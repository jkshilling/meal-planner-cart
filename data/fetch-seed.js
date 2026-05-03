// Fetch a curated recipe library from Spoonacular and write to JSON.
//
// This script is RESUMABLE: it appends new recipes to data/spoonacular-seed.json
// keyed by source_id, so re-running after a partial run picks up where it left
// off. Persists after every recipe so a crash mid-run loses at most one recipe.
//
// Usage:
//   node data/fetch-seed.js               # uses the default PLAN below
//   node data/fetch-seed.js --plan small  # 10-recipe smoke test
//   node data/fetch-seed.js --plan full   # the full ~250-recipe library
//
// Costs: each search ≈ 1.5 Spoonacular points, each /information lookup ≈ 1
// point. Plan ahead — free tier is 150 points/day. Script will continue past
// rate-limit errors but skips those recipes; re-run tomorrow to fill in.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const spoonacular = require('../app/services/spoonacular');

const OUTPUT = path.join(__dirname, 'spoonacular-seed.json');

// --------------------------------------------------------------------------
// PLANS — define what to pull. Each entry runs ONE search and pulls `count`
// recipes from the results, overriding meal_type to the planned bucket
// (Spoonacular's own classification is loose).
// --------------------------------------------------------------------------

const PLAN_SMALL = [
  // 10-recipe smoke test: 2 of each meal type, varied queries to exercise
  // search + info + normalization across the meal_type/cuisine spectrum.
  { meal_type: 'breakfast', query: 'overnight oats',         count: 1 },
  { meal_type: 'breakfast', query: 'breakfast burrito',      count: 1 },
  { meal_type: 'lunch',     query: 'chicken sandwich',       count: 1 },
  { meal_type: 'lunch',     query: 'minestrone soup',        count: 1 },
  { meal_type: 'snack',     query: 'hummus dip',             count: 1 },
  { meal_type: 'snack',     query: 'trail mix',              count: 1 },
  { meal_type: 'dinner',    query: 'chicken parmesan',       count: 1 },
  { meal_type: 'dinner',    query: 'beef stir fry',          count: 1 },
  { meal_type: 'side',      query: 'roasted broccoli',       count: 1 },
  { meal_type: 'side',      query: 'mashed potatoes',        count: 1 }
];

// Full plan: 38 search queries × 7 recipes each = 266 results targeted.
// After dedup + outlier filtering we expect ~220-240 to actually land.
//
// Queries chosen for: variety in cuisines (american, italian, mexican,
// indian, asian, mediterranean), variety in proteins (chicken, beef, pork,
// fish, vegetarian), and variety in formats (sandwich, soup, bowl, casserole,
// stir fry). Avoid trendy/branded queries — keep names recognizable.
const PLAN_FULL = [
  // ---- Breakfast (6 queries × 7 = 42) ----
  { meal_type: 'breakfast', query: 'pancakes',          count: 7 },
  { meal_type: 'breakfast', query: 'scrambled eggs',    count: 7 },
  { meal_type: 'breakfast', query: 'oatmeal',           count: 7 },
  { meal_type: 'breakfast', query: 'smoothie bowl',     count: 7 },
  { meal_type: 'breakfast', query: 'french toast',      count: 7 },
  { meal_type: 'breakfast', query: 'frittata',          count: 7 },

  // ---- Lunch (8 queries × 7 = 56) ----
  { meal_type: 'lunch',     query: 'chicken salad',     count: 7 },
  { meal_type: 'lunch',     query: 'grilled cheese',    count: 7 },
  { meal_type: 'lunch',     query: 'tuna sandwich',     count: 7 },
  { meal_type: 'lunch',     query: 'tomato soup',       count: 7 },
  { meal_type: 'lunch',     query: 'burrito bowl',      count: 7 },
  { meal_type: 'lunch',     query: 'buddha bowl',       count: 7 },
  { meal_type: 'lunch',     query: 'ramen',             count: 7 },
  { meal_type: 'lunch',     query: 'wrap',              count: 7 },

  // ---- Snack (5 queries × 6 = 30) ----
  { meal_type: 'snack',     query: 'energy balls',      count: 6 },
  { meal_type: 'snack',     query: 'protein bar',       count: 6 },
  { meal_type: 'snack',     query: 'veggie dip',        count: 6 },
  { meal_type: 'snack',     query: 'cheese plate',      count: 6 },
  { meal_type: 'snack',     query: 'fruit salad',       count: 6 },

  // ---- Dinner (12 queries × 7 = 84) ----
  { meal_type: 'dinner',    query: 'chicken curry',     count: 7 },
  { meal_type: 'dinner',    query: 'spaghetti bolognese', count: 7 },
  { meal_type: 'dinner',    query: 'tacos',             count: 7 },
  { meal_type: 'dinner',    query: 'chicken stir fry',  count: 7 },
  { meal_type: 'dinner',    query: 'baked salmon',      count: 7 },
  { meal_type: 'dinner',    query: 'pork tenderloin',   count: 7 },
  { meal_type: 'dinner',    query: 'lasagna',           count: 7 },
  { meal_type: 'dinner',    query: 'shepherds pie',     count: 7 },
  { meal_type: 'dinner',    query: 'meatballs',         count: 7 },
  { meal_type: 'dinner',    query: 'chicken casserole', count: 7 },
  { meal_type: 'dinner',    query: 'beef stew',         count: 7 },
  { meal_type: 'dinner',    query: 'enchiladas',        count: 7 },

  // ---- Side (7 queries × 7 = 49) ----
  { meal_type: 'side',      query: 'roasted vegetables', count: 7 },
  { meal_type: 'side',      query: 'rice pilaf',         count: 7 },
  { meal_type: 'side',      query: 'garlic bread',       count: 7 },
  { meal_type: 'side',      query: 'green beans',        count: 7 },
  { meal_type: 'side',      query: 'coleslaw',           count: 7 },
  { meal_type: 'side',      query: 'sweet potato',       count: 7 },
  { meal_type: 'side',      query: 'quinoa salad',       count: 7 }
];

const PLANS = { small: PLAN_SMALL, full: PLAN_FULL };

// --------------------------------------------------------------------------

function parseArgs() {
  const args = { plan: 'small' };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--plan' && process.argv[i + 1]) {
      args.plan = process.argv[++i];
    }
  }
  return args;
}

function loadExisting() {
  if (!fs.existsSync(OUTPUT)) return [];
  try {
    return JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
  } catch (e) {
    console.error(`Warning: ${OUTPUT} exists but isn't valid JSON. Starting fresh.`);
    return [];
  }
}

function persist(rows) {
  fs.writeFileSync(OUTPUT, JSON.stringify(rows, null, 2));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs();
  const plan = PLANS[args.plan];
  if (!plan) {
    console.error(`Unknown plan "${args.plan}". Valid: ${Object.keys(PLANS).join(', ')}`);
    process.exit(2);
  }
  if (!plan.length) {
    console.error(`Plan "${args.plan}" is empty. Edit data/fetch-seed.js to fill it in.`);
    process.exit(2);
  }
  if (!spoonacular.isEnabled()) {
    console.error('SPOONACULAR_API_KEY not set in .env');
    process.exit(1);
  }

  const collected = loadExisting();
  const seenIds = new Set(collected.map(r => r.source_id));
  console.log(`Plan: ${args.plan} (${plan.length} search entries, target ${plan.reduce((s, p) => s + p.count, 0)} recipes)`);
  console.log(`Existing: ${collected.length} recipes already in ${path.basename(OUTPUT)}`);

  let added = 0, skipped = 0, errored = 0;

  for (const item of plan) {
    process.stdout.write(`\n→ ${item.meal_type.padEnd(10)} | "${item.query}" (want ${item.count})\n`);

    let results;
    try {
      // Pull more than we need so dedup + bad-data filtering still leaves enough.
      results = await spoonacular.searchByName(item.query, Math.max(item.count * 3, 5));
    } catch (e) {
      console.error(`   search failed: ${e.message}`);
      errored++;
      continue;
    }

    let took = 0;
    for (const r of results) {
      if (took >= item.count) break;
      if (seenIds.has(r.source_id)) {
        console.log(`   skip (dup): ${r.name}`);
        skipped++;
        continue;
      }
      // search results don't include extendedIngredients — fetch full details.
      let full;
      try {
        full = await spoonacular.lookupById(r.source_id);
      } catch (e) {
        console.error(`   lookup failed for ${r.source_id}: ${e.message}`);
        errored++;
        continue;
      }
      if (!full || !(full.ingredients || []).length) {
        console.log(`   skip (no ingredients): ${r.name}`);
        skipped++;
        continue;
      }

      // Outlier filtering — drop recipes likely to skew the planner.
      // These cutoffs come from the smoke-test pull where "Basic Hummus"
      // (20 servings) and "Best Breakfast Burrito" (1074 cal) showed up
      // as legitimate-but-distorting entries.
      if (full.servings > 8) {
        console.log(`   skip (servings=${full.servings}, batch-cook): ${full.name}`);
        skipped++;
        continue;
      }
      if (full.calories && full.calories > 900) {
        console.log(`   skip (calories=${full.calories}/serving): ${full.name}`);
        skipped++;
        continue;
      }
      if (full.est_cost && full.servings && (full.est_cost / full.servings) > 20) {
        console.log(`   skip ($${(full.est_cost / full.servings).toFixed(2)}/serving): ${full.name}`);
        skipped++;
        continue;
      }
      // Override meal_type with our planned bucket — Spoonacular's dishTypes
      // can be loose ("main course", "finger food", etc.).
      full.meal_type = item.meal_type;
      collected.push(full);
      seenIds.add(full.source_id);
      took++;
      added++;
      console.log(`   + ${full.name} (${full.ingredients.length} ings, $${full.est_cost}, ${full.calories} cal)`);

      // Persist after each recipe — partial runs are recoverable.
      persist(collected);
      await sleep(400);  // be polite to the API
    }
  }

  console.log('');
  console.log('=== Done ===');
  console.log(`  total in JSON: ${collected.length}`);
  console.log(`  added this run: ${added}`);
  console.log(`  skipped (dup/no ings): ${skipped}`);
  console.log(`  errored: ${errored}`);

  const byType = {};
  for (const r of collected) byType[r.meal_type] = (byType[r.meal_type] || 0) + 1;
  console.log('\nDistribution by meal_type:');
  for (const [k, v] of Object.entries(byType).sort()) console.log(`  ${k.padEnd(12)} ${v}`);

  const byCuisine = {};
  for (const r of collected) byCuisine[r.cuisine || '(none)'] = (byCuisine[r.cuisine || '(none)'] || 0) + 1;
  console.log('\nDistribution by cuisine:');
  for (const [k, v] of Object.entries(byCuisine).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);

  console.log(`\nOutput: ${OUTPUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
