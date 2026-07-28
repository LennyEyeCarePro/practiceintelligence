/**
 * Setup script — copies HTML files from parent directory into local/public/
 * and patches API_BASE to point to localhost instead of Vercel.
 *
 * Run: npm run setup
 */

import { readFile, writeFile, mkdir, cp } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const parentDir = join(__dirname, '..');
const publicDir = join(__dirname, 'public');

const VERCEL_URL = 'https://practiceintelligence-lennys-projects-2067cb84.vercel.app/api';
const LOCAL_URL = '/api';

const htmlFiles = ['seo-tool.html', 'dashboard.html', 'index.html', 'embed.html'];

async function setup() {
    await mkdir(publicDir, { recursive: true });

    for (const file of htmlFiles) {
        try {
            let content = await readFile(join(parentDir, file), 'utf8');

            // Replace the hardcoded Vercel API_BASE with relative /api path
            content = content.replace(
                new RegExp(VERCEL_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
                LOCAL_URL
            );

            // Also handle any single-quoted version
            content = content.replace(
                /LIGHTHOUSE_PROXY_URL:\s*'[^']*'/g,
                "LIGHTHOUSE_PROXY_URL: '/api/page-quality'"
            );

            await writeFile(join(publicDir, file), content);
            console.log(`  ✓ ${file} → public/${file}`);
        } catch (err) {
            if (err.code === 'ENOENT') {
                console.warn(`  ⚠ ${file} not found in parent directory, skipping`);
            } else {
                console.error(`  ✗ ${file}: ${err.message}`);
            }
        }
    }

    // Brand logos and any other static assets live in ../assets and are
    // referenced by absolute path (e.g. /assets/eyefinity-logo.svg), so they
    // have to exist under public/ too or they 404 in local dev.
    try {
        await cp(join(parentDir, 'assets'), join(publicDir, 'assets'), { recursive: true });
        console.log('  ✓ assets/ → public/assets/');
    } catch (err) {
        if (err.code === 'ENOENT') console.warn('  ⚠ assets/ not found, skipping');
        else console.error(`  ✗ assets/: ${err.message}`);
    }

    console.log('\nDone! HTML files copied to public/ with localhost API paths.');
    console.log('Run "npm start" to launch the server.\n');
    console.log('Brand override for testing: http://localhost:3000/index.html?brand=eyefinity\n');
}

setup();
