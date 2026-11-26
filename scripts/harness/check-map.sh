#!/bin/bash
# 기능 지도(docs/기능지도.md) 검사. 저장소 루트에서 실행한다: bash scripts/harness/check-map.sh [지도 경로]
#   - 기능 ID(F1 …)가 겹치지 않는가
#   - 코드·확인 스크립트 칸에 `경로` 로 적은 것이 실제로 있는가(저장소 밖 경로 금지)
#   - 확인 스크립트 칸이 `경로`(백틱) 또는 손 인가
#   - 시나리오 칸의 SC-xx 가 docs/시나리오.md 에 있는가(그 파일이 있을 때)
# 실패하면 무엇이 틀렸는지 + Fix 를 출력하고 1로 끝난다. code-harness 스킬이 깔고 CI 가 돌린다(docs/RULES.md 3번).
map="${1:-docs/기능지도.md}"; sc_doc="${CHECK_MAP_SCENARIOS:-docs/시나리오.md}"
# 시나리오 ID 는 scenarios.py(표 해석을 한 곳에 둠: **SC-01**, 끝 | 없는 행, 칸 안 \|)로 읽는다. python3 가 없으면 줄 머리만 본다
here="$(cd "$(dirname "$0")" && pwd)"; sc_ids=""
if [ -f "$sc_doc" ]; then
  if command -v python3 >/dev/null 2>&1 && [ -f "$here/scenarios.py" ]; then
    sc_ids=$(python3 -I "$here/scenarios.py" ids "$sc_doc")
  else
    sc_ids=$(grep -oE '^\|[[:space:]]*SC-[0-9]+' "$sc_doc" | grep -oE 'SC-[0-9]+')
  fi
fi
[ -f "$map" ] || { echo "[check-map] $map 이 없어요. Fix: code-harness 스킬 1절로 기능 지도를 만드세요."; exit 1; }

trim() { local v="${1%$'\r'}"; v="${v#"${v%%[![:space:]]*}"}"; printf '%s' "${v%"${v##*[![:space:]]}"}"; }
paths() { printf '%s' "$1" | grep -o '`[^`]*`' | tr -d '`'; }
# 저장소 안 경로인가. 글자(../, ./..)와 실제 위치(링크로 밖을 가리키는 폴더) 둘 다 본다. 파일 자체가 링크여도 밖으로 본다.
root=$(pwd -P)
inrepo() {
  local p="$1" d
  while [ "${p%/}" != "$p" ]; do p="${p%/}"; done   # 끝의 / 는 링크를 따라가게 만든다
  case "$p" in ''|/*|..|../*|*/..|*/../*) return 1 ;; esac
  p="./$p"                                          # - 로 시작하는 이름이 옵션으로 읽히지 않게
  [ -L "$p" ] && return 1
  [ -e "$p" ] || return 0
  d=$(cd -P "$(dirname "$p")" 2>/dev/null && pwd -P) || return 1
  case "$d/" in "$root/"*) return 0 ;; esac; return 1
}
fail=0; rows=0; seen=" "; fence=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '```'*) fence=$((1-fence)); continue ;; esac   # 코드 블록 안 예시 줄은 기능이 아니다
  [ "$fence" = 1 ] && continue
  case "$line" in '|'*) ;; *) continue ;; esac
  line="${line//\\|/¦}"
  IFS='|' read -r _ id name where code sc verify _ <<<"$line"
  id=$(trim "$id"); code=$(trim "$code"); sc=$(trim "$sc"); verify=$(trim "$verify")
  [[ "$id" =~ ^F[0-9]+$ ]] || continue
  rows=$((rows+1))
  case "$seen" in *" $id "*) echo "[check-map] ${id} 가 두 번 나와요. Fix: ID 를 고치세요."; fail=1 ;; esac
  seen="$seen$id "
  if [ "$verify" != "손" ] && ! printf '%s' "$verify" | grep -q '`[^`]*[/.][^`]*`'; then
    echo "[check-map] ${id}: 확인 스크립트 칸이 '${verify}' 예요. Fix: 스크립트 경로를 백틱으로 감싸 적거나, 아직 없으면 '손' 이라고 적으세요."; fail=1
  fi
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    case "$p" in */*|*.*) ;; *) continue ;; esac
    inrepo "$p" || { echo "[check-map] ${id}: '$p' 는 저장소 밖 경로예요. Fix: 저장소 루트 기준 상대 경로로 적으세요(링크 말고 실제 파일)."; fail=1; continue; }
    [ -e "$p" ] || { echo "[check-map] ${id}: '$p' 가 없어요. Fix: 경로를 고치거나 파일을 만드세요."; fail=1; }
  done < <(paths "$code $verify")
  if [ -f "$sc_doc" ]; then
    for s in $(printf '%s' "$sc" | grep -oE 'SC-[0-9]+'); do
      printf '%s\n' "$sc_ids" | grep -qx "$s" \
        || { echo "[check-map] ${id}: 시나리오 ${s} 가 $sc_doc 에 없어요. Fix: 시나리오를 더하거나 ID 를 고치세요."; fail=1; }
    done
  fi
done < "$map"

[ "$fail" = 0 ] && echo "[check-map] 기능 ${rows}개 확인"
exit $fail
