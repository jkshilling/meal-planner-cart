const express = require('express');
const db = require('../db');

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
  const recipes = db.prepare('SELECT * FROM recipes ORDER BY archived, meal_type, name').all();
  const editing = req.query.edit ? fetchRecipe(parseInt(req.query.edit, 10)) : null;
  res.render('recipes', { title: 'Recipes', recipes, editing });
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

router.post('/recipes/:id/archive', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const current = db.prepare('SELECT archived FROM recipes WHERE id = ?').get(id);
  if (current) db.prepare('UPDATE recipes SET archived = ? WHERE id = ?').run(current.archived ? 0 : 1, id);
  res.redirect('/recipes');
});

module.exports = router;
