const express = require('express');
const db = require('../db');
const shopping = require('../services/shopping');
const { requireAuth, userIdOf } = require('../services/auth');

const router = express.Router();

// Plan ownership guard. Returns the plan row on success; on a miss it sends
// 404 and returns null so callers can early-return.
function loadOwnedPlan(req, res, planId) {
  const uid = userIdOf(req);
  const plan = db.prepare('SELECT * FROM weekly_plans WHERE id = ? AND user_id = ?').get(planId, uid);
  if (!plan) {
    res.status(404).render('error', { title: 'Not Found', message: 'Plan not found' });
    return null;
  }
  return plan;
}

// /shopping — convenience entry point used by the top nav. Resolves to the
// most-recent plan's shopping list. If there's no plan yet, kick back to
// /planner with a hint instead of 404'ing.
router.get('/shopping', requireAuth, (req, res) => {
  const uid = userIdOf(req);
  const latest = db.prepare('SELECT id FROM weekly_plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(uid);
  if (!latest) return res.redirect('/planner');
  return res.redirect('/plan/' + latest.id + '/shopping');
});

router.post('/plan/:id/build-shopping', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const plan = loadOwnedPlan(req, res, id);
  if (!plan) return;
  if (plan.status !== 'approved') {
    return res.status(400).render('error', { title: 'Not approved', message: 'Plan must be approved before building a shopping list.' });
  }
  try {
    shopping.buildShoppingList(id);
  } catch (e) {
    return res.status(500).render('error', { title: 'Shopping list error', message: e.message });
  }
  res.redirect('/plan/' + id + '/shopping');
});

router.get('/plan/:id/shopping', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const plan = loadOwnedPlan(req, res, id);
  if (!plan) return;
  const items = shopping.loadShoppingItems(id);
  res.render('shopping', { title: 'Shopping list', plan, items });
});

router.post('/plan/:id/shopping/item', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!loadOwnedPlan(req, res, id)) return;
  const b = req.body;
  if (b.action === 'add') {
    shopping.addManualItem(id, {
      name: (b.name || '').trim(),
      quantity: parseFloat(b.quantity) || 1,
      unit: (b.unit || 'each').trim()
    });
  } else if (b.action === 'delete') {
    shopping.deleteShoppingItem(parseInt(b.item_id, 10));
  } else if (b.action === 'update') {
    shopping.updateShoppingItem(parseInt(b.item_id, 10), {
      name: b.name,
      quantity: parseFloat(b.quantity) || 1,
      unit: b.unit,
      approved: b.approved ? 1 : 0
    });
  }
  res.redirect('/plan/' + id + '/shopping');
});

module.exports = router;
