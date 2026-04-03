/**
 * Vercel Serverless Function — Google Places API
 * Finds a business on Google, gets GBP details, and nearby competitors.
 * Uses multiple search strategies for reliable matching.
 *
 * GET /api/places?businessName=Access+Eye&city=Fredericksburg+VA&website=accesseye.com&phone=(540)+371-2020&address=...
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { businessName, city, website, phone, address } = req.query;
    if (!businessName && !website) return res.status(400).json({ error: 'Missing businessName or website' });

    const API_KEY = process.env.GOOGLE_PLACES_KEY;
    if (!API_KEY) {
        return res.json({ error: 'GOOGLE_PLACES_KEY not configured', business: null, competitors: [] });
    }

    try {
        // Try multiple search strategies to find the Place ID
        let placeId = null;
        let candidateName = null;

        // Strategy 1: Business name + city
        if (businessName && city) {
            const result = await findPlace(`${businessName} ${city}`, API_KEY);
            if (result) { placeId = result.place_id; candidateName = result.name; }
        }

        // Strategy 2: Business name + full address
        if (!placeId && businessName && address) {
            const result = await findPlace(`${businessName} ${address}`, API_KEY);
            if (result) { placeId = result.place_id; candidateName = result.name; }
        }

        // Strategy 3: Business name alone (broader search)
        if (!placeId && businessName) {
            const result = await findPlace(businessName, API_KEY);
            if (result) { placeId = result.place_id; candidateName = result.name; }
        }

        // Strategy 4: Search by website domain (e.g. "accesseye.com")
        if (!placeId && website) {
            const domain = website.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
            const result = await findPlace(domain, API_KEY);
            if (result) { placeId = result.place_id; candidateName = result.name; }
        }

        // Strategy 5: Search by phone number (Google Places supports this)
        if (!placeId && phone) {
            const cleanPhone = phone.replace(/[^\d+]/g, '');
            if (cleanPhone.length >= 10) {
                const phoneFormatted = cleanPhone.startsWith('+') ? cleanPhone
                    : cleanPhone.startsWith('1') ? `+${cleanPhone}`
                    : `+1${cleanPhone}`;
                try {
                    const phoneResp = await fetch(
                        `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(phoneFormatted)}&inputtype=phonenumber&fields=place_id,name,formatted_address&key=${API_KEY}`,
                        { signal: AbortSignal.timeout(8000) }
                    );
                    const phoneData = await phoneResp.json();
                    if (phoneData.candidates?.[0]?.place_id) {
                        placeId = phoneData.candidates[0].place_id;
                        candidateName = phoneData.candidates[0].name;
                    }
                } catch (_) { /* phone search failed, continue */ }
            }
        }

        if (!placeId) {
            return res.json({ error: 'Business not found on Google', business: null, competitors: [] });
        }

        // Step 2: Get Place Details
        const detailFields = [
            'name', 'rating', 'user_ratings_total', 'photos', 'opening_hours',
            'website', 'formatted_phone_number', 'types', 'url', 'geometry',
            'business_status', 'reviews', 'formatted_address',
        ].join(',');

        const detailResp = await fetch(
            `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${detailFields}&key=${API_KEY}`,
            { signal: AbortSignal.timeout(8000) }
        );
        const detailData = await detailResp.json();
        const biz = detailData.result;

        if (!biz) {
            return res.json({ error: 'Could not fetch business details', business: null, competitors: [] });
        }

        // Step 3: Nearby competitors
        let competitors = [];
        if (biz.geometry?.location) {
            const { lat, lng } = biz.geometry.location;
            const nearbyResp = await fetch(
                `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=8000&keyword=eye+doctor+optometrist+ophthalmologist&key=${API_KEY}`,
                { signal: AbortSignal.timeout(8000) }
            );
            const nearbyData = await nearbyResp.json();
            competitors = (nearbyData.results || [])
                .filter(c => c.place_id !== placeId)
                .slice(0, 4)
                .map(c => ({
                    name: c.name,
                    rating: c.rating || null,
                    reviewCount: c.user_ratings_total || 0,
                    address: c.vicinity || null,
                }));
        }

        // Format response
        const business = {
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
        };

        return res.json({ business, competitors });

    } catch (err) {
        return res.json({ error: err.message, business: null, competitors: [] });
    }
}

/** Helper: try Find Place text search, return first candidate or null */
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

function categorizeBusiness(types) {
    if (!types) return 'Unknown';
    if (types.includes('optometrist')) return 'Optometrist';
    if (types.includes('ophthalmologist')) return 'Ophthalmologist';
    if (types.includes('doctor')) return 'Doctor';
    if (types.includes('health')) return 'Health';
    return types[0] || 'Unknown';
}
