// Run: node data/seed.js
//
// Wipes the recipe tables, then loads recipes from data/spoonacular-seed.json
// if that file exists. The JSON is built up over time by data/fetch-seed.js,
// which pulls from Spoonacular and writes one row per recipe.
//
// Behavior:
//   - JSON present  → wipe + insert from JSON (this is the normal flow)
//   - JSON missing  → wipe + report "nothing to seed" (don't auto-insert
//                     legacy hand-curated content; that path is intentionally
//                     gone now)
//
// Safe to re-run anytime. Wiping cascades: deleting a recipe removes its
// recipe_ingredients (FK ON DELETE CASCADE). Past plan items keep their
// rows but their recipe_id becomes NULL (FK ON DELETE SET NULL).

const fs = require('fs');
const path = require('path');
const db = require(path.join(__dirname, '..', 'app', 'db.js'));

const JSON_PATH = path.join(__dirname, 'spoonacular-seed.json');

function loadRecipes() {
  if (!fs.existsSync(JSON_PATH)) {
    console.log(`No ${path.basename(JSON_PATH)} present — nothing to seed.`);
    console.log(`Run: node data/fetch-seed.js --plan full`);
    console.log(`(then re-run this script to populate the database).`);
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

function seed() {
  const recipes = loadRecipes();

  db.exec('DELETE FROM recipe_ingredients; DELETE FROM recipes;');
  if (recipes === null) {
    console.log('Recipe tables wiped. Database is now empty.');
    return;
  }
  if (!recipes.length) {
    console.log('Seed JSON is empty — recipe tables wiped, no rows inserted.');
    return;
  }

  const insertRecipe = db.prepare(`INSERT INTO recipes
    (name, meal_type, cuisine, kid_friendly, prep_time, servings, est_cost,
     calories, protein, fiber, sugar, sodium, favorite, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertIng = db.prepare(`INSERT INTO recipe_ingredients
    (recipe_id, name, quantity, unit, brand_preference)
    VALUES (?, ?, ?, ?, ?)`);

  const tx = db.transaction(() => {
    for (const r of recipes) {
      const info = insertRecipe.run(
        r.name,
        r.meal_type,
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
        r.notes || null
      );
      for (const ing of (r.ingredients || [])) {
        insertIng.run(
          info.lastInsertRowid,
          ing.name,
          typeof ing.quantity === 'number' && ing.quantity > 0 ? ing.quantity : 1,
          ing.unit || 'each',
          ing.brand_preference || null
        );
      }
    }
  });
  tx();

  const counts = {};
  for (const r of recipes) counts[r.meal_type] = (counts[r.meal_type] || 0) + 1;
  console.log(`Seeded ${recipes.length} recipes:`);
  for (const k of Object.keys(counts).sort()) console.log(`  ${k.padEnd(10)} ${counts[k]}`);
}

seed();
