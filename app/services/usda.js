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

// Some FDC entries — especially newer Foundation Foods — return no Energy
// nutrient at all in the foods/search response (the data lives on a
// separate /food/{fdcId} endpoint). Without Energy in KCAL, extractNutrients
// produces all-NULL values, and the row caches as "matched" but contributes
// nothing to recipe nutrition. Filter those out before the verify walk so
// we never accept a calorie-less entry as the match. Example: "Oil, olive,
// extra light" (Foundation) lacks Energy in search results; "Oil, olive,
// salad or cooking" (SR Legacy) has KCAL 884 — we want the latter.
function hasUsableEnergy(food) {
  for (const n of (food.foodNutrients || [])) {
    if ((n.nutrientName === 'Energy' || n.nutrientName === 'Energy (Atwater General Factors)')
        && (n.unitName || '').toUpperCase() === 'KCAL') {
      return true;
    }
  }
  return false;
}

// Map FDC's nutrient names + required unit → our schema fields. FDC returns
// energy in BOTH kcal and kJ; we filter to kcal so calories aren't 4x reality.
const NUTRIENT_MAP = {
  'Energy':                          { field: 'calories_per_100g', unit: 'KCAL' },
  'Energy (Atwater General Factors)':{ field: 'calories_per_100g', unit: 'KCAL' },
  'Protein':                         { field: 'protein_per_100g',  unit: 'G' },
  'Carbohydrate, by difference':     { field: 'carbs_per_100g',    unit: 'G' },
  'Total lipid (fat)':               { field: 'fat_per_100g',      unit: 'G' },
  'Fiber, total dietary':            { field: 'fiber_per_100g',    unit: 'G' },
  'Sugars, total including NLEA':    { field: 'sugar_per_100g',    unit: 'G' },
  'Sugars, Total':                   { field: 'sugar_per_100g',    unit: 'G' },
  'Sodium, Na':                      { field: 'sodium_per_100g',   unit: 'MG' }
};

function extractNutrients(food) {
  const out = {
    calories_per_100g: null,
    protein_per_100g: null,
    carbs_per_100g: null,
    fat_per_100g: null,
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

// Single round-trip to USDA FoodData Central. Returns the filtered list
// of candidates in USDA's NATURAL relevance order — we used to re-sort by
// our own scoreFood here, but that has a +3 nameRelevance bonus when the
// query word appears in the first comma-segment, which pushes derivatives
// like "Cinnamon buns, frosted" ahead of canonical entries like "Spices,
// cinnamon, ground". USDA's own relevance order tends to put the
// canonical near position 3-7, well within the verify walk. The static
// scoreFood path is now only used for the no-LLM fallback (candidates[0]
// directly out of USDA, which usually picks something reasonable).
//
// Throws on transport errors.
async function fdcLookup(query) {
  const url = `${FDC_BASE}/foods/search?query=${encodeURIComponent(query)}`
    + `&dataType=${encodeURIComponent(FDC_DATA_TYPES.join(','))}`
    + `&requireAllWords=true`
    + `&pageSize=25&api_key=${apiKey()}`;
  const res = await fetch(url);
  if (!res.ok) {
    // 429 = rate-limited; signal to the caller so it can decline to poison
    // the cache.
    if (res.status === 429) return { rateLimited: true, candidates: [] };
    throw new Error(`FDC ${res.status}`);
  }
  const data = await res.json();
  // Filter to candidates that:
  //   1. Actually contain every query word in the description (FDC's
  //      requireAllWords sometimes lets partial-stem matches through)
  //   2. Aren't branded prepared meals (CARRABBA'S, OLIVE GARDEN, etc.) —
  //      better to record no match than to use restaurant nutrition for
  //      an ingredient.
  // Filter only — do NOT re-sort. USDA's order is the source of truth for
  // the verify walk. Candidates without Energy in KCAL are dropped because
  // they'd cache as nutrient-less rows.
  const candidates = (data.foods || [])
    .filter(f => descContainsAllWords(f.description, query))
    .filter(f => !looksBranded(f.description || ''))
    .filter(f => hasUsableEnergy(f));
  return { rateLimited: false, candidates };
}

// Walk USDA's top candidates, asking the LLM to verify each. Returns the
// first candidate verify accepts, or null if every candidate (up to
// MAX_VERIFY) was explicitly rejected. A null verdict from the LLM
// (network error / unparseable response) falls back to "trust USDA" and
// accepts candidates[0] — so verify failures never make the system worse
// than the no-LLM baseline.
//
// MAX_VERIFY=10 is sized to reach USDA's canonical entries which sit at
// position 3-7 for queries like "cinnamon" (Spices, cinnamon, ground at
// position 3), "pepper" (Spices, pepper, black at position 6), and
// covers queries where USDA returns 5+ varieties before the canonical.
async function pickVerifiedCandidate(ingredientName, candidates) {
  if (!candidates || !candidates.length) return null;
  if (!llmCanonicalize.isEnabled()) return candidates[0];
  const MAX_VERIFY = 10;
  for (let i = 0; i < Math.min(MAX_VERIFY, candidates.length); i++) {
    const verdict = await llmCanonicalize.verifyMatch(ingredientName, candidates[i].description);
    if (verdict === true) return candidates[i];
    if (verdict === null) {
      // Couldn't determine — fall back to USDA's #1. Don't reject on LLM
      // uncertainty; verify is a refinement, not a gate.
      return candidates[0];
    }
    // verdict === false → continue
  }
  // All explicitly rejected. Return null so the caller can try the
  // LLM-rewrite path. We do NOT fall back to candidates[0] here because
  // verify saying "no" 10 times is strong signal that USDA's data
  // genuinely doesn't have a canonical entry for this name — accepting
  // candidates[0] would silently cache a bad match (which is exactly
  // the original cinnamon → "Cinnamon buns" bug). Better to record
  // no-match so the user sees it in the Unmatched table and can rename.
  return null;
}

// Hit FDC, return the best-match nutrition for an ingredient name, or null.
// Caches successful AND empty results so we don't repeatedly retry failures.
// Cache key is the CLEANED ingredient name, so "chopped tomatoes",
// "diced tomatoes", and "tomatoes" all share one cache entry.
//
// USDA is the data source for nutrition values — every calorie / protein /
// sodium number in the cache comes from FoodData Central. The LLM
// (services/llm_canonicalize) is used only as a candidate selector and
// query rewriter:
//
//   1. VERIFIED PICK — fdcLookup returns up to 25 candidates sorted by our
//      static score. Walk the top N (default 5) asking the LLM whether
//      each is a reasonable match for the ingredient name. Accept the
//      first "yes". Catches the case where USDA's static scoring picks
//      "Bread, cinnamon" #1 but the canonical "Spices, cinnamon, ground"
//      sits at #4.
//   2. REWRITE FALLBACK — if every walked candidate is rejected, ask the
//      LLM for a USDA-friendlier rewrite of the name and retry FDC once.
//      The retry's top candidate is trusted as-is.
//   3. SAFETY NET — if verify rejected everything AND rewrite didn't help,
//      fall back to FDC's original top match. Verify must only IMPROVE on
//      the no-LLM baseline, never make it worse.
//
// All LLM steps are silently skipped if no OPENAI_API_KEY is configured.
// The final result — match or no-match — is cached under the original
// canonical key so we never run this dance twice for the same input.
async function searchFood(rawName) {
  const ingredientName = canonicalize(rawName);
  if (!ingredientName) return null;

  const cached = db.prepare('SELECT * FROM nutrition_lookups WHERE ingredient_name = ?').get(ingredientName);
  if (cached) return cached;

  try {
    const initial = await fdcLookup(ingredientName);
    if (initial.rateLimited) return null;  // don't poison the cache

    // STEP 1 — Walk the candidate list with verify; first "yes" wins.
    let food = await pickVerifiedCandidate(ingredientName, initial.candidates);

    // STEP 2 — Verify rejected every candidate (or USDA returned nothing
    // at all) → ask the LLM to rewrite the query and retry USDA. The
    // retry's candidates ALSO go through pickVerifiedCandidate, using
    // the ORIGINAL ingredient name for the verify check — the rewrite
    // is a USDA-friendlier query string, not a redefinition of the
    // ingredient. Without this verify on retry, the rewrite path would
    // trust USDA's #1 blindly, which re-introduces the cinnamon-buns
    // bug for any rewrite that lands on a stem USDA scores poorly
    // ("salt" → "Butter, salted", "cinnamon" → "Bread, cinnamon").
    let llmSuggested = null;
    if (!food) {
      const suggested = await llmCanonicalize.suggestCanonical(ingredientName);
      if (suggested && suggested !== ingredientName) {
        llmSuggested = suggested;
        const retry = await fdcLookup(suggested);
        if (retry.rateLimited) return null;
        food = await pickVerifiedCandidate(ingredientName, retry.candidates);
      }
    }

    // No safety-net fallback to candidates[0]. If verify rejected all
    // candidates on both passes AND the rewrite didn't produce a
    // different match, no-match is the correct outcome — accepting
    // USDA's #1 in this case is exactly the original cinnamon-buns /
    // banana-pepper bug. The user sees the name in the Unmatched table
    // on the settings page and can rename it.

    const nutrients = food ? extractNutrients(food) : {
      calories_per_100g: null, protein_per_100g: null,
      carbs_per_100g: null, fat_per_100g: null,
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
       calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g,
       fiber_per_100g, sugar_per_100g, sodium_per_100g)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ingredient_name) DO UPDATE SET
        matched_description = excluded.matched_description,
        data_type = excluded.data_type,
        fdc_id = excluded.fdc_id,
        llm_suggested_name = excluded.llm_suggested_name,
        calories_per_100g = excluded.calories_per_100g,
        protein_per_100g = excluded.protein_per_100g,
        carbs_per_100g = excluded.carbs_per_100g,
        fat_per_100g = excluded.fat_per_100g,
        fiber_per_100g = excluded.fiber_per_100g,
        sugar_per_100g = excluded.sugar_per_100g,
        sodium_per_100g = excluded.sodium_per_100g`)
      .run(row.ingredient_name, row.matched_description, row.data_type, row.fdc_id, row.llm_suggested_name,
           row.calories_per_100g, row.protein_per_100g, row.carbs_per_100g, row.fat_per_100g,
           row.fiber_per_100g, row.sugar_per_100g, row.sodium_per_100g);
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
//
// Word boundaries (\b) on every regex matter: without them /can(?:ned)?/
// matched the substring "can" inside "ameri{can} cheese" and shipped 425g
// per "each" (a whole can of beans!) instead of falling through to the
// slice-aware delegation below. Same risk on /apple/ matching "applesauce",
// /onion/ matching "onion powder", etc. — all anchored now.
const PER_EACH = [
  [/\begg\b(?!plant)/, 50], [/\bbanana\b/, 120], [/\bapple\b(?!sauce)/, 180], [/\borange\b/, 130],
  [/\b(?:lemon|lime)\b/, 60], [/\bonion\b(?!\s*powder|\s*flake)/, 110], [/\b(?:garlic clove|clove)\b/, 5],
  [/\btomato\b(?!.*sauce|.*paste)/, 120], [/\bcherry tomato\b/, 17],
  [/\bbell pepper\b|\bpepper\b(?!.*flake|.*powder|.*black|.*white|.*ground)/, 120], [/\bzucchini\b/, 200],
  [/\bcucumber\b/, 200], [/\bcarrot\b/, 60], [/\bpotato\b(?!.*sweet)/, 170],
  [/\bsweet potato\b/, 130], [/\bavocado\b/, 200],
  [/\bchicken breast\b/, 170], [/\bchicken thigh\b/, 110],
  [/\btortilla\b/, 30],
  [/\b(?:bagel|english muffin|biscuit)\b/, 90], [/\b(?:dinner roll|hamburger bun|hot dog bun)\b/, 50],
  [/\bcelery\b.*\bstalk\b|\bstalk\b.*\bcelery\b/, 40],
  [/\bcan(?:ned)?\b/, 425], [/\bjar\b/, 680], [/\bpackage\b/, 200], [/\bloaf\b/, 450]
];

// Foods that are almost always counted by the slice in recipes even when
// the unit is "each" (a recipe saying "2 each bread" means 2 slices, not
// 2 loaves). Delegate to gramsPerSliceFor so the slice-weights table
// (bread=30g, american cheese=21g, bacon=10g) drives the answer. Without
// this, "2 each bread" + "2 each american cheese" was producing 1666 cal
// per serving for a grilled cheese instead of ~150.
const SLICED_FOOD_RE = /\b(bread|toast|baguette|brioche|sourdough|rye|pumpernickel|whole.?wheat|cheese|cheddar|provolone|swiss|mozzarella|monterey|colby|havarti|gouda|american|bacon|ham|prosciutto|deli|pepperoni|salami|pickle)\b/;

function gramsPerEachFor(name) {
  const n = (name || '').toLowerCase();
  if (SLICED_FOOD_RE.test(n)) return gramsPerSliceFor(name);
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
  let cal = 0, pro = 0, ca = 0, fa = 0, fi = 0, su = 0, so = 0;
  let covered = 0;
  let total = 0;
  if (!ingredients || !ingredients.length) return null;

  // Batch-fetch every ingredient's cached row in one query instead of N
  // round-trips. Keys are the canonicalize(name) form the searchFood path
  // writes under so the lookup hits — "diced tomatoes", "tomatoes",
  // "fresh tomatoes" all collapse to the same key "tomatoes".
  const names = ingredients.map(i => canonicalize(i.name));
  if (!names.length) return null;
  const placeholders = names.map(() => '?').join(',');
  const cached = db.prepare(
    `SELECT ingredient_name, calories_per_100g, protein_per_100g,
            carbs_per_100g, fat_per_100g,
            fiber_per_100g, sugar_per_100g, sodium_per_100g
       FROM nutrition_lookups
      WHERE ingredient_name IN (${placeholders})`
  ).all(...names);
  const byName = {};
  for (const row of cached) byName[row.ingredient_name] = row;

  for (const ing of ingredients) {
    const grams = unitToGrams(ing.quantity, ing.unit, ing.name);
    // Pure-flavor ingredients (unit "to taste", unparseable measurements
    // like "for serving") are excluded from both numerator AND denominator.
    // They're deliberately unquantifiable — counting them as "missing"
    // would falsely flag every recipe with a "salt to taste" line as
    // partial coverage.
    if (!grams) continue;
    total++;
    const food = byName[canonicalize(ing.name)];
    if (!food || food.calories_per_100g == null) continue;
    const factor = grams / 100;
    cal += (food.calories_per_100g || 0) * factor;
    pro += (food.protein_per_100g  || 0) * factor;
    ca  += (food.carbs_per_100g    || 0) * factor;
    fa  += (food.fat_per_100g      || 0) * factor;
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
    carbs:    +(ca  / s).toFixed(1),
    fat:      +(fa  / s).toFixed(1),
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
  let cal = 0, pro = 0, ca = 0, fa = 0, fi = 0, su = 0, so = 0;
  let covered = 0;
  let total = 0;
  for (const ing of ingredients || []) {
    const grams = unitToGrams(ing.quantity, ing.unit, ing.name);
    // Skip purely-flavor ingredients ("to taste", etc.) for both
    // covered AND total — same reasoning as nutritionFromCache above.
    if (!grams) continue;
    total++;
    const food = await searchFood(ing.name);
    if (!food || food.calories_per_100g == null) continue;
    const factor = grams / 100;
    cal += (food.calories_per_100g || 0) * factor;
    pro += (food.protein_per_100g || 0) * factor;
    ca  += (food.carbs_per_100g || 0)    * factor;
    fa  += (food.fat_per_100g || 0)      * factor;
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
    carbs:    +(ca  / s).toFixed(1),
    fat:      +(fa  / s).toFixed(1),
    fiber:    +(fi  / s).toFixed(1),
    sugar:    +(su  / s).toFixed(1),
    sodium:   +(so  / s).toFixed(1),
    covered_ingredients: covered,
    total_ingredients: total
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
