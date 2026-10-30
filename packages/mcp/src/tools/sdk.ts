import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dl from '@droidlens/core';
import { device, text, json, serialArg, readOnly, acts, recorder } from '../common.js';

export function register(server: McpServer): void {
  // ---------- 앱 SDK (네트워크 · 저장소 · 이벤트) ----------

  const pkgArg = { packageName: z.string().describe('DroidLens SDK를 넣은 앱 패키지 (debug 빌드)') };
  const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)}… (${s.length}자 중 ${n}자)` : s);

  server.registerTool(
    'sdk_apps',
    { description: 'DroidLens SDK가 실행 중인 앱 목록 (네트워크·SharedPreferences·DB·이벤트 조회 가능)', inputSchema: serialArg, annotations: readOnly },
    async ({ serial }) => {
      const dev = await device(serial);
      const apps = await dl.listSdkApps(dev);
      if (!apps.length) return text('SDK가 실행 중인 앱이 없습니다. 앱 debug 빌드에 debugImplementation으로 SDK를 넣고 실행하세요.');
      const infos = await Promise.all(apps.map((p) => dl.sdkFor(dev, p).then((c) => c.info()).catch((e) => ({ package: p, error: (e as Error).message }))));
      return json(infos);
    },
  );

  server.registerTool(
    'network_requests',
    {
      description: '앱의 HTTP 요청 목록 (OkHttp + DroidLensInterceptor). 실패·느린 요청 찾기, API 호출 순서 확인에 사용',
      inputSchema: {
        ...serialArg,
        ...pkgArg,
        filter: z.string().optional().describe('URL 부분 문자열'),
        failedOnly: z.boolean().optional().describe('실패(예외) 또는 4xx/5xx만'),
        since: z.number().int().optional().describe('이 id 이후만 (이전 호출의 마지막 id)'),
        limit: z.number().int().optional().describe('기본 100'),
      },
      annotations: readOnly,
    },
    async ({ serial, packageName, filter, failedOnly, since, limit }) => {
      const c = await dl.sdkFor(await device(serial), packageName);
      let list = await c.network({ filter, since, limit: limit ?? 100 });
      if (failedOnly) list = list.filter((e) => e.state === 'failed' || e.status >= 400);
      if (!list.length) return text('(요청 없음)');
      return text(
        list
          .map((e) => `#${e.id} ${e.method} ${e.state === 'failed' ? 'FAIL' : e.status || '…'} ${e.durationMs >= 0 ? e.durationMs + 'ms' : ''} ${e.url}${e.mockId ? `  [목 ${e.mockId}]` : ''}${e.error ? `  ✗ ${e.error}` : ''}`)
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'network_request_detail',
    {
      description: 'HTTP 요청 하나의 헤더·요청 본문·응답 본문',
      inputSchema: { ...serialArg, ...pkgArg, id: z.number().int(), maxBodyChars: z.number().int().optional().describe('본문 최대 글자 수 (기본 4000)') },
      annotations: readOnly,
    },
    async ({ serial, packageName, id, maxBodyChars }) => {
      const c = await dl.sdkFor(await device(serial), packageName);
      const d = await c.networkDetail(id);
      const n = maxBodyChars ?? 4000;
      return json({
        ...d,
        requestBody: clip(d.requestBody, n),
        responseBody: clip(d.responseBody, n),
        requestBodyBase64: d.requestBodyBase64 ? `(바이너리 ${d.requestBodyBase64.length * 0.75 | 0}B)` : undefined,
        responseBodyBase64: d.responseBodyBase64 ? `(바이너리 ${d.responseBodyBase64.length * 0.75 | 0}B)` : undefined,
      });
    },
  );

  server.registerTool(
    'prefs_get',
    { description: '앱의 SharedPreferences 전체 (파일별 키·타입·값)', inputSchema: { ...serialArg, ...pkgArg, file: z.string().optional() }, annotations: readOnly },
    async ({ serial, packageName, file }) => {
      const files = await (await dl.sdkFor(await device(serial), packageName)).prefs();
      return json(file ? files.filter((f) => f.name === file) : files);
    },
  );

  server.registerTool(
    'prefs_set',
    {
      description: 'SharedPreferences 값 변경 (앱 상태를 바꾼다: 기능 플래그, 온보딩 여부 등 테스트 조건 만들기에 사용)',
      inputSchema: {
        ...serialArg,
        ...pkgArg,
        file: z.string(),
        key: z.string(),
        type: z.enum(['string', 'int', 'long', 'float', 'boolean', 'stringSet']),
        value: z.string().describe('stringSet은 JSON 배열 문자열'),
      },
      annotations: acts,
    },
    async ({ serial, packageName, file, key, type, value }) => {
      await (await dl.sdkFor(await device(serial), packageName)).setPref(file, key, type, value);
      return text(`${file}.${key} = ${value} (${type})`);
    },
  );

  server.registerTool(
    'prefs_remove',
    { description: 'SharedPreferences 키 삭제', inputSchema: { ...serialArg, ...pkgArg, file: z.string(), key: z.string() }, annotations: acts },
    async ({ serial, packageName, file, key }) => {
      await (await dl.sdkFor(await device(serial), packageName)).removePref(file, key);
      return text(`removed ${file}.${key}`);
    },
  );

  server.registerTool(
    'db_list',
    { description: '앱의 SQLite/Room DB와 테이블(컬럼, 행 수)', inputSchema: { ...serialArg, ...pkgArg }, annotations: readOnly },
    async ({ serial, packageName }) => {
      const dbs = await (await dl.sdkFor(await device(serial), packageName)).databases();
      return text(
        dbs
          .map((d) => `${d.name} (${(d.size / 1024).toFixed(0)}KB)${d.error ? ' ✗ ' + d.error : ''}\n` + d.tables.map((t) => `  - ${t.name} [${t.rowCount ?? '?'}행] ${t.columns.map((c) => `${c.name}:${c.type}${c.pk ? '*' : ''}`).join(', ')}`).join('\n'))
          .join('\n') || 'DB 없음',
      );
    },
  );

  server.registerTool(
    'db_query',
    {
      description: 'DB에 SQL 실행. 기본은 읽기(SELECT/PRAGMA/WITH)만 허용, 최대 500행. write=true면 INSERT/UPDATE/DELETE 등도 실행 (앱 데이터가 바뀜)',
      inputSchema: { ...serialArg, ...pkgArg, db: z.string(), sql: z.string(), write: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ serial, packageName, db, sql, write }) => {
      const r = await (await dl.sdkFor(await device(serial), packageName)).query(db, sql, write);
      if (r.changes !== undefined) return text(`${r.changes}행 변경`);
      const rows = (r.rows ?? []).map((row) => row.map((v) => (v === null ? 'NULL' : String(v))).join(' | '));
      return text([(r.columns ?? []).join(' | '), ...rows, r.truncated ? (r.totalExact === false ? `… 500행 넘음, 500행만 표시` : `… 총 ${r.total}행 중 500행`) : `(${r.total}행)`].join('\n'));
    },
  );

  server.registerTool(
    'app_events',
    { description: '앱이 DroidLens.event()로 남긴 커스텀 이벤트 (분석 이벤트 검증 등)', inputSchema: { ...serialArg, ...pkgArg, since: z.number().int().optional() }, annotations: readOnly },
    async ({ serial, packageName, since }) => {
      const ev = await (await dl.sdkFor(await device(serial), packageName)).events(since);
      return text(ev.map((e) => `#${e.id} ${new Date(e.at).toLocaleTimeString()} ${e.name} ${e.data ? JSON.stringify(e.data) : ''}`).join('\n') || '(이벤트 없음)');
    },
  );

  // ---------- 네트워크 목 ----------

  const mockLine = (m: dl.MockRule) =>
    `${m.id} ${m.enabled === false ? '(꺼짐) ' : ''}${m.method ?? '*'} *${m.url}* → ${m.fail ? '연결 실패' : m.status ? `${m.status} 응답` : '실제 요청'}${m.delayMs ? ` · ${m.delayMs}ms 지연` : ''} · ${m.hits ?? 0}회 적용`;

  server.registerTool(
    'network_mock_set',
    {
      description:
        '네트워크 목 규칙 추가·수정. 요청 URL 에 url 이 들어 있고 method 가 맞는 요청을 서버에 보내지 않고 status·body 응답으로 끝내거나(status), ' +
        '연결 실패로 끝내거나(fail), 늦춰 보낸다(delayMs). 오류·빈 목록·느린 응답 화면 재현에 쓴다. ' +
        '규칙은 앱 안에 저장돼 앱을 다시 시작해도 남으므로 검증이 끝나면 network_mock_remove 로 지운다. ' +
        'id 로 고치면 준 항목만 바뀐다. 시나리오 녹화 중 켠 규칙은 저장하는 스크립트의 setup.mocks 에 들어간다',
      inputSchema: {
        ...serialArg,
        ...pkgArg,
        id: z.string().optional().describe('바꿀 규칙 id. 없으면 새로 추가'),
        url: z.string().min(1).optional().describe('요청 URL 에 들어 있는 문자열 (예: api.example.com/v1/orders). 새로 추가할 때 필요'),
        method: z.string().optional().describe('없으면 모든 메서드'),
        status: z.number().int().min(200).max(599).optional().describe('돌려줄 상태 코드'),
        body: z.string().optional().describe('돌려줄 응답 본문'),
        contentType: z.string().optional().describe('기본 application/json; charset=utf-8'),
        headers: z.record(z.string()).optional(),
        delayMs: z.number().int().min(0).max(60000).optional(),
        fail: z.boolean().optional().describe('연결 실패(IOException)로 끝냄'),
        enabled: z.boolean().optional(),
      },
      annotations: acts,
    },
    async ({ serial, packageName, ...input }) => {
      const c = await dl.sdkFor(await device(serial), packageName);
      let rule: dl.MockRule;
      if (input.id) {
        // 준 항목만 바꾼다. 응답 방식(status·fail)은 한쪽을 주면 다른 쪽을 끈다
        const cur = (await c.mocks()).find((m) => m.id === input.id);
        if (!cur) throw new Error(`목 규칙 ${input.id} 이 없습니다`);
        const { hits: _hits, ...base } = cur;
        rule = { ...base, ...input, url: input.url ?? cur.url };
        if (input.fail) delete rule.status;
        if (input.status !== undefined) rule.fail = false;
      } else {
        if (!input.url) throw new Error('새 규칙에는 url 이 필요합니다');
        rule = { ...input, url: input.url };
      }
      const saved = await c.setMock(rule);
      if (recorder.active && recorder.app === packageName && saved.id) {
        if (saved.enabled === false) recorder.mocks.delete(saved.id);
        else recorder.mocks.set(saved.id, saved);
      }
      return text(`저장했습니다: ${mockLine(saved)}`);
    },
  );

  server.registerTool(
    'network_mock_list',
    { description: '앱에 저장된 네트워크 목 규칙과 적용 횟수', inputSchema: { ...serialArg, ...pkgArg }, annotations: readOnly },
    async ({ serial, packageName }) => {
      const list = await (await dl.sdkFor(await device(serial), packageName)).mocks();
      return text(list.length ? list.map(mockLine).join('\n') : '(목 규칙 없음)');
    },
  );

  server.registerTool(
    'network_mock_remove',
    {
      description: '네트워크 목 규칙 삭제. id 를 주지 않으면 모두 지운다',
      inputSchema: { ...serialArg, ...pkgArg, id: z.string().optional() },
      annotations: acts,
    },
    async ({ serial, packageName, id }) => {
      const c = await dl.sdkFor(await device(serial), packageName);
      if (recorder.app === packageName) {
        if (id) recorder.mocks.delete(id);
        else recorder.mocks.clear();
      }
      if (!id) {
        await c.clearMocks();
        return text('목 규칙을 모두 지웠습니다');
      }
      return text((await c.removeMock(id)) ? `${id} 를 지웠습니다` : `${id} 규칙이 없습니다`);
    },
  );
}
