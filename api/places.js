/**
 * Vercel Serverless Function — Google Places API (Multi-Location Discovery)
 *
 * Instead of searching per scraped address, this uses Google Text Search to DISCOVER
 * all GBP listings for a business name. A practice like "Access Eye" might have 6
 * locations on Google even if only 2 addresses appear on their website.
 *
 * Flow:
 *   1. Text Search for business name → returns ALL matching places
 *   2. Filter to only the ones that actually belong to this practice (name match + optional website match)
 *   3. Get Place Details for each matched location
 *   4. Nearby Search for competitors around the first location
 *
 * Returns:
 *   { locations: [{...}, {...}, ...], competitors: [...] }
 *   OR for backward compat when only 1 found:
 *   { business: {...}, locations: [{...}], competitors: [...] }
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { businessName, city, website, phone, address, addresses, debug } = req.query;
    if (!businessName && !website) return res.status(400).json({ error: 'Missing businessName or website' });

    const API_KEY = process.env.GOOGLE_PLACES_KEY;
    if (!API_KEY) {
        return res.json({ error: 'GOOGLE_PLACES_KEY not configured', business: null, locations: [], competitors: [] });
    }

    const debugLog = [];

    try {
        // ── Step 1: Discover ALL GBP listings via Text Search ──
        let allPlaces = [];

        // Primary search: business name + city (broad enough to catch all locations in the area)
        if (businessName) {
            const query = city ? `${businessName} ${city}` : businessName;
            const textResults = await textSearch(query, API_KEY);
            debugLog.push({ step: 'textSearch1', query, resultCount: textResults.length, status: textSearch._lastStatus, error: textSearch._lastError, names: textResults.slice(0,3).map(r => r.name) });
            allPlaces.push(...textResults);
        }

        // Secondary search: business name alone — ALWAYS run when city was used,
        // because a practice may have locations in OTHER cities not mentioned on their website.
        // e.g. "Access Eye King George VA" finds 1 location, but "Access Eye" finds all 3-6.
        if (businessName && city) {
            const broadResults = await textSearch(businessName, API_KEY);
            debugLog.push({ step: 'textSearch2', query: businessName, resultCount: broadResults.length, names: broadResults.slice(0,3).map(r => r.name) });
            const existingIds = new Set(allPlaces.map(p => p.place_id));
            for (const r of broadResults) {
                if (!existingIds.has(r.place_id)) {
                    allPlaces.push(r);
                }
            }
        }

        // Tertiary search: website domain (catches listings that might use a different display name)
        if (website && allPlaces.length === 0) {
            const domain = website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
            const domainResults = await textSearch(domain, API_KEY);
            debugLog.push({ step: 'textSearch3_domain', query: domain, resultCount: domainResults.length });
            const existingIds = new Set(allPlaces.map(p => p.place_id));
            for (const r of domainResults) {
                if (!existingIds.has(r.place_id)) {
                    allPlaces.push(r);
                }
            }
        }

        // ── Find Place fallback (single-result, but more reliable) ──
        // Text Search may fail if the API billing plan doesn't include it,
        // so fall back to Find Place which uses a different endpoint
        if (allPlaces.length === 0 && businessName) {
            const queries = [];
            if (city) queries.push(`${businessName} ${city}`);
            queries.push(businessName);
            if (website) {
                const domain = website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
                queries.push(domain);
            }
            for (const q of queries) {
                const result = await findPlace(q, API_KEY);
                debugLog.push({ step: 'findPlace_fallback', query: q, found: !!result, name: result?.name });
                if (result) {
                    allPlaces.push(result);
                    break;
                }
            }
        }

        // Phone fallback if nothing found yet
        if (allPlaces.length === 0 && phone) {
            const cleanPhone = phone.replace(/[^\d+]/g, '');
            if (cleanPhone.length >= 10) {
                const phoneFormatted = cleanPhone.startsWith('+') ? cleanPhone
                    : cleanPhone.startsWith('1') ? `+${cleanPhone}` : `+1${cleanPhone}`;
                try {
                    const phoneResp = await fetch(
                        `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(phoneFormatted)}&inputtype=phonenumber&fields=place_id,name,formatted_address&key=${API_KEY}`,
                        { signal: AbortSignal.timeout(8000) }
                    );
                    const phoneData = await phoneResp.json();
                    if (phoneData.candidates?.length) {
                        allPlaces.push(...phoneData.candidates);
                    }
                } catch (_) { /* phone search failed */ }
            }
        }

        if (allPlaces.length === 0) {
            return res.json({ error: 'Business not found on Google', business: null, locations: [], competitors: [], ...(debug ? { debug: debugLog } : {}) });
        }

        debugLog.push({ step: 'pre_filter', totalFound: allPlaces.length, names: allPlaces.slice(0,5).map(p => p.name) });

        // ── Step 2: Filter to only places that belong to this practice ──
        const matchedPlaces = filterToMatchingBusiness(allPlaces, businessName, website);
        debugLog.push({ step: 'post_filter', matchedCount: matchedPlaces.length });

        // If filter removed everything, use only the top result (not all 5 — filter was likely correct to exclude them)
        const finalPlaces = matchedPlaces.length > 0 ? matchedPlaces : allPlaces.slice(0, 1);

        // ── Step 3: Get Place Details for each matched location (parallel, max 10) ──
        const detailPromises = finalPlaces.slice(0, 10).map(p => getPlaceDetails(p.place_id, API_KEY));
        const detailResults = await Promise.all(detailPromises);
        const locations = detailResults.filter(Boolean);

        if (locations.length === 0) {
            return res.json({ error: 'Could not get business details', business: null, locations: [], competitors: [] });
        }

        // ── Step 4: Find competitors near the first location ──
        let competitors = [];
        for (const loc of locations) {
            if (loc._lat && loc._lng) {
                competitors = await findCompetitors(
                    loc._lat, loc._lng,
                    locations.map(l => l.placeId),
                    API_KEY
                );
                break;
            }
        }

        // Strip internal fields
        const cleanLocations = locations.map(loc => {
            const { _lat, _lng, ...clean } = loc;
            return clean;
        });

        // Always include backward-compatible `business` field (first location)
        return res.json({
            business: cleanLocations[0],
            locations: cleanLocations,
            competitors,
            ...(debug ? { debug: debugLog } : {}),
        });

    } catch (err) {
        return res.json({ error: err.message, business: null, locations: [], competitors: [], ...(debug ? { debug: debugLog } : {}) });
    }
}

/**
 * Google Places Text Search — returns UP TO 20 results (unlike Find Place which returns 1).
 * This is key for discovering all locations of a multi-location practice.
 */
async function textSearch(query, apiKey) {
    try {
        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const data = await resp.json();
        // Store status for debugging
        textSearch._lastStatus = data.status;
        textSearch._lastError = data.error_message;
        return data.results || [];
    } catch (e) {
        textSearch._lastStatus = 'FETCH_ERROR';
        textSearch._lastError = e.message;
        return [];
    }
}

/**
 * Find Place — returns SINGLE best candidate (more reliable than Text Search,
 * works even if Text Search API isn't enabled on the billing plan).
 */
async function findPlace(query, apiKey) {
    try {
        const resp = await fetch(
            `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=place_id,name,formatted_address&key=${apiKey}`,
            { signal: AbortSignal.timeout(8000) }
        );
        const data = await resp.json();
        return data.candidates?.[0] || null;
    } catch (_) {
        return null;
    }
}

/**
 * Filter Text Search results to only locations belonging to this practice.
 * Uses fuzzy name matching + optional website verification.
 */
function filterToMatchingBusiness(places, businessName, website) {
    if (!businessName) return places.slice(0, 5); // If no name, just return top results

    const normName = normalizeName(businessName);
    const domain = website ? website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase() : null;

    // Extract distinctive words (3+ chars, skip common eye care filler words)
    const skipWords = new Set(['the','and','of','for','in','at','eye','care','clinic','center',
        'group','associates','llc','pc','md','od','pa','inc','office','practice','vision',
        'optical','optometry','ophthalmology','doctor','doctors','medical']);
    const bizWords = normName.split(' ').filter(w => w.length >= 3 && !skipWords.has(w));

    return places.filter(p => {
        const pName = normalizeName(p.name || '');

        // Exact or near-exact match: one name fully contains the other
        if (pName.includes(normName)) return true;

        // Only allow reverse contain if the place name is substantial (>= 3 words)
        // to prevent "Eye Clinic" matching "Empress Eye Clinic"
        const pWords = pName.split(' ');
        if (pWords.length >= 3 && normName.includes(pName)) return true;

        // Distinctive word match: at least 1 non-generic word from the business name
        // must appear in the Google result name
        if (bizWords.length > 0) {
            const matchCount = bizWords.filter(w => pName.includes(w)).length;
            if (matchCount >= 1) return true;
        }

        // Website domain match: if the place has a website matching ours, it's ours
        if (domain && p.website) {
            const pDomain = p.website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
            if (pDomain === domain) return true;
        }

        return false;
    });
}

function normalizeName(name) {
    return name.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '') // strip punctuation
        .replace(/\s+/g, ' ')        // collapse whitespace
        .trim();
}

/**
 * Get full Place Details for a single placeId.
 */
async function getPlaceDetails(placeId, apiKey) {
    try {
        const detailFields = [
            'name', 'rating', 'user_ratings_total', 'photos', 'opening_hours',
            'website', 'formatted_phone_number', 'types', 'url', 'geometry',
            'business_status', 'reviews', 'formatted_address',
        ].join(',');

        const detailResp = await fetch(
            `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${detailFields}&key=${apiKey}`,
            { signal: AbortSignal.timeout(8000) }
        );
        const detailData = await detailResp.json();
        const biz = detailData.result;

        if (!biz) return null;

        return {
            name: biz.name,
            placeId,
            rating: biz.rating || null,
            reviewCount: biz.user_ratings_total || 0,
            photoCount: biz.photos?.length || 0,
            hasHours: !!biz.opening_hours,
            isOpen: biz.opening_hours?.open_now ?? null,
            website: biz.website || null,
            phone: biz.formatted_phone_number || null,
            address: biz.formatted_address || null,
            types: biz.types || [],
            businessStatus: biz.business_status || null,
            mapsUrl: biz.url || null,
            primaryCategory: categorizeBusiness(biz.types),
            recentReview: biz.reviews?.[0] ? {
                rating: biz.reviews[0].rating,
                text: biz.reviews[0].text?.slice(0, 150),
                time: biz.reviews[0].relative_time_description,
            } : null,
            _lat: biz.geometry?.location?.lat,
            _lng: biz.geometry?.location?.lng,
        };
    } catch (_) {
        return null;
    }
}

/**
 * Find nearby competitors, excluding all known practice placeIds.
 */
async function findCompetitors(lat, lng, excludePlaceIds, apiKey) {
    try {
        const nearbyResp = await fetch(
            `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=8000&keyword=eye+doctor+optometrist+ophthalmologist&key=${apiKey}`,
            { signal: AbortSignal.timeout(8000) }
        );
        const nearbyData = await nearbyResp.json();
        const excludeSet = new Set(excludePlaceIds);
        return (nearbyData.results || [])
            .filter(c => !excludeSet.has(c.place_id))
            .slice(0, 4)
            .map(c => ({
                name: c.name,
                rating: c.rating || null,
                reviewCount: c.user_ratings_total || 0,
                address: c.vicinity || null,
            }));
    } catch (_) {
        return [];
    }
}

function categorizeBusiness(types) {
    if (!types) return 'Unknown';
    if (types.includes('optometrist')) return 'Optometrist';
    if (types.includes('ophthalmologist')) return 'Ophthalmologist';
    if (types.includes('doctor')) return 'Doctor';
    if (types.includes('health')) return 'Health';
    return types[0] || 'Unknown';
}
