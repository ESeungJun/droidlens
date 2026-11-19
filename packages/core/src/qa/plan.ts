import { z } from 'zod';

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
    /** 위험 행동 설명 (결제·삭제·전송·탈퇴 등). 없으면 비움 */
    danger: z.string().max(500).optional(),
    /** 위험 행동을 실제로 해도 되는지. 사람만 켠다 (에이전트가 저장한 값은 무시) */
    allowDanger: z.boolean().default(false),
    automatable: z.enum(AUTOMATABLE).default('yes'),
    /** 이번 회차에 실행할지 */
    selected: z.boolean().optional(),
    /** 통과해 저장된 회귀 스크립트 이름 */
    script: z.string().max(200).optional(),
    /** 디자인 TC: 비교할 Figma 프레임 */
    design: z
      .object({ figma: z.string().url().max(2000), node: z.string().max(100).optional() })
      .strict()
      .optional(),
    source: sourceRefSchema.optional(),
    notes: z.string().max(2000).optional(),
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

/** selected 를 정하지 않은 TC: 위험 행동이 없을 때만 기본 선택 */
function withDefaults(p: QaPlan): QaPlan {
  return { ...p, cases: p.cases.map((c) => ({ ...c, selected: c.selected ?? !c.danger })) };
}

/**
 * 에이전트가 만든 계획을 받을 때. 위험 허용은 사람만 켤 수 있으므로 지우고,
 * 이미 저장된 계획(prev)이 있으면 같은 번호 TC의 사람 결정(allowDanger·selected·script)을 이어받는다.
 */
export function acceptAgentPlan(raw: unknown, prev?: QaPlan): QaPlan {
  const plan = validatePlan(raw);
  const before = new Map(prev?.cases.map((c) => [c.id, c]));
  return {
    ...plan,
    cases: plan.cases.map((c) => {
      const old = before.get(c.id);
      // 위험 행동 설명이 바뀌면 사람이 다시 허용해야 한다
      const allowDanger = old?.allowDanger === true && !!c.danger && c.danger === old.danger;
      // 새로 위험 행동이 붙은 TC 는 선택을 풀고, 그 밖에는 사람이 고른 값을 따른다
      const newlyDangerous = !!c.danger && !old?.danger;
      return {
        ...c,
        allowDanger,
        selected: newlyDangerous ? false : (old?.selected ?? !c.danger),
        script: c.script ?? old?.script,
      };
    }),
  };
}

export interface CoverageRow {
  requirement: QaRequirement;
  cases: string[];
  /** 고른 TC 중 이 요구사항을 덮는 것 */
  selected: string[];
}

/** 요구사항별로 덮는 TC (추적표) */
export function qaCoverage(plan: QaPlan): { rows: CoverageRow[]; uncovered: string[]; unselected: string[] } {
  const rows = plan.requirements.map((requirement) => {
    const cases = plan.cases.filter((c) => c.requirements.includes(requirement.id));
    return { requirement, cases: cases.map((c) => c.id), selected: cases.filter((c) => c.selected).map((c) => c.id) };
  });
  return {
    rows,
    uncovered: rows.filter((r) => r.cases.length === 0).map((r) => r.requirement.id),
    unselected: rows.filter((r) => r.cases.length > 0 && r.selected.length === 0).map((r) => r.requirement.id),
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
