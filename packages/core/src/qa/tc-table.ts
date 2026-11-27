import { nextId, PRIORITIES, type QaCase } from './plan.js';

/**
 * TC 표 가져오기 (#129): 사람이 만든 TC 엑셀·CSV 를 모델 없이 열 이름으로 읽어 원문 그대로 TC 로 옮긴다.
 * 바꾸는 것은 칸을 줄로 나누고 줄 앞뒤 공백을 지우는 것뿐이다. 칸에 없는 값은 지어내지 않고 경고로 알린다.
 */

/** 표 한 장 (엑셀 시트 하나, CSV 파일 하나). rowNums 는 원본의 행 번호 (1부터) */
export interface QaTable {
  sheet: string;
  rows: string[][];
  rowNums: number[];
}

export const TC_FIELDS = ['id', 'title', 'preconditions', 'steps', 'expected', 'priority', 'kind', 'notes'] as const;
export type TcField = (typeof TC_FIELDS)[number];
/** 칸 → 열 번호 (0부터) */
export type TcColumnMap = Partial<Record<TcField, number>>;

/** 머리글 별칭. 비교할 때는 소문자로 바꾸고 공백·기호를 뺀다 */
const ALIASES: Record<TcField, string[]> = {
  id: ['tc id', 'tc no', 'test case no', 'test case number', 'tc 번호', 'tc번호', 'test id', 'case id', 'test case id', '케이스 id', '케이스 번호', '테스트 id', 'no', 'no.', '번호', 'id', '순번', '#'],
  title: ['title', 'test title', 'test case', 'test case name', 'test name', 'case name', 'summary', 'scenario', 'description', '제목', '테스트 항목', '항목', '테스트 케이스', '테스트케이스', '케이스명', '테스트명', '시나리오', '확인 항목', '점검 항목', '검증 항목'],
  preconditions: ['precondition', 'preconditions', 'pre-condition', 'pre-conditions', 'prerequisite', 'prerequisites', 'setup', '사전 조건', '사전조건', '전제 조건', '전제조건', '선행 조건', '준비'],
  steps: ['steps', 'step', 'test steps', 'test step', 'procedure', 'actions', 'action', 'how to test', '테스트 절차', '절차', '단계', '테스트 단계', '수행 절차', '수행 방법', '테스트 방법', '재현 절차', '실행 절차', '진행 방법'],
  expected: ['expected', 'expected result', 'expected results', 'expected outcome', 'expectation', '기대 결과', '기대결과', '예상 결과', '예상결과', '기대 동작', '기대값', '기대 값'],
  priority: ['priority', 'severity', 'importance', '우선순위', '우선 순위', '중요도', '심각도', '등급'],
  kind: ['type', 'test type', 'case type', 'category type', '유형', '테스트 유형', '케이스 유형', '종류'],
  notes: ['notes', 'note', 'remark', 'remarks', 'comment', 'comments', 'memo', '비고', '메모', '참고', '참고 사항', '설명'],
};

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-.()[\]/:·]+/g, '');
const NORM_ALIASES = Object.fromEntries(TC_FIELDS.map((f) => [f, ALIASES[f].map(norm).filter(Boolean)])) as Record<TcField, string[]>;

export interface TcColumnDetect {
  /** 기대 결과 열과 제목·단계 중 하나를 찾았는지 */
  ok: boolean;
  map: TcColumnMap;
}

/** 영어 별칭은 5글자 이상만 머리글 속에서 찾는다 ('type'·'note' 가 "Device Type" 같은 엉뚱한 열에 붙지 않게) */
const containsOk = (a: string) => a.length >= (/^[a-z0-9]+$/.test(a) ? 5 : 3);

/**
 * 머리줄에서 열을 찾는다. 이름이 같은 열을 먼저, 그다음 별칭을 머리글이 품은 열 (예: "기대 결과 (Expected)").
 * 품은 경우는 가장 길게 맞는 별칭이 이긴다 ("Expected Action" 은 'action'(단계)보다 'expected'(기대 결과)).
 * 기대 결과 열과 제목·단계 중 하나가 있어야 TC 표로 본다. 일정표·액션 아이템 표처럼 기대 결과가 없는 표는 사람이 열을 고른다
 */
export function detectTcColumns(header: string[]): TcColumnDetect {
  const map: TcColumnMap = {};
  const used = new Set<number>();
  const heads = header.map((h) => norm(h ?? ''));
  for (const f of TC_FIELDS) {
    const i = heads.findIndex((h, i) => !!h && !used.has(i) && NORM_ALIASES[f].includes(h));
    if (i >= 0) {
      map[f] = i;
      used.add(i);
    }
  }
  const cands: { f: TcField; i: number; len: number }[] = [];
  for (const f of TC_FIELDS) {
    if (map[f] !== undefined) continue;
    heads.forEach((h, i) => {
      if (!h || used.has(i)) return;
      const len = Math.max(0, ...NORM_ALIASES[f].filter((a) => containsOk(a) && h.includes(a)).map((a) => a.length));
      if (len) cands.push({ f, i, len });
    });
  }
  cands.sort((a, b) => b.len - a.len || TC_FIELDS.indexOf(a.f) - TC_FIELDS.indexOf(b.f) || a.i - b.i);
  for (const c of cands) {
    if (map[c.f] !== undefined || used.has(c.i)) continue;
    map[c.f] = c.i;
    used.add(c.i);
  }
  return { ok: map.expected !== undefined && (map.title !== undefined || map.steps !== undefined), map };
}

/** 머리줄을 찾을 앞쪽 행 수 (표 위에 제목·작성자 줄이 있는 문서가 많다) */
const HEADER_SCAN = 10;

export interface TcTableFound {
  sheet: string;
  headerRow: number;
  headers: string[];
  detect: TcColumnDetect;
}

/** 표 앞쪽에서 TC 머리줄을 찾는다. 못 찾으면 칸이 가장 많이 찬 행을 열 고르기 후보로 돌려준다 */
export function findTcTable(t: QaTable): TcTableFound | undefined {
  if (t.rows.length < 2) return undefined;
  let best = -1;
  let bestFilled = 0;
  for (let i = 0; i < Math.min(HEADER_SCAN, t.rows.length - 1); i++) {
    const row = t.rows[i];
    const d = detectTcColumns(row);
    if (d.ok) return { sheet: t.sheet, headerRow: i, headers: row.map((h) => h ?? ''), detect: d };
    const filled = row.filter((v) => (v ?? '').trim() !== '').length;
    if (filled > bestFilled) {
      best = i;
      bestFilled = filled;
    }
  }
  if (best < 0 || bestFilled < 2) return undefined;
  const row = t.rows[best];
  // 찾은 열은 열 고르기 화면에 미리 채운다 (기대 결과 열만 못 찾은 표는 그 칸만 고르면 된다)
  return { sheet: t.sheet, headerRow: best, headers: row.map((h) => h ?? ''), detect: { ok: false, map: detectTcColumns(row).map } };
}

const MAX_LINE = 2000;
const MAX_TITLE = 300;
const MAX_NOTES = 2000;

/** 원본 우선순위 → P0·P1·P2. 모르는 값은 undefined */
export function mapPriority(v: string): QaCase['priority'] | undefined {
  const s = norm(v);
  if (!s) return undefined;
  const up = v.trim().toUpperCase();
  if ((PRIORITIES as readonly string[]).includes(up)) return up as QaCase['priority'];
  if (/^p[3-9]$/.test(s) || /^[4-9]$/.test(s)) return 'P2';
  if (['상', '높음', '최상', '긴급', 'high', 'highest', 'critical', 'blocker', 'urgent', 'must', '1'].includes(s)) return 'P0';
  if (['중', '보통', '중간', 'medium', 'normal', 'major', 'should', '2'].includes(s)) return 'P1';
  if (['하', '낮음', '최하', 'low', 'lowest', 'minor', 'trivial', 'could', '3'].includes(s)) return 'P2';
  return undefined;
}

function mapKind(v: string): QaCase['kind'] | undefined {
  const s = norm(v);
  if (!s) return undefined;
  if (/예외|에러|오류|negative|exception|error|abnormal|비정상/.test(s)) return 'exception';
  if (/경계|boundary|edge|한계/.test(s)) return 'boundary';
  if (/정상|positive|normal|happy|기본|기능|functional/.test(s)) return 'normal';
  return undefined;
}

/** 칸 하나를 줄로. 줄 앞뒤 공백만 지우고 빈 줄은 뺀다 (글자는 바꾸지 않는다) */
function cellLines(v: string | undefined, warn: (m: string) => void): string[] {
  return (v ?? '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      if (l.length <= MAX_LINE) return l;
      warn(`줄이 ${MAX_LINE}자를 넘어 잘랐어요`);
      return l.slice(0, MAX_LINE);
    });
}

export interface TcImportResult {
  cases: QaCase[];
  warnings: string[];
  /** 제목·단계·기대 결과가 모두 비어 건너뛴 행 수 (구분 행·빈 행) */
  skipped: number;
}

/**
 * 머리줄 아래 행을 TC 로 옮긴다. 번호는 기존 TC 번호 다음부터 붙이고, 원본 번호는 notes 에 남긴다.
 * 고른 열 밖의 값이 있는 칸도 "머리글: 값" 으로 notes 에 남겨 원본 내용을 잃지 않는다.
 */
export function importTcRows(
  t: QaTable,
  headerRow: number,
  map: TcColumnMap,
  opts: { sourceId: string; existingIds: string[]; header?: string[] },
): TcImportResult {
  const header = opts.header ?? t.rows[headerRow] ?? [];
  const width = Math.max(header.length, ...t.rows.map((r) => r.length));
  for (const [f, i] of Object.entries(map)) {
    if (i === undefined) continue;
    if (!Number.isInteger(i) || i < 0 || i >= width) throw new Error(`열 번호가 표 밖입니다: ${f}=${i}`);
  }
  if (map.title === undefined && map.steps === undefined) throw new Error('제목이나 단계 열을 골라 주세요');
  const mapped = new Set(Object.values(map).filter((i): i is number => i !== undefined));
  const ids = [...opts.existingIds];
  const cases: QaCase[] = [];
  const warnings = new Set<string>();
  let skipped = 0;
  const noExpected: string[] = [];
  for (let r = headerRow + 1; r < t.rows.length; r++) {
    const row = t.rows[r];
    const at = `${t.sheet ? `${t.sheet} ` : ''}${t.rowNums[r] ?? r + 1}행`;
    const warn = (m: string) => warnings.add(`${at}: ${m}`);
    const get = (f: TcField) => (map[f] === undefined ? '' : (row[map[f]!] ?? ''));
    const steps = cellLines(get('steps'), warn);
    const expected = cellLines(get('expected'), warn);
    let title = get('title').trim();
    if (!title && !steps.length && !expected.length) {
      if (row.some((v) => (v ?? '').trim() !== '')) skipped++;
      continue;
    }
    if (!title) title = steps[0] ?? expected[0];
    if (title.length > MAX_TITLE) {
      warn(`제목이 ${MAX_TITLE}자를 넘어 잘랐어요 (전문은 비고에 남겼어요)`);
    }
    const origId = get('id').trim();
    const pr = get('priority').trim();
    const kindText = get('kind').trim();
    const notes = [
      origId ? `원본 번호: ${origId}` : '',
      title.length > MAX_TITLE ? `원본 제목: ${title}` : '',
      pr && mapPriority(pr) !== pr.toUpperCase() ? `우선순위: ${pr}` : '',
      kindText ? `유형: ${kindText}` : '',
      get('notes').trim(),
      // 고르지 않은 열의 값도 남긴다
      ...row
        .map((v, i) => (mapped.has(i) || !(v ?? '').trim() ? '' : `${(header[i] ?? '').trim() || `${i + 1}열`}: ${v.trim()}`))
        .filter(Boolean),
    ]
      .filter(Boolean)
      .join('\n');
    if (notes.length > MAX_NOTES) warn(`비고가 ${MAX_NOTES}자를 넘어 잘랐어요`);
    if (!expected.length) noExpected.push(origId || at);
    const id = nextId(ids, 'TC-');
    ids.push(id);
    cases.push({
      id,
      title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title,
      requirements: [],
      priority: mapPriority(pr) ?? 'P1',
      kind: mapKind(kindText) ?? 'normal',
      track: 'tc',
      preconditions: cellLines(get('preconditions'), warn),
      steps: steps.length ? steps : [title.slice(0, MAX_LINE)],
      expected: expected.length ? expected : ['(원본에 기대 결과가 없어요. 확인할 것을 적어 주세요)'],
      allowDanger: false,
      automatable: 'yes',
      source: { source: opts.sourceId, locator: at.slice(0, 200) },
      notes: notes ? notes.slice(0, MAX_NOTES) : undefined,
    } as QaCase);
  }
  if (noExpected.length)
    warnings.add(`기대 결과가 비어 있는 TC ${noExpected.length}개: ${noExpected.slice(0, 5).join(', ')}${noExpected.length > 5 ? ' …' : ''}. 확인할 것을 적어 주세요`);
  if (skipped) warnings.add(`제목·단계·기대 결과가 모두 빈 행 ${skipped}개는 건너뛰었어요 (구분 행일 수 있어요)`);
  return { cases, warnings: [...warnings], skipped };
}
