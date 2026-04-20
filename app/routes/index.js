const express = require('express');
const db = require('../db');
const { loadProfile } = require('../services/planner');

const router = express.Router();

router.get('/', (req, res) => {
  const profile = db.prepare('SELECT * FROM household_profiles WHERE active = 1 ORDER BY id LIMIT 1').get();
  const fullProfile = loadProfile(profile.id);
  const recipeCount = db.prepare('SELECT COUNT(*) as c FROM recipes').get().c;
  const latestPlan = db.prepare('SELECT * FROM weekly_plans WHERE profile_id = ? ORDER BY id DESC LIMIT 1').get(profile.id);
  const latestRun = db.prepare('SELECT * FROM automation_runs ORDER BY id DESC LIMIT 1').get();
  res.render('dashboard', {
    title: 'Dashboard',
    profile: fullProfile,
    recipeCount,
    latestPlan,
    latestRun
  });
});

module.exports = router;
