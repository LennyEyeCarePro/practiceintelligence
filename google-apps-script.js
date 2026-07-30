/**
 * JEDI v2 — Google Apps Script for Practice Growth Assessment
 *
 * Deploy as: Web App → Execute as "Me" → Access "Anyone"
 * Paste the resulting URL into CONFIG.GOOGLE_SHEETS_URL in index.html
 *
 * Handles two payload types:
 *   1. Initial submission (from submitToSheets) — creates new row with practice + dossier data
 *   2. SEO update (from submitSeoToSheets, _type: 'seo_update') — finds matching row and appends SEO columns
 */

// ─── CONFIGURATION ──────────────────────────────────────────
const SHEET_NAME = 'Assessments';  // Change this if your sheet tab has a different name

/**
 * Per-brand destination spreadsheets, keyed by the payload's `source` field
 * (set from BRAND.name in index.html).
 *
 * WHY THIS EXISTS
 * A second Apps Script deployment cannot be created with Access = "Anyone" on
 * this Workspace any more — the admin policy now blocks it, though THIS
 * deployment predates the policy and still works. So every brand posts to this
 * one web app, and it fans out to a separate spreadsheet per brand.
 *
 * This must NOT be solved by pointing partners at the EyeCarePro sheet: that
 * would expose the entire EyeCarePro prospect list to a channel partner. Each
 * brand's leads stay in their own file, and the partner is granted view access
 * to theirs alone.
 *
 * The script executes as its owner, so openById() can reach any spreadsheet the
 * owner can — the partner needs no Google identity and no write access.
 *
 * TO ADD A BRAND: create the spreadsheet, then put its ID here. The ID is the
 * long segment in the URL:
 *   docs.google.com/spreadsheets/d/<THIS_PART>/edit
 * An empty string means "use the spreadsheet this script is bound to".
 */
const BRAND_SHEETS = {
  'EyeCarePro': '',  // bound spreadsheet — do not change
  // "Eyefinity SEO Leads", verified 2026-07-30 by opening the document.
  // NOT 1VdgqiSirZNxdtFvm1cCpWM5iy3iAPApxyRWA7gT19B4 — that is the MASTER, and it
  // was briefly set here by mistake. Always confirm an id by opening the document
  // and reading its title.
  //
  // Dormant: this routing only applies if the web app is redeployed as a new
  // version, which we are deliberately not doing. The live separation is done by
  // the trigger in apps-script-partner-mirror.gs instead.
  'Eyefinity': '1DA7TvLjT-xlfJqufYOXqzv_YyT2uNjOo6KRsTymTC7M',
};

/**
 * Resolve the spreadsheet for a payload's brand.
 * Falls back to the bound spreadsheet so an unknown or missing source can never
 * silently discard a lead.
 */
function getSpreadsheetForSource(source) {
  const id = BRAND_SHEETS[source];
  if (!id || id.indexOf('PASTE_') === 0) {
    return SpreadsheetApp.getActiveSpreadsheet();
  }
  try {
    return SpreadsheetApp.openById(id);
  } catch (err) {
    // Wrong ID, or the owner lost access. Keep the lead rather than drop it.
    console.error('Could not open spreadsheet for source "' + source + '": ' + err);
    return SpreadsheetApp.getActiveSpreadsheet();
  }
}

// ─── Column headers for the initial submission ──────────────
const INITIAL_HEADERS = [
  'timestamp', 'source', 'name', 'email', 'url',
  'growthGoal', 'biggestPain', 'freetext',
  // These three are in the payload but were missing here, so they were being
  // silently dropped.
  'capacityOptometry', 'capacitySurgical', 'capacityOptical',
  'step1Corrections', 'step2Corrections', 'step3Corrections',
  'practiceName', 'practiceType', 'practiceSubType', 'yearEstablished',
  'doctorCount', 'mdCount', 'odCount', 'doctorNames',
  'locationCount', 'phone', 'address',
  'servicesDetected', 'servicesCount', 'missingServices',
  'cms', 'marketingVendor', 'isCompetitorClient', 'isEyeCarePro',
  // EHR/PMS signals — website-detected, so under-reported. Sales triage hint.
  'ehrPmsDetected', 'isEyefinityPms',
  'hasScheduling', 'schedulingPlatform', 'analyticsTools',
  'socialPlatforms', 'socialCount', 'facebookUrl', 'instagramUrl',
  'blogExists', 'homepageWordCount', 'totalWordCount',
  'lighthousePerformance', 'lighthouseSeo', 'lighthouseAccessibility', 'lighthouseBestPractices',
  'lighthouseFcp', 'lighthouseLcp',
  'scoreDigital', 'scoreContent', 'scorePatientExp', 'scoreMarketing', 'scoreOverall',
  'recommendedTier', 'gapCount', 'topGaps',
  'hasOptical', 'frameBrandCount', 'brandPositioning', 'insurancePlans',
  // Mirrored from the HubSpot payload so the Sheet is a complete record on
  // brands with no CRM write.
  'revenueGapMonthly', 'strategicFocus', 'strategicAdvice',
  'malignancySummary', 'technicalRootCause', 'emotionalRootCause', 'targetStatement',
  // Report provenance — explains why a given report may read generic.
  // A reportSource of "rules" means the AI narrative was unavailable.
  // NOTE: no apostrophes in comments inside this array. An unmatched quote
  // shifts quote-pairing for every entry after it, which silently hid these
  // four columns from tooling that parses this file.
  'reportSource', 'reportUsedClientInput', 'reportFallbackReason', 'lighthouseError',
  // Core package recommendation (recommend.js). Blank for brands without a ruleset.
  'recommendedPackage', 'packagePrimaryTrigger', 'packageSecondaryTrigger', 'packageConfidence', 'packageAllTriggers', 'packageRationale', 'packageDeficits',
];

// ─── Column headers for the SEO update (appended to same row) ──
const SEO_HEADERS = [
  'seoOverallScore', 'seoGrade', 'seoHeadline',
  'pillarPageSpeed', 'pillarOnPageSeo', 'pillarLocalGbp', 'pillarBacklinks', 'pillarTechnical',
  'mobilePerformance', 'mobileSeo', 'mobileAccessibility', 'mobileLcp', 'mobileFcp',
  'desktopPerformance', 'desktopLcp',
  'domainAuthority', 'domainAuthorityLabel',
  'gbpName', 'gbpRating', 'gbpReviewCount', 'gbpPhotoCount',
  'gbpHasHours', 'gbpCategory', 'gbpStatus', 'gbpAddress', 'gbpPhone', 'gbpMapsUrl', 'gbpLocationCount',
  'gbpAllLocations',
  'competitorCount', 'competitors',
  'auditSsl', 'auditTitleTag', 'auditTitleLength',
  'auditMetaDesc', 'auditMetaDescLength',
  'auditH1', 'auditH1Count',
  'auditHasSchema', 'auditHasLocalSchema',
  'auditHasCanonical', 'auditHasViewport',
  'auditHasSitemap', 'auditSitemapUrls',
  'auditHasRobots', 'auditBlocksGooglebot',
  'auditAltTextCoverage',
  'auditHasOgTitle', 'auditHasOgImage', 'auditHasBookingCta',
  'findingsCount', 'findingsCritical', 'findingsWarning', 'topOpportunity',
  'seoTimestamp',
];

// ─── MAIN HANDLER ───────────────────────────────────────────

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // Route to the brand's own spreadsheet. An seo_update carries the same
    // `source` as the initial submission, so both halves of a lead land in the
    // same file and handleSeoUpdate() can still find the row to update.
    const ss = getSpreadsheetForSource(data.source);
    let sheet = ss.getSheetByName(SHEET_NAME);

    // Auto-create sheet with headers if it doesn't exist
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      const allHeaders = [...INITIAL_HEADERS, ...SEO_HEADERS];
      sheet.getRange(1, 1, 1, allHeaders.length).setValues([allHeaders]);
      sheet.getRange(1, 1, 1, allHeaders.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    // Ensure headers exist (in case sheet was created before SEO columns were added)
    ensureHeaders(sheet);

    if (data._type === 'seo_update') {
      handleSeoUpdate(sheet, data);
    } else {
      handleInitialSubmission(sheet, data);
    }

    return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Also handle GET requests (for testing)
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'JEDI v2 Sheets endpoint is active. Use POST to submit data.',
  })).setMimeType(ContentService.MimeType.JSON);
}

// ─── INITIAL SUBMISSION (new row) ───────────────────────────

function handleInitialSubmission(sheet, data) {
  const headers = getHeaders(sheet);
  const row = headers.map(h => {
    const val = data[h];
    if (val === undefined || val === null) return '';
    return val;
  });
  sheet.appendRow(row);
}

// ─── SEO UPDATE (find matching row, append SEO columns) ─────

function handleSeoUpdate(sheet, data) {
  const headers = getHeaders(sheet);
  const emailCol = headers.indexOf('email') + 1;  // 1-indexed
  const urlCol = headers.indexOf('url') + 1;
  const timestampCol = headers.indexOf('timestamp') + 1;

  if (!emailCol || !urlCol) {
    // Can't match — just append as new row with what we have
    handleInitialSubmission(sheet, data);
    return;
  }

  // Find the matching row: same email + url, most recent (search bottom-up)
  const lastRow = sheet.getLastRow();
  let matchRow = -1;

  if (lastRow > 1) {
    const emails = sheet.getRange(2, emailCol, lastRow - 1, 1).getValues();
    const urls = sheet.getRange(2, urlCol, lastRow - 1, 1).getValues();

    const targetEmail = (data.email || '').toLowerCase().trim();
    const targetUrl = (data.url || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

    // Search from bottom (most recent) to top
    for (let i = emails.length - 1; i >= 0; i--) {
      const rowEmail = (emails[i][0] || '').toString().toLowerCase().trim();
      const rowUrl = (urls[i][0] || '').toString().toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

      if (rowEmail === targetEmail && rowUrl === targetUrl) {
        matchRow = i + 2;  // +2 because data starts at row 2, and array is 0-indexed
        break;
      }
    }
  }

  if (matchRow === -1) {
    // No matching row found — append as new row (fallback)
    // Include the seo timestamp
    data.seoTimestamp = data.timestamp;
    handleInitialSubmission(sheet, data);
    return;
  }

  // Write SEO data into the matching row
  data.seoTimestamp = data.timestamp;
  for (const key of SEO_HEADERS) {
    const colIdx = headers.indexOf(key) + 1;
    if (colIdx > 0) {
      const val = data[key];
      if (val !== undefined && val !== null && val !== '') {
        sheet.getRange(matchRow, colIdx).setValue(val);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
//   PARTNER MIRROR — run on a time trigger, NOT via the web app
// ═══════════════════════════════════════════════════════════
/**
 * Mirror one brand's rows into that brand's own spreadsheet.
 *
 * WHY A TRIGGER AND NOT doPost ROUTING
 * The live web app serves a PINNED version of this script. Changing doPost would
 * require deploying a new version, and on this Workspace that risks losing the
 * grandfathered Access="Anyone" setting — which is the only reason anonymous
 * lead capture works at all. A time-driven trigger, by contrast, runs the latest
 * SAVED code and needs no deployment. So: save this file, add a trigger, and the
 * live web app is untouched.
 *
 * WHY A SEPARATE DOCUMENT AND NOT A TAB
 * Google Sheets permissions are per-document, not per-tab. Sharing the master
 * sheet would expose every EyeCarePro prospect to the partner; hiding or
 * protecting a tab does not prevent a viewer reading it via IMPORTRANGE or the
 * API. Only a separate file is an actual boundary.
 *
 * SETUP (one time, no deployment needed)
 *   1. Save this file in the Apps Script editor (Ctrl+S). Do NOT deploy.
 *   2. Left sidebar → Triggers (clock icon) → Add Trigger
 *        Function:        syncPartnerSheets
 *        Event source:    Time-driven
 *        Type:            Minutes timer → every 15 minutes
 *   3. Grant the authorisation prompt (it needs access to the target file).
 *   4. Share the partner spreadsheet with the partner as VIEWER — not Editor.
 *      An Editor could rewrite the sheet or its formulas.
 *
 * The mirror is a full replace each run: idempotent, no dedupe state to drift,
 * and safe to run as often as you like at lead volumes.
 */
function syncPartnerSheets() {
  for (const source in BRAND_SHEETS) {
    const targetId = BRAND_SHEETS[source];
    // Skip the bound sheet (empty id) and anything unconfigured.
    if (!targetId || targetId.indexOf('PASTE_') === 0) continue;
    try {
      mirrorRowsForSource(source, targetId);
    } catch (err) {
      console.error('Mirror failed for "' + source + '": ' + err);
    }
  }
}

function mirrorRowsForSource(source, targetId) {
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!master) throw new Error('Master tab "' + SHEET_NAME + '" not found');

  const lastRow = master.getLastRow();
  const lastCol = master.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return;

  const all = master.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = all[0].map(function (h) { return String(h); });

  const srcCol = headers.indexOf('source');
  if (srcCol === -1) {
    // Without a source column every row would look like it belongs to the
    // partner. Refuse rather than leak the whole list.
    throw new Error('No "source" column in the master sheet — refusing to mirror');
  }

  const matching = all.slice(1).filter(function (row) {
    return String(row[srcCol]).trim().toLowerCase() === source.toLowerCase();
  });

  const target = SpreadsheetApp.openById(targetId);
  let tab = target.getSheetByName(SHEET_NAME);
  if (!tab) {
    tab = target.insertSheet(SHEET_NAME);
  }

  // Full replace. clear() rather than deleting the sheet so any manual
  // formatting, filters or frozen rows the partner relies on survive.
  tab.clear();
  tab.getRange(1, 1, 1, headers.length).setValues([headers]);
  tab.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  if (matching.length > 0) {
    tab.getRange(2, 1, matching.length, headers.length).setValues(matching);
  }
  tab.setFrozenRows(1);

  console.log('Mirrored ' + matching.length + ' "' + source + '" row(s) to ' + targetId);
}

// ─── HELPERS ────────────────────────────────────────────────

function getHeaders(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => h.toString());
}

function ensureHeaders(sheet) {
  const existing = getHeaders(sheet);
  const allHeaders = [...INITIAL_HEADERS, ...SEO_HEADERS];
  const missing = allHeaders.filter(h => !existing.includes(h));

  if (missing.length > 0) {
    const startCol = existing.length + 1;
    sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
    sheet.getRange(1, startCol, 1, missing.length).setFontWeight('bold');
  }
}
