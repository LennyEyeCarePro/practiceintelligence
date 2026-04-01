/**
 * EyeCarePro Practice Intelligence Scraper — Apify Actor
 *
 * Takes a single eye care practice URL and returns a comprehensive
 * Practice Intelligence Dossier in JSON. Purpose-built for the
 * Jedi v2 Practice Growth Assessment.
 *
 * Data tiers:
 *   1. Homepage scrape (DOM parsing, meta extraction)
 *   2. Subpage crawl (services, about, contact, optical pages)
 *   3. Technical audit (SSL, sitemap, robots, schema, performance)
 *   4. Content quality analysis (word counts, freshness, readability)
 *   5. Social link extraction + profile URLs for downstream analysis
 */

const { Actor } = require('apify');
const puppeteer = require('puppeteer');
const {
    VENDORS, CMS_SIGNALS, SCHEDULING_PLATFORMS, EHR_PMS,
    SERVICES, FRAME_BRANDS, INSURANCE_PROVIDERS, REVIEW_PLATFORMS,
    ACCESSIBILITY_WIDGETS, ANALYTICS, SOCIAL_PLATFORMS, FORM_PLATFORMS,
    PAYMENT_SYSTEMS, TELEHEALTH,
} = require('./dictionaries');

// ─── CONFIGURATION ──────────────────────────────────────────────────
const MAX_PAGES = 25;             // Max pages to crawl per site
const PAGE_TIMEOUT = 30000;       // 30s per page navigation
const WAIT_AFTER_LOAD = 2000;     // Wait for JS to render
const VIEWPORT = { width: 1366, height: 768 };

// ─── UTILITY FUNCTIONS ──────────────────────────────────────────────

/**
 * Normalize a URL to canonical form
 */
function normalizeUrl(input) {
    let url = input.trim().toLowerCase();
    url = url.replace(/\/+$/, '');
    if (!url.startsWith('http')) url = 'https://' + url;
    return url;
}

/**
 * Extract the base domain from a URL
 */
function getDomain(url) {
    try {
        const u = new URL(url);
        return u.hostname.replace(/^www\./, '');
    } catch {
        return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    }
}

/**
 * Search text for pattern matches (case-insensitive)
 * Returns all matched pattern strings
 */
function findMatches(text, patterns) {
    const lower = text.toLowerCase();
    return patterns.filter(p => {
        try {
            return new RegExp(p, 'i').test(lower);
        } catch {
            return lower.includes(p.toLowerCase());
        }
    });
}

/**
 * Search text against a dictionary of items with patterns
 * Returns array of { id, name, matchedPattern }
 */
function detectFromDictionary(text, dictionary) {
    const results = [];
    const lower = text.toLowerCase();
    for (const item of dictionary) {
        for (const pattern of item.patterns) {
            try {
                if (new RegExp(pattern, 'i').test(lower)) {
                    results.push({ id: item.id, name: item.name, matchedPattern: pattern });
                    break;
                }
            } catch {
                if (lower.includes(pattern.toLowerCase())) {
                    results.push({ id: item.id, name: item.name, matchedPattern: pattern });
                    break;
                }
            }
        }
    }
    return results;
}

/**
 * Detect services from text using the SERVICES taxonomy
 * Returns { detected: [...], categories: { optometry: [...], surgical: [...], ... } }
 */
function detectServices(text) {
    const detected = [];
    const categories = {};
    const lower = text.toLowerCase();

    for (const [key, svc] of Object.entries(SERVICES)) {
        for (const pattern of svc.patterns) {
            try {
                if (new RegExp(pattern, 'i').test(lower)) {
                    detected.push({ id: key, label: svc.label, category: svc.category });
                    if (!categories[svc.category]) categories[svc.category] = [];
                    categories[svc.category].push(svc.label);
                    break;
                }
            } catch {
                if (lower.includes(pattern.toLowerCase())) {
                    detected.push({ id: key, label: svc.label, category: svc.category });
                    if (!categories[svc.category]) categories[svc.category] = [];
                    categories[svc.category].push(svc.label);
                    break;
                }
            }
        }
    }

    return { detected, categories, totalCount: detected.length };
}

/**
 * Detect frame brands and classify by tier
 */
function detectFrameBrands(text) {
    const lower = text.toLowerCase();
    const found = {};

    for (const [tier, brands] of Object.entries(FRAME_BRANDS)) {
        const matched = brands.filter(b => {
            try {
                return new RegExp(b, 'i').test(lower);
            } catch {
                return lower.includes(b.toLowerCase());
            }
        });
        if (matched.length > 0) {
            found[tier] = matched;
        }
    }

    // Determine positioning
    let positioning = 'unknown';
    if (found.luxury && found.luxury.length > 0) positioning = 'luxury';
    else if (found.premium && found.premium.length > 0) positioning = 'premium';
    else if (found.independent && found.independent.length > 0) positioning = 'boutique/independent';
    else if (found.mainstream && found.mainstream.length > 0) positioning = 'mainstream';
    else if (found.value && found.value.length > 0) positioning = 'value/discount';

    const totalBrands = Object.values(found).reduce((sum, arr) => sum + arr.length, 0);

    return { brands: found, totalBrands, positioning };
}

/**
 * Extract social media links from all anchor tags
 * Returns array of { platform, url, handle }
 */
function extractSocialLinks(links) {
    const social = [];
    const seen = new Set();

    for (const link of links) {
        for (const platform of SOCIAL_PLATFORMS) {
            const match = link.match(platform.urlPattern);
            if (match && !seen.has(platform.id)) {
                seen.add(platform.id);
                social.push({
                    platform: platform.name,
                    platformId: platform.id,
                    url: link,
                    handle: match[1] || null,
                });
            }
        }
    }

    return social;
}

/**
 * Extract doctor names and credentials from text
 * Returns array of { name, credential, type }
 *
 * RULE: Only accept providers with verified credentials (OD, MD, DO).
 *   - Name + OD = optometrist
 *   - Name + MD = ophthalmologist
 *   - Name + DO = osteopathic physician
 * Names without credentials are NOT included — they create garbage
 * like "YESnick uses", "YESnick has" from page copy.
 */
function extractDoctors(text) {
    const doctors = [];
    const seen = new Set();

    // Only match names with explicit credentials — NO bare "Dr. Name" without OD/MD/DO
    // IMPORTANT: No 'i' flag — names MUST start with uppercase (proper nouns only)
    const patterns = [
        // "Dr. First Last, O.D." or "Dr. First Last, M.D."
        /(?:Dr\.?\s+)([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*,?\s*([Mm]\.?[Dd]\.?|[Oo]\.?[Dd]\.?|[Dd]\.?[Oo]\.?)/g,
        // "First Last, O.D." or "First Last, M.D." (no Dr. prefix)
        /([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*,\s*([Mm]\.?[Dd]\.?|[Oo]\.?[Dd]\.?|[Dd]\.?[Oo]\.?)/g,
        // "First Last O.D." or "First Last M.D." (no comma)
        /([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+)\s+([Oo]\.?[Dd]\.?|[Mm]\.?[Dd]\.?|[Dd]\.?[Oo]\.?)\b/g,
    ];

    // Common English words that are NOT names — expanded blocklist
    const NOT_NAMES = new Set([
        'the','our','your','new','all','eye','about','home','meet','contact','vision','care','center',
        'uses','custom','without','has','today','cares','focuses','and','is','to','call','offers',
        'provides','can','will','should','lenses','that','this','with','from','have','what','how',
        'why','who','when','where','which','their','they','them','these','those','been','being',
        'does','done','each','every','for','get','gets','got','had','here','into','its','just',
        'keep','know','last','like','long','look','made','make','many','may','more','most','much',
        'must','need','next','not','now','only','open','other','over','own','part','plan','post',
        'read','real','rest','run','same','see','seem','set','she','show','side','some','such',
        'take','tell','than','then','too','top','try','turn','two','under','upon','use','used',
        'very','want','way','well','were','what','wide','also','area','back','best','both','but',
        'came','come','could','day','even','find','first','give','good','great','help','high',
        'kind','large','left','let','life','line','live','man','men','might','move','name',
        'near','never','number','off','often','old','once','order','out','page','people','place',
        'point','put','right','said','say','small','start','still','study','sure','thing','think',
        'through','time','together','took','until','want','water','work','world','would','year',
        'years','young','review','reviews','click','blog','free','learn','view','watch','visit',
        'book','check','apply','submit','send','join','sign','log','enter','browse','shop','buy',
        'save','share','follow','search','explore','discover','find','compare','select','choose',
    ]);

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const name = match[1].trim().replace(/[\n\r\t]+/g, ' ').replace(/\s{2,}/g, ' ');
            const credential = (match[2] || '').replace(/\./g, '').toUpperCase().trim();

            // Must have a credential — this is the key filter
            if (!credential || !/(OD|MD|DO)/.test(credential)) continue;

            // Skip names with newlines or other junk characters
            if (/[\n\r\t]/.test(match[1])) continue;

            // Skip if any word in the name is a common English word (not a name)
            const nameWords = name.split(/\s+/);
            const hasNonNameWord = nameWords.some(w => NOT_NAMES.has(w.toLowerCase()));
            if (hasNonNameWord) continue;

            // Each word must start with uppercase (proper noun check)
            const allCapitalized = nameWords.every(w => w.length === 1 ? /[A-Z]/.test(w) : /^[A-Z]/.test(w));
            if (!allCapitalized) continue;

            if (name.length < 5 || name.length > 40) continue;
            // Each name word must be at least 2 chars (skip "Mc", "X", etc. as standalone)
            if (nameWords.length < 2) continue;
            if (nameWords.some(w => w.length < 2 && !/^[A-Z]$/.test(w))) continue;

            const key = name.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);

                let type = 'unknown';
                if (/MD/i.test(credential)) type = 'ophthalmologist';
                else if (/OD/i.test(credential)) type = 'optometrist';
                else if (/DO/i.test(credential)) type = 'osteopathic_physician';

                doctors.push({ name, credential, type });
            }
        }
    }

    return doctors;
}

/**
 * Extract phone numbers from text
 */
function extractPhones(text) {
    const phones = [];
    const seen = new Set();
    const pattern = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const phone = match[0].replace(/[^\d+()-\s]/g, '').trim();
        const digits = phone.replace(/\D/g, '');
        if (digits.length >= 10 && digits.length <= 11 && !seen.has(digits)) {
            seen.add(digits);
            phones.push(phone);
        }
    }
    return phones;
}

/**
 * Extract email addresses from text
 */
function extractEmails(text) {
    const emails = [];
    const seen = new Set();
    const pattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const email = match[0].toLowerCase();
        // Skip image files and common non-email patterns
        if (/\.(png|jpg|gif|svg|css|js)$/i.test(email)) continue;
        if (!seen.has(email)) {
            seen.add(email);
            emails.push(email);
        }
    }
    return emails;
}

/**
 * Extract addresses from text (US format)
 */
function extractAddresses(text) {
    const addresses = [];
    // Match street address patterns followed by city, state, zip
    const pattern = /\d{1,5}\s+[A-Z][a-zA-Z\s.]+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Circle|Cir|Place|Pl|Highway|Hwy|Suite|Ste|#)\b[^,]*,\s*[A-Z][a-zA-Z\s]+,?\s*[A-Z]{2}\s*\d{5}/gi;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        addresses.push(match[0].trim());
    }
    return addresses;
}

/**
 * Analyze content quality metrics
 */
function analyzeContentQuality(text, html) {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 20);

    // Simple readability estimate (average words per sentence)
    const avgWordsPerSentence = sentences.length > 0 ? Math.round(words.length / sentences.length) : 0;

    // Image count and alt text coverage
    const imgTags = (html.match(/<img\s[^>]*>/gi) || []);
    const imgCount = imgTags.length;
    const imgWithAlt = imgTags.filter(tag => /alt="[^"]+"/i.test(tag) && !/alt=""/i.test(tag)).length;
    const altTextCoverage = imgCount > 0 ? Math.round((imgWithAlt / imgCount) * 100) : null;

    // Heading structure
    const h1Count = (html.match(/<h1[\s>]/gi) || []).length;
    const h2Count = (html.match(/<h2[\s>]/gi) || []).length;
    const h3Count = (html.match(/<h3[\s>]/gi) || []).length;

    // Links
    const internalLinks = (html.match(/<a\s[^>]*href=["'][^"']*["'][^>]*>/gi) || []).length;
    const externalLinks = (html.match(/<a\s[^>]*href=["']https?:\/\/[^"']*["'][^>]*target=["']_blank["'][^>]*>/gi) || []).length;

    // Video embeds
    const hasVideo = /<iframe[^>]*(?:youtube|vimeo|wistia|vidyard)/i.test(html) || /<video[\s>]/i.test(html);

    return {
        wordCount: words.length,
        sentenceCount: sentences.length,
        paragraphCount: paragraphs.length,
        avgWordsPerSentence,
        readability: avgWordsPerSentence < 15 ? 'easy' : avgWordsPerSentence < 22 ? 'moderate' : 'complex',
        imageCount: imgCount,
        imagesWithAlt: imgWithAlt,
        altTextCoverage: altTextCoverage !== null ? `${altTextCoverage}%` : 'no images',
        headingStructure: { h1: h1Count, h2: h2Count, h3: h3Count },
        hasVideo,
        internalLinkCount: internalLinks,
        externalLinkCount: externalLinks,
    };
}

// ─── MAIN SCRAPER ───────────────────────────────────────────────────

Actor.main(async () => {
    const input = await Actor.getInput();
    if (!input || !input.url) throw new Error('Input must contain a "url" field');

    const startUrl = normalizeUrl(input.url);
    const domain = getDomain(startUrl);
    const maxPages = input.maxPages || MAX_PAGES;
    const includeSubpages = input.includeSubpages !== false;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  EyeCarePro Practice Intelligence Scraper`);
    console.log(`  Target: ${startUrl}`);
    console.log(`  Domain: ${domain}`);
    console.log(`  Max pages: ${maxPages}`);
    console.log(`${'='.repeat(60)}\n`);

    // Launch browser
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const dossier = {
        meta: {
            scrapedAt: new Date().toISOString(),
            url: startUrl,
            domain,
            scrapeDurationMs: 0,
            pagesScraped: 0,
            version: '1.0.0',
        },
        practice: {
            name: null,
            type: null,               // optometry | ophthalmology | optical | multi_specialty
            subType: null,            // solo | group | chain | corporate
            tagline: null,
            yearEstablished: null,
        },
        doctors: [],
        locations: {
            addresses: [],
            count: 0,
            phones: [],
            faxes: [],
            emails: [],
            hours: null,
        },
        services: {
            detected: [],
            categories: {},
            totalCount: 0,
            missingHighValue: [],     // Services they SHOULD have but don't
        },
        optical: {
            hasOptical: false,
            frameBrands: {},
            totalBrands: 0,
            positioning: 'unknown',
            hasEcommerce: false,
        },
        insurance: {
            detected: [],
            acceptsInsurance: false,
            mentionsInsurance: false,
        },
        digital: {
            cms: null,
            marketingVendor: null,
            isCompetitorClient: false,
            competitorName: null,
            scheduling: {
                hasOnlineScheduling: false,
                platform: null,
                isRealTime: false,
            },
            forms: [],
            analytics: [],
            reviewPlatforms: [],
            accessibility: [],
            payment: [],
            telehealth: [],
        },
        social: {
            links: [],
            platformCount: 0,
            hasFacebook: false,
            hasInstagram: false,
            hasYoutube: false,
            hasTiktok: false,
            hasLinkedin: false,
            facebookUrl: null,
            instagramUrl: null,
        },
        technical: {
            ssl: null,
            sitemapExists: null,
            robotsTxt: null,
            hasSchemaMarkup: false,
            schemaTypes: [],
            hasOpenGraph: false,
            openGraphData: {},
            hasTwitterCard: false,
            faviconExists: false,
            mobileViewport: false,
            pageLoadTime: null,
        },
        content: {
            homepage: {},
            blogExists: false,
            blogUrl: null,
            lastBlogPostDate: null,
            estimatedBlogPosts: 0,
            subpages: [],
            totalWordCount: 0,
        },
        ehrPms: [],
        gaps: [],
        scores: {
            digitalPresence: 0,
            contentQuality: 0,
            patientExperience: 0,
            marketingMaturity: 0,
            overall: 0,
        },
    };

    const startTime = Date.now();

    try {
        // ─── PHASE 1: Homepage deep scan ────────────────────────
        console.log('[Phase 1] Scanning homepage...');
        const page = await browser.newPage();
        await page.setViewport(VIEWPORT);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Set up request interception for resource tracking
        const resourceUrls = [];
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            resourceUrls.push(req.url());
            req.continue();
        });

        const loadStart = Date.now();
        await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT });
        await new Promise(r => setTimeout(r, WAIT_AFTER_LOAD));
        dossier.technical.pageLoadTime = Date.now() - loadStart;

        // Get full HTML and text
        const html = await page.content();
        const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '');
        const title = await page.title();
        const allLinkHrefs = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
        );
        const allLinkTexts = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a[href]')).map(a => ({
                href: a.href,
                text: (a.innerText || a.textContent || '').trim().substring(0, 200)
            }))
        );

        // Concatenate ALL text sources for maximum detection
        const fullText = [title, bodyText, html].join('\n');
        const allResourceUrlsStr = resourceUrls.join('\n');

        console.log(`  Page loaded in ${dossier.technical.pageLoadTime}ms`);
        console.log(`  Title: ${title}`);
        console.log(`  Body text: ${bodyText.length} chars`);
        console.log(`  Links found: ${allLinkHrefs.length}`);

        // ─── Practice Identity ──────────────────────────────────
        // Extract practice name from title (before " | " or " - " or " — ")
        const titleParts = title.split(/\s*[|–—-]\s*/);
        dossier.practice.name = titleParts[0].trim() || domain;
        dossier.practice.tagline = titleParts.length > 1 ? titleParts.slice(1).join(' | ').trim() : null;

        // Also try OG title
        const ogTitle = await page.evaluate(() => {
            const el = document.querySelector('meta[property="og:title"]');
            return el ? el.content : null;
        });
        if (ogTitle && (!dossier.practice.name || dossier.practice.name === domain)) {
            dossier.practice.name = ogTitle.split(/\s*[|–—-]\s*/)[0].trim();
        }

        // Practice type detection
        // RULES:
        //   - Name + OD = optometrist → practice is optometry
        //   - Name + MD = ophthalmologist → practice is ophthalmology
        //   - Both OD + MD = multi-specialty
        //   - If they have frame brands/designs on site → also optical (but type stays based on providers)
        //   - If site mentions costco/walmart/target/lenscrafters → medical only (may sell contacts)
        //   - "Optical only" = no OD/MD found, just frame brands and eyewear
        const doctors = extractDoctors(fullText);
        dossier.doctors = doctors;

        const hasMD = doctors.some(d => d.type === 'ophthalmologist');
        const hasOD = doctors.some(d => d.type === 'optometrist');
        const hasFrameBrands = /\bframe|\beyewear|\beyeglasses|\boptical\b/i.test(fullText);
        const isRetailOptical = /\bcostco\b|\bwalmart\b|\btarget\b|\blenscrafters\b/i.test(fullText);

        // Classification priority: credentials first, then page content
        if (hasMD && hasOD) dossier.practice.type = 'multi_specialty';
        else if (hasMD) dossier.practice.type = 'ophthalmology';
        else if (hasOD) dossier.practice.type = 'optometry';
        else if (isRetailOptical) dossier.practice.type = 'optometry'; // medical-only retail
        else if (/ophthalmolog/i.test(fullText)) dossier.practice.type = 'ophthalmology';
        else if (/optometr/i.test(fullText)) dossier.practice.type = 'optometry';
        else if (hasFrameBrands && !/eye\s*exam|optometrist|ophthalmolog|comprehensive/i.test(fullText)) {
            dossier.practice.type = 'optical'; // truly optical-only: frames but no medical services
        }
        else dossier.practice.type = 'unknown';

        // Flag if practice also has optical component
        dossier.practice.hasOpticalComponent = hasFrameBrands;
        dossier.practice.isRetailLocation = isRetailOptical;

        // Sub-type based on verified provider count
        if (doctors.length === 1) dossier.practice.subType = 'solo';
        else if (doctors.length <= 5) dossier.practice.subType = 'group';
        else if (doctors.length > 5) dossier.practice.subType = 'large_group';

        // Year established
        const yearMatch = fullText.match(/(?:since|established|founded|serving.*since)\s*(\d{4})/i);
        if (yearMatch) dossier.practice.yearEstablished = parseInt(yearMatch[1]);

        // ─── Contact Information ────────────────────────────────
        dossier.locations.phones = extractPhones(bodyText);
        dossier.locations.emails = extractEmails(bodyText);
        dossier.locations.addresses = extractAddresses(bodyText);
        dossier.locations.count = Math.max(dossier.locations.addresses.length, 1);

        // Multi-location detection from links
        const locationLinks = allLinkTexts.filter(l =>
            /location|office|branch|find us/i.test(l.text) ||
            /\/locations?\//i.test(l.href)
        );
        if (locationLinks.length > dossier.locations.count) {
            dossier.locations.count = locationLinks.length;
        }

        // Hours detection — must match actual time patterns, not random page text
        const hoursPatterns = [
            // "Mon-Fri 8:00am-5:00pm" style
            /(?:hours|office hours|business hours)[:\s]*((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*[\s:,-]+\d{1,2}[:\d]*\s*(?:am|pm)[\s\S]{0,80})/i,
            // "8:00 AM - 5:00 PM" near hours label
            /(?:hours|office hours|business hours)[:\s]*(\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–to]+\s*\d{1,2}:\d{2}\s*(?:am|pm))/i,
        ];
        for (const hp of hoursPatterns) {
            const hoursMatch = bodyText.match(hp);
            if (hoursMatch) {
                dossier.locations.hours = hoursMatch[1].trim().substring(0, 120);
                break;
            }
        }

        // Fax detection
        const faxMatch = bodyText.match(/fax[:\s]*([\d()\s.-]+\d)/gi);
        if (faxMatch) dossier.locations.faxes = faxMatch.map(f => f.replace(/^fax[:\s]*/i, '').trim());

        // ─── Services Detection ─────────────────────────────────
        const svcResults = detectServices(fullText);
        dossier.services = svcResults;

        // NOTE: Co-management reclassification moved to AFTER subpage crawl (Phase 2a)
        // so that all services are detected first before reclassifying.

        // ─── Optical / Frame Brands ─────────────────────────────
        const brandResults = detectFrameBrands(fullText);
        dossier.optical = {
            hasOptical: brandResults.totalBrands > 0 || /optical|eyewear|frames|eyeglasses/i.test(fullText),
            frameBrands: brandResults.brands,
            totalBrands: brandResults.totalBrands,
            positioning: brandResults.positioning,
            hasEcommerce: /add to cart|shop now|buy now|shopify|woocommerce|add to bag/i.test(html),
        };

        // ─── Insurance ──────────────────────────────────────────
        const insuranceResults = detectFromDictionary(fullText, INSURANCE_PROVIDERS);
        dossier.insurance = {
            detected: insuranceResults,
            acceptsInsurance: insuranceResults.length > 0,
            mentionsInsurance: /insurance|vision plan|accepted plans|we accept/i.test(fullText),
        };

        // ─── Digital Infrastructure ─────────────────────────────
        // CMS detection
        const allSources = [html, allResourceUrlsStr].join('\n');
        for (const cms of CMS_SIGNALS) {
            const inHtml = cms.patterns.some(p => allSources.toLowerCase().includes(p.toLowerCase()));
            const inScripts = cms.scriptPatterns
                ? cms.scriptPatterns.some(p => allResourceUrlsStr.toLowerCase().includes(p.toLowerCase()))
                : false;
            if (inHtml || inScripts) {
                dossier.digital.cms = { id: cms.id, name: cms.name, confidence: inScripts ? 'high' : 'medium' };
                break;
            }
        }

        // Vendor detection — check footer, entire page, and resource URLs
        const footerHtml = await page.evaluate(() => {
            const footer = document.querySelector('footer') || document.querySelector('[class*="footer"]') || document.querySelector('#footer');
            return footer ? footer.innerHTML : '';
        });
        const vendorText = [footerHtml, html.slice(-5000), allResourceUrlsStr].join('\n');
        for (const vendor of VENDORS) {
            if (vendor.patterns.some(p => vendorText.toLowerCase().includes(p.toLowerCase()))) {
                dossier.digital.marketingVendor = { id: vendor.id, name: vendor.name };
                // Flag EyeCarePro clients — existing client, possible upgrade candidate
                if (vendor.id === 'eyecarepro') {
                    dossier.digital.isEyeCarePro = true;
                }
                // Flag competitors
                const competitors = ['glacial', 'roya', '4ecps', 'optify', 'eyevertise', 'doctor_multimedia', 'officite'];
                if (competitors.includes(vendor.id)) {
                    dossier.digital.isCompetitorClient = true;
                    dossier.digital.competitorName = vendor.name;
                }
                break;
            }
        }

        // Scheduling platform detection
        const schedulingResults = detectFromDictionary(allSources, SCHEDULING_PLATFORMS);
        const hasSchedulingLink = /schedule|book.*appointment|book.*online|request.*appointment|book now/i.test(bodyText);

        // Deprioritize low-priority matches (e.g. Demandforce) when a better match exists
        let bestScheduler = null;
        if (schedulingResults.length > 0) {
            const lowPriorityIds = new Set(SCHEDULING_PLATFORMS.filter(p => p.priority === 'low').map(p => p.id));
            const highPriority = schedulingResults.filter(r => !lowPriorityIds.has(r.id));
            bestScheduler = highPriority.length > 0 ? highPriority[0] : schedulingResults[0];
        }

        dossier.digital.scheduling = {
            hasOnlineScheduling: schedulingResults.length > 0 || hasSchedulingLink,
            platform: bestScheduler,
            allDetected: schedulingResults.length > 1 ? schedulingResults : undefined,
            isRealTime: schedulingResults.length > 0, // Known platforms = real-time; generic form = request-based
            hasAppointmentRequest: /request.*appointment|contact.*us.*appointment/i.test(bodyText) && schedulingResults.length === 0,
        };

        // Forms
        dossier.digital.forms = detectFromDictionary(allSources, FORM_PLATFORMS);

        // Analytics
        dossier.digital.analytics = detectFromDictionary(allSources, ANALYTICS);

        // Review platforms
        dossier.digital.reviewPlatforms = detectFromDictionary(allSources, REVIEW_PLATFORMS);

        // Accessibility
        dossier.digital.accessibility = detectFromDictionary(allSources, ACCESSIBILITY_WIDGETS);

        // Payment
        dossier.digital.payment = detectFromDictionary(allSources, PAYMENT_SYSTEMS);

        // Telehealth
        dossier.digital.telehealth = detectFromDictionary(fullText, TELEHEALTH);

        // EHR/PMS
        dossier.ehrPms = detectFromDictionary(allSources, EHR_PMS);

        // ─── Social Media ───────────────────────────────────────
        dossier.social.links = extractSocialLinks(allLinkHrefs);
        dossier.social.platformCount = dossier.social.links.length;

        for (const link of dossier.social.links) {
            if (link.platformId === 'facebook') { dossier.social.hasFacebook = true; dossier.social.facebookUrl = link.url; }
            if (link.platformId === 'instagram') { dossier.social.hasInstagram = true; dossier.social.instagramUrl = link.url; }
            if (link.platformId === 'youtube') dossier.social.hasYoutube = true;
            if (link.platformId === 'tiktok') dossier.social.hasTiktok = true;
            if (link.platformId === 'linkedin') dossier.social.hasLinkedin = true;
        }

        // ─── Technical Audit ────────────────────────────────────
        // SSL
        dossier.technical.ssl = startUrl.startsWith('https') ? 'valid' : 'missing';

        // Schema/JSON-LD
        const schemaData = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            return Array.from(scripts).map(s => {
                try { return JSON.parse(s.textContent); } catch { return null; }
            }).filter(Boolean);
        });
        dossier.technical.hasSchemaMarkup = schemaData.length > 0;
        dossier.technical.schemaTypes = schemaData.map(s => s['@type']).filter(Boolean);

        // Open Graph
        const ogData = await page.evaluate(() => {
            const tags = {};
            document.querySelectorAll('meta[property^="og:"]').forEach(el => {
                tags[el.getAttribute('property')] = el.content;
            });
            return tags;
        });
        dossier.technical.hasOpenGraph = Object.keys(ogData).length > 0;
        dossier.technical.openGraphData = ogData;

        // Twitter Card
        dossier.technical.hasTwitterCard = await page.evaluate(() =>
            !!document.querySelector('meta[name="twitter:card"]')
        );

        // Favicon
        dossier.technical.faviconExists = await page.evaluate(() =>
            !!document.querySelector('link[rel*="icon"]')
        );

        // Mobile viewport
        dossier.technical.mobileViewport = await page.evaluate(() =>
            !!document.querySelector('meta[name="viewport"]')
        );

        // Meta description
        dossier.technical.metaDescription = await page.evaluate(() => {
            const el = document.querySelector('meta[name="description"]');
            return el ? el.content : null;
        });
        dossier.technical.metaDescriptionLength = dossier.technical.metaDescription
            ? dossier.technical.metaDescription.length : 0;

        // Canonical URL
        dossier.technical.canonicalUrl = await page.evaluate(() => {
            const el = document.querySelector('link[rel="canonical"]');
            return el ? el.href : null;
        });

        // Content quality
        dossier.content.homepage = analyzeContentQuality(bodyText, html);
        dossier.content.totalWordCount = dossier.content.homepage.wordCount;

        // Blog detection
        const blogLinks = allLinkTexts.filter(l =>
            /\/blog\/?$/i.test(l.href) || /\bblog\b/i.test(l.text)
        );
        dossier.content.blogExists = blogLinks.length > 0;
        dossier.content.blogUrl = blogLinks.length > 0 ? blogLinks[0].href : null;

        dossier.meta.pagesScraped = 1;

        // ─── PHASE 2: Subpage crawl ─────────────────────────────
        if (includeSubpages) {
            console.log('\n[Phase 2] Crawling subpages...');

            // Identify high-value subpages to visit
            const subpagePatterns = [
                { pattern: /\/(?:about|about-us|our-team|team|doctors?|providers?|staff)/i, priority: 'high', type: 'about' },
                { pattern: /\/(?:services?|treatments?|procedures?|what-we-do)/i, priority: 'high', type: 'services' },
                { pattern: /\/(?:contact|contact-us|find-us|locations?|offices?)/i, priority: 'high', type: 'contact' },
                { pattern: /\/(?:optical|eyewear|frames?|glasses|shop)/i, priority: 'high', type: 'optical' },
                { pattern: /\/(?:insurance|accepted-insurance|vision-plans)/i, priority: 'high', type: 'insurance' },
                { pattern: /\/(?:patient|new-patient|forms|patient-info|patient-resources)/i, priority: 'medium', type: 'patient' },
                { pattern: /\/(?:technology|our-technology|advanced-technology)/i, priority: 'medium', type: 'technology' },
                { pattern: /\/(?:blog|news|articles)/i, priority: 'medium', type: 'blog' },
                { pattern: /\/(?:reviews?|testimonials?)/i, priority: 'medium', type: 'reviews' },
                { pattern: /\/(?:faq|frequently-asked)/i, priority: 'low', type: 'faq' },
                { pattern: /\/(?:dry-eye|dry_eye)/i, priority: 'high', type: 'dry_eye' },
                { pattern: /\/(?:lasik|laser-vision)/i, priority: 'medium', type: 'lasik' },
                { pattern: /\/(?:cataract)/i, priority: 'medium', type: 'cataract' },
                { pattern: /\/(?:myopia|myopia-management|ortho-k)/i, priority: 'medium', type: 'myopia' },
                { pattern: /\/(?:glaucoma)/i, priority: 'medium', type: 'glaucoma' },
                { pattern: /\/(?:retina)/i, priority: 'medium', type: 'retina' },
            ];

            // Filter internal links and prioritize
            const internalLinks = allLinkHrefs.filter(href => {
                try {
                    const u = new URL(href);
                    return u.hostname.replace(/^www\./, '') === domain;
                } catch { return false; }
            });

            const uniqueInternalLinks = [...new Set(internalLinks)];

            // Score and sort subpages
            const scoredLinks = uniqueInternalLinks
                .map(href => {
                    let priority = 0;
                    let type = 'other';
                    for (const sp of subpagePatterns) {
                        if (sp.pattern.test(href)) {
                            priority = sp.priority === 'high' ? 3 : sp.priority === 'medium' ? 2 : 1;
                            type = sp.type;
                            break;
                        }
                    }
                    return { href, priority, type };
                })
                .filter(l => l.priority > 0)
                .sort((a, b) => b.priority - a.priority)
                .slice(0, maxPages - 1); // Reserve 1 for homepage

            console.log(`  Found ${uniqueInternalLinks.length} internal links, visiting ${scoredLinks.length} high-value pages`);

            // Visit each subpage
            for (const link of scoredLinks) {
                try {
                    console.log(`  Crawling [${link.type}]: ${link.href}`);
                    await page.goto(link.href, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT });
                    await new Promise(r => setTimeout(r, 1000));

                    const subHtml = await page.content();
                    const subText = await page.evaluate(() => document.body ? document.body.innerText : '');
                    const subTitle = await page.title();

                    // Run detections on subpage content
                    const subServices = detectServices(subText + ' ' + subHtml);
                    const subBrands = detectFrameBrands(subText);
                    const subDoctors = extractDoctors(subText);
                    const subInsurance = detectFromDictionary(subText, INSURANCE_PROVIDERS);
                    const subContent = analyzeContentQuality(subText, subHtml);

                    // Merge new findings into dossier
                    // - New services
                    for (const svc of subServices.detected) {
                        if (!dossier.services.detected.find(d => d.id === svc.id)) {
                            dossier.services.detected.push(svc);
                            if (!dossier.services.categories[svc.category]) dossier.services.categories[svc.category] = [];
                            if (!dossier.services.categories[svc.category].includes(svc.label)) {
                                dossier.services.categories[svc.category].push(svc.label);
                            }
                        }
                    }
                    dossier.services.totalCount = dossier.services.detected.length;

                    // - New doctors
                    for (const doc of subDoctors) {
                        if (!dossier.doctors.find(d => d.name.toLowerCase() === doc.name.toLowerCase())) {
                            dossier.doctors.push(doc);
                        }
                    }

                    // - New brands
                    for (const [tier, brands] of Object.entries(subBrands.brands)) {
                        if (!dossier.optical.frameBrands[tier]) dossier.optical.frameBrands[tier] = [];
                        for (const brand of brands) {
                            if (!dossier.optical.frameBrands[tier].includes(brand)) {
                                dossier.optical.frameBrands[tier].push(brand);
                            }
                        }
                    }
                    dossier.optical.totalBrands = Object.values(dossier.optical.frameBrands)
                        .reduce((sum, arr) => sum + arr.length, 0);
                    if (dossier.optical.totalBrands > 0) dossier.optical.hasOptical = true;

                    // - New insurance
                    for (const ins of subInsurance) {
                        if (!dossier.insurance.detected.find(d => d.id === ins.id)) {
                            dossier.insurance.detected.push(ins);
                        }
                    }
                    if (dossier.insurance.detected.length > 0) dossier.insurance.acceptsInsurance = true;

                    // - New addresses / phones
                    const subPhones = extractPhones(subText);
                    for (const phone of subPhones) {
                        if (!dossier.locations.phones.includes(phone)) dossier.locations.phones.push(phone);
                    }
                    const subAddresses = extractAddresses(subText);
                    for (const addr of subAddresses) {
                        if (!dossier.locations.addresses.find(a => a.includes(addr.substring(0, 20)))) {
                            dossier.locations.addresses.push(addr);
                        }
                    }
                    dossier.locations.count = Math.max(dossier.locations.addresses.length, dossier.locations.count);

                    // Blog analysis
                    if (link.type === 'blog') {
                        const blogPostLinks = await page.evaluate(() =>
                            Array.from(document.querySelectorAll('article a, .post a, .blog-post a, .entry-title a, h2 a, h3 a'))
                                .map(a => a.href)
                                .filter(href => href && !href.includes('#'))
                        );
                        dossier.content.estimatedBlogPosts = blogPostLinks.length;

                        // Try to find dates
                        const dateMatches = subText.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/gi)
                            || subText.match(/\d{1,2}\/\d{1,2}\/\d{4}/g)
                            || subText.match(/\d{4}-\d{2}-\d{2}/g);
                        if (dateMatches && dateMatches.length > 0) {
                            dossier.content.lastBlogPostDate = dateMatches[0];
                        }
                    }

                    // Record subpage data
                    dossier.content.subpages.push({
                        url: link.href,
                        type: link.type,
                        title: subTitle,
                        wordCount: subContent.wordCount,
                    });
                    dossier.content.totalWordCount += subContent.wordCount;
                    dossier.meta.pagesScraped++;

                } catch (err) {
                    console.log(`  ⚠ Failed: ${link.href} — ${err.message}`);
                    dossier.content.subpages.push({
                        url: link.href,
                        type: link.type,
                        error: err.message,
                    });
                }
            }

            // ─── PHASE 2b: Check sitemap.xml and robots.txt ────
            console.log('\n[Phase 2b] Checking sitemap & robots...');
            try {
                const sitemapResp = await page.goto(`https://${domain}/sitemap.xml`, { waitUntil: 'domcontentloaded', timeout: 10000 });
                const sitemapStatus = sitemapResp ? sitemapResp.status() : null;
                dossier.technical.sitemapExists = sitemapStatus === 200;
                if (sitemapStatus === 200) {
                    const sitemapText = await page.evaluate(() => document.body ? document.body.innerText : '');
                    const urlCount = (sitemapText.match(/<loc>/gi) || []).length;
                    dossier.technical.sitemapUrlCount = urlCount;
                }
            } catch {
                dossier.technical.sitemapExists = false;
            }

            try {
                const robotsResp = await page.goto(`https://${domain}/robots.txt`, { waitUntil: 'domcontentloaded', timeout: 10000 });
                const robotsStatus = robotsResp ? robotsResp.status() : null;
                dossier.technical.robotsTxt = robotsStatus === 200 ? 'exists' : 'missing';
                if (robotsStatus === 200) {
                    const robotsText = await page.evaluate(() => document.body ? document.body.innerText : '');
                    dossier.technical.robotsTxtContent = robotsText.substring(0, 500);
                }
            } catch {
                dossier.technical.robotsTxt = 'missing';
            }
        }

        // ─── PHASE 2c: Co-management reclassification (AFTER all subpages crawled) ─
        // RULE: If practice is OD-only (optometry), surgical services should be
        // reclassified as "co-management" — ODs don't perform surgery, they refer.
        if (dossier.practice.type === 'optometry') {
            const surgicalIds = ['lasik', 'prk', 'smile', 'icl', 'rle', 'cataract', 'premium_iol',
                'laser_cataract', 'glaucoma', 'retina', 'cornea', 'oculoplastics', 'strabismus'];

            let hasSurgicalMentions = false;
            dossier.services.detected = dossier.services.detected.map(svc => {
                if (surgicalIds.includes(svc.id)) {
                    hasSurgicalMentions = true;
                    return { ...svc, category: 'comanagement', label: svc.label + ' (Co-Management)' };
                }
                return svc;
            });

            // Rebuild categories from scratch
            dossier.services.categories = {};
            for (const svc of dossier.services.detected) {
                if (!dossier.services.categories[svc.category]) dossier.services.categories[svc.category] = [];
                dossier.services.categories[svc.category].push(svc.label);
            }

            if (hasSurgicalMentions && !dossier.services.detected.find(d => d.id === 'comanagement')) {
                dossier.services.detected.push({ id: 'comanagement', label: 'Surgical Co-Management', category: 'comanagement' });
                if (!dossier.services.categories.comanagement) dossier.services.categories.comanagement = [];
                if (!dossier.services.categories.comanagement.includes('Surgical Co-Management')) {
                    dossier.services.categories.comanagement.push('Surgical Co-Management');
                }
            }
        }

        // ─── PHASE 3: Recalculate missing services after subpage crawl ─
        dossier.services.missingHighValue = ['dry_eye', 'myopia_management', 'contact_lens', 'emergency']
            .concat(
                dossier.practice.type === 'ophthalmology' || dossier.practice.type === 'multi_specialty'
                    ? ['premium_iol', 'laser_cataract', 'oculoplastics']
                    : []
            )
            .filter(svc => !dossier.services.detected.find(d => d.id === svc))
            .map(svc => SERVICES[svc]?.label || svc);

        // ─── PHASE 4: Gap Analysis ──────────────────────────────
        console.log('\n[Phase 3] Running gap analysis...');
        const gaps = [];

        // Marketing vendor gap
        if (!dossier.digital.marketingVendor) {
            gaps.push({ category: 'marketing', severity: 'opportunity', finding: 'No marketing vendor detected — likely in-house or ad-hoc agency' });
        } else if (dossier.digital.isEyeCarePro) {
            gaps.push({ category: 'marketing', severity: 'existing_client', finding: 'Existing EyeCarePro client — may be a website-only client looking for marketing services, or a current client looking for an upgrade' });
        } else if (dossier.digital.isCompetitorClient) {
            gaps.push({ category: 'marketing', severity: 'competitor', finding: `Currently a ${dossier.digital.competitorName} client — known competitor, potential switch candidate` });
        }

        // Scheduling
        if (!dossier.digital.scheduling.hasOnlineScheduling) {
            gaps.push({ category: 'patient_experience', severity: 'critical', finding: 'No online scheduling detected — patients must call to book' });
        } else if (!dossier.digital.scheduling.isRealTime) {
            gaps.push({ category: 'patient_experience', severity: 'moderate', finding: 'Appointment request form only — no real-time booking available' });
        }

        // Social media
        if (dossier.social.platformCount === 0) {
            gaps.push({ category: 'social', severity: 'critical', finding: 'Zero social media links detected on website' });
        } else {
            if (!dossier.social.hasFacebook) gaps.push({ category: 'social', severity: 'moderate', finding: 'No Facebook link found' });
            if (!dossier.social.hasInstagram) gaps.push({ category: 'social', severity: 'moderate', finding: 'No Instagram link found — critical for optical/eyewear practices' });
            if (!dossier.social.hasYoutube) gaps.push({ category: 'social', severity: 'low', finding: 'No YouTube presence — video content gap' });
        }

        // Content
        if (!dossier.content.blogExists) {
            gaps.push({ category: 'content', severity: 'critical', finding: 'No blog detected — missing content marketing entirely' });
        } else if (dossier.content.estimatedBlogPosts < 5) {
            gaps.push({ category: 'content', severity: 'moderate', finding: `Blog exists but appears to have very few posts (est. ${dossier.content.estimatedBlogPosts})` });
        }

        if (dossier.content.homepage.wordCount < 300) {
            gaps.push({ category: 'content', severity: 'critical', finding: `Homepage has only ${dossier.content.homepage.wordCount} words — extremely thin content` });
        } else if (dossier.content.homepage.wordCount < 800) {
            gaps.push({ category: 'content', severity: 'moderate', finding: `Homepage has ${dossier.content.homepage.wordCount} words — below recommended 800+ for SEO` });
        }

        // Technical
        if (!dossier.technical.hasSchemaMarkup) {
            gaps.push({ category: 'technical', severity: 'moderate', finding: 'No JSON-LD schema markup — missed rich snippet opportunity' });
        }
        if (!dossier.technical.hasOpenGraph) {
            gaps.push({ category: 'technical', severity: 'low', finding: 'No Open Graph tags — social media sharing will look poor' });
        }
        if (!dossier.technical.mobileViewport) {
            gaps.push({ category: 'technical', severity: 'critical', finding: 'No mobile viewport meta tag — site may not be mobile-friendly' });
        }
        if (!dossier.technical.sitemapExists) {
            gaps.push({ category: 'technical', severity: 'moderate', finding: 'No sitemap.xml — search engines may not index all pages' });
        }
        if (dossier.technical.robotsTxt === 'missing') {
            gaps.push({ category: 'technical', severity: 'low', finding: 'No robots.txt file' });
        }
        if (dossier.technical.metaDescriptionLength === 0) {
            gaps.push({ category: 'technical', severity: 'moderate', finding: 'No meta description — Google will auto-generate one (poorly)' });
        } else if (dossier.technical.metaDescriptionLength < 120 || dossier.technical.metaDescriptionLength > 160) {
            gaps.push({ category: 'technical', severity: 'low', finding: `Meta description is ${dossier.technical.metaDescriptionLength} chars — recommended 120-160` });
        }
        if (dossier.content.homepage.altTextCoverage && parseInt(dossier.content.homepage.altTextCoverage) < 80) {
            gaps.push({ category: 'technical', severity: 'moderate', finding: `Image alt text coverage is ${dossier.content.homepage.altTextCoverage} — accessibility and SEO gap` });
        }

        // Services gaps
        if (dossier.services.missingHighValue.length > 0) {
            gaps.push({
                category: 'services',
                severity: 'opportunity',
                finding: `Missing high-value service pages: ${dossier.services.missingHighValue.join(', ')}`,
            });
        }

        // Reviews
        if (dossier.digital.reviewPlatforms.length === 0) {
            gaps.push({ category: 'reputation', severity: 'moderate', finding: 'No review/reputation widget detected on website — missing social proof' });
        }

        // Insurance
        if (!dossier.insurance.mentionsInsurance) {
            gaps.push({ category: 'patient_experience', severity: 'moderate', finding: 'No insurance information on website — patient friction point' });
        }

        // Analytics
        if (dossier.digital.analytics.length === 0) {
            gaps.push({ category: 'marketing', severity: 'critical', finding: 'No analytics tracking detected — flying blind on website performance' });
        }
        if (!dossier.digital.analytics.find(a => a.id === 'facebook_pixel')) {
            gaps.push({ category: 'marketing', severity: 'low', finding: 'No Facebook Pixel — cannot retarget website visitors on social media' });
        }

        // Payment
        if (dossier.digital.payment.length === 0) {
            gaps.push({ category: 'patient_experience', severity: 'low', finding: 'No online payment or financing options detected' });
        }

        dossier.gaps = gaps;

        // ─── PHASE 5: Scoring ───────────────────────────────────
        console.log('[Phase 4] Calculating scores...');

        // Digital Presence (0-100)
        let dpScore = 0;
        if (dossier.technical.ssl === 'valid') dpScore += 10;
        if (dossier.technical.mobileViewport) dpScore += 10;
        if (dossier.technical.hasSchemaMarkup) dpScore += 10;
        if (dossier.technical.hasOpenGraph) dpScore += 5;
        if (dossier.technical.sitemapExists) dpScore += 5;
        if (dossier.technical.faviconExists) dpScore += 5;
        if (dossier.social.platformCount >= 3) dpScore += 15;
        else if (dossier.social.platformCount >= 1) dpScore += 8;
        if (dossier.digital.scheduling.hasOnlineScheduling) dpScore += 15;
        if (dossier.digital.analytics.length > 0) dpScore += 10;
        if (dossier.digital.reviewPlatforms.length > 0) dpScore += 10;
        if (dossier.content.blogExists) dpScore += 5;
        dossier.scores.digitalPresence = Math.min(dpScore, 100);

        // Content Quality (0-100)
        let cqScore = 0;
        if (dossier.content.homepage.wordCount >= 800) cqScore += 20;
        else if (dossier.content.homepage.wordCount >= 400) cqScore += 10;
        if (dossier.content.homepage.hasVideo) cqScore += 15;
        if (dossier.content.homepage.h1 >= 1) cqScore += 10;
        if (parseInt(dossier.content.homepage.altTextCoverage) >= 80) cqScore += 10;
        if (dossier.content.blogExists) cqScore += 15;
        if (dossier.content.estimatedBlogPosts >= 10) cqScore += 15;
        else if (dossier.content.estimatedBlogPosts >= 5) cqScore += 8;
        if (dossier.content.totalWordCount >= 5000) cqScore += 15;
        else if (dossier.content.totalWordCount >= 2000) cqScore += 8;
        dossier.scores.contentQuality = Math.min(cqScore, 100);

        // Patient Experience (0-100)
        let peScore = 0;
        if (dossier.digital.scheduling.isRealTime) peScore += 25;
        else if (dossier.digital.scheduling.hasOnlineScheduling) peScore += 12;
        if (dossier.insurance.acceptsInsurance) peScore += 15;
        if (dossier.locations.phones.length > 0) peScore += 10;
        if (dossier.locations.hours) peScore += 10;
        if (dossier.digital.payment.length > 0) peScore += 10;
        if (dossier.digital.telehealth.length > 0) peScore += 10;
        if (dossier.locations.addresses.length > 0) peScore += 10;
        if (dossier.digital.reviewPlatforms.length > 0) peScore += 10;
        dossier.scores.patientExperience = Math.min(peScore, 100);

        // Marketing Maturity (0-100)
        let mmScore = 0;
        if (dossier.digital.analytics.find(a => a.id === 'ga4' || a.id === 'ga_universal')) mmScore += 15;
        if (dossier.digital.analytics.find(a => a.id === 'gtm')) mmScore += 10;
        if (dossier.digital.analytics.find(a => a.id === 'facebook_pixel')) mmScore += 10;
        if (dossier.digital.analytics.find(a => a.id === 'callrail' || a.id === 'call_tracking_metrics')) mmScore += 15;
        if (dossier.digital.marketingVendor) mmScore += 10;
        if (dossier.social.platformCount >= 3) mmScore += 10;
        if (dossier.content.blogExists && dossier.content.estimatedBlogPosts >= 5) mmScore += 15;
        if (dossier.digital.reviewPlatforms.length > 0) mmScore += 10;
        if (dossier.technical.hasSchemaMarkup) mmScore += 5;
        dossier.scores.marketingMaturity = Math.min(mmScore, 100);

        // Overall
        dossier.scores.overall = Math.round(
            (dossier.scores.digitalPresence * 0.25) +
            (dossier.scores.contentQuality * 0.20) +
            (dossier.scores.patientExperience * 0.30) +
            (dossier.scores.marketingMaturity * 0.25)
        );

        // ─── PHASE 6: EyeCarePro Tier Recommendation ───────────
        let recommendedTier = 'Essentials ($419/mo)';
        if (dossier.locations.count >= 3 || dossier.doctors.length >= 6) {
            recommendedTier = 'Metro ($1,549/mo)';
        } else if (dossier.services.detected.some(s => ['dry_eye', 'lasik', 'cataract', 'myopia_management'].includes(s.id))) {
            recommendedTier = 'Specialty ($799/mo)';
        } else if (dossier.practice.type === 'ophthalmology') {
            recommendedTier = 'Capture ($799/mo)';
        }
        dossier.recommendedTier = recommendedTier;

    } catch (err) {
        console.error('Fatal error:', err.message);
        dossier.meta.error = err.message;
    } finally {
        await browser.close();
    }

    dossier.meta.scrapeDurationMs = Date.now() - startTime;

    // ─── Summary log ────────────────────────────────────────────
    console.log(`\n${'='.repeat(60)}`);
    console.log('  SCRAPE COMPLETE');
    console.log(`  Practice: ${dossier.practice.name}`);
    console.log(`  Type: ${dossier.practice.type} (${dossier.practice.subType || 'unknown'})`);
    console.log(`  Doctors: ${dossier.doctors.length}`);
    console.log(`  Services: ${dossier.services.totalCount}`);
    console.log(`  Social platforms: ${dossier.social.platformCount}`);
    console.log(`  Gaps found: ${dossier.gaps.length}`);
    console.log(`  Overall score: ${dossier.scores.overall}/100`);
    console.log(`  Recommended tier: ${dossier.recommendedTier}`);
    console.log(`  Pages scraped: ${dossier.meta.pagesScraped}`);
    console.log(`  Duration: ${(dossier.meta.scrapeDurationMs / 1000).toFixed(1)}s`);
    console.log(`${'='.repeat(60)}\n`);

    // Store results
    await Actor.pushData(dossier);

    // Also store as named key-value for easy retrieval
    const store = await Actor.openKeyValueStore();
    await store.setValue('dossier', dossier);
    await store.setValue('dossier-pretty', JSON.stringify(dossier, null, 2), { contentType: 'application/json' });

    console.log('Results saved to dataset and key-value store.');
});
