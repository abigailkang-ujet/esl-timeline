/**
 * ESL Timeline — Apps Script Web App
 * ============================================================
 * Data sources (hybrid architecture, 2026-05-21):
 *   1. Jira REST API (5-min cache)  → status, dates, T-shirt, dependencies
 *   2. Notion API direct (10-min cache) → priority, PRD, PM/PMO, strategic, etc.
 *   3. Google Sheets scenario tabs   → manual planning data (dates, effort, risk, allocation)
 *   4. Google Sheets Notion_raw tab  → fallback when Notion API is unavailable
 *
 * Flow:
 *   doGet() → reads Sheets scenario tabs + fetches Notion API direct + Jira live
 *           → joins on JIRA URL, serves HTML
 *   syncNotionToSheets.gs still runs daily as backup (populates Notion_raw for
 *   XLOOKUP formulas in Overall/Realistic tabs and as tertiary data fallback).
 *
 * Deployment:
 *   Apps Script → Deploy → Web App → Execute as: Me, Access: Anyone
 * ============================================================
 */

const REALISTIC_TAB  = 'Realistic Scenario - Tasks Details (S2)';
const OPTIMISTIC_TAB = 'Optimistic Scenario - Tasks Details (S1)';
const PESSIMIST_TAB  = 'Pessimistic Scenario - Tasks Details (S3)';

// ── Jira live sync (status / start / end) — see spec 2026-05-06 ──
const JIRA_DOMAIN      = 'ujetcs.atlassian.net';
const JIRA_EMAIL       = 'abigail.kang@ujet.cx';
const JIRA_FIELD_START     = 'customfield_11014';   // Jira Start Date custom field
const JIRA_FIELD_END       = 'duedate';
const JIRA_FIELD_COMMITTED = 'customfield_11900';   // Jira Committed Date custom field (write target for pushIdealToJira)
const JIRA_FIELD_TSHIRT    = 'customfield_11190';   // Jira T-shirt size estimation (compared against Notion Eng Size)
const JIRA_CACHE_KEY       = 'esl-jira-live-v5';    // bump on parser/shape change (v5: added summary)
const JIRA_CACHE_TTL       = 300;                    // 5 minutes
const JIRA_LATE_COMMENTS_CACHE_KEY = 'esl-late-comments-v1';
const JIRA_LATE_COMMENTS_CACHE_TTL = 300;            // 5 minutes

// ── Notion direct API fetch (bypasses Sheets, 10-min cache) ──
const NOTION_CACHE_KEY = 'esl-notion-direct-v1';
const NOTION_CACHE_TTL = 600;                        // 10 minutes

// Jira 프로젝트 키 prefix → 정규화된 팀명 매핑
// 여기 없는 prefix는 Notion/Sheets 팀값으로 fallback
const EPIC_TEAM_MAP = {
  'CALL': 'CALL',
  'WEB':  'SDK',
  'SDK':  'SDK',
  'AGX':  'AGX',
  'CHAT': 'CHAT',
  'API':  'API',
  'DATA': 'DATA',
  'DPT':  'DATA',
  'ESC':  'Email',
};

// ============================================================
// Web App Entry Point
// ============================================================
function doGet(e) {
  // Debug: add ?debug=1 to URL to verify server-side data without HTML
  if (e && e.parameter && e.parameter.debug === '1') {
    try {
      const data = buildTimelineData();
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, tasks: data.tasks.length, notionSource: data.notionSource }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService
        .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  try {
    const data = buildTimelineData();
    const tpl = HtmlService.createTemplateFromFile('index');
    // Escape all characters that can break JS when JSON is injected into a <script> block:
    // - </script> → prevent early tag close
    // - U+2028 / U+2029 → Line/Paragraph separator, valid JSON but illegal in JS string literals
    // - < > → prevent <!-- and --> from being interpreted as HTML comments
    tpl.timelineData = JSON.stringify(data)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    return tpl.evaluate()
      .setTitle('ESL - Project Timeline')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return HtmlService.createHtmlOutput(
      `<pre style="color:red;padding:20px">Error: ${err.message}\n\n${err.stack}</pre>`
    );
  }
}

// ============================================================
// Late-reason → Jira comment (called from index.html via
// google.script.run.postJiraCommentFromUI). google.script.run is the
// only reliable way to hit Apps Script server-side from a webapp's
// HtmlService page — fetch() targets the sandbox iframe origin and
// gets the HTML page back instead of the script.
// ============================================================
function postJiraCommentFromUI(jiraKey, text) {
  var key  = String(jiraKey || '').trim();
  var body = String(text    || '').trim();
  if (!key)  return { ok: false, error: 'jiraKey required' };
  if (!body) return { ok: false, error: 'text required' };

  var token = PropertiesService.getScriptProperties().getProperty('jiraToken');
  if (!token) return { ok: false, error: 'jiraToken not set in Script Properties' };
  var creds = Utilities.base64Encode(JIRA_EMAIL + ':' + token);

  // Jira REST v3 comment body must be in Atlassian Document Format (ADF).
  var payload = {
    body: {
      type: 'doc', version: 1,
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: body }]
      }]
    }
  };

  try {
    var resp = UrlFetchApp.fetch(
      'https://' + JIRA_DOMAIN + '/rest/api/3/issue/' + encodeURIComponent(key) + '/comment',
      {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(payload),
        headers: { Authorization: 'Basic ' + creds, Accept: 'application/json' },
        muteHttpExceptions: true,
      }
    );
    var code = resp.getResponseCode();
    if (code === 201) {
      var json = JSON.parse(resp.getContentText());
      Logger.log('[jira-comment] posted to ' + key + ' (id=' + json.id + ')');
      // Invalidate the late-comments cache so the next render fetches fresh.
      try { CacheService.getScriptCache().remove(JIRA_LATE_COMMENTS_CACHE_KEY); } catch (e) {}
      return {
        ok: true, id: json.id, key: key,
        // Echo the comment back so the frontend can optimistically append
        // it to its in-memory task data without waiting for a page reload.
        comment: {
          author: 'You',         // best-effort — Jira's display name isn't returned on POST
          body: body,
          created: new Date().toISOString(),
        }
      };
    }
    var snip = resp.getContentText().slice(0, 300);
    Logger.log('[jira-comment] HTTP ' + code + ' for ' + key + ': ' + snip);
    return { ok: false, error: 'Jira HTTP ' + code + ': ' + snip };
  } catch (err) {
    Logger.log('[jira-comment] threw: ' + err.message);
    return { ok: false, error: 'Threw: ' + err.message };
  }
}

// ============================================================
// Fetch late-reason comments for a set of Jira keys (parallel).
// Returns { KEY: [{ author, body, created }, ...] }, filtered to
// our "[Name] reason" format so noise from unrelated comments is
// kept out. Cached 5 minutes via CacheService.
// ============================================================
function fetchLateCommentsFromJira_(jiraKeys) {
  if (!jiraKeys || !jiraKeys.length) return {};

  var cache = CacheService.getScriptCache();
  var cached = cache.get(JIRA_LATE_COMMENTS_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through to fresh fetch */ }
  }

  var token = PropertiesService.getScriptProperties().getProperty('jiraToken');
  if (!token) {
    Logger.log('[late-comments] no jiraToken — skipping fetch');
    return {};
  }
  var creds = Utilities.base64Encode(JIRA_EMAIL + ':' + token);

  var requests = jiraKeys.map(function(key) {
    return {
      url: 'https://' + JIRA_DOMAIN + '/rest/api/3/issue/' + encodeURIComponent(key) + '/comment?orderBy=created',
      method: 'get',
      headers: { Authorization: 'Basic ' + creds, Accept: 'application/json' },
      muteHttpExceptions: true,
    };
  });

  var byKey = {};
  try {
    var responses = UrlFetchApp.fetchAll(requests);
    responses.forEach(function(resp, idx) {
      var key = jiraKeys[idx];
      var code = resp.getResponseCode();
      if (code !== 200) {
        byKey[key] = [];
        return;
      }
      var json;
      try { json = JSON.parse(resp.getContentText()); }
      catch (e) { byKey[key] = []; return; }
      var comments = (json.comments || []).map(function(c) {
        return {
          author:  (c.author && c.author.displayName) || 'Unknown',
          body:    extractAdfText_(c.body),
          created: c.created || '',
        };
      }).filter(function(c) {
        // Surface comments that match our late-reason convention. Three
        // historical formats are recognized so legacy entries stay visible:
        //   - current : "Note (late reason, etc) — [Author] …"
        //   - prior   : "Late reason — [Author] …"
        //   - oldest  : "[Author] …"
        if (!c.body) return false;
        var b = c.body.trim();
        return b.indexOf('Note (late reason') === 0
            || b.indexOf('Late reason') === 0
            || b.charAt(0) === '[';
      });
      byKey[key] = comments;
    });
  } catch (e) {
    Logger.log('[late-comments] fetchAll threw: ' + e.message);
    return {};
  }

  try { cache.put(JIRA_LATE_COMMENTS_CACHE_KEY, JSON.stringify(byKey), JIRA_LATE_COMMENTS_CACHE_TTL); }
  catch (e) { /* cache failure is non-fatal */ }
  Logger.log('[late-comments] fetched for ' + jiraKeys.length + ' keys');
  return byKey;
}

// Flatten a simple Atlassian Document Format body into plain text.
// Walks the tree, collecting any node.text leaves and joining with
// spaces. Handles the common doc → paragraph → text shape that
// JIRA returns for typed-in comments.
function extractAdfText_(adf) {
  if (!adf) return '';
  var parts = [];
  function walk(node) {
    if (!node) return;
    if (typeof node.text === 'string') parts.push(node.text);
    if (node.content && Array.isArray(node.content)) node.content.forEach(walk);
  }
  walk(adf);
  return parts.join(' ').trim();
}

// ============================================================
// Compare T-shirt sizes: Notion_raw "Eng Size" vs Jira customfield
// ============================================================
// One-shot diagnostic run from the "Jira Push → Compare Sizes" menu.
// Pulls Eng Size from Notion_raw, fetches JIRA_FIELD_TSHIRT for every
// task in parallel, writes a per-row diff to a "Size_diff" tab.
// Status legend:
//   MATCH                — values agree (or both empty)
//   MISMATCH             — both have a value but they differ
//   ONLY_IN_NOTION       — Notion has a value, Jira is empty
//   ONLY_IN_JIRA         — Jira has a value, Notion is empty
//   NO_JIRA_KEY          — sheet row has no Jira URL, skipped
//   JIRA_FETCH_FAILED    — Jira returned non-200 or threw
// ============================================================
function compareSizesNotionVsJira() {
  var ui = SpreadsheetApp.getUi();
  var token = PropertiesService.getScriptProperties().getProperty('jiraToken');
  if (!token) { ui.alert('jiraToken not set in Script Properties'); return; }
  var creds = Utilities.base64Encode(JIRA_EMAIL + ':' + token);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Fetching Jira T-shirt sizes…', 'Size Diff', 30);

  // Read Notion_raw: Requirement (A), Eng Size (G), JIRA (J)
  var raw = ss.getSheetByName(NOTION_RAW_TAB);
  if (!raw) { ui.alert('Notion_raw tab not found'); return; }
  var lastRow = raw.getLastRow();
  if (lastRow < 2) { ui.alert('Notion_raw is empty'); return; }
  var data = raw.getRange(2, 1, lastRow - 1, 10).getValues();  // cols A..J

  // Build per-row list of { req, notionSize, jiraKey, jiraUrl }
  var rows = data.map(function(r) {
    var url = String(r[9] || '').trim();   // col J
    return {
      req:        String(r[0] || '').trim(),       // col A
      notionSize: String(r[6] || '').trim(),       // col G
      jiraUrl:    url,
      jiraKey:    extractJiraKey(url),
    };
  });

  // Parallel fetch JIRA_FIELD_TSHIRT for every row with a jira key
  var keysToFetch = rows.filter(function(r) { return r.jiraKey; })
                        .map(function(r) { return r.jiraKey; });
  var requests = keysToFetch.map(function(k) {
    return {
      url: 'https://' + JIRA_DOMAIN + '/rest/api/3/issue/' + encodeURIComponent(k)
           + '?fields=' + JIRA_FIELD_TSHIRT,
      method: 'get',
      headers: { Authorization: 'Basic ' + creds, Accept: 'application/json' },
      muteHttpExceptions: true,
    };
  });

  var jiraSizeByKey = {};
  var fetchFailed = {};
  try {
    var responses = UrlFetchApp.fetchAll(requests);
    responses.forEach(function(resp, idx) {
      var key = keysToFetch[idx];
      if (resp.getResponseCode() !== 200) { fetchFailed[key] = true; return; }
      try {
        var j = JSON.parse(resp.getContentText());
        jiraSizeByKey[key] = _extractTshirtValue_(j.fields && j.fields[JIRA_FIELD_TSHIRT]);
      } catch (e) { fetchFailed[key] = true; }
    });
  } catch (e) {
    ui.alert('fetchAll threw: ' + e.message);
    return;
  }

  // Build diff
  var diffRows = rows.map(function(r) {
    var jSize = '';
    var status;
    if (!r.jiraKey) {
      status = 'NO_JIRA_KEY';
    } else if (fetchFailed[r.jiraKey]) {
      status = 'JIRA_FETCH_FAILED';
    } else {
      jSize = jiraSizeByKey[r.jiraKey] || '';
      var n = r.notionSize, j = jSize;
      if (n === j)              status = 'MATCH';
      else if (n && !j)         status = 'ONLY_IN_NOTION';
      else if (!n && j)         status = 'ONLY_IN_JIRA';
      else                      status = 'MISMATCH';
    }
    return [r.jiraKey || '', r.req, r.notionSize, jSize, status];
  });

  // Sort: MISMATCH first, then ONLY_IN_*, then failures, then matches
  var statusOrder = { MISMATCH:0, ONLY_IN_NOTION:1, ONLY_IN_JIRA:1, JIRA_FETCH_FAILED:2, NO_JIRA_KEY:3, MATCH:4 };
  diffRows.sort(function(a, b) { return (statusOrder[a[4]] || 99) - (statusOrder[b[4]] || 99); });

  // Write to Size_diff tab
  var diff = getOrCreateSheet_(ss, 'Size_diff');
  diff.clearContents();
  diff.clearFormats();
  var header = [['JIRA Key', 'Requirement', 'Notion Eng Size', 'Jira T-shirt', 'Status', 'Run At']];
  var now = new Date().toLocaleString();
  var allRows = header.concat(diffRows.map(function(r) { return r.concat([now]); }));
  diff.getRange(1, 1, allRows.length, 6).setValues(allRows);

  // Header style
  diff.getRange(1, 1, 1, 6)
      .setFontWeight('bold').setBackground('#1e293b').setFontColor('#ffffff');

  // Row backgrounds by status
  if (diffRows.length > 0) {
    var bgs = diffRows.map(function(r) {
      var c;
      switch (r[4]) {
        case 'MISMATCH':          c = '#fde2e2'; break;  // light red
        case 'ONLY_IN_NOTION':    c = '#fef3c7'; break;  // light amber
        case 'ONLY_IN_JIRA':      c = '#fef3c7'; break;
        case 'JIRA_FETCH_FAILED': c = '#fce7f3'; break;  // light pink
        case 'NO_JIRA_KEY':       c = '#f3f4f6'; break;  // light grey
        case 'MATCH':             c = '#dcfce7'; break;  // light green
        default:                  c = '#ffffff';
      }
      return [c, c, c, c, c, c];
    });
    diff.getRange(2, 1, bgs.length, 6).setBackgrounds(bgs);
  }
  diff.autoResizeColumns(1, 6);
  diff.setFrozenRows(1);
  ss.setActiveSheet(diff);

  // Summary alert
  var counts = { MATCH:0, MISMATCH:0, ONLY_IN_NOTION:0, ONLY_IN_JIRA:0, NO_JIRA_KEY:0, JIRA_FETCH_FAILED:0 };
  diffRows.forEach(function(r) { counts[r[4]] = (counts[r[4]] || 0) + 1; });
  ui.alert('Size Comparison',
    'Notion vs Jira T-shirt sizes — see "Size_diff" tab.\n\n' +
    'MISMATCH          : ' + counts.MISMATCH + '\n' +
    'ONLY in Notion    : ' + counts.ONLY_IN_NOTION + '\n' +
    'ONLY in Jira      : ' + counts.ONLY_IN_JIRA + '\n' +
    'Jira fetch failed : ' + counts.JIRA_FETCH_FAILED + '\n' +
    'No Jira key       : ' + counts.NO_JIRA_KEY + '\n' +
    'MATCH (agree)     : ' + counts.MATCH,
    ui.ButtonSet.OK);
}

// Jira custom-field values come in several shapes depending on field type:
//   - select-list:  { value: 'M', id: '...', ... }
//   - free text:    'M'
//   - cascading:    { value: '...', child: {...} }
// Return the printable label (or '' if empty).
function _extractTshirtValue_(field) {
  if (field == null) return '';
  if (typeof field === 'string') return field.trim();
  if (typeof field === 'object') {
    if (field.value)       return String(field.value).trim();
    if (field.name)        return String(field.name).trim();
    if (field.displayName) return String(field.displayName).trim();
  }
  return '';
}

// ============================================================
// Core: join Scenario Sheets + Notion (direct API or Sheets fallback) + Jira live
// ============================================================
function buildTimelineData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const rsRows            = readSheet(ss, REALISTIC_TAB);
  const optimisticByUrl   = buildScenarioIndex(ss, OPTIMISTIC_TAB);
  const pessimistByUrl    = buildScenarioIndex(ss, PESSIMIST_TAB);

  // Notion: try direct API first (10-min cache), fall back to Sheets Notion_raw tab
  var notionDirect = fetchNotionDirect();
  var notionData   = notionDirect || buildNotionIndex(ss);
  var byUrl        = notionData.byUrl;
  var byName       = notionData.byName;
  var notionSource = notionDirect ? 'api' : 'sheets';

  const tasks = [];
  rsRows.forEach(row => {
    const task = str(row['Task (Do not edit)']);
    if (!task || task.startsWith('#')) return; // skip empty rows and formula errors (#N/A, #REF!, etc.)

    const epicUrl    = str(row['Epic (Do not edit)']);
    const hasUrl     = epicUrl.startsWith('http');
    const epicKey    = hasUrl ? epicUrl.split('/').pop() : '';
    const epicPrefix = epicKey ? epicKey.split('-')[0] : '';
    const epicTeam   = EPIC_TEAM_MAP[epicPrefix] || '';   // 알려진 prefix만 신뢰
    // Join: JIRA URL 우선, 없으면 task 이름(Requirement)으로 fallback
    const n          = (hasUrl && byUrl[epicUrl]) || byName[task] || {};

    // Per-scenario start/end/effort. Realistic is the canonical source for
    // the initial render (t.start / t.end fields below). Optimistic and
    // Pessimist come from sibling Sheets tabs with identical column layout
    // — the frontend toggles among the three.
    //
    // Fallback rules (so O/P bars show even if those tabs aren't fully
    // populated):
    //   - start: scenario's own start → else Realistic's start
    //   - end:   scenario's own end   → else compute from (start + effort*7)
    //   - effort: must come from the scenario tab (this is what makes the
    //            scenario different in the first place)
    const realistic = {
      start:  fmtDate(row['Start Date']),
      end:    fmtDate(row['End Date (Do not edit)']),
      effort: num(row['Scenario Estimated Effort (dev weeks)']),
    };
    const optimistic = resolveScenario_(optimisticByUrl[epicUrl], realistic);
    const pessimist  = resolveScenario_(pessimistByUrl[epicUrl],  realistic);

    tasks.push({
      // ── From Realistic Scenario tab (team leads enter these) ──
      epic:           epicKey,
      epicUrl:        epicUrl,
      task:           str(row['Task (Do not edit)']),
      lead:           str(row['Lead']),
      allocation:     str(row['Allocation']),
      headcount:      str(row['Headcount']),
      risk:           str(row['Risk Factor']),
      start:          realistic.start,
      end:            realistic.end,
      effort:         num(row['Planned Effort  (#weeks)']),
      scenarioEffort: realistic.effort,
      // Per-scenario { start, end, effort } — frontend toggles among these
      optimistic:     optimistic,
      realistic:      realistic,
      pessimist:      pessimist,
      ideal:          fmtDate(row['Ideal Delivery (due to SOW)']),
      note:           str(row['Note']),
      release:        str(row['Release']),
      ccaipRelease:   str(row['CCAIP Release [PMO Plan]']),

      // ── From Notion_raw tab (synced by syncNotionToSheets.gs) ──
      requirement:  n.requirement  || '',
      priority:     n.priority     || str(row['Priority']),
      team:         epicTeam       || n.team || str(row['Team']),
      status:       n.status       || '',
      strategic:    n.strategic    || '',
      pm:           n.pm           || '',
      pmo:          n.pmo          || '',
      prd:          n.prd          || '',
      prdUrl:       n.prdUrl       || '',
      engSize:      n.engSize      || '',
      pmSize:       n.pmSize       || '',
      comment:      n.comment      || '',
      prelimDate:   n.prelimDate   || '',
      actualStart:     n.actualStart  || '',
      actualEnd:       n.actualEnd    || '',
      statusChangedAt: '',  // populated by fetchJiraLive override below
      resolvedAt:      '',
      kickoffLink:  n.kickoffLink  || '',
      kickoffNotes: n.kickoffNotes || '',
      blockedBy:    n.blockedBy    || [],
      blocking:     n.blocking     || [],
      relates:      [],   // Jira-only (Notion has no Relates relation); populated by fetchJiraLive
    });
  });

  // ── Override status / actualStart / actualEnd + status-fallback timestamps with live Jira data ──
  // The Notion → Sheets daily sync can be up to ~24h stale. Hit Jira directly
  // (5-min cache) for the fields that drive the Schedule chip + the dual-bar
  // Gantt rendering. statusChangedAt / resolvedAt are status-derived fallbacks
  // for when actualStart / actualEnd are missing. Any failure path falls
  // through to the Notion-synced values already set above (statusChangedAt /
  // resolvedAt simply stay empty in that case — the bar logic handles that).
  const jiraKeys = tasks
    .map(function(t) { return extractJiraKey(t.epicUrl); })
    .filter(function(k) { return k; });
  const live = fetchJiraLive(jiraKeys);

  tasks.forEach(function(t) {
    const key = extractJiraKey(t.epicUrl);
    if (!key) return;                    // pre-Jira placeholder — keep Notion data
    const liveEntry = live[key];
    if (!liveEntry) return;              // Jira didn't return this key — keep Notion data
    if (liveEntry.status) t.status = liveEntry.status;
    if (liveEntry.summary) t.requirement = liveEntry.summary;
    t.actualStart     = liveEntry.start || '';
    t.actualEnd       = liveEntry.end   || '';
    t.statusChangedAt = liveEntry.statusChangedAt || '';
    t.resolvedAt      = liveEntry.resolvedAt      || '';
    // T-shirt size: Jira is the authoritative source going forward. Fall
    // back to whatever Notion synced if Jira's field is empty (so we don't
    // drop data when the customfield happens to be blank on an issue).
    if (liveEntry.tshirt) t.engSize = liveEntry.tshirt;
    // Override Notion-synced blocking / blockedBy with Jira-derived. Relates is
    // Jira-only (Notion has no equivalent), so it just copies the parsed list.
    if (liveEntry.blocking)  t.blocking  = liveEntry.blocking;
    if (liveEntry.blockedBy) t.blockedBy = liveEntry.blockedBy;
    t.relates = liveEntry.relates || [];
  });

  // ── Late-reason comments — only for tasks whose actual end is past plan end (overrun) ──
  // ISO yyyy-MM-dd strings compare lexically, so > works as date order here.
  var lateKeys = [];
  tasks.forEach(function(t) {
    if (t.actualEnd && t.end && t.actualEnd > t.end) {
      var k = extractJiraKey(t.epicUrl);
      if (k) lateKeys.push(k);
    }
  });
  var lateComments = fetchLateCommentsFromJira_(lateKeys);
  tasks.forEach(function(t) {
    var k = extractJiraKey(t.epicUrl);
    t.lateComments = (k && lateComments[k]) ? lateComments[k] : [];
  });

  return { tasks, updatedAt: new Date().toISOString(), totalRows: tasks.length, notionSource: notionSource };
}

// ============================================================
// Jira live sync helpers
// ============================================================

function extractJiraKey(epicUrl) {
  if (!epicUrl) return '';
  var m = String(epicUrl).match(/\/browse\/([A-Z]+-\d+)/);
  return m ? m[1] : '';
}

/**
 * Bulk-fetch live status + start + end for a list of Jira keys.
 * Returns { KEY: { status, start, end } }. Returns {} on any failure
 * (no token, non-200, network throw, parse error) so callers fall back
 * to Notion-synced values gracefully.
 *
 * Cached in CacheService for 5 minutes (JIRA_CACHE_TTL).
 */
function fetchJiraLive(jiraKeys) {
  if (!jiraKeys || !jiraKeys.length) return {};

  var cache = CacheService.getScriptCache();
  var cached = cache.get(JIRA_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through to fresh fetch */ }
  }

  var token = PropertiesService.getScriptProperties().getProperty('jiraToken');
  if (!token) {
    Logger.log('[jira-live] no jiraToken in Script Properties — falling back to Notion data');
    return {};
  }

  var jql = 'key in (' + jiraKeys.join(',') + ')';
  // Atlassian sunset GET /rest/api/3/search on 2025-05-01. Use the new
  // POST /rest/api/3/search/jql with a JSON body. fields is now an array.
  // For ≤200 tasks this fits in a single page; pagination via nextPageToken
  // is unused for now (we'd need it past ~5000 issues).
  var url = 'https://' + JIRA_DOMAIN + '/rest/api/3/search/jql';
  var bodyJson = JSON.stringify({
    jql: jql,
    fields: ['status', 'summary', JIRA_FIELD_START, JIRA_FIELD_END, JIRA_FIELD_TSHIRT,
             'statuscategorychangedate', 'resolutiondate', 'issuelinks'],
    maxResults: 200
  });
  var creds = Utilities.base64Encode(JIRA_EMAIL + ':' + token);

  var byKey = {};
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: bodyJson,
      headers: { Authorization: 'Basic ' + creds, Accept: 'application/json' },
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    if (code !== 200) {
      Logger.log('[jira-live] HTTP ' + code + ' — falling back to Notion data');
      return {};
    }
    var json = JSON.parse(resp.getContentText());
    (json.issues || []).forEach(function(i) {
      var f = i.fields || {};
      var entry = {
        status:          (f.status && f.status.name) || '',
        summary:         f.summary || '',
        start:           f[JIRA_FIELD_START] || '',
        end:             f[JIRA_FIELD_END]   || '',
        tshirt:          _extractTshirtValue_(f[JIRA_FIELD_TSHIRT]),
        statusChangedAt: f.statuscategorychangedate || '',
        resolvedAt:      f.resolutiondate           || '',
        blocking:  [],   // Jira keys this task blocks (Blocks type, outward)
        blockedBy: [],   // Jira keys that block this task (Blocks type, inward)
        relates:   [],   // Jira keys with Relates link (bidirectional)
      };
      // Parse issuelinks. Other types (Cloners / Duplicate / Causes / etc.) are
      // ignored. Match permissively because instances differ — e.g. some Jira
      // setups use "Relates" while others use "Relates To" or "Related". We
      // sniff both `type.name` and `type.inward` / `type.outward` strings.
      (f.issuelinks || []).forEach(function(link) {
        var t = link.type || {};
        var nameL    = String(t.name    || '').toLowerCase();
        var inwardL  = String(t.inward  || '').toLowerCase();
        var outwardL = String(t.outward || '').toLowerCase();
        var isBlocks  = nameL === 'blocks' || /\bblock/.test(inwardL + ' ' + outwardL);
        var isRelates = /^relat/.test(nameL) || (/relat/.test(inwardL) && /relat/.test(outwardL));
        if (isBlocks) {
          if (link.outwardIssue && link.outwardIssue.key) entry.blocking.push(link.outwardIssue.key);
          if (link.inwardIssue  && link.inwardIssue.key)  entry.blockedBy.push(link.inwardIssue.key);
          Logger.log('[jira-live] ' + i.key + ' Blocks link → name="' + t.name + '" inward="' + t.inward + '" outward="' + t.outward + '"');
        } else if (isRelates) {
          var other = (link.outwardIssue || link.inwardIssue || {}).key;
          if (other) entry.relates.push(other);
          Logger.log('[jira-live] ' + i.key + ' Relates → ' + other + ' (name="' + t.name + '")');
        } else if (t.name) {
          Logger.log('[jira-live] ' + i.key + ' ignored issuelink type: ' + t.name + ' (inward="' + t.inward + '", outward="' + t.outward + '")');
        }
      });
      byKey[i.key] = entry;
    });
  } catch (e) {
    Logger.log('[jira-live] fetch threw: ' + e.message + ' — falling back to Notion data');
    return {};
  }

  try { cache.put(JIRA_CACHE_KEY, JSON.stringify(byKey), JIRA_CACHE_TTL); } catch (e) { /* cache failure is non-fatal */ }
  return byKey;
}

// ============================================================
// Notion direct API fetch (bypasses Sheets Notion_raw tab)
// ============================================================
// Returns { byUrl, byName } with the same entry shape as buildNotionIndex(),
// or null on any failure (no token, API error, network throw).
// On null, buildTimelineData() falls back to buildNotionIndex() (Sheets).
//
// Reuses functions from syncNotionToSheets.gs (same Apps Script project):
//   fetchAllNotionPages_, buildPageIdToJiraKeyMap_, notionTitle_, notionSelect_,
//   notionTextOrSelect_, notionUrl_, notionPerson_, notionCheckboxOrSelect_,
//   notionDate_, notionDateRange_, notionRelation_, notionText_, notionSelectOrMulti_

function fetchNotionDirect() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(NOTION_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through */ }
  }

  var token = PropertiesService.getScriptProperties().getProperty('notionToken');
  if (!token) {
    Logger.log('[notion-direct] no notionToken — falling back to Sheets');
    return null;
  }

  try {
    var pages = fetchAllNotionPages_(token, NOTION_DB_ID);
    var pageIdMap = buildPageIdToJiraKeyMap_(pages);
    var byUrl  = {};
    var byName = {};

    pages.forEach(function(page) {
      var props   = page.properties || {};
      var jiraUrl = notionUrl_(props['JIRA']);
      var dateRange = notionDateRange_(props['Start-End Date']);

      // Resolve relation page IDs to Jira keys
      var blockedByIds = notionRelation_(props['Blocked by']);
      var blockingIds  = notionRelation_(props['Blocking']);
      var blockedByKeys = blockedByIds.map(function(id) { return pageIdMap[id] || ''; }).filter(Boolean);
      var blockingKeys  = blockingIds.map(function(id) { return pageIdMap[id] || ''; }).filter(Boolean);

      var entry = {
        requirement:  notionTitle_(props['Requirement']),
        priority:     notionSelect_(props['Priority']),
        strategic:    notionCheckboxOrSelect_(props['Strategic']),
        status:       notionSelect_(props['Status']),
        pmSize:       notionSelect_(props['PM Size']),
        prd:          notionTextOrSelect_(props['PRD (Done? Y/N)']),
        engSize:      notionSelect_(props['Eng Size']),
        team:         notionSelectOrMulti_(props['Team']),
        comment:      notionText_(props['Comment']),
        pm:           notionPerson_(props['PM Owner']),
        pmo:          notionPerson_(props['PMO Owner']),
        prelimDate:   notionDate_(props['Prelim. Committed Date']),
        actualStart:  dateRange.start || '',
        actualEnd:    dateRange.end   || '',
        kickoffLink:  notionText_(props['Kickoff Meeting Link']),
        kickoffNotes: notionText_(props['Kickoff Meeting Notes']),
        prdUrl:       notionUrl_(props['PRD URL']),
        blockedBy:    blockedByKeys,
        blocking:     blockingKeys,
      };

      if (jiraUrl && jiraUrl.startsWith('http')) byUrl[jiraUrl] = entry;
      if (entry.requirement) byName[entry.requirement] = entry;
    });

    var result = { byUrl: byUrl, byName: byName };
    Logger.log('[notion-direct] fetched ' + pages.length + ' pages, ' +
               Object.keys(byUrl).length + ' by URL, ' +
               Object.keys(byName).length + ' by name');

    try { cache.put(NOTION_CACHE_KEY, JSON.stringify(result), NOTION_CACHE_TTL); } catch (e) { /* non-fatal */ }
    return result;
  } catch (e) {
    Logger.log('[notion-direct] fetch threw: ' + e.message + ' — falling back to Sheets');
    return null;
  }
}

// ============================================================
// Push Sheet "Ideal Delivery" → Jira "Committed Date" (write back)
// ============================================================
// Direction: Realistic Scenario col "Ideal Delivery (due to SOW)" →
//            Jira epic customfield_11900 (Committed Date)
//
// Why: the SOW ideal date lives in the Sheet (planning source of truth).
// Jira's Committed Date field was historically not officially populated.
// Now formalized — this function writes Sheet values back to Jira.
//
// Menu entry points:
//   pushIdealToJiraDryRun() — preview only, no API writes
//   pushIdealToJira()       — actual push, behind a confirm dialog
//
// Behavior:
//   - Skips rows with no Jira URL (pre-Jira placeholder tasks)
//   - Skips rows with no Ideal Delivery value
//   - PUTs only the customfield_11900 field; other Jira fields untouched
//   - Logs each result; alert on completion with counts + sample
// ============================================================
function pushIdealToJiraDryRun() { _pushIdealToJira_(true); }

function pushIdealToJira() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert(
    'Push Ideal → Jira Committed Date',
    'This will OVERWRITE the Committed Date field on every Jira epic that has a value in the Sheet\'s "Ideal Delivery (due to SOW)" column.\n\nRun "Push Ideal → Jira (Dry Run)" first to preview.\n\nContinue with actual push?',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  _pushIdealToJira_(false);
}

function _pushIdealToJira_(dryRun) {
  var ui = SpreadsheetApp.getUi();
  var token = PropertiesService.getScriptProperties().getProperty('jiraToken');
  if (!token) { ui.alert('jiraToken not set in Script Properties'); return; }
  var creds = Utilities.base64Encode(JIRA_EMAIL + ':' + token);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(REALISTIC_TAB);
  if (!sheet) { ui.alert('Sheet not found: ' + REALISTIC_TAB); return; }

  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var epicColIdx  = headers.indexOf('Epic (Do not edit)');
  var idealColIdx = headers.indexOf('Ideal Delivery (due to SOW)');
  if (epicColIdx < 0)  { ui.alert('Column not found: "Epic (Do not edit)"'); return; }
  if (idealColIdx < 0) { ui.alert('Column not found: "Ideal Delivery (due to SOW)"'); return; }

  ss.toast(
    (dryRun ? 'Dry-run: previewing push' : 'Pushing to Jira') + '… this may take 10–30s.',
    'Push Ideal → Jira', 60
  );

  var pushed = 0, skippedNoKey = 0, skippedNoDate = 0, failed = 0;
  var preview = [];
  var errors  = [];

  for (var i = 1; i < data.length; i++) {
    var url   = String(data[i][epicColIdx] || '').trim();
    var ideal = data[i][idealColIdx];
    var key   = extractJiraKey(url);

    if (!key)               { skippedNoKey++;  continue; }
    var dateStr = fmtDate(ideal);
    if (!dateStr)           { skippedNoDate++; continue; }

    preview.push(key + ' → ' + dateStr);

    if (dryRun) { pushed++; continue; }

    try {
      var resp = UrlFetchApp.fetch(
        'https://' + JIRA_DOMAIN + '/rest/api/3/issue/' + key,
        {
          method: 'put',
          contentType: 'application/json',
          payload: JSON.stringify({ fields: { customfield_11900: dateStr } }),
          headers: { Authorization: 'Basic ' + creds, Accept: 'application/json' },
          muteHttpExceptions: true,
        }
      );
      var code = resp.getResponseCode();
      if (code === 204) {
        pushed++;
        Logger.log('✓ ' + key + ' → ' + dateStr);
      } else {
        failed++;
        var snip = resp.getContentText().slice(0, 200);
        errors.push(key + ' HTTP ' + code + ' — ' + snip);
        Logger.log('✗ ' + key + ' HTTP ' + code + ' — ' + snip);
      }
    } catch (e) {
      failed++;
      errors.push(key + ' threw: ' + e.message);
      Logger.log('✗ ' + key + ' threw: ' + e.message);
    }

    // gentle pace: pause briefly every 10 puts to stay polite with Jira API
    if (!dryRun && (pushed + failed) > 0 && (pushed + failed) % 10 === 0) Utilities.sleep(500);
  }

  // Invalidate live cache so the next render fetches fresh Jira data
  if (!dryRun) {
    try { CacheService.getScriptCache().remove(JIRA_CACHE_KEY); } catch (e) { /* non-fatal */ }
  }

  var title  = dryRun ? 'Push Ideal → Jira (Dry Run)' : 'Push Ideal → Jira';
  var prefix = dryRun ? 'Would push: ' : 'Pushed: ';
  var msg = prefix + pushed +
    '\nSkipped (no Jira key): ' + skippedNoKey +
    '\nSkipped (no Ideal date): ' + skippedNoDate +
    '\nFailed: ' + failed;

  if (preview.length) {
    msg += '\n\n' + (dryRun ? 'Preview:' : 'Details:') + '\n' + preview.slice(0, 50).join('\n');
    if (preview.length > 50) msg += '\n... (' + (preview.length - 50) + ' more)';
  }
  if (errors.length) {
    msg += '\n\nErrors:\n' + errors.slice(0, 10).join('\n');
  }

  Logger.log(msg);
  ui.alert(title, msg.slice(0, 4000), ui.ButtonSet.OK);
}

// ============================================================
// Build scenario-tab index (Optimistic / Pessimist)
// ============================================================
// Returns { [jiraUrl]: { start, end, effort } } for the given scenario tab.
// Each scenario tab has the same column layout as Realistic Scenario, but K
// (Scenario Estimated Effort) holds the scenario-specific weeks. Start Date
// may also differ across scenarios. We only carry start/end/effort because
// all the non-date fields (Lead, PM, Headcount, etc.) come from the
// Realistic tab as the canonical source.
function buildScenarioIndex(ss, tabName) {
  // Read scenario tab by COLUMN POSITION rather than header name. The three
  // scenario tabs share an identical column layout (B=Epic URL, H=Start,
  // I=End, K=Effort), but small header text drift between tabs (extra space,
  // case, missing parenthetical) would silently turn header-based lookups
  // into 0 / '' and the Gantt bar would vanish — exactly the bug we hit.
  // Position-based access is immune to those drifts.
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    Logger.log('[scenario] tab not found: "' + tabName + '" — skipping');
    return {};
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  // Read cols A..K (11 columns) in one batch. Indexes:
  //   1 = B (Epic URL), 7 = H (Start Date), 8 = I (End Date), 10 = K (Effort)
  var values = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  var byUrl = {};
  var nonZero = 0;
  values.forEach(function(row) {
    var url = String(row[1] || '').trim();
    if (!url.startsWith('http')) return;
    var effort = num(row[10]);
    if (effort > 0) nonZero++;
    byUrl[url] = {
      start:  fmtDate(row[7]),
      end:    fmtDate(row[8]),
      effort: effort,
    };
  });
  Logger.log('[scenario] "' + tabName + '": ' + Object.keys(byUrl).length + ' rows, ' + nonZero + ' with effort > 0');
  return byUrl;
}

// Compute end date string (yyyy-MM-dd) from a start date string + effort weeks.
function computeEndFromEffort_(startStr, effortWeeks) {
  if (!startStr || !effortWeeks) return '';
  // startStr is yyyy-MM-dd; construct as midnight local to avoid TZ drift.
  var d = new Date(startStr + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + Math.round(effortWeeks * 7));
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// Merge a scenario entry from its sibling tab with the Realistic fallback so
// the Gantt bar still renders even when the scenario tab's H / I columns are
// blank. Effort itself is scenario-specific — no Realistic fallback for it.
function resolveScenario_(rawEntry, realistic) {
  var raw    = rawEntry || {};
  var start  = raw.start || realistic.start;
  var effort = raw.effort != null ? raw.effort : 0;
  var end    = raw.end || computeEndFromEffort_(start, effort);
  return { start: start, end: end, effort: effort };
}

// ============================================================
// Build Notion index from Notion_raw Sheets tab
// Returns { byUrl: { [jiraUrl]: entry }, byName: { [requirement]: entry } }
// byName is used as fallback when Realistic Scenario row has no Epic URL
// ============================================================
function buildNotionIndex(ss) {
  const rows   = readSheet(ss, 'Notion_raw');
  const byUrl  = {};
  const byName = {};

  rows.forEach(row => {
    const jiraUrl  = str(row['JIRA']);
    const startEnd = str(row['Start-End Date']);
    const parts    = startEnd.split(' → ');

    const entry = {
      requirement:  str(row['Requirement']),
      priority:     str(row['Priority']),
      strategic:    str(row['Strategic']),
      status:       str(row['Status']),
      pmSize:       str(row['PM Size']),
      prd:          str(row['PRD (Done? Y/N)']),
      engSize:      str(row['Eng Size']),
      team:         str(row['Team']),
      comment:      str(row['Comment']),
      pm:           str(row['PM Owner']),
      pmo:          str(row['PMO Owner']),
      prelimDate:   str(row['Prelim. Committed Date']),
      actualStart:  parts[0] ? parts[0].trim() : '',
      actualEnd:    parts[1] ? parts[1].trim() : '',
      kickoffLink:  str(row['Kickoff Meeting Link']),
      kickoffNotes: str(row['Kickoff Meeting Notes']),
      prdUrl:       str(row['PRD URL']),
      blockedBy:    parseEpicList(str(row['Blocked by'])),
      blocking:     parseEpicList(str(row['Blocking'])),
    };

    if (jiraUrl.startsWith('http')) byUrl[jiraUrl] = entry;
    const reqName = str(row['Requirement']);
    if (reqName) byName[reqName] = entry;
  });

  return { byUrl, byName };
}

// Notion export: "Task Name (https://notion.so/...)\nTask B (https://...)" → ["Task Name", "Task B"]
function parseEpicList(s) {
  if (!s) return [];
  return String(s).split(/[\n,]+/)
    .map(function(x) {
      return x.replace(/\s*\(https?:\/\/[^)]+\)/g, '').trim();
    })
    .filter(Boolean);
}

// ============================================================
// Sheets reader
// ============================================================
function readSheet(ss, tabName) {
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error(`Sheet not found: "${tabName}"`);

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => String(h).trim());
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

// ============================================================
// Value helpers
// ============================================================
function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function fmtDate(v) {
  if (!v) return '';
  if (typeof v.getTime === 'function') {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  if (typeof v === 'number' && v > 1000) {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  }
  const s = String(v).trim();
  if (!s) return '';
  const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return s;
}

// ============================================================
// Local test
// ============================================================
function testLocally() {
  const data = buildTimelineData();
  Logger.log(`Tasks: ${data.tasks.length}`);
  data.tasks.slice(0, 5).forEach(t => {
    Logger.log(
      `${t.priority} | ${t.epic} | ${t.team} | ${t.start}→${t.end} | ` +
      `PM: ${t.pm || 'none'} | PRD: ${t.prd || 'none'} | Status: ${t.status} | ` +
      `blocking: [${t.blocking.join(',')}]`
    );
  });
}
