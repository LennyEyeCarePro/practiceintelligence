/**
 * PartnerMirror.gs — ADD THIS AS A NEW FILE in the existing Apps Script project.
 *
 * Copies each partner brand's rows out of the EyeCarePro master sheet into that
 * partner's own spreadsheet, on a timer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SEPARATE FILE INSTEAD OF REPLACING Code.gs
 * Apps Script files in one project share a single global scope, so this can add
 * functions without touching the existing code. That matters here: the live web
 * app is the only working anonymous lead-capture path, and pasting over Code.gs
 * would overwrite anything that has drifted in the editor and was never
 * committed back to the repo.
 *
 * ⚠️ DO NOT also paste the full google-apps-script.js into this project. That
 * file now contains its own BRAND_SHEETS declaration, and two `const
 * BRAND_SHEETS` in the same project is a duplicate-declaration error that breaks
 * every function, including doPost. Use one or the other, not both.
 *
 * This file deliberately does NOT declare SHEET_NAME — Code.gs already does, and
 * redeclaring it would be the same kind of error.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY A TRIGGER AND NOT doPost ROUTING
 * The live web app serves a PINNED script version. Routing inside doPost would
 * require deploying a new version, which on this Workspace risks losing the
 * grandfathered Access="Anyone" setting. A time-driven trigger runs the latest
 * SAVED code and needs no deployment at all.
 *
 * WHY A SEPARATE DOCUMENT AND NOT A TAB
 * Google Sheets permissions are per-document, not per-tab. Sharing the master
 * would expose every EyeCarePro prospect; hiding or protecting a tab is not a
 * boundary, since a viewer can still read it via IMPORTRANGE or the API.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP — where to click
 *   1. Open the EyeCarePro Sheet → Extensions → Apps Script
 *   2. In the left "Files" panel, click the + → Script
 *   3. Name it  PartnerMirror   (the .gs is added for you)
 *   4. Delete the stub `myFunction() {}` it creates, paste this whole file, Ctrl+S
 *      → DO NOT click Deploy
 *   5. Left sidebar → Triggers (the clock icon) → Add Trigger (bottom right)
 *        Choose which function to run ......  syncPartnerSheets
 *        Which runs at deployment ..........  Head
 *        Select event source ...............  Time-driven
 *        Select type of time based trigger .  Minutes timer
 *        Select minute interval ............  Every 15 minutes
 *      → Save, then accept the authorisation prompt
 *   6. Share the partner spreadsheet with the partner as VIEWER, not Editor.
 *      An Editor could widen the range and read everything.
 *
 * TO TEST IT IMMEDIATELY: pick syncPartnerSheets in the toolbar function
 * dropdown and press Run. Check View → Logs for the row count.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Partner destination spreadsheets, keyed by the `source` value written by
 * index.html (BRAND.name).
 *
 * The empty string for EyeCarePro means "the bound spreadsheet" and is skipped
 * by the mirror — the master is the source, not a destination.
 *
 * TO ADD A PARTNER: create their spreadsheet and paste its ID here. The ID is
 * the long segment of the URL:
 *   docs.google.com/spreadsheets/d/<THIS_PART>/edit
 */
const BRAND_SHEETS = {
  'EyeCarePro': '',
  'Eyefinity': '1VdgqiSirZNxdtFvm1cCpWM5iy3iAPApxyRWA7gT19B4',
};

/**
 * Entry point for the time-driven trigger. Mirrors every configured partner.
 * One partner failing does not stop the others.
 */
function syncPartnerSheets() {
  for (const source in BRAND_SHEETS) {
    const targetId = BRAND_SHEETS[source];
    if (!targetId || targetId.indexOf('PASTE_') === 0) continue;
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
  const master = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!master) throw new Error('Master tab "' + SHEET_NAME + '" not found');

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
  let tab = target.getSheetByName(SHEET_NAME);
  if (!tab) tab = target.insertSheet(SHEET_NAME);

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
