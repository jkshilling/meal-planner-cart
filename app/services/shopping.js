const db = require('../db');
const { loadPlan, dinersFor } = require('./planner');

// Group items by (name, unit) and sum quantity. Two recipes both calling for
// "cheese" + "oz" merge into one shopping row.
function key(item) {
  return [item.name.trim().toLowerCase(), item.unit.trim().toLowerCase()].join('|');
}

function buildShoppingList(planId) {
  const plan = loadPlan(planId);
  if (!plan) throw new Error('Plan not found');
  const profile = plan.profile;

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
  const ingRows = db.prepare(`SELECT * FROM recipe_ingredients WHERE recipe_id IN (${qMarks})`).all(...recipeIds);
  const ingsByRecipe = {};
  for (const ing of ingRows) {
    if (!ingsByRecipe[ing.recipe_id]) ingsByRecipe[ing.recipe_id] = [];
    ingsByRecipe[ing.recipe_id].push(ing);
  }

  const recipeRows = db.prepare(`SELECT id, servings FROM recipes WHERE id IN (${qMarks})`).all(...recipeIds);
  const servingsById = {};
  for (const r of recipeRows) servingsById[r.id] = r.servings || 1;

  const merged = {};
  const warnings = [];

  // Walk every plan item (each meal slot for each day) so we can scale by
  // the number of diners for THAT meal type. A side paired with a dinner
  // slot scales by dinner-diners; the same side paired with a lunch slot
  // would scale by lunch-diners. The old code multiplied by householdSize
  // uniformly, which over-portioned every meal in households with mixed
  // per-member meal behaviors.
  for (const item of plan.items) {
    const diners = dinersFor(profile, item.meal_type);
    if (diners === 0) continue;  // nobody eats this slot — don't shop for it

    const recipesInSlot = [item.recipe_id, item.side_recipe_id].filter(Boolean);
    for (const rid of recipesInSlot) {
      const recipeServings = servingsById[rid] || 1;
      const scale = diners / recipeServings;
      const ings = ingsByRecipe[rid] || [];
      for (const ing of ings) {
        if (!Number.isFinite(ing.quantity) || ing.quantity <= 0) {
          warnings.push(`Invalid quantity on ingredient "${ing.name}" — skipped.`);
          continue;
        }
        const k = key(ing);
        if (!merged[k]) {
          merged[k] = { name: ing.name, quantity: 0, unit: ing.unit };
        }
        merged[k].quantity += ing.quantity * scale;
      }
    }
  }

  const rows = Object.values(merged).map(r => ({ ...r, quantity: +r.quantity.toFixed(2) }));
  const insert = db.prepare(`INSERT INTO shopping_items (plan_id, name, quantity, unit, approved) VALUES (?, ?, ?, ?, 1)`);
  const tx = db.transaction(() => {
    for (const r of rows) insert.run(planId, r.name, r.quantity, r.unit);
  });
  tx();

  const items = db.prepare('SELECT * FROM shopping_items WHERE plan_id = ? ORDER BY name').all(planId);
  return { plan, items, warnings };
}

function loadShoppingItems(planId) {
  return db.prepare('SELECT * FROM shopping_items WHERE plan_id = ? ORDER BY name').all(planId);
}

function updateShoppingItem(id, fields) {
  const allowed = ['name', 'quantity', 'unit', 'notes', 'approved'];
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
  const { name, quantity, unit } = fields;
  db.prepare(`INSERT INTO shopping_items (plan_id, name, quantity, unit, manual, approved)
              VALUES (?, ?, ?, ?, 1, 1)`).run(planId, name, quantity || 1, unit || 'each');
}

module.exports = {
  buildShoppingList,
  loadShoppingItems,
  updateShoppingItem,
  deleteShoppingItem,
  addManualItem
};
