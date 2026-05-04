const express = require('express');
const db = require('../db');
const spoonacular = require('../services/spoonacular');
const usda = require('../services/usda');
const household = require('../services/household');
const { loadProfile, dinersFor } = require('../services/planner');
const { requireAuth, userIdOf } = require('../services/auth');

const router = express.Router();

// Gate routes on the bootstrap owner. Used by the "exclude from master
// library" handler — only the owner can curate the master library.
function requireOwner(req, res, next) {
  if (res.locals.isOwner) return next();
  return res.status(403).render('error', {
    title: 'Forbidden',
    message: 'This action is owner-only.'
  });
}

function parseIngredients(body) {
  const names = [].concat(body.ing_name || []);
  const qtys = [].concat(body.ing_qty || []);
  const units = [].concat(body.ing_unit || []);
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const name = (names[i] || '').trim();
    if (!name) continue;
    const qty = parseFloat(qtys[i]);
    out.push({
      name,
      quantity: isFinite(qty) && qty > 0 ? qty : 1,
      unit: (units[i] || 'each').trim() || 'each'
    });
  }
  return out;
}

// Fire-and-forget: hit USDA for each ingredient name so nutrition_lookups
// is warm by the next render. Don't await, don't block the save, never
// throw. The recipe list / planner read derived nutrition from the cache
// at render time (services/usda.nutritionFromCache); this is what makes
// sure that cache has data to read.
function warmNutritionCache(ings, servings) {
  if (!ings || !ings.length) return;
  // Fire and forget. searchFood populates nutrition_lookups; recipeNutrition
  // is a convenient way to hit every ingredient in one go.
  usda.recipeNutrition(ings, Math.max(1, servings || 1)).catch(() => {});
}

// Fetch a recipe scoped to the request's user. Returns null on miss
// (not-found OR not-owned both look the same — by design, no information leak).
function fetchRecipe(id, uid) {
  const r = db.prepare('SELECT * FROM recipes WHERE id = ? AND user_id = ?').get(id, uid);
  if (!r) return null;
  r.ingredients = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ?').all(id);
  return r;
}

router.get('/recipes', requireAuth, (req, res) => {
  const uid = userIdOf(req);
  const recipes = db.prepare('SELECT * FROM recipes WHERE user_id = ? ORDER BY meal_type, name').all(uid);
  // Attach ingredients + computed-from-cache nutrition to every recipe.
  // Nutrition is derived (no longer stored on recipes) so unit/USDA logic
  // changes propagate to the UI on next render — no save sweep required.
  const allIds = recipes.map(r => r.id);
  if (allIds.length) {
    const placeholders = allIds.map(() => '?').join(',');
    const allIngs = db.prepare(
      `SELECT * FROM recipe_ingredients WHERE recipe_id IN (${placeholders})`
    ).all(...allIds);
    const byRecipe = {};
    for (const r of recipes) { r.ingredients = []; byRecipe[r.id] = r; }
    for (const ing of allIngs) {
      if (byRecipe[ing.recipe_id]) byRecipe[ing.recipe_id].ingredients.push(ing);
    }
    for (const r of recipes) {
      const n = usda.nutritionFromCache(r.ingredients, r.servings);
      r.calories = n ? n.calories : null;
      r.protein  = n ? n.protein  : null;
      r.fiber    = n ? n.fiber    : null;
      r.sugar    = n ? n.sugar    : null;
      r.sodium   = n ? n.sodium   : null;
    }
  }
  const editing = req.query.edit ? fetchRecipe(parseInt(req.query.edit, 10), uid) : null;
  if (editing) {
    const n = usda.nutritionFromCache(editing.ingredients, editing.servings);
    editing.calories = n ? n.calories : null;
    editing.protein  = n ? n.protein  : null;
    editing.fiber    = n ? n.fiber    : null;
    editing.sugar    = n ? n.sugar    : null;
    editing.sodium   = n ? n.sodium   : null;
  }
  const counts = {
    total: recipes.length,
    breakfast: recipes.filter(r => r.meal_type === 'breakfast').length,
    lunch: recipes.filter(r => r.meal_type === 'lunch').length,
    snack: recipes.filter(r => r.meal_type === 'snack').length,
    dinner: recipes.filter(r => r.meal_type === 'dinner').length,
    side: recipes.filter(r => r.meal_type === 'side').length,
    favorite: recipes.filter(r => r.favorite).length
  };

  // Per-recipe "adjusted_serves" — how many servings of this recipe will
  // actually be cooked given the current household's per-meal-type behavior.
  // For dinner recipes: dinersFor(profile, 'dinner'). For sides: null,
  // because sides inherit the diner count of whichever main slot they're
  // paired with at planning time. The view uses adjusted_serves +
  // r.servings to render a multiplier ("0.25×", "1.5×") so the user knows
  // how much of each recipe will actually land in their shopping list.
  const profileRow = household.profileForUser(uid);
  const profile = profileRow ? loadProfile(profileRow.id) : null;
  for (const r of recipes) {
    if (!profile || r.meal_type === 'side') {
      r.adjusted_serves = null;
    } else {
      r.adjusted_serves = dinersFor(profile, r.meal_type);
    }
  }

  res.render('recipes', { title: 'Recipes', recipes, editing, counts });
});

// Search Spoonacular for recipes matching a query. Returns JSON so the
// page can render results without a full reload.
// NOTE: defined above the POST /recipes/:id handler so the literal path
// match wins over the :id capture.
router.get('/recipes/search-online', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  if (!spoonacular.isEnabled()) {
    return res.status(503).json({ error: 'SPOONACULAR_API_KEY not set on server', results: [] });
  }
  try {
    const results = await spoonacular.searchByName(q);
    res.json({ results });
  } catch (e) {
    res.status(502).json({ error: e.message, results: [] });
  }
});

// Compute estimated nutrition for a list of ingredients without persisting.
// Used by the "Pre-fill from USDA" button on the recipe form so the user
// can see what'll get saved before committing.
router.post('/recipes/nutrition-preview', requireAuth, express.json(), async (req, res) => {
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

router.post('/recipes/import-online', requireAuth, async (req, res) => {
  const b = req.body;
  const sourceId = (b.source_id || '').toString();
  if (!sourceId) return res.redirect('/recipes');
  if (!spoonacular.isEnabled()) {
    return res.redirect('/recipes?import_err=' + encodeURIComponent('SPOONACULAR_API_KEY not set'));
  }
  try {
    const uid = userIdOf(req);
    // Skip if this Spoonacular recipe is already in the user's library.
    const existing = db.prepare(
      'SELECT id FROM recipes WHERE user_id = ? AND source_id = ?'
    ).get(uid, sourceId);
    if (existing) {
      return res.redirect('/recipes?edit=' + existing.id);
    }

    const recipe = await spoonacular.lookupById(sourceId);
    if (!recipe) return res.redirect('/recipes?import_err=not_found');
    const mealType = ['breakfast', 'lunch', 'snack', 'dinner', 'side'].includes(b.meal_type) ? b.meal_type : recipe.meal_type;

    const info = db.prepare(`INSERT INTO recipes
      (name, meal_type, cuisine, prep_time, servings, est_cost, favorite, notes, user_id, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(recipe.name, mealType, recipe.cuisine, recipe.prep_time, recipe.servings, recipe.est_cost,
           0, recipe.notes, uid, sourceId);
    const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit) VALUES (?, ?, ?, ?)');
    for (const ing of recipe.ingredients) {
      insertIng.run(info.lastInsertRowid, ing.name, ing.quantity, ing.unit);
    }
    // Warm USDA cache for any new ingredient names so the next render of
    // the list/edit form has nutrition data to display.
    warmNutritionCache(recipe.ingredients, recipe.servings);
    return res.redirect('/recipes?edit=' + info.lastInsertRowid);
  } catch (e) {
    return res.redirect('/recipes?import_err=' + encodeURIComponent(e.message));
  }
});

router.post('/recipes', requireAuth, (req, res) => {
  const b = req.body;
  const name = (b.name || '').trim();
  const mealType = (b.meal_type || 'dinner').trim();
  const servings = parseInt(b.servings, 10) || 2;
  const ings = parseIngredients(b);
  const info = db.prepare(`INSERT INTO recipes
    (name, meal_type, cuisine, prep_time, servings, est_cost, favorite, notes, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      name || 'Untitled',
      mealType,
      (b.cuisine || '').trim() || null,
      parseInt(b.prep_time, 10) || 20,
      servings,
      parseFloat(b.est_cost) || 8,
      b.favorite ? 1 : 0,
      (b.notes || '').trim() || null,
      userIdOf(req)
    );
  const rid = info.lastInsertRowid;
  const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit) VALUES (?, ?, ?, ?)');
  for (const i of ings) insertIng.run(rid, i.name, i.quantity, i.unit);
  // Warm USDA cache for any new ingredient names so the recipe list shows
  // nutrition on next render. Fire-and-forget so the save doesn't block.
  warmNutritionCache(ings, servings);
  res.redirect('/recipes');
});

router.post('/recipes/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const uid = userIdOf(req);
  const b = req.body;
  const own = db.prepare('SELECT id FROM recipes WHERE id = ? AND user_id = ?').get(id, uid);
  if (!own) return res.status(404).render('error', { title: 'Not Found', message: 'Recipe not found.' });
  const servings = parseInt(b.servings, 10) || 2;
  const ings = parseIngredients(b);
  db.prepare(`UPDATE recipes SET
    name = ?, meal_type = ?, cuisine = ?, prep_time = ?, servings = ?, est_cost = ?,
    favorite = ?, notes = ?
    WHERE id = ? AND user_id = ?`)
    .run(
      (b.name || 'Untitled').trim(),
      (b.meal_type || 'dinner').trim(),
      (b.cuisine || '').trim() || null,
      parseInt(b.prep_time, 10) || 20,
      servings,
      parseFloat(b.est_cost) || 8,
      b.favorite ? 1 : 0,
      (b.notes || '').trim() || null,
      id,
      uid
    );
  db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);
  const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit) VALUES (?, ?, ?, ?)');
  for (const i of ings) insertIng.run(id, i.name, i.quantity, i.unit);
  // Warm USDA cache for any newly-introduced ingredient names. Fire-and-forget.
  warmNutritionCache(ings, servings);
  res.redirect('/recipes');
});

router.post('/recipes/:id/favorite', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const uid = userIdOf(req);
  const current = db.prepare('SELECT favorite FROM recipes WHERE id = ? AND user_id = ?').get(id, uid);
  if (current) {
    db.prepare('UPDATE recipes SET favorite = ? WHERE id = ? AND user_id = ?')
      .run(current.favorite ? 0 : 1, id, uid);
  }
  res.redirect(req.get('referer') || '/recipes');
});

router.post('/recipes/:id/delete', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const uid = userIdOf(req);
  db.prepare('DELETE FROM recipes WHERE id = ? AND user_id = ?').run(id, uid);
  res.redirect('/recipes');
});

// Owner-only. Marks the recipe's source_id as excluded from the master
// library AND deletes the owner's copy in one transaction. Future re-syncs
// (signup-time seeding + the explicit re-sync button) will skip this
// source_id, so the recipe never re-appears in the owner's library or any
// new user's seeded library. Existing copies in OTHER users' libraries
// are NOT retroactively deleted — those users may have personalized them.
//
// 404s if the recipe doesn't exist for the owner or has no source_id
// (hand-entered recipes can't be "excluded from the master library"
// because they were never in it).
router.post('/recipes/:id/exclude', requireAuth, requireOwner, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const uid = userIdOf(req);
  const r = db.prepare('SELECT id, source_id, name FROM recipes WHERE id = ? AND user_id = ?').get(id, uid);
  if (!r) return res.status(404).render('error', { title: 'Not Found', message: 'Recipe not found.' });
  if (!r.source_id) {
    return res.status(400).render('error', {
      title: 'Not eligible',
      message: 'This recipe is hand-entered and isn\'t part of the master library — there\'s nothing to exclude.'
    });
  }
  const tx = db.transaction(() => {
    household.excludeFromMasterLibrary(r.source_id, `excluded by owner via recipe row: "${r.name}"`);
    db.prepare('DELETE FROM recipes WHERE id = ? AND user_id = ?').run(id, uid);
  });
  tx();
  if (req.session) {
    req.session.flash = {
      type: 'success',
      message: `Excluded "${r.name}" from the master library. Future re-syncs will skip it.`
    };
  }
  res.redirect('/recipes');
});

module.exports = router;
