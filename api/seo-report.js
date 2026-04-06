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

    const { url, businessName, city, siteAudit, lighthouse, pageRank, places } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

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

        const prompt = `You are an SEO analyst specializing in optometry and ophthalmology practices. You provide actionable, data-backed insights.

Here is the real SEO audit data for ${url}:

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
- Title tag: "${audit.titleTag || 'MISSING'}" (${audit.titleLength || 0} chars)
- Meta description: ${audit.metaDescription ? `"${audit.metaDescription.slice(0, 80)}..." (${audit.metaDescriptionLength} chars)` : 'MISSING'}
- H1: "${audit.h1 || 'MISSING'}" (${audit.h1Count || 0} H1 tags)
- Schema markup: ${audit.hasLocalBusinessSchema ? 'LocalBusiness schema present' : audit.hasSchemaMarkup ? 'Generic schema only' : 'None'}
- Booking CTA: ${audit.hasOnlineBooking ? 'Online booking present' : audit.hasBookingCTA ? 'Basic booking link' : 'No booking CTA'}
- Canonical: ${audit.hasCanonical ? 'Yes' : 'No'}
- Image alt text: ${audit.altTextCoverage || 0}% coverage (${audit.imagesWithAlt || 0}/${audit.totalImages || 0})
- Sitemap: ${audit.hasSitemap ? `Yes (${audit.sitemapUrlCount} URLs)` : 'Missing'}
- Robots.txt: ${audit.hasRobots ? (audit.blocksGooglebot ? 'Present but BLOCKS Googlebot' : 'Present') : 'Missing'}
- Open Graph: ${[audit.hasOgTitle && 'title', audit.hasOgDescription && 'desc', audit.hasOgImage && 'image'].filter(Boolean).join(', ') || 'None'}
- Word count: ${audit.wordCount || 'N/A'}

DOMAIN AUTHORITY: ${pr.pageRank ?? 'N/A'}/10 (${pr.label || 'Unknown'})

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

    // Page Speed score (25%)
    const pageSpeed = mobile.performance || 50;

    // On-Page SEO (20%)
    let onPage = 0;
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
    if (audit.ssl) technical += 25;
    if (audit.hasSitemap) technical += 20;
    if (audit.hasRobots && !audit.blocksGooglebot) technical += 15;
    if (audit.hasLocalBusinessSchema) technical += 20;
    else if (audit.hasSchemaMarkup) technical += 10;
    if (audit.hasViewport) technical += 10;
    if (audit.hasOgTitle && audit.hasOgImage) technical += 10;

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
    if (!audit.metaDescription) findings.push({ severity: 'critical', category: 'On-Page SEO', detail: 'No meta description found — this is what shows in Google search results. Adding one can significantly improve click-through rates.' });
    if (audit.titleLength < 30 || audit.titleLength > 70) findings.push({ severity: 'warning', category: 'On-Page SEO', detail: `Title tag is ${audit.titleLength} characters (ideal: 50-60). ${audit.titleLength < 30 ? 'Too short — add location and key services.' : 'Too long — Google will truncate it.'}` });
    if (!audit.hasLocalBusinessSchema) findings.push({ severity: 'critical', category: 'Technical', detail: 'No LocalBusiness schema markup — Google can\'t properly understand your practice type, location, and services.' });
    if (!audit.hasSitemap) findings.push({ severity: 'warning', category: 'Technical', detail: 'No sitemap.xml found — search engines may not discover all your pages.' });
    if (biz.reviewCount && biz.reviewCount < 50) findings.push({ severity: 'warning', category: 'Local SEO', detail: `Only ${biz.reviewCount} Google reviews — practices with 50+ reviews see significantly better local rankings.` });
    if (biz.rating && biz.rating < 4.5) findings.push({ severity: 'warning', category: 'Local SEO', detail: `Google rating is ${biz.rating}★ — aim for 4.5+ to maximize patient trust and click-through.` });
    if (pageSpeed < 50) findings.push({ severity: 'critical', category: 'Page Speed', detail: `Mobile performance score is ${pageSpeed}/100 — slow sites lose up to 53% of visitors. This is costing you patients.` });
    if (audit.altTextCoverage < 50) findings.push({ severity: 'warning', category: 'Accessibility', detail: `Only ${audit.altTextCoverage}% of images have alt text — hurts both SEO and accessibility compliance.` });
    if (audit.ssl) findings.push({ severity: 'good', category: 'Security', detail: 'SSL certificate is active — your site is secure and Google gives a ranking boost for HTTPS.' });
    if (biz.rating >= 4.5) findings.push({ severity: 'good', category: 'Local SEO', detail: `Strong ${biz.rating}★ rating with ${biz.reviewCount} reviews — excellent social proof for new patients.` });

    // Top opportunity
    let topOpportunity;
    if (!audit.hasLocalBusinessSchema) topOpportunity = 'Add LocalBusiness schema markup to your homepage. This helps Google understand your practice and can improve your visibility in local search results — potentially driving 15-25% more local discovery.';
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
