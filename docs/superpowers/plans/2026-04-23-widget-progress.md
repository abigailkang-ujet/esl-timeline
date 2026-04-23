# Widget Progress Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert three summary cards (Tasks / P0 / PRD) to `X / Y` progress format, rename the dev-weeks card to `Program Weeks` with calendar-duration semantics.

**Architecture:** Pure frontend change inside `index.html`. Add small CSS rules for the muted-denominator look, add three tiny helper functions next to `getPrdState()`, and rewrite the Row 1 `innerHTML` in `buildSummary()`. No change to data pipeline, `webApp.gs`, `syncNotionToSheets.gs`, or sheet/Notion schemas.

**Tech Stack:** Vanilla JS (string concatenation — **no template literals**, per CLAUDE.md), CSS. Deployed via Google Apps Script `HtmlService`.

**Spec reference:** `docs/superpowers/specs/2026-04-23-widget-progress-design.md`

**Execution notes for Claude:**
- This project has no unit-test framework. Verification is static (grep/read) + post-deploy visual check.
- Apps Script deployment is manual — the user must paste into the Apps Script editor and redeploy. Claude stops at "committed and ready to deploy" and hands off.
- `parseDate()` exists at `index.html:340` and handles `YYYY-MM-DD` plus arbitrary parseable date strings.
- `ALL_TASKS` is a global populated by HtmlService templating (`tpl.timelineData`). All helpers read from it directly.

---

## File Structure

Single file modified: `/Users/ab/esl-timeline/index.html`

Three zones are touched, in this order:

| Zone | Location (approx) | Responsibility |
|------|-------------------|----------------|
| CSS  | after line 89 (inside `<style>`, in `.summary-card` rule group) | Muted `/ Y` appearance + empty-state opacity |
| Helpers | after line 1057 (right after `getPrdState()`) | Pure functions: `prdIsDone`, `prdIsRequired`, `programSpanWeeks` |
| `buildSummary()` Row 1 | lines 591–597 (inside `buildSummary`) | New card HTML with X/Y structure |

No new files created.

---

## Task 1: Add CSS for X/Y rendering

**Files:**
- Modify: `/Users/ab/esl-timeline/index.html` — after line 89

- [ ] **Step 1: Read the CSS anchor to confirm line numbers**

Run: `sed -n '78,90p' /Users/ab/esl-timeline/index.html` (via Bash, or Read tool with offset=78 limit=13).
Expected: last line visible is `.summary-card.danger .number { color: var(--red); }` on line 89.

- [ ] **Step 2: Insert new CSS rules after line 89**

Use Edit tool. Target `old_string` should be the exact line 89 content plus surrounding to be unique:

```
  .summary-card.warn .number { color: var(--amber); }
  .summary-card.danger .number { color: var(--red); }

  /* ── PRD Alert banner ── */
```

Replace with:

```
  .summary-card.warn .number { color: var(--amber); }
  .summary-card.danger .number { color: var(--red); }
  .summary-card .num-total {
    font-size: 0.6em; color: var(--text-muted); font-weight: normal; letter-spacing: normal;
  }
  .summary-card.is-empty { opacity: 0.5; }

  /* ── PRD Alert banner ── */
```

- [ ] **Step 3: Verify the insertion**

Run: `grep -n "num-total\|is-empty" /Users/ab/esl-timeline/index.html`
Expected: two matches, both in the `<style>` block (line numbers in the 90s).

---

## Task 2: Add helper functions

**Files:**
- Modify: `/Users/ab/esl-timeline/index.html` — after `getPrdState()` (ends at line 1057)

- [ ] **Step 1: Confirm the anchor**

Run: `sed -n '1048,1058p' /Users/ab/esl-timeline/index.html`
Expected: `getPrdState()` definition ending with `return 'missing'; }` on line 1057, followed by `function buildScheduleBadge(t)` on line 1058.

- [ ] **Step 2: Insert helpers between getPrdState and buildScheduleBadge**

Use Edit tool. `old_string`:

```
  return 'missing';
}
function buildScheduleBadge(t) {
```

`new_string`:

```
  return 'missing';
}

function isClosed(t) { return t && t.status === 'Closed'; }
function prdIsDone(t) { return !!(t && t.pm) && getPrdState(t.prd) === 'done'; }
function prdIsRequired(t) { return !!(t && t.pm) && getPrdState(t.prd) !== 'na'; }

function programSpanWeeks() {
  var starts = [], ends = [];
  for (var i = 0; i < ALL_TASKS.length; i++) {
    var s = parseDate(ALL_TASKS[i].start);
    var e = parseDate(ALL_TASKS[i].end);
    if (s) starts.push(s.getTime());
    if (e) ends.push(e.getTime());
  }
  if (!starts.length || !ends.length) return null;
  var span = Math.max.apply(null, ends) - Math.min.apply(null, starts);
  if (span <= 0) return 1;
  return Math.ceil(span / (7 * 24 * 60 * 60 * 1000));
}

function buildScheduleBadge(t) {
```

- [ ] **Step 3: Verify all five functions landed**

Run: `grep -n "^function isClosed\|^function prdIsDone\|^function prdIsRequired\|^function programSpanWeeks" /Users/ab/esl-timeline/index.html`
Expected: exactly 4 matches (one per new function).

- [ ] **Step 4: Check no template literals were accidentally introduced**

Run: `grep -n '`' /Users/ab/esl-timeline/index.html | grep -v "'"`
Expected: should match the existing count (run this BEFORE Step 2 to baseline). New count must equal old count. CLAUDE.md rule: **no backticks inside index.html** — HtmlService parser breaks on them.

---

## Task 3: Rewrite buildSummary Row 1 HTML

**Files:**
- Modify: `/Users/ab/esl-timeline/index.html` — lines ~591 to ~598 (the Row 1 `innerHTML` block inside `buildSummary()`)

- [ ] **Step 1: Confirm the anchor**

Run: `sed -n '588,600p' /Users/ab/esl-timeline/index.html`
Expected:
```
  // ── Row 1: 기존 요약 카드 ──
  const row1 = document.createElement('div');
  row1.className = 'summary-cards';
  row1.innerHTML =
    '<div class="summary-card"><div class="number">' + ALL_TASKS.length + '</div><div class="label">Total Tasks</div></div>' +
    ...
    '<div class="summary-card"><div class="number">' + totalEffort + '</div><div class="label">Total Dev Weeks</div></div>';
  wrap.appendChild(row1);
```

- [ ] **Step 2: Replace the block**

Use Edit tool. `old_string`:

```
  // ── Row 1: 기존 요약 카드 ──
  const row1 = document.createElement('div');
  row1.className = 'summary-cards';
  row1.innerHTML =
    '<div class="summary-card"><div class="number">' + ALL_TASKS.length + '</div><div class="label">Total Tasks</div></div>' +
    '<div class="summary-card"><div class="number" style="color:var(--red)">' + ALL_TASKS.filter(function(t){return t.priority==='P0';}).length + '</div><div class="label">P0 Tasks</div></div>' +
    '<div class="summary-card ' + (atRisk>0?'warn':'') + '"><div class="number">' + atRisk + '</div><div class="label">Past Ideal Date</div></div>' +
    '<div class="summary-card ' + (noPrd>0?'danger':'') + '"><div class="number">' + noPrd + '</div><div class="label">PRD Needed</div></div>' +
    '<div class="summary-card"><div class="number">' + TEAM_ORDER.filter(function(t){return ALL_TASKS.some(function(task){return getTeamKey(task.team||'')===t;});}).length + '</div><div class="label">Teams</div></div>' +
    '<div class="summary-card"><div class="number">' + totalEffort + '</div><div class="label">Total Dev Weeks</div></div>';
  wrap.appendChild(row1);
```

`new_string`:

```
  // ── Row 1: 요약 카드 (progress X/Y format) ──
  const tasksDone = ALL_TASKS.filter(isClosed).length;
  const tasksTotal = ALL_TASKS.length;

  const p0All = ALL_TASKS.filter(function(t){ return t.priority === 'P0'; });
  const p0Done = p0All.filter(isClosed).length;
  const p0Total = p0All.length;

  const prdDone = ALL_TASKS.filter(prdIsDone).length;
  const prdRequired = ALL_TASKS.filter(prdIsRequired).length;

  const teamsCount = TEAM_ORDER.filter(function(t){
    return ALL_TASKS.some(function(task){ return getTeamKey(task.team || '') === t; });
  }).length;

  const progWeeks = programSpanWeeks();
  const progWeeksDisplay = (progWeeks === null) ? '—' : String(progWeeks);

  // helper for "X / Y" number markup
  function xy(doneN, totalN, doneColor) {
    var colorAttr = doneColor ? ' style="color:' + doneColor + '"' : '';
    return '<span' + colorAttr + '>' + doneN + '</span>' +
           '<span class="num-total"> / ' + totalN + '</span>';
  }
  function emptyCls(totalN) { return (totalN === 0) ? ' is-empty' : ''; }

  const row1 = document.createElement('div');
  row1.className = 'summary-cards';
  row1.innerHTML =
    '<div class="summary-card' + emptyCls(tasksTotal) + '"><div class="number">' + xy(tasksDone, tasksTotal) + '</div><div class="label">Complete / Total</div></div>' +
    '<div class="summary-card' + emptyCls(p0Total) + '"><div class="number">' + xy(p0Done, p0Total, 'var(--red)') + '</div><div class="label">P0 Complete / Total</div></div>' +
    '<div class="summary-card ' + (atRisk>0?'warn':'') + '"><div class="number">' + atRisk + '</div><div class="label">Past Ideal Date</div></div>' +
    '<div class="summary-card' + emptyCls(prdRequired) + '"><div class="number">' + xy(prdDone, prdRequired) + '</div><div class="label">PRD Complete / Required</div></div>' +
    '<div class="summary-card"><div class="number">' + teamsCount + '</div><div class="label">Teams</div></div>' +
    '<div class="summary-card"><div class="number">' + progWeeksDisplay + '</div><div class="label">Program Weeks</div></div>';
  wrap.appendChild(row1);
```

- [ ] **Step 3: Verify the old strings are gone and new strings are present**

Run:
```
grep -n "Total Tasks\|Total Dev Weeks\|PRD Needed" /Users/ab/esl-timeline/index.html
```
Expected: no matches inside `buildSummary()`. (Might still match unrelated places — check surrounding context.)

Run:
```
grep -n "Complete / Total\|PRD Complete / Required\|Program Weeks" /Users/ab/esl-timeline/index.html
```
Expected: three new label strings present.

- [ ] **Step 4: Check old count variables are no longer dead**

The old code declared `noPrd` and `totalEffort` up at the top of `buildSummary()`. After this rewrite, `noPrd` is no longer used by Row 1 logic. Check:

Run: `sed -n '579,586p' /Users/ab/esl-timeline/index.html`
Expected output (the top of buildSummary):
```
  const noPrd = ALL_TASKS.filter(function(t) {
    if (!t.pm) return false;
    var s = getPrdState(t.prd);
    return s === 'missing' || s === 'draft' || s === 'review' || s === 'todo';
  }).length;
  const totalEffort = tasks.reduce(function(s, t) { return s + t.effort; }, 0);
```

`noPrd` is now unused (PRD card uses `prdDone`/`prdRequired`). `totalEffort` is unused (Program Weeks replaced it). **Remove both dead consts** to keep the function clean:

Use Edit tool. `old_string`:

```
  const noPrd = ALL_TASKS.filter(function(t) {
    if (!t.pm) return false;
    var s = getPrdState(t.prd);
    return s === 'missing' || s === 'draft' || s === 'review' || s === 'todo';
  }).length;
  const totalEffort = tasks.reduce(function(s, t) { return s + t.effort; }, 0);

  const wrap = document.createElement('div');
```

`new_string`:

```
  const wrap = document.createElement('div');
```

- [ ] **Step 5: Verify `tasks` (filtered list used by atRisk) is still used**

Run: `grep -n "const tasks = ALL_TASKS.filter\|const atRisk = tasks.filter" /Users/ab/esl-timeline/index.html`
Expected: both lines present (they drive the Past Ideal Date card, which is unchanged).

---

## Task 4: Static correctness checks

No unit tests exist in this project. Perform these deterministic checks before committing.

- [ ] **Step 1: No stray backticks (CLAUDE.md hard rule)**

Run: `grep -c '`' /Users/ab/esl-timeline/index.html`
Expected: `0`. If not 0, the edits introduced template literals — fix by converting to single-quoted string concatenation.

- [ ] **Step 2: Count `.summary-card` divs rendered in Row 1**

Run: `grep -o "summary-card" /Users/ab/esl-timeline/index.html | wc -l`
Expected: baseline count + 0. The number of `.summary-card` occurrences inside `buildSummary()` should still be 6 (for the 6 cards in Row 1). Verify by reading the function:

Run: `sed -n '573,645p' /Users/ab/esl-timeline/index.html | grep -c '<div class="summary-card'`
Expected: `6`.

- [ ] **Step 3: Confirm no references to removed identifiers**

Run: `grep -n "\bnoPrd\b\|\btotalEffort\b" /Users/ab/esl-timeline/index.html`
Expected: `no matches`. If either name appears, either revert the Task 3 Step 4 deletion or remove the remaining reference.

- [ ] **Step 4: Spot-check the rendered function by reading it**

Run: Read tool on `/Users/ab/esl-timeline/index.html`, offset=573, limit=75.
Expected: `buildSummary()` is self-consistent — all variables used are declared, all six cards present, labels match the spec table.

---

## Task 5: Commit and hand off to user for deployment

- [ ] **Step 1: Check git state**

Run: `git -C /Users/ab/esl-timeline status`
Expected: `index.html` modified, nothing else staged unexpectedly.

- [ ] **Step 2: View the diff one more time**

Run: `git -C /Users/ab/esl-timeline diff index.html | head -200`
Expected: only the three zones changed (CSS add, helper functions, buildSummary Row 1 rewrite + dead const removal).

- [ ] **Step 3: Stage and commit**

Run:
```
git -C /Users/ab/esl-timeline add index.html
git -C /Users/ab/esl-timeline commit -m "$(cat <<'EOF'
Summary cards: show progress as X/Y and add Program Weeks

- Tasks, P0, PRD cards now render "done / total" with muted denominator
- Sub-labels clarify direction: "Complete / Total", "P0 Complete / Total",
  "PRD Complete / Required"
- Total Dev Weeks renamed to Program Weeks; value is calendar span of the
  program (earliest task start to latest task end) instead of effort sum
- Empty categories (Y=0) render at 50% opacity
- Past Ideal Date and Teams cards unchanged

Spec: docs/superpowers/specs/2026-04-23-widget-progress-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Push**

Run: `git -C /Users/ab/esl-timeline push`
Expected: push succeeds to `origin/main`.

- [ ] **Step 5: Hand-off message to user**

Claude does not deploy to Apps Script. Write a message to the user containing:
- The commit pushed
- Deployment steps to confirm manually:
  1. Open the Apps Script project
  2. Replace `index.html` contents with the file from the repo
  3. **Deploy → Manage deployments → (existing deployment) → Edit → Version: New version → Deploy** (this preserves the existing URL per CLAUDE.md)
  4. Reload the live URL
- Post-deploy visual checklist:
  - Row 1 shows six cards: Tasks, P0, Past Ideal Date, PRD, Teams, Program Weeks
  - Tasks / P0 / PRD cards display `X / Y` with `/ Y` visibly smaller and muted
  - P0 numerator is red
  - Sub-labels read exactly: `Complete / Total`, `P0 Complete / Total`, `Past Ideal Date`, `PRD Complete / Required`, `Teams`, `Program Weeks`
  - Program Weeks number is roughly the calendar duration of the project (not ~104)
  - Theme toggle (dark ↔ light) still renders both modes cleanly
  - Status pill filtering below Row 1 still works unchanged

---

## Out of Scope (do not implement here)

- Single portfolio-level dashboard (separate spec to come).
- Filter-aware summary (cards stay global to `ALL_TASKS`).
- `clasp` CLI setup for automated deploy.
- Any change to `webApp.gs`, `syncNotionToSheets.gs`, `timeline.html`.
