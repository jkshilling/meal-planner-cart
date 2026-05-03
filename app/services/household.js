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

  // Claim the household + every owned-data table's orphaned rows. Any row
  // with user_id IS NULL was created in pre-auth state and now belongs
  // to whoever first claims it (subject to the gate above). Wrapped in a
  // transaction so claims happen atomically — partial claims would be
  // worse than none.
  const claim = db.transaction(() => {
    const profiles = db.prepare(
      'UPDATE household_profiles SET user_id = ? WHERE user_id IS NULL'
    ).run(userId).changes;
    db.prepare('UPDATE recipes             SET user_id = ? WHERE user_id IS NULL').run(userId);
    db.prepare('UPDATE weekly_plans        SET user_id = ? WHERE user_id IS NULL').run(userId);
    db.prepare('UPDATE grocery_searches    SET user_id = ? WHERE user_id IS NULL').run(userId);
    db.prepare('UPDATE ingredient_products SET user_id = ? WHERE user_id IS NULL').run(userId);

    // (Earlier versions also migrated walmart_products.is_favorite=1 rows
    // into user_favorites for the claiming user. The is_favorite column has
    // since been dropped — once the bootstrap claim ran on prod, the data
    // was already migrated. New databases never have the column.)

    // Migrate the old global grocery API token (app_settings.grocery_api_token)
    // into user_grocery_tokens for the claiming user, then retire the global
    // row so future signups can't inherit it. Only do this if the user
    // doesn't already have their own token.
    const globalToken = db.prepare(
      "SELECT value FROM app_settings WHERE key = 'grocery_api_token'"
    ).get();
    if (globalToken && globalToken.value) {
      const hasToken = db.prepare(
        'SELECT 1 FROM user_grocery_tokens WHERE user_id = ?'
      ).get(userId);
      if (!hasToken) {
        // Tokens are unique across users; if the global value happens to
        // collide with something already issued (vanishingly unlikely with
        // 16 random bytes), let the UNIQUE error propagate so we notice.
        db.prepare(
          'INSERT INTO user_grocery_tokens (user_id, token) VALUES (?, ?)'
        ).run(userId, globalToken.value);
      }
      db.prepare("DELETE FROM app_settings WHERE key = 'grocery_api_token'").run();
    }

    return profiles;
  });
  return claim();
}

function createHouseholdForUser(userId) {
  const info = db.prepare(
    'INSERT INTO household_profiles (name, user_id) VALUES (?, ?)'
  ).run('My Household', userId);
  // Seed a single adult member so the planner has something to work with.
  // meal_behavior_json defaults to "plan everything" via the schema default.
  db.prepare(
    'INSERT INTO household_members (profile_id, name, label) VALUES (?, ?, ?)'
  ).run(info.lastInsertRowid, 'Me', 'adult');
  return info.lastInsertRowid;
}

// Find the active household profile for a logged-in user. Returns null
// if the user has none yet (shouldn't happen post-signup, but defensive).
function profileForUser(userId) {
  return db.prepare(
    'SELECT * FROM household_profiles WHERE user_id = ? AND active = 1 ORDER BY id LIMIT 1'
  ).get(userId);
}

module.exports = {
  claimOrphanedHouseholds,
  createHouseholdForUser,
  profileForUser
};
