/**
 * Vercel Serverless Function — Save Scan to Supabase
 * Persists the complete scanData object from seo-tool.html.
 *
 * POST /api/save-scan  { ...scanData }
 * Returns { scanId, pageCount, backlinkCount }
 *
 * Requires env vars: SUPABASE_URL, SUPABASE_KEY (service_role key)
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ error: 'SUPABASE_URL and SUPABASE_KEY not configured' });
    }

    const data = req.body;
    if (!data || !data.domain) {
        return res.status(400).json({ error: 'Missing scan data' });
    }

    try {
        const report = data.report || {};
        const pillars = report.pillarScores || {};
        const mobile = data.lighthouse?.mobile || {};
        const desktop = data.lighthouse?.desktop || {};
        const audit = data.siteAudit || {};
        const pr = data.pageRank || {};
        const mozData = data.moz || {};
        const places = data.places || {};
        const biz = places.locations?.[0] || places.business || {};
        const sb = data.safeBrowsing || {};
        const sslData = data.ssl || {};
        const bl = data.backlinks || {};
        const blStats = bl.stats || {};
        const crawl = data.crawl || {};
        const crawlStats = crawl.crawlStats || {};
        const brokenLinks = data.brokenLinks || {};
        const brokenStats = brokenLinks.stats || {};

        // ── 1. Insert main scan record ──────────────────
        const scanRow = {
            domain: data.domain,
            business_name: data.businessName || biz.name || null,
            scan_url: `https://${data.domain}`,

            overall_score: report.overallScore ?? null,
            grade: report.grade || null,
            headline: report.headline || null,

            score_page_speed: pillars.pageSpeed ?? null,
            score_on_page_seo: pillars.onPageSeo ?? null,
            score_local_gbp: pillars.localGbp ?? null,
            score_backlinks: pillars.backlinks ?? null,
            score_technical: pillars.technical ?? null,

            crawler_blocked: report.crawlerBlocked || false,

            lh_performance: mobile.performance ?? null,
            lh_accessibility: mobile.accessibility ?? null,
            lh_best_practices: mobile.bestPractices ?? null,
            lh_seo: mobile.seo ?? null,
            lh_fcp: mobile.fcp ?? null,
            lh_lcp: mobile.lcp ?? null,
            lh_tbt: mobile.tbt ?? null,
            lh_cls: mobile.cls ?? null,
            lh_speed_index: mobile.speedIndex ?? null,

            lh_desktop_performance: desktop.performance ?? null,
            lh_desktop_fcp: desktop.fcp ?? null,
            lh_desktop_lcp: desktop.lcp ?? null,

            page_rank: pr.pageRank ?? null,
            moz_da: mozData.domainAuthority ?? null,
            moz_pa: mozData.pageAuthority ?? null,
            moz_spam_score: mozData.spamScore ?? null,

            ssl_valid: audit.ssl ?? null,
            has_sitemap: audit.hasSitemap ?? null,
            has_robots: audit.hasRobots ?? null,
            has_schema: audit.hasSchemaMarkup ?? null,
            has_local_schema: audit.hasLocalBusinessSchema ?? null,
            has_viewport: audit.hasViewport ?? null,
            blocks_googlebot: audit.blocksGooglebot ?? null,

            title_tag: audit.titleTag || null,
            meta_description: audit.metaDescription || null,
            canonical_url: audit.canonical || null,
            h1_count: audit.h1Count ?? null,
            image_count: audit.imageCount ?? null,
            images_without_alt: audit.imagesWithoutAlt ?? null,

            gbp_name: biz.name || null,
            gbp_rating: biz.rating ?? null,
            gbp_review_count: biz.reviewCount ?? biz.user_ratings_total ?? null,
            gbp_address: biz.address || biz.formatted_address || null,
            gbp_phone: biz.phone || biz.formatted_phone_number || null,
            gbp_website: biz.website || null,
            gbp_place_id: biz.place_id || null,
            gbp_categories: biz.types || biz.categories || null,

            ssl_grade: sslData.grade || null,
            ssl_details: sslData.details || null,

            safe_browsing_safe: sb.safe ?? null,
            safe_browsing_threats: sb.threats || null,

            backlinks_total: blStats.totalBacklinks ?? blStats.totalDiscovered ?? null,
            backlinks_dofollow: blStats.totalDoFollow ?? null,
            backlinks_domains: blStats.totalDomains ?? null,
            backlinks_toxic: blStats.toxicCount ?? null,
            backlinks_health: blStats.healthScore ?? null,

            crawl_pages_found: crawlStats.pagesFound ?? null,
            crawl_sitemap_urls: crawlStats.sitemapUrls ?? null,
            crawl_total_words: crawlStats.totalWords ?? null,
            crawl_avg_words: crawlStats.avgWordsPerPage ?? null,
            crawl_thin_pages: crawl.seoIssues?.thinPages ?? null,
            crawl_duration: crawlStats.duration || null,

            broken_links_total: brokenStats.broken ?? null,
            broken_links_health: brokenStats.linkHealth ?? null,

            ai_report: report || null,
            raw_lighthouse: data.lighthouse || null,
            raw_site_audit: audit || null,
            raw_backlinks: bl || null,
            raw_keywords: {
                suggestions: data.keywordSuggestions || null,
                googleSuggest: data.googleSuggest || null,
                serp: data.serpKeywords || null,
                competitive: data.competitiveKeywords || null,
            },
            raw_places: places || null,
        };

        const scanResp = await supabaseInsert(SUPABASE_URL, SUPABASE_KEY, 'scans', scanRow);

        if (scanResp.error) {
            return res.status(500).json({ error: 'Failed to save scan', details: scanResp.error });
        }

        const scanId = scanResp.data?.[0]?.id;
        if (!scanId) {
            return res.status(500).json({ error: 'Scan saved but no ID returned', details: scanResp });
        }

        // ── 2. Insert crawled pages ─────────────────────
        let pageCount = 0;
        const crawlPages = crawl.pages || [];
        if (crawlPages.length > 0) {
            // Batch insert in chunks of 50
            const pageRows = crawlPages.map(p => ({
                scan_id: scanId,
                url: p.url || '',
                slug: p.slug || '/',
                status_code: p.statusCode ?? null,
                in_sitemap: p.inSitemap || false,
                title: p.title || null,
                title_length: p.titleLength ?? null,
                meta_description: p.metaDescription || null,
                meta_description_length: p.metaDescriptionLength ?? null,
                meta_keywords: p.metaKeywords || null,
                canonical: p.canonical || null,
                robots: p.robots || null,
                og_title: p.og?.title || null,
                og_description: p.og?.description || null,
                og_image: p.og?.image || null,
                og_type: p.og?.type || null,
                h1: p.h1 || null,
                h2: p.h2 || null,
                h3: p.h3 || null,
                word_count: p.wordCount ?? 0,
                text_content: p.textContent || null,
                text_preview: p.textPreview || null,
                internal_link_count: p.internalLinkCount ?? 0,
                external_link_count: p.externalLinkCount ?? 0,
                external_links: p.externalLinks || null,
                image_count: p.imageCount ?? 0,
                images_without_alt: p.imagesWithoutAlt ?? 0,
            }));

            for (let i = 0; i < pageRows.length; i += 50) {
                const chunk = pageRows.slice(i, i + 50);
                const pageResp = await supabaseInsert(SUPABASE_URL, SUPABASE_KEY, 'scan_pages', chunk);
                if (!pageResp.error) pageCount += chunk.length;
            }
        }

        // ── 3. Insert backlinks ─────────────────────────
        let backlinkCount = 0;
        const allBacklinks = [
            ...(bl.backlinks || []),
            ...(bl.toxicBacklinks || []).filter(b => {
                // Avoid duplicates with main backlinks list
                const mainUrls = new Set((bl.backlinks || []).map(x => x.url));
                return !mainUrls.has(b.url);
            }),
        ];

        if (allBacklinks.length > 0) {
            const blRows = allBacklinks.map(b => ({
                scan_id: scanId,
                url: b.url || null,
                target_url: b.targetUrl || null,
                source_domain: b.source || null,
                anchor_text: b.anchor || null,
                title: b.title || null,
                link_type: b.type || 'top',
                is_toxic: b.toxic || false,
                toxic_reason: b.toxicReason || null,
                is_nofollow: b.nofollow ?? null,
                first_seen: b.firstSeen || null,
                last_visited: b.lastVisited || null,
                inlink_rank: b.inlinkRank ?? null,
                domain_inlink_rank: b.domainInlinkRank ?? null,
            }));

            for (let i = 0; i < blRows.length; i += 50) {
                const chunk = blRows.slice(i, i + 50);
                const blResp = await supabaseInsert(SUPABASE_URL, SUPABASE_KEY, 'scan_backlinks', chunk);
                if (!blResp.error) backlinkCount += chunk.length;
            }
        }

        // ── 4. Insert keywords ──────────────────────────
        let keywordCount = 0;
        const keywordRows = [];

        // Keyword suggestions
        (data.keywordSuggestions?.keywords || []).forEach(k => {
            keywordRows.push({
                scan_id: scanId,
                keyword: k.keyword || k,
                source: 'suggestion',
                search_volume: k.searchVolume ?? null,
                difficulty: k.difficulty ?? null,
                cpc: k.cpc ?? null,
                metadata: typeof k === 'object' ? k : null,
            });
        });

        // Google Suggest
        (data.googleSuggest?.suggestions || []).forEach(s => {
            keywordRows.push({
                scan_id: scanId,
                keyword: typeof s === 'string' ? s : s.keyword || s.query || '',
                source: 'google_suggest',
                metadata: typeof s === 'object' ? s : null,
            });
        });

        // SERP keywords
        (data.serpKeywords?.keywords || data.serpKeywords || []).forEach(k => {
            if (typeof k === 'object' && k.keyword) {
                keywordRows.push({
                    scan_id: scanId,
                    keyword: k.keyword,
                    source: 'serp',
                    position: k.position ?? null,
                    url: k.url || null,
                    search_volume: k.searchVolume ?? null,
                    metadata: k,
                });
            }
        });

        if (keywordRows.length > 0) {
            for (let i = 0; i < keywordRows.length; i += 50) {
                const chunk = keywordRows.slice(i, i + 50);
                const kwResp = await supabaseInsert(SUPABASE_URL, SUPABASE_KEY, 'scan_keywords', chunk);
                if (!kwResp.error) keywordCount += chunk.length;
            }
        }

        return res.json({
            success: true,
            scanId,
            saved: {
                pages: pageCount,
                backlinks: backlinkCount,
                keywords: keywordCount,
            },
        });

    } catch (err) {
        console.error('Save scan error:', err);
        return res.status(500).json({ error: err.message });
    }
}


/**
 * Helper — insert row(s) into a Supabase table via REST API
 */
async function supabaseInsert(url, key, table, data) {
    const rows = Array.isArray(data) ? data : [data];

    const resp = await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Prefer': 'return=representation',
        },
        body: JSON.stringify(rows),
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        return { error: `Supabase ${table} insert failed (${resp.status}): ${errText.slice(0, 300)}` };
    }

    const result = await resp.json();
    return { data: result };
}
