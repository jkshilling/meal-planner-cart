const express = require('express');
const db = require('../db');
const { loadProfile } = require('../services/planner');

const router = express.Router();

function activeProfile() {
  return db.prepare('SELECT * FROM household_profiles WHERE active = 1 ORDER BY id LIMIT 1').get();
}

router.get('/settings', (req, res) => {
  const p = activeProfile();
  const profile = loadProfile(p.id);
  res.render('settings', { title: 'Settings', profile, saved: req.query.saved === '1' });
});

router.post('/settings', (req, res) => {
  const p = activeProfile();
  const body = req.body;
  const toJSONList = (v) => {
    if (Array.isArray(v)) return JSON.stringify(v.filter(Boolean));
    if (typeof v === 'string') return JSON.stringify(v.split(',').map(s => s.trim()).filter(Boolean));
    return '[]';
  };
  const mealTypes = ['breakfast', 'lunch', 'snack', 'dinner', 'side'].filter(t => body['meal_' + t]);
  const budget = parseFloat(body.budget_weekly);
  const warnings = [];
  if (!isFinite(budget) || budget <= 0) warnings.push('Budget must be positive');
  const safeBudget = isFinite(budget) && budget > 0 ? budget : 150;

  db.prepare(`UPDATE household_profiles SET
    name = ?, budget_weekly = ?, optimization_mode = ?, breakfast_simplicity = ?, max_prep_time = ?,
    meal_types_json = ?, dietary_constraints_json = ?, allergies_json = ?, disliked_ingredients_json = ?,
    favorite_meals_json = ?, preferred_cuisines_json = ?
    WHERE id = ?`)
    .run(
      body.name || 'Household',
      safeBudget,
      body.optimization_mode || 'lowest_cost',
      body.breakfast_simplicity ? 1 : 0,
      parseInt(body.max_prep_time, 10) || 45,
      JSON.stringify(mealTypes.length ? mealTypes : ['dinner']),
      toJSONList(body.dietary_constraints),
      toJSONList(body.allergies),
      toJSONList(body.disliked_ingredients),
      toJSONList(body.favorite_meals),
      toJSONList(body.preferred_cuisines),
      p.id
    );

  // Members: replace with submitted set
  db.prepare('DELETE FROM household_members WHERE profile_id = ?').run(p.id);
  const names = [].concat(body.member_name || []);
  const labels = [].concat(body.member_label || []);
  const lunches = [].concat(body.member_lunch || []);
  const insertMember = db.prepare('INSERT INTO household_members (profile_id, name, label, lunch_behavior) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < names.length; i++) {
    const name = (names[i] || '').trim();
    if (!name) continue;
    insertMember.run(p.id, name, labels[i] || 'adult', lunches[i] || 'plan');
  }
  if (!names.filter(n => n && n.trim()).length) {
    insertMember.run(p.id, 'Me', 'adult', 'plan');
  }

  res.redirect('/settings?saved=1');
});

module.exports = router;
