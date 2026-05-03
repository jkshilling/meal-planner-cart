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
  const stats = {
    searches: db.prepare('SELECT COUNT(*) AS n FROM grocery_searches').get().n,
    products: db.prepare('SELECT COUNT(*) AS n FROM walmart_products').get().n,
    pricePoints: db.prepare('SELECT COUNT(*) AS n FROM walmart_price_history').get().n,
    confirmedMappings: db.prepare('SELECT COUNT(*) AS n FROM ingredient_products WHERE user_confirmed = 1').get().n
  };
  const recent = db.prepare(`
    SELECT s.id, s.retailer, s.query, s.pick_source, s.result_count, s.searched_at,
           p.name AS picked_name, p.product_url AS picked_url, p.latest_price AS picked_price
      FROM grocery_searches s
 LEFT JOIN walmart_products p ON p.id = s.picked_product_id
  ORDER BY s.searched_at DESC
     LIMIT 100
  `).all();
  // Top queries by frequency.
  const topQueries = db.prepare(`
    SELECT query, COUNT(*) AS n,
           SUM(CASE WHEN pick_source = 'override' THEN 1 ELSE 0 END) AS overrides
      FROM grocery_searches
  GROUP BY query
  ORDER BY n DESC
     LIMIT 25
  `).all();
  res.render('grocery_index', { title: 'Grocery data', stats, recent, topQueries });
});

router.get('/grocery/products', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const favoritesOnly = req.query.favorites === '1';
  const category = (req.query.category || '').toString().trim();
  // Brand isn't currently populated by the food-buyer extension, so the
  // search only filters by name. Brand column stays in the table for if/when
  // we start extracting it.
  const where = [];
  const params = [];
  if (q) {
    const like = '%' + q.replace(/%/g, '') + '%';
    where.push('name LIKE ?');
    params.push(like);
  }
  if (favoritesOnly) where.push('is_favorite = 1');
  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  // Sort favorites first, then group by category so similar items cluster
  // visually (cheese with cheese, bread with bread). Within each (favorite,
  // category) tier, freshest first.
  const rows = db.prepare(`
    SELECT id, name, size_text, unit_price, latest_price, latest_price_at,
           last_seen_at, image_url, is_favorite, category
      FROM walmart_products
      ${whereSql}
  ORDER BY is_favorite DESC, COALESCE(category, 'zzz'), last_seen_at DESC
     LIMIT 200
  `).all(...params);
  const favoriteCount = db.prepare('SELECT COUNT(*) AS n FROM walmart_products WHERE is_favorite = 1').get().n;
  // Distinct categories present in the table, for the filter dropdown.
  const categories = db.prepare(
    'SELECT category, COUNT(*) AS n FROM walmart_products WHERE category IS NOT NULL GROUP BY category ORDER BY category'
  ).all();
  res.render('grocery_products', { title: 'Products', rows, q, favoritesOnly, favoriteCount, category, categories });
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
  const searches = db.prepare(`
    SELECT id, query, pick_source, searched_at
      FROM grocery_searches
     WHERE picked_product_id = ?
  ORDER BY searched_at DESC
     LIMIT 50
  `).all(id);
  res.render('grocery_product', { title: product.name, product, history, searches });
});

module.exports = router;
