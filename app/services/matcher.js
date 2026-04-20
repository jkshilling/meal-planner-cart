const db = require('../db');

// Simple string similarity: token Jaccard.
function tokens(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}
function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function sizeCloseness(wantedUnit, productSize) {
  if (!productSize) return 0.5;
  const u = (wantedUnit || '').toLowerCase();
  const p = productSize.toLowerCase();
  if (!u) return 0.5;
  if (p.includes(u)) return 1;
  // handle common aliases
  const aliases = { oz: ['ounce', 'oz'], lb: ['pound', 'lb'], gal: ['gallon', 'gal'], qt: ['quart', 'qt'], count: ['ct', 'count', 'pack'] };
  for (const k of Object.keys(aliases)) {
    if (aliases[k].includes(u) && aliases[k].some(a => p.includes(a))) return 0.9;
  }
  return 0.4;
}

function rankCandidates(item, candidates) {
  const scored = candidates.map(c => {
    const sim = similarity(item.name + ' ' + (item.brand_preference || ''), c.name);
    const brandBoost = item.brand_preference && c.name.toLowerCase().includes(item.brand_preference.toLowerCase()) ? 0.2 : 0;
    const sizeScore = sizeCloseness(item.unit, c.size);
    const priceKnown = typeof c.price === 'number' && c.price > 0;
    const priceScore = priceKnown ? Math.max(0, 1 - Math.min(1, c.price / 20)) : 0.3;
    const total = sim * 0.6 + brandBoost + sizeScore * 0.2 + priceScore * 0.1;
    return { ...c, sim, total };
  });
  scored.sort((a, b) => b.total - a.total);
  return scored;
}

function confidenceFor(best) {
  if (!best) return 'low';
  if (best.sim >= 0.6 || best.total >= 0.75) return 'high';
  if (best.sim >= 0.35 || best.total >= 0.5) return 'medium';
  return 'low';
}

function saveMatch(itemId, ranked) {
  const best = ranked[0] || null;
  const confidence = confidenceFor(best);
  db.prepare('DELETE FROM walmart_matches WHERE shopping_item_id = ?').run(itemId);
  db.prepare(`INSERT INTO walmart_matches
    (shopping_item_id, product_name, product_url, product_price, product_size, confidence, approved, candidates_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      itemId,
      best ? best.name : null,
      best ? best.url : null,
      best ? best.price : null,
      best ? best.size : null,
      confidence,
      confidence === 'high' ? 1 : 0,
      JSON.stringify(ranked.slice(0, 5))
    );
}

function approveMatch(itemId, candidateIndex) {
  const match = db.prepare('SELECT * FROM walmart_matches WHERE shopping_item_id = ?').get(itemId);
  if (!match) return;
  const candidates = match.candidates_json ? JSON.parse(match.candidates_json) : [];
  const pick = candidates[candidateIndex] || candidates[0];
  if (!pick) return;
  db.prepare(`UPDATE walmart_matches SET
    product_name = ?, product_url = ?, product_price = ?, product_size = ?, approved = 1
    WHERE shopping_item_id = ?`)
    .run(pick.name, pick.url, pick.price, pick.size, itemId);
}

function setApproval(itemId, approved) {
  db.prepare('UPDATE walmart_matches SET approved = ? WHERE shopping_item_id = ?').run(approved ? 1 : 0, itemId);
}

module.exports = { rankCandidates, saveMatch, approveMatch, setApproval, confidenceFor, similarity };
