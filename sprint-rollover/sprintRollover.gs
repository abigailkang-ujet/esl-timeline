/**
 * sprintRollover.gs — DevHub board (DEVH, board 1783) sprint auto-rollover.
 *
 * Source of truth for sprint dates/names = the UJET "Release Calendar" Google Calendar
 * (all-day events titled like "Q26.4 Sprint 3" / "Q26.4 Sprint 4 - Bug Fix",
 * end date exclusive, Monday → Monday).
 *
 * Daily (~9 AM KST) the trigger:
 *   1. finds today's calendar sprint
 *   2. if Jira's active sprint is a different one: moves incomplete issues into today's
 *      sprint (creating it from the calendar if missing), completes the old sprint,
 *      starts the new one with the calendar dates
 *   3. makes sure the calendar's NEXT sprint exists on the board (creates it as future)
 *   4. emails the result to the script owner (only when something happened or needs attention)
 *
 * Dry-run by default — nothing is written to Jira until Script Property
 * `sprintRolloverLive` = 'true' (run enableSprintRolloverLive()).
 *
 * Standalone Apps Script project "DevHub Sprint Rollover" (split out of the ESL timeline project
 * 2026-10-26). Needs Script Property `jiraToken` (API token for JIRA_EMAIL);
 * that Jira account needs "Manage Sprints" on DEVH.
 */

const JIRA_DOMAIN = 'ujetcs.atlassian.net';
const JIRA_EMAIL  = 'abigail.kang@ujet.cx';

const SPRINT_BOARD_ID    = 1783;
const SPRINT_CALENDAR_ID = 'ujet.co_usq5ksn27smeqs37ik6dd3ev08@group.calendar.google.com';
const SPRINT_NAME_PREFIX = 'DevHub';
const SPRINT_LIVE_PROP   = 'sprintRolloverLive';
const SPRINT_TZ_OFFSET   = '+09:00';   // KST, no DST — Jira sprint boundaries are 00:00 KST

// ─────────────────────────── entry points ───────────────────────────

/** Trigger handler. Live or dry-run depending on the Script Property. */
function runSprintRollover() {
  var live = PropertiesService.getScriptProperties().getProperty(SPRINT_LIVE_PROP) === 'true';
  var res = rolloverFor_(todayKst_(), live);
  if (res.notify) sendRolloverMail_(res, live);
  Logger.log(res.lines.join('\n'));
}

/** Editor: what would happen today (never writes). */
function previewSprintRollover() {
  var res = rolloverFor_(todayKst_(), false);
  showRollover_('Sprint Rollover — preview (today)', res);
}

/** Editor: what will happen on the next calendar sprint boundary, given Jira as it is now (never writes). */
function previewNextSprintRollover() {
  var today = todayKst_();
  var cal = readCalendarSprints_(today);
  var upcoming = cal.filter(function(s) { return s.start > today; })[0];
  if (!upcoming) { showRollover_('Sprint Rollover — preview', { lines: ['No upcoming sprint in the calendar.'] }); return; }
  var res = rolloverFor_(upcoming.start, false);
  showRollover_('Sprint Rollover — preview (' + upcoming.start + ')', res);
}

function setupSprintRolloverTrigger() {
  removeSprintRolloverTrigger();
  ScriptApp.newTrigger('runSprintRollover')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .inTimezone('Asia/Seoul')
    .create();
  showRollover_('Sprint Rollover', { lines: [
    'Daily trigger set: every day ~9–10 AM KST.',
    'Mode: ' + (PropertiesService.getScriptProperties().getProperty(SPRINT_LIVE_PROP) === 'true' ? 'LIVE' : 'DRY RUN (emails what it would do)'),
  ] });
}

function removeSprintRolloverTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'runSprintRollover') ScriptApp.deleteTrigger(trigger);
  });
}

function enableSprintRolloverLive() {
  PropertiesService.getScriptProperties().setProperty(SPRINT_LIVE_PROP, 'true');
  showRollover_('Sprint Rollover', { lines: ['LIVE mode on — the trigger will now complete/start/create sprints in Jira.'] });
}

function disableSprintRolloverLive() {
  PropertiesService.getScriptProperties().deleteProperty(SPRINT_LIVE_PROP);
  showRollover_('Sprint Rollover', { lines: ['Back to DRY RUN — the trigger only emails what it would do.'] });
}

// ─────────────────────────── orchestration ───────────────────────────

/** Reads calendar + Jira, plans, executes (or simulates). Never throws — errors land in the result. */
function rolloverFor_(today, live) {
  var res = { today: today, lines: [], notify: false, error: null, summary: '' };
  try {
    var cal   = readCalendarSprints_(today);
    var jira  = fetchBoardSprints_();
    var plan  = planRollover_(today, cal, jira);
    res.summary = plan.summary;
    res.lines.push('Today (KST): ' + today + '   Mode: ' + (live ? 'LIVE' : 'DRY RUN'));
    res.lines.push('Calendar sprint: ' + (plan.current ? plan.current.title + ' (' + plan.current.start + ' → ' + plan.current.endExcl + ')' : '—'));
    res.lines.push('Jira active:     ' + (plan.active ? plan.active.name : '—'));
    res.lines.push('');
    plan.warnings.forEach(function(w) { res.lines.push('⚠️ ' + w); });
    if (!plan.actions.length) res.lines.push('Nothing to do.');
    executeRollover_(plan.actions, live, res.lines);
    res.notify = plan.actions.length > 0 || plan.warnings.length > 0;
  } catch (e) {
    res.error = String(e && e.message || e);
    res.lines.push('❌ ' + res.error);
    res.notify = true;
  }
  return res;
}

/**
 * Pure planner — no I/O, so it can be exercised with fixtures.
 *   cal  : [{key, title, bug, start, endExcl}] sorted by start ('yyyy-MM-dd')
 *   jira : [{id, name, state, originBoardId}]  (active + future sprints of the board)
 * Returns { current, next, active, actions:[...], warnings:[...], summary }.
 */
function planRollover_(today, cal, jira) {
  var plan = { current: null, next: null, active: null, actions: [], warnings: [], summary: '' };

  plan.current = cal.filter(function(s) { return s.start <= today && today < s.endExcl; })[0] || null;
  if (!plan.current) {
    plan.warnings.push('No Release Calendar sprint covers ' + today + ' — nothing changed. Add the sprint to the calendar.');
    plan.summary = 'no calendar sprint for ' + today;
    return plan;
  }
  var cur = plan.current;
  plan.next = cal.filter(function(s) { return s.start >= cur.endExcl; })[0] || null;

  var mine = jira.filter(function(s) { return !s.originBoardId || s.originBoardId === SPRINT_BOARD_ID; });
  var actives = mine.filter(function(s) { return s.state === 'active'; });
  if (actives.length > 1) {
    plan.warnings.push('More than one active sprint on the board (' + actives.map(function(s) { return s.name; }).join(', ') + ') — not touching anything.');
    plan.summary = 'multiple active sprints';
    return plan;
  }
  var active = plan.active = actives[0] || null;
  var byKey = function(key) { return mine.filter(function(s) { return sprintKey_(s.name) === key; })[0] || null; };

  var activeKey = active ? sprintKey_(active.name) : null;
  if (activeKey !== cur.key) {
    // Someone already started a LATER sprint by hand — leave it alone.
    var activeCal = cal.filter(function(s) { return s.key === activeKey; })[0];
    if (activeCal && activeCal.start > cur.start) {
      plan.warnings.push('Jira active sprint "' + active.name + '" is ahead of the calendar (' + cur.title + ') — not touching it.');
    } else {
      var target = byKey(cur.key);
      if (!target) plan.actions.push({ type: 'create', sprint: cur });
      if (active) {
        plan.actions.push({ type: 'moveIncomplete', from: active, toKey: cur.key, toId: target ? target.id : null, toName: target ? target.name : jiraSprintName_(cur) });
        plan.actions.push({ type: 'close', sprint: active });
      }
      plan.actions.push({ type: 'start', key: cur.key, id: target ? target.id : null, name: target ? target.name : jiraSprintName_(cur), cal: cur });
      plan.summary = (active ? active.name : '(none)') + ' → ' + (target ? target.name : jiraSprintName_(cur));
    }
  }

  if (plan.next) {
    if (!byKey(plan.next.key)) plan.actions.push({ type: 'create', sprint: plan.next });
  } else if (daysBetween_(today, cur.endExcl) <= 7) {
    plan.warnings.push('Release Calendar has no sprint after ' + cur.title + ' (ends ' + cur.endExcl + ') — next rollover will stall until it is added.');
  }

  if (!plan.summary) plan.summary = plan.actions.length ? 'create ' + jiraSprintName_(plan.next) : 'no change';
  return plan;
}

/** Runs planned actions in order. Dry-run still READS (incomplete issue list) so the email is concrete. */
function executeRollover_(actions, live, lines) {
  var idByKey = {};
  var verb = live ? '' : '[dry run] would ';
  actions.forEach(function(a) {
    if (a.type === 'create') {
      var body = jiraSprintBody_(a.sprint);
      lines.push('➕ ' + verb + 'create "' + body.name + '" (' + a.sprint.start + ' → ' + addDays_(a.sprint.endExcl, -1) + ')');
      if (live) idByKey[a.sprint.key] = jiraAgile_('post', '/sprint', body).id;
    } else if (a.type === 'moveIncomplete') {
      var keys = fetchIncompleteIssueKeys_(a.from.id);
      lines.push('↪️ ' + verb + 'move ' + keys.length + ' incomplete issue(s) from "' + a.from.name + '" → "' + a.toName + '"' +
                 (keys.length ? ': ' + keys.join(', ') : ''));
      if (live && keys.length) {
        var toId = a.toId || idByKey[a.toKey] || findSprintIdByKey_(a.toKey);
        for (var i = 0; i < keys.length; i += 50) {
          jiraAgile_('post', '/sprint/' + toId + '/issue', { issues: keys.slice(i, i + 50) });
        }
      }
    } else if (a.type === 'close') {
      lines.push('✅ ' + verb + 'complete "' + a.sprint.name + '"');
      if (live) jiraAgile_('post', '/sprint/' + a.sprint.id, { state: 'closed' });
    } else if (a.type === 'start') {
      var dates = jiraSprintBody_(a.cal);
      lines.push('▶️ ' + verb + 'start "' + a.name + '" (' + a.cal.start + ' → ' + addDays_(a.cal.endExcl, -1) + ')');
      if (live) {
        var id = a.id || idByKey[a.key] || findSprintIdByKey_(a.key);
        jiraAgile_('post', '/sprint/' + id, { state: 'active', startDate: dates.startDate, endDate: dates.endDate });
      }
    }
  });
}

// ─────────────────────────── naming / dates ───────────────────────────

/** "DevHub  Q26.4 Sprint 4 Bug Fix" / "Q26.4 Sprint 4 - Bug Fix" → "Q26.4-4". Null if not a sprint name. */
function sprintKey_(name) {
  var m = String(name || '').match(/Q\s*(\d+)\.(\d+)\s*Sprint\s*(\d+)/i);
  return m ? 'Q' + m[1] + '.' + m[2] + '-' + Number(m[3]) : null;
}

/** Calendar entry → Jira sprint name, e.g. "DevHub Q26.4 Sprint 6 Bug Fix". */
function jiraSprintName_(cal) {
  var m = cal.key.match(/^Q(\d+\.\d+)-(\d+)$/);
  return SPRINT_NAME_PREFIX + ' Q' + m[1] + ' Sprint ' + m[2] + (cal.bug ? ' Bug Fix' : '');
}

/** Jira sprint body. Matches existing board convention: start = first day 00:00 KST, end = last calendar day (exclusive end − 1) 00:00 KST. */
function jiraSprintBody_(cal) {
  return {
    name: jiraSprintName_(cal),
    originBoardId: SPRINT_BOARD_ID,
    startDate: cal.start + 'T00:00:00.000' + SPRINT_TZ_OFFSET,
    endDate: addDays_(cal.endExcl, -1) + 'T00:00:00.000' + SPRINT_TZ_OFFSET,
  };
}

function todayKst_() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
}

function addDays_(ymd, n) {
  var p = ymd.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.toISOString().slice(0, 10);
}

function daysBetween_(a, b) {
  var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

// ─────────────────────────── I/O ───────────────────────────

/** All-day sprint events from ~10 weeks back to ~5 months ahead, sorted by start. */
function readCalendarSprints_(today) {
  var cal = CalendarApp.getCalendarById(SPRINT_CALENDAR_ID);
  if (!cal) throw new Error('Cannot open Release Calendar (' + SPRINT_CALENDAR_ID + ') — is it shared with the script owner?');
  var from = new Date(addDays_(today, -70) + 'T00:00:00' + SPRINT_TZ_OFFSET);
  var to   = new Date(addDays_(today, 150) + 'T00:00:00' + SPRINT_TZ_OFFSET);
  // getAllDay*Date() is midnight in the SCRIPT's time zone, so format with that zone to get the calendar day back.
  var tz = Session.getScriptTimeZone();
  return cal.getEvents(from, to)
    .filter(function(e) { return e.isAllDayEvent() && sprintKey_(e.getTitle()); })
    .map(function(e) {
      var title = e.getTitle().trim();
      return {
        key: sprintKey_(title),
        title: title,
        bug: /bug/i.test(title),
        start: Utilities.formatDate(e.getAllDayStartDate(), tz, 'yyyy-MM-dd'),
        endExcl: Utilities.formatDate(e.getAllDayEndDate(), tz, 'yyyy-MM-dd'),
      };
    })
    .sort(function(a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
}

function fetchBoardSprints_() {
  var out = [], startAt = 0;
  for (;;) {
    var page = jiraAgile_('get', '/board/' + SPRINT_BOARD_ID + '/sprint?state=active,future&maxResults=50&startAt=' + startAt);
    out = out.concat(page.values || []);
    if (page.isLast || !(page.values || []).length) break;
    startAt += page.values.length;
  }
  return out;
}

function findSprintIdByKey_(key) {
  var s = fetchBoardSprints_().filter(function(x) { return sprintKey_(x.name) === key; })[0];
  if (!s) throw new Error('Sprint ' + key + ' not found on board ' + SPRINT_BOARD_ID);
  return s.id;
}

/** Keys of not-Done, non-subtask issues in a sprint (subtasks follow their parent when it moves). */
function fetchIncompleteIssueKeys_(sprintId) {
  var keys = [], startAt = 0;
  var jql = encodeURIComponent('statusCategory != Done');
  for (;;) {
    var page = jiraAgile_('get', '/sprint/' + sprintId + '/issue?jql=' + jql + '&fields=issuetype&maxResults=100&startAt=' + startAt);
    var issues = page.issues || [];
    issues.forEach(function(i) {
      if (!(i.fields && i.fields.issuetype && i.fields.issuetype.subtask)) keys.push(i.key);
    });
    startAt += issues.length;
    if (!issues.length || startAt >= (page.total || 0)) break;
  }
  return keys;
}

function jiraAgile_(method, path, body) {
  // trim + strip quotes: a pasted token with a trailing newline/space gives a bare 401
  var token = String(PropertiesService.getScriptProperties().getProperty('jiraToken') || '').trim().replace(/^["']|["']$/g, '');
  if (!token) throw new Error('jiraToken not set in Script Properties');
  var opts = {
    method: method,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(JIRA_EMAIL + ':' + token), Accept: 'application/json' },
    muteHttpExceptions: true,
  };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  var resp = UrlFetchApp.fetch('https://' + JIRA_DOMAIN + '/rest/agile/1.0' + path, opts);
  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Jira ' + method.toUpperCase() + ' ' + path + ' → HTTP ' + code + ': ' + text.slice(0, 300) +
                    (code === 403 ? ' (needs "Manage Sprints" permission on DEVH)' :
                     code === 401 ? ' (jiraToken rejected — check it is the same token as the ESL project, for ' + JIRA_EMAIL + ')' : ''));
  }
  return text ? JSON.parse(text) : {};
}

// ─────────────────────────── output ───────────────────────────

function sendRolloverMail_(res, live) {
  var tag = res.error ? 'ERROR' : (live ? 'done' : 'DRY RUN');
  var subject = '[Sprint Rollover] ' + tag + ' — ' + (res.summary || res.today);
  var body = res.lines.join('\n') +
    '\n\nBoard: https://' + JIRA_DOMAIN + '/jira/software/c/projects/DEVH/boards/' + SPRINT_BOARD_ID + '/backlog' +
    (live ? '' : '\n\nDry run — nothing was changed. Run enableSprintRolloverLive() in the Apps Script editor to go live.');
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, body);
}

/** Standalone project has no UI — results go to the editor's execution log. */
function showRollover_(title, res) {
  Logger.log(title + '\n' + res.lines.join('\n'));
}

/**
 * Editor: figure out WHY Jira returns 401. Tries the same token against
 *   1. site URL, platform API   (/rest/api/3/myself)        — what the ESL timeline uses
 *   2. site URL, agile API      (/rest/agile/1.0/board/…)   — what this script uses
 *   3. API gateway, both        (api.atlassian.com/ex/jira/{cloudId}/…) — required for *scoped* API tokens
 * Never logs the token itself, only its length.
 */
function diagnoseJiraAuth() {
  var raw = PropertiesService.getScriptProperties().getProperty('jiraToken') || '';
  var token = String(raw).trim().replace(/^["']|["']$/g, '');
  var auth = { Authorization: 'Basic ' + Utilities.base64Encode(JIRA_EMAIL + ':' + token), Accept: 'application/json' };
  var out = ['email: ' + JIRA_EMAIL, 'token length: ' + raw.length + ' raw / ' + token.length + ' cleaned'];

  var cloudId = '';
  try {
    cloudId = JSON.parse(UrlFetchApp.fetch('https://' + JIRA_DOMAIN + '/_edge/tenant_info').getContentText()).cloudId;
  } catch (e) { out.push('cloudId lookup failed: ' + e); }
  out.push('cloudId: ' + cloudId);

  var probes = [
    ['site  /rest/api/3/myself',            'https://' + JIRA_DOMAIN + '/rest/api/3/myself'],
    ['site  /rest/agile board',             'https://' + JIRA_DOMAIN + '/rest/agile/1.0/board/' + SPRINT_BOARD_ID],
    ['gateway /rest/api/3/myself',          'https://api.atlassian.com/ex/jira/' + cloudId + '/rest/api/3/myself'],
    ['gateway /rest/agile board',           'https://api.atlassian.com/ex/jira/' + cloudId + '/rest/agile/1.0/board/' + SPRINT_BOARD_ID],
  ];
  probes.forEach(function(p) {
    try {
      var r = UrlFetchApp.fetch(p[1], { headers: auth, muteHttpExceptions: true });
      out.push(p[0] + ' → ' + r.getResponseCode() + '  ' + r.getContentText().slice(0, 120).replace(/\s+/g, ' '));
    } catch (e) { out.push(p[0] + ' → threw ' + e); }
  });
  Logger.log(out.join('\n'));
}
