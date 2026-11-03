const $ = (id) => document.getElementById(id);
const state = { projects: [], csrfToken: '', loaded: false, filter: 'all', search: '', cards: new Map(), pending: new Map(), request: 0, fetching: 0, log: null, logRequest: 0, toastTimer: null, scanning: false };
const labels = { stopped: '未启动', starting: '正在启动', running: '运行中', stopping: '正在停止', failed: '启动失败', external: '外部运行', conflict: '端口占用' };
const actionLabels = { start: '启动', stop: '停止', restart: '重启' };
const isLive = (service) => ['running', 'external'].includes(service.status);
const isReady = (service) => Boolean(service.available) && ['stopped', 'failed', 'conflict'].includes(service.status || 'stopped');
const needsAttention = (project) => !project.services?.length || project.services.some((s) => ['failed', 'conflict'].includes(s.status) || (!s.available && !isLive(s)));
const keyFor = (project, service) => JSON.stringify([project.id, service.id]);
const text = (node, value) => { const next = String(value ?? ''); if (node.textContent !== next) node.textContent = next; };

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function button(className, label, onClick) {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function safeURL(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}

function formatTime(value, full = false) {
  if (!value) return '尚未扫描';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...(full ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}

function toast(message, error = false) {
  clearTimeout(state.toastTimer);
  text($('toast'), message);
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3500);
}

async function api(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), body ? 45000 : 20000);
  try {
    const response = await fetch(path, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Subboss-Token': state.csrfToken }, body: JSON.stringify(body) }), cache: 'no-store', signal: controller.signal });
    let data;
    try { data = await response.json(); } catch { throw new Error('服务返回了无法读取的响应，请检查启动台服务。'); }
    if (!response.ok || data.ok === false || data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `请求失败（${response.status}）`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时，请稍后刷新状态。操作可能仍在处理中。');
    if (error instanceof TypeError) throw new Error('无法连接启动台，请确认本地控制台仍在运行。');
    throw error;
  } finally { clearTimeout(timeout); }
}

function showNotice(message) {
  text($('noticeText'), message);
  $('notice').hidden = false;
  text($('connectionLabel'), '连接中断');
  $('connectionDot').className = 'connection-dot disconnected';
}

async function refresh(force = false) {
  if (state.fetching && !force) return;
  const request = ++state.request;
  state.fetching++;
  try {
    const data = await api('/api/runtime');
    if (request !== state.request) return;
    if (!Array.isArray(data.projects)) throw new Error('项目数据格式不正确，请重新扫描。');
    state.projects = data.projects.map((p) => ({ ...p, services: Array.isArray(p.services) ? p.services : [] }));
    state.csrfToken = data.csrfToken || state.csrfToken;
    state.loaded = true;
    $('notice').hidden = true;
    $('initialState').hidden = true;
    $('scanButton').disabled = state.scanning || !state.csrfToken;
    text($('rootPath'), `${data.root || '本地项目目录'}${data.roots?.length > 1 ? `\n另有 ${data.roots.length - 1} 个已纳入的项目目录` : ''}`);
    text($('scanTime'), `扫描时间：${formatTime(data.scannedAt, true)}`);
    text($('updatedAt'), `状态更新 ${formatTime(Date.now())}`);
    text($('connectionLabel'), '本地服务已连接');
    $('connectionDot').className = 'connection-dot connected';
    render();
  } catch (error) {
    if (request !== state.request) return;
    showNotice(state.loaded ? `${error.message} 当前保留上一次读取的状态。` : error.message);
    if (!state.loaded) {
      $('initialState').hidden = true;
      $('emptyState').hidden = false;
      text($('emptyTitle'), '还没有连上启动台');
      text($('emptyCopy'), '重新连接后，就可以查看和控制本地项目。');
      $('resetFilters').hidden = true;
      text($('resultCount'), '项目状态暂不可用');
    }
  } finally { state.fetching--; }
}

function createCard(project) {
  const node = element('article', 'project-card');
  const head = element('div', 'project-head');
  const monogram = element('div', 'project-monogram');
  monogram.setAttribute('aria-hidden', 'true');
  const heading = element('div', 'project-heading');
  const name = element('h2');
  const path = element('code', 'project-path');
  heading.append(name, path);
  const count = element('span', 'project-count');
  head.append(monogram, heading, count);
  const meta = element('div', 'project-meta');
  const list = element('div', 'service-list');
  const empty = element('div', 'no-services');
  const emptyText = element('div');
  emptyText.append(element('p', '', '尚未识别到可启动服务'), element('p', '', '项目可能无需本地预览，或需要补充启动配置。'));
  empty.append(element('span', '', '·'), emptyText);
  const notes = element('ul', 'project-notes');
  node.append(head, meta, list, empty, notes);
  return { node, monogram, name, path, count, meta, list, empty, notes, services: new Map(), metaKey: '', notesKey: '' };
}

function createService(project, service) {
  const node = element('div', 'service');
  const top = element('div', 'service-top');
  const name = element('h3', 'service-name');
  const status = element('span', 'service-state');
  const statusText = element('span');
  const dot = element('i', 'status-dot');
  dot.setAttribute('aria-hidden', 'true');
  status.append(dot, statusText);
  top.append(name, status);
  const endpoint = element('div', 'service-endpoint');
  const port = element('span', 'port');
  const portNumber = element('strong');
  port.append(element('span', '', '端口'), portNumber);
  const divider = element('span', 'endpoint-divider');
  divider.setAttribute('aria-hidden', 'true');
  const url = element('a', 'service-url');
  url.target = '_blank'; url.rel = 'noopener noreferrer';
  endpoint.append(port, divider, url);
  const controls = element('div', 'service-controls');
  const lifecycle = element('div', 'lifecycle-controls');
  const buttons = {};
  for (const action of ['start', 'stop', 'restart']) {
    buttons[action] = button(`button small ${action === 'start' ? 'primary' : `secondary ${action}`}`, actionLabels[action], () => act(project.id, service.id, action));
    lifecycle.append(buttons[action]);
  }
  const inspect = element('div', 'inspect-controls');
  const logs = button('button log-button', '日志', () => openLogs(project.id, service.id));
  const open = element('a', 'button open-button', '打开 ↗');
  open.target = '_blank'; open.rel = 'noopener noreferrer';
  inspect.append(logs, open);
  controls.append(lifecycle, inspect);
  const explanation = element('p', 'service-explanation');
  const details = element('details', 'service-details');
  const command = element('pre');
  details.append(element('summary', '', '启动命令与目录'), command);
  node.append(top, endpoint, controls, explanation, details);
  return { node, name, status, statusText, portNumber, url, buttons, open, logs, explanation, command };
}

function updateService(view, project, service) {
  const status = service.status || 'stopped';
  const pending = state.pending.get(keyFor(project, service));
  const busy = Boolean(pending) || ['starting', 'stopping'].includes(status);
  text(view.name, service.label || service.id);
  text(view.statusText, pending ? `${actionLabels[pending]}中…` : labels[status] || '状态未知');
  view.status.dataset.status = pending ? 'starting' : status;
  text(view.portNumber, service.port || '—');
  const href = safeURL(service.url);
  text(view.url, service.url || '未配置访问地址');
  view.url.title = service.url || '未配置访问地址';
  for (const link of [view.url, view.open]) {
    const enabled = href && isLive(service);
    link.setAttribute('aria-disabled', String(!enabled));
    link.tabIndex = enabled ? 0 : -1;
    if (enabled) link.href = href; else link.removeAttribute('href');
    link.title = !href ? '未配置可用的访问地址' : !isLive(service) ? '服务运行后可打开' : `打开 ${service.url}`;
  }
  view.buttons.start.disabled = busy || !service.available || ['running', 'external'].includes(status);
  const canControl = ['running', 'starting'].includes(status) && Boolean(service.pid);
  view.buttons.stop.disabled = Boolean(pending) || !canControl;
  view.buttons.restart.disabled = Boolean(pending) || !service.available || !canControl;
  for (const [action, control] of Object.entries(view.buttons)) {
    text(control, pending === action ? `${actionLabels[action]}中…` : action === 'start' ? '▷ 启动' : actionLabels[action]);
    control.setAttribute('aria-label', `${actionLabels[action]} ${project.name} 的 ${service.label || service.id}`);
    control.title = status === 'external' ? '服务由外部启动，请在原终端管理' : action === 'start' && !service.available ? service.disabledReason || '启动配置尚不可用' : `${actionLabels[action]}服务`;
  }
  view.logs.setAttribute('aria-label', `查看 ${project.name} 的 ${service.label || service.id} 日志`);
  let explanation = '';
  if (status === 'external') explanation = `已在其他终端运行${service.pid ? ` · 进程 ${service.pid}` : ''}，请在原终端停止或重启。`;
  else if (status === 'conflict') explanation = service.lastError || '端口已被其他进程占用。启动时将重新检查端口。';
  else if (service.lastError && ['failed', 'starting', 'stopping'].includes(status)) explanation = service.lastError;
  else if (!service.available) explanation = service.disabledReason || '启动配置不可用，请检查项目依赖或启动命令。';
  else if (status === 'running' && service.pid) explanation = `进程 ${service.pid}${service.startedAt ? ` · 启动于 ${formatTime(service.startedAt)}` : ''}`;
  text(view.explanation, explanation);
  view.explanation.hidden = !explanation;
  view.explanation.classList.toggle('is-error', ['failed', 'conflict'].includes(status));
  const args = Array.isArray(service.args) ? service.args : [];
  const quote = (value) => /^[\w./:=@+-]+$/.test(String(value)) ? String(value) : JSON.stringify(value);
  const command = [service.executable, ...args].filter((v) => v !== undefined && v !== null).map(quote).join(' ');
  text(view.command, `${command || '尚未配置启动命令'}\n\n运行目录：${service.cwd || project.path || '未知'}${service.source ? `\n识别来源：${service.source}` : ''}`);
}

function updateCard(view, project) {
  text(view.name, project.name || project.id);
  text(view.monogram, Array.from(project.name || project.id || '项')[0].toUpperCase());
  text(view.path, project.path || '路径未知');
  view.path.title = project.path || '';
  const running = project.services.filter(isLive).length;
  text(view.count, running ? `${running} / ${project.services.length} 运行中` : `${project.services.length} 个服务`);
  view.node.classList.toggle('is-live', running > 0);
  const stack = Array.isArray(project.stack) ? project.stack : [];
  const databases = Array.isArray(project.databases) ? project.databases : [];
  const metaKey = JSON.stringify([stack, databases]);
  if (metaKey !== view.metaKey) {
    view.meta.replaceChildren();
    stack.forEach((item) => view.meta.append(element('span', 'meta-tag', item)));
    if (!stack.length) view.meta.append(element('span', 'meta-tag unknown', '技术栈未识别'));
    for (const item of databases.length ? databases : ['未识别']) {
      const tag = element('span', `meta-tag ${databases.length ? 'database' : 'unknown'}`);
      tag.append(element('span', 'tag-label', '数据库'), document.createTextNode(String(item)));
      view.meta.append(tag);
    }
    view.metaKey = metaKey;
  }
  const ids = new Set();
  for (const service of project.services) {
    ids.add(service.id);
    let child = view.services.get(service.id);
    if (!child) { child = createService(project, service); view.services.set(service.id, child); view.list.append(child.node); }
    updateService(child, project, service);
  }
  for (const [id, child] of view.services) if (!ids.has(id)) { child.node.remove(); view.services.delete(id); }
  view.list.hidden = !project.services.length;
  view.empty.hidden = project.services.length > 0;
  const notes = Array.isArray(project.notes) ? project.notes : [];
  const notesKey = JSON.stringify(notes);
  if (notesKey !== view.notesKey) { view.notes.replaceChildren(...notes.map((note) => element('li', '', note))); view.notesKey = notesKey; }
  view.notes.hidden = !notes.length;
}

function matchesFilter(project, filter = state.filter) {
  return filter === 'all' || (filter === 'running' && project.services.some(isLive)) || (filter === 'ready' && project.services.some(isReady)) || (filter === 'attention' && needsAttention(project));
}

function render() {
  const services = state.projects.flatMap((p) => p.services);
  text($('projectCount'), state.projects.length);
  text($('serviceCount'), `共识别 ${services.length} 个本地服务`);
  text($('runningCount'), services.filter(isLive).length);
  const managed = services.filter((s) => s.status === 'running').length;
  const external = services.filter((s) => s.status === 'external').length;
  text($('managedCount'), `启动台管理 ${managed} · 外部运行 ${external}`);
  text($('readyCount'), services.filter(isReady).length);
  const attention = state.projects.filter(needsAttention).length;
  text($('attentionCount'), attention);
  text($('attentionNote'), `${attention} 个项目待检查或配置`);
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
    text(button.querySelector('span'), state.projects.filter((p) => matchesFilter(p, button.dataset.filter)).length);
  });
  const search = state.search.trim().toLocaleLowerCase();
  let shown = 0;
  const ids = new Set();
  for (const project of state.projects) {
    ids.add(project.id);
    let card = state.cards.get(project.id);
    if (!card) { card = createCard(project); state.cards.set(project.id, card); $('projects').append(card.node); }
    updateCard(card, project);
    const haystack = [project.name, project.id, project.path, ...(project.stack || []), ...(project.databases || []), ...project.services.flatMap((s) => [s.label, s.port, s.url])].filter(Boolean).join(' ').toLocaleLowerCase();
    const visible = matchesFilter(project) && (!search || haystack.includes(search));
    card.node.hidden = !visible;
    if (visible) shown++;
  }
  for (const [id, card] of state.cards) if (!ids.has(id)) { card.node.remove(); state.cards.delete(id); }
  text($('resultCount'), shown === state.projects.length ? `${shown} 个项目` : `显示 ${shown} / ${state.projects.length} 个项目`);
  $('emptyState').hidden = shown > 0;
  $('resetFilters').hidden = !state.projects.length;
  text($('emptyTitle'), state.projects.length ? '没有匹配的项目' : '还没有发现项目');
  text($('emptyCopy'), state.projects.length ? '换个关键词，或查看全部项目。' : '确认扫描目录内有项目，然后点击右上角重新扫描。');
}

async function act(projectId, serviceId, action) {
  const project = state.projects.find((p) => p.id === projectId);
  const service = project?.services.find((s) => s.id === serviceId);
  if (!service) return;
  const key = keyFor(project, service);
  if (state.pending.has(key)) return;
  state.pending.set(key, action);
  render();
  try {
    await api('/api/runtime/action', { projectId, serviceId, action });
    toast(`${project.name} · ${service.label || service.id}：${actionLabels[action]}请求已处理`);
    await refresh(true);
    if (state.log?.projectId === projectId && state.log?.serviceId === serviceId) await loadLogs();
  } catch (error) { toast(error.message, true); await refresh(true); }
  finally { state.pending.delete(key); render(); }
}

async function scan() {
  if (state.scanning) return;
  state.scanning = true;
  $('scanButton').disabled = true;
  $('scanButton').classList.add('spinning');
  text($('scanButton').lastElementChild, '扫描中…');
  try { await api('/api/runtime/scan', {}); await refresh(true); toast('项目扫描完成'); }
  catch (error) { toast(error.message, true); }
  finally { state.scanning = false; $('scanButton').disabled = !state.csrfToken; $('scanButton').classList.remove('spinning'); text($('scanButton').lastElementChild, '重新扫描'); }
}

function openLogs(projectId, serviceId) {
  const project = state.projects.find((p) => p.id === projectId);
  const service = project?.services.find((s) => s.id === serviceId);
  if (!service) return;
  state.log = { projectId, serviceId };
  text($('logTitle'), `${project.name} · ${service.label || service.id}`);
  text($('logSubtitle'), service.cwd || project.path);
  text($('logOutput'), '正在读取服务输出…');
  text($('logStatus'), '正在读取日志');
  $('followLogs').checked = true;
  $('logDialog').showModal();
  loadLogs();
}

async function loadLogs() {
  if (!state.log || !$('logDialog').open) return;
  const target = state.log;
  const request = ++state.logRequest;
  $('refreshLogs').disabled = true;
  try {
    const data = await api(`/api/runtime/logs?${new URLSearchParams(target)}`);
    if (request !== state.logRequest || state.log !== target) return;
    const output = $('logOutput');
    const oldScroll = output.scrollTop;
    text(output, data.logs || '暂无日志。通过启动台启动服务后，输出会显示在这里。');
    output.scrollTop = $('followLogs').checked ? output.scrollHeight : oldScroll;
    text($('logStatus'), `更新于 ${formatTime(Date.now())}`);
  } catch (error) { if (request === state.logRequest && state.log === target) text($('logStatus'), error.message); }
  finally { if (request === state.logRequest) $('refreshLogs').disabled = false; }
}

$('searchInput').addEventListener('input', (event) => { state.search = event.target.value; if (state.loaded) render(); });
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; if (state.loaded) render(); }));
$('resetFilters').addEventListener('click', () => { state.filter = 'all'; state.search = ''; $('searchInput').value = ''; render(); $('searchInput').focus(); });
$('scanButton').addEventListener('click', scan);
$('retryButton').addEventListener('click', () => refresh(true));
$('closeLogs').addEventListener('click', () => $('logDialog').close());
$('logDialog').addEventListener('close', () => { state.log = null; state.logRequest++; $('refreshLogs').disabled = false; });
$('logDialog').addEventListener('click', (event) => { if (event.target === $('logDialog') && event.clientX < $('logDialog').getBoundingClientRect().left) $('logDialog').close(); });
$('refreshLogs').addEventListener('click', loadLogs);
$('followLogs').addEventListener('change', () => { if ($('followLogs').checked) $('logOutput').scrollTop = $('logOutput').scrollHeight; });
document.addEventListener('keydown', (event) => { if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !$('logDialog').open) { event.preventDefault(); $('searchInput').focus(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); if (state.log) loadLogs(); } });
refresh();
setInterval(() => { if (!document.hidden) { refresh(); if (state.log) loadLogs(); } }, 4000);
