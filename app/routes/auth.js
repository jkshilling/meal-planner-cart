// Login / signup / logout. All three are public — they're the entry points
// before a session exists, so they're explicitly NOT guarded by requireAuth.
//
// Flash messages live in req.session.flash and are read+cleared by the
// middleware in server.js.

const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../services/auth');
const household = require('../services/household');

const router = express.Router();

// Brute-force protection on credential endpoints.
//
// /login: 10 attempts per IP per 15 min. Successful logins don't count, so a
// fumbling user with a typo gets retries without burning the budget. bcrypt
// already imposes ~100ms per verification — this caps a parallel attacker
// who pipelines requests across many connections.
//
// /signup: tighter, since each successful POST creates a row in users.
// 5 accounts per IP per hour. Same store, separate window/limit.
//
// trust proxy is set in server.js so req.ip is the real client IP behind
// nginx (rather than 127.0.0.1, which would lump every user under one bucket).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res /*, next, options */) => {
    res.status(429).render('login', {
      title: 'Sign in',
      email: (req.body && req.body.email) || '',
      next: (req.body && req.body.next) || (req.query && req.query.next) || '',
      flash: { type: 'warn', message: 'Too many login attempts. Wait a few minutes and try again.' }
    });
  }
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res /*, next, options */) => {
    res.status(429).render('signup', {
      title: 'Create account',
      email: (req.body && req.body.email) || '',
      flash: { type: 'warn', message: 'Too many signup attempts from this address. Try again in an hour.' }
    });
  }
});

// Two flavors:
//   flashError + redirect: writes to session, surfaces on the next request.
//   inlineError + render:  writes to res.locals so the same render shows it.
// Use inline when we re-render the form ourselves; flash for redirects.
function flashError(req, message) {
  req.session.flash = { type: 'warn', message };
}
function flashSuccess(req, message) {
  req.session.flash = { type: 'success', message };
}
function inlineError(res, message) {
  res.locals.flash = { type: 'warn', message };
}

// Resolve the post-login redirect target, falling back to /. We accept
// only same-origin paths to avoid open-redirect attacks.
function safeNext(raw) {
  if (!raw) return '/';
  const s = String(raw);
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  return '/';
}

router.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect(safeNext(req.query.next));
  res.render('login', { title: 'Sign in', email: '', next: req.query.next || '' });
});

router.post('/login', loginLimiter, async (req, res) => {
  const email = (req.body.email || '').toString();
  const password = (req.body.password || '').toString();
  const next_ = safeNext(req.body.next || req.query.next);

  if (!auth.isValidEmail(email) || !password) {
    inlineError(res, 'Enter a valid email and password.');
    return res.render('login', { title: 'Sign in', email, next: req.body.next || '' });
  }
  const user = auth.findUserByEmail(email);
  if (!user) {
    inlineError(res, 'Invalid email or password.');
    return res.render('login', { title: 'Sign in', email, next: req.body.next || '' });
  }
  const ok = await auth.verifyPassword(password, user.password_hash);
  if (!ok) {
    inlineError(res, 'Invalid email or password.');
    return res.render('login', { title: 'Sign in', email, next: req.body.next || '' });
  }

  // Regenerate session ID on login to defend against session-fixation.
  req.session.regenerate((err) => {
    if (err) {
      flashError(req, 'Login failed. Try again.');
      return res.redirect('/login');
    }
    req.session.user = { id: user.id, email: user.email };
    req.session.save(() => res.redirect(next_));
  });
});

router.get('/signup', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  res.render('signup', { title: 'Create account', email: '' });
});

router.post('/signup', signupLimiter, async (req, res) => {
  const email = (req.body.email || '').toString();
  const password = (req.body.password || '').toString();
  const confirm = (req.body.confirm || '').toString();

  if (!auth.isValidEmail(email)) {
    inlineError(res, 'Enter a valid email address.');
    return res.render('signup', { title: 'Create account', email });
  }
  if (!auth.isValidPassword(password)) {
    inlineError(res, `Password must be at least ${auth.MIN_PASSWORD_LEN} characters.`);
    return res.render('signup', { title: 'Create account', email });
  }
  if (password !== confirm) {
    inlineError(res, 'Passwords do not match.');
    return res.render('signup', { title: 'Create account', email });
  }
  if (auth.findUserByEmail(email)) {
    inlineError(res, 'That email is already registered. Try signing in.');
    return res.render('signup', { title: 'Create account', email });
  }

  let user;
  try {
    user = await auth.createUser(email, password);
  } catch (e) {
    inlineError(res, 'Could not create account: ' + e.message);
    return res.render('signup', { title: 'Create account', email });
  }

  // Provision a household for the new user. If the database has orphaned
  // pre-auth data and this user's email matches BOOTSTRAP_OWNER_EMAIL (or
  // the env var is unset), claim it. Otherwise create a fresh household.
  const claimed = household.claimOrphanedHouseholds(user.id, user.email);
  if (claimed === 0) {
    household.createHouseholdForUser(user.id);
  }

  req.session.regenerate((err) => {
    if (err) {
      flashError(req, 'Account created, but auto-login failed. Please sign in.');
      return res.redirect('/login');
    }
    req.session.user = { id: user.id, email: user.email };
    flashSuccess(req, 'Account created. Welcome.');
    req.session.save(() => res.redirect('/'));
  });
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.redirect('/login');
  req.session.destroy(() => {
    // Match the cookie name configured in server.js — clearing the wrong name
    // would leave a stale session cookie in the browser.
    res.clearCookie('mp.sid');
    res.redirect('/login');
  });
});

module.exports = router;
