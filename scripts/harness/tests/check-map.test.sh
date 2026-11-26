#!/bin/bash
# check-map.sh 시험(docs/RULES.md 3번). 저장소 루트에서: bash scripts/harness/tests/check-map.test.sh
# 작업 폴더는 이 폴더 안 .work (임시 폴더를 쓰지 않는다)
here="$(cd "$(dirname "$0")" && pwd)"; cm="$(dirname "$here")/check-map.sh"
work="$here/.work/cm-$$"; rm -rf "$work"; mkdir -p "$work/docs"
trap 'rm -rf "$work"' EXIT
pass=0; fail=0
check() { if eval "$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "실패: $1"; fi; }
run() { (cd "$work" && bash "$cm" 2>&1); }
head='| ID | 이름 | 어디서 | 코드 | 시나리오 | 확인 스크립트 |\n|---|---|---|---|---|---|\n'
map() { printf "$head%s\n" "$1" > "$work/docs/기능지도.md"; }

map ''
check "빈 지도는 통과(화면 없는 저장소)" 'run >/dev/null'

mkdir -p "$work/src/search" "$work/scripts/verify"; touch "$work/scripts/verify/F1-search.sh"
map '| F1 | 검색 | 홈 → 사이드바 | `src/search/` | - | `scripts/verify/F1-search.sh` |'
check "경로가 다 있으면 통과" 'run >/dev/null'

map '| F1 | 검색 | 홈 | `src/nope/` | - | 손 |'
out=$(run)
check "없는 코드 경로는 실패" '! run >/dev/null'
check "어느 기능인지 알려 줌" 'printf "%s" "$out" | grep -q "F1:"'

map '| F1 | 검색 | 홈 | `src/search/` | - | |'
check "확인 스크립트 칸이 비면 실패" '! run >/dev/null'

map '| F1 | 검색 | 홈 | `src/search/` | - | 손 |'
check "손 이라고 적으면 통과" 'run >/dev/null'

map "$(printf '| F1 | a | 홈 | `src/search/` | - | 손 |\n| F1 | b | 홈 | `src/search/` | - | 손 |')"
check "ID 중복은 실패" '! run >/dev/null'

map '| F1 | 검색 | 홈 | `/etc/hosts` | - | 손 |'
check "저장소 밖 경로는 실패" '! run >/dev/null'

printf '| ID | 누가 | 시작 | 단계 | 기대 | 우선 |\n|---|---|---|---|---|---|\n| SC-01 | a | b | c | d | P0 |\n' > "$work/docs/시나리오.md"
map '| F1 | 검색 | 홈 | `src/search/` | SC-01, SC-02 | 손 |'
out=$(run)
check "시나리오에 없는 SC 는 실패" '! run >/dev/null'
check "빠진 SC 를 알려 줌" 'printf "%s" "$out" | grep -q "SC-02"'
map '| F1 | 검색 | 홈 | `src/search/` | SC-01 | 손 |'
check "있는 SC 면 통과" 'run >/dev/null'
# 2026-11-24 keel#2: 표 해석을 scenarios.py 하나로(굵은 ID·끝 | 없는 행)
printf '| ID | 누가 | 시작 | 단계 | 기대 | 우선 |\n|---|---|---|---|---|---|\n| **SC-01** | a | b | c | d | P0 |\n| SC-02 | a | b | c | d | P1\n' > "$work/docs/시나리오.md"
map '| F1 | 검색 | 홈 | `src/search/` | SC-01, SC-02 | 손 |'
check "굵은 ID·끝 | 없는 행도 시나리오로 읽음" 'run >/dev/null'
map '| F1 | 검색 | 홈 | `src/search/` | SC-01 | 손 |'

printf '예:\n```\n| F9 | 예시 | 홈 | `src/none/` | - | 손 |\n```\n'"$head" > "$work/docs/기능지도.md"
check "코드 블록 안 예시 줄은 세지 않음" 'run >/dev/null'

# 2026-11-23 리뷰 재현
map '| F1 | 검색 | 홈 | `src/search/` | - | 나중에 |'
check "확인 칸이 손도 경로도 아니면 실패" '! run >/dev/null'
map '| F1 | 검색 | 홈 | `src/search/` | - | scripts/verify/F1-search.sh |'
check "백틱 없는 경로는 실패" '! run >/dev/null'
mkdir -p "$work/../cm-out-$$"; ln -sfn "$work/../cm-out-$$" "$work/src/out"
map '| F1 | 검색 | 홈 | `src/out` | - | 손 |'
check "저장소 밖 링크는 실패" '! run >/dev/null'
map '| F1 | 검색 | 홈 | `src/out/` | - | 손 |'
check "끝에 / 를 붙인 링크도 실패" '! run >/dev/null'
rm -f "$work/src/out"; rm -rf "$work/../cm-out-$$"
map '| F1 | 검색 | 홈 | `src/./..` | - | 손 |'
check "./.. 는 실패" '! run >/dev/null'

rm "$work/docs/기능지도.md"
check "지도가 없으면 실패" '! run >/dev/null'

echo "check-map 시험: 통과 $pass, 실패 $fail"
[ "$fail" = 0 ]
