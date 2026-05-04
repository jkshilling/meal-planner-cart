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
const llmCanonicalize = require('./llm_canonicalize');

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
  'boneless', 'skinless', 'deboned', 'virgin',
  // additional quality / fat-content / processing modifiers (added when the
  // settings-page coverage card surfaced "regular olive oil", "non-fat milk",
  // "cooking oats", etc. as unmatched).
  'regular', 'premium', 'lite', 'light',
  'non-fat', 'nonfat', 'low-fat', 'lowfat', 'reduced-fat', 'reducedfat',
  'fat-free', 'fatfree', 'full-fat', 'fullfat',
  'cooking', 'instant', 'quick', 'old-fashioned', 'oldfashioned',
  'plain', 'unsweetened', 'sweetened', 'organic', 'natural'
]);

// Multi-word synonym substitutions, applied BEFORE the single-word strip.
// Each entry: [regex, replacement]. Regex flags: global, case-insensitive.
// These exist because USDA's Foundation Foods database uses canonical
// short names ("parsley", "scallions", "mushrooms"), and Spoonacular /
// human-typed recipes use kitchen-natural variants ("flat-leaf parsley",
// "spring onions", "cremini mushrooms"). Without these aliases the long
// form has no USDA match and silently drops out of the recipe's totals.
const ALIASES = [
  // Cheese variants → parmesan
  [/\bparmigiano(?:[ -]reggiano)?(?:\s+cheese)?\b/gi, 'parmesan'],
  // Mushroom varieties → mushrooms
  [/\b(?:cremini|crimini|baby\s+bella|baby\s+bellas|portobello|portabella)\s+mushrooms?\b/gi, 'mushrooms'],
  [/\b(?:cremini|crimini)\b/gi, 'mushrooms'],
  // Onion synonyms → scallions
  [/\b(?:spring|green)\s+onions?\b/gi, 'scallions'],
  // Egg substitutes → egg
  [/\begg\s+(?:replacement|substitute)s?\b/gi, 'egg'],
  // Parsley variants → parsley
  [/\b(?:flat[\s-]?leaf|italian)\s+parsley\b/gi, 'parsley'],
  // "thyme leaves" / "rosemary leaves" / etc. → just the herb
  [/\b(thyme|rosemary|sage|basil|oregano|mint|cilantro)\s+leaves\b/gi, '$1'],
  // Sake variants
  [/\bsaki\b/gi, 'sake'],
  // Pepper / chili flake variants → red pepper
  [/\b(?:red\s+)?(?:chili|chile)\s+flakes\b/gi, 'red pepper'],
  [/\bpepper\s+flakes\b/gi, 'red pepper'],
  // Measurement-ish noise prefixes — strip
  [/\b(?:a\s+)?(?:dash(?:e?s)?|splash|pinch|sprig)\s+of\b/gi, '']
];

// The single shared canonical-name function. Used as the cache key in
// nutrition_lookups (write side: searchFood; read side: nutritionFromCache
// and ingredientMatchStatus), AND used by data/canonicalize-ingredients.js
// to bulk-rename existing recipe_ingredients rows so the recipe edit pages
// reflect the cleaned names.
//
// Pipeline: lowercase + collapse whitespace → multi-word alias substitution
// → drop single-word noise tokens (STRIP_WORDS) → re-collapse whitespace.
// Fall back to the lowercased original if every word got stripped.
function canonicalize(rawName) {
  let s = (rawName || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!s) return '';
  for (const [pattern, replacement] of ALIASES) {
    s = s.replace(pattern, replacement);
  }
  s = s.replace(/\s+/g, ' ').trim();
  const stripped = s.split(' ').filter(w => w && !STRIP_WORDS.has(w)).join(' ').trim();
  return stripped || s || (rawName || '').toLowerCase().trim();
}

// Backward-compat shim: cleanQuery used to be a separate stripping pass
// applied AFTER normalize. It's now equivalent to canonicalize so the
// search query and the cache key always agree.
function cleanQuery(s) {
  return canonicalize(s);
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

// Single round-trip to USDA FoodData Central. Returns the best-scoring
// candidate, or null if FDC has nothing usable. Throws on transport errors
// so the caller can decide whether to swallow or escalate.
async function fdcLookup(query) {
  const url = `${FDC_BASE}/foods/search?query=${encodeURIComponent(query)}`
    + `&dataType=${encodeURIComponent(FDC_DATA_TYPES.join(','))}`
    + `&requireAllWords=true`
    + `&pageSize=25&api_key=${apiKey()}`;
  const res = await fetch(url);
  if (!res.ok) {
    // 429 = rate-limited; signal to the caller so it can decline to poison
    // the cache.
    if (res.status === 429) return { rateLimited: true, food: null };
    throw new Error(`FDC ${res.status}`);
  }
  const data = await res.json();
  // Filter to candidates that:
  //   1. Actually contain every query word in the description (FDC's
  //      requireAllWords sometimes lets partial-stem matches through)
  //   2. Aren't branded prepared meals (CARRABBA'S, OLIVE GARDEN, etc.) —
  //      better to record no match than to use restaurant nutrition for
  //      an ingredient.
  const candidates = (data.foods || [])
    .filter(f => descContainsAllWords(f.description, query))
    .filter(f => !looksBranded(f.description || ''));
  candidates.sort((a, b) => scoreFood(b, query) - scoreFood(a, query));
  return { rateLimited: false, food: candidates[0] || null };
}

// Hit FDC, return the best-match nutrition for an ingredient name, or null.
// Caches successful AND empty results so we don't repeatedly retry failures.
// Cache key is the CLEANED ingredient name, so "chopped tomatoes",
// "diced tomatoes", and "tomatoes" all share one cache entry.
//
// LLM steps (services/llm_canonicalize) on the path:
//   1. VERIFY — if FDC returned a candidate, ask the LLM whether it's a
//      semantically reasonable match for the ingredient name. This catches
//      USDA's heuristic-scoring failures ("cinnamon" → "Cinnamon buns,
//      frosted") that no static rule reliably catches. On a "no" verdict
//      we treat it as if FDC had returned nothing and fall through to:
//   2. REWRITE — if FDC returned nothing (or VERIFY rejected), ask the LLM
//      for a USDA-friendlier rewrite of the name and retry FDC once. The
//      retry's match is trusted as-is (we don't recurse VERIFY on it; the
//      rewrite itself encodes the LLM's judgement).
//
// Both LLM steps are silently skipped if no OPENAI_API_KEY is configured.
// Either way the final result — match or no-match — is cached under the
// ORIGINAL canonical key so we never run this dance twice for the same
// input.
async function searchFood(rawName) {
  const ingredientName = canonicalize(rawName);
  if (!ingredientName) return null;

  const cached = db.prepare('SELECT * FROM nutrition_lookups WHERE ingredient_name = ?').get(ingredientName);
  if (cached) return cached;

  try {
    let { rateLimited, food } = await fdcLookup(ingredientName);
    if (rateLimited) return null;  // don't poison the cache; try again next render

    // STEP 1 — VERIFY. Only invoke when we have a candidate to validate.
    // null verdict means "could not determine" → trust the static scoring
    // (don't reject on LLM uncertainty).
    if (food) {
      const verdict = await llmCanonicalize.verifyMatch(ingredientName, food.description);
      if (verdict === false) {
        food = null;  // reject; fall through to REWRITE
      }
    }

    // STEP 2 — REWRITE. Triggered by FDC zero-result OR VERIFY rejection.
    let llmSuggested = null;
    if (!food) {
      const suggested = await llmCanonicalize.suggestCanonical(ingredientName);
      if (suggested && suggested !== ingredientName) {
        llmSuggested = suggested;
        const retry = await fdcLookup(suggested);
        if (retry.rateLimited) return null;
        food = retry.food;
      }
    }

    const nutrients = food ? extractNutrients(food) : {
      calories_per_100g: null, protein_per_100g: null,
      fiber_per_100g: null, sugar_per_100g: null, sodium_per_100g: null
    };
    const row = {
      ingredient_name: ingredientName,
      matched_description: food ? food.description : null,
      data_type: food ? food.dataType : null,
      fdc_id: food ? food.fdcId : null,
      llm_suggested_name: llmSuggested,
      ...nutrients
    };
    db.prepare(`INSERT INTO nutrition_lookups
      (ingredient_name, matched_description, data_type, fdc_id, llm_suggested_name,
       calories_per_100g, protein_per_100g, fiber_per_100g, sugar_per_100g, sodium_per_100g)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ingredient_name) DO UPDATE SET
        matched_description = excluded.matched_description,
        data_type = excluded.data_type,
        fdc_id = excluded.fdc_id,
        llm_suggested_name = excluded.llm_suggested_name,
        calories_per_100g = excluded.calories_per_100g,
        protein_per_100g = excluded.protein_per_100g,
        fiber_per_100g = excluded.fiber_per_100g,
        sugar_per_100g = excluded.sugar_per_100g,
        sodium_per_100g = excluded.sodium_per_100g`)
      .run(row.ingredient_name, row.matched_description, row.data_type, row.fdc_id, row.llm_suggested_name,
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

// Per-slice weights. Used when unit is "slice" / "slices" — these are very
// different from generic each-units (a slice of bread is 30g, but treating
// it as "each" with the 100g fallback over-counted nutrition by 3-7×). The
// regexes match against the ingredient name (the unit is already known to
// be a slice when this is called).
const PER_SLICE = [
  [/bread|toast|baguette|brioche|sourdough|rye|pumpernickel|whole.?wheat/, 30],
  [/cheese|cheddar|provolone|swiss|mozzarella|monterey|colby|havarti|gouda|american/, 21],
  [/bacon/, 10],
  [/pepperoni|salami/, 4],
  [/ham(?!burger)|deli|prosciutto/, 28],
  [/turkey|chicken/, 25],
  [/tomato/, 20],
  [/onion/, 15],
  [/cucumber/, 15],
  [/lemon|lime|orange/, 30],
  [/avocado/, 25],
  [/pickle/, 8],
  [/apple|pear/, 20]
];

function gramsPerSliceFor(name) {
  const n = (name || '').toLowerCase();
  for (const [re, grams] of PER_SLICE) if (re.test(n)) return grams;
  return 30;  // generic slice fallback (bread-ish)
}

function unitToGrams(quantity, unit, ingredientName) {
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const u = (unit || '').toLowerCase().trim();

  // Weight units convert directly.
  if (WEIGHT_TO_GRAMS[u] != null) return quantity * WEIGHT_TO_GRAMS[u];

  // Volume units: ingredient-aware for cup-family, generic for others.
  if (u === 'cup' || u === 'cups') return quantity * gramsPerCupFor(ingredientName);
  if (VOLUME_TO_GRAMS[u] != null) return quantity * VOLUME_TO_GRAMS[u];

  // Slices have their own table — bread = 30g, sandwich cheese = 21g, etc.
  // Lumping them into the generic each-bucket made "1 slice bread" and
  // "1 whole bread" both = 100g, blowing up calories by 3-7×.
  if (u === 'slice' || u === 'slices') {
    return quantity * gramsPerSliceFor(ingredientName);
  }

  // Each-style units.
  if (['', 'each', 'piece', 'pieces', 'whole', 'large', 'medium', 'small',
       'clove', 'cloves', 'stalk', 'stalks', 'leaf', 'leaves', 'sprig', 'sprigs',
       'can', 'cans', 'jar', 'jars', 'package', 'packages', 'pack', 'loaf', 'loaves',
       'head', 'heads', 'bunch'].includes(u)) {
    return quantity * gramsPerEachFor(ingredientName);
  }

  // Unparseable units like "to taste", "to serve" — skip.
  return null;
}

// Sync, cache-only sibling of recipeNutrition. Reads from nutrition_lookups
// without ever calling the USDA API — used on hot render paths (recipe list,
// planner scoring, plan review) where we don't want network latency. Any
// ingredient missing from the cache contributes 0 to the totals; the
// returned `covered` field tells callers how complete the result is. The
// async recipeNutrition below is the cache-warming path and gets called on
// recipe save / import to populate the cache so this function has data to
// read on subsequent renders.
function nutritionFromCache(ingredients, servings) {
  // Lazy-require db so this module stays loadable from a no-DB context if
  // anyone ever wants to (and so the unit-conversion exports don't pull in
  // SQLite at module-load time).
  const db = require('../db');
  let cal = 0, pro = 0, fi = 0, su = 0, so = 0;
  let covered = 0;
  const total = (ingredients || []).length;
  if (!total) return null;

  // Batch-fetch every ingredient's cached row in one query instead of N
  // round-trips. Keys are the canonicalize(name) form the searchFood path
  // writes under so the lookup hits — "diced tomatoes", "tomatoes",
  // "fresh tomatoes" all collapse to the same key "tomatoes".
  const names = ingredients.map(i => canonicalize(i.name));
  if (!names.length) return null;
  const placeholders = names.map(() => '?').join(',');
  const cached = db.prepare(
    `SELECT ingredient_name, calories_per_100g, protein_per_100g,
            fiber_per_100g, sugar_per_100g, sodium_per_100g
       FROM nutrition_lookups
      WHERE ingredient_name IN (${placeholders})`
  ).all(...names);
  const byName = {};
  for (const row of cached) byName[row.ingredient_name] = row;

  for (const ing of ingredients) {
    const grams = unitToGrams(ing.quantity, ing.unit, ing.name);
    if (!grams) continue;
    const food = byName[canonicalize(ing.name)];
    if (!food || food.calories_per_100g == null) continue;
    const factor = grams / 100;
    cal += (food.calories_per_100g || 0) * factor;
    pro += (food.protein_per_100g  || 0) * factor;
    fi  += (food.fiber_per_100g    || 0) * factor;
    su  += (food.sugar_per_100g    || 0) * factor;
    so  += (food.sodium_per_100g   || 0) * factor;
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
    total_ingredients: total
  };
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

// Per-ingredient match status, in the same order as the input list. Three
// possible values per slot:
//   'matched'  — nutrition_lookups has a row with non-null per-100g values.
//                The ingredient counts toward the recipe's nutrition.
//   'no-match' — nutrition_lookups has a row with NULL values (USDA was
//                queried but had no result for this name). Doesn't count.
//   'pending'  — no row at all yet. Either USDA hasn't been queried for
//                this name (brand-new ingredient typed in the edit form)
//                or the cache is cold. Treated as "doesn't count" for
//                display purposes.
// Used by the recipe edit form to put a ✓ / ✗ next to each ingredient row
// so the user can see exactly which entries USDA didn't recognize.
function ingredientMatchStatus(ingredients) {
  const db = require('../db');
  const names = (ingredients || []).map(i => canonicalize(i.name));
  if (!names.length) return [];
  const placeholders = names.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT ingredient_name, calories_per_100g
       FROM nutrition_lookups
      WHERE ingredient_name IN (${placeholders})`
  ).all(...names);
  const byName = {};
  for (const r of rows) byName[r.ingredient_name] = r;
  return (ingredients || []).map(ing => {
    const cached = byName[canonicalize(ing.name)];
    if (!cached) return 'pending';
    return cached.calories_per_100g != null ? 'matched' : 'no-match';
  });
}

module.exports = { searchFood, unitToGrams, recipeNutrition, nutritionFromCache, ingredientMatchStatus, canonicalize };
