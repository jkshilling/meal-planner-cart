const express = require('express');
const db = require('../db');
const shopping = require('../services/shopping');
const matcher = require('../services/matcher');
const productCache = require('../services/product_cache');
const { requireAuth, userIdOf } = require('../services/auth');
const walmart = require('../../automation/walmart');

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

// Guard routes that depend on headed Chromium. On headless hosts (the shared
// droplet) Playwright cannot launch, so we 404 instead of hanging.
function requireWalmart(req, res, next) {
  if (process.env.WALMART_ENABLED !== 'true') {
    return res.status(404).render('error', {
      title: 'Not available',
      message: 'Walmart automation is disabled in this deployment (no display available).'
    });
  }
  next();
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
  const matches = shopping.loadMatches(id);
  res.render('shopping', { title: 'Shopping list', plan, items, matches });
});

router.post('/plan/:id/shopping/item', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!loadOwnedPlan(req, res, id)) return;
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
    // brand_preference is no longer editable from the shopping list UI; it's
    // still set by the recipe (services/shopping.buildShoppingList copies it
    // from recipe_ingredients) and consumed by the matcher. Don't include it
    // in the update fields so saves here can't null it out.
    shopping.updateShoppingItem(parseInt(b.item_id, 10), {
      name: b.name,
      quantity: parseFloat(b.quantity) || 1,
      unit: b.unit,
      approved: b.approved ? 1 : 0
    });
  }
  res.redirect('/plan/' + id + '/shopping');
});

router.post('/plan/:id/match-walmart', requireAuth, requireWalmart, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!loadOwnedPlan(req, res, id)) return;
  const items = db.prepare('SELECT * FROM shopping_items WHERE plan_id = ? AND approved = 1').all(id);
  const errors = [];
  try {
    for (const item of items) {
      // Check cache first — if we have a user-confirmed product for this
      // ingredient, skip the live Walmart search entirely. Huge speedup and
      // fewer captcha triggers over time.
      const cached = productCache.bestProductFor(item.name);
      let candidates;
      if (cached && cached.user_confirmed) {
        candidates = [{
          name: cached.name,
          url: cached.product_url,
          price: cached.latest_price,
          size: cached.size_text
        }];
      } else {
        const query = [item.brand_preference, item.name].filter(Boolean).join(' ');
        const { blocked, candidates: live } = await walmart.searchProducts(query, 5);
        if (blocked) { errors.push(`Captcha/login wall while searching: ${item.name}`); break; }
        candidates = live;
        // Upsert every candidate into the product cache so price history
        // and product knowledge accumulate regardless of which is picked.
        for (const c of candidates) productCache.upsertProduct(c);
      }

      const ranked = matcher.rankCandidates(item, candidates);
      matcher.saveMatch(item.id, ranked);

      // Tentatively learn from the top result (non-confirmed). If the user
      // later picks a different candidate, that becomes the confirmed one.
      if (ranked[0]) {
        const topProduct = db.prepare('SELECT id FROM walmart_products WHERE product_url = ?').get(ranked[0].url);
        if (topProduct) productCache.learnMapping(item.name, topProduct.id, { confirmed: false });
      }
    }
  } catch (e) {
    errors.push('Match error: ' + e.message);
  }
  res.redirect('/plan/' + id + '/shopping' + (errors.length ? '?err=' + encodeURIComponent(errors.join(' | ')) : ''));
});

// Look up the shopping item + its current match, upsert the product into the
// cache, and create a confirmed ingredient→product mapping. This is the
// "learning on approval" loop.
function recordConfirmedMatch(itemId) {
  const item = db.prepare('SELECT name FROM shopping_items WHERE id = ?').get(itemId);
  const match = db.prepare('SELECT * FROM walmart_matches WHERE shopping_item_id = ?').get(itemId);
  if (!item || !match || !match.product_url) return;
  const productId = productCache.upsertProduct({
    name: match.product_name,
    url: match.product_url,
    price: match.product_price,
    size: match.product_size
  });
  if (productId) productCache.learnMapping(item.name, productId, { confirmed: true });
}

router.post('/plan/:id/shopping/approve-match', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!loadOwnedPlan(req, res, id)) return;
  const b = req.body;
  const itemId = parseInt(b.item_id, 10);
  if (b.action === 'approve') {
    matcher.setApproval(itemId, true);
    recordConfirmedMatch(itemId);
  } else if (b.action === 'unapprove') {
    matcher.setApproval(itemId, false);
  } else if (b.action === 'pick') {
    matcher.approveMatch(itemId, parseInt(b.candidate_index, 10) || 0);
    recordConfirmedMatch(itemId);
  }
  res.redirect('/plan/' + id + '/shopping');
});

router.post('/plan/:id/add-to-cart', requireAuth, requireWalmart, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!loadOwnedPlan(req, res, id)) return;
  const uid = userIdOf(req);
  const approved = db.prepare(`
    SELECT wm.*, si.name as item_name FROM walmart_matches wm
    JOIN shopping_items si ON wm.shopping_item_id = si.id
    WHERE si.plan_id = ? AND wm.approved = 1 AND wm.product_url IS NOT NULL
  `).all(id);

  const runInfo = db.prepare(
    `INSERT INTO automation_runs (plan_id, user_id, status) VALUES (?, ?, 'running')`
  ).run(id, uid);
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

router.get('/automation/:id', requireAuth, requireWalmart, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const uid = userIdOf(req);
  const run = db.prepare('SELECT * FROM automation_runs WHERE id = ? AND user_id = ?').get(id, uid);
  if (!run) return res.status(404).render('error', { title: 'Not Found', message: 'Run not found' });
  run.log = run.log_json ? JSON.parse(run.log_json) : [];
  res.render('automation', { title: 'Automation Result', run });
});

module.exports = router;
