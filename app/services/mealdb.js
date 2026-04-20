// Thin wrapper around TheMealDB (www.themealdb.com) — free, no API key.
// Docs: https://www.themealdb.com/api.php
//
// TheMealDB returns 1 meal per search by name (or by letter). We use the
// search-by-name endpoint and normalize the response into recipe objects
// matching our schema. TheMealDB has no prep time, cost, or nutrition —
// we leave those as reasonable defaults the user can edit after import.

const SEARCH_URL = (q) => `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(q)}`;
const LOOKUP_URL = (id) => `https://www.themealdb.com/api/json/v1/1/lookup.php?i=${encodeURIComponent(id)}`;

// TheMealDB's "category" -> our meal_type. Their categories are centered on
// the main protein/style rather than time-of-day, so this is a best-effort
// guess; the user can override before import.
function guessMealType(category) {
  if (!category) return 'dinner';
  const c = category.toLowerCase();
  if (c === 'breakfast') return 'breakfast';
  if (c === 'dessert' || c === 'miscellaneous') return 'snack';
  if (c === 'side') return 'side';
  if (c === 'starter') return 'lunch';
  return 'dinner';
}

function normalizeCuisine(area) {
  return area ? area.toLowerCase().trim() : null;
}

// Pull the numbered strIngredient1..20 + strMeasure1..20 pairs into
// [{ name, quantity, unit, brand_preference }]. TheMealDB's measure strings
// are freeform ("1 cup", "2 tbsp", "to taste"), so we do a coarse split.
function extractIngredients(meal) {
  const result = [];
  for (let i = 1; i <= 20; i++) {
    const rawName = (meal['strIngredient' + i] || '').trim();
    const rawMeasure = (meal['strMeasure' + i] || '').trim();
    if (!rawName) continue;
    const { quantity, unit } = parseMeasure(rawMeasure);
    result.push({ name: rawName.toLowerCase(), quantity, unit, brand_preference: null });
  }
  return result;
}

function parseMeasure(m) {
  if (!m) return { quantity: 1, unit: 'each' };
  const trimmed = m.trim();
  // Leading fraction like "1/2 cup" or "1 1/2 tsp"
  const fracMatch = trimmed.match(/^(\d+(?:\s+\d+\/\d+|\/\d+)?)\s*(.*)$/);
  if (fracMatch) {
    const numPart = fracMatch[1];
    const rest = fracMatch[2] || 'each';
    let quantity = 1;
    const mixed = numPart.match(/^(\d+)\s+(\d+)\/(\d+)$/);
    const simple = numPart.match(/^(\d+)\/(\d+)$/);
    const whole = numPart.match(/^(\d+)$/);
    if (mixed) quantity = parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
    else if (simple) quantity = parseInt(simple[1], 10) / parseInt(simple[2], 10);
    else if (whole) quantity = parseInt(whole[1], 10);
    return { quantity: +quantity.toFixed(3), unit: rest.trim().toLowerCase() || 'each' };
  }
  return { quantity: 1, unit: trimmed.toLowerCase() };
}

function mealToRecipe(meal) {
  if (!meal) return null;
  return {
    source: 'mealdb',
    source_id: meal.idMeal,
    name: meal.strMeal,
    meal_type: guessMealType(meal.strCategory),
    cuisine: normalizeCuisine(meal.strArea),
    kid_friendly: 0,
    prep_time: 30,
    servings: 4,
    est_cost: 10,
    calories: null,
    protein: null,
    fiber: null,
    sugar: null,
    sodium: null,
    notes: (meal.strInstructions || '').slice(0, 2000),
    image_url: meal.strMealThumb || null,
    category: meal.strCategory || null,
    ingredients: extractIngredients(meal)
  };
}

async function searchByName(query) {
  const res = await fetch(SEARCH_URL(query));
  if (!res.ok) throw new Error(`TheMealDB search failed: ${res.status}`);
  const data = await res.json();
  if (!data.meals) return [];
  return data.meals.map(mealToRecipe).filter(Boolean);
}

async function lookupById(id) {
  const res = await fetch(LOOKUP_URL(id));
  if (!res.ok) throw new Error(`TheMealDB lookup failed: ${res.status}`);
  const data = await res.json();
  if (!data.meals || !data.meals[0]) return null;
  return mealToRecipe(data.meals[0]);
}

module.exports = { searchByName, lookupById, mealToRecipe };
