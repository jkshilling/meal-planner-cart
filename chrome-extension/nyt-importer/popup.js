// Popup that runs when the user clicks the toolbar icon. Reads the
// JSON-LD Recipe block from the active tab and POSTs it to the
// meal-planner-cart import endpoint with the user's bearer token.

const $ = (id) => document.getElementById(id);

document.getElementById('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getConfig() {
  const { token, apiBase } = await chrome.storage.sync.get(['token', 'apiBase']);
  return {
    token: token || '',
    apiBase: (apiBase || 'https://meals.alaskatargeting.com').replace(/\/$/, '')
  };
}

// Run inside the page to extract the @type=Recipe entry from the
// JSON-LD scripts. Schema.org Recipe can show up in a few shapes:
//   - top-level object: { "@type": "Recipe", ... }
//   - top-level array:  [ { "@type": "Recipe", ... }, ... ]
//   - inside @graph:    { "@graph": [ { "@type": "Recipe", ... } ] }
//   - nested as mainEntity: { "mainEntity": { "@type": "Recipe", ... } }
//   - @type as array:   { "@type": ["Recipe", "NewsArticle"], ... }
// Walks all of them recursively so a recipe wrapped in any common
// structure gets found. Returns the first Recipe-typed node it sees.
function extractRecipeFromPage() {
  function typeMatches(t) {
    if (!t) return false;
    if (typeof t === 'string') return t === 'Recipe';
    if (Array.isArray(t)) return t.includes('Recipe');
    return false;
  }
  function walk(node) {
    if (!node || typeof node !== 'object') return null;
    if (typeMatches(node['@type'])) return node;
    // Walk arrays + @graph + mainEntity + nested objects.
    if (Array.isArray(node)) {
      for (const item of node) { const hit = walk(item); if (hit) return hit; }
      return null;
    }
    if (Array.isArray(node['@graph'])) {
      for (const item of node['@graph']) { const hit = walk(item); if (hit) return hit; }
    }
    if (node.mainEntity) {
      const hit = walk(node.mainEntity);
      if (hit) return hit;
    }
    return null;
  }
  const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')];
  for (const b of blocks) {
    let data;
    try { data = JSON.parse(b.textContent); } catch (e) { continue; }
    const hit = walk(data);
    if (hit) return hit;
  }
  return null;
}

async function readJsonLd(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractRecipeFromPage
  });
  return results && results[0] ? results[0].result : null;
}

function show(elId)  { $(elId).hidden = false; }
function hide(elId) { $(elId).hidden = true; }
function showError(msg) {
  hide('status'); hide('preview'); hide('success');
  const e = $('error'); e.textContent = msg; e.hidden = false;
}
function showPreview(recipe) {
  hide('status');
  $('recipe-name').textContent = recipe.name || '(untitled)';
  const yield_ = recipe.recipeYield || '?';
  const time = (recipe.totalTime || '').replace('PT', '').toLowerCase().replace('h', 'h ').replace('m', 'm') || '?';
  const cat = (recipe.recipeCategory || '').split(',').map(s => s.trim()).filter(Boolean)[0] || '?';
  const ingCount = (recipe.recipeIngredient || []).length;
  $('recipe-meta').textContent = `${yield_} · ${time} · ${ingCount} ingredients · ${cat}`;
  show('preview');
}
function showSuccess(data, apiBase) {
  hide('status'); hide('preview'); hide('error');
  const msg = data.duplicate
    ? `Already in your library: "${data.name}"`
    : `✓ Imported "${data.name}"`;
  $('success-msg').textContent = msg;
  const link = $('open-recipe');
  if (data.recipe_id) {
    // Append ?just_clipped=1 so the recipe edit page knows to show the
    // one-time "scale to your household" prompt. Skip on duplicate
    // imports — those aren't fresh, the user already has them.
    const justClippedParam = data.duplicate ? '' : '&just_clipped=1';
    link.href = `${apiBase}/recipes?edit=${data.recipe_id}${justClippedParam}`;
    link.style.display = '';
  } else {
    link.style.display = 'none';
  }
  show('success');
}

async function importRecipe(recipe, tab) {
  const { token, apiBase } = await getConfig();
  if (!token) {
    showError('Set up your API token in extension Settings first.');
    return;
  }
  const btn = $('import-btn');
  btn.disabled = true;
  btn.textContent = 'Clipping…';
  try {
    const res = await fetch(`${apiBase}/api/recipes/import-nyt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ url: tab.url, json_ld: recipe })
    });
    const data = await res.json();
    if (data.ok) {
      showSuccess(data, apiBase);
    } else {
      showError(data.reason || 'Import failed.');
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  } catch (e) {
    showError('Network error: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Try again';
  }
}

(async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.url) { showError('No active tab.'); return; }
  // Skip the URL gate — any page with a schema.org Recipe JSON-LD block
  // works. NYT Cooking is the primary target, but Bon Appétit, Serious
  // Eats, food52, allrecipes, smitten kitchen, etc. all publish the same
  // structured format for Google. The JSON-LD walker decides whether
  // there's a recipe here; if not, we say so.
  let recipe;
  try {
    recipe = await readJsonLd(tab.id);
  } catch (e) {
    showError('Could not read page: ' + e.message);
    return;
  }
  if (!recipe) {
    showError('No recipe data found on this page. Open a recipe and try again.');
    return;
  }
  showPreview(recipe);
  $('import-btn').addEventListener('click', () => importRecipe(recipe, tab));
})();
