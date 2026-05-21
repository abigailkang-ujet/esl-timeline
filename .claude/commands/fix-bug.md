# Fix Bug in ESL Timeline

ESL Timeline 버그를 수정합니다. $ARGUMENTS 에 버그 설명이 들어옵니다.

## Diagnosis process

1. **CLAUDE.md "Known Bugs & Fixes" 섹션 확인**: 이미 알려진 버그인지 먼저 체크.

2. **증상 분석**: 버그가 어느 레이어에 있는지 판단:
   - **렌더링 문제** (bar 안 보임, 색상 틀림, 레이아웃 깨짐) → `index.html`
   - **데이터 누락/불일치** (task 안 나옴, 값이 0) → `webApp.gs` join 로직 또는 Sheets 컬럼 매핑
   - **싱크 오류** (Notion 데이터 반영 안 됨) → `syncNotionToSheets.gs`
   - **Jira 데이터 stale** → `fetchJiraLive()` 캐시 또는 API 호출

3. **Common root causes** (경험상 빈번한 원인):
   - Column position drift: 시나리오 탭 컬럼 순서가 바뀜 → effort가 0으로 읽힘
   - Team alias mismatch: `getTeamKey()` + `TEAM_ALIASES`에 새 팀명 누락
   - jira_url이 없는 row: pre-Jira placeholder가 name fallback 실패
   - Backtick in template: HtmlService parsing 에러 (화면 전체 안 나옴)
   - Jira field 이름 변경: customfield_NNNNN이 다른 값 반환

4. **수정 후 체크리스트**:
   - [ ] backtick 없는지 확인 (index.html)
   - [ ] jira_url PK 규칙 준수
   - [ ] 시나리오 탭이 Notion_raw reorder에 영향 안 받는지
   - [ ] CLAUDE.md에 버그 수정 기록

## Output
- 한국어로 원인 분석 → 수정 내용 → 확인 방법 설명
- 수정 전 반드시 원인 공유하고 확인받기
