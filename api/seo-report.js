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

    // ── Provider selection ──────────────────────────────────────────────────
    // OpenAI is preferred when configured. The Gemini key was retired after its
    // free-tier quota ran out and every request started returning HTTP 429 —
    // which silently degraded every report to the rule-based fallback.
    //
    // OPEN_AI_KEY is the name used in this project's Vercel env; OPENAI_API_KEY is
    // accepted too since that is the conventional name and an easy slip.
    const OPENAI_KEY = process.env.OPEN_AI_KEY || process.env.OPENAI_API_KEY;
    const GEMINI_KEY = process.env.GEMINI_API_KEY;

    // Overridable without a code change, so a model swap is a Vercel env edit.
    const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    // Every fallback path below passes userCorrections through. It used to be
    // dropped, so any AI hiccup produced a report with zero client input —
    // pure boilerplate, and nothing in the UI said so.
    const ruleBased = (reason) => generateRuleBasedReport(
        url,
        { siteAudit, lighthouse, pageRank, places },
        userCorrections,
        reason,
    );

    if (!OPENAI_KEY && !GEMINI_KEY) {
        return res.json(ruleBased('No AI provider configured (set OPEN_AI_KEY)'));
    }

    /**
     * Ask OpenAI for the report JSON. Returns the raw text of the response.
     *
     * The body is deliberately minimal. Token-limit and sampling parameter names
     * differ across model families (max_tokens vs max_completion_tokens, and some
     * models reject a custom temperature), and the response here is ~600 tokens
     * of JSON, so there is nothing to gain by constraining it and a real chance of
     * a 400 that would push every report back to the rule-based path.
     */
    async function callOpenAI(prompt) {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + OPENAI_KEY,
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                messages: [
                    { role: 'system', content: 'You are an SEO analyst for eye care practices. Reply with JSON only.' },
                    { role: 'user', content: prompt },
                ],
                response_format: { type: 'json_object' },
            }),
            signal: AbortSignal.timeout(30000),
        });

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`OpenAI HTTP ${resp.status} (model ${OPENAI_MODEL}): ${errText.slice(0, 300)}`);
        }
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || '';
    }

    /** Ask Gemini for the report JSON. Retained as a fallback provider. */
    async function callGemini(prompt) {
        const resp = await fetch(
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
        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Gemini HTTP ${resp.status}: ${errText.slice(0, 300)}`);
        }
        const data = await resp.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    try {
        // Build the prompt with all collected data
        const mobile = lighthouse?.mobile || {};
        const desktop = lighthouse?.desktop || {};
        const audit = siteAudit || {};
        const pr = pageRank || {};
        const biz = places?.business || {};
        const competitors = places?.competitors || [];

        // Detect when our crawler was blocked (403/error) but Lighthouse succeeded
        const auditFailed = !!(audit.error && !audit.titleTag);

        const prompt = `You are an SEO analyst specializing in optometry and ophthalmology practices. You provide actionable, data-backed insights.

Here is the real SEO audit data for ${url}:
${auditFailed ? '\nIMPORTANT: Our on-page HTML crawler was BLOCKED by this site\'s firewall (HTTP ' + (audit.status || '403') + '). We could NOT inspect on-page elements like title tags, meta descriptions, schema, sitemap, etc. Google PageSpeed Insights DID successfully load the site, so Page Speed and Lighthouse scores are real. For pillar scores where we have NO DATA, use null instead of guessing. Be honest — do not fabricate scores for things we cannot verify.\n' : ''}
PAGESPEED (Mobile):
- Performance: ${mobile.performance ?? 'N/A'}/100
- SEO Score: ${mobile.seo ?? 'N/A'}/100
- Accessibility: ${mobile.accessibility ?? 'N/A'}/100
- Best Practices: ${mobile.bestPractices ?? 'N/A'}/100
- LCP: ${mobile.lcp || 'N/A'}
- CLS: ${mobile.cls || 'N/A'}
- TBT: ${mobile.tbt || 'N/A'}
- Field Data Category: ${mobile.overallCategory || 'N/A'}

PAGESPEED (Desktop):
- Performance: ${desktop.performance ?? 'N/A'}/100
- SEO Score: ${desktop.seo ?? 'N/A'}/100

GOOGLE BUSINESS PROFILE:
- Name: ${biz.name || 'Not found'}
- Rating: ${biz.rating ?? 'N/A'} (${biz.reviewCount ?? 0} reviews)
- Photos: ${biz.photoCount || 0}
- Hours set: ${biz.hasHours ? 'Yes' : 'No'}
- Category: ${biz.primaryCategory || 'Unknown'}
- Business status: ${biz.businessStatus || 'Unknown'}
- Competitors nearby: ${competitors.map(c => `${c.name} (${c.rating}★, ${c.reviewCount} reviews)`).join('; ') || 'None found'}

ON-PAGE SEO:${auditFailed ? ' ⚠️ CRAWLER BLOCKED — on-page data unavailable' : ''}
- SSL: ${auditFailed ? 'UNKNOWN (crawler blocked, but site loaded via Google PageSpeed over HTTPS)' : (audit.ssl ? 'Yes' : 'No')}
- Title tag: ${auditFailed ? 'COULD NOT FETCH' : `"${audit.titleTag || 'MISSING'}" (${audit.titleLength ?? 0} chars)`}
- Meta description: ${auditFailed ? 'COULD NOT FETCH' : (audit.metaDescription ? `"${audit.metaDescription.slice(0, 80)}..." (${audit.metaDescriptionLength} chars)` : 'MISSING')}
- H1: ${auditFailed ? 'COULD NOT FETCH' : `"${audit.h1 || 'MISSING'}" (${audit.h1Count ?? 0} H1 tags)`}
- Schema markup: ${auditFailed ? 'COULD NOT FETCH' : (audit.hasLocalBusinessSchema ? 'LocalBusiness schema present' : audit.hasSchemaMarkup ? 'Generic schema only' : 'None')}
- Booking CTA: ${auditFailed ? 'COULD NOT FETCH' : (audit.hasOnlineBooking ? 'Online booking present' : audit.hasBookingCTA ? 'Basic booking link' : 'No booking CTA')}
- Canonical: ${auditFailed ? 'COULD NOT FETCH' : (audit.hasCanonical ? 'Yes' : 'No')}
- Image alt text: ${auditFailed ? 'COULD NOT FETCH' : `${audit.altTextCoverage ?? 0}% coverage (${audit.imagesWithAlt ?? 0}/${audit.totalImages ?? 0})`}
- Sitemap: ${auditFailed ? 'COULD NOT FETCH' : (audit.hasSitemap ? `Yes (${audit.sitemapUrlCount} URLs)` : 'Missing')}
- Robots.txt: ${auditFailed ? 'COULD NOT FETCH' : (audit.hasRobots ? (audit.blocksGooglebot ? 'Present but BLOCKS Googlebot' : 'Present') : 'Missing')}
- Open Graph: ${auditFailed ? 'COULD NOT FETCH' : ([audit.hasOgTitle && 'title', audit.hasOgDescription && 'desc', audit.hasOgImage && 'image'].filter(Boolean).join(', ') || 'None')}
- Word count: ${auditFailed ? 'COULD NOT FETCH' : (audit.wordCount ?? 'N/A')}

DOMAIN AUTHORITY: ${pr.pageRank ?? 'N/A'}/10 (${pr.label || 'Unknown'})${clientContext}

Generate a response in this exact JSON format. Do not include any text outside the JSON:
{
  "overallScore": <integer 0-100 based ONLY on pillars you can actually score>,
  "grade": "<A/B/C/D/F>",
  "headline": "<10 words max — plain English verdict>",
  "topOpportunity": "<most impactful fix with estimated patient impact, 1-2 sentences>",
  "pillarScores": {
    "pageSpeed": <0-100>,
    "onPageSeo": <0-100 or null if data was unavailable>,
    "localGbp": <0-100>,
    "backlinks": <0-100>,
    "technical": <0-100 or null if data was unavailable>
  },
  "findings": [
    {"severity": "critical|warning|good", "category": "<category>", "detail": "<specific finding referencing real data>"},
    {"severity": "critical|warning|good", "category": "<category>", "detail": "<specific finding referencing real data>"},
    {"severity": "critical|warning|good", "category": "<category>", "detail": "<specific finding referencing real data>"},
    {"severity": "critical|warning|good", "category": "<category>", "detail": "<specific finding referencing real data>"},
    {"severity": "critical|warning|good", "category": "<category>", "detail": "<specific finding referencing real data>"}
  ]
}

Scoring rules:
- Base everything strictly on the real data provided. Do not invent numbers.
- If on-page data says "COULD NOT FETCH", set that pillar to null — do NOT guess a score.
- For the overallScore, calculate using only the pillars that have real data (reweight proportionally).
- Include a finding that honestly states our crawler was blocked if applicable.
- Page Speed 25%, On-Page SEO 20%, Google Business Profile 25%, Domain Authority 15%, Technical 15%.`;

        // Try OpenAI first, then Gemini. If the primary provider fails we still
        // attempt the other before giving up on an AI narrative entirely, since
        // the rule-based report is materially less useful.
        const providers = [];
        if (OPENAI_KEY) providers.push({ name: 'openai', call: callOpenAI });
        if (GEMINI_KEY) providers.push({ name: 'gemini', call: callGemini });

        let aiText = '';
        let usedProvider = null;
        const providerErrors = [];

        for (const p of providers) {
            try {
                aiText = await p.call(prompt);
                if (aiText) { usedProvider = p.name; break; }
                providerErrors.push(`${p.name}: empty response`);
            } catch (err) {
                console.error(`${p.name} error:`, err.message);
                providerErrors.push(err.message);
            }
        }

        if (!usedProvider) {
            return res.json(ruleBased(providerErrors.join(' | ') || 'All AI providers failed'));
        }

        const jsonMatch = aiText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const aiReport = JSON.parse(jsonMatch[0]);

            // Derive the grade from the score rather than trusting the model's own.
            // Observed: it returned overallScore 86 with grade "B", while our scale
            // puts 86 at "A" — an internal contradiction a prospect would notice.
            // The numeric score is the source of truth.
            if (typeof aiReport.overallScore === 'number' && Number.isFinite(aiReport.overallScore)) {
                const derived = gradeForScore(aiReport.overallScore);
                if (aiReport.grade !== derived) {
                    console.warn(`Overriding model grade "${aiReport.grade}" with "${derived}" for score ${aiReport.overallScore}`);
                }
                aiReport.grade = derived;
            }

            aiReport.source = 'ai';
            // Which provider actually answered — so a swap can be confirmed from
            // the response rather than inferred.
            aiReport.aiProvider = usedProvider;
            // Report whether the client's own words were actually in the prompt,
            // so "did this use their input?" is answerable from the response.
            aiReport.usedClientInput = clientContext.length > 0;
            return res.json(aiReport);
        }

        // Fallback to rule-based if AI response can't be parsed
        return res.json(ruleBased(`${usedProvider} response contained no parseable JSON`));

    } catch (err) {
        console.error('SEO report error:', err);
        return res.json(ruleBased(err.message || 'Gemini request failed'));
    }
}

/**
 * The single grading scale, shared by the AI and rule-based paths so a given
 * score always maps to the same letter regardless of which produced it.
 */
function gradeForScore(score) {
    if (typeof score !== 'number' || !Number.isFinite(score)) return null;
    if (score >= 85) return 'A';
    if (score >= 70) return 'B';
    if (score >= 55) return 'C';
    if (score >= 40) return 'D';
    return 'F';
}

/**
 * Rule-based fallback when the AI model is unavailable.
 *
 * @param userCorrections  What the client told us. Previously not passed at all,
 *                         which meant every fallback report was generic — the
 *                         client's stated goal, pain and service corrections
 *                         were silently discarded.
 * @param fallbackReason   Why we're here, surfaced so a degraded report is
 *                         visibly degraded instead of looking authoritative.
 */
function generateRuleBasedReport(url, data, userCorrections, fallbackReason) {
    const mobile = data.lighthouse?.mobile || {};
    const audit = data.siteAudit || {};
    const pr = data.pageRank || {};
    const biz = data.places?.business || {};
    const c = userCorrections || {};

    // Three distinct states, previously conflated into two:
    //   auditBlocked — crawler got an explicit error/403
    //   auditMissing — the audit call returned nothing usable at all
    // Both mean "we don't know", and must not be scored as "everything absent".
    const auditBlocked = !!(audit.error && !audit.titleTag);
    const auditMissing = !audit.titleTag && !audit.error && Object.keys(audit).length < 5;
    const noOnPageData = auditBlocked || auditMissing;

    // Page Speed (25%). Use ?? not || — a legitimate score of 0 is real data and
    // was being silently rewritten to 50.
    const pageSpeed = mobile.performance ?? null;

    // On-Page SEO (20%) — requires HTML crawl data
    let onPage = null;
    if (!noOnPageData) {
        onPage = 0;
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

    // Local / GBP (25%) — from Places API, always available
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

    // Backlinks / DA (15%).
    // Was: pr.pageRank !== null ? pr.pageRank * 14 : 30 — which passed for an
    // ABSENT key (undefined !== null), computing undefined * 14 = NaN. That NaN
    // propagated into overallScore and collapsed every grade to F.
    const prScore = typeof pr.pageRank === 'number' && Number.isFinite(pr.pageRank)
        ? pr.pageRank
        : null;
    const backlinks = prScore === null ? null : Math.min(Math.round(prScore * 14), 100);

    // Technical (15%) — requires HTML crawl data
    let technical = null;
    if (!noOnPageData) {
        technical = 0;
        if (audit.ssl) technical += 25;
        if (audit.hasSitemap) technical += 20;
        if (audit.hasRobots && !audit.blocksGooglebot) technical += 15;
        if (audit.hasLocalBusinessSchema) technical += 20;
        else if (audit.hasSchemaMarkup) technical += 10;
        if (audit.hasViewport) technical += 10;
        if (audit.hasOgTitle && audit.hasOgImage) technical += 10;
    }

    // Reweight over whichever pillars actually have data, rather than the two
    // hardcoded cases this used to have. Any null pillar (missing PageRank,
    // blocked crawler, absent Lighthouse) drops out and the remaining weights
    // are normalised — so one missing input no longer drags the score down or
    // produces NaN.
    const pillars = [
        { value: pageSpeed, weight: 0.25 },
        { value: onPage,    weight: 0.20 },
        { value: local,     weight: 0.25 },
        { value: backlinks, weight: 0.15 },
        { value: technical, weight: 0.15 },
    ].filter(p => typeof p.value === 'number' && Number.isFinite(p.value));

    const totalWeight = pillars.reduce((s, p) => s + p.weight, 0);
    const overallScore = totalWeight > 0
        ? Math.round(pillars.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight)
        : null;

    const grade = gradeForScore(overallScore);

    // ── Client-stated services ──────────────────────────────────────────────
    // If the client told us they offer something, never call it "missing" — the
    // issue is visibility, not absence. Rule 4 of the AI prompt says exactly
    // this; the fallback previously ignored it because it never saw the input.
    const statedServices = String(c.serviceCorrections || '')
        .split(/[,;\n]|\band\b/)
        .map(s => s.trim())
        .filter(s => s.length > 2)
        .slice(0, 6);

    const homepageText = [audit.titleTag, audit.metaDescription, audit.h1, (audit.h2Texts || []).join(' ')]
        .filter(Boolean).join(' ').toLowerCase();
    const statedButInvisible = statedServices.filter(s => !homepageText.includes(s.toLowerCase()));

    // Generate findings
    const findings = [];
    if (auditBlocked) {
        findings.push({ severity: 'warning', category: 'Crawler', detail: `Our crawler was blocked by this site's firewall (HTTP ${audit.status || 403}). On-Page SEO and Technical scores could not be determined. Page Speed, Local/GBP, and Backlink data are still accurate.` });
    } else if (auditMissing) {
        findings.push({ severity: 'warning', category: 'Crawler', detail: 'We could not retrieve this site\'s HTML, so On-Page SEO and Technical scores are unavailable rather than zero. The remaining scores reflect only what we verified externally.' });
    } else {
        if (!audit.metaDescription) findings.push({ severity: 'critical', category: 'On-Page SEO', detail: 'No meta description found — this is what shows in Google search results. Adding one can significantly improve click-through rates.' });
        if (audit.titleLength < 30 || audit.titleLength > 70) findings.push({ severity: 'warning', category: 'On-Page SEO', detail: `Title tag is ${audit.titleLength} characters (ideal: 50-60). ${audit.titleLength < 30 ? 'Too short — add location and key services.' : 'Too long — Google will truncate it.'}` });
        if (!audit.hasLocalBusinessSchema) findings.push({ severity: 'critical', category: 'Technical', detail: 'No LocalBusiness schema markup — Google can\'t properly understand your practice type, location, and services.' });
        if (!audit.hasSitemap) findings.push({ severity: 'warning', category: 'Technical', detail: 'No sitemap.xml found — search engines may not discover all your pages.' });
        if (typeof audit.altTextCoverage === 'number' && audit.altTextCoverage < 50 && audit.totalImages > 0) {
            findings.push({ severity: 'warning', category: 'Accessibility', detail: `Only ${audit.altTextCoverage}% of images have alt text — hurts both SEO and accessibility compliance.` });
        }
        if (audit.ssl) findings.push({ severity: 'good', category: 'Security', detail: 'SSL certificate is active — your site is secure and Google gives a ranking boost for HTTPS.' });

        // The client told us they offer these, but they appear nowhere in the
        // homepage's title, meta, H1 or H2s. Framed as visibility, not absence.
        if (statedButInvisible.length) {
            findings.push({
                severity: 'critical',
                category: 'Content',
                detail: `You told us you offer ${statedButInvisible.join(', ')} — but ${statedButInvisible.length > 1 ? 'these aren\'t' : 'this isn\'t'} mentioned anywhere in your homepage's title, description or headings. Patients searching for ${statedButInvisible[0]} in your area have no way to know you provide it.`,
            });
        }
    }
    if (biz.reviewCount && biz.reviewCount < 50) findings.push({ severity: 'warning', category: 'Local SEO', detail: `Only ${biz.reviewCount} Google reviews — practices with 50+ reviews see significantly better local rankings.` });
    if (biz.rating && biz.rating < 4.5) findings.push({ severity: 'warning', category: 'Local SEO', detail: `Google rating is ${biz.rating}★ — aim for 4.5+ to maximize patient trust and click-through.` });
    // pageSpeed can legitimately be null now. Guard the type: `null < 50` is true
    // in JS, which would have emitted "score is null/100".
    const haveSpeed = typeof pageSpeed === 'number';
    if (haveSpeed && pageSpeed < 50) findings.push({ severity: 'critical', category: 'Page Speed', detail: `Mobile performance score is ${pageSpeed}/100 — slow sites lose up to 53% of visitors. This is costing you patients.` });
    if (biz.rating >= 4.5) findings.push({ severity: 'good', category: 'Local SEO', detail: `Strong ${biz.rating}★ rating with ${biz.reviewCount} reviews — excellent social proof for new patients.` });

    // ── Top opportunity ─────────────────────────────────────────────────────
    // Ordered so the client's own words win when we have them. Rule 3 of the AI
    // prompt says to aim this at their stated goal and pain; the fallback now
    // does the same instead of always leading with generic schema advice.
    let topOpportunity;

    if (statedButInvisible.length) {
        topOpportunity = `You mentioned offering ${statedButInvisible[0]}, but it doesn't appear in your homepage title, meta description or headings. Giving it a dedicated, properly titled page is the single clearest step — you already provide the service, so this is a visibility fix rather than new work.`;
    } else if (c.biggestPain && haveSpeed && pageSpeed < 50) {
        topOpportunity = `You told us your biggest frustration is "${c.biggestPain}". Your mobile speed score of ${pageSpeed}/100 is very likely part of that — slow sites lose up to 53% of visitors before the page finishes loading, so fixing images and render-blocking scripts addresses the symptom you're already feeling.`;
    } else if (c.growthGoal && biz.reviewCount && biz.reviewCount < 50) {
        topOpportunity = `Your stated goal is "${c.growthGoal}". With ${biz.reviewCount} Google reviews, review volume is the nearest constraint on that — practices passing 50 reviews see materially better local ranking, and an automated post-appointment request is the usual way there.`;
    } else if (c.growthGoal && noOnPageData) {
        topOpportunity = `Your stated goal is "${c.growthGoal}". We couldn't complete the on-page audit for this site, so the fastest next step is a manual review of the pages that serve that goal — the external signals we could verify (speed, Google Business Profile, domain authority) are reflected above.`;
    } else if (noOnPageData) {
        if (haveSpeed && pageSpeed < 50) topOpportunity = `Your mobile site speed score is ${pageSpeed}/100. Optimizing images and reducing render-blocking resources could cut load time in half.`;
        else if (biz.reviewCount && biz.reviewCount < 50) topOpportunity = `You have ${biz.reviewCount} reviews — getting to 50+ can meaningfully improve your local ranking.`;
        else topOpportunity = auditBlocked
            ? 'We couldn\'t perform a full on-page audit because the site\'s firewall blocked our crawler. The scores shown are based only on what we could verify externally (speed, GBP, domain authority).'
            : 'We couldn\'t retrieve the site\'s HTML for an on-page audit. The scores shown are based only on what we could verify externally (speed, GBP, domain authority).';
    } else if (!audit.hasLocalBusinessSchema) topOpportunity = 'Add LocalBusiness schema markup to your homepage. This helps Google understand your practice and can improve your visibility in local search results — potentially driving 15-25% more local discovery.';
    else if (haveSpeed && pageSpeed < 50) topOpportunity = `Your mobile site speed score is ${pageSpeed}/100. Optimizing images and reducing render-blocking resources could cut load time in half — studies show this can recover up to 20% of bounced visitors.`;
    else if (!audit.metaDescription) topOpportunity = 'Add a compelling meta description with your city name, key services, and a call to action. This is the first thing patients see in Google results.';
    else if (biz.reviewCount < 50) topOpportunity = `You have ${biz.reviewCount} reviews — getting to 50+ can meaningfully improve your local ranking. Consider an automated review request system after appointments.`;
    else if (c.growthGoal) topOpportunity = `Your SEO foundation is solid, so the leverage is now in content aimed at your stated goal — "${c.growthGoal}". A dedicated page per service you want to grow gives each one its own chance to rank.`;
    else topOpportunity = 'Your SEO foundation is solid. Focus on creating service-specific content pages for each treatment you offer — each page is a new opportunity to rank for patient searches.';

    let headline;
    if (auditBlocked) headline = 'Partial scan — site firewall blocked our crawler';
    else if (auditMissing) headline = 'Partial scan — on-page data unavailable';
    else if (overallScore === null) headline = 'Not enough data to score this site';
    else if (overallScore >= 70) headline = 'Solid foundation with room to grow';
    else if (overallScore >= 50) headline = 'Needs attention in key areas';
    else headline = 'Significant gaps hurting your visibility';

    return {
        source: 'rules',
        // Why we fell back to rules instead of the AI narrative. Surfaced so a
        // degraded report is visibly degraded — this is the difference between
        // client-tailored findings and generic ones.
        fallbackReason: fallbackReason || null,
        // Did the client's own input actually reach this report?
        usedClientInput: !!(c.growthGoal || c.biggestPain || c.serviceCorrections || c.practiceCorrections || c.freetext),
        overallScore,
        grade,
        headline,
        topOpportunity,
        crawlerBlocked: auditBlocked || false,
        onPageDataUnavailable: noOnPageData,
        pillarScores: {
            pageSpeed,               // null when Lighthouse unavailable
            onPageSeo: onPage,       // null when on-page data unavailable
            localGbp: local,
            backlinks,               // null when PageRank unavailable
            technical,               // null when on-page data unavailable
        },
        findings: findings.slice(0, 5),
    };
}
