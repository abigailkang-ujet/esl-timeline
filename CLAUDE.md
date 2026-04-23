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

## Data Architecture

```
Jira (auto-sync) ──→ Notion "ESL Project list" DB
                              ↓ syncNotionToSheets.gs (manual or scheduled)
                      Google Sheets "Notion_raw" tab (columns A–S, JIRA = column J)
                              ↓
Google Sheets "Realistic Scenario - Tasks Details (S2)" ──→ webApp.gs (join on JIRA URL)
                                                                      ↓
                                                              index.html (serves Gantt)
```

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

## File Status (as of 2026-04-22)

| File | Status | Description |
|------|--------|-------------|
| `webApp.gs` | ✅ Modified locally, redeploy needed | Team resolution, Notion join, error filtering |
| `index.html` | ✅ Modified locally, redeploy needed | Schedule badge, PRD To Do, Status pill filter, shortName, task wrap fix, search, Gantt bar click, tooltip size/hover split |
| `syncNotionToSheets.gs` | ✅ Active, paste into Apps Script | In-place sync + compare (batch bg fix) + dedup + daily trigger |
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

## index.html Feature List (updated 2026-04-22+)

### UI / Theme
- **Dark/light mode**: toggle button top-right, saved to localStorage (`esl-theme`)
- **Inter font**: body font-size 15px
- **CSS Variables**: `:root` + `body.light-mode` override
- **Row background**: task rows `--bg-elevated`, team headers `--bg-card` (light mode: reversed — task rows `--bg-card`, team headers `--bg-elevated`)
- **Gantt bar**: height 10px, border-radius 10px, opacity 0.8

### Summary Cards (buildSummary)
- **Row 1** (6 cards): Total Tasks, P0 Tasks, Past Ideal Date, PRD Needed, Teams, Total Dev Weeks
  - Teams count: based on `TEAM_ORDER` only (excludes Other/removed teams)
  - PRD Needed: `t.pm && getPrdState(t.prd) === 'missing'` only (missing = empty/"No")
  - PRD Alert: counts missing + todo + draft + review (done/na excluded)
- **Status strip** (below Row 1): dynamic pill cards per status
  - 16px bold number + 11px label, bg-elevated background + border
  - STATUS_ORDER: `['To Do', 'Untriaged', 'In Progress', 'Closed']`
  - **Clickable**: clicking a pill sets `activeStatus` and calls `renderAll(null)` to filter timeline
  - Active pill: colored border + tinted background highlight
  - Click same pill again → deselects (back to ALL)

### PRD States (`getPrdState` function)
| Value | State | Badge | Included in PRD Alert? | PRD Needed card? |
|-------|-------|-------|------------------------|-----------------|
| `''` / `No` | `missing` | amber N | ✅ | ✅ |
| `-` | `na` | grey - | ❌ | ❌ |
| `Y` / `Yes` / `YES` | `done` | green ✓ | ❌ | ❌ |
| `Draft` | `draft` | amber Draft (0.75 opacity) | ✅ | ❌ |
| `In Review` / `Review` | `review` | blue Rev | ✅ | ❌ |
| `To Do` | `todo` | grey `.prd-todo` (`#64748b`/`#f1f5f9`) | ✅ | ❌ |

### PRD Alert Banner
- **Already started** section: tasks past start date with PRD not done — badge colors vary by state (red/amber/blue)
- **Starting within 3 weeks** section: upcoming tasks with PRD not done — amber
- Date calc: `businessDaysBetween(from, to)` (weekends excluded)
- Dark mode: amber tones, left 3px border (callout style)
- Light mode: orange tones (`#c2410c` title, `#92400e` items) — CSS override

### Legend + Timestamp
- Legend: 12px, text-secondary, 8px dot
- Legend + "Updated: ..." → single row (metaRow flex, space-between)

### Filters
- **Team**: buttons (based on TEAM_ORDER)
- **PM**: `<select>` dropdown (not buttons)
- **Status**: `activeStatus` variable — set by clicking Status strip pills
- **Search**: text input in ctrlRow — filters by task name + JIRA key (case-insensitive)
- **Deps**: toggle on same row as PM dropdown (ctrlRow)
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
- Fields: lead, allocation, headcount, start/end/ideal, effort, risk, PM, PMO, PRD, status, blocking, blockedBy, note
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

## syncNotionToSheets.gs — Menu Functions (as of 2026-04-21)

| Menu Item | Function | Notes |
|-----------|----------|-------|
| Run Sync Now | `runSyncWithAlert` | In-place update, toast progress, alert on complete |
| Compare Notion vs Sheets | `compareNotionVsSheets` | Writes diff to hidden "Notion_diff" tab (overwrites each run) |
| Remove Duplicate Rows | `removeDuplicateRows` | Batch dedup, try/catch + step toasts. Run once if needed. |
| Set Up Daily Auto-Sync | `setupDailyTrigger` | Runs sync daily at 7AM |
| Remove Auto-Sync | `removeDailyTrigger` | Removes trigger |

**Diagnostic functions** (run from editor, not menu):
- `diagnoseDoubleMatch()` — finds Notion pages that map to same sheet row
- `diagnosePage()` — logs all Notion properties for a specific JIRA URL

---

## Current Status (2026-04-22)

- 7 teams (CALL, SDK, CHAT, API, Email, AGX, DATA), ADX removed
- Sync confirmed working: 38 in-place updates, JIRA URL matching stable
- Notion_raw: 37 data rows, no duplicates
- Known: Chat Orchestration row 35 has 2 Notion pages with same JIRA URL → second is now skipped
- **Daily auto-sync trigger set** — runs `syncNotionToSheets` every day at 7AM
- **index.html modified locally (redeploy needed)** — task name wrap fix, tooltip size reduction, tooltip hover split (name-only instant vs 3s full detail)
- webApp.gs redeploy still pending (local changes not yet pushed to Apps Script)
- syncNotionToSheets.gs: fully operational, compareNotionVsSheets batch fix applied
