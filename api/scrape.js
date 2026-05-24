/**
 * Vercel Serverless Function — Apify Proxy
 * Keeps the Apify API token server-side (never exposed to the browser).
 *
 * The frontend calls: POST /api/scrape { url: "https://example.com" }
 * This function starts the Apify Actor, polls for results, and returns the dossier.
 *
 * Soft service-token auth — see checkServiceToken() below.
 */

/**
 * Soft service-token check for COOL Loop integration.
 *
 * Behavior:
 *   - No COOLLOOP_SERVICE_TOKEN env var set        → allow (transition mode)
 *   - Env var set, no X-COOLLOOP-TOKEN header sent → allow (preserves widget traffic)
 *   - Env var set, header sent, matches            → allow, tag as 'coolloop'
 *   - Env var set, header sent, mismatch           → deny (403)
 */
function checkServiceToken(req) {
    const provided = req.headers?.['x-coolloop-token'];
    const expected = process.env.COOLLOOP_SERVICE_TOKEN;

    if (!expected) return { allowed: true, reason: 'no_token_configured' };
    if (!provided) return { allowed: true, reason: 'no_token_sent' };
    if (provided !== expected) return { allowed: false, reason: 'invalid_token' };
    return { allowed: true, reason: 'token_valid' };
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-COOLLOOP-TOKEN');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const auth = checkServiceToken(req);
    if (!auth.allowed) {
        return res.status(403).json({ error: 'invalid service token' });
    }
    // const callerType = auth.reason === 'token_valid' ? 'coolloop' : 'public'; // reserved for telemetry

    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { url, maxPages = 15 } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

    const APIFY_TOKEN = process.env.APIFY_TOKEN;
    const APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID || 'eyecarepro~eyecarepro-practice-scraper';

    if (!APIFY_TOKEN) return res.status(500).json({ error: 'APIFY_TOKEN not configured' });

    try {
        // Start actor run
        const startResp = await fetch(
            `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, maxPages }),
            }
        );
        const runData = await startResp.json();
        const runId = runData.data?.id;

        if (!runId) {
            return res.status(500).json({ error: 'Failed to start Apify run', details: runData });
        }

        // Poll for completion (max 120 seconds)
        const startTime = Date.now();
        const MAX_WAIT = 120000;
        const POLL_INTERVAL = 3000;

        while (Date.now() - startTime < MAX_WAIT) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));

            const statusResp = await fetch(
                `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
            );
            const statusData = await statusResp.json();
            const status = statusData.data?.status;

            if (status === 'SUCCEEDED') {
                const dataResp = await fetch(
                    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}`
                );
                const items = await dataResp.json();
                return res.status(200).json(items[0] || { error: 'Empty result' });
            }

            if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
                return res.status(500).json({ error: `Apify run ${status}` });
            }
        }

        return res.status(504).json({ error: 'Apify run timed out after 120s' });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
