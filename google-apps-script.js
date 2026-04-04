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

// ─── Column headers for the initial submission ──────────────
const INITIAL_HEADERS = [
  'timestamp', 'name', 'email', 'url',
  'growthGoal', 'biggestPain', 'freetext', 'corrections',
  'practiceName', 'practiceType', 'practiceSubType', 'yearEstablished',
  'doctorCount', 'mdCount', 'odCount', 'doctorNames',
  'locationCount', 'phone', 'address',
  'servicesDetected', 'servicesCount', 'missingServices',
  'cms', 'marketingVendor', 'isCompetitorClient', 'isEyeCarePro',
  'hasScheduling', 'schedulingPlatform', 'analyticsTools',
  'socialPlatforms', 'socialCount', 'facebookUrl', 'instagramUrl',
  'blogExists', 'homepageWordCount', 'totalWordCount',
  'lighthousePerformance', 'lighthouseSeo', 'lighthouseAccessibility', 'lighthouseBestPractices',
  'lighthouseFcp', 'lighthouseLcp',
  'scoreDigital', 'scoreContent', 'scorePatientExp', 'scoreMarketing', 'scoreOverall',
  'recommendedTier', 'gapCount', 'topGaps',
  'hasOptical', 'frameBrandCount', 'brandPositioning', 'insurancePlans',
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
    const ss = SpreadsheetApp.getActiveSpreadsheet();
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
