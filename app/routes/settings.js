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
  res.render('settings', {
    title: 'Settings',
    profile,
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
    meal_types_json = ?, pair_sides_with_json = ?, dietary_constraints_json = ?, allergies_json = ?,
    disliked_ingredients_json = ?, favorite_meals_json = ?, preferred_cuisines_json = ?
    WHERE id = ? AND user_id = ?`)
    .run(
      body.name || 'Household',
      safeBudget,
      body.optimization_mode || 'lowest_cost',
      body.breakfast_simplicity ? 1 : 0,
      parseInt(body.max_prep_time, 10) || 45,
      JSON.stringify(mealTypes.length ? mealTypes : ['dinner']),
      JSON.stringify(pairSidesWith),
      toJSONList(body.dietary_constraints),
      toJSONList(body.allergies),
      toJSONList(body.disliked_ingredients),
      toJSONList(body.favorite_meals),
      toJSONList(body.preferred_cuisines),
      p.id,
      uid
    );

  // Members: replace with submitted set. Form gives us four parallel arrays
  // for per-meal behavior (member_breakfast, member_lunch, member_snack,
  // member_dinner), each one entry per row in the table. We collapse them
  // into a single meal_behavior_json per member.
  db.prepare('DELETE FROM household_members WHERE profile_id = ?').run(p.id);
  const names = [].concat(body.member_name || []);
  const labels = [].concat(body.member_label || []);
  const breakfasts = [].concat(body.member_breakfast || []);
  const lunches    = [].concat(body.member_lunch     || []);
  const snacks     = [].concat(body.member_snack     || []);
  const dinners    = [].concat(body.member_dinner    || []);
  const insertMember = db.prepare(
    'INSERT INTO household_members (profile_id, name, label, meal_behavior_json) VALUES (?, ?, ?, ?)'
  );
  const sanitize = (v) => (['plan', 'school', 'skip'].includes(v) ? v : 'plan');
  const mealBehaviorAt = (i) => JSON.stringify({
    breakfast: sanitize(breakfasts[i]),
    lunch:     sanitize(lunches[i]),
    snack:     sanitize(snacks[i]),
    dinner:    sanitize(dinners[i])
  });
  for (let i = 0; i < names.length; i++) {
    const name = (names[i] || '').trim();
    if (!name) continue;
    insertMember.run(p.id, name, labels[i] || 'adult', mealBehaviorAt(i));
  }
  if (!names.filter(n => n && n.trim()).length) {
    insertMember.run(
      p.id, 'Me', 'adult',
      JSON.stringify({ breakfast: 'plan', lunch: 'plan', snack: 'plan', dinner: 'plan' })
    );
  }

  res.redirect('/settings?saved=1');
});

module.exports = router;
