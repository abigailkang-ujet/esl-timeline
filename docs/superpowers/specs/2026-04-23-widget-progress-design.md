# Widget Progress Format — Design Spec

**Date:** 2026-04-23
**Project:** ESL Phase 1 — Dynamic Timeline (`/Users/ab/esl-timeline`)
**Scope:** `index.html` `buildSummary()` Row 1 cards only. No data / sync / schema changes.

---

## Background

Stakeholder feedback (2026-04-20) requested progress-style numbers on the top-of-page summary widgets. Current cards show a single count (e.g. `P0 Tasks: 26`). The ask: show `complete / total` so viewers instantly see how much of each slice is done.

> "instead of 'P0 Tasks: 26' — 'P0 Tasks Complete: 2 / 25'"
> "instead of 'PRD Needed: 9' — 'PRD Needed 9/17'"

A second, independent request (single portfolio-level summary dashboard) is **out of scope** for this spec — it will be brainstormed and planned separately.

---

## Goals

1. Three cards become `X / Y` progress indicators with a consistent **"completed / total"** direction.
2. The completed count is visually dominant; the total is secondary.
3. Sub-label explicitly identifies X and Y ("Complete / Total") so the ratio isn't ambiguous.
4. One card (`Total Dev Weeks`) is renamed and re-defined to `Program Weeks` (calendar duration of the program), because "program weeks" intuitively reads as elapsed calendar time, not an effort sum.

## Non-goals

- No change to filtering behavior, timeline rendering, or data pipeline.
- No change to the Status strip pills below Row 1.
- No portfolio / cross-program dashboard (separate workstream).
- No filter-awareness for summary cards (they stay global to `ALL_TASKS`).

---

## Row 1 Cards — Before / After

| # | Before | After | Numerator X | Denominator Y |
|---|--------|-------|-------------|---------------|
| 1 | `Total Tasks: 38` | `Tasks: 12 / 38` | `status === 'Closed'` count | `ALL_TASKS.length` |
| 2 | `P0 Tasks: 26` | `P0: 2 / 26` (X in red) | P0 tasks with `status === 'Closed'` | all P0 tasks |
| 3 | `Past Ideal Date: 3` | unchanged | — | — |
| 4 | `PRD Needed: 9` | `PRD: 8 / 17` | `t.pm && getPrdState(t.prd) === 'done'` | `t.pm && getPrdState(t.prd) !== 'na'` |
| 5 | `Teams: 7` | unchanged | — | — |
| 6 | `Total Dev Weeks: 104` | `Program Weeks: N` (single number) | — | — |

### Semantic notes

- **Direction is unified**: every `X/Y` card reads as "done out of total." No mixing "remaining/total" and "done/total."
- **PRD denominator = "Required"**, not "Total." A task with `PRD = '-'` (N/A) is not required to have a PRD and is excluded from the denominator. A task with no PM is also excluded (matches current `PRD Needed` numerator filter).
- **Program Weeks** = `ceil((latest task end − earliest task start) / 7 days)`. Calendar weeks, not business weeks. Rounded up so a 50-day span shows as 8 weeks, not 7.14.

---

## Visual Design

### Layout (B1 with emphasis)

Each progress card renders as:

```
┌────────────────────────────┐
│   12 / 38                  │   ← one line; "12" dominant, "/ 38" muted
│   Complete / Total         │   ← sub-label mirrors X / Y
└────────────────────────────┘
```

### Style rules

- **X (completed count)**: keeps the existing `.number` styling (size, weight, color).
  - Tasks and PRD: default text color (theme-aware).
  - P0: red (`var(--red)`, matches current P0 emphasis).
- **Divider `/` and Y**: smaller and muted.
  - Font size: ~`0.6em` of the big number.
  - Color: `var(--text-muted)`.
  - Weight: normal.
  - Rendered inline in the same container element — no layout reshuffle.
- **Sub-label**: existing `.label` class, text content changes to the "Complete / Total" pattern.

### Sub-label wording

| Card | Big number | Sub-label |
|------|------------|-----------|
| Tasks | `12 / 38` | `Complete / Total` |
| P0 | `2 / 26` | `P0 Complete / Total` |
| PRD | `8 / 17` | `PRD Complete / Required` |
| Past Ideal Date | `3` | `Past Ideal Date` |
| Teams | `7` | `Teams` |
| Program Weeks | `N` | `Program Weeks` |

> "Required" chosen over "Total" on the PRD card to signal the N/A exclusion in the denominator.

---

## Edge Cases

- **Y = 0** (e.g. no P0 tasks in dataset): render `0 / 0` and apply `opacity: 0.5` to the whole card so empty categories read as "no data" rather than "0% done."
- **Program Weeks with no valid dates**: if no task has a parseable `start` or `end`, render `—` (em dash) instead of a number.
- **Single-date span**: if earliest start equals latest end (degenerate case), show `1` week (not `0`).

## Filter Interaction

Summary cards stay **global** to `ALL_TASKS` regardless of Team / PM / Status / Search filters applied to the timeline below. This matches current behavior and avoids confusion where a filter would make cards look like program-wide stats are suddenly shrinking.

If filter-aware summary is desired later, it's a separate enhancement — raise a new request.

---

## Implementation Surface

- **Files touched**: `index.html` only.
  - `buildSummary()` function — Row 1 innerHTML rebuild.
  - CSS additions for the muted `/ Y` span (small util class or inline style).
- **No changes** to `webApp.gs`, `syncNotionToSheets.gs`, sheet schema, or Notion DB.
- **Deployment**: Apps Script redeploy required (per CLAUDE.md, `index.html` changes need a new Apps Script version). Same cycle as other recent UI changes.

## Data Functions Needed

New small helpers inside `buildSummary()` (or adjacent):

- `isClosed(t)` → `t.status === 'Closed'`
- `prdIsDone(t)` → `t.pm && getPrdState(t.prd) === 'done'`
- `prdIsRequired(t)` → `t.pm && getPrdState(t.prd) !== 'na'`
- `programSpanWeeks()` → compute from `ALL_TASKS` earliest start / latest end; return integer weeks or `—` when undetermined.

All counts derive from `ALL_TASKS`. No new fields required from the data layer.

---

## Out of Scope (Flagged for Future)

- **Single portfolio dashboard** — the other half of the original feedback. Will get its own spec.
- **Filter-reactive summary** — possible future enhancement.
- **Elapsed effort** vs calendar weeks — we chose calendar; an "effort burned" indicator could be added later if useful.
- **Localization / i18n of labels** — labels stay English for now.

## Acceptance Criteria

1. Row 1 shows six cards: Tasks, P0, Past Ideal Date, PRD, Teams, Program Weeks (in that order).
2. Tasks / P0 / PRD cards render `X / Y` with X visually dominant and `/ Y` muted.
3. Sub-labels read: `Complete / Total`, `P0 Complete / Total`, `PRD Complete / Required` respectively.
4. P0 numerator keeps red color emphasis.
5. Program Weeks card renders calendar-week span of the program (not effort sum).
6. Empty categories (Y = 0) render at 50% opacity.
7. No regression in Status strip, PRD Alert, or timeline behavior.
