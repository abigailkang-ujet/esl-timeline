# Deploy ESL Timeline

Deploy the current code to Google Apps Script.

## Steps

1. **Pre-deploy check**: Read `CLAUDE.md` "File Status" section to confirm which files are deployed.

2. **Diff check**: Run `git diff --stat` to see what changed since last commit. Summarize the changes clearly in Korean.

3. **Known gotcha scan** — Before deploying, grep the changed files for these known issues and FIX if found:
   - Backticks (template literals) in `index.html` → MUST use `array.join()` or string concat instead. HtmlService breaks on backticks. (Backticks inside comments are fine — several pre-existing ones are deployed.)
   - Static `<svg>` tags in HTML → MUST create SVG dynamically via JS.
   - Hardcoded tokens (jiraToken, notionToken) → MUST be in Script Properties only.
   - `GET /rest/api/3/search` → MUST use `POST /rest/api/3/search/jql` (GET was sunset 2025-05-01).
   - Column reads by header name in scenario tabs → scenario tabs use COLUMN POSITION, not header name.

4. **Deploy via clasp** (verified working 2026-07-22 — Claude can deploy directly, no GAS Commander needed):
   ```bash
   # Deploy clone: ~/Desktop/esl-timeline (has .clasp.json with scriptId; main repo doesn't)
   cd /Users/ab/Desktop/esl-timeline
   git pull origin main          # clone lags behind — ALWAYS pull first
   clasp push -f                 # pushes index.html, webApp.gs, syncNotionToSheets.gs, syncToNotion.gs, appsscript.json
   clasp deploy -i AKfycbyWEzYulBTWKo-xeI31d1EHi2Wd44uLZfjbYpKZb6jeEwc1mb10druyfdfnVSbbPhXI -d "<description>"
   ```
   - The `-i` deployment ID is MANDATORY — it creates a New Version on the existing deployment, preserving the stable URL. Omitting it creates a new deployment with a NEW URL (this is how the original URL was lost on 2026-05-26).
   - clasp auth: already logged in as abigail.kang@ujet.cx (`clasp show-authorized-user` to verify).
   - GitHub push must happen BEFORE the pull in the deploy clone.

5. **Post-deploy checklist**: List what to visually verify based on the changes made. Note: Claude cannot verify the live URL itself (curl hits UJET SSO; Browser pane blocks script.google.com) — ask the user to refresh and eyeball.

6. **Commit**: Commit and push before deploying (git main is the source of truth the deploy clone pulls from).

## Important
- Live URL: https://script.google.com/a/macros/ujet.cx/s/AKfycbyWEzYulBTWKo-xeI31d1EHi2Wd44uLZfjbYpKZb6jeEwc1mb10druyfdfnVSbbPhXI/exec
- Data-only changes (Sheets) do NOT need redeploy — just refresh.
- Always a New Version on the existing deployment ID, never a New Deployment (preserves the stable URL).
