# Recipe Clipper

One-click Chrome extension that clips recipes from NYT Cooking (and any
site publishing schema.org Recipe JSON-LD) into your Meal Planner
library. Reads the structured data that sites publish for Google's
recipe-card indexing — no scraping, no auth dance.

## Install (developer mode, one-time)

1. Open Chrome → `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select this folder: `meal-planner-cart/chrome-extension/nyt-importer`
5. The extension icon appears in your toolbar (you may want to pin it)

## Setup (one-time)

1. Sign into your Meal Planner app at
   [meals.alaskatargeting.com/settings](https://meals.alaskatargeting.com/settings#grocery-extension)
2. Copy the **Grocery extension API token** (starts with `fbe_…`).
   Same token the food-buyer extension uses; both extensions share it.
3. Right-click the extension icon → **Options**
4. Paste the token, click **Save**

## Use

1. Browse [cooking.nytimes.com](https://cooking.nytimes.com) like normal
   (logged in or not — works either way).
2. On any recipe page, click the extension icon.
3. The popup shows a preview (recipe name, prep time, ingredients count,
   category).
4. Click **Clip recipe**.
5. ~3-5 seconds later: confirmation. The recipe is in your library with
   ingredients parsed, USDA nutrition warming in the background, and
   `meal_type` set automatically (sides go to side, mains go to dinner,
   etc.).

If the same recipe is already in your library (matched by NYT recipe
ID), the import is a no-op — you'll see "Already in your library."

## How it works

```
NYT Cooking page
  ↓ (you click the extension icon)
popup.js — chrome.scripting reads <script type="application/ld+json">
  ↓ (POST to your Meal Planner)
/api/recipes/import-nyt   (bearer-authed, services/nyt_cooking.js)
  ↓
LLM parses each ingredient line → {name, qty, unit}
  ↓
insertRecipesAndIngredients (canonicalize, USDA cache warm)
  ↓
recipe lives in your library
```

No data leaves your browser except the recipe JSON-LD itself, which is
public on the NYT page.

## Privacy / ToS notes

- Reads NYT Cooking's publicly-published schema.org metadata. Same data
  Google indexes. Personal-use, one-recipe-at-a-time imports of content
  you already have access to.
- Don't bulk-pull thousands of recipes — that's where you'd cross a line.
- The API token authenticates you to *your own* Meal Planner instance.
  Treat it like a password.

## Development

The extension is plain MV3 — no build step, no bundler. Edit any file,
hit the reload icon on `chrome://extensions`, and the changes are live.

Files:
- `manifest.json` — MV3 config
- `popup.html / .js` — toolbar popup that reads the page + sends import
- `options.html / .js` — token + API URL settings
- `popup.css` — shared styling, mirrors the Meal Planner cream/ink theme
