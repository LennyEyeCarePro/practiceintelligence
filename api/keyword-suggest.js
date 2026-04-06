/**
 * Vercel Serverless Function — Keyword Suggestions via Datamuse API
 * Takes the top keywords extracted from a site and finds related/suggested keywords.
 * Shows "keyword gaps" — what the site COULD be ranking for.
 *
 * Fully free, no API key needed. ~100K requests/day.
 *
 * POST /api/keyword-suggest
 * Body: { keywords: ["eye", "vision", "care"], industry: "optometry", businessName: "Apex Eye" }
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { keywords, industry, businessName } = req.body || {};

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({ error: 'Missing keywords array' });
    }

    try {
        // Build seed terms: top page keywords + industry-specific terms
        const industryTerms = getIndustryTerms(industry || '');
        const seedTerms = [...new Set([...keywords.slice(0, 5), ...industryTerms.slice(0, 3)])];

        // Query Datamuse for related words and "sounds like" suggestions for each seed
        const allSuggestions = [];

        const fetches = seedTerms.flatMap(term => [
            // "Means like" — semantically related words
            fetch(`https://api.datamuse.com/words?ml=${encodeURIComponent(term)}&max=8`, {
                signal: AbortSignal.timeout(5000),
            }).then(r => r.json()).then(data =>
                data.map(d => ({ word: d.word, score: d.score, source: 'related', seed: term }))
            ).catch(() => []),

            // "Triggered by" — words commonly appearing after this word
            fetch(`https://api.datamuse.com/words?lc=${encodeURIComponent(term)}&max=5`, {
                signal: AbortSignal.timeout(5000),
            }).then(r => r.json()).then(data =>
                data.map(d => ({ word: `${term} ${d.word}`, score: d.score, source: 'phrase', seed: term }))
            ).catch(() => []),
        ]);

        const results = await Promise.all(fetches);
        results.forEach(batch => allSuggestions.push(...batch));

        // Also get topic-specific suggestions from industry
        if (industry) {
            const topicFetches = industryTerms.slice(0, 5).map(term =>
                fetch(`https://api.datamuse.com/words?ml=${encodeURIComponent(term)}&max=5`, {
                    signal: AbortSignal.timeout(5000),
                }).then(r => r.json()).then(data =>
                    data.map(d => ({ word: d.word, score: d.score, source: 'industry', seed: term }))
                ).catch(() => [])
            );
            const topicResults = await Promise.all(topicFetches);
            topicResults.forEach(batch => allSuggestions.push(...batch));
        }

        // Deduplicate and score
        const seen = new Set(keywords.map(k => k.toLowerCase()));
        const uniqueSuggestions = [];

        for (const s of allSuggestions) {
            const lower = s.word.toLowerCase();
            if (seen.has(lower)) continue;
            if (lower.length < 3) continue;
            // Filter out nonsense / overly generic words
            if (/^\d+$/.test(lower)) continue;
            seen.add(lower);
            uniqueSuggestions.push(s);
        }

        // Sort by Datamuse score (higher = more relevant)
        uniqueSuggestions.sort((a, b) => (b.score || 0) - (a.score || 0));

        // Categorize into keyword gaps vs. related terms
        const keywordGaps = uniqueSuggestions
            .filter(s => s.source === 'related' || s.source === 'industry')
            .slice(0, 20)
            .map(s => ({
                keyword: s.word,
                relevance: Math.min(100, Math.round((s.score || 0) / 1000)),
                source: s.source,
                seedTerm: s.seed,
            }));

        const longTailIdeas = uniqueSuggestions
            .filter(s => s.source === 'phrase')
            .slice(0, 15)
            .map(s => ({
                phrase: s.word,
                relevance: Math.min(100, Math.round((s.score || 0) / 500)),
                seedTerm: s.seed,
            }));

        return res.json({
            seedTerms,
            keywordGaps,
            longTailIdeas,
            totalSuggestions: uniqueSuggestions.length,
        });

    } catch (err) {
        return res.json({ error: err.message, keywordGaps: [], longTailIdeas: [] });
    }
}

/**
 * Get industry-specific seed terms to enhance keyword discovery.
 */
function getIndustryTerms(industry) {
    const terms = {
        optometry: ['eye exam', 'vision', 'glasses', 'contacts', 'optometrist', 'dry eye', 'myopia'],
        ophthalmology: ['eye surgery', 'cataract', 'lasik', 'retina', 'glaucoma', 'ophthalmologist'],
        multi_eye: ['eye care', 'vision', 'eye doctor', 'cataract', 'contacts', 'glasses'],
        dental: ['dentist', 'teeth', 'dental', 'orthodontist', 'braces', 'implants', 'whitening'],
        chiropractic: ['chiropractor', 'spine', 'back pain', 'adjustment', 'wellness', 'posture'],
        dermatology: ['dermatologist', 'skin', 'acne', 'botox', 'cosmetic', 'laser', 'eczema'],
        medical_general: ['doctor', 'physician', 'primary care', 'family medicine', 'clinic', 'health'],
        legal: ['lawyer', 'attorney', 'legal', 'law firm', 'litigation', 'counsel', 'dispute'],
        accounting: ['accountant', 'CPA', 'tax', 'bookkeeping', 'audit', 'financial'],
        restaurant: ['restaurant', 'dining', 'food', 'menu', 'catering', 'reservations'],
        real_estate: ['realtor', 'real estate', 'home', 'property', 'listing', 'mortgage'],
        home_services: ['plumber', 'HVAC', 'electrician', 'repair', 'contractor', 'installation'],
        auto: ['auto repair', 'mechanic', 'car', 'oil change', 'brake', 'tire'],
        fitness: ['gym', 'fitness', 'personal trainer', 'workout', 'yoga', 'health club'],
        salon: ['salon', 'spa', 'haircut', 'massage', 'beauty', 'facial', 'nail'],
        veterinary: ['veterinarian', 'vet', 'pet', 'animal hospital', 'dog', 'cat'],
        ecommerce: ['shop', 'buy', 'store', 'product', 'sale', 'discount', 'shipping'],
        saas: ['software', 'platform', 'tool', 'solution', 'cloud', 'integration', 'API'],
    };

    return terms[industry] || [];
}
