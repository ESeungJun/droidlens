# 코드 규칙표

이 저장소의 코드 규칙마다 무엇이 막는지 적는다. 장치가 없으면 `글` 이라고 그대로 적는다.
`scripts/harness/check-rules.sh` 가 적힌 장치·시험 파일이 실제로 있는지, 장치에 시험이 있는지 확인한다(CI 에서도 돈다).

규칙이 생기는 곳은 세 군데다.
- **설계서**: `docs/설계서.md` "구조 규칙" 표(`S1`, `S2` …: 의존 방향, 모듈 경계, 금지 API). 출처 칸에 `설계서 S1` 처럼 ID 를 적는다. 빠진 ID 가 있으면 check-rules 가 실패한다. 구현 하네스를 깔 때 몇 개를 바로 장치로 만든다.
- **리뷰 지적**: review-all·사람 리뷰에서 같은 지적이 두 번 나오면 여기에 올린다.
- **사용자 지적**: 사용자가 같은 실수를 두 번 짚으면 여기에 올린다.

경로는 백틱으로 감싸고 `/` 나 `.` 이 들어가게 쓴다(예: `lint.config.js`, `tests/rule1.test.ts`). 칸 안에 세로선을 쓰려면 `\|`.

장치로 만드는 순서: 코드 구조·타입으로 아예 못 하게 → 린트 규칙 → 테스트 → CI → 그래도 판단이 필요하면 글.
새 장치는 **과거 실수를 시험으로 먼저 넣어 실패하는 것을 확인한 뒤** 만든다.

| 번호 | 규칙 | 출처 | 장치 | 시험 | 메모 |
|---|---|---|---|---|---|
| 1 | main 의 파일 IPC 는 DroidLens 데이터 폴더 안 경로만 연다 | 설계서 S4 | 글 | | `apps/desktop/src/main/ipc/files.ts` 의 `insideHome` 을 거친다. 시험이 생기면 장치로 옮긴다 |
| 2 | 색은 디자인 토큰으로만 쓴다(하드코딩 금지) | design-system 4절 | `scripts/harness/check-tokens.sh` | `scripts/harness/tests/check-tokens.test.sh` | 토큰 원본·기준선은 `scripts/harness/tokens.allow`. 2026-11-26 기준선: 데스크톱 CSS·리포트 HTML 3곳, 이슈 #94 |
| 3 | 기능 지도의 코드·확인 스크립트·시나리오가 실제로 있다 | qa-check | `scripts/harness/check-map.sh` | `scripts/harness/tests/check-map.test.sh` | 지도는 `docs/기능지도.md`, 확인 스크립트는 `scripts/verify/`(지도에 없는 `F<번호>-…` 스크립트도 실패), 시나리오는 `docs/시나리오.md` |
| 4 | core 는 데스크톱·MCP 를 import 하지 않는다 | 설계서 S1 | `scripts/harness/check-layers.sh` | `scripts/harness/tests/check-layers.test.sh` | |
| 5 | 렌더러는 Node·electron 모듈을 직접 쓰지 않는다(main 과는 `window.dl` 로만) | 설계서 S2 | `scripts/harness/check-layers.sh` | `scripts/harness/tests/check-layers.test.sh` | |
| 6 | 데스크톱·MCP 는 adb 를 직접 띄우지 않는다 | 설계서 S3 | `scripts/harness/check-layers.sh` | `scripts/harness/tests/check-layers.test.sh` || `'adb'` 를 글자 그대로 넘긴 호출만 잡는다(변수로 넘기면 리뷰에서 본다) |
| 7 | MCP 스크립트 도구는 scripts 폴더(실행이면 프로젝트 폴더) 안만 읽고 쓴다 | 설계서 S5 | 글 | | `packages/mcp/src/tools/scenario.ts` 의 `guardPath`. 밖 경로·심볼릭 링크 시험이 없다 |
| 8 | 확인 필수 버튼은 사람이 켠 허용 없이 누르지 않는다 | 설계서 S6 | `packages/mcp/src/common.ts` | `packages/mcp/test/qa.test.mjs` | `dangerAllowed`. `tools.test.mjs`·`qa-run.test.mjs` 도 같은 경로를 본다 |
| 9 | 공유되는 리포트·결과표의 조작 값은 가린다 | 설계서 S7 | `packages/core/src/redact.ts` | `packages/core/test/redact.test.mjs` | |
| 10 | QA 문서 글은 `<source>` 로 감싼 데이터로만 넘긴다 | 설계서 S8 | `packages/mcp/src/tools/qa.ts` | `packages/mcp/test/qa.test.mjs` | `qa_source_read` |

## 실수 기록

`mistake-guard` 스킬로 적는다. 같은 꼴이면 횟수만 올린다. 횟수가 2 이상이면 표 번호(위 표의 번호)나 `보류: 이유` 를 적는다. 비면 `check-rules.sh` 가 실패한다.

| 날짜 | 실수 | 어디서 발견 | 횟수 | 표 번호 |
|---|---|---|---|---|
