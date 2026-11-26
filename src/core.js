import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const EVENTS = new Set(['SessionStart', 'PreInvocation', 'PostInvocation', 'PostToolUse', 'Stop']);
const FIELDS = ['title', 'goal', 'constraints', 'decisions', 'nextSteps'];
const MAX_TASKS = 500;
const MAX_EVENTS = 2000;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const OMIT = new Set(['.git', 'node_modules', '.antigravity-companion']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function object(value, label = 'value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function rejectPoison(value, depth = 0) {
  if (depth > 12) throw new Error('Input nesting is too deep');
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe input key');
    rejectPoison(value[key], depth + 1);
  }
}

function text(value, label, max = 8000, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}`);
  return value;
}

function lines(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error(`Invalid ${label}`);
  return value.map(item => text(item, label, 2000));
}

function fields(value) {
  object(value, 'task');
  rejectPoison(value);
  const title = text(value.title, 'title', 200).trim();
  if (!title) throw new Error('Task title is required');
  return {
    title,
    goal: text(value.goal, 'goal', 8000, ''),
    constraints: lines(value.constraints, 'constraints'),
    decisions: lines(value.decisions, 'decisions'),
    nextSteps: lines(value.nextSteps, 'nextSteps'),
  };
}

function date(value, label) {
  const result = text(value, label, 40);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Invalid ${label}`);
  return result;
}

function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid task or evidence ID');
  return value;
}

export function createTask(input) {
  const now = new Date().toISOString();
  return { id: randomUUID(), ...fields(input), createdAt: now, updatedAt: now, checks: [], notes: [] };
}

// This is deliberately an import validator. Local evidence is read separately.
export function validateTask(value) {
  const task = createTask(value);
  if (value.id !== undefined) task.id = id(value.id);
  return task;
}

async function rootDir(workspace) {
  const root = await fs.realpath(workspace);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Workspace must be a directory');
  return root;
}

async function privateDirectory(directory) {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Local storage must be a real directory');
  await fs.chmod(directory, 0o700);
}

async function storage(workspace) {
  const root = await rootDir(workspace);
  const directory = path.join(root, '.antigravity-companion');
  await privateDirectory(directory);
  await privateDirectory(path.join(directory, 'events'));
  try { await fs.writeFile(path.join(directory, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return directory;
}

async function readSafe(file, max = MAX_STATE_BYTES) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > max) throw new Error('Invalid or oversized local data file');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size > max) throw new Error('Local data file changed while opening');
    const data = await handle.readFile('utf8');
    if (Buffer.byteLength(data) > max) throw new Error('Oversized local data file');
    return data;
  } finally { await handle.close(); }
}

async function atomic(file, value) {
  const data = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(data) > MAX_STATE_BYTES) throw new Error('Local state size limit reached');
  const temporary = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

function checkValue(value) {
  object(value, 'check');
  rejectPoison(value);
  if (!Array.isArray(value.argv) || value.argv.length < 1 || value.argv.length > 100) throw new Error('Invalid check argv');
  if (value.exitCode !== null && (!Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)) throw new Error('Invalid check exit code');
  for (const field of ['beforeFingerprint', 'afterFingerprint']) {
    if (value[field] !== null && (typeof value[field] !== 'string' || !HASH.test(value[field]))) throw new Error('Invalid workspace fingerprint');
  }
  return {
    id: value.id === undefined ? randomUUID() : id(value.id),
    argv: value.argv.map(item => text(item, 'argv', 4000)),
    exitCode: value.exitCode,
    signal: value.signal === null || value.signal === undefined ? null : text(value.signal, 'signal', 40),
    startedAt: date(value.startedAt, 'startedAt'), finishedAt: date(value.finishedAt, 'finishedAt'),
    beforeFingerprint: value.beforeFingerprint, afterFingerprint: value.afterFingerprint,
    output: text(value.output, 'output', 65536, ''),
    source: value.source === 'local-runner' ? 'local-runner' : 'imported',
  };
}

function internalTask(value) {
  const clean = fields(value);
  if (!Array.isArray(value.checks) || value.checks.length > 200 || !Array.isArray(value.notes) || value.notes.length > 200) throw new Error('Invalid task evidence');
  return {
    id: id(value.id), ...clean, createdAt: date(value.createdAt, 'createdAt'), updatedAt: date(value.updatedAt, 'updatedAt'),
    checks: value.checks.map(checkValue),
    notes: value.notes.map(note => ({ id: id(note.id), text: text(note.text, 'note', 8000), createdAt: date(note.createdAt, 'createdAt'), source: 'manual' })),
  };
}

async function tasksAt(directory) {
  let raw;
  try { raw = await readSafe(path.join(directory, 'state.json')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  let data;
  try { data = JSON.parse(raw); rejectPoison(data); }
  catch { throw new Error('Local state is corrupt; it was not overwritten'); }
  if (data.version !== 1 || !Array.isArray(data.tasks) || data.tasks.length > MAX_TASKS) throw new Error('Unsupported or corrupt local state; it was not overwritten');
  const tasks = data.tasks.map(internalTask);
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('Duplicate IDs in local state');
  return tasks;
}

async function mutate(workspace, operation) {
  const directory = await storage(workspace);
  const lock = path.join(directory, '.lock');
  let held = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fs.mkdir(lock, { mode: 0o700 }); held = true; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await delay(10); }
  }
  if (!held) throw new Error('Local state is busy. Retry; a lock left by a crashed process may need manual removal.');
  try {
    const tasks = await tasksAt(directory);
    const result = operation(tasks);
    await atomic(path.join(directory, 'state.json'), { version: 1, tasks });
    return result;
  } finally { await fs.rmdir(lock); }
}

function taskById(tasks, taskId) {
  id(taskId);
  const task = tasks.find(item => item.id === taskId);
  if (!task) throw new Error('Task not found');
  return task;
}

export async function addTask(workspace, input) {
  const task = createTask(input);
  return mutate(workspace, tasks => {
    if (tasks.length >= MAX_TASKS) throw new Error('Task limit reached');
    tasks.push(task); return task;
  });
}

export async function updateTask(workspace, taskId, patch) {
  object(patch, 'patch'); rejectPoison(patch);
  if (Object.keys(patch).some(key => !FIELDS.includes(key))) throw new Error('Only task card fields may be updated');
  return mutate(workspace, tasks => {
    const task = taskById(tasks, taskId);
    Object.assign(task, fields({ ...task, ...patch }), { updatedAt: new Date().toISOString() });
    return task;
  });
}

export async function addNote(workspace, taskId, content) {
  const note = { id: randomUUID(), text: text(content, 'note', 8000), createdAt: new Date().toISOString(), source: 'manual' };
  if (!note.text.trim()) throw new Error('Note is empty');
  return mutate(workspace, tasks => {
    const task = taskById(tasks, taskId);
    if (task.notes.length >= 200) throw new Error('Note limit reached');
    task.notes.push(note); task.updatedAt = note.createdAt; return task;
  });
}

export async function recordCheck(workspace, taskId, value) {
  const check = checkValue(value);
  if (check.source !== 'local-runner') throw new Error('Only explicit local runner checks may be recorded');
  return mutate(workspace, tasks => {
    const task = taskById(tasks, taskId);
    if (task.checks.length >= 200) throw new Error('Check limit reached');
    task.checks.push(check); task.updatedAt = check.finishedAt; return task;
  });
}

function eventValue(eventName, payload, clock = new Date().toISOString()) {
  if (!EVENTS.has(eventName)) throw new Error('Unsupported hook event');
  object(payload, 'hook payload');
  const conversationId = text(payload.conversationId, 'conversationId', 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) throw new Error('Invalid conversation identifier');
  const result = {
    id: randomUUID(), eventName, conversationId,
    modelName: typeof payload.modelName === 'string' && /^[a-zA-Z0-9._:/-]{1,120}$/.test(payload.modelName) ? payload.modelName : 'unknown',
    toolName: eventName === 'PostToolUse' && typeof payload.toolCall?.name === 'string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(payload.toolCall.name) ? payload.toolCall.name : null,
    hasError: eventName === 'PostToolUse' && (typeof payload.error === 'string' ? payload.error.trim().length > 0 : payload.error != null && payload.error !== false),
    fullyIdle: eventName === 'Stop' && typeof payload.fullyIdle === 'boolean' ? payload.fullyIdle : null,
    createdAt: clock,
  };
  return result;
}

export async function appendEvent(workspace, eventName, payload) {
  const event = eventValue(eventName, payload);
  const directory = path.join(await storage(workspace), 'events');
  await atomic(path.join(directory, `${event.id}.json`), event);
  const entries = await fs.readdir(directory);
  if (entries.length > MAX_EVENTS + 100) {
    const files = entries.filter(name => UUID.test(name.slice(0, -5)) && name.endsWith('.json'));
    const dated = await Promise.all(files.map(async name => ({ name, time: (await fs.lstat(path.join(directory, name)).catch(() => ({ mtimeMs: Infinity }))).mtimeMs })));
    dated.sort((a, b) => a.time - b.time);
    await Promise.all(dated.slice(0, Math.max(0, dated.length - MAX_EVENTS)).map(item => fs.unlink(path.join(directory, item.name)).catch(() => {})));
  }
  return event;
}

export async function readState(workspace) {
  const directory = await storage(workspace);
  const tasks = await tasksAt(directory);
  const files = (await fs.readdir(path.join(directory, 'events'))).filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5)));
  if (files.length > MAX_EVENTS + 500) throw new Error('Event store is oversized; inspect it before continuing');
  const events = [];
  for (const file of files) {
    let value;
    try { value = JSON.parse(await readSafe(path.join(directory, 'events', file), 4096)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error('Local event store contains an unreadable record'); }
    if (value.id !== file.slice(0, -5) || !UUID.test(value.id)) throw new Error('Invalid stored event identifier');
    // Reconstruct a strict allowlist even when a record was edited outside this application.
    const clean = eventValue(value.eventName, { conversationId: value.conversationId, modelName: value.modelName, toolCall: { name: value.toolName }, error: value.hasError ? true : null, fullyIdle: value.fullyIdle }, date(value.createdAt, 'event date'));
    events.push({ ...clean, id: value.id });
  }
  events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { version: 1, tasks, events: events.slice(-MAX_EVENTS) };
}

function included(relative) {
  return relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).some(part => part === '..' || OMIT.has(part));
}

async function listFiles(root) {
  try {
    await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, timeout: 5000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    if (error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.code !== 'ENOENT' && !/not a git repository/i.test(error.stderr || '')) throw new Error('Cannot enumerate workspace reliably');
    const output = [];
    let visited = 0;
    async function walk(directory, prefix = '', depth = 0) {
      if (depth > 64 || ++visited > 10000) throw new Error('Workspace directory traversal limit exceeded');
      const entries = await fs.readdir(directory, { withFileTypes: true });
      if (entries.length > 10000) throw new Error('Workspace directory contains too many entries');
      for (const entry of entries) {
        if (OMIT.has(entry.name)) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative, depth + 1);
        else output.push(relative);
        if (output.length > MAX_FILES) throw new Error('Workspace snapshot exceeds 5000 files');
      }
    }
    await walk(root); return output.sort();
  }
  const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], { cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  const names = [...new Set(stdout.split('\0').filter(included))].sort();
  if (names.length > MAX_FILES) throw new Error('Workspace snapshot exceeds 5000 files');
  return names;
}

async function safeLstat(root, relative) {
  const segments = relative.split('/');
  let cursor = root;
  for (let index = 0; index < segments.length; index++) {
    cursor = path.join(cursor, segments[index]);
    let stat;
    try { stat = await fs.lstat(cursor, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (index === segments.length - 1) return stat;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Workspace path traverses a symlink or non-directory');
  }
  throw new Error('Invalid snapshot path');
}

function signature(stat) {
  return stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':') : 'missing';
}

export async function workspaceFingerprint(workspace) {
  const root = await rootDir(workspace);
  const names = await listFiles(root);
  const hash = createHash('sha256');
  const snapshots = [];
  let total = 0;
  for (const relative of names) {
    const before = await safeLstat(root, relative);
    hash.update(`${Buffer.byteLength(relative)}:${relative}\0`);
    snapshots.push([relative, signature(before)]);
    if (!before) { hash.update('deleted\0'); continue; }
    if (before.isSymbolicLink()) {
      hash.update(`symlink:${await fs.readlink(path.join(root, relative))}\0`);
    } else if (before.isFile()) {
      if (before.size > BigInt(MAX_FILE_BYTES)) throw new Error('Workspace snapshot contains a file larger than 8 MiB');
      total += Number(before.size);
      if (total > MAX_SNAPSHOT_BYTES) throw new Error('Workspace snapshot exceeds 64 MiB');
      const handle = await fs.open(path.join(root, relative), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const opened = await handle.stat({ bigint: true });
        if (signature(opened) !== signature(before)) throw new Error('Workspace changed during snapshot; retry');
        const buffer = await handle.readFile();
        if (buffer.length > MAX_FILE_BYTES) throw new Error('File grew beyond snapshot limit');
        hash.update(`file:${Number(before.mode & 0o111n)}:${buffer.length}\0`); hash.update(buffer); hash.update('\0');
      } finally { await handle.close(); }
    } else if (before.isDirectory()) {
      throw new Error('Cannot snapshot a Git submodule; record verification outside the companion');
    } else { throw new Error('Workspace contains an unsupported special file'); }
    if (signature(await safeLstat(root, relative)) !== signature(before)) throw new Error('Workspace changed during snapshot; retry');
  }
  if (JSON.stringify(await listFiles(root)) !== JSON.stringify(names)) throw new Error('Workspace file set changed during snapshot; retry');
  for (const [relative, expected] of snapshots) {
    if (signature(await safeLstat(root, relative)) !== expected) throw new Error('Workspace changed during snapshot; retry');
  }
  return hash.digest('hex');
}

export function buildReceipt(task, currentFingerprint) {
  const latest = new Map();
  for (const check of task.checks || []) latest.set(JSON.stringify(check.argv), check.id);
  const checks = (task.checks || []).map(check => {
    let verdict;
    if (latest.get(JSON.stringify(check.argv)) !== check.id) verdict = 'superseded';
    else if (check.source !== 'local-runner') verdict = 'unverified';
    else if (check.exitCode !== null && check.exitCode !== 0 || check.signal) verdict = 'failed';
    else if (check.exitCode === null) verdict = 'unverified';
    else if (!HASH.test(check.beforeFingerprint || '') || !HASH.test(check.afterFingerprint || '') || !HASH.test(currentFingerprint || '')) verdict = 'unverified';
    else if (check.beforeFingerprint !== check.afterFingerprint || check.afterFingerprint !== currentFingerprint) verdict = 'stale';
    else verdict = 'passed';
    return { ...check, verdict };
  });
  const active = checks.filter(check => check.verdict !== 'superseded');
  const status = active.length === 0 ? 'unverified' : ['failed', 'stale', 'unverified', 'passed'].find(value => active.some(check => check.verdict === value));
  const warnings = ['通过仅表示记录的命令成功退出，不代表所有需求已经验收。'];
  if (!currentFingerprint) warnings.push('当前项目快照不可用，无法确认验证结果是否仍适用。');
  if (active.some(check => check.verdict === 'stale')) warnings.push('项目内容在验证期间或验证之后发生变化，需要重新验证。');
  return { status, checks, warnings };
}

export function buildHandoff(task, receipt, { target = 'generic' } = {}) {
  const names = { generic: '通用', codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' };
  if (!Object.hasOwn(names, target)) throw new Error('Unsupported handoff target');
  const list = items => items.length ? items.map(item => `- ${item.replaceAll('\n', '\n  ')}`).join('\n') : '- 尚未填写';
  const checkLines = (receipt.checks || []).map(check => `- ${JSON.stringify(check.argv)}：${check.verdict}；退出码 ${check.exitCode ?? '未知'}；${check.finishedAt}`);
  return [
    `# ${task.title}`, '', `交接目标：${names[target]}。卡片内容由用户填写，属于待接手方核对的工作说明。`, '',
    '## 目标', '', task.goal || '尚未填写', '', '## 必须保留的约束', '', list(task.constraints), '',
    '## 已记录的决策', '', list(task.decisions), '', '## 下一步', '', list(task.nextSteps), '',
    '## 验证记录', '', `状态：${receipt.status}。来源：Gravity Companion 本地显式运行器；手动说明和导入内容不作为验证通过的证据。`, '',
    checkLines.length ? checkLines.join('\n') : '尚无本地命令验证记录。', '', ...receipt.warnings.map(warning => `- ${warning}`), '',
    '## 手动备注', '', list((task.notes || []).map(note => note.text)), '',
    '接手后请先核对项目版本、上述约束和验证范围。交接文本可能含敏感信息，分享前请检查。', '',
  ].join('\n');
}

export function summarizeEvents(events, now = Date.now()) {
  const sessions = new Map();
  const ordered = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const event of ordered) {
    const session = sessions.get(event.conversationId) || { id: event.conversationId, model: event.modelName, status: 'unknown', lastEventAt: event.createdAt, toolCount: 0, errorCount: 0 };
    session.model = event.modelName; session.lastEventAt = event.createdAt;
    if (event.eventName === 'Stop') session.status = event.fullyIdle === false ? 'background' : event.fullyIdle === true ? 'idle' : 'unknown';
    else if (event.eventName === 'PostInvocation') session.status = 'unknown';
    else session.status = 'working';
    if (event.eventName === 'PostToolUse') { session.toolCount++; if (event.hasError) session.errorCount++; }
    sessions.set(session.id, session);
  }
  const alerts = [];
  for (const session of sessions.values()) {
    const recent = ordered.filter(event => event.conversationId === session.id && now - Date.parse(event.createdAt) <= 10 * 60_000);
    const errors = recent.filter(event => event.eventName === 'PostToolUse' && event.hasError);
    if (errors.length >= 3) alerts.push({ level: 'warning', message: `最近 10 分钟观察到 ${errors.length} 次工具错误，请查看宿主输出；尚不能据此确认原因。`, sessionId: session.id });
    if (session.status !== 'idle' && now - Date.parse(session.lastEventAt) > 5 * 60_000) {
      session.status = 'unknown';
      alerts.push({ level: 'info', message: '超过 5 分钟未观察到新事件。可能仍在思考、离线或 hooks 未连接，请在宿主中确认。', sessionId: session.id });
    }
  }
  return { sessions: [...sessions.values()].sort((a, b) => b.lastEventAt.localeCompare(a.lastEventAt)), alerts };
}
