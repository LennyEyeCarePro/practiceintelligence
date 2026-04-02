/**
 * Vercel Serverless Function — On-Page SEO Audit
 * Fetches a site's homepage HTML server-side and extracts SEO signals.
 * Also checks robots.txt and sitemap.xml.
 *
 * GET /api/site-audit?url=example.com
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });

    // Normalize domain
    const domain = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');

    try {
        // Fetch homepage, robots.txt, and sitemap.xml in parallel
        const [htmlResponse, robotsResponse, sitemapResponse] = await Promise.all([
            fetch(`https://${domain}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PracticeIntelligence-SEO-Bot/1.0)' },
                signal: AbortSignal.timeout(10000),
                redirect: 'follow',
            }).catch(() => null),
            fetch(`https://${domain}/robots.txt`, {
                signal: AbortSignal.timeout(5000),
            }).catch(() => null),
            fetch(`https://${domain}/sitemap.xml`, {
                signal: AbortSignal.timeout(5000),
            }).catch(() => null),
        ]);

        if (!htmlResponse || !htmlResponse.ok) {
            return res.json({ error: 'Could not fetch site', domain });
        }

        const html = await htmlResponse.text();
        const finalUrl = htmlResponse.url;

        // Robots.txt
        const robotsTxt = (robotsResponse?.ok) ? await robotsResponse.text() : null;
        const hasRobots = !!robotsTxt;
        const blocksGooglebot = robotsTxt
            ? /User-agent:\s*\*[\s\S]*?Disallow:\s*\/\s*$/m.test(robotsTxt) ||
              /User-agent:\s*Googlebot[\s\S]*?Disallow:\s*\/\s*$/m.test(robotsTxt)
            : false;

        // Sitemap
        const sitemapText = (sitemapResponse?.ok) ? await sitemapResponse.text() : null;
        const hasSitemap = sitemapResponse?.ok && sitemapText?.includes('<url');
        const sitemapUrlCount = hasSitemap ? (sitemapText.match(/<url>/gi) || []).length : 0;

        // ── On-page SEO checks ──
        const audit = {
            domain,
            finalUrl,

            // SSL
            ssl: finalUrl.startsWith('https://'),

            // Title tag
            titleTag: extractBetween(html, '<title>', '</title>'),
            titleLength: (extractBetween(html, '<title>', '</title>') || '').length,

            // Meta description
            metaDescription: extractMeta(html, 'description'),
            metaDescriptionLength: (extractMeta(html, 'description') || '').length,

            // H1
            h1: extractFirstTag(html, 'h1'),
            h1Count: (html.match(/<h1[\s>]/gi) || []).length,

            // H2 count (content structure)
            h2Count: (html.match(/<h2[\s>]/gi) || []).length,

            // Viewport (mobile-friendly)
            hasViewport: /name=["']viewport["']/i.test(html),

            // Schema markup
            hasSchemaMarkup: html.includes('application/ld+json'),
            hasLocalBusinessSchema: /"(?:LocalBusiness|MedicalBusiness|Optometrist|Physician|Dentist|HealthAndBeautyBusiness)"/.test(html),
            schemaTypes: extractSchemaTypes(html),

            // Booking signals
            hasBookingCTA: /book|schedule|appointment|reserve/i.test(html),
            hasOnlineBooking: /book\s*(?:online|now|an?\s*appointment)|schedule\s*(?:online|now|an?\s*appointment)|request\s*(?:an?\s*)?appointment/i.test(html),

            // NAP signals
            hasPhone: /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(html),
            hasAddress: /\d+\s+\w+\s+(?:street|st|avenue|ave|road|rd|blvd|boulevard|drive|dr|lane|ln|way|court|ct|circle|cir|place|pl|highway|hwy|pkwy|parkway)/i.test(html),

            // Social links
            hasFacebook: /facebook\.com\/(?!sharer)/i.test(html),
            hasInstagram: /instagram\.com\//i.test(html),
            hasYouTube: /youtube\.com\//i.test(html),
            hasLinkedIn: /linkedin\.com\//i.test(html),

            // Robots meta
            robotsMeta: extractMeta(html, 'robots'),
            isIndexable: !/noindex/i.test(extractMeta(html, 'robots') || ''),

            // Canonical
            hasCanonical: /rel=["']canonical["']/i.test(html),
            canonicalUrl: extractCanonical(html),

            // Image analysis
            totalImages: (html.match(/<img[\s>]/gi) || []).length,
            imagesWithAlt: (html.match(/<img[^>]+alt=["'][^"']+["']/gi) || []).length,
            altTextCoverage: 0,

            // Open Graph
            hasOgTitle: /og:title/i.test(html),
            hasOgDescription: /og:description/i.test(html),
            hasOgImage: /og:image/i.test(html),

            // Technical
            hasHreflang: /hreflang/i.test(html),
            hasFavicon: /rel=["'](?:shortcut\s+)?icon["']/i.test(html),
            doctype: html.trimStart().toLowerCase().startsWith('<!doctype'),

            // Robots.txt & Sitemap
            hasRobots,
            blocksGooglebot,
            hasSitemap,
            sitemapUrlCount,

            // Word count (rough content analysis)
            wordCount: html.replace(/<script[\s\S]*?<\/script>/gi, '')
                          .replace(/<style[\s\S]*?<\/style>/gi, '')
                          .replace(/<[^>]+>/g, ' ')
                          .replace(/\s+/g, ' ')
                          .trim()
                          .split(' ')
                          .filter(w => w.length > 1).length,
        };

        // Calculate alt text coverage percentage
        audit.altTextCoverage = audit.totalImages > 0
            ? Math.round((audit.imagesWithAlt / audit.totalImages) * 100)
            : 100;

        return res.json(audit);

    } catch (err) {
        return res.json({ error: err.message, domain });
    }
}

function extractBetween(html, start, end) {
    const s = html.indexOf(start);
    if (s === -1) return null;
    const e = html.indexOf(end, s + start.length);
    if (e === -1) return null;
    return html.slice(s + start.length, e).replace(/<[^>]+>/g, '').trim();
}

function extractFirstTag(html, tag) {
    const regex = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'is');
    const match = html.match(regex);
    return match ? match[1].replace(/<[^>]+>/g, '').trim() : null;
}

function extractMeta(html, name) {
    const r1 = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
    const r2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i');
    const match = html.match(r1) || html.match(r2);
    return match ? match[1] : null;
}

function extractCanonical(html) {
    const match = html.match(/rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
                  html.match(/href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
    return match ? match[1] : null;
}

function extractSchemaTypes(html) {
    const types = [];
    const regex = /"@type"\s*:\s*"([^"]+)"/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
        if (!types.includes(match[1])) types.push(match[1]);
    }
    return types;
}
