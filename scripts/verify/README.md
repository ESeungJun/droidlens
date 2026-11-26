# 실행 확인 스크립트

`docs/기능지도.md` 의 기능을 실제 빌드에서 확인하는 스크립트를 둬요. 매번 즉석으로 브라우저·기기를 조작하지 않고, 한 번 확인한 흐름은 여기 남겨 다음부터 다시 돌려요.

약속
- 이름: `F<번호>-<짧은 이름>.<sh|mjs|py>` (예: `F1-search.sh`). 기능 지도 ID 와 같은 번호를 써요.
- 인자: 첫 번째 인자는 캡처를 둘 폴더예요(예: `~/Documents/검토요청/<프로젝트>/YYYY-MM-DD_<작업>/시나리오`). 없으면 캡처를 남기지 않아요.
- 결과: 성공이면 0, 실패면 0이 아닌 값으로 끝내고, 실패한 단계와 기대·실제 값을 한 줄로 출력해요.
- 시작 상태(로그인·데이터·화면 크기)를 스크립트 머리 주석에 적어요. 재현할 수 없으면 근거가 안 돼요.
- 비밀값은 넣지 않아요. 계정이 필요하면 환경 변수 이름만 적어요(`.env.example`).

도구
- 이 저장소 `docs/도구.md` 의 화면 확인 칸에 정한 것을 쓴다.
- 정한 것이 없을 때의 기본: 웹은 브라우저 자동화(예: Playwright), 모바일 기기·에뮬레이터는 `adb`(설치·실행·`uiautomator dump`·`screencap`), 데스크톱은 OS 스크린샷

돌리기: `bash scripts/verify/F1-search.sh <캡처 폴더>` · 전부:

```bash
out=.work/verify; mkdir -p "$out"
for s in scripts/verify/F*; do
  case "$s" in *.sh) bash "$s" "$out" ;; *.mjs) node "$s" "$out" ;; *.py) python3 "$s" "$out" ;; *) continue ;; esac || echo "실패: $s"
done
```
