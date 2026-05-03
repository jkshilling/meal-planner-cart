// Per-user grocery-events API tokens. Each user that wants to ship data from
// the food-buyer Chrome extension gets their own bearer; rotating regenerates
// it in place. Storage: user_grocery_tokens (one row per user). The
// previously-global token in app_settings has been retired — the claim helper
// (services/household.claimOrphanedHouseholds) migrates a pre-auth global
// token to the first claiming user.
//
// Token shape: 32 hex chars (16 bytes), prefixed with "fbe_" so it's
// recognizable in logs and at-a-glance distinguishable from API keys for
// other systems.

const crypto = require('crypto');
const db = require('../db');

function generate() {
  return 'fbe_' + crypto.randomBytes(16).toString('hex');
}

function tokenForUser(userId) {
  const row = db.prepare('SELECT token FROM user_grocery_tokens WHERE user_id = ?').get(userId);
  return row ? row.token : null;
}

function ensureForUser(userId) {
  let t = tokenForUser(userId);
  if (t) return t;
  t = generate();
  db.prepare('INSERT INTO user_grocery_tokens (user_id, token) VALUES (?, ?)').run(userId, t);
  return t;
}

function rotateForUser(userId) {
  const t = generate();
  db.prepare(`
    INSERT INTO user_grocery_tokens (user_id, token, created_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, created_at = datetime('now')
  `).run(userId, t);
  return t;
}

// Reverse lookup: given a presented token, return the owning user_id or null.
// High-entropy random token means a simple existence check is fine — knowing
// "this token exists" leaks at most one bit and the search space is 2^128.
function userForToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT user_id FROM user_grocery_tokens WHERE token = ?').get(token);
  return row ? row.user_id : null;
}

// Express middleware: validates the Authorization bearer and attaches
// `req.tokenUser = { id }` so downstream handlers can scope inserts/queries
// to the owning user. 401 on any mismatch.
function requireTokenAndResolveUser(req, res, next) {
  const header = req.get('Authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/);
  if (!m) {
    return res.status(401).json({ ok: false, error: 'missing bearer token' });
  }
  const uid = userForToken(m[1].trim());
  if (!uid) {
    return res.status(401).json({ ok: false, error: 'invalid token' });
  }
  req.tokenUser = { id: uid };
  next();
}

module.exports = {
  tokenForUser,
  ensureForUser,
  rotateForUser,
  userForToken,
  requireTokenAndResolveUser
};
