/**
 * Vercel Serverless Function — Open PageRank
 * Returns domain authority score from openpagerank.com
 *
 * GET /api/pagerank?domain=example.com
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { domain } = req.query;
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
        const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

        const resp = await fetch(
            `https://openpagerank.com/api/v1.0/getPageRank?domains[]=${encodeURIComponent(cleanDomain)}`,
            {
                headers: { 'API-OPR': API_KEY },
                signal: AbortSignal.timeout(8000),
            }
        );

        if (!resp.ok) {
            return res.json({ domain: cleanDomain, pageRank: null, rank: null, error: `API returned ${resp.status}` });
        }

        const data = await resp.json();
        const result = data.response?.[0] || {};

        const pr = result.page_rank_integer ?? null;
        let label = 'Unknown';
        if (pr !== null) {
            if (pr >= 7) label = 'Strong';
            else if (pr >= 5) label = 'Established';
            else if (pr >= 3) label = 'Growing';
            else label = 'New / Low';
        }

        return res.json({
            domain: cleanDomain,
            pageRank: pr,
            pageRankDecimal: result.page_rank_decimal ?? null,
            rank: result.rank ?? null,
            label,
            benchmark: 'Average optometry practice scores 2-4',
        });

    } catch (err) {
        return res.json({ domain, pageRank: null, rank: null, error: err.message });
    }
}
