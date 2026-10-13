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

## 보안·구조 리뷰 (v0.4.0)

- [x] 에이전트·SDK 소켓을 adb(shell) 연결만 받도록 UID 검사, 에이전트 TCP 제거
- [x] Electron sandbox·내비게이션 차단·파일 IPC 경로 제한, 패키지 이름 검증
- [x] MCP 모듈 분리, 공용 HTTP/포워딩, 폴링 통합·증분 조회

## 2단계 — 속도와 깊이

- [x] **온디바이스 에이전트 APK**: 뷰 계층 0.03~0.3초, 접근성 이벤트 기반 Activity 추적, 한글 입력, idle 대기
- [x] 자동 탐색: CLEAR_TASK 실행, 구조 안정 판정, ANR/크래시 대화상자 처리
- [x] **scrcpy 연동** 고프레임 미러링 (v0.3.0, scrcpy v5 서버 + WebCodecs H.264 디코딩, 최대 60fps)
- [ ] scrcpy 컨트롤 소켓으로 입력 지연 단축, 오디오
- [x] **선택형 SDK** (v0.2.0, JitPack, `debugImplementation` + `sdk-noop`), localabstract 소켓 + `adb forward`
  - [x] 네트워크 인스펙터 (OkHttp Interceptor): 요청/응답 헤더·본문, 타이밍, 실패
  - [x] DB 브라우저 (SQLite/Room) + SQL, SharedPreferences 조회·편집
  - [x] 커스텀 이벤트
  - [ ] 네트워크 목킹/응답 조작, DataStore, Compose 트리 상세(recomposition)
- [ ] 자동 탐색 개선: 스크롤 영역 탐색, 입력 폼 더미 값, 로그인 시나리오 프리셋 후 탐색
- [ ] 화면 그래프 레이아웃 개선 (dagre/elk), 그래프 diff (버전 간 화면 변화)

## 3단계 — 시나리오 자동화

- [x] 시나리오 YAML 스크립트 + 러너 (v0.4.0): 셀렉터 대기, optional, 스크롤 탐색, assert 10종(화면·Activity·네트워크·Prefs·DB·이벤트·크래시)
- [x] 에이전트 검증 중 조작·검사 자동 녹화 → 통과 시 스크립트 저장
- [x] 회귀 실행: 폴더 일괄 실행 (MCP suite_run, 데스크톱, CLI `run` — CI용 종료 코드)
- [ ] 결과 대시보드 (실행 이력·성공률 추이), 스크립트 매개변수(계정 등) 주입
- [ ] 스크린샷 비교(시각적 회귀)
- [ ] 버전 간 비교: 라이브러리 diff, 화면 그래프 diff, REA `compare_application_versions` 연동
- [ ] 성능: 앱 시작 시간, 프레임(gfxinfo), 메모리(meminfo) 수집
