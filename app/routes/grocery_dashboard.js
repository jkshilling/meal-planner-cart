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
const { requireToken } = require('../services/grocery_token');
const { userIdOf } = require('../services/auth');

const router = express.Router();

// CORS for the food-buyer Chrome extension. Only chrome-extension:// origins
// can read responses. Mirrors the policy on /api/grocery-events.
function extensionCors(req, res, next) {
  const origin = req.get('Origin') || '';
  if (origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

router.get('/grocery', (req, res) => {
  const uid = userIdOf(req);
  // Searches and ingredient_products scope to the user; walmart_products
  // and price history are intentionally global caches.
  const userScopeSql = uid ? 'WHERE user_id = ?' : '';
  const userScopeArgs = uid ? [uid] : [];

  const stats = {
    searches: db.prepare(`SELECT COUNT(*) AS n FROM grocery_searches ${userScopeSql}`).get(...userScopeArgs).n,
    products: db.prepare('SELECT COUNT(*) AS n FROM walmart_products').get().n,
    pricePoints: db.prepare('SELECT COUNT(*) AS n FROM walmart_price_history').get().n,
    confirmedMappings: db.prepare(
      `SELECT COUNT(*) AS n FROM ingredient_products WHERE user_confirmed = 1 ${uid ? 'AND user_id = ?' : ''}`
    ).get(...userScopeArgs).n
  };
  const recent = db.prepare(`
    SELECT s.id, s.retailer, s.query, s.pick_source, s.result_count, s.searched_at,
           p.name AS picked_name, p.product_url AS picked_url, p.latest_price AS picked_price
      FROM grocery_searches s
 LEFT JOIN walmart_products p ON p.id = s.picked_product_id
      ${uid ? 'WHERE s.user_id = ?' : ''}
  ORDER BY s.searched_at DESC
     LIMIT 100
  `).all(...userScopeArgs);
  // Top queries by frequency.
  const topQueries = db.prepare(`
    SELECT query, COUNT(*) AS n,
           SUM(CASE WHEN pick_source = 'override' THEN 1 ELSE 0 END) AS overrides
      FROM grocery_searches
      ${userScopeSql}
  GROUP BY query
  ORDER BY n DESC
     LIMIT 25
  `).all(...userScopeArgs);
  res.render('grocery_index', { title: 'Grocery data', stats, recent, topQueries });
});

router.get('/grocery/products', (req, res) => {
  // Always send the latest 200; the page filters client-side via typeahead +
  // favorites checkbox. Sort favorites first, then group by category so
  // similar items cluster (cheese with cheese, bread with bread); within
  // each tier, freshest first.
  const rows = db.prepare(`
    SELECT id, name, size_text, unit_price, latest_price, latest_price_at,
           last_seen_at, image_url, is_favorite, category
      FROM walmart_products
  ORDER BY is_favorite DESC, COALESCE(category, 'zzz'), last_seen_at DESC
     LIMIT 200
  `).all();
  const favoriteCount = db.prepare('SELECT COUNT(*) AS n FROM walmart_products WHERE is_favorite = 1').get().n;
  res.render('grocery_products', { title: 'Products', rows, favoriteCount });
});

// Toggle a product's favorite flag. Used by the star button in the catalog
// table. Idempotent: re-clicking flips back to non-favorite.
router.post('/grocery/products/:id/favorite', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.redirect('/grocery/products');
  db.prepare('UPDATE walmart_products SET is_favorite = 1 - is_favorite WHERE id = ?').run(id);
  // Bounce back to wherever they came from so the search/filter state is preserved.
  const back = req.get('referer') || '/grocery/products';
  res.redirect(back);
});

// JSON endpoint the food-buyer extension polls to learn which products the
// user has favorited. Bearer-token authed (same token as /api/grocery-events)
// so favorites can't be enumerated by anyone who finds the URL. Returns just
// enough data for the extension to match against Walmart search results
// (URL or item ID).
router.options('/api/grocery/favorites', extensionCors);
router.get('/api/grocery/favorites', extensionCors, requireToken, (req, res) => {
  const rows = db.prepare(`
    SELECT walmart_item_id, product_url, name
      FROM walmart_products
     WHERE is_favorite = 1
  ORDER BY last_seen_at DESC
  `).all();
  res.json({ favorites: rows });
});

// Back-compat shim. The earlier /grocery/favorites.json was unauthenticated
// and intended to be the public path; redirect to the authed endpoint so
// any client coded against the old URL gets a clear 401 instead of silent
// data leakage.
router.get('/grocery/favorites.json', (req, res) => {
  res.redirect(308, '/api/grocery/favorites');
});

router.get('/grocery/products/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const product = db.prepare('SELECT * FROM walmart_products WHERE id = ?').get(id);
  if (!product) return res.status(404).render('error', { title: 'Not found', message: 'No such product.' });
  const history = db.prepare(`
    SELECT price, seen_at FROM walmart_price_history
     WHERE product_id = ?
  ORDER BY seen_at ASC
  `).all(id);
  const uid = userIdOf(req);
  // "Searches that picked this product" — scope to current user when authed
  // so one user's picks aren't visible to another. Product itself + price
  // history stay global (they're per-product cache, not per-user data).
  const searches = uid
    ? db.prepare(`SELECT id, query, pick_source, searched_at
                    FROM grocery_searches
                   WHERE picked_product_id = ? AND user_id = ?
                ORDER BY searched_at DESC LIMIT 50`).all(id, uid)
    : db.prepare(`SELECT id, query, pick_source, searched_at
                    FROM grocery_searches
                   WHERE picked_product_id = ?
                ORDER BY searched_at DESC LIMIT 50`).all(id);
  res.render('grocery_product', { title: product.name, product, history, searches });
});

module.exports = router;
