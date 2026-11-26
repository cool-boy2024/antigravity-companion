'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const labels = { workbench: '工作台', activity: '会话动态', competitors: '竞品观察', guide: '使用说明' };
  const verdicts = { passed: '已通过', failed: '失败', stale: '已过期', unverified: '未验证' };
  const sessionLabels = { working: '正在工作', idle: '本轮已停止', background: '后台仍在运行', unknown: '状态待确认' };
  const eventLabels = { SessionStart: '会话开始', PreInvocation: '开始模型调用', PostInvocation: '模型调用结束', PostToolUse: '工具调用结束', Stop: '执行循环停止' };
  let currentView = 'workbench';
  let selectedId = null;
  let draftMode = false;
  let dirty = false;
  let state = { tasks: [], events: [], activity: { sessions: [], alerts: [] } };
  let previewAction = null;
  let previewFilename = '';
  let previewMime = 'text/plain;charset=utf-8';
  let toastTimer;
  let refreshing = false;
  let competitorsLoaded = false;
  let token = '';

  try {
    const hash = new URLSearchParams(location.hash.slice(1));
    const incoming = hash.get('token');
    if (incoming) {
      token = incoming;
      sessionStorage.setItem('gravity-companion-token', incoming);
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    } else {
      token = sessionStorage.getItem('gravity-companion-token') || '';
    }
  } catch {
    token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    if (token) history.replaceState(null, '', `${location.pathname}${location.search}`);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function showToast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function showError(error) {
    $('global-error').textContent = errorMessage(error);
    $('global-error').hidden = false;
  }

  async function api(path, options = {}) {
    if (!token) throw new Error('缺少本机连接密钥。请打开服务终端打印的完整地址。');
    const headers = { Authorization: `Bearer ${token}` };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, {
      ...options,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(15000)
    });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('本机连接验证失败。服务重启后，请打开终端打印的新地址。');
      }
      const message = typeof data?.error === 'string' ? data.error : data?.error?.message;
      throw new Error(message || `请求失败（${response.status}）。请检查终端中的服务状态。`);
    }
    return data;
  }

  function timeLabel(value, full = false) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '时间未知';
    return full ? date.toLocaleString('zh-CN', { hour12: false }) : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  }

  function badge(status, customLabel) {
    const safeStatus = Object.hasOwn(verdicts, status) || Object.hasOwn(sessionLabels, status) ? status : 'unverified';
    return element('span', `badge ${safeStatus}`, customLabel || verdicts[safeStatus] || sessionLabels[safeStatus]);
  }

  function empty(title, description, compact = false) {
    const node = element('div', `empty-state${compact ? ' compact' : ''}`);
    node.append(element('strong', '', title), element('span', '', description));
    return node;
  }

  function getCurrentTask() {
    return state.tasks.find((task) => task.id === selectedId);
  }

  function changeView(view) {
    if (!Object.hasOwn(labels, view)) return;
    currentView = view;
    for (const [name] of Object.entries(labels)) $('view-' + name).hidden = name !== view || !token;
    for (const button of document.querySelectorAll('.nav-item')) {
      const active = button.dataset.view === view;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    $('view-label').textContent = labels[view];
    if (view === 'competitors' && !competitorsLoaded && token) loadCompetitors();
  }

  function fillEditor(task) {
    $('task-title').value = task?.title || '';
    $('task-goal').value = task?.goal || '';
    $('task-constraints').value = (task?.constraints || []).join('\n');
    $('task-decisions').value = (task?.decisions || []).join('\n');
    $('task-next-steps').value = (task?.nextSteps || []).join('\n');
    $('editor-heading').textContent = task ? '任务简报' : '新建任务';
    $('task-id').textContent = task ? `ID ${task.id}` : '保存后生成任务标识';
    $('save-state').textContent = task ? `保存于 ${timeLabel(task.updatedAt, true)}` : '尚未保存';
    dirty = false;
    $('save-task').textContent = task ? '保存修改' : '保存任务';
  }

  function selectTask(id) {
    if (dirty && !window.confirm('当前简报还有未保存的修改。切换后这些修改会丢失，继续吗？')) return;
    selectedId = id;
    draftMode = false;
    fillEditor(getCurrentTask());
    renderTaskList();
    renderTaskDetails();
  }

  function newTask() {
    if (dirty && !window.confirm('当前简报还有未保存的修改。新建任务前放弃这些修改吗？')) return;
    selectedId = null;
    draftMode = true;
    fillEditor(null);
    changeView('workbench');
    renderTaskList();
    renderTaskDetails();
    $('task-title').focus();
  }

  function renderTaskList() {
    const list = $('task-list');
    list.replaceChildren();
    $('task-count').textContent = `${state.tasks.length} 条`;
    if (!state.tasks.length) {
      list.append(empty('还没有任务', '在右侧写下第一个目标，保存后即可开始积累记录。'));
      return;
    }
    for (const task of [...state.tasks].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
      const card = element('button', `task-card${task.id === selectedId ? ' selected' : ''}`);
      card.type = 'button';
      card.setAttribute('aria-pressed', String(task.id === selectedId));
      card.append(element('h3', '', task.title || '未命名任务'));
      const meta = element('div', 'task-card-meta');
      const time = element('time', '', timeLabel(task.updatedAt));
      if (task.updatedAt) time.dateTime = task.updatedAt;
      meta.append(badge(task.receipt?.status || 'unverified'), time);
      card.append(meta);
      card.addEventListener('click', () => selectTask(task.id));
      list.append(card);
    }
  }

  function renderTaskDetails() {
    const task = getCurrentTask();
    for (const id of ['receipt-panel', 'handoff-panel', 'notes-panel']) $(id).hidden = !task;
    if (!task) return;
    const receipt = task.receipt || { status: 'unverified', checks: [], warnings: [] };
    const status = Object.hasOwn(verdicts, receipt.status) ? receipt.status : 'unverified';
    $('receipt-status').className = `badge ${status}`;
    $('receipt-status').textContent = verdicts[status];
    $('receipt-warnings').replaceChildren();
    for (const warning of receipt.warnings || []) {
      $('receipt-warnings').append(element('p', 'banner warning-banner', warning));
    }
    $('checks-list').replaceChildren();
    const checks = receipt.checks || task.checks || [];
    if (!checks.length) $('checks-list').append(empty('暂无验证记录', '手动备注和 hooks 事件不会被当作测试通过的证据。', true));
    for (const check of [...checks].reverse()) {
      const row = element('div', 'check-item');
      const header = element('div', 'check-header');
      header.append(element('code', 'check-command', Array.isArray(check.argv) ? check.argv.join(' ') : '未记录命令'), badge(check.verdict || 'unverified'));
      row.append(header);
      const exitCode = Number.isInteger(check.exitCode) ? check.exitCode : '未知';
      row.append(element('span', 'check-meta', `${timeLabel(check.finishedAt || check.startedAt, true)} · 退出码 ${exitCode}${check.signal ? ` · 信号 ${check.signal}` : ''} · ${check.source === 'local-runner' ? '本地运行器' : '导入或未确认来源'}`));
      const details = element('details');
      details.append(element('summary', '', '查看命令输出'));
      const output = element('pre', 'check-output');
      output.append(element('code', '', check.output || '没有捕获到输出。'));
      details.append(output);
      row.append(details);
      $('checks-list').append(row);
    }
    const hasGeneratedCommand = typeof task.checkCommand === 'string' && task.checkCommand.trim().length > 0;
    $('check-command').textContent = hasGeneratedCommand ? task.checkCommand : `gravity-companion check ${task.id} -- node --test`;
    $('check-command-help').textContent = hasGeneratedCommand
      ? '以下命令已经指定当前工作区和任务。复制后在终端显式运行，工作台不会在浏览器里执行命令。'
      : '此命令要求已安装 CLI，并在目标工作区的终端显式运行。工作台不会在浏览器里执行命令。';
    $('notes-list').replaceChildren();
    const notes = task.notes || [];
    if (!notes.length) $('notes-list').append(element('p', 'section-copy', '还没有补充记录。'));
    for (const note of notes) {
      const item = element('div', 'note-item');
      item.append(element('p', '', note.text), element('time', '', `${timeLabel(note.createdAt, true)} · ${note.source === 'manual' ? '手动记录' : '导入记录'}`));
      $('notes-list').append(item);
    }
  }

  function renderActivity() {
    const activity = state.activity || { sessions: [], alerts: [] };
    $('activity-alerts').replaceChildren();
    for (const alert of activity.alerts || []) {
      const message = typeof alert === 'string' ? alert : alert.message;
      $('activity-alerts').append(element('p', 'banner warning-banner', message));
    }
    const sessions = activity.sessions || [];
    $('session-count').textContent = String(sessions.length);
    $('sessions-list').replaceChildren();
    if (!sessions.length) $('sessions-list').append(empty('还没有接入会话事件', '启用官方 hooks 后，新的会话状态会出现在这里。'));
    for (const session of sessions) {
      const card = element('section', 'panel session-card');
      const header = element('div', 'panel-heading');
      header.append(element('h2', '', session.model || 'Antigravity 会话'), badge(session.status, sessionLabels[session.status] || '状态待确认'));
      card.append(header, element('p', 'session-id', session.id));
      const stats = element('div', 'session-stats');
      for (const [number, label] of [[session.toolCount || 0, '工具调用'], [session.errorCount || 0, '错误事件']]) {
        const item = element('span');
        item.append(element('strong', '', number), document.createTextNode(label));
        stats.append(item);
      }
      card.append(stats, element('p', 'session-updated', `最近事件 ${timeLabel(session.lastEventAt, true)}`));
      $('sessions-list').append(card);
    }
    const events = [...(state.events || [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 60);
    $('events-list').replaceChildren();
    if (!events.length) $('events-list').append(empty('暂无事件', '这里只展示实际收到的本地事件。', true));
    for (const event of events) {
      const row = element('div', 'event-row');
      row.append(element('time', '', timeLabel(event.createdAt, true)));
      const detail = element('div');
      detail.append(element('p', 'event-title', `${eventLabels[event.eventName] || event.eventName}${event.hasError ? ' · 观察到错误' : ''}`));
      detail.append(element('p', 'session-id', event.conversationId || '会话标识未知'));
      row.append(detail, element('span', 'event-tool', event.toolName || (event.fullyIdle === false ? '后台仍有任务' : '')));
      $('events-list').append(row);
    }
    $('activity-updated').textContent = `本地刷新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  }

  function renderState() {
    $('workspace-name').textContent = state.workspaceName || '当前工作区';
    $('task-total').textContent = String(state.tasks.length);
    $('check-total').textContent = String(state.tasks.reduce((sum, task) => sum + (task.checks?.length || 0), 0));
    $('active-total').textContent = String((state.activity?.sessions || []).filter((session) => session.status === 'working' || session.status === 'background').length);
    if (!selectedId && !draftMode && state.tasks.length) {
      selectedId = [...state.tasks].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0].id;
      fillEditor(getCurrentTask());
    }
    renderTaskList();
    renderTaskDetails();
    renderActivity();
  }

  async function refresh() {
    if (refreshing || !token) return;
    refreshing = true;
    try {
      const data = await api('/api/state');
      if (!data || !Array.isArray(data.tasks)) throw new Error('服务返回的数据格式无法识别。');
      state = data;
      $('connection').replaceChildren(element('span', 'status-dot'), document.createTextNode('本地已连接'));
      $('connection').classList.remove('offline');
      $('global-error').hidden = true;
      renderState();
    } catch (error) {
      $('connection').replaceChildren(element('span', 'status-dot'), document.createTextNode('连接中断'));
      $('connection').classList.add('offline');
      showError(error);
    } finally {
      refreshing = false;
    }
  }

  function lineItems(value) {
    return value.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  function taskInput() {
    return { title: $('task-title').value.trim(), goal: $('task-goal').value.trim(), constraints: lineItems($('task-constraints').value), decisions: lineItems($('task-decisions').value), nextSteps: lineItems($('task-next-steps').value) };
  }

  async function saveTask(event) {
    event.preventDefault();
    if (!$('task-form').reportValidity()) return;
    $('save-task').disabled = true;
    try {
      const data = await api(selectedId ? `/api/tasks/${encodeURIComponent(selectedId)}` : '/api/tasks', { method: selectedId ? 'PATCH' : 'POST', body: taskInput() });
      const task = data.task || data;
      if (!task.id) throw new Error('保存结果缺少任务标识。');
      selectedId = task.id;
      draftMode = false;
      fillEditor(task);
      showToast('任务已保存在本机。');
      await refresh();
    } catch (error) { showError(error); }
    finally { $('save-task').disabled = false; }
  }

  function openPreview({ title, description, content, filename, mime, action, confirmLabel, canCopy = true }) {
    $('preview-title').textContent = title;
    $('preview-description').textContent = description;
    $('preview-text').value = content;
    $('preview-feedback').textContent = '请检查敏感信息和验证状态。';
    $('copy-preview').hidden = !canCopy;
    $('confirm-preview').textContent = confirmLabel || '下载文件';
    previewAction = action || null;
    previewFilename = filename || 'gravity-handoff.txt';
    previewMime = mime || 'text/plain;charset=utf-8';
    $('preview-dialog').showModal();
  }

  async function handoffPreview() {
    if (!selectedId) return;
    $('handoff-preview').disabled = true;
    try {
      const target = $('handoff-target').value;
      const data = await api(`/api/tasks/${encodeURIComponent(selectedId)}/handoff?target=${encodeURIComponent(target)}`);
      if (typeof data?.markdown !== 'string') throw new Error('交接内容格式无法识别。');
      openPreview({ title: '预览交接', description: '这是供下一次会话参考的工作记录。复制或下载前，请复核约束、未完成事项和敏感信息。', content: data.markdown, filename: `gravity-handoff-${selectedId.slice(0, 8)}.md`, mime: 'text/markdown;charset=utf-8' });
    } catch (error) { showError(error); }
    finally { $('handoff-preview').disabled = false; }
  }

  async function exportTask() {
    if (!selectedId) return;
    $('export-json').disabled = true;
    try {
      const data = await api(`/api/tasks/${encodeURIComponent(selectedId)}/export`);
      openPreview({ title: '预览 JSON 导出', description: '导出文件用于跨工具交接。服务会做基础脱敏，仍请检查命令输出、项目名称及你主动填写的信息。', content: JSON.stringify(data, null, 2), filename: `gravity-task-${selectedId.slice(0, 8)}.json`, mime: 'application/json;charset=utf-8' });
    } catch (error) { showError(error); }
    finally { $('export-json').disabled = false; }
  }

  async function importTask(event) {
    const file = event.target.files?.[0];
    $('import-file').value = '';
    if (!file) return;
    try {
      if (file.size > 256 * 1024) throw new Error('导入文件不能超过 256 KB。请移除不需要的输出后重试。');
      const content = await file.text();
      const parsed = JSON.parse(content);
      const task = parsed?.task || parsed;
      if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.title !== 'string') throw new Error('请选择包含任务名称的 Gravity Companion JSON 文件。');
      openPreview({ title: '预览导入', description: '导入会新建一条任务，不会执行文件中的命令。外部验证声明会被降级为未验证记录，请先审阅内容。', content: JSON.stringify(task, null, 2), canCopy: false, confirmLabel: '确认导入为新任务', action: async () => {
        if (dirty && !window.confirm('当前简报还有未保存的修改。导入并切换任务前放弃这些修改吗？')) return false;
        const data = await api('/api/import', { method: 'POST', body: { task } });
        const imported = data.task || data;
        if (!imported.id) throw new Error('导入结果缺少任务标识。');
        selectedId = imported.id;
        draftMode = false;
        fillEditor(imported);
        changeView('workbench');
        await refresh();
        showToast('已导入为新任务，外部验证不会计为本机通过。');
        return true;
      } });
    } catch (error) {
      showError(error instanceof SyntaxError ? new Error('文件不是有效的 JSON，请检查格式后重试。') : error);
    }
  }

  async function confirmPreview() {
    $('confirm-preview').disabled = true;
    try {
      if (previewAction) {
        const completed = await previewAction();
        if (completed !== false) $('preview-dialog').close();
      } else {
        const blob = new Blob([$('preview-text').value], { type: previewMime });
        const url = URL.createObjectURL(blob);
        const link = element('a');
        link.href = url;
        link.download = previewFilename;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        $('preview-feedback').textContent = '已准备下载，请检查浏览器下载列表。';
      }
    } catch (error) { $('preview-feedback').textContent = errorMessage(error); }
    finally { $('confirm-preview').disabled = false; }
  }

  async function copyPreview() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('无法自动复制');
      await navigator.clipboard.writeText($('preview-text').value);
      $('preview-feedback').textContent = '内容已复制。';
    } catch {
      $('preview-text').focus();
      $('preview-text').select();
      $('preview-feedback').textContent = '内容已选中，请按 Ctrl+C 或 Command+C 复制。';
    }
  }

  async function copyCheckCommand() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('无法自动复制');
      await navigator.clipboard.writeText($('check-command').textContent);
      showToast('验证命令已复制，请检查后在终端运行。');
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents($('check-command'));
      selection.removeAllRanges();
      selection.addRange(range);
      showToast('命令已选中，请按 Ctrl+C 或 Command+C 复制。');
    }
  }

  async function addNote(event) {
    event.preventDefault();
    if (!selectedId || !$('note-form').reportValidity()) return;
    const text = $('note-text').value.trim();
    if (!text) return;
    $('add-note').disabled = true;
    try {
      await api(`/api/tasks/${encodeURIComponent(selectedId)}/notes`, { method: 'POST', body: { text } });
      $('note-text').value = '';
      await refresh();
      showToast('补充记录已保存。');
    } catch (error) { showError(error); }
    finally { $('add-note').disabled = false; }
  }

  function cellText(value) {
    if (value === null || value === undefined) return '尚未核实';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return value.summary || value.description || value.status || JSON.stringify(value);
    return String(value);
  }

  async function loadCompetitors() {
    $('competitors-list').replaceChildren(empty('正在读取能力对照', '加载本项目维护的官方来源记录。'));
    try {
      const data = await api('/api/competitors');
      if (!Array.isArray(data?.features)) throw new Error('竞品观察数据格式无法识别。');
      $('competitor-date').textContent = `核实日期 ${data.checkedAt || '未记录'}`;
      $('competitors-list').replaceChildren();
      if (!data.features.length) $('competitors-list').append(empty('尚无对照记录', '后续会根据官方文档补充。'));
      for (const feature of data.features) {
        const card = element('section', 'panel competitor-card');
        const header = element('div', 'panel-heading');
        header.append(element('h2', '', feature.name || feature.id || '功能对照'));
        if (feature.priority) header.append(element('span', 'badge', feature.priority));
        card.append(header);
        const grid = element('div', 'compare-grid');
        for (const [key, label] of [['codex', 'Codex'], ['claude', 'Claude Code'], ['antigravity', 'Antigravity']]) {
          const cell = element('div', 'compare-cell');
          cell.append(element('div', 'compare-label', label), element('p', '', cellText(feature[key])));
          grid.append(cell);
        }
        card.append(grid);
        const ours = element('div', 'our-direction');
        ours.append(element('strong', '', '本项目的实现与方向'), element('p', '', cellText(feature.ours)));
        card.append(ours);
        const sources = element('div', 'source-links');
        for (const source of feature.sources || []) {
          try {
            const url = new URL(source.url);
            if (url.protocol !== 'https:') continue;
            const link = element('a', '', source.label || url.hostname);
            link.href = url.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            sources.append(link);
          } catch { /* Invalid source links are omitted. */ }
        }
        card.append(sources);
        $('competitors-list').append(card);
      }
      competitorsLoaded = true;
    } catch (error) {
      $('competitors-list').replaceChildren(empty('暂时无法读取对照记录', errorMessage(error)));
      const retry = element('button', 'button secondary', '重试');
      retry.type = 'button';
      retry.addEventListener('click', loadCompetitors);
      $('competitors-list').append(retry);
      $('competitor-date').textContent = '加载失败';
    }
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('theme-toggle').textContent = theme === 'dark' ? '切换浅色' : '切换深色';
    $('theme-toggle').setAttribute('aria-label', theme === 'dark' ? '切换浅色模式' : '切换深色模式');
    try { localStorage.setItem('gravity-companion-theme', theme); } catch { /* Theme remains available without storage. */ }
  }

  let savedTheme;
  try { savedTheme = localStorage.getItem('gravity-companion-theme'); } catch { /* Use system theme. */ }
  setTheme(savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $('theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  for (const button of document.querySelectorAll('.nav-item')) button.addEventListener('click', () => changeView(button.dataset.view));
  document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); changeView('workbench'); });
  $('new-task').addEventListener('click', newTask);
  $('task-form').addEventListener('submit', saveTask);
  $('task-form').addEventListener('input', () => { dirty = true; $('save-state').textContent = '有未保存的修改'; });
  $('note-form').addEventListener('submit', addNote);
  $('handoff-preview').addEventListener('click', handoffPreview);
  $('export-json').addEventListener('click', exportTask);
  $('import-button').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', importTask);
  $('close-preview').addEventListener('click', () => $('preview-dialog').close());
  $('copy-preview').addEventListener('click', copyPreview);
  $('copy-check-command').addEventListener('click', copyCheckCommand);
  $('confirm-preview').addEventListener('click', confirmPreview);
  window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  $('auth-gate').hidden = Boolean(token);
  if (!token) {
    $('connection').replaceChildren(element('span', 'status-dot'), document.createTextNode('未连接'));
    $('connection').classList.add('offline');
    $('workspace-name').textContent = '尚未连接';
  }
  changeView(currentView);
  fillEditor(null);
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
