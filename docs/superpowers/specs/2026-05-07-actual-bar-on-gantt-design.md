# Actual Bar on Gantt — Design Spec

**Date:** 2026-05-07
**Project:** ESL Phase 1 — Dynamic Timeline (`/Users/ab/esl-timeline`)
**Scope:** `webApp.gs` (two extra Jira fields) + `index.html` (Gantt bar rendering and tooltip rows). No data-pipeline / sheet / Notion changes.

---

## Background

The 2026-05-06 Jira live-sync change brought `actualStart` / `actualEnd` directly from Jira, but the Gantt area still shows only a single planned bar. PMO reviewers asked for a visualisation where plan and actual sit side by side, with explicit overrun (actual end past plan end) called out — same idea MS Project uses in Tracking Gantt.

Two complications surfaced during brainstorm with the team:

1. **Status as a fallback for missing dates.** Tickets sometimes transition through Jira workflow without the user filling in custom Start Date / Due Date fields. We still want a bar to draw if the status alone says "this happened" — using `statuscategorychangedate` (status-transition timestamp) and `resolutiondate` (close timestamp) as fallbacks.
2. **Toggle scope.** The existing "Show Actual" toggle gates both the columns and the bar today. Conceptually the bar is a visualisation that should always be visible if there's data; only the textual columns are optional. The toggle is being narrowed to the columns only.

---

## Goals

1. Show plan vs actual side-by-side in the Gantt area whenever effective actual data exists (explicit dates or status-derived fallbacks).
2. Surface plan-end overrun unambiguously — softly red-hatched segment continuing past plan-end on the actual line.
3. Communicate "in progress, end open" with a fade on the right edge instead of a hard cutoff at today.
4. Keep the existing single-bar look for tasks with no effective actual data — no visual surprise on To Do rows.
5. No regression in: Schedule chip, Done pill, Today line, ideal diamond, dependency arrows, click-to-Jira, theme toggle, Show Actual toggle for columns.

## Non-goals

- No new aggregate views, no team-rollup bars.
- No per-segment tooltips. The row-level tooltip already covers everything.
- No Jira `issuelinks` / blocking visualisation (separate spec).
- No status name normalisation (still using verbatim Jira status strings).
- No background time-trigger / push notifications. Refresh comes from the existing 5-minute Jira live-sync cache.

---

## Data Shape

### Two new fields fetched from Jira

`webApp.gs` `fetchJiraLive()` JQL gains two fields:

```
fields=status,customfield_11014,duedate,statuscategorychangedate,resolutiondate
```

Mapped onto the per-key result:

```js
byKey[i.key] = {
  status:           f.status?.name || '',
  start:            f[JIRA_FIELD_START]      || '',  // explicit Start Date
  end:              f[JIRA_FIELD_END]        || '',  // explicit Due Date
  statusChangedAt:  f.statuscategorychangedate || '', // last category transition
  resolvedAt:       f.resolutiondate           || '', // null until close
};
```

Override loop in `buildTimelineData()` adds two new task fields next to the existing three:

```js
t.statusChangedAt = liveEntry.statusChangedAt || '';
t.resolvedAt      = liveEntry.resolvedAt      || '';
```

### Effective-date helpers

Two pure functions in `index.html`. They encode the status-driven fallback rules in one place so the bar drawer, the tooltip, and any later consumer all read identical values:

```js
function effectiveActualStart(t) {
  if (t.actualStart) return t.actualStart;
  var s = (t.status || '').toLowerCase().trim();
  var startedOrFinished = s === 'in progress' || /closed|done|complete/.test(s);
  return startedOrFinished ? (t.statusChangedAt || '') : '';
}

function effectiveActualEnd(t) {
  if (t.actualEnd) return t.actualEnd;
  var s = (t.status || '').toLowerCase().trim();
  if (/closed|done|complete/.test(s))  return t.resolvedAt || '';
  if (s === 'in progress')             return new Date().toISOString().slice(0, 10);
  return '';
}
```

Caveats:

- `statuscategorychangedate` reflects the **last** category change. A ticket that bounced In Progress → Blocked → In Progress shows the latest transition, not the first. Acceptable trade-off — the alternative is fetching the changelog (per-issue, paginated, expensive). If a ticket regresses, the bar relocates; that's correct behaviour.
- `resolutiondate` is set when Jira resolution is set (typically on Close). Reliable.
- Fallback only fires when explicit dates are absent. Explicit always wins.

---

## Visual

Three rendering cases, branched on whether effective actual dates exist (so status fallback is automatically honoured):

| Case | Trigger | Rendered |
|------|---------|----------|
| 1 — plan only | `effectiveActualStart` and/or `effectiveActualEnd` empty | Existing single 10 px team-color bar from `t.start` to `t.end`. Visually identical to today. |
| 2 — split, no overrun | Both effective dates present, actual end ≤ plan end | Plan: 6 px grey on top half (`rgba(148,163,184,0.55)`). Actual: 6 px team color on bottom half. |
| 3 — split + overrun | Both effective dates present, actual end > plan end | Same as case 2 plus a soft-red hatched segment on the bottom half from plan end to actual end. |

### CSS

```css
.gantt-plan {
  position: absolute; top: 50%; height: 6px;
  background: rgba(148, 163, 184, 0.55);
  transform: translateY(-100%);
  border-top-left-radius: 6px; border-top-right-radius: 6px;
  z-index: 1;
}
.gantt-actual {
  position: absolute; top: 50%; height: 6px;
  /* background: <team color>  ← inline */
  border-bottom-left-radius: 6px; border-bottom-right-radius: 6px;
  opacity: 0.92; z-index: 2;
}
.gantt-actual.in-progress-ongoing {
  -webkit-mask-image: linear-gradient(90deg, black 70%, transparent 100%);
          mask-image: linear-gradient(90deg, black 70%, transparent 100%);
}
.gantt-overrun {
  position: absolute; top: 50%; height: 6px;
  background-image: repeating-linear-gradient(45deg,
    rgba(244, 112, 103, 0.55), rgba(244, 112, 103, 0.55) 4px,
    rgba(244, 112, 103, 0.20) 4px, rgba(244, 112, 103, 0.20) 8px);
  border-bottom-right-radius: 6px;
  z-index: 3;
}
.task-row:hover .gantt-plan,
.task-row:hover .gantt-actual,
.task-row:hover .gantt-overrun { opacity: 1; }
```

The existing `.gantt-bar` rule stays — used by case 1 (plan-only). Border-radius on the actual segment drops the right corner when an overrun segment is appended (so the two segments visually join).

### Pixel math (in `buildTaskRow`)

```js
const planSd = parseDate(t.start);
const planEd = parseDate(t.end);
const actSd  = parseDate(effectiveActualStart(t));
const actEd  = parseDate(effectiveActualEnd(t));
const hasActual = actSd && actEd;

if (!hasActual) {
  // Case 1 — plan only, existing behaviour preserved
  if (planSd && planEd) {
    const left  = dayToPx(dayOffset(planSd));
    const width = Math.max(3, dayToPx(dayOffset(planEd)) - left);
    ganttInner += '<div class="gantt-bar" style="left:' + left + 'px;width:' + width
              + 'px;background:' + color + ';"' + barClickAttrs + '></div>';
  }
} else {
  // Case 2 / 3 — half-split
  if (planSd && planEd) {
    const planLeft  = dayToPx(dayOffset(planSd));
    const planWidth = Math.max(3, dayToPx(dayOffset(planEd)) - planLeft);
    ganttInner += '<div class="gantt-plan" style="left:' + planLeft + 'px;width:' + planWidth
              + 'px;"' + barClickAttrs + '></div>';
  }
  const actLeft   = dayToPx(dayOffset(actSd));
  const actEdPx   = dayToPx(dayOffset(actEd));
  const planEdPx  = planEd ? dayToPx(dayOffset(planEd)) : null;
  const isOngoing = (t.status || '').toLowerCase().trim() === 'in progress' && !t.actualEnd;
  const actClass  = 'gantt-actual' + (isOngoing ? ' in-progress-ongoing' : '');

  if (planEdPx && actEdPx > planEdPx) {
    // Overrun — split the actual into within-plan + overrun segments
    if (actLeft < planEdPx) {
      ganttInner += '<div class="' + actClass + '" style="left:' + actLeft
                + 'px;width:' + (planEdPx - actLeft)
                + 'px;background:' + color + ';border-bottom-right-radius:0;"'
                + barClickAttrs + '></div>';
    }
    ganttInner += '<div class="gantt-overrun" style="left:' + planEdPx
              + 'px;width:' + (actEdPx - planEdPx) + 'px;"' + barClickAttrs + '></div>';
  } else {
    const actWidth = Math.max(3, actEdPx - actLeft);
    ganttInner += '<div class="' + actClass + '" style="left:' + actLeft
              + 'px;width:' + actWidth + 'px;background:' + color + ';"'
              + barClickAttrs + '></div>';
  }
}
```

`barClickAttrs` is the existing `onclick="window.open(epicUrl,...)"` markup, applied to every segment so the entire bar area opens the Jira ticket.

---

## Tooltip

`showRowTooltip` adds annotation when an effective date came from a fallback rather than an explicit field. The format remains the existing label/value rows:

| Condition | Row text |
|-----------|----------|
| `t.actualStart` set | `Actual Start  4/18` |
| no `actualStart`, status In Progress / Closed, `statusChangedAt` set | `Actual Start  ~4/18 (status transition)` |
| `t.actualEnd` set | `Actual End  5/15` |
| no `actualEnd`, Closed, `resolvedAt` set | `Actual End  ~5/15 (resolved)` |
| no `actualEnd`, In Progress | `Actual End  in progress (today: 5/7)` |
| neither explicit nor fallback | row omitted |

`explainSchedule` (Schedule pill hover) gets the same fallback-aware text in the Closed branch — when the chip is computed off `resolvedAt` instead of `actualEnd`, the hover says `Closed (resolved 5/15) — N days after planned end ...`.

---

## Toggle behaviour

`Show Actual` toggle scope narrows:

- **Before:** controls Act Start / Act End columns AND whether the (single old-style) bar uses actual dates.
- **After:** controls Act Start / Act End columns only. The Gantt bar always renders the dual-bar treatment when effective actual data exists. Tooltip continues to show actuals regardless of the toggle (existing safety net, unchanged).

Net effect for users:
- Toggle off → table reads "lighter" (fewer columns), bar still tells the plan-vs-actual story.
- Toggle on → bar unchanged, columns reappear for explicit textual comparison.

LocalStorage key `esl-show-actual` keeps its semantics.

---

## Edge cases

| Case | Handling |
|------|----------|
| Early start (`actualStart` < `plannedStart`) | Bars rendered at literal positions. Plan visible from plan-start, actual extends further left. No special marker (early start ≠ warning). |
| Closed early (`actualEnd` < `plannedEnd`) | Plan bar full duration, actual bar shorter; the right portion of plan shows "remaining" with no actual underneath. Already correct from the half-split layout. |
| Plan dates partially missing (`t.start` or `t.end` empty) | Plan segment skipped. Actual segment still draws if effective dates exist. Both missing → no bars. |
| Actual extends past `TIMELINE_END` (2026-10-31) | Clipped via `gantt-area` overflow. Out-of-range portion not drawn. |
| Actual starts before `TIMELINE_START` | `dayOffset` clamped at 0; left edge sits at the gantt-area boundary. |
| Status Blocked / Untriaged / blank | Treated as pre-start by `effectiveActualStart` (no fallback). Case 1 (plan only). |
| Closed without any end signal (`actualEnd` and `resolvedAt` both empty) | `effectiveActualEnd` returns empty → case 1 (plan only). Schedule chip already returns `Done` for this state (2026-04-29). |
| In Progress without any start signal (`actualStart` and `statusChangedAt` both empty) | `effectiveActualStart` returns empty → case 1 (plan only). Tooltip notes the absence. |
| Status reverted (workflow regression) | `statusChangedAt` reflects the latest transition; bar updates accordingly. Acceptable. |
| Hover / click | Row-level tooltip and click open Jira. Each segment carries the same `onclick`, so any part of the bar is a hit target. |
| Theme toggle | Plan grey, actual team color, overrun red hatch all read against both `--bg-card` modes. No mode-specific overrides needed. |
| Existing dependency arrows / today line / ideal diamond | Untouched — they sit at row-relative coordinates that don't depend on the bar shape. |

---

## Verification Plan

**Static (pre-commit):**

1. `grep -n "statuscategorychangedate\|resolutiondate" webApp.gs` — both new field names appear in the JQL.
2. `grep -n "statusChangedAt\|resolvedAt" webApp.gs` — both task fields are written and overridden.
3. `grep -n "effectiveActualStart\|effectiveActualEnd" index.html` — helpers defined and used (≥1 of each).
4. `grep -n "gantt-plan\|gantt-actual\|gantt-overrun\|in-progress-ongoing" index.html` — CSS rules + JS class assignments.
5. `grep -n "showActual" index.html` — only column logic depends on it; bar rendering does not check `showActual`.

**Post-deploy (live):**

1. To Do task — single full-height team-color bar (case 1).
2. Closed on time — half-split, no overrun.
3. Closed late (over plan end) — half-split with red-hatched segment past plan-end.
4. Closed early — actual bar visibly shorter than plan; no overrun.
5. In Progress with explicit `actualStart`, no `actualEnd` — actual segment from `actualStart` to today, right edge faded.
6. In Progress without `actualStart` — segment from `statusChangedAt` to today, faded.
7. In Progress without any start signal — case 1 (plan only).
8. Closed without explicit `actualEnd` but with `resolvedAt` — segment ends at `resolvedAt`.
9. Tooltip hover — Actual Start / Actual End rows correctly annotated with `~` + source label when fallback is used.
10. Show Actual toggle — flipping it changes only the columns, never the bar.
11. Bar click anywhere → Jira opens.
12. Light + dark mode — both render legibly. Overrun hatch readable on both.

---

## Out of Scope (Flagged for Future)

- **Per-segment tooltips** — could surface segment-specific facts (plan vs actual span). Likely unnecessary; row tooltip is enough.
- **Lead / PM column reorganisation** — separate brainstorm raised today; not in this spec.
- **Jira `issuelinks` for dependencies** — already deferred from the 2026-05-06 spec.
- **Changelog-based "first transition into In Progress"** — deferred unless the latest-transition behaviour proves wrong in practice.

---

## Acceptance Criteria

1. `webApp.gs` `fetchJiraLive()` requests `statuscategorychangedate` and `resolutiondate` and exposes them on the per-key result.
2. `buildTimelineData()` writes `t.statusChangedAt` and `t.resolvedAt` on each task that has a Jira key match.
3. `index.html` defines `effectiveActualStart(t)` and `effectiveActualEnd(t)` per the rules above.
4. Gantt bar rendering branches: case 1 (plan-only, single bar) when `hasActual` false; case 2/3 (half-split, with overrun segment when actual end > plan end) when true.
5. CSS classes `.gantt-plan`, `.gantt-actual`, `.gantt-overrun`, and `.gantt-actual.in-progress-ongoing` exist with the values above.
6. `Show Actual` toggle controls columns only — the bar renders independently of `showActual`.
7. Tooltip Actual Start / Actual End rows annotate fallback sources with `~` and a source label.
8. `explainSchedule` Closed branch uses `resolvedAt` as the actual-end source when `actualEnd` is empty, and says so in the hover text.
9. CLAUDE.md updates the Gantt and Show Actual sections to reflect the new behaviour.
