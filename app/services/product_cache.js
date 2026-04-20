// Persistent cache of Walmart products + learned ingredient→product mappings.
// Every Walmart search upserts its candidates here; every user-approved match
// creates (or strengthens) an ingredient_products row.
//
// Matching short-circuits: before hitting Walmart, check if we already have
// a user-confirmed product for this ingredient.

const db = require('../db');

// Pull Walmart's internal item ID out of a product URL if we can.
// URLs look like https://www.walmart.com/ip/Some-Name/12345678 — the trailing
// numeric segment is the item id.
function extractItemId(url) {
  if (!url) return null;
  const m = url.match(/\/ip\/[^/]*\/(\d+)/);
  return m ? m[1] : null;
}

function normalizeIngredient(name) {
  return (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Upsert a product into the cache. Returns the row id.
// Existing rows get their name/brand/size refreshed and price logged to history
// when it changes.
function upsertProduct(candidate) {
  if (!candidate || !candidate.url || !candidate.name) return null;
  const itemId = extractItemId(candidate.url);
  const existing = db.prepare('SELECT * FROM walmart_products WHERE product_url = ? OR (walmart_item_id IS NOT NULL AND walmart_item_id = ?)').get(candidate.url, itemId);

  if (existing) {
    db.prepare(`UPDATE walmart_products SET
      name = ?, size_text = COALESCE(?, size_text),
      latest_price = COALESCE(?, latest_price),
      latest_price_at = CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE latest_price_at END,
      last_seen_at = datetime('now')
      WHERE id = ?`)
      .run(candidate.name, candidate.size || null, candidate.price ?? null, candidate.price ?? null, existing.id);
    if (typeof candidate.price === 'number' && candidate.price > 0 && existing.latest_price !== candidate.price) {
      db.prepare('INSERT INTO walmart_price_history (product_id, price) VALUES (?, ?)').run(existing.id, candidate.price);
    }
    return existing.id;
  }

  const info = db.prepare(`INSERT INTO walmart_products
    (walmart_item_id, product_url, name, size_text, latest_price, latest_price_at)
    VALUES (?, ?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE NULL END)`)
    .run(itemId, candidate.url, candidate.name, candidate.size || null, candidate.price ?? null, candidate.price ?? null);
  if (typeof candidate.price === 'number' && candidate.price > 0) {
    db.prepare('INSERT INTO walmart_price_history (product_id, price) VALUES (?, ?)').run(info.lastInsertRowid, candidate.price);
  }
  return info.lastInsertRowid;
}

// Record that we're mapping this ingredient to this product. If it already
// exists, bump uses_count and optionally flip user_confirmed to 1.
function learnMapping(ingredientName, productId, { confirmed = false } = {}) {
  const key = normalizeIngredient(ingredientName);
  if (!key || !productId) return;
  const existing = db.prepare('SELECT id, user_confirmed, uses_count FROM ingredient_products WHERE ingredient_name = ? AND product_id = ?').get(key, productId);
  if (existing) {
    db.prepare(`UPDATE ingredient_products SET
      uses_count = uses_count + 1,
      user_confirmed = MAX(user_confirmed, ?),
      updated_at = datetime('now') WHERE id = ?`)
      .run(confirmed ? 1 : 0, existing.id);
  } else {
    db.prepare(`INSERT INTO ingredient_products (ingredient_name, product_id, user_confirmed) VALUES (?, ?, ?)`)
      .run(key, productId, confirmed ? 1 : 0);
  }
}

// Return the best cached product for this ingredient, or null.
// Prefers user-confirmed mappings, then falls back to most-used.
function bestProductFor(ingredientName) {
  const key = normalizeIngredient(ingredientName);
  if (!key) return null;
  return db.prepare(`
    SELECT wp.*, ip.user_confirmed, ip.uses_count
    FROM ingredient_products ip
    JOIN walmart_products wp ON wp.id = ip.product_id
    WHERE ip.ingredient_name = ?
    ORDER BY ip.user_confirmed DESC, ip.uses_count DESC
    LIMIT 1
  `).get(key) || null;
}

// Compute an estimated recipe cost from cached ingredient prices when we have
// them. Returns { cost, covered, total } — covered is how many ingredients
// we found a cached price for, total is how many ingredients the recipe has.
function estimateRecipeCost(recipeId) {
  const ings = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ?').all(recipeId);
  let cost = 0;
  let covered = 0;
  for (const ing of ings) {
    const product = bestProductFor(ing.name);
    if (product && typeof product.latest_price === 'number') {
      // For MVP we treat latest_price as the per-recipe-unit cost — not trying
      // to reason about package sizes vs recipe quantities. Over-estimates are
      // usually fine; better than undercounting against a budget.
      cost += product.latest_price;
      covered++;
    }
  }
  return { cost: +cost.toFixed(2), covered, total: ings.length };
}

function allProducts() {
  return db.prepare(`
    SELECT wp.*,
      (SELECT COUNT(*) FROM ingredient_products ip WHERE ip.product_id = wp.id) as mapped_ingredient_count
    FROM walmart_products wp
    ORDER BY wp.last_seen_at DESC
  `).all();
}

function mappingsSummary() {
  return {
    products: db.prepare('SELECT COUNT(*) as c FROM walmart_products').get().c,
    price_points: db.prepare('SELECT COUNT(*) as c FROM walmart_price_history').get().c,
    mappings: db.prepare('SELECT COUNT(*) as c FROM ingredient_products').get().c,
    confirmed_mappings: db.prepare('SELECT COUNT(*) as c FROM ingredient_products WHERE user_confirmed = 1').get().c
  };
}

module.exports = {
  extractItemId,
  normalizeIngredient,
  upsertProduct,
  learnMapping,
  bestProductFor,
  estimateRecipeCost,
  allProducts,
  mappingsSummary
};
