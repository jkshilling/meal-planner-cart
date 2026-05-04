// Shared CORS middleware for endpoints that bearer-token-authed Chrome
// extensions call (food-buyer-extension, nyt-importer, …). Allows ANY
// chrome-extension:// origin — the extension's bearer token is what
// actually authorizes the request, so origin-pinning would only force
// us to maintain a manifest of allowed extension IDs without adding
// real security.
//
// Routes mounting this should also add the path to BEARER_EXEMPT in
// services/csrf.js (CSRF cookie isn't shippable across origins, and
// the bearer is the auth instead).

function extensionCors(req, res, next) {
  const origin = req.get('Origin') || '';
  if (origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

module.exports = { extensionCors };
