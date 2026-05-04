// Run: node data/pull-popular-sides.js [count]
//
// One-shot pull of the top N most-popular Spoonacular side dishes into
// the bootstrap owner's recipe library. Default count is 10.
//
// Why this exists: data/fetch-seed.js works off PLAN_FULL, which has
// only 7 hardcoded side queries (rice pilaf, garlic bread, coleslaw,
// etc.). That caps side variety at ~49 recipes around 7 narrow themes.
// This script bypasses PLAN_FULL and uses Spoonacular's `type=side dish`
// dishType filter to pull the actual popularity-ranked sides — which
// gives access to all 1,338 typed side dishes in their corpus.
//
// Idempotent: skips recipes whose source_id is already in the owner's
// library. Outlier filter mirrors fetch-seed.js (servings <= 8) so a
// 20-serving "Basic Hummus" entry doesn't poison cost / portion math.
//
// Cost: ~10 points for 100 results. Free tier is 150/day, $9 plan is
// 200/day, so 10 sides is ~1 point.
//
// After insert, services/household.insertRecipesAndIngredients fires off
// a USDA cache warm in the background — by the time you reload the
// recipes page, nutrition should be populated for any new ingredients.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require(path.join(__dirname, '..', 'app', 'db.js'));
const spoonacular = require(path.join(__dirname, '..', 'app', 'services', 'spoonacular.js'));
const household = require(path.join(__dirname, '..', 'app', 'services', 'household.js'));

async function main() {
  const count = parseInt(process.argv[2], 10) || 10;
  if (!spoonacular.isEnabled()) {
    console.error('SPOONACULAR_API_KEY not set in .env');
    process.exit(1);
  }
  const ownerEmail = (process.env.BOOTSTRAP_OWNER_EMAIL || '').toLowerCase().trim();
  if (!ownerEmail) {
    console.error('BOOTSTRAP_OWNER_EMAIL not set in .env');
    process.exit(1);
  }
  const owner = db.prepare(
    'SELECT id, email FROM users WHERE LOWER(email) = ?'
  ).get(ownerEmail);
  if (!owner) {
    console.error(`No user found with email ${ownerEmail}`);
    process.exit(1);
  }

  console.log(`Pulling top ${count} popular sides for ${owner.email} (user ${owner.id})…`);
  const results = await spoonacular.searchRecipes({
    type: 'side dish',
    limit: count,
    sort: 'popularity'
  });
  console.log(`Spoonacular returned ${results.length} candidates.`);

  // Filter outliers + dedupe against existing library.
  const existingIds = new Set(
    db.prepare('SELECT source_id FROM recipes WHERE user_id = ? AND source_id IS NOT NULL').all(owner.id)
      .map(r => r.source_id)
  );
  const rows = [];
  for (const r of results) {
    if (existingIds.has(r.source_id)) {
      console.log(`  skip dup: ${r.name} (sp:${r.source_id})`);
      continue;
    }
    if (r.servings > 8) {
      console.log(`  skip batch-size (servings=${r.servings}): ${r.name}`);
      continue;
    }
    if (!r.ingredients || !r.ingredients.length) {
      console.log(`  skip no-ingredients: ${r.name}`);
      continue;
    }
    // Force meal_type to 'side' regardless of Spoonacular's classification —
    // the user asked for sides, that's what they get.
    rows.push({ ...r, meal_type: 'side' });
  }
  console.log(`Inserting ${rows.length} new sides…`);
  if (!rows.length) { console.log('Nothing to do.'); return; }

  household.insertRecipesAndIngredients(owner.id, rows, r => r.ingredients);

  console.log('\nDone. Newly-added sides:');
  for (const r of rows) {
    console.log(`  ${r.name}  (${r.prep_time}m · $${r.est_cost} · ${r.servings} servings)`);
  }
  console.log('\nUSDA cache is warming in the background. Reload /recipes in a minute or so.');
}

main().catch(e => { console.error(e); process.exit(1); });
