#!/usr/bin/env node
import { realpath, stat, lstat, readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readState, addTask, addNote, appendEvent, workspaceFingerprint, recordCheck, buildReceipt, buildHandoff } from './core.js';
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

export async function initWorkspace(input) {
  const workspace = await resolveWorkspace(input);
  // Initialize private state, without altering host files or credentials.
  await readState(workspace);
  const directory = path.join(workspace, '.antigravity-companion');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, '.gitignore'), '*\n', { mode: 0o600, flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  await writeFile(path.join(directory, 'opt-in'), 'local-events-v1\n', { mode: 0o600, flag: 'wx' }).catch(async (error) => {
    if (error.code !== 'EEXIST') throw error;
    const marker = path.join(directory, 'opt-in');
    const info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink() || (await readFile(marker, 'utf8')).trim() !== 'local-events-v1') throw new Error('已有 opt-in 文件无效，请检查后重试');
  });
  return workspace;
}

export async function createDemoWorkspace({ directory } = {}) {
  const owned = !directory;
  const target = directory ? path.resolve(directory) : await mkdtemp(path.join(os.tmpdir(), 'gravity-companion-demo-'));
  if (directory) await mkdir(target, { recursive: true, mode: 0o700 });
  try {
    const workspace = await initWorkspace(target);
    await writeFile(
      path.join(workspace, 'README.md'),
      '# Gravity Companion Demo\n\n临时演示工作区，用于体验本地任务卡片、真实命令验证与跨工具交接。\n',
      { mode: 0o600 },
    );
    const pendingTask = await addTask(workspace, {
      title: '梳理支付回调重试与熔断策略',
      goal: '整理回调超时后的重试退避规则，生成可供 Codex 或 Claude Code 直接接手的交接卡片。',
      constraints: [
        '不修改现有订单表结构和公开回调 URL',
        '所有幂等键必须保留至少 24 小时',
        '生产配置密钥不得写入交接文档',
      ],
      decisions: [
        '重试上限设为 5 次，采用指数退避（1s / 2s / 4s / 8s / 16s）',
        '签名校验失败直接返回 400，不进入重试队列',
      ],
      nextSteps: [
        '补齐网络超时场景的单元测试并运行本地验证',
        '预览并导出 Markdown 交接记录给下一会话核对',
      ],
    });
    await addNote(workspace, pendingTask.id, '已完成回调状态机梳理；待补齐单测后通过 CLI 显式运行验证。');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const verifiedTask = await addTask(workspace, {
      title: '修复登录态续期与 OAuth 幂等校验',
      goal: '避免并发刷新令牌导致会话意外失效，并留存可复核的本地命令验收证据。',
      constraints: [
        '保持既有 Cookie 名称与同站策略不变',
        '零第三方运行时依赖，仅使用 Node.js 标准库',
        '源码变更后原有通过状态必须自动标为已过期',
      ],
      decisions: [
        '按 sessionId 对并发刷新请求做单飞合并，防止重复签发',
        'OAuth state 校验改为单次消费并记录执行前后文件快照',
      ],
      nextSteps: [
        '在验收记录确认通过后预览 Markdown 交接文本',
        '将任务简报交给下一次会话继续集成回归测试',
      ],
    });
    await addNote(workspace, verifiedTask.id, '已在本地复现并发刷新竞态并完成修复；若后续修改工作区源码，该验收结果会自动标为过期。');
    const { check, receipt } = await runCheck(workspace, verifiedTask.id, [process.execPath, '-e', "console.log('demo check ok')"]);
    const state = await readState(workspace);
    const tasks = [
      state.tasks.find((item) => item.id === verifiedTask.id),
      state.tasks.find((item) => item.id === pendingTask.id),
    ].filter(Boolean);
    const cleanup = () => (owned ? rm(workspace, { recursive: true, force: true }) : Promise.resolve());
    return { workspace, tasks, check, receipt, cleanup };
  } catch (error) {
    if (owned) await rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function openBrowser(url) {
  const executable = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const browser = spawn(executable, [url], { stdio: 'ignore', detached: false });
  browser.on('error', () => console.error('无法自动打开浏览器，请复制上面的链接。'));
  browser.unref();
}

async function main() {
  if (command === 'hook') return handleHook();
  if (command === 'demo') {
    const port = Number(option('--port', '0'));
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须在 0 到 65535 之间');
    const seedOnly = argv.includes('--seed-only');
    const demo = await createDemoWorkspace();
    if (seedOnly) {
      console.log(JSON.stringify({
        workspace: demo.workspace,
        tasks: demo.tasks.map((task) => ({ id: task.id, title: task.title })),
        receiptStatus: demo.receipt.status,
      }, null, 2));
      return;
    }
    let result;
    try {
      result = await startServer({ workspace: demo.workspace, port });
    } catch (error) {
      await demo.cleanup().catch(() => {});
      throw error;
    }
    console.log(`Gravity Companion Demo · ${path.basename(demo.workspace)}\n临时演示目录：${demo.workspace}\n本地面板：${result.url}\n已预置 2 条示例任务（含 1 条真实本地验证通过记录）。此链接包含临时访问令牌，请勿分享。Ctrl+C 停止并清理临时目录。`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      result.server.close();
      result.server.closeAllConnections();
      await demo.cleanup().catch(() => {});
    };
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
    if (argv.includes('--open')) openBrowser(result.url);
    return;
  }
  const workspace = await resolveWorkspace(option('--workspace', process.cwd()));
  if (command === 'init') {
    await initWorkspace(workspace);
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
    if (argv.includes('--open')) openBrowser(result.url);
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
  console.log(`Gravity Companion 0.1.1 · Node.js 22+\n\n用法：\n  node src/cli.js demo --open\n  node src/cli.js init --workspace <项目目录>\n  node src/cli.js serve --workspace <项目目录> --open\n  node src/cli.js task --workspace <项目目录> --title "修复登录"\n  node src/cli.js check --workspace <项目目录> <任务ID> -- node --test\n  node src/cli.js handoff --workspace <项目目录> <任务ID> --target claude\n  node src/cli.js doctor --workspace <项目目录>\n\ncheck 直接执行你指定的程序及参数，不隐式调用 shell。Windows .cmd 包装器请改用 node 加实际JS入口。\n官方插件安装方法见 README.md。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
