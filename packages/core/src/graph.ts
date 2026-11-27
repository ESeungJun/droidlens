/**
 * 화면 지도 기능의 공개 입구. 실제 코드는 graph/ 아래에 역할별로 있고, 이 파일은 그 공개 API 를 다시 내보내기만 한다
 * (index.ts·script.ts 가 './graph.js' 로 가져오는 그대로 쓰도록). 내부 도우미는 여기서 내보내지 않는다.
 *
 * - graph/snapshot.ts  화면 읽기·안정 대기·누를 수 있는 요소
 * - graph/bundle.ts    지도 파일 형식·한도
 * - graph/store.ts     ScreenGraph 저장소
 * - graph/navigate.ts  행동 실행·경로·화면 이동
 * - graph/explore.ts   자동 탐색
 * - graph/flow.ts      흐름 수집
 * - graph/path.ts      TC 실행 경로 (#131)
 * - graph/coverage.ts  화면별 검증 기록 (#131)
 * 의존 방향: bundle·snapshot ← store ← navigate ← explore·flow (explore·flow는 snapshot·store도 직접 씀). 거꾸로 가는 import 는 없다.
 */
export * from './graph-model.js';
export {
  candidateActions,
  captureSnapshot,
  dismissSystemDialog,
  launchAndSettle,
  returnToStart,
  screenId,
  resumeStartOf,
  targetAt,
  waitForSettle,
  type Candidate,
  type ReturnToStartResult,
  type Snapshot,
  type StartScreen,
} from './graph/snapshot.js';
export { MAP_LIMITS, type MapBundle } from './graph/bundle.js';
export { ScreenGraph } from './graph/store.js';
export {
  followPath,
  navigateTo,
  performAction,
  planRoute,
  recordTransition,
  startTransition,
  type PathStep,
} from './graph/navigate.js';
export { explore, type ExploreOptions, type ExploreResult } from './graph/explore.js';
export { FlowCollector, type NotedAction } from './graph/flow.js';
export { TcPath, type TcPathAction } from './graph/path.js';
export { loadScreenRecords, screenChecks, type ScreenCheck, type ScreenRecord } from './graph/coverage.js';
