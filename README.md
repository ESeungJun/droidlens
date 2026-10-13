<p align="center"><img src="apps/desktop/build/icon.png" width="120" alt="DroidLens"></p>

<h1 align="center">DroidLens</h1>

<p align="center">Android 앱을 들여다보는 렌즈 — 분석 · 디버깅 · 화면 흐름 · 시나리오 검증<br>
SDK 없이 adb만으로 <b>모든 앱</b>을 분석하고, Claude Code 에이전트가 직접 기기를 조작해 검증합니다.</p>

<p align="center"><a href="https://github.com/ESeungJun/droidlens/releases/latest"><b>⬇ 최신 버전 다운로드</b></a></p>

---

Meta의 [Flipper](https://github.com/facebook/flipper)(2025년 아카이브)를 대체하는 것을 목표로 합니다. 앱에 아무것도 심지 않아도 화면 미러링, 뷰 계층, 화면 이동 경로, 사용 라이브러리를 볼 수 있고, 내장 MCP 서버로 Claude Code 에이전트가 같은 기능을 그대로 사용합니다.

## 설치

[Releases](https://github.com/ESeungJun/droidlens/releases/latest)에서 운영체제에 맞는 파일을 받으세요.

| 운영체제 | 파일 |
| --- | --- |
| macOS (Apple 칩 M1~) | `DroidLens-x.y.z-mac-arm64.dmg` |
| macOS (Intel) | `DroidLens-x.y.z-mac-x64.dmg` |
| Windows (x64) | `DroidLens-x.y.z-win-x64.exe` |
| Windows (ARM) | `DroidLens-x.y.z-win-arm64.exe` |
| Linux | `DroidLens-x.y.z-linux-x86_64.AppImage` |

**macOS 첫 실행**: 코드 서명 인증서가 없어 "손상되었기 때문에 열 수 없습니다"가 뜰 수 있습니다. 앱을 응용 프로그램 폴더로 옮긴 뒤 터미널에서 한 번 실행하세요.
```bash
xattr -dr com.apple.quarantine /Applications/DroidLens.app
```
**Windows 첫 실행**: SmartScreen 경고가 뜨면 "추가 정보 → 실행"을 누르세요.

### 준비물: adb
Android Studio가 설치되어 있으면 자동으로 찾습니다. 없다면 platform-tools만 설치하세요.
```
macOS    brew install --cask android-platform-tools
Windows  winget install Google.PlatformTools
Linux    sudo apt install adb
```
그다음 기기에서 **개발자 옵션 → USB 디버깅**을 켜고 연결하거나 에뮬레이터를 실행하면 됩니다. adb 경로는 앱의 **설정·연동** 탭에서 직접 지정할 수도 있습니다.

## 기능

| 탭 | 내용 |
| --- | --- |
| **화면** | 실시간 미러링 (클릭 = 탭, 드래그 = 스와이프, 길게 = 롱프레스), 하드웨어 키, 텍스트 입력, 스크린샷, 녹화(최대 180초) |
| **뷰 계층** | 스크린샷 ↔ 트리 양방향 선택, 속성·셀렉터, 깊이별 노드 수, Compose 추정, **3D 깊이 분해도** |
| **화면 흐름** | 화면 그래프 (썸네일 + 동작 라벨), **자동 탐색**(결제·삭제·로그아웃·전송 버튼은 누르지 않음), 화면별 진입·진출 경로 |
| **로그** | 실시간 logcat (앱 PID 필터, 레벨, 검색), 최근 크래시 |
| **라이브러리** | APK의 DEX·네이티브 lib로 100여 개 라이브러리·프레임워크 탐지, 난독화 추정 |
| **앱 정보** | 버전·SDK·권한·Activity, 실행/재시작/종료, 딥링크 |
| **시나리오** | 에이전트가 남긴 검증 기록(단계별 스크린샷·판정)을 실시간 확인 |
| **설정·연동** | adb 경로, Claude Code MCP 원클릭 등록, 전용 에이전트 설치 |

## Claude Code 연동

앱의 **설정·연동** 탭에서 버튼 두 개만 누르면 됩니다.

1. **MCP 자동 등록** — 앱에 내장된 MCP 서버(도구 28개)를 `claude mcp add --scope user`로 등록합니다. Node를 따로 설치할 필요가 없습니다.
2. **에이전트 설치** — 전용 에이전트를 `~/.claude/agents/`에 복사합니다.

| 에이전트 | 하는 일 |
| --- | --- |
| `droidlens-verifier` | 자연어 시나리오를 실제 기기에서 단계별로 검증하고, 스크린샷이 포함된 HTML 리포트를 남깁니다 |
| `droidlens-analyst` | 기술 스택, UI 구조(View/Compose), 화면 지도를 분석합니다. [REA](https://github.com/morluto/rea)가 있으면 코드 수준까지 추적합니다 |

Claude Code를 재시작한 뒤 이렇게 요청하세요.
> droidlens-verifier로 쇼핑 앱에서 검색 → 상품 상세 → 찜하기 시나리오 검증해줘
>
> droidlens-analyst로 이 앱 기술 스택이랑 화면 구조 분석해줘

앱 없이 MCP만 쓰려면 Releases의 `droidlens-mcp.mjs`(Node 20+)를 받아 `claude mcp add --scope user droidlens -- node /path/to/droidlens-mcp.mjs`로 등록하세요.

## 산출물

모두 `~/.droidlens/`에 저장됩니다 (`DROIDLENS_HOME`으로 변경 가능).

| 폴더 | 내용 |
| --- | --- |
| `screenshots/`, `recordings/` | 스크린샷 PNG, 녹화 mp4 |
| `graphs/<패키지>/` | 화면 그래프 `graph.json`, `graph.mmd`(mermaid), 화면별 스크린샷 |
| `scenarios/<id>/` | 시나리오 검증 `report.html`, `scenario.json`, 단계별 스크린샷 |
| `apks/<패키지>/` | 분석용 APK |

## 온디바이스 에이전트

기기를 연결하면 DroidLens가 작은 에이전트 앱(`io.github.eseungjun.droidlens.agent`, 13KB)을 자동으로 설치·실행합니다. 상단 바의 **⚡ 에이전트** 표시로 상태를 확인하고 끄고 켤 수 있습니다.

| | 에이전트 없음 (uiautomator) | 에이전트 |
| --- | --- | --- |
| 뷰 계층 덤프 | 1.5~3초 | 0.03~0.3초 |
| 현재 Activity | dumpsys 1~7초 | 즉시 (접근성 이벤트 추적) |
| 텍스트 입력 | ASCII만 | 한글 등 유니코드 |
| 화면 안정 판정 | 스크린샷 비교 | 접근성 idle + 구조 비교 |

에이전트는 UI 테스트 도구(Appium, uiautomator)와 같은 Instrumentation 권한으로만 동작하고 네트워크는 기기 내부 `127.0.0.1`에서만 엽니다. 쓰지 않으려면 `DROIDLENS_AGENT=0`.

## 알려진 한계

- 네트워크·DB·SharedPreferences 같은 앱 내부 정보는 선택형 SDK가 필요 (개발 예정)
- WebView·Flutter·게임 엔진 화면은 접근성 노드가 적어 분석이 제한적
- Appium 등 다른 UiAutomation 도구와 동시에 쓸 수 없음 (상단 바에서 에이전트를 끄면 됨)

## 개발

```bash
pnpm install
pnpm build                              # core + mcp
pnpm dev                                # 데스크톱 앱 (개발 모드)
pnpm build:agent                        # 에이전트 APK (JDK 17 + Android SDK 필요)
pnpm dist                               # 현재 OS용 설치 파일 → apps/desktop/release/
```

```
packages/core     adb 엔진 (기기·입력·캡처, 뷰 계층, 화면 그래프·자동 탐색, 라이브러리 탐지, 시나리오)
packages/mcp      MCP 서버 (단일 파일 번들 droidlens-mcp.mjs)
android/agent     온디바이스 에이전트 APK (Instrumentation + HTTP)
apps/desktop      Electron + React
agents/           Claude Code 에이전트 정의
```

`v*` 태그를 푸시하면 GitHub Actions가 macOS(arm64/x64)·Windows(x64/arm64)·Linux 설치 파일을 빌드해 Releases에 올립니다. 로드맵은 [docs/ROADMAP.md](docs/ROADMAP.md).

## 라이선스

MIT
