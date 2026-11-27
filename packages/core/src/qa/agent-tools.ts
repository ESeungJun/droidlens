/**
 * QA 회차 실행 에이전트(droidlens-verifier, 데스크톱 QA 탭)에게 주는 DroidLens 도구 (#140).
 * 모든 MCP 도구는 아래 두 목록 중 정확히 한쪽에 있어야 한다(packages/mcp/test/qa-run-tools.test.mjs 가 검사).
 * 새 도구를 만들면 회차 에이전트가 써도 되는지 정해서 한쪽에 넣는다.
 */

/** 회차 실행에 쓰는 도구: 기기 조작·화면 읽기·기록·판정 */
export const QA_RUN_TOOLS: readonly string[] = [
  // 기기
  'devices',
  'device_info',
  'screenshot',
  'record_start',
  'record_stop',
  'agent_status',
  // 앱 (앱 데이터 삭제는 화면 승인 창을 거친다)
  'list_packages',
  'app_info',
  'launch_app',
  'stop_app',
  'clear_app_data',
  'open_deeplink',
  'analyze_libraries',
  'logcat',
  'crashes',
  // 조작
  'tap',
  'swipe',
  'type_text',
  'press_key',
  'wait_for',
  // 화면
  'current_screen',
  'view_hierarchy',
  'find_nodes',
  'screenshot_compare',
  'a11y_audit',
  // 웹뷰 페이지 읽기 (#132, 읽기만)
  'webview_inspect',
  // 화면 지도
  'graph_record',
  'graph_get',
  'explore',
  'graph_navigate',
  // 성능
  'perf_startup',
  'perf_stats',
  // 앱 내부 (prefs·DB 쓰기는 화면 승인 창을 거친다)
  'sdk_apps',
  'network_requests',
  'network_request_detail',
  'prefs_get',
  'prefs_set',
  'prefs_remove',
  'db_list',
  'db_query',
  'app_events',
  'network_mock_set',
  'network_mock_list',
  'network_mock_remove',
  // 기록
  'scenario_start',
  'scenario_step',
  'scenario_finish',
  'script_list',
  'script_read',
  // 판정 (계획은 읽기만, 결과는 돌리지 못한 TC 의 skip·blocked 만 적힌다)
  'qa_plan_get',
  'qa_case_result',
  'design_compare',
];

/** 회차 실행에 주지 않는 도구와 이유 */
export const QA_RUN_DENIED_TOOLS: readonly string[] = [
  // 계획·TC·출처·디자인 기준 바꾸기: 판정하는 쪽이 기준을 바꾸면 결과를 믿을 수 없다
  'qa_plan_create',
  'qa_plan_save',
  'qa_case_update',
  'qa_source_add',
  'design_guide_save',
  // 확인 필수 버튼 허용 켜기: 사람이 정한다
  'qa_case_allow',
  // 회차 열기·결과표 만들기: 앱이 한다. 에이전트가 부르면 회차가 하나 더 생긴다
  'qa_run_scripts',
  'qa_report',
  // TC 와 상관없는 계획 목록·원문 읽기
  'qa_plan_list',
  'qa_source_read',
  // Claude Code 가 저장한 Figma 응답 파일 읽기: TC 뽑기(계획 에이전트)용. 회차는 파일을 읽을 일이 없다 (#156)
  'figma_outline',
  // 저장한 스크립트 고치기·다시 돌리기: 회차의 스크립트 실행은 앱이 한다. 통과 뒤 다시 돌리면 TC 마다 앱 재시작과 7~20초가 더 든다 (#148)
  'script_write',
  'script_run',
  // 기기에 앱 설치, 저장된 시나리오 전부 돌리기: 회차의 TC 범위를 넘는다
  'install_apk',
  'suite_run',
];

/** --allowedTools 에 넣을 이름 */
export function qaRunAllowedTools(): string[] {
  return QA_RUN_TOOLS.map((n) => `mcp__droidlens__${n}`);
}
