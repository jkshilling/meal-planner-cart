// CSRF protection. Each session gets a random token on first request; every
// form embeds it as a hidden _csrf field; every state-changing request must
// echo the value back. Tokens are stored in the session (not as a separate
// double-submit cookie) because all session writes already go through our
// SQLite store, so there's no cross-cookie-store sync concern.
//
// Exempt routes:
//   - GET/HEAD/OPTIONS (CSRF only matters for state changes)
//   - /api/grocery-events  (bearer-token authed; cross-origin, no session cookie)
//   - /api/grocery/favorites (same)
//
// Anything else under /api/* is treated as session-authed and must carry
// either a body._csrf field or an X-CSRF-Token header.

const crypto = require('crypto');

function generate() {
  return crypto.randomBytes(32).toString('hex');
}

// Idempotent: ensures the session has a CSRF token and exposes it on
// res.locals.csrfToken so EJS templates can render <input name="_csrf">.
function ensureToken(req, res, next) {
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = generate();
  }
  res.locals.csrfToken = (req.session && req.session.csrfToken) || '';
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Bearer-authed endpoints that the food-buyer Chrome extension uses. They
// don't carry session cookies (different origin) so traditional CSRF doesn't
// apply — the bearer token itself is the auth + intent proof.
const BEARER_EXEMPT = new Set([
  '/api/grocery-events',
  '/api/grocery/favorites',
  '/api/grocery/price-estimate',
  '/api/grocery/reset',
  '/api/recipes/import-nyt'
]);

function verify(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (BEARER_EXEMPT.has(req.path)) return next();

  const presented = (req.body && req.body._csrf) || req.get('X-CSRF-Token') || '';
  const expected = (req.session && req.session.csrfToken) || '';

  // Length-mismatched buffers throw with timingSafeEqual; bail out first.
  if (!expected || !presented || expected.length !== presented.length) {
    return res.status(403).render('error', {
      title: 'Forbidden',
      message: 'Invalid request token. Reload the page and try again.'
    });
  }
  if (!crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))) {
    return res.status(403).render('error', {
      title: 'Forbidden',
      message: 'Invalid request token. Reload the page and try again.'
    });
  }
  next();
}

module.exports = { ensureToken, verify, generate };
