/**
 * syncNotionToSheets.gs
 * ============================================================
 * Syncs the Notion "ESL Project list" DB to the Google Sheets
 * tab "Notion_raw" (columns A–S, plus Notion_ID at T).
 *
 * Strategy: CLEAR + DUMP (jira_url is PK)
 *   1. Fetch all pages from Notion API.
 *   2. Build a row per page in NOTION_RAW_HEADERS order.
 *   3. Clear existing data rows (cols A–Notion_ID), write fresh.
 *   4. Run ensureOverallAnchors() so any new jira_urls get a row in Overall.
 *
 *   Row order is NOT preserved — and intentionally so. After the 2026-04
 *   refactor, all downstream tabs (Overall, Realistic Scenario) join on
 *   jira_url via XLOOKUP. Row position is irrelevant; manual-input columns
 *   in Overall are anchored to jira_url, not row number, so they survive
 *   any reordering of Notion_raw.
 *
 * Column order (col J = JIRA URL, the primary key):
 *   A  Requirement
 *   B  Priority
 *   C  Strategic
 *   D  Status
 *   E  PM Size
 *   F  PRD (Done? Y/N)
 *   G  Eng Size
 *   H  Team
 *   I  Comment
 *   J  JIRA                   <- PK (XLOOKUP key in Overall + Realistic)
 *   K  Prelim. Committed Date
 *   L  PM Owner
 *   M  PMO Owner
 *   N  Start-End Date
 *   O  Kickoff Meeting Link
 *   P  Kickoff Meeting Notes
 *   Q  PRD URL
 *   R  Blocked by
 *   S  Blocking
 *   T  Notion_ID (page UUID, kept for diagnostics only)
 *
 * Requirements:
 *   - Script Property "notionToken" must be set.
 *   - Notion DB ID: 33b5bd55-7775-8190-9e38-fa14f6b29411
 * ============================================================
 */

const NOTION_DB_ID   = '33b5bd55-7775-8190-9e38-fa14f6b29411';
const NOTION_VERSION = '2022-06-28';
const NOTION_RAW_TAB = 'Notion_raw';

const NOTION_RAW_HEADERS = [
  'Requirement',            // A
  'Priority',               // B
  'Strategic',              // C
  'Status',                 // D
  'PM Size',                // E
  'PRD (Done? Y/N)',        // F
  'Eng Size',               // G
  'Team',                   // H
  'Comment',                // I
  'JIRA',                   // J  <- INDEX/MATCH anchor
  'Prelim. Committed Date', // K
  'PM Owner',               // L
  'PMO Owner',              // M
  'Start-End Date',         // N
  'Kickoff Meeting Link',   // O
  'Kickoff Meeting Notes',  // P
  'PRD URL',                // Q
  'Blocked by',             // R
  'Blocking',               // S
];

// ============================================================
// Main sync function — clear + dump (jira_url is PK)
// ============================================================
//
// Strategy: full overwrite on every sync.
//   1. Fetch all Notion pages.
//   2. Build a row per page (A through Notion_ID).
//   3. Clear existing data rows in cols A–Notion_ID, write fresh.
//   4. Call ensureOverallAnchors() so new jira_urls appear in Overall.
//
// Row order is NOT preserved — and no longer needs to be. All downstream
// formulas (Overall, Realistic Scenario) join on jira_url (PK), so the
// physical row position of any task is irrelevant.
//
function syncNotionToSheets() {
  const token = PropertiesService.getScriptProperties().getProperty('notionToken');
  if (!token) throw new Error('notionToken not found in Script Properties');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet_(ss, NOTION_RAW_TAB);

  const totalCols    = NOTION_RAW_HEADERS.length + 1;          // +1 for Notion_ID
  const finalHeaders = NOTION_RAW_HEADERS.concat(['Notion_ID']);

  // ── 1. Fetch all Notion pages ────────────────────────────────
  Logger.log('Fetching Notion pages...');
  const pages = fetchAllNotionPages_(token, NOTION_DB_ID);
  Logger.log('Fetched ' + pages.length + ' total Notion pages.');

  const pageIdToJiraKey = buildPageIdToJiraKeyMap_(pages);

  // ── 2. Convert each page to a row in NOTION_RAW_HEADERS order
  const rows  = [];
  let skipped = 0;

  pages.forEach(function(page) {
    const props = page.properties;
    const req   = notionTitle_(props['Requirement']);
    if (!req) { skipped++; return; }

    const jiraUrl       = notionUrl_(props['JIRA']);
    const blockedByIds  = notionRelation_(props['Blocked by']).concat(notionRelation_(props['Blocked by 1']));
    const blockingIds   = notionRelation_(props['Blocking']).concat(notionRelation_(props['Blocking 1']));
    const blockedByKeys = blockedByIds.map(function(id) { return pageIdToJiraKey[id] || id; }).join(', ');
    const blockingKeys  = blockingIds.map(function(id)  { return pageIdToJiraKey[id] || id; }).join(', ');
    const dateRange     = notionDateRange_(props['Start-End Date']);
    const startEndStr   = formatDateRange_(dateRange.start, dateRange.end);

    rows.push([
      req,                                              // A  Requirement
      notionSelect_(props['Priority']),                 // B
      notionCheckboxOrSelect_(props['Strategic']),       // C
      notionSelect_(props['Status']),                   // D
      notionSelect_(props['PM Size']),                  // E
      notionTextOrSelect_(props['PRD (Done? Y/N)']),    // F
      notionSelect_(props['Eng Size']),                 // G
      notionSelectOrMulti_(props['Team']),              // H
      notionText_(props['Comment']),                    // I
      jiraUrl,                                          // J  JIRA URL  (PK)
      notionDate_(props['Prelim. Committed Date']),     // K
      notionPerson_(props['PM Owner']),                 // L
      notionPerson_(props['PMO Owner']),                // M
      startEndStr,                                      // N
      notionText_(props['Kickoff Meeting Link']),        // O
      notionText_(props['Kickoff Meeting Notes']),      // P
      notionUrl_(props['PRD URL']),                     // Q
      blockedByKeys,                                    // R
      blockingKeys,                                     // S
      page.id,                                          // T  Notion_ID (diagnostic)
    ]);
  });

  // ── 3. Clear existing data rows and write fresh ──────────────
  // Only clear cols A–Notion_ID; any extra cols beyond stay untouched.
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, totalCols).clearContent();
  }
  sheet.getRange(1, 1, 1, totalCols).setValues([finalHeaders]);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, totalCols).setValues(rows);
  }
  sheet.setFrozenRows(1);
  Logger.log('Notion_raw sync complete. Rows written: ' + rows.length);

  // ── 4. Ensure Overall has anchor row for every jira_url ──────
  try {
    ensureOverallAnchors();
  } catch (e) {
    Logger.log('ensureOverallAnchors warning (non-fatal): ' + e.message);
  }

  // ── 5. Informational: duplicate Requirement names in Notion ──
  const reqCount = {};
  rows.forEach(function(r) {
    const name = String(r[0] || '').trim();
    if (name) reqCount[name] = (reqCount[name] || 0) + 1;
  });
  const duplicates = Object.keys(reqCount).filter(function(r) { return reqCount[r] > 1; });
  if (duplicates.length > 0) {
    Logger.log('NOTE: Duplicate Requirement names in Notion: ' + duplicates.join(', '));
  }

  return {
    rowsWritten:  rows.length,
    skipped:      skipped,
    totalFetched: pages.length,
    duplicates:   duplicates,
  };
}

// ============================================================
// Notion API: paginated fetch
// ============================================================
function fetchAllNotionPages_(token, dbId) {
  var pages   = [];
  var cursor  = null;
  var pageNum = 0;

  do {
    pageNum++;
    var body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    var response = UrlFetchApp.fetch(
      'https://api.notion.com/v1/databases/' + dbId + '/query',
      {
        method:  'POST',
        headers: {
          'Authorization':  'Bearer ' + token,
          'Notion-Version': NOTION_VERSION,
          'Content-Type':   'application/json',
        },
        payload:            JSON.stringify(body),
        muteHttpExceptions: true,
      }
    );

    var json = JSON.parse(response.getContentText());

    if (json.object === 'error') {
      throw new Error('Notion API error (page ' + pageNum + '): ' + json.message);
    }

    pages = pages.concat(json.results);
    Logger.log('  Page ' + pageNum + ': ' + json.results.length + ' records (total: ' + pages.length + ')');

    cursor = json.has_more ? json.next_cursor : null;
  } while (cursor);

  return pages;
}

// ============================================================
// Build pageId → JIRA issue key map (for relation resolution)
// ============================================================
function buildPageIdToJiraKeyMap_(pages) {
  var map = {};
  pages.forEach(function(page) {
    var jiraUrl = notionUrl_(page.properties['JIRA']);
    if (jiraUrl && jiraUrl.startsWith('http')) {
      var key = jiraUrl.split('/').pop().trim();
      if (key) map[page.id] = key;
    }
  });
  return map;
}

// ============================================================
// Sheets helper
// ============================================================
function getOrCreateSheet_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    Logger.log('Created new sheet: "' + name + '"');
  }
  return sheet;
}

// ============================================================
// Overall tab anchor maintenance
// ============================================================
/**
 * Ensures every jira_url in Notion_raw exists as an anchor row in Overall.
 * Missing jira_urls are appended at the bottom of Overall; manual columns
 * (Lead, Allocation, Headcount, Risk, etc.) remain blank for human input.
 *
 * Called automatically at the end of syncNotionToSheets().
 * Can also be run manually from the menu ("Ensure Overall Anchors").
 *
 * Row order is NOT preserved — PK-based XLOOKUPs in other tabs are
 * independent of row position, so append-at-bottom is always safe.
 */
function ensureOverallAnchors() {
  var ss      = SpreadsheetApp.getActiveSpreadsheet();
  var overall = ss.getSheetByName('Overall');
  var raw     = ss.getSheetByName(NOTION_RAW_TAB);
  if (!overall) throw new Error('Overall tab not found.');
  if (!raw)     throw new Error('Notion_raw tab not found.');

  // Notion_raw jira_url column = col J (index 10, 1-based)
  var rawLastRow = raw.getLastRow();
  if (rawLastRow < 2) {
    Logger.log('ensureOverallAnchors: Notion_raw is empty, nothing to do.');
    return;
  }
  var rawUrls = raw.getRange(2, 10, rawLastRow - 1, 1)
                   .getValues()
                   .map(function(r) { return String(r[0] || '').trim(); })
                   .filter(function(u) { return u && u.indexOf('http') === 0; });

  // Overall jira_url column = col A
  var overallLastRow = overall.getLastRow();
  var existingUrls = {};
  if (overallLastRow >= 2) {
    overall.getRange(2, 1, overallLastRow - 1, 1)
           .getValues()
           .forEach(function(r) {
             var v = String(r[0] || '').trim();
             if (v) existingUrls[v] = true;
           });
  }

  var missing = rawUrls.filter(function(u) { return !existingUrls[u]; });
  if (missing.length === 0) {
    Logger.log('ensureOverallAnchors: Overall is already up to date.');
    ss.toast('Overall anchors: up to date', 'Overall', 5);
    return;
  }

  // Append missing urls as new rows, col A only (formulas in B onward
  // will auto-populate via XLOOKUP; manual cols stay blank).
  var appendStartRow = overall.getLastRow() + 1;
  overall.getRange(appendStartRow, 1, missing.length, 1)
         .setValues(missing.map(function(u) { return [u]; }));

  Logger.log('ensureOverallAnchors: appended ' + missing.length + ' new jira_url anchor(s).');
  ss.toast('Overall anchors: appended ' + missing.length + ' new row(s)', 'Overall', 5);
}

// ============================================================
// Date formatting helper
// ============================================================
function formatDateRange_(start, end) {
  if (!start) return '';
  if (end && end !== start) return start + ' → ' + end;
  return start;
}

// ============================================================
// Notion property extractors (underscore suffix avoids name
// collision with webApp.gs helpers in the same project)
// ============================================================
function notionTitle_(prop) {
  if (!prop || !prop.title || !prop.title.length) return '';
  return prop.title.map(function(r) { return r.plain_text; }).join('').trim();
}

function notionText_(prop) {
  if (!prop || !prop.rich_text || !prop.rich_text.length) return '';
  return prop.rich_text.map(function(r) { return r.plain_text; }).join('').trim();
}

function notionUrl_(prop) {
  return (prop && prop.url) ? prop.url.trim() : '';
}

function notionSelect_(prop) {
  return (prop && prop.select && prop.select.name) ? prop.select.name : '';
}

function notionCheckbox_(prop) {
  if (!prop || prop.type !== 'checkbox') return '';
  return prop.checkbox ? 'Yes' : 'No';
}

// Handles fields that may be checkbox OR select depending on Notion setup
function notionCheckboxOrSelect_(prop) {
  if (!prop) return '';
  if (prop.type === 'checkbox') return prop.checkbox ? 'Yes' : 'No';
  if (prop.select && prop.select.name) return prop.select.name;
  return '';
}

// Handles fields that may be rich_text OR select
function notionTextOrSelect_(prop) {
  if (!prop) return '';
  if (prop.type === 'rich_text' && prop.rich_text && prop.rich_text.length)
    return prop.rich_text.map(function(r) { return r.plain_text; }).join('').trim();
  if (prop.type === 'select' && prop.select && prop.select.name) return prop.select.name;
  return '';
}

function notionSelectOrMulti_(prop) {
  if (!prop) return '';
  if (prop.select && prop.select.name) return prop.select.name;
  if (prop.multi_select && prop.multi_select.length) {
    return prop.multi_select.map(function(s) { return s.name; }).join(', ');
  }
  return '';
}

function notionPerson_(prop) {
  if (!prop || !prop.people || !prop.people.length) return '';
  return prop.people.map(function(p) { return p.name || p.id; }).join(', ');
}

function notionDate_(prop) {
  if (!prop || !prop.date || !prop.date.start) return '';
  return prop.date.start;
}

function notionDateRange_(prop) {
  if (!prop || !prop.date) return { start: '', end: '' };
  return {
    start: prop.date.start || '',
    end:   prop.date.end   || '',
  };
}

function notionRelation_(prop) {
  if (!prop || !prop.relation || !prop.relation.length) return [];
  return prop.relation.map(function(r) { return r.id; });
}

// ============================================================
// Notion vs Sheets comparison
// ============================================================

/**
 * Compares Notion DB live data against Notion_raw sheet.
 * Writes a color-coded diff report to "Notion_diff" tab.
 *
 * Issue types:
 *   FIELD_MISMATCH    — same row, but value differs between Notion and Sheets
 *   MISSING_IN_SHEETS — page exists in Notion but has no row in Notion_raw
 *   STALE_IN_SHEETS   — row exists in Notion_raw but not found in Notion anymore
 */
function compareNotionVsSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Comparing Notion vs Notion_raw…  this may take 10–30 seconds.', 'Notion Diff', 60);

  var token = PropertiesService.getScriptProperties().getProperty('notionToken');
  if (!token) throw new Error('notionToken not found in Script Properties');

  // ── Read Notion_raw ──────────────────────────────────────────
  var rawSheet = ss.getSheetByName(NOTION_RAW_TAB);
  if (!rawSheet) throw new Error('Notion_raw sheet not found.');
  var rawData    = rawSheet.getDataRange().getValues();
  var rawHeaders = rawData[0];
  var jiraColIdx = rawHeaders.indexOf('JIRA');
  var reqColIdx  = rawHeaders.indexOf('Requirement');

  // Index: JIRA URL → row index (1-based into rawData array)
  var sheetByJira = {};
  var sheetByReq  = {};
  for (var i = 1; i < rawData.length; i++) {
    var sJira = String(rawData[i][jiraColIdx] || '').trim();
    var sReq  = String(rawData[i][reqColIdx]  || '').trim();
    if (sJira && sJira.startsWith('http')) sheetByJira[sJira] = i;
    else if (sReq) sheetByReq[sReq] = i;
  }

  // ── Fetch from Notion ────────────────────────────────────────
  var pages           = fetchAllNotionPages_(token, NOTION_DB_ID);
  var pageIdToJiraKey = buildPageIdToJiraKeyMap_(pages);

  // ── Fields to compare ────────────────────────────────────────
  var COMPARE_FIELDS = [
    { label: 'Status',         sheetsCol: 'Status',
      get: function(p) { return notionSelect_(p['Status']); } },
    { label: 'Priority',       sheetsCol: 'Priority',
      get: function(p) { return notionSelect_(p['Priority']); } },
    { label: 'Team',           sheetsCol: 'Team',
      get: function(p) { return notionSelectOrMulti_(p['Team']); } },
    { label: 'PRD',            sheetsCol: 'PRD (Done? Y/N)',
      get: function(p) { return notionTextOrSelect_(p['PRD (Done? Y/N)']); } },
    { label: 'Strategic',      sheetsCol: 'Strategic',
      get: function(p) { return notionCheckboxOrSelect_(p['Strategic']); } },
    { label: 'Start-End Date', sheetsCol: 'Start-End Date',
      get: function(p) {
        var dr = notionDateRange_(p['Start-End Date']);
        return formatDateRange_(dr.start, dr.end);
      } },
    { label: 'PM Owner',       sheetsCol: 'PM Owner',
      get: function(p) { return notionPerson_(p['PM Owner']); } },
    { label: 'PMO Owner',      sheetsCol: 'PMO Owner',
      get: function(p) { return notionPerson_(p['PMO Owner']); } },
    { label: 'Eng Size',       sheetsCol: 'Eng Size',
      get: function(p) { return notionSelect_(p['Eng Size']); } },
    { label: 'PM Size',        sheetsCol: 'PM Size',
      get: function(p) { return notionSelect_(p['PM Size']); } },
  ];

  // ── Compare ──────────────────────────────────────────────────
  var diffs        = [];
  var notionJirasSeen = {};
  var now = new Date().toLocaleString();

  pages.forEach(function(page) {
    var props   = page.properties;
    var req     = notionTitle_(props['Requirement']);
    var jiraUrl = notionUrl_(props['JIRA']);
    if (!req) return;

    var sheetIdx = null;
    if (jiraUrl && jiraUrl.startsWith('http')) {
      notionJirasSeen[jiraUrl] = true;
      sheetIdx = sheetByJira[jiraUrl];
    } else {
      sheetIdx = sheetByReq[req];
    }

    var jiraKey = jiraUrl ? jiraUrl.split('/').pop() : '';

    if (sheetIdx === null || sheetIdx === undefined) {
      diffs.push([jiraKey, req, '(row)', '(exists in Notion)', '(MISSING from Notion_raw)', 'MISSING_IN_SHEETS', now]);
      return;
    }

    // Compare each field
    COMPARE_FIELDS.forEach(function(f) {
      var notionVal  = f.get(props).trim();
      var colIdx     = rawHeaders.indexOf(f.sheetsCol);
      var sheetsVal  = colIdx >= 0 ? String(rawData[sheetIdx][colIdx] || '').trim() : '';
      if (notionVal !== sheetsVal) {
        diffs.push([jiraKey, req, f.label, notionVal, sheetsVal, 'FIELD_MISMATCH', now]);
      }
    });
  });

  // Stale rows: in Sheets but JIRA URL no longer found in Notion
  for (var i = 1; i < rawData.length; i++) {
    var sj = String(rawData[i][jiraColIdx] || '').trim();
    var sr = String(rawData[i][reqColIdx]  || '').trim();
    if (!sr) continue;
    if (sj && sj.startsWith('http') && !notionJirasSeen[sj]) {
      diffs.push([sj.split('/').pop(), sr, '(row)', '(NOT in Notion)', '(stale in Notion_raw)', 'STALE_IN_SHEETS', now]);
    }
  }

  // ── Write Notion_diff sheet ──────────────────────────────────
  var diffSheet = getOrCreateSheet_(ss, 'Notion_diff');
  diffSheet.clearContents();
  diffSheet.clearFormats();

  var header = [['JIRA Key', 'Requirement', 'Field', 'Notion Value', 'Sheets Value', 'Issue Type', 'Run At']];
  var allRows = header.concat(diffs);

  diffSheet.getRange(1, 1, allRows.length, 7).setValues(allRows);

  // Header style
  var hdr = diffSheet.getRange(1, 1, 1, 7);
  hdr.setFontWeight('bold');
  hdr.setBackground('#1e293b');
  hdr.setFontColor('#ffffff');

  // Color rows by type — batch all backgrounds in one call
  if (allRows.length > 1) {
    var bgColors = allRows.slice(1).map(function(row) {
      var type = row[5];
      var bg = type === 'MISSING_IN_SHEETS' ? '#fef9c3'
             : type === 'STALE_IN_SHEETS'   ? '#fce7f3'
             :                                '#fff7ed';
      return [bg, bg, bg, bg, bg, bg, bg];
    });
    diffSheet.getRange(2, 1, bgColors.length, 7).setBackgrounds(bgColors);
  }

  diffSheet.autoResizeColumns(1, 7);
  diffSheet.setFrozenRows(1);
  ss.setActiveSheet(diffSheet);

  // Summary alert
  var nMismatch = diffs.filter(function(d) { return d[5] === 'FIELD_MISMATCH'; }).length;
  var nMissing  = diffs.filter(function(d) { return d[5] === 'MISSING_IN_SHEETS'; }).length;
  var nStale    = diffs.filter(function(d) { return d[5] === 'STALE_IN_SHEETS'; }).length;
  SpreadsheetApp.getUi().alert(
    'Comparison Complete',
    diffs.length + ' differences found — see "Notion_diff" tab.\n\n' +
    'Field mismatches (out of sync) : ' + nMismatch + '\n' +
    'Missing in Notion_raw           : ' + nMissing  + '\n' +
    'Stale rows (not in Notion)      : ' + nStale,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ============================================================
// Custom menu (runs on spreadsheet open)
// ============================================================

/**
 * Adds "Notion Sync" menu to the spreadsheet toolbar.
 * Triggered automatically when the spreadsheet is opened.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Notion Sync')
    .addItem('Run Sync Now', 'runSyncWithAlert')
    .addItem('Compare Notion vs Sheets', 'compareNotionVsSheets')
    .addItem('Ensure Overall Anchors', 'ensureOverallAnchors')
    .addSeparator()
    .addItem('Remove Duplicate Rows (run once to fix)', 'removeDuplicateRows')
    .addSeparator()
    .addItem('Set Up Daily Auto-Sync', 'setupDailyTrigger')
    .addItem('Remove Auto-Sync', 'removeDailyTrigger')
    .addToUi();
}

/**
 * Runs the sync and shows a popup with the result.
 * Called from the "Notion Sync → Run Sync Now" menu item.
 */
function runSyncWithAlert() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  try {
    ss.toast('Syncing with Notion... this may take 10–30 seconds.', 'Notion Sync', 60);
    var result = syncNotionToSheets();
    var msg =
      'Total from Notion : ' + result.totalFetched + '\n' +
      'Rows written      : ' + result.rowsWritten + '\n' +
      'Skipped (no name) : ' + result.skipped;
    if (result.duplicates && result.duplicates.length > 0) {
      msg += '\n\nNote: Duplicate Requirement names in Notion:\n' + result.duplicates.join('\n');
    }
    ui.alert('Notion Sync Complete', msg, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Sync Error', err.message + '\n\nCheck Apps Script logs (Extensions → Apps Script → Executions) for details.', ui.ButtonSet.OK);
  }
}

/**
 * Removes duplicate rows from Notion_raw caused by past matching failures.
 * Keeps the FIRST occurrence of each JIRA URL / Requirement name (original row order).
 * Run this ONCE to clean up, then run sync.
 */
function removeDuplicateRows() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var ui  = SpreadsheetApp.getUi();
  try {
    var sheet = ss.getSheetByName(NOTION_RAW_TAB);
    if (!sheet) { ui.alert('Notion_raw sheet not found.'); return; }

    ss.toast('Step 1/3: Reading sheet data…', 'Dedup', 30);
    var data       = sheet.getDataRange().getValues();
    var headers    = data[0];
    var jiraColIdx = headers.indexOf('JIRA');
    var reqColIdx  = headers.indexOf('Requirement');
    var totalCols  = headers.length;

    Logger.log('removeDuplicateRows: ' + (data.length - 1) + ' rows, ' + totalCols + ' cols, JIRA col=' + jiraColIdx + ', Req col=' + reqColIdx);

    if (jiraColIdx === -1 || reqColIdx === -1) {
      ui.alert('Error', 'JIRA or Requirement column not found in Notion_raw headers.\nFound headers: ' + headers.join(', '), ui.ButtonSet.OK);
      return;
    }

    ss.toast('Step 2/3: Scanning for duplicates…', 'Dedup', 30);
    var seenUrl = {};
    var seenReq = {};
    var kept    = [];
    var removed = 0;

    for (var i = 1; i < data.length; i++) {
      var jiraUrl = String(data[i][jiraColIdx] || '').trim();
      var req     = String(data[i][reqColIdx]  || '').trim();
      var isDup   = false;

      if (jiraUrl && jiraUrl.startsWith('http')) {
        if (seenUrl[jiraUrl]) { isDup = true; } else { seenUrl[jiraUrl] = true; }
      } else if (req) {
        if (seenReq[req]) { isDup = true; } else { seenReq[req] = true; }
      }
      if (isDup) { removed++; } else { kept.push(data[i]); }
    }

    Logger.log('removeDuplicateRows: kept=' + kept.length + ', removed=' + removed);

    if (removed === 0) {
      ui.alert('No duplicate rows found.');
      return;
    }

    if (kept.length === 0) {
      ui.alert('Error', 'All rows flagged as duplicates — this is unexpected. Check the sheet manually.', ui.ButtonSet.OK);
      return;
    }

    // Normalize: ensure every kept row has exactly totalCols cells
    for (var k = 0; k < kept.length; k++) {
      while (kept[k].length < totalCols) kept[k].push('');
      if (kept[k].length > totalCols) kept[k] = kept[k].slice(0, totalCols);
    }

    ss.toast('Step 3/3: Writing ' + kept.length + ' rows, removing ' + removed + ' duplicates…', 'Dedup', 60);
    Logger.log('removeDuplicateRows: writing ' + kept.length + ' rows back to sheet');

    sheet.getRange(2, 1, kept.length, totalCols).setValues(kept);

    var leftoverStart = kept.length + 2;
    var lastRow = sheet.getLastRow();
    Logger.log('removeDuplicateRows: leftoverStart=' + leftoverStart + ', lastRow=' + lastRow);
    if (leftoverStart <= lastRow) {
      sheet.deleteRows(leftoverStart, lastRow - leftoverStart + 1);
    }

    ui.alert('Cleanup complete', removed + ' duplicate rows removed.\nNow run Notion Sync → Run Sync Now.', ui.ButtonSet.OK);

  } catch (err) {
    Logger.log('removeDuplicateRows ERROR: ' + err.message + '\n' + err.stack);
    SpreadsheetApp.getUi().alert('Error in removeDuplicateRows', err.message + '\n\nCheck Apps Script logs (Extensions → Apps Script → Executions) for stack trace.', SpreadsheetApp.getUi().ButtonSet.OK);
  }
}

/**
 * Sets up a daily time-based trigger to run syncNotionToSheets automatically.
 * Runs once per day between 7–8 AM (script timezone).
 * Safe to call multiple times — removes existing trigger first.
 */
function setupDailyTrigger() {
  removeDailyTrigger(); // avoid duplicates
  ScriptApp.newTrigger('syncNotionToSheets')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();
  SpreadsheetApp.getUi().alert(
    'Auto-Sync Enabled',
    'Notion_raw will sync automatically every day at ~7 AM.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/**
 * Removes all time-based triggers for syncNotionToSheets.
 */
function removeDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'syncNotionToSheets') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

// ============================================================
// Diagnostic: inspect raw Notion properties for a specific JIRA URL
// Usage: set JIRA_URL below and run diagnosePage_()
// ============================================================
function diagnosePage() { diagnosePage_(); }
function diagnosePage_() {
  var JIRA_URL = 'https://ujetcs.atlassian.net/browse/CALL-4352'; // ← change if needed

  var token = PropertiesService.getScriptProperties().getProperty('notionToken');
  if (!token) throw new Error('notionToken not found in Script Properties');

  var pages = fetchAllNotionPages_(token, NOTION_DB_ID);
  var target = pages.find(function(p) {
    return notionUrl_(p.properties['JIRA']) === JIRA_URL;
  });

  if (!target) {
    Logger.log('Page not found for JIRA URL: ' + JIRA_URL);
    return;
  }

  Logger.log('=== Page found: ' + target.id + ' ===');
  Logger.log('All property names and types:');
  Object.keys(target.properties).forEach(function(key) {
    var prop = target.properties[key];
    Logger.log('  "' + key + '" → type: ' + prop.type + ' | raw: ' + JSON.stringify(prop).slice(0, 120));
  });

  Logger.log('\n--- Start-End Date specifically ---');
  var dateProp = target.properties['Start-End Date'];
  Logger.log(dateProp ? JSON.stringify(dateProp) : 'NOT FOUND (property name may differ)');
}

// ============================================================
// Test / diagnostic function
// ============================================================
function testSyncNotionToSheets() {
  Logger.log('=== testSyncNotionToSheets: START ===');
  var start = Date.now();

  try {
    var result  = syncNotionToSheets();
    var elapsed = ((Date.now() - start) / 1000).toFixed(1);

    Logger.log('=== testSyncNotionToSheets: COMPLETE ===');
    Logger.log('  Total Notion pages fetched : ' + result.totalFetched);
    Logger.log('  In-place updates           : ' + result.matched);
    Logger.log('  New rows appended          : ' + result.added);
    Logger.log('  Skipped (no name)          : ' + result.skipped);
    Logger.log('  Elapsed time               : ' + elapsed + 's');

    // Spot-check: print header + first 5 data rows
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(NOTION_RAW_TAB);
    if (sheet && sheet.getLastRow() > 1) {
      var preview = sheet.getRange(1, 1, Math.min(6, sheet.getLastRow()), NOTION_RAW_HEADERS.length).getValues();
      Logger.log('\n--- Sheet preview (header + up to 5 rows) ---');
      preview.forEach(function(row, i) {
        var label = i === 0 ? 'HEADER' : 'Row ' + i;
        Logger.log('  ' + label + ': Req="' + row[0] + '" | Priority="' + row[1] + '" | Status="' + row[3] + '" | JIRA="' + row[9] + '"');
      });
    }
  } catch (err) {
    Logger.log('ERROR: ' + err.message);
    Logger.log(err.stack);
  }

  Logger.log('=== testSyncNotionToSheets: END ===');
}
