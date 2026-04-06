/**
 * Vercel Serverless Function — Google Safe Browsing API
 * Checks if a URL/domain is flagged for malware, phishing, unwanted software, etc.
 *
 * Free: 10,000 requests/day.
 * Requires GOOGLE_SAFE_BROWSING_KEY env var (or reuses GOOGLE_PLACES_KEY).
 *
 * GET /api/safe-browsing?url=example.com
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });

    // Use dedicated key or fall back to Places key (both are Google Cloud keys)
    const API_KEY = process.env.GOOGLE_SAFE_BROWSING_KEY || process.env.GOOGLE_PLACES_KEY;
    if (!API_KEY) {
        return res.json({
            url,
            error: 'GOOGLE_SAFE_BROWSING_KEY not configured',
            safe: null,
            threats: [],
        });
    }

    const domain = url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

    try {
        // Check both HTTP and HTTPS versions
        const urls = [
            `https://${domain}/`,
            `http://${domain}/`,
            `https://www.${domain}/`,
        ];

        const resp = await fetch(
            `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client: {
                        clientId: 'eyecarepro-seo-tool',
                        clientVersion: '1.0.0',
                    },
                    threatInfo: {
                        threatTypes: [
                            'MALWARE',
                            'SOCIAL_ENGINEERING',
                            'UNWANTED_SOFTWARE',
                            'POTENTIALLY_HARMFUL_APPLICATION',
                        ],
                        platformTypes: ['ANY_PLATFORM'],
                        threatEntryTypes: ['URL'],
                        threatEntries: urls.map(u => ({ url: u })),
                    },
                }),
                signal: AbortSignal.timeout(8000),
            }
        );

        if (!resp.ok) {
            const errText = await resp.text();
            return res.json({
                domain,
                error: `Safe Browsing API ${resp.status}: ${errText.slice(0, 200)}`,
                safe: null,
                threats: [],
            });
        }

        const data = await resp.json();
        const matches = data.matches || [];

        if (matches.length === 0) {
            return res.json({
                domain,
                safe: true,
                threats: [],
                summary: 'No threats detected — site is clean',
            });
        }

        // Map threat types to human-readable labels
        const threatLabels = {
            'MALWARE': 'Malware',
            'SOCIAL_ENGINEERING': 'Phishing / Social Engineering',
            'UNWANTED_SOFTWARE': 'Unwanted Software',
            'POTENTIALLY_HARMFUL_APPLICATION': 'Potentially Harmful App',
        };

        const threats = [...new Set(matches.map(m => m.threatType))].map(t => ({
            type: t,
            label: threatLabels[t] || t,
        }));

        return res.json({
            domain,
            safe: false,
            threats,
            summary: `WARNING: ${threats.map(t => t.label).join(', ')} detected`,
        });

    } catch (err) {
        return res.json({
            domain,
            error: err.message,
            safe: null,
            threats: [],
        });
    }
}
