const express = require('express');
const db = require('../db');
const productCache = require('../services/product_cache');
const { requireAuth } = require('../services/auth');

const router = express.Router();

// Product cache only accumulates data when the Walmart automation runs.
// On headless deploys the table will always be empty, so hide the page.
function requireWalmart(req, res, next) {
  if (process.env.WALMART_ENABLED !== 'true') {
    return res.status(404).render('error', {
      title: 'Not available',
      message: 'Walmart automation is disabled in this deployment.'
    });
  }
  next();
}

router.get('/products', requireAuth, requireWalmart, (req, res) => {
  const products = productCache.allProducts();
  const summary = productCache.mappingsSummary();

  // Attach mapped ingredients for each product
  const mapRows = db.prepare(`
    SELECT ip.id, ip.product_id, ip.ingredient_name, ip.user_confirmed, ip.uses_count
    FROM ingredient_products ip
    ORDER BY ip.user_confirmed DESC, ip.uses_count DESC
  `).all();
  const mapsByProduct = {};
  for (const m of mapRows) {
    if (!mapsByProduct[m.product_id]) mapsByProduct[m.product_id] = [];
    mapsByProduct[m.product_id].push(m);
  }
  for (const p of products) p.mapped_ingredients = mapsByProduct[p.id] || [];

  res.render('products', { title: 'Walmart product cache', products, summary });
});

router.post('/products/mapping/:mappingId/delete', requireAuth, requireWalmart, (req, res) => {
  const id = parseInt(req.params.mappingId, 10);
  db.prepare('DELETE FROM ingredient_products WHERE id = ?').run(id);
  res.redirect('/products');
});

router.post('/products/:id/delete', requireAuth, requireWalmart, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM walmart_products WHERE id = ?').run(id);
  res.redirect('/products');
});

module.exports = router;
