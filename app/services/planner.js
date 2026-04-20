const db = require('../db');

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function parseJSON(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

function loadProfile(profileId) {
  const profile = db.prepare('SELECT * FROM household_profiles WHERE id = ?').get(profileId);
  if (!profile) return null;
  profile.members = db.prepare('SELECT * FROM household_members WHERE profile_id = ?').all(profileId);
  profile.meal_types = parseJSON(profile.meal_types_json, ['breakfast', 'lunch', 'snack', 'dinner']);
  profile.dietary = parseJSON(profile.dietary_constraints_json, []).map(s => s.toLowerCase());
  profile.allergies = parseJSON(profile.allergies_json, []).map(s => s.toLowerCase());
  profile.dislikes = parseJSON(profile.disliked_ingredients_json, []).map(s => s.toLowerCase());
  profile.favorites = parseJSON(profile.favorite_meals_json, []).map(s => s.toLowerCase());
  profile.preferred_cuisines = parseJSON(profile.preferred_cuisines_json, []).map(s => s.toLowerCase());
  return profile;
}

function loadRecipes() {
  const recipes = db.prepare('SELECT * FROM recipes').all();
  const ings = db.prepare('SELECT * FROM recipe_ingredients').all();
  const byId = {};
  for (const r of recipes) { r.ingredients = []; byId[r.id] = r; }
  for (const ing of ings) { if (byId[ing.recipe_id]) byId[ing.recipe_id].ingredients.push(ing); }
  return recipes;
}

function recipePassesHardFilters(recipe, profile) {
  const ingNames = recipe.ingredients.map(i => i.name.toLowerCase());
  for (const a of profile.allergies) {
    if (ingNames.some(n => n.includes(a)) || recipe.name.toLowerCase().includes(a)) return false;
  }
  for (const d of profile.dislikes) {
    if (ingNames.some(n => n.includes(d))) return false;
  }
  for (const c of profile.dietary) {
    if (c === 'vegetarian') {
      const meats = ['chicken', 'beef', 'pork', 'turkey', 'bacon', 'sausage', 'ham', 'fish', 'salmon', 'tuna', 'shrimp'];
      if (meats.some(m => ingNames.some(n => n.includes(m)))) return false;
    }
    if (c === 'vegan') {
      const animal = ['chicken', 'beef', 'pork', 'turkey', 'bacon', 'sausage', 'ham', 'fish', 'salmon', 'tuna', 'shrimp', 'egg', 'milk', 'cheese', 'butter', 'yogurt', 'cream'];
      if (animal.some(m => ingNames.some(n => n.includes(m)))) return false;
    }
    if (c === 'gluten-free' || c === 'gluten free') {
      const gluten = ['flour', 'bread', 'pasta', 'tortilla', 'noodle', 'cracker', 'cereal'];
      if (gluten.some(m => ingNames.some(n => n.includes(m)))) return false;
    }
  }
  if (profile.max_prep_time && recipe.prep_time > profile.max_prep_time) return false;
  return true;
}

function householdSize(profile) {
  return Math.max(1, profile.members.length);
}

function hasKids(profile) {
  return profile.members.some(m => (m.label || '').toLowerCase() === 'child');
}

function lunchScopeForSlot(profile) {
  const planLunch = profile.members.filter(m => m.lunch_behavior === 'plan');
  const schoolLunch = profile.members.filter(m => m.lunch_behavior === 'school');
  const skipLunch = profile.members.filter(m => m.lunch_behavior === 'skip');
  return { planLunch, schoolLunch, skipLunch };
}

function scoreRecipe(recipe, ctx) {
  const { profile, usedCounts, remainingBudget, slotsLeft, mealType } = ctx;
  const perSlotBudget = slotsLeft > 0 ? remainingBudget / slotsLeft : recipe.est_cost;
  const cost = recipe.est_cost * householdSize(profile) / Math.max(1, recipe.servings);

  // Budget score: 1 if cost <= perSlot, scales down sharply above.
  const budgetScore = cost <= perSlotBudget ? 1 : Math.max(0, 1 - (cost - perSlotBudget) / Math.max(1, perSlotBudget));

  // Prep time: 1 at 0 min, 0 at 60+
  const prepScore = Math.max(0, 1 - recipe.prep_time / 60);

  // Health score: reward fiber, protein; penalize sugar, sodium.
  const protein = recipe.protein || 0;
  const fiber = recipe.fiber || 0;
  const sugar = recipe.sugar || 0;
  const sodium = recipe.sodium || 0;
  let healthScore = 0.5 + (protein / 40) * 0.2 + (fiber / 10) * 0.2 - (sugar / 30) * 0.2 - (sodium / 1500) * 0.2;
  healthScore = Math.max(0, Math.min(1, healthScore));

  const used = usedCounts[recipe.id] || 0;
  const repetitionPenalty = used * 0.25;

  const nameLower = recipe.name.toLowerCase();
  const favoriteBoost = (recipe.favorite || profile.favorites.some(f => nameLower.includes(f))) ? 0.15 : 0;

  let fitBoost = 0;
  if (hasKids(profile) && recipe.kid_friendly) fitBoost += 0.1;
  if (profile.preferred_cuisines.length && recipe.cuisine && profile.preferred_cuisines.includes(recipe.cuisine.toLowerCase())) fitBoost += 0.1;
  if (mealType === 'breakfast' && profile.breakfast_simplicity && recipe.prep_time <= 15) fitBoost += 0.15;

  let weights;
  if (profile.optimization_mode === 'healthiest') weights = { budget: 0.45, prep: 0.1, health: 0.45 };
  else if (profile.optimization_mode === 'least_prep_time') weights = { budget: 0.45, prep: 0.45, health: 0.1 };
  else weights = { budget: 0.65, prep: 0.2, health: 0.15 };

  const base = budgetScore * weights.budget + prepScore * weights.prep + healthScore * weights.health;
  const total = base - repetitionPenalty + favoriteBoost + fitBoost;

  return {
    total,
    factors: {
      budget: +budgetScore.toFixed(2),
      prep: +prepScore.toFixed(2),
      health: +healthScore.toFixed(2),
      repetition_penalty: +repetitionPenalty.toFixed(2),
      favorite_boost: +favoriteBoost.toFixed(2),
      fit_boost: +fitBoost.toFixed(2),
      cost_estimate: +cost.toFixed(2)
    }
  };
}

function buildSlots(profile) {
  const slots = [];
  const types = profile.meal_types;
  const { planLunch } = lunchScopeForSlot(profile);
  for (let day = 0; day < 7; day++) {
    for (const t of types) {
      if (t === 'lunch' && planLunch.length === 0) continue;
      slots.push({ day, meal_type: t });
    }
  }
  return slots;
}

function generatePlan(profileId) {
  const profile = loadProfile(profileId);
  if (!profile) throw new Error('No household profile');
  const allRecipes = loadRecipes().filter(r => recipePassesHardFilters(r, profile));
  const warnings = [];

  const slots = buildSlots(profile);
  const usedCounts = {};
  let remainingBudget = profile.budget_weekly;
  const items = [];

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const pool = allRecipes.filter(r => r.meal_type === slot.meal_type);
    if (pool.length === 0) {
      warnings.push(`No recipes available for ${slot.meal_type} (${DAYS[slot.day]}).`);
      items.push({ ...slot, recipe_id: null, score: null });
      continue;
    }
    const ctx = {
      profile,
      usedCounts,
      remainingBudget,
      slotsLeft: slots.length - i,
      mealType: slot.meal_type
    };
    const scored = pool.map(r => ({ recipe: r, result: scoreRecipe(r, ctx) }));
    scored.sort((a, b) => b.result.total - a.result.total);
    const pick = scored[0];
    usedCounts[pick.recipe.id] = (usedCounts[pick.recipe.id] || 0) + 1;
    const cost = pick.result.factors.cost_estimate;
    remainingBudget -= cost;
    items.push({ ...slot, recipe_id: pick.recipe.id, score: pick.result });
  }

  const totalCost = items.reduce((s, it) => s + (it.score ? it.score.factors.cost_estimate : 0), 0);
  if (totalCost > profile.budget_weekly) {
    warnings.push(`Estimated cost $${totalCost.toFixed(2)} exceeds weekly budget $${profile.budget_weekly.toFixed(2)}.`);
  }

  return { profile, items, warnings, totalCost };
}

function savePlan(profileId, generated) {
  const today = new Date();
  const startDate = today.toISOString().slice(0, 10);
  const insertPlan = db.prepare('INSERT INTO weekly_plans (profile_id, start_date, status, total_cost) VALUES (?, ?, ?, ?)');
  const info = insertPlan.run(profileId, startDate, 'draft', generated.totalCost);
  const planId = info.lastInsertRowid;
  const insertItem = db.prepare(`INSERT INTO weekly_plan_items (plan_id, day, meal_type, recipe_id, score_json) VALUES (?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const it of generated.items) {
      insertItem.run(planId, it.day, it.meal_type, it.recipe_id, it.score ? JSON.stringify(it.score) : null);
    }
  });
  tx();
  return planId;
}

function loadPlan(planId) {
  const plan = db.prepare('SELECT * FROM weekly_plans WHERE id = ?').get(planId);
  if (!plan) return null;
  const items = db.prepare(`
    SELECT wpi.*, r.name as recipe_name, r.prep_time, r.est_cost, r.servings,
           r.calories, r.protein, r.fiber, r.sugar, r.sodium, r.kid_friendly
    FROM weekly_plan_items wpi
    LEFT JOIN recipes r ON wpi.recipe_id = r.id
    WHERE wpi.plan_id = ?
    ORDER BY wpi.day, wpi.meal_type
  `).all(planId);
  for (const it of items) {
    it.score = it.score_json ? JSON.parse(it.score_json) : null;
  }
  plan.items = items;
  plan.profile = loadProfile(plan.profile_id);
  const totalPrep = items.reduce((s, it) => s + (it.prep_time || 0), 0);
  const healthItems = items.filter(it => it.recipe_id);
  const avgHealth = healthItems.length ? healthItems.reduce((s, it) => s + (it.score ? it.score.factors.health : 0), 0) / healthItems.length : 0;
  plan.total_prep = totalPrep;
  plan.health_score = +avgHealth.toFixed(2);
  return plan;
}

function updateSlot(planId, day, mealType, recipeId, locked) {
  db.prepare(`UPDATE weekly_plan_items SET recipe_id = ?, locked = ?, score_json = NULL
              WHERE plan_id = ? AND day = ? AND meal_type = ?`)
    .run(recipeId || null, locked ? 1 : 0, planId, day, mealType);
}

function regenerateSlot(planId, day, mealType) {
  const plan = loadPlan(planId);
  if (!plan) return;
  const profile = plan.profile;
  const allRecipes = loadRecipes().filter(r => recipePassesHardFilters(r, profile) && r.meal_type === mealType);
  const currentId = (plan.items.find(it => it.day === day && it.meal_type === mealType) || {}).recipe_id;
  const pool = allRecipes.filter(r => r.id !== currentId);
  if (pool.length === 0) return;
  const usedCounts = {};
  for (const it of plan.items) if (it.recipe_id) usedCounts[it.recipe_id] = (usedCounts[it.recipe_id] || 0) + 1;
  const remaining = Math.max(1, profile.budget_weekly - plan.items.reduce((s, it) => s + (it.score ? it.score.factors.cost_estimate : 0), 0));
  const scored = pool.map(r => ({ recipe: r, result: scoreRecipe(r, { profile, usedCounts, remainingBudget: remaining, slotsLeft: 1, mealType }) }));
  scored.sort((a, b) => b.result.total - a.result.total);
  const pick = scored[0];
  db.prepare(`UPDATE weekly_plan_items SET recipe_id = ?, score_json = ? WHERE plan_id = ? AND day = ? AND meal_type = ?`)
    .run(pick.recipe.id, JSON.stringify(pick.result), planId, day, mealType);
}

function approvePlan(planId) {
  db.prepare(`UPDATE weekly_plans SET status = 'approved', approved_at = datetime('now') WHERE id = ?`).run(planId);
}

module.exports = {
  DAYS,
  loadProfile,
  loadRecipes,
  generatePlan,
  savePlan,
  loadPlan,
  updateSlot,
  regenerateSlot,
  approvePlan,
  lunchScopeForSlot,
  hasKids,
  householdSize
};
