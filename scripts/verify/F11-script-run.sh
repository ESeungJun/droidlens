#!/bin/bash
# F11 YAML 스크립트·회귀 실행 · SC-04: 저장된 스크립트를 CLI 로 다시 돌려 종료 코드와 JUnit 을 받는다.
#
# 시작 상태
#   - 저장소 루트에서 `pnpm build` 를 마친 상태 (packages/mcp/dist/droidlens-mcp.mjs)
#   - 기기 하나 연결, 샘플 앱 debug 빌드 설치: `cd android && ./gradlew :sample:installDebug`
#   - 에이전트 APK 가 옆에 없으면 DROIDLENS_AGENT_APK 로 알려 준다(없으면 uiautomator 로 돈다)
#   - 사용자의 ~/.droidlens 는 건드리지 않는다. DroidLens 홈은 <캡처 폴더>/F11-home 이나 .work/verify/F11-<시각>
#
# 사용: bash scripts/verify/F11-script-run.sh [캡처 폴더] [--serial <기기>]
# 결과: 성공 0, 실패 1(실패한 단계와 기대·실제를 한 줄로)
set -u
root="$(cd "$(dirname "$0")/../.." && pwd)"
capture=""; serial=""
while [ $# -gt 0 ]; do
  case "$1" in
    --serial) serial="${2:-}"; shift 2 ;;
    *) capture="$1"; shift ;;
  esac
done
fail() { echo "실패: $1 — 기대: $2 / 실제: $3" >&2; exit 1; }

cli="$root/packages/mcp/dist/droidlens-mcp.mjs"
[ -f "$cli" ] || fail "준비" "packages/mcp/dist/droidlens-mcp.mjs 가 있음 (pnpm build)" "없음"
if [ -n "$capture" ]; then home="$(mkdir -p "$capture" && cd "$capture" && pwd)/F11-home"
else home="$root/.work/verify/F11-$(date +%Y%m%d-%H%M%S)"; fi
mkdir -p "$home"

adb_s=(adb); [ -n "$serial" ] && adb_s=(adb -s "$serial")
"${adb_s[@]}" shell pm path io.github.eseungjun.droidlens.sample >/dev/null 2>&1 \
  || fail "준비" "샘플 앱이 설치된 기기" "기기가 없거나 샘플 앱이 없음"

junit="$home/junit.xml"; summary="$home/summary.md"
out=$(DROIDLENS_HOME="$home" node "$cli" run "$root/examples/scripts/sample-notes.yaml" \
  ${serial:+--serial "$serial"} --junit "$junit" --summary "$summary" 2>&1); code=$?
printf '%s\n' "$out" | tail -3
[ "$code" = 0 ] || fail "실행" "종료 코드 0" "종료 코드 $code"
grep -q 'failures="0"' "$junit" || fail "JUnit" 'failures="0"' "$(grep -o 'failures="[0-9]*"' "$junit" | head -1)"
[ -s "$summary" ] || fail "요약" "summary.md 가 있음" "없음"

# 실패 길: 없는 요소를 기다리는 스크립트는 종료 코드 1 이어야 한다(CI 가 실패를 받는다)
bad="$home/bad.yaml"
printf 'name: 없는 버튼\napp: io.github.eseungjun.droidlens.sample\nsteps:\n  - tap: { text: "없는 버튼", timeout: 1500 }\n' > "$bad"
DROIDLENS_HOME="$home" node "$cli" run "$bad" ${serial:+--serial "$serial"} >/dev/null 2>&1; code=$?
[ "$code" = 1 ] || fail "실패 길" "종료 코드 1" "종료 코드 $code"
echo "F11 확인 끝: 통과 스크립트 종료 코드 0, 실패 스크립트 종료 코드 1 (홈: $home)"
