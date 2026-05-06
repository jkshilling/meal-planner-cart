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
const usda = require('./usda');

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

// Sync source_id-bearing recipes from the bootstrap owner's library into a
// target user's library. Used at signup so a new invitee inherits the
// owner's curated recipes, and also by the explicit "re-sync from master
// library" button on /settings.
//
// Owner-on-owner is a no-op: there's no master library separate from the
// owner's own DB rows. (Earlier this branch restored from a staged JSON
// file written by a Spoonacular pull cron — that pipeline has been
// retired.)
//
// What it never does:
//   - Touch hand-entered recipes (source_id NULL is invisible).
//   - Modify the user's existing copies — edits, customized ingredients,
//     custom calories all preserved. Dedup is by source_id.
//   - Reset favorites on existing recipes.
//   - Delete anything.
//
// Returns the number of recipes newly added.
function seedRecipesForUser(userId) {
  const ownerEmail = (process.env.BOOTSTRAP_OWNER_EMAIL || '').toLowerCase().trim();
  if (!ownerEmail) return 0;
  const owner = db.prepare('SELECT id FROM users WHERE email = ?').get(ownerEmail);
  if (!owner) return 0;
  if (owner.id === userId) return 0;  // owner = master library; nothing to copy from

  return copyFromOwnerLibrary(userId, owner.id);
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
    SELECT id, name, meal_type, cuisine, prep_time, servings,
           est_cost, notes, source_id
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

// Set of source_ids the user already owns. Used to dedupe at copy time.
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
//
// After the transaction commits, fires off USDA cache-warming for every
// distinct ingredient name across the inserted recipes. Fire-and-forget —
// returns immediately, the cache fills up over the next few seconds. This
// is what makes the recipe list show full nutrition coverage on first
// render after a cron import or signup-time seed; without it, all those
// recipes would render with the partial-coverage marker until something
// else (manual save, edit-form preview) forced individual lookups.
function insertRecipesAndIngredients(userId, rows, getIngredients) {
  const insertRecipe = db.prepare(`
    INSERT INTO recipes
      (name, meal_type, cuisine, prep_time, servings, est_cost,
       favorite, notes, user_id, source_id)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `);
  const insertIng = db.prepare(
    'INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit) VALUES (?, ?, ?, ?)'
  );
  const allIngsForWarm = [];
  const tx = db.transaction(() => {
    for (const r of rows) {
      const info = insertRecipe.run(
        r.name, r.meal_type, r.cuisine,
        r.prep_time, r.servings, r.est_cost,
        r.notes, userId, r.source_id
      );
      const ings = getIngredients(r) || [];
      for (const ing of ings) {
        // Canonicalize before write so cron-imported and seed-replicated
        // recipes land in recipe_ingredients with the same name USDA's
        // cache is keyed on. Fallback keeps the original if canonicalize
        // strips everything (defensive — shouldn't happen in practice).
        const canonName = usda.canonicalize(ing.name) || ing.name;
        insertIng.run(info.lastInsertRowid, canonName, ing.quantity, ing.unit);
        allIngsForWarm.push({ ...ing, name: canonName });
      }
    }
  });
  tx();
  // Fire-and-forget USDA warm so nutrition_lookups gets populated for any
  // new ingredient names. Recipe inserts don't wait on this; the cache
  // catches up async.
  if (allIngsForWarm.length) {
    usda.recipeNutrition(allIngsForWarm, 1).catch(() => {});
  }
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
  profileForUser,
  // Exported so one-shot scripts (data/pull-popular-sides.js etc.)
  // can use the canonical insert + cache-warm pipeline instead of
  // duplicating it inline.
  insertRecipesAndIngredients
};
