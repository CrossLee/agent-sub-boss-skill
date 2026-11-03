import http from "node:http";
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { todayShanghai } from "./model.mjs";
import { categoryLabels } from "./categories.mjs";
import { readConversations } from "./conversations.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(ROOT, "state");
const DASHBOARD_FILE = path.join(STATE_DIR, "dashboard.json");
const ACTIONS_FILE = path.join(STATE_DIR, "actions.json");
const CATEGORY_ASSIGNMENTS_FILE = path.join(STATE_DIR, "category-assignments.json");
const HOST = "127.0.0.1";
if (process.env.SUBBOSS_DASHBOARD_HOST && process.env.SUBBOSS_DASHBOARD_HOST !== HOST) {
  throw new Error("Sub-boss only supports the loopback host 127.0.0.1");
}
const PORT = Number(process.env.SUBBOSS_DASHBOARD_PORT || 4317);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid dashboard port");
let actionQueue = Promise.resolve();
let runtimePromise;
function runtimeController() {
  runtimePromise ||= import('./runtime.mjs').then(({ RuntimeController }) => new RuntimeController());
  return runtimePromise;
}
const publicFiles = new Set(['index.html', 'styles.css', 'app.js', 'model.mjs', 'categories.mjs',
  'motion.css', 'motion.js', 'theme-cyberpunk.css', 'runtime.html', 'runtime.css', 'runtime.js']);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function normalizeAction(payload, taskIds) {
  const taskId = String(payload.taskId || "");
  const action = String(payload.action || "");
  if (!taskIds.has(taskId)) throw new Error("任务不存在");
  if (!["active", "completed", "no_tracking", "deferred"].includes(action)) {
    throw new Error("不支持的操作");
  }

  const today = new Date();
  const item = {
    action,
    updatedAt: today.toISOString(),
  };

  if (action === "deferred") {
    const shanghaiNoon = new Date(`${todayShanghai(today)}T12:00:00+08:00`);
    item.deferredUntil = todayShanghai(new Date(shanghaiNoon.getTime() + 3 * 86400000));
  }
  return { taskId, item };
}

function localRequest(request) {
  const host = request.headers.host;
  const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  const origin = request.headers.origin;
  return allowedHosts.has(host)
    && (!origin || origin === `http://${host}`)
    && !['cross-site', 'same-site'].includes(request.headers['sec-fetch-site']);
}

async function handleApi(request, response, pathname) {
  if (pathname === '/api/runtime' || pathname.startsWith('/api/runtime/')) {
    const host = request.headers.host;
    try {
      const runtime = await runtimeController();
      if (request.method === 'GET' && pathname === '/api/runtime') return json(response, 200, await runtime.snapshot());
      if (request.method === 'GET' && pathname === '/api/runtime/logs') {
        const params = new URL(request.url, `http://${host}`).searchParams;
        return json(response, 200, await runtime.logs(params.get('projectId'), params.get('serviceId')));
      }
      if (request.method === 'POST') {
        if (request.headers['x-subboss-token'] !== runtime.token) return json(response, 403, { error: '页面连接已更新，请刷新页面后重试' });
        if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '需要 JSON 请求' });
        const payload = await readBody(request);
        if (pathname === '/api/runtime/scan') return json(response, 200, await runtime.scan());
        if (pathname === '/api/runtime/action') return json(response, 200, await runtime.action(payload.projectId, payload.serviceId, payload.action));
      }
      return json(response, 404, { error: '接口不存在' });
    } catch (error) { return json(response, 400, { error: error.message || '操作失败' }); }
  }
  if (request.method === "GET" && pathname === "/api/health") {
    return json(response, 200, { ok: true, url: `http://${HOST}:${PORT}`, instanceToken: process.env.SUBBOSS_INSTANCE_TOKEN || null });
  }
  if (request.method === "GET" && pathname === "/api/dashboard") {
    const [dashboard, actions, assignments] = await Promise.all([
      readJson(DASHBOARD_FILE, null),
      readJson(ACTIONS_FILE, { version: 1, items: {} }),
      readJson(CATEGORY_ASSIGNMENTS_FILE, { version: 1, items: {} }),
    ]);
    if (!dashboard) return json(response, 503, { error: "看板数据尚未生成" });
    const items = assignments?.items;
    const classifiedDashboard = Array.isArray(dashboard.tasks) && items && typeof items === "object"
      ? { ...dashboard, tasks: dashboard.tasks.map(task => {
        const category = Object.hasOwn(items, task.id) ? items[task.id] : null;
        return typeof category === "string" && Object.hasOwn(categoryLabels, category) ? { ...task, category } : task;
      }) }
      : dashboard;
    return json(response, 200, { dashboard: classifiedDashboard, actions });
  }
  if (request.method === "GET" && pathname === "/api/conversations") {
    const catalog = await readConversations();
    return json(response, catalog.coverage.available ? 200 : 503, catalog);
  }
  if (request.method === "POST" && pathname === "/api/actions") {
    try {
      if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, { error: '需要 JSON 请求' });
      if (request.headers['x-subboss-action'] !== '1') return json(response, 403, { error: '请从本机看板提交操作' });
      const payload = await readBody(request);
      const save = actionQueue.then(async () => {
        const dashboard = await readJson(DASHBOARD_FILE, { tasks: [] });
        const taskIds = new Set((dashboard.tasks || []).map((task) => task.id));
        const { taskId, item } = normalizeAction(payload, taskIds);
        const actions = await readJson(ACTIONS_FILE, { version: 1, items: {} });
        actions.items ||= {};
        if (item.action === "active") delete actions.items[taskId];
        else actions.items[taskId] = item;
        actions.updatedAt = new Date().toISOString();
        await writeJsonAtomic(ACTIONS_FILE, actions);
        return actions;
      });
      actionQueue = save.catch(() => {});
      const actions = await save;
      return json(response, 200, { ok: true, actions });
    } catch (error) {
      return json(response, 400, { error: error.message || "保存失败" });
    }
  }
  return false;
}

async function serveStatic(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname === '/runtime' ? 'runtime.html' : pathname.replace(/^\/+/, "");
  if (!publicFiles.has(relative)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return response.end('未找到页面');
  }
  const requested = path.resolve(ROOT, relative);
  if (!requested.startsWith(`${ROOT}${path.sep}`)) {
    response.writeHead(403);
    return response.end("Forbidden");
  }
  try {
    const info = await stat(requested);
    if (!info.isFile()) throw new Error("Not a file");
    const content = await readFile(requested);
    response.writeHead(200, {
      "Content-Type": MIME[path.extname(requested)] || "application/octet-stream",
      "Cache-Control": pathname === "/" ? "no-cache" : "public, max-age=60",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("未找到页面");
  }
}

await mkdir(STATE_DIR, { recursive: true });

const server = http.createServer(async (request, response) => {
  try {
    // Validate Host before URL parsing to prevent DNS-rebinding access to local data.
    if (!localRequest(request)) return json(response, 403, { error: '只接受本机同源请求' });
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) return json(response, 405, { error: '不支持的请求方式' });
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(request, response, url.pathname);
      if (handled !== false) return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    json(response, 500, { error: error.message || "服务器内部错误" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Subboss dashboard: http://${HOST}:${PORT}`);
});
