/**
 * Vercel Serverless Function — Open PageRank (with bulk competitor support)
 * Returns domain authority scores from openpagerank.com
 * Supports up to 100 domains in a single API call.
 *
 * GET /api/pagerank?domain=example.com
 * GET /api/pagerank?domain=example.com&competitors=comp1.com,comp2.com,comp3.com
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { domain, competitors } = req.query;
    if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

    const API_KEY = process.env.OPEN_PAGE_RANK_KEY;
    if (!API_KEY) {
        return res.json({
            domain,
            pageRank: null,
            rank: null,
            error: 'OPEN_PAGE_RANK_KEY not configured',
        });
    }

    try {
        const cleanDomain = clean(domain);

        // Build bulk domain list: target + competitors
        const allDomains = [cleanDomain];
        const competitorList = [];

        if (competitors) {
            const compArray = competitors.split(',').map(d => clean(d)).filter(Boolean);
            compArray.slice(0, 15).forEach(d => {
                if (d !== cleanDomain && !allDomains.includes(d)) {
                    allDomains.push(d);
                    competitorList.push(d);
                }
            });
        }

        // Single API call for all domains (up to 100 supported)
        const queryString = allDomains.map(d => `domains[]=${encodeURIComponent(d)}`).join('&');
        const resp = await fetch(
            `https://openpagerank.com/api/v1.0/getPageRank?${queryString}`,
            {
                headers: { 'API-OPR': API_KEY },
                signal: AbortSignal.timeout(10000),
            }
        );

        if (!resp.ok) {
            return res.json({ domain: cleanDomain, pageRank: null, rank: null, error: `API returned ${resp.status}` });
        }

        const data = await resp.json();
        const results = data.response || [];

        // Map results by domain
        const resultMap = {};
        results.forEach(r => {
            const d = clean(r.domain || '');
            resultMap[d] = r;
        });

        // Target domain result
        const target = resultMap[cleanDomain] || {};
        const pr = target.page_rank_integer ?? null;

        // Competitor results
        const competitorResults = competitorList.map(d => {
            const r = resultMap[d] || {};
            return {
                domain: d,
                pageRank: r.page_rank_integer ?? null,
                pageRankDecimal: r.page_rank_decimal ?? null,
                rank: r.rank ?? null,
                label: getLabel(r.page_rank_integer),
            };
        }).sort((a, b) => (b.pageRank ?? -1) - (a.pageRank ?? -1));

        return res.json({
            domain: cleanDomain,
            pageRank: pr,
            pageRankDecimal: target.page_rank_decimal ?? null,
            rank: target.rank ?? null,
            label: getLabel(pr),
            benchmark: 'Average local business scores 2-4',
            competitors: competitorResults.length > 0 ? competitorResults : undefined,
        });

    } catch (err) {
        return res.json({ domain, pageRank: null, rank: null, error: err.message });
    }
}

function clean(d) {
    return d.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
}

function getLabel(pr) {
    if (pr == null) return 'Unknown';
    if (pr >= 7) return 'Strong';
    if (pr >= 5) return 'Established';
    if (pr >= 3) return 'Growing';
    return 'New / Low';
}
