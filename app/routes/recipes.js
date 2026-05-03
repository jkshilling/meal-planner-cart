const express = require('express');
const db = require('../db');
const mealdb = require('../services/mealdb');
const spoonacular = require('../services/spoonacular');
const usda = require('../services/usda');

const router = express.Router();

function parseIngredients(body) {
  const names = [].concat(body.ing_name || []);
  const qtys = [].concat(body.ing_qty || []);
  const units = [].concat(body.ing_unit || []);
  const brands = [].concat(body.ing_brand || []);
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const name = (names[i] || '').trim();
    if (!name) continue;
    const qty = parseFloat(qtys[i]);
    out.push({
      name,
      quantity: isFinite(qty) && qty > 0 ? qty : 1,
      unit: (units[i] || 'each').trim() || 'each',
      brand_preference: (brands[i] || '').trim() || null
    });
  }
  return out;
}

function fetchRecipe(id) {
  const r = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  if (!r) return null;
  r.ingredients = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ?').all(id);
  return r;
}

router.get('/recipes', (req, res) => {
  const recipes = db.prepare('SELECT * FROM recipes ORDER BY meal_type, name').all();
  const editing = req.query.edit ? fetchRecipe(parseInt(req.query.edit, 10)) : null;
  const counts = {
    total: recipes.length,
    breakfast: recipes.filter(r => r.meal_type === 'breakfast').length,
    lunch: recipes.filter(r => r.meal_type === 'lunch').length,
    snack: recipes.filter(r => r.meal_type === 'snack').length,
    dinner: recipes.filter(r => r.meal_type === 'dinner').length,
    side: recipes.filter(r => r.meal_type === 'side').length,
    favorite: recipes.filter(r => r.favorite).length
  };
  res.render('recipes', { title: 'Recipes', recipes, editing, counts });
});

// Search TheMealDB for recipes matching a query. Returns JSON so the page
// can render results without a full reload.
// NOTE: defined above the POST /recipes/:id handler so the literal path
// match wins over the :id capture.
router.get('/recipes/search-online', async (req, res) => {
  const q = (req.query.q || '').trim();
  // Default to Spoonacular when its key is present (~360k recipes, has
  // built-in nutrition + cost). Fall back to TheMealDB (~300, free) when
  // either the key is missing or the user explicitly picks it.
  const requested = req.query.source;
  const source = requested === 'mealdb' ? 'mealdb' :
                 (requested === 'spoonacular' || spoonacular.isEnabled()) ? 'spoonacular' : 'mealdb';
  if (!q) return res.json({ results: [], source });
  try {
    let results;
    if (source === 'spoonacular' && spoonacular.isEnabled()) {
      results = await spoonacular.searchByName(q);
    } else {
      results = await mealdb.searchByName(q);
    }
    res.json({ results, source });
  } catch (e) {
    res.status(502).json({ error: e.message, results: [], source });
  }
});

// Compute estimated nutrition for a list of ingredients without persisting.
// Used by the "Pre-fill from USDA" button on the recipe form so the user
// can see what'll get saved before committing.
router.post('/recipes/nutrition-preview', express.json(), async (req, res) => {
  const ingredients = Array.isArray(req.body && req.body.ingredients) ? req.body.ingredients : [];
  const servings = parseInt((req.body && req.body.servings) || 1, 10) || 1;
  if (!ingredients.length) return res.json({ ok: false, reason: 'no ingredients' });
  try {
    const nutrition = await usda.recipeNutrition(ingredients, servings);
    res.json({ ok: true, nutrition });
  } catch (e) {
    res.json({ ok: false, reason: e.message });
  }
});

router.post('/recipes/import-online', async (req, res) => {
  const b = req.body;
  const sourceId = (b.source_id || '').toString();
  const source = b.source === 'spoonacular' ? 'spoonacular' : 'mealdb';
  if (!sourceId) return res.redirect('/recipes');
  try {
    const recipe = source === 'spoonacular' && spoonacular.isEnabled()
      ? await spoonacular.lookupById(sourceId)
      : await mealdb.lookupById(sourceId);
    if (!recipe) return res.redirect('/recipes?import_err=not_found');
    const mealType = ['breakfast', 'lunch', 'snack', 'dinner', 'side'].includes(b.meal_type) ? b.meal_type : recipe.meal_type;

    // Spoonacular returns nutrition + price baked into the response, so most
    // imported recipes already have those fields populated. TheMealDB returns
    // neither — we fall back to USDA only when the source didn't already set
    // any nutrition value.
    let { calories = null, protein = null, fiber = null, sugar = null, sodium = null } = recipe;
    const haveNutrition = [calories, protein, fiber, sugar, sodium].some(v => v != null);
    if (!haveNutrition) {
      const looked = await usda.recipeNutrition(recipe.ingredients, recipe.servings).catch(() => null);
      if (looked) ({ calories, protein, fiber, sugar, sodium } = looked);
    }

    const info = db.prepare(`INSERT INTO recipes
      (name, meal_type, cuisine, kid_friendly, prep_time, servings, est_cost, calories, protein, fiber, sugar, sodium, favorite, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(recipe.name, mealType, recipe.cuisine, 0, recipe.prep_time, recipe.servings, recipe.est_cost,
           calories, protein, fiber, sugar, sodium, 0, recipe.notes);
    const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit, brand_preference) VALUES (?, ?, ?, ?, ?)');
    for (const ing of recipe.ingredients) {
      insertIng.run(info.lastInsertRowid, ing.name, ing.quantity, ing.unit, ing.brand_preference);
    }
    return res.redirect('/recipes?edit=' + info.lastInsertRowid);
  } catch (e) {
    return res.redirect('/recipes?import_err=' + encodeURIComponent(e.message));
  }
});

router.post('/recipes', (req, res) => {
  const b = req.body;
  const warnings = [];
  const name = (b.name || '').trim();
  if (!name) warnings.push('Name required');
  const mealType = (b.meal_type || 'dinner').trim();
  const info = db.prepare(`INSERT INTO recipes
    (name, meal_type, cuisine, kid_friendly, prep_time, servings, est_cost, calories, protein, fiber, sugar, sodium, favorite, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      name || 'Untitled',
      mealType,
      (b.cuisine || '').trim() || null,
      b.kid_friendly ? 1 : 0,
      parseInt(b.prep_time, 10) || 20,
      parseInt(b.servings, 10) || 2,
      parseFloat(b.est_cost) || 8,
      b.calories ? parseInt(b.calories, 10) : null,
      b.protein ? parseFloat(b.protein) : null,
      b.fiber ? parseFloat(b.fiber) : null,
      b.sugar ? parseFloat(b.sugar) : null,
      b.sodium ? parseFloat(b.sodium) : null,
      b.favorite ? 1 : 0,
      (b.notes || '').trim() || null
    );
  const rid = info.lastInsertRowid;
  const ings = parseIngredients(b);
  const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit, brand_preference) VALUES (?, ?, ?, ?, ?)');
  for (const i of ings) insertIng.run(rid, i.name, i.quantity, i.unit, i.brand_preference);
  res.redirect('/recipes');
});

router.post('/recipes/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body;
  db.prepare(`UPDATE recipes SET
    name = ?, meal_type = ?, cuisine = ?, kid_friendly = ?, prep_time = ?, servings = ?, est_cost = ?,
    calories = ?, protein = ?, fiber = ?, sugar = ?, sodium = ?, favorite = ?, notes = ?
    WHERE id = ?`)
    .run(
      (b.name || 'Untitled').trim(),
      (b.meal_type || 'dinner').trim(),
      (b.cuisine || '').trim() || null,
      b.kid_friendly ? 1 : 0,
      parseInt(b.prep_time, 10) || 20,
      parseInt(b.servings, 10) || 2,
      parseFloat(b.est_cost) || 8,
      b.calories ? parseInt(b.calories, 10) : null,
      b.protein ? parseFloat(b.protein) : null,
      b.fiber ? parseFloat(b.fiber) : null,
      b.sugar ? parseFloat(b.sugar) : null,
      b.sodium ? parseFloat(b.sodium) : null,
      b.favorite ? 1 : 0,
      (b.notes || '').trim() || null,
      id
    );
  db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);
  const ings = parseIngredients(b);
  const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit, brand_preference) VALUES (?, ?, ?, ?, ?)');
  for (const i of ings) insertIng.run(id, i.name, i.quantity, i.unit, i.brand_preference);
  res.redirect('/recipes');
});

router.post('/recipes/:id/favorite', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const current = db.prepare('SELECT favorite FROM recipes WHERE id = ?').get(id);
  if (current) db.prepare('UPDATE recipes SET favorite = ? WHERE id = ?').run(current.favorite ? 0 : 1, id);
  res.redirect(req.get('referer') || '/recipes');
});

router.post('/recipes/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
  res.redirect('/recipes');
});

module.exports = router;
