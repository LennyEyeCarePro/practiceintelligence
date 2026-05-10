/**
 * Vercel Serverless Function — Full Site Content Crawler
 * Fetches sitemap.xml, then recursively spiders internal links.
 * For each page: extracts slug, metadata, headings, and full text content.
 *
 * GET /api/crawl-site?domain=example.com&maxPages=50
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const rawDomain = (req.query.domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!rawDomain) return res.status(400).json({ error: 'Missing domain parameter' });

    const maxPages = Math.min(parseInt(req.query.maxPages) || 80, 150);
    const baseUrl = `https://${rawDomain}`;
    const startTime = Date.now();
    const MAX_DURATION_MS = 110000; // 110s hard limit (function has 120s max)

    const visited = new Set();
    const queue = [];
    const pages = [];
    const sitemapUrls = new Set();
    const errors = [];

    // ── Step 1: Parse sitemap.xml ──────────────────────
    const sitemapData = await fetchSitemap(baseUrl, rawDomain);
    sitemapData.urls.forEach(u => {
        sitemapUrls.add(u);
        queue.push(u);
    });
    if (sitemapData.error) errors.push(sitemapData.error);

    // Always ensure homepage is in the queue
    const homepage = baseUrl + '/';
    if (!queue.some(u => normalizeUrl(u) === normalizeUrl(homepage))) {
        queue.unshift(homepage);
    }

    // ── Step 2: Crawl pages ────────────────────────────
    while (queue.length > 0 && pages.length < maxPages) {
        // Time check
        if (Date.now() - startTime > MAX_DURATION_MS) {
            errors.push(`Stopped early — reached ${Math.round((Date.now() - startTime) / 1000)}s time limit`);
            break;
        }

        const url = queue.shift();
        const normalized = normalizeUrl(url);

        if (visited.has(normalized)) continue;
        visited.add(normalized);

        // Only crawl pages on this domain
        if (!isSameDomain(url, rawDomain)) continue;

        // Skip non-page resources
        if (isAssetUrl(url)) continue;

        try {
            const pageData = await crawlPage(url, rawDomain, baseUrl);
            if (pageData) {
                pageData.inSitemap = sitemapUrls.has(url) || sitemapUrls.has(normalized);
                pages.push(pageData);

                // Add discovered internal links to queue
                if (pageData._internalLinks) {
                    for (const link of pageData._internalLinks) {
                        const norm = normalizeUrl(link);
                        if (!visited.has(norm) && !isAssetUrl(link) && isSameDomain(link, rawDomain)) {
                            queue.push(link);
                        }
                    }
                    delete pageData._internalLinks; // Don't include raw list in output
                }
            }
        } catch (err) {
            errors.push(`Failed to crawl ${url}: ${err.message?.slice(0, 80)}`);
        }
    }

    // ── Step 3: Build response ─────────────────────────
    const duration = Math.round((Date.now() - startTime) / 1000);

    // Summary stats
    const totalWords = pages.reduce((sum, p) => sum + (p.wordCount || 0), 0);
    const pagesWithoutTitle = pages.filter(p => !p.title).length;
    const pagesWithoutMeta = pages.filter(p => !p.metaDescription).length;
    const pagesWithoutH1 = pages.filter(p => !p.h1 || p.h1.length === 0).length;
    const duplicateTitles = findDuplicates(pages.map(p => p.title).filter(Boolean));
    const duplicateDescriptions = findDuplicates(pages.map(p => p.metaDescription).filter(Boolean));
    const thinPages = pages.filter(p => (p.wordCount || 0) < 300);

    return res.json({
        domain: rawDomain,
        crawlStats: {
            pagesFound: pages.length,
            sitemapUrls: sitemapUrls.size,
            pagesVisited: visited.size,
            totalWords,
            avgWordsPerPage: pages.length > 0 ? Math.round(totalWords / pages.length) : 0,
            duration: `${duration}s`,
            maxPagesLimit: maxPages,
            hitLimit: pages.length >= maxPages,
            errors: errors.length,
        },
        seoIssues: {
            pagesWithoutTitle,
            pagesWithoutMeta,
            pagesWithoutH1,
            thinPages: thinPages.length,
            duplicateTitles,
            duplicateDescriptions,
        },
        sitemap: {
            found: sitemapData.urls.length > 0,
            urlCount: sitemapData.urls.length,
            urls: sitemapData.urls.slice(0, 500),
            error: sitemapData.error || null,
        },
        pages,
        errors: errors.slice(0, 20),
    });
}

// ═══════════════════════════════════════════════════
//   SITEMAP PARSER
// ═══════════════════════════════════════════════════

async function fetchSitemap(baseUrl, domain) {
    const result = { urls: [], error: null };
    const sitemapLocations = [
        `${baseUrl}/sitemap.xml`,
        `${baseUrl}/sitemap_index.xml`,
        `${baseUrl}/sitemap1.xml`,
    ];

    // Also check robots.txt for sitemap directives
    try {
        const robotsResp = await fetch(`${baseUrl}/robots.txt`, {
            headers: browserHeaders(),
            signal: AbortSignal.timeout(8000),
            redirect: 'follow',
        });
        if (robotsResp.ok) {
            const robotsText = await robotsResp.text();
            const sitemapMatches = robotsText.match(/^Sitemap:\s*(.+)$/gmi);
            if (sitemapMatches) {
                sitemapMatches.forEach(m => {
                    const url = m.replace(/^Sitemap:\s*/i, '').trim();
                    if (url && !sitemapLocations.includes(url)) {
                        sitemapLocations.unshift(url); // prioritize robots.txt sitemaps
                    }
                });
            }
        }
    } catch (_) {}

    // Try each sitemap location
    for (const sitemapUrl of sitemapLocations) {
        try {
            const resp = await fetch(sitemapUrl, {
                headers: browserHeaders(),
                signal: AbortSignal.timeout(10000),
                redirect: 'follow',
            });
            if (!resp.ok) continue;

            const text = await resp.text();
            if (!text.includes('<urlset') && !text.includes('<sitemapindex')) continue;

            // Check if it's a sitemap index (contains nested sitemaps)
            if (text.includes('<sitemapindex')) {
                const nestedUrls = extractXmlTags(text, 'loc');
                // Fetch up to 5 nested sitemaps
                for (const nestedUrl of nestedUrls.slice(0, 5)) {
                    try {
                        const nestedResp = await fetch(nestedUrl, {
                            headers: browserHeaders(),
                            signal: AbortSignal.timeout(8000),
                            redirect: 'follow',
                        });
                        if (nestedResp.ok) {
                            const nestedText = await nestedResp.text();
                            const urls = extractXmlTags(nestedText, 'loc')
                                .filter(u => isSameDomain(u, domain));
                            urls.forEach(u => result.urls.push(u));
                        }
                    } catch (_) {}
                }
            } else {
                // Regular sitemap
                const urls = extractXmlTags(text, 'loc')
                    .filter(u => isSameDomain(u, domain));
                urls.forEach(u => result.urls.push(u));
            }

            if (result.urls.length > 0) break; // Found a working sitemap
        } catch (_) {}
    }

    if (result.urls.length === 0) {
        result.error = 'No sitemap found or sitemap is empty';
    }

    // Deduplicate
    result.urls = [...new Set(result.urls)];
    return result;
}

// ═══════════════════════════════════════════════════
//   PAGE CRAWLER
// ═══════════════════════════════════════════════════

async function crawlPage(url, domain, baseUrl) {
    const resp = await fetch(url, {
        headers: browserHeaders(),
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
    });

    if (!resp.ok) {
        return null;
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    const html = await resp.text();
    const finalUrl = resp.url || url;

    // Extract slug from URL
    let slug = '/';
    try {
        slug = new URL(finalUrl).pathname;
    } catch (_) {}

    // ── Metadata ──
    const title = extractMetaContent(html, 'title') || extractTagContent(html, 'title');
    const metaDescription = extractMetaContent(html, 'description');
    const metaKeywords = extractMetaContent(html, 'keywords');
    const canonical = extractLinkHref(html, 'canonical');
    const ogTitle = extractMetaProperty(html, 'og:title');
    const ogDescription = extractMetaProperty(html, 'og:description');
    const ogImage = extractMetaProperty(html, 'og:image');
    const ogType = extractMetaProperty(html, 'og:type');
    const robots = extractMetaContent(html, 'robots');

    // ── Headings ──
    const h1 = extractAllTags(html, 'h1');
    const h2 = extractAllTags(html, 'h2');
    const h3 = extractAllTags(html, 'h3');

    // ── Body text content ──
    const textContent = extractTextContent(html);
    const wordCount = textContent.split(/\s+/).filter(w => w.length > 0).length;

    // ── Links ──
    const allLinks = extractLinks(html, finalUrl, baseUrl);
    const internalLinks = allLinks.filter(l => isSameDomain(l, domain));
    const externalLinks = allLinks.filter(l => !isSameDomain(l, domain));

    // ── Images ──
    const images = extractImages(html, finalUrl);
    const imagesWithoutAlt = images.filter(i => !i.alt);

    return {
        url: finalUrl,
        slug,
        statusCode: resp.status,
        inSitemap: false, // set by caller

        // Metadata
        title: title?.slice(0, 200) || null,
        titleLength: title?.length || 0,
        metaDescription: metaDescription?.slice(0, 500) || null,
        metaDescriptionLength: metaDescription?.length || 0,
        metaKeywords: metaKeywords || null,
        canonical: canonical || null,
        robots: robots || null,

        // Open Graph
        og: {
            title: ogTitle || null,
            description: ogDescription?.slice(0, 300) || null,
            image: ogImage || null,
            type: ogType || null,
        },

        // Headings
        h1: h1.slice(0, 5),
        h2: h2.slice(0, 15),
        h3: h3.slice(0, 15),

        // Content
        wordCount,
        textContent: textContent.slice(0, 5000), // First 5000 chars
        textPreview: textContent.slice(0, 300),

        // Links
        internalLinkCount: internalLinks.length,
        externalLinkCount: externalLinks.length,
        externalLinks: externalLinks.slice(0, 20).map(l => {
            try { return new URL(l).hostname; } catch { return l.slice(0, 60); }
        }),

        // Images
        imageCount: images.length,
        imagesWithoutAlt: imagesWithoutAlt.length,

        // Pass internal links for queue (removed before response)
        _internalLinks: internalLinks,
    };
}

// ═══════════════════════════════════════════════════
//   HTML EXTRACTION HELPERS
// ═══════════════════════════════════════════════════

function browserHeaders() {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Connection': 'keep-alive',
    };
}

function extractMetaContent(html, name) {
    const regex = new RegExp(`<meta[^>]+name=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
    const match = html.match(regex);
    if (match) return decodeEntities(match[1]);
    // Try reversed order (content before name)
    const regex2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i');
    const match2 = html.match(regex2);
    return match2 ? decodeEntities(match2[1]) : null;
}

function extractMetaProperty(html, property) {
    const regex = new RegExp(`<meta[^>]+property=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i');
    const match = html.match(regex);
    if (match) return decodeEntities(match[1]);
    const regex2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${property}["']`, 'i');
    const match2 = html.match(regex2);
    return match2 ? decodeEntities(match2[1]) : null;
}

function extractTagContent(html, tag) {
    const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
    const match = html.match(regex);
    return match ? decodeEntities(match[1].trim()) : null;
}

function extractLinkHref(html, rel) {
    const regex = new RegExp(`<link[^>]+rel=["']${rel}["'][^>]*href=["']([^"']*)["']`, 'i');
    const match = html.match(regex);
    if (match) return match[1];
    const regex2 = new RegExp(`<link[^>]+href=["']([^"']*)["'][^>]*rel=["']${rel}["']`, 'i');
    const match2 = html.match(regex2);
    return match2 ? match2[1] : null;
}

function extractAllTags(html, tag) {
    const regex = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'gis');
    const results = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
        const text = stripHtml(match[1]).trim();
        if (text) results.push(text.slice(0, 200));
    }
    return results;
}

function extractXmlTags(xml, tag) {
    const regex = new RegExp(`<${tag}[^>]*>\\s*([^<]+)\\s*</${tag}>`, 'gi');
    const results = [];
    let match;
    while ((match = regex.exec(xml)) !== null) {
        const url = match[1].trim();
        if (url.startsWith('http')) results.push(url);
    }
    return results;
}

function extractTextContent(html) {
    // Remove script, style, nav, header, footer, noscript
    let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ');

    // Strip remaining HTML tags
    text = stripHtml(text);

    // Clean whitespace
    text = text.replace(/\s+/g, ' ').trim();

    return text;
}

function extractLinks(html, pageUrl, baseUrl) {
    const regex = /href=["']([^"'#]+)["']/gi;
    const links = new Set();
    let match;

    while ((match = regex.exec(html)) !== null) {
        let href = match[1].trim();
        if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;

        try {
            const resolved = new URL(href, pageUrl);
            if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
                // Remove hash and trailing slash inconsistencies
                resolved.hash = '';
                links.add(resolved.href);
            }
        } catch (_) {}
    }

    return [...links];
}

function extractImages(html, pageUrl) {
    const regex = /<img[^>]*>/gi;
    const images = [];
    let match;

    while ((match = regex.exec(html)) !== null) {
        const tag = match[0];
        const src = tag.match(/src=["']([^"']+)["']/i)?.[1] || '';
        const alt = tag.match(/alt=["']([^"']*)["']/i)?.[1] || '';

        if (src) {
            try {
                const resolved = new URL(src, pageUrl);
                images.push({ src: resolved.href, alt: alt.trim() });
            } catch (_) {
                images.push({ src, alt: alt.trim() });
            }
        }
    }

    return images;
}

function stripHtml(html) {
    return html.replace(/<[^>]+>/g, ' ').replace(/&[^;]+;/g, m => decodeEntities(m));
}

function decodeEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// ═══════════════════════════════════════════════════
//   URL HELPERS
// ═══════════════════════════════════════════════════

function normalizeUrl(url) {
    try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        // Remove trailing slash, www, hash, and common tracking params
        let path = u.pathname.replace(/\/+$/, '') || '/';
        let host = u.hostname.replace(/^www\./, '');
        return `${host}${path}`.toLowerCase();
    } catch {
        return url.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
    }
}

function isSameDomain(url, domain) {
    try {
        const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
        return host === domain;
    } catch {
        return false;
    }
}

function isAssetUrl(url) {
    const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
    const skipExts = [
        'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif',
        'css', 'js', 'mjs', 'map',
        'woff', 'woff2', 'ttf', 'eot', 'otf',
        'mp4', 'mp3', 'avi', 'mov', 'wmv', 'webm', 'ogg',
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
        'zip', 'rar', 'gz', 'tar', '7z',
        'exe', 'dmg', 'msi', 'apk',
        'xml', 'json', 'rss', 'atom',
    ];
    return skipExts.includes(ext);
}

function findDuplicates(arr) {
    const counts = {};
    arr.forEach(item => {
        if (item) counts[item] = (counts[item] || 0) + 1;
    });
    return Object.entries(counts)
        .filter(([_, count]) => count > 1)
        .map(([value, count]) => ({ value: value.slice(0, 100), count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
}
