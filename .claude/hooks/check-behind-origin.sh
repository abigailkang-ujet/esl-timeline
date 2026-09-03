#!/usr/bin/env bash
# SessionStart hook — warn when this clone is behind origin/main.
#
# Added 2026-09-03: a session started on a clone that was 30 commits (two
# months) stale, including a Live-URL rotation. Nothing surfaced it until the
# user happened to ask. This makes the gap loud at session start instead.
#
# Fails open everywhere: no network, no remote, detached HEAD, not a repo —
# all exit 0 silently. A hook that blocks startup is worse than a stale clone.
set -u

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

git fetch origin main --quiet >/dev/null 2>&1

behind=$(git rev-list --count HEAD..origin/main 2>/dev/null) || exit 0
case "$behind" in ''|*[!0-9]*) exit 0 ;; esac
[ "$behind" -gt 0 ] || exit 0

# Oldest unpulled commit's date — turns "30 commits" into "since 2026-05-26".
since=$(git log --format=%ad --date=short HEAD..origin/main 2>/dev/null | tail -1)
[ -n "$since" ] && since=" (oldest unpulled: $since)"

printf '{"systemMessage":"esl-timeline: local is %s commit(s) behind origin/main%s. Run: git pull --ff-only","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"This clone is %s commit(s) behind origin/main%s. Tell the user before editing, deploying, or answering questions about project state, and suggest git pull --ff-only first. Deploying from a stale clone would push outdated code to the live Apps Script URL."}}\n' \
  "$behind" "$since" "$behind" "$since"
