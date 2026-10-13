# DroidLens

개인용 Android 앱 분석·디버깅·시나리오 검증 툴. Flipper(2025년 아카이브)를 대체하는 것을 목표로 하며, **SDK 없이 adb만으로 모든 앱**을 분석하고, 선택형 SDK로 내 앱은 더 깊게 본다. 같은 기능을 Electron 데스크톱 앱과 MCP 서버로 함께 제공해서 Claude Code 에이전트가 직접 기기를 조작하고 검증할 수 있다.

```
packages/core     adb 엔진 — 기기, 스크린샷/녹화, 뷰 계층, 화면 그래프·자동 탐색, APK 라이브러리 탐지, 시나리오 기록
packages/mcp      core를 MCP 도구 28개로 노출 (stdio)
apps/desktop      Electron + React UI
agents/           Claude Code 전용 에이전트 (droidlens-verifier, droidlens-analyst)
sdk/android       (2단계) 선택형 Kotlin SDK — 네트워크·DB·SharedPreferences·Compose 상세
```

## 실행

```bash
pnpm install
pnpm build                              # core + mcp
pnpm --filter @droidlens/desktop dev    # 데스크톱 앱
```

adb는 `ADB_PATH` → `ANDROID_HOME` → `~/Library/Android/sdk/platform-tools/adb` → PATH 순서로 찾는다. 산출물은 모두 `~/.droidlens/`(`DROIDLENS_HOME`로 변경 가능)에 쌓인다.

| 폴더 | 내용 |
| --- | --- |
| `screenshots/`, `recordings/` | 스크린샷 PNG, 녹화 mp4 |
| `graphs/<패키지>/` | 화면 그래프 `graph.json`, `graph.mmd`, 화면별 스크린샷 |
| `scenarios/<id>/` | 시나리오 검증 `scenario.json`, `report.html`, 단계별 스크린샷 |
| `apks/<패키지>/` | 분석용으로 내려받은 APK (REA 분석에 재사용) |

## 데스크톱 앱 기능

- **화면**: 실시간 미러링(클릭=탭, 드래그=스와이프, 길게=롱프레스), 하드웨어 키, 텍스트 입력, 스크린샷, 녹화(최대 180초), 조작을 화면 그래프에 기록
- **뷰 계층**: 스크린샷 ↔ 트리 양방향 선택, 속성·셀렉터, 깊이별 노드 수, Compose 추정, **3D 깊이 분해도**(드래그 회전·간격 조절)
- **화면 흐름**: 화면 그래프(썸네일 노드 + 동작 라벨 엣지), 자동 탐색(DFS, 위험 버튼 회피), 화면별 진입/진출 경로
- **로그**: 실시간 logcat(앱 PID 필터, 레벨, 검색), 최근 크래시
- **라이브러리**: APK의 DEX 클래스·네이티브 lib로 100여 개 라이브러리/프레임워크 탐지, 난독화 추정, 시그니처에 없는 패키지
- **앱 정보**: 버전·SDK·권한·Activity·실행/재시작/종료·딥링크
- **시나리오**: 에이전트가 남긴 검증 기록을 실시간으로 확인

## Claude Code 연동

이 폴더에서 Claude Code를 열면 `.mcp.json`과 `.claude/agents/`가 자동으로 잡힌다. 다른 폴더에서도 쓰려면 직접 등록한다.

```bash
claude mcp add --scope user droidlens -- node <droidlens 경로>/packages/mcp/dist/index.js
cp agents/*.md ~/.claude/agents/
```

사용 예:
- "droidlens-verifier로 쇼핑 앱에서 검색 → 상품 상세 → 찜하기 시나리오 검증해줘"
- "droidlens-analyst로 이 앱 기술 스택이랑 화면 구조 분석해줘"

## 알려진 한계 (adb 모드)

- `uiautomator dump`가 한 번에 1.5~3초 걸려 자동 탐색이 스텝당 5~15초. → 2단계 온디바이스 에이전트 APK로 개선 예정
- `input text`는 ASCII만 지원 (한글 입력은 IME 필요)
- 네트워크·DB·SharedPreferences 같은 앱 내부 정보는 SDK가 필요 (2단계)
- Compose 화면은 semantics가 노출된 노드만 보인다
- WebView/Flutter/게임 엔진 화면 내부는 접근성 노드가 적어 분석이 제한적

로드맵은 [docs/ROADMAP.md](docs/ROADMAP.md).
