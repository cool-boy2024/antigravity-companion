#!/usr/bin/env node
import { realpath, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readState, addTask, appendEvent, workspaceFingerprint, recordCheck, buildReceipt, buildHandoff } from './core.js';
import { redact } from './privacy.js';
import { startServer } from './server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const command = argv.shift() || 'help';
function option(name, fallback) {
  const index = argv.indexOf(name);
  const separator = argv.indexOf('--');
  if (index < 0 || (separator >= 0 && index > separator)) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少值`);
  argv.splice(index, 2);
  return value;
}
async function resolveWorkspace(input) {
  const workspace = await realpath(input);
  if (!(await stat(workspace)).isDirectory()) throw new Error('工作区必须是目录');
  return workspace;
}

async function handleHook() {
  try {
    const event = argv.shift();
    if (!['SessionStart', 'PreInvocation', 'PostInvocation', 'PostToolUse', 'Stop'].includes(event)) return;
    let size = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size <= 2 * 1024 * 1024) chunks.push(chunk);
    }
    if (size > 2 * 1024 * 1024) return;
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const explicit = option('--workspace', null);
    const workspace = await resolveWorkspace(explicit || payload.workspacePaths?.[0] || '');
    // A workspace .opt-in marker is only created by the user's init command.
    // Installing a globally enabled plugin cannot collect unrelated projects.
    if ((await readFile(path.join(workspace, '.antigravity-companion/opt-in'), 'utf8')).trim() !== 'local-events-v1') return;
    await appendEvent(workspace, event, payload);
  } catch {
    // Observation failure never changes the host's permissions or task outcome.
  } finally { process.stdout.write('{}\n'); }
}

export async function runCheck(workspace, taskId, args, { timeoutMs = 120000 } = {}) {
  if (!args.length) throw new Error('在 -- 后指定程序及参数，例如 -- node --test');
  const state = await readState(workspace);
  if (!state.tasks.some((task) => task.id === taskId)) throw new Error('任务不存在');
  const beforeFingerprint = await workspaceFingerprint(workspace);
  const startedAt = new Date().toISOString();
  const result = await new Promise((resolve) => {
    let output = '';
    let truncated = false;
    let launchError;
    let timedOut = false;
    const child = spawn(args[0], args.slice(1), { cwd: workspace, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const capture = (chunk) => {
      if (output.length < 65536) output += chunk.toString('utf8').slice(0, 65536 - output.length);
      else truncated = true;
    };
    const terminate = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* process already exited */ }
    };
    const cancel = () => { timedOut = true; terminate(); };
    process.once('SIGINT', cancel);
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', (error) => { launchError = error.message; });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', cancel);
      resolve({ exitCode, signal: timedOut ? (signal || 'TIMEOUT') : signal, output: `${output}${truncated ? '\n[输出截断为 64KB]' : ''}${launchError ? `\n[启动失败] ${launchError}` : ''}` });
    });
  });
  let afterFingerprint = null;
  try { afterFingerprint = await workspaceFingerprint(workspace); } catch { /* receipt stays unverified */ }
  const check = { id: randomUUID(), argv: args.map(redact), ...result, output: redact(result.output).slice(0, 65536), startedAt, finishedAt: new Date().toISOString(), beforeFingerprint, afterFingerprint, source: 'local-runner' };
  const task = await recordCheck(workspace, taskId, check);
  return { check, receipt: buildReceipt(task, afterFingerprint) };
}

async function main() {
  if (command === 'hook') return handleHook();
  const workspace = await resolveWorkspace(option('--workspace', process.cwd()));
  if (command === 'init') {
    // Initialize private state, without altering host files or credentials.
    await readState(workspace);
    const directory = path.join(workspace, '.antigravity-companion');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, '.gitignore'), '*\n', { mode: 0o600, flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    await writeFile(path.join(directory, 'opt-in'), 'local-events-v1\n', { mode: 0o600, flag: 'wx' }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
      const { lstat } = await import('node:fs/promises');
      const marker = path.join(directory, 'opt-in');
      if (!(await lstat(marker)).isFile() || (await lstat(marker)).isSymbolicLink() || (await readFile(marker, 'utf8')).trim() !== 'local-events-v1') throw new Error('已有 opt-in 文件无效，请检查后重试');
    });
    console.log('工作区已初始化。只在此工作区接收已启用的官方 hook 事件。');
    return;
  }
  if (command === 'serve') {
    const port = Number(option('--port', '0'));
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须在 0 到 65535 之间');
    const result = await startServer({ workspace, port });
    console.log(`Gravity Companion · ${path.basename(workspace)}\n本地面板：${result.url}\n此链接包含临时访问令牌，请勿分享。Ctrl+C 关闭服务。`);
    const stop = () => { result.server.close(); result.server.closeAllConnections(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (argv.includes('--open')) {
      const executable = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
      const browser = spawn(executable, [result.url], { stdio: 'ignore', detached: false });
      browser.on('error', () => console.error('无法自动打开浏览器，请复制上面的链接。'));
      browser.unref();
    }
    return;
  }
  if (command === 'task') {
    const title = option('--title', argv.join(' '));
    const task = await addTask(workspace, { title });
    console.log(`${task.id}\t${task.title}`);
    return;
  }
  if (command === 'check') {
    const timeout = Number(option('--timeout', '120'));
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 1800) throw new Error('超时应为 1 到 1800 秒');
    const separator = argv.indexOf('--');
    if (separator !== 1) throw new Error('格式：check <任务ID> -- <程序> [参数]');
    const { check, receipt } = await runCheck(workspace, argv[0], argv.slice(2), { timeoutMs: timeout * 1000 });
    console.log(JSON.stringify({ status: receipt.status, exitCode: check.exitCode, signal: check.signal, output: check.output }, null, 2));
    process.exitCode = check.exitCode === 0 && !check.signal ? 0 : 1;
    return;
  }
  if (command === 'handoff') {
    const target = option('--target', 'generic');
    if (!['generic', 'codex', 'claude', 'antigravity'].includes(target)) throw new Error('未知交接目标');
    const task = (await readState(workspace)).tasks.find((item) => item.id === argv[0]);
    if (!task) throw new Error('任务不存在');
    let fingerprint = null;
    try { fingerprint = await workspaceFingerprint(workspace); } catch { /* unknown */ }
    console.log(redact(buildHandoff(task, buildReceipt(task, fingerprint), { target })));
    return;
  }
  if (command === 'doctor') {
    const plugin = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'));
    const state = await readState(workspace);
    console.log(JSON.stringify({ node: process.version, workspace: path.basename(workspace), plugin: plugin.name, tasks: state.tasks.length, events: state.events.length, accountAccess: false, networkTelemetry: false, hostActivation: '请在 Antigravity 的 Customizations / Hooks 界面确认是否加载；doctor 不推断宿主已接入。' }, null, 2));
    return;
  }
  console.log(`Gravity Companion 0.1.0 · Node.js 22+\n\n用法：\n  node src/cli.js init --workspace <项目目录>\n  node src/cli.js serve --workspace <项目目录> --open\n  node src/cli.js task --workspace <项目目录> --title "修复登录"\n  node src/cli.js check --workspace <项目目录> <任务ID> -- node --test\n  node src/cli.js handoff --workspace <项目目录> <任务ID> --target claude\n  node src/cli.js doctor --workspace <项目目录>\n\ncheck 直接执行你指定的程序及参数，不隐式调用 shell。Windows .cmd 包装器请改用 node 加实际JS入口。\n官方插件安装方法见 README.md。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
