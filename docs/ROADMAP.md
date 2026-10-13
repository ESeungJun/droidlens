# 로드맵

## 1단계 — adb 코어 + 데스크톱 + MCP (완료, v0.1.0)

- [x] adb 래퍼, 기기 정보, 입력(탭·스와이프·키·텍스트)
- [x] 스크린샷, 화면 녹화
- [x] 뷰 계층 덤프·파싱·셀렉터·압축 텍스트·통계, 3D 깊이 뷰
- [x] 현재 Activity / Fragment 인식
- [x] 화면 그래프(구조 시그니처 기반 화면 식별), 수동 기록, 자동 탐색(DFS + 위험 라벨 회피), 최단 경로, mermaid
- [x] APK 라이브러리 탐지 (DEX type_ids 파싱 + 네이티브 lib + 시그니처 DB)
- [x] logcat 스트림·크래시
- [x] 시나리오 기록 + HTML 리포트
- [x] MCP 서버 28개 도구, 에이전트 2종

## 배포 (v0.1.0)

- [x] electron-builder: macOS arm64/x64, Windows x64/arm64, Linux AppImage
- [x] MCP 서버 단일 파일 번들을 앱에 내장, 설정·연동 탭에서 원클릭 등록
- [x] GitHub Actions: CI, 태그 푸시 시 릴리스 자동 빌드

## 2단계 — 속도와 깊이

- [x] **온디바이스 에이전트 APK**: 뷰 계층 0.03~0.3초, 접근성 이벤트 기반 Activity 추적, 한글 입력, idle 대기
- [x] 자동 탐색: CLEAR_TASK 실행, 구조 안정 판정, ANR/크래시 대화상자 처리
- [ ] **scrcpy 연동** 고프레임 미러링 (현재 screencap 폴링 2~4fps)
- [ ] **선택형 Kotlin SDK** (`debugImplementation`), `adb forward`로 데스크톱과 WebSocket 연결
  - 네트워크 인스펙터 (OkHttp Interceptor): 요청/응답, 타이밍, 목킹
  - DB 브라우저 (Room/SQLite), SharedPreferences/DataStore 편집
  - Compose 트리 상세 (recomposition 횟수, modifier, semantics)
  - 커스텀 이벤트/로그 채널
- [ ] 자동 탐색 개선: 스크롤 영역 탐색, 입력 폼 더미 값, 로그인 시나리오 프리셋 후 탐색
- [ ] 화면 그래프 레이아웃 개선 (dagre/elk), 그래프 diff (버전 간 화면 변화)

## 3단계 — 시나리오 자동화

- [ ] 시나리오를 YAML로 저장하고 재생 (에이전트가 성공한 경로를 스크립트로 굳히기)
- [ ] 회귀 실행: 여러 시나리오 일괄 실행 → 결과 대시보드
- [ ] 스크린샷 비교(시각적 회귀)
- [ ] 버전 간 비교: 라이브러리 diff, 화면 그래프 diff, REA `compare_application_versions` 연동
- [ ] 성능: 앱 시작 시간, 프레임(gfxinfo), 메모리(meminfo) 수집
