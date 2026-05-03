const express = require('express');
const db = require('../db');
const { loadProfile } = require('../services/planner');
const household = require('../services/household');
const { userIdOf } = require('../services/auth');

const router = express.Router();

router.get('/', (req, res) => {
  const profile = household.profileForRequest(req);
  if (!profile) return res.redirect('/login');
  const fullProfile = loadProfile(profile.id);
  const uid = userIdOf(req);

  // Counts and "latest" lookups are scoped to the logged-in user when there
  // is one. Pre-auth fallback returns the global counts.
  const recipeCount = uid
    ? db.prepare('SELECT COUNT(*) AS c FROM recipes WHERE user_id = ?').get(uid).c
    : db.prepare('SELECT COUNT(*) AS c FROM recipes').get().c;
  const latestPlan = uid
    ? db.prepare('SELECT * FROM weekly_plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(uid)
    : db.prepare('SELECT * FROM weekly_plans WHERE profile_id = ? ORDER BY id DESC LIMIT 1').get(profile.id);
  const latestRun = uid
    ? db.prepare('SELECT * FROM automation_runs WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(uid)
    : db.prepare('SELECT * FROM automation_runs ORDER BY id DESC LIMIT 1').get();

  res.render('dashboard', {
    title: 'Dashboard',
    profile: fullProfile,
    recipeCount,
    latestPlan,
    latestRun
  });
});

// Public, unauthenticated. Chrome Web Store reviewers and prospective
// users need to read the privacy policy before installing the extension,
// so this route can't sit behind login.
router.get('/privacy', (req, res) => {
  res.render('privacy', { title: 'Privacy Policy' });
});

module.exports = router;
