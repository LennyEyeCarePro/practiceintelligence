/**
 * Vercel Serverless Function — PageSpeed / Lighthouse Proxy
 * Keeps the Google API key server-side (never exposed to the browser).
 *
 * The frontend calls: POST /api/lighthouse { url: "https://example.com" }
 * This function calls Google PageSpeed API and returns the results.
 */

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

    const API_KEY = process.env.PAGESPEED_API_KEY;
    if (!API_KEY) return res.status(500).json({ error: 'PAGESPEED_API_KEY not configured' });

    try {
        const categories = ['performance', 'seo', 'accessibility', 'best-practices'];
        const params = new URLSearchParams({ url, key: API_KEY, strategy: 'mobile' });
        categories.forEach(c => params.append('category', c));

        const resp = await fetch(
            `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`,
            {
                signal: AbortSignal.timeout(45000),
                headers: { 'Referer': 'https://practiceintelligence.vercel.app/' },
            }
        );

        if (!resp.ok) {
            const err = await resp.text();
            return res.status(resp.status).json({ error: `PageSpeed API error: ${resp.status}`, details: err });
        }

        const data = await resp.json();
        const cats = data.lighthouseResult?.categories || {};
        const audits = data.lighthouseResult?.audits || {};

        return res.status(200).json({
            performance: Math.round((cats.performance?.score || 0) * 100),
            seo: Math.round((cats.seo?.score || 0) * 100),
            accessibility: Math.round((cats.accessibility?.score || 0) * 100),
            bestPractices: Math.round((cats['best-practices']?.score || 0) * 100),
            fcp: audits['first-contentful-paint']?.displayValue || null,
            lcp: audits['largest-contentful-paint']?.displayValue || null,
            tbt: audits['total-blocking-time']?.displayValue || null,
            cls: audits['cumulative-layout-shift']?.displayValue || null,
            speedIndex: audits['speed-index']?.displayValue || null,
            interactive: audits['interactive']?.displayValue || null,
            serverResponseTime: audits['server-response-time']?.displayValue || null,
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
