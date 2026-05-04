// Run: node data/canonicalize-ingredients.js
//
// One-shot rename pass. Walks recipe_ingredients, applies usda.canonicalize()
// to every name, and UPDATEs the row when the canonical form differs. After
// this runs, the recipe edit pages show the cleaned-up names ("olive oil"
// instead of "regular olive oil", "mushrooms" instead of "cremini mushrooms",
// etc.) and the settings-page coverage card stops listing those rename-able
// variants as unmatched.
//
// Why this exists: services/usda.js used to use a noisier normalize() as the
// nutrition_lookups cache key, then a cleanQuery() pass on the way to USDA.
// That meant the row in recipe_ingredients was stored verbatim ("regular
// olive oil") but the cache lookup was on a different shape, and matches
// only happened by accident. The fix unified both sides on canonicalize()
// (services/usda.js) — but existing rows still hold the old verbose names
// and need a one-time scrub. Going forward, the recipe-edit and Spoonacular-
// import paths canonicalize on write, so this stays a one-shot.
//
// Safe to re-run. Idempotent: if a row is already canonical, the UPDATE is
// skipped. After the rename sweep, the script also warms USDA cache for any
// canonical name that isn't yet in nutrition_lookups.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require(path.join(__dirname, '..', 'app', 'db.js'));
const usda = require(path.join(__dirname, '..', 'app', 'services', 'usda.js'));

async function main() {
  // Phase A: rename existing rows.
  const rows = db.prepare(
    'SELECT id, name FROM recipe_ingredients'
  ).all();
  console.log(`Total recipe_ingredients rows: ${rows.length}`);

  const updateName = db.prepare(
    'UPDATE recipe_ingredients SET name = ? WHERE id = ?'
  );
  // Track the distinct rename mappings for the summary printout. Keyed
  // by `${before}→${after}` so we report each transformation once with
  // a count of affected rows.
  const renameCounts = new Map();
  let changed = 0;
  let unchanged = 0;
  let emptyFallback = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      const before = (r.name || '').trim();
      if (!before) { unchanged++; continue; }
      const after = usda.canonicalize(before);
      if (!after) {
        // canonicalize fell through to empty (shouldn't happen given its
        // own fallback, but defensive). Leave the row alone.
        emptyFallback++;
        unchanged++;
        continue;
      }
      if (after === before) {
        unchanged++;
        continue;
      }
      updateName.run(after, r.id);
      const key = `${before} → ${after}`;
      renameCounts.set(key, (renameCounts.get(key) || 0) + 1);
      changed++;
    }
  });
  tx();

  console.log('');
  console.log('=== Rename pass ===');
  console.log(`  changed:        ${changed} rows`);
  console.log(`  unchanged:      ${unchanged} rows`);
  if (emptyFallback) console.log(`  empty-fallback: ${emptyFallback} rows (left as-is)`);
  if (renameCounts.size) {
    console.log('');
    console.log('Distinct mappings (most rows first):');
    const sorted = [...renameCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [pair, n] of sorted) {
      console.log(`  ${String(n).padStart(3)}× ${pair}`);
    }
  }

  // Phase B: warm USDA cache for any canonical name not yet in
  // nutrition_lookups. Mirrors data/warm-nutrition-cache.js but scoped to
  // the names we actually have post-rename.
  const allNames = db.prepare(`
    SELECT DISTINCT LOWER(TRIM(name)) AS name FROM recipe_ingredients
  `).all().map(r => r.name).filter(Boolean);
  const cached = new Set(
    db.prepare('SELECT ingredient_name FROM nutrition_lookups').all().map(r => r.ingredient_name)
  );
  const todo = allNames.filter(n => !cached.has(n));

  console.log('');
  console.log('=== Cache warm pass ===');
  console.log(`  distinct names:     ${allNames.length}`);
  console.log(`  already cached:     ${allNames.length - todo.length}`);
  console.log(`  to warm via USDA:   ${todo.length}`);
  if (!todo.length) {
    console.log('Nothing more to do.');
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
    // Polite throttle. USDA's free tier is 1000 req/hr per key.
    await new Promise(r => setTimeout(r, 150));
  }

  console.log('');
  console.log('=== Done ===');
  console.log(`  hits:    ${hits}`);
  console.log(`  misses:  ${misses}  (USDA had no match — these stay partial)`);
  console.log(`  errors:  ${errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
