# Jira Issuelinks → Dependency Visualization — Design Spec

**Date:** 2026-05-07
**Project:** ESL Phase 1 — Dynamic Timeline (`/Users/ab/esl-timeline`)
**Scope:** `webApp.gs` (issuelinks added to Jira fetch + parsed into per-task arrays) + `index.html` (`drawDependencies` extended for two link types, hover tooltips on each path).

---

## Background

The current dependency arrows source `t.blocking` / `t.blockedBy` from Notion's two relation properties. Notion only carries one relation type — there's no Relates / Cloners / Causes distinction. Jira does, via `issuelinks`. Three things motivate the change:

1. **Freshness** — Jira live (5-min cache) replaces a 24-hour Notion sync for the values that drive the arrows.
2. **Coverage** — Jira's `issuelinks` exposes link types Notion can't (Relates is the one PMO has actually asked for).
3. **One source for one concern** — co-locate dependency data with the rest of the live-sync fields rather than splitting between Notion and Jira.

This is the deferred follow-up to the 2026-05-06 Jira live-sync spec; the data path is the same, only the parsing and the renderer change.

---

## Goals

1. Show **Blocks** (directional, "A blocks B") and **Relates** (bidirectional, "A relates to B") as visually distinct dependency arrows on the Gantt overlay.
2. Keep the existing `Show Dependencies` toggle as a single switch covering both types.
3. Hover any arrow / line and see which link type it is, plus the two Jira keys involved.
4. Don't break anything: row click → Jira open, gantt bars, schedule chip, lead/pm relocation, show actual, today line, ideal diamond, tour overlay all behave as before.
5. Graceful Notion fallback: if Jira fetch fails, Blocks still draws from Notion-synced values; Relates is silently empty.

## Non-goals

- No support for Cloners, Duplicate, Causes, or other Jira link types. They're parsed and ignored. Adding them is a future spec if PMO asks.
- No per-type toggle (Blocks-only, Relates-only). One toggle covers both.
- No filter such as "show only at-risk arrows."
- No persistent toggle state via localStorage (stays as `let showDeps = false` reset on each load — current behaviour).
- No edits to Notion DB schema; Notion's "Blocking" / "Blocked by" relations still sync as today and provide the fallback for Blocks.

---

## Data Flow

### `webApp.gs` — fetch and parse issuelinks

JQL field list grows by one:

```
fields=status,customfield_11014,duedate,statuscategorychangedate,resolutiondate,issuelinks
```

Per Jira issue, parse the array into three local arrays:

```js
byKey[i.key] = {
  // ... existing fields (status, start, end, statusChangedAt, resolvedAt) ...
  blocking:  [],
  blockedBy: [],
  relates:   [],
};

(i.fields.issuelinks || []).forEach(function(link) {
  var typeName = (link.type && link.type.name) || '';
  if (typeName === 'Blocks') {
    if (link.outwardIssue) byKey[i.key].blocking.push(link.outwardIssue.key);
    if (link.inwardIssue)  byKey[i.key].blockedBy.push(link.inwardIssue.key);
  } else if (typeName === 'Relates') {
    var other = (link.outwardIssue || link.inwardIssue || {}).key;
    if (other) byKey[i.key].relates.push(other);
  }
  // Cloners / Duplicate / Causes / unknown — ignored
});
```

Both halves of a Blocks pair are recorded independently on each issue (A's outward "blocks" entry on A; A's inward "is blocked by" entry on B). The renderer's existing arrow-set deduplicates pairs.

### `webApp.gs` — task object

Initial push (next to the existing `blockedBy` / `blocking` defaults):

```js
relates: [],   // populated by fetchJiraLive (Notion has no Relates relation)
```

Override loop adds:

```js
if (liveEntry.blocking)  t.blocking  = liveEntry.blocking;
if (liveEntry.blockedBy) t.blockedBy = liveEntry.blockedBy;
t.relates = liveEntry.relates || [];
```

When Jira responds, `t.blocking` / `t.blockedBy` become Jira-derived; otherwise they stay as the Notion-synced defaults (graceful fallback). `t.relates` only ever populates from Jira — Notion has no equivalent — so it's safe to overwrite unconditionally with the empty array.

---

## Rendering

### `drawDependencies` — extended

```js
var blocksSet  = {};   // 'A->B' dedupe key
var relatesSet = {};   // canonical 'min<->max' for bidirectional dedupe

ALL_TASKS.forEach(function(t) {
  if (!t.epic) return;

  // Blocks (directional, both halves of a pair both record it)
  (t.blocking || []).forEach(function(targetKey) {
    var target = taskMap[targetKey];
    if (target) drawBlocksArrow(t, target, blocksSet);
  });
  (t.blockedBy || []).forEach(function(blockerKey) {
    var blocker = taskMap[blockerKey];
    if (blocker) drawBlocksArrow(blocker, t, blocksSet);
  });

  // Relates (bidirectional, dedupe by sorted pair key)
  (t.relates || []).forEach(function(otherKey) {
    if (otherKey === t.epic) return;                 // self-link guard
    var other = taskMap[otherKey];
    if (!other) return;
    var pair = [t.epic, otherKey].sort().join('<->');
    if (blocksSet[t.epic + '->' + otherKey] || blocksSet[otherKey + '->' + t.epic]) return;
    if (relatesSet[pair]) return;
    relatesSet[pair] = true;
    drawRelatesLink(t, other);
  });
});
```

The `blocksSet` lookup before adding to `relatesSet` ensures a pair already drawn as Blocks is not re-drawn as Relates (Blocks is the more specific signal — it wins).

### `drawBlocksArrow` (existing `drawArrow`, renamed + tweaks)

- Stroke `#e5a44b` (`var(--amber)`), dasharray `5,3`, width `2`, marker-end `dep-arrow` (existing arrowhead).
- Bezier from source-task bar end → target-task bar start (existing behaviour).
- Adds `pointer-events="stroke"` so hover hits the line.
- Adds an SVG `<title>` child: `Blocks: <fromKey> → <toKey>` — browser-native tooltip.

### `drawRelatesLink` — new

```js
function drawRelatesLink(taskA, taskB) {
  var rowA = rowMap[taskA.epic], rowB = rowMap[taskB.epic];
  if (!rowA || !rowB) return;
  var aStart = parseDate(taskA.start);
  var bStart = parseDate(taskB.start);
  if (!aStart || !bStart) return;       // need both starts for X anchor

  var x1 = ganttLeft + dayToPx(dayOffset(aStart));
  var x2 = ganttLeft + dayToPx(dayOffset(bStart));
  var y1 = rowYCenter(rowA);            // helper that mirrors drawBlocksArrow's Y math
  var y2 = rowYCenter(rowB);

  var d = bezierPath(x1, y1, x2, y2);   // same curvature helper as Blocks
  var path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('stroke', '#5b8af5');         // var(--blue)
  path.setAttribute('stroke-width', '1.2');
  path.setAttribute('stroke-dasharray', '1,3');
  path.setAttribute('fill', 'none');
  path.setAttribute('opacity', '0.7');
  path.setAttribute('pointer-events', 'stroke');
  // No marker-end — bidirectional, no arrowhead.

  var title = document.createElementNS(NS, 'title');
  title.textContent = 'Relates: ' + taskA.epic + ' ↔ ' + taskB.epic;
  path.appendChild(title);

  svg.appendChild(path);
}
```

Both segments anchor at each task's plan start (left edge of the bar) — the relates relation is informational, not date-driven, and the start anchor reads as "these two tasks are connected" without implying a time-based dependency.

### SVG `pointer-events`

The SVG element keeps `pointer-events: none` (so clicks fall through to the underlying table for row / bar clicks). Only individual `<path>` elements get `pointer-events: stroke` so hover triggers on the line itself. The empty bezier interior remains pass-through.

---

## Toggle

`Show Dependencies` button stays exactly as today — same id (`dep-toggle`), same `showDeps` boolean, same on/off behaviour, same default OFF, same non-persistence. The toggle controls both Blocks and Relates together. Button label unchanged.

---

## Edge Cases

| Case | Behaviour |
|------|-----------|
| Same pair has both Blocks and Relates registered in Jira | Blocks wins. Relates skipped. |
| Self-link (`t.relates` includes `t.epic`) | Skipped via guard. |
| Relates target not in current view (filtered out) | `rowMap` lookup returns undefined → silently skipped. |
| Task missing `t.start` on either side of a Relates link | Skipped (no X anchor). Pair could be drawn later if data improves. |
| Many Relates per task (10+) | All drawn. Toggle OFF available if too noisy. No clutter heuristic. |
| Cross-team Relates (CALL ↔ API) | Drawn naturally; bezier may pass over team-header rows. Acceptable. |
| Closed task with Relates | Drawn. Historical relations remain valid context. |
| Jira fetch fails entirely | `t.relates` stays as the empty default. `t.blocking` / `t.blockedBy` stay as Notion-synced. Relates lines simply don't appear; Blocks arrows continue from Notion data. Page renders normally. |
| Notion sync also stale | `t.blocking` / `t.blockedBy` empty too — no arrows rendered. No exception. |
| Hover tooltip on touch / mobile | SVG `<title>` falls through to the OS's behaviour. Acceptable for the user's audience (desktop). |
| Theme toggle | Amber + blue both legible against the page bg in either mode (already-used colours). |

No regressions in: Schedule chip, Done pill, Show Actual columns, Lead/PM relocation, Today line, ideal diamond, tour overlay, PM filter, Status filter, Schedule filter, search.

---

## Verification

**Static (pre-commit):**

1. `grep -n 'issuelinks' webApp.gs` — appears in JQL field list and parser block.
2. `grep -n 'relates:' webApp.gs` — initial empty default + override.
3. `grep -n 'drawRelatesLink\|relatesSet' index.html` — new function and dedup state.
4. `grep -n '"Relates: \|"Blocks: ' index.html` — hover tooltip strings.
5. `grep -n "pointer-events.*stroke" index.html` — applied to dep paths.
6. `grep -c "issuelinks" webApp.gs` — ≥ 2 (JQL field list + parser).

**Post-deploy:**

1. Show Dependencies OFF (default): no arrows or lines.
2. Show Dependencies ON, task with Blocks links: amber dashed arrows with arrowheads.
3. Same toggle, task with Relates links: blue dotted lines without arrowheads.
4. Hover any arrow → tooltip "Blocks: KEY → KEY". Hover any Relates line → "Relates: KEY ↔ KEY".
5. Toggle OFF → both kinds disappear.
6. Click on a row or bar that lies under or near an arrow → Jira opens (path doesn't block).
7. Apps Script Executions log shows `fetchJiraLive` runs without error; sample issue's `issuelinks` array is observable in the response.
8. Temporarily clear the `jiraToken` Script Property → Relates lines disappear; Blocks arrows continue (Notion fallback). Logger logs the warning.
9. Light + dark mode: amber and blue both readable.

---

## Out of Scope (Flagged for Future)

- **Other Jira link types** (Cloners, Duplicate, Causes). Parser already ignores them; adding visualisation is a future ask if it surfaces.
- **Per-type toggles** ("Show Blocks" / "Show Relates" separately). Single toggle is enough today.
- **Filter "at-risk dependencies only"** (e.g., draw arrows only for late tasks).
- **Click-on-arrow → open the link's `inward` / `outward` Jira issue**. Hover tooltip is enough.
- **Persisted toggle state** in localStorage. Current per-load default is fine.

---

## Acceptance Criteria

1. `webApp.gs` JQL field list includes `issuelinks`. Parser splits on `link.type.name` into `blocking` / `blockedBy` / `relates` arrays per issue.
2. `webApp.gs` task object initialises `relates: []` at push time and overrides it (plus `blocking` / `blockedBy`) from Jira live data when available.
3. `drawDependencies` iterates `t.relates` in addition to the existing two arrays. Pairs deduplicated via canonical sorted key. Blocks pair takes priority over a Relates pair on the same two tasks.
4. New `drawRelatesLink(a, b)` function exists with the styling above (blue, dotted `1,3`, width `1.2`, opacity `0.7`, no arrowhead, bezier between bar starts).
5. `drawBlocksArrow` (existing `drawArrow`, renamed) and `drawRelatesLink` both attach an SVG `<title>` child to each `<path>` for hover tooltips. Each path also carries `pointer-events="stroke"`.
6. Self-link guard skips entries where `t.relates` includes `t.epic`.
7. `Show Dependencies` toggle behaviour unchanged — single toggle controls both types.
8. CLAUDE.md "Dependency Arrows" section and the data-architecture diagram updated to reflect the Jira issuelinks source and the two link types.
