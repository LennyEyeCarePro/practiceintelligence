/**
 * Vercel Serverless Function — Broken Outbound Link Checker
 * Crawls a page's outbound links and checks each for 404s, redirects, and dead links.
 * Broken links hurt SEO trust signals and user experience.
 *
 * Fully free — no API key needed.
 *
 * GET /api/broken-links?url=example.com
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
        // Step 1: Fetch the page and extract all links
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
                // Skip obviously non-page resources
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

        // Step 2: Check each link (limit to avoid timeout)
        const linksToCheck = [
            ...internalLinks.slice(0, 25),
            ...externalLinks.slice(0, 25),
        ];

        const results = await Promise.all(
            linksToCheck.map(url => checkLink(url, domain))
        );

        // Categorize results
        const broken = results.filter(r => r.status === 'broken');
        const redirected = results.filter(r => r.status === 'redirect');
        const ok = results.filter(r => r.status === 'ok');
        const timeout = results.filter(r => r.status === 'timeout');
        const errors = results.filter(r => r.status === 'error');

        // Calculate health score
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

/**
 * Check a single link for availability
 */
async function checkLink(url, sourceDomain) {
    try {
        const isInternal = new URL(url).hostname.replace(/^www\./, '') === sourceDomain;

        const resp = await fetch(url, {
            method: 'HEAD', // Use HEAD for speed
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            signal: AbortSignal.timeout(6000),
            redirect: 'manual', // Don't follow redirects — we want to detect them
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
            // Some 403s are false positives (bot blocking) — try GET
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
