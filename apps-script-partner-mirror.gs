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
 * ⚠️ REQUIRED. Take it from the master spreadsheet URL:
 *   docs.google.com/spreadsheets/d/<THIS_PART>/edit
 */
const MIRROR_MASTER_ID = 'PASTE_MASTER_SPREADSHEET_ID';

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
  'Eyefinity': '1VdgqiSirZNxdtFvm1cCpWM5iy3iAPApxyRWA7gT19B4',
};

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
function mirrorRowsForSource(source, targetId) {
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
