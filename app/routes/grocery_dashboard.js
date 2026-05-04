// Grocery dashboards. Reads only — no mutations. Renders three small views:
//
//   GET  /grocery                  Recent searches + summary stats
//   GET  /grocery/products         Walmart products we've encountered
//   GET  /grocery/products/:id     One product page with price history
//
// Intentionally simple. The point is to verify data is flowing and to make
// the price-over-time visible. Charts later if it earns them.

const express = require('express');
const db = require('../db');
const { requireTokenAndResolveUser } = require('../services/grocery_token');
const { requireAuth, userIdOf } = require('../services/auth');

const router = express.Router();

// CORS for the food-buyer Chrome extension. Only chrome-extension:// origins
// can read responses. Mirrors the policy on /api/grocery-events.
function extensionCors(req, res, next) {
  const origin = req.get('Origin') || '';
  if (origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

router.get('/grocery', requireAuth, (req, res) => {
  const uid = userIdOf(req);
  // Searches and ingredient_products are scoped to the user; walmart_products
  // and price history are intentionally global caches (price-over-time is
  // shared knowledge, not per-user).
  const stats = {
    searches: db.prepare('SELECT COUNT(*) AS n FROM grocery_searches WHERE user_id = ?').get(uid).n,
    products: db.prepare('SELECT COUNT(*) AS n FROM walmart_products').get().n,
    pricePoints: db.prepare('SELECT COUNT(*) AS n FROM walmart_price_history').get().n,
    confirmedMappings: db.prepare(
      'SELECT COUNT(*) AS n FROM ingredient_products WHERE user_confirmed = 1 AND user_id = ?'
    ).get(uid).n
  };
  const recent = db.prepare(`
    SELECT s.id, s.retailer, s.query, s.pick_source, s.result_count, s.searched_at,
           p.name AS picked_name, p.product_url AS picked_url, p.latest_price AS picked_price
      FROM grocery_searches s
 LEFT JOIN walmart_products p ON p.id = s.picked_product_id
     WHERE s.user_id = ?
  ORDER BY s.searched_at DESC
     LIMIT 100
  `).all(uid);
  const topQueries = db.prepare(`
    SELECT query, COUNT(*) AS n,
           SUM(CASE WHEN pick_source = 'override' THEN 1 ELSE 0 END) AS overrides
      FROM grocery_searches
     WHERE user_id = ?
  GROUP BY query
  ORDER BY n DESC
     LIMIT 25
  `).all(uid);
  res.render('grocery_index', { title: 'Grocery data', stats, recent, topQueries });
});

router.get('/grocery/products', requireAuth, (req, res) => {
  const uid = userIdOf(req);
  // Always send the latest 200; the page filters client-side via typeahead +
  // favorites checkbox. Sort favorites first, then group by category so
  // similar items cluster (cheese with cheese, bread with bread); within
  // each tier, freshest first. Favorites are derived from user_favorites
  // via LEFT JOIN so each user only sees their own stars.
  const rows = db.prepare(`
    SELECT p.id, p.name, p.size_text, p.unit_price, p.latest_price, p.latest_price_at,
           p.last_seen_at, p.image_url, p.category,
           CASE WHEN uf.user_id IS NULL THEN 0 ELSE 1 END AS is_favorite
      FROM walmart_products p
 LEFT JOIN user_favorites uf
        ON uf.walmart_product_id = p.id AND uf.user_id = ?
  ORDER BY is_favorite DESC, COALESCE(p.category, 'zzz'), p.last_seen_at DESC
     LIMIT 200
  `).all(uid);
  const favoriteCount = db.prepare(
    'SELECT COUNT(*) AS n FROM user_favorites WHERE user_id = ?'
  ).get(uid).n;
  res.render('grocery_products', { title: 'Products', rows, favoriteCount });
});

// Toggle a product's favorite flag for the current user. Used by the star
// button in the catalog table. Idempotent: re-clicking removes the row.
router.post('/grocery/products/:id/favorite', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.redirect('/grocery/products');
  const uid = userIdOf(req);
  // Insert if missing, delete if present. Single round-trip via a tiny
  // transaction so concurrent double-clicks can't race into a duplicate row
  // (the PRIMARY KEY would already block that, but being explicit avoids
  // surfacing a UNIQUE constraint error to the user).
  const toggle = db.transaction(() => {
    const existing = db.prepare(
      'SELECT 1 FROM user_favorites WHERE user_id = ? AND walmart_product_id = ?'
    ).get(uid, id);
    if (existing) {
      db.prepare(
        'DELETE FROM user_favorites WHERE user_id = ? AND walmart_product_id = ?'
      ).run(uid, id);
    } else {
      db.prepare(
        'INSERT INTO user_favorites (user_id, walmart_product_id) VALUES (?, ?)'
      ).run(uid, id);
    }
  });
  toggle();
  // Bounce back to wherever they came from so the search/filter state is preserved.
  const back = req.get('referer') || '/grocery/products';
  res.redirect(back);
});

// Estimate the cart total before the user clicks "Add all to cart" in the
// extension. For each shopping-list item, look up the most likely product
// the run would land on and return its last-seen price.
//
// Cascade per item, in decreasing confidence:
//   1. user_favorites — favorited product whose name LIKE the query → that.
//   2. ingredient_products WHERE user_confirmed = 1 — user-validated mapping.
//   3. ingredient_products (any) — algorithmic mapping picked at least once.
//   4. recent grocery_searches → that search's picked_product_id.
//   5. NULL — return source=null, exclude from sum.
//
// All lookups are scoped to req.tokenUser.id so two users querying the same
// ingredient see their own histories.
// Wipe the calling user's grocery data: their searches, ingredient
// mappings, favorites, and any walmart_products rows that nobody else has
// touched. The walmart_products table is shared across users (a SKU is a
// SKU), so we only delete rows that have no remaining references from
// OTHER users' searches/mappings/favorites — otherwise we'd corrupt their
// catalogs.
//
// Bearer-token authed; bound to req.tokenUser.id so one user's reset
// can't touch another user's data.
router.options('/api/grocery/reset', extensionCors);
router.post('/api/grocery/reset', extensionCors, requireTokenAndResolveUser, (req, res) => {
  const uid = req.tokenUser.id;
  const before = {
    searches:  db.prepare('SELECT COUNT(*) AS n FROM grocery_searches WHERE user_id = ?').get(uid).n,
    mappings:  db.prepare('SELECT COUNT(*) AS n FROM ingredient_products WHERE user_id = ?').get(uid).n,
    favorites: db.prepare('SELECT COUNT(*) AS n FROM user_favorites WHERE user_id = ?').get(uid).n
  };

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM grocery_searches WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM ingredient_products WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM user_favorites WHERE user_id = ?').run(uid);
    // Orphan-cleanup: products with no remaining reference from any
    // user's searches/mappings/favorites. price_history rows go via the
    // ON DELETE CASCADE foreign key.
    db.prepare(`
      DELETE FROM walmart_products
       WHERE id NOT IN (SELECT picked_product_id FROM grocery_searches WHERE picked_product_id IS NOT NULL)
         AND id NOT IN (SELECT product_id FROM ingredient_products)
         AND id NOT IN (SELECT walmart_product_id FROM user_favorites)
    `).run();
  });
  tx();

  res.json({ ok: true, deleted: before });
});

router.options('/api/grocery/price-estimate', extensionCors);
router.post('/api/grocery/price-estimate', extensionCors, requireTokenAndResolveUser, express.json({ limit: '128kb' }), (req, res) => {
  const uid = req.tokenUser.id;
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ ok: false, error: 'items array required' });
  if (items.length > 200) return res.status(413).json({ ok: false, error: 'too many items (max 200)' });

  const favoriteForQuery = db.prepare(`
    SELECT p.id, p.name, p.product_url, p.latest_price
      FROM user_favorites uf
      JOIN walmart_products p ON p.id = uf.walmart_product_id
     WHERE uf.user_id = ?
       AND p.latest_price IS NOT NULL
       AND LOWER(p.name) LIKE ?
  ORDER BY p.last_seen_at DESC
     LIMIT 1
  `);
  const confirmedMapping = db.prepare(`
    SELECT p.id, p.name, p.product_url, p.latest_price
      FROM ingredient_products ip
      JOIN walmart_products p ON p.id = ip.product_id
     WHERE ip.user_id = ?
       AND ip.user_confirmed = 1
       AND ip.ingredient_name = ?
       AND p.latest_price IS NOT NULL
  ORDER BY ip.uses_count DESC, ip.updated_at DESC
     LIMIT 1
  `);
  const anyMapping = db.prepare(`
    SELECT p.id, p.name, p.product_url, p.latest_price
      FROM ingredient_products ip
      JOIN walmart_products p ON p.id = ip.product_id
     WHERE ip.user_id = ?
       AND ip.ingredient_name = ?
       AND p.latest_price IS NOT NULL
  ORDER BY ip.uses_count DESC, ip.updated_at DESC
     LIMIT 1
  `);
  const recentSearch = db.prepare(`
    SELECT p.id, p.name, p.product_url, p.latest_price
      FROM grocery_searches s
      JOIN walmart_products p ON p.id = s.picked_product_id
     WHERE s.user_id = ?
       AND LOWER(s.query) = ?
       AND p.latest_price IS NOT NULL
  ORDER BY s.searched_at DESC
     LIMIT 1
  `);

  const estimates = items.map((item) => {
    const name = String((item && item.name) || '').trim();
    if (!name) return { name: '', price: null, source: null };
    const lower = name.toLowerCase();
    const like = '%' + lower.replace(/%/g, '') + '%';

    let row = favoriteForQuery.get(uid, like);
    if (row) return { name, price: row.latest_price, source: 'favorite', productName: row.name, productUrl: row.product_url };

    row = confirmedMapping.get(uid, lower);
    if (row) return { name, price: row.latest_price, source: 'confirmed', productName: row.name, productUrl: row.product_url };

    row = anyMapping.get(uid, lower);
    if (row) return { name, price: row.latest_price, source: 'history', productName: row.name, productUrl: row.product_url };

    row = recentSearch.get(uid, lower);
    if (row) return { name, price: row.latest_price, source: 'recent', productName: row.name, productUrl: row.product_url };

    return { name, price: null, source: null };
  });

  const priced = estimates.filter((e) => e.price != null);
  const total = priced.reduce((s, e) => s + e.price, 0);

  // Include the user's weekly grocery budget so the extension can flag a
  // run that exceeds it, without needing a second round-trip.
  const profile = db.prepare(
    'SELECT budget_weekly FROM household_profiles WHERE user_id = ? AND active = 1 ORDER BY id LIMIT 1'
  ).get(uid);

  res.json({
    ok: true,
    estimates,
    summary: {
      total: Math.round(total * 100) / 100,
      pricedCount: priced.length,
      totalCount: estimates.length,
      weeklyBudget: profile && profile.budget_weekly != null ? profile.budget_weekly : null
    }
  });
});

// JSON endpoint the food-buyer extension polls to learn which products the
// user has favorited. Bearer-token authed (same token as /api/grocery-events)
// so one user's favorites can't be enumerated via another user's token.
// Returns just enough data for the extension to match against Walmart search
// results (URL or item ID).
router.options('/api/grocery/favorites', extensionCors);
router.get('/api/grocery/favorites', extensionCors, requireTokenAndResolveUser, (req, res) => {
  const rows = db.prepare(`
    SELECT p.walmart_item_id, p.product_url, p.name
      FROM user_favorites uf
      JOIN walmart_products p ON p.id = uf.walmart_product_id
     WHERE uf.user_id = ?
  ORDER BY p.last_seen_at DESC
  `).all(req.tokenUser.id);
  res.json({ favorites: rows });
});

// Back-compat shim. The earlier /grocery/favorites.json was unauthenticated
// and intended to be the public path; redirect to the authed endpoint so
// any client coded against the old URL gets a clear 401 instead of silent
// data leakage.
router.get('/grocery/favorites.json', (req, res) => {
  res.redirect(308, '/api/grocery/favorites');
});

router.get('/grocery/products/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const product = db.prepare('SELECT * FROM walmart_products WHERE id = ?').get(id);
  if (!product) return res.status(404).render('error', { title: 'Not found', message: 'No such product.' });
  const history = db.prepare(`
    SELECT price, seen_at FROM walmart_price_history
     WHERE product_id = ?
  ORDER BY seen_at ASC
  `).all(id);
  // "Searches that picked this product" is scoped to the current user so one
  // user's picks aren't visible to another. Product + price history are
  // intentionally global (per-product cache, not per-user data).
  const uid = userIdOf(req);
  const searches = db.prepare(`
    SELECT id, query, pick_source, searched_at
      FROM grocery_searches
     WHERE picked_product_id = ? AND user_id = ?
  ORDER BY searched_at DESC LIMIT 50
  `).all(id, uid);
  res.render('grocery_product', { title: product.name, product, history, searches });
});

module.exports = router;
