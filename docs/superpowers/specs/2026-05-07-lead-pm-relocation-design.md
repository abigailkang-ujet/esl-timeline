# Lead / PM Relocation to Team Header — Design Spec

**Date:** 2026-05-07
**Project:** ESL Phase 1 — Dynamic Timeline (`/Users/ab/esl-timeline`)
**Scope:** `index.html` only — remove the per-task Lead and PM columns and surface those two values inline on each team header row.

---

## Background

Lead and PM are repeated 90 px columns in every task row even though, in practice, every task in a given team carries the same Lead Engineer and the same PM Owner. The columns also crowd the table left side and steal width from the Gantt area. User confirmed the within-team uniformity (2026-05-07 brainstorm), which makes a team-level consolidation safe.

This is a follow-up to the 2026-05-07 dual-bar Gantt spec. Two specs ship in the same day; this one is purely a layout reorganisation with no data shape change.

---

## Goals

1. Reclaim 180 px of horizontal space (Lead 90 + PM 90) for the Gantt area.
2. Keep Lead and PM names visible at a glance — not hidden behind a hover-only treatment.
3. Survive rare data inconsistencies (a stray task in a team with a different Lead or PM) without losing the information; surface the discrepancy in the header.
4. No regressions in PM dropdown filter, Schedule chip, tour overlay, Show Actual toggle, or tooltip content.

## Non-goals

- No change to the underlying data shape — `t.lead` and `t.pm` continue to be populated per task.
- No change to the tooltip — the per-task Lead and PM Owner rows stay (so individual differences remain auditable on hover).
- No change to Allocation, Headcount, PMO Owner, Risk, or any other field. They remain per-task columns.
- No change to the PM filter dropdown's behaviour (`t.pm` still feeds it).
- No change to `webApp.gs`, sheet schema, or Notion DB.

---

## Layout

### Before (current)

```
| Pri | Task                          | Lead       | PM        | PRD | Risk | Plan St | Plan End | ... | Gantt → |
| P0  | [Web SDK] Inbound Voice Calls | Youngjeong | Taylor    | ✓   | M    | 4/15    | 5/10     | ... |  ████   |
| P1  | Email channel support         | Youngjeong | Taylor    | Dr  | L    | 5/01    | 6/15     | ... |  ████   |
```

### After

```
| Pri | Task                          | PRD | Risk | Plan St | Plan End | ... | Gantt → |
| CALL (3)  · Lead: Youngjeong Yu  · PM: Taylor Tew                              |
| P0  | [Web SDK] Inbound Voice Calls | ✓   | M    | 4/15    | 5/10     | ... |  ████   |
| P1  | Email channel support         | Dr  | L    | 5/01    | 6/15     | ... |  ████   |
```

The team-header row spans the full table via colspan. Inline format: team name (uppercase, team color, current style) → `(N)` count chip → ` · Lead: <names>` → ` · PM: <names>`.

`Lead:` and `PM:` labels render in the muted text color so the names sit visually closer to the team name. Names use normal text-transform / letter-spacing so proper nouns don't get distorted by the parent's uppercase styling.

---

## Implementation

### `index.html` JS — team header build site

Currently the team-header markup is built inline inside `renderOrder.forEach`:

```js
'<td class="info-col" colspan="' + teamColspan + '" style="color:' + color +
';border-left:3px solid ' + color + '">' + team +
' <span style="font-weight:400;font-size:11px;opacity:0.6">(' + teamTasks.length + ')</span></td>'
```

Replace with a small helper + a more structured markup:

```js
function teamPeople(teamTasks) {
  var leads = [], pms = [];
  teamTasks.forEach(function(t) {
    if (t.lead) {
      var L = t.lead.trim();
      if (L && leads.indexOf(L) === -1) leads.push(L);
    }
    if (t.pm) {
      // PM field is comma-separated for multi-PM tasks
      t.pm.split(',').forEach(function(p) {
        var P = p.trim();
        if (P && pms.indexOf(P) === -1) pms.push(P);
      });
    }
  });
  return { leads: leads, pms: pms };
}

// inside the forEach:
var ppl = teamPeople(teamTasks);
var people = '';
if (ppl.leads.length) people += '<span class="role"> · Lead:</span> ' + escapeHtml(ppl.leads.join(', '));
if (ppl.pms.length)   people += '<span class="role"> · PM:</span> '   + escapeHtml(ppl.pms.join(', '));

rows += '<tr class="team-header">' +
  '<td class="info-col" colspan="' + teamColspan + '" style="color:' + color + ';border-left:3px solid ' + color + '">' +
    team +
    ' <span class="team-count">(' + teamTasks.length + ')</span>' +
    (people ? '<span class="team-people">' + people + '</span>' : '') +
  '</td>' +
  '<td class="gantt-col">' + teamTodayLine + '</td></tr>';
```

`escapeHtml` (already in the codebase, used elsewhere for safe text injection) protects against name strings that contain markup characters.

### `index.html` JS — column removal

Drop these lines from `buildTimeline` (the THEAD construction near line 1073):
- `<th class="info-col" data-col="lead" ...>Lead' + tip(...)</th>`
- `<th class="info-col" data-col="pm"   ...>PM'   + tip(...)</th>`

Drop these lines from `buildTaskRow` (the TBODY construction near line 1192):
- `<td class="info-col date-cell" data-col="lead" ...>` ... `</td>`
- `<td class="info-col date-cell" data-col="pm"   ...>` ... `</td>`

The `pmDisplay` and `leadDisplay` local variables become unused — remove them.

### Team-header colspan

Currently:

```js
var teamColspan = 10 + (showExtra ? 2 : 0) + (showActual ? 2 : 0);
```

The `10` was: Pri, Task, Lead, PM, PRD, Risk, Plan Start, Plan End, Ideal, Schedule. After removing Lead and PM:

```js
var teamColspan = 8 + (showExtra ? 2 : 0) + (showActual ? 2 : 0);
```

The `+2 if showExtra` (Alloc, Status) and `+2 if showActual` (Act Start, Act End) modifiers stay intact.

### CSS

Three new rules (added to the existing team-header section):

```css
/* Team header inline meta — Lead/PM relocated 2026-05-07 */
.team-header .team-count {
  font-weight: 400; font-size: 11px; opacity: 0.6;
}
.team-header .team-people {
  font-weight: 400; font-size: 11px;
  color: var(--text-secondary);
  text-transform: none; letter-spacing: normal;
}
.team-header .team-people .role {
  color: var(--text-muted);
}
```

The existing inline `style="font-weight:400;font-size:11px;opacity:0.6"` on the count span gets replaced by the `.team-count` class — same visual.

---

## Edge cases

| Case | Behaviour |
|------|-----------|
| Lead present, PM empty (or vice versa) | Only the present label renders. `CALL (3) · Lead: Youngjeong Yu` |
| Both empty | `CALL (3)` — same as current |
| Multi-PM in one task (`t.pm = "Taylor Tew, Sarah Lee"`) | Both names listed, comma-joined: `PM: Taylor Tew, Sarah Lee` |
| Same team has tasks with different Leads (data inconsistency) | Both Leads shown, comma-joined. Surfaces the inconsistency without hiding it. |
| Whitespace-only `t.lead` | Trimmed and dropped (not rendered as an empty entry) |
| HTML-unsafe characters in names | `escapeHtml` applied before injection |
| PM filter dropdown | Unaffected. Still iterates `t.pm` per task; team-header relocation does not touch the data. |
| Tooltip Lead / PM Owner rows | Unchanged. Per-task values continue to render on hover. |
| Show Actual toggle | Unaffected. Toggle controls Act Start / Act End columns only. |
| `hiddenCols` Set may still hold `'lead'` / `'pm'` from prior session | Harmless — `applyHiddenCols` queries `[data-col]` attributes; nothing matches, no-op. Not cleaned up on purpose (YAGNI). |
| Tour overlay | None of the steps target the Lead or PM column. No update needed. |
| Theme toggle | Uses `var(--text-secondary)` and `var(--text-muted)` which adapt automatically. |

---

## Verification

**Static (pre-commit):**

1. `grep -n 'data-col="lead"\|data-col="pm"' index.html` — must be empty (both columns gone).
2. `grep -n 'team-count\|team-people' index.html` — class names present in CSS and JS.
3. `grep -n 'teamColspan' index.html` — base value updated to `8 +`.
4. `grep -n 'leadDisplay\|pmDisplay' index.html` — only the still-used `pmFull` (tooltip) remains, the `…Display` locals are gone.
5. `grep -n 'function teamPeople' index.html` — helper defined.

**Post-deploy (live URL):**

1. Lead and PM no longer appear as column headers.
2. Team header row reads `CALL (3) · Lead: <name> · PM: <name>` inline.
3. Gantt area is visibly wider — month range extends further right.
4. Hover any task → tooltip still shows Lead and PM Owner.
5. PM filter dropdown lists the same names as before; selecting one filters correctly.
6. Schedule chip, Show Actual toggle, dependency arrows, today line, ideal diamond, tour overlay all still work.
7. Light + dark mode both legible.
8. Smoke check on a team where Lead/PM happens to be empty in some tasks: header renders with the values that exist; no `Lead: ,` or trailing dangling separators.

---

## Out of Scope (Flagged for Future)

- **Editable header** (click team name to edit Lead / PM right there) — out of scope; sheet remains the source of truth.
- **Initial / avatar treatment** of names (e.g., `Y. Yu` instead of full first-last) — kept as full names in this iteration. The header gets infrequent reads, so terseness costs more than it saves.
- **Lead / PM as separate badge rows when many people share a team** (>3 names) — defer until that case actually appears.

---

## Acceptance Criteria

1. `<th data-col="lead">`, `<th data-col="pm">`, `<td data-col="lead">`, `<td data-col="pm">` all removed from `index.html`.
2. `teamPeople(teamTasks)` helper exists and returns `{ leads, pms }` with deduplicated, trimmed values; PM splits on comma.
3. Team-header `<td>` markup includes `<span class="team-count">(N)</span>` and, when applicable, `<span class="team-people">` containing `<span class="role"> · Lead:</span>` / `<span class="role"> · PM:</span>` followed by the joined names. Empty role groups are omitted.
4. Names pass through `escapeHtml`.
5. `teamColspan` base value is `8` (was `10`); the `showExtra` / `showActual` modifiers are unchanged.
6. CSS rules `.team-header .team-count`, `.team-header .team-people`, `.team-header .team-people .role` exist with the values above.
7. Tooltip Lead / PM Owner rows still render per task.
8. PM dropdown filter still functional.
9. CLAUDE.md "Team Header" section reflects the new inline meta + the 2026-05-07 relocation note. The "Show Actual" / "Filters" / "Column Header" sections do not need changes.
