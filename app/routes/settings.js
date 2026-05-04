const express = require('express');
const db = require('../db');
const { loadProfile } = require('../services/planner');
const groceryToken = require('../services/grocery_token');
const household = require('../services/household');
const invites = require('../services/invites');
const { requireAuth, userIdOf } = require('../services/auth');

const router = express.Router();

router.get('/settings', requireAuth, (req, res) => {
  const uid = userIdOf(req);
  const p = household.profileForUser(uid);
  if (!p) {
    return res.status(500).render('error', {
      title: 'No household',
      message: 'No household found for your account.'
    });
  }
  const profile = loadProfile(p.id);
  // Pulled for the per-member "packed meal" recipe dropdowns. Just id +
  // name + meal_type — the dropdown groups by meal_type so the user can
  // pick the right kind of recipe (or any recipe if they want).
  const recipes = db.prepare(
    'SELECT id, name, meal_type FROM recipes WHERE user_id = ? ORDER BY meal_type, name'
  ).all(uid);
  // Counts for the "Recipe library" card. Total = everything the user owns;
  // fromMaster = the subset that came from a Spoonacular import (source_id
  // set). Difference = hand-entered.
  const libraryCounts = {
    total:       db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE user_id = ?').get(uid).n,
    fromMaster:  db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE user_id = ? AND source_id IS NOT NULL').get(uid).n
  };

  // Ingredient nutrition coverage. Two tables on the settings page:
  //   matched   — every ingredient that has a real USDA match, shown with
  //               the matched description + cal/100g. Lets the owner spot
  //               wrong-but-non-empty matches by eye (e.g. "cinnamon" →
  //               "Cinnamon buns, frosted") that the no-match table would
  //               never surface.
  //   unmatched — everything else (USDA found nothing, or hasn't been
  //               asked yet), with the recipes affected.
  //
  // Status semantics for unmatched:
  //   'no-match' = nutrition_lookups has a row with NULL calories
  //                (USDA was queried, came back empty).
  //   'pending'  = no row in nutrition_lookups at all yet
  //                (USDA hasn't been asked about this name).
  // Both states mean "this ingredient doesn't count toward nutrition."
  const allUserIngs = db.prepare(`
    SELECT DISTINCT LOWER(TRIM(ri.name)) AS ing_name
      FROM recipe_ingredients ri
      JOIN recipes r ON r.id = ri.recipe_id
     WHERE r.user_id = ?
  `).all(uid).map(r => r.ing_name).filter(Boolean);
  let ingredientCoverage = {
    total_distinct: allUserIngs.length,
    matched: [],
    unmatched: []
  };
  if (allUserIngs.length) {
    const placeholders = allUserIngs.map(() => '?').join(',');
    const cached = db.prepare(
      `SELECT ingredient_name, matched_description, calories_per_100g, llm_suggested_name
         FROM nutrition_lookups
        WHERE ingredient_name IN (${placeholders})`
    ).all(...allUserIngs);
    const cacheRows = new Map();
    for (const r of cached) cacheRows.set(r.ingredient_name, r);

    // Pre-fetch every ingredient → recipe edge in one query so we can
    // attach a recipe list to BOTH matched and unmatched entries (the
    // matched table needs the recipe links so the owner can jump to a
    // recipe that uses a wrong match and rename the ingredient).
    const allUsage = db.prepare(`
      SELECT LOWER(TRIM(ri.name)) AS ing_name, r.id, r.name
        FROM recipe_ingredients ri
        JOIN recipes r ON r.id = ri.recipe_id
       WHERE r.user_id = ?
    `).all(uid);
    const recipesByName = new Map();
    for (const u of allUsage) {
      if (!recipesByName.has(u.ing_name)) recipesByName.set(u.ing_name, []);
      const list = recipesByName.get(u.ing_name);
      if (!list.find(x => x.id === u.id)) list.push({ id: u.id, name: u.name });
    }

    const matched = [];
    const unmatched = [];
    for (const name of allUserIngs) {
      const row = cacheRows.get(name);
      const recipes = recipesByName.get(name) || [];
      if (row && row.calories_per_100g != null) {
        matched.push({
          name,
          usda_description: row.matched_description,
          calories_per_100g: row.calories_per_100g,
          llm_suggested_name: row.llm_suggested_name,
          recipes
        });
      } else {
        const status = row ? 'no-match' : 'pending';
        unmatched.push({ name, status, recipes });
      }
    }
    // Matched: alphabetical by ingredient name. The owner is scanning the
    // table for weird matches by eye, and alphabetical is the most
    // predictable order for that scan.
    matched.sort((a, b) => a.name.localeCompare(b.name));
    // Unmatched: most-used first, then alphabetical — surfaces the
    // highest-impact rename targets at the top.
    unmatched.sort((a, b) =>
      b.recipes.length - a.recipes.length || a.name.localeCompare(b.name)
    );
    ingredientCoverage.matched = matched;
    ingredientCoverage.unmatched = unmatched;
  }
  res.render('settings', {
    title: 'Settings',
    profile,
    recipes,
    libraryCounts,
    ingredientCoverage,
    saved: req.query.saved === '1',
    groceryToken: groceryToken.ensureForUser(uid),
    tokenRotated: req.query.tokenRotated === '1',
    inviteCodes: invites.listByCreator(uid),
    inviteCreated: req.query.inviteCreated || null,
    inviteRevoked: req.query.inviteRevoked === '1'
  });
});

router.post('/settings/grocery-token/rotate', requireAuth, (req, res) => {
  groceryToken.rotateForUser(userIdOf(req));
  res.redirect('/settings?tokenRotated=1#grocery-extension');
});

// Re-sync the user's recipe library from the bootstrap owner's master
// library. Purely additive: copies any source_id-bearing recipes the user
// doesn't already have. See services/household.seedRecipesForUser for the
// full contract — in short, edits and hand-entered recipes are never
// touched. Sets a flash so the redirect can show how many were imported.
router.post('/settings/recipes/resync', requireAuth, (req, res) => {
  const added = household.seedRecipesForUser(userIdOf(req));
  req.session.flash = {
    type: 'success',
    message: added > 0
      ? `Imported ${added} new recipe${added === 1 ? '' : 's'} from the master library.`
      : "You're already up to date — nothing new in the master library."
  };
  res.redirect('/settings#recipe-library');
});

// Mint a new single-use invite code. Optional label so the inviter can
// remember who it was for. Redirects with the new code in the query so it
// shows once on the settings page (the user copy/pastes from there).
router.post('/settings/invites/create', requireAuth, (req, res) => {
  const label = (req.body.label || '').toString().trim().slice(0, 80);
  const { code } = invites.create({ createdByUserId: userIdOf(req), label: label || null });
  res.redirect('/settings?inviteCreated=' + encodeURIComponent(code) + '#invites');
});

// Revoke an unused invite. No-op on used codes (those stay as audit trail).
router.post('/settings/invites/:id/revoke', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isInteger(id)) {
    invites.revoke({ id, createdByUserId: userIdOf(req) });
  }
  res.redirect('/settings?inviteRevoked=1#invites');
});

router.post('/settings', requireAuth, (req, res) => {
  const uid = userIdOf(req);
  const p = household.profileForUser(uid);
  if (!p) return res.status(500).render('error', { title: 'No household', message: 'No household found.' });
  const body = req.body;
  // Parse a comma-separated text input into a JSON array of trimmed strings.
  // Accepts either an array (rare; some browsers send multiple inputs) or a
  // single comma-joined string (the common case for our settings form).
  const toJSONList = (v) => {
    if (Array.isArray(v)) return JSON.stringify(v.filter(Boolean));
    if (typeof v === 'string') return JSON.stringify(v.split(',').map(s => s.trim()).filter(Boolean));
    return '[]';
  };
  const mealTypes = ['breakfast', 'lunch', 'snack', 'dinner'].filter(t => body['meal_' + t]);
  const pairSidesWith = ['lunch', 'dinner'].filter(t => body['pair_sides_' + t]);
  const budget = parseFloat(body.budget_weekly);
  const safeBudget = isFinite(budget) && budget > 0 ? budget : 150;

  // Re-confirm ownership in the WHERE clause so a forged p.id can't slip
  // through. Belt and suspenders given household.profileForUser already
  // scopes by user_id.
  db.prepare(`UPDATE household_profiles SET
    name = ?, budget_weekly = ?, optimization_mode = ?, breakfast_simplicity = ?, max_prep_time = ?,
    meal_types_json = ?, pair_sides_with_json = ?
    WHERE id = ? AND user_id = ?`)
    .run(
      body.name || 'Household',
      safeBudget,
      body.optimization_mode || 'lowest_cost',
      body.breakfast_simplicity ? 1 : 0,
      parseInt(body.max_prep_time, 10) || 45,
      JSON.stringify(mealTypes.length ? mealTypes : ['dinner']),
      JSON.stringify(pairSidesWith),
      p.id,
      uid
    );

  // Members: replace with submitted set. Form arrays we collect per row:
  //   member_name, member_label
  //   member_breakfast / lunch / snack / dinner   (plan|school|skip)
  //   member_allergies / member_dietary / member_dislikes  (CSV strings)
  // Each is an N-length array (or single value, which Array.concat normalizes).
  db.prepare('DELETE FROM household_members WHERE profile_id = ?').run(p.id);
  const names = [].concat(body.member_name || []);
  const labels = [].concat(body.member_label || []);
  const breakfasts = [].concat(body.member_breakfast || []);
  const lunches    = [].concat(body.member_lunch     || []);
  const snacks     = [].concat(body.member_snack     || []);
  const dinners    = [].concat(body.member_dinner    || []);
  const allergies  = [].concat(body.member_allergies || []);
  const dietary    = [].concat(body.member_dietary   || []);
  const dislikes   = [].concat(body.member_dislikes  || []);
  // Packed-meal recipe assignments (per-member, per-meal-type). Each is an
  // array of recipe IDs (or empty strings, which we coerce to null).
  const packedBreakfasts = [].concat(body.member_packed_breakfast || []);
  const packedLunches    = [].concat(body.member_packed_lunch     || []);
  const packedSnacks     = [].concat(body.member_packed_snack     || []);
  const packedDinners    = [].concat(body.member_packed_dinner    || []);
  const insertMember = db.prepare(`
    INSERT INTO household_members
      (profile_id, name, label, meal_behavior_json,
       allergies_json, dietary_constraints_json, disliked_ingredients_json,
       packed_recipe_ids_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sanitizeBehavior = (v) => (['plan', 'school', 'skip'].includes(v) ? v : 'plan');
  const mealBehaviorAt = (i) => JSON.stringify({
    breakfast: sanitizeBehavior(breakfasts[i]),
    lunch:     sanitizeBehavior(lunches[i]),
    snack:     sanitizeBehavior(snacks[i]),
    dinner:    sanitizeBehavior(dinners[i])
  });
  // Empty string from a "(none)" select option becomes null in the JSON;
  // stringify-then-parse keeps numeric IDs as numbers.
  const sanitizeRecipeId = (v) => {
    const n = parseInt(v, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const packedAt = (i) => JSON.stringify({
    breakfast: sanitizeRecipeId(packedBreakfasts[i]),
    lunch:     sanitizeRecipeId(packedLunches[i]),
    snack:     sanitizeRecipeId(packedSnacks[i]),
    dinner:    sanitizeRecipeId(packedDinners[i])
  });
  for (let i = 0; i < names.length; i++) {
    const name = (names[i] || '').trim();
    if (!name) continue;
    insertMember.run(
      p.id,
      name,
      labels[i] || 'adult',
      mealBehaviorAt(i),
      toJSONList(allergies[i] || ''),
      toJSONList(dietary[i]   || ''),
      toJSONList(dislikes[i]  || ''),
      packedAt(i)
    );
  }
  if (!names.filter(n => n && n.trim()).length) {
    insertMember.run(
      p.id, 'Me', 'adult',
      JSON.stringify({ breakfast: 'plan', lunch: 'plan', snack: 'plan', dinner: 'plan' }),
      '[]', '[]', '[]', '{}'
    );
  }

  res.redirect('/settings?saved=1');
});

module.exports = router;
