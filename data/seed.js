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
// All the actual import logic lives in services/household.seedRecipesForUser
// (the same function the "Re-sync from master library" button calls). This
// script is just the CLI wrapper.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require(path.join(__dirname, '..', 'app', 'db.js'));
const { seedRecipesForUser } = require(path.join(__dirname, '..', 'app', 'services', 'household.js'));

const OWNER_EMAIL = (process.env.BOOTSTRAP_OWNER_EMAIL || '').toLowerCase().trim();

function main() {
  if (!OWNER_EMAIL) {
    console.error('BOOTSTRAP_OWNER_EMAIL is not set in .env — cannot determine');
    console.error('which user should own the imported recipes. Aborting.');
    process.exit(1);
  }
  const owner = db.prepare('SELECT id, email FROM users WHERE email = ?').get(OWNER_EMAIL);
  if (!owner) {
    console.error(`No user found with email ${OWNER_EMAIL}.`);
    console.error(`Sign up at /signup first; then re-run this script.`);
    process.exit(1);
  }

  // seedRecipesForUser dispatches to importFromStagedJson when the target
  // is the bootstrap owner — exactly what we want from the cron.
  const imported = seedRecipesForUser(owner.id);
  const total = db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE user_id = ?').get(owner.id).n;

  console.log(`Imported: ${imported}`);
  console.log(`Total recipes for ${owner.email}: ${total}`);
}

main();
