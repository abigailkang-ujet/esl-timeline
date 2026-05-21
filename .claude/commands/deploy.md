# Deploy ESL Timeline

Deploy the current code to Google Apps Script.

## Steps

1. **Pre-deploy check**: Read `CLAUDE.md` "File Status" section to confirm which files are deployed.

2. **Diff check**: Run `git diff --stat` to see what changed since last commit. Summarize the changes clearly in Korean.

3. **Known gotcha scan** — Before deploying, grep the changed files for these known issues and FIX if found:
   - Backticks (template literals) in `index.html` → MUST use `array.join()` or string concat instead. HtmlService breaks on backticks.
   - Static `<svg>` tags in HTML → MUST create SVG dynamically via JS.
   - Hardcoded tokens (jiraToken, notionToken) → MUST be in Script Properties only.
   - `GET /rest/api/3/search` → MUST use `POST /rest/api/3/search/jql` (GET was sunset 2025-05-01).
   - Column reads by header name in scenario tabs → scenario tabs use COLUMN POSITION, not header name.

4. **Generate deploy instructions**: Since `clasp` is not installed, output a step-by-step paste guide:
   ```
   배포 순서:
   1. Apps Script 에디터 열기 (script.google.com)
   2. [변경된 파일명] 의 내용을 에디터에 붙여넣기 (기존 내용 전체 삭제 후)
   3. 저장 (Ctrl+S)
   4. Deploy → Manage deployments → 연필 아이콘 → Version: New version → Deploy
   5. 브라우저에서 live URL 새로고침하여 확인
   ```

5. **Post-deploy checklist**: List what to visually verify based on the changes made.

6. **Offer to commit**: Ask if the user wants to commit the changes.

## Important
- Live URL: https://script.google.com/a/macros/ujet.cx/s/AKfycbzFRDFEpOfH47DNCXgf1hruIzrI-B951nYqFj_6I-7_9cQHEJMQkt8TnZuFrns9a4sD/exec
- Data-only changes (Sheets) do NOT need redeploy — just refresh.
- Always create a New Version, never a New Deployment (preserves the stable URL).
