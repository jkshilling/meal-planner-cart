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
  dietary_constraints_json TEXT NOT NULL DEFAULT '[]',
  allergies_json TEXT NOT NULL DEFAULT '[]',
  disliked_ingredients_json TEXT NOT NULL DEFAULT '[]',
  favorite_meals_json TEXT NOT NULL DEFAULT '[]',
  preferred_cuisines_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS household_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'adult',
  lunch_behavior TEXT NOT NULL DEFAULT 'plan',
  FOREIGN KEY (profile_id) REFERENCES household_profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  meal_type TEXT NOT NULL,
  cuisine TEXT,
  kid_friendly INTEGER NOT NULL DEFAULT 0,
  prep_time INTEGER NOT NULL DEFAULT 20,
  servings INTEGER NOT NULL DEFAULT 2,
  est_cost REAL NOT NULL DEFAULT 8,
  calories INTEGER,
  protein REAL,
  fiber REAL,
  sugar REAL,
  sodium REAL,
  favorite INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'each',
  brand_preference TEXT,
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
  brand_preference TEXT,
  notes TEXT,
  approved INTEGER NOT NULL DEFAULT 1,
  manual INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (plan_id) REFERENCES weekly_plans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS walmart_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopping_item_id INTEGER NOT NULL,
  product_name TEXT,
  product_url TEXT,
  product_price REAL,
  product_size TEXT,
  confidence TEXT NOT NULL DEFAULT 'low',
  approved INTEGER NOT NULL DEFAULT 0,
  candidates_json TEXT,
  FOREIGN KEY (shopping_item_id) REFERENCES shopping_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  log_json TEXT,
  FOREIGN KEY (plan_id) REFERENCES weekly_plans(id) ON DELETE CASCADE
);

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
  -- DEPRECATED. Was the global "favorite" flag before favorites became
  -- per-user (see user_favorites). Kept on the schema for legacy data
  -- migrated by claimOrphanedHouseholds. Not written to anywhere; routes
  -- read user_favorites instead. Will be dropped in a future migration
  -- once all known installs have run the claim.
  is_favorite INTEGER NOT NULL DEFAULT 0,
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
// DEPRECATED: see CREATE TABLE comment. Kept for legacy migration only.
ensureColumn('walmart_products', 'is_favorite', 'INTEGER NOT NULL DEFAULT 0');
// Coarse grocery category, derived from product name at ingest time.
ensureColumn('walmart_products', 'category', 'TEXT');
// User scoping for households. NULL means "orphaned, claimable on first
// signup" — see services/household.claimOrphanedHouseholds().
ensureColumn('household_profiles', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
// Owned-data tables. Same NULL-means-orphaned semantics; commit 5 will
// flip these to NOT NULL once routes are gated.
ensureColumn('recipes',             'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
ensureColumn('weekly_plans',        'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
ensureColumn('grocery_searches',    'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
ensureColumn('ingredient_products', 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
ensureColumn('automation_runs',     'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
// The brand column was added speculatively for an extension feature that
// never landed. Always null in practice. Dropped to clean up the schema.
dropColumnIfExists('walmart_products', 'brand');

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
