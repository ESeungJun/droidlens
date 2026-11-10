// 기기 쪽 서버(에이전트·SDK)는 X-DroidLens 헤더가 없는 요청을 거부한다. 호스트가 항상 붙이는지 확인한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LocalHttpClient } from '../dist/http.js';

test('LocalHttpClient: X-DroidLens 헤더를 붙이고 Origin 은 보내지 않는다, Host 는 127.0.0.1', async () => {
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push(req.headers);
    if (req.url.startsWith('/bad')) {
      res.statusCode = 403;
      res.end('{"error":"거부"}');
    } else res.end('{"ok":true}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const c = new LocalHttpClient(srv.address().port, 'sdk');
    assert.deepEqual(await c.json('GET', '/ping'), { ok: true });
    await c.text('POST', '/text', { query: { text: '가' }, body: 'x' });
    for (const h of seen) {
      assert.equal(h['x-droidlens'], '1');
      assert.equal(h.origin, undefined);
      assert.equal(h.host, `127.0.0.1:${srv.address().port}`);
    }
    await assert.rejects(c.text('GET', '/bad'), /sdk \/bad: 거부/);
  } finally {
    srv.close();
  }
});
