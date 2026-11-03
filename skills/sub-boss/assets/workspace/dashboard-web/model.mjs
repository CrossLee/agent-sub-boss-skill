import { categoryFor, categoryLabels } from "./categories.mjs";

export { categoryFor, categoryLabels, categoryReason } from "./categories.mjs";

export const evidenceLabels = Object.freeze({
  code: "代码完成",
  build: "构建通过",
  installed: "已安装",
  committed: "已提交",
  deployed: "已部署/上架",
  accepted: "真实验收",
});

export const statusLabels = Object.freeze({
  risk: "有风险",
  decision: "待拍板",
  progress: "推进中",
  waiting: "待验证",
  unknown: "本次未核实",
  completed: "已完结",
  no_tracking: "不再追踪",
  deferred: "已延后",
});

const closedStates = new Set(["completed", "no_tracking", "deferred"]);
const validDay = /^\d{4}-\d{2}-\d{2}$/;
const shanghaiFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});

export function todayShanghai(date = new Date()) {
  const parts = Object.fromEntries(shanghaiFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function taskAction(task, actions) {
  return actions?.items?.[task.id] || { action: "active" };
}

function isExpired(action, today) {
  return action.action === "deferred" && validDay.test(action.deferredUntil || "") && action.deferredUntil <= today;
}

export function effectiveStatus(task, actions, today = todayShanghai()) {
  // A task closed by the source report cannot be resurrected by an older defer record.
  if (task.status === "completed") return "completed";
  const action = taskAction(task, actions);
  if (action.action === "completed" || action.action === "no_tracking") return action.action;
  if (action.action === "deferred" && !isExpired(action, today)) return "deferred";
  return task.status || "unknown";
}

export function isActive(task, actions, today = todayShanghai()) {
  return !closedStates.has(effectiveStatus(task, actions, today));
}

export function needsDecision(task, actions, today = todayShanghai()) {
  return isActive(task, actions, today) && (task.decisionNeeded === true || task.status === "decision");
}

export function counts(dashboard, actions, today = todayShanghai()) {
  const result = { active: 0, decision: 0, risk: 0, waiting: 0, unknown: 0, deferred: 0, completed: 0, no_tracking: 0, expired: 0, projects: 0 };
  const projects = new Set();
  for (const task of dashboard?.tasks || []) {
    const status = effectiveStatus(task, actions, today);
    if (isActive(task, actions, today)) {
      result.active += 1;
      if (task.project) projects.add(task.project);
      if (needsDecision(task, actions, today)) result.decision += 1;
      if (status === "risk" || status === "waiting" || status === "unknown") result[status] += 1;
      if (isExpired(taskAction(task, actions), today)) result.expired += 1;
    } else if (Object.hasOwn(result, status)) {
      result[status] += 1;
    }
  }
  result.projects = projects.size;
  return result;
}

function searchableValues(value) {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  return Object.values(value).map(searchableValues).join(" ");
}

function matchesView(task, actions, view, today) {
  const status = effectiveStatus(task, actions, today);
  if (view === "decision") return needsDecision(task, actions, today);
  if (["risk", "waiting", "unknown"].includes(view)) return isActive(task, actions, today) && status === view;
  if (["deferred", "completed", "no_tracking"].includes(view)) return status === view;
  return isActive(task, actions, today);
}

function attentionRank(task, actions, today) {
  if (effectiveStatus(task, actions, today) === "risk") return 0;
  if (needsDecision(task, actions, today)) return 1;
  return 2;
}

export function filterTasks(dashboard, actions, { view = "active", query = "", sort = "priority", category = "all", project = "all" } = {}, today = todayShanghai()) {
  const search = String(query).trim().toLocaleLowerCase("zh-CN");
  const priority = new Map();
  for (const [index, id] of (dashboard?.priorities || []).entries()) {
    if (!priority.has(id)) priority.set(id, index);
  }
  const tasks = (dashboard?.tasks || []).filter((task) => {
    if (!matchesView(task, actions, view, today)) return false;
    const taskCategory = categoryFor(task);
    if (category !== "all" && taskCategory !== category) return false;
    if (project !== "all" && task.project !== project) return false;
    if (!search) return true;
    const status = effectiveStatus(task, actions, today);
    return `${searchableValues(task)} ${searchableValues(taskAction(task, actions))} ${statusLabels[status] || status} ${categoryLabels[taskCategory]}`
      .toLocaleLowerCase("zh-CN").includes(search);
  });
  return tasks.sort((a, b) => {
    if (sort === "date") {
      const aDate = validDay.test(a.suggestedDate || "") ? a.suggestedDate : "9999-99-99";
      const bDate = validDay.test(b.suggestedDate || "") ? b.suggestedDate : "9999-99-99";
      return aDate.localeCompare(bDate);
    }
    if (sort === "project") return String(a.project || "").localeCompare(String(b.project || ""), "zh-CN", { numeric: true });
    const aPriority = priority.get(a.id) ?? Infinity;
    const bPriority = priority.get(b.id) ?? Infinity;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return attentionRank(a, actions, today) - attentionRank(b, actions, today);
  });
}
