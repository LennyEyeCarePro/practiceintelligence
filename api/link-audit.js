/**
 * Vercel Serverless Function — Link Audit Hub
 * Backlink Discovery (RapidAPI Best Backlink Checker) + Broken Link Checker.
 *
 * GET /api/link-audit?action=backlinks&domain=example.com   → Top + New backlinks
 * GET /api/link-audit?action=toxic&domain=example.com       → Poor/toxic backlinks (internal tool only)
 * GET /api/link-audit?action=broken-links&url=example.com   → Outbound broken link check
 */

const RAPIDAPI_HOST = 'best-backlink-checker-api.p.rapidapi.com';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const action = req.query.action || 'backlinks';

    if (action === 'backlinks') return handleBacklinks(req, res);
    if (action === 'toxic') return handleToxic(req, res);
    if (action === 'broken-links') return handleBrokenLinks(req, res);
    return res.status(400).json({ error: `Unknown action: ${action}. Use backlinks|toxic|broken-links` });
}

/**
 * Shared helper — call a RapidAPI Best Backlink Checker endpoint
 */
async function rapidApiGet(endpoint, domain) {
    const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
    if (!RAPIDAPI_KEY) {
        return { _error: 'RAPIDAPI_KEY not configured' };
    }

    const resp = await fetch(
        `https://${RAPIDAPI_HOST}/${endpoint}?domain=${encodeURIComponent(domain)}`,
        {
            headers: {
                'Content-Type': 'application/json',
                'x-rapidapi-host': RAPIDAPI_HOST,
                'x-rapidapi-key': RAPIDAPI_KEY,
            },
            signal: AbortSignal.timeout(15000),
        }
    );

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        return { _error: `RapidAPI ${endpoint} returned ${resp.status}: ${errText.slice(0, 200)}` };
    }

    return resp.json();
}

// ═══════════════════════════════════════════════════
//   ACTION: backlinks — Top + New Backlinks via RapidAPI
// ═══════════════════════════════════════════════════
async function handleBacklinks(req, res) {
    const domain = (req.query.domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

    try {
        // Fetch top and new backlinks in parallel
        const [topData, newData] = await Promise.all([
            rapidApiGet('backlinks.php', domain),
            rapidApiGet('newbacklinks.php', domain),
        ]);

        if (topData._error && newData._error) {
            return res.json({
                error: topData._error,
                domain,
                backlinks: [],
                newBacklinks: [],
                stats: { totalDiscovered: 0, healthScore: null },
            });
        }

        // Normalize the RapidAPI response into our standard format
        // The API returns arrays of backlink objects — exact shape may vary,
        // so we handle both array and object responses defensively
        const topLinks = normalizeBacklinks(topData, 'top');
        const newLinks = normalizeBacklinks(newData, 'new');
        const allLinks = [...topLinks, ...newLinks];

        // Deduplicate by source domain
        const seen = new Set();
        const uniqueLinks = allLinks.filter(b => {
            const key = b.source || b.url;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Separate clean vs toxic using our local heuristics + any API flags
        const toxicLinks = uniqueLinks.filter(b => b.toxic);
        const cleanLinks = uniqueLinks.filter(b => !b.toxic);

        // Health score
        const totalLinks = uniqueLinks.length;
        const toxicCount = toxicLinks.length;
        const healthScore = totalLinks > 0
            ? Math.max(0, Math.round(100 - (toxicCount / totalLinks) * 100))
            : null;

        let healthLabel = 'Unknown';
        if (healthScore !== null) {
            healthLabel = healthScore >= 80 ? 'Healthy' : healthScore >= 50 ? 'Moderate Risk' : 'High Risk';
        }

        // Build referring domains summary
        const domainCounts = {};
        uniqueLinks.forEach(b => {
            const d = b.source || extractDomain(b.url);
            if (d) domainCounts[d] = (domainCounts[d] || 0) + 1;
        });
        const topReferringDomains = Object.entries(domainCounts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 20)
            .map(([domain, count]) => ({ domain, count }));

        // Extract counts from the top backlinks response (if available)
        const apiCounts = topData?.counts?.backlinks || {};
        const apiDomainCounts = topData?.counts?.domains || {};

        return res.json({
            domain,
            backlinks: uniqueLinks.slice(0, 30),
            newBacklinks: newLinks.slice(0, 15),
            toxicBacklinks: toxicLinks.slice(0, 15),
            cleanBacklinks: cleanLinks.slice(0, 15),
            stats: {
                totalBacklinks: apiCounts.total || totalLinks,
                totalDoFollow: apiCounts.doFollow || null,
                totalDomains: apiDomainCounts.total || null,
                doFollowDomains: apiDomainCounts.doFollow || null,
                totalDiscovered: totalLinks,
                newCount: newLinks.length,
                toxicCount,
                cleanCount: cleanLinks.length,
                healthScore,
                healthLabel,
            },
            topReferringDomains,
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

// ═══════════════════════════════════════════════════
//   ACTION: toxic — Poor/Toxic Backlinks via RapidAPI
//   (Internal SEO tool only — not exposed in client embed)
// ═══════════════════════════════════════════════════
async function handleToxic(req, res) {
    const domain = (req.query.domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

    try {
        const poorData = await rapidApiGet('poorbacklinks.php', domain);

        if (poorData._error) {
            return res.json({
                error: poorData._error,
                domain,
                toxicBacklinks: [],
                stats: { toxicCount: 0 },
            });
        }

        const toxicLinks = normalizeBacklinks(poorData, 'poor');

        return res.json({
            domain,
            toxicBacklinks: toxicLinks.slice(0, 30),
            stats: {
                toxicCount: toxicLinks.length,
            },
        });

    } catch (err) {
        return res.json({
            error: err.message,
            domain,
            toxicBacklinks: [],
            stats: { toxicCount: 0 },
        });
    }
}


// ═══════════════════════════════════════════════════
//   Normalize RapidAPI backlink responses
// ═══════════════════════════════════════════════════

/**
 * Normalize whatever shape the RapidAPI returns into our standard format.
 * The API may return an array directly or an object with a data/backlinks key.
 */
function normalizeBacklinks(apiResp, type) {
    if (!apiResp || apiResp._error) return [];

    // Find the actual array in the response
    let items = [];
    if (Array.isArray(apiResp)) {
        items = apiResp;
    } else if (Array.isArray(apiResp.data)) {
        items = apiResp.data;
    } else if (Array.isArray(apiResp.backlinks)) {
        items = apiResp.backlinks;
    } else if (Array.isArray(apiResp.result)) {
        items = apiResp.result;
    } else if (Array.isArray(apiResp.results)) {
        items = apiResp.results;
    } else if (typeof apiResp === 'object') {
        // Maybe the object keys are the backlinks themselves
        const keys = Object.keys(apiResp).filter(k => !['error', 'status', 'message', 'domain', '_error'].includes(k));
        if (keys.length > 0 && typeof apiResp[keys[0]] === 'object') {
            items = keys.map(k => apiResp[k]).filter(v => v && typeof v === 'object');
        }
    }

    return items.filter(item => item && typeof item === 'object').map(item => {
        // RapidAPI Best Backlink Checker uses url_from (source) and url_to (target)
        const url = item.url_from || item.url || item.source_url || item.source || item.link || item.href || '';
        const targetUrl = item.url_to || '';
        const sourceDomain = item.source_domain || item.domain || extractDomain(url);
        const anchor = item.anchor || item.anchor_text || item.anchorText || '';
        const title = item.title || '';

        // For 'poor' type, always mark toxic. For others, run heuristics.
        const isToxic = type === 'poor' ? true : isToxicDomain(sourceDomain);

        return {
            url,
            targetUrl,
            source: sourceDomain,
            anchor,
            title,
            type: type === 'poor' ? 'toxic' : (item.type || type),
            toxic: isToxic,
            toxicReason: isToxic
                ? (type === 'poor' ? (item.reason || 'Flagged as poor quality') : getToxicReason(sourceDomain))
                : null,
            nofollow: item.nofollow ?? item.rel?.includes('nofollow') ?? null,
            firstSeen: item.first_seen || item.firstSeen || item.date || null,
            lastVisited: item.last_visited || null,
            inlinkRank: item.inlink_rank ?? null,
            domainInlinkRank: item.domain_inlink_rank ?? null,
            isImage: item.image || false,
        };
    });
}

function extractDomain(url) {
    if (!url) return '';
    try {
        return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
    } catch {
        return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    }
}

function isToxicDomain(domain) {
    if (!domain) return false;
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
    if (!domain) return 'Unknown';
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
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
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
