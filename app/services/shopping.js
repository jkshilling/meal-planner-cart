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

  // Collect every recipe that contributes to the list — mains, paired sides,
  // and any per-member packed-meal recipes for meals where that member's
  // behavior is 'school'. We fetch ingredients + servings for the union
  // upfront so the inner loops are pure aggregation.
  const allIds = new Set();
  for (const i of plan.items) {
    if (i.recipe_id) allIds.add(i.recipe_id);
    if (i.side_recipe_id) allIds.add(i.side_recipe_id);
  }
  const PACKED_MEAL_TYPES = ['breakfast', 'lunch', 'snack', 'dinner'];
  for (const m of profile.members) {
    for (const mt of PACKED_MEAL_TYPES) {
      if (m.meal_behavior && m.meal_behavior[mt] === 'school') {
        const rid = m.packed_recipe_ids && m.packed_recipe_ids[mt];
        if (rid) allIds.add(rid);
      }
    }
  }
  const recipeIds = [...allIds];
  if (recipeIds.length === 0) {
    return { plan, items: [], warnings: ['No recipes in plan or packed meals'] };
  }

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

  // addContribution walks a recipe's ingredients and merges them into the
  // shared `merged` map, scaled by the supplied `scale` factor. Used for
  // both planned slots (scale = diners / recipe.servings) and packed-meal
  // contributions (scale = days / recipe.servings).
  function addContribution(recipeId, scale, sourceLabel) {
    const ings = ingsByRecipe[recipeId];
    if (!ings) return;  // recipe was deleted or never existed; skip silently
    for (const ing of ings) {
      if (!Number.isFinite(ing.quantity) || ing.quantity <= 0) {
        warnings.push(`Invalid quantity on ingredient "${ing.name}" (${sourceLabel}) — skipped.`);
        continue;
      }
      const k = key(ing);
      if (!merged[k]) {
        merged[k] = { name: ing.name, quantity: 0, unit: ing.unit };
      }
      merged[k].quantity += ing.quantity * scale;
    }
  }

  // (1) Planned slots. Walk every plan item so we can scale by the number
  // of diners for THAT meal type. A side paired with a dinner slot scales
  // by dinner-diners; the same side paired with a lunch slot would scale
  // by lunch-diners.
  for (const item of plan.items) {
    const diners = dinersFor(profile, item.meal_type);
    if (diners === 0) continue;  // nobody eats this slot — don't shop for it
    for (const rid of [item.recipe_id, item.side_recipe_id].filter(Boolean)) {
      const recipeServings = servingsById[rid] || 1;
      addContribution(rid, diners / recipeServings, 'planned ' + item.meal_type);
    }
  }

  // (2) Packed-meal contributions. For each member with meal_behavior of
  // 'school' for a meal type AND a packed recipe assigned, add 7 servings'
  // worth of that recipe's ingredients (one packed serving per day per
  // packed eater for the week). This shows up on the shopping list without
  // generating a sit-down slot in the plan.
  const DAYS_PER_WEEK = 7;
  for (const m of profile.members) {
    for (const mt of PACKED_MEAL_TYPES) {
      if (!m.meal_behavior || m.meal_behavior[mt] !== 'school') continue;
      const rid = m.packed_recipe_ids && m.packed_recipe_ids[mt];
      if (!rid) continue;
      const recipeServings = servingsById[rid] || 1;
      addContribution(
        rid,
        DAYS_PER_WEEK / recipeServings,
        `${m.name}'s packed ${mt}`
      );
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
