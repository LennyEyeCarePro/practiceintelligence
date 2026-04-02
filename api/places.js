/**
 * Vercel Serverless Function — Google Places API
 * Finds a business on Google, gets GBP details, and nearby competitors.
 *
 * GET /api/places?businessName=Access+Eye&city=Fredericksburg+VA
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { businessName, city } = req.query;
    if (!businessName) return res.status(400).json({ error: 'Missing businessName' });

    const API_KEY = process.env.GOOGLE_PLACES_KEY;
    if (!API_KEY) {
        return res.json({ error: 'GOOGLE_PLACES_KEY not configured', business: null, competitors: [] });
    }

    try {
        // Step 1: Find Place ID
        const searchQuery = city ? `${businessName} ${city}` : businessName;
        const searchResp = await fetch(
            `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(searchQuery)}&inputtype=textquery&fields=place_id,name,formatted_address&key=${API_KEY}`,
            { signal: AbortSignal.timeout(8000) }
        );
        const searchData = await searchResp.json();
        const placeId = searchData.candidates?.[0]?.place_id;

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
            // Search for eye care / optometrist businesses nearby
            const nearbyResp = await fetch(
                `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=8000&keyword=eye+doctor+optometrist+ophthalmologist&key=${API_KEY}`,
                { signal: AbortSignal.timeout(8000) }
            );
            const nearbyData = await nearbyResp.json();
            competitors = (nearbyData.results || [])
                .filter(c => c.place_id !== placeId) // exclude this practice
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
            // Check if primary category is eye-care specific
            primaryCategory: categorizeBusiness(biz.types),
            // Recent review snippet (most recent)
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

function categorizeBusiness(types) {
    if (!types) return 'Unknown';
    if (types.includes('optometrist')) return 'Optometrist';
    if (types.includes('ophthalmologist')) return 'Ophthalmologist';
    if (types.includes('doctor')) return 'Doctor';
    if (types.includes('health')) return 'Health';
    return types[0] || 'Unknown';
}
