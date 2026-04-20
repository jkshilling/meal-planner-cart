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

## Current limitations (v1)

- Rules-based planner only — no AI, embeddings, or external nutrition APIs.
- No pantry tracking. Plan assumes an empty pantry.
- No payment or checkout automation — deliberately stops before checkout.
- No accounts / multi-user. Single household profile, local SQLite.
- Walmart selectors are a moving target. When they break, update `automation/walmart.js` only.
- Unit merging is string-based (`cup` + `cup` merge; `cup` + `oz` do not) — extend if you want cross-unit conversion.
- Login state is not persisted between runs. Playwright opens a fresh context each time the server starts.
