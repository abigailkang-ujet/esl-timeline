# Refactoring: jira_url as Primary Key

**Status**: ✅ Completed 2026-04-27 (started 2026-04-24)
**Goal**: Eliminate fragile ROW()/task-name joins across Sheets + simplify syncNotionToSheets.gs

## Outcome

- All three tabs (Notion_raw, Overall, Realistic Scenario) now key on `jira_url`
- `ROW()`-based formulas and `MATCH(task_name; …)` patterns fully removed
- `syncNotionToSheets.gs` simplified from 933 → 787 lines (146 lines removed)
- In-place update / `claimedRows` / matching-priority logic deleted
- Notion_raw row order is now irrelevant; manual data in Overall is anchored to jira_url
- Validated: sorting Notion_raw does not break any downstream tab
- Auto-deployment of new tasks via `ensureOverallAnchors()` (called automatically at end of every sync)

---

## Problem Statement

The current Sheets data model makes joins fragile in two ways:

### 1. Task-name based lookup

Overall tab uses `MATCH(B2; Notion_raw!J:J; 0)` where `B2` is the task name. When anyone renames a task in Jira (which propagates through Notion → Notion_raw), the match breaks and Overall shows wrong/empty values for that row.

### 2. ROW()-based fallback (the bigger problem)

```
=IF(B2<>"";
  INDEX(Notion_raw!A:Z; MATCH(B2; Notion_raw!J:J; 0); MATCH("Priority"; Notion_raw!$1:$1; 0));
  INDEX(Notion_raw!A:Z; ROW(); MATCH("Priority"; Notion_raw!$1:$1; 0))
)
```

The `INDEX(...; ROW(); ...)` fallback means:
- **Overall's row N is implicitly bound to Notion_raw's row N**
- Manual columns (Lead Engineer, Allocation, Headcount, Risk, Optimistic) entered on row N are bound to whatever Notion task happens to be on Notion_raw row N
- If Notion_raw rows shuffle, **manual data silently attaches to the wrong task**

This is the reason syncNotionToSheets.gs contains all its complexity: in-place update, `claimedRows` guard, matching priority (URL > Notion_ID > name) — all of it exists to preserve row order so the ROW() fallback keeps working. The fragility is not in the sync script; it is in the Sheets schema the sync script is trying to protect.

### 3. Realistic Scenario's task-name XLOOKUP

`=XLOOKUP(C3; Overall!$C:$C; Overall!$A:$A)` — still keyed on task name. Same fragility if task names drift.

---

## Target State

### Overall tab — new column layout

| Col | Name | Source | Notes |
|-----|------|--------|-------|
| A | `jira_url` | **Manual / static** | PK. Row identity. |
| B | Priority | `=XLOOKUP($A2; Notion_raw!<url_col>; Notion_raw!<priority_col>; "")` | |
| C | task | `=XLOOKUP($A2; Notion_raw!<url_col>; Notion_raw!<task_col>; "")` | display only |
| D | Ideal Delivery | `=XLOOKUP($A2; Notion_raw!<url_col>; Notion_raw!<ideal_col>; "")` | |
| E | T-shirt size | `=XLOOKUP($A2; Notion_raw!<url_col>; Notion_raw!<tshirt_col>; "")` | |
| F+ | Lead Engineer, Allocation, Headcount, Risk factor, Optimistic scenario | Manual input | Bound to jira_url (not row number) |

**Invariants that hold after this change:**
- A task's manual data stays with that task even if Notion_raw is reordered, resorted, or a row is deleted+reappended
- A task rename in Jira → Notion → Notion_raw changes column C (display) but breaks nothing

### Realistic Scenario tab

Replace `=XLOOKUP(C3; Overall!$C:$C; Overall!$A:$A)` with `=XLOOKUP($<jira_url_col>3; Overall!$A:$A; Overall!<target_col>)`.

### Auto-appear mechanism (`ensureOverallAnchors()`)

Currently, new tasks "auto-appear" in Overall because Notion_raw has a new row and the ROW() formula reflects it. After the refactor, this is replaced by a script helper:

```javascript
function ensureOverallAnchors() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const overall = ss.getSheetByName('Overall');
  const raw = ss.getSheetByName('Notion_raw');

  const rawUrls = getColumnValues_(raw, 'JIRA');          // jira_url column from Notion_raw
  const existingUrls = new Set(getColumnValues_(overall, 'jira_url'));

  const missing = rawUrls.filter(u => u && !existingUrls.has(u));
  if (missing.length === 0) return;

  const firstEmptyRow = overall.getLastRow() + 1;
  overall.getRange(firstEmptyRow, 1, missing.length, 1)
         .setValues(missing.map(u => [u]));
  // Manual columns remain empty until filled in by a human
}
```

Called at the end of `syncNotionToSheets.gs` so user-perceived behavior (new tasks auto-appear) is preserved.

### syncNotionToSheets.gs — post-refactor shape

Once the PK transition is validated, the sync script collapses to approximately:

```javascript
function syncNotionToSheets() {
  const pages = fetchAllNotionPages_(DB_ID);
  const rows = pages.map(pageToRow_);
  const sheet = ss.getSheetByName('Notion_raw');
  sheet.getRange(2, 1, sheet.getMaxRows()-1, sheet.getMaxColumns()).clearContent();
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  ensureOverallAnchors();
}
```

Logic removed:
- In-place update (`findMatchingRow_`, partial write by column)
- `claimedRows` guard
- Matching priority (URL > Notion_ID > name)
- Row order preservation

---

## Migration Plan (7 steps, each independently revertible)

### Step 0 — Prerequisite
Confirm Notion_raw's jira_url column letter (currently column J is task name; jira_url is a different column — exact letter TBD).

### Step 1 — Add `jira_url` anchor column to Overall
- Insert a new column A, header `jira_url`
- Temporarily fill with `=INDEX(Notion_raw!<url_col>:<url_col>; ROW())` for existing rows
- **Copy → Paste values only** to freeze the column as static strings
- Verify: every existing row in Overall has a jira_url value

### Step 2 — Replace Overall lookup formulas
Replace B~E (Priority, task, Ideal Delivery, T-shirt) with XLOOKUP by `$A2`:
```
=XLOOKUP($A2; Notion_raw!<url_col>:<url_col>; Notion_raw!<target_col>:<target_col>; "")
```
Delete all `IF(B2<>"";...;INDEX(...;ROW();...))` patterns. Delete `MATCH(B2; Notion_raw!J:J; 0)` patterns.

### Step 3 — Update Realistic Scenario XLOOKUPs

**Primary pattern** (Jira'd tasks):
```
=XLOOKUP($<jira_url_col>3; Overall!$A:$A; Overall!<target_col>)
```

**Hybrid pattern (required) — jira_url primary, task-name fallback for pre-Jira tasks:**
```
=IFERROR(
  XLOOKUP($<jira_url_col>3; Overall!$A:$A; Overall!$<target_col>:$<target_col>);
  XLOOKUP($<task_name_col>3; Overall!$C:$C; Overall!$<target_col>:$<target_col>; "")
)
```

**Rationale**: Some tasks in Overall have no `jira_url` yet (PM-created placeholders before the Jira ticket is filed). These rows still carry manually-set priority/ideal-delivery/etc. Pure `XLOOKUP` by jira_url would return `#N/A` for them.

**Why this does not reintroduce general fragility**:
- For any row with `jira_url`, the first `XLOOKUP` matches immediately → fallback never fires → task-name rename in Jira/Notion is harmless
- Fallback only triggers when `jira_url` is blank on both sides (pre-Jira task)
- Pre-Jira tasks are user-managed placeholders with short lifespan (promoted to real Jira shortly); the rename-break risk is bounded to this narrow window

**Decision log (2026-04-24)**: Option 2 (hybrid fallback) chosen over Option 1 (synthetic DRAFT IDs) for operational simplicity. Accepted tradeoff: limited task-name-rename fragility for pre-Jira tasks only.

### Step 4 — Add `ensureOverallAnchors()`
- Write the helper function in `syncNotionToSheets.gs`
- Append call at end of `runSync()` / `syncNotionToSheets()`
- Manual test: delete a row from Overall, run sync, verify row reappears with empty manual columns

### Step 5 — Validation
- Reorder Notion_raw rows manually (sort by task name, then by priority, then reverse)
- After each reorder: verify Overall's manual columns (Lead, Allocation, Headcount, Risk, Optimistic) stay attached to the correct task
- Verify Realistic Scenario still resolves correct values

### Step 6 — Remove sync script complexity
After Step 5 passes, remove from `syncNotionToSheets.gs`:
- in-place update logic
- `claimedRows` guard
- Matching priority (URL > Notion_ID > name)
- Row-order preservation code

Replace with straightforward clear+dump + `ensureOverallAnchors()`.

### Step 7 — Post-refactor cleanup
- Remove `diagnoseDoubleMatch()` (no longer relevant with clean PK)
- Simplify `compareNotionVsSheets()` — diff is now just set difference on jira_url
- Update CLAUDE.md "webApp.gs Core Logic" to remove `byName` fallback (URL-only join)

---

## Rollback Plan

Each step is reversible:

| Step | Rollback |
|------|----------|
| 1 | Delete new column A |
| 2 | Restore old formulas from version history (Sheets File → Version history) |
| 3 | Restore old formulas from version history |
| 4 | Remove `ensureOverallAnchors()` call from sync |
| 5 | (validation only, nothing to roll back) |
| 6 | Git revert `syncNotionToSheets.gs` |
| 7 | Git revert `syncNotionToSheets.gs` / `webApp.gs` / `CLAUDE.md` |

Do not proceed past Step 5 unless validation is explicitly green.

---

## Key Rules Going Forward

1. **jira_url is the only primary key** — never use task name or row number as a join key
2. **No ROW() fallback** — once removed, do not reintroduce
3. **No MATCH(task_name; …)** — use XLOOKUP by jira_url
4. **Sync scripts are not responsible for row order** — Sheets schema is now order-independent
5. When writing any new formula, ask: "does this still work if Notion_raw is reordered?" before committing
