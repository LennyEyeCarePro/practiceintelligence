/**
 * Practice Intelligence — Local Express Server
 * Wraps all Vercel serverless handlers into a single Express app.
 *
 * Usage:
 *   1. Copy your .env file into this folder (or parent)
 *   2. npm install
 *   3. node server.js
 *   4. Open http://localhost:3000
 */

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdir } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS for local dev
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

// ── Static files (HTML pages) ──────────────────────
app.use(express.static(join(__dirname, 'public')));

// ── API Routes ─────────────────────────────────────
// Dynamically load all handlers from ../api/ and mount them
const apiDir = join(__dirname, '..', 'api');

// Map of filename → route path
const routeMap = {
    'crawl-site':       '/api/crawl-site',
    'hubspot':          '/api/hubspot',
    'keyword-research': '/api/keyword-research',
    'link-audit':       '/api/link-audit',
    'page-quality':     '/api/page-quality',
    'places':           '/api/places',
    'scan-data':        '/api/scan-data',
    'scrape':           '/api/scrape',
    'search-rankings':  '/api/search-rankings',
    'seo-report':       '/api/seo-report',
    'site-audit':       '/api/site-audit',
    'site-info':        '/api/site-info',
};

async function loadHandlers() {
    for (const [name, route] of Object.entries(routeMap)) {
        try {
            const filePath = join(apiDir, `${name}.js`);

            // Read the file and create a handler that strips the problematic
            // require('./proxy-agent') and axios lines (dead code in several files)
            const module = await import(`file://${filePath}`);
            const handler = module.default;

            if (typeof handler !== 'function') {
                console.warn(`  ⚠ ${name}.js — no default export function, skipping`);
                continue;
            }

            // Mount as both GET and POST (the handler itself decides what to accept)
            app.all(route, async (req, res) => {
                try {
                    await handler(req, res);
                } catch (err) {
                    console.error(`Error in ${route}:`, err.message);
                    if (!res.headersSent) {
                        res.status(500).json({ error: err.message });
                    }
                }
            });

            console.log(`  ✓ ${route}`);
        } catch (err) {
            console.warn(`  ✗ ${name}.js — failed to load: ${err.message}`);
        }
    }
}

// ── Start ──────────────────────────────────────────
async function start() {
    console.log('\n🔍 Practice Intelligence — Local Server\n');
    console.log('Loading API handlers...');

    await loadHandlers();

    console.log('\nStarting server...');
    app.listen(PORT, () => {
        console.log(`\n✅ Server running at http://localhost:${PORT}`);
        console.log(`   SEO Tool:   http://localhost:${PORT}/seo-tool.html`);
        console.log(`   Dashboard:  http://localhost:${PORT}/dashboard.html`);
        console.log(`   Client App: http://localhost:${PORT}/index.html`);
        console.log(`\nPress Ctrl+C to stop.\n`);
    });
}

start().catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});
