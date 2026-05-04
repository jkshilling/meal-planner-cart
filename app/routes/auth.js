// Login / signup / logout. All three are public — they're the entry points
// before a session exists, so they're explicitly NOT guarded by requireAuth.
//
// Flash messages live in req.session.flash and are read+cleared by the
// middleware in server.js.

const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../services/auth');
const household = require('../services/household');
const invites = require('../services/invites');

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
  // skipSuccessfulRequests defaults to "status code < 400". Our failed-login
  // path returns 200 (re-renders the form with an inline error), which would
  // be counted as success and never decrement the budget. Successful login
  // returns 302 (redirect to ?next or /). Match on that explicitly.
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode === 302,
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
  // ?invite=CODE pre-fills the invite field so the inviter can share a deep
  // link instead of asking the recipient to copy a code by hand.
  const invite = (req.query.invite || '').toString().toUpperCase().slice(0, invites.CODE_LEN);
  res.render('signup', { title: 'Create account', email: '', invite });
});

router.post('/signup', signupLimiter, async (req, res) => {
  const email = (req.body.email || '').toString();
  const password = (req.body.password || '').toString();
  const confirm = (req.body.confirm || '').toString();
  const invite = (req.body.invite || '').toString();

  // Helper that re-renders the signup form with the same invite + email so
  // the user doesn't have to retype either after a validation error.
  const reshow = (msg) => {
    inlineError(res, msg);
    return res.render('signup', { title: 'Create account', email, invite });
  };

  if (!invite.trim()) return reshow('An invite code is required.');
  if (!auth.isValidEmail(email)) return reshow('Enter a valid email address.');
  if (!auth.isValidPassword(password)) {
    return reshow(`Password must be at least ${auth.MIN_PASSWORD_LEN} characters.`);
  }
  if (password !== confirm) return reshow('Passwords do not match.');
  if (auth.findUserByEmail(email)) {
    return reshow('That email is already registered. Try signing in.');
  }

  // Create the user FIRST, then atomically consume the invite. If the
  // invite turns out to be invalid we delete the user. We do it in this
  // order rather than the reverse because consume() needs the new user_id
  // to attribute the consumption (used_by_user_id).
  let user;
  try {
    user = await auth.createUser(email, password);
  } catch (e) {
    return reshow('Could not create account: ' + e.message);
  }

  const consumed = invites.consume({ presented: invite, userId: user.id });
  if (!consumed) {
    // Roll back the user creation and ask for a fresh code.
    require('../db').prepare('DELETE FROM users WHERE id = ?').run(user.id);
    return reshow('That invite code is invalid or has already been used.');
  }

  // Provision a household for the new user. If the database has orphaned
  // pre-auth data and this user's email matches BOOTSTRAP_OWNER_EMAIL (or
  // the env var is unset), claim it. Otherwise create a fresh household
  // and seed their recipe library by deep-copying every Spoonacular recipe
  // already in the bootstrap owner's library. Each user owns their own
  // copies after this — edits, favorites, deletes are isolated. The
  // bootstrap owner falls into the claim branch and isn't seeded from
  // themselves.
  const claimed = household.claimOrphanedHouseholds(user.id, user.email);
  if (claimed === 0) {
    household.createHouseholdForUser(user.id);
    household.seedRecipesForUser(user.id);
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
