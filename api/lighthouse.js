/**
 * Vercel Serverless Function — PageSpeed / Lighthouse Proxy (Expanded)
 * Runs BOTH mobile and desktop strategies, extracts Core Web Vitals,
 * failing audits, and loading experience data.
 *
 * POST /api/lighthouse { url: "https://example.com" }
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

    const API_KEY = process.env.PAGESPEED_API_KEY;
    if (!API_KEY) return res.status(500).json({ error: 'PAGESPEED_API_KEY not configured' });

    async function runPageSpeed(strategy) {
        const categories = ['performance', 'seo', 'accessibility', 'best-practices'];
        const params = new URLSearchParams({ url, key: API_KEY, strategy });
        categories.forEach(c => params.append('category', c));

        const resp = await fetch(
            `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`,
            {
                signal: AbortSignal.timeout(45000),
                headers: { 'Referer': 'https://practiceintelligence-lennys-projects-2067cb84.vercel.app/' },
            }
        );

        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`PageSpeed API ${strategy} error: ${resp.status} — ${err.slice(0, 200)}`);
        }

        const data = await resp.json();
        const cats = data.lighthouseResult?.categories || {};
        const audits = data.lighthouseResult?.audits || {};
        const loadExp = data.loadingExperience?.metrics || {};

        return {
            strategy,
            // Category scores (0-100)
            performance: Math.round((cats.performance?.score || 0) * 100),
            seo: Math.round((cats.seo?.score || 0) * 100),
            accessibility: Math.round((cats.accessibility?.score || 0) * 100),
            bestPractices: Math.round((cats['best-practices']?.score || 0) * 100),

            // Core Web Vitals — lab data
            fcp: audits['first-contentful-paint']?.displayValue || null,
            lcp: audits['largest-contentful-paint']?.displayValue || null,
            tbt: audits['total-blocking-time']?.displayValue || null,
            cls: audits['cumulative-layout-shift']?.displayValue || null,
            speedIndex: audits['speed-index']?.displayValue || null,
            interactive: audits['interactive']?.displayValue || null,
            serverResponseTime: audits['server-response-time']?.displayValue || null,

            // Core Web Vitals — real field data (CrUX)
            fieldLcp: loadExp.LARGEST_CONTENTFUL_PAINT_MS?.percentile || null,
            fieldCls: loadExp.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile || null,
            fieldFid: loadExp.FIRST_INPUT_DELAY_MS?.percentile || null,
            fieldInp: loadExp.INTERACTION_TO_NEXT_PAINT?.percentile || null,
            overallCategory: data.loadingExperience?.overall_category || null,

            // Specific failing audits (score 0-1, null if not present)
            auditRenderBlocking: audits['render-blocking-resources']?.score ?? null,
            auditOptimizedImages: audits['uses-optimized-images']?.score ?? null,
            auditResponsiveImages: audits['uses-responsive-images']?.score ?? null,
            auditAnimatedContent: audits['efficient-animated-content']?.score ?? null,
            auditTextCompression: audits['uses-text-compression']?.score ?? null,
            auditMinifiedCss: audits['unminified-css']?.score ?? null,
            auditMinifiedJs: audits['unminified-javascript']?.score ?? null,
            auditCachePolicy: audits['uses-long-cache-ttl']?.score ?? null,
            auditRedirects: audits['redirects']?.score ?? null,
        };
    }

    try {
        // Run mobile and desktop in parallel
        const [mobile, desktop] = await Promise.all([
            runPageSpeed('mobile'),
            runPageSpeed('desktop'),
        ]);

        return res.status(200).json({ mobile, desktop });

    } catch (err) {
        // If parallel fails, try mobile only as fallback
        try {
            const mobile = await runPageSpeed('mobile');
            return res.status(200).json({ mobile, desktop: null });
        } catch (fallbackErr) {
            return res.status(500).json({ error: err.message });
        }
    }
}
