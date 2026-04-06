/**
 * Vercel Serverless Function — Google Autocomplete / Suggest
 * Returns REAL Google search suggestions for any keyword + location.
 *
 * Completely free. No API key needed. No rate limit (within reason).
 * This is the same data Google shows in the search bar dropdown.
 *
 * GET /api/google-suggest?q=eye+doctor&city=Fredericksburg+VA
 *
 * For competitive keyword research:
 * GET /api/google-suggest?q=eye+doctor&city=Fredericksburg+VA&expand=true
 *   → Also runs alphabet expansion (eye doctor a, eye doctor b, ...)
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { q, city, expand } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing q parameter' });

    try {
        const baseQuery = city ? `${q} ${city}` : q;
        const results = { query: baseQuery, suggestions: [], expanded: [] };

        // ── Primary: Direct suggestions ──
        const primary = await fetchSuggestions(baseQuery);
        results.suggestions = primary;

        // ── Also try without city for broader ideas ──
        if (city) {
            const broad = await fetchSuggestions(q);
            // Add any suggestions we don't already have
            const existing = new Set(primary.map(s => s.toLowerCase()));
            broad.forEach(s => {
                if (!existing.has(s.toLowerCase())) {
                    results.suggestions.push(s);
                    existing.add(s.toLowerCase());
                }
            });
        }

        // ── Alphabet expansion: "keyword a", "keyword b", ... ──
        if (expand === 'true') {
            const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
            // Also add common question words
            const prefixes = [...letters, 'how', 'what', 'why', 'when', 'where', 'is', 'can', 'does', 'best', 'top', 'near', 'cost', 'price', 'free', 'vs'];

            // Run in batches of 8 to be respectful
            const allExpanded = [];
            for (let i = 0; i < prefixes.length; i += 8) {
                const batch = prefixes.slice(i, i + 8);
                const batchResults = await Promise.all(
                    batch.map(letter => fetchSuggestions(`${q} ${letter}`))
                );
                batchResults.forEach(suggestions => {
                    suggestions.forEach(s => {
                        if (!allExpanded.some(e => e.toLowerCase() === s.toLowerCase())) {
                            allExpanded.push(s);
                        }
                    });
                });
            }

            // Also do "question" format: "how to [keyword]", "what is [keyword]"
            const questionPrefixes = [`how to ${q}`, `what is ${q}`, `why ${q}`, `${q} vs`, `best ${q}`, `${q} near me`];
            const questionResults = await Promise.all(
                questionPrefixes.map(qp => fetchSuggestions(qp))
            );
            questionResults.forEach(suggestions => {
                suggestions.forEach(s => {
                    if (!allExpanded.some(e => e.toLowerCase() === s.toLowerCase())) {
                        allExpanded.push(s);
                    }
                });
            });

            results.expanded = allExpanded;
        }

        // ── Categorize suggestions ──
        results.categorized = categorizeSuggestions([...results.suggestions, ...results.expanded]);
        results.totalSuggestions = results.suggestions.length + results.expanded.length;

        return res.json(results);

    } catch (err) {
        return res.json({ error: err.message, suggestions: [], expanded: [] });
    }
}

/**
 * Fetch Google Autocomplete suggestions for a query.
 * Uses the unofficial but stable Firefox client endpoint.
 */
async function fetchSuggestions(query) {
    try {
        const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}&hl=en&gl=us`;
        const resp = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0',
            },
            signal: AbortSignal.timeout(5000),
        });

        if (!resp.ok) return [];

        const data = await resp.json();
        // Response format: ["query", ["suggestion1", "suggestion2", ...]]
        return (data[1] || []).filter(s => typeof s === 'string');

    } catch (_) {
        return [];
    }
}

/**
 * Categorize suggestions into types (questions, comparisons, locations, etc.)
 */
function categorizeSuggestions(suggestions) {
    const categories = {
        questions: [],       // how, what, why, when, where, is, can, does
        comparisons: [],     // vs, versus, or, compared
        commercial: [],      // cost, price, insurance, free, best, top, near me
        informational: [],   // everything else
    };

    suggestions.forEach(s => {
        const lower = s.toLowerCase();
        if (/^(how|what|why|when|where|is|can|does|do|should|will) /i.test(lower) || lower.includes('?')) {
            categories.questions.push(s);
        } else if (/\b(vs|versus|compared|or|difference)\b/i.test(lower)) {
            categories.comparisons.push(s);
        } else if (/\b(cost|price|insurance|free|best|top|near me|cheap|affordable|review|rating)\b/i.test(lower)) {
            categories.commercial.push(s);
        } else {
            categories.informational.push(s);
        }
    });

    return categories;
}
