/**
 * ESL Timeline — Google Sheets → Notion Sync
 * ============================================================
 * 사용법:
 *   1. 스프레드시트 메뉴 → 확장 프로그램 → Apps Script
 *   2. 이 파일 내용 전체를 붙여넣기
 *   3. NOTION_TOKEN에 토큰 입력
 *   4. 처음엔 DRY_RUN = true로 테스트 → 로그 확인
 *   5. DRY_RUN = false로 바꾸고 실제 실행
 *   6. setupTimeTrigger() 실행해서 자동 싱크 설정
 * ============================================================
 */

// ============================================================
// ★ CONFIGURATION — 여기만 수정하세요
// ============================================================
const CONFIG = {
  // 스프레드시트 → 프로젝트 설정 → Script Properties에 notionToken 키로 저장
  notionToken:  PropertiesService.getScriptProperties().getProperty('notionToken'),
  notionDbId:   '3425bd55-7775-802f-9667-c375cd628d46', // Realistic Scenario DB ID
  sheetName:    'Realistic Scenario - Tasks Details (S2)',
  headerRow:    1,     // 헤더가 있는 행 번호
  dataStartRow: 2,     // 데이터 시작 행 번호
  epicUrlCol:   'B',   // Epic (Jira URL) 컬럼 (사용자 확인: B열)
  dryRun:       true,  // true = 로그만 출력, 실제 변경 없음 / false = 실제 싱크
};

// ============================================================
// 컬럼 헤더 이름 → Notion 필드 매핑
// 스프레드시트 헤더 이름과 다르면 왼쪽 key를 수정하세요
// ============================================================
const FIELD_MAP = {
  'Priority':                              { field: 'Priority',                              type: 'select'     },
  'Team':                                  { field: 'Team',                                  type: 'rich_text'  },
  'Lead':                                  { field: 'Lead',                                  type: 'rich_text'  },
  'Risk Factor':                           { field: 'Risk Factor',                           type: 'select'     },
  'Start Date':                            { field: 'Start Date',                            type: 'date'       },
  'End Date (Do not edit)':               { field: 'End Date (Do not edit)',                type: 'date'       },
  'Ideal Delivery (due to SOW)':          { field: 'Ideal Delivery (due to SOW)',           type: 'date'       },
  'Planned Effort  (#weeks)':             { field: 'Planned Effort  (#weeks)',              type: 'number'     },
  'Scenario Estimated Effort (dev weeks)':{ field: 'Scenario Estimated Effort (dev weeks)', type: 'number'     },
  'Allocation':                            { field: 'Allocation',                            type: 'rich_text'  },
  'Headcount':                             { field: 'Headcount',                             type: 'rich_text'  },
  'Note':                                  { field: 'Note',                                  type: 'rich_text'  },
  'Release':                               { field: 'Release',                               type: 'rich_text'  },
  'CCAIP Release [PMO Plan]':             { field: 'CCAIP Release [PMO Plan]',              type: 'rich_text'  },
};

// ============================================================
// MAIN: 수동 실행용 (또는 트리거로 자동 실행)
// ============================================================
function syncSheetsToNotion() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.sheetName);

  if (!sheet) {
    Logger.log(`❌ 시트를 찾을 수 없습니다: "${CONFIG.sheetName}"`);
    return;
  }

  // 1. 헤더 읽기 → 컬럼명: 인덱스 맵 생성
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(CONFIG.headerRow, 1, 1, lastCol).getValues()[0];
  const colMap = {}; // { "헤더이름": 0-based index }
  headers.forEach((h, i) => { if (h) colMap[String(h).trim()] = i; });

  Logger.log('📋 인식된 헤더: ' + JSON.stringify(Object.keys(colMap)));

  // FIELD_MAP에서 매핑 안 된 헤더 경고
  for (const sheetHeader of Object.keys(FIELD_MAP)) {
    if (colMap[sheetHeader] === undefined) {
      Logger.log(`⚠️  헤더 미발견 (스킵됨): "${sheetHeader}"`);
    }
  }

  const epicColIdx = colLetterToIdx(CONFIG.epicUrlCol);

  // 2. 시트 데이터 전체 읽기
  const lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.dataStartRow) {
    Logger.log('데이터 행이 없습니다.');
    return;
  }
  const data = sheet.getRange(CONFIG.dataStartRow, 1, lastRow - CONFIG.dataStartRow + 1, lastCol).getValues();

  // 3. Notion DB에서 전체 페이지 가져오기 → Epic URL로 인덱싱
  Logger.log('🔍 Notion 페이지 로딩 중...');
  const notionPages = fetchAllNotionPages();
  const notionIndex = {}; // epicUrl → notionPage
  notionPages.forEach(page => {
    const epicUrl = page.properties['Epic (Do not edit)']?.url?.trim();
    if (epicUrl) notionIndex[epicUrl] = page;
  });
  Logger.log(`✅ Notion 페이지 ${notionPages.length}개 로드 완료 (Epic URL 있는 것: ${Object.keys(notionIndex).length}개)`);

  if (CONFIG.dryRun) Logger.log('\n🧪 DRY RUN 모드 — 실제 변경 없음\n');

  // 4. 각 행 싱크
  let updated = 0, skipped = 0, notFound = 0, errors = 0;

  data.forEach((row, i) => {
    const rowNum = CONFIG.dataStartRow + i;
    const epicUrl = String(row[epicColIdx] || '').trim();

    // Epic URL 없는 행 스킵 (섹션 헤더, 빈 행 등)
    if (!epicUrl.startsWith('http')) {
      skipped++;
      return;
    }

    const notionPage = notionIndex[epicUrl];
    if (!notionPage) {
      Logger.log(`⚠️  Row ${rowNum}: Notion에서 찾을 수 없음 → ${epicUrl}`);
      notFound++;
      return;
    }

    // 업데이트할 properties 빌드
    const properties = {};
    for (const [sheetHeader, fieldDef] of Object.entries(FIELD_MAP)) {
      const colIdx = colMap[sheetHeader];
      if (colIdx === undefined) continue;

      const cellValue = row[colIdx];
      const notionProp = buildNotionProp(cellValue, fieldDef.type);
      if (notionProp !== null) {
        properties[fieldDef.field] = notionProp;
      }
    }

    if (Object.keys(properties).length === 0) {
      skipped++;
      return;
    }

    const taskName = notionPage.properties['Task (Do not edit)']?.title?.[0]?.plain_text || epicUrl;

    if (CONFIG.dryRun) {
      Logger.log(`[DRY RUN] Row ${rowNum}: "${taskName}"\n  → ${JSON.stringify(properties)}`);
      updated++;
      return;
    }

    try {
      notionRequest('PATCH', `https://api.notion.com/v1/pages/${notionPage.id}`, { properties });
      Logger.log(`✅ Row ${rowNum}: "${taskName}" 업데이트 완료`);
      updated++;
      Utilities.sleep(350); // Notion API rate limit (약 3 req/sec)
    } catch (e) {
      Logger.log(`❌ Row ${rowNum}: 오류 → ${e.message}`);
      errors++;
    }
  });

  Logger.log(`\n📊 완료 — 업데이트: ${updated}, 스킵: ${skipped}, 미발견: ${notFound}, 오류: ${errors}`);
}

// ============================================================
// Notion API
// ============================================================
function fetchAllNotionPages() {
  const pages = [];
  let cursor = null;

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = notionRequest('POST', `https://api.notion.com/v1/databases/${CONFIG.notionDbId}/query`, body);
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return pages;
}

function notionRequest(method, url, body) {
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${CONFIG.notionToken}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  };

  const res = UrlFetchApp.fetch(url, options);
  const json = JSON.parse(res.getContentText());

  if (json.object === 'error') {
    throw new Error(`[Notion ${json.status}] ${json.message}`);
  }
  return json;
}

// ============================================================
// Notion Property 빌더
// ============================================================
function buildNotionProp(value, type) {
  if (value === null || value === undefined || value === '') return null;

  switch (type) {
    case 'select':
      const selectVal = String(value).trim();
      return selectVal ? { select: { name: selectVal } } : null;

    case 'rich_text':
      const textVal = String(value).trim();
      return textVal ? { rich_text: [{ text: { content: textVal } }] } : null;

    case 'number':
      const num = parseFloat(value);
      return isNaN(num) ? null : { number: num };

    case 'date':
      const dateStr = toISODate(value);
      return dateStr ? { date: { start: dateStr } } : null;

    default:
      return null;
  }
}

function toISODate(value) {
  if (!value) return null;
  let d;
  if (value instanceof Date) {
    d = value;
  } else {
    d = new Date(value);
  }
  if (isNaN(d.getTime())) return null;
  // YYYY-MM-DD (UTC 기준)
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

// ============================================================
// 유틸리티
// ============================================================
function colLetterToIdx(letter) {
  let idx = 0;
  for (let i = 0; i < letter.length; i++) {
    idx = idx * 26 + letter.toUpperCase().charCodeAt(i) - 64;
  }
  return idx - 1; // 0-based
}

// ============================================================
// 트리거 설정 (한 번만 실행)
// ============================================================

/** 30분마다 자동 싱크 트리거 설정 */
function setupTimeTrigger() {
  // 기존 트리거 삭제
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncSheetsToNotion') {
      ScriptApp.deleteTrigger(t);
    }
  });
  // 새 트리거 생성
  ScriptApp.newTrigger('syncSheetsToNotion')
    .timeBased()
    .everyMinutes(30)
    .create();
  Logger.log('✅ 트리거 설정 완료: syncSheetsToNotion 30분마다 자동 실행');
}

/** 트리거 제거 */
function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncSheetsToNotion') {
      ScriptApp.deleteTrigger(t);
    }
  });
  Logger.log('🗑️ 트리거 제거 완료');
}

/** 연결 테스트 — 토큰/DB ID 확인용 */
function testConnection() {
  try {
    const res = notionRequest('POST', `https://api.notion.com/v1/databases/${CONFIG.notionDbId}/query`, { page_size: 1 });
    Logger.log(`✅ 연결 성공! 첫 번째 페이지: ${res.results[0]?.properties?.['Task (Do not edit)']?.title?.[0]?.plain_text}`);
  } catch (e) {
    Logger.log(`❌ 연결 실패: ${e.message}`);
  }
}
