// Per-user household provisioning helpers used by the signup flow.
//
// Two paths on signup:
//   1. claimOrphanedHouseholds — for pre-auth data: a database that existed
//      before commit 1 has at least one household_profile with user_id IS NULL.
//      The first signup whose email matches BOOTSTRAP_OWNER_EMAIL (or any
//      signup if the env var is unset) claims those rows.
//   2. createHouseholdForUser — for fresh users with no existing data to
//      claim. Creates a blank household with a default "Me" member.

const fs = require('fs');
const path = require('path');
const db = require('../db');

const SPOONACULAR_SEED_PATH = path.join(__dirname, '..', '..', 'data', 'spoonacular-seed.json');

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

// Sync Spoonacular-sourced recipes (those with source_id set) into a target
// user's library. Used both for the initial seed at signup AND the explicit
// "re-sync from master library" button on settings — same code path,
// idempotent.
//
// Dispatches based on whether the target user is the bootstrap owner:
//   - Non-owner → deep-copy any source_id-bearing recipes from the owner's
//     library that the user doesn't already have. (The owner's library IS
//     the master library for everyone else.)
//   - Owner → restore from data/spoonacular-seed.json. The owner's own
//     library can't be its own source of truth (deleted recipes are gone),
//     but the JSON file is an append-only audit log of every recipe the
//     nightly cron has ever pulled. So the owner's "master library" is
//     effectively the JSON, and re-sync brings back anything they deleted.
//
// What it never does:
//   - Touch hand-entered recipes (source_id NULL is invisible to every
//     query/JSON entry this code uses).
//   - Modify the user's existing copies of recipes — edits, customized
//     ingredients, custom calories all preserved. Dedup is by source_id
//     so we never overwrite anything.
//   - Reset favorites on existing recipes. (Newly-inserted copies do start
//     with favorite=0; favorites are personal taste, not inherited.)
//   - Delete anything.
//
// Returns the number of recipes newly added in this sync. No-ops (returns 0)
// when:
//   - BOOTSTRAP_OWNER_EMAIL is unset
//   - the owner doesn't exist yet
//   - non-owner case: owner has no source_id-bearing recipes the user lacks
//   - owner case: spoonacular-seed.json is missing/empty, OR the owner
//     already has every source_id in the JSON
function seedRecipesForUser(userId) {
  const ownerEmail = (process.env.BOOTSTRAP_OWNER_EMAIL || '').toLowerCase().trim();
  if (!ownerEmail) return 0;
  const owner = db.prepare('SELECT id FROM users WHERE email = ?').get(ownerEmail);
  if (!owner) return 0;

  return owner.id === userId
    ? importFromStagedJson(userId)
    : copyFromOwnerLibrary(userId, owner.id);
}

// Copy any of source_user's source_id-bearing recipes into target_user that
// target_user doesn't already have. Deep copy: row + recipe_ingredients,
// favorite reset to 0 on the new row. Excluded source_ids (the owner's
// "exclude from master library" list) are filtered out so they never
// propagate to new signups or re-syncs.
function copyFromOwnerLibrary(targetUserId, sourceUserId) {
  const have = userSourceIds(targetUserId);
  const excluded = excludedSourceIds();
  const sources = db.prepare(`
    SELECT id, name, meal_type, cuisine, kid_friendly, prep_time, servings,
           est_cost, calories, protein, fiber, sugar, sodium, notes, source_id
      FROM recipes
     WHERE user_id = ? AND source_id IS NOT NULL
  `).all(sourceUserId).filter(r => {
    const sid = String(r.source_id);
    return !have.has(sid) && !excluded.has(sid);
  });
  if (!sources.length) return 0;

  const selectIngs = db.prepare(
    'SELECT name, quantity, unit FROM recipe_ingredients WHERE recipe_id = ?'
  );
  return insertRecipesAndIngredients(targetUserId, sources, (r) => selectIngs.all(r.id));
}

// Read data/spoonacular-seed.json (an append-only cache of every recipe the
// nightly Spoonacular cron has pulled) and insert any source_ids the target
// user is missing. The JSON IS the master library when the owner re-syncs
// against themselves — the owner's currently-deleted recipes are still in
// there. Format matches what fetch-seed.js writes; same shape data/seed.js
// expects.
function importFromStagedJson(targetUserId) {
  if (!fs.existsSync(SPOONACULAR_SEED_PATH)) return 0;
  let staged;
  try {
    staged = JSON.parse(fs.readFileSync(SPOONACULAR_SEED_PATH, 'utf8'));
  } catch (e) {
    return 0;
  }
  if (!Array.isArray(staged) || !staged.length) return 0;

  const have = userSourceIds(targetUserId);
  const excluded = excludedSourceIds();
  const missing = staged.filter(r => {
    if (r.source_id == null) return false;
    const sid = String(r.source_id);
    return !have.has(sid) && !excluded.has(sid);
  });
  if (!missing.length) return 0;

  // Map the JSON shape onto our column shape. Defaults match data/seed.js.
  const recipeRows = missing.map(r => ({
    name: r.name || 'Untitled',
    meal_type: r.meal_type || 'dinner',
    cuisine: r.cuisine || null,
    kid_friendly: r.kid_friendly ? 1 : 0,
    prep_time: r.prep_time || 30,
    servings: r.servings || 4,
    est_cost: typeof r.est_cost === 'number' ? r.est_cost : 10,
    calories: r.calories ?? null,
    protein:  r.protein  ?? null,
    fiber:    r.fiber    ?? null,
    sugar:    r.sugar    ?? null,
    sodium:   r.sodium   ?? null,
    notes:    r.notes || null,
    source_id: String(r.source_id),
    _ings: (r.ingredients || []).map(ing => ({
      name: ing.name,
      quantity: typeof ing.quantity === 'number' && ing.quantity > 0 ? ing.quantity : 1,
      unit: ing.unit || 'each'
    }))
  }));

  return insertRecipesAndIngredients(targetUserId, recipeRows, (r) => r._ings);
}

// Set of source_ids the user already owns. Used to dedupe both code paths.
function userSourceIds(userId) {
  return new Set(
    db.prepare(
      'SELECT source_id FROM recipes WHERE user_id = ? AND source_id IS NOT NULL'
    ).all(userId).map(r => String(r.source_id))
  );
}

// Set of source_ids the owner has marked "do not propagate." Resync paths
// filter against this so excluded recipes never re-appear in the owner's
// library or in any new user's seeded library. Existing copies in other
// users' libraries are NOT retroactively removed.
function excludedSourceIds() {
  return new Set(
    db.prepare('SELECT source_id FROM excluded_recipe_sources').all().map(r => String(r.source_id))
  );
}

// Mark a source_id as excluded from the master library so re-sync (and
// future signups) skip it. Idempotent — re-excluding the same source_id
// updates `reason` if provided. Optional reason for audit/debugging
// (shown on the settings page when we eventually surface the list).
function excludeFromMasterLibrary(sourceId, reason) {
  if (!sourceId) return;
  db.prepare(`
    INSERT INTO excluded_recipe_sources (source_id, reason)
    VALUES (?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      reason = COALESCE(excluded.reason, excluded_recipe_sources.reason),
      excluded_at = datetime('now')
  `).run(String(sourceId), reason || null);
}

// Shared insert pipeline. `rows` is an array of objects with the recipe
// columns plus whatever the `getIngredients` callback expects to consume.
// Wrapped in a transaction so a partial failure doesn't half-insert.
function insertRecipesAndIngredients(userId, rows, getIngredients) {
  const insertRecipe = db.prepare(`
    INSERT INTO recipes
      (name, meal_type, cuisine, kid_friendly, prep_time, servings, est_cost,
       calories, protein, fiber, sugar, sodium, favorite, notes, user_id, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
  const insertIng = db.prepare(
    'INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit) VALUES (?, ?, ?, ?)'
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      const info = insertRecipe.run(
        r.name, r.meal_type, r.cuisine, r.kid_friendly,
        r.prep_time, r.servings, r.est_cost,
        r.calories, r.protein, r.fiber, r.sugar, r.sodium,
        r.notes, userId, r.source_id
      );
      const ings = getIngredients(r) || [];
      for (const ing of ings) {
        insertIng.run(info.lastInsertRowid, ing.name, ing.quantity, ing.unit);
      }
    }
  });
  tx();
  return rows.length;
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
  seedRecipesForUser,
  excludeFromMasterLibrary,
  profileForUser
};
