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

## Data Architecture (hybrid, refactored 2026-05-21)

```
Jira REST ──── fetchJiraLive (5-min cache) ──────────→ webApp.gs → index.html
               status, summary, dates, T-shirt,          ↑
               dependencies, statusChangedAt/resolvedAt   │
                                                          │
Notion API ── fetchNotionDirect (10-min cache) ──────────┘
               priority, PRD state, PM/PMO, strategic,
               comment, kickoff links, prelim date

Google Sheets scenario tabs ─────────────────────────────┘
               lead, allocation, risk, scenario dates/effort,
               ideal delivery, notes, release

Google Sheets Notion_raw (daily 7AM backup) ─── fallback when Notion API unavailable
```

All joins are by `jira_url`. Row order in any tab is irrelevant — manual data is anchored by PK.

**Data source priority per field** (2026-05-21):
- **Jira live (5-min cache)**: status, actualStart, actualEnd, statusChangedAt, resolvedAt, engSize (T-shirt), blocking, blockedBy, relates, summary → `t.requirement`
- **Notion direct (10-min cache)**: priority, PRD URL, strategic, PM/PMO owner, PM size, comment, prelim date, kickoff link/notes, team (fallback after epic prefix)
- **PRD document Status (2026-09-03, inside `fetchNotionDirect`)**: `t.prd` now comes from the **PRD document's own Notion `Status`** (Product Documents DB), reached by following `PRD URL` → `GET /v1/pages/{id}` in parallel (`fetchPrdDocStatuses_`). Mapped via `PRD_DOC_STATUS_MAP` (To Do→`To Do`, Draft→`Draft`, In Review→`In Review`, Approved/In Development/Delivered→`Yes`; Canceled unmapped). The hand-typed `PRD (Done? Y/N)` column is now only a **fallback** — used when the PRD URL is non-Notion (Confluence), points at a database view (`?v=`), the integration lacks page access, or the status is unmapped. Each task carries `prdSource` (`'doc'`|`'column'`), `prdDocStatus` (raw), `prdColumn` (original column value). `?debug=1` reports `prdDoc: {pages, ok, failed, mapped, unmapped, failures}`. Cache key bumped to `esl-notion-direct-v2`.
- **Sheets scenario tabs**: lead, allocation, headcount, risk, start/end (plan), effort, ideal delivery, notes, release, ccaipRelease
- **Fallback chain for Notion fields**: Notion API direct → Sheets Notion_raw tab (daily sync) → empty

**`fetchNotionDirect()` (2026-05-21)**: calls Notion API at render time (cached 10 min). Reuses `fetchAllNotionPages_`, `buildPageIdToJiraKeyMap_`, and all `notion*_` extractors from `syncNotionToSheets.gs`. Returns `{ byUrl, byName }` with identical entry shape to `buildNotionIndex()`. On failure (no token, HTTP error, throw) returns `null` → `buildNotionIndex(ss)` takes over as Sheets fallback. Debug endpoint (`?debug=1`) reports `notionSource: "api"` or `"sheets"`.

**`syncNotionToSheets.gs` daily sync continues** as backup: populates Notion_raw for XLOOKUP formulas in Overall/Realistic tabs, `ensureOverallAnchors()`, `compareSizesNotionVsJira()`, and as tertiary data fallback.

**Jira live (5-min cache)**: `fetchJiraLive` fetches status, summary, start/end dates, T-shirt size, statuscategorychangedate, resolutiondate, and issuelinks (Blocks + Relates). Tokens: `jiraToken` + `notionToken` in Script Properties.

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

- **Live URL**: https://script.google.com/a/macros/ujet.cx/s/AKfycbyWEzYulBTWKo-xeI31d1EHi2Wd44uLZfjbYpKZb6jeEwc1mb10druyfdfnVSbbPhXI/exec
- **Previous URL** (deleted from project 2026-05-26, unrecoverable): `AKfycbzFRDFEpOfH47DNCXgf1hruIzrI-B951nYqFj_6I-7_9cQHEJMQkt8TnZuFrns9a4sD` — replaced with the new deployment above. To prevent the URL from disappearing again, configure GAS Commander to **update an existing deployment ID** (Deploy → Manage → Edit existing) instead of creating "New deployment" each time.
- **Access**: Anyone (no auth)
- **Code changes** → redeploy required (Deploy → Manage → New version, on the SAME deployment ID — do NOT create a new deployment)
- **Data changes** (Sheets only) → no redeploy needed, just refresh the page

---

## File Status (as of 2026-05-26)

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
**Where `t.prd` comes from (2026-09-03)**: the PRD document's Notion `Status` when reachable (see Data Architecture → PRD document Status), else the hand-typed `PRD (Done? Y/N)` list column. Reason: the two drifted — list column said `Yes` while the PRD doc said `In Review`, and the doc is where PMs actually change state. The badge's hover `title` says which source produced it and shows the column value when it disagrees with the doc. `getPrdState()` itself is unchanged; it still classifies the canonical strings below.

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

### Jira Key column (2026-07-22)
New "Key" column between Pri and Task — always-visible Jira epic key, replacing the old hover-revealed `.task-jira-key` badge inside the task name cell (removed same day).

- **Rendering**: `.jira-key-chip` (monospace 10px, muted, bordered — same look as the old hover badge). Tasks with `t.epicUrl` render the chip as an `<a target="_blank">` opening Jira; tasks with a key but no URL render a plain span; pre-Jira placeholder tasks render `-`.
- **Sticky layout — offsets are DYNAMIC (2026-07-22, same day)**: three sticky columns — `.sticky-pri` (left 0), `.sticky-key`, `.sticky-task`. Key/Task `left` values are CSS vars (`--sticky-key-left` / `--sticky-task-left`) set by `syncStickyOffsets()`, which measures the rendered `th` widths after every render/column-toggle (called at the end of `applyHiddenCols()`), plus on window resize and `document.fonts.ready`. Hardcoded offsets were tried first and failed: table auto-layout treats `th width` as a hint, so the real column widths drifted and left a 16px gap between Key and Task through which the covered Plan Start column bled during horizontal scroll. Key cell horizontal padding tightened to 6px (`table.timeline td.sticky-key` — same specificity as the `td.info-col` padding rule, declared later so it wins).
- **Collapsible** (`data-col="jira"`): collapse/restore just re-runs `syncStickyOffsets()` via `applyHiddenCols()` — measured widths handle the 10px strip automatically.
- Team-header base colspan bumped 9 → 10.
- Search already matched `t.epic` before this column existed — no change needed.

### T-shirt Size column (2026-05-20)
New column "Size" between Risk and Plan Start.

- **Data source**: Jira `customfield_11190` (T-shirt size estimation). Fetched live via `fetchJiraLive` (5-min cache). Falls back to Notion `Eng Size` if the Jira customfield is empty for that task.
- **Visual**: blue chip family — distinct from Risk's red/amber/green so the two columns never visually collide.
  - `S` = lightest blue, `M`, `L`, `XL` = progressively deeper blue
  - Light-mode overrides darken the color so contrast holds on white
- **Hover**: letter expands to full word (`Small / Medium / Large / Extra Large`) — mirrors the Risk chip pattern.
- **Format tolerance**: `buildTshirtBadge(size)` recognizes bare letters (`S`), full words (`Small`), and Jira's `"L - Large"` / `"XL - Extra Large"` select-list format. XL is checked first so `X-Large` doesn't get caught by the bare-L branch.
- Collapsible column (`data-col="size"`).

### Late-reason comments → Jira (2026-05-20, expanded 2026-05-26)
Late-task (overrun / red-hatched Gantt segment) gets a click + hover affordance for posting and reading reasons as Jira comments.

- **Click overrun bar** → opens modal (view + add + edit + delete in one place, 2026-05-26):
  - First time: prompts for the user's name, stores it in localStorage `'esl-author-name'`
  - Existing comments listed at top of the modal. Own comments (matched on the `[Name]` tag against `esl-author-name`) get inline ✏️ / 🗑️ buttons; everyone else's stays read-only
  - ✏️ → inline textarea with Save / Cancel; saves via `editJiraCommentFromUI(key, id, text)` PUT, reapplying the same prefix
  - 🗑️ → `confirm('Delete this reason?')` → `deleteJiraCommentFromUI(key, id)` DELETE, optimistic local removal
  - Below: Add-new section with reason textarea + Post / Close buttons
  - Submitted body format: **`Note (late reason, etc) — [Name] reason text`** (soft "Note" header reads neutrally to whoever is assigned to the Jira ticket; parenthetical keeps intent explicit). Server filter recognizes all three historical formats — current `Note (late reason, etc) —`, prior `Late reason —`, oldest `[Author] …`
- **Hover overrun bar (250ms delay)** → custom floating tooltip (read-only):
  - Header line: `Late · plan {end} → actual {end}` (red, uppercase)
  - Comments list (author · date / body)
  - Empty state when no reasons logged yet
  - Hint: "Click bar to add reason"
- **Submission path**: `google.script.run.postJiraCommentFromUI / editJiraCommentFromUI / deleteJiraCommentFromUI` call server-side, which hits Jira REST `/rest/api/3/issue/{key}/comment[/{id}]`. POST/PUT use ADF body. All three invalidate the late-comments cache on success.
- **Why `google.script.run` and not fetch**: Apps Script webapps render in a sandbox iframe on a different origin, so `fetch(window.location)` hits the sandbox and gets the HTML page back instead of JSON. `google.script.run` is the supported RPC channel.
- **Reading existing comments**: `fetchLateCommentsFromJira_(jiraKeys)` parallel-fetches `/comment` for tasks whose overrun hatch renders. Cached 5 min via CacheService.
- **lateKeys criterion (widened 2026-05-26)** — matches the frontend's effective-actual-end hatch logic, three shapes:
  1. closed late          : `actualEnd > planEnd`
  2. closed late, no actualEnd : `resolvedAt > planEnd` (status Closed)
  3. **in progress past plan : `today > planEnd`** ← added 2026-05-26. Without this, equal-date tasks like PLAN 5/22 / ACTUAL 5/22 that are still In Progress (visual hatch reaches today) were silently excluded.
- **Filter (widened 2026-05-26)** — body must start with `Note (late reason, etc) —` / `Late reason —` / `[`, OR carry a `[Word…]` tag anywhere in the first 40 chars (safety net for ADF artifacts like mention/emoji prefixes). `extractAdfText_` also scrubs zero-width chars (U+200B-U+200D, U+FEFF) and non-breaking spaces — they survive `.trim()` and would silently shift a leading-prefix check off zero. Skipped comments now log `[late-comments] skipped (KEY/id): "…"` to Executions for future debugging.
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
- **Delay**: 3000ms (was `8000ms` until 2026-06-11). Two timer paths both at 3000: the row `mouseenter` initial timer, and the name-cell `mouseleave` restart. Dropped from the original 8s "deliberate hover" because the tooltip content is now small (Allocation + Effort only) and doesn't obscure other rows; 3s is a middle ground — 150ms was tried but felt too eager.
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
  - **Ongoing = any in-flight task with no recorded actualEnd** (2026-05-26; generalized 2026-06-01): `.gantt-actual` adds class `in-progress-ongoing` (gradient fade + "ongoing" label) whenever `!isClosed && !t.actualEnd`. Earlier this was gated on `status === 'in progress'` only; after the 2026-06-01 actualStart catch-all started rendering actual bars for Blocked / Late Start / On Hold / On Review tasks, those rendered hard-edged with literal date labels until this generalization landed. Class name kept (`in-progress-ongoing`) for CSS continuity but the semantics now cover all in-flight states.
  - **Effective dates** via `effectiveActualStart(t)` / `effectiveActualEnd(t)`:
    - **Start**: `t.actualStart` first; else `t.statusChangedAt` when status is In Progress / Closed.
    - **End (2026-05-26; generalized 2026-05-27; actualStart catch-all added 2026-06-01)**: branching order matters. (1) If status matches Closed/Done/Complete → return `t.actualEnd || t.resolvedAt || ''` (closed tasks own their dates). (2) Else if `t.actualStart` exists → return today (work has begun; covers Blocked / Late Start / On Hold / On Review / In Progress whose plan end is still in the future — without this branch the bar stops at planStart and the actual segment vanishes). (3) Else if `t.end` exists and `todayStr > t.end` → return today (catches tasks that never started but whose plan window has elapsed — stale-duedate case). (4) Else if status === 'in progress' → return today. (5) Else return `t.actualEnd || ''`. The 2026-06-01 branch (2) caught a Blocked AGX task with actualStart=5/6 but plan ending 6/15 that was rendering as plan-only.
  - All segments carry the same `onclick` → opens Jira. Row-level tooltip annotates fallback sources (e.g. `~5/15 (resolved)` when end came from `resolvedAt` rather than explicit `actualEnd`).
- **Bar click**: if `epicUrl` exists, `window.open(epicUrl, '_blank')` — cursor:pointer. Native `title` attr is gone; the inline `.bar-label` (see below) covers the visual hint.
- **Bar hover label (2026-05-07)**: each segment renders an inner `<span class="bar-label">` and grows vertically on hover (6→16px split, 10→18px single) to reveal the date string in white, e.g. `Plan: 4/16 → 5/28`, `Actual: 4/16 → today`, `Late: 5/28 → 6/15`. Built via `seg(left, width, extraStyle, klass, label)` helper. Plan segment darkens its grey bg on hover for white-text contrast; overrun drops the red hatch and switches to solid red on hover. **`overflow: hidden` was deliberately dropped** so labels on narrow bars extend past the bar edges; a strong text-shadow (`0 0 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.55)`) keeps the label readable wherever it lands.
- **Status dot (CSS expand 2026-05-07)**: in gantt-col, `position:absolute left:6px`, default 7×7 colored circle. On `:hover` the dot expands into a same-color pill (`width:auto; height:16px; border-radius:8px`) revealing the status text inside, like the Risk badge's letter→word swap. No JS tooltip — the dot itself is the affordance. Background color is set inline via `style="background:..."` based on `statusColor()`; the `.status-text` child fades in via opacity.
- **TIMELINE_END**: `new Date('2026-10-31')`

### Team Header
- Background: same as task rows (`--bg-elevated` dark / `--bg-card` light) — see "Row background" above. `border-left: 3px solid teamColor`, text in team color provide the only visual grouping cue.
- **Inline meta (2026-05-07; PMO added later same day)**: header reads `<TEAM> (count) · Lead: <names> · PM: <names> · PMO: <names>`. Lead, PM, and PMO were per-task columns or tooltip rows; they're identical across tasks within a team in our data, so consolidating saved 180 px of table width that the Gantt area now uses, and frees the slim row tooltip from carrying PMO. The `teamPeople(teamTasks)` helper deduplicates leads, pms, and pmos; `t.pm` and `t.pmo` are split on commas first (multi-owner tasks). Inconsistent values across tasks (rare data drift) are comma-joined so nothing is hidden. Empty Lead / PM / PMO omits the corresponding label.
- `team-count`, `team-people`, `team-people .role` CSS classes carry the visual styling — count and meta line are smaller / lighter than the team name, names use normal text-transform / letter-spacing (so proper nouns aren't UPPERCASED by the parent rule).
- Team-header `colspan` base value: `10` (8 after 2026-05-07 Lead/PM removal → 9 with the Size column 2026-05-20 → 10 with the Jira Key column 2026-07-22). `+2 if showExtra` (Alloc, Status under team filter) and `+2 if showActual` (Act Start, Act End) modifiers unchanged.
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
| Show Dependencies ON kills every row hover / bar label / status-dot expand | `#dep-svg` overlay (z-index:10, sized to full table) had no `pointer-events:none` on the container, so the SVG box itself intercepted pointer events on the table beneath. Earlier comment claimed "empty areas pass through" but that's not how the SVG CSS box behaves once it has explicit width/height. | (2026-05-27) `pointer-events:none` on the SVG container; inner hit paths keep `pointer-events:stroke` so dep-line `<title>` tooltips still work. |
| Blocked/Late-Start task with real actualStart shows plan-only bar | `effectiveActualEnd` had no branch for "non-closed task with actualStart but plan end still in the future" — fell through to `t.actualEnd \|\| ''` (empty) → `hasActual=false` → Case 1 (plan only) rendered. Hid the fact that work was already underway. | (2026-06-01) Added an early branch in `effectiveActualEnd`: any non-closed task with `t.actualStart` → end = today. Bar now correctly half-splits to show plan + actual segments. |
| Blocked task actual bar renders hard-edged with literal date label (no gradient) | `isOngoing` was gated on `status === 'in progress'` only. After the actualStart catch-all started rendering Blocked tasks' actual bars, those didn't get the in-progress-ongoing class so they lost the gradient fade + "ongoing" label. | (2026-06-01) `isOngoing = !isClosed && !t.actualEnd` (any in-flight task without a recorded actualEnd). CSS class name retained for continuity. |
| T-shirt "XS - Extra Small" select-list value rendered as raw gray text | `buildTshirtBadge` had no XS branch. XL regex required 'l' after 'x'; bare-S branch unreachable (charAt(0) was 'x'). Fell through to raw fallback. | (2026-06-01) Added XS as the first branch (checked before XL) + `tshirt-XS` CSS class (lightest blue of the family). |
| ESC-2629 stuck in PRD Needed despite being marked "None" in Jira | First wiring of `customfield_11089` checked for exact `value === 'None'`, but in this Jira config the "None" dropdown option clears the field — API returns null. Indistinguishable from "never set". | (2026-06-01) Treat null/empty/none all as 'na'. Safe because the field has a "Required" default that auto-populates new tickets; only explicitly None tickets land as null. To surface a ticket in PRD Needed, set Jira requirement to "Required" or "Optional". |
| Sticky Pri/Key/Task cells see-through on at-risk rows during horizontal scroll (covered columns' text bleeds through) | `.at-risk td.info-col` background was bare translucent `rgba(244,112,103,0.04)` — fine in normal flow, but a sticky cell floats OVER other columns, so any translucent bg shows them | (2026-07-22) Layer the tint over the opaque row bg: `linear-gradient(rgba(...), rgba(...)), var(--bg-elevated)`. Same visual, no transparency. |
| 16px gap between sticky Key and Task columns; underlying Plan Start digit peeks through while scrolled | Hardcoded sticky `left` offsets (42/134px) assumed `th width` is exact, but table auto-layout treats it as a hint — real rendered widths drift | (2026-07-22) `syncStickyOffsets()` measures rendered th widths after every render/toggle/resize/font-load and pins offsets via CSS vars `--sticky-key-left` / `--sticky-task-left`. Never hardcode sticky offsets in this table. |

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
- **Deploy**: git commit ≠ live. Three paths, in order of preference:
  1. **clasp direct (2026-07-22, verified)**: the deploy clone `~/Desktop/esl-timeline` holds `.clasp.json` (scriptId `1eBNrpBO…`; the main repo deliberately has none). `git pull origin main && clasp push -f && clasp deploy -i AKfycbyWEzYul… -d "…"`. The `-i` deployment ID is mandatory — it makes a New Version on the existing deployment and preserves the URL. The clone lags behind main, so always pull first (and push to GitHub before that). Full recipe in `.claude/commands/deploy.md`.
  2. GAS Commander "Deploy to Apps Script" button (pulls GitHub → pushes to Apps Script).
  3. Manual paste into the Apps Script editor + Deploy → Manage deployments → Edit → New version.
- **No test framework**, but there IS a local render harness for `index.html`: replace the `<?!= timelineData ?>` scriptlet with a sample `{tasks:[…], updatedAt:…}` JSON (python one-liner), serve the file over `python3 -m http.server` and open it in a browser. Caveat: `file://` pages don't execute scripts in the Claude browser pane — must serve over HTTP. Used 2026-07-22 to catch the sticky-offset gap before deploy.
- **Live-URL verification is human-only**: curl gets bounced to UJET SSO, and script.google.com is blocked in the Claude browser pane — after deploying, ask the user to refresh and eyeball.

## Current Status (2026-09-03)

- **PRD badge follows the PRD document** (2026-09-03): `fetchNotionDirect` now follows each task's `PRD URL`, reads the PRD page's `Status`, and overrides `t.prd`. The `PRD (Done? Y/N)` list column is fallback-only. Triggered by ESC-2962: PM set the PRD doc to In Review, list column still said Yes, badge showed a stale Draft — three different answers for one field. Hover on the badge now shows the source. Verify after deploy with `?debug=1` → `prdDoc.ok` should be > 0; if `failed === pages`, the Notion integration lacks access to the Product Documents DB (share the DB with the integration).
- **SessionStart hook** (2026-09-03): `.claude/hooks/check-behind-origin.sh` warns when the clone is behind origin/main. Added after a session opened on a clone 30 commits stale. Committed to the repo so it travels to every laptop.

- **Jira Key column** (2026-07-22): always-visible Key column between Pri and Task (sticky, collapsible, chip links to Jira). Replaces the hover-revealed `.task-jira-key` badge in the task name cell. Three sticky columns now: Pri 0/42px, Key 42/92px, Task 134px (52px when Key collapsed). Team-header base colspan 9 → 10.

- 7 teams (CALL, SDK, CHAT, API, Email, AGX, DATA), ADX removed
- **jira_url PK refactor complete** — Sheets schema fully on jira_url PK; `syncNotionToSheets.gs` simplified to clear+dump
- Notion_raw: ~37 data rows, jira_url at col J, Notion_ID at col T
- **Daily auto-sync trigger active** — runs `syncNotionToSheets` every day at 7AM
- **3-scenario data plumbing** (2026-05-19): server reads Optimistic / Realistic / Pessimistic tabs by column position. Each task exposes `t.optimistic / t.realistic / t.pessimist` with `{start, end, effort}`.
- **Multi-scenario Gantt** (2026-05-19): multi-select toggle. Single-select = rich plan/actual rendering. 2+ selected = stacked 4-lane bars (O/R/P/A) with letter badges + hover labels. Actual lane in slate to stand out from team-coloured plan bars. Scenario default = Realistic only on every load (no localStorage restore).
- **Jira live override**: webApp.gs hits Jira REST at render time (5-min cache) for status / actualStart / actualEnd / statusChangedAt / resolvedAt / issuelinks (Blocks + Relates) / **T-shirt size (`customfield_11190`)**. Token in Script Properties as `jiraToken`.
- **Jira write-back** (2026-05-18): "Jira Push" menu pushes Sheet's `Ideal Delivery (due to SOW)` value into Jira's `customfield_11900` (Committed Date). Dry-run + confirm dialog gating.
- **T-shirt Size column** (2026-05-20): new Size column between Risk and Plan Start. Source = Jira customfield_11190, falls back to Notion Eng Size. Blue chip family (distinct from Risk red/amber/green). Format-tolerant normalizer handles bare letters, full words, and `"L - Large"` select-list format.
- **Late-reason → Jira comments** (2026-05-20, expanded 2026-05-26):
  - Click red hatch → modal with view / add / **edit / delete** (own notes only). `postJiraCommentFromUI` / `editJiraCommentFromUI` / `deleteJiraCommentFromUI` via `google.script.run`. Optimistic local updates after each operation.
  - Body format: `Note (late reason, etc) — [Name] reason text` (soft, neutral when surfaced in Jira). Server filter recognizes the new format AND legacy `Late reason —` / `[…` prefixes.
  - `extractAdfText_` scrubs zero-width / BOM / non-breaking-space characters so a Confluence-copy-paste artifact can't silently knock a leading-prefix match off zero.
  - `lateKeys` overrun criterion (widened 2026-05-26): closed-late OR closed+resolvedAt-late OR **In Progress + today > planEnd**. Last branch caught a case where actualEnd === planEnd but the hatch still rendered (because effectiveActualEnd returns today for In Progress).
- **In Progress Late hatch fix** (2026-05-26): `effectiveActualEnd` now checks status === 'in progress' FIRST and forces today, ignoring any stale `t.actualEnd` from Jira `duedate`. Combined with `isOngoing` dropping the `&& !t.actualEnd` guard, an In Progress task that's past its planned end now correctly shows the actual bar + Late hatch extending to today.
- **Late hatch generalized to all non-closed past-plan tasks** (2026-05-27): `effectiveActualEnd` now also forces today for Blocked / Late Start / any non-closed status with `todayStr > t.end`. The In-Progress-only check left other late states (e.g. Blocked tasks past plan end with stale `actualEnd === planEnd`) with the Late hatch cut short of the today line. New branch order: closed → return actualEnd/resolvedAt; non-closed past plan → today; in-progress → today; else → actualEnd or empty.
- **Deployment URL rotation** (2026-05-27): the original Live URL (`AKfycbzFRDFE…`) vanished from the project's Manage Deployments list — most likely because GAS Commander was issuing "New deployment" each time rather than editing the existing one. New canonical URL: `AKfycbyWEzYul…`. **Going forward**: redeploys must use **Deploy → Manage deployments → (existing deployment) → ✏️ Edit → New version**, never "New deployment". GAS Commander config should pin the deployment ID.
- **PRD requirement → Jira customfield_11089 wiring** (2026-06-01): the Jira "PRD requirement" select (`None` / `Required` / `Optional`) is now the source of truth for whether a ticket counts toward PRD Needed. Wired through `fetchJiraLive` (cache key bumped to v6) onto `t.prdRequirement`; frontend `getPrdState(prd, prdRequirement)` short-circuits to `'na'` when the value is empty / null / "none". **Crucial config dependency**: this Jira project has a "Required" default that auto-populates new tickets, so null only happens when someone explicitly chooses "None" (which clears the field). Without that default, all untouched tickets would land in the 'na' bucket. Notion's PRD column still drives done/draft/review/missing classification for Required/Optional tickets. Discovery snippet `_findPrdRequirementField()` in `webApp.gs` for future field hunts.
- **T-shirt XS recognition** (2026-06-01): `buildTshirtBadge` now handles the "XS - Extra Small" select-list format, added `tshirt-XS` CSS class as the lightest blue of the family.
- **fmtDate timezone fix** (2026-05-26): server-side date formatter now uses `SpreadsheetApp.getSpreadsheetTimeZone()` instead of `Session.getScriptTimeZone()`. The Apps Script project runs in America/Los_Angeles (per appsscript.json) but the spreadsheet is in Asia/Seoul — formatting Seoul-midnight dates with LA's timezone shifted every Plan Start / Plan End back by one day. Now "what was typed in the Sheet" round-trips correctly.
- **Hybrid Notion / Jira / Sheets data architecture** (2026-05-21, by external session): webApp.gs no longer reads Notion data from `Notion_raw` sheet — it now calls Notion API direct (`fetchNotionDirect()`, 10-min CacheService cache), with the daily-synced Sheets tab as fallback. See top of webApp.gs and "Data Architecture" section for details. `syncNotionToSheets.gs` still runs daily 7AM as backup populator for `Notion_raw` (used by Overall/Realistic XLOOKUP formulas + `compareSizesNotionVsJira()` + tertiary fallback).
- **clasp + GAS Commander deploy** (2026-05-21, by external session): clasp now configured; GAS Commander UI provides a "Deploy to Apps Script" button that pulls latest from GitHub and pushes to Apps Script in one click. No more manual clipboard → paste → Deploy New Version workflow.
- **No-cache meta tags** (2026-05-21, by external session): browser cache busting for stale data.
- **Size diff tool** (2026-05-20): "Jira Push → Compare Sizes: Notion vs Jira" menu populates a colour-coded "Size_diff" tab with per-row status (MATCH / MISMATCH / ONLY_IN_NOTION / ONLY_IN_JIRA / JIRA_FETCH_FAILED / NO_JIRA_KEY).
- **Default sort** (2026-05-19): tasks sort by plan start ASC within each team on first load.
- **webApp.gs deployed (2026-04-27)** — local + main + live now in sync
- syncNotionToSheets.gs: deployed and validated — 3 tests passed (manual anchor run, full sync, anchor recreation), Notion_raw row reorder doesn't break Overall
