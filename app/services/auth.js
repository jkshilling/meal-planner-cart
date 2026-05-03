// Per-user authentication helpers.
//
// hashPassword / verifyPassword wrap bcryptjs. We use the pure-JS port
// rather than native bcrypt so npm install on the droplet doesn't need
// build tools beyond what better-sqlite3 already requires.
//
// requireAuth is the route middleware that gates protected pages. Public
// routes (login, signup, logout, static, /api/grocery-events) skip it;
// everything else 302s to /login when there's no session user.

const bcrypt = require('bcryptjs');
const db = require('../db');

const BCRYPT_ROUNDS = 10;  // ~100ms on a modern laptop, fine for human-typed passwords
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return EMAIL_RE.test(email);
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LEN;
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

function findUserByEmail(email) {
  return db.prepare('SELECT id, email, password_hash, created_at FROM users WHERE email = ?').get(normalizeEmail(email));
}

function getUserById(id) {
  return db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(id);
}

async function createUser(email, password) {
  const normalizedEmail = normalizeEmail(email);
  const password_hash = await hashPassword(password);
  const info = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(normalizedEmail, password_hash);
  return { id: info.lastInsertRowid, email: normalizedEmail };
}

function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

// Read the logged-in user's id off the request, or null when not authed.
// Used by routes during the WIP migration so they can scope queries when
// a session exists and fall back to legacy "single household" behavior
// when one doesn't. Commit 5 makes this non-null mandatory via requireAuth.
function userIdOf(req) {
  return (req.session && req.session.user && req.session.user.id) || null;
}

// Route middleware. Use on every protected route. The /login redirect
// preserves the requested URL so a successful login bounces back to it.
function requireAuth(req, res, next) {
  if (req.session && req.session.user && req.session.user.id) return next();
  // Don't redirect API endpoints; return 401 instead.
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'authentication required' });
  }
  const next_ = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?next=${next_}`);
}

module.exports = {
  isValidEmail,
  isValidPassword,
  normalizeEmail,
  hashPassword,
  verifyPassword,
  findUserByEmail,
  getUserById,
  createUser,
  userCount,
  requireAuth,
  userIdOf,
  MIN_PASSWORD_LEN
};
