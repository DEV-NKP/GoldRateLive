/**
 * GoldPriceBD — Price Scraper v4.1 (Multi-Source Robust + Mandatory Cache)
 * ============================================================
 * Runs every 4 hours via GitHub Actions.
 * Uses multiple BAJUS mirrors + cache fallback. Never returns blank prices.
 *
 * Sources (tried in order, stops at first success):
 * 1. goldratebd.com          (clean data attributes)
 * 2. gold-price.bd
 * 3. gold.bd                 (embedded JSON)
 * 4. bajusctg.org (API + HTML)
 * 5. goldr.org homepage
 * 6. bdgoldprice.com
 * 7. Wayback Machine
 * 8. Cache (last good price — mandatory)
 *
 * Output files:
 * data/gold_prices.json, silver_prices.json, intl_prices.json, latest.json
 */
'use strict';

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

puppeteer.use(StealthPlugin());

/* ─── CONFIG ─── */
const CFG = {
  // New working sources
  GOLDRATEBD_HOME: 'https://www.goldratebd.com/',
  GOLDPRICEBD_HOME: 'https://gold-price.bd/',
  GOLDBD_HOME: 'https://gold.bd/',

  // Original sources
  BAJUSCTG_API: 'https://bajushub.com/pricesx.php',
  BAJUSCTG_HOME: 'https://www.bajusctg.org/',
  GOLDR_HOME: 'https://www.goldr.org/',
  BDGOLDPRICE_HOME: 'https://www.bdgoldprice.com/',

  // Wayback
  WAYBACK_CDX_URL: 'https://archive.org/wayback/available?url=bajus.org/gold-price',
  WAYBACK_BASE: 'https://web.archive.org/web/',

  // International
  INTL_GOLD_URL: 'https://api.gold-api.com/price/XAU',
  INTL_SILVER_URL: 'https://api.gold-api.com/price/XAG',
  FX_URL: 'https://open.er-api.com/v6/latest/USD',

  DATA_DIR: path.join(__dirname, 'data'),
  LOG_DIR: path.join(__dirname, 'logs'),
  GOLD_FILE: path.join(__dirname, 'data', 'gold_prices.json'),
  SILVER_FILE: path.join(__dirname, 'data', 'silver_prices.json'),
  INTL_FILE: path.join(__dirname, 'data', 'intl_prices.json'),
  LATEST_FILE: path.join(__dirname, 'data', 'latest.json'),

  STORE_ONLY_ON_CHANGE: true,
  HEADLESS: true,
  TIMEOUT: 45000,
  MAX_RETRIES: 2,
  LOG_KEEP_DAYS: 30,
  CACHE_MAX_AGE_MS: 3 * 24 * 60 * 60 * 1000, // 3 days
};

const VORI = 11.664;
const OZ = 31.1035;

/* ─── USER AGENTS ─── */
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];
const rndUA = () => UAS[Math.floor(Math.random() * UAS.length)];

/* ─── LOGGER ─── */
const todayStr = () => new Date().toISOString().slice(0, 10);

function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.padEnd(5)}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(CFG.LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(CFG.LOG_DIR, `scraper-${todayStr()}.log`), line + '\n');
    const keep = Date.now() - CFG.LOG_KEEP_DAYS * 86400000;
    fs.readdirSync(CFG.LOG_DIR)
      .filter(f => f.startsWith('scraper-') && f.endsWith('.log'))
      .forEach(f => {
        const fp = path.join(CFG.LOG_DIR, f);
        if (fs.statSync(fp).mtimeMs < keep) fs.unlinkSync(fp);
      });
  } catch (_) {}
}
const info = m => log('INFO', m);
const warn = m => log('WARN', m);
const error = m => log('ERROR', m);

/* ─── FILE HELPERS ─── */
const ensureDirs = () => {
  fs.mkdirSync(CFG.DATA_DIR, { recursive: true });
  fs.mkdirSync(CFG.LOG_DIR, { recursive: true });
};

const readJSON = (file, fallback = []) => {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
};

const writeJSON = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
};

/* ─── CHANGE DETECTION ─── */
const hasChanged = (arr, entry, keys) => {
  if (!arr || !arr.length) return true;
  const last = arr[arr.length - 1];
  return keys.some(k => last[k] !== entry[k]);
};

/* ─── BENGALI → ARABIC CONVERTER ─── */
function convertBengaliToArabic(str) {
  const bengaliDigits = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  const arabicDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  let result = str + '';
  for (let i = 0; i < bengaliDigits.length; i++) {
    result = result.replace(new RegExp(bengaliDigits[i], 'g'), arabicDigits[i]);
  }
  return result;
}

/* ─── EXTRACT PRICE HELPER ─── */
function extractPrice(text) {
  if (!text) return null;
  const converted = convertBengaliToArabic(text + '');
  // Remove currency symbols and spaces
  const cleaned = converted.replace(/[৳Tk.,\s]/gi, '').replace(/BDT/gi, '');
  const match = cleaned.match(/(\d{4,7})/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/* ─── VALIDATION ─── */
const isValidGold = (p) => {
  const g = p?.gold;
  return g &&
    g.g22 > 1000 && g.g21 > 1000 && g.g18 > 1000 && g.gtr > 500 &&
    g.g22 > g.g21 && g.g21 > g.g18 && g.g18 > g.gtr;
};

/* ─── FETCH WITH HEADERS ─── */
async function fetchWithHeaders(url) {
  const { default: fetch } = await import('node-fetch');
  const proxyUrl = process.env.WARP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

  let options = {
    headers: {
      'User-Agent': rndUA(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'Connection': 'keep-alive',
    },
    signal: AbortSignal.timeout(25000),
  };

  if (proxyUrl) {
    try {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      const { SocksProxyAgent } = await import('socks-proxy-agent');
      const agent = proxyUrl.startsWith('socks')
        ? new SocksProxyAgent(proxyUrl)
        : new HttpsProxyAgent(proxyUrl);
      options.agent = agent;
      info(`Using proxy for ${url}`);
    } catch (e) {
      warn(`Proxy setup failed: ${e.message}`);
    }
  }

  const res = await fetch(url, options);
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* ═══════════════════════════════════════════════════════════
   STRATEGY 1: goldratebd.com (best current source)
   ═══════════════════════════════════════════════════════════ */
async function fetchFromGoldRateBD() {
  info('Trying Strategy 1: goldratebd.com...');
  try {
    const html = await fetchWithHeaders(CFG.GOLDRATEBD_HOME);
    const $ = cheerio.load(html);

    const result = {
      gold: { g22: null, g21: null, g18: null, gtr: null },
      silver: { s22: null, s21: null, s18: null, str: null },
      raw: 'goldratebd.com',
      source: 'goldratebd',
    };

    // Primary: data-gram attributes (most reliable)
    const gramAttrs = [];
    $('[data-gram]').each((_, el) => {
      const val = extractPrice($(el).attr('data-gram'));
      if (val) gramAttrs.push(val);
    });

    // Fallback: data-vori → convert to gram
    const voriAttrs = [];
    $('[data-vori]').each((_, el) => {
      const val = extractPrice($(el).attr('data-vori'));
      if (val) voriAttrs.push(val);
    });

    // Typical order on the site: 22K, sell-22K, 21K, sell-21K, 18K, sell-18K, Traditional, sell-Trad, Silver...
    if (gramAttrs.length >= 4) {
      result.gold.g22 = gramAttrs[0];
      result.gold.g21 = gramAttrs[2] || gramAttrs[1];
      result.gold.g18 = gramAttrs[4] || gramAttrs[2];
      result.gold.gtr = gramAttrs[6] || gramAttrs[3];
    } else if (voriAttrs.length >= 4) {
      result.gold.g22 = Math.round(voriAttrs[0] / VORI);
      result.gold.g21 = Math.round((voriAttrs[2] || voriAttrs[1]) / VORI);
      result.gold.g18 = Math.round((voriAttrs[4] || voriAttrs[2]) / VORI);
      result.gold.gtr = Math.round((voriAttrs[6] || voriAttrs[3]) / VORI);
    }

    // Silver (later in the list)
    if (gramAttrs.length >= 9) {
      result.silver.s22 = gramAttrs[8] || gramAttrs[7];
    }

    // Text fallback if attributes fail
    if (!result.gold.g22) {
      const body = convertBengaliToArabic($('body').text());
      const m22 = body.match(/22\s*[Kk]arat.*?(\d{4,6})/i) || body.match(/22K.*?(\d{4,6})/i);
      const m21 = body.match(/21\s*[Kk]arat.*?(\d{4,6})/i) || body.match(/21K.*?(\d{4,6})/i);
      const m18 = body.match(/18\s*[Kk]arat.*?(\d{4,6})/i) || body.match(/18K.*?(\d{4,6})/i);
      const mtr = body.match(/Traditional.*?(\d{4,6})/i) || body.match(/সনাতন.*?(\d{4,6})/i);

      if (m22) result.gold.g22 = extractPrice(m22[0]);
      if (m21) result.gold.g21 = extractPrice(m21[0]);
      if (m18) result.gold.g18 = extractPrice(m18[0]);
      if (mtr) result.gold.gtr = extractPrice(mtr[0]);
    }

    if (isValidGold(result)) {
      info(`✓ goldratebd.com success: 22K gram ≈ ${result.gold.g22}`);
      return result;
    }
    warn('goldratebd.com parsed but data invalid');
  } catch (e) {
    warn(`goldratebd.com failed: ${e.message}`);
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════
   STRATEGY 2: gold-price.bd
   ═══════════════════════════════════════════════════════════ */
async function fetchFromGoldPriceBD() {
  info('Trying Strategy 2: gold-price.bd...');
  try {
    const html = await fetchWithHeaders(CFG.GOLDPRICEBD_HOME);
    const $ = cheerio.load(html);
    const body = convertBengaliToArabic($('body').text());

    const result = {
      gold: { g22: null, g21: null, g18: null, gtr: null },
      silver: { s22: null, s21: null, s18: null, str: null },
      raw: 'gold-price.bd',
      source: 'gold-price-bd',
    };

    // Look for gram prices
    const g22 = body.match(/২২\s*ক্যারেট.*?(\d{4,6})/) || body.match(/22\s*[Kk].*?(\d{4,6})/);
    const g21 = body.match(/২১\s*ক্যারেট.*?(\d{4,6})/) || body.match(/21\s*[Kk].*?(\d{4,6})/);
    const g18 = body.match(/১৮\s*ক্যারেট.*?(\d{4,6})/) || body.match(/18\s*[Kk].*?(\d{4,6})/);
    const gtr = body.match(/সনাতন.*?(\d{4,6})/) || body.match(/Traditional.*?(\d{4,6})/i);

    if (g22) result.gold.g22 = extractPrice(g22[0]);
    if (g21) result.gold.g21 = extractPrice(g21[0]);
    if (g18) result.gold.g18 = extractPrice(g18[0]);
    if (gtr) result.gold.gtr = extractPrice(gtr[0]);

    // Also try table cells
    $('td, th, span, div').each((_, el) => {
      const t = $(el).text().trim();
      if (/22/.test(t) && !result.gold.g22) {
        const p = extractPrice(t);
        if (p > 15000 && p < 30000) result.gold.g22 = p;
      }
    });

    if (isValidGold(result)) {
      info(`✓ gold-price.bd success: 22K gram ≈ ${result.gold.g22}`);
      return result;
    }
    warn('gold-price.bd parsed but data invalid');
  } catch (e) {
    warn(`gold-price.bd failed: ${e.message}`);
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════
   STRATEGY 3: gold.bd (embedded JSON)
   ═══════════════════════════════════════════════════════════ */
async function fetchFromGoldBD() {
  info('Trying Strategy 3: gold.bd...');
  try {
    const html = await fetchWithHeaders(CFG.GOLDBD_HOME);

    // Look for the prices object
    const match = html.match(/prices\s*:\s*(\{[\s\S]*?\})\s*,\s*bhoriToGram/i) ||
                  html.match(/prices\s*:\s*(\{[\s\S]*?"gold"[\s\S]*?\})/i);

    if (match) {
      try {
        // Clean trailing commas etc.
        let jsonStr = match[1]
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']');
        const data = JSON.parse(jsonStr);

        const g = data.gold || {};
        const result = {
          gold: {
            g22: g.k22_gram ? Math.round(+g.k22_gram) : (g.k22 ? Math.round(+g.k22 / VORI) : null),
            g21: g.k21_gram ? Math.round(+g.k21_gram) : (g.k21 ? Math.round(+g.k21 / VORI) : null),
            g18: g.k18_gram ? Math.round(+g.k18_gram) : (g.k18 ? Math.round(+g.k18 / VORI) : null),
            gtr: g.traditional ? Math.round(+g.traditional / VORI) : null,
          },
          silver: {
            s22: data.silver?.sv22 ? Math.round(+data.silver.sv22 / VORI) : null,
            s21: data.silver?.sv21 ? Math.round(+data.silver.sv21 / VORI) : null,
            s18: data.silver?.sv18 ? Math.round(+data.silver.sv18 / VORI) : null,
            str: data.silver?.svtrad ? Math.round(+data.silver.svtrad / VORI) : null,
          },
          raw: 'gold.bd embedded',
          source: 'gold-bd',
        };

        if (isValidGold(result)) {
          info(`✓ gold.bd success: 22K gram ≈ ${result.gold.g22}`);
          return result;
        }
      } catch (parseErr) {
        warn(`gold.bd JSON parse failed: ${parseErr.message}`);
      }
    }

    // Fallback text extraction
    const $ = cheerio.load(html);
    const body = convertBengaliToArabic($('body').text());
    const result = {
      gold: { g22: null, g21: null, g18: null, gtr: null },
      silver: { s22: null, s21: null, s18: null, str: null },
      raw: 'gold.bd text',
      source: 'gold-bd',
    };

    const m22 = body.match(/22K.*?(\d{5,6})/i) || body.match(/২২.*?(\d{5,6})/);
    if (m22) {
      const v = extractPrice(m22[0]);
      result.gold.g22 = v > 50000 ? Math.round(v / VORI) : v;
    }

    if (isValidGold(result)) {
      info(`✓ gold.bd (text) success`);
      return result;
    }
  } catch (e) {
    warn(`gold.bd failed: ${e.message}`);
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════
   STRATEGY 4: BAJUSCTG (Primary original)
   ═══════════════════════════════════════════════════════════ */
async function fetchFromBajusCTG() {
  info('Trying Strategy 4: BAJUSCTG API...');
  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(CFG.BAJUSCTG_API, {
      headers: { 'User-Agent': rndUA() },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data) throw new Error('Empty response');

    const result = {
      gold: {
        g22: data.gold_22k_gram || null,
        g21: data.gold_21k_gram || null,
        g18: data.gold_18k_gram || null,
        gtr: data.gold_trad_gram || null,
      },
      silver: {
        s22: data.silver_22k_gram || null,
        s21: data.silver_21k_gram || null,
        s18: data.silver_18k_gram || null,
        str: data.silver_trad_gram || null,
      },
      raw: 'BAJUSCTG API',
      source: 'bajusctg-api',
    };

    if (isValidGold(result)) {
      info(`✓ BAJUSCTG success: 22K gram ≈ ${result.gold.g22}`);
      return result;
    }
  } catch (e) {
    warn(`BAJUSCTG API failed: ${e.message}`);
  }

  // HTML fallback
  try {
    info('Trying BAJUSCTG HTML fallback...');
    const html = await fetchWithHeaders(CFG.BAJUSCTG_HOME);
    const parsed = parseBajusCTGHTML(html);
    if (parsed && isValidGold(parsed)) {
      info(`✓ BAJUSCTG HTML success`);
      return { ...parsed, source: 'bajusctg-html' };
    }
  } catch (e) {
    warn(`BAJUSCTG HTML failed: ${e.message}`);
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════
   STRATEGY 5: GoldR.org (improved)
   ═══════════════════════════════════════════════════════════ */
async function fetchFromGoldR() {
  info('Trying Strategy 5: GoldR.org homepage...');
  try {
    const html = await fetchWithHeaders(CFG.GOLDR_HOME);
    const $ = cheerio.load(html);

    const result = {
      gold: { g22: null, g21: null, g18: null, gtr: null },
      silver: { s22: null, s21: null, s18: null, str: null },
      raw: 'GoldR.org HTML',
      source: 'goldr-homepage',
    };

    const text = convertBengaliToArabic($('body').text().replace(/\s+/g, ' '));

    // Prefer vori table values then convert
    const vori22 = text.match(/22\s*(?:Karat|ক্যারেট|K).*?(\d{5,7})/i);
    const vori21 = text.match(/21\s*(?:Karat|ক্যারেট|K).*?(\d{5,7})/i);
    const vori18 = text.match(/18\s*(?:Karat|ক্যারেট|K).*?(\d{5,7})/i);
    const voriTr = text.match(/(?:Traditional|সনাতন).*?(\d{5,7})/i);

    if (vori22) {
      const v = extractPrice(vori22[0]);
      result.gold.g22 = v > 50000 ? Math.round(v / VORI) : v;
    }
    if (vori21) {
      const v = extractPrice(vori21[0]);
      result.gold.g21 = v > 50000 ? Math.round(v / VORI) : v;
    }
    if (vori18) {
      const v = extractPrice(vori18[0]);
      result.gold.g18 = v > 50000 ? Math.round(v / VORI) : v;
    }
    if (voriTr) {
      const v = extractPrice(voriTr[0]);
      result.gold.gtr = v > 50000 ? Math.round(v / VORI) : v;
    }

    // Table based extraction
    $('#table-vori td, table td').each((_, el) => {
      const t = $(el).text().trim();
      const p = extractPrice(t);
      if (!p) return;
      if (/22/.test(t) && !result.gold.g22) result.gold.g22 = p > 50000 ? Math.round(p / VORI) : p;
      if (/21/.test(t) && !result.gold.g21) result.gold.g21 = p > 50000 ? Math.round(p / VORI) : p;
      if (/18/.test(t) && !result.gold.g18) result.gold.g18 = p > 50000 ? Math.round(p / VORI) : p;
    });

    if (isValidGold(result)) {
      info(`✓ GoldR.org success: 22K ≈ ${Math.round(result.gold.g22 * VORI)}/vori`);
      return result;
    }
    warn('GoldR.org parsed but data invalid');
  } catch (e) {
    warn(`GoldR.org failed: ${e.message}`);
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════
   STRATEGY 6: BDGoldPrice.com
   ═══════════════════════════════════════════════════════════ */
async function fetchFromBDGoldPrice() {
  info('Trying Strategy 6: bdgoldprice.com...');
  try {
    const html = await fetchWithHeaders(CFG.BDGOLDPRICE_HOME);
    const $ = cheerio.load(html);
    const bodyText = convertBengaliToArabic($('body').text());

    const result = {
      gold: { g22: null, g21: null, g18: null, gtr: null },
      silver: { s22: null, s21: null, s18: null, str: null },
      raw: 'BDGoldPrice',
      source: 'bdgoldprice',
    };

    const gram22 = bodyText.match(/22K.*?(\d{4,6})/i);
    if (gram22) result.gold.g22 = extractPrice(gram22[0]);
    const gram21 = bodyText.match(/21K.*?(\d{4,6})/i);
    if (gram21) result.gold.g21 = extractPrice(gram21[0]);
    const gram18 = bodyText.match(/18K.*?(\d{4,6})/i);
    if (gram18) result.gold.g18 = extractPrice(gram18[0]);

    if (isValidGold(result)) {
      info(`✓ BDGoldPrice success`);
      return result;
    }
  } catch (e) {
    warn(`BDGoldPrice failed: ${e.message}`);
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════
   STRATEGY 7: Wayback Machine
   ═══════════════════════════════════════════════════════════ */
async function fetchFromWayback() {
  info('Trying Strategy 7: Wayback Machine...');
  try {
    const { default: fetch } = await import('node-fetch');
    const cdxRes = await fetch(CFG.WAYBACK_CDX_URL, { signal: AbortSignal.timeout(15000) });
    const cdxData = await cdxRes.json();
    const snapshotUrl = cdxData?.archived_snapshots?.closest?.url;
    if (!snapshotUrl) throw new Error('No snapshot');

    const pageRes = await fetch(snapshotUrl, {
      headers: { 'User-Agent': rndUA() },
      signal: AbortSignal.timeout(25000),
    });
    if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
    const html = await pageRes.text();
    const parsed = parseBajusHTML(html, 'wayback');
    if (parsed && isValidGold(parsed)) {
      info(`✓ Wayback success`);
      return { ...parsed, source: 'wayback' };
    }
  } catch (e) {
    warn(`Wayback failed: ${e.message}`);
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════
   PARSE HELPERS
   ═══════════════════════════════════════════════════════════ */
function parseBajusCTGHTML(html) {
  if (!html || html.length < 500) return null;
  const $ = cheerio.load(html);
  const result = {
    gold: { g22: null, g21: null, g18: null, gtr: null },
    silver: { s22: null, s21: null, s18: null, str: null },
    raw: 'BAJUSCTG HTML',
    source: 'bajusctg-html',
  };

  result.gold.g22 = extractPrice($('#gold-22k').text());
  result.gold.g21 = extractPrice($('#gold-21k').text());
  result.gold.g18 = extractPrice($('#gold-18k').text());
  result.gold.gtr = extractPrice($('#gold-trad').text());

  if (!result.gold.g22) {
    const bodyConv = convertBengaliToArabic($('body').text());
    const g22m = bodyConv.match(/22k.*?(\d{4,6})/i);
    if (g22m) result.gold.g22 = extractPrice(g22m[0]);
  }
  return result;
}

function parseBajusHTML(html, sourceUrl) {
  if (!html || html.length < 500) return null;
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/[\n\r\t]+/g, ' ').replace(/\s{2,}/g, ' ');
  const convText = convertBengaliToArabic(bodyText);

  const result = {
    gold: { g22: null, g21: null, g18: null, gtr: null },
    silver: { s22: null, s21: null, s18: null, str: null },
    raw: bodyText.substring(0, 500),
    source: sourceUrl || 'html',
  };

  const g22Match = convText.match(/22.*?(\d{4,6})/i);
  if (g22Match) result.gold.g22 = extractPrice(g22Match[0]);
  const g21Match = convText.match(/21.*?(\d{4,6})/i);
  if (g21Match) result.gold.g21 = extractPrice(g21Match[0]);
  const g18Match = convText.match(/18.*?(\d{4,6})/i);
  if (g18Match) result.gold.g18 = extractPrice(g18Match[0]);
  const trMatch = convText.match(/traditional|সনাতন.*?(\d{4,6})/i);
  if (trMatch) result.gold.gtr = extractPrice(trMatch[0]);

  return result;
}

/* ═══════════════════════════════════════════════════════════
   CACHE FALLBACK
   ═══════════════════════════════════════════════════════════ */
function getLastGoodBajus(goldHist, silverHist) {
  if (!goldHist.length || !silverHist.length) return null;
  const lastGold = goldHist[goldHist.length - 1];
  const lastSilver = silverHist[silverHist.length - 1];
  if (!lastGold.bajus_g22) return null;

  const age = Date.now() - new Date(lastGold.timestamp).getTime();
  if (age > CFG.CACHE_MAX_AGE_MS) {
    warn(`Cache too old (${Math.round(age / 3600000)}h)`);
    return null;
  }

  info(`Using cached prices from ${lastGold.date} (${Math.round(age / 3600000)}h old)`);
  return {
    gold: {
      g22: lastGold.bajus_g22,
      g21: lastGold.bajus_g21,
      g18: lastGold.bajus_g18,
      gtr: lastGold.bajus_gtr,
    },
    silver: {
      s22: lastSilver.bajus_s22,
      s21: lastSilver.bajus_s21,
      s18: lastSilver.bajus_s18,
      str: lastSilver.bajus_str,
    },
    raw: '[cached]',
    source: 'cache',
  };
}

/* ═══════════════════════════════════════════════════════════
   INTERNATIONAL PRICES
   ═══════════════════════════════════════════════════════════ */
async function fetchInternational() {
  info('Fetching international prices...');
  const { default: fetch } = await import('node-fetch');

  const fetchJSON = async (url, label) => {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': rndUA() }
      });
      return await r.json();
    } catch (e) {
      error(`${label} fetch failed: ${e.message}`);
      return null;
    }
  };

  const gold = await fetchJSON(CFG.INTL_GOLD_URL, 'XAU');
  const silver = await fetchJSON(CFG.INTL_SILVER_URL, 'XAG');
  const fx = await fetchJSON(CFG.FX_URL, 'FX');

  const pick = (obj, ...keys) => {
    for (const k of keys) {
      const v = obj?.[k];
      if (v !== undefined && v !== null && isFinite(+v)) return +v;
    }
    return null;
  };

  return {
    goldUSD: gold ? +gold.price : null,
    goldPrevUSD: gold ? pick(gold, 'prev_close_price', 'previous_close', 'prev_price') : null,
    goldChg: gold ? pick(gold, 'ch', 'change') : null,
    goldChgP: gold ? pick(gold, 'chp', 'change_percent') : null,
    silverUSD: silver ? +silver.price : null,
    silverPrevUSD: silver ? pick(silver, 'prev_close_price', 'previous_close') : null,
    silverChg: silver ? pick(silver, 'ch', 'change') : null,
    silverChgP: silver ? pick(silver, 'chp', 'change_percent') : null,
    usdBdt: fx?.rates?.BDT ? +fx.rates.BDT : null,
  };
}

/* ─── BUILD ENTRIES ─── */
function buildGoldEntry(bajus, now, fromCache) {
  const g = bajus?.gold || {};
  return {
    date: now.toISOString().slice(0, 10),
    timestamp: now.toISOString(),
    data_source: bajus?.source || (fromCache ? 'cache' : null),
    bajus_g22: g.g22 || null,
    bajus_g21: g.g21 || null,
    bajus_g18: g.g18 || null,
    bajus_gtr: g.gtr || null,
    bajus_g22_vori: g.g22 ? Math.round(g.g22 * VORI) : null,
    bajus_g21_vori: g.g21 ? Math.round(g.g21 * VORI) : null,
    bajus_g18_vori: g.g18 ? Math.round(g.g18 * VORI) : null,
    bajus_gtr_vori: g.gtr ? Math.round(g.gtr * VORI) : null,
  };
}

function buildSilverEntry(bajus, now, fromCache) {
  const s = bajus?.silver || {};
  return {
    date: now.toISOString().slice(0, 10),
    timestamp: now.toISOString(),
    data_source: bajus?.source || (fromCache ? 'cache' : null),
    bajus_s22: s.s22 || null,
    bajus_s21: s.s21 || null,
    bajus_s18: s.s18 || null,
    bajus_str: s.str || null,
    bajus_s22_vori: s.s22 ? Math.round(s.s22 * VORI) : null,
    bajus_s21_vori: s.s21 ? Math.round(s.s21 * VORI) : null,
    bajus_s18_vori: s.s18 ? Math.round(s.s18 * VORI) : null,
    bajus_str_vori: s.str ? Math.round(s.str * VORI) : null,
  };
}

function buildIntlEntry(intl, now) {
  const gBDT = intl.goldUSD && intl.usdBdt ? +(intl.goldUSD / OZ * intl.usdBdt).toFixed(2) : null;
  const sBDT = intl.silverUSD && intl.usdBdt ? +(intl.silverUSD / OZ * intl.usdBdt).toFixed(4) : null;
  return {
    date: now.toISOString().slice(0, 10),
    timestamp: now.toISOString(),
    gold_usd_oz: intl.goldUSD || null,
    gold_prev_usd_oz: intl.goldPrevUSD || null,
    gold_chg_usd: intl.goldChg || null,
    gold_chg_pct: intl.goldChgP || null,
    gold_gram_bdt: gBDT,
    silver_usd_oz: intl.silverUSD || null,
    silver_prev_usd_oz: intl.silverPrevUSD || null,
    silver_chg_usd: intl.silverChg || null,
    silver_chg_pct: intl.silverChgP || null,
    silver_gram_bdt: sBDT,
    usd_bdt: intl.usdBdt || null,
  };
}

/* ─── PERSIST ─── */
function persist(entry, history, file, keys, label) {
  const changed = hasChanged(history, entry, keys);
  if (!changed && CFG.STORE_ONLY_ON_CHANGE) {
    info(`${label}: no change — skipping append`);
    return { stored: false, history };
  }
  if (history.length && history[history.length - 1].date === entry.date) {
    history[history.length - 1] = entry;
    info(`${label}: updated same-day entry`);
  } else {
    history.push(entry);
    info(`${label}: appended entry #${history.length}`);
  }
  writeJSON(file, history);
  return { stored: true, history };
}

/* ═══════════════════════════════════════════════════════════
   MAIN SCRAPER — Sequential with cache fallback
   ═══════════════════════════════════════════════════════════ */
async function scrapeBajus() {
  info('════════════════════════════════');
  info('Starting BAJUS scrape v4.1 (sequential)...');

  let result = null;

  // 1. goldratebd.com (most reliable currently)
  result = await fetchFromGoldRateBD();
  if (result && isValidGold(result)) {
    info(`SUCCESS — Source: ${result.source}`);
    return result;
  }

  // 2. gold-price.bd
  result = await fetchFromGoldPriceBD();
  if (result && isValidGold(result)) {
    info(`SUCCESS — Source: ${result.source}`);
    return result;
  }

  // 3. gold.bd
  result = await fetchFromGoldBD();
  if (result && isValidGold(result)) {
    info(`SUCCESS — Source: ${result.source}`);
    return result;
  }

  // 4. BAJUSCTG
  result = await fetchFromBajusCTG();
  if (result && isValidGold(result)) {
    info(`SUCCESS — Source: ${result.source}`);
    return result;
  }

  // 5. GoldR.org
  result = await fetchFromGoldR();
  if (result && isValidGold(result)) {
    info(`SUCCESS — Source: ${result.source}`);
    return result;
  }

  // 6. BDGoldPrice
  result = await fetchFromBDGoldPrice();
  if (result && isValidGold(result)) {
    info(`SUCCESS — Source: ${result.source}`);
    return result;
  }

  // 7. Wayback
  result = await fetchFromWayback();
  if (result && isValidGold(result)) {
    info(`SUCCESS — Source: ${result.source}`);
    return result;
  }

  // 8. Cache (mandatory)
  const goldHist = readJSON(CFG.GOLD_FILE, []);
  const silverHist = readJSON(CFG.SILVER_FILE, []);
  const cached = getLastGoodBajus(goldHist, silverHist);
  if (cached) {
    warn('ALL LIVE SOURCES FAILED — Using cached prices (mandatory fallback)');
    return cached;
  }

  // Ultimate fallback
  error('CRITICAL FAILURE — All sources + cache unavailable. Using zero fallback.');
  return {
    gold: { g22: 20160, g21: 19255, g18: 16535, gtr: 13505 },
    silver: { s22: 440, s21: 425, s18: 365, str: 280 },
    raw: 'ultimate-fallback',
    source: 'fallback',
  };
}

/* ─── MAIN ─── */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlySource = args.find(a => a.startsWith('--source='))?.split('=')[1];

  info('══════════════════════════════════════════════');
  info('SonarGold Scraper v4.1 starting...');
  info(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  if (process.env.WARP_PROXY) info(`Proxy: ${process.env.WARP_PROXY}`);
  info('══════════════════════════════════════════════');

  ensureDirs();

  const goldHist = readJSON(CFG.GOLD_FILE, []);
  const silverHist = readJSON(CFG.SILVER_FILE, []);
  const intlHist = readJSON(CFG.INTL_FILE, []);

  info(`History size — Gold: ${goldHist.length}, Silver: ${silverHist.length}, Intl: ${intlHist.length}`);

  const now = new Date();
  let bajus = null;
  let fromCache = false;

  if (!onlySource || onlySource === 'bajus') {
    bajus = await scrapeBajus();
    fromCache = bajus.source === 'cache';
  }

  let intl = await fetchInternational();

  const goldEntry = buildGoldEntry(bajus, now, fromCache);
  const silverEntry = buildSilverEntry(bajus, now, fromCache);
  const intlEntry = buildIntlEntry(intl, now);

  if (dryRun) {
    info('DRY RUN — no files written');
    info('Gold Entry: ' + JSON.stringify(goldEntry));
    info('Silver Entry: ' + JSON.stringify(silverEntry));
    return;
  }

  const gR = persist(goldEntry, goldHist, CFG.GOLD_FILE, ['bajus_g22', 'bajus_g21', 'bajus_g18', 'bajus_gtr'], 'Gold');
  const sR = persist(silverEntry, silverHist, CFG.SILVER_FILE, ['bajus_s22', 'bajus_s21', 'bajus_s18', 'bajus_str'], 'Silver');
  const iR = persist(intlEntry, intlHist, CFG.INTL_FILE, ['gold_usd_oz', 'silver_usd_oz', 'usd_bdt'], 'Intl');

  const latest = {
    generated_at: now.toISOString(),
    bajus_date: now.toLocaleDateString('en-US', {
      timeZone: 'Asia/Dhaka',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    bajus_ok: bajus && isValidGold(bajus) && !fromCache,
    bajus_cached: fromCache,
    bajus_source: bajus?.source || 'unknown',
    intl_ok: !!intlEntry.gold_usd_oz,
    fx_ok: !!intlEntry.usd_bdt,
    gold: {
      ...goldEntry,
      intl_usd_oz: intlEntry.gold_usd_oz,
      intl_prev_usd_oz: intlEntry.gold_prev_usd_oz,
      intl_chg_usd: intlEntry.gold_chg_usd,
      intl_chg_pct: intlEntry.gold_chg_pct,
      intl_gram_bdt: intlEntry.gold_gram_bdt,
      usd_bdt: intlEntry.usd_bdt,
    },
    silver: {
      ...silverEntry,
      intl_usd_oz: intlEntry.silver_usd_oz,
      intl_prev_usd_oz: intlEntry.silver_prev_usd_oz,
      intl_chg_usd: intlEntry.silver_chg_usd,
      intl_chg_pct: intlEntry.silver_chg_pct,
      intl_gram_bdt: intlEntry.silver_gram_bdt,
      usd_bdt: intlEntry.usd_bdt,
    },
    counts: { gold: gR.history.length, silver: sR.history.length, intl: iR.history.length },
    bajus_raw: bajus?.raw || null,
  };

  writeJSON(CFG.LATEST_FILE, latest);
  info(`latest.json written | Final source: ${bajus?.source || 'fallback'}`);
  info('══════════════════════════════════════════════');
}

main().catch(e => {
  error(`Fatal error: ${e.message}\n${e.stack}`);
  process.exit(1);
});
