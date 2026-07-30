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

## Step 0 — identify TWO different spreadsheets by title, and do not mix them up

This involves two separate documents. Confirming which is which is the single
most important thing in this task, because the mirror does a **full replace** on
the destination.

1. **The MASTER** — the one lead capture writes into. Its `Assessments` tab has
   roughly 110+ columns of existing data.
2. **The PARTNER destination** — a different document, for Eyefinity only.

For **each** one: open it, and report to me **both its title and its id** from the
URL (`docs.google.com/spreadsheets/d/<ID>/edit`). Wait for me to confirm the
pairing before you paste either id into the code.

**If the two ids are ever the same, stop.** The code will refuse to run in that
case, but do not rely on that — a full replace against the master would destroy
every prospect row.

**Expect the master's bound script to be empty.** If Extensions → Apps Script
shows only `function myFunction() {}`, that is normal: opening that menu on a
spreadsheet with no bound script creates an empty one. Our live lead-capture app
is a separate project — do not go looking for it, and do not edit it.

The mirror opens the master spreadsheet **by ID**, so it can live in any Apps
Script project. You do not need to find our lead-capture web app, and you should
not go looking for it.

1. With the master spreadsheet open, read its ID out of the URL:
   `docs.google.com/spreadsheets/d/<THIS_PART>/edit`
2. Tell me that ID, and hold on to it — it goes into `MIRROR_MASTER_ID` in Step 2.

**Expect the bound script to be empty.** If you open Extensions → Apps Script and
find only `function myFunction() {}`, that is normal and not a problem: opening
that menu on a spreadsheet with no bound script creates an empty one. Our live
lead-capture app is a separate project. Do not go and find it, do not edit it,
and do not worry that it is missing here — this mirror is fully self-contained and
does not depend on it.

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

## Step 2 — create the script file

1. In the master spreadsheet: **Extensions → Apps Script**
2. If the project contains only the empty `function myFunction() {}` stub, you may
   simply select all of it and replace it with the code below. If it contains real
   code, instead click the **+** in the left **Files** panel → **Script**, name it
   `PartnerMirror`, and paste there — leaving the existing code untouched.
3. Paste the code block below in full.
4. **Edit two lines**, using the ids I confirmed in Step 0:
   - `MIRROR_MASTER_ID` → the **master** spreadsheet id
   - `PARTNER_SHEETS['Eyefinity']` → the **partner** spreadsheet id
   These must be **two different ids**. If you are about to paste the same value
   into both, stop and ask me. Leave everything else exactly as written.
5. Press **Ctrl+S** to save.
6. Confirm there are no red error markers. If you see "has already been declared",
   stop and tell me which name — it would mean a collision with existing code.

```javascript
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
  // ⚠️ MUST be the partner's OWN spreadsheet, never the master.
  //
  // This previously held 1VdgqiSirZNxdtFvm1cCpWM5iy3iAPApxyRWA7gT19B4, which is
  // the MASTER's id — that was a mix-up on my part, and running it would have
  // called tab.clear() on the master and destroyed every EyeCarePro prospect
  // row. assertDistinctFromMaster() and assertSafeToOverwrite() below now make
  // that outcome impossible, but fill this in carefully anyway.
  'Eyefinity': 'PASTE_EYEFINITY_PARTNER_SHEET_ID',
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
   - Expected: `Mirrored N "Eyefinity" row(s) to <the partner id>`
   - `REFUSING TO RUN` or `REFUSING TO OVERWRITE` → the ids are wrong. Do **not**
     try to work around it — report it to me verbatim. These guards exist because
     a full replace against the wrong document would destroy data.
   - `MIRROR_MASTER_ID is not set` → Step 2 item 4 was missed. Paste the master ID in.
   - `refusing to mirror` → Step 1 did not take; the `source` column is missing or
     misspelled in row 1 of the master.
   - `Master tab "Assessments" not found` → the master ID is wrong, or its tab has a
     different name. Tell me the actual tab name rather than guessing.
   - Any other error: paste it to me verbatim.
3. Open the **partner** spreadsheet — the id you put in `PARTNER_SHEETS`, not the
   master. Confirm it now has an **Assessments** tab with a bold header row, and
   confirm the master is unchanged.
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
