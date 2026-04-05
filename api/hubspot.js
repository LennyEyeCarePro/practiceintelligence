/**
 * Vercel Serverless Function — HubSpot CRM Integration
 * Receives assessment data and syncs to HubSpot:
 *   1. Ensures custom properties exist on Company & Contact objects
 *   2. Finds or creates Company by domain
 *   3. Finds or creates Contact by email, associates with Company
 *   4. Creates a Deal tied to both
 *
 * POST /api/hubspot
 */

const HUBSPOT_TOKEN = process.env.HUBSPOT_API_TOKEN;
const BASE = 'https://api.hubapi.com';

// ── Custom property definitions (created if missing) ──────────────────
const COMPANY_PROPERTIES = [
    { name: 'assessment_date', label: 'Assessment Date', type: 'datetime', fieldType: 'date', groupName: 'companyinformation' },
    { name: 'assessment_practice_type', label: 'Practice Type', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_practice_subtype', label: 'Practice Sub-Type', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_doctor_count', label: 'Doctor Count', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_md_count', label: 'MD Count', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_od_count', label: 'OD Count', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_doctor_names', label: 'Doctor Names', type: 'string', fieldType: 'textarea', groupName: 'companyinformation' },
    { name: 'assessment_location_count', label: 'Location Count', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_services_detected', label: 'Services Detected', type: 'string', fieldType: 'textarea', groupName: 'companyinformation' },
    { name: 'assessment_services_count', label: 'Services Count', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_missing_services', label: 'Missing High-Value Services', type: 'string', fieldType: 'textarea', groupName: 'companyinformation' },
    { name: 'assessment_cms', label: 'CMS Platform', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_marketing_vendor', label: 'Marketing Vendor', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_is_competitor_client', label: 'Is Competitor Client', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_is_eyecarepro', label: 'Is EyeCarePro Client', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_has_scheduling', label: 'Has Online Scheduling', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_scheduling_platform', label: 'Scheduling Platform', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_analytics_tools', label: 'Analytics Tools', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_social_platforms', label: 'Social Platforms', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_social_count', label: 'Social Platform Count', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_blog_exists', label: 'Has Blog', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_lighthouse_performance', label: 'Lighthouse Performance', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_lighthouse_seo', label: 'Lighthouse SEO Score', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_score_digital', label: 'Score: Digital Presence', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_score_content', label: 'Score: Content Quality', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_score_patient_exp', label: 'Score: Patient Experience', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_score_marketing', label: 'Score: Marketing Maturity', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_score_overall', label: 'Score: Overall', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_gap_count', label: 'Gap Count', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_top_gaps', label: 'Top Gaps', type: 'string', fieldType: 'textarea', groupName: 'companyinformation' },
    { name: 'assessment_has_optical', label: 'Has Optical', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_frame_brand_count', label: 'Frame Brand Count', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_brand_positioning', label: 'Brand Positioning', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_insurance_plans', label: 'Insurance Plans', type: 'string', fieldType: 'textarea', groupName: 'companyinformation' },
    { name: 'assessment_recommended_tier', label: 'Recommended Tier', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_year_established', label: 'Year Established', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_revenue_gap_monthly', label: 'Revenue Gap (Monthly)', type: 'number', fieldType: 'number', groupName: 'companyinformation' },
    { name: 'assessment_growth_goal', label: 'Growth Goal', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_biggest_pain', label: 'Biggest Pain Point', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
    { name: 'assessment_freetext', label: 'Assessment Notes', type: 'string', fieldType: 'textarea', groupName: 'companyinformation' },
];

const CONTACT_PROPERTIES = [
    { name: 'assessment_completed', label: 'Assessment Completed', type: 'datetime', fieldType: 'date', groupName: 'contactinformation' },
    { name: 'assessment_growth_goal', label: 'Growth Goal', type: 'string', fieldType: 'text', groupName: 'contactinformation' },
    { name: 'assessment_biggest_pain', label: 'Biggest Pain Point', type: 'string', fieldType: 'text', groupName: 'contactinformation' },
    { name: 'assessment_freetext', label: 'Assessment Notes', type: 'string', fieldType: 'textarea', groupName: 'contactinformation' },
];

// ── HubSpot API helpers ───────────────────────────────────────────────
const headers = () => ({
    'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
    'Content-Type': 'application/json',
});

async function hsGet(path) {
    const r = await fetch(`${BASE}${path}`, { headers: headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
    return r.json();
}

async function hsPost(path, body) {
    const r = await fetch(`${BASE}${path}`, {
        method: 'POST', headers: headers(), body: JSON.stringify(body),
    });
    if (!r.ok) {
        const txt = await r.text();
        throw new Error(`POST ${path}: ${r.status} ${txt}`);
    }
    return r.json();
}

async function hsPatch(path, body) {
    const r = await fetch(`${BASE}${path}`, {
        method: 'PATCH', headers: headers(), body: JSON.stringify(body),
    });
    if (!r.ok) {
        const txt = await r.text();
        throw new Error(`PATCH ${path}: ${r.status} ${txt}`);
    }
    return r.json();
}

// ── Ensure custom properties exist ────────────────────────────────────
async function ensureProperties(objectType, definitions) {
    // Fetch existing properties
    const existing = await hsGet(`/crm/v3/properties/${objectType}`);
    const existingNames = new Set((existing?.results || []).map(p => p.name));

    const missing = definitions.filter(d => !existingNames.has(d.name));
    if (missing.length === 0) return;

    // Create missing properties (batch)
    const results = await Promise.allSettled(
        missing.map(prop =>
            hsPost(`/crm/v3/properties/${objectType}`, prop)
                .catch(err => {
                    // Property might already exist (race condition) — that's fine
                    if (err.message?.includes('409') || err.message?.includes('PROPERTY_EXISTS')) return null;
                    console.warn(`Failed to create property ${prop.name}:`, err.message);
                    return null;
                })
        )
    );

    const created = results.filter(r => r.status === 'fulfilled' && r.value).length;
    console.log(`Created ${created} new ${objectType} properties (${missing.length} attempted)`);
}

// ── Find or create Company by domain ──────────────────────────────────
async function findOrCreateCompany(domain, props) {
    // Search by domain
    const searchResult = await hsPost('/crm/v3/objects/companies/search', {
        filterGroups: [{
            filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }]
        }],
        limit: 1,
    });

    if (searchResult.results?.length > 0) {
        // Update existing company
        const companyId = searchResult.results[0].id;
        await hsPatch(`/crm/v3/objects/companies/${companyId}`, { properties: props });
        return companyId;
    }

    // Create new company
    const company = await hsPost('/crm/v3/objects/companies', {
        properties: { domain, ...props },
    });
    return company.id;
}

// ── Find or create Contact by email ───────────────────────────────────
async function findOrCreateContact(email, props) {
    const searchResult = await hsPost('/crm/v3/objects/contacts/search', {
        filterGroups: [{
            filters: [{ propertyName: 'email', operator: 'EQ', value: email }]
        }],
        limit: 1,
    });

    if (searchResult.results?.length > 0) {
        const contactId = searchResult.results[0].id;
        await hsPatch(`/crm/v3/objects/contacts/${contactId}`, { properties: props });
        return contactId;
    }

    const contact = await hsPost('/crm/v3/objects/contacts', {
        properties: { email, ...props },
    });
    return contact.id;
}

// ── Associate Contact ↔ Company ───────────────────────────────────────
async function associateContactToCompany(contactId, companyId) {
    try {
        await fetch(`${BASE}/crm/v3/objects/contacts/${contactId}/associations/companies/${companyId}/contact_to_company`, {
            method: 'PUT',
            headers: headers(),
        });
    } catch (err) {
        console.warn('Association error (may already exist):', err.message);
    }
}

// ── Create Deal ───────────────────────────────────────────────────────
async function createDeal(dealProps, contactId, companyId) {
    const deal = await hsPost('/crm/v3/objects/deals', {
        properties: dealProps,
    });

    // Associate deal with contact and company
    const assocPromises = [];
    if (contactId) {
        assocPromises.push(
            fetch(`${BASE}/crm/v3/objects/deals/${deal.id}/associations/contacts/${contactId}/deal_to_contact`, {
                method: 'PUT', headers: headers(),
            }).catch(() => {})
        );
    }
    if (companyId) {
        assocPromises.push(
            fetch(`${BASE}/crm/v3/objects/deals/${deal.id}/associations/companies/${companyId}/deal_to_company`, {
                method: 'PUT', headers: headers(),
            }).catch(() => {})
        );
    }
    await Promise.allSettled(assocPromises);
    return deal.id;
}

// ── Main handler ──────────────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    if (!HUBSPOT_TOKEN) {
        return res.status(500).json({ error: 'HUBSPOT_API_TOKEN not configured' });
    }

    const data = req.body;
    if (!data?.email) {
        return res.status(400).json({ error: 'email is required' });
    }

    try {
        // Step 0: Ensure custom properties exist (runs once, then fast no-ops)
        await Promise.all([
            ensureProperties('companies', COMPANY_PROPERTIES),
            ensureProperties('contacts', CONTACT_PROPERTIES),
        ]);

        // Extract domain from URL
        const domain = (data.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();

        const now = new Date().toISOString();

        // Step 1: Find or create Company by domain
        const companyProps = {
            name: data.practiceName || domain,
            phone: data.phone || '',
            address: data.address || '',
            assessment_date: now,
            assessment_practice_type: data.practiceType || '',
            assessment_practice_subtype: data.practiceSubType || '',
            assessment_doctor_count: String(data.doctorCount || 0),
            assessment_md_count: String(data.mdCount || 0),
            assessment_od_count: String(data.odCount || 0),
            assessment_doctor_names: data.doctorNames || '',
            assessment_location_count: String(data.locationCount || 0),
            assessment_services_detected: data.servicesDetected || '',
            assessment_services_count: String(data.servicesCount || 0),
            assessment_missing_services: data.missingServices || '',
            assessment_cms: data.cms || '',
            assessment_marketing_vendor: data.marketingVendor || '',
            assessment_is_competitor_client: data.isCompetitorClient || '',
            assessment_is_eyecarepro: data.isEyeCarePro || '',
            assessment_has_scheduling: data.hasScheduling || '',
            assessment_scheduling_platform: data.schedulingPlatform || '',
            assessment_analytics_tools: data.analyticsTools || '',
            assessment_social_platforms: data.socialPlatforms || '',
            assessment_social_count: String(data.socialCount || 0),
            assessment_blog_exists: data.blogExists || '',
            assessment_lighthouse_performance: String(data.lighthousePerformance || 0),
            assessment_lighthouse_seo: String(data.lighthouseSeo || 0),
            assessment_score_digital: String(data.scoreDigital || 0),
            assessment_score_content: String(data.scoreContent || 0),
            assessment_score_patient_exp: String(data.scorePatientExp || 0),
            assessment_score_marketing: String(data.scoreMarketing || 0),
            assessment_score_overall: String(data.scoreOverall || 0),
            assessment_gap_count: String(data.gapCount || 0),
            assessment_top_gaps: data.topGaps || '',
            assessment_has_optical: data.hasOptical || '',
            assessment_frame_brand_count: String(data.frameBrandCount || 0),
            assessment_brand_positioning: data.brandPositioning || '',
            assessment_insurance_plans: data.insurancePlans || '',
            assessment_recommended_tier: data.recommendedTier || '',
            assessment_year_established: data.yearEstablished || '',
            assessment_revenue_gap_monthly: String(data.revenueGapMonthly || 0),
            assessment_growth_goal: data.growthGoal || '',
            assessment_biggest_pain: data.biggestPain || '',
            assessment_freetext: data.freetext || '',
        };

        const companyId = await findOrCreateCompany(domain, companyProps);

        // Step 2: Find or create Contact by email
        const contactProps = {
            firstname: (data.name || '').split(' ')[0] || '',
            lastname: (data.name || '').split(' ').slice(1).join(' ') || '',
            phone: data.phone || '',
            company: data.practiceName || domain,
            website: data.url || '',
            assessment_completed: now,
            assessment_growth_goal: data.growthGoal || '',
            assessment_biggest_pain: data.biggestPain || '',
            assessment_freetext: data.freetext || '',
        };

        const contactId = await findOrCreateContact(data.email, contactProps);

        // Step 3: Associate contact with company
        await associateContactToCompany(contactId, companyId);

        // Step 4: Create Deal
        const gapAmount = data.revenueGapMonthly || 0;
        const dealName = `${data.practiceName || domain} — Practice Growth Assessment`;
        const dealProps = {
            dealname: dealName,
            pipeline: 'default',
            dealstage: 'Interested',
            amount: String(gapAmount),
            description: [
                `Practice: ${data.practiceName || domain}`,
                `Type: ${data.practiceType || 'Unknown'}`,
                `Overall Score: ${data.scoreOverall || '--'}/100`,
                `Monthly Revenue Gap: $${gapAmount.toLocaleString()}`,
                `Goal: ${data.growthGoal || 'Not specified'}`,
                `Pain: ${data.biggestPain || 'Not specified'}`,
                `Locations: ${data.locationCount || 1}`,
                `Doctors: ${data.doctorCount || 0}`,
                data.freetext ? `Notes: ${data.freetext}` : '',
            ].filter(Boolean).join('\n'),
        };

        const dealId = await createDeal(dealProps, contactId, companyId);

        return res.status(200).json({
            success: true,
            companyId,
            contactId,
            dealId,
            message: `Synced to HubSpot: Company ${companyId}, Contact ${contactId}, Deal ${dealId}`,
        });

    } catch (err) {
        console.error('HubSpot sync error:', err);
        return res.status(500).json({
            error: 'HubSpot sync failed',
            detail: err.message,
        });
    }
}
