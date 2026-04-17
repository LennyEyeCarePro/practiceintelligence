/**
 * Vercel Serverless Function — SEO Report Orchestrator
 * Collects data from all sources and optionally sends to Claude for AI interpretation.
 *
 * POST /api/seo-report { url: "example.com", businessName: "Access Eye", city: "Fredericksburg VA" }
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { url, businessName, city, siteAudit, lighthouse, pageRank, places, userCorrections } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

    // Build a single "CLIENT-PROVIDED CONTEXT" block from free-text corrections.
    // The client knows their practice better than any scraper — this takes priority over scraped data.
    function buildClientContext(c) {
        if (!c) return '';
        const parts = [];
        if (c.practiceCorrections) parts.push(`• Practice profile corrections (trusted — client clarified what the scrape got wrong): "${c.practiceCorrections}"`);
        if (c.serviceCorrections) parts.push(`• Services we missed / client offers (trusted over scraped list): "${c.serviceCorrections}"`);
        if (c.digitalCorrections) parts.push(`• Digital/marketing context the client shared: "${c.digitalCorrections}"`);
        if (c.growthGoal) parts.push(`• Client's #1 stated growth goal: "${c.growthGoal}"`);
        if (c.biggestPain) parts.push(`• Client's biggest frustration right now: "${c.biggestPain}"`);
        if (c.freetext) parts.push(`• Additional notes from the client: "${c.freetext}"`);
        if (c.correctedBusinessName) parts.push(`• Correct business name (use this, not the scraped one): "${c.correctedBusinessName}"`);
        if (parts.length === 0) return '';
        return `\n\nCLIENT-PROVIDED CONTEXT (authoritative — the client knows their own practice):\n${parts.join('\n')}\n\nRules for using this context:\n1. When scraped data contradicts the client's corrections, TRUST THE CLIENT.\n2. Reference specific client-provided details in findings where relevant (e.g. "You mentioned offering dry eye treatment — ensure this is prominent on your homepage").\n3. Tailor the topOpportunity toward the client's stated growth goal and biggest pain point.\n4. Do not claim a service is "missing" if the client said they offer it — instead frame it as a visibility issue ("you offer this but it's not visible on your site/GBP").`;
    }

    const clientContext = buildClientContext(userCorrections);

    const GEMINI_KEY = process.env.GEMINI_API_KEY;

    // If no Gemini key, return a rule-based interpretation
    if (!GEMINI_KEY) {
        return res.json(generateRuleBasedReport(url, { siteAudit, lighthouse, pageRank, places }));
    }

    try {
        // Build the prompt with all collected data
        const mobile = lighthouse?.mobile || {};
        const desktop = lighthouse?.desktop || {};
        const audit = siteAudit || {};
        const pr = pageRank || {};
        const biz = places?.business || {};
        const competitors = places?.competitors || [];

        // When site-audit got a 403/error, infer what we can from Lighthouse
        // (Google's infrastructure successfully fetched the page even if our server couldn't)
        const auditFailed = !!(audit.error && !audit.titleTag);
        if (auditFailed && (mobile.seo || desktop.seo)) {
            // Lighthouse loaded the page over HTTPS, so SSL is confirmed
            if (!audit.ssl) audit.ssl = true;
            // Use Lighthouse SEO score as a proxy indicator
            audit._lighthouseFallback = true;
        }

        const prompt = `You are an SEO analyst specializing in optometry and ophthalmology practices. You provide actionable, data-backed insights.

Here is the real SEO audit data for ${url}:
${auditFailed ? '\nNOTE: Our on-page crawler could not fetch this site directly (HTTP 403), but Google PageSpeed Insights successfully loaded and scored it. The SSL and Lighthouse data below are confirmed real. For on-page elements we could not verify, use the Lighthouse SEO score as a proxy — if Lighthouse SEO is high (85+), the site likely has proper meta tags, viewport, canonical, etc. Score conservatively but do NOT give 0 to pillars just because our crawler was blocked.\n' : ''}
PAGESPEED (Mobile):
- Performance: ${mobile.performance || 'N/A'}/100
- SEO Score: ${mobile.seo || 'N/A'}/100
- Accessibility: ${mobile.accessibility || 'N/A'}/100
- Best Practices: ${mobile.bestPractices || 'N/A'}/100
- LCP: ${mobile.lcp || 'N/A'}
- CLS: ${mobile.cls || 'N/A'}
- TBT: ${mobile.tbt || 'N/A'}
- Field Data Category: ${mobile.overallCategory || 'N/A'}

PAGESPEED (Desktop):
- Performance: ${desktop.performance || 'N/A'}/100
- SEO Score: ${desktop.seo || 'N/A'}/100

GOOGLE BUSINESS PROFILE:
- Name: ${biz.name || 'Not found'}
- Rating: ${biz.rating || 'N/A'} (${biz.reviewCount || 0} reviews)
- Photos: ${biz.photoCount || 0}
- Hours set: ${biz.hasHours ? 'Yes' : 'No'}
- Category: ${biz.primaryCategory || 'Unknown'}
- Business status: ${biz.businessStatus || 'Unknown'}
- Competitors nearby: ${competitors.map(c => `${c.name} (${c.rating}★, ${c.reviewCount} reviews)`).join('; ') || 'None found'}

ON-PAGE SEO:
- SSL: ${audit.ssl ? 'Yes' : 'No'}
- Title tag: "${audit.titleTag || (auditFailed ? 'UNABLE TO VERIFY (crawler blocked)' : 'MISSING')}" (${audit.titleLength || 0} chars)
- Meta description: ${audit.metaDescription ? `"${audit.metaDescription.slice(0, 80)}..." (${audit.metaDescriptionLength} chars)` : (auditFailed ? 'UNABLE TO VERIFY (crawler blocked)' : 'MISSING')}
- H1: "${audit.h1 || (auditFailed ? 'UNABLE TO VERIFY (crawler blocked)' : 'MISSING')}" (${audit.h1Count || 0} H1 tags)
- Schema markup: ${audit.hasLocalBusinessSchema ? 'LocalBusiness schema present' : audit.hasSchemaMarkup ? 'Generic schema only' : (auditFailed ? 'Unable to verify' : 'None')}
- Booking CTA: ${audit.hasOnlineBooking ? 'Online booking present' : audit.hasBookingCTA ? 'Basic booking link' : (auditFailed ? 'Unable to verify' : 'No booking CTA')}
- Canonical: ${audit.hasCanonical ? 'Yes' : (auditFailed ? 'Unable to verify' : 'No')}
- Image alt text: ${auditFailed ? 'Unable to verify' : `${audit.altTextCoverage || 0}% coverage (${audit.imagesWithAlt || 0}/${audit.totalImages || 0})`}
- Sitemap: ${audit.hasSitemap ? `Yes (${audit.sitemapUrlCount} URLs)` : (auditFailed ? 'Unable to verify' : 'Missing')}
- Robots.txt: ${audit.hasRobots ? (audit.blocksGooglebot ? 'Present but BLOCKS Googlebot' : 'Present') : (auditFailed ? 'Unable to verify' : 'Missing')}
- Open Graph: ${[audit.hasOgTitle && 'title', audit.hasOgDescription && 'desc', audit.hasOgImage && 'image'].filter(Boolean).join(', ') || (auditFailed ? 'Unable to verify' : 'None')}
- Word count: ${audit.wordCount || 'N/A'}

DOMAIN AUTHORITY: ${pr.pageRank ?? 'N/A'}/10 (${pr.label || 'Unknown'})${clientContext}

Generate a response in this exact JSON format. Do not include any text outside the JSON:
{
  "overallScore": <integer 0-100>,
  "grade": "<A/B/C/D/F>",
  "headline": "<10 words max — plain English verdict>",
  "topOpportunity": "<most impactful fix with estimated patient impact, 1-2 sentences>",
  "pillarScores": {
    "pageSpeed": <0-100>,
    "onPageSeo": <0-100>,
    "localGbp": <0-100>,
    "backlinks": <0-100>,
    "technical": <0-100>
  },
  "findings": [
    {"severity": "critical|warning|good", "category": "<category>", "detail": "<specific finding referencing real data>"},
    {"severity": "critical|warning|good", "category": "<category>", "detail": "<specific finding referencing real data>"},
    {"severity": "critical|warning|good", "category": "<category>", "detail": "<specific finding referencing real data>"},
    {"severity": "critical|warning|good", "category": "<category>", "detail": "<specific finding referencing real data>"},
    {"severity": "critical|warning|good", "category": "<category>", "detail": "<specific finding referencing real data>"}
  ]
}

Scoring weights: Page Speed 25%, On-Page SEO 20%, Google Business Profile 25%, Domain Authority 15%, Technical 15%.
Base everything strictly on the real data provided. Do not invent numbers.`;

        const geminiResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${GEMINI_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.3,
                        maxOutputTokens: 1024,
                        responseMimeType: 'application/json',
                    },
                }),
                signal: AbortSignal.timeout(20000),
            }
        );

        if (!geminiResp.ok) {
            const errText = await geminiResp.text();
            console.error('Gemini API error:', errText);
            return res.json(generateRuleBasedReport(url, { siteAudit, lighthouse, pageRank, places }));
        }

        const geminiData = await geminiResp.json();
        const aiText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // Parse JSON from Gemini's response
        const jsonMatch = aiText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const aiReport = JSON.parse(jsonMatch[0]);
            aiReport.source = 'ai';
            return res.json(aiReport);
        }

        // Fallback to rule-based if AI response can't be parsed
        return res.json(generateRuleBasedReport(url, { siteAudit, lighthouse, pageRank, places }));

    } catch (err) {
        console.error('SEO report error:', err);
        return res.json(generateRuleBasedReport(url, { siteAudit, lighthouse, pageRank, places }));
    }
}

/**
 * Rule-based fallback when Claude API is unavailable
 */
function generateRuleBasedReport(url, data) {
    const mobile = data.lighthouse?.mobile || {};
    const audit = data.siteAudit || {};
    const pr = data.pageRank || {};
    const biz = data.places?.business || {};

    // Detect if our crawler was blocked but Lighthouse succeeded
    const auditFailed = !!(audit.error && !audit.titleTag);
    const lighthouseWorked = !!(mobile.seo || mobile.performance);

    // Page Speed score (25%)
    const pageSpeed = mobile.performance || 50;

    // On-Page SEO (20%)
    let onPage = 0;
    if (auditFailed && lighthouseWorked) {
        // Crawler was blocked, use Lighthouse SEO score as proxy
        // Lighthouse SEO checks meta tags, viewport, canonical, indexable, etc.
        onPage = mobile.seo || 50;
    } else {
        if (audit.ssl) onPage += 15;
        if (audit.titleLength >= 30 && audit.titleLength <= 70) onPage += 20;
        else if (audit.titleTag) onPage += 10;
        if (audit.metaDescriptionLength >= 120 && audit.metaDescriptionLength <= 170) onPage += 20;
        else if (audit.metaDescription) onPage += 10;
        if (audit.h1 && audit.h1Count === 1) onPage += 15;
        else if (audit.h1) onPage += 8;
        if (audit.hasCanonical) onPage += 10;
        if (audit.isIndexable) onPage += 10;
        if (audit.altTextCoverage >= 80) onPage += 10;
        else if (audit.altTextCoverage >= 50) onPage += 5;
    }

    // Local / GBP (25%)
    let local = 0;
    if (biz.rating >= 4.5) local += 30;
    else if (biz.rating >= 4.0) local += 20;
    else if (biz.rating) local += 10;
    if (biz.reviewCount >= 100) local += 25;
    else if (biz.reviewCount >= 50) local += 18;
    else if (biz.reviewCount >= 20) local += 10;
    if (biz.photoCount >= 10) local += 15;
    else if (biz.photoCount >= 5) local += 8;
    if (biz.hasHours) local += 10;
    if (biz.primaryCategory === 'Optometrist' || biz.primaryCategory === 'Ophthalmologist') local += 20;
    else if (biz.name) local += 10;

    // Backlinks / DA (15%)
    const backlinks = pr.pageRank !== null ? Math.min(pr.pageRank * 14, 100) : 30;

    // Technical (15%)
    let technical = 0;
    if (auditFailed && lighthouseWorked) {
        // Crawler was blocked but site loads fine via Google
        // SSL is confirmed (Lighthouse loaded it), give baseline technical score
        technical = 25; // SSL confirmed
        // Lighthouse bestPractices covers some technical aspects
        if (mobile.bestPractices >= 80) technical += 25;
        else if (mobile.bestPractices >= 60) technical += 15;
        // Give partial credit since we can't verify sitemap/robots/schema
        technical += 15; // assume average for unverifiable items
    } else {
        if (audit.ssl) technical += 25;
        if (audit.hasSitemap) technical += 20;
        if (audit.hasRobots && !audit.blocksGooglebot) technical += 15;
        if (audit.hasLocalBusinessSchema) technical += 20;
        else if (audit.hasSchemaMarkup) technical += 10;
        if (audit.hasViewport) technical += 10;
        if (audit.hasOgTitle && audit.hasOgImage) technical += 10;
    }

    const overallScore = Math.round(
        pageSpeed * 0.25 + onPage * 0.20 + local * 0.25 + backlinks * 0.15 + technical * 0.15
    );

    let grade;
    if (overallScore >= 85) grade = 'A';
    else if (overallScore >= 70) grade = 'B';
    else if (overallScore >= 55) grade = 'C';
    else if (overallScore >= 40) grade = 'D';
    else grade = 'F';

    // Generate findings
    const findings = [];
    if (auditFailed) {
        findings.push({ severity: 'warning', category: 'Technical', detail: 'Our crawler was blocked by this site\'s firewall (HTTP 403). Some on-page details could not be verified directly, but Google PageSpeed successfully analyzed the site. Scores are estimated from Lighthouse data.' });
        // Still add SSL as good finding since Lighthouse confirmed HTTPS
        if (lighthouseWorked) findings.push({ severity: 'good', category: 'Security', detail: 'SSL certificate is active — confirmed via Google PageSpeed analysis. Your site is secure.' });
    } else {
        if (!audit.metaDescription) findings.push({ severity: 'critical', category: 'On-Page SEO', detail: 'No meta description found — this is what shows in Google search results. Adding one can significantly improve click-through rates.' });
        if (audit.titleLength < 30 || audit.titleLength > 70) findings.push({ severity: 'warning', category: 'On-Page SEO', detail: `Title tag is ${audit.titleLength} characters (ideal: 50-60). ${audit.titleLength < 30 ? 'Too short — add location and key services.' : 'Too long — Google will truncate it.'}` });
        if (!audit.hasLocalBusinessSchema) findings.push({ severity: 'critical', category: 'Technical', detail: 'No LocalBusiness schema markup — Google can\'t properly understand your practice type, location, and services.' });
        if (!audit.hasSitemap) findings.push({ severity: 'warning', category: 'Technical', detail: 'No sitemap.xml found — search engines may not discover all your pages.' });
        if (audit.altTextCoverage < 50) findings.push({ severity: 'warning', category: 'Accessibility', detail: `Only ${audit.altTextCoverage}% of images have alt text — hurts both SEO and accessibility compliance.` });
        if (audit.ssl) findings.push({ severity: 'good', category: 'Security', detail: 'SSL certificate is active — your site is secure and Google gives a ranking boost for HTTPS.' });
    }
    if (biz.reviewCount && biz.reviewCount < 50) findings.push({ severity: 'warning', category: 'Local SEO', detail: `Only ${biz.reviewCount} Google reviews — practices with 50+ reviews see significantly better local rankings.` });
    if (biz.rating && biz.rating < 4.5) findings.push({ severity: 'warning', category: 'Local SEO', detail: `Google rating is ${biz.rating}★ — aim for 4.5+ to maximize patient trust and click-through.` });
    if (pageSpeed < 50) findings.push({ severity: 'critical', category: 'Page Speed', detail: `Mobile performance score is ${pageSpeed}/100 — slow sites lose up to 53% of visitors. This is costing you patients.` });
    if (biz.rating >= 4.5) findings.push({ severity: 'good', category: 'Local SEO', detail: `Strong ${biz.rating}★ rating with ${biz.reviewCount} reviews — excellent social proof for new patients.` });

    // Top opportunity
    let topOpportunity;
    if (auditFailed && !audit.hasLocalBusinessSchema) {
        // Can't determine schema status when audit failed
        if (pageSpeed < 50) topOpportunity = `Your mobile site speed score is ${pageSpeed}/100. Optimizing images and reducing render-blocking resources could cut load time in half.`;
        else if (biz.reviewCount && biz.reviewCount < 50) topOpportunity = `You have ${biz.reviewCount} reviews — getting to 50+ can meaningfully improve your local ranking.`;
        else topOpportunity = 'Your site\'s firewall blocked our detailed crawler. Consider whitelisting SEO audit tools to get deeper on-page insights. Based on Google PageSpeed data, your foundation looks reasonable.';
    } else if (!audit.hasLocalBusinessSchema) topOpportunity = 'Add LocalBusiness schema markup to your homepage. This helps Google understand your practice and can improve your visibility in local search results — potentially driving 15-25% more local discovery.';
    else if (pageSpeed < 50) topOpportunity = `Your mobile site speed score is ${pageSpeed}/100. Optimizing images and reducing render-blocking resources could cut load time in half — studies show this can recover up to 20% of bounced visitors.`;
    else if (!audit.metaDescription) topOpportunity = 'Add a compelling meta description with your city name, key services, and a call to action. This is the first thing patients see in Google results.';
    else if (biz.reviewCount < 50) topOpportunity = `You have ${biz.reviewCount} reviews — getting to 50+ can meaningfully improve your local ranking. Consider an automated review request system after appointments.`;
    else topOpportunity = 'Your SEO foundation is solid. Focus on creating service-specific content pages for each treatment you offer — each page is a new opportunity to rank for patient searches.';

    return {
        source: 'rules',
        overallScore,
        grade,
        headline: overallScore >= 70 ? 'Solid foundation with room to grow' : overallScore >= 50 ? 'Needs attention in key areas' : 'Significant gaps hurting your visibility',
        topOpportunity,
        pillarScores: {
            pageSpeed,
            onPageSeo: onPage,
            localGbp: local,
            backlinks,
            technical,
        },
        findings: findings.slice(0, 5),
    };
}
