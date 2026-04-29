# Polish Pass — Design Spec

**Date:** 2026-04-29
**Project:** ESL Phase 1 — Dynamic Timeline (`/Users/ab/esl-timeline`)
**Scope:** `index.html` CSS-only polish across three coordinated areas: card flat-ification, Gantt grid simplification, micro-label typography. No JS / data / structural changes (one tiny JS edit in the Gantt grid loop is the only non-CSS line touched).

---

## Background

After shipping the actual-dates surfacing and the What's-New tour (2026-04-28), the user reviewed a second internal dashboard ("Programs Dashboard" by another team) and asked to take a *feeling* — not a copy — of its calmer, more polished tone. The takeaway after comparing: this codebase is leaning on glassmorphism (`backdrop-filter: blur`), busy weekly Gantt grid lines, and casual lowercase labels. Replacing those three with flat cards + month-only grid + uppercase micro-labels (with the existing amber accent kept) lifts the polish without altering any feature or layout.

The polish pass is **for the user's own daily use** (they are part of the audience as a PM). Director-facing was considered as a secondary benefit but not the driver.

---

## Goals

1. Make the dashboard feel calmer and more "data-forward" — chrome should not compete with the data.
2. Drop translucent / blurred chrome that ages quickly and is expensive to render.
3. Tighten up Gantt grid noise so bars and the today line read more clearly.
4. Add micro-label typography polish (uppercase + letter-spacing) on the existing summary card labels for visual hierarchy with the big numbers above them.
5. No regression in any feature behavior, color semantics (P0 red / amber warn), filtering, tour, or theme toggle.

## Non-goals

- No layout / structure changes (no new sections, no removed sections, no column moves).
- No color system overhaul. Amber accent stays; the slate palette stays.
- No font / icon system changes. Inter @ 15px stays.
- No tour overlay changes (caret, popover styling left for a future pass if wanted).
- No light-mode redesign — both modes get the same set of CSS edits, mode-aware via existing CSS variables.
- No accessibility audit beyond the existing patterns.

---

## Change 1 — Flat cards (replace glassmorphism)

Targets: `.summary-card` and `.prd-pm-card` (both currently use the same `rgba + backdrop-filter` glass pattern).

### Before

```css
.summary-card {
  background: rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 16px 14px; text-align: center;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.18),
              inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
```

### After

```css
.summary-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px; text-align: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}
.summary-card:hover {
  border-color: rgba(229, 164, 75, 0.35);                 /* amber-tinted */
  box-shadow: 0 4px 14px rgba(229, 164, 75, 0.10);        /* warm glow */
  transform: translateY(-1px);                            /* lift */
}
body.light-mode .summary-card {
  /* background inherits from var(--bg-card), which is updated in 1.b */
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
}
body.light-mode .summary-card:hover {
  border-color: rgba(229, 164, 75, 0.45);
  box-shadow: 0 3px 10px rgba(229, 164, 75, 0.12);
  transform: translateY(-1px);
}
```

Removed entirely: `backdrop-filter`, `-webkit-backdrop-filter`, the rgba translucent fill, the `inset 0 1px 0` highlight.

`.prd-pm-card` gets the same treatment — drop `backdrop-filter` and the rgba translucent fill, switch to solid `var(--bg-card)` background, subtle `var(--border)` border, soft shadow, and the same amber-tinted hover (border + box-shadow + 1px lift). Border-radius stays at its current 8px (slightly tighter than summary cards is intentional — these are nested inside a parent panel).

### 1.b — Light-mode card surface

Bump `--bg-card` in light mode from `#f7f8fc` to `#ffffff`. With glassmorphism gone, we want the card to read as a clearly elevated surface against the page. `#ffffff` cards on `#dfe3f0` page bg gives the right contrast; `#f7f8fc` was OK with translucent overlay but feels muddy as a solid.

`--bg-elevated` in light mode stays `#eceef7` (still used by team-header rows for contrast).

### Notes

- Hover ring uses `rgba(229, 164, 75, ...)` literal RGB (matches `var(--amber)` = `#e5a44b`). We do not introduce a new CSS variable for this; the literal keeps the rule self-contained.
- `transform: translateY(-1px)` is a common dashboard hover pattern (Linear, Vercel). 1px is the entire range — anything more reads as bouncy.
- Border-radius drops from 12px → 10px for both card classes. 12px was fitting the chunky glass look; 10px sits better on flat surfaces and matches the dashboard reference's tone.

---

## Change 2 — Gantt grid simplification

Drop the weekly vertical grid lines. Keep only month boundaries (slightly bolder) and the today line. Horizontal row separators are unchanged.

### JS (one line)

In the loop that emits `.grid-line` divs inside `.gantt-area` (around `index.html` line 1083):

**Before:**
```js
weeks.forEach(function(w, i) {
  const mb = i > 0 && w.getMonth() !== weeks[i-1].getMonth();
  ganttInner += '<div class="grid-line ' + (mb ? 'grid-line-major' : 'grid-line-minor') + '" style="left:' + (i*weekW) + 'px"></div>';
});
```

**After:**
```js
weeks.forEach(function(w, i) {
  const mb = i > 0 && w.getMonth() !== weeks[i-1].getMonth();
  if (mb) ganttInner += '<div class="grid-line grid-line-major" style="left:' + (i*weekW) + 'px"></div>';
});
```

Weekly lines are simply not emitted any more.

### CSS

Bump `.grid-line-major` opacity in both modes since it's now the only structural grid line (instead of competing with weekly lines for the same role):

```css
.grid-line-major  { background: rgba(255, 255, 255, 0.16); } /* was 0.10 */
body.light-mode .grid-line-major { background: rgba(0, 0, 0, 0.18); } /* was 0.11 */
```

Leave `.grid-line-minor` rule definitions in CSS. They become unused (no DOM elements carry the class), but keeping the CSS makes the change easy to revert if month-only feels too sparse in production.

### Unchanged

- Today line (red 2px vertical) — keeps its current opacity / color. With weekly lines gone it now stands out more naturally.
- Horizontal row separators (`td.gantt-col { border-bottom: 1px solid var(--border) }`) — kept.
- Gantt bars, ideal diamonds, status dots, click-to-Jira — all kept.
- Drawing of dependency arrows (`drawDependencies`) — unaffected (uses bar coordinates, not grid lines).

---

## Change 3 — Micro-label typography

Two coordinated micro-tweaks on `.summary-card`. Both small, but they're what makes the card feel "designed" instead of generic.

### 3.a — Number letter-spacing relaxed

```css
.summary-card .number {
  letter-spacing: -0.02em;  /* was -0.03em */
}
```

`-0.03em` over-tightens digits that already sit close together. `-0.02em` keeps the elegant look without the "smooshed" feeling on cases like `2 / 27` where two numerals sit right next to a slash.

### 3.b — Label as proper micro-label

```css
.summary-card .label {
  font-size: 11px;                /* unchanged */
  color: var(--text-muted);       /* unchanged */
  margin-top: 8px;                /* was 6px */
  font-weight: 600;               /* was 500 */
  text-transform: uppercase;      /* new */
  letter-spacing: 0.06em;         /* new */
}
```

Goal: card labels read like deliberate micro-labels (matches the existing STATUS / SCHEDULE strip headers, which already use this exact treatment). Side effect: caps + tracking makes 11px appear visually a touch larger / more present, so we do not need to bump font size.

### Unchanged

- Status / Schedule strip headers — already uppercase 10px / 0.07em, which is the model for 3.b.
- Tour `What's New X / Y` step counter — already uppercase 10px / 0.08em.
- Column headers — already uppercase 12px / 0.07em.
- Body font / size / weight — Inter 15px regular, unchanged.

---

## Theme & accessibility

- Both changes 1 and 3 propagate naturally to dark and light modes via the existing CSS variable system. Light-mode-specific overrides (where needed) are added side-by-side with the dark-mode rules.
- `transform: translateY(-1px)` does not affect surrounding layout (transforms don't reflow). It is also fine with `prefers-reduced-motion` since the transition is short and small. No explicit `prefers-reduced-motion` guard added — we trust the OS toggle to be honored by the browser at the engine level.
- Amber-tinted hover ring (`rgba(229, 164, 75, 0.35)`) has acceptable contrast against both `#161b27` (dark card) and `#ffffff` (light card) for non-text decorative purposes.

---

## Implementation Surface

- **Files touched**: `index.html` only.
  - CSS edits: `.summary-card` block (around line 79), `.prd-pm-card` block (around line 116), light-mode overrides (around line 360-380), `.grid-line-major` rule (around line 333 and 386), `--bg-card` light-mode value (around line 362).
  - JS edit: one line inside `buildTaskRow` / `buildTimeline` Gantt grid loop (around line 1083) — convert the grid-line emit to month-only.
- **No changes** to `webApp.gs`, `syncNotionToSheets.gs`, sheet schema, Notion DB, or any data flow.
- **CLAUDE.md update** (in same change): a short note under `### UI / Theme` and `### Summary Cards (buildSummary)` to flag the move from glassmorphism to flat, the Gantt grid simplification, and the micro-label tweak. Keeps file as the source of truth.
- **Deployment**: Apps Script redeploy required as usual.

---

## Verification Plan

No automated tests in this project; verification is static + post-deploy visual.

**Static (pre-commit):**

1. `grep -n "backdrop-filter" index.html` → should return 0 matches (we removed all glass blur).
2. `grep -n "rgba(255, 255, 255, 0.04)\|rgba(255, 255, 255, 0.55)" index.html` → 0 matches against card backgrounds (this rgba pattern was the glass tell-tale).
3. `grep -n "grid-line-minor" index.html` → CSS rules still present, but no DOM-emitting code. The string should not appear inside any `'<div class="...' + ...` template literal.
4. `grep -n "summary-card .label" index.html` → confirms uppercase / letter-spacing rules are present.

**Post-deploy visual (live URL):**

1. Default (dark) load — top summary cards: solid background, soft shadow, no blur. Hover any card: amber-tinted border + tiny lift.
2. PRD by PM section: cards have the same flat treatment.
3. Toggle to light mode: cards are clearly white on the light page bg; hover effect still visible (warmer / softer).
4. Gantt area: weekly vertical lines gone. Month labels still readable. Today line stands out in red.
5. Bars, ideal diamonds, status dots, dependency arrows: unchanged.
6. Card labels read as `COMPLETE / TOTAL`, `P0 COMPLETE / TOTAL`, `WEEKS ELAPSED / TOTAL`, etc. (uppercase + tracked).
7. P0 number is still red. Past Ideal Date number is still amber when > 0.
8. Tour overlay still works (open via Guide button).
9. Spot-check on a smaller viewport — flat cards still legible without translucent fallback.

---

## Out of Scope (Flagged for Future)

- **Tour popover caret** — the reference dashboard's popover has a 45° rotated square as a caret pointing at the spotlight. Could add to ours later if directionality cues feel needed.
- **Larger color system rework** — switching to slate-only or introducing lavender as a secondary accent. Not for this pass.
- **Font / icon system swap** — sticking with Inter and emoji-style markers.
- **Mobile / narrow viewport pass** — separate concern.
- **prd-alert (banner)** redesign — uses a different pattern (left-bordered amber callout); deliberately left untouched.

---

## Acceptance Criteria

1. `.summary-card` and `.prd-pm-card` have no `backdrop-filter` declarations and no rgba translucent backgrounds. They use solid `var(--bg-card)`, subtle `var(--border)`, and soft shadows.
2. Cards have an amber-tinted hover state with `translateY(-1px)`. Both modes.
3. `--bg-card` in light mode is `#ffffff` (was `#f7f8fc`).
4. The Gantt rendering loop emits a grid line **only** at month boundaries; weekly verticals are not emitted.
5. `.grid-line-major` opacity is bumped (`0.16` dark / `0.18` light); today line and horizontal row separators are unchanged.
6. `.summary-card .number` uses `letter-spacing: -0.02em`.
7. `.summary-card .label` is rendered uppercase with `letter-spacing: 0.06em`, `font-weight: 600`, `margin-top: 8px`. Font size stays `11px`.
8. No regressions: tour, Show Actual toggle, Plan/Act columns, dependency arrows, theme toggle, sort, filters all behave as before.
9. CLAUDE.md mentions the polish pass under the relevant sections.
