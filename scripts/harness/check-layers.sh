#!/bin/bash
# 레이어 규칙 검사(docs/RULES.md 4·5·6번, 설계서 구조 규칙 S1·S2·S3). 저장소 루트에서: bash scripts/harness/check-layers.sh
#   S1 core 는 데스크톱·MCP 를 import 하지 않는다 (의존 방향: 앱 → core)
#   S2 렌더러는 Node·electron 모듈을 직접 쓰지 않는다 (main 과는 preload 의 window.dl 로만)
#   S3 데스크톱·MCP 는 adb 를 직접 띄우지 않는다 (기기 작업은 core 를 거친다)
# 주석 줄(// · *)은 보지 않는다.
set -u
bad=0
hit() { echo "[check-layers] $1: $2"; bad=$((bad + 1)); }
scan() { # <폴더> <정규식> <규칙 설명>
  [ -d "$1" ] || return 0
  while IFS= read -r line; do
    code="${line#*:*:}"
    case "$(printf '%s' "$code" | sed 's/^[[:space:]]*//')" in //* | \**) continue ;; esac
    hit "${line%%:${code}}" "$3"
  done < <(grep -rnE --include='*.ts' --include='*.tsx' --include='*.mts' --include='*.js' --include='*.mjs' "$2" "$1" 2>/dev/null)
}

scan packages/core/src "(from|import\(|require\()[[:space:]]*['\"](@droidlens/(mcp|desktop)|[./]*apps/desktop|[./]*packages/mcp)" \
  "S1: core 가 데스크톱·MCP 를 import 함. Fix: 공통 로직을 core 로 옮기고 앱이 core 를 부르게 하세요"
scan apps/desktop/src/renderer "(from|import\(|require\()[[:space:]]*['\"](electron|node:[a-z_/]+|fs|fs/promises|child_process|path|os|net)['\"]" \
  "S2: 렌더러가 Node·electron 을 직접 씀. Fix: main 에 IPC 를 두고 api.ts(window.dl) 로 부르세요"
scan apps/desktop/src "(spawn|execFile|execFileSync|spawnSync|exec|execSync)\([[:space:]]*['\"]adb['\"]" \
  "S3: 데스크톱이 adb 를 직접 띄움. Fix: @droidlens/core 의 Adb·DeviceAdb 를 쓰세요"
scan packages/mcp/src "(spawn|execFile|execFileSync|spawnSync|exec|execSync)\([[:space:]]*['\"]adb['\"]" \
  "S3: MCP 가 adb 를 직접 띄움. Fix: @droidlens/core 의 Adb·DeviceAdb 를 쓰세요"

if [ "$bad" -gt 0 ]; then
  echo "[check-layers] 위반 ${bad}곳 (docs/RULES.md 4~6번)"
  exit 1
fi
echo "[check-layers] 통과"
