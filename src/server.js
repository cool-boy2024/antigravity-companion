import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState, addTask, updateTask, addNote, workspaceFingerprint, buildReceipt, buildHandoff, summarizeEvents } from './core.js';
import { exchangeTask, redact } from './privacy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
function shellExample(workspace, id) {
  const quote = process.platform === 'win32'
    ? value => `'${value.replaceAll("'", "''")}'`
    : value => `'${value.replaceAll("'", "'\\''")}'`;
  return `${process.platform === 'win32' ? '& ' : ''}${[process.execPath, path.join(root, 'src/cli.js'), 'check', '--workspace', workspace, id, '--', process.execPath, '--test'].map(quote).join(' ')}`;
}
const staticFiles = new Map([
  ['/', ['web/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['web/style.css', 'text/css; charset=utf-8']],
  ['/logo.svg', ['assets/logo.svg', 'image/svg+xml']],
]);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw Object.assign(new Error('请求超过 256KB'), { statusCode: 413 });
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求需要有效 JSON'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('需要 JSON 对象');
  return result;
}

function cardFields(input) {
  const fields = {};
  for (const key of ['title', 'goal', 'constraints', 'decisions', 'nextSteps']) {
    if (Object.hasOwn(input, key)) fields[key] = input[key];
  }
  return fields;
}

export async function startServer({ workspace, port = 0, token = randomBytes(32).toString('hex') }) {
  workspace = await realpath(workspace);
  if (!(await stat(workspace)).isDirectory()) throw new Error('工作区必须是目录');
  let origin;
  let snapshotPromise;
  let snapshotTime = 0;
  const fingerprint = async () => {
    if (!snapshotPromise || Date.now() - snapshotTime > 2000) {
      snapshotTime = Date.now();
      snapshotPromise = workspaceFingerprint(workspace).catch(() => null);
    }
    return snapshotPromise;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      // Reject DNS rebinding, cross-site browser requests, and wrong origins.
      if (req.headers.host !== new URL(origin).host) return send(res, 403, { error: 'Host 不匹配' });
      if (req.headers.origin && req.headers.origin !== origin) return send(res, 403, { error: 'Origin 不匹配' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: '拒绝跨站访问' });
      const url = new URL(req.url, origin);
      const asset = staticFiles.get(url.pathname);
      if (asset && req.method === 'GET') return send(res, 200, await readFile(path.join(root, asset[0])), asset[1]);
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: '未找到' });
      const actual = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(res, 401, { error: '请使用启动命令提供的完整链接重新打开面板' });
      if (req.method === 'GET' && url.pathname === '/api/competitors') {
        return send(res, 200, JSON.parse(await readFile(path.join(root, 'data/competitors.json'), 'utf8')));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const state = await readState(workspace);
        const hash = state.tasks.some((task) => task.checks.length) ? await fingerprint() : null;
        return send(res, 200, {
          workspaceName: path.basename(workspace),
          tasks: state.tasks.map((task) => ({ ...task, receipt: buildReceipt(task, hash), checkCommand: shellExample(workspace, task.id) })),
          events: state.events,
          activity: summarizeEvents(state.events),
          capabilities: { hooks: 'official-opt-in', accountAccess: false, quota: false, automaticTranscriptReading: false, remoteTelemetry: false, commandExecution: 'CLI-only', snapshotAvailable: Boolean(hash) },
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') return send(res, 201, await addTask(workspace, cardFields(await readBody(req))));
      if (req.method === 'POST' && url.pathname === '/api/import') {
        const { task } = await readBody(req);
        if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('导入内容需要 task 对象');
        const notes = task.notes ?? [];
        const checks = task.checks ?? [];
        if (!Array.isArray(notes) || !Array.isArray(checks) || notes.length + checks.length > 100) throw new Error('外部备注和检查合计最多 100 条');
        const assertions = notes.map(note => {
          if (!note || typeof note.text !== 'string' || note.text.length > 7800 || note.text.includes('\0')) throw new Error('外部备注无效或过长');
          return `[外部交接说明，未经验证] ${note.text}`;
        });
        for (const check of checks) {
          if (!check || !Array.isArray(check.argv) || check.argv.some(value => typeof value !== 'string')) throw new Error('外部检查声明格式无效');
          const summary = `[外部检查声明，未经本机验证] ${JSON.stringify(check.argv)}；外部声称退出码：${Number.isInteger(check.exitCode) ? check.exitCode : '未知'}。请在本机重新执行。`;
          if (summary.length > 7800 || summary.includes('\0')) throw new Error('外部检查声明过长');
          assertions.push(summary);
        }
        // All foreign validation results are assertions, never local evidence.
        const imported = await addTask(workspace, cardFields(task));
        await addNote(workspace, imported.id, '从交接包导入；外部检查记录未作为本机验证证据，请在当前工作区重新运行检查。');
        for (const assertion of assertions) await addNote(workspace, imported.id, assertion);
        return send(res, 201, (await readState(workspace)).tasks.find((item) => item.id === imported.id));
      }
      const match = /^\/api\/tasks\/([0-9a-f-]{36})(?:\/(notes|handoff|export))?$/.exec(url.pathname);
      if (match) {
        const [, id, action] = match;
        const task = (await readState(workspace)).tasks.find((item) => item.id === id);
        if (!task) return send(res, 404, { error: '任务不存在' });
        if (req.method === 'PATCH' && !action) return send(res, 200, await updateTask(workspace, id, cardFields(await readBody(req))));
        if (req.method === 'POST' && action === 'notes') return send(res, 201, await addNote(workspace, id, (await readBody(req)).text));
        if (req.method === 'GET' && action === 'export') return send(res, 200, { schemaVersion: 1, warning: '导出已过滤常见密钥和用户目录，仍需人工检查商业信息与其他隐私。检查记录在接收方仅作外部声明。', task: exchangeTask(task) });
        if (req.method === 'GET' && action === 'handoff') {
          const target = url.searchParams.get('target') || 'generic';
          if (!['generic', 'codex', 'claude', 'antigravity'].includes(target)) throw new Error('未知交接目标');
          const receipt = buildReceipt(task, await fingerprint());
          return send(res, 200, { markdown: redact(buildHandoff(task, receipt, { target })) });
        }
      }
      return send(res, 404, { error: '未找到此接口；面板不提供执行命令的接口' });
    } catch (error) {
      if (!res.headersSent) send(res, error.statusCode || 400, { error: error.message || '操作失败' });
      else res.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxConnections = 32;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  return { server, origin, token, url: `${origin}/#token=${token}` };
}
