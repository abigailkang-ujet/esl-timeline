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

const REALISTIC_TAB = 'Realistic Scenario - Tasks Details (S2)';

// ── Jira live sync (status / start / end) — see spec 2026-05-06 ──
const JIRA_DOMAIN      = 'ujetcs.atlassian.net';
const JIRA_EMAIL       = 'abigail.kang@ujet.cx';
const JIRA_FIELD_START = 'customfield_11014';   // Jira Start Date custom field
const JIRA_FIELD_END   = 'duedate';
const JIRA_CACHE_KEY   = 'esl-jira-live-v2';   // bump on parser/shape change
const JIRA_CACHE_TTL   = 300;                    // 5 minutes

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
// Core: join Realistic Scenario + Notion_raw (both from Sheets)
// ============================================================
function buildTimelineData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const rsRows                  = readSheet(ss, REALISTIC_TAB);
  const { byUrl, byName }       = buildNotionIndex(ss);

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

    tasks.push({
      // ── From Realistic Scenario tab (team leads enter these) ──
      epic:           epicKey,
      epicUrl:        epicUrl,
      task:           str(row['Task (Do not edit)']),
      lead:           str(row['Lead']),
      allocation:     str(row['Allocation']),
      headcount:      str(row['Headcount']),
      risk:           str(row['Risk Factor']),
      start:          fmtDate(row['Start Date']),
      end:            fmtDate(row['End Date (Do not edit)']),
      effort:         num(row['Planned Effort  (#weeks)']),
      scenarioEffort: num(row['Scenario Estimated Effort (dev weeks)']),
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
  var url = 'https://' + JIRA_DOMAIN + '/rest/api/3/search'
          + '?jql=' + encodeURIComponent(jql)
          + '&fields=status,' + JIRA_FIELD_START + ',' + JIRA_FIELD_END
          + ',statuscategorychangedate,resolutiondate,issuelinks'
          + '&maxResults=200';
  var creds = Utilities.base64Encode(JIRA_EMAIL + ':' + token);

  var byKey = {};
  try {
    var resp = UrlFetchApp.fetch(url, {
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
