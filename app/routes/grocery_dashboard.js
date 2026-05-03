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

const router = express.Router();

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
  let rows;
  if (q) {
    const like = '%' + q.replace(/%/g, '') + '%';
    // Brand isn't currently populated by the food-buyer extension, so the
    // search only filters by name. Brand column stays in the table for if/when
    // we start extracting it.
    rows = db.prepare(`
      SELECT id, name, brand, size_text, unit_price, latest_price, latest_price_at, last_seen_at, image_url
        FROM walmart_products
       WHERE name LIKE ?
    ORDER BY last_seen_at DESC
       LIMIT 200
    `).all(like);
  } else {
    rows = db.prepare(`
      SELECT id, name, brand, size_text, unit_price, latest_price, latest_price_at, last_seen_at, image_url
        FROM walmart_products
    ORDER BY last_seen_at DESC
       LIMIT 200
    `).all();
  }
  res.render('grocery_products', { title: 'Products', rows, q });
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
