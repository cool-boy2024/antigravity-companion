import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  createTask, validateTask, addTask, updateTask, addNote, readState, appendEvent,
  recordCheck, workspaceFingerprint, buildReceipt, buildHandoff, summarizeEvents,
} from '../src/core.js';

const exec = promisify(execFile);
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const now = '2026-11-26T03:00:00.000Z';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-core-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function check(overrides = {}) {
  return {
    id: randomUUID(), argv: ['node', '--test'], exitCode: 0, signal: null,
    startedAt: now, finishedAt: now, beforeFingerprint: A, afterFingerprint: A,
    output: 'ok', source: 'local-runner', ...overrides,
  };
}

test('import validation strips fabricated proof and prototype keys', () => {
  const fake = { ...createTask({ title: '交接' }), checks: [check()], notes: [{ text: 'fake' }] };
  const clean = validateTask(fake);
  assert.deepEqual(clean.checks, []);
  assert.deepEqual(clean.notes, []);
  assert.equal(buildReceipt(clean, A).status, 'unverified');
  assert.throws(() => createTask(JSON.parse('{"title":"x","__proto__":{"polluted":true}}')), /Unsafe/);
  assert.throws(() => createTask({ title: '', constraints: [] }), /title/);
  assert.throws(() => createTask({ title: 'x', goal: 'a'.repeat(8001) }), /goal/);
});

test('concurrent task updates and notes preserve independent writes', async t => {
  const root = await workspace(t);
  const tasks = await Promise.all(Array.from({ length: 12 }, (_, index) => addTask(root, { title: `Task ${index}` })));
  assert.equal((await readState(root)).tasks.length, 12);
  await Promise.all(Array.from({ length: 10 }, (_, index) => addNote(root, tasks[0].id, `Note ${index}`)));
  const state = await readState(root);
  assert.equal(state.tasks.find(task => task.id === tasks[0].id).notes.length, 10);
  const updated = await updateTask(root, tasks[1].id, { goal: 'Ship local evidence' });
  assert.equal(updated.goal, 'Ship local evidence');
  await assert.rejects(updateTask(root, tasks[1].id, { checks: [check()] }), /Only task/);
  await assert.rejects(updateTask(root, '../out', { goal: 'x' }), /ID/);
  const mode = (await fs.stat(path.join(root, '.antigravity-companion', 'state.json'))).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
});

test('corrupt state is preserved instead of silently replaced', async t => {
  const root = await workspace(t);
  await addTask(root, { title: 'Original' });
  const statePath = path.join(root, '.antigravity-companion', 'state.json');
  await fs.writeFile(statePath, '{broken');
  await assert.rejects(addTask(root, { title: 'Replacement' }), /corrupt/);
  assert.equal(await fs.readFile(statePath, 'utf8'), '{broken');
});

test('storage symlinks cannot redirect local records', async t => {
  if (process.platform === 'win32') { t.skip('File mode / POSIX symlink case; Windows junction case is covered by CLI tests'); return; }
  const root = await workspace(t);
  const elsewhere = await workspace(t);
  await fs.symlink(elsewhere, path.join(root, '.antigravity-companion'));
  await assert.rejects(addTask(root, { title: 'x' }), /real directory/);
  assert.deepEqual(await fs.readdir(elsewhere), []);
});

test('hooks keep only metadata and never infer successful verification', async t => {
  const root = await workspace(t);
  await Promise.all(Array.from({ length: 20 }, () => appendEvent(root, 'PostToolUse', {
    conversationId: 'session-abc', modelName: 'gemini-test',
    lastUserInput: 'private prompt', transcriptPath: '/secret/path',
    toolCall: { name: 'run_command', args: { CommandLine: 'echo private-key' } },
    error: null,
  })));
  const state = await readState(root);
  assert.equal(state.events.length, 20);
  assert.equal(state.events[0].hasError, false);
  const stored = JSON.stringify(state);
  assert.ok(!stored.includes('private prompt'));
  assert.ok(!stored.includes('private-key'));
  assert.ok(!stored.includes('/secret/path'));
  assert.equal(buildReceipt(createTask({ title: 'x' }), A).status, 'unverified');
  await assert.rejects(appendEvent(root, 'PreToolUse', { conversationId: 'x' }), /Unsupported/);
});

test('error contents are discarded and Stop fullyIdle preserves background state', async t => {
  const root = await workspace(t);
  await appendEvent(root, 'PostToolUse', { conversationId: 'session-1', error: 'PASSWORD=secret', toolCall: { name: 'run_command' } });
  await appendEvent(root, 'Stop', { conversationId: 'session-1', fullyIdle: false });
  const state = await readState(root);
  assert.ok(!JSON.stringify(state).includes('PASSWORD'));
  assert.equal(summarizeEvents(state.events).sessions[0].status, 'background');
  const quiet = summarizeEvents(state.events, Date.now() + 6 * 60_000);
  assert.equal(quiet.sessions[0].status, 'unknown');
  assert.equal(quiet.alerts[0].level, 'info');
});

test('empty hook error text is not reported as a tool failure', async t => {
  const root = await workspace(t);
  for (const error of [null, undefined, '', '   ', false]) {
    const event = await appendEvent(root, 'PostToolUse', { conversationId: 'session', error, toolCall: { name: 'run_command' } });
    assert.equal(event.hasError, false);
  }
  assert.equal((await appendEvent(root, 'PostToolUse', { conversationId: 'session', error: 'failed' })).hasError, true);
});

test('event retention deletes old disk records instead of only hiding them', async t => {
  const root = await workspace(t);
  await readState(root);
  const directory = path.join(root, '.antigravity-companion', 'events');
  const template = { eventName: 'SessionStart', conversationId: 'old-session', modelName: 'test', toolName: null, hasError: false, fullyIdle: null, createdAt: now };
  for (let start = 0; start < 2100; start += 100) {
    await Promise.all(Array.from({ length: 100 }, async () => {
      const eventId = randomUUID();
      const file = path.join(directory, `${eventId}.json`);
      await fs.writeFile(file, JSON.stringify({ ...template, id: eventId }), { mode: 0o600 });
      await fs.utimes(file, 1, 1);
    }));
  }
  const latest = await appendEvent(root, 'Stop', { conversationId: 'new-session', fullyIdle: true });
  assert.equal((await fs.readdir(directory)).length, 2000);
  assert.ok((await readState(root)).events.some(event => event.id === latest.id));
});

test('receipt detects stale project, changed-during-run, signals and imported assertions', () => {
  const task = createTask({ title: 'Verify' });
  task.checks = [check()];
  assert.equal(buildReceipt(task, A).status, 'passed');
  assert.equal(buildReceipt(task, B).status, 'stale');
  assert.equal(buildReceipt(task, null).status, 'unverified');
  task.checks = [check({ beforeFingerprint: B })];
  assert.equal(buildReceipt(task, A).status, 'stale');
  task.checks = [check({ source: 'imported' })];
  assert.equal(buildReceipt(task, A).status, 'unverified');
  task.checks = [check({ exitCode: 0, signal: 'SIGTERM' })];
  assert.equal(buildReceipt(task, A).status, 'failed');
  task.checks = [check({ exitCode: null })];
  assert.equal(buildReceipt(task, A).status, 'unverified');
});

test('new run supersedes previous run of same argv, while distinct failed checks remain', () => {
  const task = createTask({ title: 'Verify' });
  task.checks = [check({ exitCode: 1 }), check()];
  const receipt = buildReceipt(task, A);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.checks[0].verdict, 'superseded');
  task.checks.push(check({ argv: ['npm', 'run', 'lint'], exitCode: 1 }));
  assert.equal(buildReceipt(task, A).status, 'failed');
});

test('local runner evidence persists and normal updates cannot fabricate it', async t => {
  const root = await workspace(t);
  const task = await addTask(root, { title: 'Verify' });
  await recordCheck(root, task.id, check());
  assert.equal(buildReceipt((await readState(root)).tasks[0], A).status, 'passed');
  await assert.rejects(recordCheck(root, task.id, check({ source: 'imported' })), /explicit local/);
});

test('fingerprints track contents, new files and deletion, excluding internal state', async t => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, 'code.js'), 'before');
  const first = await workspaceFingerprint(root);
  await addTask(root, { title: 'Snapshot' });
  assert.equal(await workspaceFingerprint(root), first);
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'huge.js'), 'ignored');
  assert.equal(await workspaceFingerprint(root), first);
  await fs.writeFile(path.join(root, 'code.js'), 'after');
  const changed = await workspaceFingerprint(root);
  assert.notEqual(changed, first);
  await fs.writeFile(path.join(root, 'new.js'), 'new');
  assert.notEqual(await workspaceFingerprint(root), changed);
  await fs.unlink(path.join(root, 'new.js'));
  assert.equal(await workspaceFingerprint(root), changed);
});

test('git snapshots respect ignored untracked files and still include ignored tracked files', async t => {
  const root = await workspace(t);
  await exec('git', ['init', '-q'], { cwd: root });
  await fs.writeFile(path.join(root, '.gitignore'), '*.log\n');
  await fs.writeFile(path.join(root, 'tracked.log'), 'tracked');
  await exec('git', ['add', '-f', 'tracked.log'], { cwd: root });
  const before = await workspaceFingerprint(root);
  await fs.writeFile(path.join(root, 'ignored.log'), 'ignored');
  assert.equal(await workspaceFingerprint(root), before);
  await fs.writeFile(path.join(root, 'tracked.log'), 'changed');
  assert.notEqual(await workspaceFingerprint(root), before);
  await fs.unlink(path.join(root, 'tracked.log'));
  const deleted = await workspaceFingerprint(root);
  assert.notEqual(deleted, before);
  assert.equal(await workspaceFingerprint(root), deleted);
});

test('snapshot does not follow symlinks and refuses oversized files', async t => {
  const root = await workspace(t);
  if (process.platform !== 'win32') {
    const outside = await workspace(t);
    await fs.writeFile(path.join(outside, 'secret'), 'secret');
    await fs.symlink(outside, path.join(root, 'linked'));
    const before = await workspaceFingerprint(root);
    await fs.writeFile(path.join(outside, 'secret'), 'changed');
    assert.equal(await workspaceFingerprint(root), before);
  }
  await fs.writeFile(path.join(root, 'huge'), Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(workspaceFingerprint(root), /larger than/);
});

test('handoff preserves explicit constraints and labels verification scope', () => {
  const task = createTask({ title: '继续登录修复', goal: '修复重复回调', constraints: ['不要改线上库'], decisions: ['保留幂等键'], nextSteps: ['验证重复请求'] });
  const markdown = buildHandoff(task, buildReceipt(task, A), { target: 'codex' });
  assert.ok(markdown.includes('不要改线上库'));
  assert.ok(markdown.includes('unverified'));
  assert.ok(markdown.includes('Codex'));
  assert.throws(() => buildHandoff(task, buildReceipt(task, A), { target: '__proto__' }), /Unsupported/);
});

test('repeated errors warn without declaring a cause or test failure', () => {
  const events = Array.from({ length: 3 }, (_, index) => ({ eventName: 'PostToolUse', conversationId: 'session', modelName: 'model', hasError: true, createdAt: new Date(Date.parse(now) + index * 1000).toISOString() }));
  const result = summarizeEvents(events, Date.parse(now) + 10000);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.sessions[0].errorCount, 3);
  assert.equal(result.sessions[0].status, 'working');
  assert.ok(result.alerts[0].message.includes('尚不能'));
});
