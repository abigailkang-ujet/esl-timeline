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
- **Jira REST search**: Atlassian sunset GET `/rest/api/3/search` on 2025-05-01. Use POST `/rest/api/3/search/jql` with a JSON body (`fields` is now an array, not a comma-separated string). The deprecated GET form returns HTTP 410.

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
Jira REST (status / customfield_11014 / duedate) ──→ webApp.gs override (5-min cache, 2026-05-06)
                                                                      ↓
                                                              index.html (serves Gantt)
```

All joins are by `jira_url`. Row order in any tab is irrelevant — manual data is anchored by PK.

**Live Jira override (2026-05-06; expanded 2026-05-07)**: `webApp.gs` calls Jira REST at render time (cached 5 min via `CacheService`) to refresh `t.status`, `t.actualStart`, `t.actualEnd`, plus `t.statusChangedAt` / `t.resolvedAt` (status-fallback timestamps for the Gantt bar) and `t.blocking` / `t.blockedBy` / `t.relates` (parsed from `issuelinks` for the dependency arrows). Every other field still flows through the Notion → Sheets daily path. Failure of the Jira fetch (no token, non-200, throw) returns an empty map; tasks fall back to their Notion-synced values without an exception (Relates simply stays empty since Notion has no equivalent). Token lives in Apps Script Script Properties under key `jiraToken`. Specs: `docs/superpowers/specs/2026-05-06-jira-live-sync-design.md`, `2026-05-07-jira-issuelinks-dependencies-design.md`.

---

## Spreadsheet Info

- **Spreadsheet ID**: `1s_AGnjgrSc_UtrVBRVHORlV_V9NpocKt15EpJaxmXpw`
- **URL**: https://docs.google.com/spreadsheets/d/1s_AGnjgrSc_UtrVBRVHORlV_V9NpocKt15EpJaxmXpw/edit
- **Key tabs**:
  - `Notion_raw` (sync target, jira_url PK at col J)
  - `Overall` (derived, jira_url PK at col A; M cols cover manual + scenario effort)
  - `Optimistic Scenario - Tasks Details (S1)` — per-task O start/end/effort
  - `Realistic Scenario - Tasks Details (S2)` — canonical source for non-date fields
  - `Pessimistic Scenario - Tasks Details (S3)` — per-task P start/end/effort
  - `Engineers`
  - All three scenario tabs share identical column layout (B=Epic URL, H=Start, I=End, K=Scenario Estimated Effort). webApp.gs reads them by COLUMN POSITION, not header name — header text drift between tabs was silently zeroing efforts and hiding bars (bug found 2026-05-19).

## Notion DB Info

- **DB ID**: `33b5bd55-7775-8190-9e38-fa14f6b29411`
- **notionToken**: stored in Script Properties under key `notionToken`

## Apps Script Deployment

- **Live URL**: https://script.google.com/a/macros/ujet.cx/s/AKfycbzFRDFEpOfH47DNCXgf1hruIzrI-B951nYqFj_6I-7_9cQHEJMQkt8TnZuFrns9a4sD/exec
- **Access**: Anyone (no auth)
- **Code changes** → redeploy required (Deploy → Manage → New version)
- **Data changes** (Sheets only) → no redeploy needed, just refresh the page

---

## File Status (as of 2026-05-20)

| File | Status | Description |
|------|--------|-------------|
| `webApp.gs` | ✅ Deployed | 3-scenario read (S1/S2/S3 sibling tabs, position-based column read), Jira live sync (status/start/end/T-shirt/issuelinks), `pushIdealToJira()` write-back, `postJiraCommentFromUI()` callable via google.script.run, `compareSizesNotionVsJira()` diff tool, Late-reason comment fetcher (parallel, cached) |
| `index.html` | ✅ Deployed | Late reason modal + tooltip (overrun-bar click/hover), T-shirt Size column (blue chip family, format-tolerant), Scenario multi-select toggle (stacked 4-lane Gantt + letter badges + hover labels), default sort = plan start within team, glass cards, pill hover, PRD PM-grouped cards, Risk H/M/L chips, Schedule strip, Program Weeks Elapsed/Total |
| `syncNotionToSheets.gs` | ✅ Active | Clear+dump strategy, jira_url as PK, `ensureOverallAnchors()` auto-append, "Jira Push" menu (Push Ideal → Jira Committed Date + Compare Sizes: Notion vs Jira) |
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
- **Row background (2026-04-29 polish pass, follow-up)**: task rows AND team headers share the same bg now — `--bg-elevated` in dark, `--bg-card` in light. Team headers used to be slightly off-tone so they read as a horizontal "band"; uniform bg removes the band, and team identity is carried by the colored left border + colored text only.
- **Gantt bar**: height 10px, border-radius 10px, opacity 0.8
- **Flat cards (2026-04-29 polish pass — replaced earlier glassmorphism)**: `.summary-card` and `.prd-pm-card` use solid `var(--bg-card)` + `var(--border)` + soft shadow. No `backdrop-filter`. Hover gives an amber-tinted ring (`rgba(229,164,75,0.35)`) + warm glow + 1px lift. Light-mode `--bg-card` is `#ffffff` so cards read clearly against the page bg. Spec: `docs/superpowers/specs/2026-04-29-polish-pass-design.md`.
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
  - **Label typography (2026-04-29 polish pass)**: card labels render UPPERCASE with `letter-spacing: 0.06em`, `font-weight: 600`, `font-size: 11px`, `margin-top: 8px` — matches the existing micro-label style of the Status / Schedule strip headers. Big number above uses `letter-spacing: -0.02em` (relaxed from -0.03em).
  - PRD Alert (banner below): counts missing + todo + draft + review (done/na excluded). Unrelated to the PRD summary card.
  - Helpers live next to `getPrdState()`: `isClosed`, `prdIsDone`, `prdIsRequired`, `programSpanWeeks`.
- **Status strip** (below Row 1): dynamic pill cards per status
  - 16px bold number + 11px label, bg-elevated background + border
  - STATUS_ORDER: `['To Do', 'Untriaged', 'In Progress', 'Closed']`
  - **Clickable**: clicking a pill sets `activeStatus` and calls `renderAll(null)` to filter timeline
  - Active pill: colored border + tinted background highlight
  - Click same pill again → deselects (back to ALL)
- **Schedule strip (2026-04-27)** (below Status strip): same pattern, filter by Schedule status
  - SCHEDULE_ORDER: `['On Track', 'Behind', 'Ahead', 'Done', '—']` (Done added 2026-05-06)
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

**PRD badge is clickable (2026-05-06)**: states with a `t.prdUrl` (`done`, `draft`, `review`, `todo`) are wrapped in `<a class="prd-badge-link" target="_blank">` opening the PRD page. `missing` and `na` and any task without a recorded `prdUrl` stay as plain spans. Helper: `wrapPrdLink(badgeHtml, prdUrl)` — pass any badge, it returns the original HTML when prdUrl is empty. Used in both the PRD column and the PRD Needed alert items.

### PRD Alert Banner (rewritten 2026-04-27)
- **Layout**: per-PM collapsible cards (`.prd-pm-card`) — header click toggles `.collapsed` class
  - Header: `▼` toggle + PM first/last name + count chip (right-aligned)
  - Body: `<ol>` with items numbered 1, 2, 3
- **Item rendering** per task:
  - `[JIRA-KEY]` (clickable, opens Jira in new tab if `t.epicUrl` exists)
  - Task name
  - PRD state badge (reuses existing `.prd-badge` + `.prd-missing/.prd-draft/.prd-review/.prd-todo`) — wrapped in a `.prd-badge-link` anchor when the task has a `t.prdUrl` (2026-05-06)
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

### Scenario Toggle (2026-05-19) — multi-select
Located in ctrlRow2 (second control row), next to Search.

- **State**: `selectedScenarios` (array; at least one always selected). Persists to `localStorage['esl-scenarios']` as JSON array; migrates legacy `'esl-scenario'` string key on first load.
- **Primary scenario** (drives Schedule chip, Past Ideal Date, at-risk hatching, t.start/t.end): `primaryScenario()` returns Realistic if it's selected, else the first selected.
- **Single selected** → existing single-bar rendering (plan/actual/overrun split, hatching, all rich behavior).
- **2+ selected** → stacked 4-lane Gantt:
  - Optimistic (top, opacity 0.6, team color) — letter badge `O`
  - Realistic (middle, opacity 0.95, team color) — letter badge `R`
  - Pessimist (bottom of plan trio, opacity 0.6, team color) — letter badge `P`
  - Actual (lowest lane, slate `#475569` / light `#64748b`, team-color-distinct) — letter badge `A` (amber bg)
  - Each bar expands to 13px on hover with inline `<span class="bar-label">` showing scenario name + date range.
  - Letter badges have z-index 11 so they remain visible above any hovered bar.
- **Data flow**: each task carries `t.optimistic / t.realistic / t.pessimist` objects (`{start, end, effort}`) from the server. `applyScenarios()` mutates `t.start / t.end / t.scenarioEffort` to the primary scenario at toggle time.
- **Resilience**: scenario tabs read by COLUMN POSITION (not header name). `resolveScenario_()` falls back to Realistic's start and recomputes end from `start + effort*7` when a scenario tab has empty H/I.

### Default sort (2026-05-19)
`activeSort` initial value changed from `'default'` (sheet row order) to `'start'` — tasks within each team sort by plan start ASC on first load. flatView still defaults to false so teams stay grouped.

### T-shirt Size column (2026-05-20)
New column "Size" between Risk and Plan Start.

- **Data source**: Jira `customfield_11190` (T-shirt size estimation). Fetched live via `fetchJiraLive` (5-min cache). Falls back to Notion `Eng Size` if the Jira customfield is empty for that task.
- **Visual**: blue chip family — distinct from Risk's red/amber/green so the two columns never visually collide.
  - `S` = lightest blue, `M`, `L`, `XL` = progressively deeper blue
  - Light-mode overrides darken the color so contrast holds on white
- **Hover**: letter expands to full word (`Small / Medium / Large / Extra Large`) — mirrors the Risk chip pattern.
- **Format tolerance**: `buildTshirtBadge(size)` recognizes bare letters (`S`), full words (`Small`), and Jira's `"L - Large"` / `"XL - Extra Large"` select-list format. XL is checked first so `X-Large` doesn't get caught by the bare-L branch.
- Collapsible column (`data-col="size"`).

### Late-reason comments → Jira (2026-05-20)
Late-task (overrun / red-hatched Gantt segment) gets a click + hover affordance for posting and reading reasons as Jira comments.

- **Click overrun bar** → opens modal:
  - First time: prompts for the user's name, stores it in localStorage `'esl-author-name'`
  - Reason textarea, Post / Cancel buttons, status line
  - Submitted body format: `Late reason — [Name] reason text` (the "Late reason —" prefix so the Jira comment reads sensibly out of timeline context)
- **Hover overrun bar (250ms delay)** → custom floating tooltip:
  - Header line: `Late · plan {end} → actual {end}` (red, uppercase)
  - Comments list (author · date / body) — only comments matching our convention (`Late reason —…` or legacy `[…`) are surfaced; unrelated Jira chatter stays out
  - Empty state when no reasons logged yet
  - Hint: "Click bar to add reason"
- **Submission path**: `google.script.run.postJiraCommentFromUI(jiraKey, text)` calls server-side, which POSTs ADF body to `/rest/api/3/issue/{key}/comment`. Returns `{ ok, id, key, comment }`. Returned `comment` is optimistically appended to `ALL_TASKS[i].lateComments` so the next hover reflects the new entry without waiting for the 5-min server cache to expire.
- **Why `google.script.run` and not fetch**: Apps Script webapps render in a sandbox iframe on a different origin, so `fetch(window.location)` hits the sandbox and gets the HTML page back instead of JSON. `google.script.run` is the supported RPC channel.
- **Reading existing comments**: `fetchLateCommentsFromJira_(jiraKeys)` parallel-fetches `/comment` for tasks whose actual end is past plan end (overrun), filters to our late-reason convention, caches 5 min via CacheService. `postJiraCommentFromUI` invalidates that cache on success.
- **Search**: text input in ctrlRow — filters by task name + JIRA key (case-insensitive)
- **Deps**: toggle on same row as PM dropdown (ctrlRow)
- **Show Actual (2026-04-28; scope narrowed 2026-05-07)**: toggle next to Deps. `showActual` global, persisted in localStorage `esl-show-actual`. When ON, two extra columns `Act Start` / `Act End` appear between `Plan End` and `Ideal`, sourced from `t.actualStart` / `t.actualEnd` (Jira REST direct, Notion-synced fallback). **Toggle controls the columns only — the Gantt bar's dual-bar treatment now renders independently whenever effective actual data exists** (see Gantt section below).

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
- **Hover (2026-05-07)**: on `td.task-name-cell:hover` the wrap drops the line-clamp (`display:block; -webkit-line-clamp:unset; overflow:visible`) and the full task name renders in place — no separate tooltip. The cell grows vertically; the row reflows. Mirrors the status-dot / bar-hover expand-in-place pattern. The earlier JS handler that flew an `[Epic] task` mini-tooltip out of the cursor is gone; only the `onNameCell` flag remains so the row tooltip is suppressed while the cursor is on the name cell.

### Schedule Badge (`buildScheduleBadge`) — status-driven (2026-04-30)
**Branching is keyed on `t.status`, NOT on the presence of `actualStart` / `actualEnd`.** Earlier logic trusted those fields as "actual" indicators, but Jira/Notion's "Start-End Date" property can carry target dates for not-yet-started tickets and stale dates after a status revert. Reading status first prevents To Do tickets from being misclassified as Ahead/Behind.

| `t.status` | Logic |
|------------|-------|
| `Closed` / `Done` / `Complete` (case-insensitive) | Compare `actualEnd` vs `t.end` (±3 day tolerance): Behind / On Track / Ahead. If either date is missing → `Done` (neutral grey pill — task is closed, on-time/late can't be judged). |
| `In Progress` (exact, lowercase compare) | `On Track` always (we can't compare ends yet). Per-task hover surfaces start-vs-plan delta when `actualStart` differs from `t.start` (any non-zero day count, not the ±3 tolerance). |
| Anything else (To Do, Untriaged, Blocked, blank) | `Behind` when `t.start` < today, otherwise `—`. Notion dates are deliberately ignored in this branch. |

- Per-task hover (`title` on the chip) explains the specific reason in concrete dates and day counts. Generic rule recap lives on the column header `tip()`.
- Both functions to update together: `getScheduleStatus(t)` and `explainSchedule(t, s)`.

### Tooltip (slimmed 2026-05-07)
- **Row tooltip fields (final)**: task title, **Allocation**, **Effort**, **Blocking**, **Blocked by**. Everything else (Lead, dates, Ideal, Risk, Schedule, Status, PM, PMO, PRD) is already visible elsewhere on the row — column, team header, schedule chip, status dot, PRD badge, or bar hover label — so duplicating it here would just be noise.
- **Delay**: 8 seconds (`8000ms`). Two timer paths now both at 8000: the row `mouseenter` initial timer, and the name-cell `mouseleave` restart. User-facing rationale is "deliberate hover" — brief mouse passes during scanning don't pop the tooltip.
- **Size**: max-width 300px, padding 10px 12px, font-size 12px.
- **Smart positioning**: flips up/left automatically when near viewport edges
  ```javascript
  if (left + ttW > window.innerWidth  - 8) left = e.clientX - ttW - 16;
  if (top  + ttH > window.innerHeight - 8) top  = e.clientY - ttH - 10;
  ```
- **Hover patterns now expand inline, not via JS tooltip** (project convention as of 2026-05-07): status dot, bar segments, and task name cell all use CSS `:hover` to expand in place. Only the slim row tooltip still uses the JS positioned-by-cursor flow. Don't reintroduce JS-driven floating tooltips for new affordances; reach for `:hover` + display/size/opacity transitions on the existing element first.
- Column header tooltips:
  - Schedule: Jira actual dates via Notion, not Notion-only
  - Priority: P0/P1/P2 only (Low removed)
  - Task: "Task name from Jira → Notion — synced via Realistic Scenario sheet"

### Dependency Arrows (drawDependencies) — two link types (2026-05-07)
- **Source**: Jira `issuelinks` via `fetchJiraLive` (5-min cache). Notion-synced `t.blocking` / `t.blockedBy` remain as the graceful fallback if Jira fetch fails. `t.relates` is Jira-only — Notion has no Relates relation.
- **Two link types rendered**:
  - **Blocks** (directional, `t.blocking[]` / `t.blockedBy[]`) — amber dashed bezier `#e5a44b`, dasharray `5 3`, width 1.5, arrowhead via `marker-end`. Goes from source-task bar end → target-task bar start.
  - **Relates** (bidirectional, `t.relates[]`) — blue dotted bezier `#5b8af5`, **stroke-linecap round** with dasharray `0.1 5` (renders as crisp circular dots, diameter = stroke-width), width 1.8, opacity 0.95, **no arrowhead**. Anchored at each task's plan start (left edge of the bar). Earlier spec used `dasharray '1 3'` / width 1.2 / opacity 0.7 — too faint on the live chart, bumped 2026-05-07.
- Other Jira link types (Cloners, Duplicate, Causes, etc.) are parsed and ignored — only Blocks and Relates render.
- **Dedup**: `arrowSet` for Blocks (`'A->B'` key, both halves of a Blocks pair populate independently in Jira); `relatesSet` for Relates (canonical sorted-pair key `'min<->max'`, since Relates is bidirectional and both ends record the link). Pairs already drawn as Blocks skip the Relates draw — Blocks is the more specific signal.
- **Self-link guard**: `t.relates` entries equal to `t.epic` are skipped.
- **Hover tooltip**: each `<path>` has an SVG `<title>` child rendering the link type and the two Jira keys (`Blocks: A → B` / `Relates: A ↔ B`). Each path also gets `pointer-events: stroke` so the line itself is hit-testable; SVG container stays `pointer-events: none` so empty bezier areas pass clicks through to the table beneath.
- **Toggle**: `Show Dependencies` button covers both types together. Default OFF.
- **Helper**: `drawArrow(fromKey, fromTask, toKey, toTask, arrowSet)` (Blocks); `drawRelatesLink(taskA, taskB)` (Relates). Both bail out if either task is filtered out of view (rowMap miss) or missing the required date (Blocks: `fromTask.end` + `toTask.start`; Relates: both `start`s).

### Gantt
- **At-risk rows**: highlighted red when end > ideal date
- **Today line**: red vertical line
- **Grid lines (2026-04-29 polish pass, second iteration)**: body Gantt cells have **no vertical lines at all** — neither weekly nor month-boundary. Time anchoring is carried by the header dividers (`.gantt-week-label` / `.gantt-month-label` `border-right`) and the per-task date columns; the Today line still draws in red. The grid-line `forEach` loop in `buildTaskRow` is gone. `.grid-line-minor` and `.grid-line-major` CSS rules remain (dead code) for easy revert if a body line is ever wanted again.
- **Dual-bar (2026-05-07 spec)**: bar branches on whether *effective* actual data exists.
  - **Case 1 — plan only** (To Do / no fallback): single full-height `.gantt-bar` in team color, identical to legacy behaviour.
  - **Case 2/3 — half-split** (effective actual present): top half `.gantt-plan` (muted grey, team-agnostic), bottom half `.gantt-actual` (team color). When actual end > plan end, append `.gantt-overrun` continuing past plan-end with a soft red hatch (`var(--red)` palette, low contrast, no border).
  - **In Progress + no explicit `actualEnd`**: `.gantt-actual` adds class `in-progress-ongoing` — CSS `mask-image` fades the right edge so the endpoint reads as "ongoing, today as soft endpoint."
  - **Effective dates** via `effectiveActualStart(t)` / `effectiveActualEnd(t)`: explicit `t.actualStart` / `t.actualEnd` win first, then `t.statusChangedAt` (Jira `statuscategorychangedate`) for start when status is In Progress / Closed, then `t.resolvedAt` (Jira `resolutiondate`) for end when Closed, then today for end when In Progress.
  - All segments carry the same `onclick` → opens Jira. Row-level tooltip annotates fallback sources (e.g. `~5/15 (resolved)` when end came from `resolvedAt` rather than explicit `actualEnd`).
- **Bar click**: if `epicUrl` exists, `window.open(epicUrl, '_blank')` — cursor:pointer. Native `title` attr is gone; the inline `.bar-label` (see below) covers the visual hint.
- **Bar hover label (2026-05-07)**: each segment renders an inner `<span class="bar-label">` and grows vertically on hover (6→16px split, 10→18px single) to reveal the date string in white, e.g. `Plan: 4/16 → 5/28`, `Actual: 4/16 → today`, `Late: 5/28 → 6/15`. Built via `seg(left, width, extraStyle, klass, label)` helper. Plan segment darkens its grey bg on hover for white-text contrast; overrun drops the red hatch and switches to solid red on hover. **`overflow: hidden` was deliberately dropped** so labels on narrow bars extend past the bar edges; a strong text-shadow (`0 0 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.55)`) keeps the label readable wherever it lands.
- **Status dot (CSS expand 2026-05-07)**: in gantt-col, `position:absolute left:6px`, default 7×7 colored circle. On `:hover` the dot expands into a same-color pill (`width:auto; height:16px; border-radius:8px`) revealing the status text inside, like the Risk badge's letter→word swap. No JS tooltip — the dot itself is the affordance. Background color is set inline via `style="background:..."` based on `statusColor()`; the `.status-text` child fades in via opacity.
- **TIMELINE_END**: `new Date('2026-10-31')`

### Team Header
- Background: same as task rows (`--bg-elevated` dark / `--bg-card` light) — see "Row background" above. `border-left: 3px solid teamColor`, text in team color provide the only visual grouping cue.
- **Inline meta (2026-05-07; PMO added later same day)**: header reads `<TEAM> (count) · Lead: <names> · PM: <names> · PMO: <names>`. Lead, PM, and PMO were per-task columns or tooltip rows; they're identical across tasks within a team in our data, so consolidating saved 180 px of table width that the Gantt area now uses, and frees the slim row tooltip from carrying PMO. The `teamPeople(teamTasks)` helper deduplicates leads, pms, and pmos; `t.pm` and `t.pmo` are split on commas first (multi-owner tasks). Inconsistent values across tasks (rare data drift) are comma-joined so nothing is hidden. Empty Lead / PM / PMO omits the corresponding label.
- `team-count`, `team-people`, `team-people .role` CSS classes carry the visual styling — count and meta line are smaller / lighter than the team name, names use normal text-transform / letter-spacing (so proper nouns aren't UPPERCASED by the parent rule).
- Team-header `colspan` base value: `8` (was 10 before Lead/PM removal). `+2 if showExtra` (Alloc, Status under team filter) and `+2 if showActual` (Act Start, Act End) modifiers unchanged.
- `hexAlpha(hex, a)` helper converts hex → `rgba(r,g,b,a)` (available but not used on header bg)

### Column Header (th)
- `border-top-left-radius: 12px` on first th, `border-top-right-radius: 12px` on `th.gantt-col` — matches container border-radius
- `border-bottom: 1px solid var(--border)` (was 2px / `--border-mid`; softened in 2026-04-29 polish follow-up so the header-body boundary matches every other row separator)

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
| Task started but shows Behind | `buildScheduleBadge` only checked `start < today` without checking `actualStart` | Added `if (t.actualStart) return On Track` before Behind check |
| To Do task showing Ahead/Behind via end-date comparison | `getScheduleStatus` trusted `actualEnd` presence as "task finished" indicator, but Notion's Start-End Date can carry Jira target dates or stale post-revert data | Rewrote logic to branch on `t.status` first — only the Closed branch consults `actualEnd`; To Do/Untriaged/Blocked ignore notion dates entirely (2026-04-30) |
| Task name not wrapping to 2 lines | `max-width` on `<td>` ignored in table auto-layout — cell expands horizontally | Use inner `<span class="task-name-wrap">` with `max-width` + `-webkit-line-clamp:2` |
| Dependency arrows not drawing | Task has `blockedBy` but blocker's `blocking` field empty (one-directional Notion relation) | `drawDependencies` now iterates both `t.blocking` and `t.blockedBy`; `arrowSet` prevents double-draw |
| Team header / task row look same | Both using `--bg-card` | Task rows → `--bg-elevated`; team header → `--bg-card` (light mode: reversed) |
| Task name hover shows full detail immediately | Task name cell used same `showRowTooltip` with 400ms delay | (2026-05-07) Replaced entirely: hover the cell drops the 2-line clamp via CSS so the full name expands in place; no separate tooltip. `onNameCell` flag still suppresses the slim row tooltip while the cursor is on the name cell. |
| Jira live-sync returning HTTP 410 (all tasks fall back to Notion) | Atlassian sunset GET `/rest/api/3/search` on 2025-05-01 | Migrate `fetchJiraLive` to POST `/rest/api/3/search/jql` with JSON body (`fields` is now an array, not a comma-separated string). |
| Bar hover date label clipped on narrow bars | `.gantt-bar` etc. had `overflow: hidden` so the centered `.bar-label` was cropped to the bar's width | Drop `overflow: hidden` on the bar segments; rely on stacked text-shadow (`0 0 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.55)`) so the label remains legible when it extends past the bar edges. |
| Relates link almost invisible on screen | Style 2 spec used `dasharray '1 3'` + `stroke-width 1.2` + `opacity 0.7` — dots too small and faint | (2026-05-07) Bumped to `stroke-width 1.8`, `stroke-linecap round`, `dasharray '0.1 5'` (round-capped circles), `opacity 0.95`. Still distinct from amber dashed Blocks. |
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

## Current Status (2026-05-20)

- 7 teams (CALL, SDK, CHAT, API, Email, AGX, DATA), ADX removed
- **jira_url PK refactor complete** — Sheets schema fully on jira_url PK; `syncNotionToSheets.gs` simplified to clear+dump
- Notion_raw: ~37 data rows, jira_url at col J, Notion_ID at col T
- **Daily auto-sync trigger active** — runs `syncNotionToSheets` every day at 7AM
- **3-scenario data plumbing** (2026-05-19): server reads Optimistic / Realistic / Pessimistic tabs by column position. Each task exposes `t.optimistic / t.realistic / t.pessimist` with `{start, end, effort}`.
- **Multi-scenario Gantt** (2026-05-19): multi-select toggle. Single-select = rich plan/actual rendering. 2+ selected = stacked 4-lane bars (O/R/P/A) with letter badges + hover labels. Actual lane in slate to stand out from team-coloured plan bars. Scenario default = Realistic only on every load (no localStorage restore).
- **Jira live override**: webApp.gs hits Jira REST at render time (5-min cache) for status / actualStart / actualEnd / statusChangedAt / resolvedAt / issuelinks (Blocks + Relates) / **T-shirt size (`customfield_11190`)**. Token in Script Properties as `jiraToken`.
- **Jira write-back** (2026-05-18): "Jira Push" menu pushes Sheet's `Ideal Delivery (due to SOW)` value into Jira's `customfield_11900` (Committed Date). Dry-run + confirm dialog gating.
- **T-shirt Size column** (2026-05-20): new Size column between Risk and Plan Start. Source = Jira customfield_11190, falls back to Notion Eng Size. Blue chip family (distinct from Risk red/amber/green). Format-tolerant normalizer handles bare letters, full words, and `"L - Large"` select-list format.
- **Late-reason → Jira comments** (2026-05-20): click red hatch on overrun bar → modal posts `Late reason — [Name] reason` as a Jira comment via `google.script.run.postJiraCommentFromUI`. Hover overrun bar → custom tooltip shows date + posted reasons (parallel-fetched, 5-min cache, filtered to our convention). Optimistic local update on submit; ESC closes; toast confirms.
- **Size diff tool** (2026-05-20): "Jira Push → Compare Sizes: Notion vs Jira" menu populates a colour-coded "Size_diff" tab with per-row status (MATCH / MISMATCH / ONLY_IN_NOTION / ONLY_IN_JIRA / JIRA_FETCH_FAILED / NO_JIRA_KEY).
- **Default sort** (2026-05-19): tasks sort by plan start ASC within each team on first load.
- **webApp.gs deployed (2026-04-27)** — local + main + live now in sync
- syncNotionToSheets.gs: deployed and validated — 3 tests passed (manual anchor run, full sync, anchor recreation), Notion_raw row reorder doesn't break Overall
