/**
 * Vercel Serverless Function — Site Info Hub
 * Combines PageRank, Moz DA, Safe Browsing, and SSL into one endpoint.
 *
 * GET /api/site-info?domain=example.com                          → Open PageRank
 * GET /api/site-info?domain=example.com&competitors=a.com,b.com  → PageRank + competitors
 * GET /api/site-info?domain=example.com&action=moz               → Moz Domain Authority
 * GET /api/site-info?domain=example.com&action=safe-browsing      → Google Safe Browsing
 * GET /api/site-info?domain=example.com&action=ssl                → SSL Labs
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // Support legacy ?url= param for safe-browsing
    const action = req.query.action || (req.query.url && !req.query.domain ? 'safe-browsing' : null);

    if (action === 'safe-browsing') return handleSafeBrowsing(req, res);
    if (action === 'ssl') return handleSSL(req, res);
    if (action === 'moz') {
        const domain = req.query.domain;
        if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });
        return handleMoz(req, res, domain);
    }

    // Default: Open PageRank
    const domain = req.query.domain;
    if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });
    return handlePageRank(req, res, domain);
}

// ═══════════════════════════════════════════════════
//   Open PageRank
// ═══════════════════════════════════════════════════
async function handlePageRank(req, res, domain) {
    const { competitors } = req.query;

    const API_KEY = process.env.OPEN_PAGE_RANK_KEY;
    if (!API_KEY) {
        return res.json({ domain, pageRank: null, rank: null, error: 'OPEN_PAGE_RANK_KEY not configured' });
    }

    try {
        const cleanDomain = clean(domain);
        const allDomains = [cleanDomain];
        const competitorList = [];

        if (competitors) {
            competitors.split(',').map(d => clean(d)).filter(Boolean).slice(0, 15).forEach(d => {
                if (d !== cleanDomain && !allDomains.includes(d)) {
                    allDomains.push(d);
                    competitorList.push(d);
                }
            });
        }

        const queryString = allDomains.map(d => `domains[]=${encodeURIComponent(d)}`).join('&');
        const resp = await fetch(
            `https://openpagerank.com/api/v1.0/getPageRank?${queryString}`,
            { headers: { 'API-OPR': API_KEY }, signal: AbortSignal.timeout(10000) }
        );

        if (!resp.ok) {
            return res.json({ domain: cleanDomain, pageRank: null, rank: null, error: `API returned ${resp.status}` });
        }

        const data = await resp.json();
        const resultMap = {};
        (data.response || []).forEach(r => { resultMap[clean(r.domain || '')] = r; });

        const target = resultMap[cleanDomain] || {};
        const pr = target.page_rank_integer ?? null;

        const competitorResults = competitorList.map(d => {
            const r = resultMap[d] || {};
            return {
                domain: d,
                pageRank: r.page_rank_integer ?? null,
                pageRankDecimal: r.page_rank_decimal ?? null,
                rank: r.rank ?? null,
                label: getPRLabel(r.page_rank_integer),
            };
        }).sort((a, b) => (b.pageRank ?? -1) - (a.pageRank ?? -1));

        return res.json({
            domain: cleanDomain,
            pageRank: pr,
            pageRankDecimal: target.page_rank_decimal ?? null,
            rank: target.rank ?? null,
            label: getPRLabel(pr),
            benchmark: 'Average local business scores 2-4',
            competitors: competitorResults.length > 0 ? competitorResults : undefined,
        });

    } catch (err) {
        return res.json({ domain, pageRank: null, rank: null, error: err.message });
    }
}

// ═══════════════════════════════════════════════════
//   Moz Domain Authority
// ═══════════════════════════════════════════════════
async function handleMoz(req, res, domain) {
    const ACCESS_ID = process.env.MOZ_ACCESS_ID;
    const SECRET_KEY = process.env.MOZ_SECRET_KEY;

    if (!ACCESS_ID || !SECRET_KEY) {
        return res.json({
            domain,
            error: 'MOZ_ACCESS_ID and MOZ_SECRET_KEY not configured',
            domainAuthority: null,
            pageAuthority: null,
        });
    }

    const cleanDomain = clean(domain);

    try {
        const authToken = Buffer.from(`${ACCESS_ID}:${SECRET_KEY}`).toString('base64');

        const resp = await fetch('https://lsapi.seomoz.com/v2/url_metrics', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${authToken}`,
            },
            body: JSON.stringify({ targets: [`${cleanDomain}/`] }),
            signal: AbortSignal.timeout(10000),
        });

        if (!resp.ok) {
            const errText = await resp.text();
            return res.json({
                domain: cleanDomain,
                error: `Moz API ${resp.status}: ${errText.slice(0, 200)}`,
                domainAuthority: null,
                pageAuthority: null,
            });
        }

        const data = await resp.json();
        const result = data.results?.[0] || {};

        const da = result.domain_authority ?? null;
        const pa = result.page_authority ?? null;
        const spamScore = result.spam_score ?? null;
        const linkingDomains = result.root_domains_to_root_domain ?? null;
        const externalLinks = result.external_pages_to_root_domain ?? null;

        let daLabel;
        if (da === null) daLabel = 'Unknown';
        else if (da >= 60) daLabel = 'Strong';
        else if (da >= 40) daLabel = 'Established';
        else if (da >= 20) daLabel = 'Growing';
        else daLabel = 'New / Low';

        let spamLabel;
        if (spamScore === null) spamLabel = 'Unknown';
        else if (spamScore <= 30) spamLabel = 'Low risk';
        else if (spamScore <= 60) spamLabel = 'Moderate risk';
        else spamLabel = 'High risk';

        return res.json({
            domain: cleanDomain,
            domainAuthority: da !== null ? Math.round(da) : null,
            pageAuthority: pa !== null ? Math.round(pa) : null,
            spamScore: spamScore !== null ? Math.round(spamScore) : null,
            spamLabel,
            linkingDomains,
            externalLinks,
            daLabel,
        });

    } catch (err) {
        return res.json({ domain: cleanDomain, error: err.message, domainAuthority: null, pageAuthority: null });
    }
}

// ═══════════════════════════════════════════════════
//   Google Safe Browsing
// ═══════════════════════════════════════════════════
async function handleSafeBrowsing(req, res) {
    const url = req.query.url || req.query.domain || '';
    if (!url) return res.status(400).json({ error: 'Missing url/domain parameter' });

    const API_KEY = process.env.GOOGLE_SAFE_BROWSING_KEY || process.env.GOOGLE_PLACES_KEY;
    if (!API_KEY) return res.json({ url, error: 'GOOGLE_SAFE_BROWSING_KEY not configured', safe: null, threats: [] });

    const domain = url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

    try {
        const urls = [`https://${domain}/`, `http://${domain}/`, `https://www.${domain}/`];

        const resp = await fetch(
            `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client: { clientId: 'eyecarepro-seo-tool', clientVersion: '1.0.0' },
                    threatInfo: {
                        threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
                        platformTypes: ['ANY_PLATFORM'],
                        threatEntryTypes: ['URL'],
                        threatEntries: urls.map(u => ({ url: u })),
                    },
                }),
                signal: AbortSignal.timeout(8000),
            }
        );

        if (!resp.ok) {
            const errText = await resp.text();
            return res.json({ domain, error: `Safe Browsing API ${resp.status}: ${errText.slice(0, 200)}`, safe: null, threats: [] });
        }

        const data = await resp.json();
        const matches = data.matches || [];

        if (matches.length === 0) {
            return res.json({ domain, safe: true, threats: [], summary: 'No threats detected — site is clean' });
        }

        const threatLabels = {
            'MALWARE': 'Malware', 'SOCIAL_ENGINEERING': 'Phishing / Social Engineering',
            'UNWANTED_SOFTWARE': 'Unwanted Software', 'POTENTIALLY_HARMFUL_APPLICATION': 'Potentially Harmful App',
        };
        const threats = [...new Set(matches.map(m => m.threatType))].map(t => ({ type: t, label: threatLabels[t] || t }));

        return res.json({ domain, safe: false, threats, summary: `WARNING: ${threats.map(t => t.label).join(', ')} detected` });
    } catch (err) {
        return res.json({ domain, error: err.message, safe: null, threats: [] });
    }
}

// ═══════════════════════════════════════════════════
//   SSL Labs
// ═══════════════════════════════════════════════════
async function handleSSL(req, res) {
    const domain = (req.query.domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

    try {
        const cacheResp = await fetch(
            `https://api.ssllabs.com/api/v3/analyze?host=${encodeURIComponent(domain)}&fromCache=on&all=done`,
            { signal: AbortSignal.timeout(15000) }
        );

        if (!cacheResp.ok) return res.json({ domain, error: `SSL Labs API returned ${cacheResp.status}`, grade: null });

        const data = await cacheResp.json();

        if (data.status === 'ERROR') {
            return res.json({ domain, grade: null, hasSSL: false, error: data.statusMessage || 'SSL analysis failed', summary: 'No valid SSL certificate found or domain unreachable' });
        }

        if (data.status === 'DNS' || data.status === 'IN_PROGRESS') {
            const readyEndpoints = (data.endpoints || []).filter(e => e.grade);
            if (readyEndpoints.length > 0) return res.json(formatSSLResults(domain, data, readyEndpoints));
            return res.json({ domain, grade: null, scanning: true, status: data.status, summary: 'SSL scan in progress — results may take 30-90 seconds. Try again shortly.' });
        }

        return res.json(formatSSLResults(domain, data, data.endpoints || []));
    } catch (err) {
        try {
            const basicCheck = await fetch(`https://${domain}`, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'follow' });
            return res.json({ domain, grade: null, hasSSL: basicCheck.url.startsWith('https://'), error: 'SSL Labs unavailable — basic check performed', summary: basicCheck.url.startsWith('https://') ? 'HTTPS is active (detailed analysis unavailable)' : 'Site does not use HTTPS' });
        } catch (_) {
            return res.json({ domain, error: err.message, grade: null });
        }
    }
}

function formatSSLResults(domain, data, endpoints) {
    const gradeOrder = ['A+','A','A-','B','C','D','E','F','T','M'];
    const grades = endpoints.map(e => e.grade).filter(Boolean);
    const bestGrade = grades.sort((a, b) => gradeOrder.indexOf(a) - gradeOrder.indexOf(b))[0] || null;
    const worstGrade = grades.sort((a, b) => gradeOrder.indexOf(b) - gradeOrder.indexOf(a))[0] || null;

    const ep = endpoints.find(e => e.details) || endpoints[0] || {};
    const details = ep.details || {};
    const cert = details.cert || {};
    const protocols = (details.protocols || []).map(p => `${p.name} ${p.version}`);

    const vulnerabilities = [];
    if (details.heartbleed) vulnerabilities.push('Heartbleed');
    if (details.poodle) vulnerabilities.push('POODLE');
    if (details.freak) vulnerabilities.push('FREAK');
    if (details.logjam) vulnerabilities.push('Logjam');
    if (details.drownVulnerable) vulnerabilities.push('DROWN');

    let certExpiry = null, certDaysLeft = null, certExpired = false;
    if (cert.notAfter) {
        certExpiry = new Date(cert.notAfter).toISOString().split('T')[0];
        certDaysLeft = Math.floor((cert.notAfter - Date.now()) / 86400000);
        certExpired = certDaysLeft < 0;
    }

    let gradeLabel = !bestGrade ? 'Unknown' : bestGrade.startsWith('A') ? 'Excellent' : bestGrade === 'B' ? 'Good' : bestGrade === 'C' ? 'Fair' : 'Poor';

    let summary;
    if (!bestGrade) summary = 'SSL analysis in progress';
    else if (certExpired) summary = `SSL grade ${bestGrade} but CERTIFICATE IS EXPIRED`;
    else if (certDaysLeft !== null && certDaysLeft < 30) summary = `SSL grade ${bestGrade} — certificate expires in ${certDaysLeft} days!`;
    else if (vulnerabilities.length > 0) summary = `SSL grade ${bestGrade} — ${vulnerabilities.length} vulnerabilities detected`;
    else summary = `SSL grade ${bestGrade} (${gradeLabel}) — certificate valid for ${certDaysLeft} days`;

    return {
        domain, hasSSL: true, grade: bestGrade, worstGrade, gradeLabel,
        certIssuer: cert.issuerSubject || cert.issuerLabel || null,
        certSubject: cert.commonNames?.[0] || cert.subject || null,
        certExpiry, certDaysLeft, certExpired, protocols,
        supportsHSTS: details.hstsPolicy?.status === 'present',
        hstsMaxAge: details.hstsPolicy?.maxAge || null,
        vulnerabilities, hasVulnerabilities: vulnerabilities.length > 0,
        endpointCount: endpoints.length, summary,
    };
}

// ═══════════════════════════════════════════════════
//   Helpers
// ═══════════════════════════════════════════════════
function clean(d) {
    return d.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
}

function getPRLabel(pr) {
    if (pr == null) return 'Unknown';
    if (pr >= 7) return 'Strong';
    if (pr >= 5) return 'Established';
    if (pr >= 3) return 'Growing';
    return 'New / Low';
}
