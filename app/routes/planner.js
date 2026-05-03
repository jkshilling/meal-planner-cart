const express = require('express');
const db = require('../db');
const planner = require('../services/planner');

const router = express.Router();

function activeProfile() {
  return db.prepare('SELECT * FROM household_profiles WHERE active = 1 ORDER BY id LIMIT 1').get();
}

router.get('/planner', (req, res) => {
  const p = activeProfile();
  const latest = db.prepare('SELECT * FROM weekly_plans WHERE profile_id = ? ORDER BY id DESC LIMIT 1').get(p.id);
  if (latest) return res.redirect('/plan/' + latest.id);
  res.render('planner_empty', { title: 'Weekly Planner' });
});

router.post('/planner/generate', (req, res) => {
  const p = activeProfile();
  try {
    const generated = planner.generatePlan(p.id);
    const planId = planner.savePlan(p.id, generated);
    res.redirect('/plan/' + planId);
  } catch (e) {
    res.status(400).render('error', { title: 'Error', message: e.message });
  }
});

router.post('/planner/update-slot', (req, res) => {
  const b = req.body;
  const planId = parseInt(b.plan_id, 10);
  const day = parseInt(b.day, 10);
  const mealType = b.meal_type;
  const target = b.target === 'side' ? 'side' : 'main';
  if (b.action === 'regenerate') {
    planner.regenerateSlot(planId, day, mealType, target);
  } else if (b.action === 'lock') {
    const cur = db.prepare('SELECT locked FROM weekly_plan_items WHERE plan_id = ? AND day = ? AND meal_type = ?').get(planId, day, mealType);
    db.prepare('UPDATE weekly_plan_items SET locked = ? WHERE plan_id = ? AND day = ? AND meal_type = ?')
      .run(cur && cur.locked ? 0 : 1, planId, day, mealType);
  } else {
    const recipeId = b.recipe_id ? parseInt(b.recipe_id, 10) : null;
    planner.updateSlot(planId, day, mealType, recipeId, false, target);
  }
  res.redirect('/plan/' + planId);
});

router.post('/planner/approve', (req, res) => {
  const planId = parseInt(req.body.plan_id, 10);
  planner.approvePlan(planId);
  res.redirect('/plan/' + planId);
});

router.get('/plan/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const plan = planner.loadPlan(id);
  if (!plan) return res.status(404).render('error', { title: 'Not Found', message: 'Plan not found' });
  const allRecipes = db.prepare('SELECT id, name, meal_type FROM recipes ORDER BY meal_type, name').all();
  const shopping = db.prepare('SELECT * FROM shopping_items WHERE plan_id = ? ORDER BY name').all(id);
  const matches = db.prepare(`SELECT wm.*, si.name as item_name FROM walmart_matches wm
    JOIN shopping_items si ON wm.shopping_item_id = si.id
    WHERE si.plan_id = ? ORDER BY si.name`).all(id);
  res.render('review', {
    title: `Plan ${id}`,
    plan,
    DAYS: planner.DAYS,
    allRecipes,
    shopping,
    matches
  });
});

module.exports = router;
