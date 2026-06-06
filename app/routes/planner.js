const express = require('express');
const db = require('../db');
const planner = require('../services/planner');
const { loadProfile } = require('../services/planner');
const household = require('../services/household');
const { requireAuth, userIdOf } = require('../services/auth');

const router = express.Router();

router.get('/planner', requireAuth, (req, res) => {
  const uid = userIdOf(req);
  const p = household.profileForUser(uid);
  if (!p) return res.status(500).render('error', { title: 'No household', message: 'No household found.' });
  const latest = db.prepare('SELECT * FROM weekly_plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(uid);
  if (latest) return res.redirect('/plan/' + latest.id);

  // Surface recipe counts per meal type so the empty-state page can warn
  // the user about sparse library before they hit Generate. Without this,
  // generating against (say) zero lunch recipes silently produces a plan
  // with 7 empty lunch slots and no explanation.
  const fullProfile = loadProfile(p.id);
  const countsRows = db.prepare(
    'SELECT meal_type, COUNT(*) AS n FROM recipes WHERE user_id = ? GROUP BY meal_type'
  ).all(uid);
  const recipeCounts = {};
  for (const row of countsRows) recipeCounts[row.meal_type] = row.n;
  res.render('planner_empty', {
    title: 'Weekly Planner',
    enabledMealTypes: fullProfile.meal_types,
    recipeCounts
  });
});

// List every plan the user owns. Used to delete old plans and to navigate
// to historical plans (the /planner link only ever shows the latest). Each
// row reports total/filled slot counts so the user can see at a glance
// which plans are still half-empty (e.g. generated before the recipe
// library was populated for that meal type).
router.get('/plans', requireAuth, (req, res) => {
  const uid = userIdOf(req);

  // Auto-prune fully-empty plans (no filled slots at all). These accumulated
  // historically when the user regenerated against a too-thin library. The
  // user's MOST RECENT plan is preserved unconditionally — they might've
  // just generated it and be looking at it from /planner.
  db.prepare(`
    DELETE FROM weekly_plans
     WHERE user_id = ?
       AND id NOT IN (SELECT MAX(id) FROM weekly_plans WHERE user_id = ?)
       AND NOT EXISTS (
         SELECT 1 FROM weekly_plan_items
          WHERE plan_id = weekly_plans.id AND recipe_id IS NOT NULL
       )
  `).run(uid, uid);

  const plans = db.prepare(`
    SELECT p.id, p.start_date, p.status, p.total_cost, p.created_at,
           (SELECT COUNT(*) FROM weekly_plan_items WHERE plan_id = p.id) AS slots,
           (SELECT COUNT(*) FROM weekly_plan_items WHERE plan_id = p.id AND recipe_id IS NOT NULL) AS filled
      FROM weekly_plans p
     WHERE p.user_id = ?
     ORDER BY p.id DESC
  `).all(uid);
  res.render('plans_list', { title: 'All plans', plans });
});

// Delete a plan. ON DELETE CASCADE on weekly_plan_items.plan_id handles
// cleanup of the per-day slot rows automatically. Ownership is enforced
// by user_id in the WHERE clause; a forged id from someone else's account
// is a no-op.
router.post('/plan/:id/delete', requireAuth, (req, res) => {
  const uid = userIdOf(req);
  const id = parseInt(req.params.id, 10);
  if (Number.isInteger(id)) {
    db.prepare('DELETE FROM weekly_plans WHERE id = ? AND user_id = ?').run(id, uid);
  }
  res.redirect('/plans');
});

router.post('/planner/generate', requireAuth, (req, res) => {
  const uid = userIdOf(req);
  const p = household.profileForUser(uid);
  if (!p) return res.status(500).render('error', { title: 'No household', message: 'No household found.' });
  try {
    // Drafts overwrite themselves on regen — the previous "always insert
    // a new row" behavior accumulated stale empty plans every time the
    // user hit Regenerate, cluttering /plans. Approved plans are history
    // and stay put; only unapproved drafts get cleared.
    db.prepare(
      "DELETE FROM weekly_plans WHERE user_id = ? AND status = 'draft'"
    ).run(uid);
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

  // AJAX clients (the JS on /plan/:id) get JSON describing the slot's new
  // state and update the DOM in place — no full page reload, scroll stays.
  // Plain form submits still get a redirect (no-JS fallback works).
  if ((req.get('Accept') || '').includes('application/json')) {
    const slot = db.prepare(`
      SELECT i.recipe_id, i.side_recipe_id, i.locked,
             m.name AS main_name, m.prep_time AS main_prep, m.est_cost AS main_cost,
             s.name AS side_name, s.prep_time AS side_prep, s.est_cost AS side_cost
        FROM weekly_plan_items i
        LEFT JOIN recipes m ON m.id = i.recipe_id
        LEFT JOIN recipes s ON s.id = i.side_recipe_id
       WHERE i.plan_id = ? AND i.day = ? AND i.meal_type = ?
    `).get(planId, day, mealType);
    if (!slot) return res.json({ ok: false, reason: 'slot not found' });
    return res.json({
      ok: true,
      target,
      day,
      meal_type: mealType,
      recipe_id: slot.recipe_id,
      recipe_name: slot.main_name || null,
      prep_time: slot.main_prep,
      est_cost: slot.main_cost,
      side_recipe_id: slot.side_recipe_id,
      side_recipe_name: slot.side_name || null,
      side_prep_time: slot.side_prep,
      side_est_cost: slot.side_cost,
      locked: !!slot.locked
    });
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
  res.render('review', {
    title: `Plan ${id}`,
    plan,
    DAYS: planner.DAYS,
    allRecipes
  });
});

module.exports = router;
