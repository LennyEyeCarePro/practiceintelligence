/**
 * Vercel Serverless Function — SSL Labs API
 * Deep SSL/TLS certificate analysis — grade, expiration, protocol support, vulnerabilities.
 *
 * Fully free, no API key needed.
 * NOTE: SSL Labs scans take 30-90 seconds. We use fromCache=on to get cached results when available.
 *       If no cache exists, we start a scan and return partial results.
 *
 * GET /api/ssl-check?domain=example.com
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { domain } = req.query;
    if (!domain) return res.status(400).json({ error: 'Missing domain parameter' });

    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

    try {
        // First try to get cached results (instant)
        const cacheResp = await fetch(
            `https://api.ssllabs.com/api/v3/analyze?host=${encodeURIComponent(cleanDomain)}&fromCache=on&all=done`,
            { signal: AbortSignal.timeout(15000) }
        );

        if (!cacheResp.ok) {
            return res.json({
                domain: cleanDomain,
                error: `SSL Labs API returned ${cacheResp.status}`,
                grade: null,
            });
        }

        const data = await cacheResp.json();

        // If status is ERROR, the domain may not have SSL at all
        if (data.status === 'ERROR') {
            return res.json({
                domain: cleanDomain,
                grade: null,
                hasSSL: false,
                error: data.statusMessage || 'SSL analysis failed',
                summary: 'No valid SSL certificate found or domain unreachable',
            });
        }

        // If status is DNS or IN_PROGRESS, a scan has started but isn't done yet
        if (data.status === 'DNS' || data.status === 'IN_PROGRESS') {
            // Try to get at least some info from the endpoints that are ready
            const readyEndpoints = (data.endpoints || []).filter(e => e.grade);

            if (readyEndpoints.length > 0) {
                return res.json(formatResults(cleanDomain, data, readyEndpoints));
            }

            return res.json({
                domain: cleanDomain,
                grade: null,
                scanning: true,
                status: data.status,
                summary: 'SSL scan in progress — results may take 30-90 seconds. Try again shortly.',
            });
        }

        // READY — full results available
        const endpoints = data.endpoints || [];
        return res.json(formatResults(cleanDomain, data, endpoints));

    } catch (err) {
        // If SSL Labs is down or slow, do a basic SSL check ourselves
        try {
            const basicCheck = await fetch(`https://${cleanDomain}`, {
                method: 'HEAD',
                signal: AbortSignal.timeout(5000),
                redirect: 'follow',
            });

            return res.json({
                domain: cleanDomain,
                grade: null,
                hasSSL: basicCheck.url.startsWith('https://'),
                error: 'SSL Labs unavailable — basic check performed',
                summary: basicCheck.url.startsWith('https://') ? 'HTTPS is active (detailed analysis unavailable)' : 'Site does not use HTTPS',
            });
        } catch (_) {
            return res.json({
                domain: cleanDomain,
                error: err.message,
                grade: null,
            });
        }
    }
}

function formatResults(domain, data, endpoints) {
    // Get the best (lowest) grade from all endpoints
    const gradeOrder = ['A+', 'A', 'A-', 'B', 'C', 'D', 'E', 'F', 'T', 'M'];
    const grades = endpoints.map(e => e.grade).filter(Boolean);
    const bestGrade = grades.sort((a, b) => gradeOrder.indexOf(a) - gradeOrder.indexOf(b))[0] || null;
    const worstGrade = grades.sort((a, b) => gradeOrder.indexOf(b) - gradeOrder.indexOf(a))[0] || null;

    // Extract cert details from first endpoint with details
    const ep = endpoints.find(e => e.details) || endpoints[0] || {};
    const details = ep.details || {};
    const cert = details.cert || {};

    // Protocol support
    const protocols = (details.protocols || []).map(p => `${p.name} ${p.version}`);

    // Vulnerability flags
    const vulnerabilities = [];
    if (details.heartbleed) vulnerabilities.push('Heartbleed');
    if (details.poodle) vulnerabilities.push('POODLE');
    if (details.freak) vulnerabilities.push('FREAK');
    if (details.logjam) vulnerabilities.push('Logjam');
    if (details.drownVulnerable) vulnerabilities.push('DROWN');

    // Certificate expiration
    let certExpiry = null;
    let certDaysLeft = null;
    let certExpired = false;
    if (cert.notAfter) {
        certExpiry = new Date(cert.notAfter).toISOString().split('T')[0];
        certDaysLeft = Math.floor((cert.notAfter - Date.now()) / 86400000);
        certExpired = certDaysLeft < 0;
    }

    // Grade label
    let gradeLabel;
    if (!bestGrade) gradeLabel = 'Unknown';
    else if (bestGrade.startsWith('A')) gradeLabel = 'Excellent';
    else if (bestGrade === 'B') gradeLabel = 'Good';
    else if (bestGrade === 'C') gradeLabel = 'Fair';
    else gradeLabel = 'Poor';

    // Summary
    let summary;
    if (!bestGrade) summary = 'SSL analysis in progress';
    else if (certExpired) summary = `SSL grade ${bestGrade} but CERTIFICATE IS EXPIRED`;
    else if (certDaysLeft !== null && certDaysLeft < 30) summary = `SSL grade ${bestGrade} — certificate expires in ${certDaysLeft} days!`;
    else if (vulnerabilities.length > 0) summary = `SSL grade ${bestGrade} — ${vulnerabilities.length} vulnerabilities detected`;
    else summary = `SSL grade ${bestGrade} (${gradeLabel}) — certificate valid for ${certDaysLeft} days`;

    return {
        domain,
        hasSSL: true,
        grade: bestGrade,
        worstGrade,
        gradeLabel,
        certIssuer: cert.issuerSubject || cert.issuerLabel || null,
        certSubject: cert.commonNames?.[0] || cert.subject || null,
        certExpiry,
        certDaysLeft,
        certExpired,
        protocols,
        supportsHSTS: details.hstsPolicy?.status === 'present',
        hstsMaxAge: details.hstsPolicy?.maxAge || null,
        vulnerabilities,
        hasVulnerabilities: vulnerabilities.length > 0,
        endpointCount: endpoints.length,
        summary,
    };
}
