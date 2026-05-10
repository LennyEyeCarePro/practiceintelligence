/**
 * Vercel Serverless Function — Query Scans from Supabase
 *
 * GET /api/get-scans                         → list all scans (summary)
 * GET /api/get-scans?id=<uuid>               → full scan detail + pages + backlinks + keywords
 * GET /api/get-scans?domain=example.com      → scans for a specific domain
 *
 * Requires env vars: SUPABASE_URL, SUPABASE_KEY
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return res.status(500).json({ error: 'SUPABASE_URL and SUPABASE_KEY not configured' });
    }

    const { id, domain } = req.query;

    try {
        // ── Single scan detail ──
        if (id) {
            const scan = await supabaseGet(SUPABASE_URL, SUPABASE_KEY,
                `scans?id=eq.${id}&select=*`);
            if (!scan.length) return res.status(404).json({ error: 'Scan not found' });

            const [pages, backlinks, keywords] = await Promise.all([
                supabaseGet(SUPABASE_URL, SUPABASE_KEY,
                    `scan_pages?scan_id=eq.${id}&select=url,slug,status_code,in_sitemap,title,title_length,meta_description,meta_description_length,h1,word_count,internal_link_count,external_link_count,image_count,images_without_alt,og_title,og_image,text_preview&order=slug.asc`),
                supabaseGet(SUPABASE_URL, SUPABASE_KEY,
                    `scan_backlinks?scan_id=eq.${id}&select=url,source_domain,anchor_text,title,link_type,is_toxic,toxic_reason,is_nofollow,first_seen,domain_inlink_rank&order=domain_inlink_rank.desc.nullslast`),
                supabaseGet(SUPABASE_URL, SUPABASE_KEY,
                    `scan_keywords?scan_id=eq.${id}&select=keyword,source,search_volume,difficulty,cpc,position&order=search_volume.desc.nullslast`),
            ]);

            return res.json({
                scan: scan[0],
                pages,
                backlinks,
                keywords,
            });
        }

        // ── List scans (optionally filtered by domain) ──
        let query = `scans?select=id,created_at,domain,business_name,overall_score,grade,headline,score_page_speed,score_on_page_seo,score_local_gbp,score_backlinks,score_technical,crawler_blocked,backlinks_total,backlinks_toxic,crawl_pages_found,crawl_total_words,broken_links_total,lh_performance,page_rank,moz_da&order=created_at.desc&limit=100`;

        if (domain) {
            query += `&domain=eq.${encodeURIComponent(domain)}`;
        }

        const scans = await supabaseGet(SUPABASE_URL, SUPABASE_KEY, query);

        return res.json({ scans });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

async function supabaseGet(url, key, query) {
    const resp = await fetch(`${url}/rest/v1/${query}`, {
        headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
        },
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`Supabase query failed (${resp.status}): ${errText.slice(0, 200)}`);
    }

    return resp.json();
}
