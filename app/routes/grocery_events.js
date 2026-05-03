// POST /api/grocery-events
//
// Endpoint for the food-buyer Chrome extension to ship batches of search
// results + picks. Auth: bearer token (services/grocery_token.js).
//
// Request body shape (camelCase, JSON):
//   {
//     clientSessionId?: string,           // optional UUID-ish from extension
//     events: [
//       {
//         retailer: 'walmart',
//         query: 'American Cheese',
//         shoppingItemId?: number,        // meal-planner shopping_items.id, if known
//         searchedAt?: string (ISO),
//         pickSource: 'auto' | 'override' | 'failed',
//         pickedUrl?: string,             // walmart_products.product_url of pick
//         results: [
//           {
//             url: 'https://walmart.com/ip/...',
//             walmartItemId?: string,
//             title: string,
//             brand?: string,
//             sizeText?: string,
//             price?: number,
//             imageUrl?: string,
//             rating?: number,
//             reviewCount?: number,
//             availability?: string,
//             sponsored?: boolean,
//             position?: number
//           }, ...
//         ]
//       }, ...
//     ]
//   }
//
// Response (200): { ok: true, ingested: { searches, products, priceRows } }
// Errors return { ok: false, error: '...' }.

const express = require('express');
const db = require('../db');
const { requireToken } = require('../services/grocery_token');

const router = express.Router();

// CORS for the extension. The extension's origin is chrome-extension://<id>;
// we explicitly allow that scheme rather than '*' so a misconfigured browser
// extension elsewhere can't read responses.
function cors(req, res, next) {
  const origin = req.get('Origin') || '';
  if (origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// Upsert one product. Returns the product row id.
const selectByUrl = db.prepare('SELECT id, latest_price FROM walmart_products WHERE product_url = ?');
const insertProduct = db.prepare(`
  INSERT INTO walmart_products
    (walmart_item_id, product_url, name, brand, size_text, unit_price, latest_price, latest_price_at, image_url, last_seen_at)
  VALUES
    (@walmart_item_id, @product_url, @name, @brand, @size_text, @unit_price, @latest_price, @latest_price_at, @image_url, datetime('now'))
`);
const updateProduct = db.prepare(`
  UPDATE walmart_products
     SET name = @name,
         brand = COALESCE(@brand, brand),
         size_text = COALESCE(@size_text, size_text),
         unit_price = COALESCE(@unit_price, unit_price),
         image_url = COALESCE(@image_url, image_url),
         walmart_item_id = COALESCE(@walmart_item_id, walmart_item_id),
         latest_price = COALESCE(@latest_price, latest_price),
         latest_price_at = CASE WHEN @latest_price IS NOT NULL THEN @latest_price_at ELSE latest_price_at END,
         last_seen_at = datetime('now')
   WHERE id = @id
`);
const insertPriceHistory = db.prepare(`
  INSERT INTO walmart_price_history (product_id, price) VALUES (?, ?)
`);
const insertSearch = db.prepare(`
  INSERT INTO grocery_searches
    (retailer, query, shopping_item_id, picked_product_id, pick_source, result_count, client_session_id, searched_at)
  VALUES
    (@retailer, @query, @shopping_item_id, @picked_product_id, @pick_source, @result_count, @client_session_id, @searched_at)
`);
const upsertIngredientProduct = db.prepare(`
  INSERT INTO ingredient_products (ingredient_name, product_id, user_confirmed, uses_count, updated_at)
  VALUES (@ingredient_name, @product_id, @user_confirmed, 1, datetime('now'))
  ON CONFLICT(ingredient_name, product_id) DO UPDATE SET
    user_confirmed = MAX(ingredient_products.user_confirmed, excluded.user_confirmed),
    uses_count     = ingredient_products.uses_count + 1,
    updated_at     = datetime('now')
`);

function upsertProduct(r) {
  const url = String(r.url || '').trim();
  if (!url) return null;
  const existing = selectByUrl.get(url);
  const fields = {
    walmart_item_id: r.walmartItemId || null,
    product_url: url,
    name: String(r.title || '').slice(0, 500) || '(unknown)',
    brand: r.brand ? String(r.brand).slice(0, 200) : null,
    size_text: r.sizeText ? String(r.sizeText).slice(0, 100) : null,
    unit_price: r.unitPrice ? String(r.unitPrice).slice(0, 50) : null,
    latest_price: typeof r.price === 'number' && isFinite(r.price) ? r.price : null,
    latest_price_at: typeof r.price === 'number' && isFinite(r.price) ? new Date().toISOString() : null,
    image_url: r.imageUrl ? String(r.imageUrl).slice(0, 1000) : null
  };
  if (existing) {
    updateProduct.run({ id: existing.id, ...fields });
    // Only append to price_history if the price actually changed (or if we
    // never had one). Avoids inflating the table with no-op rows when the
    // same SKU appears in many searches at the same price.
    if (fields.latest_price != null && fields.latest_price !== existing.latest_price) {
      insertPriceHistory.run(existing.id, fields.latest_price);
    }
    return existing.id;
  }
  const info = insertProduct.run(fields);
  if (fields.latest_price != null) {
    insertPriceHistory.run(info.lastInsertRowid, fields.latest_price);
  }
  return info.lastInsertRowid;
}

function ingestEvent(ev, sessionId) {
  const results = Array.isArray(ev.results) ? ev.results : [];
  const productCount = { products: 0, priceRows: 0 };
  let pickedProductId = null;

  for (const r of results) {
    const id = upsertProduct(r);
    if (id) {
      productCount.products++;
      if (typeof r.price === 'number') productCount.priceRows++;
      if (ev.pickedUrl && r.url === ev.pickedUrl) pickedProductId = id;
    }
  }

  // If the pickedUrl wasn't in the results array (which would be odd but
  // possible if we ever ship a "previous pick" suggestion), upsert it on its
  // own with whatever we have.
  if (ev.pickedUrl && !pickedProductId) {
    pickedProductId = upsertProduct({ url: ev.pickedUrl, title: '(picked, not in results)' });
  }

  insertSearch.run({
    retailer: String(ev.retailer || 'unknown').slice(0, 32),
    query: String(ev.query || '').slice(0, 500),
    shopping_item_id: Number.isInteger(ev.shoppingItemId) ? ev.shoppingItemId : null,
    picked_product_id: pickedProductId,
    pick_source: ['auto', 'override', 'failed'].includes(ev.pickSource) ? ev.pickSource : 'auto',
    result_count: results.length,
    client_session_id: sessionId || null,
    searched_at: ev.searchedAt || new Date().toISOString()
  });

  // Learn the ingredient -> product mapping. user_confirmed when override.
  if (pickedProductId && ev.query) {
    upsertIngredientProduct.run({
      ingredient_name: String(ev.query).toLowerCase().trim(),
      product_id: pickedProductId,
      user_confirmed: ev.pickSource === 'override' ? 1 : 0
    });
  }

  return { searches: 1, ...productCount };
}

router.options('/api/grocery-events', cors);
router.post('/api/grocery-events', cors, requireToken, express.json({ limit: '4mb' }), (req, res) => {
  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events : null;
  if (!events) return res.status(400).json({ ok: false, error: 'events array required' });
  if (events.length > 200) return res.status(413).json({ ok: false, error: 'batch too large (max 200 events)' });

  const totals = { searches: 0, products: 0, priceRows: 0 };
  const errors = [];
  // Wrap in a transaction so a malformed event in the middle doesn't leave
  // the DB half-written.
  const tx = db.transaction((evs) => {
    for (let i = 0; i < evs.length; i++) {
      try {
        const r = ingestEvent(evs[i], body.clientSessionId);
        totals.searches += r.searches;
        totals.products += r.products;
        totals.priceRows += r.priceRows;
      } catch (e) {
        errors.push({ index: i, error: String(e && e.message || e) });
      }
    }
  });
  try {
    tx(events);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }

  res.json({ ok: true, ingested: totals, errors: errors.length ? errors : undefined });
});

module.exports = router;
