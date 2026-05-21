# Add Feature to ESL Timeline

새 기능을 ESL Timeline에 추가합니다. $ARGUMENTS 에 기능 설명이 들어옵니다.

## Before writing any code

1. **CLAUDE.md 전체 읽기**: 반드시 `CLAUDE.md`를 읽고 아키텍처를 이해한 후 코딩 시작.

2. **영향 범위 분석**: 어떤 파일을 수정해야 하는지 파악:
   - UI/차트 변경 → `index.html`
   - 데이터 소스/API 변경 → `webApp.gs`
   - Notion 싱크 변경 → `syncNotionToSheets.gs`

3. **사용자에게 계획 공유**: 한국어로 수정 계획을 먼저 설명하고 확인받기.

## Non-negotiable rules (CLAUDE.md에서)

- **jira_url이 PK** — task name이나 row number로 join하지 않기
- **backtick 금지** (index.html) — `array.join()` 또는 string concat 사용
- **static `<svg>` 금지** — JS로 동적 생성
- **시나리오 탭은 column position으로 읽기** — header name 아님
- **clear+dump 싱크 패턴 유지** — in-place update 재도입 금지
- **Jira REST는 POST** — GET /search는 sunset됨

## Implementation pattern

1. 기능 구현
2. 관련 코드에서 known gotcha 위반 여부 grep 확인
3. `CLAUDE.md` 업데이트 (새 기능 문서화)
4. 변경사항 요약 (한국어)
5. deploy 여부 질문

## Output format
- 모든 커뮤니케이션은 한국어로
- 코드 변경 전에 계획을 먼저 공유
- 변경 후 CLAUDE.md 업데이트 포함
