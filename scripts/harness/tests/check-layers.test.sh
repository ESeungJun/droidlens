#!/bin/bash
# check-layers.sh 시험(docs/RULES.md 4·5·6번, 설계서 S1·S2·S3). 저장소 루트에서: bash scripts/harness/tests/check-layers.test.sh
# 작업 폴더는 이 폴더 안 .work (임시 폴더를 쓰지 않는다)
here="$(cd "$(dirname "$0")" && pwd)"; cl="$(dirname "$here")/check-layers.sh"
work="$here/.work/cl-$$"; rm -rf "$work"; mkdir -p "$work"
trap 'rm -rf "$work"' EXIT
pass=0; fail=0
check() { if eval "$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "실패: $1"; fi; }
run() { (cd "$work" && bash "$cl" 2>&1); }
put() { mkdir -p "$work/$(dirname "$1")"; printf '%b' "$2" > "$work/$1"; }
reset() { rm -rf "$work"; mkdir -p "$work"; }

ok_tree() {
  put packages/core/src/a.ts "import { x } from './b.js';\n"
  put packages/mcp/src/c.ts "import * as dl from '@droidlens/core';\n"
  put apps/desktop/src/main/d.ts "import { shell } from 'electron';\nimport { spawn } from 'node:child_process';\nspawn(claude.bin, args);\n"
  put apps/desktop/src/renderer/src/e.tsx "import { useState } from 'react';\nconst r = await window.dl.invoke('x');\n"
}

ok_tree
check "규칙을 지킨 트리는 통과" 'run >/dev/null'

reset; ok_tree; put packages/core/src/bad.ts "import { register } from '@droidlens/mcp';\n"
out=$(run)
check "S1: core 가 MCP 를 import 하면 실패" '! run >/dev/null'
check "S1: 파일:줄과 규칙을 알려 줌" 'printf "%s" "$out" | grep -q "packages/core/src/bad.ts:1:.*S1"'

reset; ok_tree; put packages/core/src/bad2.ts "import { x } from '../../../apps/desktop/src/main/qa';\n"
check "S1: core 가 데스크톱 파일을 상대 경로로 import 하면 실패" '! run >/dev/null'

reset; ok_tree; put apps/desktop/src/renderer/src/bad.tsx "import { readFile } from 'node:fs/promises';\n"
check "S2: 렌더러가 node: 모듈을 import 하면 실패" '! run >/dev/null'

reset; ok_tree; put apps/desktop/src/renderer/src/bad.tsx "import { ipcRenderer } from 'electron';\n"
check "S2: 렌더러가 electron 을 import 하면 실패" '! run >/dev/null'

reset; ok_tree; put apps/desktop/src/renderer/src/bad.tsx "const fs = require('fs');\n"
check "S2: 렌더러가 require('fs') 하면 실패" '! run >/dev/null'

reset; ok_tree; put apps/desktop/src/main/bad.ts "spawn('adb', ['devices']);\n"
check "S3: 데스크톱이 adb 를 직접 띄우면 실패" '! run >/dev/null'

reset; ok_tree; put packages/mcp/src/bad.ts "execFile(\"adb\", ['shell']);\n"
check "S3: MCP 가 adb 를 직접 띄우면 실패" '! run >/dev/null'

reset; ok_tree; put apps/desktop/src/main/f.ts "// spawn('adb') 는 쓰지 않는다\nconst m = /x/.exec(s);\n"
check "주석과 정규식 exec 는 안 잡음" 'run >/dev/null'

echo "check-layers 시험: 통과 $pass · 실패 $fail"
[ "$fail" -eq 0 ]
