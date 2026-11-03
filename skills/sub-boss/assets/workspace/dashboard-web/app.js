import { evidenceLabels, statusLabels, todayShanghai, effectiveStatus, isActive, needsDecision, counts, filterTasks } from "./model.mjs?v=6";
import { categoryLabels, categoryFor, categoryReason } from "./categories.mjs";
import { animateIn, replayMotion, syncMotion, motionEnabled } from "./motion.js?v=1";

const $ = (selector) => document.querySelector(selector);
const html = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const storage = {
  get(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};
const views = {
  overview: { name: "工作总览", short: "总览", symbol: "◫" },
  active: { name: "全部待办", short: "全部待办", symbol: "▦", description: "按工作类别、项目与关键词，找到每件事的下一步。" },
  conversations: { name: "对话目录", short: "对话目录", symbol: "▤", description: "按主要目的整理本机 Codex 对话；未归档不等于未完成，归档对话仅保留检索。" },
  decision: { name: "需要你拍板", short: "待我拍板", symbol: "◇", description: "汇集所有需要你做选择的事项，包含同时存在风险或等待验证的项目。" },
  risk: { name: "交付风险", short: "交付风险", symbol: "△", description: "优先看清会影响交付的阻塞与依赖。" },
  waiting: { name: "等待验证", short: "等待验证", symbol: "◷", description: "完成真实设备、外部平台或业务场景的最后一程。" },
  deferred: { name: "稍后再看", short: "已延后", symbol: "↗", description: "到期日按上海时间自动回到续办清单。" },
  completed: { name: "已经完结", short: "已完结", symbol: "✓", description: "已经结束的工作，不再进入关注事项与每日提醒。" },
  no_tracking: { name: "停止追踪", short: "不再追踪", symbol: "⊘", description: "保留操作记录，不再主动提醒。" },
  unknown: { name: "本次未核实", short: "未核实", symbol: "?" , description: "当前证据不足，等待下一次检查。"},
};
const themes = [
  { id: "command", name: "苔原指挥台", color: "#111310" },
  { id: "orbit", name: "深海控制室", color: "#0b1420" },
  { id: "paper", name: "纸上工作室", color: "#f4f3ee" },
  { id: "cyberpunk", name: "赛博故障终端", color: "#0a0a0f" },
];
const state = {
  dashboard: null, actions: { items: {} }, view: "overview", query: "", sort: "priority",
  category: "all", project: "all", conversations: null, conversationsError: "", conversationState: "all",
  layout: storage.get("subboss-layout", "list") === "board" ? "board" : "list",
  selected: null, saving: false, loading: false, presentation: false, summaryOpen: false,
  detailMessage: "", detailError: "", returnFocus: null,
};
const page = $("#pageContent");
const detailDialog = $("#detailDialog");
const themeDialog = $("#themeDialog");
const active = (task) => isActive(task, state.actions);
const effective = (task) => effectiveStatus(task, state.actions);
const taskById = (id) => state.dashboard?.tasks.find((task) => task.id === id);
const currentCounts = () => counts(state.dashboard, state.actions);
const label = (task) => statusLabels[effective(task)] || "本次未核实";
const badge = (task) => `<span class="status-label ${html(effective(task))}">${html(label(task))}</span>`;
const categoryBadge = (item) => `<span class="category-badge" data-category="${categoryFor(item)}" title="${html(categoryReason(item))}">${categoryLabels[categoryFor(item)]}</span>`;
const categoryDescriptions = {
  product: "应用、系统、产品与开发交付", research: "资料搜集、比较分析与可行性",
  troubleshooting: "工具使用、知识答疑与故障定位", content: "视频、文案、海报与传播素材",
  education: "课程设计、教学与学习训练", operations: "活动、商务、行政与日常管理",
  uncategorized: "目的尚不明确，保留待确认",
};
const taskFilters = (extra = {}) => ({ view: state.view === "overview" ? "active" : state.view, query: state.query, sort: state.sort, category: state.category, project: state.project, ...extra });
const linkedTask = (item) => state.dashboard?.tasks.find(task => task.sourceThreadId === item.id || task.id === `thread-${item.id}`);
function catalogItems() {
  return (state.conversations?.items || []).map(item => ({ ...item, category: linkedTask(item)?.category || item.category }));
}
function conversationStatus(item) {
  if (item.archived) return "completed";
  const task = linkedTask(item);
  const status = task && effective(task);
  return ["completed", "no_tracking", "deferred"].includes(status) ? status : "open";
}
function conversationExcerpt(item) {
  const text = String(item.summary || "").trim();
  if (/^# Files (?:mentioned|pasted) by the user:/.test(text)) return "此对话以附件开始，可按标题检索；分类不代表附件已重新审阅。";
  if (/^<realtime_delegation>/.test(text)) return "语音对话，暂无可用的文字摘录。";
  return text || "暂无开场摘录，可按对话标题检索。";
}
function filteredConversations({ category = state.category, project = state.project } = {}) {
  const query = state.query.trim().toLocaleLowerCase("zh-CN");
  return catalogItems().filter(item => (state.conversationState === "all" || conversationStatus(item) === state.conversationState)
    && (category === "all" || categoryFor(item) === category)
    && (project === "all" || item.project === project)
    && (!query || [item.title, item.summary, item.project, item.cwd, categoryLabels[categoryFor(item)]].join(" ").toLocaleLowerCase("zh-CN").includes(query)));
}
const priorities = () => (state.dashboard?.priorities || []).map(taskById).filter(Boolean).filter(active).slice(0, 3);
const dateLabel = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : "日期待定";
const reportDate = () => (state.dashboard?.generatedAt || "").slice(0, 10);
const counter = (value) => `<span class="sr-only">${value}</span><span data-count-value="${value}" aria-hidden="true" style="min-width:${String(value).length}ch">${value}</span>`;
function orphanActions(view) {
  const ids = new Set((state.dashboard?.tasks || []).map((task) => task.id));
  return Object.entries(state.actions.items || {}).filter(([id, action]) => !ids.has(id) && action.action === view);
}
function notify(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => $("#toast").classList.remove("show"), 3000);
}
function renderNav() {
  const c = currentCounts();
  $("#navigation").innerHTML = Object.entries(views).filter(([key]) => key !== "unknown" || c.unknown > 0).map(([key, view]) => `
    ${key === "deferred" ? '<div class="nav-separator"></div>' : ""}
    <button class="nav-item" data-view="${key}" aria-label="${view.short}" ${state.view === key ? 'aria-current="page"' : ""} title="${view.short}">
      <span class="nav-symbol" aria-hidden="true">${view.symbol}</span><span class="nav-text">${view.short}</span>
      ${key === "overview" ? "" : `<span class="nav-count">${key === "conversations" ? state.conversations?.items?.length ?? "—" : (c[key] || 0) + orphanActions(key).length}</span>`}
    </button>`).join("");
  $("#breadcrumbTitle").textContent = views[state.view].short;
  $("#syncTime").textContent = `快照 ${state.dashboard.generatedAt?.slice(11, 16) || "未知"}`;
  $("#syncTime").title = `汇总生成于 ${state.dashboard.generatedAt || "本次未核实"}`;
  $("#footerTime").textContent = `数据更新于 ${state.dashboard.generatedAt || "本次未核实"}`;
}
function miniEvidence(task) {
  const entries = Object.entries(evidenceLabels);
  const confirmed = entries.filter(([key]) => task.evidence?.[key] === true).length;
  const description = entries.map(([key, name]) => `${name}：${task.evidence?.[key] === true ? "已确认" : "暂无确认"}`).join("；");
  return `<div class="mini-evidence" role="img" aria-label="${html(description)}" title="${html(description)}">${entries.map(([key]) => `<i class="${task.evidence?.[key] === true ? "yes" : ""}"></i>`).join("")}</div><span class="evidence-quantity">${confirmed ? `已确认 ${confirmed} 项` : "暂无确认"}</span>`;
}
function priorityCard(task, index) {
  return `<article class="priority-card enter">
    <div class="motion-card-effects" aria-hidden="true"><i></i></div>
    <div class="priority-meta">${badge(task)}<span class="rank">优先 ${String(index + 1).padStart(2, "0")}</span></div>
    <p class="priority-project">${categoryBadge(task)} ${html(task.project)}</p><h3 class="priority-title">${html(task.title)}</h3>
    <p class="priority-next">${html(task.next)}</p>
    <div class="priority-footer"><span>建议 ${html(dateLabel(task.suggestedDate))}</span><span class="arrow-link">查看与处理 ↗</span></div>
    <button class="stretched" data-open="${html(task.id)}" aria-label="查看${html(task.project)}：${html(task.title)}"></button>
  </article>`;
}
function renderCategoryOverview() {
  const items = catalogItems();
  const totals = Object.fromEntries(Object.keys(categoryLabels).map(key => [key, 0]));
  for (const item of items) totals[categoryFor(item)] += 1;
  return `<section class="category-overview" aria-labelledby="categoryTitle"><div class="section-heading"><h2 id="categoryTitle">按工作类别查找 <span>对话目录</span></h2><button class="text-button" data-view="conversations">查看对话目录 →</button></div>
    <div class="category-overview-grid">${Object.entries(categoryLabels).map(([key, name]) => `<button class="category-tile" data-category="${key}" data-browse-category="${key}"><span class="category-tile-name">${name} ↗</span><strong>${state.conversations ? totals[key] : "—"}</strong><small>条对话</small><p>${categoryDescriptions[key]}</p></button>`).join("")}</div>
    <p class="classification-note">${state.conversationsError ? html(state.conversationsError) : "本机对话目录，包含已归档；按主要目的自动分类，[PRODUCT] 标签优先。类别与完成状态互不影响。"}</p></section>`;
}
function renderFilterControls() {
  const catalog = state.view === "conversations";
  const items = catalog ? catalogItems() : state.dashboard.tasks;
  const projects = [...new Set(items.map(item => item.project).filter(Boolean))].sort((a,b) => a.localeCompare(b,"zh-CN"));
  return `<div class="category-filter-bar"><div class="category-chips" role="group" aria-label="按分类筛选">${[["all", "全部类别"], ...Object.entries(categoryLabels)].map(([key, name]) => `<button class="category-chip" data-category-filter="${key}" aria-pressed="${key === state.category}">${name} <b data-category-count="${key}">0</b></button>`).join("")}</div>
    <div class="filter-secondary"><label class="filter-label"><span>所属项目</span><select id="projectFilter" class="sort-select" aria-label="按项目筛选"><option value="all">全部项目</option>${projects.map(project => `<option value="${html(project)}" ${project === state.project ? "selected" : ""}>${html(project)}</option>`).join("")}</select></label>
    ${catalog ? '<label class="filter-label"><span>目录状态</span><select id="conversationStateFilter" class="sort-select" aria-label="对话状态筛选"><option value="all">全部状态</option><option value="open">未归档</option><option value="completed">已完结 / 已归档</option><option value="deferred">已延后</option><option value="no_tracking">不再追踪</option></select></label>' : ""}
    <button class="text-button" data-clear-filters>清除筛选</button><span class="classification-note">按主要目的分类 · 与处理状态独立</span></div></div>`;
}
function updateCategoryFilters() {
  const items = state.view === "conversations" ? filteredConversations({ category: "all" }) : filterTasks(state.dashboard, state.actions, taskFilters({ category: "all" }));
  const totals = Object.fromEntries(Object.keys(categoryLabels).map(key => [key, 0]));
  items.forEach(item => totals[categoryFor(item)] += 1);
  document.querySelectorAll("[data-category-filter]").forEach(button => {
    const key = button.dataset.categoryFilter;
    button.setAttribute("aria-pressed", String(key === state.category));
    button.querySelector("b").textContent = key === "all" ? items.length : totals[key];
  });
}
function renderConversations() {
  page.innerHTML = `<div class="page-heading workspace-heading enter"><div><p class="eyebrow">工作分类</p><h1>对话目录</h1><p>${views.conversations.description}</p></div><span class="view-count">${state.conversations?.items.length ?? "—"} 条</span></div>
    <div class="list-toolbar"><label class="search-box"><span aria-hidden="true">⌕</span><input id="searchInput" type="search" placeholder="搜索标题、开场摘录、项目…" aria-label="搜索对话" autocomplete="off" value="${html(state.query)}"><kbd>/</kbd></label><span class="classification-note">按最近更新排序 · 摘录非进展</span></div>
    ${renderFilterControls()}<p class="classification-note">${html(state.conversationsError || state.conversations?.coverage?.description || "仅检索本机 Codex 的用户对话；不包含内部子任务，未连接的云端记录不在本次覆盖内。")}</p><div id="listResults" aria-live="polite"></div>`;
  $("#conversationStateFilter").value = state.conversationState;
  renderConversationResults();
}
function renderConversationResults() {
  const items = filteredConversations();
  updateCategoryFilters();
  $(".view-count").textContent = `${items.length} / ${state.conversations?.items.length || 0} 条`;
  const date = value => {
    if (!value) return "日期未知";
    const instant = new Date(typeof value === "number" ? value * 1000 : value);
    return Number.isNaN(instant.getTime()) ? "日期未知" : todayShanghai(instant);
  };
  $("#listResults").innerHTML = (items.length ? `<div class="conversation-list">${items.map(item => {
    const task = linkedTask(item);
    const status = conversationStatus(item);
    return `<article class="conversation-card"><div class="conversation-heading">${categoryBadge(item)}<span class="conversation-state ${status}">${item.archived ? "已归档 · 已完结" : status === "open" ? "未归档" : statusLabels[status]}</span></div><p class="conversation-project">${html(item.project || "独立对话")}</p><h2 title="${html(item.title)}">${html(item.title || "未命名对话")}</h2><p class="conversation-summary">${html(conversationExcerpt(item))}</p><div class="conversation-footer"><time>更新 ${html(date(item.updatedAt))}</time>${task && !item.archived ? `<button class="text-button" data-open="${html(task.id)}">查看关联事项 ↗</button>` : ""}<span class="conversation-path" title="${html(item.cwd)}">${html(item.cwd)}</span></div></article>`;
  }).join("")}</div>` : state.conversationsError && !state.conversations ? `<div class="empty-state"><h2>对话目录暂不可用</h2><p>${html(state.conversationsError)}。原待办与操作记录不受影响。</p><button data-reload>重新读取</button></div>` : emptyState()) + `<p class="result-count">显示 ${items.length} / ${state.conversations?.items.length || 0} 条本机对话 · 分类仅用于整理，不会自动恢复或归档任务</p>`;
  animateIn($("#listResults"));
}
function renderOverview() {
  const c = currentCounts();
  const tasks = state.dashboard.tasks.filter(active);
  const primaryDecision = tasks.filter((task) => effective(task) === "decision").length;
  const riskAngle = c.active ? c.risk / c.active * 360 : 0;
  const decisionAngle = c.active ? (c.risk + primaryDecision) / c.active * 360 : 0;
  const other = c.active - c.risk - primaryDecision;
  const spotlight = priorities();
  const focus = filterTasks(state.dashboard, state.actions, { view: "active" }).filter((task) => !spotlight.some((item) => item.id === task.id)).slice(0, 4);
  const lead = state.dashboard.summary300?.split(/[。！]/)[0]?.replace(/^总体判断[：:]\s*/, "") || "查看续办事项，明确下一步安排";
  page.innerHTML = `
    <div class="page-heading enter"><div><p class="eyebrow">你的项目、产品与每一段对话</p><h1>工作总览</h1></div><span class="date-stamp">${html(reportDate())} · 汇总快照</span></div>
    <section class="overview-hero enter" aria-labelledby="heroHeading">
      <div class="hero-copy"><p class="eyebrow">当前判断</p><h2 class="hero-heading" id="heroHeading">${c.active ? html(state.dashboard.overallStatus || "待检查") : state.dashboard.tasks.length ? "当前事项已处理" : html(state.dashboard.overallStatus || "等待首次盘点")}<span class="heading-dot">。</span></h2>
      <p class="hero-description">${c.active ? html(lead) : "你已处理当前追踪事项。下一次汇总会带来新的检查结果。"}。</p>
      <button class="hero-summary-toggle" data-toggle-summary aria-expanded="${state.summaryOpen}" aria-controls="summaryExpanded">${state.summaryOpen ? "收起" : "阅读"}完整日报 <span aria-hidden="true">${state.summaryOpen ? "−" : "↗"}</span></button>
      <div class="hero-stats"><button class="stat-button" data-view="decision"><span class="stat-number">${counter(c.decision)}<small>项</small></span><span class="stat-label">等你拍板 ↗</span></button><button class="stat-button risk" data-view="risk"><span class="stat-number">${counter(c.risk)}<small>项</small></span><span class="stat-label">交付有风险 ↗</span></button><button class="stat-button" data-view="deferred"><span class="stat-number">${counter(c.deferred)}<small>项</small></span><span class="stat-label">延后再跟进 ↗</span></button></div></div>
      <div class="orbit-viz" aria-label="续办事项按主状态分类，风险${c.risk}项，待拍板${primaryDecision}项，其他${other}项"><span class="orbit-caption">主状态分布</span><div class="status-orbit" style="--risk-angle:${riskAngle}deg;--decision-angle:${decisionAngle}deg${c.active ? "" : ";background:var(--track)"}"><span class="chart-cover" aria-hidden="true"></span><span class="orbit-effects" aria-hidden="true"><i class="orbit-track"></i><i class="orbit-track secondary"></i><i class="orbit-comet"></i><i class="orbit-comet secondary"></i></span><div class="orbit-center"><strong>${counter(c.active)}</strong><span>正在续办的事项</span></div></div><div class="orbit-legend"><span><i class="legend-dot risk"></i>风险 ${c.risk}</span><span><i class="legend-dot"></i>拍板 ${primaryDecision}</span><span><i class="legend-dot waiting"></i>其他 ${other}</span></div></div>
      <div class="summary-expanded" id="summaryExpanded" ${state.summaryOpen ? "" : "hidden"}><p>${html(state.dashboard.summary300)}</p><small>原始日报快照 · ${html(state.dashboard.generatedAt)} · 操作后的即时状态以清单为准。</small></div>
    </section>
    ${renderCategoryOverview()}
    <section aria-labelledby="priorityTitle"><div class="section-heading"><h2 id="priorityTitle">最值得推进的 ${spotlight.length} 件事 <span>聚焦下一步</span></h2><button class="text-button" data-view="active">查看全部 ${c.active} 项 →</button></div>
    <div class="priority-grid">${spotlight.map(priorityCard).join("") || (c.active ? '<p class="board-empty">尚未安排优先事项，请先核实项目进展。</p>' : '<p class="board-empty">当前优先事项均已处理。</p>')}</div></section>
    <div class="overview-bottom"><section><div class="section-heading"><h2>接下来，别遗漏 <span>其余需关注事项</span></h2><button class="text-button" data-view="active">全部待办 →</button></div>
      <div class="attention-list">${focus.map((task) => `<button class="attention-row" data-open="${html(task.id)}"><span class="attention-marker ${html(effective(task))}"></span><div><strong>${html(task.project)}</strong><p>${html(task.title)}</p></div><span>${html(dateLabel(task.suggestedDate))} ↗</span></button>`).join("") || '<p class="board-empty">没有其他待跟进事项。</p>'}</div>
      ${c.expired ? `<div class="expired-note"><span>${c.expired} 项延后已到期，已回到续办清单</span><button data-view="active">去查看 →</button></div>` : ""}
    </section><section><div class="section-heading"><h2>交付证据 <span>独立统计</span></h2></div>
      <div class="evidence-overview">${Object.entries(evidenceLabels).map(([key, title]) => {
        const number = tasks.filter((task) => task.evidence?.[key] === true).length;
        return `<div class="evidence-meter"><span>${title}</span><div class="meter-track"><span style="width:${c.active ? number / c.active * 100 : 0}%"></span></div><b>${counter(number)}</b></div>`;
      }).join("")}<p><strong>已确认的事项数，非完成率。</strong><br>代码、构建、安装、提交、部署和真实验收分别核对，暂无确认不等于失败。</p></div>
    </section></div>`;
}
function emptyState() {
  const messages = {
    deferred: ["没有仍在延后的事项", "到期的任务已经恢复追踪，可以在“全部待办”里查看。"],
    completed: ["当前快照没有已完结事项", "已从日报移出的操作记录会保留在下方历史记录中。"],
    no_tracking: ["当前快照没有停止追踪的事项", "历史记录如有保留，会显示在下方。"],
    decision: ["暂时没有需要你拍板的事项", "可以继续处理其他续办工作。"],
    risk: ["当前没有标记风险的事项", "这表示当前清单没有风险标记，不代表所有项目已经验收。"],
  };
  const filtered = state.query || state.category !== "all" || state.project !== "all" || state.view === "conversations";
  const [title, description] = filtered ? ["没有找到匹配内容", "可以更换类别、项目或关键词，也可以清除筛选。"] : messages[state.view] || ["这里暂时没有事项", "等待下一次汇总，或切换到其他工作视图。"];
  return `<div class="empty-state"><div class="empty-symbol" aria-hidden="true">◇</div><h2>${title}</h2><p>${description}</p>${filtered ? '<button data-clear-filters>清除全部筛选 →</button>' : '<button data-view="active">查看全部待办 →</button>'}</div>`;
}
function tableRow(task) {
  const priorityIndex = (state.dashboard.priorities || []).indexOf(task.id);
  const action = state.actions.items?.[task.id];
  const date = effective(task) === "deferred" ? action?.deferredUntil : task.suggestedDate;
  return `<tr data-open="${html(task.id)}"><td><div class="task-project">${categoryBadge(task)} ${html(task.project)}${priorityIndex >= 0 && active(task) ? `<span class="priority-pin">优先 ${priorityIndex + 1}</span>` : ""}</div><button class="task-title-button" data-open="${html(task.id)}">${html(task.title)}</button><p class="task-preview">${html(task.next)}</p></td>
  <td>${badge(task)}<p class="task-stage">${html(task.stage)}</p>${needsDecision(task, state.actions) && effective(task) !== "decision" ? '<span class="decision-dot">◇ 同时需拍板</span>' : ""}</td>
  <td class="task-owner">${html(task.owner)}</td><td><time class="task-date">${html(dateLabel(date))}</time><p class="date-caption">${effective(task) === "deferred" ? "恢复追踪" : "建议安排"}</p></td><td>${miniEvidence(task)}</td></tr>`;
}
function renderBoard(tasks) {
  const closed = ["deferred", "completed", "no_tracking"].includes(state.view);
  const groups = closed ? [{ name: views[state.view].name, tasks }] : [
    { name: "风险优先", tasks: tasks.filter((task) => effective(task) === "risk") },
    { name: "需要拍板", tasks: tasks.filter((task) => effective(task) !== "risk" && needsDecision(task, state.actions)) },
    { name: "继续推进", tasks: tasks.filter((task) => effective(task) !== "risk" && !needsDecision(task, state.actions)) },
  ];
  return `<div class="board" ${closed ? 'style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))"' : ""}>${groups.map((group) => `<section class="board-column"><h2 class="board-heading">${group.name}<b>${group.tasks.length}</b></h2>${group.tasks.map((task) => `<button class="board-card" data-open="${html(task.id)}"><span class="task-project">${categoryBadge(task)} ${html(task.project)}</span><h3>${html(task.title)}</h3><p>${html(task.next)}</p><div class="board-card-footer">${badge(task)}<time>${effective(task) === "deferred" ? "恢复 " : ""}${html(dateLabel(effective(task) === "deferred" ? state.actions.items?.[task.id]?.deferredUntil : task.suggestedDate))}</time></div></button>`).join("") || '<p class="board-empty">暂无事项</p>'}</section>`).join("")}</div>`;
}
function historicalRecords() {
  if (state.category !== "all" || state.project !== "all") return "";
  const entries = orphanActions(state.view).filter(([id]) => !state.query || id.toLowerCase().includes(state.query.toLowerCase()));
  if (!entries.length) return "";
  return `<details class="historical-records" open><summary>${entries.length} 条历史操作记录</summary><p>这些事项已不在当前日报中，保留你的处理结果。原任务内容未随本次快照提供，无法在此恢复；本条记录不会重新进入续办。</p>${entries.map(([id, action]) => `<div class="historical-record"><span>${html(id)} · ${html(statusLabels[action.action])}</span><time>${html(todayShanghai(new Date(action.updatedAt)))}</time></div>`).join("")}</details>`;
}
function renderListResults() {
  if (state.view === "conversations") return renderConversationResults();
  const tasks = filterTasks(state.dashboard, state.actions, taskFilters());
  updateCategoryFilters();
  $(".view-count").textContent = `${tasks.length} / ${currentCounts()[state.view] || 0} 项`;
  $("#listResults").innerHTML = (tasks.length ? state.layout === "board" ? renderBoard(tasks) : `<table class="task-table"><caption class="sr-only">${views[state.view].name}，点击事项查看完整内容与操作</caption><thead><tr><th scope="col">项目 / 当前事项</th><th scope="col">状态与阶段</th><th scope="col">谁来推进</th><th scope="col">建议日期</th><th scope="col">独立证据</th></tr></thead><tbody>${tasks.map(tableRow).join("")}</tbody></table>` : emptyState()) + historicalRecords() + `<p class="result-count">显示 ${tasks.length} 项 · 内容来自 ${html(state.dashboard.generatedAt)} · 点击事项查看完整资料</p>`;
  document.querySelectorAll("[data-layout]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.layout === state.layout)));
  animateIn($("#listResults"));
}
function renderWorkspace() {
  const view = views[state.view];
  const count = currentCounts()[state.view] || 0;
  page.innerHTML = `<div class="page-heading workspace-heading enter"><div><p class="eyebrow">工作清单</p><h1>${view.name}</h1><p>${view.description}</p></div><span class="view-count">${count} 项${orphanActions(state.view).length ? ` · ${orphanActions(state.view).length} 历史记录` : ""}</span></div>
    <div class="list-toolbar"><label class="search-box"><span aria-hidden="true">⌕</span><input id="searchInput" type="search" placeholder="搜索项目、负责人、下一步…" aria-label="搜索事项" autocomplete="off" value="${html(state.query)}"><kbd>/</kbd></label>
    <div class="list-tools"><select id="sortSelect" class="sort-select" aria-label="排序方式"><option value="priority">按关注优先级</option><option value="date">按建议日期</option><option value="project">按项目名称</option></select><div class="segmented" aria-label="清单显示方式"><button data-layout="list" aria-pressed="${state.layout === "list"}">列表</button><button data-layout="board" aria-pressed="${state.layout === "board"}">看板</button></div></div></div>${renderFilterControls()}<div id="listResults" aria-live="polite"></div>`;
  $("#sortSelect").value = state.sort;
  renderListResults();
}
function render() {
  if (!state.dashboard) return;
  renderNav();
  state.view === "overview" ? renderOverview() : state.view === "conversations" ? renderConversations() : renderWorkspace();
  animateIn(page);
}
function setView(view) {
  if (!views[view]) return;
  state.view = view;
  state.query = "";
  const items = view === "conversations" ? catalogItems() : state.dashboard?.tasks || [];
  if (state.project !== "all" && !items.some(item => item.project === state.project)) state.project = "all";
  closeNavigation();
  render();
  if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  window.scrollTo({ top: 0, behavior: "instant" });
}
function renderDetail() {
  const task = taskById(state.selected);
  if (!task) return;
  const action = state.actions.items?.[task.id] || {};
  const status = effective(task);
  const activeTask = active(task);
  const notice = status === "completed" ? "已完结。这项工作不再出现在续办、风险和优先事项中。" : status === "no_tracking" ? "已停止追踪。后续每日总结不会主动提醒。" : status === "deferred" ? `延后至 ${action.deferredUntil || "待确认日期"}，到期自动恢复续办。` : action.action === "deferred" ? `此前延后至 ${action.deferredUntil}，现已到期并恢复追踪。` : "";
  const all = state.view === "conversations" ? filteredConversations().filter(item => !item.archived).map(linkedTask).filter(Boolean) : filterTasks(state.dashboard, state.actions, taskFilters(state.view === "overview" ? { category: "all", project: "all", query: "" } : {}));
  const index = all.findIndex((item) => item.id === task.id);
  const sourceThreadId = task.sourceThreadId || (task.id.startsWith("thread-") ? task.id.slice(7) : "");
  const codexProjectUrl = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceThreadId)
    ? `codex://threads/${sourceThreadId}` : null;
  $("#detailContent").innerHTML = `
    <div class="detail-top"><p>${badge(task)}<span>事项详情</span></p><div><button class="icon-button" data-detail-prev aria-label="上一项" ${index <= 0 ? "disabled" : ""}>‹</button><button class="icon-button" data-detail-next aria-label="下一项" ${index < 0 || index >= all.length - 1 ? "disabled" : ""}>›</button><button class="icon-button" data-close-detail aria-label="关闭事项详情">×</button></div></div>
    <div class="detail-scroll">${notice ? `<p class="state-notice">${html(notice)}</p>` : ""}<p class="detail-project">${categoryBadge(task)} ${html(task.project)}</p><h2 class="detail-title" id="detailTitle">${html(task.title)}</h2><p class="detail-stage">${html(task.stage)}</p>
    <dl class="detail-facts"><div><dt>谁来推进</dt><dd>${html(task.owner)}</dd></div><div><dt>建议日期</dt><dd>${html(dateLabel(task.suggestedDate))}</dd></div><div><dt>需要拍板</dt><dd>${activeTask ? task.decisionNeeded || task.status === "decision" ? "是，等你决定" : "暂无决策项" : "当前不续办"}</dd></div></dl>
    <section class="detail-section"><h3>做到哪一步</h3><p>${html(task.progress || "本次未核实")}</p></section>
    <section class="detail-section"><h3>${activeTask ? "还剩什么 / 风险" : "关闭前记录 · 剩余事项"}</h3><p>${html(task.remaining || "本次未核实")}</p></section>
    <section class="detail-section next-step"><h3>${activeTask ? "建议下一步" : "关闭前记录 · 原建议"}</h3><p>${html(task.next || "待安排")}</p></section>
    <section class="detail-section"><h3>六类独立证据</h3><div class="evidence-grid">${Object.entries(evidenceLabels).map(([key, name]) => `<div class="evidence-cell ${task.evidence?.[key] === true ? "yes" : ""}"><strong>${name}</strong><span>${task.evidence?.[key] === true ? "✓ 已确认" : "— 暂无确认"}</span></div>`).join("")}</div><p class="evidence-note">这些证据彼此独立，并非开发进度条。暂无确认不表示失败，非软件事项也不必满足全部六类。</p></section>
    </div>
    <div class="detail-action-bar">${state.detailError ? `<p class="detail-inline-error" role="alert">${html(state.detailError)}</p>` : ""}<p class="action-explanation" role="status">${html(state.detailMessage || (activeTask ? "你的选择会保存到本地，并影响之后的每日汇总。" : "这里保留原始内容，处理状态由你的操作记录决定。"))}</p><div class="actions">
    ${activeTask ? '<button class="action-button primary" data-action="completed">✓ 任务已结束</button><button class="action-button" data-action="deferred">延后 3 天</button><button class="action-button" data-action="no_tracking">无需追踪</button>' : task.status === "completed" ? '<span class="action-explanation">来源任务已完结；重新打开原对话后可重新汇总。</span>' : '<button class="action-button primary" data-action="active">恢复追踪</button>'}
    ${codexProjectUrl ? `<a class="action-button codex-project-link" href="${html(codexProjectUrl)}" title="打开这条事项对应的 Codex 原对话">打开 Codex 项目 <span aria-hidden="true">↗</span></a>` : '<button class="action-button codex-project-link" disabled title="此事项尚未关联 Codex 原对话">打开 Codex 项目</button>'}
    </div></div>`;
  detailDialog.querySelectorAll("[data-action]").forEach((button) => button.disabled = state.saving || state.loading);
  animateIn($("#detailContent"));
}
function openDetail(id) {
  if (!taskById(id)) return;
  state.selected = id;
  state.detailError = "";
  state.detailMessage = "";
  if (!detailDialog.open) state.returnFocus = document.activeElement;
  renderDetail();
  if (!detailDialog.open) detailDialog.showModal();
  detailDialog.querySelector("[data-close-detail]")?.focus();
}
async function saveAction(action) {
  if (state.saving || state.loading || !state.selected) return;
  const taskId = state.selected;
  state.saving = true;
  $("#refreshButton").disabled = true;
  state.detailError = "";
  state.detailMessage = "正在保存…";
  renderDetail();
  try {
    const response = await fetch("/api/actions", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Subboss-Action": "1" }, body: JSON.stringify({ taskId, action }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.actions) throw new Error(payload.error || "操作未保存，请重试。");
    state.actions = payload.actions;
    const message = action === "completed" ? "已标记完结，后续不再提醒。" : action === "no_tracking" ? "已停止追踪。" : action === "deferred" ? `已延后至 ${payload.actions.items?.[taskId]?.deferredUntil}。` : "已恢复追踪。";
    if (state.selected === taskId) state.detailMessage = message;
    render();
    notify(message);
  } catch (error) {
    if (state.selected === taskId) {
      state.detailError = error.message || "操作未保存，请重试。";
      state.detailMessage = "原处理状态已保留。";
    } else notify(`${taskById(taskId)?.project || "事项"}：操作没有保存，请重试。`);
  } finally {
    state.saving = false;
    $("#refreshButton").disabled = false;
    renderDetail();
  }
}
async function load({ announce = false } = {}) {
  if (state.loading || state.saving) return;
  state.loading = true;
  $("#refreshButton").disabled = true;
  document.body.classList.add("is-loading");
  if (detailDialog.open) renderDetail();
  $("#connectionLabel").textContent = "正在读取";
  try {
    const response = await fetch(`/api/dashboard?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`读取失败（${response.status}）`);
    const payload = await response.json();
    if (!Array.isArray(payload.dashboard?.tasks)) throw new Error("看板数据格式不完整");
    state.dashboard = payload.dashboard;
    state.actions = payload.actions || { items: {} };
    try {
      const response = await fetch(`/api/conversations?t=${Date.now()}`, { cache: "no-store" });
      const catalog = await response.json();
      if (!response.ok || !Array.isArray(catalog.items)) throw new Error(catalog.error || "目录返回异常");
      state.conversations = catalog;
      state.conversationsError = "";
      const conversationsById = new Map(catalog.items.map(item => [item.id, item]));
      // View-only reconciliation: a verified archive never reappears as a duty,
      // even when the daily snapshot predates it. Source files stay untouched.
      state.dashboard = { ...state.dashboard, tasks: state.dashboard.tasks.map(task => {
        const item = conversationsById.get(task.sourceThreadId || task.id.replace(/^thread-/, ""));
        return item ? { ...task, sourceTitle: item.title, ...(item.archived ? { status: "completed" } : {}) } : task;
      }) };
    } catch (error) {
      state.conversationsError = `${error.message || "本机对话目录本次未核实"}${state.conversations ? "，仍展示上次成功读取的目录" : ""}`;
    }
    render();
    if (detailDialog.open) {
      if (taskById(state.selected)) renderDetail();
      else detailDialog.close();
    }
    $("#loadError").hidden = true;
    document.body.classList.remove("connection-failed");
    $("#connectionLabel").textContent = "本地已连接";
    if (announce) notify("已读取最新看板快照");
  } catch (error) {
    $("#loadError").hidden = false;
    $("#loadError").textContent = `${error.message}。请确认本地服务可用。${state.dashboard ? "当前仍展示上次成功读取的内容。" : "点击刷新可以重试。"}`;
    if (!state.dashboard) page.innerHTML = '<div class="empty-state"><div class="empty-symbol">↻</div><h2>暂时无法读取工作空间</h2><p>已保留你的本地数据，请恢复服务后刷新。</p></div>';
    $("#connectionLabel").textContent = "连接中断";
    document.body.classList.add("connection-failed");
    if (announce) notify("刷新失败，未替换现有内容");
  } finally {
    state.loading = false;
    if (detailDialog.open) renderDetail();
    $("#refreshButton").disabled = false;
    document.body.classList.remove("is-loading");
  }
}
function renderTheme() {
  const current = themes.find((theme) => theme.id === document.documentElement.dataset.theme) || themes[0];
  document.documentElement.dataset.theme = current.id;
  document.querySelector('meta[name="theme-color"]').content = current.color;
  $("#themeButton").title = `当前主题：${current.name}`;
  $("#themeOptions").innerHTML = themes.map((theme) => `<button class="theme-option" data-theme-choice="${theme.id}" aria-pressed="${theme.id === current.id}"><span class="theme-preview" aria-hidden="true"><span class="preview-side"></span><span class="preview-main"><i></i><i></i><i></i></span></span><strong>${theme.name}</strong></button>`).join("");
  $("#motionButton").setAttribute("aria-checked", String(!document.documentElement.classList.contains("motion-paused")));
  updateMotionControls();
}
function updateMotionControls() {
  const enabled = motionEnabled();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  $("#quickMotionButton").setAttribute("aria-pressed", String(!enabled));
  $("#quickMotionButton").setAttribute("aria-label", reduced ? "系统已减弱动态效果" : enabled ? "暂停全部动效" : "开启全部动效");
  $("#quickMotionButton").title = reduced ? "系统已开启减弱动态效果" : enabled ? "暂停全部动效" : "开启全部动效";
  $("#quickMotionButton .quick-motion-label").textContent = enabled ? "暂停" : "开启动效";
  $("#quickMotionButton .quick-motion-icon").textContent = enabled ? "Ⅱ" : "▷";
  $("#motionReplayButton").disabled = !enabled;
}
function toggleMotion() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    notify("系统已开启减弱动态效果，页面保持静止。");
    return;
  }
  const paused = !document.documentElement.classList.contains("motion-paused");
  document.documentElement.classList.toggle("motion-paused", paused);
  storage.set("subboss-motion", paused ? "paused" : "on");
  syncMotion();
  renderTheme();
  if (!paused) replayMotion();
}
function closeNavigation() {
  document.body.classList.remove("nav-open");
  $("#menuButton").setAttribute("aria-expanded", "false");
  $("#sidebarScrim").hidden = true;
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button?.dataset.browseCategory) {
    state.category = button.dataset.browseCategory;
    state.project = "all";
    state.conversationState = "all";
    return setView("conversations");
  }
  if (button?.dataset.categoryFilter) {
    state.category = button.dataset.categoryFilter;
    return renderListResults();
  }
  if (button?.hasAttribute("data-clear-filters")) {
    state.query = "";
    state.category = "all";
    state.project = "all";
    state.conversationState = "all";
    state.view === "conversations" ? renderConversations() : renderWorkspace();
    return $("#searchInput")?.focus();
  }
  if (button?.hasAttribute("data-reload")) return load({ announce: true });
  if (button?.dataset.view) return setView(button.dataset.view);
  const opener = event.target.closest("[data-open]");
  if (opener) return openDetail(opener.dataset.open);
  if (button?.hasAttribute("data-toggle-summary")) {
    state.summaryOpen = !state.summaryOpen;
    $("#summaryExpanded").hidden = !state.summaryOpen;
    button.setAttribute("aria-expanded", String(state.summaryOpen));
    button.innerHTML = `${state.summaryOpen ? "收起" : "阅读"}完整日报 <span aria-hidden="true">${state.summaryOpen ? "−" : "↗"}</span>`;
  }
  if (button?.dataset.layout) {
    state.layout = button.dataset.layout;
    storage.set("subboss-layout", state.layout);
    renderListResults();
  }
  if (button?.hasAttribute("data-clear-search")) {
    state.query = "";
    $("#searchInput").value = "";
    renderListResults();
    $("#searchInput").focus();
  }
  if (button?.hasAttribute("data-close-detail")) detailDialog.close();
  if (button?.hasAttribute("data-close-theme")) themeDialog.close();
  if (button?.dataset.action) saveAction(button.dataset.action);
  if (button?.dataset.themeChoice) {
    document.documentElement.dataset.theme = button.dataset.themeChoice;
    storage.set("subboss-theme", button.dataset.themeChoice);
    renderTheme();
    themeDialog.querySelector(`[data-theme-choice="${button.dataset.themeChoice}"]`).focus();
  }
  if (button?.hasAttribute("data-detail-prev") || button?.hasAttribute("data-detail-next")) {
    const tasks = state.view === "conversations" ? filteredConversations().filter(item => !item.archived).map(linkedTask).filter(Boolean) : filterTasks(state.dashboard, state.actions, taskFilters(state.view === "overview" ? { category: "all", project: "all", query: "" } : {}));
    const index = tasks.findIndex((task) => task.id === state.selected);
    const next = tasks[index + (button.hasAttribute("data-detail-prev") ? -1 : 1)];
    if (next) openDetail(next.id);
  }
});
page.addEventListener("input", (event) => {
  if (event.target.id === "searchInput") { state.query = event.target.value; renderListResults(); }
});
page.addEventListener("change", (event) => {
  if (event.target.id === "sortSelect") { state.sort = event.target.value; renderListResults(); }
  if (event.target.id === "projectFilter") { state.project = event.target.value; renderListResults(); }
  if (event.target.id === "conversationStateFilter") { state.conversationState = event.target.value; renderListResults(); }
});
$("#refreshButton").addEventListener("click", () => load({ announce: true }));
$("#themeButton").addEventListener("click", () => { renderTheme(); themeDialog.showModal(); animateIn(themeDialog); });
$("#motionButton").addEventListener("click", toggleMotion);
$("#quickMotionButton").addEventListener("click", toggleMotion);
$("#motionReplayButton").addEventListener("click", () => replayMotion());
document.addEventListener("motionpreferencechange", updateMotionControls);
$("#presentationButton").addEventListener("click", () => {
  state.presentation = !state.presentation;
  document.body.classList.toggle("presentation", state.presentation);
  $("#presentationButton").setAttribute("aria-pressed", String(state.presentation));
  $("#presentationButton .presentation-label").textContent = state.presentation ? "退出演示" : "演示";
  if (state.presentation) setView("overview");
  notify(state.presentation ? "演示视图已开启，聚焦总览与优先事项" : "已返回完整工作台");
});
$("#menuButton").addEventListener("click", () => {
  const open = !document.body.classList.contains("nav-open");
  document.body.classList.toggle("nav-open", open);
  $("#menuButton").setAttribute("aria-expanded", String(open));
  $("#sidebarScrim").hidden = !open;
});
$("#sidebarScrim").addEventListener("click", closeNavigation);
document.querySelector(".brand").addEventListener("click", (event) => { event.preventDefault(); setView("overview"); });
for (const dialog of [detailDialog, themeDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
}
detailDialog.addEventListener("close", () => {
  if (state.returnFocus?.isConnected) state.returnFocus.focus({ preventScroll: true });
  else $("#mainContent").focus({ preventScroll: true });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeNavigation();
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !detailDialog.open && !themeDialog.open && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    if (state.view === "overview") setView("active");
    $("#searchInput")?.focus();
  }
});
window.addEventListener("hashchange", () => {
  const view = location.hash.slice(1);
  if (views[view]) setView(view);
});
state.view = views[location.hash.slice(1)] ? location.hash.slice(1) : "overview";
renderTheme();
load();
