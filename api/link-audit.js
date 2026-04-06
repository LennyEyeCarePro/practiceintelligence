/**
 * Vercel Serverless Function — Link Audit Hub
 * Combines Backlink Discovery (CommonCrawl) + Broken Link Checker into one endpoint.
 *
 * GET /api/link-audit?action=backlinks&domain=example.com
 * GET /api/link-audit?action=broken-links&url=example.com
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const action = req.query.action || 'backlinks';

    if (action === 'backlinks') return handleBacklinks(req, res);
    if (action === 'broken-links') return handleBrokenLinks(req, res);
    return res.status(400).json({ error: `Unknown action: ${action}. Use backlinks|broken-links` });
}

// ═══════════════════════════════════════════════════
//   ACTION: backlinks — CommonCrawl Backlink Discovery
// ═══════════════════════════════════════════════════
async function handleBacklinks(req, res) {
    const domain = (req.query.domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

    try {
        // Step 1: Get the latest CommonCrawl index
        const indexResp = await fetch('https://index.commoncrawl.org/collinfo.json', {
            signal: AbortSignal.timeout(8000),
        });
        const indexes = await indexResp.json();
        const latestIndex = indexes[0]?.id;
        if (!latestIndex) {
            return res.json({ error: 'Could not determine latest CommonCrawl index', backlinks: [] });
        }

        // Step 2: Search CommonCrawl for pages related to this domain
        const searchUrl = `https://index.commoncrawl.org/${latestIndex}-index?url=*.${domain}&output=json&limit=100&fl=url,mime,status,timestamp`;

        const [ccResp, backlinkResp] = await Promise.all([
            fetch(searchUrl, { signal: AbortSignal.timeout(15000) })
                .then(r => r.text())
                .catch(() => ''),
            discoverBacklinks(domain),
        ]);

        // Parse CommonCrawl results (NDJSON format)
        const ccPages = [];
        if (ccResp) {
            const lines = ccResp.split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    ccPages.push({
                        url: parsed.url,
                        mime: parsed.mime,
                        status: parsed.status,
                        lastCrawled: parsed.timestamp,
                    });
                } catch (_) {}
            }
        }

        // Combine backlink data
        const backlinks = backlinkResp.backlinks || [];
        const toxicLinks = backlinks.filter(b => b.toxic);
        const cleanLinks = backlinks.filter(b => !b.toxic);

        // Calculate backlink health score
        const totalLinks = backlinks.length;
        const toxicCount = toxicLinks.length;
        const healthScore = totalLinks > 0
            ? Math.max(0, Math.round(100 - (toxicCount / totalLinks) * 100))
            : null;

        let healthLabel = 'Unknown';
        if (healthScore !== null) {
            healthLabel = healthScore >= 80 ? 'Healthy' : healthScore >= 50 ? 'Moderate Risk' : 'High Risk';
        }

        return res.json({
            domain,
            crawlIndex: latestIndex,
            indexedPages: ccPages.length,
            sitePages: ccPages.slice(0, 20),
            backlinks: backlinks.slice(0, 30),
            toxicBacklinks: toxicLinks.slice(0, 15),
            cleanBacklinks: cleanLinks.slice(0, 15),
            stats: {
                totalDiscovered: totalLinks,
                toxicCount,
                cleanCount: cleanLinks.length,
                healthScore,
                healthLabel,
            },
            topReferringDomains: backlinkResp.referringDomains || [],
        });

    } catch (err) {
        return res.json({
            error: err.message,
            domain,
            backlinks: [],
            stats: { totalDiscovered: 0, toxicCount: 0, healthScore: null },
        });
    }
}

/**
 * Discover backlinks by checking multiple free sources
 */
async function discoverBacklinks(domain) {
    const backlinks = [];
    const referringDomains = {};

    // Use Google Suggest to find sites mentioning this domain
    try {
        const suggestUrl = `https://suggestqueries.google.com/complete/search?client=firefox&q="${domain}"&hl=en&gl=us`;
        await fetch(suggestUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0' },
            signal: AbortSignal.timeout(5000),
        });
    } catch (_) {}

    // Scrape the homepage to find external domains, then check for reciprocal links
    try {
        const siteResp = await fetch(`https://${domain}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            signal: AbortSignal.timeout(8000),
            redirect: 'follow',
        });

        if (siteResp.ok) {
            const html = await siteResp.text();

            const linkRegex = /href=["'](https?:\/\/[^"']+)["']/gi;
            let match;
            const externalLinks = new Set();

            while ((match = linkRegex.exec(html)) !== null) {
                try {
                    const linkUrl = new URL(match[1]);
                    const linkDomain = linkUrl.hostname.replace(/^www\./, '');
                    if (linkDomain !== domain && linkDomain !== `www.${domain}`) {
                        externalLinks.add(linkDomain);
                    }
                } catch (_) {}
            }

            // Check each external domain for reciprocal links
            const checkPromises = [...externalLinks].slice(0, 10).map(async extDomain => {
                try {
                    const resp = await fetch(`https://${extDomain}`, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                        signal: AbortSignal.timeout(5000),
                        redirect: 'follow',
                    });
                    if (resp.ok) {
                        const extHtml = await resp.text();
                        if (extHtml.includes(domain)) {
                            const toxic = isToxicDomain(extDomain);
                            backlinks.push({
                                source: extDomain,
                                url: `https://${extDomain}`,
                                type: 'reciprocal',
                                toxic,
                                toxicReason: toxic ? getToxicReason(extDomain) : null,
                            });
                            referringDomains[extDomain] = (referringDomains[extDomain] || 0) + 1;
                        }
                    }
                } catch (_) {}
            });

            await Promise.all(checkPromises);
        }
    } catch (_) {}

    backlinks.sort((a, b) => (b.toxic ? 1 : 0) - (a.toxic ? 1 : 0));

    return {
        backlinks,
        referringDomains: Object.entries(referringDomains)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 20)
            .map(([domain, count]) => ({ domain, count })),
    };
}

function isToxicDomain(domain) {
    const lower = domain.toLowerCase();
    const spamTLDs = ['.xyz', '.top', '.buzz', '.click', '.link', '.info', '.win',
        '.bid', '.stream', '.download', '.gdn', '.review', '.trade', '.webcam',
        '.loan', '.racing', '.cricket', '.science', '.party', '.date', '.faith',
        '.accountant', '.men', '.work', '.cf', '.ga', '.gq', '.ml', '.tk'];
    if (spamTLDs.some(tld => lower.endsWith(tld))) return true;

    const spamPatterns = [
        /casino/i, /poker/i, /slots/i, /gambling/i, /betting/i,
        /viagra/i, /cialis/i, /pharma/i, /pills/i, /drug/i,
        /porn/i, /xxx/i, /adult/i, /escort/i, /dating/i,
        /cheap-?seo/i, /buy-?links/i, /link-?building/i, /backlink/i,
        /payday/i, /loan-?shark/i, /crypto-?pump/i,
        /hack/i, /crack/i, /keygen/i, /torrent/i, /pirat/i,
        /replica/i, /counterfeit/i, /fake-?id/i,
    ];
    if (spamPatterns.some(p => p.test(lower))) return true;
    if (lower.split('.')[0].length > 30) return true;
    if ((lower.match(/-/g) || []).length >= 4) return true;
    return false;
}

function getToxicReason(domain) {
    const lower = domain.toLowerCase();
    const spamTLDs = ['.xyz', '.top', '.buzz', '.click', '.link', '.info', '.win', '.bid', '.cf', '.ga', '.gq', '.ml', '.tk'];
    if (spamTLDs.some(tld => lower.endsWith(tld))) return 'Suspicious TLD';
    if (/casino|poker|slots|gambling|betting/i.test(lower)) return 'Gambling-related';
    if (/viagra|cialis|pharma|pills/i.test(lower)) return 'Pharmaceutical spam';
    if (/porn|xxx|adult|escort/i.test(lower)) return 'Adult content';
    if (/cheap-?seo|buy-?links|backlink/i.test(lower)) return 'Link scheme';
    if (/hack|crack|torrent|pirat/i.test(lower)) return 'Piracy/hacking';
    if (lower.split('.')[0].length > 30) return 'Auto-generated domain';
    if ((lower.match(/-/g) || []).length >= 4) return 'Excessive hyphens';
    return 'Suspicious pattern';
}

// ═══════════════════════════════════════════════════
//   ACTION: broken-links — Outbound Broken Link Checker
// ═══════════════════════════════════════════════════
async function handleBrokenLinks(req, res) {
    const rawUrl = (req.query.url || req.query.domain || '').trim();
    if (!rawUrl) return res.status(400).json({ error: 'Missing url/domain parameter' });

    const domain = rawUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    const targetUrl = `https://${domain}`;

    try {
        const pageResp = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            signal: AbortSignal.timeout(10000),
            redirect: 'follow',
        });

        if (!pageResp.ok) {
            return res.json({
                error: `Could not fetch ${targetUrl}: HTTP ${pageResp.status}`,
                links: [],
                stats: {},
            });
        }

        const html = await pageResp.text();

        // Extract all href links
        const linkRegex = /href=["'](https?:\/\/[^"'#]+)["']/gi;
        const allLinks = new Set();
        let match;

        while ((match = linkRegex.exec(html)) !== null) {
            try {
                const url = new URL(match[1]);
                const ext = url.pathname.split('.').pop()?.toLowerCase();
                const skipExts = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico',
                    'css', 'js', 'woff', 'woff2', 'ttf', 'eot', 'mp4', 'mp3',
                    'pdf', 'zip', 'rar', 'exe', 'dmg'];
                if (!skipExts.includes(ext)) {
                    allLinks.add(url.href);
                }
            } catch (_) {}
        }

        // Also extract internal links (relative paths)
        const relLinkRegex = /href=["'](\/[^"'#][^"']*)["']/gi;
        while ((match = relLinkRegex.exec(html)) !== null) {
            try {
                const fullUrl = new URL(match[1], targetUrl);
                const ext = fullUrl.pathname.split('.').pop()?.toLowerCase();
                const skipExts = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico',
                    'css', 'js', 'woff', 'woff2', 'ttf', 'eot', 'pdf'];
                if (!skipExts.includes(ext)) {
                    allLinks.add(fullUrl.href);
                }
            } catch (_) {}
        }

        const linkArray = [...allLinks];
        const internalLinks = linkArray.filter(l => {
            try { return new URL(l).hostname.replace(/^www\./, '') === domain; } catch { return false; }
        });
        const externalLinks = linkArray.filter(l => {
            try { return new URL(l).hostname.replace(/^www\./, '') !== domain; } catch { return false; }
        });

        // Check each link (limit to avoid timeout)
        const linksToCheck = [
            ...internalLinks.slice(0, 25),
            ...externalLinks.slice(0, 25),
        ];

        const results = await Promise.all(
            linksToCheck.map(url => checkLink(url, domain))
        );

        const broken = results.filter(r => r.status === 'broken');
        const redirected = results.filter(r => r.status === 'redirect');
        const ok = results.filter(r => r.status === 'ok');
        const timeout = results.filter(r => r.status === 'timeout');
        const errors = results.filter(r => r.status === 'error');

        const totalChecked = results.length;
        const brokenCount = broken.length + errors.length;
        const linkHealth = totalChecked > 0
            ? Math.max(0, Math.round(((totalChecked - brokenCount) / totalChecked) * 100))
            : 100;

        let linkHealthLabel = 'Excellent';
        if (linkHealth < 95) linkHealthLabel = 'Good';
        if (linkHealth < 85) linkHealthLabel = 'Needs Attention';
        if (linkHealth < 70) linkHealthLabel = 'Poor';

        return res.json({
            domain,
            totalLinksFound: allLinks.size,
            totalChecked,
            internalCount: internalLinks.length,
            externalCount: externalLinks.length,
            brokenLinks: broken.map(simplifyResult),
            redirectedLinks: redirected.slice(0, 10).map(simplifyResult),
            timeoutLinks: timeout.map(simplifyResult),
            errorLinks: errors.map(simplifyResult),
            stats: {
                ok: ok.length,
                broken: broken.length,
                redirected: redirected.length,
                timeout: timeout.length,
                errors: errors.length,
                linkHealth,
                linkHealthLabel,
            },
        });

    } catch (err) {
        return res.json({
            error: err.message,
            domain,
            links: [],
            stats: { linkHealth: null },
        });
    }
}

async function checkLink(url, sourceDomain) {
    try {
        const isInternal = new URL(url).hostname.replace(/^www\./, '') === sourceDomain;

        const resp = await fetch(url, {
            method: 'HEAD',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            signal: AbortSignal.timeout(6000),
            redirect: 'manual',
        });

        const status = resp.status;

        if (status >= 200 && status < 300) {
            return { url, status: 'ok', httpStatus: status, isInternal };
        } else if (status >= 300 && status < 400) {
            const location = resp.headers.get('location') || '';
            return { url, status: 'redirect', httpStatus: status, redirectTo: location, isInternal };
        } else if (status === 404 || status === 410) {
            return { url, status: 'broken', httpStatus: status, isInternal };
        } else if (status >= 400 && status < 500) {
            try {
                const getResp = await fetch(url, {
                    method: 'GET',
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                    signal: AbortSignal.timeout(5000),
                    redirect: 'follow',
                });
                if (getResp.ok) {
                    return { url, status: 'ok', httpStatus: getResp.status, isInternal, note: 'HEAD blocked, GET OK' };
                }
            } catch (_) {}
            return { url, status: 'broken', httpStatus: status, isInternal };
        } else if (status >= 500) {
            return { url, status: 'error', httpStatus: status, isInternal, reason: 'Server error' };
        }

        return { url, status: 'ok', httpStatus: status, isInternal };

    } catch (err) {
        if (err.name === 'AbortError' || err.message.includes('timeout')) {
            return { url, status: 'timeout', isInternal: false, reason: 'Request timed out' };
        }
        return { url, status: 'error', isInternal: false, reason: err.message?.slice(0, 100) };
    }
}

function simplifyResult(r) {
    return {
        url: r.url,
        httpStatus: r.httpStatus || null,
        isInternal: r.isInternal || false,
        redirectTo: r.redirectTo || null,
        reason: r.reason || null,
    };
}
