import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import type { QaSourceKind } from './plan.js';
import type { QaTable } from './tc-table.js';

/**
 * QA 문서 읽기: 파일(md·txt·PDF·CSV·엑셀)을 에이전트가 읽을 글(markdown)로 바꾼다.
 * Confluence·Figma 링크는 여기서 읽지 않는다. 사용자의 연결(커넥터)로 에이전트가 읽는다.
 */

/** 한 파일 상한. 기획서·TC 문서로는 넉넉하고, 실수로 큰 파일을 넣었을 때 멈추지 않게 */
export const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
/** 에이전트에게 넘길 글 상한 (대략 10만 토큰) */
export const MAX_SOURCE_TEXT = 400_000;
/** 표 하나에서 옮길 행 상한 */
export const MAX_TABLE_ROWS = 5_000;
/** 표 하나에서 옮길 열 상한. 셀 주소(예: ZZZZZ1)로 거대한 배열을 만들지 못하게 한다 */
export const MAX_TABLE_COLS = 256;
/** 엑셀 압축을 푼 XML 전체 상한. 실제 TC 엑셀은 몇 MB 이고, XML 을 객체로 바꾸면 수십 배 메모리를 쓴다 */
const MAX_XLSX_UNPACKED = 40 * 1024 * 1024;
/** 공유 문자열 XML 상한 (시트는 행 상한에서 잘라 읽는다) */
const MAX_XLSX_PART = 8 * 1024 * 1024;
/** 엑셀 시트 상한 */
const MAX_XLSX_SHEETS = 50;
/** PDF 쪽 상한 */
export const MAX_PDF_PAGES = 500;

const FILE_KINDS: Record<string, QaSourceKind> = {
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
  '.pdf': 'pdf',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.xlsx': 'xlsx',
};

export interface QaSourceFile {
  kind: QaSourceKind;
  /** 받은 경로 */
  ref: string;
  title: string;
  hash: string;
  bytes: Buffer;
  /** 에이전트가 읽을 글 */
  text: string;
  /** 글이 잘렸거나 비었을 때 사람이 알아야 할 것 */
  warnings: string[];
  /** csv·xlsx 의 표 (TC 표 가져오기용, #129) */
  tables?: QaTable[];
}

export interface QaSourceLink {
  kind: 'confluence' | 'figma';
  ref: string;
  /** Figma 면 파일 키와 노드 */
  figma?: { fileKey: string; nodeId?: string };
}

/** 입력이 링크인지 파일인지 가른다. 지원하지 않는 링크·확장자는 오류 */
export function classifyQaSource(input: string): { link: QaSourceLink } | { file: string; kind: QaSourceKind } {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      throw new Error(`링크 형식이 아닙니다: ${s}`);
    }
    if (url.protocol !== 'https:') throw new Error(`https 링크만 받습니다: ${url.host}`);
    const figma = parseFigmaUrl(url);
    if (figma) return { link: { kind: 'figma', ref: s, figma } };
    if (isConfluenceUrl(url)) return { link: { kind: 'confluence', ref: s } };
    throw new Error(`읽을 수 있는 링크는 Confluence·Figma 입니다: ${url.host}`);
  }
  const kind = FILE_KINDS[extname(s).toLowerCase()];
  if (!kind) {
    const ext = extname(s).toLowerCase();
    const hint = ext === '.xls' ? ' (예전 엑셀 형식은 .xlsx 로 다시 저장해 주세요)' : ext === '.docx' ? ' (PDF 나 md 로 내보내 주세요)' : '';
    throw new Error(`읽을 수 있는 파일은 md·txt·pdf·csv·tsv·xlsx 입니다: ${basename(s)}${hint}`);
  }
  return { file: s, kind };
}

/** figma.com/design|file|proto/<key>/...?node-id=1-2 → { fileKey, nodeId: '1:2' }. branch 링크는 branch 키를 쓴다 */
export function parseFigmaUrl(url: URL): { fileKey: string; nodeId?: string } | undefined {
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  if (!['design', 'file', 'proto'].includes(parts[0] ?? '') || !parts[1]) return undefined;
  const fileKey = parts[2] === 'branch' && parts[3] ? parts[3] : parts[1];
  const raw = url.searchParams.get('node-id');
  const nodeId = raw ? raw.replace(/-/g, ':') : undefined;
  return { fileKey, nodeId };
}

function isConfluenceUrl(url: URL): boolean {
  return /\.atlassian\.net$/i.test(url.hostname) ? url.pathname.startsWith('/wiki') : /\/(confluence|display|pages)\//i.test(url.pathname);
}

/** 파일을 읽어 글로 바꾼다 */
export async function readQaSourceFile(path: string): Promise<QaSourceFile> {
  const c = classifyQaSource(path);
  if (!('file' in c)) throw new Error('링크는 파일로 읽지 않습니다');
  const st = await stat(path).catch(() => undefined);
  if (!st?.isFile()) throw new Error(`파일이 없습니다: ${path}`);
  if (st.size > MAX_SOURCE_BYTES) throw new Error(`파일이 너무 큽니다 (${Math.round(st.size / 1024 / 1024)}MB, 상한 30MB): ${basename(path)}`);
  const bytes = await readFile(path);
  const warnings: string[] = [];
  let text: string;
  let tables: QaTable[] | undefined;
  switch (c.kind) {
    case 'md':
    case 'txt':
      text = decodeText(bytes, warnings);
      break;
    case 'csv': {
      const lines: number[] = [];
      const rows = parseCsv(decodeText(bytes, warnings), extname(path).toLowerCase() === '.tsv' ? '\t' : undefined, warnings, lines);
      text = tableToMarkdown(rows, warnings);
      const body = rows.slice(0, MAX_TABLE_ROWS + 1).map((r) => r.slice(0, MAX_TABLE_COLS));
      tables = [{ sheet: '', rows: body, rowNums: lines.slice(0, body.length) }];
      break;
    }
    case 'xlsx':
      tables = xlsxTables(bytes, warnings);
      text = tables.map((t) => `## 시트: ${t.sheet}\n\n${tableToMarkdown(t.rows, warnings, t.sheet)}`).join('\n\n');
      break;
    case 'pdf':
      text = await pdfToMarkdown(bytes, warnings);
      break;
    default:
      throw new Error(`읽을 수 없는 형식: ${c.kind}`);
  }
  text = text.replace(/\r\n?/g, '\n').trim();
  if (!text) warnings.push('읽은 글이 없습니다');
  if (text.length > MAX_SOURCE_TEXT) {
    text = text.slice(0, MAX_SOURCE_TEXT);
    warnings.push(`글이 길어 앞 ${MAX_SOURCE_TEXT.toLocaleString()}자만 옮겼습니다. 문서를 나눠 넣어 주세요`);
  }
  return { kind: c.kind, ref: path, title: basename(path), hash: sha256(bytes), bytes, text, warnings, tables };
}

export function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

/** UTF-16 BOM 이 있으면 UTF-16, 아니면 UTF-8 우선, 깨지면 한국어 엑셀이 내보내는 CP949 로 (경고) */
export function decodeText(b: Uint8Array, warnings: string[] = []): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    warnings.push('UTF-8 이 아니라 CP949(EUC-KR)로 읽었습니다. 글자가 깨졌으면 UTF-8 로 다시 저장해 주세요');
    return new TextDecoder('euc-kr').decode(b);
  }
}

// ---------- 표 ----------

/** RFC 4180 CSV (따옴표 안 쉼표·줄바꿈·"" 이스케이프). 구분자를 안 주면 첫 줄로 쉼표·탭·세미콜론 중 고른다 */
export function parseCsv(text: string, delimiter?: string, warnings: string[] = [], lineNums?: number[]): string[][] {
  const s = text.replace(/^\uFEFF/, '');
  const firstLine = s.slice(0, s.search(/\r?\n|$/));
  const delim = delimiter ?? [',', '\t', ';'].map((d) => [d, countOutsideQuotes(firstLine, d)] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  // 레코드마다 시작 줄 번호 (따옴표 안 줄바꿈도 원본 줄로 센다)
  const starts: number[] = [];
  let line = 1;
  let start = 1;
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n' || (ch === '\r' && s[i + 1] !== '\n')) line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      starts.push(start);
      line++;
      start = line;
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (quoted) warnings.push('닫히지 않은 따옴표가 있어 그 뒤 내용이 한 칸에 들어갔습니다. 원본 CSV 를 확인해 주세요');
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
    starts.push(start);
  }
  const keep = rows.map((r) => r.some((c) => c.trim() !== ''));
  lineNums?.push(...starts.filter((_, i) => keep[i]));
  return rows.filter((_, i) => keep[i]);
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (!q && ch === d) n++;
  }
  return n;
}

/** 첫 행을 머리줄로 하는 markdown 표. 칸 안 | 와 줄바꿈은 표가 깨지지 않게 바꾼다 */
export function tableToMarkdown(rows: string[][], warnings: string[] = [], label = ''): string {
  if (!rows.length) return '';
  let body = rows;
  if (rows.length > MAX_TABLE_ROWS + 1) {
    body = rows.slice(0, MAX_TABLE_ROWS + 1);
    warnings.push(`${label ? `${label}: ` : ''}행이 많아 앞 ${MAX_TABLE_ROWS.toLocaleString()}행만 옮겼습니다`);
  }
  // 값이 있는 마지막 열까지만 (테두리만 그린 빈 칸이 뒤에 붙지 않게)
  let width = body.reduce((m, r) => {
    for (let i = r.length - 1; i >= m; i--) if ((r[i] ?? '').trim() !== '') return i + 1;
    return m;
  }, 0);
  if (width > MAX_TABLE_COLS) {
    width = MAX_TABLE_COLS;
    warnings.push(`${label ? `${label}: ` : ''}열이 많아 앞 ${MAX_TABLE_COLS}열만 옮겼습니다`);
  }
  const cell = (v: string | undefined) => (v ?? '').trim().replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(' | ')} |`;
  const [head, ...rest] = body;
  return [line(head), `|${' --- |'.repeat(width)}`, ...rest.map(line)].join('\n');
}

// ---------- 엑셀 (.xlsx = zip 안의 XML) ----------

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // 숫자·공백을 그대로 둔다 (TC 번호 001, 앞뒤 공백 있는 문구)
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => ['sheet', 'Relationship', 'si', 'r', 'row', 'c'].includes(name),
});

/** 시트마다 `## 시트: 이름` 아래 markdown 표로 */
export function xlsxToMarkdown(bytes: Uint8Array, warnings: string[] = []): string {
  return xlsxTables(bytes, warnings)
    .map((t) => `## 시트: ${t.sheet}\n\n${tableToMarkdown(t.rows, warnings, t.sheet)}`)
    .join('\n\n');
}

/** 시트마다 값이 있는 행만 (원본 행 번호와 함께) */
export function xlsxTables(bytes: Uint8Array, warnings: string[] = []): QaTable[] {
  let files: Record<string, Uint8Array>;
  let unpacked = 0;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        const want = (f.name.startsWith('xl/') && f.name.endsWith('.xml')) || f.name.endsWith('.rels');
        // 압축을 풀면 터무니없이 커지는 파일(zip 폭탄)을 막는다
        if (want && (unpacked += f.originalSize) > MAX_XLSX_UNPACKED) throw new Error('too large');
        return want;
      },
    });
  } catch {
    if (unpacked > MAX_XLSX_UNPACKED) throw new Error('엑셀 파일이 너무 큽니다 (압축을 푼 크기 40MB 초과)');
    throw new Error('엑셀 파일을 열 수 없습니다 (암호가 걸렸거나 손상된 파일일 수 있어요)');
  }
  const text = (name: string) => (files[name] ? new TextDecoder().decode(files[name]) : undefined);
  const read = (name: string) => {
    const t = text(name);
    if (t !== undefined && t.length > MAX_XLSX_PART) throw new Error(`엑셀 파일이 너무 큽니다 (${name.split('/').pop()} 8MB 초과)`);
    return t === undefined ? undefined : xml.parse(t);
  };

  const shared: string[] = (read('xl/sharedStrings.xml')?.sst?.si ?? []).map(richText);
  const rels = new Map<string, string>(
    (read('xl/_rels/workbook.xml.rels')?.Relationships?.Relationship ?? []).map((r: Record<string, string>) => [r['@Id'], r['@Target']]),
  );
  const sheets: Record<string, string>[] = read('xl/workbook.xml')?.workbook?.sheets?.sheet ?? [];
  if (!sheets.length) throw new Error('엑셀 파일에 시트가 없습니다');

  const out: QaTable[] = [];
  const seen = new Set<string>();
  if (sheets.length > MAX_XLSX_SHEETS) warnings.push(`시트가 많아 앞 ${MAX_XLSX_SHEETS}개만 읽었습니다`);
  for (const sh of sheets.slice(0, MAX_XLSX_SHEETS)) {
    // 관계 속성은 보통 r:id 지만 접두어가 다른 도구도 있다
    const relKey = Object.keys(sh).find((k) => k.endsWith(':id'));
    const target = relKey ? rels.get(sh[relKey]) : undefined;
    if (!target) {
      warnings.push(`${sh['@name']}: 시트 위치를 찾지 못해 건너뛰었습니다`);
      continue;
    }
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    // 같은 시트 파일을 여러 시트가 가리켜도 한 번만 읽는다
    if (seen.has(path)) continue;
    seen.add(path);
    const sheetXml = text(path);
    if (sheetXml === undefined) continue;
    // 객체로 바꾸기 전에 문자열에서 행 상한까지만 남긴다 (큰 시트 XML 을 통째로 파싱하지 않게)
    const rowsXml: Record<string, unknown>[] = xml.parse(cutRows(sheetXml, MAX_TABLE_ROWS + 2, MAX_XLSX_PART))?.worksheet?.sheetData?.row ?? [];
    const nonEmpty: string[][] = [];
    const rowNums: number[] = [];
    let colsCut = false;
    let rowNo = 0;
    for (const r of rowsXml) {
      const rAttr = Number(r['@r']);
      rowNo = Number.isInteger(rAttr) && rAttr > 0 ? rAttr : rowNo + 1;
      // 머리줄 + 상한 + 1행까지만 모은다 (넘친 것은 tableToMarkdown 이 잘랐다고 알린다)
      if (nonEmpty.length > MAX_TABLE_ROWS + 1) break;
      const row: string[] = [];
      let next = 0;
      for (const c of (r.c as Record<string, unknown>[] | undefined) ?? []) {
        const ref = c['@r'] as string | undefined;
        const col = ref ? colIndex(ref) : next;
        next = col + 1;
        if (col >= MAX_TABLE_COLS) {
          colsCut = true;
          continue;
        }
        const v = cellValue(c, shared);
        if (v !== '') row[col] = v;
      }
      const filled = Array.from(row, (v) => v ?? '');
      if (filled.some((v) => v.trim() !== '')) {
        nonEmpty.push(filled);
        rowNums.push(rowNo);
      }
    }
    if (colsCut) warnings.push(`${sh['@name']}: 열이 많아 앞 ${MAX_TABLE_COLS}열만 옮겼습니다`);
    if (!nonEmpty.length) continue;
    out.push({ sheet: String(sh['@name'] ?? ''), rows: nonEmpty, rowNums });
  }
  return out;
}

/** 시트 XML 을 n번째 </row> (또는 maxChars 안의 마지막 </row>) 뒤에서 자르고 닫는 태그를 붙인다 */
export function cutRows(sheet: string, n: number, maxChars: number): string {
  let end = -1;
  let from = 0;
  for (let i = 0; i < n; i++) {
    const at = sheet.indexOf('</row>', from);
    if (at < 0 || at + 6 > maxChars) break;
    end = at + 6;
    from = end;
  }
  // 자르지 않고 그대로 돌려주는 경로도 상한을 지킨다 (</row> 가 적거나 <row/> 만 많은 시트)
  if (end < 0 || sheet.indexOf('</row>', end) < 0) {
    if (sheet.length > maxChars) throw new Error('엑셀 파일이 너무 큽니다 (시트 하나가 8MB 초과)');
    return sheet;
  }
  return `${sheet.slice(0, end)}</sheetData></worksheet>`;
}

/** A1 → 0, AB12 → 27 */
function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  // 엑셀 열은 XFD(16384)까지라 4글자 넘으면 상한 밖으로 본다
  if (letters.length > 3) return Number.MAX_SAFE_INTEGER;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** <si><t>..</t></si> 또는 서식 조각 <si><r><t>..</t></r>…</si> */
function richText(si: unknown): string {
  if (si == null) return '';
  if (typeof si === 'string') return si;
  const o = si as Record<string, unknown>;
  if (o.t !== undefined) return textOf(o.t);
  if (Array.isArray(o.r)) return o.r.map((r) => textOf((r as Record<string, unknown>).t)).join('');
  return '';
}

function textOf(t: unknown): string {
  if (t == null) return '';
  const raw = typeof t === 'object' ? String((t as Record<string, unknown>)['#text'] ?? '') : String(t);
  // OOXML 이스케이프 (_x000D_ = CR 등)
  return raw.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function cellValue(c: Record<string, unknown>, shared: string[]): string {
  const type = c['@t'] as string | undefined;
  if (type === 'inlineStr') return richText(c.is);
  const v = textOf(c.v);
  if (type === 's') return shared[Number(v)] ?? '';
  if (type === 'b') return v === '1' ? 'TRUE' : 'FALSE';
  return v;
}

// ---------- PDF ----------

/** 쪽마다 `## p.N`. 글자층이 없는 스캔본이면 경고 */
async function pdfToMarkdown(bytes: Uint8Array, warnings: string[]): Promise<string> {
  let pages: string[];
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    // pdf.js 가 받은 버퍼를 넘겨받아 비우므로 복사본을 준다
    // isEvalSupported 는 넘기지 않는다: 들어 있는 pdf.js(6.x)는 이 옵션을 없앴고 eval·new Function 경로가 없다 (#74 보안 리뷰 확인)
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    try {
      if (doc.numPages > MAX_PDF_PAGES) throw new Error(`쪽이 너무 많습니다 (${doc.numPages}쪽, 상한 ${MAX_PDF_PAGES}쪽). 문서를 나눠 넣어 주세요`);
      pages = (await extractText(doc, { mergePages: false })).text as string[];
    } finally {
      await doc.loadingTask.destroy();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith('쪽이 너무 많습니다')) throw new Error(`PDF ${msg}`);
    throw new Error(/password/i.test(msg) ? 'PDF 에 암호가 걸려 있어 읽을 수 없습니다' : `PDF 를 읽을 수 없습니다: ${msg}`);
  }
  const blank = pages.filter((p) => !p.trim()).length;
  if (pages.length && blank === pages.length) warnings.push('PDF 에 글자층이 없습니다 (스캔본이면 글자를 인식한 PDF 로 다시 저장해 주세요)');
  else if (blank) warnings.push(`${blank}쪽은 글자가 없어 건너뛰었습니다`);
  return pages
    .map((t, i) => (t.trim() ? `## p.${i + 1}\n\n${t.trim()}` : ''))
    .filter(Boolean)
    .join('\n\n');
}
