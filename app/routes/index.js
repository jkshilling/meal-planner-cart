const express = require('express');
const db = require('../db');
const { loadProfile } = require('../services/planner');
const household = require('../services/household');
const { requireAuth, userIdOf } = require('../services/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
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
