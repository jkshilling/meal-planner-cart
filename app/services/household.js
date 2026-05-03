// Per-user household provisioning helpers used by the signup flow.
//
// Two paths on signup:
//   1. claimOrphanedHouseholds — for pre-auth data: a database that existed
//      before commit 1 has at least one household_profile with user_id IS NULL.
//      The first signup whose email matches BOOTSTRAP_OWNER_EMAIL (or any
//      signup if the env var is unset) claims those rows.
//   2. createHouseholdForUser — for fresh users with no existing data to
//      claim. Creates a blank household with a default "Me" member.

const db = require('../db');

function claimOrphanedHouseholds(userId, email) {
  // BOOTSTRAP_OWNER_EMAIL gate: in production, set this to the email that
  // owns the existing data so a stranger who happens to sign up first
  // doesn't end up owning your droplet's pre-auth household. Empty/unset
  // (e.g. on local dev) lets any first signup claim. Match is
  // case-insensitive.
  const ownerEmail = (process.env.BOOTSTRAP_OWNER_EMAIL || '').toLowerCase().trim();
  if (ownerEmail && email.toLowerCase().trim() !== ownerEmail) return 0;
  const result = db.prepare(
    'UPDATE household_profiles SET user_id = ? WHERE user_id IS NULL'
  ).run(userId);
  return result.changes;
}

function createHouseholdForUser(userId) {
  const info = db.prepare(
    'INSERT INTO household_profiles (name, user_id) VALUES (?, ?)'
  ).run('My Household', userId);
  // Seed a single adult member so the planner has something to work with.
  db.prepare(
    'INSERT INTO household_members (profile_id, name, label, lunch_behavior) VALUES (?, ?, ?, ?)'
  ).run(info.lastInsertRowid, 'Me', 'adult', 'plan');
  return info.lastInsertRowid;
}

// Find the active household profile for a logged-in user. Returns null
// if the user has none yet (shouldn't happen post-signup, but defensive).
function profileForUser(userId) {
  return db.prepare(
    'SELECT * FROM household_profiles WHERE user_id = ? AND active = 1 ORDER BY id LIMIT 1'
  ).get(userId);
}

module.exports = { claimOrphanedHouseholds, createHouseholdForUser, profileForUser };
