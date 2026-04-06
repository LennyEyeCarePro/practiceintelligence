/**
 * Vercel Serverless Function — W3C HTML Validation + Rich Results Check
 * Validates HTML using the free W3C Nu Validator API and checks
 * structured data eligibility for Google Rich Results.
 *
 * Fully free — no API key needed.
 * W3C Validator: https://validator.w3.org/nu/
 *
 * GET /api/html-validate?url=example.com
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

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

/**
 * Validate HTML using W3C Nu Validator
 */
async function validateHTML(url) {
    try {
        const validatorUrl = `https://validator.w3.org/nu/?doc=${encodeURIComponent(url)}&out=json`;

        const resp = await fetch(validatorUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; SEO-Tool/1.0)',
            },
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

        // Categorize errors by type for actionable insights
        const errorCategories = categorizeErrors(errors);

        // Calculate a validation score
        const totalIssues = errors.length + warnings.length;
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

/**
 * Categorize HTML validation errors into actionable groups
 */
function categorizeErrors(errors) {
    const cats = {
        accessibility: 0,    // alt text, aria, label issues
        deprecated: 0,       // deprecated tags/attributes
        structuralSEO: 0,    // heading hierarchy, meta issues
        syntax: 0,           // unclosed tags, attribute issues
        performance: 0,      // render-blocking, resource hints
        other: 0,
    };

    errors.forEach(e => {
        const msg = e.message.toLowerCase();
        if (/alt|aria|label|role|tabindex|accessib/i.test(msg)) {
            cats.accessibility++;
        } else if (/deprecated|obsolete/i.test(msg)) {
            cats.deprecated++;
        } else if (/heading|meta|title|h[1-6]|lang|charset/i.test(msg)) {
            cats.structuralSEO++;
        } else if (/unclosed|missing|stray|unexpected|attribute|duplicate/i.test(msg)) {
            cats.syntax++;
        } else if (/async|defer|preload|prefetch/i.test(msg)) {
            cats.performance++;
        } else {
            cats.other++;
        }
    });

    return cats;
}

/**
 * Check for Rich Results eligibility via structured data analysis
 */
async function checkRichResults(url, domain) {
    try {
        // Fetch the page HTML directly for structured data analysis
        const resp = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            signal: AbortSignal.timeout(8000),
            redirect: 'follow',
        });

        if (!resp.ok) return { schemas: [], eligible: [], error: `HTTP ${resp.status}` };

        const html = await resp.text();

        // Extract JSON-LD structured data
        const jsonLdBlocks = [];
        const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
        let match;
        while ((match = jsonLdRegex.exec(html)) !== null) {
            try {
                const data = JSON.parse(match[1]);
                if (Array.isArray(data)) {
                    data.forEach(d => jsonLdBlocks.push(d));
                } else {
                    jsonLdBlocks.push(data);
                }
            } catch (_) {}
        }

        // Also check @graph arrays
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

        // Check for microdata
        const microdataTypes = [];
        const mdRegex = /itemtype=["'](https?:\/\/schema\.org\/([^"']+))["']/gi;
        while ((match = mdRegex.exec(html)) !== null) {
            microdataTypes.push(match[2]);
        }

        // Determine Rich Result eligibility
        const eligible = [];
        const missing = [];

        // Check for each rich result type
        const schemaTypes = schemas.map(s => s.type.toLowerCase());
        const allTypes = [...schemaTypes, ...microdataTypes.map(t => t.toLowerCase())];

        // LocalBusiness / Organization
        if (allTypes.some(t => t.includes('localbusiness') || t.includes('organization') || t.includes('medicalclinic'))) {
            const biz = schemas.find(s => s.type.toLowerCase().includes('localbusiness') || s.type.toLowerCase().includes('organization'));
            const hasName = biz?.hasField?.includes('name');
            const hasAddress = biz?.hasField?.includes('address');
            const hasPhone = biz?.hasField?.includes('telephone');
            eligible.push({
                type: 'Local Business',
                status: hasName && hasAddress ? 'eligible' : 'partial',
                fields: { name: hasName, address: hasAddress, phone: hasPhone },
            });
        } else {
            missing.push({ type: 'LocalBusiness', impact: 'high', reason: 'Critical for local SEO rich results' });
        }

        // FAQ
        if (allTypes.some(t => t.includes('faqpage'))) {
            eligible.push({ type: 'FAQ', status: 'eligible' });
        } else {
            missing.push({ type: 'FAQPage', impact: 'medium', reason: 'Can show expandable FAQ in search results' });
        }

        // Breadcrumb
        if (allTypes.some(t => t.includes('breadcrumblist'))) {
            eligible.push({ type: 'Breadcrumb', status: 'eligible' });
        }

        // Review / AggregateRating
        if (allTypes.some(t => t.includes('review') || t.includes('aggregaterating'))) {
            eligible.push({ type: 'Review Stars', status: 'eligible' });
        } else {
            missing.push({ type: 'AggregateRating', impact: 'high', reason: 'Shows star ratings in search results — major CTR boost' });
        }

        // Article
        if (allTypes.some(t => t.includes('article') || t.includes('blogposting') || t.includes('newsarticle'))) {
            eligible.push({ type: 'Article', status: 'eligible' });
        }

        // Product
        if (allTypes.some(t => t.includes('product'))) {
            eligible.push({ type: 'Product', status: 'eligible' });
        }

        // Event
        if (allTypes.some(t => t.includes('event'))) {
            eligible.push({ type: 'Event', status: 'eligible' });
        }

        // HowTo
        if (allTypes.some(t => t.includes('howto'))) {
            eligible.push({ type: 'How-To', status: 'eligible' });
        }

        // Video
        if (allTypes.some(t => t.includes('videoobject'))) {
            eligible.push({ type: 'Video', status: 'eligible' });
        }

        // Website (sitelinks search box)
        if (allTypes.some(t => t === 'website')) {
            eligible.push({ type: 'Sitelinks Search Box', status: 'eligible' });
        }

        return {
            schemas: schemas.slice(0, 15),
            microdataTypes,
            eligible,
            missing: missing.slice(0, 8),
            totalSchemas: schemas.length + microdataTypes.length,
            hasStructuredData: schemas.length > 0 || microdataTypes.length > 0,
        };

    } catch (err) {
        return {
            error: err.message,
            schemas: [],
            eligible: [],
            missing: [],
            hasStructuredData: false,
        };
    }
}

/**
 * Normalize a JSON-LD schema block for display
 */
function normalizeSchema(item) {
    const type = Array.isArray(item['@type']) ? item['@type'].join(', ') : item['@type'] || 'Unknown';
    const fields = Object.keys(item).filter(k => !k.startsWith('@'));

    return {
        type,
        hasField: fields,
        fieldCount: fields.length,
        name: item.name || null,
        description: item.description ? item.description.slice(0, 100) : null,
    };
}
