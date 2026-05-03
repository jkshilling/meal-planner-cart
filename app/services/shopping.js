const db = require('../db');
const { loadPlan, householdSize } = require('./planner');

// Simple unit normalization: group items by (name, unit) and sum quantity.
// Preserve specificity by keeping distinct brand preferences separate.
function key(item) {
  return [item.name.trim().toLowerCase(), item.unit.trim().toLowerCase(), (item.brand_preference || '').trim().toLowerCase()].join('|');
}

function buildShoppingList(planId) {
  const plan = loadPlan(planId);
  if (!plan) throw new Error('Plan not found');
  const profile = plan.profile;
  const size = householdSize(profile);

  // Clear previous list.
  db.prepare('DELETE FROM shopping_items WHERE plan_id = ?').run(planId);

  // Mains AND paired sides both contribute ingredients.
  const allIds = new Set();
  for (const i of plan.items) {
    if (i.recipe_id) allIds.add(i.recipe_id);
    if (i.side_recipe_id) allIds.add(i.side_recipe_id);
  }
  const recipeIds = [...allIds];
  if (recipeIds.length === 0) return { plan, items: [], warnings: ['No recipes in plan'] };

  const qMarks = recipeIds.map(() => '?').join(',');
  const ings = db.prepare(`SELECT * FROM recipe_ingredients WHERE recipe_id IN (${qMarks})`).all(...recipeIds);

  // Count how many times each recipe appears across the week (mains + sides).
  const counts = {};
  for (const it of plan.items) {
    if (it.recipe_id) counts[it.recipe_id] = (counts[it.recipe_id] || 0) + 1;
    if (it.side_recipe_id) counts[it.side_recipe_id] = (counts[it.side_recipe_id] || 0) + 1;
  }

  const recipeRows = db.prepare(`SELECT id, servings FROM recipes WHERE id IN (${qMarks})`).all(...recipeIds);
  const servingsById = {};
  for (const r of recipeRows) servingsById[r.id] = r.servings || 1;

  const merged = {};
  const warnings = [];

  for (const ing of ings) {
    if (!Number.isFinite(ing.quantity) || ing.quantity <= 0) {
      warnings.push(`Invalid quantity on ingredient "${ing.name}" — skipped.`);
      continue;
    }
    const recipeServings = servingsById[ing.recipe_id] || 1;
    const scale = size / recipeServings;
    const totalForWeek = ing.quantity * scale * (counts[ing.recipe_id] || 0);
    const k = key(ing);
    if (!merged[k]) {
      merged[k] = {
        name: ing.name,
        quantity: 0,
        unit: ing.unit,
        brand_preference: ing.brand_preference || null
      };
    }
    merged[k].quantity += totalForWeek;
  }

  const rows = Object.values(merged).map(r => ({ ...r, quantity: +r.quantity.toFixed(2) }));
  const insert = db.prepare(`INSERT INTO shopping_items (plan_id, name, quantity, unit, brand_preference, approved) VALUES (?, ?, ?, ?, ?, 1)`);
  const tx = db.transaction(() => {
    for (const r of rows) insert.run(planId, r.name, r.quantity, r.unit, r.brand_preference);
  });
  tx();

  const items = db.prepare('SELECT * FROM shopping_items WHERE plan_id = ? ORDER BY name').all(planId);
  return { plan, items, warnings };
}

function loadShoppingItems(planId) {
  return db.prepare('SELECT * FROM shopping_items WHERE plan_id = ? ORDER BY name').all(planId);
}

function loadMatches(planId) {
  return db.prepare(`
    SELECT wm.*, si.name as item_name, si.quantity as item_quantity, si.unit as item_unit, si.brand_preference as item_brand
    FROM walmart_matches wm
    JOIN shopping_items si ON wm.shopping_item_id = si.id
    WHERE si.plan_id = ?
    ORDER BY si.name
  `).all(planId);
}

function updateShoppingItem(id, fields) {
  const allowed = ['name', 'quantity', 'unit', 'brand_preference', 'notes', 'approved'];
  const set = [], vals = [];
  for (const k of allowed) if (k in fields) { set.push(`${k} = ?`); vals.push(fields[k]); }
  if (!set.length) return;
  vals.push(id);
  db.prepare(`UPDATE shopping_items SET ${set.join(', ')} WHERE id = ?`).run(...vals);
}

function deleteShoppingItem(id) {
  db.prepare('DELETE FROM shopping_items WHERE id = ?').run(id);
}

function addManualItem(planId, fields) {
  const { name, quantity, unit, brand_preference } = fields;
  db.prepare(`INSERT INTO shopping_items (plan_id, name, quantity, unit, brand_preference, manual, approved)
              VALUES (?, ?, ?, ?, ?, 1, 1)`).run(planId, name, quantity || 1, unit || 'each', brand_preference || null);
}

module.exports = {
  buildShoppingList,
  loadShoppingItems,
  loadMatches,
  updateShoppingItem,
  deleteShoppingItem,
  addManualItem
};
