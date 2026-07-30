# Data inventory — everything available to drive recommendation logic

Extracted from the code on 2026-07-30, not from memory. Sources: the Apify actor
(`eyecarepro-practice-scraper/main.js` + `dictionaries.js`), the seven API handlers
the wizard calls, and the client's own answers in `index.html`.

Read the **"What we do NOT have"** section before designing anything — it is the
part most likely to change your approach.

---

## 1. Client-declared input — the highest-trust data

Twelve fields the practice tells us directly. `api/seo-report.js` already treats
these as authoritative over anything scraped.

| Field | Type | Notes |
|---|---|---|
| `name`, `email`, `url` | text | Identity |
| `goal` | one of 5 | Picked from a list that **varies by practice type** — see `GOAL_OPTIONS` |
| `pain` | one of 5 | Same, from `PAIN_OPTIONS` |
| `freetext` | free text | Open-ended. Where "we just added a dry eye clinic" showed up in testing |
| `capacityOptometry` | free text | Spare capacity — chair/exam slots |
| `capacitySurgical` | free text | Spare surgical capacity |
| `capacityOptical` | free text | Spare optical capacity |
| `step1Corrections` | free text | Client fixing our practice-profile scrape |
| `step2Corrections` | free text | Client fixing our services list |
| `step3Corrections` | free text | Client adding digital/marketing context |

**The three `capacity*` fields are the strongest revenue-logic signal we collect**
and are currently barely used. A practice telling you it has surgical capacity
sitting idle is a far better tier signal than anything inferable from a website.

---

## 2. Scraped practice dossier

One Apify actor call returns this whole structure. Full skeleton in
`main.js`; the fields worth building on:

### Practice identity
`practice.name`, `practice.type` (`optometry` | `ophthalmology` | `optical` |
`multi_specialty`), `practice.subType` (`solo` | `group` | `chain` | `corporate`),
`practice.tagline`, `practice.yearEstablished`

### People and footprint
- `doctors[]` — each with name, credential, type (`optometrist` / `ophthalmologist`)
- `locations.count`, `.addresses[]`, `.phones[]`, `.faxes[]`, `.emails[]`, `.hours`

### Services — 37 detected, categorised
`services.detected[]`, `.categories{}`, `.totalCount`, `.missingHighValue[]`

| Category | Count | Services |
|---|---|---|
| **surgical** | 13 | LASIK, PRK, SMILE, ICL, Refractive Lens Exchange, Cataract, Premium IOLs, Laser-Assisted Cataract, Glaucoma, Retina, Cornea, Oculoplastics, Strabismus |
| **specialty** | 9 | Myopia Management, Dry Eye, OptiLight/IPL, LipiFlow, TearLab, iLux, ZEST, BlephEx, Sports Vision |
| **optometry** | 7 | Comprehensive Exams, Pediatric, Contact Lens Fitting, Vision Therapy, Low Vision, Surgical Co-Management, Emergency |
| **technology** | 5 | OCT, Optos/Wide-Field, Fundus Photography, Visual Field, Corneal Topography |
| **optical** | 3 | Eyeglasses/Frames, Sunglasses, Specialty Lenses |

`missingHighValue` is computed against a **different expected set per type**:
- Ophthalmology → `premium_iol, laser_cataract, lasik, retina, glaucoma, oculoplastics, cornea, dry_eye`
- Optometry → `dry_eye, myopia_management, vision_therapy, contact_lens, emergency`

### Optical
`optical.hasOptical`, `.frameBrands{}`, `.totalBrands`, `.hasEcommerce`, and
`.positioning` derived from brand tiers: **luxury / premium / mainstream / value /
independent / kids**. Brand-tier mix is a real proxy for patient affluence.

### Digital / vendor intelligence
- `digital.cms` — 11 platforms
- `digital.marketingVendor` — 19 known vendors, plus footer-attribution fallback
- `digital.isCompetitorClient` + `competitorName`
- `digital.isEyeCarePro` ⚠️ **load-bearing safeguard — see `BRANDS.md`**
- `digital.scheduling.hasOnlineScheduling`, `.platform` (22 platforms), `.isRealTime`
- `digital.forms` (9), `.analytics` (11), `.reviewPlatforms` (12),
  `.accessibility` (5), `.payment` (13), `.telehealth` (5)
- `ehrPms[]` — 15 systems incl. Eyefinity/OfficeMate ⚠️ *website-signal only, under-reports*
- `insurance.detected[]` — 20 providers, `.acceptsInsurance`

### Social, content, technical
- `social.platformCount`, per-platform booleans, `facebookUrl`, `instagramUrl`
- `content.blogExists`, `.lastBlogPostDate`, `.estimatedBlogPosts`, `.totalWordCount`, `.subpages[]`
- `technical.ssl`, `.sitemapExists`, `.robotsTxt`, `.hasSchemaMarkup`, `.schemaTypes[]`, `.mobileViewport`

---

## 3. API-derived data

### `site-audit` — 76 fields, no API key needed
SEO/meta (title + length, meta desc + length, H1–H4 counts, canonical, robots meta,
indexability), schema (`hasLocalBusinessSchema`, `schemaTypes[]`), social meta (OG,
Twitter cards), images (`totalImages`, `imagesWithAlt`, `altTextCoverage`),
**content quality** (`wordCount`, `readabilityScore`, `readabilityLevel`,
`avgWordsPerSentence`, `topKeywords`, `topPhrases`, `h2Texts`), links (internal,
external, unique external domains, top external domains), infrastructure
(`securityHeaders`, `securityScore`, `redirectChain`, `technology[]` — 40+
platforms), tooling (`hasGoogleAnalytics`, `hasGoogleTagManager`,
`hasFacebookPixel`, `hasHotjar`, `hasLiveChat`, `hasADA`, `hasLazyLoading`, `hasAMP`),
and booking (`hasBookingCTA`, `hasOnlineBooking`).

### `page-quality` — Lighthouse, mobile **and** desktop
4 category scores each, Core Web Vitals (FCP, LCP, TBT, CLS, Speed Index, TTI,
server response), **real-user field data** (`fieldLcp`, `fieldCls`, `fieldFid`,
`fieldInp`, `overallCategory`), plus 9 specific audit flags (render-blocking,
image optimisation, compression, minification, cache policy, redirects).
Also W3C HTML validation + rich-results eligibility via `?action=validate`.

### `places` — Google Business Profile
`name`, `rating`, `reviewCount`, `photoCount`, `hasHours`, `phone`, `address`,
`businessStatus`, `mapsUrl`, `primaryCategory`, `placeId`; `locations[]` for
multi-location discovery; and **`competitors[]` within 8km** with each one's name,
rating, reviewCount and address.

Competitor review counts are the most actionable local-SEO number we hold — they
turn "you have 88 reviews" into "you have 88, they have 340."

### `site-info` — authority and trust
Open PageRank (0–10 + label), Moz (`domainAuthority`, `pageAuthority`, `spamScore`,
`linkingDomains`), Google Safe Browsing, SSL Labs (grade, issuer, days remaining,
protocols, HSTS, vulnerabilities). Accepts up to 15 competitor domains for
side-by-side authority comparison.

### `search-rankings` — actual SERP positions
Keyword list is built **per practice type**, localised with city/state, then matched
against the practice domain in both organic results and the map pack.

### `seo-report` — the AI layer
Returns `overallScore`, `grade`, `headline`, `topOpportunity`, 5 `pillarScores`,
and 5 `findings[]` (severity + category + detail). Plus provenance:
`source` (`ai`|`rules`), `aiProvider`, `usedClientInput`, `fallbackReason`.

---

## 4. Computed / derived

- **4 sub-scores + overall**: `digitalPresence`, `contentQuality`,
  `patientExperience`, `marketingMaturity`, `overall`
- **5 weighted pillars**: Page Speed 25%, On-Page SEO 20%, GBP 25%,
  Domain Authority 15%, Technical 15% — reweighted over whichever have data
- **`gaps[]`** — each with `category`, `severity`, `finding`. Severities include
  `critical`, `moderate`, `opportunity`, plus vendor states `existing_client` and
  `competitor`
- **Revenue gap** — from a per-service annual value map in `index.html`:

| Service | Est. annual value/patient |
|---|---|
| Premium IOL | $5,000 – $20,000 |
| LASIK | $4,000 – $15,000 |
| Cataract | $3,000 – $12,000 |
| Oculoplastics | $2,000 – $10,000 |
| Glaucoma | $2,000 – $8,000 |
| Retina | $2,000 – $8,000 |
| Myopia Management | $1,200 – $4,000 |
| LipiFlow / OptiLight | $1,000 – $3,500 |
| Contact Lens | $800 – $2,500 |

---

## 5. The tier logic you'd be replacing

Currently in the **Apify actor**, not the web app — worth knowing, because moving it
into the app is part of the work.

**Ophthalmology / multi-specialty → EyeMDPRO**
- Oculoplastics/aesthetics present **or** ≥3 locations → **Platinum** ($2,499/mo)
- LASIK/PRK/Premium IOL/Laser Cataract/RLE → **Gold** ($1,499/mo)
- Otherwise → **Silver**

**Optometry / optical → EyeCarePro**
- ≥3 locations **or** ≥6 doctors → **Metro** ($1,549/mo)
- Dry eye / LASIK / cataract / myopia management → **Specialty** ($799/mo)
- Has optical → **Capture** ($799/mo)
- Otherwise → **Essentials** ($419/mo)

Two things to note: it keys on only 4 inputs (services, locations, doctors,
optical), and it **ignores every client-declared field** — including the capacity
answers, which are the most direct statement of unmet demand we get.

---

## 6. What we do **NOT** have

Read this before designing. These are the things most likely to be assumed:

- **No patient volume** — no visit counts, new-patient counts or no-show rates
- **No actual revenue** — the gap figures are industry estimates × detected
  services, never the practice's real numbers
- **No EHR/PMS data** — we detect that Eyefinity is *present*, nothing inside it
- **No appointment or scheduling data** — only whether a booking widget exists
- **No ad spend or paid-channel data** — no Google Ads, no Meta
- **No traffic data** — no sessions, no conversion rates. `site-audit` reads markup
  only; we have Lighthouse field data but not analytics
- **No staffing beyond doctor count** — no opticians, techs or front desk
- **No insurance mix or reimbursement rates** — only which plans are *mentioned*
- **No equipment inventory** — only what's named on the website
- **EHR/PMS and vendor detection under-report** — website-signal based. A practice
  not naming its PMS looks like it has none
- **`isEyefinityPms` is a weak hint**, deliberately driving no UI behaviour

---

## 7. Highest-signal fields for product logic

If Eyefinity's recommendation engine keys on a handful of things, these carry the
most information per field:

1. **`practice.type`** — the single biggest branch; surgical vs optometric economics differ entirely
2. **`capacitySurgical` / `capacityOptometry` / `capacityOptical`** — declared unmet demand, currently unused
3. **`services.missingHighValue[]`** — already type-aware, maps straight to revenue
4. **`goal` + `pain`** — the client's own stated priority, already type-aware
5. **`locations.count` + `doctors.length`** — practice scale
6. **`optical.positioning`** — brand-tier proxy for patient affluence
7. **`digital.scheduling.isRealTime`** — real-time booking vs a contact form is a large conversion difference
8. **GBP `reviewCount` vs `competitors[].reviewCount`** — relative, not absolute, local standing
9. **`digital.marketingVendor` / `isCompetitorClient`** — incumbent status, i.e. switch vs greenfield
10. **`ehrPms[]`** — integration fit, but treat as a hint only

---

## 8. Seeing it for yourself

The three endpoints needing no API key, against any practice domain:

```bash
curl "https://practiceintelligence-black.vercel.app/api/site-audit?url=https://www.pv-sg.com/"
curl "https://practiceintelligence-black.vercel.app/api/site-info?domain=pv-sg.com"
curl "https://practiceintelligence-black.vercel.app/api/places?businessName=NAME&city=CITY"
```

For a full dossier, run the Apify actor `eyecarepro~eyecarepro-practice-scraper`
directly in the Apify console — the output is the structure in section 2.
