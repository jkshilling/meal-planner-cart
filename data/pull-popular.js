// Run: node data/pull-popular.js <spoonacular-dishType> [count=10] [sort=popularity] [--as <meal_type>]
//
// Examples:
//   node data/pull-popular.js "side dish" 50            # 50 popular sides → meal_type=side
//   node data/pull-popular.js snack 100 meta-score      # 100 best-quality snacks
//   node data/pull-popular.js "main course" 200 popularity --as dinner
//   node data/pull-popular.js salad 60                  # 60 popular salads → meal_type=side
//
// Pulls top-N recipes for a Spoonacular dishType filter into the
// bootstrap owner's recipe library. dishType is what Spoonacular
// classifies a recipe as ("side dish", "main course", "snack", etc.);
// our internal meal_type is one of breakfast / lunch / snack / dinner /
// side. The DEFAULT_MAP below maps the most common dishTypes to a
// sensible internal meal_type — pass `--as <meal_type>` to override.
//
// Idempotent: skips recipes whose source_id is already in the owner's
// library. Outlier filter mirrors data/fetch-seed.js (servings <= 8).
//
// Cost on Spoonacular: ~1 point + ~0.085 per result, so a 100-recipe
// pull is roughly 10 points. The $9 plan is 200 points/day.
//
// After insert, services/household.insertRecipesAndIngredients fires off
// a USDA cache warm in the background — reload /recipes in a minute or
// so for nutrition to populate on new ingredients.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require(path.join(__dirname, '..', 'app', 'db.js'));
const spoonacular = require(path.join(__dirname, '..', 'app', 'services', 'spoonacular.js'));
const household = require(path.join(__dirname, '..', 'app', 'services', 'household.js'));

// Spoonacular dishType → our internal meal_type. Conservative defaults;
// override with --as <meal_type>.
const DEFAULT_MAP = {
  'side dish':   'side',
  'side':        'side',
  'main course': 'dinner',
  'main dish':   'dinner',
  'dinner':      'dinner',
  'lunch':       'lunch',
  'breakfast':   'breakfast',
  'morning meal':'breakfast',
  'brunch':      'breakfast',
  'snack':       'snack',
  'appetizer':   'snack',
  'fingerfood':  'snack',
  'dessert':     'snack',
  'salad':       'side',
  'soup':        'dinner',
  'bread':       'side'
};

// Bias results toward "healthy" without being draconian. Combines a
// minHealthScore floor (Spoonacular's own composite — protein density,
// fiber, fat balance) with sodium / saturated-fat / sugar caps so the
// truly junky items get filtered out. Numbers chosen as gentle gates
// that still let through plenty of crowd-popular meals.
const HEALTHY_FILTERS = {
  minHealthScore: 35,
  maxSodium: 1500,        // mg per serving
  maxSaturatedFat: 15,    // g per serving
  maxSugar: 25            // g per serving
};

function parseArgs(argv) {
  const args = { type: null, count: 10, sort: 'popularity', as: null, healthy: false };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--as') { args.as = argv[++i]; continue; }
    if (a === '--healthy') { args.healthy = true; continue; }
    positional.push(a);
  }
  if (positional[0]) args.type = positional[0];
  if (positional[1]) args.count = parseInt(positional[1], 10) || 10;
  if (positional[2]) args.sort = positional[2];
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.type) {
    console.error('Usage: node data/pull-popular.js <dishType> [count=10] [sort=popularity] [--as <meal_type>]');
    console.error('  dishTypes: side dish, main course, snack, breakfast, lunch, salad, soup, appetizer, dessert, bread, beverage');
    process.exit(2);
  }
  const targetMealType = args.as || DEFAULT_MAP[args.type.toLowerCase()] || 'dinner';

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

  const filters = args.healthy ? HEALTHY_FILTERS : {};
  console.log(`Pulling top ${args.count} ${args.type} (sort=${args.sort}) → meal_type=${targetMealType}`);
  if (args.healthy) {
    console.log(`Healthy mode: minHealthScore=${HEALTHY_FILTERS.minHealthScore}, maxSodium=${HEALTHY_FILTERS.maxSodium}mg, maxSatFat=${HEALTHY_FILTERS.maxSaturatedFat}g, maxSugar=${HEALTHY_FILTERS.maxSugar}g`);
  }
  console.log(`Owner: ${owner.email} (user ${owner.id})\n`);

  // Spoonacular caps per-call at 100. For larger pulls, paginate via offset.
  const PAGE = 100;
  const all = [];
  for (let off = 0; off < args.count; off += PAGE) {
    const wanted = Math.min(PAGE, args.count - off);
    const batch = await spoonacular.searchRecipes({
      type: args.type,
      limit: wanted,
      sort: args.sort,
      offset: off,
      filters
    });
    all.push(...batch);
    if (batch.length < wanted) break;  // Spoonacular ran out of results
  }
  console.log(`Spoonacular returned ${all.length} candidates.`);

  // Dedupe vs. existing library + apply outlier / sanity filters.
  const existingIds = new Set(
    db.prepare('SELECT source_id FROM recipes WHERE user_id = ? AND source_id IS NOT NULL')
      .all(owner.id).map(r => r.source_id)
  );
  const rows = [];
  let dups = 0, batchSize = 0, noIng = 0;
  for (const r of all) {
    if (existingIds.has(r.source_id)) { dups++; continue; }
    if (r.servings > 8) { batchSize++; continue; }
    if (!r.ingredients || !r.ingredients.length) { noIng++; continue; }
    rows.push({ ...r, meal_type: targetMealType });
  }
  console.log(`Filtered: ${dups} dup, ${batchSize} batch-cook (servings>8), ${noIng} no-ingredients.`);
  console.log(`Inserting ${rows.length} new recipes…`);
  if (!rows.length) { console.log('Nothing to do.'); return; }

  household.insertRecipesAndIngredients(owner.id, rows, r => r.ingredients);

  console.log('\nNewly added:');
  for (const r of rows.slice(0, 50)) {
    console.log(`  ${r.name}  (${r.prep_time}m · $${r.est_cost} · ${r.servings} servings)`);
  }
  if (rows.length > 50) console.log(`  …and ${rows.length - 50} more.`);
  console.log('\nUSDA cache is warming in the background.');
}

main().catch(e => { console.error(e); process.exit(1); });
