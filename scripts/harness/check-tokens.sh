#!/bin/bash
# 하드코딩한 색 검사. 저장소 루트에서 실행한다: bash scripts/harness/check-tokens.sh [예외 파일]
#   기존 저장소에 처음 붙일 때: bash scripts/harness/check-tokens.sh --baseline [예외 파일]
#     지금 위반이 있는 파일을 예외 파일 끝에 `경로  # 기준선 날짜, n곳` 으로 더하고 0으로 끝난다(이미 예외인 파일은 건너뜀).
#   찾는 것: #rgb·#rrggbb·#rrggbbaa, rgb()·rgba()·hsl()·hsla()(숫자 값), Color(0x…) (웹·Android·iOS 코드와 스타일 파일)
#   안 찾는 것: 주석(// …, /* … */), 토큰을 쓴 hsl(var(--…)), svg 자산, 심볼릭 링크
#   예외: scripts/harness/tokens.allow 에 한 줄에 경로 하나(글롭 가능). 토큰 파일과 기준선(기존 위반)을 적는다.
#         형식: `src/styles/tokens.css  # 토큰 원본` / `src/old/*.tsx  # 기준선, 이슈 #12`
# git 저장소면 추적 중인 파일만, 아니면 node_modules·dist·build 를 뺀 전체를 본다.
# 실패하면 위치 + Fix 를 출력하고 1로 끝난다. code-harness 스킬이 깔고 CI 가 돌린다(docs/RULES.md 2번).
baseline=0; [ "$1" = --baseline ] && { baseline=1; shift; }
allow="${1:-scripts/harness/tokens.allow}"
style='css|scss|sass|less|html|xml'
code='ts|tsx|js|jsx|mjs|cjs|vue|svelte|kt|kts|java|swift|dart'
hex='#([0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3,4})([^0-9A-Za-z_-]|$)'
fn='(rgba?|hsla?)\([[:space:]]*[0-9.]|Color\(0x[0-9A-Fa-f]{6,8}'
# 스타일 파일은 #hex 를 다 잡는다. 코드 파일은 값 자리(따옴표·백틱·콜론·괄호·쉼표·[·solid 뒤)만 잡는다.
# 주석 밖의 "이슈 #123" 을 색으로 보지 않게. [ 는 Tailwind 임의값 bg-[#1a2b3c].
pat_style="(^|[^A-Za-z0-9_&])$hex|$fn"
pat_code="([\"'\`:(,[]|solid|dashed|dotted)[[:space:]]*$hex|$fn"
# 줄 수는 그대로 두고 주석만 비운다(줄 번호가 맞게).
#   /* … */ 는 여러 줄에 걸쳐도 지운다. // 는 줄 처음이나 공백 뒤이고 앞의 따옴표 짝이 맞을 때만(문자열 안 " // " 와 http:// 는 남긴다).
#   ./ 는 - 로 시작하는 파일 이름 대비.
uncomment() {
  awk -v q="'" -v bt='`' '
    function cnt(s, c,  a) { return s == "" ? 0 : split(s, a, c) - 1 }
    { out = ""; s = $0
      while (s != "") {
        if (inb) { i = index(s, "*/"); if (!i) break; s = substr(s, i + 2); inb = 0; continue }
        i = index(s, "/*"); if (!i) { out = out s; break }
        out = out substr(s, 1, i - 1); s = substr(s, i + 2); inb = 1
      }
      for (k = 1; k < length(out); k++)
        if (substr(out, k, 2) == "//" && (k == 1 || substr(out, k - 1, 1) ~ /[ \t]/)) {
          pre = substr(out, 1, k - 1)
          if (cnt(pre, "\"") % 2 == 0 && cnt(pre, q) % 2 == 0 && cnt(pre, bt) % 2 == 0) { out = pre; break }
        }
      print out }' "./$1"
}

pats=()
if [ -f "$allow" ]; then
  while IFS= read -r l || [ -n "$l" ]; do
    l="${l%%#*}"; l="${l%$'\r'}"; l="${l#"${l%%[![:space:]]*}"}"; l="${l%"${l##*[![:space:]]}"}"
    [ -n "$l" ] && pats+=("$l")
  done < "$allow"
fi
allowed() { local p; for p in ${pats[@]+"${pats[@]}"}; do [[ "$1" == $p ]] && return 0; done; return 1; }

if [ "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)" ]; then   # 다른 저장소의 하위 폴더면 그 저장소 무시 목록을 따르지 않는다
  list() { git ls-files -z --cached --others --exclude-standard; }
else
  list() { find . \( -name node_modules -o -name dist -o -name build -o -name .git \) -prune -o -type f -print0; }
fi

hits=0; files=0; found=""
while IFS= read -r -d '' f; do
  f="${f#./}"
  case "$f" in *$'\n'*|*$'\r'*) continue ;; esac   # 이름에 줄바꿈이 든 파일은 CI 로그 줄을 위조할 수 있다
  [ -L "$f" ] && continue                          # 링크는 저장소 밖을 가리킬 수 있다
  [ -f "$f" ] || continue
  if [[ "$f" =~ \.($style)$ ]]; then pat="$pat_style"; elif [[ "$f" =~ \.($code)$ ]]; then pat="$pat_code"; else continue; fi
  allowed "$f" && continue   # [[ == ]] 의 * 는 / 도 넘는다(src/*.css 는 하위 폴더까지)
  files=$((files+1)); n=0
  while IFS= read -r m; do
    [ "$baseline" = 1 ] || echo "[check-tokens] $f:${m%%:*}: ${m#*:}"
    n=$((n+1))
  done < <(uncomment "$f" | grep -nEo "$pat" 2>/dev/null)
  [ "$n" -gt 0 ] && { hits=$((hits+n)); found="$found$n"$'\t'"$f"$'\n'; }
done < <(list)

if [ "$baseline" = 1 ]; then
  { : >> "$allow"; } 2>/dev/null || { echo "[check-tokens] $allow 에 쓸 수 없어요. Fix: 폴더가 있는지, 쓰기 권한이 있는지 보세요."; exit 1; }
  [ -s "$allow" ] && [ -n "$(tail -c1 "$allow")" ] && echo >> "$allow"   # 끝 줄에 이어 붙지 않게
  today=$(date +%F); added=0; spots=0; bad=0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    n="${line%%$'\t'*}"; f="${line#*$'\t'}"
    # 예외 파일은 # 뒤를 주석으로, 앞뒤 공백을 지우고 읽는다. 그렇게 읽으면 달라지는 경로는 적지 않는다.
    case "$f" in *'#'*|[[:space:]]*|*[[:space:]]) echo "[check-tokens] '$f' 는 경로에 # 나 앞뒤 공백이 있어 예외 파일에 적을 수 없어요. Fix: 파일 이름을 바꾸거나 색을 토큰으로 고치세요."; bad=1; continue ;; esac
    # 글롭·extglob 문자는 그 글자로만 맞게
    printf '%s  # 기준선 %s, %s곳\n' "$(printf '%s' "$f" | sed 's/[][*?\\+@!()|]/\\&/g')" "$today" "$n" >> "$allow" \
      || { echo "[check-tokens] $allow 에 '$f' 를 쓰지 못했어요."; bad=1; continue; }
    added=$((added+1)); spots=$((spots+n))
  done <<< "$found"
  echo "[check-tokens] 기준선: 파일 ${added}개(${spots}곳)를 $allow 에 더했어요. 줄마다 이슈 번호를 붙이고, 고친 파일은 줄을 지우세요."
  exit $bad
fi

if [ "$hits" -gt 0 ]; then
  echo "[check-tokens] 하드코딩한 색 ${hits}곳. Fix: 디자인 토큰(CSS var(--…)·테마 색)을 쓰세요. 토큰 원본 파일이거나 손대지 않을 기존 코드면 $allow 에 경로와 이유를 적으세요."
  exit 1
fi
echo "[check-tokens] 파일 ${files}개 확인, 하드코딩한 색 없음"
exit 0
