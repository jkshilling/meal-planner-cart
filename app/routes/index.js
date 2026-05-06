const express = require('express');
const db = require('../db');
const { loadProfile } = require('../services/planner');
const household = require('../services/household');
const { requireAuth, userIdOf } = require('../services/auth');

const router = express.Router();

// `/` serves two distinct things based on auth state:
//   - logged out: a public landing page describing what the app does
//     and prompting sign-in. Routes that require auth all redirect to
//     /login already, so the landing exists primarily to give the URL
//     a destination that isn't a login form.
//   - logged in: the dashboard with profile + recipe count + latest plan.
// Not gated by requireAuth so the public branch can render.
router.get('/', (req, res) => {
  const isLoggedIn = req.session && req.session.user && req.session.user.id;
  if (!isLoggedIn) {
    return res.render('landing', { title: 'Meal Planner' });
  }

  const profile = household.profileForUser(userIdOf(req));
  if (!profile) {
    // Should never happen — signup creates a profile. If it does, the user's
    // data is broken and they need to start over.
    return res.status(500).render('error', {
      title: 'No household',
      message: 'No household found for your account. Contact support.'
    });
  }
  const fullProfile = loadProfile(profile.id);
  const uid = userIdOf(req);

  const recipeCount = db.prepare('SELECT COUNT(*) AS c FROM recipes WHERE user_id = ?').get(uid).c;
  const latestPlan = db.prepare('SELECT * FROM weekly_plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(uid);

  res.render('dashboard', {
    title: 'Dashboard',
    profile: fullProfile,
    recipeCount,
    latestPlan
  });
});

// Public, unauthenticated. Chrome Web Store reviewers and prospective
// users need to read the privacy policy before installing the extension,
// so this route can't sit behind login.
router.get('/privacy', (req, res) => {
  res.render('privacy', { title: 'Privacy Policy' });
});

module.exports = router;
