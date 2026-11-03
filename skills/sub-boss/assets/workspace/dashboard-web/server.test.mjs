import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const frozenInstant = "2026-10-15T17:30:00.000Z"; // Shanghai 2026-10-16 01:30.
const execFileAsync = promisify(execFile);

async function availablePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  assert.notEqual(port, 4317, "isolation must never use the real dashboard port");
  return port;
}

async function startIsolatedServer(directory, database = path.join(directory, "missing-codex.sqlite")) {
  const port = await availablePort();
  const bootstrap = `
    const NativeDate = Date;
    const instant = ${JSON.stringify(frozenInstant)};
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [instant])); }
      static now() { return new NativeDate(instant).getTime(); }
    };
    await import('./server.mjs');
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", bootstrap], {
    cwd: directory,
    env: { ...process.env, TZ: "Asia/Shanghai", SUBBOSS_DASHBOARD_HOST: "127.0.0.1", SUBBOSS_DASHBOARD_PORT: String(port), SUBBOSS_CODEX_DB: database, SUBBOSS_INSTANCE_TOKEN: "isolated-fixture-instance" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Isolated server did not start: ${output}`));
    }, 8000);
    const finish = (error) => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`Isolated server exited with ${code}: ${output}`));
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.includes("Subboss dashboard:")) finish();
    });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
  });
  await ready;
  return { child, url: `http://127.0.0.1:${port}` };
}

async function stopIsolatedServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = once(server.child, "exit");
  const timer = setTimeout(() => server.child.kill("SIGKILL"), 2000);
  server.child.kill("SIGTERM");
  try { await exited; } finally { clearTimeout(timer); }
}

test("dashboard API reads and writes only isolated fixture state", { timeout: 25000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "subboss-dashboard-api-"));
  let server;
  t.after(async () => {
    await stopIsolatedServer(server);
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, "state"));
  await Promise.all([
    copyFile(path.join(sourceDirectory, "server.mjs"), path.join(directory, "server.mjs")),
    copyFile(path.join(sourceDirectory, "model.mjs"), path.join(directory, "model.mjs")),
    copyFile(path.join(sourceDirectory, "categories.mjs"), path.join(directory, "categories.mjs")),
    copyFile(path.join(sourceDirectory, "conversations.mjs"), path.join(directory, "conversations.mjs")),
  ]);
  const dashboard = {
    version: 1, generatedAt: "2026-10-16 01:00 CST", overallStatus: "需要拍板", summary300: "隔离测试虚构数据", priorities: ["fixture-a"],
    tasks: ["fixture-a", "fixture-b"].map(id => ({
      id, project: "虚构测试项目", title: id, stage: "验证中", status: "risk", progress: "测试文本", remaining: "测试剩余", next: "测试下一步",
      owner: "测试执行人", suggestedDate: "2026-10-16", decisionNeeded: true,
      evidence: { code: true, build: true, installed: false, committed: false, deployed: false, accepted: false },
    })),
  };
  const originalActions = { version: 1, items: { "fixture-history": { action: "completed", updatedAt: "2026-10-01T00:00:00.000Z" } } };
  const dashboardFile = path.join(directory, "state", "dashboard.json");
  const actionsFile = path.join(directory, "state", "actions.json");
  await writeFile(dashboardFile, JSON.stringify(dashboard));
  await writeFile(actionsFile, JSON.stringify(originalActions));
  const originalDashboardBytes = await readFile(dashboardFile, "utf8");
  server = await startIsolatedServer(directory);
  const get = async (endpoint) => {
    const response = await fetch(`${server.url}${endpoint}`);
    return { response, payload: await response.json() };
  };
  const post = async (body) => {
    const response = await fetch(`${server.url}/api/actions`, { method: "POST", headers: { "Content-Type": "application/json", "X-Subboss-Action": "1" }, body: JSON.stringify(body) });
    return { response, payload: await response.json() };
  };

  await t.test("GET health/dashboard and module MIME match browser expectations", async () => {
    const health = await get("/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.payload.ok, true);
    assert.equal(health.payload.url, server.url);
    assert.equal(health.payload.instanceToken, "isolated-fixture-instance");
    const loaded = await get("/api/dashboard");
    assert.equal(loaded.response.status, 200);
    assert.deepEqual(loaded.payload, { dashboard, actions: originalActions });
    assert.equal(loaded.response.headers.get("cache-control"), "no-store");
    const moduleResponse = await fetch(`${server.url}/model.mjs`);
    assert.equal(moduleResponse.status, 200);
    assert.match(moduleResponse.headers.get("content-type"), /(?:text|application)\/javascript/);
  });

  await t.test("unavailable conversation catalog never prevents dashboard reads", async () => {
    const catalog = await get("/api/conversations");
    assert.equal(catalog.response.status, 503);
    assert.equal(catalog.payload.errorCode, "CONVERSATIONS_UNAVAILABLE");
    assert.equal(catalog.payload.coverage.available, false);
    const loaded = await get("/api/dashboard");
    assert.equal(loaded.response.status, 200);
    assert.deepEqual(loaded.payload, { dashboard, actions: originalActions });
  });

  await t.test("category assignments overlay only valid categories and never alter source state", async () => {
    const assignmentsFile = path.join(directory, "state", "category-assignments.json");
    const beforeActions = await readFile(actionsFile, "utf8");
    const assignments = { version: 1, items: { "fixture-a": "product", "fixture-b": "not-a-category", "missing": "research" } };
    const bytes = JSON.stringify(assignments);
    await writeFile(assignmentsFile, bytes);
    try {
      const loaded = await get("/api/dashboard");
      assert.equal(loaded.response.status, 200);
      assert.deepEqual(Object.keys(loaded.payload).sort(), ["actions", "dashboard"]);
      assert.deepEqual(loaded.payload.dashboard, { ...dashboard, tasks: [{ ...dashboard.tasks[0], category: "product" }, dashboard.tasks[1]] });
      assert.deepEqual(loaded.payload.actions, originalActions);
      assert.equal(await readFile(dashboardFile, "utf8"), originalDashboardBytes);
      assert.equal(await readFile(actionsFile, "utf8"), beforeActions);
      assert.equal(await readFile(assignmentsFile, "utf8"), bytes);
    } finally {
      await rm(assignmentsFile);
    }
  });

  await t.test("local APIs reject cross-origin, rebinding, form and headerless writes", async () => {
    const before = await readFile(actionsFile, "utf8");
    for (const headers of [
      { Origin: "https://attacker.invalid" },
      { Host: "attacker.invalid" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
    ]) {
      for (const endpoint of ["/api/dashboard", "/api/conversations", "/api/health"]) {
        const status = await new Promise((resolve, reject) => {
          const request = httpRequest(`${server.url}${endpoint}`, { headers }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
          });
          request.on('error', reject);
          request.end();
        });
        assert.equal(status, 403, JSON.stringify({ headers, endpoint }));
      }
    }
    const body = JSON.stringify({ taskId: "fixture-a", action: "completed" });
    assert.equal((await fetch(`${server.url}/api/actions`, { method: "POST", headers: { "Content-Type": "text/plain" }, body })).status, 415);
    assert.equal((await fetch(`${server.url}/api/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 403);
    for (const resource of ["/state/actions.json", "/state/dashboard.json", "/server.mjs", "/conversations.mjs"]) {
      assert.equal((await fetch(`${server.url}${resource}`)).status, 404);
    }
    assert.equal(await readFile(actionsFile, "utf8"), before);
  });

  await t.test("completed and no_tracking persist and retain unrelated history", async () => {
    for (const [taskId, action] of [["fixture-a", "completed"], ["fixture-b", "no_tracking"]]) {
      const saved = await post({ taskId, action });
      assert.equal(saved.response.status, 200);
      assert.equal(saved.payload.ok, true);
      assert.equal(saved.payload.actions.items[taskId].action, action);
      assert.equal(saved.payload.actions.items[taskId].updatedAt, frozenInstant);
      assert.deepEqual(saved.payload.actions.items["fixture-history"], originalActions.items["fixture-history"]);
      const disk = JSON.parse(await readFile(actionsFile, "utf8"));
      assert.deepEqual(saved.payload.actions, disk);
    }
  });

  await t.test("deferred uses Shanghai calendar plus three days even before 08:00", async () => {
    const saved = await post({ taskId: "fixture-a", action: "deferred" });
    assert.equal(saved.response.status, 200);
    assert.deepEqual(saved.payload.actions.items["fixture-a"], {
      action: "deferred", updatedAt: frozenInstant, deferredUntil: "2026-10-19",
    });
    const reloaded = await get("/api/dashboard");
    assert.deepEqual(reloaded.payload.actions, saved.payload.actions);
    assert.deepEqual(reloaded.payload.dashboard, dashboard);
  });

  await t.test("invalid task/action/JSON are rejected without touching stored state", async () => {
    const before = await readFile(actionsFile, "utf8");
    for (const body of [{ taskId: "missing", action: "completed" }, { taskId: "fixture-a", action: "delete" }]) {
      const rejected = await post(body);
      assert.equal(rejected.response.status, 400);
      assert.equal(typeof rejected.payload.error, "string");
      assert.equal(await readFile(actionsFile, "utf8"), before);
    }
    const invalid = await fetch(`${server.url}/api/actions`, { method: "POST", headers: { "Content-Type": "application/json", "X-Subboss-Action": "1" }, body: "{bad json" });
    assert.equal(invalid.status, 400);
    assert.equal(typeof (await invalid.json()).error, "string");
    assert.equal(await readFile(actionsFile, "utf8"), before);
  });

  await t.test("concurrent tracking writes retain each task update", async () => {
    const saved = await Promise.all([
      post({ taskId: "fixture-a", action: "completed" }),
      post({ taskId: "fixture-b", action: "no_tracking" }),
    ]);
    assert.ok(saved.every(item => item.response.status === 200));
    const persisted = JSON.parse(await readFile(actionsFile, "utf8"));
    assert.equal(persisted.items["fixture-a"].action, "completed");
    assert.equal(persisted.items["fixture-b"].action, "no_tracking");
  });

  await t.test("active removes only the selected override and a restart retains saved state", async () => {
    const restored = await post({ taskId: "fixture-a", action: "active" });
    assert.equal(restored.response.status, 200);
    assert.equal(Object.hasOwn(restored.payload.actions.items, "fixture-a"), false);
    assert.equal(restored.payload.actions.items["fixture-b"].action, "no_tracking");
    assert.deepEqual(restored.payload.actions.items["fixture-history"], originalActions.items["fixture-history"]);
    await stopIsolatedServer(server);
    server = await startIsolatedServer(directory);
    const persisted = await get("/api/dashboard");
    assert.deepEqual(persisted.payload.actions, restored.payload.actions);
    assert.deepEqual(persisted.payload.dashboard, dashboard);
    assert.equal(await readFile(dashboardFile, "utf8"), originalDashboardBytes);
  });
});

test("conversation HTTP API reads only an isolated SQLite fixture", { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "subboss-conversation-api-"));
  let server;
  t.after(async () => {
    await stopIsolatedServer(server);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all(["server.mjs", "model.mjs", "categories.mjs", "conversations.mjs"].map(name =>
    copyFile(path.join(sourceDirectory, name), path.join(directory, name))));
  const database = path.join(directory, "codex-fixture.sqlite");
  await execFileAsync("sqlite3", [database, `
    CREATE TABLE threads (id TEXT, title TEXT, name TEXT, preview TEXT, source TEXT, cwd TEXT,
      archived INTEGER, updated_at INTEGER, has_user_event INTEGER, agent_path TEXT);
    INSERT INTO threads VALUES ('product', '旧标题', '[PRODUCT] 中文项目', '测试摘要', 'vscode', '/fixture/ip', 0, 1792375200, 0, NULL);
    INSERT INTO threads VALUES ('archive', '已归档调研', NULL, '', 'cli', '/fixture/research', 1, 1792375100, 1, NULL);
    INSERT INTO threads VALUES ('agent', '内部子代理', NULL, '', '{"subagent":{}}', '/fixture', 0, 1792375200, 1, NULL);
    INSERT INTO threads VALUES ('blank', '', ' ', '', 'vscode', '/fixture', 0, 1792375200, 0, NULL);
  `]);
  const before = await readFile(database);
  server = await startIsolatedServer(directory, database);
  const response = await fetch(`${server.url}/api/conversations`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const catalog = await response.json();
  assert.deepEqual(catalog.items.map(item => item.id), ["product", "archive"]);
  assert.equal(catalog.items[0].title, "[PRODUCT] 中文项目");
  assert.equal(catalog.items[1].archived, true);
  assert.equal(catalog.coverage.total, 2);
  assert.equal(catalog.coverage.scope, "本机 Codex 对话");
  assert.deepEqual(await readFile(database), before);
});
