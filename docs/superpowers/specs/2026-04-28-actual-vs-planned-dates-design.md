# Actual vs Planned Dates — Design Spec

**Date:** 2026-04-28
**Project:** ESL Phase 1 — Dynamic Timeline (`/Users/ab/esl-timeline`)
**Scope:** `index.html` only — column headers, one new toggle, two new optional columns, tooltip rows. No data / sync / schema changes.

---

## Background

PMO director (2026-04-28) requested that the timeline expose both planned and actual start/end dates per task. The current `Start` / `End` columns are sourced from the Realistic Scenario sheet — they are *planned* dates, even though the column labels do not say so. Actual dates already arrive in the data layer (`t.notionStart` / `t.notionEnd`, sourced from Jira via Notion) but today they are only consumed internally by `buildScheduleBadge` to compute the Behind / On Track / Ahead chip; they are never rendered to users.

The director's request was data-centric ("expose planned and actual dates"), without specifying a use case. The existing column area is already crowded, so the design must balance "data is reachable" with "default view stays uncluttered."

---

## Goals

1. Column header naming reflects what the values actually are: `Plan Start` / `Plan End`.
2. Actual start/end dates are reachable in the table view (not only on hover).
3. Default state stays as compact as today — actual columns are off by default, surfaced via a toggle.
4. Tooltip always shows all four dates regardless of toggle state, so a hover answers the question even if the user never finds the toggle.
5. No regression to Schedule chip, Gantt rendering, Sheets sync, or dependency arrows.

## Non-goals

- No change to `webApp.gs`, `syncNotionToSheets.gs`, sheet schema, or Notion DB.
- No change to Schedule chip logic — it continues to derive Behind / On Track / Ahead from `t.notionEnd` vs `t.end`.
- No change to Gantt bar rendering — bars continue to use planned `start` / `end`. (Dual-bar Gantt was considered and explicitly rejected for this round.)
- No new sort option for actual dates. Sort menu stays Plan-only.
- No filter-aware actual columns — the toggle is a global UI preference, not a filter.

---

## Data Lineage (authoritative)

This was the most error-prone area during brainstorming, so it is fixed here explicitly.

| Field | Source | Path |
|-------|--------|------|
| `t.start` (Plan Start) | Google Sheets — "Realistic Scenario - Tasks Details (S2)" col H | `webApp.gs` reads `row['Start Date']` |
| `t.end` (Plan End) | Google Sheets — "Realistic Scenario - Tasks Details (S2)" col I | `webApp.gs` reads `row['End Date']` |
| `t.notionStart` (Act Start) | Notion DB "Start-End Date" property — start half | Notion → `syncNotionToSheets.gs` `notionDateRange_()` → `Notion_raw` col N → `webApp.gs` `buildNotionIndex` splits the range |
| `t.notionEnd` (Act End) | Notion DB "Start-End Date" property — end half | same path as above |

The Notion "Start-End Date" property is auto-populated from Jira (per the data architecture diagram in `CLAUDE.md`). Specifically, Jira workflow transitions write into this property — so `notionStart` corresponds to the Jira "started" timestamp and `notionEnd` to the Jira "done" timestamp. Empty string when the task has not yet entered the corresponding state.

**Consistency invariant**: the Schedule chip's `notionEnd` and the new "Act End" column are the same field. If Schedule says "Behind," the new Act End column will visibly show a date later than Plan End (or be empty while today is past Plan End). If the two ever disagree, that is a bug.

---

## UI Changes

### Column header rename

| Before | After | Header tooltip (hover ℹ) |
|--------|-------|--------------------------|
| `Start` | `Plan Start` | "Planned start date — from Realistic Scenario sheet" |
| `End` | `Plan End` | "Planned end date — from Realistic Scenario sheet" (changed from "Projected end date" to remove ambiguity) |

### New columns (off by default)

Inserted between `Plan End` and `Ideal`:

| Header | Width | Header tooltip |
|--------|-------|----------------|
| `Act Start` | 60px | "Actual start date — from Jira (synced via Notion). '—' if not started yet." |
| `Act End` | 60px | "Actual end date — from Jira (synced via Notion). '—' if not finished yet." |

Final column order (left → right):

```
Pri | Task | Lead | PM | PRD | Risk | Plan Start | Plan End | Act Start | Act End | Ideal | Schedule | (Alloc | Status) | Gantt
                                       ↑ rename                ↑ new (toggle ON)         ↑ unchanged
```

`Plan Start` and `Plan End` widen from 55px → 60px to fit the longer label on a single line. Actual columns are 60px each. Net width delta: +10px when toggle OFF, +130px when ON.

### Toggle button

- Location: `ctrlRow`, immediately to the right of the existing `Deps` toggle.
- Label: `Show Actual` (matches the visual style of `Deps` — same height, same padding, same on/off color treatment using existing accent vars).
- State: global `showActual` boolean, persisted to `localStorage` under key `esl-show-actual` as `'1'` / `'0'`.
- Default on first visit (key missing): OFF.
- Behavior: clicking the toggle flips state, persists to localStorage, and triggers `renderTimeline()` so the column set updates.

### Cell rendering rules

- `Plan Start` / `Plan End` cells: unchanged from today — `(d.start || '-')` / `(d.end || '-')`, formatted as `M/D` via `fmtShort`.
- `Act Start` / `Act End` cells: same shape — `(d.notionStart || '-')` / `(d.notionEnd || '-')`, same `fmtShort` formatting.
- Use `-` (single hyphen) for missing values to match the existing pattern used by other date cells.

### data-col attributes

To avoid breaking the existing `hiddenCols` set semantics, the renamed columns keep their existing `data-col` attributes:

- `Plan Start` `<th>`: `data-col="start"` (unchanged)
- `Plan End` `<th>`: `data-col="end"` (unchanged)
- `Act Start` `<th>`: `data-col="actStart"` (new)
- `Act End` `<th>`: `data-col="actEnd"` (new)

### Existing collapsible-column behavior

`Plan Start` and `Plan End` continue to be individually collapsible by clicking their `<th>` (existing `hiddenCols` pattern). `Act Start` / `Act End` are **not** individually collapsible — the `Show Actual` toggle is the only control for them. This keeps the mental model simple: one master switch for the actual pair.

---

## Tooltip Update

Current tooltip rows (line 1115-1117 of `index.html`):

```
Start  | 4/15
End    | 5/10
Ideal  | 5/15
```

New tooltip rows:

```
Plan Start    | 4/15
Plan End      | 5/10
Actual Start  | 4/18           ← only rendered when t.notionStart is non-empty
Actual End    | —              ← only rendered when t.notionEnd is non-empty
Ideal         | 5/15
```

Rules:

- `Plan Start` / `Plan End` / `Ideal`: always rendered (existing behavior); `-` when missing.
- `Actual Start` row: only inserted when `d.notionStart` is truthy.
- `Actual End` row: only inserted when `d.notionEnd` is truthy.
- This keeps the tooltip compact for tasks that haven't started yet and avoids "Actual Start: —" noise.
- The tooltip shows actuals **regardless** of the `Show Actual` toggle state — this is the safety net that ensures hovering always answers the question.

---

## Edge Cases

1. **Task with no Jira sync** — `t.notionStart` / `t.notionEnd` empty. Cells: `-`. Tooltip: rows omitted. Schedule chip: derived from planned `start` vs today (existing logic).
2. **Started but not finished** — `notionStart` present, `notionEnd` empty. Act Start cell shows date; Act End shows `-`. Schedule chip: "On Track" (existing logic, line 1267).
3. **Finished early or late** — both notion dates present. Schedule chip computes ±3 day tolerance (existing). Act End column shows raw date so the user can see the magnitude of the slip / lead.
4. **localStorage unavailable / corrupted value** — treat as OFF. Wrap read in try/catch or guard for non-`'0'`/`'1'` values.
5. **Light mode** — new toggle and columns must respect existing CSS variables. No hard-coded colors. Toggle uses the same accent variable as `Deps`.
6. **Horizontal scroll when toggle ON** — Gantt is not sticky, so wider table can require scrolling. Acceptable; matches current behavior when `Alloc` / `Status` are added by team filter.
7. **Sort by Start / End** — existing sort options (line 994-996) sort by `t.start` and `t.end` (planned). Unchanged. No new sort options for actual.
8. **Header name collision in sortOpts dropdown** — current option labels `'Start Date'` and `'End Date'` (line 537) should be relabeled `'Plan Start'` and `'Plan End'` for consistency with the renamed headers. (Minor follow-up included in implementation.)

---

## Implementation Surface

- **Files touched**: `index.html` only.
  - Header `<th>` markup (line 979-981) — rename + add 2 new headers wrapped in a conditional or with a hidden class.
  - Cell rendering (line ~1001 onwards) — emit Act Start / Act End cells gated on `showActual`.
  - Tooltip builder (line 1115-1117) — rename labels, conditionally append actual rows.
  - Toggle button — append to `ctrlRow` near Deps toggle (search for the Deps toggle attach point and add adjacent).
  - `tip()` strings for renamed and new headers.
  - `sortOpts` labels (line 537) — `'Start Date'` → `'Plan Start'`, `'End Date'` → `'Plan End'`.
  - CSS — no new rules required if widths are inline; if defined in CSS, update `info-col[data-col="start"]` width and add rules for new `data-col="actStart"` / `data-col="actEnd"`.
- **No changes** to `webApp.gs`, `syncNotionToSheets.gs`, sheet schema, or Notion DB.
- **CLAUDE.md update** (in same change) — reflect the renamed columns, new toggle, and updated tooltip field list. Specifically: column header table around line 979-983 reference, Tooltip Fields list, and Filters section.
- **Deployment**: Apps Script redeploy required (per `CLAUDE.md` — `index.html` changes need a new Apps Script version).

---

## Verification Plan

No automated tests in this project; verification is static + post-deploy visual.

**Static (pre-commit):**

1. `grep -n "Plan Start\|Plan End\|Act Start\|Act End" index.html` — confirms all four headers, sort options, tooltip labels, and tip() strings are present and consistent.
2. `grep -n "showActual\|esl-show-actual" index.html` — confirms toggle variable and localStorage key are spelled identically across reads/writes.
3. `grep -c "notionStart\|notionEnd" index.html` — count goes up (was 2 occurrences in `buildScheduleBadge`; should be ~6 after change: schedule + cell render × 2 + tooltip × 2).
4. `grep -n "Start Date\|End Date" index.html` — should only match `sortOpts` labels (now relabeled) and any code reading sheet column names. No stray "Start Date" / "End Date" remaining as column headers.

**Post-deploy visual (live URL):**

1. Default load — toggle OFF, Plan Start / Plan End columns visible, no Act columns.
2. Click `Show Actual` — Act Start / Act End columns appear between Plan End and Ideal.
3. Refresh page — toggle stays ON (localStorage).
4. Hover any task without Jira actuals — tooltip shows Plan Start / Plan End / Ideal only (no Actual rows).
5. Hover a task that is in progress (notionStart set, notionEnd empty) — tooltip shows Actual Start row only.
6. Hover a task that is closed (both notion dates set) — tooltip shows both Actual rows.
7. Toggle dark/light — no color regressions; new toggle and columns theme correctly.
8. Pick one task where Schedule chip = "Behind" — confirm Act End column shows a date later than Plan End (consistency invariant from the Data Lineage section).
9. Sort dropdown — labels read `Plan Start` / `Plan End` (no longer `Start Date` / `End Date`).

---

## Out of Scope (Flagged for Future)

- **Dual-bar Gantt** (planned outline + actual fill) — considered and rejected for this round. Could be a follow-up if the director asks for visual slip on the chart, not just in the table.
- **Sort by actual dates** — not requested; deferred until a use case appears.
- **Filter / highlight tasks by slip magnitude** — e.g., "show only tasks where Act End > Plan End by ≥ N days." Out of scope; the existing Schedule chip filter already covers Behind / On Track / Ahead.
- **Cell-level slip indicator** (e.g., red text on Act End when later than Plan End) — option C from brainstorming; not selected. If raw dates prove insufficient, revisit.
- **Two-line column headers** (`Plan` / `Plan` / `Act` / `Act` over `Start` / `End` / `Start` / `End`) — kept as a fallback if 60px single-line headers feel cramped during implementation. Not the planned approach.

---

## Acceptance Criteria

1. Column headers read `Plan Start` and `Plan End` (no longer `Start` / `End`).
2. A `Show Actual` toggle exists in `ctrlRow` next to the `Deps` toggle, defaults OFF, and persists across page reloads via `localStorage` key `esl-show-actual`.
3. With toggle ON, two columns `Act Start` and `Act End` appear between `Plan End` and `Ideal`, sourced from `t.notionStart` / `t.notionEnd`, formatted as `M/D` and showing `-` when empty.
4. Tooltip shows `Plan Start` / `Plan End` always, `Actual Start` and `Actual End` only when their respective values are non-empty, regardless of toggle state.
5. Header ℹ tooltips reflect the renamed and new columns per the table above.
6. Sort dropdown labels match new header names (`Plan Start` / `Plan End`).
7. Schedule chip behavior, Gantt rendering, dependency arrows, and Sheets/Notion sync are unchanged.
8. CLAUDE.md is updated in the same change to reflect new headers, the toggle, and the tooltip additions.
