/**
 * syncNotionToSheets.gs
 * ============================================================
 * Syncs the Notion "ESL Project list" DB to the Google Sheets
 * tab "Notion_raw" (columns A–S).
 *
 * Strategy: IN-PLACE UPDATE (preserves existing row order)
 *   1. Read Notion_raw into memory.
 *   2. Build index maps: { jiraUrl → arrayIndex } and { requirement → arrayIndex }.
 *   3. Fetch all pages from Notion API.
 *   4. For each Notion page:
 *        - Match by JIRA URL first, then by Requirement name.
 *        - If matched → update that slot in the in-memory array.
 *        - If no match → append as new row at the end.
 *   5. Write the entire array back to the sheet in one batch call.
 *
 *   Row order is NEVER changed. Formulas in other tabs that reference
 *   Notion_raw by row position remain valid.
 *
 * Column order (must match; col J = JIRA URL for Overall tab formulas):
 *   A  Requirement
 *   B  Priority
 *   C  Strategic
 *   D  Status
 *   E  PM Size
 *   F  PRD (Done? Y/N)
 *   G  Eng Size
 *   H  Team
 *   I  Comment
 *   J  JIRA                   <- INDEX/MATCH anchor in Overall tab
 *   K  Prelim. Committed Date
 *   L  PM Owner
 *   M  PMO Owner
 *   N  Start-End Date
 *   O  Kickoff Meeting Link
 *   P  Kickoff Meeting Notes
 *   Q  PRD URL
 *   R  Blocked by
 *   S  Blocking
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
// Main sync function — in-place update
// ============================================================
function syncNotionToSheets() {
  const token = PropertiesService.getScriptProperties().getProperty('notionToken');
  if (!token) throw new Error('notionToken not found in Script Properties');

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet_(ss, NOTION_RAW_TAB);

  // ── 1. Read ALL existing sheet data into memory ─────────────
  // Read every column (including any beyond S) so we never lose extra data.
  var data = sheet.getDataRange().getValues();
  if (data.length === 0 || String(data[0][0]).trim() !== 'Requirement') {
    data = [NOTION_RAW_HEADERS];
  }

  var headers    = data[0];
  var jiraColIdx = headers.indexOf('JIRA');         // col J = index 9
  var reqColIdx  = headers.indexOf('Requirement');  // col A = index 0

  // ── 2. Find or add Notion_ID column ─────────────────────────
  // Notion_ID stores the stable Notion page UUID — never changes even if
  // the Requirement name is renamed in Notion. Used as the primary match key.
  var notionIdColIdx = headers.indexOf('Notion_ID');
  if (notionIdColIdx === -1) {
    notionIdColIdx = headers.length;
    for (var r = 0; r < data.length; r++) {
      data[r].push(r === 0 ? 'Notion_ID' : '');
    }
    Logger.log('Notion_ID column added at col index ' + notionIdColIdx);
  }

  // Total column count (now includes Notion_ID if just added)
  var totalCols = data[0].length;

  // ── 3. Build index maps ─────────────────────────────────────
  var byNotionId = {};  // { page.id  → dataIndex }  ← primary (stable UUID)
  var byJiraUrl  = {};  // { jiraUrl  → dataIndex }  ← secondary
  var byReq      = {};  // { reqName  → dataIndex }  ← fallback

  // First-occurrence wins: original rows (higher up) take priority over
  // any duplicate rows appended at the bottom from failed earlier syncs.
  for (var i = 1; i < data.length; i++) {
    var notionId = String(data[i][notionIdColIdx] || '').trim();
    var jiraUrl  = String(data[i][jiraColIdx]     || '').trim();
    var req      = String(data[i][reqColIdx]      || '').trim();
    if (notionId && !byNotionId[notionId]) byNotionId[notionId] = i;
    if (jiraUrl && jiraUrl.startsWith('http') && !byJiraUrl[jiraUrl]) byJiraUrl[jiraUrl] = i;
    if (req && !byReq[req]) byReq[req] = i;
  }

  // ── 3. Fetch all Notion pages ───────────────────────────────
  Logger.log('Fetching Notion pages...');
  const pages = fetchAllNotionPages_(token, NOTION_DB_ID);
  Logger.log(`Fetched ${pages.length} total Notion pages.`);

  const pageIdToJiraKey = buildPageIdToJiraKeyMap_(pages);
  Logger.log(`pageId map: ${Object.keys(pageIdToJiraKey).length} entries.`);

  // ── 4. Match each page → update in-place or append ─────────
  let matched = 0;
  let added   = 0;
  let skipped = 0;
  var claimedRows = {};  // rowIdx → first req that claimed it (prevents double-write)

  pages.forEach(function(page) {
    const props   = page.properties;
    const req     = notionTitle_(props['Requirement']);
    const jiraUrl = notionUrl_(props['JIRA']);

    // Skip pages with no requirement name at all
    if (!req) { skipped++; return; }

    // Build the row values in NOTION_RAW_HEADERS column order
    const blockedByIds  = notionRelation_(props['Blocked by']).concat(notionRelation_(props['Blocked by 1']));
    const blockingIds   = notionRelation_(props['Blocking']).concat(notionRelation_(props['Blocking 1']));
    const blockedByKeys = blockedByIds.map(function(id) { return pageIdToJiraKey[id] || id; }).join(', ');
    const blockingKeys  = blockingIds.map(function(id)  { return pageIdToJiraKey[id] || id; }).join(', ');
    const dateRange     = notionDateRange_(props['Start-End Date']);
    const startEndStr   = formatDateRange_(dateRange.start, dateRange.end);

    const rowValues = [
      req,                                              // A  Requirement
      notionSelect_(props['Priority']),                 // B
      notionCheckboxOrSelect_(props['Strategic']),       // C
      notionSelect_(props['Status']),                   // D
      notionSelect_(props['PM Size']),                  // E
      notionTextOrSelect_(props['PRD (Done? Y/N)']),    // F
      notionSelect_(props['Eng Size']),                 // G
      notionSelectOrMulti_(props['Team']),              // H
      notionText_(props['Comment']),                    // I
      jiraUrl,                                          // J  JIRA URL
      notionDate_(props['Prelim. Committed Date']),     // K
      notionPerson_(props['PM Owner']),                 // L
      notionPerson_(props['PMO Owner']),                // M
      startEndStr,                                      // N
      notionText_(props['Kickoff Meeting Link']),        // O
      notionText_(props['Kickoff Meeting Notes']),      // P
      notionUrl_(props['PRD URL']),                     // Q
      blockedByKeys,                                    // R
      blockingKeys,                                     // S
    ];

    // Match priority: JIRA URL → Notion_ID → Requirement name
    var idx = null;
    if (jiraUrl && jiraUrl.startsWith('http') && byJiraUrl[jiraUrl] !== undefined) {
      idx = byJiraUrl[jiraUrl];
    } else if (byNotionId[page.id] !== undefined) {
      idx = byNotionId[page.id];
    } else if (byReq[req] !== undefined) {
      idx = byReq[req];
    }

    if (idx !== null) {
      // Guard: if this row was already updated by a different Notion page, skip to avoid overwrite.
      if (claimedRows[idx] !== undefined) {
        Logger.log('WARNING: Row ' + (idx+1) + ' already claimed by "' + claimedRows[idx] + '". Skipping duplicate Notion page: "' + req + '" (' + jiraUrl + ')');
        skipped++;
        return;
      }
      claimedRows[idx] = req;
      // Update in-place: overwrite A–S cols + write Notion_ID.
      for (var c = 0; c < rowValues.length; c++) {
        data[idx][c] = rowValues[c];
      }
      data[idx][notionIdColIdx] = page.id;  // stamp the stable page ID
      matched++;
    } else {
      // New row: A–S values + Notion_ID + empty strings for any extra columns
      var newRow = rowValues.slice();
      while (newRow.length < notionIdColIdx) newRow.push('');
      newRow.push(page.id);  // Notion_ID
      while (newRow.length < totalCols) newRow.push('');
      data.push(newRow);
      var newIdx = data.length - 1;
      claimedRows[newIdx] = req;
      byNotionId[page.id] = newIdx;
      if (jiraUrl && jiraUrl.startsWith('http')) byJiraUrl[jiraUrl] = newIdx;
      byReq[req] = newIdx;
      added++;
    }
  });

  Logger.log('In-place updates: ' + matched + ', New rows appended: ' + added + ', Skipped (no name): ' + skipped);

  // ── 5. Write entire array back in one batch call ────────────
  // Write ALL columns (totalCols) so extra columns beyond S are preserved.
  // No clearContents — overwrite in place so data is never lost on error.
  sheet.getRange(1, 1, data.length, totalCols).setValues(data);
  sheet.setFrozenRows(1);

  Logger.log('Notion_raw sync complete. Total data rows: ' + (data.length - 1));

  // ── 6. Duplicate Requirement check ─────────────────────────
  // Warn if the same Requirement name appears more than once (can happen if
  // a Notion page was renamed — the old row stays, a new row is appended).
  var reqCount = {};
  for (var i = 1; i < data.length; i++) {
    var r = String(data[i][reqColIdx] || '').trim();
    if (r) reqCount[r] = (reqCount[r] || 0) + 1;
  }
  var duplicates = Object.keys(reqCount).filter(function(r) { return reqCount[r] > 1; });
  if (duplicates.length > 0) {
    Logger.log('WARNING: Duplicate Requirement names found: ' + duplicates.join(', '));
  }

  return {
    matched:        matched,
    added:          added,
    skipped:        skipped,
    totalFetched:   pages.length,
    duplicates:     duplicates,
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
      'Updated : ' + result.matched + ' rows\n' +
      'New rows : ' + result.added  + '\n' +
      'Skipped (no name) : ' + result.skipped + '\n' +
      'Total from Notion : ' + result.totalFetched;
    if (result.duplicates && result.duplicates.length > 0) {
      msg += '\n\n⚠️ Duplicate Requirement names found:\n' + result.duplicates.join('\n') +
             '\n\nThese may be caused by renamed Notion pages. Please check Notion_raw and remove the stale row manually.';
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
function diagnoseDoubleMatch() {
  var token = PropertiesService.getScriptProperties().getProperty('notionToken');
  if (!token) throw new Error('notionToken not found in Script Properties');

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(NOTION_RAW_TAB);
  var data  = sheet.getDataRange().getValues();
  var headers      = data[0];
  var jiraColIdx   = headers.indexOf('JIRA');
  var reqColIdx    = headers.indexOf('Requirement');
  var notionIdColIdx = headers.indexOf('Notion_ID');

  // Build same index maps as syncNotionToSheets
  var byNotionId = {}, byJiraUrl = {}, byReq = {};
  for (var i = 1; i < data.length; i++) {
    var nid  = String(data[i][notionIdColIdx] || '').trim();
    var jurl = String(data[i][jiraColIdx]     || '').trim();
    var req  = String(data[i][reqColIdx]      || '').trim();
    if (nid  && !byNotionId[nid])                              byNotionId[nid]  = i;
    if (jurl && jurl.startsWith('http') && !byJiraUrl[jurl])  byJiraUrl[jurl]  = i;
    if (req  && !byReq[req])                                   byReq[req]       = i;
  }

  var pages = fetchAllNotionPages_(token, NOTION_DB_ID);
  Logger.log('Total Notion pages: ' + pages.length);

  var rowHitCount = {};  // rowIdx → [requirement1, requirement2, ...]
  var unmatchedPages = [];

  pages.forEach(function(page) {
    var props   = page.properties;
    var req     = notionTitle_(props['Requirement']);
    var jiraUrl = notionUrl_(props['JIRA']);
    if (!req) return;

    var idx = null;
    var matchedBy = '';
    if (jiraUrl && jiraUrl.startsWith('http') && byJiraUrl[jiraUrl] !== undefined) {
      idx = byJiraUrl[jiraUrl]; matchedBy = 'JIRA';
    } else if (byNotionId[page.id] !== undefined) {
      idx = byNotionId[page.id]; matchedBy = 'NotionID';
    } else if (byReq[req] !== undefined) {
      idx = byReq[req]; matchedBy = 'Req';
    }

    if (idx === null) {
      unmatchedPages.push(req + ' | ' + jiraUrl);
    } else {
      if (!rowHitCount[idx]) rowHitCount[idx] = [];
      rowHitCount[idx].push(req + ' [' + matchedBy + ']');
    }
  });

  // Report double-matched rows
  Logger.log('\n=== DOUBLE-MATCHED ROWS (same sheet row hit by 2+ Notion pages) ===');
  var found = false;
  Object.keys(rowHitCount).forEach(function(idx) {
    if (rowHitCount[idx].length > 1) {
      found = true;
      Logger.log('Row ' + (parseInt(idx)+1) + ' → ' + rowHitCount[idx].join(' | OVERWRITTEN BY → '));
    }
  });
  if (!found) Logger.log('None found.');

  // Report unmatched pages
  Logger.log('\n=== UNMATCHED (would be appended as new row) ===');
  if (unmatchedPages.length === 0) Logger.log('None.');
  unmatchedPages.forEach(function(p) { Logger.log('  ' + p); });
}

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
