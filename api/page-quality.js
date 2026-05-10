/**
 * Vercel Serverless Function — Page Quality Hub
 * Combines Lighthouse/PageSpeed + W3C HTML Validation into one endpoint.
 *
 * POST /api/page-quality { url: "https://example.com" }              → Lighthouse
 * GET  /api/page-quality?action=validate&url=example.com             → W3C + Rich Results
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // GET with action=validate → HTML validation
    if (req.method === 'GET' && req.query.action === 'validate') {
        return handleValidation(req, res);
    }

    // POST → Lighthouse
    if (req.method === 'POST') {
        return handleLighthouse(req, res);
    }

    // GET without action → also try Lighthouse via query param
    if (req.method === 'GET' && req.query.url && !req.query.action) {
        req.body = { url: req.query.url };
        return handleLighthouse(req, res);
    }

    return res.status(400).json({ error: 'POST with {url} for Lighthouse, or GET ?action=validate&url= for HTML validation' });
}

// ═══════════════════════════════════════════════════
//   Lighthouse / PageSpeed
// ═══════════════════════════════════════════════════
async function handleLighthouse(req, res) {
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
            fieldLcp: loadExp.LARGEST_CONTENTFUL_PAINT_MS?.percentile || null,
            fieldCls: loadExp.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile || null,
            fieldFid: loadExp.FIRST_INPUT_DELAY_MS?.percentile || null,
            fieldInp: loadExp.INTERACTION_TO_NEXT_PAINT?.percentile || null,
            overallCategory: data.loadingExperience?.overall_category || null,
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
        const [mobile, desktop] = await Promise.all([
            runPageSpeed('mobile'),
            runPageSpeed('desktop'),
        ]);
        return res.status(200).json({ mobile, desktop });
    } catch (err) {
        try {
            const mobile = await runPageSpeed('mobile');
            return res.status(200).json({ mobile, desktop: null });
        } catch (fallbackErr) {
            return res.status(500).json({ error: err.message });
        }
    }
}

// ═══════════════════════════════════════════════════
//   W3C HTML Validation + Rich Results
// ═══════════════════════════════════════════════════
async function handleValidation(req, res) {
    const rawUrl = (req.query.url || '').trim();
    if (!rawUrl) return res.status(400).json({ error: 'Missing url parameter' });

    const domain = rawUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    const targetUrl = `https://${domain}`;

    try {
        const [w3cResult, richResult] = await Promise.all([
            validateHTML(targetUrl),
            checkRichResults(targetUrl, domain),
        ]);

        return res.json({
            domain,
            url: targetUrl,
            validation: w3cResult,
            richResults: richResult,
        });

    } catch (err) {
        return res.json({
            error: err.message,
            domain,
            validation: { errors: [], warnings: [] },
            richResults: { schemas: [], eligible: [] },
        });
    }
}

async function validateHTML(url) {
    try {
        const validatorUrl = `https://validator.w3.org/nu/?doc=${encodeURIComponent(url)}&out=json`;

        const resp = await fetch(validatorUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Tool/1.0)' },
            signal: AbortSignal.timeout(15000),
        });

        if (!resp.ok) {
            return { error: `W3C returned ${resp.status}`, errors: [], warnings: [] };
        }

        const data = await resp.json();
        const messages = data.messages || [];

        const errors = [];
        const warnings = [];
        const info = [];

        messages.forEach(msg => {
            const entry = {
                message: msg.message,
                type: msg.type,
                line: msg.lastLine || msg.firstLine,
                column: msg.lastColumn || msg.firstColumn,
                extract: msg.extract ? msg.extract.slice(0, 120) : null,
            };

            if (msg.type === 'error') {
                errors.push(entry);
            } else if (msg.type === 'info' && msg.subType === 'warning') {
                warnings.push(entry);
            } else {
                info.push(entry);
            }
        });

        const errorCategories = categorizeErrors(errors);

        let validationScore;
        if (errors.length === 0) validationScore = 100;
        else if (errors.length <= 5) validationScore = 85;
        else if (errors.length <= 15) validationScore = 70;
        else if (errors.length <= 30) validationScore = 50;
        else validationScore = Math.max(10, 100 - errors.length);

        let validationLabel;
        if (validationScore >= 90) validationLabel = 'Excellent';
        else if (validationScore >= 70) validationLabel = 'Good';
        else if (validationScore >= 50) validationLabel = 'Fair';
        else validationLabel = 'Poor';

        return {
            errors: errors.slice(0, 20),
            warnings: warnings.slice(0, 10),
            errorCount: errors.length,
            warningCount: warnings.length,
            infoCount: info.length,
            errorCategories,
            validationScore,
            validationLabel,
        };

    } catch (err) {
        return {
            error: err.message,
            errors: [],
            warnings: [],
            errorCount: 0,
            warningCount: 0,
        };
    }
}

function categorizeErrors(errors) {
    const cats = {
        accessibility: 0, deprecated: 0, structuralSEO: 0,
        syntax: 0, performance: 0, other: 0,
    };

    errors.forEach(e => {
        const msg = e.message.toLowerCase();
        if (/alt|aria|label|role|tabindex|accessib/i.test(msg)) cats.accessibility++;
        else if (/deprecated|obsolete/i.test(msg)) cats.deprecated++;
        else if (/heading|meta|title|h[1-6]|lang|charset/i.test(msg)) cats.structuralSEO++;
        else if (/unclosed|missing|stray|unexpected|attribute|duplicate/i.test(msg)) cats.syntax++;
        else if (/async|defer|preload|prefetch/i.test(msg)) cats.performance++;
        else cats.other++;
    });

    return cats;
}

async function checkRichResults(url, domain) {
    try {
        const resp = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            signal: AbortSignal.timeout(8000),
            redirect: 'follow',
        });

        if (!resp.ok) return { schemas: [], eligible: [], error: `HTTP ${resp.status}` };

        const html = await resp.text();

        const jsonLdBlocks = [];
        const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
        let match;
        while ((match = jsonLdRegex.exec(html)) !== null) {
            try {
                const data = JSON.parse(match[1]);
                if (Array.isArray(data)) data.forEach(d => jsonLdBlocks.push(d));
                else jsonLdBlocks.push(data);
            } catch (_) {}
        }

        const schemas = [];
        jsonLdBlocks.forEach(block => {
            if (block['@graph'] && Array.isArray(block['@graph'])) {
                block['@graph'].forEach(item => {
                    if (item['@type']) schemas.push(normalizeSchema(item));
                });
            } else if (block['@type']) {
                schemas.push(normalizeSchema(block));
            }
        });

        const microdataTypes = [];
        const mdRegex = /itemtype=["'](https?:\/\/schema\.org\/([^"']+))["']/gi;
        while ((match = mdRegex.exec(html)) !== null) {
            microdataTypes.push(match[2]);
        }

        const eligible = [];
        const missing = [];
        const schemaTypes = schemas.map(s => s.type.toLowerCase());
        const allTypes = [...schemaTypes, ...microdataTypes.map(t => t.toLowerCase())];

        if (allTypes.some(t => t.includes('localbusiness') || t.includes('organization') || t.includes('medicalclinic'))) {
            const biz = schemas.find(s => s.type.toLowerCase().includes('localbusiness') || s.type.toLowerCase().includes('organization'));
            const hasName = biz?.hasField?.includes('name');
            const hasAddress = biz?.hasField?.includes('address');
            const hasPhone = biz?.hasField?.includes('telephone');
            eligible.push({ type: 'Local Business', status: hasName && hasAddress ? 'eligible' : 'partial', fields: { name: hasName, address: hasAddress, phone: hasPhone } });
        } else {
            missing.push({ type: 'LocalBusiness', impact: 'high', reason: 'Critical for local SEO rich results' });
        }

        if (allTypes.some(t => t.includes('faqpage'))) eligible.push({ type: 'FAQ', status: 'eligible' });
        else missing.push({ type: 'FAQPage', impact: 'medium', reason: 'Can show expandable FAQ in search results' });

        if (allTypes.some(t => t.includes('breadcrumblist'))) eligible.push({ type: 'Breadcrumb', status: 'eligible' });
        if (allTypes.some(t => t.includes('review') || t.includes('aggregaterating'))) eligible.push({ type: 'Review Stars', status: 'eligible' });
        else missing.push({ type: 'AggregateRating', impact: 'high', reason: 'Shows star ratings in search results — major CTR boost' });
        if (allTypes.some(t => t.includes('article') || t.includes('blogposting') || t.includes('newsarticle'))) eligible.push({ type: 'Article', status: 'eligible' });
        if (allTypes.some(t => t.includes('product'))) eligible.push({ type: 'Product', status: 'eligible' });
        if (allTypes.some(t => t.includes('event'))) eligible.push({ type: 'Event', status: 'eligible' });
        if (allTypes.some(t => t.includes('howto'))) eligible.push({ type: 'How-To', status: 'eligible' });
        if (allTypes.some(t => t.includes('videoobject'))) eligible.push({ type: 'Video', status: 'eligible' });
        if (allTypes.some(t => t === 'website')) eligible.push({ type: 'Sitelinks Search Box', status: 'eligible' });

        return {
            schemas: schemas.slice(0, 15), microdataTypes, eligible,
            missing: missing.slice(0, 8),
            totalSchemas: schemas.length + microdataTypes.length,
            hasStructuredData: schemas.length > 0 || microdataTypes.length > 0,
        };

    } catch (err) {
        return { error: err.message, schemas: [], eligible: [], missing: [], hasStructuredData: false };
    }
}

function normalizeSchema(item) {
    const type = Array.isArray(item['@type']) ? item['@type'].join(', ') : item['@type'] || 'Unknown';
    const fields = Object.keys(item).filter(k => !k.startsWith('@'));
    return {
        type, hasField: fields, fieldCount: fields.length,
        name: item.name || null,
        description: item.description ? item.description.slice(0, 100) : null,
    };
}
