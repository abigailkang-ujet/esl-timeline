# Performance Metric Ideas — Program-Level Health

**Status**: Brainstorming, awaiting PMO discussion (raised by Manager 2026-04-27)
**Context**: Leslie wants visibility into program weeks elapsed (✅ shipped via `Weeks Elapsed / Total` summary card). Manager raised the deeper question: how do we measure *performance* — was the program estimated well? Is it actually on track? "Estimated 20 weeks, actual 23 weeks" kind of metric.

Manager has put this to the PMO team (Gabriel + D) to define. This document captures the implementation-side brainstorming so when the data model decision arrives, we're ready.

---

## Available Data (no new fields needed for ideas 1, 2, 4)

Per task we already have:
- `task.start` — baseline start (Realistic Scenario)
- `task.end` — baseline finish (Realistic Scenario)
- `task.notionStart` — actual start from Jira (synced via Notion)
- `task.notionEnd` — actual finish from Jira (or current projection if open)
- `task.status` — `To Do | Untriaged | In Progress | Closed`
- `task.blocking` / `task.blockedBy` — dependency edges
- `task.ideal` — ideal delivery date (SOW commit)

So we already have baseline, actual-start, and actual/projected-finish at task level. The challenge is rolling up to program level meaningfully.

---

## Idea 1 — Forecast Variance Card ⭐ (recommended)

**Single number that answers: "Is the program going to finish on time?"**

```javascript
function programForecastVariance() {
  const tasks = ALL_TASKS;
  let baselineFinish = null;
  let projectedFinish = null;
  for (const t of tasks) {
    if (t.end) baselineFinish = Math.max(baselineFinish ?? 0, +t.end);
    const proj = t.notionEnd || t.end;  // Notion end if available, else baseline
    if (proj) projectedFinish = Math.max(projectedFinish ?? 0, +proj);
  }
  if (!baselineFinish || !projectedFinish) return null;
  const diffMs = projectedFinish - baselineFinish;
  const diffWeeks = diffMs / (7 * 24 * 60 * 60 * 1000);
  return Math.round(diffWeeks * 10) / 10;  // 1 decimal
}
```

**UI** (summary card):
- `+2.3w` red — "Behind by 2.3 weeks"
- `On Track` green — within ±1 week
- `-1.5w` green — "Ahead by 1.5 weeks"

**Pros**:
- Uses existing data — no new fields
- Single number → executive-friendly
- Solves Manager's "where do we stop counting" problem: dynamic forecast, no terminal "actual finish" needed
- Updates automatically as Jira dates change
- Same philosophy as per-task Schedule badge, just rolled up

**Cons**:
- One slow task at the end skews the whole view (max-driven)
- Doesn't say *why* it's behind (which task is the slip)

**Mitigations**:
- Click card → expand → list of tasks contributing to slip (sorted by individual variance)
- Or pair with Idea 2 below

---

## Idea 2 — Schedule Health Pill (rollup)

Reuse existing per-task Schedule badge logic, count by category:

```
🟢 On Track 24    🟡 Behind 5    🟢 Ahead 2    ⚪ Not Started 6
```

**Pros**:
- Zero new logic — pure aggregation of existing badge
- Clickable filter (already partially exists with Status pills)
- Shows distribution, not just summary

**Cons**:
- Doesn't quantify slip in weeks
- Multiple numbers → less executive-friendly than Idea 1

**Best use**: pair with Idea 1 — Idea 1 = single forecast, Idea 2 = breakdown.

---

## Idea 3 — Critical Path Slip

We have `blocking` / `blockedBy` data, so we can compute the critical path (longest dependency chain) and measure baseline vs projected on it.

**Pros**:
- Theoretically most accurate program-level measure
- 5 tasks slipping outside critical path → program not actually delayed; this captures that

**Cons**:
- Requires graph traversal (manageable, but more code)
- Depends on dependency data quality (Notion blocking field accuracy)
- Edge cases: cycles, missing edges, parallel paths

**Verdict**: Worth it eventually. Defer until Idea 1 is in production and we have a feel for accuracy.

---

## Idea 4 — EVM-lite (Earned Value)

Standard PMI metric:
- **PV (Planned Value)**: % of program-weeks that *should* be done by today (based on baseline schedule)
- **EV (Earned Value)**: % of work *actually* done — approximate from task status (Closed = 100%, In Progress = 50%, To Do = 0%)
- **SPI = EV / PV**: 1.0 = on track, < 1.0 = behind, > 1.0 = ahead

**Pros**:
- Industry-standard PM metric — Leslie may recognize / appreciate
- Includes velocity insight (not just date math)

**Cons**:
- More abstract than weeks of slip
- "% done" approximation from status is fuzzy
- Most PMs would still need it explained

**Verdict**: Idea 1 says the same thing more directly. Skip unless PMO specifically asks for EVM.

---

## Idea 5 — Burn-up Chart (sparkline)

Mini chart in summary area:
- X-axis: weeks since program start
- Y-axis: cumulative tasks complete
- Two lines: baseline plan vs actual

**Pros**:
- Visually intuitive — gap between lines = how off-plan we are
- Shows trend, not just snapshot

**Cons**:
- Bigger UI footprint than a card
- Library dependency (or hand-rolled SVG)
- More work for marginal informational gain over Idea 1

**Verdict**: Defer. Add later if PMO wants visual reporting.

---

## Recommendation for PMO Meeting

Lead with **Idea 1 (Forecast Variance Card)** as the proposal:

> "We already have everything needed: baseline dates from Realistic Scenario, actual/projected dates from Jira via Notion. A single card showing `+2.3 weeks behind` or `On Track` would give the same answer to the question 'how is the program performing' — but updates dynamically and doesn't need a manual 'actual finish' field per program. It's the same logic as the per-task Schedule badge, rolled up to program level."

Pair with **Idea 2 (rollup pill)** as a "click to drill down" if the PMO wants more detail.

If PMO wants something more sophisticated, **Idea 3 (Critical Path)** is the next-level upgrade — same idea, but only counts slip on the critical path so a few non-critical late tasks don't move the headline number.

---

## Implementation Estimate (Idea 1 only)

- ~30 lines of JS in `index.html` (`programForecastVariance()` function)
- ~10 lines of CSS for the card color states
- ~5 lines in `buildSummary()` to add the card
- Total: 30 minutes including testing

Add as the 7th summary card, or replace one of the existing 6 if dashboard real estate is tight.
