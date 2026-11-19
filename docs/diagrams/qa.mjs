// 문서로 QA 돌리기(#72) 그림. 렌더:
// node ~/.claude/skills/doc-diagrams/scripts/render.mjs docs/diagrams/qa.mjs docs/images
export default [
  {
    name: 'qa-flow',
    type: 'flow',
    title: '문서로 QA 돌리기 — 처리 흐름',
    sub: '데스크톱 QA 탭과 Claude Code(MCP)가 같은 core 를 쓴다',
    labels: { new: '이번에 만드는 것', base: '사람 · 기존 기능' },
    lanes: [
      {
        name: '1. 추출',
        when: 'droidlens-qa-planner · 기기 도구 없음',
        icon: 'llm',
        steps: [
          ['start', '문서 넣기<br>md·txt·PDF · CSV·엑셀 · Confluence · Figma'],
          ['step', '문서 정규화<br>CSV·엑셀 → 표, 사본 sources/'],
          ['step', '요구사항 R-xx 추출<br>문서 근거'],
          ['q', 'TC 표도 넣었나?', ['skip', '예', '표를 옮기고 빈칸 · 빠진 요구사항 TC만 더함']],
          ['step', 'TC 표 새로 만들기<br>정상·예외·경계 · Figma 프레임마다 디자인 TC'],
          ['q', '형식 검사 통과?', ['err', '아니오', '오류를 에이전트에 돌려줘 다시 저장']],
          ['db', 'qa/<계획>/plan.json'],
        ],
        recv: '검토 화면',
      },
      {
        name: '2. 검토',
        when: '사람',
        icon: 'user',
        steps: [
          ['start', '추적표 · TC 표 보기'],
          ['q', 'TC 없는 요구사항?', ['skip', '있음', '빨간 표시 · TC 더하기 / 그 요구사항만 다시 추출']],
          ['step', 'TC 고치기 · 지우기 · 더하기'],
          ['q', '확인 필수 TC?', ['skip', '예', '기본 선택 해제 · 실행하려면 실제로 누르기 허용 켬']],
          ['db', 'plan.json 저장<br>selected · allowDanger'],
        ],
        recv: '실행',
      },
      {
        name: '3. 실행 (TC 하나)',
        when: '우선순위 순서 · TC마다 새 세션 · 10분 제한',
        icon: 'robot',
        steps: [
          ['start', '고른 TC 하나'],
          ['q', '스크립트 있나?', ['skip', '없음', '에이전트 실행으로 바로']],
          ['step', '스크립트 실행<br>guardDanger 켬', ['loop', '실패', '설정이 켜져 있으면 에이전트로 다시 판정']],
          ['step', 'verifier 에이전트 판정<br>scenario_start(tc)', ['err', '막힘·시간 초과', '막힘으로 기록 · 다음 TC']],
          ['q', '통과?', ['skip', '실패', '시나리오 리포트만 남김']],
          ['db', '스크립트 저장(tc 달림)<br>TC.script 에 이름'],
        ],
        recv: '회차 결과 run.json',
      },
      {
        name: '4. 결과',
        when: '회차가 끝나면',
        icon: 'list',
        steps: [
          ['start', 'run.json'],
          ['step', '요구사항별 확인 여부 집계'],
          ['step', '결과표 HTML · CSV · JUnit<br>가리기 규칙 적용'],
        ],
        recv: 'QA 탭 · 파일 · CI',
      },
    ],
  },
  {
    name: 'qa-design-flow',
    type: 'flow',
    title: '디자인 비교 — Figma 가이드 vs 실제 화면',
    sub: '디자인 TC 하나를 실행할 때',
    labels: { new: '이번에 만드는 것', base: '사람 · 기존 기능' },
    lanes: [
      {
        name: '가이드',
        when: '에이전트 · Figma 커넥터',
        icon: 'page2',
        steps: [
          ['start', 'Figma 프레임 링크'],
          ['step', '노드 읽기<br>문구 · 글자 · 색 · 여백 · 크기'],
          ['q', '형식 검사 통과?', ['err', '아니오', '빈 값은 모름 · 비교에서 뺌']],
          ['db', 'design_guide_save<br>guide.json'],
        ],
        recv: '비교',
      },
      {
        name: '비교',
        when: 'verifier → design_compare (core)',
        icon: 'compare',
        steps: [
          ['start', '그 화면으로 이동 · 멈출 때까지 대기'],
          ['step', '뷰 계층 + 스크린샷 동시에'],
          ['q', '글자 크기 정보 있나?', ['skip', '없음', '글자 높이로 추정 · 정확도 추정']],
          ['step', '짝짓기<br>같은 문구 → 비슷한 문구 → 위치', ['err', '짝 없음', '차이로 기록 · 가이드에만 / 화면에만 있음']],
          ['q', '허용치 넘나?', ['skip', '아니오', '보고하지 않음']],
          ['db', 'diff.json · 표시한 캡처'],
        ],
        recv: 'TC 결과 · 리포트 디자인 차이 n건',
      },
    ],
  },
];
