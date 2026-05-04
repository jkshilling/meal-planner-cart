// LLM-assisted ingredient name normalization. Used as a last-resort
// fallback when our hand-rolled canonicalize() (services/usda.js) plus a
// USDA FoodData Central search both fail to find a match for an
// ingredient name.
//
// Why: canonicalize() is a static list of aliases + strip-words. It can
// only fix what we've manually anticipated ("non-fat milk" → "milk",
// "cremini mushrooms" → "mushrooms"). For long-tail variants the user
// types — "vidalia onion", "freshly cracked tellicherry pepper",
// "applewood smoked bacon" — there's no scalable way to maintain enough
// aliases by hand. An LLM does this kind of normalization trivially.
//
// Cost: gpt-4o-mini is roughly $0.0001 per call. We only invoke it when
// USDA returns zero candidates, AND the result (match or no-match) gets
// cached in nutrition_lookups, so each unique unmatched ingredient name
// triggers exactly one LLM call lifetime.
//
// Failure modes are silent: no API key, network error, malformed
// response, or a suggestion that USDA still can't match → we just cache
// the no-match like before. The fallback never makes things worse.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function apiKey() {
  return process.env.OPENAI_API_KEY || '';
}

function modelName() {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

// Few-shot prompt anchors the output format (single short lowercase name,
// no punctuation). The model should keep distinguishing words that change
// the food itself (sweet potato vs potato, ground beef vs beef) and drop
// modifiers USDA Foundation Foods doesn't differentiate on (brand, region,
// "freshly", "organic", quality grades, prep verbs).
const SYSTEM_PROMPT = [
  'Normalize a cooking ingredient name to a short canonical form that is',
  'likely to match the USDA FoodData Central database (Foundation Foods /',
  'SR Legacy datasets).',
  '',
  'Rules:',
  '- Output ONLY the normalized name. Lowercase. Plain text. No quotes,',
  '  no explanations, no trailing punctuation.',
  '- Drop brand names, region/variety qualifiers, prep verbs, freshness',
  '  states, and quality/processing modifiers when USDA would not',
  '  differentiate on them.',
  '- Keep words that meaningfully change the food itself (sweet potato,',
  '  ground beef, brown rice).',
  '- For ambiguous spice-vs-vegetable words, default to the form a recipe',
  '  most likely means: bare "pepper" almost always means black pepper',
  '  the spice (not bell pepper or jalapeño). Bare "salt" is table salt.',
  '  Bare "oil" is generic vegetable cooking oil.',
  '- If the input names multiple ingredients ("salt and pepper", "oil and',
  '  vinegar"), output only the FIRST ingredient — the caller will treat',
  '  the rest as a separate item.',
  '- If the input is already canonical, echo it back unchanged.',
  '',
  'Examples:',
  '  freshly grated parmigiano-reggiano cheese -> parmesan',
  '  organic baby spinach leaves -> spinach',
  '  smoked applewood bacon -> bacon',
  '  low-sodium canned chicken broth -> chicken broth',
  '  vidalia onion -> onion',
  '  extra virgin olive oil -> olive oil',
  '  sweet potato -> sweet potato',
  '  ground beef -> ground beef',
  '  pepper -> black pepper',
  '  oatmeal -> oats',
  '  salt and pepper -> salt',
  '  oil of frying -> vegetable oil',
  '  flour -> all-purpose flour'
].join('\n');

// Reject suggestions that are obviously bad output: too long, contain
// quotes/newlines/colons (a sign the model didn't follow the format),
// or are empty after trim. Better to fall through to no-match than to
// poison the cache with garbage.
function looksClean(s) {
  if (!s) return false;
  if (s.length > 60) return false;
  if (/[\n"'`:]/.test(s)) return false;
  return true;
}

// Best-effort canonical-name suggestion. Returns null on any failure
// (no key, network error, model error, malformed response). Callers
// must treat null as "no help — fall back to no-match."
async function suggestCanonical(rawName) {
  const key = apiKey();
  if (!key) return null;
  const name = (rawName || '').trim();
  if (!name) return null;

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: modelName(),
        // Deterministic so the same input always normalizes the same way
        // (matters because we cache the result — flaky outputs would mean
        // identical recipes import inconsistently).
        temperature: 0,
        max_tokens: 30,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: name }
        ]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string') return null;
    // Trim, lowercase, collapse whitespace. Strip surrounding quotes the
    // model occasionally sneaks in despite the prompt.
    let s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    s = s.replace(/^['"`]+|['"`]+$/g, '').trim();
    if (!looksClean(s)) return null;
    return s;
  } catch (e) {
    return null;
  }
}

// LLM-verify: ask the model whether USDA's top match is semantically
// reasonable for the ingredient as the user typed it. Used by
// services/usda.searchFood after FDC returns a candidate but before we
// commit it to the cache — catches USDA's heuristic-scoring mistakes
// like "cinnamon" → "Cinnamon buns, frosted" or "pepper" → "Pepper,
// banana, raw" that no static rule would consistently catch.
//
// Returns true (match looks reasonable), false (match looks wrong), or
// null (couldn't determine — no key, network error, model output didn't
// parse). Callers should treat null as "trust the static scoring" so
// failures here never make the system worse than it was before.
const VERIFY_PROMPT = [
  'You validate whether a USDA FoodData Central entry is a reasonable',
  'nutritional match for a recipe ingredient. The match is good when the',
  'matched entry has roughly the right macros (calories, fat, protein)',
  'for what a recipe usually means by the ingredient. Loose matches are',
  'fine — the match does not need to be exact.',
  '',
  'Reply with ONLY "yes" or "no". No explanation, no punctuation.',
  '',
  'Reject (reply "no") in any of these cases:',
  '- Match is a derivative product when the ingredient is the base.',
  '  Example: ingredient "cinnamon" matched to "Cinnamon buns" — buns are',
  '  a baked good containing cinnamon, not the spice itself.',
  '- Match is a babyfood, infant/toddler, or fortified-cereal formulation,',
  '  unless the ingredient explicitly says baby food.',
  '- Match is a branded prepared meal, restaurant entrée, snack mix,',
  '  candy, or beverage when the ingredient is a base ingredient.',
  '- Ingredient name describes multiple distinct items ("salt and pepper",',
  '  "oil and vinegar"). No single USDA entry can represent both.',
  '- Ingredient is an ambiguous spice/vegetable word and the match is the',
  '  vegetable form. Bare "pepper" almost always means black pepper the',
  '  spice (250 cal/100g), NOT bell, banana, hungarian, or any other raw',
  '  pepper variety (~30 cal/100g). Same logic: bare "salt" means table',
  '  salt; bare "oil" means a generic cooking oil.',
  '',
  'Accept (reply "yes") for sensible loose matches even if not exact.',
  '',
  'Examples of GOOD matches (reply yes):',
  '  ingredient: kosher salt            | usda: Salt, table',
  '  ingredient: extra virgin olive oil | usda: Oil, olive, salad or cooking',
  '  ingredient: ground beef            | usda: Beef, ground, raw',
  '  ingredient: lemon zest             | usda: Lemon peel, raw',
  '  ingredient: cinnamon               | usda: Spices, cinnamon, ground',
  '  ingredient: black pepper           | usda: Spices, pepper, black',
  '',
  'Examples of BAD matches (reply no):',
  '  ingredient: cinnamon       | usda: Cinnamon buns, frosted',
  '  ingredient: pepper         | usda: Peppers, hungarian, raw',
  '  ingredient: pepper         | usda: Pepper, banana, raw',
  '  ingredient: milk           | usda: Crackers, milk',
  '  ingredient: chicken        | usda: Chicken nuggets, frozen, breaded',
  '  ingredient: oatmeal        | usda: Babyfood, cereal, oatmeal, dry fortified',
  '  ingredient: oatmeal        | usda: Cookies, oatmeal, with raisins',
  '  ingredient: salt and pepper | usda: Peppers, sweet, green, cooked',
  '  ingredient: cocoa          | usda: Cocoa mix, NESTLE Hot Cocoa Mix'
].join('\n');

async function verifyMatch(ingredientName, usdaDescription) {
  const key = apiKey();
  if (!key) return null;
  const ing = (ingredientName || '').trim();
  const usda = (usdaDescription || '').trim();
  if (!ing || !usda) return null;

  const userMsg = `ingredient: ${ing} | usda: ${usda}`;
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: modelName(),
        temperature: 0,
        max_tokens: 3,  // "yes" / "no" — never need more
        messages: [
          { role: 'system', content: VERIFY_PROMPT },
          { role: 'user',   content: userMsg }
        ]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== 'string') return null;
    const norm = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
    if (norm === 'yes') return true;
    if (norm === 'no')  return false;
    // Some other output — bail rather than guess.
    return null;
  } catch (e) {
    return null;
  }
}

function isEnabled() {
  return !!apiKey();
}

module.exports = { suggestCanonical, verifyMatch, isEnabled };
