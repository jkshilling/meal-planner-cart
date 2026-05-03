const express = require('express');
const db = require('../db');
const planner = require('../services/planner');
const household = require('../services/household');
const { requireAuth, userIdOf } = require('../services/auth');

const router = express.Router();

router.get('/planner', requireAuth, (req, res) => {
  const uid = userIdOf(req);
  const p = household.profileForUser(uid);
  if (!p) return res.status(500).render('error', { title: 'No household', message: 'No household found.' });
  const latest = db.prepare('SELECT * FROM weekly_plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(uid);
  if (latest) return res.redirect('/plan/' + latest.id);
  res.render('planner_empty', { title: 'Weekly Planner' });
});

router.post('/planner/generate', requireAuth, (req, res) => {
  const uid = userIdOf(req);
  const p = household.profileForUser(uid);
  if (!p) return res.status(500).render('error', { title: 'No household', message: 'No household found.' });
  try {
    const generated = planner.generatePlan(p.id, uid);
    const planId = planner.savePlan(p.id, generated, uid);
    res.redirect('/plan/' + planId);
  } catch (e) {
    res.status(400).render('error', { title: 'Error', message: e.message });
  }
});

// Ownership guard: refuses to mutate a plan owned by another user.
function planOwnedByRequestOr404(req, res, planId) {
  const uid = userIdOf(req);
  const p = db.prepare('SELECT id FROM weekly_plans WHERE id = ? AND user_id = ?').get(planId, uid);
  if (!p) {
    res.status(404).render('error', { title: 'Not Found', message: 'Plan not found.' });
    return false;
  }
  return true;
}

router.post('/planner/update-slot', requireAuth, (req, res) => {
  const b = req.body;
  const planId = parseInt(b.plan_id, 10);
  if (!planOwnedByRequestOr404(req, res, planId)) return;
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

router.post('/planner/approve', requireAuth, (req, res) => {
  const planId = parseInt(req.body.plan_id, 10);
  if (!planOwnedByRequestOr404(req, res, planId)) return;
  planner.approvePlan(planId);
  res.redirect('/plan/' + planId);
});

router.get('/plan/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!planOwnedByRequestOr404(req, res, id)) return;
  const plan = planner.loadPlan(id);
  if (!plan) return res.status(404).render('error', { title: 'Not Found', message: 'Plan not found' });
  const uid = userIdOf(req);
  // Recipes shown in the swap dropdowns are scoped to this user.
  const allRecipes = db.prepare(
    'SELECT id, name, meal_type FROM recipes WHERE user_id = ? ORDER BY meal_type, name'
  ).all(uid);
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
