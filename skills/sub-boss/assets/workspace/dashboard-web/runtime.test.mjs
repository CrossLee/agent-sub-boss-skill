import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RuntimeController } from './runtime.mjs';
import { decodeService } from './runtime-store.mjs';

const exec = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const projectId = 'isolated-fixture';
const serviceId = 'web';
const fixtureCode = `
import http from 'node:http';
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('runtime-fixture:' + process.pid);
});
server.once('error', error => { console.error(error); process.exit(2); });
server.listen(Number(process.argv[2]), '127.0.0.1', () => console.log('fixture ready ' + process.pid));
let closing = false;
process.on('SIGTERM', () => {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
`;

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.ok(port >= 1024 && port !== 4317, 'fixture must use a random unprivileged port');
  return port;
}

async function eventually(read, accept, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let value;
  let failure;
  do {
    try { value = await read(); if (accept(value)) return value; }
    catch (error) { failure = error; }
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(`${message}; last result: ${JSON.stringify(value)}${failure ? `; last error: ${failure.message}` : ''}`);
}

async function bodyAt(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
  assert.equal(response.status, 200);
  return response.text();
}

async function portIsClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 1500);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.kill('SIGTERM');
  });
}

async function ownedFixtureWorker(run, database) {
  if (!run.pid) return false;
  try {
    const { stdout } = await exec('/bin/ps', ['-p', String(run.pid), '-o', 'pgid=,command=']);
    const result = stdout.trim().match(/^(\d+)\s+(.+)$/);
    return Number(result?.[1]) === run.pid && result[2].includes('runtime-worker.mjs') && result[2].includes(database) && result[2].includes(run.token);
  } catch { return false; }
}

async function fixtureProcesses(directory) {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,pgid=,command=']);
  return stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match && match[3].includes(directory) && /(?:runtime-worker|fixture|grandchild)\.mjs/.test(match[3])
      ? [{ pid: Number(match[1]), group: Number(match[2]), command: match[3] }] : [];
  });
}

async function fixture(t, { failed = false, descendantMode = null } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'subboss-runtime-test-')));
  const root = path.join(directory, 'projects');
  const projectPath = path.join(root, 'fixture');
  const foreignPath = path.join(directory, 'unrelated-process');
  const database = path.join(directory, 'state', 'runtime.sqlite');
  const children = [];
  const controllers = [];
  // Register before starting any child, so a failing assertion cannot leak services.
  t.after(async () => {
    for (const child of children) await stopChild(child);
    let cleanup;
    try {
      cleanup = new RuntimeController({ root, database });
      const runs = cleanup.db.prepare('SELECT * FROM runs ORDER BY id DESC').all();
      for (const run of runs) {
        if (!await ownedFixtureWorker(run, database)) continue;
        try { await cleanup.stop(run.project_id, run.service_id); } catch {}
        // A lifecycle regression can leave an older worker outside latest().
        // Kill only a worker carrying this test's database and unguessable token.
        if (await ownedFixtureWorker(run, database)) process.kill(-run.pid, 'SIGKILL');
        await eventually(() => ownedFixtureWorker(run, database), (alive) => !alive, 'fixture worker must exit during cleanup', 5000);
      }
    } finally {
      // A failed process-group regression must not leave an orphaned fixture.
      // These commands contain this test's unique, canonical temporary path.
      for (const child of await fixtureProcesses(directory)) {
        try { process.kill(child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await eventually(() => fixtureProcesses(directory), (processes) => processes.length === 0, 'all test descendants must be cleaned up', 5000);
      try { cleanup?.db.close(); } catch {}
      for (const controller of controllers) { try { controller.db.close(); } catch {} }
      await rm(directory, { recursive: true, force: true });
    }
  });
  await Promise.all([mkdir(projectPath, { recursive: true }), mkdir(foreignPath, { recursive: true })]);
  const script = path.join(projectPath, 'fixture.mjs');
  if (descendantMode) {
    const grandchildScript = path.join(projectPath, 'grandchild.mjs');
    await writeFile(grandchildScript, `
import http from 'node:http';
const server = http.createServer((_request, response) => response.end('runtime-grandchild:' + process.pid));
process.on('SIGTERM', () => console.log('grandchild ignored SIGTERM'));
server.listen(Number(process.argv[2]), '127.0.0.1', () => {
  console.log('grandchild ready ' + process.pid);
  if (process.send) process.send('ready');
});
`);
    await writeFile(script, `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(grandchildScript)}, process.argv[2]], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
child.on('error', error => { console.error(error); process.exit(3); });
child.once('message', () => { ${descendantMode === 'launcher-exits' ? 'process.exit(17);' : "console.log('launcher ready ' + process.pid);"} });
process.on('SIGTERM', () => process.exit(0));
`);
  } else await writeFile(script, failed ? "console.error('fixture startup failed'); process.exit(23);\n" : fixtureCode);
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const controller = new RuntimeController({ root, database });
  controllers.push(controller);
  controller.db.prepare(`INSERT INTO projects(id,name,path,stack,databases,notes,scanned_at,present)
    VALUES (?,?,?,?,?,?,?,1)`).run(projectId, '隔离测试项目', projectPath, '["Node.js"]', '["SQLite"]', '[]', new Date().toISOString());
  controller.db.prepare(`INSERT INTO services(project_id,id,label,cwd,executable,args,env,port,url,kind,source,available,dependencies,present)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'[]',1)`).run(projectId, serviceId, '测试网页', projectPath, process.execPath, JSON.stringify([script, String(port)]), '{}', port, url, 'web', 'isolated test fixture');
  const project = { id: projectId, name: '隔离测试项目', path: projectPath };
  const service = () => decodeService(controller.db.prepare('SELECT * FROM services WHERE project_id=? AND id=?').get(projectId, serviceId));
  const serviceState = async (owner = controller) => {
    const snapshot = await owner.snapshot();
    assert.equal(snapshot.projects.length, 1, 'snapshot must contain only the isolated project');
    assert.equal(snapshot.root, root);
    return snapshot.projects[0].services[0];
  };
  const running = (owner = controller) => eventually(() => serviceState(owner), (state) => state.status === 'running', 'managed fixture should become ready');
  const action = (actionName, owner = controller) => owner.action(projectId, serviceId, actionName);
  const latest = (owner = controller) => owner.latest(projectId, serviceId);
  const runCount = (owner = controller) => Number(owner.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count);
  const external = async (cwd) => {
    const child = spawn(process.execPath, [script, String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => { output += error.message; });
    await eventually(async () => ({ body: await bodyAt(url), output }), (value) => value.body === `runtime-fixture:${child.pid}`, 'external fixture should become ready');
    return child;
  };
  const reopen = () => {
    const next = new RuntimeController({ root, database });
    controllers.push(next);
    return next;
  };
  return { directory, root, projectPath, foreignPath, database, port, url, controller, project, service, serviceState, running, action, latest, runCount, external, reopen };
}

test('managed service starts, reaches HTTP readiness, ignores duplicate start, and stops', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.serviceState()).status, 'stopped');
  assert.equal((await f.controller.logs(projectId, serviceId)).logs, '尚未由总控台启动，没有运行日志。');
  assert.deepEqual(await f.action('start'), { ok: true });
  const running = await f.running();
  assert.ok(running.pid > 0);
  assert.equal(running.port, f.port);
  assert.equal(running.url, f.url);
  assert.match(await bodyAt(f.url), /^runtime-fixture:\d+$/);
  const original = f.latest();
  await f.action('start');
  assert.equal(f.latest().id, original.id, 'duplicate start must not create another run');
  assert.equal(f.latest().pid, original.pid);
  assert.equal(f.runCount(), 1);
  assert.match((await f.controller.logs(projectId, serviceId)).logs, /fixture ready/);
  await f.action('stop');
  await eventually(() => portIsClosed(f.port), Boolean, 'stop must release the fixture port');
  assert.equal((await f.serviceState()).status, 'stopped');
  assert.equal(f.latest().status, 'stopped');
  assert.ok(f.latest().stopped_at);
});

test('restart replaces the managed worker and serves the same address', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  await f.action('start');
  await f.running();
  const original = f.latest();
  const originalBody = await bodyAt(f.url);
  await f.action('restart');
  const next = await f.running();
  assert.notEqual(next.pid, original.pid);
  assert.notEqual(f.latest().id, original.id);
  assert.equal(f.runCount(), 2);
  assert.equal(next.url, f.url);
  assert.notEqual(await bodyAt(f.url), originalBody, 'restart must replace the actual HTTP child');
  assert.equal(f.controller.db.prepare('SELECT status FROM runs WHERE id=?').get(original.id).status, 'stopped');
  assert.equal(await ownedFixtureWorker(original, f.database), false);
});

test('concurrent start actions create exactly one worker and one run', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 5 }, () => f.action('start')));
  assert.ok(responses.every((response) => response.ok === true));
  const state = await f.running();
  assert.equal(f.runCount(), 1);
  assert.equal(state.pid, f.latest().pid);
  assert.equal(await ownedFixtureWorker(f.latest(), f.database), true);
  assert.match(await bodyAt(f.url), /^runtime-fixture:\d+$/);
});

test('external service in the project directory is visible and cannot be stopped or restarted', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  const external = await f.external(f.projectPath);
  const state = await f.serviceState();
  assert.equal(state.status, 'external');
  assert.equal(state.pid, external.pid);
  assert.equal(f.runCount(), 0);
  await assert.rejects(f.action('start'), /外部/);
  assert.equal(f.runCount(), 0, 'start should preserve a service already started outside the controller');
  await assert.rejects(f.action('stop'), /外部|安全停止/);
  await assert.rejects(f.action('restart'), /外部|安全停止/);
  assert.equal(await bodyAt(f.url), `runtime-fixture:${external.pid}`);
  assert.equal(external.exitCode, null);
  assert.equal(f.runCount(), 0);
});

test('unrelated port owner is a conflict and is never killed by start, stop, or restart', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  const external = await f.external(f.foreignPath);
  const state = await f.controller.serviceState(f.project, f.service(), await f.controller.context());
  assert.equal(state.status, 'conflict');
  assert.match(state.lastError, new RegExp(String(f.port)));
  await assert.rejects(f.action('start'), /端口.*占用/);
  await assert.rejects(f.action('stop'), /外部|安全停止/);
  await assert.rejects(f.action('restart'), /端口.*占用/);
  assert.equal(f.runCount(), 0);
  assert.equal(await bodyAt(f.url), `runtime-fixture:${external.pid}`);
  assert.equal(external.exitCode, null);
});

test('new controller instance recovers the existing worker from SQLite and can stop it', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  await f.action('start');
  await f.running();
  const original = f.latest();
  f.controller.db.close();
  const recovered = f.reopen();
  const state = await f.serviceState(recovered);
  assert.equal(state.status, 'running');
  assert.equal(state.pid, original.pid);
  assert.equal(f.latest(recovered).token, original.token);
  assert.equal(f.runCount(recovered), 1);
  await f.action('start', recovered);
  assert.equal(f.runCount(recovered), 1, 'recovered controller must not launch a duplicate');
  assert.match((await recovered.logs(projectId, serviceId)).logs, /fixture ready/);
  await f.action('stop', recovered);
  await eventually(() => portIsClosed(f.port), Boolean, 'recovered stop must release the port');
  assert.equal((await f.serviceState(recovered)).status, 'stopped');
});

test('failed startup retains stderr, exit status, and a failed service state', { timeout: 25000 }, async (t) => {
  const f = await fixture(t, { failed: true });
  await f.action('start');
  const failed = await eventually(() => f.serviceState(), (state) => state.status === 'failed', 'failed fixture should report failure');
  assert.equal(f.latest().exit_code, 23);
  assert.match(failed.lastError, /23|退出/);
  const logs = await f.controller.logs(projectId, serviceId);
  assert.match(logs.logs, /fixture startup failed/);
  assert.match(logs.logs, /退出码 23/);
  assert.equal(await portIsClosed(f.port), true);
  await assert.rejects(f.action('stop'), /外部|安全停止/);
  assert.equal(f.runCount(), 1);
});

test('two controller instances starting concurrently share only one active run and worker', { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  const second = f.reopen();
  const outcomes = await Promise.allSettled([f.action('start'), f.action('start', second)]);
  assert.ok(outcomes.some((result) => result.status === 'fulfilled'), 'at least one controller should start the service');
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') assert.match(outcome.reason.message, /启动|占用|UNIQUE constraint/);
  }
  const [firstState, secondState] = await Promise.all([f.running(), f.running(second)]);
  assert.equal(firstState.pid, secondState.pid);
  assert.equal(f.runCount(), 1);
  const active = f.controller.db.prepare("SELECT * FROM runs WHERE status IN ('starting','running','stopping')").all();
  assert.equal(active.length, 1);
  const workers = (await fixtureProcesses(f.directory)).filter((entry) => entry.command.includes('runtime-worker.mjs'));
  assert.equal(workers.length, 1);
  assert.equal(workers[0].pid, active[0].pid);
  await f.action('stop', second);
  await eventually(() => portIsClosed(f.port), Boolean, 'second controller should be able to stop the sole worker');
});

test('launcher exit cleans up a grandchild that ignores SIGTERM', { timeout: 25000 }, async (t) => {
  const f = await fixture(t, { descendantMode: 'launcher-exits' });
  await f.action('start');
  await eventually(() => f.serviceState(), (state) => state.status === 'failed', 'launcher exit should report failure');
  const logs = (await f.controller.logs(projectId, serviceId)).logs;
  assert.match(logs, /grandchild ready \d+/, 'fixture must have actually started its descendant');
  assert.match(logs, /grandchild ignored SIGTERM/, 'fixture descendant must resist graceful shutdown');
  assert.equal(f.latest().exit_code, 17);
  await eventually(() => portIsClosed(f.port), Boolean, 'launcher exit must release its grandchild port');
  await eventually(() => fixtureProcesses(f.directory), (processes) => processes.length === 0, 'launcher exit must leave no fixture process');
});

test('stop terminates the entire worker group even when a grandchild ignores SIGTERM', { timeout: 25000 }, async (t) => {
  const f = await fixture(t, { descendantMode: 'stubborn-grandchild' });
  await f.action('start');
  await f.running();
  assert.match(await bodyAt(f.url), /^runtime-grandchild:\d+$/);
  const descendants = await fixtureProcesses(f.directory);
  assert.equal(descendants.filter((entry) => entry.command.includes('grandchild.mjs')).length, 1);
  assert.equal(new Set(descendants.map((entry) => entry.group)).size, 1, 'fixture descendants should share the supervisor process group');
  await f.action('stop');
  assert.equal((await f.serviceState()).status, 'stopped');
  assert.match((await f.controller.logs(projectId, serviceId)).logs, /grandchild ignored SIGTERM/);
  await eventually(() => portIsClosed(f.port), Boolean, 'stop must close the stubborn descendant listener');
  assert.deepEqual(await fixtureProcesses(f.directory), []);
});
