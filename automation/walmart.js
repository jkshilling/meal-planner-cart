// All Walmart-specific selectors and logic live in this module.
// Walmart aggressively changes its markup and uses bot protection, so treat these
// selectors as assumptions that may need tuning. See README for details.

const { chromium } = require('playwright');

const SEARCH_URL = (q) => `https://www.walmart.com/search?q=${encodeURIComponent(q)}`;

const SELECTORS = {
  resultCard: '[data-testid="list-view"] [data-item-id], [data-testid="item-stack"] [data-item-id], div[data-item-id]',
  resultName: 'span[data-automation-id="product-title"], span.lh-title, [data-automation-id="product-title"]',
  resultPrice: '[data-automation-id="product-price"] span.mr1, [data-automation-id="product-price"] span, div[data-automation-id="product-price"]',
  resultLink: 'a[link-identifier], a[href*="/ip/"]',
  resultSize: '[data-automation-id="product-price"] + div, span.gray, .f7.gray',
  addToCartButton: 'button[data-automation-id="atc"], button[aria-label^="Add to cart"], button:has-text("Add to cart")',
  cartConfirm: '[data-testid="cart-preview"], [data-automation-id="cart-preview"]',
  captcha: '[data-testid="captcha"], iframe[src*="captcha"], #px-captcha'
};

let _browser = null;
let _context = null;
let _page = null;

async function ensureBrowser() {
  if (_page && !_page.isClosed()) return _page;
  const headless = process.env.WALMART_HEADLESS === 'true';
  _browser = await chromium.launch({ headless });
  _context = await _browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });
  _page = await _context.newPage();
  return _page;
}

async function close() {
  try { if (_browser) await _browser.close(); } catch (e) {}
  _browser = null; _context = null; _page = null;
}

async function checkCaptchaOrLogin(page) {
  const hit = await page.$(SELECTORS.captcha);
  if (hit) {
    return { blocked: true, reason: 'captcha' };
  }
  return { blocked: false };
}

async function searchProducts(query, limit = 5) {
  const page = await ensureBrowser();
  await page.goto(SEARCH_URL(query), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  const block = await checkCaptchaOrLogin(page);
  if (block.blocked) return { blocked: true, candidates: [] };

  // Give the page a moment to render lazy content.
  await page.waitForTimeout(1500);

  const candidates = await page.evaluate((sel) => {
    const cards = Array.from(document.querySelectorAll(sel.resultCard));
    const out = [];
    for (const card of cards) {
      const nameEl = card.querySelector(sel.resultName);
      const priceEl = card.querySelector(sel.resultPrice);
      const linkEl = card.querySelector(sel.resultLink);
      const sizeEl = card.querySelector(sel.resultSize);
      const name = nameEl ? nameEl.textContent.trim() : '';
      const priceText = priceEl ? priceEl.textContent.replace(/[^0-9.]/g, '') : '';
      const price = priceText ? parseFloat(priceText) : null;
      const href = linkEl ? linkEl.getAttribute('href') : '';
      const url = href ? (href.startsWith('http') ? href : 'https://www.walmart.com' + href) : '';
      const size = sizeEl ? sizeEl.textContent.trim() : '';
      if (name && url) out.push({ name, price, url, size });
      if (out.length >= 10) break;
    }
    return out;
  }, SELECTORS);

  return { blocked: false, candidates: candidates.slice(0, limit) };
}

async function addToCart(productUrl) {
  const page = await ensureBrowser();
  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  const block = await checkCaptchaOrLogin(page);
  if (block.blocked) return { success: false, reason: 'captcha-or-login-wall' };
  const btn = await page.$(SELECTORS.addToCartButton);
  if (!btn) return { success: false, reason: 'add-to-cart-button-not-found' };
  try {
    await btn.click({ timeout: 10000 });
    await page.waitForTimeout(2000);
    return { success: true };
  } catch (e) {
    return { success: false, reason: 'click-failed: ' + e.message };
  }
}

async function openForManualLogin() {
  const page = await ensureBrowser();
  await page.goto('https://www.walmart.com/account/login', { waitUntil: 'domcontentloaded' }).catch(() => {});
  return page;
}

module.exports = {
  ensureBrowser,
  close,
  searchProducts,
  addToCart,
  openForManualLogin,
  SELECTORS
};
