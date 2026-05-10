-- ═══════════════════════════════════════════════════════════════
--  Practice Intelligence — Supabase Schema
--  Stores complete SEO scan data for external program consumption.
--  Run this in Supabase SQL Editor to create all tables.
-- ═══════════════════════════════════════════════════════════════

-- ─── SCANS (one row per audit run) ─────────────────────────
CREATE TABLE IF NOT EXISTS scans (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at      TIMESTAMPTZ DEFAULT now(),

    -- Identity
    domain          TEXT NOT NULL,
    business_name   TEXT,
    scan_url        TEXT,

    -- Overall scores
    overall_score   INTEGER,
    grade           TEXT,
    headline        TEXT,

    -- Pillar scores (0-100, null if unavailable)
    score_page_speed    INTEGER,
    score_on_page_seo   INTEGER,
    score_local_gbp     INTEGER,
    score_backlinks     INTEGER,
    score_technical     INTEGER,

    -- Crawler status
    crawler_blocked BOOLEAN DEFAULT false,

    -- Lighthouse performance (mobile)
    lh_performance      INTEGER,
    lh_accessibility     INTEGER,
    lh_best_practices   INTEGER,
    lh_seo              INTEGER,
    lh_fcp              REAL,
    lh_lcp              REAL,
    lh_tbt              REAL,
    lh_cls              REAL,
    lh_speed_index      REAL,

    -- Lighthouse desktop
    lh_desktop_performance  INTEGER,
    lh_desktop_fcp          REAL,
    lh_desktop_lcp          REAL,

    -- PageRank / Authority
    page_rank       INTEGER,
    moz_da          INTEGER,
    moz_pa          INTEGER,
    moz_spam_score  REAL,

    -- Site audit basics
    ssl_valid       BOOLEAN,
    has_sitemap     BOOLEAN,
    has_robots      BOOLEAN,
    has_schema      BOOLEAN,
    has_local_schema BOOLEAN,
    has_viewport    BOOLEAN,
    blocks_googlebot BOOLEAN,

    -- Site audit meta
    title_tag       TEXT,
    meta_description TEXT,
    canonical_url   TEXT,
    h1_count        INTEGER,
    image_count     INTEGER,
    images_without_alt INTEGER,

    -- Google Business Profile
    gbp_name        TEXT,
    gbp_rating      REAL,
    gbp_review_count INTEGER,
    gbp_address     TEXT,
    gbp_phone       TEXT,
    gbp_website     TEXT,
    gbp_place_id    TEXT,
    gbp_categories  JSONB,

    -- SSL Labs
    ssl_grade       TEXT,
    ssl_details     JSONB,

    -- Safe Browsing
    safe_browsing_safe BOOLEAN,
    safe_browsing_threats JSONB,

    -- Backlink summary
    backlinks_total     INTEGER,
    backlinks_dofollow  INTEGER,
    backlinks_domains   INTEGER,
    backlinks_toxic     INTEGER,
    backlinks_health    INTEGER,

    -- Crawl summary
    crawl_pages_found   INTEGER,
    crawl_sitemap_urls  INTEGER,
    crawl_total_words   INTEGER,
    crawl_avg_words     INTEGER,
    crawl_thin_pages    INTEGER,
    crawl_duration      TEXT,

    -- Broken links summary
    broken_links_total  INTEGER,
    broken_links_health INTEGER,

    -- AI report (full JSON)
    ai_report       JSONB,

    -- Raw data blobs for anything the consuming program needs
    raw_lighthouse  JSONB,
    raw_site_audit  JSONB,
    raw_backlinks   JSONB,
    raw_keywords    JSONB,
    raw_places      JSONB
);

-- Index for querying by domain and date
CREATE INDEX IF NOT EXISTS idx_scans_domain ON scans (domain);
CREATE INDEX IF NOT EXISTS idx_scans_created ON scans (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scans_domain_date ON scans (domain, created_at DESC);


-- ─── SCAN PAGES (per-page crawl data) ─────────────────────
CREATE TABLE IF NOT EXISTS scan_pages (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    scan_id         UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ DEFAULT now(),

    -- Page identity
    url             TEXT NOT NULL,
    slug            TEXT,
    status_code     INTEGER,
    in_sitemap      BOOLEAN DEFAULT false,

    -- Metadata
    title           TEXT,
    title_length    INTEGER,
    meta_description TEXT,
    meta_description_length INTEGER,
    meta_keywords   TEXT,
    canonical       TEXT,
    robots          TEXT,

    -- Open Graph
    og_title        TEXT,
    og_description  TEXT,
    og_image        TEXT,
    og_type         TEXT,

    -- Headings
    h1              JSONB,  -- array of strings
    h2              JSONB,
    h3              JSONB,

    -- Content
    word_count      INTEGER,
    text_content    TEXT,    -- full extracted text (up to 5000 chars)
    text_preview    TEXT,    -- first 300 chars

    -- Links
    internal_link_count  INTEGER,
    external_link_count  INTEGER,
    external_links       JSONB,  -- array of domain strings

    -- Images
    image_count          INTEGER,
    images_without_alt   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_scan_pages_scan ON scan_pages (scan_id);
CREATE INDEX IF NOT EXISTS idx_scan_pages_slug ON scan_pages (scan_id, slug);


-- ─── SCAN BACKLINKS (individual backlink records) ──────────
CREATE TABLE IF NOT EXISTS scan_backlinks (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    scan_id         UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,

    url             TEXT,        -- referring page URL
    target_url      TEXT,        -- page on our domain being linked to
    source_domain   TEXT,        -- referring domain
    anchor_text     TEXT,
    title           TEXT,        -- page title of linking page

    link_type       TEXT,        -- 'top', 'new', 'toxic'
    is_toxic        BOOLEAN DEFAULT false,
    toxic_reason    TEXT,
    is_nofollow     BOOLEAN,
    first_seen      DATE,
    last_visited    DATE,
    inlink_rank     INTEGER,
    domain_inlink_rank INTEGER
);

CREATE INDEX IF NOT EXISTS idx_scan_backlinks_scan ON scan_backlinks (scan_id);
CREATE INDEX IF NOT EXISTS idx_scan_backlinks_toxic ON scan_backlinks (scan_id, is_toxic);


-- ─── SCAN KEYWORDS (keyword suggestions & SERP data) ──────
CREATE TABLE IF NOT EXISTS scan_keywords (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    scan_id         UUID NOT NULL REFERENCES scans(id) ON DELETE CASCADE,

    keyword         TEXT NOT NULL,
    source          TEXT,        -- 'suggestion', 'serp', 'competitive', 'google_suggest'
    search_volume   INTEGER,
    difficulty      INTEGER,
    cpc             REAL,
    position        INTEGER,     -- current ranking position if known
    url             TEXT,        -- ranking URL if known
    metadata        JSONB        -- any extra source-specific data
);

CREATE INDEX IF NOT EXISTS idx_scan_keywords_scan ON scan_keywords (scan_id);


-- ─── ROW LEVEL SECURITY (open for now — tighten as needed) ─
ALTER TABLE scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_backlinks ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_keywords ENABLE ROW LEVEL SECURITY;

-- Allow full access via service_role key (used by serverless functions)
CREATE POLICY "Service role full access" ON scans FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON scan_pages FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON scan_backlinks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON scan_keywords FOR ALL USING (true) WITH CHECK (true);


-- ─── USEFUL VIEWS ──────────────────────────────────────────

-- Latest scan per domain
CREATE OR REPLACE VIEW latest_scans AS
SELECT DISTINCT ON (domain) *
FROM scans
ORDER BY domain, created_at DESC;

-- Scan summary for dashboards
CREATE OR REPLACE VIEW scan_summary AS
SELECT
    s.id,
    s.domain,
    s.business_name,
    s.created_at,
    s.overall_score,
    s.grade,
    s.score_page_speed,
    s.score_on_page_seo,
    s.score_local_gbp,
    s.score_backlinks,
    s.score_technical,
    s.crawler_blocked,
    s.backlinks_total,
    s.backlinks_toxic,
    s.crawl_pages_found,
    s.crawl_total_words,
    s.broken_links_total,
    (SELECT COUNT(*) FROM scan_pages sp WHERE sp.scan_id = s.id) AS page_count,
    (SELECT COUNT(*) FROM scan_backlinks sb WHERE sb.scan_id = s.id) AS backlink_count
FROM scans s
ORDER BY s.created_at DESC;
