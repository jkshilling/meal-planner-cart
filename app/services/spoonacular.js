// Spoonacular recipe search + import.
// API: https://spoonacular.com/food-api
// Docs: https://spoonacular.com/food-api/docs
//
// Per-recipe nutrition AND pricePerServing are baked into responses, so
// imported recipes land with both nutrition and cost pre-filled.
//
// Cost model: free tier is 150 "points" per day. complexSearch with
// addRecipeInformation+addRecipeNutrition costs ~1.5 points per call,
// so a friend importing 10+ recipes/day stays well under the cap.
//
// Key: process.env.SPOONACULAR_API_KEY. If missing, isEnabled() returns
// false and the search/import routes return errors — same flag-off
// pattern as Walmart.

const SP_BASE = 'https://api.spoonacular.com';

function apiKey() {
  return process.env.SPOONACULAR_API_KEY || '';
}

function isEnabled() {
  return !!apiKey();
}

// Spoonacular's `dishTypes` array is the closest signal to our meal_type.
// They use a freeform list ("breakfast", "side dish", "lunch", "main course",
// "dessert", "snack", etc.). Map to our enum.
function guessMealType(recipe) {
  const types = (recipe.dishTypes || []).map(t => t.toLowerCase());
  if (types.includes('breakfast') || types.includes('morning meal') || types.includes('brunch')) return 'breakfast';
  if (types.includes('side dish') || types.includes('side')) return 'side';
  if (types.includes('snack') || types.includes('appetizer') || types.includes('finger food') || types.includes('antipasto')) return 'snack';
  if (types.includes('dessert')) return 'snack';  // map desserts → snack since we have no dessert slot
  if (types.includes('lunch')) return 'lunch';
  if (types.includes('main course') || types.includes('main dish') || types.includes('dinner')) return 'dinner';
  return 'dinner';  // sensible default
}

function normalizeCuisine(recipe) {
  const cuisines = recipe.cuisines || [];
  return cuisines.length ? cuisines[0].toLowerCase() : null;
}

function extractIngredients(recipe) {
  const ext = recipe.extendedIngredients || [];
  return ext.map(i => ({
    name: (i.nameClean || i.name || '').toLowerCase().trim(),
    quantity: typeof i.amount === 'number' && i.amount > 0 ? +i.amount.toFixed(3) : 1,
    unit: (i.unit || 'each').trim().toLowerCase() || 'each'
  })).filter(i => i.name);
}

// Extract nutrition (per-serving values directly from Spoonacular).
function extractNutrition(recipe) {
  const nutrients = (recipe.nutrition && recipe.nutrition.nutrients) || [];
  const find = name => {
    const n = nutrients.find(x => (x.name || '').toLowerCase() === name.toLowerCase());
    return n ? +Number(n.amount).toFixed(1) : null;
  };
  return {
    calories: find('Calories') ? Math.round(find('Calories')) : null,
    protein:  find('Protein'),
    fiber:    find('Fiber'),
    sugar:    find('Sugar'),
    sodium:   find('Sodium')
  };
}

function priceUSDFor(recipe) {
  // pricePerServing is in cents per serving. Convert to dollars per recipe.
  const cents = typeof recipe.pricePerServing === 'number' ? recipe.pricePerServing : null;
  if (cents == null) return null;
  const servings = recipe.servings || 1;
  return +((cents * servings) / 100).toFixed(2);
}

function spoonacularToRecipe(r) {
  if (!r) return null;
  const ingredients = extractIngredients(r);
  const nutrition = extractNutrition(r);
  return {
    source: 'spoonacular',
    source_id: String(r.id),
    name: r.title || 'Untitled',
    meal_type: guessMealType(r),
    cuisine: normalizeCuisine(r),
    prep_time: r.readyInMinutes || 30,
    servings: r.servings || 4,
    est_cost: priceUSDFor(r) ?? 10,
    calories: nutrition.calories,
    protein:  nutrition.protein,
    fiber:    nutrition.fiber,
    sugar:    nutrition.sugar,
    sodium:   nutrition.sodium,
    notes: (r.summary || '').replace(/<[^>]+>/g, '').slice(0, 2000),  // strip HTML
    image_url: r.image || null,
    category: (r.dishTypes || [])[0] || null,
    ingredients
  };
}

// complexSearch with addRecipeInformation/Nutrition gets us everything in one
// call — full recipe data for each result, no second per-import lookup.
//
// Accepts either a free-text `query` (themed pull, e.g. "chicken curry"),
// a Spoonacular `type` filter (broad dish-type pull, e.g. "side dish"),
// or both. Without `query`, the type filter alone returns Spoonacular's
// most popular recipes of that dishType — useful for filling buckets
// where you want variety, not specific themes (sides, snacks, salads).
async function searchRecipes(opts) {
  if (!isEnabled()) throw new Error('SPOONACULAR_API_KEY not set');
  const { query, type, limit = 8, offset = 0, sort, filters = {} } = opts || {};
  if (!query && !type) throw new Error('searchRecipes: query or type required');
  const params = new URLSearchParams({
    number: String(limit),
    addRecipeInformation: 'true',
    addRecipeNutrition: 'true',
    fillIngredients: 'true',  // populates extendedIngredients on each result
    instructionsRequired: 'true',
    apiKey: apiKey()
  });
  if (query) params.set('query', query);
  if (type)  params.set('type', type);
  if (offset) params.set('offset', String(offset));
  if (sort) params.set('sort', sort);
  // Forward any nutrition / time filters to Spoonacular as-is. Their
  // complexSearch supports min/max for every macro plus maxReadyTime,
  // minHealthScore, intolerances, diet, includeIngredients, etc. The
  // caller knows the schema; this layer just passes through.
  for (const [k, v] of Object.entries(filters)) {
    if (v != null && v !== '') params.set(k, String(v));
  }
  const url = `${SP_BASE}/recipes/complexSearch?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Spoonacular ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.results || []).map(spoonacularToRecipe).filter(Boolean);
}

// Backward-compat wrapper. Same signature as the old function.
async function searchByName(query, limit = 8) {
  return searchRecipes({ query, limit });
}

async function lookupById(id) {
  if (!isEnabled()) throw new Error('SPOONACULAR_API_KEY not set');
  const url = `${SP_BASE}/recipes/${encodeURIComponent(id)}/information?includeNutrition=true&apiKey=${encodeURIComponent(apiKey())}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Spoonacular ${res.status}`);
  const data = await res.json();
  return spoonacularToRecipe(data);
}

module.exports = { isEnabled, searchByName, searchRecipes, lookupById, spoonacularToRecipe };
