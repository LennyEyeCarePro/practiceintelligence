/**
 * PartnerMirror.gs — a SELF-CONTAINED Apps Script file.
 *
 * Copies each partner brand's rows out of the EyeCarePro master sheet into that
 * partner's own spreadsheet, on a timer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT DOES NOT MATTER WHICH PROJECT THIS GOES IN
 * Every name here is prefixed MIRROR_ / PARTNER_ so it cannot collide with an
 * existing Code.gs, and the master spreadsheet is opened by ID rather than via
 * getActiveSpreadsheet(). So this works in a bound script, a standalone script,
 * or a brand-new empty project, and it never needs to read or edit any other
 * file in the project.
 *
 * An earlier version referenced a SHEET_NAME constant declared in the
 * lead-capture Code.gs. That was wrong: the spreadsheet's own bound project
 * turned out to be an empty stub (opening Extensions → Apps Script CREATES one
 * if none exists), so the live web app lives in a different project entirely.
 * Depending on a constant from a file that may not be there would have thrown
 * ReferenceError at runtime.
 *
 * ⚠️ Do NOT also paste google-apps-script.js into the same project. Its
 * BRAND_SHEETS / SHEET_NAME declarations are separate from the ones here; two
 * declarations of the same name in one project is an error that breaks every
 * function in it. This file alone is enough for the mirror.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY A TRIGGER AND NOT ROUTING INSIDE doPost
 * The live web app serves a PINNED script version. Routing inside doPost would
 * require deploying a new version, which on this Workspace risks losing the
 * grandfathered Access="Anyone" setting that anonymous lead capture depends on.
 * A time-driven trigger runs the latest SAVED code and needs no deployment.
 *
 * WHY A SEPARATE DOCUMENT AND NOT A TAB
 * Google Sheets permissions are per-document, not per-tab. Sharing the master
 * would expose every EyeCarePro prospect; hiding or protecting a tab is not a
 * boundary, since a viewer can still read it via IMPORTRANGE or the API.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP
 *   1. Fill in MIRROR_MASTER_ID below — the master spreadsheet's ID, taken from
 *      its URL. This is the only edit required.
 *   2. Paste this file into any Apps Script project (a new one is fine) and save
 *      with Ctrl+S. DO NOT click Deploy.
 *   3. Left sidebar → Triggers (clock icon) → Add Trigger
 *        Function ..........  syncPartnerSheets
 *        Deployment ........  Head
 *        Event source ......  Time-driven
 *        Type ..............  Minutes timer → Every 15 minutes
 *      Save, then approve the authorisation prompt.
 *   4. Share the partner spreadsheet with the partner as VIEWER, not Editor.
 *
 * TO TEST NOW: select syncPartnerSheets in the toolbar dropdown, press Run, and
 * read the Execution log.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The master spreadsheet that lead capture writes into — the one whose
 * Assessments tab has a `source` column.
 *
 * Opened by ID on purpose. getActiveSpreadsheet() only works in a script bound
 * to that spreadsheet, and this file is meant to run from anywhere.
 *
 * Identify this document by CONTENT, not by name — it was titled "Untitled
 * spreadsheet" when this id was verified on 2026-07-30 and has since been renamed.
 * The reliable signature is an Assessments tab with ~130 columns of real prospect
 * data including an isEyeCarePro column, which only lead capture produces.
 *
 * Renaming is harmless: everything here keys off the id, never the title.
 */
const MIRROR_MASTER_ID = '1VdgqiSirZNxdtFvm1cCpWM5iy3iAPApxyRWA7gT19B4';

/** Tab name in both the master and each partner spreadsheet. */
const MIRROR_TAB_NAME = 'Assessments';

/**
 * Partner destination spreadsheets, keyed by the `source` value written by
 * index.html (BRAND.name).
 *
 * EyeCarePro is intentionally absent: it is the source, not a destination.
 *
 * TO ADD A PARTNER: create their spreadsheet and paste its ID here.
 */
const PARTNER_SHEETS = {
  // "Eyefinity SEO Leads" — verified 2026-07-30 by opening it: a separate
  // document with only a Sheet1 tab and no lead data.
  //
  // ⚠️ MUST be the partner's OWN spreadsheet, never the master. This briefly
  // held the MASTER's id (1Vdgq...) by mistake, which would have called
  // tab.clear() on the master and destroyed every EyeCarePro prospect row.
  // assertDistinctFromMaster() and assertSafeToOverwrite() now make that
  // outcome impossible, but always confirm an id by opening the document and
  // reading its title rather than assuming.
  'Eyefinity': '1DA7TvLjT-xlfJqufYOXqzv_YyT2uNjOo6KRsTymTC7M',
};

/**
 * Column names the lead-capture payload sends that the master sheet may not have
 * a column for yet. handleInitialSubmission() writes a row by matching payload
 * field names against the header names in row 1, so a field with no column is
 * silently discarded — including `source`, which the mirror depends on.
 */
const MIRROR_REQUIRED_HEADERS = [
  'source',
  'capacityOptometry', 'capacitySurgical', 'capacityOptical',
  'ehrPmsDetected', 'isEyefinityPms',
  'revenueGapMonthly', 'strategicFocus', 'strategicAdvice',
  'malignancySummary', 'technicalRootCause', 'emotionalRootCause', 'targetStatement',
  'reportSource', 'reportUsedClientInput', 'reportFallbackReason', 'lighthouseError',
  'recommendedPackage', 'packagePrimaryTrigger', 'packageSecondaryTrigger', 'packageConfidence', 'packageAllTriggers', 'packageRationale', 'packageDeficits',
];

/**
 * ONE-OFF SETUP — run this once, manually, before the mirror will work.
 *
 * Adds any missing names from MIRROR_REQUIRED_HEADERS to row 1 of the master.
 *
 * WHY THIS EXISTS RATHER THAN TYPING THE HEADERS BY HAND
 * Pasting a tab-separated line into a cell is unreliable: entering it as
 * keystrokes puts literal tab characters inside ONE cell instead of advancing
 * across cells, which produced a single 282-character cell and no `source`
 * column at all. Typing 17 names by hand is no better — one typo and that field
 * is silently dropped forever, with no error anywhere. Writing them
 * programmatically makes the spelling exact by construction.
 *
 * Safe to run repeatedly: it only appends names that are genuinely absent, and
 * only ever writes to row 1.
 */
function addMissingHeadersToMaster() {
  const sheet = SpreadsheetApp.openById(MIRROR_MASTER_ID).getSheetByName(MIRROR_TAB_NAME);
  if (!sheet) throw new Error('Master tab "' + MIRROR_TAB_NAME + '" not found in ' + MIRROR_MASTER_ID);

  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const row1 = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  // A header containing a tab is the botched single-cell paste described above.
  // A real header name never contains one, so clearing it is safe.
  let repaired = 0;
  for (let i = 0; i < row1.length; i++) {
    if (String(row1[i]).indexOf('\t') !== -1) {
      console.warn('Clearing malformed header in column ' + (i + 1) +
        ' (contained tab characters): ' + String(row1[i]).slice(0, 60) + '...');
      sheet.getRange(1, i + 1).clearContent();
      row1[i] = '';
      repaired++;
    }
  }

  const existing = {};
  row1.forEach(function (h) {
    const name = String(h).trim();
    if (name) existing[name] = true;
  });

  const missing = MIRROR_REQUIRED_HEADERS.filter(function (h) { return !existing[h]; });
  if (missing.length === 0) {
    console.log('Nothing to do — all ' + MIRROR_REQUIRED_HEADERS.length + ' required headers already present'
      + (repaired ? ' (repaired ' + repaired + ' malformed cell(s))' : ''));
    return;
  }

  // First truly empty column, so nothing existing is overwritten.
  let startCol = row1.length;
  while (startCol > 0 && String(row1[startCol - 1]).trim() === '') startCol--;
  startCol += 1;

  sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
  sheet.getRange(1, startCol, 1, missing.length).setFontWeight('bold');

  console.log('Added ' + missing.length + ' header(s) starting at column ' + startCol + ': ' + missing.join(', ')
    + (repaired ? ' | repaired ' + repaired + ' malformed cell(s)' : ''));
}

/**
 * Entry point for the time-driven trigger. Mirrors every configured partner.
 * One partner failing does not stop the others.
 */
function syncPartnerSheets() {
  if (!MIRROR_MASTER_ID || MIRROR_MASTER_ID.indexOf('PASTE_') === 0) {
    throw new Error('MIRROR_MASTER_ID is not set — put the master spreadsheet ID at the top of this file');
  }
  for (const source in PARTNER_SHEETS) {
    const targetId = PARTNER_SHEETS[source];
    if (!targetId || targetId.indexOf('PASTE_') === 0) {
      console.warn('Skipping "' + source + '": no spreadsheet ID configured');
      continue;
    }
    try {
      mirrorRowsForSource(source, targetId);
    } catch (err) {
      console.error('Mirror failed for "' + source + '": ' + err);
    }
  }
}

/**
 * Copy the rows whose `source` matches into the target spreadsheet.
 * Full replace each run: idempotent, with no dedupe state that can drift.
 */
/**
 * First guard: the destination must not be the master.
 *
 * This mirror does a full replace, so pointing a partner destination at the
 * master would clear the master and replace it with one brand's subset. That is
 * unrecoverable, and it very nearly happened — the partner id was mistakenly set
 * to the master id. Cheap check, catastrophic thing to catch.
 */
function assertDistinctFromMaster(source, targetId) {
  if (String(targetId).trim() === String(MIRROR_MASTER_ID).trim()) {
    throw new Error(
      'REFUSING TO RUN: the destination for "' + source + '" is the MASTER spreadsheet (' +
      targetId + '). This mirror does a full replace, so that would erase the master. ' +
      'Set PARTNER_SHEETS["' + source + '"] to the partner OWN spreadsheet id.'
    );
  }
}

/**
 * Second guard: never clear a destination that holds anybody else's rows.
 *
 * Protects against the destination being some other populated sheet — a wrong id
 * that happens not to equal the master. If the tab already has a `source` column
 * with values that are not this partner, we are pointed at the wrong file.
 */
function assertSafeToOverwrite(tab, source, targetId) {
  const lastRow = tab.getLastRow();
  const lastCol = tab.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return;  // empty or headers-only: safe

  const existing = tab.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = existing[0].map(function (h) { return String(h); });
  const srcCol = headers.indexOf('source');
  if (srcCol === -1) {
    // Has data rows but no source column — not a sheet this mirror produced.
    throw new Error(
      'REFUSING TO OVERWRITE ' + targetId + ': its "' + MIRROR_TAB_NAME + '" tab has ' +
      (lastRow - 1) + ' data row(s) but no "source" column, so it was not produced by ' +
      'this mirror. Check that this is the correct partner spreadsheet.'
    );
  }

  const foreign = {};
  for (let i = 1; i < existing.length; i++) {
    const v = String(existing[i][srcCol]).trim();
    if (v && v.toLowerCase() !== source.toLowerCase()) foreign[v] = true;
  }
  const names = Object.keys(foreign);
  if (names.length > 0) {
    throw new Error(
      'REFUSING TO OVERWRITE ' + targetId + ': its "' + MIRROR_TAB_NAME + '" tab contains ' +
      'rows from other sources (' + names.join(', ') + '). Clearing it would destroy data ' +
      'that is not "' + source + '". This is almost certainly the wrong spreadsheet id.'
    );
  }
}

function mirrorRowsForSource(source, targetId) {
  assertDistinctFromMaster(source, targetId);

  const master = SpreadsheetApp.openById(MIRROR_MASTER_ID).getSheetByName(MIRROR_TAB_NAME);
  if (!master) throw new Error('Master tab "' + MIRROR_TAB_NAME + '" not found in ' + MIRROR_MASTER_ID);

  const lastRow = master.getLastRow();
  const lastCol = master.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return;

  const all = master.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = all[0].map(function (h) { return String(h); });

  const srcCol = headers.indexOf('source');
  if (srcCol === -1) {
    // Without a source column every row would look like the partner's. Refuse
    // rather than copy the entire EyeCarePro prospect list into their file.
    throw new Error('No "source" column in the master sheet — refusing to mirror');
  }

  const matching = all.slice(1).filter(function (row) {
    return String(row[srcCol]).trim().toLowerCase() === source.toLowerCase();
  });

  const target = SpreadsheetApp.openById(targetId);
  let tab = target.getSheetByName(MIRROR_TAB_NAME);
  if (!tab) tab = target.insertSheet(MIRROR_TAB_NAME);

  // Second guard, in case the destination is some other sheet holding real data:
  // never clear a tab that contains rows belonging to anyone but this partner.
  assertSafeToOverwrite(tab, source, targetId);

  // clear() rather than deleting the sheet, so any formatting or filter views
  // the partner has set up survive the refresh.
  tab.clear();
  tab.getRange(1, 1, 1, headers.length).setValues([headers]);
  tab.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  if (matching.length > 0) {
    tab.getRange(2, 1, matching.length, headers.length).setValues(matching);
  }
  tab.setFrozenRows(1);

  console.log('Mirrored ' + matching.length + ' "' + source + '" row(s) to ' + targetId);
}
