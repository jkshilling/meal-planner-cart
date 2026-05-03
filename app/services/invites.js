// Signup invite codes. Single-use bearer-style tokens minted by an existing
// user from their settings page. /signup requires presenting an unused code
// to create an account; the code is consumed atomically as part of signup.
//
// Code shape: 12 chars from a 32-char unambiguous alphabet (skips 0/O, 1/I/l).
// 32^12 = ~1.2e18, plenty of room. Stored verbatim — these are short-lived
// throwaway grants, not long-term secrets, so a hash isn't worth the trouble.

const crypto = require('crypto');
const db = require('../db');

// Skip 0 O 1 I l so handwritten/typed codes don't get misread.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 12;

function generate() {
  // Reject-sample on a 256-byte buffer to avoid modulo bias against an
  // alphabet that doesn't divide evenly into 256.
  const out = [];
  while (out.length < CODE_LEN) {
    const buf = crypto.randomBytes(CODE_LEN * 2);
    for (let i = 0; i < buf.length && out.length < CODE_LEN; i++) {
      const v = buf[i];
      if (v < 256 - (256 % ALPHABET.length)) {
        out.push(ALPHABET[v % ALPHABET.length]);
      }
    }
  }
  return out.join('');
}

function normalize(presented) {
  // Accept lowercase / mixed case / surrounding whitespace; strip ambiguous
  // chars that the alphabet excludes anyway, in case the user typed an "O"
  // where the real char was "0"-shaped (it isn't, but defensive).
  return String(presented || '').trim().toUpperCase();
}

function create({ createdByUserId, label }) {
  // Loop on UNIQUE collision (vanishing odds, but defensive).
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generate();
    try {
      const info = db.prepare(
        'INSERT INTO invite_codes (code, label, created_by_user_id) VALUES (?, ?, ?)'
      ).run(code, label || null, createdByUserId || null);
      return { id: info.lastInsertRowid, code };
    } catch (e) {
      if (!/UNIQUE/i.test(e.message)) throw e;
    }
  }
  throw new Error('could not generate unique invite code');
}

function listByCreator(userId) {
  return db.prepare(`
    SELECT id, code, label, created_at, used_at, used_by_user_id
      FROM invite_codes
     WHERE created_by_user_id = ?
  ORDER BY created_at DESC
  `).all(userId);
}

function revoke({ id, createdByUserId }) {
  // Only allow deletion of one's own unused codes. Used codes stay as audit
  // trail (who invited whom).
  const r = db.prepare(`
    DELETE FROM invite_codes
     WHERE id = ?
       AND created_by_user_id = ?
       AND used_at IS NULL
  `).run(id, createdByUserId);
  return r.changes;
}

// Atomic consume: marks the code used and returns the row, or null if the
// code is missing/already-used. Wrap in a transaction so two concurrent
// signups racing the same code can't both succeed.
function consume({ presented, userId }) {
  const code = normalize(presented);
  if (!code) return null;
  const tx = db.transaction(() => {
    const row = db.prepare(`
      SELECT id, code, label, created_by_user_id, used_at
        FROM invite_codes
       WHERE code = ?
    `).get(code);
    if (!row) return null;
    if (row.used_at) return null;
    db.prepare(`
      UPDATE invite_codes
         SET used_at = datetime('now'),
             used_by_user_id = ?
       WHERE id = ?
    `).run(userId, row.id);
    return row;
  });
  return tx();
}

module.exports = {
  create,
  listByCreator,
  revoke,
  consume,
  CODE_LEN
};
