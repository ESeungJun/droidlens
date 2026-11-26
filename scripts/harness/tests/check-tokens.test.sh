#!/bin/bash
# check-tokens.sh 시험(docs/RULES.md 2번). 저장소 루트에서: bash scripts/harness/tests/check-tokens.test.sh
# 작업 폴더는 이 폴더 안 .work (임시 폴더를 쓰지 않는다)
here="$(cd "$(dirname "$0")" && pwd)"; ct="$(dirname "$here")/check-tokens.sh"
work="$here/.work/ct-$$"; rm -rf "$work"; mkdir -p "$work"
trap 'rm -rf "$work"' EXIT
pass=0; fail=0
check() { if eval "$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "실패: $1"; fi; }
run() { (cd "$work" && bash "$ct" "${1:-scripts/harness/tokens.allow}" 2>&1); }
put() { mkdir -p "$work/$(dirname "$1")"; printf '%b' "$2" > "$work/$1"; }
reset() { rm -rf "$work"; mkdir -p "$work"; }

put src/a.tsx 'const s = { color: "#1a2b3c" };\n'
out=$(run)
check "tsx 의 #hex 를 잡음" '! run >/dev/null'
check "파일:줄을 알려 줌" 'printf "%s" "$out" | grep -q "src/a.tsx:1:"'

reset; put src/b.css '.a { color: var(--text-1); }\n'
check "토큰만 쓰면 통과" 'run >/dev/null'

reset; put src/b.css '.a { border: 1px solid #ccc; }\n'
check "css 의 맨 #hex 를 잡음" '! run >/dev/null'

reset; put src/c.ts 'el.style.background = "rgba(0,0,0,.5)";\n'
check "rgba() 를 잡음" '! run >/dev/null'

reset; put app/Theme.kt 'val Brand = Color(0xFF3366FF)\n'
check "Kotlin Color(0x…) 를 잡음" '! run >/dev/null'

reset; put src/d.ts '// 이슈 #123 참고\nclass A { #count = 0; }\nconst e = "&#123;";\n'
check "주석의 이슈 번호·private 필드·HTML 엔티티는 안 잡음" 'run >/dev/null'

reset; put src/e.ts 'const b = `1px solid #ccc`;\n'
check "코드 안 solid #hex 를 잡음" '! run >/dev/null'

reset; put src/styles/tokens.css ':root { --text-1: #111111; }\n'
put scripts/harness/tokens.allow 'src/styles/tokens.css  # 토큰 원본\n'
check "예외 파일의 경로는 건너뜀" 'run >/dev/null'

reset; put src/legacy/old/x.tsx 'const c = "#fff";\n'
put scripts/harness/tokens.allow '# 설명 줄\nsrc/legacy/*   # 기준선, 이슈 #12\n'
check "글롭 예외는 하위 폴더까지" 'run >/dev/null'

reset; put node_modules/lib/x.css '.a{color:#fff}\n'
check "git 밖에서 node_modules 는 안 봄" 'run >/dev/null'

reset; put README.md '색은 #ffffff\n'
check "문서 파일은 안 봄" 'run >/dev/null'

reset; git -C "$work" init -q; put .gitignore 'gen/\n'; put gen/x.css '.a{color:#fff}\n'; put src/y.css '.a{color:#fff}\n'
out=$(run)
check "git 저장소면 무시 목록을 따름" '! printf "%s" "$out" | grep -q "gen/x.css"'
check "git 저장소에서 추적 안 된 새 파일도 봄" 'printf "%s" "$out" | grep -q "src/y.css"'

# 2026-11-23 리뷰 재현
reset; put src/tw.tsx 'export const A = () => <div className="bg-[#1a2b3c] p-2" />;\n'
check "Tailwind 임의값 bg-[#…] 를 잡음" '! run >/dev/null'

reset; put src/globals.css ':root { --bg: 0 0% 100%; }\n.a { color: hsl(var(--bg)); background: rgb(var(--bg) / .5); }\n'
check "토큰을 쓴 hsl(var(--…))·rgb(var(--…)) 는 안 잡음" 'run >/dev/null'

reset; put src/cmt.ts '// 고친 곳 (#123), 원인: #456, 참고 #345\nconst x = 1; // 이슈 (#789)\n/* 브랜드 "#ffffff" */\n'
check "주석 안의 이슈 번호·색은 안 잡음" 'run >/dev/null'

reset; put src/url.css '.a { background: url(http://x.example/a.png); color: #abcdef; }\n'
out=$(run)
check "주석을 지워도 http:// 뒤 값은 남음" 'printf "%s" "$out" | grep -q "src/url.css:1:"'

# 2차 리뷰 재현: 주석 지우기가 진짜 색을 지우면 안 됨
reset; put src/a.css '* { color: #ff0000; }\n*::before { background: rgb(1,2,3); }\n'
out=$(run)
check "CSS * 선택자 줄의 색을 잡음" 'printf "%s" "$out" | grep -q "src/a.css:1:" && printf "%s" "$out" | grep -q "src/a.css:2:"'
reset; put src/b.ts 'const s = "x // y"; const c = "#ff0000";\n'
check "문자열 안 // 뒤 색도 잡음" '! run >/dev/null'
reset; put src/c.ts '/*\n * 예전 색 "#ffffff"\n */\nconst c = "#00ff00";\n'
out=$(run)
check "여러 줄 주석은 건너뛰고 줄 번호는 맞음" 'printf "%s" "$out" | grep -q "src/c.ts:4:" && ! printf "%s" "$out" | grep -q "src/c.ts:2:"'

reset; put public/vite.svg '<svg><path fill="#41D1FF"/></svg>\n'
check "svg 자산은 안 봄" 'run >/dev/null'

reset; put app/src/main/res/drawable/ic_launcher_background.xml '<vector><path android:fillColor="#3DDC84"/></vector>\n'
put app/src/main/res/values/colors.xml '<color name="brand">#FF6200EE</color>\n'
cp "$(dirname "$ct")/tokens.allow" "$work/tokens.allow"
check "기본 예외 파일은 스택 자산을 미리 빼 두지 않음" '! (cd "$work" && bash "$ct" tokens.allow >/dev/null)'
printf 'app/src/main/res/values/colors.xml  # 토큰 원본\napp/src/main/res/drawable*/*  # 아이콘\n' >> "$work/tokens.allow"
check "저장소가 자산 경로를 적으면 통과" '(cd "$work" && bash "$ct" tokens.allow >/dev/null)'

reset; mkdir -p "$work/../ct-out-$$"; printf '#deadbe\n' > "$work/../ct-out-$$/outside.css"
mkdir -p "$work/src"; ln -s "../../ct-out-$$/outside.css" "$work/src/leak.css"
git -C "$work" init -q && git -C "$work" add src/leak.css
out=$(run)
check "git 이 추적하는 링크도 따라가지 않음" '! printf "%s" "$out" | grep -q leak.css'
rm -rf "$work/../ct-out-$$"

# --baseline: 지금 있는 위반을 예외 파일로 옮긴다(#17)
base() { (cd "$work" && bash "$ct" --baseline "${1:-tokens.allow}" 2>&1); }
reset; put src/a.tsx 'const a = "#111111";\nconst b = "#222222";\n'; put src/b.css '.b { color: #333; }\n'
put src/ok.css '.ok { color: var(--x); }\n'; put tokens.allow '# 예외\nsrc/styles/tokens.css  # 토큰 원본\n'
out=$(base); code=$?
check "기준선은 0으로 끝남" '[ "$code" = 0 ]'
check "위반 파일만 더함" 'grep -q "^src/a.tsx  # 기준선 .*, 2곳$" "$work/tokens.allow" && grep -q "^src/b.css  # 기준선 .*, 1곳$" "$work/tokens.allow" && ! grep -q ok.css "$work/tokens.allow"'
check "기존 줄은 그대로" 'head -2 "$work/tokens.allow" | grep -q "^src/styles/tokens.css  # 토큰 원본$"'
check "몇 개 더했는지 알려 줌" 'printf "%s" "$out" | grep -q "파일 2개"'
check "기준선 뒤 검사는 통과" '(cd "$work" && bash "$ct" tokens.allow >/dev/null)'
before=$(cat "$work/tokens.allow"); base >/dev/null
check "두 번 돌려도 같음" '[ "$(cat "$work/tokens.allow")" = "$before" ]'

reset; put 'src/[id]/page.tsx' 'const a = "#111111";\n'; put 'src/x/page.tsx' 'const a = "#222222";\n'
base tokens.allow >/dev/null; rm "$work/src/x/page.tsx"
put 'src/1/page.tsx' 'const a = "#444444";\n'
out=$(run tokens.allow)
check "글롭 문자는 이스케이프(그 파일만 예외)" 'printf "%s" "$out" | grep -q "src/1/page.tsx:1:" && ! printf "%s" "$out" | grep -q "\[id\]"'

reset; put 'src/a#b.css' '.a { color: #fff; }\n'
out=$(base tokens.allow)
check "# 든 경로는 못 적는다고 알림" 'printf "%s" "$out" | grep -q "src/a#b.css" && ! grep -q "a#b" "$work/tokens.allow" 2>/dev/null'
check "# 든 경로가 남으면 1로 끝남" '! base tokens.allow >/dev/null'

reset; put src/a.css '.a { color: #fff; }\n'
printf 'x.css  # 줄바꿈 없는 끝 줄' > "$work/tokens.allow"; base tokens.allow >/dev/null
check "끝 줄에 줄바꿈이 없어도 이어 붙이지 않음" 'grep -qx "x.css  # 줄바꿈 없는 끝 줄" "$work/tokens.allow" && grep -q "^src/a.css  # 기준선" "$work/tokens.allow"'

# 리뷰 재현(#17)
reset; put src/a.css '.a { color: #fff; }\n'
out=$(base nodir/tokens.allow); code=$?
check "예외 파일을 못 쓰면 1로 끝나고 알림" '[ "$code" = 1 ] && printf "%s" "$out" | grep -q "쓸 수 없어요" && ! printf "%s" "$out" | grep -q "더했어요"'
reset; put ' lead.css' '.a { color: #fff; }\n'; put "$(printf '\t')tab.css" '.a { color: #fff; }\n'
out=$(base tokens.allow); code=$?
check "앞에 공백·탭이 붙은 경로는 거절" '[ "$code" = 1 ] && ! grep -q "lead.css\|tab.css" "$work/tokens.allow"'
reset; put 'src/ lead.css' '.a { color: #fff; }\n'; put 'my dir/a b.css' '.a { color: #fff; }\n'; base tokens.allow >/dev/null
check "중간 공백 경로는 적고 맞음" '(cd "$work" && bash "$ct" tokens.allow >/dev/null)'
reset; put 'src/+(x).css' '.a { color: #fff; }\n'; base tokens.allow >/dev/null; put src/x.css '.b { color: #000; }\n'
out=$(run tokens.allow)
check "extglob 문자도 이스케이프(+(x) 가 x 를 덮지 않음)" 'printf "%s" "$out" | grep -q "src/x.css:1:"'

reset; put src/a.css '.a { color: #fff; }\n'; base tokens.allow >/dev/null
check "예외 파일이 없으면 만듦" 'grep -q "^src/a.css  # 기준선" "$work/tokens.allow"'

echo "check-tokens 시험: 통과 $pass, 실패 $fail"
[ "$fail" = 0 ]
