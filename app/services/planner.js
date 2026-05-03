const db = require('../db');
const productCache = require('./product_cache');

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function parseJSON(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

const DEFAULT_MEAL_BEHAVIOR = { breakfast: 'plan', lunch: 'plan', snack: 'plan', dinner: 'plan' };

function loadProfile(profileId) {
  const profile = db.prepare('SELECT * FROM household_profiles WHERE id = ?').get(profileId);
  if (!profile) return null;
  profile.members = db.prepare('SELECT * FROM household_members WHERE profile_id = ?').all(profileId);
  // Parse per-member meal behavior; fall back to "plan everything" if the
  // JSON is malformed or missing keys (e.g. row migrated from an old schema
  // where some meal types weren't represented).
  for (const m of profile.members) {
    const parsed = parseJSON(m.meal_behavior_json, {});
    m.meal_behavior = { ...DEFAULT_MEAL_BEHAVIOR, ...parsed };
  }
  profile.meal_types = parseJSON(profile.meal_types_json, ['breakfast', 'lunch', 'snack', 'dinner'])
    .filter(t => t !== 'side');  // 'side' is no longer a slot type — paired with mains instead
  profile.pair_sides_with = parseJSON(profile.pair_sides_with_json, ['dinner']);
  profile.dietary = parseJSON(profile.dietary_constraints_json, []).map(s => s.toLowerCase());
  profile.allergies = parseJSON(profile.allergies_json, []).map(s => s.toLowerCase());
  profile.dislikes = parseJSON(profile.disliked_ingredients_json, []).map(s => s.toLowerCase());
  profile.favorites = parseJSON(profile.favorite_meals_json, []).map(s => s.toLowerCase());
  profile.preferred_cuisines = parseJSON(profile.preferred_cuisines_json, []).map(s => s.toLowerCase());
  return profile;
}

// Tag a recipe by its primary carb based on ingredient name keywords. Used
// to avoid carb-on-carb pairings like pasta+rice. 'none' means the recipe
// has no dominant carb, so any side is fine.
const CARB_KEYWORDS = {
  pasta:  ['pasta', 'spaghetti', 'penne', 'fettuccine', 'lasagna', 'macaroni', 'noodle', 'lo mein', 'ramen', 'orzo', 'rotini', 'ziti', 'shells', 'linguine', 'rigatoni'],
  rice:   ['rice', 'risotto', 'biryani', 'pilaf'],
  bread:  ['bread', 'tortilla', 'bun', 'baguette', 'roll', 'bagel', 'pita', 'flatbread', 'cornbread', 'biscuit', 'focaccia', 'crackers'],
  potato: ['potato', 'mashed', 'fries', 'wedges']
};
function carbTagFor(recipe) {
  const text = ((recipe.name || '') + ' ' + (recipe.ingredients || []).map(i => i.name).join(' ')).toLowerCase();
  for (const [tag, words] of Object.entries(CARB_KEYWORDS)) {
    if (words.some(w => text.includes(w))) return tag;
  }
  return 'none';
}

// Pull the recipe pool used by the planner, scoped to one user. Required —
// callers without a user shouldn't be planning anything.
function loadRecipes(userId) {
  if (!userId) throw new Error('loadRecipes: userId required');
  const recipes = db.prepare('SELECT * FROM recipes WHERE user_id = ?').all(userId);
  const ids = recipes.map(r => r.id);
  let ings = [];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    ings = db.prepare(`SELECT * FROM recipe_ingredients WHERE recipe_id IN (${placeholders})`).all(...ids);
  }
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

function hasKids(profile) {
  return profile.members.some(m => (m.label || '').toLowerCase() === 'child');
}

// How many household members actually eat the given meal type (i.e. their
// per-meal behavior is 'plan' rather than 'school' or 'skip'). Used in place
// of the old householdSize() so portion math and cost estimates reflect the
// people who'll actually be at the table for that meal — not the total
// household head-count. Returns at least 1 to avoid divide-by-zero in
// scoring; callers that need to gate slot generation check === 0 separately
// against the raw count via the same predicate.
function dinersFor(profile, mealType) {
  const n = profile.members.filter(
    m => m.meal_behavior && m.meal_behavior[mealType] === 'plan'
  ).length;
  return n;
}

function scoreRecipe(recipe, ctx) {
  const { profile, usedCounts, remainingBudget, slotsLeft, mealType, costOverrides } = ctx;
  const perSlotBudget = slotsLeft > 0 ? remainingBudget / slotsLeft : recipe.est_cost;
  const rawCost = (costOverrides && costOverrides[recipe.id] != null) ? costOverrides[recipe.id] : recipe.est_cost;
  // Cost scales by the number of people who actually eat THIS meal type, not
  // the total household. A household of 4 where only the WFH parent eats
  // planned lunches buys 1-serving lunches, not 4. dinersFor returns at
  // least 1 (clamped) so a meal with zero diners — which buildSlots already
  // skipped — wouldn't divide-by-zero if it ever leaked into scoring.
  const diners = Math.max(1, dinersFor(profile, mealType));
  const cost = rawCost * diners / Math.max(1, recipe.servings);

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
  const types = profile.meal_types.filter(t => t !== 'side');
  for (let day = 0; day < 7; day++) {
    for (const t of types) {
      // Skip the slot entirely when no member is set to 'plan' for this
      // meal type — generalizes the old lunch-only "if everyone has school
      // lunch, skip lunch slots" rule to every meal type.
      if (dinersFor(profile, t) === 0) continue;
      slots.push({ day, meal_type: t });
    }
  }
  return slots;
}

// Pick a side recipe to pair with a main. Same scoring spine as scoreRecipe
// but with a side-specific pairing layer:
//   - carb-on-carb penalty: -0.3 if main and side share carb tag
//   - cuisine match: +0.1 boost
//   - kid-friendly carry-over: +0.1 if main is kid_friendly and household has kids
function pickSideFor(main, sidePool, ctx) {
  if (!sidePool.length) return null;
  const mainCarb = carbTagFor(main);
  const mainCuisine = (main.cuisine || '').toLowerCase();
  const profile = ctx.profile;

  const scored = sidePool.map(side => {
    const base = scoreRecipe(side, ctx);
    const sideCarb = carbTagFor(side);

    let pairing = 0;
    if (mainCarb !== 'none' && sideCarb === mainCarb) pairing -= 0.3;
    if (mainCuisine && side.cuisine && mainCuisine === side.cuisine.toLowerCase()) pairing += 0.1;
    if (hasKids(profile) && main.kid_friendly && side.kid_friendly) pairing += 0.1;

    return {
      recipe: side,
      result: {
        total: base.total + pairing,
        factors: {
          ...base.factors,
          pairing: +pairing.toFixed(2),
          main_carb: mainCarb,
          side_carb: sideCarb
        }
      }
    };
  });

  scored.sort((a, b) => b.result.total - a.result.total);
  return scored[0];
}

// Scopes the recipe pool to userId.
function generatePlan(profileId, userId) {
  if (!userId) throw new Error('generatePlan: userId required');
  const profile = loadProfile(profileId);
  if (!profile) throw new Error('No household profile');
  const allRecipes = loadRecipes(userId).filter(r => recipePassesHardFilters(r, profile));
  const warnings = [];

  // Pre-compute cost overrides from cached Walmart prices. If we have prices
  // for >=50% of a recipe's ingredients, use the cached cost instead of the
  // stored est_cost. This lets the "price list" organically improve scoring
  // as Walmart data accumulates.
  const costOverrides = {};
  for (const r of allRecipes) {
    const est = productCache.estimateRecipeCost(r.id);
    if (est.total > 0 && est.covered / est.total >= 0.5) {
      costOverrides[r.id] = est.cost;
    }
  }

  const slots = buildSlots(profile);
  const usedCounts = {};
  let remainingBudget = profile.budget_weekly;
  const items = [];
  const sidePool = allRecipes.filter(r => r.meal_type === 'side');

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const pool = allRecipes.filter(r => r.meal_type === slot.meal_type);
    if (pool.length === 0) {
      warnings.push(`No recipes available for ${slot.meal_type} (${DAYS[slot.day]}).`);
      items.push({ ...slot, recipe_id: null, score: null, side_recipe_id: null, side_score: null });
      continue;
    }
    const ctx = {
      profile,
      usedCounts,
      remainingBudget,
      slotsLeft: slots.length - i,
      mealType: slot.meal_type,
      costOverrides
    };
    const scored = pool.map(r => ({ recipe: r, result: scoreRecipe(r, ctx) }));
    scored.sort((a, b) => b.result.total - a.result.total);
    const pick = scored[0];
    usedCounts[pick.recipe.id] = (usedCounts[pick.recipe.id] || 0) + 1;
    const cost = pick.result.factors.cost_estimate;
    remainingBudget -= cost;

    // Pair a side if profile says this meal_type gets one.
    let sidePick = null;
    if (profile.pair_sides_with.includes(slot.meal_type) && sidePool.length) {
      sidePick = pickSideFor(pick.recipe, sidePool, { ...ctx, mealType: 'side' });
      if (sidePick) {
        usedCounts[sidePick.recipe.id] = (usedCounts[sidePick.recipe.id] || 0) + 1;
        remainingBudget -= sidePick.result.factors.cost_estimate;
      }
    }

    items.push({
      ...slot,
      recipe_id: pick.recipe.id,
      score: pick.result,
      side_recipe_id: sidePick ? sidePick.recipe.id : null,
      side_score: sidePick ? sidePick.result : null
    });
  }

  const totalCost = items.reduce((s, it) => {
    let c = it.score ? it.score.factors.cost_estimate : 0;
    if (it.side_score) c += it.side_score.factors.cost_estimate;
    return s + c;
  }, 0);
  if (totalCost > profile.budget_weekly) {
    warnings.push(`Estimated cost $${totalCost.toFixed(2)} exceeds weekly budget $${profile.budget_weekly.toFixed(2)}.`);
  }

  return { profile, items, warnings, totalCost };
}

function savePlan(profileId, generated, userId) {
  if (!userId) throw new Error('savePlan: userId required');
  const today = new Date();
  const startDate = today.toISOString().slice(0, 10);
  const insertPlan = db.prepare(
    'INSERT INTO weekly_plans (profile_id, user_id, start_date, status, total_cost) VALUES (?, ?, ?, ?, ?)'
  );
  const info = insertPlan.run(profileId, userId, startDate, 'draft', generated.totalCost);
  const planId = info.lastInsertRowid;
  const insertItem = db.prepare(`INSERT INTO weekly_plan_items
    (plan_id, day, meal_type, recipe_id, score_json, side_recipe_id, side_score_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const it of generated.items) {
      insertItem.run(
        planId, it.day, it.meal_type, it.recipe_id,
        it.score ? JSON.stringify(it.score) : null,
        it.side_recipe_id || null,
        it.side_score ? JSON.stringify(it.side_score) : null
      );
    }
  });
  tx();
  return planId;
}

function loadPlan(planId) {
  const plan = db.prepare('SELECT * FROM weekly_plans WHERE id = ?').get(planId);
  if (!plan) return null;
  const items = db.prepare(`
    SELECT wpi.*,
           r.name as recipe_name, r.prep_time, r.est_cost, r.servings,
           r.calories, r.protein, r.fiber, r.sugar, r.sodium, r.kid_friendly,
           sr.name as side_recipe_name, sr.prep_time as side_prep_time, sr.est_cost as side_est_cost
    FROM weekly_plan_items wpi
    LEFT JOIN recipes r  ON wpi.recipe_id = r.id
    LEFT JOIN recipes sr ON wpi.side_recipe_id = sr.id
    WHERE wpi.plan_id = ?
    ORDER BY wpi.day, wpi.meal_type
  `).all(planId);
  for (const it of items) {
    it.score = it.score_json ? JSON.parse(it.score_json) : null;
    it.side_score = it.side_score_json ? JSON.parse(it.side_score_json) : null;
  }
  plan.items = items;
  plan.profile = loadProfile(plan.profile_id);
  const totalPrep = items.reduce((s, it) => s + (it.prep_time || 0) + (it.side_prep_time || 0), 0);
  const healthItems = items.filter(it => it.recipe_id);
  const avgHealth = healthItems.length ? healthItems.reduce((s, it) => s + (it.score ? it.score.factors.health : 0), 0) / healthItems.length : 0;
  plan.total_prep = totalPrep;
  plan.health_score = +avgHealth.toFixed(2);
  return plan;
}

// target = 'main' (default) or 'side' — controls which column is updated.
function updateSlot(planId, day, mealType, recipeId, locked, target = 'main') {
  if (target === 'side') {
    db.prepare(`UPDATE weekly_plan_items SET side_recipe_id = ?, side_score_json = NULL
                WHERE plan_id = ? AND day = ? AND meal_type = ?`)
      .run(recipeId || null, planId, day, mealType);
  } else {
    db.prepare(`UPDATE weekly_plan_items SET recipe_id = ?, locked = ?, score_json = NULL
                WHERE plan_id = ? AND day = ? AND meal_type = ?`)
      .run(recipeId || null, locked ? 1 : 0, planId, day, mealType);
  }
}

function regenerateSlot(planId, day, mealType, target = 'main') {
  const plan = loadPlan(planId);
  if (!plan) return;
  const profile = plan.profile;
  const item = plan.items.find(it => it.day === day && it.meal_type === mealType);
  if (!item) return;
  // Scope the recipe pool to the plan's owner.
  const allRecipes = loadRecipes(plan.user_id).filter(r => recipePassesHardFilters(r, profile));
  const usedCounts = {};
  for (const it of plan.items) {
    if (it.recipe_id) usedCounts[it.recipe_id] = (usedCounts[it.recipe_id] || 0) + 1;
    if (it.side_recipe_id) usedCounts[it.side_recipe_id] = (usedCounts[it.side_recipe_id] || 0) + 1;
  }
  const remaining = Math.max(1, profile.budget_weekly - plan.items.reduce((s, it) => {
    let c = it.score ? it.score.factors.cost_estimate : 0;
    if (it.side_score) c += it.side_score.factors.cost_estimate;
    return s + c;
  }, 0));

  if (target === 'side') {
    const main = item.recipe_id ? db.prepare('SELECT * FROM recipes WHERE id = ?').get(item.recipe_id) : null;
    if (!main) return;
    main.ingredients = db.prepare('SELECT * FROM recipe_ingredients WHERE recipe_id = ?').all(main.id);
    const sidePool = allRecipes.filter(r => r.meal_type === 'side' && r.id !== item.side_recipe_id);
    if (!sidePool.length) return;
    const costOverrides = {};
    for (const r of sidePool) {
      const est = productCache.estimateRecipeCost(r.id);
      if (est.total > 0 && est.covered / est.total >= 0.5) costOverrides[r.id] = est.cost;
    }
    const pick = pickSideFor(main, sidePool, { profile, usedCounts, remainingBudget: remaining, slotsLeft: 1, mealType: 'side', costOverrides });
    if (!pick) return;
    db.prepare(`UPDATE weekly_plan_items SET side_recipe_id = ?, side_score_json = ? WHERE plan_id = ? AND day = ? AND meal_type = ?`)
      .run(pick.recipe.id, JSON.stringify(pick.result), planId, day, mealType);
  } else {
    const pool = allRecipes.filter(r => r.meal_type === mealType && r.id !== item.recipe_id);
    if (!pool.length) return;
    const costOverrides = {};
    for (const r of pool) {
      const est = productCache.estimateRecipeCost(r.id);
      if (est.total > 0 && est.covered / est.total >= 0.5) costOverrides[r.id] = est.cost;
    }
    const scored = pool.map(r => ({ recipe: r, result: scoreRecipe(r, { profile, usedCounts, remainingBudget: remaining, slotsLeft: 1, mealType, costOverrides }) }));
    scored.sort((a, b) => b.result.total - a.result.total);
    const pick = scored[0];
    db.prepare(`UPDATE weekly_plan_items SET recipe_id = ?, score_json = ? WHERE plan_id = ? AND day = ? AND meal_type = ?`)
      .run(pick.recipe.id, JSON.stringify(pick.result), planId, day, mealType);
  }
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
  hasKids,
  dinersFor
};
