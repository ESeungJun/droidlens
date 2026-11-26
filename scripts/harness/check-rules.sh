#!/bin/bash
# 코드 규칙표(docs/RULES.md) 검사. 저장소 루트에서 실행한다: bash scripts/harness/check-rules.sh [표 경로]
#   - 장치·시험 칸에 `경로` 로 적은 파일이 실제로 있는가
#   - 장치가 `글` 이 아닌 줄에 시험이 적혀 있는가
#   - 번호가 겹치지 않는가
#   - docs/설계서.md 의 구조 규칙(| S1 | …)이 표의 출처 칸에 다 있는가
#   - 실수 기록에서 횟수 2 이상인 줄에 표 번호(규칙 번호)나 '보류: 이유' 가 있는가
# 표 약속: 경로는 백틱으로 감싸고 '/' 나 '.' 을 넣는다. 칸 안에 | 를 쓰려면 \| 로 쓴다.
# macOS bash 3.2 와 리눅스 bash 5 둘 다에서 돈다("${no}번" 처럼 변수 뒤 한글은 중괄호로 감싼다).
# 실패하면 무엇이 틀렸는지 + Fix 를 출력하고 1로 끝난다. code-harness 스킬이 깔고 CI 가 돌린다.
table="${1:-docs/RULES.md}"
[ -f "$table" ] || { echo "[check-rules] $table 이 없어요. Fix: code-harness 스킬 1절로 규칙표를 만드세요."; exit 1; }

trim() { local v="${1%$'\r'}"; v="${v#"${v%%[![:space:]]*}"}"; printf '%s' "${v%"${v##*[![:space:]]}"}"; }  # xargs 는 따옴표에 걸린다
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
fail=0; rows=0; seen=" "; logs=""
while IFS= read -r line || [ -n "$line" ]; do   # 마지막 줄에 줄바꿈이 없어도 읽는다
  case "$line" in '|'*) ;; *) continue ;; esac
  line="${line//\\|/¦}"                       # 칸 안의 \| 는 칸 경계가 아니다
  IFS='|' read -r _ no rule src dev test memo _ <<<"$line"
  no=$(trim "$no"); dev=$(trim "$dev"); test=$(trim "$test")
  case "$no" in ''|번호|---*|날짜) continue ;; esac
  if [[ "$no" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2} ]]; then  # 실수 기록 표: 날짜(다시 나면 ", 날짜" 덧붙임) · 실수 · 어디서 · 횟수 · 표 번호
    bars="${line%$'\r'}"; bars="${bars//[!|]/}"
    [ "${#bars}" = 6 ] || { echo "[check-rules] 실수 기록 줄의 칸이 5개가 아니에요: $line Fix: 칸 안의 | 는 \\| 로 쓰세요."; fail=1; continue; }
    logs="$logs$(trim "$rule")|$(trim "$dev")|$(trim "$test")"$'\n'; continue
  fi
  [[ "$no" =~ ^[0-9]+$ ]] || continue
  rows=$((rows+1))
  case "$seen" in *" $no "*) echo "[check-rules] 번호 $no 가 두 번 나와요. Fix: 번호를 고치세요."; fail=1 ;; esac
  seen="$seen$no "
  if [ "$dev" != "글" ]; then
    [ -z "$test" ] && { echo "[check-rules] ${no}번: 장치($dev)에 시험이 없어요. Fix: 시험 칸에 시험 파일을 적으세요."; fail=1; }
    # 백틱 안에서 '/' 나 '.' 이 든 것만 경로로 본다(`no-restricted-imports` 같은 규칙 이름은 건너뜀). 공백 든 경로도 한 덩어리로.
    while IFS= read -r p; do
      case "$p" in */*|*.*) ;; *) continue ;; esac
      inrepo "$p" || { echo "[check-rules] ${no}번: '$p' 는 저장소 밖 경로예요. Fix: 저장소 루트 기준 상대 경로로 적으세요(링크 말고 실제 파일)."; fail=1; continue; }
      [ -e "$p" ] || { echo "[check-rules] ${no}번: '$p' 가 없어요. Fix: 경로를 고치거나 파일을 만드세요."; fail=1; }
    done < <(printf '%s %s' "$dev" "$test" | grep -o '`[^`]*`' | tr -d '`')
  fi
done < "$table"

[ "$rows" = 0 ] && { echo "[check-rules] 규칙이 하나도 없어요. Fix: 설계서의 구조 규칙부터 한 줄 적으세요."; exit 1; }

# 같은 실수가 두 번째면 규칙표로 올렸거나(표 번호) 막을 수 없는 이유(보류: …)가 있어야 한다(#32, mistake-guard 3절).
while IFS='|' read -r what cnt no; do
  [ -z "$what$cnt$no" ] && continue
  cnt=$(printf '%s' "$cnt" | grep -oE '^[0-9]+')
  [ -n "$cnt" ] || { echo "[check-rules] 실수 기록 '$what' 의 횟수가 숫자가 아니에요. Fix: 횟수 칸을 숫자(1, 2 …)로 시작하세요."; fail=1; continue; }
  [ "${#cnt}" -gt 3 ] && cnt=999
  [ "$cnt" -ge 2 ] || continue
  case "$no" in
    '') echo "[check-rules] 실수 기록 '$what' 가 ${cnt}번째인데 표 번호가 비었어요. Fix: mistake-guard 스킬로 장치를 만들고 규칙 번호를 적거나, 막을 수 없으면 '보류: 이유' 를 적으세요."; fail=1 ;;
    보류:*[![:space:]]*|보류：*[![:space:]]*) ;;
    보류*) echo "[check-rules] 실수 기록 '$what' 의 보류 칸 꼴이 달라요. Fix: '보류: 이유' 처럼 콜론 뒤에 이유를 적으세요."; fail=1 ;;
    *) set -f; for n in ${no//,/ }; do
         case "$n" in *[!0-9]*) ok=0 ;; *) case "$seen" in *" $n "*) ok=1 ;; *) ok=0 ;; esac ;; esac
         [ "$ok" = 1 ] || { echo "[check-rules] 실수 기록 '$what' 의 표 번호 $n 이 규칙표에 없어요. Fix: 규칙표의 번호(여럿이면 쉼표로)나 '보류: 이유' 를 적으세요."; fail=1; }
       done; set +f ;;
  esac
done <<<"$logs"

# 설계서 "구조 규칙" 표의 ID(S1, S2 …)가 규칙표 출처 칸에 다 있는가. 설계 → 개발이 손으로 옮기다 빠지지 않게(#15).
design="${CHECK_RULES_DESIGN:-docs/설계서.md}"
if [ -f "$design" ]; then
  # 규칙 칸이 "(예)" 로 시작하는 템플릿 예시 줄은 출처로 치지 않는다(예시의 "설계서 S1" 이 진짜 S1 을 덮지 않게)
  srcs=$(sed 's/\\|/¦/g' "$table" | awk -F'|' '$2 ~ /^[[:space:]]*[0-9]+[[:space:]]*$/ && $3 !~ /^[[:space:]]*\(예\)/ {print $4}')
  # 코드 블록 안 예시 표는 건너뛰고, | **S2** | 처럼 굵게 쓴 ID 도 읽는다
  for id in $(sed 's/\r$//' "$design" | awk '/^```/ {f=!f; next} !f' \
              | grep -oE '^\|[[:space:]]*(\*\*)?S[0-9]+(\*\*)?[[:space:]]*\|' | tr -d '|* \t'); do
    printf '%s\n' "$srcs" | grep -qE "(^|[^A-Za-z0-9])${id}([^0-9]|\$)" \
      || { echo "[check-rules] 설계서 구조 규칙 ${id} 가 규칙표에 없어요. Fix: docs/RULES.md 에 줄을 더하고 출처 칸에 '설계서 ${id}' 를 적으세요."; fail=1; }
  done
fi
[ "$fail" = 0 ] && echo "[check-rules] 규칙 ${rows}개 확인"
exit $fail
