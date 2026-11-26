import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseFigmaUrl } from './sources.js';

/**
 * QA 계획(문서 → 요구사항 → TC) 형식. 데스크톱·MCP·CLI가 같은 검사를 쓰도록 형식은 이 파일에만 둔다.
 * 저장은 store.ts, 문서 읽기는 sources.ts.
 */

export const QA_PLAN_VERSION = 1;

export const REQ_ID = /^R-\d{2,}$/;
export const CASE_ID = /^TC-\d{3,}$/;
export const SOURCE_ID = /^S\d+$/;
/** 계획 id 는 폴더 이름이 된다: 글자·숫자·._- 만, 점으로 시작하지 않음 */
export const PLAN_ID = /^[\p{L}\p{N}_-][\p{L}\p{N}._-]*$/u;

export const SOURCE_KINDS = ['md', 'txt', 'pdf', 'csv', 'xlsx', 'confluence', 'figma'] as const;
export const PRIORITIES = ['P0', 'P1', 'P2'] as const;
/** normal 정상 · exception 예외 · boundary 경계 · design 디자인 비교 */
export const CASE_KINDS = ['normal', 'exception', 'boundary', 'design'] as const;
/** yes 자동 · partial 일부(사람 확인 필요) · manual 사람만 */
export const AUTOMATABLE = ['yes', 'partial', 'manual'] as const;
/**
 * 사람이 다시 봐야 하는 이유. 에이전트가 다시 뽑을 때 core 가 붙이고, 사람이 TC 를 확인(선택·허용을 정함)하면 지운다.
 * danger-removed: 확인 필수 표시가 빠짐 (선택은 이전 값 그대로라 꺼져 있을 수 있다)
 * danger-changed: 사람이 본 뒤 확인 필수 TC 의 실행 내용이 바뀜 (허용·선택을 풀었다)
 */
export const REVIEW_REASONS = ['danger-removed', 'danger-changed'] as const;
export type QaReviewReason = (typeof REVIEW_REASONS)[number];
export const REVIEW_LABEL: Record<QaReviewReason, string> = {
  'danger-removed': '다시 보기: 확인 필수 표시가 빠졌어요. 실행할지 정해 주세요',
  'danger-changed': '다시 보기: 확인 필수 TC 내용이 바뀌었어요. 다시 허용해 주세요',
};

export const CASE_KIND_LABEL: Record<(typeof CASE_KINDS)[number], string> = {
  normal: '정상',
  exception: '예외',
  boundary: '경계',
  design: '디자인',
};

const line = z.string().trim().min(1).max(2000);

/** 문서 근거: 어느 문서의 어디인지 */
export const sourceRefSchema = z
  .object({
    source: z.string().regex(SOURCE_ID, '문서 번호는 S1, S2 … 형식입니다'),
    /** 쪽·절·시트·행 같은 위치 (예: "p.3", "2.1 로그인", "TC시트 12행") */
    locator: z.string().max(200).optional(),
    /** 근거 문장 일부 */
    quote: z.string().max(500).optional(),
  })
  .strict();

export const qaSourceSchema = z
  .object({
    id: z.string().regex(SOURCE_ID),
    kind: z.enum(SOURCE_KINDS),
    /** 파일 경로나 URL */
    ref: z.string().min(1).max(2000),
    title: z.string().max(300).optional(),
    /** 파일 내용 sha256 (링크는 없음) */
    hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    addedAt: z.number().int(),
  })
  .strict();

export const qaRequirementSchema = z
  .object({
    id: z.string().regex(REQ_ID, '요구사항 번호는 R-01 형식입니다'),
    text: line,
    source: sourceRefSchema.optional(),
  })
  .strict();

export const qaCaseSchema = z
  .object({
    id: z.string().regex(CASE_ID, 'TC 번호는 TC-001 형식입니다'),
    title: z.string().trim().min(1).max(300),
    requirements: z.array(z.string().regex(REQ_ID)).default([]),
    priority: z.enum(PRIORITIES),
    kind: z.enum(CASE_KINDS),
    preconditions: z.array(line).default([]),
    steps: z.array(line).min(1, '단계가 하나 이상 필요합니다'),
    expected: z.array(line).min(1, '기대 결과가 하나 이상 필요합니다'),
    /** 입력값 (계정·검색어 등) */
    data: z.string().max(2000).optional(),
    /** 확인 필수 동작 설명 (결제·삭제·전송·탈퇴 등). 없으면 비움 */
    danger: z
      .string()
      .trim()
      .max(500)
      .optional()
      .transform((v) => v || undefined),
    /** 확인 필수 동작을 실제로 해도 되는지. 사람만 켠다 (에이전트가 저장한 값은 무시) */
    allowDanger: z.boolean().default(false),
    automatable: z.enum(AUTOMATABLE).default('yes'),
    /** 이번 회차에 실행할지 */
    selected: z.boolean().optional(),
    /** 통과해 저장된 회귀 스크립트 이름 */
    script: z.string().max(200).regex(PLAN_ID, '스크립트 이름은 글자·숫자·._- 만 씁니다').optional(),
    /** 잇는 순간의 스크립트 파일 sha256. 이은 뒤 파일이 바뀌면 그 스크립트로 확인 필수 동작을 누르지 않는다 */
    scriptHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** 잇는 순간의 TC 내용(dangerFingerprint)의 sha256. 그 뒤 TC 가 바뀌면 이 스크립트는 다른 TC 를 시험하는 것이라 돌리지 않는다 */
    scriptCase: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** 디자인 TC: 비교할 Figma 프레임 */
    design: z
      .object({
        figma: z.string().max(2000).refine(isFigmaHttpsUrl, 'Figma 디자인 링크(https://www.figma.com/design/…)가 아닙니다'),
        node: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
    source: sourceRefSchema.optional(),
    notes: z.string().max(2000).optional(),
    /** 다시 보기 표시 (REVIEW_REASONS) */
    review: z.array(z.enum(REVIEW_REASONS)).optional(),
  })
  .strict();

export const qaPlanSchema = z
  .object({
    version: z.literal(QA_PLAN_VERSION),
    id: z.string().max(120).regex(PLAN_ID, '계획 id 는 글자·숫자·._- 만 씁니다'),
    name: z.string().trim().min(1).max(200),
    /** 대상 앱 패키지 */
    app: z
      .string()
      .regex(/^[a-zA-Z][\w]*(\.[\w]+)+$/, '패키지 이름 형식이 아닙니다')
      .optional(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    sources: z.array(qaSourceSchema).default([]),
    requirements: z.array(qaRequirementSchema).default([]),
    cases: z.array(qaCaseSchema).default([]),
  })
  .strict()
  .superRefine((p, ctx) => {
    const dup = (ids: string[], path: string) => {
      const seen = new Set<string>();
      ids.forEach((id, i) => {
        if (seen.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path, i, 'id'], message: `번호가 겹칩니다: ${id}` });
        seen.add(id);
      });
    };
    dup(p.sources.map((s) => s.id), 'sources');
    dup(p.requirements.map((r) => r.id), 'requirements');
    dup(p.cases.map((c) => c.id), 'cases');

    const reqs = new Set(p.requirements.map((r) => r.id));
    const srcs = new Set(p.sources.map((s) => s.id));
    const checkRef = (ref: z.infer<typeof sourceRefSchema> | undefined, path: (string | number)[]) => {
      if (ref && !srcs.has(ref.source)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `없는 문서입니다: ${ref.source}` });
    };
    p.requirements.forEach((r, i) => checkRef(r.source, ['requirements', i, 'source']));
    p.cases.forEach((c, i) => {
      checkRef(c.source, ['cases', i, 'source']);
      c.requirements.forEach((rid, j) => {
        if (!reqs.has(rid)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cases', i, 'requirements', j], message: `없는 요구사항입니다: ${rid}` });
      });
      if (c.kind !== 'design' && c.requirements.length === 0)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cases', i, 'requirements'], message: '덮는 요구사항이 하나 이상 필요합니다 (디자인 TC 제외)' });
      if (c.kind === 'design' && !c.design)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cases', i, 'design'], message: '디자인 TC에는 Figma 프레임(design.figma)이 필요합니다' });
    });
  });

export type QaSource = z.infer<typeof qaSourceSchema>;
export type QaRequirement = z.infer<typeof qaRequirementSchema>;
export type QaCase = z.infer<typeof qaCaseSchema>;
export type QaPlan = z.infer<typeof qaPlanSchema>;
export type QaSourceKind = (typeof SOURCE_KINDS)[number];

/** zod 오류를 사람이(그리고 에이전트가) 고칠 수 있는 줄 목록으로 */
export function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

/** 형식 검사. 실패하면 고칠 곳을 줄마다 적은 오류를 던진다 */
export function validatePlan(raw: unknown): QaPlan {
  const r = qaPlanSchema.safeParse(raw);
  if (!r.success) throw new Error(`QA 계획 형식 오류:\n${formatIssues(r.error)}`);
  return withDefaults(r.data);
}

/** selected 를 정하지 않은 TC: 확인 필수 동작이 없을 때만 기본 선택 */
function withDefaults(p: QaPlan): QaPlan {
  return { ...p, cases: p.cases.map((c) => ({ ...c, selected: c.selected ?? !c.danger })) };
}

/**
 * 에이전트가 만든 계획을 받을 때. 실제로 누르기 허용은 사람만 켤 수 있으므로 지우고,
 * 이미 저장된 계획(prev)이 있으면 같은 번호 TC의 사람 결정(allowDanger·selected·script)을 이어받는다.
 */
export function acceptAgentPlan(raw: unknown, prev?: QaPlan): QaPlan {
  const plan = validatePlan(raw);
  const before = new Map(prev?.cases.map((c) => [c.id, c]));
  return {
    ...plan,
    cases: plan.cases.map((c) => {
      const old = before.get(c.id);
      // 사람이 허용한 뒤 실행 내용(확인 필수 설명·단계·입력값 등)이 하나라도 바뀌면 다시 허용받아야 한다
      const same = !!old && dangerFingerprint(c) === dangerFingerprint(old);
      const allowDanger = old?.allowDanger === true && !!c.danger && same;
      // 확인 필수 TC 가 새로 생기거나 내용이 바뀌면 선택을 풀고, 그 밖에는 사람이 고른 값을 따른다
      const unselect = !!c.danger && !same;
      // 다시 보기 표시: 사람이 아직 확인하지 않은 표시는 내용이 그대로면 이어 간다
      const review = new Set<QaReviewReason>(same ? (old?.review ?? []) : []);
      if (old?.danger && !c.danger) review.add('danger-removed');
      if (old?.danger && c.danger && !same) review.add('danger-changed');
      return {
        ...c,
        allowDanger,
        selected: unselect ? false : (old?.selected ?? !c.danger),
        // 에이전트가 낸 표시는 받지 않는다
        review: review.size ? [...review] : undefined,
        // 스크립트 연결은 실행기가 통과한 TC 에만 붙인다. 에이전트가 낸 값은 받지 않고,
        // TC 실행 내용이 바뀌면 옛 흐름을 녹화한 스크립트라 버린다 (새 내용에 받은 허용으로 옛 흐름을 누르지 않게)
        script: same ? old?.script : undefined,
        scriptHash: same ? old?.scriptHash : undefined,
        scriptCase: same ? old?.scriptCase : undefined,
      };
    }),
  };
}

/** dangerFingerprint 의 sha256 (스크립트를 이은 TC 내용 비교용) */
export function caseContentHash(c: Pick<QaCase, 'danger' | 'steps' | 'preconditions' | 'expected' | 'data'>): string {
  return createHash('sha256').update(dangerFingerprint(c)).digest('hex');
}

/** 실제로 누르기 허용이 가리키는 실행 내용. 이 값이 같아야 이전 허용을 이어받는다 */
export function dangerFingerprint(c: Pick<QaCase, 'danger' | 'steps' | 'preconditions' | 'expected' | 'data'>): string {
  return JSON.stringify([c.danger ?? '', c.preconditions, c.steps, c.expected, c.data ?? '']);
}

function isFigmaHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !!parseFigmaUrl(u);
  } catch {
    return false;
  }
}

/** 다시 봐야 하는 TC 와 이유 (데스크톱·MCP 가 계획을 보여 줄 때 맨 위에 띄운다) */
export function qaReviewList(plan: QaPlan): { id: string; title: string; reasons: QaReviewReason[]; selected: boolean }[] {
  return plan.cases.filter((c) => c.review?.length).map((c) => ({ id: c.id, title: c.title, reasons: c.review!, selected: !!c.selected }));
}

export interface CoverageRow {
  requirement: QaRequirement;
  cases: string[];
  /** 고른 TC 중 이 요구사항을 덮는 것 */
  selected: string[];
}

/** 요구사항별로 덮는 TC (추적표). missingKinds: 정상 또는 예외 TC 가 빠진 요구사항 (디자인 TC 로만 덮인 것은 뺀다) */
export function qaCoverage(plan: QaPlan): {
  rows: CoverageRow[];
  uncovered: string[];
  unselected: string[];
  missingKinds: { id: string; missing: ('normal' | 'exception')[] }[];
} {
  const rows = plan.requirements.map((requirement) => {
    const cases = plan.cases.filter((c) => c.requirements.includes(requirement.id));
    return { requirement, cases: cases.map((c) => c.id), selected: cases.filter((c) => c.selected).map((c) => c.id) };
  });
  const missingKinds = plan.requirements.flatMap((r) => {
    const kinds = new Set(plan.cases.filter((c) => c.requirements.includes(r.id)).map((c) => c.kind));
    if (!kinds.size || (kinds.size === 1 && kinds.has('design'))) return [];
    const missing = (['normal', 'exception'] as const).filter((k) => !kinds.has(k));
    return missing.length ? [{ id: r.id, missing }] : [];
  });
  return {
    rows,
    uncovered: rows.filter((r) => r.cases.length === 0).map((r) => r.requirement.id),
    unselected: rows.filter((r) => r.cases.length > 0 && r.selected.length === 0).map((r) => r.requirement.id),
    missingKinds,
  };
}

/** 다음 번호 (TC-007 다음은 TC-008, 자리 수는 기존 최대를 따른다) */
export function nextId(ids: string[], prefix: 'R-' | 'TC-' | 'S'): string {
  const min = prefix === 'TC-' ? 3 : prefix === 'R-' ? 2 : 1;
  let max = 0;
  let width = min;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const digits = id.slice(prefix.length);
    if (!/^\d+$/.test(digits)) continue;
    max = Math.max(max, Number(digits));
    width = Math.max(width, digits.length);
  }
  return prefix + String(max + 1).padStart(width, '0');
}
