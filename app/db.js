const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'app.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
-- Per-user authentication. Email is the login identity; password_hash is
-- bcrypt-hashed. Future: password resets via email, OAuth providers, etc.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS household_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Scoping: NULL means "orphaned, awaiting claim" — only happens for
  -- pre-auth profiles in databases that existed before commit 1. New
  -- signups always create a profile with a non-null user_id. Commit 5
  -- enforces NOT NULL once routes are fully gated.
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Household',
  budget_weekly REAL NOT NULL DEFAULT 150,
  optimization_mode TEXT NOT NULL DEFAULT 'lowest_cost',
  breakfast_simplicity INTEGER NOT NULL DEFAULT 1,
  max_prep_time INTEGER NOT NULL DEFAULT 45,
  -- Slot types the planner generates per day. Sides are NOT a slot type —
  -- they're paired into lunch/dinner slots via pair_sides_with_json below.
  meal_types_json TEXT NOT NULL DEFAULT '["breakfast","lunch","snack","dinner"]',
  -- Which meal slots get a paired side recipe attached. e.g. ["dinner"] or
  -- ["lunch","dinner"]. Empty array disables side pairing entirely.
  pair_sides_with_json TEXT NOT NULL DEFAULT '["dinner"]',
  -- (allergies, dietary constraints, disliked ingredients moved to
  -- household_members — see meal_behavior_json's neighbor columns. The
  -- old favorite_meals and preferred_cuisines fields were retired
  -- entirely; per-recipe favorite stars cover the same ground better.)
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS household_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'adult',
  -- Per-meal behavior. JSON map from meal_type → 'plan' | 'school' | 'skip'.
  -- 'school' and 'skip' both mean "don't plan this meal for this person";
  -- the distinction is cosmetic (different mental model for the user) but
  -- the planner treats them identically. dinersFor(profile, mealType) counts
  -- only members whose value for that meal_type is 'plan'.
  meal_behavior_json TEXT NOT NULL DEFAULT '{"breakfast":"plan","lunch":"plan","snack":"plan","dinner":"plan"}',
  -- Per-member hard-filter preferences. Aggregated across the diners for
  -- each slot in services/planner.recipePassesFiltersForSlot:
  --   allergies — union (recipe rejected if it contains any diner's allergen)
  --   dietary   — union (recipe must satisfy every diner's diet, e.g. one
  --               vegetarian diner forces the slot to be vegetarian)
  --   dislikes  — union (recipe rejected if it contains any diner's dislike)
  -- Each is a JSON array of lowercase strings.
  allergies_json TEXT NOT NULL DEFAULT '[]',
  dietary_constraints_json TEXT NOT NULL DEFAULT '[]',
  disliked_ingredients_json TEXT NOT NULL DEFAULT '[]',
  -- Packed-meal recipes. JSON map from meal_type → recipe_id (or null) for
  -- meals where this member's meal_behavior is 'school' (i.e. they take a
  -- packed meal — sandwich, leftovers, etc.). The planner does NOT generate
  -- a sit-down slot for these meals, but the shopping list builder adds
  -- 7 days × (1 / recipe.servings) of each ingredient so the packer has
  -- groceries on hand. Recipe IDs that no longer exist are skipped silently.
  -- Example: {"breakfast":null,"lunch":15,"snack":null,"dinner":null}
  packed_recipe_ids_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (profile_id) REFERENCES household_profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  meal_type TEXT NOT NULL,
  cuisine TEXT,
  prep_time INTEGER NOT NULL DEFAULT 20,
  servings INTEGER NOT NULL DEFAULT 2,
  est_cost REAL NOT NULL DEFAULT 8,
  -- (calories/protein/fiber/sugar/sodium were stored columns until they
  -- were derived. Now computed at render time from recipe_ingredients +
  -- nutrition_lookups via services/usda.nutritionFromCache. The dropped
  -- columns are removed by the migration block below for existing DBs.)
  favorite INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  -- External source ID (e.g. Spoonacular recipe ID, stringified). NULL for
  -- hand-entered recipes. data/seed.js + routes/recipes.js use this to
  -- skip re-importing recipes that already exist for a user.
  source_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'each',
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS weekly_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  total_cost REAL NOT NULL DEFAULT 0,
  total_prep INTEGER NOT NULL DEFAULT 0,
  health_score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  FOREIGN KEY (profile_id) REFERENCES household_profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS weekly_plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  day INTEGER NOT NULL,
  meal_type TEXT NOT NULL,
  recipe_id INTEGER,
  -- Optional side dish paired with the main on this slot (lunch/dinner only).
  -- Filled by the planner when profile.pair_sides_with_json includes meal_type.
  side_recipe_id INTEGER,
  side_score_json TEXT,
  note TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  score_json TEXT,
  FOREIGN KEY (plan_id) REFERENCES weekly_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL,
  FOREIGN KEY (side_recipe_id) REFERENCES recipes(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS shopping_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'each',
  notes TEXT,
  approved INTEGER NOT NULL DEFAULT 1,
  manual INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (plan_id) REFERENCES weekly_plans(id) ON DELETE CASCADE
);

-- (walmart_matches and automation_runs were retired when the Playwright
-- cart-automation path was removed — the food-buyer Chrome extension now
-- handles Walmart matching/cart adding entirely client-side. The tables are
-- dropped by the migration below if they exist on an older database.)

-- Persistent cache of Walmart products we've encountered, one row per
-- product URL. Grows over time as searches run. Nutrition fields are
-- nullable and populated lazily (not yet scraped from product pages).
CREATE TABLE IF NOT EXISTS walmart_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  walmart_item_id TEXT UNIQUE,
  product_url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  size_text TEXT,
  latest_price REAL,
  latest_price_at TEXT,
  image_url TEXT,
  calories INTEGER,
  protein REAL,
  fiber REAL,
  sugar REAL,
  sodium REAL,
  -- Coarse grocery-aisle category derived from the product name at ingest
  -- time. Used to group/filter the catalog. NULL for legacy rows; populated
  -- by routes/grocery_events.js classify().
  category TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_walmart_products_name ON walmart_products(name);

CREATE TABLE IF NOT EXISTS walmart_price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  price REAL NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES walmart_products(id) ON DELETE CASCADE
);

-- Learned ingredient → product mappings. user_confirmed=1 means the
-- user approved this product as a match for this ingredient.
-- Used to short-circuit matching for ingredients we've already figured out.
CREATE TABLE IF NOT EXISTS ingredient_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_name TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  user_confirmed INTEGER NOT NULL DEFAULT 0,
  uses_count INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (ingredient_name, product_id),
  FOREIGN KEY (product_id) REFERENCES walmart_products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ingredient_products_name ON ingredient_products(ingredient_name);

-- Cache of USDA FoodData Central lookups so we don't re-hit the API every
-- time we see "chicken breast" in an imported recipe. Per-100g values.
CREATE TABLE IF NOT EXISTS nutrition_lookups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_name TEXT NOT NULL UNIQUE,
  matched_description TEXT,
  data_type TEXT,
  fdc_id INTEGER,
  calories_per_100g REAL,
  protein_per_100g REAL,
  fiber_per_100g REAL,
  sugar_per_100g REAL,
  sodium_per_100g REAL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Source IDs (Spoonacular recipe IDs) that the owner has decided shouldn't
-- be in anyone's library. The "Exclude from master library" button on a
-- recipe row inserts here AND deletes the row. Re-sync paths (signup-time
-- seed and the explicit re-sync button) filter out these IDs so the recipe
-- never lands in any user's library again — including future signups.
-- Existing copies in OTHER users' libraries are not retroactively deleted.
CREATE TABLE IF NOT EXISTS excluded_recipe_sources (
  source_id TEXT PRIMARY KEY,
  reason TEXT,
  excluded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tiny key/value bag for app-wide settings. Used to be the home of the
-- grocery-events API token before it was made per-user (see
-- user_grocery_tokens below); keep around for any future global flags.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-user favorite products. Replaces the old global walmart_products.is_favorite
-- column (which is dropped by a migration below).
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id INTEGER NOT NULL,
  walmart_product_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, walmart_product_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (walmart_product_id) REFERENCES walmart_products(id) ON DELETE CASCADE
);

-- Per-user grocery-events API tokens. Replaces the single global token
-- previously stored in app_settings under key='grocery_api_token'.
-- Each user has at most one active token; rotating regenerates it in place.
CREATE TABLE IF NOT EXISTS user_grocery_tokens (
  user_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- One row per search event posted by the food-buyer Chrome extension.
-- Captures the query the user (or the meal planner) sent to a retailer
-- plus enough metadata to re-rank later or audit search-quality drift.
CREATE TABLE IF NOT EXISTS grocery_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  retailer TEXT NOT NULL,
  query TEXT NOT NULL,
  -- The shopping_items.id (from the meal planner) this query was for, if
  -- the extension knew it. Optional: extension sometimes searches for ad-hoc
  -- ingredient names that never lived in our shopping_items table.
  shopping_item_id INTEGER,
  -- The product the user (or the auto-ranker) actually picked. References
  -- walmart_products.id. NULL when the search returned no usable match.
  picked_product_id INTEGER,
  -- 'auto' = ranker chose, 'override' = user manually overrode in the popup,
  -- 'failed' = nothing picked.
  pick_source TEXT NOT NULL DEFAULT 'auto',
  result_count INTEGER NOT NULL DEFAULT 0,
  client_session_id TEXT,
  searched_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (picked_product_id) REFERENCES walmart_products(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_grocery_searches_query ON grocery_searches(query);
CREATE INDEX IF NOT EXISTS idx_grocery_searches_searched_at ON grocery_searches(searched_at);

-- Single-use signup invite codes. /signup rejects anyone who can't present
-- an unused code. Codes are minted by an authed user from their settings
-- page; their user_id goes into created_by_user_id so we can audit who
-- invited whom. used_at + used_by_user_id stamp on consumption.
CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  -- Free-text label so the inviter can remember who they meant the code for
  -- ("Alice", "team test"). Optional; just for display.
  label TEXT,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT,
  used_by_user_id INTEGER,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_unused ON invite_codes(code) WHERE used_at IS NULL;
`;

db.exec(SCHEMA);

// ---- Migrations for existing databases ----------------------------------
// CREATE TABLE IF NOT EXISTS doesn't add new columns to existing tables.
// Add them idempotently via PRAGMA table_info introspection.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
// Idempotent column drop. Requires SQLite >= 3.35 (Ubuntu 22.04 ships 3.37,
// 24.04 ships 3.45). Wrapped in try/catch so older SQLite versions just
// log and continue rather than crashing the app on startup.
function dropColumnIfExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.find(c => c.name === column)) {
    try {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    } catch (e) {
      console.warn(`drop column ${table}.${column} failed (SQLite too old?): ${e.message}`);
    }
  }
}
ensureColumn('weekly_plan_items', 'side_recipe_id', 'INTEGER REFERENCES recipes(id) ON DELETE SET NULL');
ensureColumn('weekly_plan_items', 'side_score_json', 'TEXT');
ensureColumn('household_profiles', 'pair_sides_with_json', `TEXT NOT NULL DEFAULT '["dinner"]'`);
// Per-unit price string from the search card ("$9.88/lb"). Stored verbatim;
// catalog UI displays as-is. Nullable because not every product card has it.
ensureColumn('walmart_products', 'unit_price', 'TEXT');
// Coarse grocery category, derived from product name at ingest time.
ensureColumn('walmart_products', 'category', 'TEXT');
// User scoping for households. NULL means "orphaned, claimable on first
// signup" — see services/household.claimOrphanedHouseholds().
ensureColumn('household_profiles', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
// Owned-data tables. user_id columns added retroactively to pre-auth
// databases. Application-layer guarantees they're set (every write goes
// through requireAuth → userIdOf); the column is left nullable to avoid
// a fragile table-recreation ALTER on prod.
ensureColumn('recipes',             'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
ensureColumn('weekly_plans',        'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
ensureColumn('grocery_searches',    'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
ensureColumn('ingredient_products', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');

// The brand column was added speculatively for an extension feature that
// never landed. Always null in practice. Dropped to clean up the schema.
dropColumnIfExists('walmart_products', 'brand');
// is_favorite was the pre-auth global favorite flag. Replaced by user_favorites
// (commit 4) and then truly retired once the bootstrap claim ran on prod.
dropColumnIfExists('walmart_products', 'is_favorite');
// brand_preference on recipe ingredients + shopping items: never set on any
// row of any deployed database. Speculative column from v1 design that no
// matcher actually consumed.
dropColumnIfExists('recipe_ingredients', 'brand_preference');
dropColumnIfExists('shopping_items', 'brand_preference');

// Tables retired with the Playwright cart-automation path (the food-buyer
// Chrome extension replaced server-side Playwright). Drop on existing
// databases; new ones never create them in the first place.
db.exec('DROP TABLE IF EXISTS walmart_matches');
db.exec('DROP TABLE IF EXISTS automation_runs');

// kid_friendly was a manual flag + +0.1 planner boost gated on
// hasKids(profile). Removed entirely — moms (and dads) just mark
// kid-acceptable recipes as Favorites, which already gets a +0.15 boost
// and is more honest about what "kid-friendly" really means: "this
// recipe is one we like." The column is dropped from the schema; new
// databases never have it.
dropColumnIfExists('recipes', 'kid_friendly');

// Nutrition columns are now derived (computed from recipe_ingredients +
// nutrition_lookups at render time via services/usda.nutritionFromCache).
// Drop the stored columns so unit-conversion or USDA-data fixes propagate
// automatically on the next render — no recipe re-save sweep required.
dropColumnIfExists('recipes', 'calories');
dropColumnIfExists('recipes', 'protein');
dropColumnIfExists('recipes', 'fiber');
dropColumnIfExists('recipes', 'sugar');
dropColumnIfExists('recipes', 'sodium');

// household_members.lunch_behavior → meal_behavior_json migration.
// The old single column gated lunch only ('plan' | 'school' | 'skip').
// The new JSON column generalizes that to all meal types so the same kid
// can have school breakfast, school lunch, planned snack, planned dinner.
// Backfill: for each existing member, lift lunch_behavior into the lunch
// slot of meal_behavior_json and default the other three meals to 'plan'.
ensureColumn(
  'household_members',
  'meal_behavior_json',
  `TEXT NOT NULL DEFAULT '{"breakfast":"plan","lunch":"plan","snack":"plan","dinner":"plan"}'`
);
{
  // Only run the backfill while the legacy column still exists; afterwards
  // the dropColumnIfExists below removes it and this block becomes a no-op.
  const cols = db.prepare('PRAGMA table_info(household_members)').all().map(c => c.name);
  if (cols.includes('lunch_behavior')) {
    db.prepare(`
      UPDATE household_members
         SET meal_behavior_json = json_object(
           'breakfast', 'plan',
           'lunch',     COALESCE(lunch_behavior, 'plan'),
           'snack',     'plan',
           'dinner',    'plan'
         )
       WHERE lunch_behavior IS NOT NULL
    `).run();
  }
}
dropColumnIfExists('household_members', 'lunch_behavior');

// Per-member preferences migration. The old household-level columns
// (allergies, dietary, dislikes) are being moved per-member so the planner
// can apply them only to slots where the affected member actually eats.
// Backfill strategy: every existing member of a profile inherits that
// profile's existing values verbatim — preserves current planner behavior
// (everyone treated as if they had the household's constraints) until the
// user splits them apart in the settings UI. After backfill the
// household-level columns are dropped, along with two retired soft-boost
// fields (favorite_meals_json + preferred_cuisines_json — keyword-favorites
// duplicate the per-recipe favorite star, and preferred-cuisines averaged
// across an unaverageable household was always a fiction).
ensureColumn('household_members', 'allergies_json',           `TEXT NOT NULL DEFAULT '[]'`);
ensureColumn('household_members', 'dietary_constraints_json', `TEXT NOT NULL DEFAULT '[]'`);
ensureColumn('household_members', 'disliked_ingredients_json',`TEXT NOT NULL DEFAULT '[]'`);
// Per-member packed-meal recipe assignments. Defaults to {} so existing
// members start with no packed meals (preserves current behavior — they'll
// only get packed groceries on the shopping list once they pick a recipe).
ensureColumn('household_members', 'packed_recipe_ids_json',   `TEXT NOT NULL DEFAULT '{}'`);

// Spoonacular (or other external) source ID, used by data/seed.js and the
// manual import route to dedupe on re-import. Stringified — Spoonacular IDs
// are integers but we don't want to assume that for future sources.
ensureColumn('recipes', 'source_id', 'TEXT');

// Audit column for the LLM-canonicalize fallback (services/llm_canonicalize).
// When services/usda.searchFood gets zero FDC candidates for an ingredient
// name, it asks the LLM for a USDA-friendlier rewrite and retries with that.
// This column records the rewrite the LLM proposed (NULL means the LLM was
// not consulted, either because the first lookup hit or because no
// OPENAI_API_KEY is configured). Useful for spot-checking the LLM's
// judgement on the settings-page coverage card.
ensureColumn('nutrition_lookups', 'llm_suggested_name', 'TEXT');

// Carbs and total fat per 100g — added when the recipe edit form's
// nutrition panel started showing 0 sugar for a grilled cheese (true:
// no sugar) but no carbs/fat to balance the calorie count. USDA returns
// both nutrients on every Foundation/SR Legacy entry; the schema just
// wasn't capturing them. Existing rows have NULL until re-warmed.
ensureColumn('nutrition_lookups', 'carbs_per_100g', 'REAL');
ensureColumn('nutrition_lookups', 'fat_per_100g',   'REAL');
// Partial index would be ideal here but SQLite UNIQUE-on-non-null is awkward
// to retrofit cleanly. Plain index gives us the lookup speed without the
// uniqueness guarantee — duplicate detection happens in app code which can
// scope to user_id anyway.
db.exec('CREATE INDEX IF NOT EXISTS idx_recipes_user_source ON recipes(user_id, source_id)');
{
  const profileCols = db.prepare('PRAGMA table_info(household_profiles)').all().map(c => c.name);
  // Only backfill while the legacy household-level columns still exist.
  if (
    profileCols.includes('allergies_json') ||
    profileCols.includes('dietary_constraints_json') ||
    profileCols.includes('disliked_ingredients_json')
  ) {
    // Pull each row explicitly so we can per-field guard against missing
    // columns on weirdly-half-migrated databases.
    const select = `
      SELECT id,
             ${profileCols.includes('allergies_json')           ? 'allergies_json'           : "'[]' AS allergies_json"},
             ${profileCols.includes('dietary_constraints_json') ? 'dietary_constraints_json' : "'[]' AS dietary_constraints_json"},
             ${profileCols.includes('disliked_ingredients_json')? 'disliked_ingredients_json': "'[]' AS disliked_ingredients_json"}
        FROM household_profiles
    `;
    const profiles = db.prepare(select).all();
    const update = db.prepare(`
      UPDATE household_members
         SET allergies_json            = COALESCE(NULLIF(allergies_json,            '[]'), ?),
             dietary_constraints_json  = COALESCE(NULLIF(dietary_constraints_json,  '[]'), ?),
             disliked_ingredients_json = COALESCE(NULLIF(disliked_ingredients_json, '[]'), ?)
       WHERE profile_id = ?
    `);
    const tx = db.transaction(() => {
      for (const p of profiles) {
        update.run(
          p.allergies_json           || '[]',
          p.dietary_constraints_json || '[]',
          p.disliked_ingredients_json|| '[]',
          p.id
        );
      }
    });
    tx();
  }
}
dropColumnIfExists('household_profiles', 'allergies_json');
dropColumnIfExists('household_profiles', 'dietary_constraints_json');
dropColumnIfExists('household_profiles', 'disliked_ingredients_json');
dropColumnIfExists('household_profiles', 'favorite_meals_json');
dropColumnIfExists('household_profiles', 'preferred_cuisines_json');

// One-time migration: profiles created before sides-as-slots was removed
// still have "side" inside meal_types_json. Strip it; pair_sides_with_json
// already defaulted to ["dinner"], which preserves the user's intent.
db.prepare(`
  UPDATE household_profiles
     SET meal_types_json = REPLACE(REPLACE(REPLACE(meal_types_json, '"side",', ''), ',"side"', ''), '"side"', '')
   WHERE meal_types_json LIKE '%"side"%'
`).run();

// Pre-auth ensureProfile() used to auto-create a household at boot. Removed
// now that requireAuth gates everything: profiles are created by
// services/household.createHouseholdForUser at signup time, and the bootstrap
// owner inherits any orphan profile via claimOrphanedHouseholds.

module.exports = db;
