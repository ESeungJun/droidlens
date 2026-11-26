/**
 * 시나리오 스크립트 (YAML)의 공개 입구. 실제 코드는 script/ 아래에 역할별로 있고, 이 파일은 그 공개 API 를 다시 내보내기만 한다
 * (index.ts·report-junit.ts 가 './script.js' 로 가져오는 그대로 쓰도록). 내부 도우미는 여기서 내보내지 않는다.
 *
 * ```yaml
 * name: 메모 추가
 * app: com.example.app
 * setup: { restart: true }
 * steps:
 *   - tap: { text: 메모 추가 }
 *   - type: { text: 장보기, into: { id: title_input } }
 *   - tap: { id: save }
 *   - assert: { visible: { textContains: 장보기 } }
 *   - assert: { network: { url: /api/notes, method: POST, status: 201 } }
 *   - assert: { perf: { maxMemoryMb: 300, maxJankPercent: 10 } }
 *   - startup: { cold: true, runs: 3, maxMs: 1500 }
 * ```
 * matchScreenshot 단계는 화면을 기준 이미지와 비교한다 (처음 실행하면 지금 화면이 기준이 된다):
 *   - matchScreenshot: { name: 상품 상세, maxDiffPercent: 0.5, ignore: [{ id: banner }] }
 * setup.mocks 로 실행하는 동안만 네트워크 목을 켤 수 있다 (예: 주문 API 를 500 으로 만들어 오류 화면 확인)
 *
 * - script/schema.ts    스크립트 형식·읽기·저장
 * - script/describe.ts  단계·검사·준비를 사람이 읽는 말로 (리포트 제목·기대 칸)
 * - script/common.ts    단계 실패·요소 기다리기·조작 뒤 대기
 * - script/assert.ts    검사기 표와 evaluateAssertion
 * - script/steps.ts     단계 실행기 표와 runStep
 * - script/run.ts       실행 흐름(준비·단계 반복·정리·리포트)과 runSuite
 * - script/volatile.ts  다시 돌리면 바뀌는 값을 정확히 일치로 보는 단계 찾기(#115)
 * 의존 방향: schema ← describe·common ← assert ← steps ← run. 거꾸로 가는 import 는 없다.
 */
export {
  collectScripts,
  loadScript,
  parseScript,
  saveScript,
  scriptSchema,
  scriptsDir,
  stepSchema,
  toYaml,
  type Assertion,
  type Script,
  type ScriptStep,
} from './script/schema.js';
export { describeAssertion, describeStep, selectorLabel } from './script/describe.js';
export { waitScreenSettled } from './script/common.js';
export { evaluateAssertion } from './script/assert.js';
export { volatileChecks, volatileWarning, type VolatileCheck } from './script/volatile.js';
export { foreignPackage, runScript, runSuite, type RunResult, type ScriptRunOptions, type SuiteResult } from './script/run.js';
