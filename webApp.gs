/**
 * ESL Timeline — Apps Script Web App
 * ============================================================
 * Data sources:
 *   1. Google Sheets "Realistic Scenario - Tasks Details (S2)" → timeline dates, effort, allocation
 *   2. Google Sheets "Notion_raw" tab → all Notion fields (kept fresh by syncNotionToSheets.gs)
 *
 * Flow:
 *   syncNotionToSheets.gs  →  writes Notion_raw tab  (run manually or on schedule)
 *   doGet()                →  reads both tabs, joins on JIRA URL, serves HTML
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
const JIRA_CACHE_KEY       = 'esl-jira-live-v3';    // bump on parser/shape change
const JIRA_CACHE_TTL       = 300;                    // 5 minutes
const JIRA_LATE_COMMENTS_CACHE_KEY = 'esl-late-comments-v1';
const JIRA_LATE_COMMENTS_CACHE_TTL = 300;            // 5 minutes

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
        .createTextOutput(JSON.stringify({ ok: true, tasks: data.tasks.length }))
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
        // Only surface comments that match our late-reason convention:
        // body must start with "[" (i.e. "[Author] reason"). Keeps the
        // tooltip free of unrelated Jira chatter.
        return c.body && c.body.trim().charAt(0) === '[';
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
// Core: join Realistic Scenario + Notion_raw (both from Sheets)
// ============================================================
function buildTimelineData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const rsRows                  = readSheet(ss, REALISTIC_TAB);
  const { byUrl, byName }       = buildNotionIndex(ss);
  const optimisticByUrl         = buildScenarioIndex(ss, OPTIMISTIC_TAB);
  const pessimistByUrl          = buildScenarioIndex(ss, PESSIMIST_TAB);

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
    t.actualStart     = liveEntry.start || '';
    t.actualEnd       = liveEntry.end   || '';
    t.statusChangedAt = liveEntry.statusChangedAt || '';
    t.resolvedAt      = liveEntry.resolvedAt      || '';
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

  return { tasks, updatedAt: new Date().toISOString(), totalRows: tasks.length };
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
    fields: ['status', JIRA_FIELD_START, JIRA_FIELD_END,
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
        start:           f[JIRA_FIELD_START] || '',
        end:             f[JIRA_FIELD_END]   || '',
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
