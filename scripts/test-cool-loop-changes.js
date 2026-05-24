#!/usr/bin/env node
/**
 * Manual smoke test for the COOL Loop integration changes:
 *   1. GET /api/scan-data?id=<uuid>&shape=bundle  — verify bundle dossier shape
 *   2. GET /api/scan-data?shape=bundle (no id)    — expect 400
 *   3. POST /api/scrape (no token)                — expect normal behavior
 *   4. POST /api/scrape (correct token, if set)   — expect normal behavior
 *   5. POST /api/scrape (wrong token, if set)     — expect 403
 *
 * Usage:
 *   PI_BASE_URL=https://practiceintelligence-...vercel.app \
 *   PI_TEST_SCAN_ID=<a-real-scan-uuid> \
 *   COOLLOOP_SERVICE_TOKEN=<token-if-deployed> \
 *     node scripts/test-cool-loop-changes.js
 *
 * Required env: PI_BASE_URL, PI_TEST_SCAN_ID
 * Optional env: COOLLOOP_SERVICE_TOKEN (skips auth tests if absent)
 *
 * Requires Node 18+ (built-in fetch).
 */

const BASE = process.env.PI_BASE_URL || 'http://localhost:3000';
const SCAN_ID = process.env.PI_TEST_SCAN_ID || '00000000-0000-0000-0000-000000000000'; // replace with real id
const TOKEN = process.env.COOLLOOP_SERVICE_TOKEN || '';

const SCRAPE_TARGET_URL = process.env.PI_TEST_SCRAPE_URL || 'https://example.com';

const c = { green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m', bold: '\x1b[1m' };
const log = (label, ok, detail) =>
    console.log(`${ok ? c.green + '✓' : c.red + '✗'} ${c.bold}${label}${c.reset} ${c.dim}${detail || ''}${c.reset}`);

async function safeFetch(url, opts = {}) {
    try {
        const r = await fetch(url, opts);
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { status: r.status, json, text };
    } catch (err) {
        return { status: 0, json: null, text: String(err) };
    }
}

async function test1_BundleShape() {
    const url = `${BASE}/api/scan-data?id=${encodeURIComponent(SCAN_ID)}&shape=bundle`;
    const r = await safeFetch(url);
    const ok = r.status === 200 && r.json && r.json.overview && r.json.practice && r.json.current_site;
    log('Test 1 — bundle shape', ok, `status=${r.status}`);
    if (r.json) {
        const keys = Object.keys(r.json).sort();
        console.log(`  top-level keys: ${keys.join(', ')}`);
        console.log(`  overview.overall_score = ${r.json.overview?.overall_score}`);
        console.log(`  practice.business_name = ${r.json.practice?.business_name}`);
        console.log(`  raw_blobs_available    = ${JSON.stringify(r.json.raw_blobs_available)}`);
        console.log(`  pi_scan_id             = ${r.json.pi_scan_id}`);
    } else {
        console.log(`  body: ${r.text.slice(0, 300)}`);
    }
}

async function test2_BundleWithoutId() {
    const url = `${BASE}/api/scan-data?shape=bundle`;
    const r = await safeFetch(url);
    const ok = r.status === 400 && r.json?.error === 'shape=bundle requires id';
    log('Test 2 — bundle without id rejects (400)', ok, `status=${r.status} error=${r.json?.error}`);
}

async function test3_ScrapeNoToken() {
    const url = `${BASE}/api/scrape`;
    const r = await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: SCRAPE_TARGET_URL, maxPages: 1 }),
    });
    // Without a token header, soft auth should allow the request through.
    // Downstream (Apify) may then 500/504, but it should NOT be 403.
    const ok = r.status !== 403;
    log('Test 3 — scrape with no token (not 403)', ok, `status=${r.status}`);
    if (r.status === 403) console.log(`  body: ${r.text.slice(0, 200)}`);
}

async function test4_ScrapeCorrectToken() {
    if (!TOKEN) {
        log('Test 4 — scrape with correct token', true, 'SKIPPED (COOLLOOP_SERVICE_TOKEN not set in env)');
        return;
    }
    const url = `${BASE}/api/scrape`;
    const r = await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-COOLLOOP-TOKEN': TOKEN },
        body: JSON.stringify({ url: SCRAPE_TARGET_URL, maxPages: 1 }),
    });
    const ok = r.status !== 403;
    log('Test 4 — scrape with correct token (not 403)', ok, `status=${r.status}`);
}

async function test5_ScrapeWrongToken() {
    if (!TOKEN) {
        log('Test 5 — scrape with wrong token', true, 'SKIPPED (COOLLOOP_SERVICE_TOKEN not set in env)');
        return;
    }
    const url = `${BASE}/api/scrape`;
    const r = await safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-COOLLOOP-TOKEN': 'wrong-' + Date.now() },
        body: JSON.stringify({ url: SCRAPE_TARGET_URL, maxPages: 1 }),
    });
    const ok = r.status === 403 && r.json?.error === 'invalid service token';
    log('Test 5 — scrape with wrong token (403)', ok, `status=${r.status} error=${r.json?.error}`);
}

(async () => {
    console.log(`${c.bold}COOL Loop integration smoke tests${c.reset}`);
    console.log(`  base:    ${BASE}`);
    console.log(`  scan_id: ${SCAN_ID}`);
    console.log(`  token:   ${TOKEN ? '(set, length=' + TOKEN.length + ')' : '(not set — auth tests will skip)'}`);
    console.log('');

    await test1_BundleShape();
    await test2_BundleWithoutId();
    await test3_ScrapeNoToken();
    await test4_ScrapeCorrectToken();
    await test5_ScrapeWrongToken();

    console.log('');
    console.log(`${c.dim}Note: Tests 3–5 hit Apify and may be slow / cost run-credits.${c.reset}`);
    console.log(`${c.dim}      Set PI_TEST_SCRAPE_URL to override the scrape target.${c.reset}`);
})();
