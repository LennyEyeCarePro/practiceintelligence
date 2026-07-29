# Prompt — set up the Eyefinity lead mirror in Google Apps Script

Paste everything below the line into Claude with the browser extension enabled.
Have the EyeCarePro assessments spreadsheet open first.

Reusable: to onboard another partner brand later, change the brand name, the
spreadsheet ID, and the `source` value.

---

You are operating my browser to configure a Google Apps Script automation. Work
carefully and stop to ask me if anything does not match what is described.

## What we are building

Our lead-capture form writes every assessment into one master Google Sheet. Each
row has a `source` column naming the brand that generated it — currently
`EyeCarePro` or `Eyefinity`. I need the `Eyefinity` rows automatically copied
into a separate spreadsheet that I can share with our partner, without giving
them access to the master sheet (which contains all of our own prospects).

A separate spreadsheet is required because Google Sheets permissions are
per-document, not per-tab — hiding or protecting a tab would not stop a viewer
reading it via IMPORTRANGE or the API.

## 🚫 ABSOLUTE CONSTRAINTS — violating any of these breaks production

1. **NEVER click "Deploy", "Manage deployments", "New deployment", or "Test
   deployments"** anywhere in the Apps Script editor. The existing web app
   deployment is the only thing receiving our leads, and it has a legacy
   "Anyone" access setting that our Workspace can no longer grant. Re-saving that
   deployment could permanently lose it. We do not need to deploy anything: a
   time-driven trigger runs the latest **saved** code, which is why this approach
   was chosen.
2. **Do NOT edit, overwrite, rename or delete the existing `Code.gs`** (or any
   existing file). Everything goes in a brand-new file.
3. **Do NOT create a second Apps Script project** or a second web app.
4. If you are ever unsure, **stop and ask me** rather than guessing. Do not click
   through dialogs you did not expect.

## Step 1 — add the missing column headers to the master sheet

The script writes a row by matching the payload's field names against the header
names in **row 1**. Several fields have no column yet, so their data is being
discarded — including `source`, which the mirror depends on.

In the master spreadsheet, on the tab named **Assessments**:

1. Find the **first empty cell in row 1** (scroll right past the last header).
2. Paste this single tab-separated line into that cell. Google Sheets will spread
   it across consecutive columns:

```
source	capacityOptometry	capacitySurgical	capacityOptical	ehrPmsDetected	isEyefinityPms	revenueGapMonthly	strategicFocus	strategicAdvice	malignancySummary	technicalRootCause	emotionalRootCause	targetStatement	reportSource	reportUsedClientInput	reportFallbackReason	lighthouseError
```

3. Confirm to me that a column named exactly `source` now exists in row 1, and
   tell me which column letter it landed in.

Do not reorder or rename any existing headers. Order does not matter — only the
exact spelling, which is case-sensitive.

## Step 2 — create the new script file

1. In the master spreadsheet: **Extensions → Apps Script**
2. In the left **Files** panel, click the **+** and choose **Script**
3. Name it exactly `PartnerMirror`
4. It will open with a stub like `function myFunction() {}`. **Select all of that
   stub and delete it**, then paste in the code block below, in full.
5. Press **Ctrl+S** to save.
6. Confirm there are no red error markers. If you see an error containing
   "has already been declared", stop and tell me — it means a name collides with
   the existing `Code.gs` and I need to look at it.

```javascript
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
```

## Step 3 — create the trigger

1. In the Apps Script left sidebar, click the **clock icon** (Triggers)
2. Click **Add Trigger** (bottom right)
3. Set exactly:

   | Field | Value |
   |---|---|
   | Choose which function to run | `syncPartnerSheets` |
   | Choose which deployment should run | **Head** |
   | Select event source | **Time-driven** |
   | Select type of time based trigger | **Minutes timer** |
   | Select minute interval | **Every 15 minutes** |
   | Failure notification settings | Notify me daily |

4. Click **Save**
5. An authorisation prompt will appear. Approve it — it needs permission to open
   the partner spreadsheet. If it shows a "Google hasn't verified this app"
   warning, choose **Advanced → Go to (project name)**, since this is our own
   script.

## Step 4 — test it now, do not wait 15 minutes

1. In the Apps Script editor toolbar, select `syncPartnerSheets` in the function
   dropdown and click **Run**.
2. Open the **Execution log**. Report to me exactly what it says.
   - Expected: `Mirrored N "Eyefinity" row(s) to 1Vdgq...`
   - If it says `refusing to mirror`, Step 1 did not work — the `source` column
     is missing or misspelled. Go back and fix it.
   - Any other error: paste it to me verbatim.
3. Open the partner spreadsheet:
   https://docs.google.com/spreadsheets/d/1VdgqiSirZNxdtFvm1cCpWM5iy3iAPApxyRWA7gT19B4
   Confirm it now has an **Assessments** tab with a bold header row.
4. **Critical check:** scan the `source` column of that partner sheet and confirm
   **every** value reads `Eyefinity`. If you see even one `EyeCarePro` row, stop
   immediately and tell me — that is a data leak and I need to fix the code.
   (If there are no Eyefinity leads yet, headers-only is the correct result.)

## Step 5 — share it with the partner

In the partner spreadsheet: **Share** → add the email addresses I give you →
set the role to **Viewer**.

Do **not** grant Editor or Commenter. An Editor could widen the imported range
and read data they should not see. Ask me for the addresses before sending, and
uncheck "Notify people" unless I say otherwise.

## Report back

1. Which column letter `source` ended up in
2. The exact execution log line from the manual run
3. How many rows landed in the partner sheet, and confirmation that every
   `source` value in it reads `Eyefinity`
4. That the trigger is listed on the Triggers page as running every 15 minutes
5. Confirm you never opened any Deploy menu
