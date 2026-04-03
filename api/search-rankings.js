/**
 * Vercel Serverless Function — Google Search Rankings via Apify
 *
 * Checks where a practice ranks for relevant "near me" keywords
 * based on their practice type and detected specialties.
 *
 * POST /api/search-rankings
 * Body: { domain, city, state, practiceType, specialties[], services[] }
 * Returns: { keywords: [{ keyword, rank, url, snippet }], searchedAt }
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const APIFY_TOKEN = process.env.APIFY_TOKEN;
    if (!APIFY_TOKEN) {
        return res.status(500).json({ error: 'APIFY_TOKEN not configured' });
    }

    const { domain, city, state, practiceType, serviceIds } = req.body;
    if (!domain) return res.status(400).json({ error: 'Missing domain' });
    if (!city) return res.status(400).json({ error: 'Missing city' });

    try {
        // ── Step 1: Build keyword list based on practice type + services ──
        const keywords = buildKeywordList(practiceType, serviceIds || []);

        // Localize each keyword: "eye doctor near me Fredericksburg VA"
        const stateAbbr = state || '';
        const localizedQueries = keywords.map(kw => `${kw} ${city} ${stateAbbr}`.trim());

        // ── Step 2: Run Apify Google Search Scraper ──
        const ACTOR_ID = 'apify/google-search-scraper';
        const startResp = await fetch(
            `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    queries: localizedQueries.join('\n'),
                    countryCode: 'us',
                    languageCode: 'en',
                    maxPagesPerQuery: 1,
                    resultsPerPage: 20,
                    mobileResults: false,
                }),
            }
        );

        if (!startResp.ok) {
            const errText = await startResp.text();
            return res.json({ error: `Apify start failed: ${errText}`, keywords: [] });
        }

        const runData = await startResp.json();
        const runId = runData?.data?.id;
        if (!runId) return res.json({ error: 'No Apify run ID returned', keywords: [] });

        // ── Step 3: Poll for completion (max 90 seconds) ──
        const startTime = Date.now();
        const MAX_WAIT = 90000;
        let status = 'RUNNING';

        while (Date.now() - startTime < MAX_WAIT) {
            await new Promise(r => setTimeout(r, 4000)); // Poll every 4s

            const statusResp = await fetch(
                `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
            );
            const statusData = await statusResp.json();
            status = statusData?.data?.status;

            if (status === 'SUCCEEDED') break;
            if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
                return res.json({ error: `Apify run ${status}`, keywords: [] });
            }
        }

        if (status !== 'SUCCEEDED') {
            return res.json({ error: 'Search ranking check timed out', keywords: [] });
        }

        // ── Step 4: Get results and find our practice's rank ──
        const datasetResp = await fetch(
            `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}`
        );
        const searchResults = await datasetResp.json();

        // Clean the domain for matching
        const cleanDomain = domain.replace(/^www\./, '').toLowerCase();

        // Map results back to keywords
        const rankingResults = keywords.map((keyword, idx) => {
            const localizedQuery = localizedQueries[idx];
            // Find the search result set for this query
            const resultSet = searchResults.find(r =>
                r.searchQuery?.term === localizedQuery ||
                r.searchQuery?.term?.includes(keyword)
            );

            if (!resultSet || !resultSet.organicResults) {
                return { keyword, rank: null, found: false, url: null, snippet: null };
            }

            // Search through organic results for our domain
            const organicResults = resultSet.organicResults || [];
            for (let i = 0; i < organicResults.length; i++) {
                const resultUrl = (organicResults[i].url || organicResults[i].link || '').toLowerCase();
                if (resultUrl.includes(cleanDomain)) {
                    return {
                        keyword,
                        rank: i + 1,
                        found: true,
                        url: organicResults[i].url || organicResults[i].link,
                        snippet: (organicResults[i].description || organicResults[i].snippet || '').slice(0, 150),
                        title: organicResults[i].title,
                    };
                }
            }

            // Also check local/map pack results
            const localResults = resultSet.localResults || resultSet.placesResults || [];
            for (let i = 0; i < localResults.length; i++) {
                const localTitle = (localResults[i].title || localResults[i].name || '').toLowerCase();
                const localUrl = (localResults[i].url || localResults[i].website || '').toLowerCase();
                if (localUrl.includes(cleanDomain) || localTitle.includes(cleanDomain.split('.')[0])) {
                    return {
                        keyword,
                        rank: null, // Map pack doesn't have a traditional rank
                        found: true,
                        inMapPack: true,
                        mapPackPosition: i + 1,
                        url: localResults[i].url || localResults[i].website,
                        snippet: localResults[i].address || '',
                        title: localResults[i].title || localResults[i].name,
                    };
                }
            }

            return { keyword, rank: null, found: false, url: null, snippet: null };
        });

        return res.json({
            keywords: rankingResults,
            totalKeywords: keywords.length,
            foundCount: rankingResults.filter(r => r.found).length,
            searchedAt: new Date().toISOString(),
            city,
        });

    } catch (err) {
        return res.json({ error: err.message, keywords: [] });
    }
}

/**
 * Build the keyword list based on practice type and detected service IDs.
 *
 * Practice types: optometry, ophthalmology, multi_specialty, optical, unknown
 * Service IDs come from dossier.services.detected[].id
 */
function buildKeywordList(practiceType, serviceIds) {
    const svcSet = new Set(serviceIds.map(s => s.toLowerCase()));

    // ─────────────────────────────────────────────────
    // OPTOMETRIST: 3 base + specialties, max 8 total
    // ─────────────────────────────────────────────────
    if (practiceType === 'optometry' || practiceType === 'unknown') {
        const base = [
            'eye exam near me',
            'eye doctor near me',
            'optometrist near me',
        ];
        const specialties = [];

        // Specialty keywords — only added if that service is on their website
        if (svcSet.has('dry_eye') || svcSet.has('dry_eye_treatment') || svcSet.has('dry_eye_therapy'))
            specialties.push('dry eye near me');
        if (svcSet.has('myopia_management') || svcSet.has('myopia') || svcSet.has('myopia_control'))
            specialties.push('myopia near me');
        if (svcSet.has('ortho_k') || svcSet.has('orthokeratology') || svcSet.has('ortho-k'))
            specialties.push('ortho k near me');
        if (svcSet.has('vision_therapy') || svcSet.has('vision_training'))
            specialties.push('vision therapy near me');
        if (svcSet.has('low_vision') || svcSet.has('low_vision_aids'))
            specialties.push('low vision near me');
        if (svcSet.has('scleral_lenses') || svcSet.has('scleral') || svcSet.has('specialty_contacts'))
            specialties.push('scleral lenses near me');
        if (svcSet.has('pediatric') || svcSet.has('pediatric_eye_care') || svcSet.has('childrens_eye'))
            specialties.push('pediatric eye doctor near me');
        if (svcSet.has('contact_lenses') || svcSet.has('contacts'))
            specialties.push('contact lenses near me');
        if (svcSet.has('emergency_eye_care') || svcSet.has('urgent_eye'))
            specialties.push('emergency eye doctor near me');

        // Cap at 8 total (3 base + up to 5 specialties)
        return [...base, ...specialties.slice(0, 5)];
    }

    // ─────────────────────────────────────────────────
    // OPHTHALMOLOGIST: all keywords that fit based on website (no cap)
    // ─────────────────────────────────────────────────
    if (practiceType === 'ophthalmology') {
        const keywords = [
            'ophthalmologist near me',
            'eye doctor near me',
            'eye exam near me',
            'vision correction near me',
        ];

        if (svcSet.has('cataract_surgery') || svcSet.has('cataracts'))
            keywords.push('cataract surgery near me');
        if (svcSet.has('lasik') || svcSet.has('refractive_surgery') || svcSet.has('laser_vision'))
            keywords.push('lasik near me');
        if (svcSet.has('retina') || svcSet.has('retinal') || svcSet.has('retinal_surgery'))
            keywords.push('retinal surgery near me');
        if (svcSet.has('glaucoma') || svcSet.has('glaucoma_treatment'))
            keywords.push('glaucoma treatment near me');
        if (svcSet.has('cornea') || svcSet.has('corneal'))
            keywords.push('cornea specialist near me');
        if (svcSet.has('oculoplastics') || svcSet.has('eyelid_surgery'))
            keywords.push('oculoplastics near me');
        if (svcSet.has('macular_degeneration') || svcSet.has('amd'))
            keywords.push('macular degeneration treatment near me');
        if (svcSet.has('diabetic_eye') || svcSet.has('diabetic_retinopathy'))
            keywords.push('diabetic eye doctor near me');
        if (svcSet.has('dry_eye') || svcSet.has('dry_eye_treatment'))
            keywords.push('dry eye near me');
        if (svcSet.has('pediatric') || svcSet.has('pediatric_ophthalmology'))
            keywords.push('pediatric ophthalmologist near me');

        return keywords;
    }

    // ─────────────────────────────────────────────────
    // MULTI-SPECIALTY: ophthalmology + optometry keywords that fit
    // ─────────────────────────────────────────────────
    if (practiceType === 'multi_specialty') {
        const keywords = [
            'eye doctor near me',
            'eye exam near me',
            'optometrist near me',
            'ophthalmologist near me',
        ];

        // Ophthalmology services
        if (svcSet.has('cataract_surgery') || svcSet.has('cataracts'))
            keywords.push('cataract surgery near me');
        if (svcSet.has('lasik') || svcSet.has('refractive_surgery') || svcSet.has('laser_vision'))
            keywords.push('lasik near me');
        if (svcSet.has('retina') || svcSet.has('retinal') || svcSet.has('retinal_surgery'))
            keywords.push('retinal surgery near me');
        if (svcSet.has('glaucoma') || svcSet.has('glaucoma_treatment'))
            keywords.push('glaucoma treatment near me');

        // Optometry specialties
        if (svcSet.has('dry_eye') || svcSet.has('dry_eye_treatment'))
            keywords.push('dry eye near me');
        if (svcSet.has('myopia_management') || svcSet.has('myopia'))
            keywords.push('myopia near me');
        if (svcSet.has('vision_therapy') || svcSet.has('vision_training'))
            keywords.push('vision therapy near me');

        return keywords;
    }

    // ─────────────────────────────────────────────────
    // OPTICAL: all optical keywords that fit
    // ─────────────────────────────────────────────────
    if (practiceType === 'optical') {
        const keywords = [
            'eyeglasses near me',
            'eye glasses near me',
        ];

        if (svcSet.has('contact_lenses') || svcSet.has('contacts'))
            keywords.push('contact lenses near me');
        if (svcSet.has('sunglasses'))
            keywords.push('sunglasses near me');
        if (svcSet.has('lens_types') || svcSet.has('progressive'))
            keywords.push('progressive lenses near me');
        // If optical also does exams
        if (svcSet.has('eye_exam') || svcSet.has('comprehensive_exam'))
            keywords.push('eye exam near me');

        return keywords;
    }

    // Fallback
    return ['eye doctor near me', 'eye exam near me'];
}
