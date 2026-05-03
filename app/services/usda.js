// USDA FoodData Central (FDC) lookups for recipe nutrition.
// API: https://api.nal.usda.gov/fdc/v1
// Docs: https://fdc.nal.usda.gov/api-guide.html
//
// We hit the foods/search endpoint, filter to the curated Foundation /
// SR Legacy datasets (raw and minimally-prepared foods, well-curated),
// and cache results in the nutrition_lookups table so each ingredient
// only costs one API call ever.
//
// API key: DEMO_KEY (default) is rate-limited to 30 req/hr per IP. For
// real use, sign up free at https://api.data.gov/signup/ for 1000 req/hr
// and put it in .env as USDA_API_KEY=...

const db = require('../db');

const FDC_BASE = 'https://api.nal.usda.gov/fdc/v1';
const FDC_DATA_TYPES = ['Foundation', 'SR Legacy'];

function apiKey() {
  return process.env.USDA_API_KEY || 'DEMO_KEY';
}

function normalize(name) {
  return (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Recipes commonly write ingredients with prep modifiers ("chopped tomatoes",
// "minced beef", "mozzarella balls") that confuse FDC's search engine —
// the engine matches on ANY word, so "chopped tomatoes" can return "Pork chop"
// because "chop" is in the description. Strip the noise so the food name
// actually drives the search.
const STRIP_WORDS = new Set([
  // prep verbs
  'minced', 'chopped', 'sliced', 'diced', 'grated', 'shredded', 'ground',
  'crushed', 'crumbled', 'cubed', 'pureed', 'mashed', 'torn', 'rolled', 'beaten',
  // forms / cuts / shapes (NOT food-part words like 'breast', 'thigh', 'leg')
  'whole', 'halved', 'quartered', 'julienned', 'peeled',
  'sheets', 'pieces', 'strips', 'cubes', 'wedges', 'rounds', 'balls', 'sticks',
  'slices', 'slice',
  // states (NOT 'canned' — nutritionally different from raw)
  'fresh', 'dried', 'raw', 'cooked', 'frozen', 'baked', 'roasted',
  'smoked', 'fried', 'sauteed', 'grilled', 'steamed', 'boiled',
  // sizes / quality grades
  'large', 'medium', 'small', 'baby', 'mini', 'jumbo', 'extra',
  // structural
  'boneless', 'skinless', 'deboned', 'virgin'
]);

function cleanQuery(s) {
  if (!s) return '';
  const cleaned = s.toLowerCase().split(/\s+/).filter(w => !STRIP_WORDS.has(w)).join(' ').trim();
  // Fall back to the original if every word got stripped (e.g. "fresh") —
  // better to search something dumb than nothing at all.
  return cleaned || s.toLowerCase().trim();
}

// Defensive backstop: even with FDC's requireAllWords param, sometimes a
// match slips through where the description doesn't actually contain all
// the query words. Reject those locally.
function descContainsAllWords(desc, query) {
  const d = (desc || '').toLowerCase();
  const words = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.every(w => d.includes(w));
}

// Map FDC's nutrient names + required unit → our schema fields. FDC returns
// energy in BOTH kcal and kJ; we filter to kcal so calories aren't 4x reality.
const NUTRIENT_MAP = {
  'Energy':                          { field: 'calories_per_100g', unit: 'KCAL' },
  'Energy (Atwater General Factors)':{ field: 'calories_per_100g', unit: 'KCAL' },
  'Protein':                         { field: 'protein_per_100g',  unit: 'G' },
  'Fiber, total dietary':            { field: 'fiber_per_100g',    unit: 'G' },
  'Sugars, total including NLEA':    { field: 'sugar_per_100g',    unit: 'G' },
  'Sugars, Total':                   { field: 'sugar_per_100g',    unit: 'G' },
  'Sodium, Na':                      { field: 'sodium_per_100g',   unit: 'MG' }
};

function extractNutrients(food) {
  const out = {
    calories_per_100g: null,
    protein_per_100g: null,
    fiber_per_100g: null,
    sugar_per_100g: null,
    sodium_per_100g: null
  };
  for (const n of (food.foodNutrients || [])) {
    const name = n.nutrientName || n.name;
    const unit = (n.unitName || '').toUpperCase();
    const map = NUTRIENT_MAP[name];
    if (!map) continue;
    if (map.unit && map.unit !== unit) continue;  // e.g. ignore the kJ Energy entry
    if (out[map.field] == null) {
      out[map.field] = typeof n.value === 'number' ? n.value : (typeof n.amount === 'number' ? n.amount : null);
    }
  }
  return out;
}

// Score how likely a food entry is what the user actually meant.
// Prefer entries that:
//   - have all five nutrients we care about (no fragmentary lunchmeat entries)
//   - aren't dehydrated/powdered/concentrated (skews calories)
//   - aren't weirdly prepared if the user said something generic
//   - mention "raw" if available (closer to recipe-pantry intent)
const PENALTIES = [
  /\bpowder/i, /\bdehydrated\b/i, /\bdried\b/i, /\bconcentrate\b/i,
  /\binstant\b/i, /\bfreeze.dried\b/i,
  /\blunchmeat\b/i, /\bdeli\b/i,
  /\bbaby food\b/i, /\binfant\b/i, /\bnonfat dry\b/i,
  /\bcanned\b/i,  // canned versions often have added sodium/sugar
  /\bcured\b/i, /\bsmoked\b/i, /\bmarinated\b/i  // more processed than the generic
];
const BOOSTS = [
  /\braw\b/i, /\bfresh\b/i, /\bcooked\b/i  // "cooked" is fine, just not bad
];

// Specific cut/variety words. If the user typed "beef" we don't want to
// match "Beef, tenderloin" — that's a particular cut with a different
// nutrition profile. Penalize cut/variety words ONLY if they're not in
// the user's query.
const CUT_WORDS = [
  'tenderloin', 'ribeye', 'sirloin', 'flank', 'brisket', 'chuck', 'round',
  'shank', 'shoulder', 'loin', 'rib', 'plate', 'belly', 'porterhouse',
  'tomahawk', 'striploin', 'skirt', 'hanger', 'oxtail',
  'thigh', 'wing', 'drumstick', 'tender'
];

// "Brand-y" descriptions tend to be ALL CAPS or contain a possessive like
// "CARRABBA'S" — those are usually prepared meals, not generic ingredients.
function looksBranded(desc) {
  // 2+ consecutive ALL-CAPS words of length ≥ 3
  if (/\b[A-Z]{3,}(?:\s+[A-Z]{3,})+\b/.test(desc)) return true;
  // Apostrophe-S in caps (RED LOBSTER'S, McDONALD'S, CARRABBA'S)
  if (/\b[A-Z]{2,}'S\b/.test(desc)) return true;
  return false;
}

function nameRelevance(desc, query) {
  // Reward descriptions where the query words appear at the *start* of the
  // food name. "Milk, whole" should beat "Crackers, milk" for the query "milk".
  const descLower = desc.toLowerCase();
  const queryWords = (query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const firstSegment = descLower.split(/[,(]/)[0].trim();
  const firstWords = firstSegment.split(/\s+/);
  let score = 0;
  for (const qw of queryWords) {
    if (firstWords.includes(qw)) score += 3;
    else if (descLower.includes(qw)) score += 1;
  }
  return score;
}

function scoreFood(food, query) {
  const rawDesc = food.description || '';
  const desc = rawDesc.toLowerCase();
  const n = food.foodNutrients || [];
  const hasNutrient = (name, unit) => n.some(x => (x.nutrientName === name) && (!unit || (x.unitName || '').toUpperCase() === unit));
  let score = 0;
  // Name relevance is dominant: don't pick "Crackers, milk" for "milk".
  score += nameRelevance(desc, query);
  // Nutrient completeness so our recipe sums actually fill in.
  if (hasNutrient('Energy', 'KCAL') || hasNutrient('Energy (Atwater General Factors)', 'KCAL')) score += 5;
  if (hasNutrient('Protein', 'G')) score += 2;
  if (hasNutrient('Sodium, Na', 'MG')) score += 1;
  // Foundation > SR Legacy when both available.
  if (food.dataType === 'Foundation') score += 0.5;
  // Penalties for processed forms.
  for (const re of PENALTIES) if (re.test(desc)) score -= 3;
  for (const re of BOOSTS) if (re.test(desc)) score += 0.5;
  // Brand-style descriptions (CARRABBA'S, OLIVE GARDEN, etc.) are
  // prepared meals — not what we want for an ingredient lookup.
  if (looksBranded(rawDesc)) score -= 5;
  // Cut/variety words ("tenderloin", "ribeye") penalized when not in query —
  // user said "beef", we shouldn't return "Beef, tenderloin".
  for (const cut of CUT_WORDS) {
    if (desc.includes(cut) && !(query || '').toLowerCase().includes(cut)) {
      score -= 1.5;
    }
  }
  // Shorter, simpler descriptions tend to be the canonical entry.
  score -= Math.min(2, desc.length / 80);
  return score;
}

// Hit FDC, return the best-match nutrition for an ingredient name, or null.
// Caches successful AND empty results so we don't repeatedly retry failures.
// Cache key is the CLEANED ingredient name, so "chopped tomatoes",
// "diced tomatoes", and "tomatoes" all share one cache entry.
async function searchFood(rawName) {
  const ingredientName = cleanQuery(normalize(rawName));
  if (!ingredientName) return null;

  const cached = db.prepare('SELECT * FROM nutrition_lookups WHERE ingredient_name = ?').get(ingredientName);
  if (cached) return cached;

  try {
    const url = `${FDC_BASE}/foods/search?query=${encodeURIComponent(ingredientName)}`
      + `&dataType=${encodeURIComponent(FDC_DATA_TYPES.join(','))}`
      + `&requireAllWords=true`
      + `&pageSize=25&api_key=${apiKey()}`;
    const res = await fetch(url);
    if (!res.ok) {
      // 429 = rate-limited, don't poison the cache
      if (res.status === 429) return null;
      throw new Error(`FDC ${res.status}`);
    }
    const data = await res.json();
    // Belt-and-suspenders: filter to candidates whose descriptions actually
    // contain every query word. Sometimes FDC's requireAllWords still lets
    // partial-stem matches through.
    const candidates = (data.foods || []).filter(f => descContainsAllWords(f.description, ingredientName));
    candidates.sort((a, b) => scoreFood(b, ingredientName) - scoreFood(a, ingredientName));
    const food = candidates[0] || null;
    const nutrients = food ? extractNutrients(food) : {
      calories_per_100g: null, protein_per_100g: null,
      fiber_per_100g: null, sugar_per_100g: null, sodium_per_100g: null
    };
    const row = {
      ingredient_name: ingredientName,
      matched_description: food ? food.description : null,
      data_type: food ? food.dataType : null,
      fdc_id: food ? food.fdcId : null,
      ...nutrients
    };
    db.prepare(`INSERT INTO nutrition_lookups
      (ingredient_name, matched_description, data_type, fdc_id,
       calories_per_100g, protein_per_100g, fiber_per_100g, sugar_per_100g, sodium_per_100g)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ingredient_name) DO UPDATE SET
        matched_description = excluded.matched_description,
        data_type = excluded.data_type,
        fdc_id = excluded.fdc_id,
        calories_per_100g = excluded.calories_per_100g,
        protein_per_100g = excluded.protein_per_100g,
        fiber_per_100g = excluded.fiber_per_100g,
        sugar_per_100g = excluded.sugar_per_100g,
        sodium_per_100g = excluded.sodium_per_100g`)
      .run(row.ingredient_name, row.matched_description, row.data_type, row.fdc_id,
           row.calories_per_100g, row.protein_per_100g, row.fiber_per_100g, row.sugar_per_100g, row.sodium_per_100g);
    return row;
  } catch (e) {
    return null;  // best-effort; a failed lookup just means we skip this ingredient's nutrition
  }
}

// Convert a recipe's quantity+unit into approximate grams. Honest about
// imprecision: we use food-aware overrides for common ingredients when
// possible (1 cup flour ≠ 1 cup spinach), otherwise fall back to a generic
// volume-as-water default. Returns null when we can't make sense of it.
const WEIGHT_TO_GRAMS = {
  'g': 1, 'gram': 1, 'grams': 1,
  'kg': 1000, 'kilogram': 1000, 'kilograms': 1000,
  'oz': 28.35, 'ounce': 28.35, 'ounces': 28.35,
  'lb': 453.59, 'lbs': 453.59, 'pound': 453.59, 'pounds': 453.59
};

// Default volume → grams, treating volume as water. Override per-food below.
const VOLUME_TO_GRAMS = {
  'cup': 240, 'cups': 240,
  'tbsp': 15, 'tbs': 15, 'tbls': 15, 'tablespoon': 15, 'tablespoons': 15,
  'tsp': 5, 'tsps': 5, 'teaspoon': 5, 'teaspoons': 5,
  'ml': 1, 'milliliter': 1, 'milliliters': 1,
  'l': 1000, 'liter': 1000, 'liters': 1000,
  'fl oz': 30, 'fluid ounce': 30, 'fluid ounces': 30,
  'pint': 473, 'pints': 473,
  'quart': 946, 'quarts': 946, 'qt': 946,
  'gallon': 3785, 'gallons': 3785, 'gal': 3785
};

// Per-cup overrides by ingredient keyword. Order matters: first match wins.
const CUP_OVERRIDES = [
  [/flour/, 120], [/sugar(?!.*free)/, 200], [/brown sugar/, 213],
  [/oats|granola/, 90], [/rice(?!.*cooked)/, 200], [/pasta|noodle|macaroni|ziti|penne/, 100],
  [/cocoa/, 85], [/cornmeal|cornstarch/, 145],
  [/spinach|kale|lettuce|romaine|cabbage|mixed greens/, 35],
  [/blueberries|strawberries|raspberries|berries|grapes/, 150],
  [/cheese.*shred|shredded.*cheese/, 110], [/cheese/, 120],
  [/breadcrumbs|panko/, 110],
  [/peanut butter|almond butter/, 250], [/honey|syrup|molasses/, 320],
  [/chocolate chips/, 175], [/raisins|cranberries|dried/, 150],
  [/butter/, 227], [/yogurt|sour cream|cream cheese/, 230]
];

function gramsPerCupFor(name) {
  const n = (name || '').toLowerCase();
  for (const [re, grams] of CUP_OVERRIDES) if (re.test(n)) return grams;
  return 240; // fallback: treat as water
}

// Per-each weight in grams. For ingredients sold by the unit ("1 banana",
// "2 eggs"). Falls back to 100g if unknown — gives a number rather than
// ignoring the ingredient entirely.
const PER_EACH = [
  [/egg(?!plant)/, 50], [/banana/, 120], [/apple/, 180], [/orange/, 130],
  [/lemon|lime/, 60], [/onion/, 110], [/garlic clove|clove/, 5],
  [/tomato(?!.*sauce|.*paste)/, 120], [/cherry tomato/, 17],
  [/bell pepper|pepper(?!.*flake|.*powder)/, 120], [/zucchini/, 200],
  [/cucumber/, 200], [/carrot/, 60], [/potato(?!.*sweet)/, 170],
  [/sweet potato/, 130], [/avocado/, 200],
  [/chicken breast/, 170], [/chicken thigh/, 110],
  [/tortilla/, 30], [/bread.*slice|slice.*bread/, 30],
  [/bagel|english muffin|biscuit/, 90], [/dinner roll|hamburger bun|hot dog bun/, 50],
  [/celery.*stalk|stalk.*celery/, 40],
  [/can(?:ned)?/, 425], [/jar/, 680], [/package|package/, 200], [/loaf/, 450]
];

function gramsPerEachFor(name) {
  const n = (name || '').toLowerCase();
  for (const [re, grams] of PER_EACH) if (re.test(n)) return grams;
  return 100;  // generic fallback
}

function unitToGrams(quantity, unit, ingredientName) {
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const u = (unit || '').toLowerCase().trim();

  // Weight units convert directly.
  if (WEIGHT_TO_GRAMS[u] != null) return quantity * WEIGHT_TO_GRAMS[u];

  // Volume units: ingredient-aware for cup-family, generic for others.
  if (u === 'cup' || u === 'cups') return quantity * gramsPerCupFor(ingredientName);
  if (VOLUME_TO_GRAMS[u] != null) return quantity * VOLUME_TO_GRAMS[u];

  // Each-style units.
  if (['', 'each', 'piece', 'pieces', 'whole', 'large', 'medium', 'small', 'slice', 'slices',
       'clove', 'cloves', 'stalk', 'stalks', 'leaf', 'leaves', 'sprig', 'sprigs',
       'can', 'cans', 'jar', 'jars', 'package', 'packages', 'pack', 'loaf', 'loaves',
       'head', 'heads', 'bunch'].includes(u)) {
    return quantity * gramsPerEachFor(ingredientName);
  }

  // Unparseable units like "to taste", "to serve" — skip.
  return null;
}

// Compute total recipe nutrition by summing per-ingredient values. Returns
// per-serving numbers (so health scoring stays comparable across recipes).
async function recipeNutrition(ingredients, servings) {
  let cal = 0, pro = 0, fi = 0, su = 0, so = 0;
  let covered = 0;
  for (const ing of ingredients || []) {
    const grams = unitToGrams(ing.quantity, ing.unit, ing.name);
    if (!grams) continue;
    const food = await searchFood(ing.name);
    if (!food || food.calories_per_100g == null) continue;
    const factor = grams / 100;
    cal += (food.calories_per_100g || 0) * factor;
    pro += (food.protein_per_100g || 0) * factor;
    fi  += (food.fiber_per_100g || 0)    * factor;
    su  += (food.sugar_per_100g || 0)    * factor;
    so  += (food.sodium_per_100g || 0)   * factor;
    covered++;
  }
  if (!covered) return null;
  const s = Math.max(1, servings || 1);
  return {
    calories: Math.round(cal / s),
    protein:  +(pro / s).toFixed(1),
    fiber:    +(fi  / s).toFixed(1),
    sugar:    +(su  / s).toFixed(1),
    sodium:   +(so  / s).toFixed(1),
    covered_ingredients: covered,
    total_ingredients: (ingredients || []).length
  };
}

module.exports = { searchFood, unitToGrams, recipeNutrition };
