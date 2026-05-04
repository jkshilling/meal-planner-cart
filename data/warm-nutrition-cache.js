// Run: node data/warm-nutrition-cache.js
//
// One-shot cache warmer. Walks every distinct ingredient name across all
// recipe_ingredients in the DB, finds the ones not yet in nutrition_lookups,
// and hits USDA searchFood() for each (which populates the cache as a side
// effect). After running, the recipe list renders with full per-recipe
// nutrition coverage instead of partial values.
//
// Why this is needed: the Spoonacular cron (data/fetch-seed.js +
// data/seed.js) inserts recipes with ingredients but doesn't pre-warm the
// USDA cache for those ingredient names. Before nutrition was derived, the
// cron stored Spoonacular's per-recipe nutrition values directly on the
// recipe row, so individual ingredients were never looked up. After the
// derive-nutrition refactor, those cron-imported recipes show partial
// nutrition until something (this script, a manual save, or the edit-form
// preview) forces searchFood to run for each ingredient.
//
// Going forward services/household.insertRecipesAndIngredients fires its
// own warm-up so this script becomes a one-time backfill rather than a
// recurring chore. Safe to re-run though — already-cached names are
// skipped.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require(path.join(__dirname, '..', 'app', 'db.js'));
const usda = require(path.join(__dirname, '..', 'app', 'services', 'usda.js'));

async function main() {
  // Distinct lowercased ingredient names referenced by any recipe.
  const allNames = db.prepare(`
    SELECT DISTINCT LOWER(TRIM(name)) AS name FROM recipe_ingredients
  `).all().map(r => r.name).filter(Boolean);

  // Names already in the cache (regardless of whether USDA matched them —
  // a NULL row counts as "we already tried, no match exists").
  const cachedNames = new Set(
    db.prepare('SELECT ingredient_name FROM nutrition_lookups').all().map(r => r.ingredient_name)
  );

  const todo = allNames.filter(n => !cachedNames.has(n));
  console.log(`Total distinct ingredient names: ${allNames.length}`);
  console.log(`Already cached:                ${allNames.length - todo.length}`);
  console.log(`To warm:                       ${todo.length}`);
  if (!todo.length) {
    console.log('Nothing to do.');
    return;
  }

  let hits = 0, misses = 0, errors = 0;
  for (let i = 0; i < todo.length; i++) {
    const name = todo[i];
    process.stdout.write(`[${i + 1}/${todo.length}] ${name} … `);
    try {
      const food = await usda.searchFood(name);
      if (food && food.calories_per_100g != null) {
        console.log(`${Math.round(food.calories_per_100g)} cal/100g`);
        hits++;
      } else {
        console.log('no match');
        misses++;
      }
    } catch (e) {
      console.log(`error: ${e.message}`);
      errors++;
    }
    // Be polite to the USDA API. Their rate limits are generous but no
    // reason to hammer.
    await new Promise(r => setTimeout(r, 150));
  }

  console.log('');
  console.log('=== Done ===');
  console.log(`  hits:    ${hits}`);
  console.log(`  misses:  ${misses}  (USDA had no match — these will read as partial in the UI)`);
  console.log(`  errors:  ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
