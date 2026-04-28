# ESL Phase 1 - Dynamic Timeline Project

---
## For Other PMO Teams Using This File

Give this file to Claude and ask:
> "This CLAUDE.md describes a Gantt timeline project built with Google Sheets + Apps Script. We want to build something similar — what do we need and how do we get started?"

**Project-specific values to replace with your own:**
- Spreadsheet ID: `1s_AGnjgrSc_UtrVBRVHORlV_V9NpocKt15EpJaxmXpw`
- Notion DB ID: `33b5bd55-7775-8190-9e38-fa14f6b29411`
- Live URL: generated after deploying Apps Script
- Team names: CALL, SDK, CHAT, API, Email, AGX, DATA → replace with your team names

**Known gotchas (learned through trial and error):**
- Never use backticks (template literals) in index.html → breaks HtmlService parsing
- Never use static `<svg>` tags in HTML → generate SVG dynamically via JS
- Never hardcode the Notion token in code → store in Apps Script Script Properties

---

## Project Goal
Dynamic Gantt timeline driven by Google Sheets (Realistic Scenario) + Notion DB data

---

## ✅ jira_url as PK (refactor completed 2026-04-27)

**History**: [docs/refactoring-jira-url-pk.md](docs/refactoring-jira-url-pk.md)

Sheets schema migrated from "row-position + task-name" joins to "jira_url" joins. All sync/lookup logic now keys on `jira_url`. Row order in Notion_raw is irrelevant — it can be sorted/shuffled without breaking anything downstream.

**Non-negotiable rules for any future code touching this project:**
1. **jira_url is the primary key everywhere.** Never use task name or row number as a join key.
2. **No `ROW()` fallback** in any Sheets formula.
3. **No `MATCH(task_name; …)`** in any Sheets formula. Use `XLOOKUP($jira_url; Notion_raw!$J:$J; Notion_raw!<target_col>; "")`. *Exception*: a task-name `XLOOKUP` is allowed only as an `IFERROR` fallback after a primary jira_url lookup — solely to handle pre-Jira placeholder tasks (rows that exist in Overall/Realistic but have no Jira ticket yet). See `docs/refactoring-jira-url-pk.md` Step 3.
4. **Sync script (`syncNotionToSheets.gs`) is clear+dump.** Do not reintroduce in-place update, `claimedRows`, or any logic that depends on Notion_raw row order.
5. **Manual columns in Overall** (Lead/Allocation/Headcount/Risk/Optimistic/Realistic/Pessimist/Note) are anchored to jira_url. New jira_urls auto-appended via `ensureOverallAnchors()`.
6. When writing any new formula, ask: "does this still work if Notion_raw is reordered?" If not, rewrite it.

**Current Sheet column layouts:**
- **Notion_raw**: A=Requirement, B=Priority, C=Strategic, D=Status, E=PM Size, F=PRD, G=Eng Size, H=Team, I=Comment, **J=JIRA (PK)**, K=Prelim Date, L=PM Owner, M=PMO Owner, N=Start-End, O-Q=Kickoff/PRD URLs, R=Blocked by, S=Blocking, T=Notion_ID
- **Overall**: **A=jira_url (PK)**, B=Priority, C=Task, D=Lead Engineer, E=Allocation, F=Headcount, G=Ideal Delivery, H=T-shirt, I=Risk factor, J=Optimistic, K=Realistic, L=Pessimist, M=Note
- **Realistic Scenario**: A=Priority, **B=Epic/jira_url (PK, manual)**, C=Task, D=Lead, E=Allocation, F=Headcount, G=Risk Factor, H=Start Date (manual), I=End Date, J=Planned Effort, K=Scenario Estimated Effort, L=Ideal Delivery

---

## Data Architecture

```
Jira (auto-sync) ──→ Notion "ESL Project list" DB
                              ↓ syncNotionToSheets.gs (clear+dump, daily 7 AM trigger)
                      Google Sheets "Notion_raw" tab (PK: col J = JIRA URL)
                              ↓ XLOOKUP by jira_url
                      Google Sheets "Overall" tab (PK: col A = jira_url)
                              ↓ XLOOKUP by jira_url
Google Sheets "Realistic Scenario - Tasks Details (S2)" ──→ webApp.gs (join on JIRA URL)
                                                                      ↓
                                                              index.html (serves Gantt)
```

All joins are by `jira_url`. Row order in any tab is irrelevant — manual data is anchored by PK.

---

## Spreadsheet Info

- **Spreadsheet ID**: `1s_AGnjgrSc_UtrVBRVHORlV_V9NpocKt15EpJaxmXpw`
- **URL**: https://docs.google.com/spreadsheets/d/1s_AGnjgrSc_UtrVBRVHORlV_V9NpocKt15EpJaxmXpw/edit
- **Key tabs**: Realistic Scenario - Tasks Details (S2), Notion_raw, Overall, Engineers

## Notion DB Info

- **DB ID**: `33b5bd55-7775-8190-9e38-fa14f6b29411`
- **notionToken**: stored in Script Properties under key `notionToken`

## Apps Script Deployment

- **Live URL**: https://script.google.com/a/macros/ujet.cx/s/AKfycbzFRDFEpOfH47DNCXgf1hruIzrI-B951nYqFj_6I-7_9cQHEJMQkt8TnZuFrns9a4sD/exec
- **Access**: Anyone (no auth)
- **Code changes** → redeploy required (Deploy → Manage → New version)
- **Data changes** (Sheets only) → no redeploy needed, just refresh the page

---

## File Status (as of 2026-04-27)

| File | Status | Description |
|------|--------|-------------|
| `webApp.gs` | ✅ Deployed | Team resolution, Notion join, error filtering |
| `index.html` | ✅ Deployed (2026-04-27 evening) | Glass cards + pill hover + PRD PM-grouped collapsible cards + Risk H/M/L chips + Schedule strip + subtitle polish + Program Weeks Elapsed/Total + earlier (widget X/Y, schedule badge, PRD To Do, status pill filter, shortName, task wrap, search, Gantt bar click, tooltip size/hover split) |
| `syncNotionToSheets.gs` | ✅ Refactored (787 lines, was 933) | Clear+dump strategy, jira_url as PK, `ensureOverallAnchors()` auto-append |
| `timeline.html` | Backup | Local standalone version |
| `syncToNotion.gs` | Deferred | Reverse sync (not needed) |

---

## Team Configuration (current)

```javascript
// index.html
const TEAM_COLORS = {
  CALL:'#3b82f6', SDK:'#8b5cf6', CHAT:'#10b981',
  API:'#f97316', Email:'#06b6d4', AGX:'#ec4899', DATA:'#a3e635',
};
const TEAM_ORDER = ['CALL','SDK','CHAT','API','Email','AGX','DATA'];

// TEAM_ALIASES (getTeamKey fallback)
'agent experience' → AGX
'admin experience' → ADX   // (legacy, ADX team removed)
'calls' / 'call'   → CALL
'web'              → SDK
'data platforms'   → DATA
'api'              → API
```

```javascript
// webApp.gs EPIC_TEAM_MAP (Jira prefix → team name)
CALL → CALL,  WEB → SDK,  SDK → SDK
AGX  → AGX,   CHAT → CHAT, API → API
DATA → DATA,  ESC → Email
// ADX removed (2026-04-16)
```

---

## webApp.gs Core Logic

```javascript
// Row filter: include rows with a task name, exclude formula errors (#N/A etc.)
const task = str(row['Task (Do not edit)']);
if (!task || task.startsWith('#')) return;

// Notion join: JIRA URL takes priority, falls back to task name (Requirement)
const { byUrl, byName } = buildNotionIndex(ss);
const n = (hasUrl && byUrl[epicUrl]) || byName[task] || {};
// → rows without an Epic URL can still be matched via Notion

// Team resolution order: epicTeam takes priority
team: epicTeam || n.team || str(row['Team'])

// JSON escaping (prevents SyntaxError)
tpl.timelineData = JSON.stringify(data)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
```

---

## index.html Feature List (updated 2026-04-27+)

### UI / Theme
- **Dark/light mode**: toggle button top-right, saved to localStorage (`esl-theme`)
- **Inter font**: body font-size 15px
- **CSS Variables**: `:root` + `body.light-mode` override
- **Row background**: task rows `--bg-elevated`, team headers `--bg-card` (light mode: reversed — task rows `--bg-card`, team headers `--bg-elevated`)
- **Gantt bar**: height 10px, border-radius 10px, opacity 0.8
- **Glassmorphism (2026-04-27)**: `.summary-card` and `.prd-pm-card` use `rgba(255,255,255,0.04)` bg + `backdrop-filter: blur(14px) saturate(140%)` + subtle inset highlight + thin translucent border. Border brightens on hover. Light mode uses `rgba(255,255,255,0.55)` bg + soft shadow.
- **Header subtitle (2026-04-27)**: 12px / opacity 0.7 / middle dot separator → `Gantt chart view · data live from Google Sheets & Notion`

### Summary Cards (buildSummary)
- **Row 1** (6 cards, in order): Tasks, P0, Past Ideal Date, PRD, Teams, Program Weeks
  - **Tasks / P0 / PRD**: render `X / Y` progress format. `X` keeps existing `.number` size/weight (P0 stays red). `Y` is rendered in a `<span class="num-total">` — smaller (0.6em) and muted (`--text-muted`).
  - **Tasks**: X = `status === 'Closed'` count, Y = `ALL_TASKS.length`. Label: `Complete / Total`.
  - **P0**: X = P0 & Closed count, Y = P0 total. Label: `P0 Complete / Total`.
  - **PRD**: X = `prdIsDone(t)` (PM assigned + state `done`), Y = `prdIsRequired(t)` (PM assigned + state ≠ `na`). Label: `PRD Complete / Required`. `-` (N/A) is excluded from the denominator.
  - **Past Ideal Date**: unchanged count card (`warn` class when > 0).
  - **Teams**: count of `TEAM_ORDER` entries with at least one task.
  - **Program Weeks**: `X / Y` format — X = weeks elapsed (`Math.floor((today - earliest start) / 7d)`, capped at total), Y = total weeks (`Math.ceil((latest end - earliest start) / 7d)`). Label: `Weeks Elapsed / Total`. Renders `—` when no valid dates.
  - **Empty category** (Y = 0) adds `is-empty` class → 50% opacity on the whole card.
  - PRD Alert (banner below): counts missing + todo + draft + review (done/na excluded). Unrelated to the PRD summary card.
  - Helpers live next to `getPrdState()`: `isClosed`, `prdIsDone`, `prdIsRequired`, `programSpanWeeks`.
- **Status strip** (below Row 1): dynamic pill cards per status
  - 16px bold number + 11px label, bg-elevated background + border
  - STATUS_ORDER: `['To Do', 'Untriaged', 'In Progress', 'Closed']`
  - **Clickable**: clicking a pill sets `activeStatus` and calls `renderAll(null)` to filter timeline
  - Active pill: colored border + tinted background highlight
  - Click same pill again → deselects (back to ALL)
- **Schedule strip (2026-04-27)** (below Status strip): same pattern, filter by Schedule status
  - SCHEDULE_ORDER: `['On Track', 'Behind', 'Ahead', '—']`
  - Variable: `activeSchedule` (parallel to `activeStatus`); AND-combined in `renderTimeline()` filter
  - Helpers: `getScheduleStatus(t)` (extracted from `buildScheduleBadge`), `scheduleColor(s)`
  - Colors: On Track green, Behind red, Ahead blue, — grey
- **Pill hover affordance (2026-04-27)**: both Status and Schedule pills get `.strip-pill` class with `:hover` → `translateY(-1px)` + box-shadow + `filter: brightness(1.12)` to signal clickability

### Risk Badge (column, 2026-04-27)
- `Low/Medium/High` in Realistic Scenario → rendered as single-letter color chip via `buildRiskBadge(risk)`
  - L (green), M (amber), H (red) — uses `.risk-badge` + `.risk-Low/Medium/High` CSS
  - Hover: chip's `.risk-letter` swaps with `.risk-word` via CSS, padding animates 2→9px → shows full word "Low / Medium / High" inline
  - Empty / unknown values → rendered as plain `-` (`.risk-none`)
- Hover behavior is CSS-only (no JS, no browser tooltip delay)

### PRD States (`getPrdState` function)
| Value | State | Badge | In PRD Alert? | In PRD card **X** (done) | In PRD card **Y** (required) |
|-------|-------|-------|----------------|--------------------------|------------------------------|
| `''` / `No` | `missing` | amber N | ✅ | ❌ | ✅ |
| `-` | `na` | grey - | ❌ | ❌ | ❌ |
| `Y` / `Yes` / `YES` | `done` | green ✓ | ❌ | ✅ | ✅ |
| `Draft` | `draft` | amber Draft (0.75 opacity) | ✅ | ❌ | ✅ |
| `In Review` / `Review` | `review` | blue Rev | ✅ | ❌ | ✅ |
| `To Do` | `todo` | grey `.prd-todo` (`#64748b`/`#f1f5f9`) | ✅ | ❌ | ✅ |

Note: PRD card counts require `t.pm` on both X and Y sides — tasks without a PM are not counted.

### PRD Alert Banner (rewritten 2026-04-27)
- **Layout**: per-PM collapsible cards (`.prd-pm-card`) — header click toggles `.collapsed` class
  - Header: `▼` toggle + PM first/last name + count chip (right-aligned)
  - Body: `<ol>` with items numbered 1, 2, 3
- **Item rendering** per task:
  - `[JIRA-KEY]` (clickable, opens Jira in new tab if `t.epicUrl` exists)
  - Task name
  - PRD state badge (reuses existing `.prd-badge` + `.prd-missing/.prd-draft/.prd-review/.prd-todo`)
  - Urgency text (red `started Xd ago` for overdue / amber `starts in Xd` for upcoming, ≤21 business days)
- **PM order**: most items first → alphabetical → "— Unassigned —" last
- **Item order inside PM**: overdue first (most-slipped first), then upcoming (soonest first)
- Date calc: `businessDaysBetween(from, to)` (weekends excluded)
- Default state: all PMs expanded; user can collapse individually

### Legend + Timestamp
- Legend: 12px, text-secondary, 8px dot
- Legend + "Updated: ..." → single row (metaRow flex, space-between)

### Filters
- **Team**: buttons (based on TEAM_ORDER)
- **PM**: `<select>` dropdown (not buttons)
- **Status**: `activeStatus` variable — set by clicking Status strip pills
- **Schedule (2026-04-27)**: `activeSchedule` variable — set by clicking Schedule strip pills
- **Search**: text input in ctrlRow — filters by task name + JIRA key (case-insensitive)
- **Deps**: toggle on same row as PM dropdown (ctrlRow)
- **Show Actual (2026-04-28)**: toggle next to Deps. `showActual` global, persisted in localStorage `esl-show-actual`. When ON, two extra columns `Act Start` / `Act End` appear between `Plan End` and `Ideal`, sourced from `t.notionStart` / `t.notionEnd` (Jira via Notion).

### What's-new tour overlay (2026-04-28)
- `?` button in top-right (next to theme toggle) opens a sequential walkthrough with 6 callouts pointing at recent features: Progress widgets, Schedule filter strip, PRD by PM cards, Risk chips, Show Actual toggle, Plan vs Actual columns.
- Auto-shown on first visit; persisted via localStorage key `esl-tour-seen`. `?` button re-opens any time.
- Implementation: `TOUR_STEPS` array → `runTour()` initializes; `renderTourStep()` builds one step at a time. Each step calls `target.scrollIntoView({block:'center'})`, then renders a spotlight rectangle (CSS `box-shadow:0 0 0 9999px rgba(0,0,0,0.65)` trick — dims everything except the highlighted target) + a single floating `.tour-label-seq` panel near the target (auto-positioned below/above based on viewport space). Footer of the panel: Step X/N counter, Prev/Next/Done buttons; top-right Skip ✕ button.
- Body scroll locked during a step; unlocked briefly during `scrollIntoView`. Keyboard: `→`/Enter advances, `←` goes back, Esc closes.
- Note: an earlier implementation tried to show all 6 callouts at once with curved SVG arrows — it didn't work because labels overlapped on smaller viewports and the dim layer blocked page scroll. Sequential mode replaced it.
- Filter logic: all four filters combined with AND in `renderTimeline()`
- When a team is selected, Alloc/Status columns are shown (showExtra flag)

### Name Shortening
- Lead/PM columns show first name only: `t.pm.split(',')[0].trim().split(/\s+/)[0]`
- Full name shown in hover tooltip

### Task Name Cell
- 2-line wrap via inner `<span class="task-name-wrap">` — `display:-webkit-box`, `-webkit-line-clamp:2`, `max-width:260px`, `word-break:break-word`
- **Important**: `max-width` on `<td>` in a table with `auto` layout doesn't work — must apply to an inner element
- `td.task-name-cell`: `white-space:normal`, `overflow-wrap:break-word`, `line-height:1.35`

### Schedule Badge (`buildScheduleBadge`)
| Condition | Badge |
|-----------|-------|
| `notionEnd` exists | Compare notionEnd vs end (±3 day tolerance): Behind / On Track / Ahead |
| `notionStart` exists, no `notionEnd` | On Track (task has started) |
| No notionStart/notionEnd + `start` < today | Behind (planned start passed, not started) |
| Otherwise | — |
- Tooltip: "based on Jira actual dates (synced via Notion). If started: compares actual end vs planned end (±3 day tolerance). If not started: Behind when planned start date has passed."

### Tooltip
- Fields: lead, allocation, headcount, **Plan Start / Plan End** (always), **Actual Start / Actual End** (only when present), Ideal, effort, risk, PM, PMO, PRD, status, blocking, blockedBy, note
- Plan Start/End rows always render (`-` when missing). Actual Start/End rows are conditional on `d.notionStart` / `d.notionEnd` being non-empty — keeps tooltip compact for not-yet-started tasks. Tooltip shows actuals regardless of `Show Actual` toggle state (safety net).
- **Size**: max-width 300px, padding 10px 12px, font-size 12px
- **Smart positioning**: flips up/left automatically when near viewport edges
  ```javascript
  if (left + ttW > window.innerWidth  - 8) left = e.clientX - ttW - 16;
  if (top  + ttH > window.innerHeight - 8) top  = e.clientY - ttH - 10;
  ```
- **Hover behavior (두 가지)**:
  - task name 셀 (`td.task-name-cell`): 브라우저 기본 `title` 툴팁만 표시, 커스텀 다크박스 없음. `onNameCell=true` 플래그로 full tooltip 완전 차단
  - 나머지 셀: 3초 후 `showRowTooltip(row)` 전체 상세 표시
  - name cell mouseleave 시 3s 타이머 재시작 (다른 셀로 이동해도 full tooltip 작동)
  - `showRowTooltip(row)` — tooltip HTML 빌드 로직을 별도 함수로 분리 (중복 제거)
- Column header tooltips:
  - Schedule: Jira actual dates via Notion, not Notion-only
  - Priority: P0/P1/P2 only (Low removed)
  - Task: "Task name from Jira → Notion — synced via Realistic Scenario sheet"

### Dependency Arrows (drawDependencies)
- Uses Notion blocking/blockedBy fields
- Amber dashed bezier curves + arrow markers
- **Bidirectional**: iterates both `t.blocking` (this blocks others) AND `t.blockedBy` (others block this)
- `arrowSet` object deduplicates — same arrow not drawn twice even if both directions are populated
- `drawArrow(fromKey, fromTask, toKey, toTask, arrowSet)` helper function
- Arrow only draws if both tasks have start/end dates (no dates = no Gantt bar = no position to draw from)

### Gantt
- **At-risk rows**: highlighted red when end > ideal date
- **Today line**: red vertical line
- **Bar click**: if `epicUrl` exists, `window.open(epicUrl, '_blank')` — cursor:pointer, title "Open in Jira"
- **Status dot**: in gantt-col, position:absolute left:6px, shows status name on hover
- **TIMELINE_END**: `new Date('2026-10-31')`

### Team Header
- Background: `--bg-card` (darker than task rows), `border-left: 3px solid teamColor`, text in team color
- `hexAlpha(hex, a)` helper converts hex → `rgba(r,g,b,a)` (available but not used on header bg)

### Column Header (th)
- `border-top-left-radius: 12px` on first th, `border-top-right-radius: 12px` on `th.gantt-col` — matches container border-radius
- `border-bottom: 2px solid var(--border-mid)` to visually separate header from rows

### Collapsible Columns
- Click th to toggle hide/show — PRI, TASK, Gantt are fixed; all others collapsible
- `hiddenCols = new Set()` global — persists across re-renders
- Collapsed: `width:10px`, `overflow:hidden`, `padding:0`, narrow grey strip
- `toggleCol(col)`, `applyHiddenCols()`, `attachColToggle()` functions
- `attachColToggle()` + `applyHiddenCols()` called after every `renderTimeline()`
- ℹ button click does NOT trigger collapse (`e.target.closest('.col-info')` guard)

---

## Team Colors
```
CALL:#3b82f6  SDK:#8b5cf6  CHAT:#10b981  API:#f97316
Email:#06b6d4  AGX:#ec4899  DATA:#a3e635
```

---

## Known Bugs & Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `SyntaxError: unexpected token` | U+2028/2029 characters in Notion text | 4-way escaping in webApp.gs |
| Spinner only, never loads | Static `<svg>` tag conflicts with HtmlService parsing | Generate SVG via JS |
| Some teams not showing | Team name case mismatch | `getTeamKey()` + `TEAM_ALIASES` |
| Email team filter broken | epicPrefix "ESC" not in TEAM_ORDER | Add `ESC→Email` to EPIC_TEAM_MAP |
| WEB-XXX shows as Other | epicPrefix "WEB" not mapped | Add `web→SDK` to TEAM_ALIASES |
| Dependency arrows not drawn | blocking value is "Task Name (https://...)" format | parseEpicList strips URL via regex |
| Rows without Epic URL missing | Join was epicUrl-only | Added byName fallback |
| #N/A rows showing | Formula errors remain in deleted rows | `task.startsWith('#')` filter |
| PRD `-` tasks in alert | isPrdDone treated `-` as incomplete | Exclude when prd==='-' |
| Tooltip cut off at edge | Used fixed offset only | Check viewport bounds, flip up/left |
| PRD banner invisible in light mode | Amber too faint on light background | light-mode CSS orange override |
| ALL_TASKS inaccessible in console | HtmlService iframe sandbox | Use `?debug=1` endpoint |
| Strategic / PRD not syncing | Field type is select or checkbox (not always text) | `notionCheckboxOrSelect_()` + `notionTextOrSelect_()` |
| Same row overwritten by 2 Notion pages | Two pages sharing same JIRA URL | `claimedRows` guard in sync loop |
| removeDuplicateRows hangs | `deleteRow()` loop (1 API call per row) | Batch: `setValues(kept)` + single `deleteRows()` |
| Sheet not reflecting Notion changes | Checked sheet before running sync after Notion edit | Always run sync after making Notion changes |
| compareNotionVsSheets hangs/slow | Per-row `setBackground()` calls (1 Sheets API call per row) | Batch: `getRange(...).setBackgrounds(bgColors)` single call |
| Status pill highlight not updating on click | `buildSummary()` returns new DOM node, doesn't replace existing | Call `renderAll(null)` instead — full re-render clears+rebuilds root |
| Task started but shows Behind | `buildScheduleBadge` only checked `start < today` without checking `notionStart` | Added `if (t.notionStart) return On Track` before Behind check |
| Task name not wrapping to 2 lines | `max-width` on `<td>` ignored in table auto-layout — cell expands horizontally | Use inner `<span class="task-name-wrap">` with `max-width` + `-webkit-line-clamp:2` |
| Dependency arrows not drawing | Task has `blockedBy` but blocker's `blocking` field empty (one-directional Notion relation) | `drawDependencies` now iterates both `t.blocking` and `t.blockedBy`; `arrowSet` prevents double-draw |
| Team header / task row look same | Both using `--bg-card` | Task rows → `--bg-elevated`; team header → `--bg-card` (light mode: reversed) |
| Task name hover shows full detail immediately | Task name cell used same `showRowTooltip` with 400ms delay | `onNameCell` flag blocks full tooltip; name cell uses browser native `title` tooltip only |
| setupDailyTrigger shows spinner forever | `getUi().alert()` pops up on spreadsheet tab, not editor tab | Normal — check spreadsheet tab for the alert popup |

---

## syncNotionToSheets.gs — Menu Functions (as of 2026-04-27)

| Menu Item | Function | Notes |
|-----------|----------|-------|
| Run Sync Now | `runSyncWithAlert` | Clear+dump sync, alert on complete |
| Compare Notion vs Sheets | `compareNotionVsSheets` | Writes diff to "Notion_diff" tab (overwrites each run) |
| Ensure Overall Anchors | `ensureOverallAnchors` | Appends missing jira_urls to Overall (also auto-called at end of every sync) |
| Remove Duplicate Rows | `removeDuplicateRows` | Manual dedup tool. Rarely needed under clear+dump. |
| Set Up Daily Auto-Sync | `setupDailyTrigger` | Runs sync daily at 7AM |
| Remove Auto-Sync | `removeDailyTrigger` | Removes trigger |

**Diagnostic functions** (run from editor, not menu):
- `diagnosePage()` — logs all Notion properties for a specific JIRA URL
- `testSyncNotionToSheets()` — runs sync with extra logging + sheet preview

---

## Repo / Workflow

- **GitHub**: `github.com/abigailkang-ujet/esl-timeline` (initialized 2026-04-23, single `main` branch, solo repo).
- **Docs layout**: design specs live under `docs/superpowers/specs/`, implementation plans under `docs/superpowers/plans/` (both committed to main).
- **Deploy**: git commit ≠ live. After merging to `main`, manually paste changed files into the Apps Script editor and use **Deploy → Manage deployments → Edit → New version** to preserve the URL.
- **No test framework**. Verification is static (grep/read) + post-deploy visual checks.

## Current Status (2026-04-27)

- 7 teams (CALL, SDK, CHAT, API, Email, AGX, DATA), ADX removed
- **Refactor complete** — Sheets schema fully on jira_url PK; `syncNotionToSheets.gs` simplified to clear+dump (787 lines, was 933)
- Notion_raw: ~37 data rows, header at row 1, jira_url at col J, Notion_ID at col T
- Known: Chat Orchestration has 2 Notion pages with same JIRA URL → both rows now appear in Notion_raw (Overall's XLOOKUP picks first match)
- **Daily auto-sync trigger active** — runs `syncNotionToSheets` (clear+dump + ensureOverallAnchors) every day at 7AM
- **index.html deployed (2026-04-27 evening)** — UI polish round: glass cards (backdrop-filter blur), Status/Schedule pill hover affordance, PRD Needed regrouped into collapsible per-PM cards (numbered items, Jira-clickable keys), Risk column rendered as H/M/L color chips that expand to full word on hover, header subtitle shrunk + "& Notion" added. Earlier today: Schedule strip, Program Weeks Elapsed/Total, widget X/Y format.
- **webApp.gs deployed (2026-04-27)** — local + main + live now in sync
- syncNotionToSheets.gs: deployed and validated — 3 tests passed (manual anchor run, full sync, anchor recreation), Notion_raw row reorder doesn't break Overall
