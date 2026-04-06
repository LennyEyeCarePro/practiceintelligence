/**
 * Vercel Serverless Function — Security Hub
 * Combines Google Safe Browsing + SSL Labs into one endpoint.
 *
 * GET /api/security?domain=example.com&action=safe-browsing
 * GET /api/security?domain=example.com&action=ssl
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const action = req.query.action || req.query.url ? 'safe-browsing' : 'ssl';

    // Support legacy ?url= param for safe-browsing
    if (action === 'safe-browsing' || req.query.url) return handleSafeBrowsing(req, res);
    if (action === 'ssl') return handleSSL(req, res);
    return res.status(400).json({ error: `Unknown action: ${action}. Use safe-browsing|ssl` });
}

// ═══════════════════════════════════════════════════
//   ACTION: safe-browsing — Google Safe Browsing API
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
//   ACTION: ssl — SSL Labs Certificate Analysis
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
