# Sync Health Check

Notion → Sheets → Jira 데이터 파이프라인 상태를 점검합니다.

## Steps

1. **syncNotionToSheets.gs 분석**: Read the sync file and check:
   - `syncNotionToSheets()` 함수가 정상인지 (clear+dump 패턴 유지)
   - `ensureOverallAnchors()` 가 새 jira_url을 자동 추가하는지
   - PK가 `jira_url` (col J)인지 확인

2. **webApp.gs Jira live fetch 분석**: Check:
   - `fetchJiraLive()` 캐시 TTL (5분)
   - Jira REST endpoint가 POST `/rest/api/3/search/jql` 사용하는지
   - `fetchLateCommentsFromJira_()` 병렬 fetch 상태
   - 에러 핸들링 (token 없거나 non-200일 때 graceful fallback)

3. **데이터 흐름 일관성 확인**:
   - Notion_raw col J (jira_url) → Overall col A (jira_url) → Realistic Scenario col B (Epic URL) 로 PK 체인이 연결되는지
   - `buildNotionIndex()` 가 byUrl 우선, byName fallback으로 join하는지
   - 시나리오 탭들이 column position으로 읽히는지 (header name 아님)

4. **결과 리포트**: 한국어로 요약
   ```
   ✅ 정상 항목
   ⚠️ 주의 필요 항목
   ❌ 문제 발견 항목
   ```

5. **개선 제안**: 발견된 이슈에 대해 구체적 수정 방안 제시.

## Context
- Daily sync trigger: 매일 오전 7시
- Jira cache: CacheService 5분 TTL
- Notion DB ID: 33b5bd55-7775-8190-9e38-fa14f6b29411
- Spreadsheet ID: 1s_AGnjgrSc_UtrVBRVHORlV_V9NpocKt15EpJaxmXpw
