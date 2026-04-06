/**
 * Vercel Serverless Function — Competitive Keyword Analysis
 * Compares the target site's keywords against competitors found via Google SERP.
 * Identifies keyword overlap, gaps, and opportunities.
 *
 * Uses site-audit keyword extraction + Google Suggest to build competitor profiles.
 * Fully free — no API key needed.
 *
 * POST /api/competitive-keywords
 * Body: {
 *   targetKeywords: ["eye exam", "vision care", ...],
 *   targetDomain: "mysite.com",
 *   competitors: ["competitor1.com", "competitor2.com"],
 *   industry: "optometry",
 *   city: "Fredericksburg",
 *   state: "VA"
 * }
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const { targetKeywords, targetDomain, competitors, industry, city, state } = req.body || {};

    if (!targetKeywords || !Array.isArray(targetKeywords)) {
        return res.status(400).json({ error: 'Missing targetKeywords array' });
    }

    try {
        // ── Step 1: Scrape competitor pages for their keywords ──
        const competitorProfiles = [];

        if (competitors && competitors.length > 0) {
            const scrapePromises = competitors.slice(0, 3).map(domain =>
                scrapePageKeywords(domain)
            );
            const profiles = await Promise.all(scrapePromises);
            profiles.forEach((profile, i) => {
                if (profile) {
                    competitorProfiles.push({
                        domain: competitors[i],
                        ...profile,
                    });
                }
            });
        }

        // ── Step 2: Build comprehensive keyword universe ──
        const targetSet = new Set(targetKeywords.map(k => k.toLowerCase()));
        const competitorKeywordMap = {}; // keyword → which competitors have it

        competitorProfiles.forEach(profile => {
            (profile.keywords || []).forEach(k => {
                const lower = k.word ? k.word.toLowerCase() : k.toLowerCase();
                if (!competitorKeywordMap[lower]) {
                    competitorKeywordMap[lower] = [];
                }
                competitorKeywordMap[lower].push(profile.domain);
            });
        });

        // ── Step 3: Classify keywords ──
        const shared = [];      // Both target and competitors have
        const gaps = [];        // Competitors have, target doesn't
        const unique = [];      // Only target has
        const opportunities = []; // High-value keywords target is missing

        // Find shared and gaps
        for (const [keyword, domains] of Object.entries(competitorKeywordMap)) {
            if (targetSet.has(keyword)) {
                shared.push({
                    keyword,
                    competitorCount: domains.length,
                    competitors: domains,
                });
            } else {
                gaps.push({
                    keyword,
                    competitorCount: domains.length,
                    competitors: domains,
                    priority: domains.length >= 2 ? 'high' : 'medium',
                });
            }
        }

        // Find unique target keywords
        targetKeywords.forEach(k => {
            const lower = k.toLowerCase ? k.toLowerCase() : k;
            if (!competitorKeywordMap[lower]) {
                unique.push({ keyword: lower });
            }
        });

        // Sort gaps by how many competitors use them (higher = more important to have)
        gaps.sort((a, b) => b.competitorCount - a.competitorCount);

        // ── Step 4: Get industry-specific opportunity keywords from Google Suggest ──
        if (industry && city) {
            const seedQueries = getOpportunitySeeds(industry, city, state);
            const suggestPromises = seedQueries.slice(0, 6).map(q =>
                fetchGoogleSuggestions(q)
            );
            const suggestResults = await Promise.all(suggestPromises);
            const existingAll = new Set([
                ...targetSet,
                ...Object.keys(competitorKeywordMap),
            ]);

            suggestResults.flat().forEach(suggestion => {
                const lower = suggestion.toLowerCase();
                if (!existingAll.has(lower) && lower.length > 3) {
                    opportunities.push({
                        keyword: suggestion,
                        source: 'google_suggest',
                        reason: 'Not used by target or competitors',
                    });
                    existingAll.add(lower);
                }
            });
        }

        // ── Step 5: Calculate competitive score ──
        const totalCompetitorKeywords = Object.keys(competitorKeywordMap).length;
        const overlapRate = totalCompetitorKeywords > 0
            ? Math.round((shared.length / totalCompetitorKeywords) * 100)
            : 0;

        let competitiveScore;
        if (overlapRate >= 70) competitiveScore = { score: 'Strong', label: 'Your keyword coverage is strong' };
        else if (overlapRate >= 40) competitiveScore = { score: 'Moderate', label: 'Room for improvement in keyword coverage' };
        else competitiveScore = { score: 'Weak', label: 'Significant keyword gaps vs. competitors' };

        return res.json({
            targetDomain: targetDomain || 'unknown',
            competitorCount: competitorProfiles.length,
            competitors: competitorProfiles.map(p => ({
                domain: p.domain,
                keywordCount: p.keywords?.length || 0,
                title: p.title || '',
            })),
            analysis: {
                sharedKeywords: shared.slice(0, 20),
                keywordGaps: gaps.slice(0, 25),
                uniqueToTarget: unique.slice(0, 15),
                opportunities: opportunities.slice(0, 20),
            },
            stats: {
                targetKeywordCount: targetKeywords.length,
                totalCompetitorKeywords,
                sharedCount: shared.length,
                gapCount: gaps.length,
                uniqueCount: unique.length,
                overlapRate,
            },
            competitiveScore,
        });

    } catch (err) {
        return res.json({
            error: err.message,
            analysis: { sharedKeywords: [], keywordGaps: [], uniqueToTarget: [], opportunities: [] },
        });
    }
}

/**
 * Scrape a competitor's homepage and extract keywords from meta + content
 */
async function scrapePageKeywords(domain) {
    try {
        const resp = await fetch(`https://${domain}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            signal: AbortSignal.timeout(8000),
            redirect: 'follow',
        });

        if (!resp.ok) return null;

        const html = await resp.text();

        // Extract title
        const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
        const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

        // Extract meta description
        const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/is)
            || html.match(/<meta[^>]*content=["'](.*?)["'][^>]*name=["']description["']/is);
        const description = descMatch ? descMatch[1] : '';

        // Extract meta keywords
        const kwMatch = html.match(/<meta[^>]*name=["']keywords["'][^>]*content=["'](.*?)["']/is);
        const metaKeywords = kwMatch ? kwMatch[1].split(',').map(k => k.trim()).filter(Boolean) : [];

        // Extract heading text
        const headings = [];
        const hRegex = /<h[1-3][^>]*>(.*?)<\/h[1-3]>/gis;
        let hMatch;
        while ((hMatch = hRegex.exec(html)) !== null) {
            headings.push(hMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
        }

        // Simple keyword extraction from title + description + headings
        const allText = [title, description, ...headings, ...metaKeywords].join(' ');
        const words = allText.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
        const stopWords = new Set([
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
            'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'are', 'was',
            'this', 'that', 'your', 'you', 'we', 'our', 'their', 'all', 'can',
            'has', 'had', 'will', 'do', 'not', 'so', 'if', 'up', 'out', 'about',
        ]);

        const freq = {};
        words.forEach(w => {
            if (w.length > 2 && !stopWords.has(w)) {
                freq[w] = (freq[w] || 0) + 1;
            }
        });

        // Also extract bigrams
        for (let i = 0; i < words.length - 1; i++) {
            if (words[i].length > 2 && words[i + 1].length > 2
                && !stopWords.has(words[i]) && !stopWords.has(words[i + 1])) {
                const bigram = `${words[i]} ${words[i + 1]}`;
                freq[bigram] = (freq[bigram] || 0) + 1;
            }
        }

        const keywords = Object.entries(freq)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 30)
            .map(([word, count]) => ({ word, count }));

        return { title, description, keywords, metaKeywords, headingCount: headings.length };
    } catch (_) {
        return null;
    }
}

/**
 * Fetch Google Autocomplete suggestions
 */
async function fetchGoogleSuggestions(query) {
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
        return (data[1] || []).filter(s => typeof s === 'string');
    } catch (_) {
        return [];
    }
}

/**
 * Generate opportunity seed queries based on industry and location
 */
function getOpportunitySeeds(industry, city, state) {
    const location = state ? `${city} ${state}` : city;

    const industryQueries = {
        optometry: [`best optometrist ${location}`, `eye exam ${location}`, `glasses ${location}`, `contacts ${location}`, `dry eye treatment ${location}`, `pediatric eye doctor ${location}`],
        ophthalmology: [`eye surgeon ${location}`, `cataract surgery ${location}`, `lasik ${location}`, `retina specialist ${location}`, `glaucoma doctor ${location}`],
        multi_eye: [`eye care ${location}`, `eye doctor ${location}`, `vision center ${location}`, `eye specialist ${location}`],
        dental: [`best dentist ${location}`, `dental implants ${location}`, `teeth whitening ${location}`, `emergency dentist ${location}`],
        chiropractic: [`chiropractor ${location}`, `back pain ${location}`, `spinal adjustment ${location}`, `neck pain ${location}`],
        dermatology: [`dermatologist ${location}`, `skin doctor ${location}`, `acne treatment ${location}`, `botox ${location}`],
        medical_general: [`doctor ${location}`, `primary care ${location}`, `family doctor ${location}`, `urgent care ${location}`],
        legal: [`lawyer ${location}`, `attorney ${location}`, `law firm ${location}`, `legal help ${location}`],
        accounting: [`accountant ${location}`, `CPA ${location}`, `tax preparation ${location}`, `bookkeeper ${location}`],
        restaurant: [`best restaurants ${location}`, `food delivery ${location}`, `catering ${location}`, `dining ${location}`],
        real_estate: [`homes for sale ${location}`, `realtor ${location}`, `real estate agent ${location}`, `houses ${location}`],
        home_services: [`plumber ${location}`, `electrician ${location}`, `HVAC ${location}`, `handyman ${location}`],
        auto: [`auto repair ${location}`, `mechanic ${location}`, `oil change ${location}`, `tire shop ${location}`],
        fitness: [`gym ${location}`, `personal trainer ${location}`, `yoga ${location}`, `fitness center ${location}`],
        salon: [`hair salon ${location}`, `spa ${location}`, `massage ${location}`, `nail salon ${location}`],
        veterinary: [`vet ${location}`, `animal hospital ${location}`, `pet clinic ${location}`, `emergency vet ${location}`],
        ecommerce: [`buy online ${location}`, `shop local ${location}`, `delivery ${location}`],
        saas: [`best software ${location}`, `business tools ${location}`, `cloud platform ${location}`],
    };

    return industryQueries[industry] || [`best ${industry} ${location}`, `${industry} near me ${location}`];
}
