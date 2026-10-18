/**
 * Tests for the Eyefinity tier rules in recommend.js (Lenny's "Eyefinity Evaluator
 * Logic Update", 2026-10-18). Run: node recommend.test.js
 *
 * Inputs use the exact option strings the form offers (GOAL_OPTIONS, PAIN_OPTIONS,
 * Q3_CAPACITY in index.html), so a renamed option breaks a test instead of silently
 * dropping a practice to Base.
 */
require('./recommend.js');
const { recommendPackage, capacityBucket, classifyGoal } = globalThis.PracticeRecommender;

let failed = 0;
function check(name, actual, expected) {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
}

const CAP = {
    lt5: 'Less than 5 (We are mostly full, looking for higher-value patients)',
    c5: '5 to 15 (We have consistent gaps we need to fill)',
    c15: '15 to 25 (We are under-utilized and losing revenue daily)',
    c25: '25+ (We have a critical need for new patient acquisition)',
};

/** A single-location optometry practice that markets dry eye: the old "Deluxe for everyone" case. */
function practice({ goal = '', pain = '', capacity = '', freetext = '', locations = 1, doctors = 1,
    services = ['dry_eye'], positioning = 'boutique/independent', topCompetitorReviews = 120,
    type = 'optometry', capacityKey = 'capacityOptometry', h2 = [] } = {}) {
    return {
        brandId: 'eyefinity',
        dossier: {
            practice: { name: 'Test Eye Care', type },
            locations: { count: locations },
            doctors: Array.from({ length: doctors }, (_, i) => ({ name: `Dr ${i}` })),
            services: { detected: services.map(id => ({ id })) },
            optical: { hasOptical: true, positioning, totalBrands: 12 },
            content: { blogExists: false },
            digital: { scheduling: { hasOnlineScheduling: false, isRealTime: false } },
        },
        userAnswers: { goal, pain, freetext, [capacityKey]: capacity },
        places: { business: { reviewCount: 80 }, competitors: [{ reviewCount: topCompetitorReviews }, { reviewCount: 40 }] },
        siteAudit: { h2Texts: h2, hasViewport: true, ssl: true },
    };
}
const tier = input => recommendPackage(input).recommendation.recommended_core_package;
const confidence = input => recommendPackage(input).recommendation.confidence_score;

// The screenshot case: ReVision Eye Care - 1 location, top competitor 794 reviews,
// new-patient goal, 20 empty slots. Was Ultimate on market density alone.
check('ReVision Eye Care (1 location, dense market, new patients, 15-25) -> Pro',
    tier(practice({ goal: 'New patient volume', capacity: CAP.c15, topCompetitorReviews: 794 })), 'Pro');

// Ultimate
check('3 locations -> Ultimate', tier(practice({ locations: 3, goal: 'Patient retention & recall', capacity: CAP.lt5 })), 'Ultimate');
check('2 locations + dense + new patients -> Ultimate',
    tier(practice({ locations: 2, topCompetitorReviews: 300, goal: 'New patient volume', capacity: CAP.c5 })), 'Ultimate');
check('2 locations + dense + ophthalmology multi-location goal -> Ultimate',
    tier(practice({ type: 'ophthalmology', capacityKey: 'capacitySurgical', locations: 2, topCompetitorReviews: 300, goal: 'Multi-location brand consistency', capacity: '70% - 90% (Need more consistent Cataract/LASIK leads to fill OR days)' })), 'Ultimate');
check('2 locations, NOT dense, new patients -> Pro (rural drops)',
    tier(practice({ locations: 2, topCompetitorReviews: 90, goal: 'New patient volume', capacity: CAP.c5 })), 'Pro');
check('2 locations + dense but retention goal -> not Ultimate',
    tier(practice({ locations: 2, topCompetitorReviews: 300, goal: 'Patient retention & recall', capacity: CAP.lt5 })), 'Advanced');

// Deluxe
check('specialty goal + dry eye on site -> Deluxe',
    tier(practice({ goal: 'Specialty services revenue (dry eye, myopia)', capacity: CAP.c5 })), 'Deluxe');
check('specialty goal + specialty on site + <5 slots (higher-value patients) -> Deluxe',
    tier(practice({ goal: 'Specialty services revenue (dry eye, myopia)', capacity: CAP.lt5 })), 'Deluxe');
check('specialty goal + scleral text only -> Deluxe',
    tier(practice({ goal: 'Specialty services revenue (dry eye, myopia)', capacity: CAP.c5, services: [], h2: ['Scleral lens fitting'] })), 'Deluxe');
check('specialty goal, NO specialty on site -> Pro',
    tier(practice({ goal: 'Specialty services revenue (dry eye, myopia)', capacity: CAP.c5, services: [] })), 'Pro');
check('optical goal + luxury optical -> Deluxe',
    tier(practice({ goal: 'Optical sales & frame revenue', capacity: CAP.c5, positioning: 'luxury' })), 'Deluxe');
check('optical goal + boutique/independent optical -> Pro (independent is not upscale)',
    tier(practice({ goal: 'Optical sales & frame revenue', capacity: CAP.c5 })), 'Pro');
check('expansion free text + 15-25 -> Deluxe',
    tier(practice({ goal: 'Patient retention & recall', capacity: CAP.c15, freetext: 'We are launching a myopia clinic' })), 'Deluxe');
check('expansion free text + 5-15 -> not Deluxe',
    tier(practice({ goal: 'Patient retention & recall', capacity: CAP.c5, freetext: 'We are launching a myopia clinic' })), 'Advanced');
check('ophthalmology premium IOL goal + LASIK on site -> Deluxe',
    tier(practice({ type: 'ophthalmology', capacityKey: 'capacitySurgical', goal: 'Premium IOL & refractive conversions', capacity: 'Operating at 90%+ (Looking to optimize for premium IOLs/Refractive)', services: ['lasik'] })), 'Deluxe');

// Pro
check('visibility goal -> Pro', tier(practice({ goal: 'Online visibility & local search ranking', capacity: CAP.lt5 })), 'Pro');
check('25+ capacity, retention goal -> Pro', tier(practice({ goal: 'Patient retention & recall', capacity: CAP.c25 })), 'Pro');
check('dry eye on site alone (no goal match) is NOT Deluxe',
    tier(practice({ goal: 'Patient retention & recall', capacity: CAP.c5 })), 'Advanced');
check('no real-time booking alone is NOT Pro',
    tier(practice({ goal: '', capacity: CAP.lt5 })), 'Base');

// Advanced
check('retention + <5 -> Advanced', tier(practice({ goal: 'Patient retention & recall', capacity: CAP.lt5 })), 'Advanced');
check('retention + 5-15 -> Advanced', tier(practice({ goal: 'Patient retention & recall', capacity: CAP.c5 })), 'Advanced');
check('outdated website + optical goal (no upscale) -> Pro, not Advanced (Pro is checked first)',
    tier(practice({ goal: 'Optical sales & frame revenue', pain: 'Our website feels outdated but we don\'t know where to start', capacity: CAP.lt5 })), 'Pro');
check('outdated website + no goal -> Advanced',
    tier(practice({ pain: 'Our website feels outdated but we don\'t know where to start', capacity: CAP.lt5 })), 'Advanced');

// Base
check('nothing declared -> Base', tier(practice({})), 'Base');

// Capacity by position across practice types
check('ophthalmology "Below 50%" -> bucket 3', capacityBucket({ capacitySurgical: 'Below 50% (Under-utilized MDs and high overhead pressure)' }, 'ophthalmology'), 3);
check('ophthalmology "50% - 70%" -> bucket 2', capacityBucket({ capacitySurgical: '50% - 70% (Significant gaps in the surgical schedule)' }, 'ophthalmology'), 2);
check('optical "6-10" -> bucket 2', capacityBucket({ capacityOptical: '6-10 (We have significant "dead time" in the dispensary)' }, 'optical'), 2);
check('multi-specialty takes the most spare answer', capacityBucket({ capacityOptometry: CAP.lt5, capacityOptical: '10+ (We are heavily under-performing relative to our floor space)' }, 'multi_specialty'), 3);
check('unanswered capacity -> null', capacityBucket({}, 'optometry'), null);

// Goal mapping for the other practice types
check('"Brand awareness & foot traffic" -> new_patients', classifyGoal('Brand awareness & foot traffic'), 'new_patients');
check('"Online reputation & patient reviews" -> retention', classifyGoal('Online reputation & patient reviews'), 'retention');
check('"Frame sales & average transaction value" -> optical', classifyGoal('Frame sales & average transaction value'), 'optical');

// Confidence
check('confidence: specialty goal + evidence + 15-25 = 0.50+0.25+0.15',
    confidence(practice({ goal: 'Specialty services revenue (dry eye, myopia)', capacity: CAP.c15 })), 0.9);
check('confidence: specialty goal without evidence -> Pro with conflict = 0.50+0.15-0.20',
    confidence(practice({ goal: 'Specialty services revenue (dry eye, myopia)', capacity: CAP.c15, services: [] })), 0.45);
check('confidence: no capacity answer -> -0.20',
    confidence(practice({ goal: 'New patient volume' })), 0.3);

// Rationale shown to the prospect never mentions booking (the scheduler is included)
const why = recommendPackage(practice({ goal: 'New patient volume', capacity: CAP.c15 })).display.why.join(' ');
check('rationale does not mention booking or scheduling', /book|schedul/i.test(why), false);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
