// ==UserScript==
// @name         Walmart Smart Cart Builder
// @namespace    https://github.com/ZodchiSama
// @version      1.2.1
// @description  Paste a shopping list, review the best match for each line (price, unit price, rating, rollbacks and sales, store brand), then add everything to your cart automatically. Fixes misspellings and learns your picks. Unofficial; not affiliated with Walmart.
// @author       Zodchi
// @license      MIT
// @homepageURL  https://github.com/ZodchiSama/walmart-smart-cart-builder
// @supportURL   https://github.com/ZodchiSama/walmart-smart-cart-builder/issues
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%230071dc' d='M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM1 2v2h2l3.6 7.6L5.2 14A2 2 0 0 0 7 17h12v-2H7.4l1.1-2h7.4a2 2 0 0 0 1.8-1l3.6-6.5A1 1 0 0 0 20.4 4H5.2l-.9-2z'/%3E%3C/svg%3E
// @match        https://www.walmart.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Storage
   * ------------------------------------------------------------------ */
  const K = {
    settings: 'wscb.settings',
    lists: 'wscb.lists',
    memory: 'wscb.memory',
    job: 'wscb.job',
    draft: 'wscb.draft',
    open: 'wscb.open',
  };

  const DEFAULT_SETTINGS = {
    strategy: 'smart', // smart | deals | cheapest | unit | rated
    preferDeals: true,
    preferStore: true,
    storeBrands: "Great Value, Equate, Mainstays, Parent's Choice, Marketside, Freshness Guaranteed, Sam's Choice, bettergoods, Spring Valley, Hyper Tough, Pen+Gear, Ozark Trail",
    skipSponsored: true,
    inStockOnly: true,
    minRating: 0,
    minMatch: 0.6,
    useMemory: true,
    delayMs: 900,
    // Fee estimate (walmart.com/help, fall 2026). Editable in Settings since they vary by area.
    fulfillment: 'delivery', // delivery | pickup | shipping
    deliveryFee: 9.95,       // store delivery, non-members only
    smallOrderFee: 6.99,     // orders under the minimum
    orderMinimum: 35,
  };

  const load = (k, d) => {
    try { const v = GM_getValue(k); return v === undefined ? d : v; } catch { return d; }
  };
  const save = (k, v) => GM_setValue(k, v);

  let settings = { ...DEFAULT_SETTINGS, ...load(K.settings, {}) };
  const getMemory = () => load(K.memory, {});
  const getJob = () => load(K.job, null);
  const setJob = (j) => save(K.job, j);

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (ms) => ms + Math.floor(Math.random() * 400);
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => (n == null || isNaN(n) ? '—' : '$' + n.toFixed(2));
  const visible = (el) => !!el && el.offsetParent !== null;

  async function waitFor(fn, timeout = 10000, onTick) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      if (onTick) onTick();
      await sleep(350);
    }
    return null;
  }

  const stem = (w) => (w.length > 3 ? w.replace(/ies$/, 'y').replace(/(?:es|s)$/, '') : w);
  const tokens = (s) =>
    norm(s).replace(/[^a-z0-9%.\s]/g, ' ').split(/\s+/).filter((w) => w && w !== '.').map(stem);

  function lev(a, b) {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // Close enough to be a typo: 1 edit for 5–6 letters, 2 edits for 7+. Shorter words are too
  // ambiguous (milk/silk, rice/mice) — Walmart's own spelling fix covers those.
  const isTypoOf = (word, typed) =>
    typed.length >= 5 &&!/\d/.test(typed) && Math.abs(word.length - typed.length) <= 2 &&
    lev(word, typed) <= (typed.length >= 7 ? 2 : 1);

  const memKey = (line) =>norm(line.query) + (line.brand ? ' !' + line.brand : '');

  const isChallengePage = () =>
    /robot or human/i.test(document.title) ||
    !!document.querySelector('#px-captcha') ||
    location.pathname.startsWith('/blocked');

  /* ------------------------------------------------------------------ *
   * List parsing
   *   2 milk gallon          -> qty 2
   *   eggs 18 ct @5          -> max price $5
   *   yogurt -vanilla        -> exclude "vanilla"
   *   milk !fairlife         -> brand must contain "fairlife"
   *   bananas x3             -> qty 3
   *   # comment
   * ------------------------------------------------------------------ */
  const UNIT_WORDS = '(?:ct|count|oz|fl|lb|lbs|pk|pack|gal|gallon|g|kg|ml|l|qt|pt|in|ft|inch|roll|rolls|sheet|sheets)\\b';

  function parseLine(raw) {
    let s = raw.replace(/#.*/, '').trim();
    if (!s) return null;
    let qty = 1, maxPrice = null, brand = null;
    const exclude = [];
    s = s.replace(new RegExp(`^(\\d{1,3})\\s*x?\\s+(?!${UNIT_WORDS})`, 'i'), (_, n) => { qty = +n; return ''; });
    s = s.replace(/\s+x\s*(\d{1,3})$/i, (_, n) => { qty = +n; return ''; });
    s = s.replace(/@\s*\$?(\d+(?:\.\d+)?)/, (_, n) => { maxPrice = +n; return ' '; });
    s = s.replace(/(^|\s)!(?:"([^"]+)"|(\S+))/, (_, sp, q, w) => { brand = norm(q || w); return ' '; });
    s = s.replace(/(^|\s)-([a-z0-9][\w'-]*)/gi, (_, sp, w) => { exclude.push(stem(w.toLowerCase())); return ' '; });
    const query = s.replace(/\s+/g, ' ').trim();
    return query ? { raw, qty: Math.max(1, qty), maxPrice, brand, exclude, query } : null;
  }

  /* ------------------------------------------------------------------ *
   * Size / unit price parsing from product names
   * ------------------------------------------------------------------ */
  const UNITS = {
    'fl oz': ['vol', 1], 'fl. oz': ['vol', 1], floz: ['vol', 1],
    oz: ['wt', 1], ounce: ['wt', 1], ounces: ['wt', 1],
    lb: ['wt', 16], lbs: ['wt', 16], pound: ['wt', 16], pounds: ['wt', 16],
    g: ['wt', 0.035274], kg: ['wt', 35.274],
    ml: ['vol', 0.033814], l: ['vol', 33.814], liter: ['vol', 33.814], litre: ['vol', 33.814],
    gal: ['vol', 128], gallon: ['vol', 128], qt: ['vol', 32], quart: ['vol', 32], pt: ['vol', 16], pint: ['vol', 16],
  };
  const UNIT_LABEL = { vol: 'fl oz', wt: 'oz', ct: 'ct' };

  function parseSize(name) {
    const n = norm(name);
    let amount = null;
    const m = n.match(/(\d+(?:\.\d+)?)\s*(fl\.? ?oz|floz|ounces?|oz|pounds?|lbs?|kg|g|ml|liters?|litres?|l|gallons?|gal|quarts?|qt|pints?|pt)\b/);
    if (m) {
      const key = m[2].replace(/s$/, '').replace(/^fl\.? ?oz$/, 'fl oz');
      const u = UNITS[key] || UNITS[m[2]];
      if (u) amount = { dim: u[0], qty: parseFloat(m[1]) * u[1] };
    } else if (/\bhalf gallon\b/.test(n)) amount = { dim: 'vol', qty: 64 };
    else if (/\bgallon\b/.test(n)) amount = { dim: 'vol', qty: 128 };

    const c = n.match(/(\d+)\s*(?:-\s*)?(?:ct|count|pk|pack|pc|pcs|piece|pieces|rolls?)\b/) || n.match(/\b(\d+)\s*x\s*\d/);
    const count = c ? parseInt(c[1], 10) : null;

    if (amount && count && count > 1 && count <= 100) return { dim: amount.dim, qty: amount.qty * count };
    if (amount) return amount;
    if (count) return { dim: 'ct', qty: count };
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Search (same-origin fetch of the search page, read __NEXT_DATA__)
   * ------------------------------------------------------------------ */
  class BlockedError extends Error {
    constructor() { super('Walmart bot check triggered — open any Walmart page, complete the check, then retry.'); this.blocked = true; }
  }

  const searchCache = new Map();

  // Returns { products, corrected } — corrected is Walmart's spelling fix for the query, if it made one.
  async function search(query) {
    if (searchCache.has(query)) return searchCache.get(query);
    const r = await fetch('/search?q=' + encodeURIComponent(query), { credentials: 'include' });
    if (r.url.includes('/blocked')) throw new BlockedError();
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new BlockedError();
    const data = JSON.parse(m[1]);
    const result = data?.props?.pageProps?.initialData?.searchResult || {};
    const products = (result.itemStacks || [])
      .flatMap((s) => s.items || [])
      .filter((i) => i && i.__typename === 'Product' && i.name && i.usItemId)
      .map(toProduct);
    const fix = result.spelling?.correctedTerm;
    const out = { products, corrected: fix && norm(fix) !== norm(query) ? norm(fix) : null };
    searchCache.set(query, out);
    return out;
  }

  const DEAL_LABELS = { ROLLBACK: 'Rollback', CLEARANCE: 'Clearance', REDUCED_PRICE: 'Reduced price', TODAYS_DEAL: "Today's deal", SALE: 'On sale' };
  const parseMoney = (v) => parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));

  function dealInfo(i, price) {
    const b = i.badges || {};
    const keys = [...(b.flags || []), ...(b.tags || [])].map((x) => x?.key);
    const badge = ['ROLLBACK', 'CLEARANCE', 'REDUCED_PRICE', 'TODAYS_DEAL'].find((k) => keys.includes(k)) || null;
    let was = parseMoney(i.priceInfo?.wasPrice);
    if (!(was > 0)) {
      const cmp = (i.priceInfo?.priceDetails?.priceLines || []).find((l) => l.lineType === 'COMPARISON');
      was = parseMoney(cmp?.values?.find((v) => v.key === 'WAS_PRICE')?.value);
    }
    if (!(price > 0 && was > price)) was = null;
    return { deal: badge || (was ? 'SALE' : null), wasPrice: was, savePct: was ? (was - price) / was : 0 };
  }

  function toProduct(i, rank) {
    let price = parseFloat(i.price);
    if (!(price > 0)) price = parseMoney(i.priceInfo?.linePrice || i.priceInfo?.itemPrice);
    const status = i.availabilityStatusV2?.value || i.availabilityStatus;
    const size = parseSize(i.name);
    return {
      ...dealInfo(i, price),
      id: i.id,
      usItemId: String(i.usItemId),
      name: i.name,
      brand: i.brand || '',
      price: price > 0 ? price : null,
      rating: parseFloat(i.averageRating) || 0,
      reviews: parseInt(i.numberOfReviews, 10) || 0,
      inStock: status ? status === 'IN_STOCK' : !i.isOutOfStock,
      canAdd: i.canAddToCart !== false,
      hasOptions: !!i.showOptions,
      sponsored: !!i.isSponsoredFlag,
      seller: i.sellerName || '',
      rank,
      size,
      unitPrice: price > 0 && size ? price / size.qty : null,
    };
  }

  /* ------------------------------------------------------------------ *
   * Ranking
   * ------------------------------------------------------------------ */
  const WEIGHTS = {
    smart:    { rel: 3,   rank: 1.5, rating: 1,   price: 1,   unit: 1,   deal: 1.5 },
    deals:    { rel: 3,   rank: 0.5, rating: 0.5, price: 0.5, unit: 0.5, deal: 4 },
    cheapest: { rel: 1.5, rank: 0.3, rating: 0.3, price: 4,   unit: 0,   deal: 1 },
    unit:     { rel: 1.5, rank: 0.3, rating: 0.3, price: 0.5, unit: 4,   deal: 0.5 },
    rated:    { rel: 1.5, rank: 0.5, rating: 4,   price: 0.3, unit: 0,   deal: 0.3 },
  };

  // Query word found in the product name: exact, as a prefix, or as a likely typo (worth a bit less).
  function wordHit(nameTokens, t) {
    if (nameTokens.has(t)) return 1;
    for (const n of nameTokens) {
      if (t.length > 2 && n.startsWith(t)) return 1;
      if (isTypoOf(n, t)) return 0.85;
    }
    return 0;
  }

  // When Walmart didn't fix the spelling, rebuild the query from the best match's own words.
  function localCorrection(query, product) {
    if (!product) return null;
    const nameWords = norm(product.brand + ' ' + product.name).replace(/[^a-z0-9%.\s'-]/g, ' ').split(/\s+/).filter(Boolean);
    const nameStems = new Set(nameWords.map(stem));
    let changed = false;
    const fixed = norm(query).split(' ').map((w) => {
      if (nameStems.has(stem(w)) || nameWords.some((n) => w.length > 2 && n.startsWith(w))) return w;
      const best = nameWords.filter((n) => isTypoOf(n, w)).sort((a, b) => lev(a, w) - lev(b, w))[0];
      if (!best) return w;
      changed = true;
      return best;
    });
    return changed ? fixed.join(' ') : null;
  }

  function rankProducts(products, line) {
    const qTokens = [...new Set(tokens(line.query))];
    const storeBrands = settings.storeBrands.split(',').map(norm).filter(Boolean);
    const total = products.length || 1;

    const pool = products
      .map((p) => {
        const nameTokens = new Set(tokens(p.name + ' ' + p.brand));
        const hit = qTokens.reduce((s, t) => s + wordHit(nameTokens, t), 0);
        return { ...p, relevance: qTokens.length ? hit / qTokens.length : 0, _tokens: nameTokens };
      })
      .filter((p) => {
        if (!p.canAdd || p.price == null) return false;
        if (settings.inStockOnly && !p.inStock) return false;
        if (settings.skipSponsored && p.sponsored) return false;
        if (line.maxPrice != null && p.price > line.maxPrice) return false;
        if (settings.minRating && p.reviews > 0 && p.rating < settings.minRating) return false;
        if (line.exclude.some((x) => p._tokens.has(x))) return false;
        if (line.brand && !norm(p.brand + ' ' + p.name).includes(line.brand)) return false;
        return p.relevance >= Math.min(settings.minMatch, 1);
      });

    if (!pool.length) return [];

    const minPrice = Math.min(...pool.map((p) => p.price));
    // Unit price only compares like-for-like: use the most common dimension in the pool.
    const dims = {};
    pool.forEach((p) => p.size && (dims[p.size.dim] = (dims[p.size.dim] || 0) + 1));
    const dim = Object.keys(dims).sort((a, b) => dims[b] - dims[a])[0];
    const unitPool = pool.filter((p) => p.unitPrice && p.size.dim === dim);
    const minUnit = unitPool.length ? Math.min(...unitPool.map((p) => p.unitPrice)) : null;

    const w = WEIGHTS[settings.strategy] || WEIGHTS.smart;
    pool.forEach((p) => {
      const bayes = (p.rating * p.reviews + 4 * 20) / (p.reviews + 20);
      const ratingScore = Math.max(0, Math.min(1, (bayes - 3) / 2));
      const unitScore = minUnit && p.unitPrice && p.size.dim === dim ? minUnit / p.unitPrice : 0.4;
      const isStore = storeBrands.some((b) => norm(p.brand).includes(b) || norm(p.name).startsWith(b));
      p.isStore = isStore;
      // Any rollback/sale gets a base boost; bigger discounts (up to 50%) get more.
      const dealScore = p.deal ? 0.5 + Math.min(p.savePct, 0.5) : 0;
      p.score =
        w.rel * p.relevance +
        w.rank * (1 - p.rank / total) +
        w.rating * ratingScore +
        w.price * (minPrice / p.price) +
        w.unit * unitScore +
        (settings.preferDeals || settings.strategy === 'deals' ? w.deal * dealScore : 0) +
        (settings.preferStore && isStore ? 0.75 : 0);
      delete p._tokens;
    });
    pool.sort((a, b) => b.score - a.score);

    if (settings.useMemory) {
      const remembered = getMemory()[memKey(line)];
      const idx = remembered ? pool.findIndex((p) => p.usItemId === remembered.usItemId) : -1;
      if (idx >= 0) {
        const [p] = pool.splice(idx, 1);
        p.remembered = true;
        pool.unshift(p);
      }
    }
    return pool;
  }

  function remember(line, product) {
    const mem = getMemory();
    mem[memKey(line)] = { usItemId: product.usItemId, name: product.name, at: Date.now() };
    save(K.memory, mem);
  }

  /* ------------------------------------------------------------------ *
   * Cart automation (runs across page loads via a stored job)
   * ------------------------------------------------------------------ */
  function tileOf(el) {
    let n = el;
    for (let i = 0; i < 8 && n && n !== document.body; i++) {
      if (n.querySelector && n.querySelector('a[href*="/ip/"]')) return n;
      n = n.parentElement;
    }
    return null;
  }

  function findSearchAddButton(it) {
    const name = norm(it.name);
    const btns = [...document.querySelectorAll('button[data-automation-id="add-to-cart"]')];
    return (
      btns.find((b) => norm(b.getAttribute('aria-label')).includes(name)) ||
      btns.find((b) => b.closest('[data-item-id]')?.getAttribute('data-item-id') === it.id)
    );
  }

  function findPdpAddButton() {
    const btns = [...document.querySelectorAll('button')].filter(visible);
    return (
      btns.find((b) => b.getAttribute('data-dca-name') === 'ItemBuyBoxAddToCartButton') ||
      btns.find((b) => /^add to cart$/i.test(b.textContent.trim()))
    );
  }

  function findIncrease(scope, it) {
    const sel = 'button[aria-label*="increase" i]';
    const name = norm(it.name);
    const scoped = scope && document.contains(scope) ? scope.querySelector(sel) : null;
    if (scoped) return scoped;
    const all = [...document.querySelectorAll(sel)];
    return all.find((b) => norm(b.getAttribute('aria-label')).includes(name)) || (it.mode === 'pdp' ? all.find(visible) : null);
  }

  const currentQty = (btn) => {
    const m = (btn?.getAttribute('aria-label') || '').match(/current quantity\s*(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  };
  const enabled = (b) => b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';

  // Returns 'added' | 'unverified' | false
  async function addOnPage(it) {
    const onSearch = it.mode !== 'pdp';
    let scrolled = 0;
    const target = await waitFor(
      () => {
        const add = onSearch ? findSearchAddButton(it) : findPdpAddButton();
        if (add) return { kind: 'add', el: add };
        const inc = findIncrease(null, it);
        if (inc) return { kind: 'stepper', el: inc }; // already in cart
        return null;
      },
      onSearch ? 14000 : 10000,
      () => { if (onSearch && scrolled < 12) { window.scrollBy(0, 900); scrolled++; } }
    );
    if (!target) return false;

    const scope = tileOf(target.el);
    target.el.scrollIntoView({ block: 'center' });
    await sleep(400);

    let have = 0;
    if (target.kind === 'add') {
      target.el.click();
      const inc = await waitFor(() => findIncrease(scope, it), 8000);
      if (!inc) return document.contains(target.el) ? false : 'unverified';
      have = currentQty(inc) ?? 1;
    } else {
      have = currentQty(target.el) ?? 1;
    }

    // "qty" means: make sure the cart holds at least this many.
    while (have < it.qty) {
      const b = await waitFor(() => { const x = findIncrease(scope, it); return enabled(x) ? x : null; }, 6000);
      if (!b) { it.note = `quantity stopped at ${have}`; break; }
      b.click();
      have++;
      await sleep(jitter(650));
    }
    return 'added';
  }

  const isOnSearchFor = (q) => location.pathname === '/search' && new URLSearchParams(location.search).get('q') === q;
  const isOnPdpFor = (id) => location.pathname.startsWith('/ip/') && location.pathname.split('/').includes(id);

  let jobRunning = false;
  async function runJob() {
    if (jobRunning) return;
    jobRunning = true;
    try {
      while (true) {
        const job = getJob();
        if (!job || job.status !== 'running') break;
        renderJob();

        if (isChallengePage()) {
          job.status = 'paused';
          job.message = 'Walmart is showing a human check. Complete it yourself, then press Resume.';
          setJob(job);
          break;
        }

        const it = job.items[job.idx];
        if (!it) {
          job.status = 'done';
          setJob(job);
          renderJob();
          if (!location.pathname.startsWith('/cart')) location.href = '/cart';
          break;
        }

        it.status = 'working';
        const onTarget = it.mode === 'pdp' ? isOnPdpFor(it.usItemId) : isOnSearchFor(it.query);
        if (!onTarget) {
          it.visits = (it.visits || 0) + 1;
          if (it.visits > 2) {
            if (it.mode !== 'pdp') { it.mode = 'pdp'; it.visits = 0; setJob(job); continue; }
            it.status = 'failed'; it.note = 'page would not load';
            job.idx++; setJob(job); continue;
          }
          setJob(job);
          location.href = it.mode === 'pdp' ? `/ip/${it.usItemId}` : '/search?q=' + encodeURIComponent(it.query);
          break; // script resumes on next page load
        }

        const result = await addOnPage(it);
        const fresh = getJob();
        if (!fresh || fresh.status !== 'running') break; // stopped mid-item
        if (result) {
          it.status = result;
          remember(it.line, it);
        } else if (it.mode !== 'pdp') {
          it.mode = 'pdp'; it.visits = 0; it.status = 'pending';
          job.items[job.idx] = it; setJob(job);
          continue;
        } else {
          it.status = 'failed';
          it.note = it.hasOptions ? 'needs a size/flavor choice' : 'add button not found';
        }
        job.items[job.idx] = it;
        job.idx++;
        setJob(job);
        await sleep(jitter(settings.delayMs));
      }
    } finally {
      jobRunning = false;
      renderJob();
    }
  }

  function startJob(rowsToAdd) {
    const items = rowsToAdd.map((r) => {
      const p = r.candidates[r.pick];
      return {
        line: r.line, query: r.line.query, qty: r.line.qty,
        id: p.id, usItemId: p.usItemId, name: p.name, price: p.price, hasOptions: p.hasOptions,
        mode: p.hasOptions ? 'pdp' : 'search', status: 'pending',
      };
    });
    setJob({ status: 'running', idx: 0, items, startedAt: Date.now() });
    view = 'job';
    render();
    runJob();
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */
  let view = 'list'; // list | settings | job
  let rows = [];
  let finding = false;
  let stopFind = false;
  let notice = '';

  const host = document.createElement('div');
  host.id = 'wscb-host';
  const root = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .fab { position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; background: #0071dc; color: #fff;
      border: 0; border-radius: 999px; padding: 11px 16px; font-size: 14px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 14px rgba(0,0,0,.25); }
    .fab:hover { background: #004f9a; }
    .panel { position: fixed; right: 18px; bottom: 70px; z-index: 2147483647; width: min(480px, calc(100vw - 32px));
      max-height: min(78vh, 760px); display: none; flex-direction: column; background: #fff; color: #1d1d1f;
      border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.28); overflow: hidden; font-size: 13px; }
    .panel.open { display: flex; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #0071dc; color: #fff; }
    header h1 { font-size: 14px; margin: 0; flex: 1; font-weight: 700; }
    header button { background: rgba(255,255,255,.18); color: #fff; border: 0; border-radius: 6px; padding: 4px 9px; cursor: pointer; font-size: 12px; }
    header button.on { background: #ffc220; color: #1d1d1f; }
    .body { padding: 12px; overflow: auto; flex: 1; }
    textarea { width: 100%; min-height: 130px; resize: vertical; border: 1px solid #c9ccd1; border-radius: 8px; padding: 8px;
      font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: #1d1d1f; background: #fff; }
    .hint { color: #5f6368; font-size: 11.5px; margin: 6px 0 10px; line-height: 1.45; }
    .hint code { background: #f1f3f4; padding: 0 3px; border-radius: 3px; font-family: ui-monospace, monospace; }
    .bar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
    .bar .grow { flex: 1; }
    button.btn { border: 1px solid #c9ccd1; background: #fff; color: #1d1d1f; border-radius: 999px; padding: 6px 12px;
      cursor: pointer; font-size: 12.5px; font-weight: 600; }
    button.btn:hover { background: #f4f6f8; }
    button.primary { background: #0071dc; border-color: #0071dc; color: #fff; }
    button.primary:hover { background: #004f9a; }
    button.btn:disabled { opacity: .45; cursor: default; }
    select, input[type=number], input[type=text] { border: 1px solid #c9ccd1; border-radius: 6px; padding: 4px 6px; font-size: 12.5px; background: #fff; color: #1d1d1f; max-width: 100%; }
    .row { border: 1px solid #e3e5e8; border-radius: 10px; padding: 8px; margin-bottom: 7px; }
    .row.off { opacity: .5; }
    .row .top { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
    .row .q { font-weight: 700; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row select { width: 100%; }
    .meta { color: #5f6368; font-size: 11.5px; margin-top: 4px; display: flex; gap: 8px; flex-wrap: wrap; }
    .tag { font-size: 10.5px; padding: 1px 6px; border-radius: 999px; background: #e6f1fc; color: #004f9a; font-weight: 600; }
    .tag.warn { background: #fff4ce; color: #7a5b00; }
    .tag.bad { background: #fde7e9; color: #a4262c; }
    .tag.good { background: #e3f4e1; color: #2a7a1f; }
    .tag.deal { background: #ffe1e1; color: #b3000c; }
    .saved { color: #b3000c; }
    footer { flex-wrap: wrap; }
    .costs { flex-basis: 100%; display: grid; gap: 3px; margin-bottom: 6px; padding-bottom: 8px; border-bottom: 1px solid #e3e5e8; }
    .costs > div { display: flex; justify-content: space-between; gap: 8px; }
    .costs small { color: #5f6368; font-weight: 400; font-size: 11px; }
    .costs > div small { margin-left: 4px; }
    .meta s { color: #8a8f96; }
    footer { padding: 10px 12px; border-top: 1px solid #e3e5e8; display: flex; align-items: center; gap: 8px; background: #fafbfc; }
    footer .total { flex: 1; font-weight: 700; }
    .notice { background: #fff4ce; color: #5c4400; padding: 8px 10px; border-radius: 8px; margin-bottom: 10px; font-size: 12px; }
    label.opt { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
    label.opt span { flex: 1; }
    .field { margin: 10px 0; }
    .field > div { font-weight: 600; margin-bottom: 4px; }
    .field input[type=text] { width: 100%; }
    .progress { height: 6px; border-radius: 3px; background: #e3e5e8; overflow: hidden; margin: 6px 0 12px; }
    .progress > i { display: block; height: 100%; background: #0071dc; }
    a { color: #0071dc; }
  </style>
  <button class="fab" part="fab">🛒 Cart Builder</button>
  <div class="panel">
    <header>
      <h1>Smart Cart Builder</h1>
      <button data-view="list">List</button>
      <button data-view="job">Progress</button>
      <button data-view="settings">Settings</button>
      <button data-act="close" title="Close">✕</button>
    </header>
    <div class="body"></div>
    <footer></footer>
  </div>`;

  const $fab = root.querySelector('.fab');
  const $panel = root.querySelector('.panel');
  const $body = root.querySelector('.body');
  const $footer = root.querySelector('footer');

  const setOpen = (open) => { $panel.classList.toggle('open', open); save(K.open, open); if (open) render(); };
  $fab.addEventListener('click', () => setOpen(!$panel.classList.contains('open')));

  // Item prices are the same for everyone; Walmart+ only changes the fees.
  function feeEstimate(subtotal) {
    const s = settings;
    const small = subtotal < s.orderMinimum;
    const fees = { member: [], nonMember: [] };
    const smallLabel = `Under $${s.orderMinimum} fee`;
    if (s.fulfillment === 'delivery') {
      fees.nonMember.push(['Delivery fee', s.deliveryFee]);
      if (small) {
        fees.nonMember.push([smallLabel, s.smallOrderFee]);
        fees.member.push([smallLabel, s.smallOrderFee]);
      }
    } else if (s.fulfillment === 'shipping' && small) {
      fees.nonMember.push([smallLabel, s.smallOrderFee]);
    }
    const sum = (list) => list.reduce((t, [, v]) => t + v, 0);
    return {
      nonMember: { fees: fees.nonMember, total: subtotal + sum(fees.nonMember) },
      member: { fees: fees.member, total: subtotal + sum(fees.member) },
    };
  }

  function costSummary(subtotal) {
    const est = feeEstimate(subtotal);
    const feeList = (fees) => (fees.length ? fees.map(([k, v]) => `${esc(k)} ${money(v)}`).join(' + ') : 'no fees');
    const how = { delivery: 'delivery', pickup: 'pickup', shipping: 'shipping' }[settings.fulfillment];
    return `
      <div class="costs">
        <div><span>Items total</span><b>${money(subtotal)}</b></div>
        <div><span>Without Walmart+ <small>${feeList(est.nonMember.fees)}</small></span><b>${money(est.nonMember.total)}</b></div>
        <div><span>With Walmart+ <small>${feeList(est.member.fees)}</small></span><b>${money(est.member.total)}</b></div>
        <small>Estimate for ${how}, before tax and tip. Change fees in Settings.</small>
      </div>`;
  }

  const dealText = (p) =>
    p.deal ? DEAL_LABELS[p.deal] + (p.wasPrice ? ` −${Math.round(p.savePct * 100)}% (was ${money(p.wasPrice)})` : '') : '';

  function candidateLabel(p) {
    const bits = [money(p.price), p.name.length > 70 ? p.name.slice(0, 68) + '…' : p.name];
    if (p.deal) bits.unshift('🔻 ' + DEAL_LABELS[p.deal] + (p.wasPrice ? ` −${Math.round(p.savePct * 100)}%` : ''));
    if (p.unitPrice) bits.push(`${(p.unitPrice * 100).toFixed(1)}¢/${UNIT_LABEL[p.size.dim]}`);
    if (p.reviews) bits.push(`★${p.rating.toFixed(1)} (${p.reviews >= 1000 ? Math.round(p.reviews / 1000) + 'k' : p.reviews})`);
    return bits.join(' · ');
  }

  function renderList() {
    const lists = load(K.lists, {});
    const names = Object.keys(lists).sort();
    const draft = load(K.draft, '');
    const included = rows.filter((r) => r.include && r.pick >= 0);
    const total = included.reduce((s, r) => s + r.candidates[r.pick].price * r.line.qty, 0);
    const saved = included.reduce((s, r) => {
      const p = r.candidates[r.pick];
      return s + (p.wasPrice ? (p.wasPrice - p.price) * r.line.qty : 0);
    }, 0);

    $body.innerHTML = `
      ${notice ? `<div class="notice">${esc(notice)}</div>` : ''}
      <div class="bar">
        <select data-k="savedList"><option value="">Saved lists…</option>${names.map((n) => `<option>${esc(n)}</option>`).join('')}</select>
        <button class="btn" data-act="saveList">Save</button>
        <button class="btn" data-act="deleteList" ${names.length ? '' : 'disabled'}>Delete</button>
      </div>
      <textarea spellcheck="false" placeholder="2 whole milk gallon&#10;eggs 18 ct @5&#10;bananas&#10;greek yogurt -vanilla x4&#10;sparkling water !lacroix">${esc(draft)}</textarea>
      <div class="hint">
        One item per line. <code>2 milk</code> or <code>milk x2</code> quantity ·
        <code>@5</code> max price · <code>-word</code> exclude · <code>!brand</code> require brand · <code># note</code> ignored.
      </div>
      <div class="bar">
        <button class="btn primary" data-act="find" ${finding ? 'disabled' : ''}>${finding ? 'Searching…' : (rows.length ? 'Search again' : 'Find items')}</button>
        ${finding ? '<button class="btn" data-act="stopFind">Stop</button>' : ''}
        <span class="grow"></span>
        <span class="hint" style="margin:0">Strategy: <b>${esc(settings.strategy)}</b></span>
      </div>
      <div class="rows">${rows.map(renderRow).join('')}</div>`;

    $footer.innerHTML = rows.length
      ? `${included.length ? costSummary(total) : ''}
         <span class="total">${included.length} item${included.length === 1 ? '' : 's'}${saved > 0.005 ? ` <span class="saved">· saving ${money(saved)} on deals</span>` : ''}</span>
         <button class="btn primary" data-act="addAll" ${included.length && !finding ? '' : 'disabled'}>Add to cart</button>`
      : `<span class="total" style="font-weight:400;color:#5f6368">Write a list, then Find items.</span>`;
  }

  function renderRow(r, i) {
    const p = r.pick >= 0 ? r.candidates[r.pick] : null;
    const status =
      r.status === 'searching' ? '<span class="tag">searching…</span>' :
      r.status === 'pending' ? '<span class="tag">queued</span>' :
      r.status === 'none' ? '<span class="tag bad">no match</span>' :
      r.status === 'error' ? `<span class="tag bad" title="${esc(r.error)}">error</span>` : '';
    const tags = p ? [
      p.deal ? `<span class="tag deal">🔻 ${esc(dealText(p))}</span>` : '',
      p.remembered ? '<span class="tag good">your usual</span>' : '',
      p.isStore ? '<span class="tag">store brand</span>' : '',
      !p.inStock ? '<span class="tag warn">stock?</span>' : '',
      p.hasOptions ? '<span class="tag warn">has options</span>' : '',
      p.seller && !/walmart/i.test(p.seller) ? `<span class="tag warn">sold by ${esc(p.seller)}</span>` : '',
    ].join('') : '';
    return `
      <div class="row ${r.include ? '' : 'off'}" data-i="${i}">
        <div class="top">
          <input type="checkbox" data-k="include" ${r.include ? 'checked' : ''} ${p ? '' : 'disabled'}>
          <span class="q" title="${esc(r.line.raw)}">${esc(r.line.query)}</span>
          <span>×${r.line.qty}</span>
          ${status}
          ${p ? `<b>${money(p.price * r.line.qty)}</b>` : ''}
        </div>
        ${r.candidates.length ? `<select data-k="pick">${r.candidates.map((c, j) => `<option value="${j}" ${j === r.pick ? 'selected' : ''}>${esc(candidateLabel(c))}</option>`).join('')}</select>` : ''}
        ${r.corrected ? `<div class="meta"><span class="tag warn">spelling fixed</span> <s>${esc(r.corrected.from)}</s> → <b>${esc(r.corrected.to)}</b></div>` : ''}
        ${r.status === 'error' ? `<div class="meta">${esc(r.error)}</div>` : ''}
        ${p ? `<div class="meta">${tags}<a href="/ip/${esc(p.usItemId)}" target="_blank" rel="noopener">view</a></div>` : ''}
      </div>`;
  }

  function renderSettings() {
    const s = settings;
    const memCount = Object.keys(getMemory()).length;
    $body.innerHTML = `
      <div class="field"><div>Pick strategy</div>
        <select data-s="strategy">
          ${[['smart', 'Smart balance (relevance, price, rating, popularity)'], ['deals', 'Best deal (rollbacks & biggest savings)'], ['cheapest', 'Cheapest price'], ['unit', 'Best unit price (per oz / ct)'], ['rated', 'Best rated']]
            .map(([v, t]) => `<option value="${v}" ${s.strategy === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
      <label class="opt"><input type="checkbox" data-s="preferDeals" ${s.preferDeals ? 'checked' : ''}><span>Prioritize rollbacks &amp; sale items</span></label>
      <label class="opt"><input type="checkbox" data-s="preferStore" ${s.preferStore ? 'checked' : ''}><span>Prefer store brands</span></label>
      <div class="field"><div>Store brands</div><input type="text" data-s="storeBrands" value="${esc(s.storeBrands)}"></div>
      <label class="opt"><input type="checkbox" data-s="skipSponsored" ${s.skipSponsored ? 'checked' : ''}><span>Skip sponsored results</span></label>
      <label class="opt"><input type="checkbox" data-s="inStockOnly" ${s.inStockOnly ? 'checked' : ''}><span>In-stock only</span></label>
      <label class="opt"><input type="checkbox" data-s="useMemory" ${s.useMemory ? 'checked' : ''}><span>Reuse my previous picks ("your usual")</span></label>
      <label class="opt"><span>Minimum rating (0 = off)</span><input type="number" min="0" max="5" step="0.1" data-s="minRating" value="${s.minRating}" style="width:70px"></label>
      <label class="opt"><span>Name match strictness (0–1)</span><input type="number" min="0" max="1" step="0.05" data-s="minMatch" value="${s.minMatch}" style="width:70px"></label>
      <div class="field"><div>Cost estimate</div>
        <select data-s="fulfillment">
          ${[['delivery', 'Delivery from store'], ['pickup', 'Pickup (free)'], ['shipping', 'Shipping']]
            .map(([v, t]) => `<option value="${v}" ${s.fulfillment === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
      <label class="opt"><span>Delivery fee without Walmart+ ($)</span><input type="number" min="0" step="0.01" data-s="deliveryFee" value="${s.deliveryFee}" style="width:80px"></label>
      <label class="opt"><span>Small-order fee ($)</span><input type="number" min="0" step="0.01" data-s="smallOrderFee" value="${s.smallOrderFee}" style="width:80px"></label>
      <label class="opt"><span>Order minimum to avoid it ($)</span><input type="number" min="0" step="1" data-s="orderMinimum" value="${s.orderMinimum}" style="width:80px"></label>
      <label class="opt"><span>Delay between actions (ms)</span><input type="number" min="300" max="10000" step="100" data-s="delayMs" value="${s.delayMs}" style="width:80px"></label>
      <div class="bar" style="margin-top:14px">
        <button class="btn" data-act="forget" ${memCount ? '' : 'disabled'}>Forget ${memCount} learned pick${memCount === 1 ? '' : 's'}</button>
        <button class="btn" data-act="resetSettings">Reset settings</button>
      </div>`;
    $footer.innerHTML = `<span class="total" style="font-weight:400;color:#5f6368">Settings save automatically. Re-run Find items to apply.</span>`;
  }

  function renderJob() {
    if (!$panel.classList.contains('open') || view !== 'job') return;
    const job = getJob();
    if (!job) {
      $body.innerHTML = `<div class="hint">No cart run yet. Build a list and press <b>Add to cart</b>.</div>`;
      $footer.innerHTML = '';
      return;
    }
    const done = job.items.filter((i) => ['added', 'unverified', 'failed'].includes(i.status)).length;
    const pct = Math.round((done / job.items.length) * 100);
    const tag = (i) =>
      i.status === 'added' ? '<span class="tag good">added</span>' :
      i.status === 'unverified' ? '<span class="tag warn">check cart</span>' :
      i.status === 'failed' ? '<span class="tag bad">failed</span>' :
      i.status === 'working' ? '<span class="tag">working…</span>' : '<span class="tag">queued</span>';
    $body.innerHTML = `
      ${job.message && job.status === 'paused' ? `<div class="notice">${esc(job.message)}</div>` : ''}
      <div><b>${esc(job.status)}</b> · ${done}/${job.items.length}</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      ${job.items.map((i) => `
        <div class="row">
          <div class="top"><span class="q" title="${esc(i.name)}">${esc(i.query)} → ${esc(i.name)}</span><span>×${i.qty}</span>${tag(i)}</div>
          ${i.note ? `<div class="meta">${esc(i.note)} · <a href="/ip/${esc(i.usItemId)}" target="_blank" rel="noopener">open item</a></div>` : ''}
        </div>`).join('')}`;
    $footer.innerHTML =
      job.status === 'running' ? `<span class="total">Adding items… keep this tab open.</span><button class="btn" data-act="stopJob">Stop</button>` :
      job.status === 'paused' || job.status === 'stopped' ? `<span class="total">${esc(job.status)}</span><button class="btn" data-act="clearJob">Discard</button><button class="btn primary" data-act="resumeJob">Resume</button>` :
      `<span class="total">Done.</span><button class="btn" data-act="clearJob">Clear</button><a class="btn primary" href="/cart" style="text-decoration:none;padding:6px 12px;border-radius:999px;background:#0071dc;color:#fff;font-weight:600">Go to cart</a>`;
  }

  function render() {
    root.querySelectorAll('header [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    if (view === 'settings') renderSettings();
    else if (view === 'job') renderJob();
    else renderList();
  }

  // Keep the textarea draft without re-rendering on every keystroke.
  root.addEventListener('input', (e) => {
    if (e.target.tagName === 'TEXTAREA') save(K.draft, e.target.value);
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.s) {
      const k = t.dataset.s;
      settings[k] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? parseFloat(t.value) || 0 : t.value;
      save(K.settings, settings);
      return;
    }
    const rowEl = t.closest('.row[data-i]');
    if (t.dataset.k === 'savedList') {
      const lists = load(K.lists, {});
      if (t.value && lists[t.value] != null) { save(K.draft, lists[t.value]); rows = []; render(); }
    } else if (rowEl && t.dataset.k === 'pick') {
      const r = rows[+rowEl.dataset.i];
      r.pick = +t.value;
      remember(r.line, r.candidates[r.pick]); // learn the manual choice
      render();
    } else if (rowEl && t.dataset.k === 'include') {
      rows[+rowEl.dataset.i].include = t.checked;
      render();
    }
  });

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.dataset.view) { view = t.dataset.view; render(); return; }
    const act = t.dataset.act;
    if (!act) return;

    if (act === 'close') setOpen(false);
    else if (act === 'find') findAll();
    else if (act === 'stopFind') stopFind = true;
    else if (act === 'addAll') {
      const toAdd = rows.filter((r) => r.include && r.pick >= 0);
      if (toAdd.length) startJob(toAdd);
    } else if (act === 'saveList') {
      const text = root.querySelector('textarea')?.value.trim();
      if (!text) return;
      const name = window.prompt('Name this list:', root.querySelector('[data-k="savedList"]').value || 'Weekly groceries');
      if (!name) return;
      const lists = load(K.lists, {});
      lists[name] = text;
      save(K.lists, lists);
      render();
    } else if (act === 'deleteList') {
      const sel = root.querySelector('[data-k="savedList"]');
      if (!sel.value) return;
      const lists = load(K.lists, {});
      delete lists[sel.value];
      save(K.lists, lists);
      render();
    } else if (act === 'forget') { save(K.memory, {}); render(); }
    else if (act === 'resetSettings') { settings = { ...DEFAULT_SETTINGS }; save(K.settings, settings); render(); }
    else if (act === 'stopJob') { const j = getJob(); if (j) { j.status = 'stopped'; setJob(j); } render(); }
    else if (act === 'resumeJob') { const j = getJob(); if (j) { j.status = 'running'; j.message = ''; setJob(j); } render(); runJob(); }
    else if (act === 'clearJob') { setJob(null); view = 'list'; render(); }
  });

  // Write a spelling fix back into the list so saved lists stay corrected.
  function fixDraftLine(line, typed) {
    const at = line.raw.toLowerCase().indexOf(typed.toLowerCase());
    if (at < 0) return;
    const fixed = line.raw.slice(0, at) + line.query + line.raw.slice(at + typed.length);
    const lines = load(K.draft, '').split('\n');
    const i = lines.indexOf(line.raw);
    if (i < 0) return;
    lines[i] = fixed;
    line.raw = fixed;
    save(K.draft, lines.join('\n')); // the next render() shows it in the textarea
  }

  async function findAll() {
    if (finding) return;
    const text = root.querySelector('textarea')?.value || load(K.draft, '');
    save(K.draft, text);
    const lines = text.split('\n').map(parseLine).filter(Boolean);
    if (!lines.length) return;
    finding = true;
    stopFind = false;
    notice = '';
    rows = lines.map((line) => ({ line, status: 'pending', candidates: [], pick: -1, include: false }));
    render();

    for (const r of rows) {
      if (stopFind) { r.status = r.status === 'pending' ? 'none' : r.status; continue; }
      r.status = 'searching';
      render();
      try {
        const typed = r.line.query;
        const wasCached = searchCache.has(typed);
        const res = await search(typed);
        // Rank against what the user meant: Walmart's spelling fix first, then our own typo match.
        if (res.corrected) r.line.query = res.corrected;
        let ranked = rankProducts(res.products, r.line);
        const local = !res.corrected && localCorrection(typed, ranked[0]);
        if (local) {
          r.line.query = local;
          ranked = rankProducts(res.products, r.line); // re-rank so "your usual" uses the fixed name
        }
        if (r.line.query !== typed) {
          r.corrected = { from: typed, to: r.line.query };
          fixDraftLine(r.line, typed);
        }
        r.candidates = ranked.slice(0, 8);
        r.pick = r.candidates.length ? 0 : -1;
        r.status = r.candidates.length ? 'ok' : 'none';
        r.include = r.status === 'ok';
        if (!wasCached) await sleep(jitter(settings.delayMs));
      } catch (err) {
        r.status = 'error';
        r.error = err.message;
        if (err.blocked) { notice = err.message; stopFind = true; }
      }
      render();
    }
    finding = false;
    render();
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Open Smart Cart Builder', () => setOpen(true));
  }

  // Resume an in-progress cart run after a page navigation.
  const job = getJob();
  if (job && (job.status === 'running' || job.status === 'paused')) {
    view = 'job';
    setOpen(true);
    if (job.status === 'running') runJob();
  } else if (load(K.open, false)) {
    setOpen(true);
  }
})();
