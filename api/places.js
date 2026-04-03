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

    const { businessName, city, website, phone, address, addresses } = req.query;
    if (!businessName && !website) return res.status(400).json({ error: 'Missing businessName or website' });

    const API_KEY = process.env.GOOGLE_PLACES_KEY;
    if (!API_KEY) {
        return res.json({ error: 'GOOGLE_PLACES_KEY not configured', business: null, locations: [], competitors: [] });
    }

    try {
        // ── Step 1: Discover ALL GBP listings via Text Search ──
        let allPlaces = [];

        // Primary search: business name + city (broad enough to catch all locations in the area)
        if (businessName) {
            const query = city ? `${businessName} ${city}` : businessName;
            const textResults = await textSearch(query, API_KEY);
            allPlaces.push(...textResults);
        }

        // Secondary search: business name alone (might catch locations in other cities)
        if (businessName && city) {
            const broadResults = await textSearch(businessName, API_KEY);
            // Add any that aren't already found
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
            const existingIds = new Set(allPlaces.map(p => p.place_id));
            for (const r of domainResults) {
                if (!existingIds.has(r.place_id)) {
                    allPlaces.push(r);
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
            return res.json({ error: 'Business not found on Google', business: null, locations: [], competitors: [] });
        }

        // ── Step 2: Filter to only places that belong to this practice ──
        const matchedPlaces = filterToMatchingBusiness(allPlaces, businessName, website);

        if (matchedPlaces.length === 0) {
            return res.json({ error: 'Business not found on Google', business: null, locations: [], competitors: [] });
        }

        // ── Step 3: Get Place Details for each matched location (parallel, max 10) ──
        const detailPromises = matchedPlaces.slice(0, 10).map(p => getPlaceDetails(p.place_id, API_KEY));
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
        });

    } catch (err) {
        return res.json({ error: err.message, business: null, locations: [], competitors: [] });
    }
}

/**
 * Google Places Text Search — returns UP TO 20 results (unlike Find Place which returns 1).
 * This is key for discovering all locations of a multi-location practice.
 */
async function textSearch(query, apiKey) {
    try {
        const resp = await fetch(
            `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&type=health&key=${apiKey}`,
            { signal: AbortSignal.timeout(10000) }
        );
        const data = await resp.json();
        return data.results || [];
    } catch (_) {
        return [];
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

    return places.filter(p => {
        const pName = normalizeName(p.name || '');
        // Check if the place name contains the business name or vice versa
        // e.g. "Access Eye" matches "Access Eye - Fredericksburg" or "Access Eye Consultants"
        return pName.includes(normName) || normName.includes(pName);
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
