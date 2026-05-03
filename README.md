# Meal Planner + Walmart Cart

A lean local web app that plans a week of meals from your own recipes, lets you review and tweak the plan, builds a shopping list, matches items to Walmart products, and — after you approve — adds them to your Walmart cart via browser automation. It stops before checkout.

## Stack

- Node.js + Express
- EJS templates, plain CSS
- SQLite via `better-sqlite3`
- Playwright (Chromium) for Walmart automation

No React, Next.js, Tailwind, or heavy UI libs.

## Folder structure

```
meal-planner-cart/
├── app/
│   ├── server.js              # Express entry
│   ├── db.js                  # SQLite connection + schema
│   ├── routes/
│   │   ├── index.js           # Dashboard
│   │   ├── settings.js        # GET/POST /settings
│   │   ├── recipes.js         # CRUD + archive
│   │   ├── planner.js         # Planner generation, slot edits, approval, GET /plan/:id
│   │   └── plan.js            # Shopping list, Walmart match, add-to-cart, automation result
│   ├── services/
│   │   ├── planner.js         # Scoring + meal selection
│   │   ├── shopping.js        # Ingredient merge + editing
│   │   └── matcher.js         # Walmart candidate ranking + confidence
│   ├── views/                 # EJS templates (dashboard, settings, recipes, review, shopping, automation, error)
│   └── public/styles.css
├── automation/
│   └── walmart.js             # All Playwright + Walmart selectors live here
├── data/
│   ├── seed.js                # 13 sample recipes
│   └── app.db                 # Created on first run
├── package.json
├── .env.example
└── README.md
```

## Setup

```bash
cd meal-planner-cart
cp .env.example .env
npm install
npx playwright install chromium
node data/seed.js         # seed sample recipes
npm start                 # http://localhost:3000
```

`app.db` is created automatically on first run (schema initialized by `app/db.js`). The seed script wipes and reloads the recipe tables — run it again any time to reset sample data.

## How to use

1. **Settings** — define household members, budget, optimization mode, meal types, lunch behaviors, and filters.
2. **Recipes** — add/edit/archive recipes. The sample seed is a starting point.
3. **Weekly Planner** → generate a plan. Swap, regen, or lock individual slots.
4. **Review + Approve** — approve when ready.
5. **Shopping + Walmart Match** — builds a merged shopping list, runs Walmart searches, ranks candidates, and flags confidence.
6. Approve matches, then **Add to Cart** to run the automation. The browser opens; log in manually if Walmart prompts. Automation stops before checkout.

## Planning logic

Slot scoring lives in `app/services/planner.js`. Each recipe is scored on visible factors:

- **budget_score** — does the per-serving cost fit the remaining per-slot budget?
- **prep_score** — 1.0 at 0 min, 0.0 at 60+ min.
- **health_score** — from calories/protein/fiber/sugar/sodium.
- **repetition_penalty** — -0.25 per prior use in the same week.
- **favorite_boost** — +0.15 if the recipe is a favorite or matches a favorite keyword.
- **household_fit_boost** — +0.10 kid_friendly (if household has kids), +0.10 cuisine match, +0.15 breakfast under 15 min when simplicity is enabled.

Weights depend on `optimization_mode`:

- `lowest_cost`: budget 0.65, prep 0.20, health 0.15
- `healthiest`: budget 0.45, prep 0.10, health 0.45
- `least_prep_time`: budget 0.45, prep 0.45, health 0.10

Budget is always weighted heaviest (or tied) — matches the "budget is top priority" requirement.

Hard filters drop recipes that contain allergens, disliked ingredients, violate dietary constraints (vegetarian / vegan / gluten-free), or exceed `max_prep_time`.

Household fit works the same code path for solo and family households — the only differences are driven by settings (member count for scaling, `kid_friendly` boost, per-member lunch behavior).

## Shopping list

`app/services/shopping.js` merges ingredients across recipes by `(name, unit, brand_preference)`. Quantities scale by household size / recipe servings and multiply by how many times the recipe appears in the week. The list is fully editable before automation runs.

## Walmart matching

`app/services/matcher.js` ranks Playwright search results with:

- token Jaccard similarity (primary)
- brand-preference substring boost
- size/unit closeness
- price tie-breaker

Confidence is tagged `high` / `medium` / `low`. Low-confidence items are *not* auto-approved — the UI requires you to pick a candidate or approve manually.

## Walmart selector assumptions

`automation/walmart.js` is the only place Walmart-specific logic lives. These selectors were accurate at the time of writing, but Walmart rotates class names and adds bot-protection often. If matching returns zero candidates or add-to-cart misses, update the `SELECTORS` map at the top of that file. Current assumptions:

- Search results live under `div[data-item-id]` cards (backed by `data-testid="list-view"` or `item-stack`).
- Product title: `span[data-automation-id="product-title"]`.
- Price: `[data-automation-id="product-price"]`.
- Product link: `a[href*="/ip/"]`.
- Add to cart button: `button[data-automation-id="atc"]` (falls back to `aria-label` and text match).
- Captcha / bot wall detected via `[data-testid="captcha"]` or `#px-captcha` — matching is halted when detected.

The browser runs headed by default (`WALMART_HEADLESS=false`) so you can see what's happening and finish login or captcha manually.

## Env

```
PORT=3000
NODE_ENV=development
SESSION_SECRET=change-me-to-a-long-random-string
WALMART_HEADLESS=false
```

## Deploy to shared DigitalOcean droplet

The app is built to coexist with other apps on a shared droplet (systemd units per app, specific nginx server_name per subdomain, loopback-only binds — no global writes).

**Layout on the droplet**

```
/srv/meal-planner-cart/          # app code, git checkout or rsync target
/srv/meal-planner-cart/.env      # production env, NEVER committed
/srv/meal-planner-cart/data/     # SQLite db lives here, writable by www-data
/etc/systemd/system/meal-planner-cart.service   # installed by deploy.sh
/etc/nginx/sites-available/meal-planner-cart.conf → sites-enabled/…
```

**Port + subdomain**: app binds to `127.0.0.1:8002`. Nginx proxies `meals.alaskatargeting.com` → that port. Nothing else is exposed.

**Deploy sequence (first time)**

```bash
# 1. On the droplet, pull the code
sudo mkdir -p /srv/meal-planner-cart
sudo chown $(whoami) /srv/meal-planner-cart
git clone https://github.com/jkshilling/meal-planner-cart.git /srv/meal-planner-cart
cd /srv/meal-planner-cart

# 2. Copy and edit the env file (NODE_ENV=production, PORT=8002,
#    WALMART_ENABLED=false, real SESSION_SECRET)
cp .env.example .env
${EDITOR:-vi} .env

# 3. Seed the database once
node data/seed.js

# 4. Install systemd unit, nginx site, rebuild native deps, start
sudo ./deploy/deploy.sh

# 5. Point DNS: A record meals.alaskatargeting.com → droplet IP

# 6. Obtain TLS cert (rewrites the nginx site file in place)
sudo certbot --nginx -d meals.alaskatargeting.com
```

**Deploy sequence (subsequent)**

```bash
cd /srv/meal-planner-cart
git pull
sudo ./deploy/deploy.sh       # idempotent — re-runs safely
```

`deploy.sh` touches only this app's systemd unit and nginx site. It never modifies `sites-enabled/default`, sibling apps' configs, `nginx.conf`, or global systemd settings. If nginx config validation fails, it bails before reloading so other apps stay up.

**TLS config handling.** The deploy script is TLS-aware to avoid clobbering certbot's 443 server block on re-runs:

- `deploy/nginx.conf` — HTTP-only, used on first deploy before certbot has issued a cert.
- `deploy/nginx-tls.conf` — HTTPS-enabled, mirrors what certbot would write. Installed automatically on any deploy after `/etc/letsencrypt/live/meals.alaskatargeting.com/fullchain.pem` exists.

Flow: first deploy installs the HTTP-only config → run `certbot --nginx` once → re-run `deploy.sh` and it swaps to the TLS config. From then on, every `deploy.sh` re-run keeps the TLS config intact.

**Production env differences from local**

| | Local (Mac) | Droplet |
|---|---|---|
| `NODE_ENV` | `development` | `production` |
| `PORT` | anything | `8002` |
| `HOST` | `127.0.0.1` | `127.0.0.1` |
| `WALMART_ENABLED` | `true` | `false` |
| `WALMART_HEADLESS` | `false` | irrelevant |

On the droplet, the Walmart match / add-to-cart / Products pages are all disabled (they 404 and the buttons hide). Headed Chromium can't run without a display, so those features stay local-only. Run them on your Mac against the local DB.

**Logs**

```bash
journalctl -u meal-planner-cart -f        # app
tail -f /var/log/nginx/meal-planner-cart.access.log
tail -f /var/log/nginx/meal-planner-cart.error.log
```

## Recipe search (Spoonacular)

The "Search online" panel on the Recipes page hits Spoonacular's `complexSearch` API. Imported recipes arrive with real per-serving nutrition (calories / protein / fiber / sugar / sodium) and per-serving cost in USD, both pulled directly from Spoonacular's response.

**API key**: required. Sign up free at <https://spoonacular.com/food-api> for 150 points/day, put it in `.env` as `SPOONACULAR_API_KEY=...`. Each search costs ~1.5 points (with `addRecipeInformation+addRecipeNutrition`), each import costs ~1 point. The "Search online" feature 503s when the key is missing.

## Nutrition fallback (USDA FoodData Central)

USDA is the secondary nutrition source — used by:

1. The "Pre-fill from USDA" button on the manual recipe form (compute nutrition for whatever ingredients you've typed).
2. Spoonacular imports where the recipe came back without nutrient data (rare).

Per-ingredient lookups are cached in `nutrition_lookups` so each unique ingredient is queried once.

**API key**: `DEMO_KEY` (default in `.env.example`) is rate-limited to 30 req/hour per IP. For real use, sign up free at <https://api.data.gov/signup/> for 1,000 req/hour and put it in `.env` as `USDA_API_KEY=...`.

**Honest accuracy notes**:
- Per-100g USDA values are converted to recipe quantities via approximate volume→grams conversions. `1 cup flour ≈ 120g`, `1 cup leafy greens ≈ 30g`, etc. Generic fallback is `1 cup ≈ 240g` (water density). Real accuracy is roughly ±15–20%.
- "Each"-style units (`1 banana`, `2 eggs`) use a small per-each weight lookup, falling back to 100g.
- Branded prepared meals (e.g. "CARRABBA'S ITALIAN GRILL, lasagne") and food-cut variants ("beef tenderloin" for a query of "beef") are filtered out — the matcher prefers generic raw ingredients.

## Current limitations (v1)

- Rules-based planner only — no AI, embeddings, or external nutrition APIs.
- No pantry tracking. Plan assumes an empty pantry.
- No payment or checkout automation — deliberately stops before checkout.
- No accounts / multi-user. Single household profile, local SQLite.
- Walmart selectors are a moving target. When they break, update `automation/walmart.js` only.
- Unit merging is string-based (`cup` + `cup` merge; `cup` + `oz` do not) — extend if you want cross-unit conversion.
- Login state is not persisted between runs. Playwright opens a fresh context each time the server starts.
