// NYT Cooking JSON-LD → internal recipe shape.
//
// NYT publishes a complete schema.org Recipe object on every recipe page
// for SEO. The data is identical between unauthenticated and logged-in
// requests — they can't hide it from Google or they fall out of search
// rankings. The Chrome extension reads this JSON-LD client-side and
// POSTs it to /api/recipes/import-nyt; this module maps it to our
// internal recipe shape (same as services/spoonacular.spoonacularToRecipe).
//
// What we keep:
//   name, description, recipeYield, totalTime, recipeCategory,
//   recipeIngredient (parsed via LLM into qty/unit/name),
//   recipeInstructions (joined into notes),
//   nutrition.calories (extracted from "184 calories" → 184)
//   author, image (first one)
//
// What we drop: aggregateRating, review array, all the @id / @context
// schema.org plumbing. Could surface ratings later as a sortable column.

const llm = require('./llm_canonicalize');

// NYT's recipeCategory is comma-separated and multi-tag, e.g. "dinner,
// weeknight, vegetables, side dish". Pick the most specific meal-type
// signal, in priority order. Falls back to 'dinner' if nothing matches —
// a reasonable default for "main course"-flavored recipes.
//
// Order matters: we want "side dish" to win over "dinner" when both are
// present, because the recipe is genuinely both (Spoonacular has the
// same multi-tag issue).
const CATEGORY_PRIORITY = [
  ['side dish',     'side'],
  ['side',          'side'],
  ['breakfast',     'breakfast'],
  ['brunch',        'breakfast'],
  ['lunch',         'lunch'],
  ['snack',         'snack'],
  ['appetizer',     'snack'],
  ['fingerfood',    'snack'],
  ['dessert',       'snack'],
  ['salad',         'side'],
  ['soup',          'dinner'],
  ['main course',   'dinner'],
  ['main',          'dinner'],
  ['dinner',        'dinner']
];

function guessMealType(category, keywords) {
  const hay = ((category || '') + ' ' + (keywords || '')).toLowerCase();
  for (const [needle, mealType] of CATEGORY_PRIORITY) {
    if (hay.includes(needle)) return mealType;
  }
  return 'dinner';
}

// "PT25M" → 25, "PT1H30M" → 90, "PT4H" → 240.
function parseIso8601Minutes(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/);
  if (!m) return null;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  return h * 60 + min;
}

// recipeYield is free-form: "4 servings", "Makes 1 9-inch cake",
// "1 1/2 dozen 5-inch cookies". Try to pull a leading integer; fall
// back to 4 (a reasonable default for "feeds the family").
function parseYield(yield_) {
  if (typeof yield_ === 'number') return yield_;
  if (typeof yield_ !== 'string') return 4;
  const m = yield_.match(/(\d+)/);
  if (!m) return 4;
  const n = parseInt(m[1], 10);
  // "Makes 1 9-inch cake" picks up "1" — but a 1-serving cake is wrong.
  // Heuristic: if the parsed number is 1 and the string contains "cake"
  // / "loaf" / "pie" / "casserole", it's probably 6-8 servings.
  if (n === 1 && /cake|loaf|pie|casserole|tart/i.test(yield_)) return 8;
  return Math.max(1, n);
}

// nutrition.fatContent is a string like "11 grams". Extract the number.
function gramsFromString(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// Convert ingredient strings → {name, quantity, unit} via the LLM.
// Done one-at-a-time deterministically; results cached in memory of
// the calling request (LLM with temperature 0 is reliable here).
//
// Free-text examples this needs to handle:
//   "3 tablespoons unsalted butter"          → name=butter, qty=3, unit=tbsp
//   "1/2 cup finely chopped shallot (about 1 large shallot)"
//                                            → name=shallot, qty=0.5, unit=cup
//   "1 1/4 pounds bittersweet chocolate disks"
//                                            → name=chocolate, qty=1.25, unit=lb
//   "Kosher salt and black pepper"           → name=salt, qty=1, unit=to taste
//   "Store-bought fried shallots (optional)" → name=fried shallots, qty=1, unit=to taste
async function parseIngredientLine(line) {
  const parsed = await llm.parseIngredient(line);
  if (parsed) return parsed;
  // LLM unavailable: fall back to a non-zero placeholder so the row
  // still inserts. nutritionFromCache returns 0 for unknown units.
  return { name: line.toLowerCase().trim().slice(0, 80) || 'unknown', quantity: 1, unit: 'to taste' };
}

async function nytLdToRecipe(jsonLd, sourceUrl) {
  if (!jsonLd || jsonLd['@type'] !== 'Recipe') return null;

  const totalMin = parseIso8601Minutes(jsonLd.totalTime)
    || parseIso8601Minutes(jsonLd.cookTime)
    || parseIso8601Minutes(jsonLd.prepTime)
    || 30;

  const servings = parseYield(jsonLd.recipeYield);

  const meal_type = guessMealType(jsonLd.recipeCategory, jsonLd.keywords);

  // Source ID for dedup. Prefer the recipe ID from the URL slug
  // (https://cooking.nytimes.com/recipes/1023535-miso-gravy-… → "nyt:1023535").
  // Fall back to the JSON-LD @id if that's all we have.
  let source_id = null;
  const urlMatch = (sourceUrl || jsonLd.url || '').match(/\/recipes\/(\d+)/);
  if (urlMatch) source_id = `nyt:${urlMatch[1]}`;
  else if (jsonLd['@id']) source_id = `nyt:${jsonLd['@id']}`;

  // Build instructions block — NYT's instructions are an array of
  // HowToStep objects. Number them and join with blank lines so the
  // notes field reads like a recipe.
  const steps = (jsonLd.recipeInstructions || [])
    .map(s => (typeof s === 'string' ? s : s.text || ''))
    .filter(Boolean);
  const notes = steps.map((s, i) => `${i + 1}. ${s}`).join('\n\n');

  // Nutrition. NYT's keys: calories (number), proteinContent / carbohydrateContent /
  // fatContent / fiberContent / sugarContent / sodiumContent (strings like "11 grams").
  const n = jsonLd.nutrition || {};
  const calories = typeof n.calories === 'number' ? n.calories : gramsFromString(n.calories);

  // Parse all ingredient lines in parallel (LLM is cheap; race them).
  const ingLines = jsonLd.recipeIngredient || [];
  const ingredients = await Promise.all(ingLines.map(parseIngredientLine));

  return {
    source: 'nyt',
    source_id,
    name: jsonLd.name || 'Untitled',
    meal_type,
    cuisine: (jsonLd.recipeCuisine || '').toLowerCase().trim() || null,
    prep_time: totalMin,
    servings,
    est_cost: 12,  // NYT doesn't give us cost; leave a sensible per-recipe placeholder.
    calories: typeof calories === 'number' ? Math.round(calories) : null,
    notes,
    image_url: extractImageUrl(jsonLd.image),
    author: ((jsonLd.author || {}).name) || null,
    rating: (jsonLd.aggregateRating && jsonLd.aggregateRating.ratingValue) || null,
    rating_count: (jsonLd.aggregateRating && jsonLd.aggregateRating.ratingCount) || null,
    ingredients
  };
}

function extractImageUrl(image) {
  if (!image) return null;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) {
    const first = image[0];
    if (!first) return null;
    return typeof first === 'string' ? first : (first.url || first.contentUrl || null);
  }
  if (typeof image === 'object') return image.url || image.contentUrl || null;
  return null;
}

module.exports = { nytLdToRecipe, guessMealType, parseYield, parseIso8601Minutes };
