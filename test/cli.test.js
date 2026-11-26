import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gravity CLI 中文 '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function run(args, { cwd = os.tmpdir(), input = '', timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI test timed out: ${stderr}`)); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(input);
  });
}

async function createTask(directory, title = 'Test local verification') {
  const result = await run(['task', '--workspace', directory, '--title', title]);
  assert.equal(result.code, 0, result.stderr);
  const id = result.stdout.split('\t')[0];
  assert.match(id, /^[0-9a-f-]{36}$/);
  return id;
}

test('CLI initializes only the chosen workspace and creates a task', async t => {
  const directory = await workspace(t);
  const init = await run(['init', '--workspace', directory]);
  assert.equal(init.code, 0, init.stderr);
  assert.equal((await readFile(path.join(directory, '.antigravity-companion', 'opt-in'), 'utf8')).trim(), 'local-events-v1');
  const taskId = await createTask(directory, '路径可以包含中文与空格');
  const doctor = await run(['doctor', '--workspace', directory]);
  assert.equal(doctor.code, 0, doctor.stderr);
  const state = JSON.parse(doctor.stdout);
  assert.equal(state.tasks, 1);
  assert.equal(state.accountAccess, false);
  assert.equal(state.networkTelemetry, false);
  const handoff = await run(['handoff', '--workspace', directory, taskId, '--target', 'codex']);
  assert.equal(handoff.code, 0, handoff.stderr);
  assert.match(handoff.stdout, /Codex/);
  assert.match(handoff.stdout, /unverified/);
});

test('hooks are opt-in, protocol-safe and store metadata without prompts or arguments', async t => {
  const directory = await workspace(t);
  const secret = 'DoNotPersistThisUserPromptOrToolArgument';
  const payload = { conversationId: 'session-123', workspacePaths: [directory], lastUserInput: secret, transcriptPath: path.join(directory, secret), toolCall: { name: 'run_command', args: { CommandLine: secret } }, error: '', modelName: 'gemini-test' };
  const before = await run(['hook', 'PostToolUse'], { input: JSON.stringify(payload) });
  assert.equal(before.code, 0);
  assert.deepEqual(JSON.parse(before.stdout), {});
  assert.equal((await readdir(directory)).includes('.antigravity-companion'), false);
  await run(['init', '--workspace', directory]);
  const accepted = await run(['hook', 'PostToolUse'], { input: JSON.stringify(payload) });
  assert.equal(accepted.code, 0);
  assert.deepEqual(JSON.parse(accepted.stdout), {});
  const files = await readdir(path.join(directory, '.antigravity-companion', 'events'));
  assert.equal(files.length, 1);
  const raw = await readFile(path.join(directory, '.antigravity-companion', 'events', files[0]), 'utf8');
  assert.ok(!raw.includes(secret));
  assert.equal(JSON.parse(raw).toolName, 'run_command');
  assert.equal(JSON.parse(raw).hasError, false, 'an empty official error field is a successful tool event');
  for (const input of ['invalid json', JSON.stringify({}), JSON.stringify({ workspacePaths: [directory] })]) {
    const ignored = await run(['hook', 'PostToolUse'], { input });
    assert.equal(ignored.code, 0);
    assert.deepEqual(JSON.parse(ignored.stdout), {});
  }
  const unsupported = await run(['hook', 'PreToolUse'], { input: JSON.stringify(payload) });
  assert.deepEqual(JSON.parse(unsupported.stdout), {});
  assert.equal((await readdir(path.join(directory, '.antigravity-companion', 'events'))).length, 1);
});

test('explicit local checks report real success and failure exit codes', async t => {
  const directory = await workspace(t);
  const task = await createTask(directory);
  const passed = await run(['check', '--workspace', directory, task, '--', process.execPath, '-e', 'console.log("actual-success")']);
  assert.equal(passed.code, 0, passed.stderr);
  const success = JSON.parse(passed.stdout);
  assert.equal(success.exitCode, 0);
  assert.equal(success.status, 'passed');
  assert.match(success.output, /actual-success/);
  const failed = await run(['check', '--workspace', directory, task, '--', process.execPath, '-e', 'console.error("actual-failure");process.exit(7)']);
  assert.equal(failed.code, 1, failed.stderr);
  const failure = JSON.parse(failed.stdout);
  assert.equal(failure.exitCode, 7);
  assert.equal(failure.status, 'failed');
  assert.match(failure.output, /actual-failure/);
});

test('local checks never invoke shell expansion and preserve program options after --', async t => {
  const directory = await workspace(t);
  const task = await createTask(directory);
  const literal = '$(touch should-not-exist); & echo hi';
  const result = await run(['check', '--workspace', directory, task, '--', process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', '--timeout', '7', literal]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(JSON.parse(result.stdout).output.trim()), ['--timeout', '7', literal]);
  assert.ok(!(await readdir(directory)).includes('should-not-exist'));
});

test('a timed-out check records failure and kills the child', async t => {
  const directory = await workspace(t);
  const task = await createTask(directory);
  const started = Date.now();
  const result = await run(['check', '--workspace', directory, '--timeout', '1', task, '--', process.execPath, '-e', 'setInterval(()=>{},1000)']);
  assert.equal(result.code, 1, result.stderr);
  assert.ok(Date.now() - started < 6000);
  const value = JSON.parse(result.stdout);
  assert.equal(value.status, 'failed');
  assert.notEqual(value.signal, null);
});

test('large command logs remain bounded and still record verification', async t => {
  const directory = await workspace(t);
  const task = await createTask(directory);
  const result = await run(['check', '--workspace', directory, task, '--', process.execPath, '-e', 'for(let i=0;i<20;i++)console.log("x".repeat(10000))']);
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.exitCode, 0);
  assert.equal(value.status, 'passed');
  assert.ok(value.output.length <= 65536);
});

test('storage directory symlinks cannot redirect init or checks outside the workspace', async t => {
  const directory = await workspace(t);
  const outside = await workspace(t);
  await writeFile(path.join(outside, 'sentinel'), 'unchanged');
  await symlink(outside, path.join(directory, '.antigravity-companion'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await run(['init', '--workspace', directory]);
  assert.notEqual(result.code, 0);
  assert.deepEqual(await readdir(outside), ['sentinel']);
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
});

test('an opt-in marker symlink cannot overwrite an unrelated file during init', async t => {
  const directory = await workspace(t);
  const outside = await workspace(t);
  const target = path.join(outside, 'sentinel');
  await writeFile(target, 'unrelated user file');
  await mkdir(path.join(directory, '.antigravity-companion'));
  try { await symlink(target, path.join(directory, '.antigravity-companion', 'opt-in')); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'ENOSYS'].includes(error.code)) { t.skip('Windows runner does not grant file symlink privileges'); return; }
    throw error;
  }
  const result = await run(['init', '--workspace', directory]);
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(target, 'utf8'), 'unrelated user file');
});

test('concurrent CLI task writes do not lose existing tasks', async t => {
  const directory = await workspace(t);
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => run(['task', '--workspace', directory, '--title', `Parallel ${index}`])));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const result = await run(['doctor', '--workspace', directory]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).tasks, 10);
});
