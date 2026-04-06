/**
 * Vercel Serverless Function — SERP Keyword Mining via Apify
 * Scrapes Google SERPs to extract "People Also Ask" questions and "Related Searches"
 * — the BEST free competitive keyword intelligence available.
 *
 * Uses the existing Apify Google Search Scraper actor.
 * Requires APIFY_TOKEN env var (already configured).
 *
 * POST /api/serp-keywords
 * Body: { keywords: ["eye doctor fredericksburg va", "optometrist near me"], maxPages: 1 }
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { keywords, maxPages } = req.body || {};

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({ error: 'Missing keywords array' });
    }

    const APIFY_TOKEN = process.env.APIFY_TOKEN;
    if (!APIFY_TOKEN) {
        return res.json({ error: 'APIFY_TOKEN not configured', paa: [], related: [] });
    }

    try {
        // Use Apify's Google Search Results Scraper
        // Actor: apify/google-search-scraper
        const actorInput = {
            queries: keywords.slice(0, 5).join('\n'), // Limit to 5 queries
            maxPagesPerQuery: maxPages || 1,
            resultsPerPage: 10,
            languageCode: 'en',
            countryCode: 'us',
            mobileResults: false,
            includeUnfilteredResults: false,
            saveHtml: false,
            saveHtmlToKeyValueStore: false,
        };

        // Start the actor run and wait for it (synchronous call)
        const runResp = await fetch(
            `https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=30`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(actorInput),
                signal: AbortSignal.timeout(45000),
            }
        );

        if (!runResp.ok) {
            const errText = await runResp.text();
            return res.json({
                error: `Apify returned ${runResp.status}: ${errText.slice(0, 200)}`,
                paa: [],
                related: [],
            });
        }

        const results = await runResp.json();

        // Extract People Also Ask questions
        const allPAA = [];
        const allRelated = [];
        const allOrganicKeywords = [];

        for (const result of results) {
            // People Also Ask
            if (result.peopleAlsoAsk && Array.isArray(result.peopleAlsoAsk)) {
                result.peopleAlsoAsk.forEach(q => {
                    const question = typeof q === 'string' ? q : q.question || q.title || '';
                    if (question && !allPAA.some(p => p.toLowerCase() === question.toLowerCase())) {
                        allPAA.push(question);
                    }
                });
            }

            // Related Searches
            if (result.relatedQueries) {
                const related = result.relatedQueries.items || result.relatedQueries;
                if (Array.isArray(related)) {
                    related.forEach(r => {
                        const term = typeof r === 'string' ? r : r.title || r.query || '';
                        if (term && !allRelated.some(p => p.toLowerCase() === term.toLowerCase())) {
                            allRelated.push(term);
                        }
                    });
                }
            }

            // Also extract title keywords from organic results for keyword ideas
            if (result.organicResults && Array.isArray(result.organicResults)) {
                result.organicResults.forEach(r => {
                    if (r.title) {
                        allOrganicKeywords.push({
                            title: r.title,
                            url: r.url || r.link || '',
                            position: r.position || r.rank || 0,
                            query: result.searchQuery?.term || '',
                        });
                    }
                });
            }
        }

        // Categorize PAA questions
        const paaCategories = categorizePAA(allPAA);

        // Extract keyword themes from organic titles
        const titleKeywords = extractTitleKeywords(allOrganicKeywords);

        return res.json({
            queriesSearched: keywords.slice(0, 5),
            peopleAlsoAsk: allPAA,
            paaCategories,
            relatedSearches: allRelated,
            organicTitleKeywords: titleKeywords,
            totalPAA: allPAA.length,
            totalRelated: allRelated.length,
        });

    } catch (err) {
        return res.json({
            error: err.message,
            paa: [],
            related: [],
        });
    }
}

/**
 * Categorize People Also Ask questions by intent
 */
function categorizePAA(questions) {
    const categories = {
        informational: [],   // what, how, why, when
        commercial: [],      // cost, price, best, insurance, worth
        navigational: [],    // near me, in [city], location
        transactional: [],   // book, schedule, buy, get
    };

    questions.forEach(q => {
        const lower = q.toLowerCase();
        if (/\b(cost|price|insurance|worth|afford|cheap|expensive|pay|fee|much)\b/.test(lower)) {
            categories.commercial.push(q);
        } else if (/\b(near me|in my|location|closest|nearby|area|local)\b/.test(lower)) {
            categories.navigational.push(q);
        } else if (/\b(book|schedule|appointment|buy|order|sign up|get started|find a)\b/.test(lower)) {
            categories.transactional.push(q);
        } else {
            categories.informational.push(q);
        }
    });

    return categories;
}

/**
 * Extract common keyword themes from organic result titles
 */
function extractTitleKeywords(organicResults) {
    const wordFreq = {};
    const stopWords = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
        'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'are', 'was',
        'this', 'that', 'your', 'you', 'we', 'our', 'their', 'his', 'her',
        'all', 'can', 'has', 'had', 'will', 'do', 'did', 'not', 'no', 'so',
        'if', 'up', 'out', 'about', 'just', 'into', 'than', 'them', 'then',
        'its', 'my', 'more', 'some', 'any', 'how', 'what', 'when', 'who',
    ]);

    organicResults.forEach(r => {
        const words = r.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
        words.forEach(word => {
            if (word.length > 2 && !stopWords.has(word)) {
                wordFreq[word] = (wordFreq[word] || 0) + 1;
            }
        });
    });

    return Object.entries(wordFreq)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 25)
        .map(([word, count]) => ({ word, count }));
}
