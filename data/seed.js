// Run: node data/seed.js
//
// Imports recipes from data/spoonacular-seed.json (built up nightly by
// data/fetch-seed.js) into the recipes table for the user identified by
// BOOTSTRAP_OWNER_EMAIL. Idempotent — re-runs skip recipes already imported
// (matched by source_id within the user's library), so it's safe to chain
// after every fetch.
//
// Behavior:
//   - JSON missing or empty → no-op + log
//   - User missing          → exit non-zero with a clear error
//   - JSON present          → insert any recipe whose source_id isn't
//                             already in the DB for this user
//
// Does NOT wipe existing recipes — the previous version of this script did,
// which is incompatible with the post-auth schema (would orphan the user's
// hand-entered recipes and fail on the dropped brand_preference column).

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require(path.join(__dirname, '..', 'app', 'db.js'));

const JSON_PATH = path.join(__dirname, 'spoonacular-seed.json');
const OWNER_EMAIL = (process.env.BOOTSTRAP_OWNER_EMAIL || '').toLowerCase().trim();

function ownerOrExit() {
  if (!OWNER_EMAIL) {
    console.error('BOOTSTRAP_OWNER_EMAIL is not set in .env — cannot determine');
    console.error('which user should own the imported recipes. Aborting.');
    process.exit(1);
  }
  const row = db.prepare('SELECT id, email FROM users WHERE email = ?').get(OWNER_EMAIL);
  if (!row) {
    console.error(`No user found with email ${OWNER_EMAIL}.`);
    console.error(`Sign up at /signup first; then re-run this script.`);
    process.exit(1);
  }
  return row;
}

function loadStaged() {
  if (!fs.existsSync(JSON_PATH)) {
    console.log(`No ${path.basename(JSON_PATH)} present — nothing to import.`);
    console.log(`Run: node data/fetch-seed.js --plan full`);
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    if (!Array.isArray(data)) throw new Error('seed JSON is not an array');
    return data;
  } catch (e) {
    console.error(`Failed to load ${JSON_PATH}: ${e.message}`);
    process.exit(1);
  }
}

function importStaged() {
  const owner = ownerOrExit();
  const recipes = loadStaged();
  if (recipes === null) return;
  if (!recipes.length) {
    console.log('Seed JSON is empty — nothing to import.');
    return;
  }

  // Dedupe against what's already in the user's library by source_id. Recipes
  // without a source_id (hand-entered ones) never collide with this set.
  const existing = new Set(
    db.prepare('SELECT source_id FROM recipes WHERE user_id = ? AND source_id IS NOT NULL')
      .all(owner.id)
      .map(r => String(r.source_id))
  );

  const insertRecipe = db.prepare(`
    INSERT INTO recipes
      (name, meal_type, cuisine, kid_friendly, prep_time, servings, est_cost,
       calories, protein, fiber, sugar, sodium, favorite, notes, user_id, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIng = db.prepare(`
    INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit) VALUES (?, ?, ?, ?)
  `);

  let imported = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const r of recipes) {
      const sid = r.source_id != null ? String(r.source_id) : null;
      if (sid && existing.has(sid)) { skipped++; continue; }
      const info = insertRecipe.run(
        r.name || 'Untitled',
        r.meal_type || 'dinner',
        r.cuisine || null,
        r.kid_friendly ? 1 : 0,
        r.prep_time || 30,
        r.servings || 4,
        typeof r.est_cost === 'number' ? r.est_cost : 10,
        r.calories ?? null,
        r.protein  ?? null,
        r.fiber    ?? null,
        r.sugar    ?? null,
        r.sodium   ?? null,
        r.favorite ? 1 : 0,
        r.notes || null,
        owner.id,
        sid
      );
      for (const ing of (r.ingredients || [])) {
        insertIng.run(
          info.lastInsertRowid,
          ing.name,
          typeof ing.quantity === 'number' && ing.quantity > 0 ? ing.quantity : 1,
          ing.unit || 'each'
        );
      }
      if (sid) existing.add(sid);
      imported++;
    }
  });
  tx();

  const total = db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE user_id = ?').get(owner.id).n;
  console.log(`Imported: ${imported}`);
  console.log(`Skipped (already in DB): ${skipped}`);
  console.log(`Total recipes for ${owner.email}: ${total}`);

  if (imported > 0) {
    const counts = {};
    for (const r of recipes) counts[r.meal_type] = (counts[r.meal_type] || 0) + 1;
    console.log('Distribution by meal_type (this batch):');
    for (const k of Object.keys(counts).sort()) {
      console.log(`  ${k.padEnd(10)} ${counts[k]}`);
    }
  }
}

importStaged();
