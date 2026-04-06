/**
 * Vercel Serverless Function — Moz Link API (Domain Authority)
 * Returns DA, PA, backlink metrics from Moz's free tier.
 *
 * Free tier: 25 requests/day — more than enough for an internal tool.
 * Requires MOZ_ACCESS_ID and MOZ_SECRET_KEY env vars.
 *
 * GET /api/moz-da?domain=example.com
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { domain } = req.query;
    if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

    const ACCESS_ID = process.env.MOZ_ACCESS_ID;
    const SECRET_KEY = process.env.MOZ_SECRET_KEY;

    if (!ACCESS_ID || !SECRET_KEY) {
        return res.json({
            domain,
            error: 'MOZ_ACCESS_ID and MOZ_SECRET_KEY not configured',
            domainAuthority: null,
            pageAuthority: null,
        });
    }

    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

    try {
        // Moz Links API v2 — uses Basic auth with Access ID : Secret Key
        const authToken = Buffer.from(`${ACCESS_ID}:${SECRET_KEY}`).toString('base64');

        const resp = await fetch('https://lsapi.seomoz.com/v2/url_metrics', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${authToken}`,
            },
            body: JSON.stringify({
                targets: [`${cleanDomain}/`],
            }),
            signal: AbortSignal.timeout(10000),
        });

        if (!resp.ok) {
            const errText = await resp.text();
            return res.json({
                domain: cleanDomain,
                error: `Moz API ${resp.status}: ${errText.slice(0, 200)}`,
                domainAuthority: null,
                pageAuthority: null,
            });
        }

        const data = await resp.json();
        const result = data.results?.[0] || {};

        // Moz fields:
        // domain_authority (0-100), page_authority (0-100), spam_score (0-100),
        // root_domains_to_root_domain, external_pages_to_root_domain
        const da = result.domain_authority ?? null;
        const pa = result.page_authority ?? null;
        const spamScore = result.spam_score ?? null;
        const linkingDomains = result.root_domains_to_root_domain ?? null;
        const externalLinks = result.external_pages_to_root_domain ?? null;

        let daLabel;
        if (da === null) daLabel = 'Unknown';
        else if (da >= 60) daLabel = 'Strong';
        else if (da >= 40) daLabel = 'Established';
        else if (da >= 20) daLabel = 'Growing';
        else daLabel = 'New / Low';

        let spamLabel;
        if (spamScore === null) spamLabel = 'Unknown';
        else if (spamScore <= 30) spamLabel = 'Low risk';
        else if (spamScore <= 60) spamLabel = 'Moderate risk';
        else spamLabel = 'High risk';

        return res.json({
            domain: cleanDomain,
            domainAuthority: da !== null ? Math.round(da) : null,
            pageAuthority: pa !== null ? Math.round(pa) : null,
            spamScore: spamScore !== null ? Math.round(spamScore) : null,
            spamLabel,
            linkingDomains,
            externalLinks,
            daLabel,
        });

    } catch (err) {
        return res.json({
            domain: cleanDomain,
            error: err.message,
            domainAuthority: null,
            pageAuthority: null,
        });
    }
}
