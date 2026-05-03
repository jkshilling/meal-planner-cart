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
    (walmart_item_id, product_url, name, brand, size_text, unit_price, latest_price, latest_price_at, image_url, category, last_seen_at)
  VALUES
    (@walmart_item_id, @product_url, @name, @brand, @size_text, @unit_price, @latest_price, @latest_price_at, @image_url, @category, datetime('now'))
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
         category = COALESCE(@category, category),
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

// The extension was sending review counts ("3256") in the sizeText field
// because Walmart's product cards put the count where a structured size
// would be. Real sizes contain a letter (oz, ct, lb, ml, etc.); pure
// numerics are almost always junk extracted from the wrong DOM element.
function cleanSize(s) {
  if (!s) return null;
  const trimmed = String(s).trim().slice(0, 100);
  if (!trimmed) return null;
  if (!/[a-zA-Z]/.test(trimmed)) return null;
  return trimmed;
}

// Compute a per-unit price string when Walmart didn't provide one. We extract
// a size from the product name (most grocery items include "12 oz" / "1 lb" /
// etc.) and divide latest_price by the quantity. Only used as a fallback —
// a Walmart-provided unit_price always wins.
//
// Order of patterns matters: check the more specific tokens first ("fl oz"
// before "oz", "kg" before "g"). Patterns are case-insensitive except "L"
// for liters, where the lowercase "l" would match too many false positives
// (Lake, Lipton, etc.).
const SIZE_PATTERNS = [
  { rx: /(\d+\.?\d*)\s*fl\.?\s*oz\b/i,         unit: 'fl oz' },
  { rx: /(\d+\.?\d*)\s*fluid\s+ounces?\b/i,    unit: 'fl oz' },
  { rx: /(\d+\.?\d*)\s*oz\b/i,                 unit: 'oz' },
  { rx: /(\d+\.?\d*)\s*ounces?\b/i,            unit: 'oz' },
  { rx: /(\d+\.?\d*)\s*lbs?\b/i,               unit: 'lb' },
  { rx: /(\d+\.?\d*)\s*pounds?\b/i,            unit: 'lb' },
  { rx: /(\d+\.?\d*)\s*gal\b/i,                unit: 'gal' },
  { rx: /(\d+\.?\d*)\s*gallons?\b/i,           unit: 'gal' },
  { rx: /(\d+\.?\d*)\s*qt\b/i,                 unit: 'qt' },
  { rx: /(\d+\.?\d*)\s*quarts?\b/i,            unit: 'qt' },
  { rx: /(\d+\.?\d*)\s*pt\b/i,                 unit: 'pt' },
  { rx: /(\d+\.?\d*)\s*pints?\b/i,             unit: 'pt' },
  { rx: /(\d+\.?\d*)\s*ml\b/i,                 unit: 'ml' },
  { rx: /(\d+\.?\d*)\s*L\b/,                   unit: 'L' },   // case-sensitive on purpose
  { rx: /(\d+\.?\d*)\s*liters?\b/i,            unit: 'L' },
  { rx: /(\d+\.?\d*)\s*kg\b/i,                 unit: 'kg' },
  { rx: /(\d+\.?\d*)\s*kilograms?\b/i,         unit: 'kg' },
  { rx: /(\d+)\s*slices?\b/i,                  unit: 'slice' },  // sliced cheese, deli meat, bread
  { rx: /(\d+)\s*pieces?\b/i,                  unit: 'piece' },
  { rx: /(\d+)\s*(?:ct|count|pack|pk)\b/i,     unit: 'ct' }    // count is the last fallback
];

function extractSizeFromName(name) {
  if (!name) return null;
  for (const { rx, unit } of SIZE_PATTERNS) {
    const m = name.match(rx);
    if (m) {
      const qty = parseFloat(m[1]);
      if (qty > 0 && Number.isFinite(qty)) return { quantity: qty, unit };
    }
  }
  return null;
}

function computeUnitPrice(price, name) {
  if (typeof price !== 'number' || !isFinite(price) || price <= 0) return null;
  const size = extractSizeFromName(name);
  if (!size) return null;
  const per = price / size.quantity;
  if (!isFinite(per) || per <= 0) return null;
  // 3 decimal places below 10 cents (sub-cent precision when relevant);
  // 2 decimal places everywhere else. Avoids "$0.04/oz" hiding the difference
  // between $0.035 and $0.044 for cheap-by-the-ounce staples.
  const formatted = per < 0.10 ? per.toFixed(3) : per.toFixed(2);
  return `$${formatted}/${size.unit}`;
}

// Coarse grocery-aisle classifier based on product name. Order matters:
// the FIRST matching rule wins, so list more specific / disambiguating
// categories first. This is intentionally simple and will misclassify
// edge cases ("Cheese Pizza" → Frozen, not Cheese, because Frozen comes
// first; "Banana Pudding" → Sweets, not Produce). Adjust by re-ordering
// or extending the keyword lists in CATEGORY_RULES.
const CATEGORY_RULES = [
  ['Frozen',                /\b(frozen|ice cream|gelato|popsicle|freezer|pizza)\b/i],
  ['Sweets & Desserts',     /\b(chocolate|candy|candies|cookie|cookies|brownie|donut|doughnut|cake|cupcake|pastry|pie|fudge|truffle|caramel|jelly bean|gummies?|marshmallow)\b/i],
  ['Canned & Jarred',       /\b(canned|jarred|jar of|broth|stock|soup|chili\b|salsa|pickles|olives|peanut butter|jam|jelly(?!\s*bean)|preserves)\b/i],
  ['Bread & Bakery',        /\b(bread|loaf|baguette|bun|buns|roll|rolls|tortilla|tortillas|bagel|bagels|biscuit|biscuits|pita|croissant|muffin|muffins|pancake|waffle|crumpet)\b/i],
  ['Cheese',                /\b(cheese|cheddar|mozzarella|parmesan|brie|gouda|feta|ricotta|swiss|provolone|colby|monterey jack|gruy[èe]re|asiago|havarti|paneer|cotija|queso|american slices|cheese singles|kraft singles)\b/i],
  ['Eggs',                  /\b(eggs?)\b(?!\s*(?:roll|nog|noodle))/i],
  ['Dairy',                 /\b(milk|yogurt|yoghurt|butter|margarine|sour cream|heavy cream|half(?:\s|-)and(?:\s|-)half|whipped cream|kefir|buttermilk)\b/i],
  ['Meat & Seafood',        /\b(chicken|beef|pork|turkey|ham\b|lamb|veal|bacon|sausage|salami|pepperoni|prosciutto|hot dog|ground meat|salmon|tuna|shrimp|cod|tilapia|halibut|crab|lobster|scallop|fish)\b/i],
  ['Pasta & Grains',        /\b(pasta|spaghetti|penne|linguine|fettuccine|macaroni|lasagna|ziti|rigatoni|noodle|noodles|rice(?!\s*krisp)|quinoa|couscous|farro|barley|oats|oatmeal|cereal|granola|cornmeal|polenta)\b/i],
  ['Beverages',             /\b(soda|cola|pepsi|sprite|coke|juice|lemonade|tea\b|coffee|espresso|water bottle|sparkling water|seltzer|kombucha|beer|wine|liquor|whiskey|vodka|rum|gin|tequila|smoothie drink)\b/i],
  ['Snacks',                /\b(chips|cracker|crackers|pretzel|popcorn|trail mix|nuts(?:\s|$)|almonds|cashews|peanuts(?!\s*butter)|jerky|granola bar|protein bar|energy bar)\b/i],
  ['Condiments, Oils & Spices', /\b(sauce|dressing|ketchup|mustard|mayo|mayonnaise|vinegar|olive oil|vegetable oil|canola oil|coconut oil|sesame oil|oil\b|salt|pepper|spice|seasoning|garlic powder|paprika|cumin|cinnamon|oregano|basil|thyme|rosemary|honey|maple syrup|hot sauce|soy sauce|sriracha|teriyaki)\b/i],
  ['Produce',               /\b(apple|banana|orange|grape|strawberry|blueberry|raspberry|blackberry|melon|watermelon|pineapple|mango|peach|pear|plum|cherry|cherries|kiwi|avocado|lemon|lime|lettuce|spinach|kale|arugula|romaine|cabbage|broccoli|cauliflower|carrot|celery|onion|garlic|ginger|tomato|cucumber|pepper(?!\s*corn)|potato|sweet potato|squash|zucchini|mushroom|asparagus|bean sprouts|herbs?\b)\b/i]
];

function classify(name) {
  if (!name) return null;
  for (const [category, regex] of CATEGORY_RULES) {
    if (regex.test(name)) return category;
  }
  return 'Other';
}

function upsertProduct(r) {
  const url = String(r.url || '').trim();
  if (!url) return null;
  const existing = selectByUrl.get(url);
  const name = String(r.title || '').slice(0, 500) || '(unknown)';
  const latestPrice = typeof r.price === 'number' && isFinite(r.price) ? r.price : null;
  const fields = {
    walmart_item_id: r.walmartItemId || null,
    product_url: url,
    name,
    brand: r.brand ? String(r.brand).slice(0, 200) : null,
    size_text: cleanSize(r.sizeText),
    // Walmart-provided unit price wins; fall back to one we compute from
    // (latest_price ÷ size-in-name) when the extension didn't deliver one.
    unit_price: r.unitPrice
      ? String(r.unitPrice).slice(0, 50)
      : computeUnitPrice(latestPrice, name),
    latest_price: latestPrice,
    latest_price_at: latestPrice != null ? new Date().toISOString() : null,
    image_url: r.imageUrl ? String(r.imageUrl).slice(0, 1000) : null,
    category: classify(name)
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
    pick_source: ['auto', 'override', 'favorite', 'failed'].includes(ev.pickSource) ? ev.pickSource : 'auto',
    result_count: results.length,
    client_session_id: sessionId || null,
    searched_at: ev.searchedAt || new Date().toISOString()
  });

  // Learn the ingredient -> product mapping. Both manual overrides and
  // favorite-driven picks are user-validated signals — record both as
  // user_confirmed=1 so the mapping persists with high confidence.
  if (pickedProductId && ev.query) {
    upsertIngredientProduct.run({
      ingredient_name: String(ev.query).toLowerCase().trim(),
      product_id: pickedProductId,
      user_confirmed: (ev.pickSource === 'override' || ev.pickSource === 'favorite') ? 1 : 0
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
