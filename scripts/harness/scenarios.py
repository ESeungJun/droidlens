#!/usr/bin/env python3
"""docs/시나리오.md 표 해석 (scenario-review 1절). 한 곳에만 둔다.
- 프로젝트 저장소: code-harness 가 scripts/harness/ 에 깔고 check-map.sh 가 `python3 scripts/harness/scenarios.py ids` 로 쓴다
- keel: issue-ticket/issue.py 가 이 파일을 불러 쓴다(동작 비교 줄 뽑기, 새 시나리오 SC 확인, 릴리스 때 바뀐 시나리오)

표: | ID | 누가, 무엇을 | 시작 상태 | 단계 | 기대 결과 | 우선 |
- 끝 | 는 없어도 된다(GFM). 칸 안의 \\| 는 나누지 않는다. **SC-01**·[SC-01](#…) 도 ID 로 본다.

사용: python3 scenarios.py ids [docs/시나리오.md]   → SC ID 를 한 줄에 하나씩
"""
from __future__ import annotations

import re
import sys

SCENARIO_DOC = "docs/시나리오.md"
ROW = re.compile(r"^\|(.+?)\|?\s*$")  # 끝 | 는 없어도 된다(GFM)


def parse_scenarios(text: str | None) -> list[dict]:
    """시나리오 표의 행. ID 칸이 SC-숫자 인 줄만"""
    rows = []
    for l in (text or "").split("\n"):
        m = ROW.match(l.strip())
        if not m:
            continue
        cells = [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", m.group(1))]  # 칸 안의 \| 는 나누지 않는다
        sid = re.sub(r"[*`\[\]]|\(.*?\)", "", cells[0]).strip()  # **SC-01**·[SC-01](#…) 도 ID 로 본다
        if len(cells) < 6 or not re.fullmatch(r"SC-\d+", sid):
            continue
        rows.append({"id": sid, "what": cells[1], "start": cells[2], "steps": cells[3], "expect": cells[4], "prio": cells[5]})
    return rows


def has(text: str, x: str) -> bool:
    """x 가 SC-12·F3 같은 ID 꼴이면 낱말 경계로(F1 이 F10 에 걸리지 않게), 아니면 부분 일치"""
    if re.fullmatch(r"(?:SC-|F)\d+", x) or re.fullmatch(r"\[SC-\d+\]", x):
        return re.search(r"(?<![\w-])" + re.escape(x) + r"(?!\d)", text) is not None
    return x in text


def pick(rows: list[dict], areas: list[str]) -> list[dict]:
    """ID·누가 무엇을·단계 칸에 그 글자(기능 지도 ID F3, 화면 이름, SC ID)가 든 시나리오. 시작 상태 칸은 보지 않는다"""
    return [r for r in rows if any(has(r["id"], x) or has(r["what"], x) or has(r["steps"], x) for x in areas)]


def compare_line(r: dict, ref: str) -> str:
    return f"- [ ] [{r['id']}] {r['what']} · 기대: {r['expect']} · 기준: {ref}"


def scenario_diff(old: list[dict], new: list[dict]) -> tuple[list[dict], list[tuple[dict, dict]], list[str]]:
    """(더해진 행, (옛 행, 새 행) 바뀐 것, 빠진 ID)"""
    o = {r["id"]: r for r in old}
    n = {r["id"]: r for r in new}
    added = [r for k, r in n.items() if k not in o]
    changed = [(o[k], r) for k, r in n.items() if k in o and r != o[k]]
    removed = [k for k in o if k not in n]
    return added, changed, removed


def main(argv: list[str]) -> int:
    if len(argv) >= 1 and argv[0] == "ids":
        path = argv[1] if len(argv) > 1 else SCENARIO_DOC
        try:
            text = open(path, encoding="utf-8").read()
        except OSError as e:
            print(f"{path} 를 못 읽었어요: {e}", file=sys.stderr)
            return 1
        for r in parse_scenarios(text):
            print(r["id"])
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
