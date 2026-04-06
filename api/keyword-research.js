/**
 * Vercel Serverless Function — Keyword Research Hub
 * Consolidates 4 keyword endpoints into one routed by ?action= parameter.
 *
 * GET  /api/keyword-research?action=suggest&q=eye+doctor&city=Fredericksburg+VA
 * POST /api/keyword-research?action=gaps    body: { keywords, industry, businessName }
 * POST /api/keyword-research?action=serp    body: { keywords, maxPages }
 * POST /api/keyword-research?action=competitive  body: { targetKeywords, targetDomain, competitors, ... }
 *
 * Default (no action): suggest
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const action = req.query.action || 'suggest';

    switch (action) {
        case 'suggest': return handleGoogleSuggest(req, res);
        case 'gaps': return handleKeywordGaps(req, res);
        case 'serp': return handleSerpKeywords(req, res);
        case 'competitive': return handleCompetitive(req, res);
        default: return res.status(400).json({ error: `Unknown action: ${action}. Use suggest|gaps|serp|competitive` });
    }
}

// ═══════════════════════════════════════════════════
//   ACTION: suggest — Google Autocomplete
// ═══════════════════════════════════════════════════
async function handleGoogleSuggest(req, res) {
    const { q, city, expand } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing q parameter' });

    try {
        const baseQuery = city ? `${q} ${city}` : q;
        const results = { query: baseQuery, suggestions: [], expanded: [] };

        const primary = await fetchSuggestions(baseQuery);
        results.suggestions = primary;

        if (city) {
            const broad = await fetchSuggestions(q);
            const existing = new Set(primary.map(s => s.toLowerCase()));
            broad.forEach(s => { if (!existing.has(s.toLowerCase())) { results.suggestions.push(s); existing.add(s.toLowerCase()); } });
        }

        if (expand === 'true') {
            const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
            const prefixes = [...letters, 'how', 'what', 'why', 'when', 'where', 'is', 'can', 'does', 'best', 'top', 'near', 'cost', 'price', 'free', 'vs'];
            const allExpanded = [];

            for (let i = 0; i < prefixes.length; i += 8) {
                const batch = prefixes.slice(i, i + 8);
                const batchResults = await Promise.all(batch.map(letter => fetchSuggestions(`${q} ${letter}`)));
                batchResults.forEach(suggestions => {
                    suggestions.forEach(s => { if (!allExpanded.some(e => e.toLowerCase() === s.toLowerCase())) allExpanded.push(s); });
                });
            }

            const questionPrefixes = [`how to ${q}`, `what is ${q}`, `why ${q}`, `${q} vs`, `best ${q}`, `${q} near me`];
            const questionResults = await Promise.all(questionPrefixes.map(qp => fetchSuggestions(qp)));
            questionResults.forEach(suggestions => {
                suggestions.forEach(s => { if (!allExpanded.some(e => e.toLowerCase() === s.toLowerCase())) allExpanded.push(s); });
            });

            results.expanded = allExpanded;
        }

        results.categorized = categorizeSuggestions([...results.suggestions, ...results.expanded]);
        results.totalSuggestions = results.suggestions.length + results.expanded.length;
        return res.json(results);
    } catch (err) {
        return res.json({ error: err.message, suggestions: [], expanded: [] });
    }
}

// ═══════════════════════════════════════════════════
//   ACTION: gaps — Datamuse Keyword Gap Discovery
// ═══════════════════════════════════════════════════
async function handleKeywordGaps(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only for action=gaps' });
    const { keywords, industry, businessName } = req.body || {};
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) return res.status(400).json({ error: 'Missing keywords array' });

    try {
        const industryTerms = getIndustryTerms(industry || '');
        const seedTerms = [...new Set([...keywords.slice(0, 5), ...industryTerms.slice(0, 3)])];
        const allSuggestions = [];

        const fetches = seedTerms.flatMap(term => [
            fetch(`https://api.datamuse.com/words?ml=${encodeURIComponent(term)}&max=8`, { signal: AbortSignal.timeout(5000) })
                .then(r => r.json()).then(data => data.map(d => ({ word: d.word, score: d.score, source: 'related', seed: term }))).catch(() => []),
            fetch(`https://api.datamuse.com/words?lc=${encodeURIComponent(term)}&max=5`, { signal: AbortSignal.timeout(5000) })
                .then(r => r.json()).then(data => data.map(d => ({ word: `${term} ${d.word}`, score: d.score, source: 'phrase', seed: term }))).catch(() => []),
        ]);
        const results = await Promise.all(fetches);
        results.forEach(batch => allSuggestions.push(...batch));

        if (industry) {
            const topicFetches = industryTerms.slice(0, 5).map(term =>
                fetch(`https://api.datamuse.com/words?ml=${encodeURIComponent(term)}&max=5`, { signal: AbortSignal.timeout(5000) })
                    .then(r => r.json()).then(data => data.map(d => ({ word: d.word, score: d.score, source: 'industry', seed: term }))).catch(() => [])
            );
            const topicResults = await Promise.all(topicFetches);
            topicResults.forEach(batch => allSuggestions.push(...batch));
        }

        const seen = new Set(keywords.map(k => k.toLowerCase()));
        const uniqueSuggestions = [];
        for (const s of allSuggestions) {
            const lower = s.word.toLowerCase();
            if (seen.has(lower) || lower.length < 3 || /^\d+$/.test(lower)) continue;
            seen.add(lower);
            uniqueSuggestions.push(s);
        }
        uniqueSuggestions.sort((a, b) => (b.score || 0) - (a.score || 0));

        return res.json({
            seedTerms,
            keywordGaps: uniqueSuggestions.filter(s => s.source === 'related' || s.source === 'industry').slice(0, 20)
                .map(s => ({ keyword: s.word, relevance: Math.min(100, Math.round((s.score || 0) / 1000)), source: s.source, seedTerm: s.seed })),
            longTailIdeas: uniqueSuggestions.filter(s => s.source === 'phrase').slice(0, 15)
                .map(s => ({ phrase: s.word, relevance: Math.min(100, Math.round((s.score || 0) / 500)), seedTerm: s.seed })),
            totalSuggestions: uniqueSuggestions.length,
        });
    } catch (err) {
        return res.json({ error: err.message, keywordGaps: [], longTailIdeas: [] });
    }
}

// ═══════════════════════════════════════════════════
//   ACTION: serp — SERP Mining via Apify
// ═══════════════════════════════════════════════════
async function handleSerpKeywords(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only for action=serp' });
    const { keywords, maxPages } = req.body || {};
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) return res.status(400).json({ error: 'Missing keywords array' });

    const APIFY_TOKEN = process.env.APIFY_TOKEN;
    if (!APIFY_TOKEN) return res.json({ error: 'APIFY_TOKEN not configured', peopleAlsoAsk: [], relatedSearches: [] });

    try {
        const actorInput = {
            queries: keywords.slice(0, 5).join('\n'), maxPagesPerQuery: maxPages || 1,
            resultsPerPage: 10, languageCode: 'en', countryCode: 'us', mobileResults: false,
            includeUnfilteredResults: false, saveHtml: false, saveHtmlToKeyValueStore: false,
        };

        const runResp = await fetch(
            `https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=30`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(actorInput), signal: AbortSignal.timeout(45000) }
        );

        if (!runResp.ok) {
            const errText = await runResp.text();
            return res.json({ error: `Apify returned ${runResp.status}: ${errText.slice(0, 200)}`, peopleAlsoAsk: [], relatedSearches: [] });
        }

        const results = await runResp.json();
        const allPAA = [], allRelated = [], allOrganicKeywords = [];

        for (const result of results) {
            if (result.peopleAlsoAsk && Array.isArray(result.peopleAlsoAsk)) {
                result.peopleAlsoAsk.forEach(q => {
                    const question = typeof q === 'string' ? q : q.question || q.title || '';
                    if (question && !allPAA.some(p => p.toLowerCase() === question.toLowerCase())) allPAA.push(question);
                });
            }
            if (result.relatedQueries) {
                const related = result.relatedQueries.items || result.relatedQueries;
                if (Array.isArray(related)) {
                    related.forEach(r => {
                        const term = typeof r === 'string' ? r : r.title || r.query || '';
                        if (term && !allRelated.some(p => p.toLowerCase() === term.toLowerCase())) allRelated.push(term);
                    });
                }
            }
            if (result.organicResults && Array.isArray(result.organicResults)) {
                result.organicResults.forEach(r => {
                    if (r.title) allOrganicKeywords.push({ title: r.title, url: r.url || r.link || '', position: r.position || r.rank || 0, query: result.searchQuery?.term || '' });
                });
            }
        }

        return res.json({
            queriesSearched: keywords.slice(0, 5),
            peopleAlsoAsk: allPAA, paaCategories: categorizePAA(allPAA),
            relatedSearches: allRelated, organicTitleKeywords: extractTitleKeywords(allOrganicKeywords),
            totalPAA: allPAA.length, totalRelated: allRelated.length,
        });
    } catch (err) {
        return res.json({ error: err.message, peopleAlsoAsk: [], relatedSearches: [] });
    }
}

// ═══════════════════════════════════════════════════
//   ACTION: competitive — Competitive Keyword Overlap
// ═══════════════════════════════════════════════════
async function handleCompetitive(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only for action=competitive' });
    const { targetKeywords, targetDomain, competitors, industry, city, state } = req.body || {};
    if (!targetKeywords || !Array.isArray(targetKeywords)) return res.status(400).json({ error: 'Missing targetKeywords array' });

    try {
        const competitorProfiles = [];
        if (competitors && competitors.length > 0) {
            const profiles = await Promise.all(competitors.slice(0, 3).map(d => scrapePageKeywords(d)));
            profiles.forEach((profile, i) => { if (profile) competitorProfiles.push({ domain: competitors[i], ...profile }); });
        }

        const targetSet = new Set(targetKeywords.map(k => k.toLowerCase()));
        const competitorKeywordMap = {};
        competitorProfiles.forEach(profile => {
            (profile.keywords || []).forEach(k => {
                const lower = k.word ? k.word.toLowerCase() : k.toLowerCase();
                if (!competitorKeywordMap[lower]) competitorKeywordMap[lower] = [];
                competitorKeywordMap[lower].push(profile.domain);
            });
        });

        const shared = [], gaps = [], unique = [], opportunities = [];
        for (const [keyword, domains] of Object.entries(competitorKeywordMap)) {
            if (targetSet.has(keyword)) shared.push({ keyword, competitorCount: domains.length, competitors: domains });
            else gaps.push({ keyword, competitorCount: domains.length, competitors: domains, priority: domains.length >= 2 ? 'high' : 'medium' });
        }
        targetKeywords.forEach(k => { const lower = k.toLowerCase ? k.toLowerCase() : k; if (!competitorKeywordMap[lower]) unique.push({ keyword: lower }); });
        gaps.sort((a, b) => b.competitorCount - a.competitorCount);

        if (industry && city) {
            const seedQueries = getOpportunitySeeds(industry, city, state);
            const suggestResults = await Promise.all(seedQueries.slice(0, 6).map(q => fetchSuggestions(q)));
            const existingAll = new Set([...targetSet, ...Object.keys(competitorKeywordMap)]);
            suggestResults.flat().forEach(suggestion => {
                const lower = suggestion.toLowerCase();
                if (!existingAll.has(lower) && lower.length > 3) { opportunities.push({ keyword: suggestion, source: 'google_suggest', reason: 'Not used by target or competitors' }); existingAll.add(lower); }
            });
        }

        const totalCompetitorKeywords = Object.keys(competitorKeywordMap).length;
        const overlapRate = totalCompetitorKeywords > 0 ? Math.round((shared.length / totalCompetitorKeywords) * 100) : 0;
        let competitiveScore;
        if (overlapRate >= 70) competitiveScore = { score: 'Strong', label: 'Your keyword coverage is strong' };
        else if (overlapRate >= 40) competitiveScore = { score: 'Moderate', label: 'Room for improvement in keyword coverage' };
        else competitiveScore = { score: 'Weak', label: 'Significant keyword gaps vs. competitors' };

        return res.json({
            targetDomain: targetDomain || 'unknown', competitorCount: competitorProfiles.length,
            competitors: competitorProfiles.map(p => ({ domain: p.domain, keywordCount: p.keywords?.length || 0, title: p.title || '' })),
            analysis: { sharedKeywords: shared.slice(0, 20), keywordGaps: gaps.slice(0, 25), uniqueToTarget: unique.slice(0, 15), opportunities: opportunities.slice(0, 20) },
            stats: { targetKeywordCount: targetKeywords.length, totalCompetitorKeywords, sharedCount: shared.length, gapCount: gaps.length, uniqueCount: unique.length, overlapRate },
            competitiveScore,
        });
    } catch (err) {
        return res.json({ error: err.message, analysis: { sharedKeywords: [], keywordGaps: [], uniqueToTarget: [], opportunities: [] } });
    }
}

// ═══════════════════════════════════════════════════
//   SHARED HELPERS
// ═══════════════════════════════════════════════════

async function fetchSuggestions(query) {
    try {
        const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}&hl=en&gl=us`;
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0' }, signal: AbortSignal.timeout(5000) });
        if (!resp.ok) return [];
        const data = await resp.json();
        return (data[1] || []).filter(s => typeof s === 'string');
    } catch (_) { return []; }
}

function categorizeSuggestions(suggestions) {
    const categories = { questions: [], comparisons: [], commercial: [], informational: [] };
    suggestions.forEach(s => {
        const lower = s.toLowerCase();
        if (/^(how|what|why|when|where|is|can|does|do|should|will) /i.test(lower) || lower.includes('?')) categories.questions.push(s);
        else if (/\b(vs|versus|compared|or|difference)\b/i.test(lower)) categories.comparisons.push(s);
        else if (/\b(cost|price|insurance|free|best|top|near me|cheap|affordable|review|rating)\b/i.test(lower)) categories.commercial.push(s);
        else categories.informational.push(s);
    });
    return categories;
}

function categorizePAA(questions) {
    const categories = { informational: [], commercial: [], navigational: [], transactional: [] };
    questions.forEach(q => {
        const lower = q.toLowerCase();
        if (/\b(cost|price|insurance|worth|afford|cheap|expensive|pay|fee|much)\b/.test(lower)) categories.commercial.push(q);
        else if (/\b(near me|in my|location|closest|nearby|area|local)\b/.test(lower)) categories.navigational.push(q);
        else if (/\b(book|schedule|appointment|buy|order|sign up|get started|find a)\b/.test(lower)) categories.transactional.push(q);
        else categories.informational.push(q);
    });
    return categories;
}

function extractTitleKeywords(organicResults) {
    const wordFreq = {};
    const stopWords = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','is','it','as','be','are','was','this','that','your','you','we','our','their','his','her','all','can','has','had','will','do','did','not','no','so','if','up','out','about','just','into','than','them','then','its','my','more','some','any','how','what','when','who']);
    organicResults.forEach(r => {
        r.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).forEach(word => {
            if (word.length > 2 && !stopWords.has(word)) wordFreq[word] = (wordFreq[word] || 0) + 1;
        });
    });
    return Object.entries(wordFreq).sort(([,a],[,b]) => b - a).slice(0, 25).map(([word, count]) => ({ word, count }));
}

function getIndustryTerms(industry) {
    const terms = {
        optometry: ['eye exam','vision','glasses','contacts','optometrist','dry eye','myopia'],
        ophthalmology: ['eye surgery','cataract','lasik','retina','glaucoma','ophthalmologist'],
        multi_eye: ['eye care','vision','eye doctor','cataract','contacts','glasses'],
        dental: ['dentist','teeth','dental','orthodontist','braces','implants','whitening'],
        chiropractic: ['chiropractor','spine','back pain','adjustment','wellness','posture'],
        dermatology: ['dermatologist','skin','acne','botox','cosmetic','laser','eczema'],
        medical_general: ['doctor','physician','primary care','family medicine','clinic','health'],
        legal: ['lawyer','attorney','legal','law firm','litigation','counsel','dispute'],
        accounting: ['accountant','CPA','tax','bookkeeping','audit','financial'],
        restaurant: ['restaurant','dining','food','menu','catering','reservations'],
        real_estate: ['realtor','real estate','home','property','listing','mortgage'],
        home_services: ['plumber','HVAC','electrician','repair','contractor','installation'],
        auto: ['auto repair','mechanic','car','oil change','brake','tire'],
        fitness: ['gym','fitness','personal trainer','workout','yoga','health club'],
        salon: ['salon','spa','haircut','massage','beauty','facial','nail'],
        veterinary: ['veterinarian','vet','pet','animal hospital','dog','cat'],
        ecommerce: ['shop','buy','store','product','sale','discount','shipping'],
        saas: ['software','platform','tool','solution','cloud','integration','API'],
    };
    return terms[industry] || [];
}

function getOpportunitySeeds(industry, city, state) {
    const location = state ? `${city} ${state}` : city;
    const industryQueries = {
        optometry: [`best optometrist ${location}`,`eye exam ${location}`,`glasses ${location}`,`contacts ${location}`,`dry eye treatment ${location}`,`pediatric eye doctor ${location}`],
        ophthalmology: [`eye surgeon ${location}`,`cataract surgery ${location}`,`lasik ${location}`,`retina specialist ${location}`,`glaucoma doctor ${location}`],
        dental: [`best dentist ${location}`,`dental implants ${location}`,`teeth whitening ${location}`,`emergency dentist ${location}`],
        chiropractic: [`chiropractor ${location}`,`back pain ${location}`,`spinal adjustment ${location}`,`neck pain ${location}`],
        dermatology: [`dermatologist ${location}`,`skin doctor ${location}`,`acne treatment ${location}`,`botox ${location}`],
        medical_general: [`doctor ${location}`,`primary care ${location}`,`family doctor ${location}`,`urgent care ${location}`],
        legal: [`lawyer ${location}`,`attorney ${location}`,`law firm ${location}`,`legal help ${location}`],
        real_estate: [`homes for sale ${location}`,`realtor ${location}`,`real estate agent ${location}`],
        home_services: [`plumber ${location}`,`electrician ${location}`,`HVAC ${location}`,`handyman ${location}`],
        auto: [`auto repair ${location}`,`mechanic ${location}`,`oil change ${location}`,`tire shop ${location}`],
        fitness: [`gym ${location}`,`personal trainer ${location}`,`yoga ${location}`,`fitness center ${location}`],
        salon: [`hair salon ${location}`,`spa ${location}`,`massage ${location}`,`nail salon ${location}`],
        veterinary: [`vet ${location}`,`animal hospital ${location}`,`pet clinic ${location}`,`emergency vet ${location}`],
    };
    return industryQueries[industry] || [`best ${industry} ${location}`, `${industry} near me ${location}`];
}

async function scrapePageKeywords(domain) {
    try {
        const resp = await fetch(`https://${domain}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
            signal: AbortSignal.timeout(8000), redirect: 'follow',
        });
        if (!resp.ok) return null;
        const html = await resp.text();
        const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
        const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
        const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/is) || html.match(/<meta[^>]*content=["'](.*?)["'][^>]*name=["']description["']/is);
        const description = descMatch ? descMatch[1] : '';
        const kwMatch = html.match(/<meta[^>]*name=["']keywords["'][^>]*content=["'](.*?)["']/is);
        const metaKeywords = kwMatch ? kwMatch[1].split(',').map(k => k.trim()).filter(Boolean) : [];
        const headings = [];
        const hRegex = /<h[1-3][^>]*>(.*?)<\/h[1-3]>/gis;
        let hMatch;
        while ((hMatch = hRegex.exec(html)) !== null) headings.push(hMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());

        const allText = [title, description, ...headings, ...metaKeywords].join(' ');
        const words = allText.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
        const stopWords = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','is','it','as','be','are','was','this','that','your','you','we','our','their','all','can','has','had','will','do','not','so','if','up','out','about']);
        const freq = {};
        words.forEach(w => { if (w.length > 2 && !stopWords.has(w)) freq[w] = (freq[w] || 0) + 1; });
        for (let i = 0; i < words.length - 1; i++) {
            if (words[i].length > 2 && words[i+1].length > 2 && !stopWords.has(words[i]) && !stopWords.has(words[i+1])) {
                const bigram = `${words[i]} ${words[i+1]}`; freq[bigram] = (freq[bigram] || 0) + 1;
            }
        }
        const keywords = Object.entries(freq).sort(([,a],[,b]) => b - a).slice(0, 30).map(([word, count]) => ({ word, count }));
        return { title, description, keywords, metaKeywords, headingCount: headings.length };
    } catch (_) { return null; }
}
