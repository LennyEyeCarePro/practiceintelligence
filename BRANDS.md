# Multi-brand architecture

One codebase, multiple front doors. Each brand is a Vercel project deploying
**this same repo**; the brand is chosen at runtime from the hostname. There is no
build step and no forked copy to keep in sync.

## Brands

| Brand | Hostname match | CRM write | Leads land in |
|---|---|---|---|
| `eyecarepro` | *(default fallback)* | ✅ HubSpot + Sheets | EyeCarePro Sheet + HubSpot |
| `eyefinity` | `practiceintelligence-eyefinity`, `eyefinity` | ❌ Sheets only | Eyefinity Sheet (`source: "Eyefinity"`) |

## How resolution works

`resolveBrand()` in `index.html`, in precedence order:

1. **`?brand=<id>`** — explicit override. Use it for testing, and for embeds
   served from a host that doesn't match a brand:
   `localhost:3000/index.html?brand=eyefinity`
2. **Hostname substring match** against each brand's `hostnames` array.
3. **`BRANDS.eyecarepro`** as the default.

`applyBrand()` then writes the brand into the chrome on `DOMContentLoaded`:
logo, CSS custom properties, both CTAs, footer, existing-client banner, and
`document.title`.

## Adding a brand

Add one entry to `BRANDS`. Nothing else in `index.html` should ever contain a
hardcoded brand name. Required keys:

| Key | Notes |
|---|---|
| `id`, `name` | `name` is also written into the Sheet as `source` |
| `hostnames` | Array of substrings matched against `location.hostname`. Empty = default |
| `logoUrl`, `logoAlt`, `logoHeight` | Empty `logoUrl` falls back to a text wordmark, never a broken image |
| `brandHex`, `brandLightHex`, `brandDarkHex`, `surfaceHex`, `textHex` | `null` leaves the stylesheet's `:root` value alone |
| `ctaUrl`, `ctaLabel` | Results-screen CTA |
| `offVerticalCtaUrl` | CTA on the "not an eye care practice" fallback screen |
| `footerHtml` | Raw HTML, so partner attribution can be marked up |
| `sheetsUrl` | Apps Script `/exec`. **Must allow anonymous access** — see the warning below |
| `crmSubmit` | `true` writes to HubSpot. Partner brands are normally `false` |
| `copy.*` | The brand-varying sentences. See below |

### Why `copy` holds whole sentences, not just nouns

Interpolating a brand noun into one shared sentence produces subtly wrong
English across brands (article agreement, possessives, whether the brand is even
named to the prospect). Each brand owns the full sentence instead, which also
guarantees the EyeCarePro wording can never drift when a partner brand is
edited. There's a regression guard for exactly that — see below.

## ⚠️ The reseller safeguard is brand-independent

`dossier.digital.isEyeCarePro` and `CONFIG.EXISTING_CLIENTS` gate ~26 `isECP`
branches that soften the findings when the scanned site is one **EyeCarePro**
built: hide the Lighthouse score row, hide the SEO Health panel, suppress
competitor findings, swap to opportunity-framed copy.

That detection stays keyed on EyeCarePro **for every brand**, because partners
resell EyeCarePro services — we must never hand a prospect a teardown of a site
we built. Only the wording varies, via `copy.existingClientTag`,
`copy.biggerQuestion`, `copy.programLabel`, and `copy.siteLabel`.

**Do not make the safeguard per-brand, and do not "simplify" those branches away.**

For partner brands the visible wording is deliberately brand-neutral ("current
website program", "Managed Website Program") rather than naming EyeCarePro: a
practice buying through a partner may not know the product by our name, and a
site scrape cannot distinguish a direct client from a partner-sold one.

## Regression guard

Any change to `BRANDS.eyecarepro` risks altering the live EyeCarePro tool. The
guard asserts that all 15 EyeCarePro-visible strings still appear verbatim in a
known-good reference copy of `index.html`:

```bash
git show <known-good-ref>:index.html > /tmp/orig.html
# extract the BRANDS block, then run the checker (see scratchpad/regress2.js)
```

Note when writing such checks: the file stores apostrophes inside single-quoted
JS literals as `\'`, so a runtime value `we'll` appears in source as `we\'ll`.
Match against both forms or the test produces false failures.

## Anonymous access on the Apps Script endpoint

`submitToSheets()` posts with `mode: 'no-cors'`, so **a rejected POST is
completely silent** — no console error, and the prospect still sees the success
screen. If a brand's Apps Script deployment is not set to Access = **"Anyone"**,
every one of its leads is dropped with no visible symptom.

Verify a brand's endpoint with an unauthenticated GET; the correct response is
`{"status":"ok","message":"JEDI v2 Sheets endpoint is active..."}`. Anything that
redirects to `accounts.google.com` means it is still closed.

## Function budget

12 serverless functions = exactly the Vercel Hobby limit. Every brand deploying
this repo gets all 12, since the limit is per-project. Adding an endpoint
requires consolidating an existing one first.
