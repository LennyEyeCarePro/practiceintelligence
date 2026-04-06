/**
 * Vercel Serverless Function — Domain Authority Hub
 * Combines Open PageRank + Moz DA into a single endpoint.
 *
 * GET /api/pagerank?domain=example.com                          → Open PageRank
 * GET /api/pagerank?domain=example.com&competitors=a.com,b.com  → PageRank + competitors
 * GET /api/pagerank?domain=example.com&action=moz               → Moz Domain Authority
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { domain, action } = req.query;
    if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

    // Route to Moz handler
    if (action === 'moz') return handleMoz(req, res, domain);

    // Default: Open PageRank
    return handlePageRank(req, res, domain);
}

// ─── OPEN PAGERANK ─────────────────────────────────
async function handlePageRank(req, res, domain) {
    const { competitors } = req.query;

    const API_KEY = process.env.OPEN_PAGE_RANK_KEY;
    if (!API_KEY) {
        return res.json({ domain, pageRank: null, rank: null, error: 'OPEN_PAGE_RANK_KEY not configured' });
    }

    try {
        const cleanDomain = clean(domain);
        const allDomains = [cleanDomain];
        const competitorList = [];

        if (competitors) {
            competitors.split(',').map(d => clean(d)).filter(Boolean).slice(0, 15).forEach(d => {
                if (d !== cleanDomain && !allDomains.includes(d)) {
                    allDomains.push(d);
                    competitorList.push(d);
                }
            });
        }

        const queryString = allDomains.map(d => `domains[]=${encodeURIComponent(d)}`).join('&');
        const resp = await fetch(
            `https://openpagerank.com/api/v1.0/getPageRank?${queryString}`,
            { headers: { 'API-OPR': API_KEY }, signal: AbortSignal.timeout(10000) }
        );

        if (!resp.ok) {
            return res.json({ domain: cleanDomain, pageRank: null, rank: null, error: `API returned ${resp.status}` });
        }

        const data = await resp.json();
        const resultMap = {};
        (data.response || []).forEach(r => { resultMap[clean(r.domain || '')] = r; });

        const target = resultMap[cleanDomain] || {};
        const pr = target.page_rank_integer ?? null;

        const competitorResults = competitorList.map(d => {
            const r = resultMap[d] || {};
            return {
                domain: d,
                pageRank: r.page_rank_integer ?? null,
                pageRankDecimal: r.page_rank_decimal ?? null,
                rank: r.rank ?? null,
                label: getPRLabel(r.page_rank_integer),
            };
        }).sort((a, b) => (b.pageRank ?? -1) - (a.pageRank ?? -1));

        return res.json({
            domain: cleanDomain,
            pageRank: pr,
            pageRankDecimal: target.page_rank_decimal ?? null,
            rank: target.rank ?? null,
            label: getPRLabel(pr),
            benchmark: 'Average local business scores 2-4',
            competitors: competitorResults.length > 0 ? competitorResults : undefined,
        });

    } catch (err) {
        return res.json({ domain, pageRank: null, rank: null, error: err.message });
    }
}

// ─── MOZ DOMAIN AUTHORITY ──────────────────────────
async function handleMoz(req, res, domain) {
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

    const cleanDomain = clean(domain);

    try {
        const authToken = Buffer.from(`${ACCESS_ID}:${SECRET_KEY}`).toString('base64');

        const resp = await fetch('https://lsapi.seomoz.com/v2/url_metrics', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${authToken}`,
            },
            body: JSON.stringify({ targets: [`${cleanDomain}/`] }),
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
        return res.json({ domain: cleanDomain, error: err.message, domainAuthority: null, pageAuthority: null });
    }
}

function clean(d) {
    return d.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
}

function getPRLabel(pr) {
    if (pr == null) return 'Unknown';
    if (pr >= 7) return 'Strong';
    if (pr >= 5) return 'Established';
    if (pr >= 3) return 'Growing';
    return 'New / Low';
}
