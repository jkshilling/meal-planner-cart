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
  meal_types_json TEXT NOT NULL DEFAULT '["breakfast","lunch","snack","dinner"]',
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
  archived INTEGER NOT NULL DEFAULT 0,
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
  note TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  score_json TEXT,
  FOREIGN KEY (plan_id) REFERENCES weekly_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE SET NULL
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
`;

db.exec(SCHEMA);

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
