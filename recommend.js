/**
 * Core Package Recommendation Engine
 * ═══════════════════════════════════════════════════════════════════════════
 * Implements the Eyefinity Core Package Recommendation Bot spec (2026-07-30).
 *
 * SHAPE: a brand-agnostic signal normaliser plus a per-brand ordered ruleset.
 * deriveSignals() knows nothing about any brand's products; PACKAGE_RULESETS
 * holds one brand's tiers and thresholds. Adding EyeCarePro's own tiers later
 * means adding a ruleset, not editing the engine.
 *
 * Loaded as a plain script by index.html — no build step, consistent with the
 * rest of this codebase. Attaches window.PracticeRecommender.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THREE PLACES THE SPEC ASKS FOR DATA WE DO NOT HAVE
 * Documented here rather than silently approximated:
 *
 * 1. "Market classified as Major Metro" — there is no ZIP-density or
 *    population source anywhere in the pipeline. The spec offers a measurable
 *    alternative in the same clause ("OR competitor review density is extreme,
 *    top competitor review count > 250") and that is what is implemented. A
 *    true metro flag needs a new data source.
 *
 * 2. "Scleral Lenses" as a distinct detected service — it is not one. In the
 *    scraper dictionary, 'scleral lens' is a *pattern inside* contact_lens, so
 *    a scleral practice and a routine-contacts practice both surface as
 *    contact_lens. Treating contact_lens as a specialty trigger would sweep in
 *    every practice that fits soft lenses. Instead we text-scan the page
 *    signals we do hold for scleral/keratoconus/ortho-k and emit a distinctly
 *    named trigger. Adding a `scleral_lens` entry to the actor dictionary would
 *    make this reliable — recommended.
 *
 * 3. "1 to 4 blog posts per year" — the scraper gives a total post count and a
 *    last-post date, never a per-year rate. blogCadence() approximates from
 *    those two and the approximation is labeled in the output.
 *
 * TIER RULES - Lenny's "Eyefinity Evaluator Logic Update" (2026-10-18)
 * The first version let ANY one signal win a tier, and signals like "mentions
 * dry eye" or "fewer reviews than competitors" are near-universal, so almost
 * every practice landed on Deluxe or Ultimate. A tier now needs a declared goal
 * AND site evidence or capacity. Still first-match-wins, top down:
 *   Ultimate  3+ locations; or 2 locations + dense market (top competitor
 *             > 250 reviews) + a multi-location or growth goal
 *   Deluxe    specialty goal + specialty on the site; or optical goal + upscale
 *             (luxury/premium) optical; or expansion free text + 15+ capacity
 *   Pro       new-patient or visibility goal; or 15+ capacity; or a specialty /
 *             optical goal whose evidence the site does not show
 *   Advanced  retention goal with < 15 capacity; or "website feels outdated"
 *             with a goal other than new patients or specialty
 *   Base      everything else
 * Capacity is the form's 4-option question, read by POSITION across practice
 * types (exam slots / surgical utilization / optical walk-ins): 0 = "< 5",
 * 1 = "5 to 15", 2 = "15 to 25", 3 = "25+".
 * Real-time booking is NOT a tier signal: the scheduler is included for
 * Eyefinity EPM / OfficeMate customers (Lenny, hard rule).
 * ═══════════════════════════════════════════════════════════════════════════
 */
(function (global) {
    'use strict';

    /** Services that count as a clinical specialty for the Deluxe path. */
    const SPECIALTY_SERVICE_IDS = [
        'dry_eye', 'optilight', 'lipiflow', 'tearlab', 'iLux', 'zest', 'blephex',
        'myopia_management', 'vision_therapy',
    ];

    /** Human labels for trigger codes, used in the rationale lines. */
    const SPECIALTY_LABELS = {
        dry_eye: 'dry eye therapy',
        optilight: 'OptiLight / IPL',
        lipiflow: 'LipiFlow',
        tearlab: 'TearLab',
        iLux: 'iLux',
        zest: 'ZEST',
        blephex: 'BlephEx',
        myopia_management: 'myopia management',
        vision_therapy: 'vision therapy',
    };

    // Upscale = luxury or premium frame brands. The scraper's third value is
    // 'boutique/independent', which describes most private practices, so it is
    // deliberately not upscale.
    const HIGH_END_OPTICAL_POSITIONING = ['luxury', 'premium'];

    /** Ophthalmology services that evidence a premium IOL / refractive goal. */
    const REFRACTIVE_SERVICE_IDS = ['lasik', 'prk', 'smile', 'icl', 'premium_iol', 'laser_cataract'];

    /** Goals that count as growth for Ultimate rule B and Pro rule A. */
    const GROWTH_GOALS = ['new_patients', 'visibility'];

    /** Top-competitor review count above which a market reads as high-density. */
    const METRO_REVIEW_THRESHOLD = 250;

    // ─────────────────────────────────────────────────────────────────────
    //  Declared capacity parsing
    // ─────────────────────────────────────────────────────────────────────
    /**
     * The capacity questions are free text, and the spec keys on capacity being
     * "explicitly declared open". Treating any non-empty answer as "open" would
     * be wrong in the most consequential direction: "none", "we're full" and
     * "0 slots" are all non-empty answers meaning the opposite, and capacity is
     * a Deluxe trigger — so a bad parse promotes a practice two tiers.
     *
     * @returns {'open'|'full'|'unknown'}
     */
    function parseDeclaredCapacity(text) {
        const raw = String(text == null ? '' : text).trim();
        if (!raw) return 'unknown';
        const s = raw.toLowerCase();

        // Explicit negation wins over everything, including any numbers present
        // ("no room, 3 chairs" is still no room).
        const NEGATIVE = /\b(none|no capacity|no room|no space|no availability|not really|nothing|nil|full|fully booked|at capacity|maxed|max(ed)? out|booked out|no openings|no slots|n\/?a|not applicable|zero)\b/;
        if (NEGATIVE.test(s)) return 'full';

        // A bare "no" / "no." answer.
        if (/^(no|none|n\/a|na|-|0)[.!]?$/.test(s)) return 'full';

        // Any number greater than zero reads as declared capacity. Percentages
        // and ranges included: "20%", "10-15 slots", "2 days".
        const numbers = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
        if (numbers.length > 0) {
            if (numbers.some(n => n > 0)) return 'open';
            return 'full';  // every number was 0
        }

        const POSITIVE = /\b(open|openings|available|availability|room|space|slots|idle|unused|spare|extra|capacity|could take|can take|can fit|could fit|more patients|more volume|plenty|lots|some|yes|definitely|under.?utili[sz]ed|half|most days)\b/;
        if (POSITIVE.test(s)) return 'open';

        return 'unknown';
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Helpers
    // ─────────────────────────────────────────────────────────────────────
    function monthsSince(dateish) {
        if (!dateish) return null;
        const t = Date.parse(dateish);
        if (Number.isNaN(t)) return null;
        const months = (Date.now() - t) / (1000 * 60 * 60 * 24 * 30.44);
        return months < 0 ? 0 : Math.round(months * 10) / 10;
    }

    function matchesAny(text, patterns) {
        const s = String(text == null ? '' : text).toLowerCase();
        return patterns.some(p => s.includes(p));
    }

    function average(nums) {
        const valid = nums.filter(n => typeof n === 'number' && Number.isFinite(n));
        if (!valid.length) return null;
        return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
    }

    /**
     * Blog cadence from a total post count and a last-post date, because a
     * per-year rate is not collected. See note 3 at the top.
     * @returns {'none'|'stale'|'sporadic'|'active'}
     */
    function blogCadence(content) {
        const c = content || {};
        if (!c.blogExists) return 'none';
        const months = monthsSince(c.lastBlogPostDate);
        if (months !== null && months > 12) return 'stale';
        const total = Number(c.estimatedBlogPosts) || 0;
        // <= 8 discovered posts with recent activity approximates the spec's
        // "1 to 4 posts per year" band. Deliberately generous, since the scraper
        // only counts post links it can find on the blog index.
        if (total <= 8) return 'sporadic';
        return 'active';
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Signal derivation — brand-agnostic
    // ─────────────────────────────────────────────────────────────────────
    /**
     * Flatten every input source into one signals object. Nothing here knows
     * about packages or brands.
     */
    /**
     * The single goal the prospect picked, as a category. Covers every practice
     * type's option list in index.html (GOAL_OPTIONS); order matters where two
     * patterns could both match.
     */
    function classifyGoal(goal) {
        const g = String(goal || '').toLowerCase();
        if (!g) return null;
        if (g.includes('multi-location') || g.includes('multi location')) return 'multi_location';
        if (g.includes('specialty services') || g.includes('premium iol') || g.includes('refractive')) return 'specialty';
        if (g.includes('optical sales') || g.includes('frame sales') || g.includes('e-commerce eyewear') || g.includes('revenue per patient')) return 'optical';
        if (g.includes('new patient volume') || g.includes('surgical case volume') || g.includes('referral network') || g.includes('foot traffic')) return 'new_patients';
        if (g.includes('visibility') || g.includes('search ranking') || g.includes('brand awareness') || g.includes('social media')) return 'visibility';
        if (g.includes('retention') || g.includes('recall') || g.includes('loyalty') || g.includes('reputation') || g.includes('patient experience')) return 'retention';
        return null;
    }

    /** One capacity answer as its position, 0 (least spare) to 3 (most); null if unanswered. */
    function capacityPosition(text) {
        const t = String(text || '').trim().toLowerCase();
        if (!t) return null;
        if (/^(less than 5|operating at 90%\+|0-2)/.test(t)) return 0;
        if (/^(5 to 15|70% - 90%|3-5)/.test(t)) return 1;
        if (/^(15 to 25|50% - 70%|6-10)/.test(t)) return 2;
        if (/^(25\+|below 50%|10\+)/.test(t)) return 3;
        return null;
    }

    /**
     * The capacity question the form asked this practice type. Multi-specialty
     * and unknown types may have answered more than one; the most spare wins.
     */
    function capacityBucket(answers, practiceType) {
        const byType = { optometry: 'capacityOptometry', ophthalmology: 'capacitySurgical', optical: 'capacityOptical' };
        const keys = byType[practiceType] ? [byType[practiceType]] : Object.values(byType);
        const found = keys.map(k => capacityPosition(answers[k])).filter(b => b !== null);
        return found.length ? Math.max.apply(null, found) : null;
    }

    function deriveSignals(input) {
        const d = (input && input.dossier) || {};
        const answers = (input && input.userAnswers) || {};
        const places = (input && input.places) || {};
        const audit = (input && input.siteAudit) || {};

        const detectedIds = ((d.services && d.services.detected) || [])
            .map(s => (s && s.id) || '')
            .filter(Boolean);

        const specialtiesDetected = SPECIALTY_SERVICE_IDS.filter(id => detectedIds.includes(id));

        // Scleral / keratoconus / ortho-k are not separately detected services
        // (note 2). Scan the text signals we do hold, including what the client
        // told us, which is the more trustworthy half.
        const textPool = [
            audit.titleTag, audit.metaDescription, audit.h1,
            (audit.h2Texts || []).join(' '),
            (audit.topKeywords || []).join(' '),
            (audit.topPhrases || []).join(' '),
            answers.freetext, answers.step2Corrections,
        ].filter(Boolean).join(' ');
        const scleralSignals = matchesAny(textPool, ['scleral', 'keratoconus', 'ortho-k', 'orthokeratology']);

        const biz = places.business || {};
        const competitors = places.competitors || [];
        const competitorReviews = competitors.map(c => Number(c && c.reviewCount) || 0);
        const topCompetitorReviews = competitorReviews.length ? Math.max.apply(null, competitorReviews) : null;
        const avgCompetitorReviews = average(competitorReviews);
        const gbpReviews = typeof biz.reviewCount === 'number' ? biz.reviewCount : null;

        const optical = d.optical || {};
        const scheduling = (d.digital && d.digital.scheduling) || {};

        const goal = String(answers.goal || '');
        const pain = String(answers.pain || '');

        return {
            // identity / scale
            practiceName: (d.practice && d.practice.name) || null,
            practiceType: (d.practice && d.practice.type) || null,
            locationCount: Number((d.locations && d.locations.count) || 0),
            doctorCount: Array.isArray(d.doctors) ? d.doctors.length : 0,

            // services
            detectedServiceIds: detectedIds,
            specialtiesDetected,
            scleralSignals,
            missingHighValue: (d.services && d.services.missingHighValue) || [],

            // optical
            hasOptical: !!optical.hasOptical,
            opticalPositioning: optical.positioning || 'unknown',
            opticalIsHighEnd: HIGH_END_OPTICAL_POSITIONING.indexOf(optical.positioning) !== -1,
            frameBrandCount: Number(optical.totalBrands || 0),

            // declared capacity — highest-trust signals
            capacityOptometry: parseDeclaredCapacity(answers.capacityOptometry),
            capacitySurgical: parseDeclaredCapacity(answers.capacitySurgical),
            capacityOptical: parseDeclaredCapacity(answers.capacityOptical),

            // declared intent, matched on keywords rather than exact strings so
            // copy edits to GOAL_OPTIONS/PAIN_OPTIONS do not silently break this
            goalCategory: classifyGoal(goal),
            capacityBucket: capacityBucket(answers, (d.practice && d.practice.type) || null),
            refractiveDetected: REFRACTIVE_SERVICE_IDS.some(id => detectedIds.includes(id)),
            painIsOutdatedSite: matchesAny(pain, ['website feels outdated']),
            goalRaw: goal,
            painRaw: pain,
            freetext: String(answers.freetext || ''),
            goalIsMultiLocation: matchesAny(goal, ['multi-location', 'multi location']),
            goalIsPatientVolume: matchesAny(goal, ['new patient volume', 'patient volume', 'foot traffic', 'surgical case volume']),
            goalIsSpecialty: matchesAny(goal, ['specialty services', 'premium iol', 'refractive conversions']),
            goalIsOptical: matchesAny(goal, ['optical sales', 'frame sales', 'e-commerce eyewear', 'revenue per patient']),
            goalIsVisibility: matchesAny(goal, ['visibility', 'search ranking', 'brand awareness']),
            painIsVisibility: matchesAny(pain, ['find us', 'don\'t know', 'competitors with better online', 'no digital marketing', 'no real digital strategy', 'sits there', 'outdated']),
            freetextMentionsExpansion: matchesAny(String(answers.freetext || ''), ['launch', 'launching', 'new clinic', 'added', 'adding', 'expand', 'expanding', 'just opened', 'starting']),

            // market density (proxy — see note 1)
            gbpReviewCount: gbpReviews,
            competitorCount: competitors.length,
            topCompetitorReviews,
            avgCompetitorReviews,
            reviewsBelowCompetitorAverage:
                gbpReviews !== null && avgCompetitorReviews !== null && gbpReviews < avgCompetitorReviews,
            highDensityMarket:
                topCompetitorReviews !== null && topCompetitorReviews > METRO_REVIEW_THRESHOLD,

            // digital maturity
            hasOnlineScheduling: !!scheduling.hasOnlineScheduling,
            isRealTimeBooking: !!scheduling.isRealTime,
            blogCadence: blogCadence(d.content),
            estimatedBlogPosts: Number((d.content && d.content.estimatedBlogPosts) || 0),
            monthsSinceLastPost: monthsSince(d.content && d.content.lastBlogPostDate),
            hasSchema: !!(audit.hasSchemaMarkup || (d.technical && d.technical.hasSchemaMarkup)),
            hasLocalBusinessSchema: !!audit.hasLocalBusinessSchema,
            schemaTypes: audit.schemaTypes || (d.technical && d.technical.schemaTypes) || [],
            hasViewport: audit.hasViewport !== undefined
                ? !!audit.hasViewport
                : !!(d.technical && d.technical.mobileViewport),
            hasSsl: audit.ssl !== undefined ? !!audit.ssl : !!(d.technical && d.technical.ssl),
            cms: (d.digital && d.digital.cms && d.digital.cms.name) || null,
            marketingVendor: (d.digital && d.digital.marketingVendor && d.digital.marketingVendor.name) || null,
            isCompetitorClient: !!(d.digital && d.digital.isCompetitorClient),
            isEyeCarePro: !!(d.digital && d.digital.isEyeCarePro),
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Per-brand rulesets
    // ─────────────────────────────────────────────────────────────────────
    /**
     * Ordered, first match wins. Each rule returns the triggers it fired, most
     * significant first — triggers[0] becomes primary_trigger_code.
     */
    /**
     * Prospect-facing copy per package, from section 2/4 of the spec.
     *
     * Lives beside the ruleset rather than in index.html markup so a brand's
     * products and the words describing them stay in one place. Deliberately no
     * prices: the spec assigns none to the Eyefinity packages, and inventing them
     * in front of a prospect would be worse than omitting them.
     */
    const PACKAGE_COPY = {
        eyefinity: {
            Base: {
                label: 'Eyefinity Base',
                purpose: 'Establishing digital credibility',
                capabilities: [
                    'Fully managed web presence',
                    'Initial SEO setup',
                    'Basic online scheduling link',
                    'Site administration and updates',
                    'Analytics and reporting dashboard',
                    'Eyefinity EPM / OfficeMate compatibility',
                ],
            },
            Advanced: {
                label: 'Eyefinity Advanced',
                purpose: 'Foundational local visibility, maintained',
                capabilities: [
                    'Everything in Base',
                    'Strategic SEO maintenance (4 blog posts a year)',
                    'Review and reputation management',
                    'Social media publishing',
                    'Call and lead analytics',
                    'Semi-annual strategy consults',
                ],
            },
            Pro: {
                label: 'Eyefinity Pro',
                purpose: 'Filling the exam schedule with new patients',
                capabilities: [
                    'Everything in Advanced',
                    'Conversion-focused website design',
                    'Ongoing general eyecare SEO',
                    '6 SEO-optimized blog posts a year',
                    'Two-way texting',
                    'Google Reserve integration',
                    'Bi-monthly strategy consults',
                ],
            },
            Deluxe: {
                label: 'Eyefinity Deluxe',
                purpose: 'Growing high-margin specialty and optical revenue',
                capabilities: [
                    'Everything in Pro',
                    'Specialty or optical-focused SEO architecture',
                    '12 SEO-optimized posts or specialty landing pages a year',
                    'Custom practice photoshoot (one-time)',
                    'Video editing and optimization',
                    'Monthly strategy consults',
                ],
            },
            Ultimate: {
                label: 'Eyefinity Ultimate',
                purpose: 'Multi-location governance and competitive metro growth',
                capabilities: [
                    'Everything in Deluxe',
                    'High-velocity local SEO strategy',
                    '24 SEO-optimized posts or pages a year',
                    'Multi-location site architecture (up to 5 locations)',
                    'Competitive market positioning',
                    'Monthly strategy consults',
                ],
            },
        },
    };

    const GOAL_LABELS = {
        multi_location: 'multi-location growth',
        new_patients: 'new patient volume',
        visibility: 'online visibility and local search',
        specialty: 'specialty service revenue',
        optical: 'optical and frame revenue',
        retention: 'patient retention',
    };
    const CAPACITY_LABELS = ['fewer than 5', '5 to 15', '15 to 25', '25+'];

    function declaredGoal(s) {
        return ['DECLARED_GOAL_' + String(s.goalCategory).toUpperCase(), `You told us your goal is ${GOAL_LABELS[s.goalCategory]}`];
    }
    function declaredCapacity(s) {
        return ['DECLARED_CAPACITY_' + s.capacityBucket, `You have ${CAPACITY_LABELS[s.capacityBucket]} open slots a week`];
    }
    function specialtyEvidence(s) {
        const names = s.specialtiesDetected.map(id => SPECIALTY_LABELS[id] || id);
        if (s.scleralSignals) names.push('scleral / keratoconus / ortho-k');
        if (s.refractiveDetected) names.push('refractive or premium IOL surgery');
        return names;
    }

    const PACKAGE_RULESETS = {
        eyefinity: [
            {
                package: 'Ultimate',
                evaluate(s) {
                    if (s.locationCount >= 3) {
                        return [['MULTI_LOCATION_3_PLUS', `${s.locationCount} locations found on your site`]];
                    }
                    if (s.locationCount === 2 && s.highDensityMarket
                        && (s.goalCategory === 'multi_location' || GROWTH_GOALS.includes(s.goalCategory))) {
                        return [
                            declaredGoal(s),
                            ['TWO_LOCATIONS_DENSE_MARKET', `2 locations in a competitive market (the top nearby competitor has ${s.topCompetitorReviews} reviews)`],
                        ];
                    }
                    return [];
                },
            },
            {
                package: 'Deluxe',
                evaluate(s) {
                    const evidence = specialtyEvidence(s);
                    if (s.goalCategory === 'specialty' && evidence.length) {
                        return [declaredGoal(s), ['SPECIALTY_EVIDENCE_ON_SITE', `Your site markets ${evidence.join(', ')}`]];
                    }
                    if (s.goalCategory === 'optical' && s.opticalIsHighEnd) {
                        return [
                            declaredGoal(s),
                            ['UPSCALE_OPTICAL_ON_SITE', `Your optical carries ${s.opticalPositioning} frame lines${s.frameBrandCount ? ` (${s.frameBrandCount} brands found)` : ''}`],
                        ];
                    }
                    if (s.freetextMentionsExpansion && s.capacityBucket !== null && s.capacityBucket >= 2) {
                        return [['DECLARED_EXPANSION', 'You told us you are launching or expanding a service line'], declaredCapacity(s)];
                    }
                    return [];
                },
            },
            {
                package: 'Pro',
                evaluate(s) {
                    const t = [];
                    if (GROWTH_GOALS.includes(s.goalCategory)) t.push(declaredGoal(s));
                    if (s.capacityBucket !== null && s.capacityBucket >= 2) t.push(declaredCapacity(s));
                    if (s.goalCategory === 'specialty' || s.goalCategory === 'optical') {
                        // The Deluxe goal without the Deluxe evidence: fill the schedule first.
                        t.push(declaredGoal(s));
                        t.push(['GOAL_WITHOUT_SITE_EVIDENCE', s.goalCategory === 'specialty'
                            ? "Your site doesn't market a specialty service yet"
                            : "Your site doesn't show an upscale optical yet"]);
                    }
                    return t;
                },
            },
            {
                package: 'Advanced',
                evaluate(s) {
                    if (s.goalCategory === 'retention' && (s.capacityBucket === null || s.capacityBucket < 2)) {
                        return [declaredGoal(s)];
                    }
                    if (s.painIsOutdatedSite && s.goalCategory !== 'new_patients' && s.goalCategory !== 'specialty') {
                        return [['DECLARED_PAIN_OUTDATED_SITE', 'You told us your website feels outdated']];
                    }
                    return [];
                },
            },
            {
                package: 'Base',
                // Terminal fallback: always matches, so a package is always returned.
                evaluate(s) {
                    const t = [];
                    if (s.blogCadence === 'none') t.push(['NO_ACTIVE_CONTENT_ENGINE', 'No blog or content engine detected']);
                    if (s.blogCadence === 'stale') t.push(['BLOG_STALE', `Last blog post was ~${s.monthsSinceLastPost} months ago`]);
                    if (!s.hasViewport) t.push(['LEGACY_NON_RESPONSIVE', 'No mobile viewport — site is not responsive']);
                    if (!t.length) t.push(['BASELINE_PRESENCE_ONLY', 'Establishing a credible online presence']);
                    return t;
                },
            },
        ],
    };

    // ─────────────────────────────────────────────────────────────────────
    //  Deficits — current-state problems, independent of the tier matched
    // ─────────────────────────────────────────────────────────────────────
    function deriveDeficits(s) {
        const out = [];
        if (!s.isRealTimeBooking) {
            out.push(s.hasOnlineScheduling
                ? 'Scheduling links out to a third party rather than booking in real time'
                : 'Booking relies on a static contact form rather than real-time integration');
        }
        if (s.reviewsBelowCompetitorAverage) {
            out.push(`Google Business Profile review count (${s.gbpReviewCount}) lags the local 8km competitor average (${s.avgCompetitorReviews})`);
        }
        if (!s.hasLocalBusinessSchema) out.push('No LocalBusiness schema markup detected');
        else if (!s.hasSchema) out.push('No structured data detected');
        if (s.blogCadence === 'none') out.push('No blog or content engine present');
        else if (s.blogCadence === 'stale') out.push(`Blog has not been updated in ~${s.monthsSinceLastPost} months`);
        else if (s.blogCadence === 'sporadic') out.push(`Blog is live but sparse (~${s.estimatedBlogPosts} posts found)`);
        if (!s.hasViewport) out.push('No mobile viewport — the site is not responsive');
        if (!s.hasSsl) out.push('No SSL certificate detected');
        if (s.missingHighValue && s.missingHighValue.length) {
            out.push(`High-value services not marketed: ${s.missingHighValue.slice(0, 4).join(', ')}`);
        }
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Confidence
    // ─────────────────────────────────────────────────────────────────────
    /**
     * Confidence reflects how well-evidenced the match is, not how good a fit
     * the package is. It rises with corroborating triggers and with the primary
     * trigger being client-declared rather than inferred, and falls when the
     * inputs the tier depends on are missing.
     */
    function computeConfidence(pkg, triggers, s) {
        const codes = triggers.map(t => t[0]);
        let c = 0.50;

        // The declared goal and what the site shows point the same way.
        const aligned = (pkg === 'Deluxe' && (codes.includes('SPECIALTY_EVIDENCE_ON_SITE') || codes.includes('UPSCALE_OPTICAL_ON_SITE')))
            || (pkg === 'Ultimate' && s.goalCategory === 'multi_location' && s.locationCount >= 2);
        if (aligned) c += 0.25;

        // Declared capacity fits the package: room to grow for the growth tiers,
        // little spare for the light ones.
        const b = s.capacityBucket;
        if (b !== null && ((b >= 2 && ['Pro', 'Deluxe', 'Ultimate'].includes(pkg)) || (b <= 1 && ['Advanced', 'Base'].includes(pkg)))) {
            c += 0.15;
        }

        // Missing inputs, or the answers and the site disagree.
        const missing = !s.goalCategory || b === null;
        const conflict = codes.includes('GOAL_WITHOUT_SITE_EVIDENCE') || (s.goalCategory === 'retention' && b !== null && b >= 2);
        if (missing || conflict) c -= 0.20;

        return Math.max(0.1, Math.min(0.95, Math.round(c * 100) / 100));
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Entry point
    // ─────────────────────────────────────────────────────────────────────
    /**
     * @param {object} input {brandId, dossier, userAnswers, places, siteAudit}
     * @returns {object|null} the spec payload, or null if the brand has no ruleset
     */
    function recommendPackage(input) {
        const brandId = (input && input.brandId) || 'eyefinity';
        const ruleset = PACKAGE_RULESETS[brandId];
        if (!ruleset) return null;   // brand keeps its own existing logic

        const s = deriveSignals(input);

        let matched = null;
        let triggers = [];
        for (const rule of ruleset) {
            const fired = rule.evaluate(s) || [];
            if (fired.length) { matched = rule.package; triggers = fired; break; }
        }
        if (!matched) {   // defensive: Base always fires, so this should be unreachable
            matched = 'Base';
            triggers = [['BASELINE_PRESENCE_ONLY', 'No growth, specialty or scale signals found']];
        }

        const copy = (PACKAGE_COPY[brandId] && PACKAGE_COPY[brandId][matched]) || null;

        return {
            // Prospect-facing copy for the matched package. Separate from
            // `recommendation` because that block is the spec's payload for sales
            // systems, while this exists only for rendering.
            display: copy ? {
                label: copy.label,
                purpose: copy.purpose,
                capabilities: copy.capabilities,
                // Rationale worth showing a prospect: their own declared answers
                // first, since those read as "you told us", then site findings.
                why: triggers
                    .slice()
                    .sort((a, b) => (b[0].indexOf('DECLARED_') === 0) - (a[0].indexOf('DECLARED_') === 0))
                    .map(t => t[1])
                    .slice(0, 4),
            } : null,
            practice_identity: {
                url: (input.userAnswers && input.userAnswers.url) || null,
                name: s.practiceName,
                type: s.practiceType,
                location_count: s.locationCount,
                doctor_count: s.doctorCount,
            },
            recommendation: {
                recommended_core_package: matched,
                primary_trigger_code: triggers[0] ? triggers[0][0] : null,
                secondary_trigger_code: triggers[1] ? triggers[1][0] : null,
                confidence_score: computeConfidence(matched, triggers, s),
            },
            rationale_summary: triggers.map(t => t[1]),
            gap_deficits_identified: deriveDeficits(s),
            // Not in the spec, but the whole trigger set is worth keeping — the
            // spec surfaces only two codes and the rest are useful for triage.
            all_trigger_codes: triggers.map(t => t[0]),
            _signals: s,
        };
    }

    global.PracticeRecommender = {
        recommendPackage,
        deriveSignals,
        parseDeclaredCapacity,
        blogCadence,
        PACKAGE_RULESETS,
        SPECIALTY_SERVICE_IDS,
        METRO_REVIEW_THRESHOLD,
        classifyGoal,
        capacityBucket,
    };
})(typeof window !== 'undefined' ? window : globalThis);
