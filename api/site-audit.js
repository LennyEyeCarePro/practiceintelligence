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
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                },
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

        // Fallback: if bare domain failed, try www. prefix (some sites only respond at www)
        let finalResponse = htmlResponse;
        if (!finalResponse || !finalResponse.ok) {
            try {
                finalResponse = await fetch(`https://www.${domain}`, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                    },
                    signal: AbortSignal.timeout(10000),
                    redirect: 'follow',
                });
            } catch (_) { /* fall through */ }
        }

        if (!finalResponse || !finalResponse.ok) {
            return res.json({ error: 'Could not fetch site', domain, status: finalResponse?.status });
        }

        const html = await finalResponse.text();
        const finalUrl = finalResponse.url;

        // ── Security Headers (use finalResponse — the one that actually succeeded) ──
        const securityHeaders = {
            contentSecurityPolicy: finalResponse.headers.get('content-security-policy') ? true : false,
            xFrameOptions: finalResponse.headers.get('x-frame-options') || null,
            xContentTypeOptions: finalResponse.headers.get('x-content-type-options') || null,
            strictTransportSecurity: finalResponse.headers.get('strict-transport-security') ? true : false,
            xXssProtection: finalResponse.headers.get('x-xss-protection') || null,
            referrerPolicy: finalResponse.headers.get('referrer-policy') || null,
            permissionsPolicy: finalResponse.headers.get('permissions-policy') ? true : false,
        };
        const securityScore = [
            securityHeaders.contentSecurityPolicy,
            securityHeaders.xFrameOptions,
            securityHeaders.xContentTypeOptions === 'nosniff',
            securityHeaders.strictTransportSecurity,
            securityHeaders.referrerPolicy,
        ].filter(Boolean).length;

        // ── Redirect chain ──
        const redirectChain = [];
        if (finalResponse.redirected) {
            redirectChain.push({ from: `https://${domain}`, to: finalUrl });
        }

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
            hasOnlineBooking: /book\s*(?:online|now|an?\s*appointment)|schedule\s*(?:online|now|an?\s*appointment)|request\s*(?:an?\s*)?appointment|visualbook\.ca|visualbook\.com|localmed\.com|zocdoc\.com|nexhealth\.com|scheduleyourexam\.com|acuityscheduling\.com|calendly\.com/i.test(html),

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
            wordCount: 0, // computed below

            // ── NEW: Twitter Cards ──
            hasTwitterCard: /twitter:card/i.test(html),
            hasTwitterTitle: /twitter:title/i.test(html),
            hasTwitterImage: /twitter:image/i.test(html),
            twitterCardType: extractMeta(html, 'twitter:card'),

            // ── NEW: Security Headers ──
            securityHeaders,
            securityScore,

            // ── NEW: Redirect chain ──
            redirectChain,
            hasRedirect: redirectChain.length > 0,

            // ── NEW: Technology Detection ──
            technology: detectTechnology(html),

            // ── NEW: Link Analysis ──
            ...analyzeLinkStructure(html, domain),

            // ── NEW: JS/CSS file counts ──
            externalJsCount: (html.match(/<script[^>]+src=/gi) || []).length,
            externalCssCount: (html.match(/<link[^>]+stylesheet/gi) || []).length,
            inlineStyleCount: (html.match(/style=["']/gi) || []).length,
            inlineScriptCount: (html.match(/<script(?![^>]*src=)[^>]*>/gi) || []).length,

            // ── NEW: Duplicate meta detection ──
            duplicateTitles: (html.match(/<title[\s>]/gi) || []).length > 1,
            duplicateDescriptions: (html.match(/name=["']description["']/gi) || []).length > 1,

            // ── NEW: Content depth (H tags breakdown) ──
            h3Count: (html.match(/<h3[\s>]/gi) || []).length,
            h4Count: (html.match(/<h4[\s>]/gi) || []).length,

            // ── NEW: Keyword extraction & readability ──
            ...analyzeContent(html),

            // ── NEW: Misc detection ──
            hasGoogleAnalytics: /google-analytics\.com|googletagmanager\.com|gtag|ga\(/i.test(html),
            hasGoogleTagManager: /googletagmanager\.com/i.test(html),
            hasFacebookPixel: /facebook\.com\/tr|fbq\(|fb-pixel/i.test(html),
            hasHotjar: /hotjar\.com/i.test(html),
            hasLiveChat: /livechat|tawk\.to|intercom|crisp\.chat|drift\.com|zendesk|hubspot.*chat|olark/i.test(html),
            hasADA: /accessibe|userway|audioeye|ada.*compliance|equalweb/i.test(html),
            hasLazyLoading: /loading=["']lazy["']/i.test(html),
            hasAMP: /<html[^>]+amp|<html[^>]+⚡/i.test(html),
        };

        // Calculate word count and alt text coverage
        const bodyText = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                             .replace(/<style[\s\S]*?<\/style>/gi, '')
                             .replace(/<[^>]+>/g, ' ')
                             .replace(/\s+/g, ' ')
                             .trim();
        audit.wordCount = bodyText.split(' ').filter(w => w.length > 1).length;

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

/**
 * Detect the technology/platform powering the website
 */
function detectTechnology(html) {
    const techs = [];

    // CMS / Platform
    if (/wp-content|wp-includes|wordpress/i.test(html)) techs.push('WordPress');
    else if (/shopify/i.test(html) && /cdn\.shopify/i.test(html)) techs.push('Shopify');
    else if (/squarespace/i.test(html)) techs.push('Squarespace');
    else if (/wix\.com|wixsite/i.test(html)) techs.push('Wix');
    else if (/weebly/i.test(html)) techs.push('Weebly');
    else if (/webflow/i.test(html)) techs.push('Webflow');
    else if (/ghost/i.test(html) && /ghost-/i.test(html)) techs.push('Ghost');
    else if (/drupal/i.test(html)) techs.push('Drupal');
    else if (/joomla/i.test(html)) techs.push('Joomla');
    else if (/hubspot/i.test(html) && /hs-scripts/i.test(html)) techs.push('HubSpot CMS');
    else if (/godaddysites/i.test(html)) techs.push('GoDaddy');
    else if (/duda/i.test(html)) techs.push('Duda');

    // EyeCarePro specific
    if (/eyecarepro/i.test(html)) techs.push('EyeCarePro');

    // JS Frameworks
    if (/react/i.test(html) && /__NEXT_DATA__|next\.js/i.test(html)) techs.push('Next.js');
    else if (/react/i.test(html) || /data-reactroot|reactDOM/i.test(html)) techs.push('React');
    if (/vue/i.test(html) && /data-v-|__VUE__|nuxt/i.test(html)) techs.push('Vue.js');
    if (/angular/i.test(html) && /ng-version|ng-app/i.test(html)) techs.push('Angular');
    if (/gatsby/i.test(html)) techs.push('Gatsby');

    // CSS Frameworks
    if (/bootstrap/i.test(html)) techs.push('Bootstrap');
    if (/tailwind/i.test(html)) techs.push('Tailwind CSS');
    if (/foundation/i.test(html) && /foundation\.css/i.test(html)) techs.push('Foundation');

    // E-commerce
    if (/woocommerce/i.test(html)) techs.push('WooCommerce');
    if (/bigcommerce/i.test(html)) techs.push('BigCommerce');
    if (/magento/i.test(html)) techs.push('Magento');

    // Scheduling / Booking
    if (/localmed/i.test(html)) techs.push('LocalMed');
    if (/solutionreach/i.test(html)) techs.push('Solutionreach');
    if (/weave/i.test(html) && /getweave/i.test(html)) techs.push('Weave');
    if (/calendly/i.test(html)) techs.push('Calendly');
    if (/zocdoc/i.test(html)) techs.push('Zocdoc');
    if (/patientpop/i.test(html)) techs.push('PatientPop');

    // CDN
    if (/cloudflare/i.test(html)) techs.push('Cloudflare');
    if (/fastly/i.test(html)) techs.push('Fastly');
    if (/akamai/i.test(html)) techs.push('Akamai');

    // Analytics & Marketing
    if (/google-analytics|googletagmanager|gtag/i.test(html)) techs.push('Google Analytics');
    if (/facebook\.com\/tr|fbq\(/i.test(html)) techs.push('Facebook Pixel');
    if (/hotjar/i.test(html)) techs.push('Hotjar');
    if (/mailchimp/i.test(html)) techs.push('Mailchimp');
    if (/hubspot/i.test(html) && !/HubSpot CMS/.test(techs.join(','))) techs.push('HubSpot');

    return [...new Set(techs)]; // deduplicate
}

/**
 * Analyze internal vs external links
 */
function analyzeLinkStructure(html, domain) {
    const linkRegex = /href=["']([^"'#]+)["']/gi;
    let match;
    let internalLinks = 0;
    let externalLinks = 0;
    const externalDomains = new Set();

    while ((match = linkRegex.exec(html)) !== null) {
        const href = match[1];
        if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;

        if (href.startsWith('/') || href.includes(domain)) {
            internalLinks++;
        } else if (href.startsWith('http')) {
            externalLinks++;
            try {
                const extDomain = new URL(href).hostname.replace('www.', '');
                externalDomains.add(extDomain);
            } catch (_) {}
        }
    }

    return {
        internalLinkCount: internalLinks,
        externalLinkCount: externalLinks,
        uniqueExternalDomains: externalDomains.size,
        topExternalDomains: [...externalDomains].slice(0, 10),
    };
}

/**
 * Analyze page content — keyword extraction + readability
 */
function analyzeContent(html) {
    // Strip tags to get body text
    const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const words = text.split(' ').filter(w => w.length > 1);
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);

    // ── Readability (Flesch-Kincaid) ──
    const syllableCount = words.reduce((sum, w) => sum + countSyllables(w), 0);
    const avgWordsPerSentence = sentences.length > 0 ? words.length / sentences.length : 0;
    const avgSyllablesPerWord = words.length > 0 ? syllableCount / words.length : 0;

    // Flesch Reading Ease: 206.835 - 1.015 * (words/sentences) - 84.6 * (syllables/words)
    const fleschScore = Math.round(
        206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord
    );
    // Clamp between 0 and 100
    const readability = Math.max(0, Math.min(100, fleschScore));

    let readabilityLevel;
    if (readability >= 80) readabilityLevel = '6th grade — Easy';
    else if (readability >= 70) readabilityLevel = '7th grade — Fairly Easy';
    else if (readability >= 60) readabilityLevel = '8th-9th grade — Standard';
    else if (readability >= 50) readabilityLevel = '10th-12th grade — Fairly Difficult';
    else if (readability >= 30) readabilityLevel = 'College level — Difficult';
    else readabilityLevel = 'Graduate level — Very Difficult';

    // ── Keyword Extraction ──
    const stopWords = new Set([
        'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from',
        'is','are','was','were','be','been','being','have','has','had','do','does','did',
        'will','would','could','should','may','might','can','this','that','these','those',
        'it','its','we','our','you','your','he','she','they','them','his','her','their',
        'what','which','who','whom','where','when','how','why','not','no','all','each',
        'every','both','few','more','most','other','some','such','than','too','very',
        'just','about','also','into','over','after','before','between','under','again',
        'then','there','here','up','out','if','so','as','only','own','same','new',
        'now','way','may','said','one','two','first','even','back','well','much','get',
        'like','make','made','go','see','come','take','know','think','say','us','me',
        'my','am','any','many','through','right','still','per','call','click','learn',
        'read','find','contact','home','page','site','website',
    ]);

    const wordFreq = {};
    words.forEach(w => {
        const clean = w.toLowerCase().replace(/[^a-z]/g, '');
        if (clean.length < 3 || stopWords.has(clean)) return;
        wordFreq[clean] = (wordFreq[clean] || 0) + 1;
    });

    // Top 15 keywords by frequency
    const topKeywords = Object.entries(wordFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([word, count]) => ({
            word,
            count,
            density: words.length > 0 ? Math.round((count / words.length) * 1000) / 10 : 0,
        }));

    // ── 2-word phrases (bigrams) ──
    const bigramFreq = {};
    for (let i = 0; i < words.length - 1; i++) {
        const w1 = words[i].toLowerCase().replace(/[^a-z]/g, '');
        const w2 = words[i + 1].toLowerCase().replace(/[^a-z]/g, '');
        if (w1.length < 3 || w2.length < 3 || stopWords.has(w1) || stopWords.has(w2)) continue;
        const bigram = `${w1} ${w2}`;
        bigramFreq[bigram] = (bigramFreq[bigram] || 0) + 1;
    }
    const topPhrases = Object.entries(bigramFreq)
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([phrase, count]) => ({ phrase, count }));

    // ── Extract all H2 headings ──
    const h2Regex = /<h2[^>]*>(.*?)<\/h2>/gis;
    const h2Texts = [];
    let h2Match;
    while ((h2Match = h2Regex.exec(html)) !== null) {
        const cleaned = h2Match[1].replace(/<[^>]+>/g, '').trim();
        if (cleaned) h2Texts.push(cleaned);
    }

    return {
        readabilityScore: readability,
        readabilityLevel,
        avgWordsPerSentence: Math.round(avgWordsPerSentence),
        sentenceCount: sentences.length,
        topKeywords,
        topPhrases,
        h2Texts: h2Texts.slice(0, 10),
    };
}

function countSyllables(word) {
    word = word.toLowerCase().replace(/[^a-z]/g, '');
    if (word.length <= 3) return 1;
    word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
    word = word.replace(/^y/, '');
    const matches = word.match(/[aeiouy]{1,2}/g);
    return matches ? matches.length : 1;
}
