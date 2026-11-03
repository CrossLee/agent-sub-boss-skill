import test from "node:test";
import assert from "node:assert/strict";
import { evidenceLabels, statusLabels, todayShanghai, effectiveStatus, isActive, needsDecision, counts, filterTasks } from "./model.mjs";

const day = "2026-10-16";
const task = (id, status = "waiting", extra = {}) => ({ id, project: id, title: id, status, ...extra });
const actionsFor = (items) => ({ version: 1, items });

test("Shanghai calendar day changes at 16:00 UTC, including year boundary", () => {
  assert.equal(todayShanghai(new Date("2026-10-15T15:59:59Z")), "2026-10-15");
  assert.equal(todayShanghai(new Date("2026-10-15T16:00:00Z")), "2026-10-16");
  assert.equal(todayShanghai(new Date("2026-12-31T16:00:00Z")), "2027-01-01");
});

test("completed and no-tracking overrides remove risk and decision duties", () => {
  const source = task("a", "risk", { decisionNeeded: true });
  for (const action of ["completed", "no_tracking"]) {
    const actions = actionsFor({ a: { action } });
    assert.equal(effectiveStatus(source, actions, day), action);
    assert.equal(isActive(source, actions, day), false);
    assert.equal(needsDecision(source, actions, day), false);
  }
  assert.equal(effectiveStatus(source, actionsFor({}), day), "risk");
});

test("defer resumes on its due day and retains the source status without writing", () => {
  const source = task("a", "risk", { decisionNeeded: true });
  const actions = actionsFor({ a: { action: "deferred", deferredUntil: day } });
  const before = JSON.stringify(actions);
  assert.equal(effectiveStatus(source, actions, "2026-10-15"), "deferred");
  assert.equal(isActive(source, actions, "2026-10-15"), false);
  assert.equal(effectiveStatus(source, actions, day), "risk");
  assert.equal(isActive(source, actions, day), true);
  assert.equal(needsDecision(source, actions, day), true);
  assert.equal(JSON.stringify(actions), before);
});

test("missing defer date stays deferred; completed source stays closed despite old defer", () => {
  assert.equal(effectiveStatus(task("a"), actionsFor({ a: { action: "deferred" } }), day), "deferred");
  const closed = task("a", "completed", { decisionNeeded: true });
  assert.equal(isActive(closed, actionsFor({}), day), false);
  assert.equal(effectiveStatus(closed, actionsFor({ a: { action: "deferred", deferredUntil: "2026-10-17" } }), day), "completed");
  assert.equal(needsDecision(closed, actionsFor({}), day), false);
});

test("decision metric includes flagged risk and waiting tasks, ignores orphan actions", () => {
  const dashboard = { tasks: [
    task("risk", "risk", { project: "P", decisionNeeded: true }),
    task("decision", "decision", { project: "P" }),
    task("wait", "waiting"), task("unknown", "unknown"), task("closed", "completed"),
    task("paused", "risk", { decisionNeeded: true }), task("ignored", "decision"),
  ] };
  const actions = actionsFor({
    risk: { action: "deferred", deferredUntil: day },
    paused: { action: "deferred", deferredUntil: "2026-10-17" },
    ignored: { action: "no_tracking" },
    orphan: { action: "completed" },
  });
  assert.deepEqual(counts(dashboard, actions, day), {
    active: 4, decision: 2, risk: 1, waiting: 1, unknown: 1,
    deferred: 1, completed: 1, no_tracking: 1, expired: 1, projects: 3,
  });
  assert.deepEqual(filterTasks(dashboard, actions, { view: "decision" }, day).map(t => t.id), ["risk", "decision"]);
  for (const [view, ids] of Object.entries({ risk: ["risk"], waiting: ["wait"], unknown: ["unknown"], deferred: ["paused"], completed: ["closed"], no_tracking: ["ignored"] })) {
    assert.deepEqual(filterTasks(dashboard, actions, { view }, day).map(t => t.id), ids);
  }
});

test("priority sort honors explicit ranking before risk, decision, and stable remaining order", () => {
  const dashboard = { priorities: ["p2", "p1", "missing"], tasks: [
    task("ordinary"), task("decision", "decision"), task("p1"), task("risk", "risk"), task("p2"), task("last"),
  ] };
  assert.deepEqual(filterTasks(dashboard, {}, {}, day).map(t => t.id), ["p2", "p1", "risk", "decision", "ordinary", "last"]);
});

test("date and project sorts are stable and search covers detail and owner fields", () => {
  const dashboard = { tasks: [
    task("a", "waiting", { project: "Project 10", suggestedDate: "2026-10-18", owner: "老板", next: "检查 CALLBACK" }),
    task("b", "risk", { project: "Project 2", suggestedDate: "2026-10-16", remaining: "原申请待核验" }),
    task("c", "waiting", { project: "Project 2", stage: "渠道联调" }),
  ] };
  assert.deepEqual(filterTasks(dashboard, {}, { sort: "date" }, day).map(t => t.id), ["b", "a", "c"]);
  assert.deepEqual(filterTasks(dashboard, {}, { sort: "project" }, day).map(t => t.id), ["b", "c", "a"]);
  for (const [query, ids] of [["callback", ["a"]], ["老板", ["a"]], ["原申请", ["b"]], ["渠道", ["c"]], ["有风险", ["b"]]]) {
    assert.deepEqual(filterTasks(dashboard, {}, { query }, day).map(t => t.id), ids);
  }
});

test("six independent evidence labels and immutable source content are preserved", () => {
  assert.deepEqual(Object.keys(evidenceLabels), ["code", "build", "installed", "committed", "deployed", "accepted"]);
  assert.equal(statusLabels.unknown, "本次未核实");
  const source = task("immutable", "risk", { evidence: { code: true, build: true, installed: false, committed: false, deployed: false, accepted: false } });
  const dashboard = { priorities: ["immutable"], tasks: [source] };
  const actions = actionsFor({ immutable: { action: "deferred", deferredUntil: day } });
  const before = JSON.stringify({ dashboard, actions });
  Object.freeze(source.evidence);
  Object.freeze(source);
  Object.freeze(dashboard.tasks);
  Object.freeze(dashboard);
  const result = filterTasks(dashboard, actions, {}, day);
  counts(dashboard, actions, day);
  assert.notEqual(result, dashboard.tasks);
  assert.equal(result[0], source);
  assert.equal(JSON.stringify({ dashboard, actions }), before);
});

test("fixture report keeps task content and excludes orphan action records", () => {
  const dashboard = { priorities: ["open"], tasks: [task("open", "risk", { decisionNeeded: true }), task("closed", "progress")] };
  const actions = actionsFor({ closed: { action: "completed" }, orphan: { action: "completed" } });
  const before = JSON.stringify({ dashboard, actions });
  const active = filterTasks(dashboard, actions, {}, day);
  assert.equal(active.every(t => dashboard.tasks.includes(t)), true);
  const c = counts(dashboard, actions, day);
  assert.equal(c.active, active.length);
  assert.equal(c.decision, active.filter(t => t.decisionNeeded === true || t.status === "decision").length);
  assert.equal(c.completed, dashboard.tasks.filter(t => effectiveStatus(t, actions, day) === "completed").length);
  assert.equal(JSON.stringify({ dashboard, actions }), before);
});

test("category, exact project, query and status filters compose without restoring closed tasks", () => {
  const dashboard = { priorities: ["elsewhere", "risk"], tasks: [
    task("risk", "risk", { project: "Alpha", title: "调研错误", sourceTitle: "[PRODUCT] Alpha", next: "核对回调" }),
    task("research", "risk", { project: "Alpha", title: "调研错误", next: "核对回调" }),
    task("waiting", "waiting", { project: "Alpha", title: "开发接口", next: "核对回调" }),
    task("elsewhere", "risk", { project: "Alpha 2", title: "开发接口", next: "核对回调" }),
    task("closed", "risk", { project: "Alpha", title: "开发接口", next: "核对回调" }),
    task("deferred", "risk", { project: "Alpha", title: "开发接口", next: "核对回调" }),
    task("ignored", "risk", { project: "Alpha", title: "开发接口", next: "核对回调" }),
  ] };
  const actions = actionsFor({
    closed: { action: "completed" },
    deferred: { action: "deferred", deferredUntil: "2026-10-17" },
    ignored: { action: "no_tracking" },
  });
  const options = { view: "risk", category: "product", project: "Alpha", query: "回调" };
  assert.deepEqual(filterTasks(dashboard, actions, options, day).map(t => t.id), ["risk"]);
  assert.deepEqual(filterTasks(dashboard, actions, { ...options, category: "research" }, day).map(t => t.id), ["research"]);
  assert.deepEqual(filterTasks(dashboard, actions, { ...options, project: "Alpha 2" }, day).map(t => t.id), ["elsewhere"]);
  assert.deepEqual(filterTasks(dashboard, actions, { ...options, view: "completed" }, day).map(t => t.id), ["closed"]);
  assert.deepEqual(filterTasks(dashboard, actions, { ...options, view: "deferred" }, day).map(t => t.id), ["deferred"]);
  assert.deepEqual(filterTasks(dashboard, actions, { ...options, view: "no_tracking" }, day).map(t => t.id), ["ignored"]);
  assert.deepEqual(filterTasks(dashboard, actions, { ...options, project: "Alph" }, day), []);
  assert.deepEqual(filterTasks(dashboard, actions, { ...options, query: "不存在" }, day), []);
});

test("Chinese category label is searchable and category filtering retains original ranking and data", () => {
  const dashboard = { priorities: ["b"], tasks: [
    task("a", "risk", { title: "修复崩溃" }),
    task("b", "waiting", { title: "排查故障" }),
    task("c", "waiting", { title: "没有明确分类" }),
  ] };
  const before = JSON.stringify(dashboard);
  Object.freeze(dashboard.tasks);
  for (const source of dashboard.tasks) Object.freeze(source);
  assert.deepEqual(filterTasks(dashboard, {}, { query: "问答排查" }, day).map(t => t.id), ["b", "a"]);
  assert.deepEqual(filterTasks(dashboard, {}, { category: "troubleshooting" }, day).map(t => t.id), ["b", "a"]);
  assert.deepEqual(filterTasks(dashboard, {}, { category: "uncategorized", query: "待分类" }, day).map(t => t.id), ["c"]);
  assert.deepEqual(filterTasks(dashboard, {}, { category: "not-a-category" }, day), []);
  assert.equal(JSON.stringify(dashboard), before);
});
