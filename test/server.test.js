import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function launch(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'gravity-http-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const child = spawn(process.execPath, [cli, 'serve', '--workspace', workspace, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill('SIGTERM'); await exited; });
  let text = '';
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 8000);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${errors}`)); });
    child.stdout.on('data', chunk => {
      text += chunk;
      const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/);
      if (match) { clearTimeout(timeout); resolve(new URL(match[0])); }
    });
  });
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  return { workspace, url, token };
}

function request(url, endpoint, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(endpoint, url), { method, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('real local HTTP server protects state and preserves evidence boundaries', async t => {
  const { url, token } = await launch(t);
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let task;

  await t.test('binds loopback and serves a restrictive page without exposing the token', async () => {
    const response = await request(url, '/');
    assert.equal(response.status, 200);
    assert.match(response.headers['content-security-policy'], /default-src 'none'/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.ok(!response.text.includes(token));
    assert.ok(!response.headers['access-control-allow-origin']);
  });

  await t.test('requires the exact bearer token for API reads and writes', async () => {
    for (const headers of [{}, { Authorization: 'Bearer wrong' }]) {
      assert.equal((await request(url, '/api/state', { headers })).status, 401);
      assert.equal((await request(url, '/api/tasks', { method: 'POST', headers, body: { title: 'unauthorized' } })).status, 401);
    }
    const response = await request(url, '/api/state', { headers: auth });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.tasks, []);
  });

  await t.test('rejects foreign Host, Origin and cross-site requests even with a token', async () => {
    for (const extra of [{ Host: 'attacker.example' }, { Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await request(url, '/api/state', { headers: { ...auth, ...extra } })).status, 403);
    }
    assert.equal((await request(url, '/api/state', { headers: { ...auth, Origin: url.origin } })).status, 200);
  });

  await t.test('creates and updates card fields while treating script-like content as text', async () => {
    const title = '<img src=x onerror=alert(1)> & "plain text"';
    const created = await request(url, '/api/tasks', { method: 'POST', headers: auth, body: { title, goal: 'Verify sign-in', constraints: ['Keep schema'], decisions: [], nextSteps: ['Run tests'] } });
    assert.equal(created.status, 201);
    task = created.data;
    assert.equal(task.title, title);
    assert.deepEqual(task.checks, []);
    const updated = await request(url, `/api/tasks/${task.id}`, { method: 'PATCH', headers: auth, body: { goal: '<script>window.pwned=true</script>', checks: [{ exitCode: 0, source: 'local-runner' }] } });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.goal, '<script>window.pwned=true</script>');
    assert.deepEqual(updated.data.checks, []);
    const state = (await request(url, '/api/state', { headers: auth })).data;
    assert.equal(state.tasks.find(item => item.id === task.id).receipt.status, 'unverified');
  });

  await t.test('imports foreign passed checks as unverified card data', async () => {
    const response = await request(url, '/api/import', { method: 'POST', headers: auth, body: { task: { ...task, title: 'Imported task', notes: [{text: 'Keep the existing schema'}], checks: [{ id: task.id, argv: ['node', '--test'], source: 'local-runner', exitCode: 0, verdict: 'passed', beforeFingerprint: 'a'.repeat(64), afterFingerprint: 'a'.repeat(64) }], receipt: { status: 'passed' } } } });
    assert.equal(response.status, 201);
    assert.notEqual(response.data.id, task.id);
    assert.deepEqual(response.data.checks, []);
    assert.ok(response.data.notes.some(note => note.text.includes('Keep the existing schema') && note.text.includes('外部')));
    assert.ok(response.data.notes.some(note => note.text.includes('node') && note.text.includes('未经本机验证')));
    const state = (await request(url, '/api/state', { headers: auth })).data;
    assert.equal(state.tasks.find(item => item.id === response.data.id).receipt.status, 'unverified');
  });

  await t.test('redacts common secrets and user directories in shared exports and handoffs', async () => {
    const secret = 'abcDEFsecretValue123456789';
    const text = `api_key="${secret}" password='${secret}' Bearer ${secret} https://example.com/?token=${secret} /Users/alice/private/file C:\\Users\\Alice\\private`;
    const added = await request(url, `/api/tasks/${task.id}/notes`, { method: 'POST', headers: auth, body: { text } });
    assert.equal(added.status, 201);
    for (const suffix of ['export', 'handoff?target=claude']) {
      const response = await request(url, `/api/tasks/${task.id}/${suffix}`, { headers: auth });
      assert.equal(response.status, 200);
      assert.ok(!response.text.includes(secret), 'common secret values must not survive sharing');
      assert.ok(!response.text.includes('/Users/alice'));
      assert.ok(!response.text.includes('Alice'));
    }
  });

  await t.test('concurrent card writes survive without lost updates', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => request(url, '/api/tasks', { method: 'POST', headers: auth, body: { title: `Concurrent task ${index}` } })));
    for (const response of results) assert.equal(response.status, 201);
    const state = (await request(url, '/api/state', { headers: auth })).data;
    assert.equal(new Set(results.map(item => item.data.id)).size, 12);
    for (const response of results) assert.ok(state.tasks.some(item => item.id === response.data.id));
  });

  await t.test('has no HTTP command execution endpoint or arbitrary file reader', async () => {
    for (const endpoint of ['/api/exec', '/api/check', '/api/files?path=/etc/passwd', '/api/../../etc/passwd']) {
      assert.equal((await request(url, endpoint, { method: 'POST', headers: auth, body: { command: 'whoami' } })).status, 404);
    }
  });

  await t.test('rejects invalid and oversized bodies without damaging state', async () => {
    const before = (await request(url, '/api/state', { headers: auth })).data.tasks.length;
    assert.equal((await request(url, '/api/tasks', { method: 'POST', headers: auth, body: '{invalid' })).status, 400);
    assert.equal((await request(url, '/api/tasks', { method: 'POST', headers: auth, body: { title: 'x'.repeat(270000) } })).status, 413);
    assert.equal((await request(url, '/api/state', { headers: auth })).data.tasks.length, before);
  });
});
