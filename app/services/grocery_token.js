// Grocery-events API token. Single shared bearer token (per-device tokens
// would be nicer for revocation, but this is one user's personal app — one
// token is enough). Stored in app_settings.
//
// Token shape: 32 hex chars (16 bytes), prefixed with "fbe_" so it's
// recognizable in logs and at-a-glance distinguishable from an API key for
// some other system.

const crypto = require('crypto');
const db = require('../db');

const KEY = 'grocery_api_token';

function generate() {
  return 'fbe_' + crypto.randomBytes(16).toString('hex');
}

function get() {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY);
  return row ? row.value : null;
}

function ensure() {
  let t = get();
  if (t) return t;
  t = generate();
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(KEY, t);
  return t;
}

function rotate() {
  const t = generate();
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(KEY, t);
  return t;
}

// Express middleware: 401 if Authorization header doesn't carry the right
// bearer. Use timingSafeEqual to keep the comparison constant-time.
function requireToken(req, res, next) {
  const expected = ensure();
  const header = req.get('Authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/);
  if (!m) {
    return res.status(401).json({ ok: false, error: 'missing bearer token' });
  }
  const presented = m[1].trim();
  // Length-mismatched buffers throw with timingSafeEqual; pad both to a
  // common length so wrong-length tokens don't leak length via error type.
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return res.status(401).json({ ok: false, error: 'invalid token' });
  }
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: 'invalid token' });
  }
  next();
}

module.exports = { ensure, get, rotate, requireToken };
