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

// On save, recompute per-serving nutrition from the ingredients via USDA so
// users don't have to remember to click "Pre-fill from USDA" every time
// they tweak a recipe. Returns either { calories, protein, fiber, sugar,
// sodium } or null on any failure (no API key, network error, no
// ingredients matched). Form values are the fallback when null is returned,
// so a USDA outage never blocks a save.
async function recomputeNutrition(ings, servings) {
  if (!ings.length) return null;
  try {
    const r = await usda.recipeNutrition(ings, Math.max(1, servings || 1));
    if (!r || !r.covered_ingredients) return null;
    return {
      calories: r.calories,
      protein:  r.protein,
      fiber:    r.fiber,
      sugar:    r.sugar,
      sodium:   r.sodium
    };
  } catch (e) {
    return null;
  }
}

// Pick computed value when USDA returned one; otherwise fall back to whatever
// the form sent (parsed as the right type, or null if blank).
function pickNutrition(computed, formValue, parser) {
  if (computed != null) return computed;
  if (formValue === undefined || formValue === '' || formValue === null) return null;
  const v = parser(formValue);
  return Number.isFinite(v) ? v : null;
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
  const editing = req.query.edit ? fetchRecipe(parseInt(req.query.edit, 10), uid) : null;
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

    // Spoonacular populates nutrition directly; only fall back to USDA on
    // the rare recipe where their nutrient list came back empty.
    let { calories = null, protein = null, fiber = null, sugar = null, sodium = null } = recipe;
    const haveNutrition = [calories, protein, fiber, sugar, sodium].some(v => v != null);
    if (!haveNutrition) {
      const looked = await usda.recipeNutrition(recipe.ingredients, recipe.servings).catch(() => null);
      if (looked) ({ calories, protein, fiber, sugar, sodium } = looked);
    }

    const info = db.prepare(`INSERT INTO recipes
      (name, meal_type, cuisine, prep_time, servings, est_cost, calories, protein, fiber, sugar, sodium, favorite, notes, user_id, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(recipe.name, mealType, recipe.cuisine, recipe.prep_time, recipe.servings, recipe.est_cost,
           calories, protein, fiber, sugar, sodium, 0, recipe.notes, uid, sourceId);
    const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit) VALUES (?, ?, ?, ?)');
    for (const ing of recipe.ingredients) {
      insertIng.run(info.lastInsertRowid, ing.name, ing.quantity, ing.unit);
    }
    return res.redirect('/recipes?edit=' + info.lastInsertRowid);
  } catch (e) {
    return res.redirect('/recipes?import_err=' + encodeURIComponent(e.message));
  }
});

router.post('/recipes', requireAuth, async (req, res) => {
  const b = req.body;
  const name = (b.name || '').trim();
  const mealType = (b.meal_type || 'dinner').trim();
  const servings = parseInt(b.servings, 10) || 2;
  const ings = parseIngredients(b);
  // Recompute nutrition from ingredients whenever there's something to
  // compute against. Form values still ride along as fallback.
  const nut = await recomputeNutrition(ings, servings);
  const info = db.prepare(`INSERT INTO recipes
    (name, meal_type, cuisine, prep_time, servings, est_cost, calories, protein, fiber, sugar, sodium, favorite, notes, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      name || 'Untitled',
      mealType,
      (b.cuisine || '').trim() || null,
      parseInt(b.prep_time, 10) || 20,
      servings,
      parseFloat(b.est_cost) || 8,
      pickNutrition(nut && nut.calories, b.calories, v => parseInt(v, 10)),
      pickNutrition(nut && nut.protein,  b.protein,  parseFloat),
      pickNutrition(nut && nut.fiber,    b.fiber,    parseFloat),
      pickNutrition(nut && nut.sugar,    b.sugar,    parseFloat),
      pickNutrition(nut && nut.sodium,   b.sodium,   parseFloat),
      b.favorite ? 1 : 0,
      (b.notes || '').trim() || null,
      userIdOf(req)
    );
  const rid = info.lastInsertRowid;
  const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit) VALUES (?, ?, ?, ?)');
  for (const i of ings) insertIng.run(rid, i.name, i.quantity, i.unit);
  res.redirect('/recipes');
});

router.post('/recipes/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const uid = userIdOf(req);
  const b = req.body;
  const own = db.prepare('SELECT id FROM recipes WHERE id = ? AND user_id = ?').get(id, uid);
  if (!own) return res.status(404).render('error', { title: 'Not Found', message: 'Recipe not found.' });
  const servings = parseInt(b.servings, 10) || 2;
  const ings = parseIngredients(b);
  // Same auto-recompute on edit. Users had to remember to click "Pre-fill
  // from USDA" after every ingredient/serving tweak before this; now save
  // does it for them.
  const nut = await recomputeNutrition(ings, servings);
  db.prepare(`UPDATE recipes SET
    name = ?, meal_type = ?, cuisine = ?, prep_time = ?, servings = ?, est_cost = ?,
    calories = ?, protein = ?, fiber = ?, sugar = ?, sodium = ?, favorite = ?, notes = ?
    WHERE id = ? AND user_id = ?`)
    .run(
      (b.name || 'Untitled').trim(),
      (b.meal_type || 'dinner').trim(),
      (b.cuisine || '').trim() || null,
      parseInt(b.prep_time, 10) || 20,
      servings,
      parseFloat(b.est_cost) || 8,
      pickNutrition(nut && nut.calories, b.calories, v => parseInt(v, 10)),
      pickNutrition(nut && nut.protein,  b.protein,  parseFloat),
      pickNutrition(nut && nut.fiber,    b.fiber,    parseFloat),
      pickNutrition(nut && nut.sugar,    b.sugar,    parseFloat),
      pickNutrition(nut && nut.sodium,   b.sodium,   parseFloat),
      b.favorite ? 1 : 0,
      (b.notes || '').trim() || null,
      id,
      uid
    );
  db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);
  const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit) VALUES (?, ?, ?, ?)');
  for (const i of ings) insertIng.run(id, i.name, i.quantity, i.unit);
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
