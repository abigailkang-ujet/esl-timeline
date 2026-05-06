# Jira Live Sync (status / start / end) — Design Spec

**Date:** 2026-05-06
**Project:** ESL Phase 1 — Dynamic Timeline (`/Users/ab/esl-timeline`)
**Scope:** `webApp.gs` only — add a render-time Jira REST fetch that overrides three fields (`status`, `notionStart`, `notionEnd`) on every task that has a Jira URL. CSS / JS / status logic in `index.html` get tiny touch-ups for a new "Done" schedule pill. Notion → Sheets daily sync stays in place for every other field.

---

## Background

The current data path is **Jira → Notion → Sheets → webApp.gs → index.html**. The Notion → Sheets hop runs as a daily 7 AM trigger (`syncNotionToSheets.gs`), so a status change made in Jira can take up to 24 hours to surface in the timeline. The user reported a real instance of this: a ticket already moved to "In Progress" in Jira but the timeline still showed it as the prior status with stale data.

Three fields are most sensitive to staleness because the Schedule chip is keyed on them:
- `status` — drives the chip's branch (Closed / In Progress / pre-start)
- Jira "Start Date" (`customfield_11014`) — surfaced as `t.notionStart`
- Jira "Due Date" (`duedate`) — surfaced as `t.notionEnd`

Fetching just these three live from Jira eliminates the 24-hour gap for the Schedule chip while leaving every other field on the existing Notion path. The 2026-04-30 status-driven schedule rewrite is the precondition that makes this worthwhile — the chip already trusts `t.status` over date presence, so a fresh status alone unblocks the right chip color even when dates lag.

This spec deliberately defers `blocking` / `blockedBy` (Jira `issuelinks`) to a later spec. Jira's link model has many types (`Blocks`, `Cloners`, `Duplicate`, `Relates`, `Causes` …) that need a UX decision for `drawDependencies`, and that's a different problem from sync latency.

---

## Goals

1. The Schedule chip reflects the Jira status within minutes of a workflow transition, not hours.
2. Actual start / end dates from Jira reach the timeline without waiting for the daily Notion sync.
3. Failure of the Jira API never breaks the page — fall back to the Notion-synced values gracefully.
4. The new "Done" pill (introduced in this pass) covers Closed tickets that legitimately lack end-date data so they don't disappear into `—`.
5. No change to `index.html` data shapes — the same `t.status` / `t.notionStart` / `t.notionEnd` fields downstream consumers already read.

## Non-goals

- No change to Notion → Sheets daily sync (`syncNotionToSheets.gs` stays). Other fields (PM Owner, PMO, PRD URL, Strategic, Comment, Priority, Team, etc.) continue flowing through that path.
- No change to the `Sheets` schema or Notion DB schema.
- No `blocking` / `blockedBy` from Jira — separate spec.
- No status name normalization. Take Jira's `status.name` verbatim. If Jira returns `Done` while Notion-synced data was using `Closed`, both will appear in the Schedule strip filter; we'll observe and decide a mapping later if needed.
- No background time-based trigger. The fetch runs at render time, gated by a 5-minute `CacheService` entry.
- No new tests / test framework — verification is static grep + post-deploy visual.

---

## Data Lineage (after this change)

| Field | Source (after) | Source (before) |
|-------|----------------|-----------------|
| `t.status` | Jira REST `status.name` (live, 5-min cache); Notion fallback on Jira failure | Notion → Sheets daily |
| `t.notionStart` | Jira REST `customfield_11014` (live, 5-min cache); Notion fallback | Notion "Start-End Date" → split → daily sync |
| `t.notionEnd` | Jira REST `duedate` (live, 5-min cache); Notion fallback | Notion "Start-End Date" → split → daily sync |
| Everything else (PM, PMO, PRD, etc.) | unchanged | unchanged |

The variable names `notionStart` / `notionEnd` are kept even though the data now sources from Jira, because:
- All downstream code (`index.html`, schedule logic, tooltip, Show Actual columns) already reads these names.
- Renaming would be a larger churn for no semantic gain — the values *are* "actual dates from Jira (via Notion previously, directly now)."

---

## Implementation

### `webApp.gs` — new constants

```js
const JIRA_DOMAIN      = 'ujetcs.atlassian.net';
const JIRA_EMAIL       = 'abigail.kang@ujet.cx';
const JIRA_FIELD_START = 'customfield_11014';   // Jira's Start Date custom field
const JIRA_FIELD_END   = 'duedate';
const JIRA_CACHE_KEY   = 'esl-jira-live-v1';
const JIRA_CACHE_TTL   = 300;                    // 5 minutes
```

Email and domain are not sensitive — kept as constants in code for readability. The token lives in Apps Script Script Properties under key `jiraToken` (added manually by the user, mirroring the existing `notionToken` pattern).

### `extractJiraKey(epicUrl)` helper

```js
function extractJiraKey(epicUrl) {
  if (!epicUrl) return '';
  var m = String(epicUrl).match(/\/browse\/([A-Z]+-\d+)/);
  return m ? m[1] : '';
}
```

Handles `https://ujetcs.atlassian.net/browse/CALL-4427` → `CALL-4427`. Empty input or non-matching URL returns empty string (placeholder tasks fall through to Notion data).

### `fetchJiraLive(jiraKeys)` — bulk fetch + cache

One JQL search `key in (KEY-1,KEY-2,…)` with `fields=status,customfield_11014,duedate&maxResults=200`. Returns a `{ KEY: { status, start, end } }` map. Empty map on any failure (no token, non-200, exception). Caches the result map for 5 minutes via `CacheService.getScriptCache()`.

`muteHttpExceptions: true` so non-200 doesn't throw — we inspect `getResponseCode()` and return empty on anything other than 200. `Logger.log` records the failure mode for debugging via Apps Script Executions UI.

### `buildTimelineData()` — integration

After the existing loop builds `data[]` from Sheets + Notion, before returning:

```js
var jiraKeys = data
  .map(function(t) { return extractJiraKey(t.epicUrl); })
  .filter(function(k) { return k; });
var live = fetchJiraLive(jiraKeys);

data.forEach(function(t) {
  var key = extractJiraKey(t.epicUrl);
  if (!key) return;                    // pre-Jira placeholder — keep Notion data
  var liveEntry = live[key];
  if (!liveEntry) return;              // Jira didn't return this key — keep Notion data

  if (liveEntry.status) t.status = liveEntry.status;
  t.notionStart = liveEntry.start || '';
  t.notionEnd   = liveEntry.end   || '';
});

return data;
```

Three-field override only. Status is taken only when truthy (defensive — Jira always returns a status, but if the response shape ever changes we don't blank it out). Dates are taken verbatim from Jira including empty — Jira's "no date set" should propagate, otherwise stale Notion dates would mask the truth.

### `index.html` — "Done" pill (the only client-side change)

When a task is `Closed` but missing either `t.end` (planned) or `t.notionEnd` (actual), the chip currently renders `—`. With this spec, those tasks render a new "Done" pill instead:

- New CSS class `.schedule-done` — neutral grey (`color: var(--text-muted)`, `background: rgba(148,163,184,0.10)`, `border-color: rgba(148,163,184,0.25)`). Distinct from `On Track` (green = closed-on-time) so the visual story is clear: green = "closed AND we can confirm it was on time", grey-Done = "closed BUT we can't compare".
- `getScheduleStatus(t)` Closed branch returns `'Done'` (instead of `'—'`) when either date is missing.
- `buildScheduleBadge(t)` adds the `Done` case.
- `explainSchedule(t, s)` Closed branch's missing-date message becomes the `Done` chip's hover.
- `SCHEDULE_ORDER` (line ~767) gains `'Done'` between `'Ahead'` and `'—'`. The Schedule filter strip will show a Done pill if any task qualifies.

### Failure path summary

| Failure | Behavior |
|---------|----------|
| `jiraToken` missing in Script Properties | `fetchJiraLive` returns `{}`, every task uses Notion data, page renders. Logger logs a warning. |
| Jira returns 401 / 4xx / 5xx | Same — `{}` returned, Notion fallback, Logger logs the HTTP code. |
| Apps Script `UrlFetchApp` throws (network, DNS) | `try/catch` swallows, returns `{}`. Logger logs the message. |
| Jira response shape unexpected | Iteration over `json.issues` is null-safe; missing `fields.status` leaves the task on Notion status (the `if (liveEntry.status)` guard). |
| Cache corrupt | `try/catch` around `JSON.parse(cached)` falls through to a fresh fetch. |

In every failure mode the page renders normally with Notion data — same shape, possibly up to ~24 hours stale.

---

## Apps Script setup (one-time, by user)

Before deploying:

1. Apps Script editor → ⚙ Project Settings → Script Properties → Add property
   - Property name: `jiraToken`
   - Value: paste the existing Atlassian API token (the user already has one from the `jira-notion-sync` project)
2. Save.

Token is account-scoped, not project-scoped, so the same token from the other Apps Script project works here.

---

## Verification Plan

**Static (pre-commit):**

1. `grep -n "fetchJiraLive\|extractJiraKey\|JIRA_DOMAIN\|JIRA_FIELD_START" webApp.gs` — new functions and constants present.
2. `grep -n "jiraToken" webApp.gs` — token is read from Script Properties (no hard-coded value).
3. `grep -n "schedule-done\|'Done'" index.html` — new pill class + SCHEDULE_ORDER entry.
4. `grep -n "muteHttpExceptions" webApp.gs` — non-200 handling is in place.

**Post-deploy (live URL):**

1. First load — small added latency (~1-2 s) for the initial Jira fetch.
2. Reload within 5 minutes — fast (cache hit).
3. Pick a To Do ticket, transition it to In Progress in Jira, wait at most 5 minutes (cache TTL) and reload — Schedule chip updates from Behind to On Track.
4. Apps Script Executions log shows `fetchJiraLive` runs without error.
5. Temporarily clear `jiraToken` in Script Properties → reload — page still renders, all tasks fall back to Notion data, Logger has a "no jiraToken" entry.
6. Find (or contrive) a Closed ticket with no end date in Jira → Schedule chip is the new grey "Done" pill, hover reads "Closed but missing actual or planned end date — cannot compare to plan."
7. Status filter strip shows a "Done" pill if any task qualifies; clicking it filters the table.

---

## Out of Scope (Flagged for Future)

- **`blocking` / `blockedBy` from Jira** — Jira `issuelinks` includes types beyond Blocks (Cloners, Duplicates, Relates, Causes). Needs a UX decision for `drawDependencies` (filter, color-by-type, tooltips). Separate spec.
- **Status name normalization / mapping** — wait until verbatim Jira values surface a real conflict, then revisit. Current Schedule logic uses case-insensitive `closed|done|complete` regex so the chip color stays correct either way; the strip filter is the only place that does exact-match.
- **Background time-trigger sync** — would let the page render zero-latency, but adds a moving part. Not warranted at the current ~37-task scale.
- **Pagination of JQL** — `maxResults=200` is plenty for now. If task count crosses ~150, we'd batch keys.
- **Stale indicator UI** — when Notion fallback is in use, we silently serve old data. A small banner ("Live Jira sync unavailable, showing data from Xh ago") was option C in brainstorm; deferred — only worth adding if fallback hits become common.

---

## Acceptance Criteria

1. `webApp.gs` defines `JIRA_DOMAIN`, `JIRA_EMAIL`, `JIRA_FIELD_START`, `JIRA_FIELD_END`, `JIRA_CACHE_KEY`, `JIRA_CACHE_TTL` as constants.
2. `webApp.gs` defines `extractJiraKey(epicUrl)` and `fetchJiraLive(jiraKeys)` helpers.
3. `buildTimelineData()` calls `fetchJiraLive` after the Sheets + Notion data is built and overrides `status`, `notionStart`, `notionEnd` per task when Jira returned a row for that key.
4. Any Jira failure path (no token / non-200 / network throw / parse error) returns an empty map; every task falls through to Notion data with no exception bubbling to the user.
5. The `jiraToken` value is read from `PropertiesService.getScriptProperties()` — never hard-coded.
6. `getScheduleStatus(t)` returns `'Done'` when status is closed-like AND `t.notionEnd` or `t.end` is missing. Otherwise the existing branches stand.
7. `index.html` has a `.schedule-done` CSS rule, a `Done` case in `buildScheduleBadge`, an explanation in `explainSchedule`, and `'Done'` added to `SCHEDULE_ORDER`.
8. CLAUDE.md is updated under "Schedule Badge" and adds a note about the live Jira sync data lineage.
