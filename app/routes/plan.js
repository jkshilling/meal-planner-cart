const express = require('express');
const db = require('../db');
const shopping = require('../services/shopping');
const matcher = require('../services/matcher');
const walmart = require('../../automation/walmart');

const router = express.Router();

router.post('/plan/:id/build-shopping', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const plan = db.prepare('SELECT * FROM weekly_plans WHERE id = ?').get(id);
  if (!plan) return res.status(404).render('error', { title: 'Not Found', message: 'Plan not found' });
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

router.get('/plan/:id/shopping', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const plan = db.prepare('SELECT * FROM weekly_plans WHERE id = ?').get(id);
  if (!plan) return res.status(404).render('error', { title: 'Not Found', message: 'Plan not found' });
  const items = shopping.loadShoppingItems(id);
  const matches = shopping.loadMatches(id);
  res.render('shopping', { title: 'Shopping + Walmart', plan, items, matches });
});

router.post('/plan/:id/shopping/item', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body;
  if (b.action === 'add') {
    shopping.addManualItem(id, {
      name: (b.name || '').trim(),
      quantity: parseFloat(b.quantity) || 1,
      unit: (b.unit || 'each').trim(),
      brand_preference: (b.brand || '').trim() || null
    });
  } else if (b.action === 'delete') {
    shopping.deleteShoppingItem(parseInt(b.item_id, 10));
  } else if (b.action === 'update') {
    shopping.updateShoppingItem(parseInt(b.item_id, 10), {
      name: b.name,
      quantity: parseFloat(b.quantity) || 1,
      unit: b.unit,
      brand_preference: (b.brand || '').trim() || null,
      approved: b.approved ? 1 : 0
    });
  }
  res.redirect('/plan/' + id + '/shopping');
});

router.post('/plan/:id/match-walmart', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const items = db.prepare('SELECT * FROM shopping_items WHERE plan_id = ? AND approved = 1').all(id);
  const errors = [];
  try {
    for (const item of items) {
      const query = [item.brand_preference, item.name].filter(Boolean).join(' ');
      const { blocked, candidates } = await walmart.searchProducts(query, 5);
      if (blocked) { errors.push(`Captcha/login wall while searching: ${item.name}`); break; }
      const ranked = matcher.rankCandidates(item, candidates);
      matcher.saveMatch(item.id, ranked);
    }
  } catch (e) {
    errors.push('Match error: ' + e.message);
  }
  // Stash errors on a minimal run row for visibility (optional)
  res.redirect('/plan/' + id + '/shopping' + (errors.length ? '?err=' + encodeURIComponent(errors.join(' | ')) : ''));
});

router.post('/plan/:id/shopping/approve-match', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body;
  const itemId = parseInt(b.item_id, 10);
  if (b.action === 'approve') matcher.setApproval(itemId, true);
  else if (b.action === 'unapprove') matcher.setApproval(itemId, false);
  else if (b.action === 'pick') matcher.approveMatch(itemId, parseInt(b.candidate_index, 10) || 0);
  res.redirect('/plan/' + id + '/shopping');
});

router.post('/plan/:id/add-to-cart', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const approved = db.prepare(`
    SELECT wm.*, si.name as item_name FROM walmart_matches wm
    JOIN shopping_items si ON wm.shopping_item_id = si.id
    WHERE si.plan_id = ? AND wm.approved = 1 AND wm.product_url IS NOT NULL
  `).all(id);

  const runInfo = db.prepare(`INSERT INTO automation_runs (plan_id, status) VALUES (?, 'running')`).run(id);
  const runId = runInfo.lastInsertRowid;
  const log = [];
  let successCount = 0, failureCount = 0;

  try {
    // Open a browser and let the user log in manually if needed before starting.
    await walmart.openForManualLogin();
    for (const m of approved) {
      const result = await walmart.addToCart(m.product_url);
      if (result.success) { successCount++; log.push({ item: m.item_name, product: m.product_name, ok: true }); }
      else { failureCount++; log.push({ item: m.item_name, product: m.product_name, ok: false, reason: result.reason }); }
    }
    db.prepare(`UPDATE automation_runs SET status = 'done', finished_at = datetime('now'),
      success_count = ?, failure_count = ?, log_json = ? WHERE id = ?`)
      .run(successCount, failureCount, JSON.stringify(log), runId);
  } catch (e) {
    db.prepare(`UPDATE automation_runs SET status = 'error', finished_at = datetime('now'),
      success_count = ?, failure_count = ?, log_json = ? WHERE id = ?`)
      .run(successCount, failureCount, JSON.stringify(log.concat([{ error: e.message }])), runId);
  }
  res.redirect('/automation/' + runId);
});

router.get('/automation/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const run = db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id);
  if (!run) return res.status(404).render('error', { title: 'Not Found', message: 'Run not found' });
  run.log = run.log_json ? JSON.parse(run.log_json) : [];
  res.render('automation', { title: 'Automation Result', run });
});

module.exports = router;
