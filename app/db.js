const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'app.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS household_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  brand TEXT,
  size_text TEXT,
  latest_price REAL,
  latest_price_at TEXT,
  image_url TEXT,
  calories INTEGER,
  protein REAL,
  fiber REAL,
  sugar REAL,
  sodium REAL,
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
ensureColumn('weekly_plan_items', 'side_recipe_id', 'INTEGER REFERENCES recipes(id) ON DELETE SET NULL');
ensureColumn('weekly_plan_items', 'side_score_json', 'TEXT');
ensureColumn('household_profiles', 'pair_sides_with_json', `TEXT NOT NULL DEFAULT '["dinner"]'`);

// One-time migration: profiles created before sides-as-slots was removed
// still have "side" inside meal_types_json. Strip it; pair_sides_with_json
// already defaulted to ["dinner"], which preserves the user's intent.
db.prepare(`
  UPDATE household_profiles
     SET meal_types_json = REPLACE(REPLACE(REPLACE(meal_types_json, '"side",', ''), ',"side"', ''), '"side"', '')
   WHERE meal_types_json LIKE '%"side"%'
`).run();

function ensureProfile() {
  const row = db.prepare('SELECT * FROM household_profiles WHERE active = 1 ORDER BY id LIMIT 1').get();
  if (row) return row;
  const info = db.prepare('INSERT INTO household_profiles (name) VALUES (?)').run('My Household');
  db.prepare('INSERT INTO household_members (profile_id, name, label, lunch_behavior) VALUES (?, ?, ?, ?)')
    .run(info.lastInsertRowid, 'Me', 'adult', 'plan');
  return db.prepare('SELECT * FROM household_profiles WHERE id = ?').get(info.lastInsertRowid);
}

ensureProfile();

module.exports = db;
