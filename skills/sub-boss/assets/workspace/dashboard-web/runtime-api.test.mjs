import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, mkdir, writeFile, access, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function availablePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  assert.notEqual(port, 4317, 'tests must never use the real dashboard port');
  return port;
}

function httpCall(base, endpoint, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(endpoint, base), { method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload;
        try { payload = JSON.parse(text); } catch { payload = null; }
        resolve({ status: response.statusCode, headers: response.headers, text, payload });
      });
    });
    req.setTimeout(12000, () => req.destroy(new Error('isolated HTTP request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function eventually(check, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await wait(100);
  }
  throw new Error(`${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(timer); }
}

// Emergency cleanup only accepts the worker copied into this test's temporary
// directory, with the exact token recorded in this test's private database.
async function cleanupFixtureWorkers(directory, database) {
  let db;
  try {
    db = new DatabaseSync(database, { readOnly: true });
    const runs = db.prepare('SELECT pid,token FROM runs WHERE pid IS NOT NULL').all();
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,pgid=,command=']);
    const workerPath = path.join(directory, 'runtime-worker.mjs');
    for (const run of runs) {
      const owned = stdout.split('\n').some(line => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        return match && +match[1] === run.pid && +match[2] === run.pid
          && match[3].includes(workerPath) && match[3].includes(run.token);
      });
      if (owned) { try { process.kill(-run.pid, 'SIGKILL'); } catch {} }
    }
  } catch {} finally { db?.close(); }
}

test('runtime HTTP API confines actions and data to isolated fixtures', { timeout: 45000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'subboss-runtime-api-')));
  const projectRoot = path.join(directory, 'projects');
  const projectDirectory = path.join(projectRoot, 'fixtureweb');
  const database = path.join(directory, 'state', 'runtime.sqlite');
  const sentinel = path.join(directory, 'arbitrary-command-executed');
  let child;
  let base;
  let csrfToken;
  let target;
  let serverOutput = '';
  const post = (endpoint, payload, headers = {}) => httpCall(base, endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-subboss-token': csrfToken, ...headers },
    body: JSON.stringify(payload),
  });
  t.after(async () => {
    if (target && csrfToken && child?.exitCode === null && child?.signalCode === null) {
      try { await post('/api/runtime/action', { ...target, action: 'stop' }); } catch {}
    }
    await stopServer(child);
    await cleanupFixtureWorkers(directory, database);
    await rm(directory, { recursive: true, force: true });
  });

  await mkdir(projectDirectory, { recursive: true });
  await Promise.all([
    'server.mjs', 'model.mjs', 'categories.mjs', 'conversations.mjs',
    'runtime.mjs', 'runtime-store.mjs', 'runtime-worker.mjs', 'runtime-discovery.mjs',
  ].map(file => copyFile(path.join(sourceDirectory, file), path.join(directory, file))));
  const servicePort = await availablePort();
  await writeFile(path.join(projectDirectory, 'package.json'), JSON.stringify({
    name: 'isolated-fixtureweb', scripts: { dev: 'node server.js' },
  }));
  await writeFile(path.join(projectDirectory, 'server.js'), `
    const http = require('node:http');
    const port = Number(process.env.PORT || ${servicePort});
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('isolated-runtime-fixture');
    });
    server.listen(port, '127.0.0.1', () => console.log('fixture ready'));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `);
  let dashboardPort = await availablePort();
  while (dashboardPort === servicePort) dashboardPort = await availablePort();
  base = `http://127.0.0.1:${dashboardPort}`;
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: directory,
    env: {
      ...process.env,
      SUBBOSS_DASHBOARD_HOST: '127.0.0.1', SUBBOSS_DASHBOARD_PORT: String(dashboardPort),
      SUBBOSS_PROJECT_ROOT: projectRoot, SUBBOSS_RUNTIME_DB: database,
      SUBBOSS_CODEX_DB: path.join(directory, 'missing-codex.sqlite'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { serverOutput += chunk.toString(); });
  await eventually(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(serverOutput);
    return (await httpCall(base, '/api/health')).status === 200;
  }, 'isolated dashboard did not start');

  await t.test('GET runtime discovers only the private fixture root', async () => {
    const result = await httpCall(base, '/api/runtime');
    assert.equal(result.status, 200, result.text);
    assert.equal(result.payload.root, projectRoot);
    assert.deepEqual(result.payload.roots.map(root => root.path), [projectRoot]);
    assert.equal(result.payload.projects.length, 1);
    const project = result.payload.projects[0];
    assert.equal(project.path, projectDirectory);
    assert.equal(project.services.length, 1);
    const service = project.services[0];
    assert.equal(service.port, servicePort);
    assert.equal(service.available, true, service.disabledReason);
    assert.equal(service.status, 'stopped');
    assert.deepEqual(service.env, {});
    assert.match(result.payload.csrfToken, /^[a-f0-9]{64}$/);
    csrfToken = result.payload.csrfToken;
    target = { projectId: project.id, serviceId: service.id };
  });

  await t.test('missing/wrong token, hostile Origin/Host and wrong content type are rejected', async () => {
    const action = { ...target, action: 'start' };
    const missing = await httpCall(base, '/api/runtime/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action),
    });
    assert.equal(missing.status, 403);
    assert.equal((await post('/api/runtime/action', action, { 'x-subboss-token': 'wrong' })).status, 403);
    assert.equal((await post('/api/runtime/action', action, { Origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await post('/api/runtime/action', action, { Host: 'attacker.invalid' })).status, 403);
    assert.equal((await post('/api/runtime/action', action, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post('/api/runtime/action', action, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await httpCall(base, '/api/runtime', { headers: { Host: 'attacker.invalid' } })).status, 403);
    const db = new DatabaseSync(database, { readOnly: true });
    try { assert.equal(db.prepare('SELECT count(*) AS count FROM runs').get().count, 0); }
    finally { db.close(); }
  });

  await t.test('server source and SQLite state are never served as static files', async () => {
    for (const endpoint of ['/server.mjs', '/runtime.mjs', '/runtime-worker.mjs', '/runtime-store.mjs', '/state/runtime.sqlite', '/state/runtime.sqlite-wal', '/state/../server.mjs']) {
      const result = await httpCall(base, endpoint);
      assert.equal(result.status, 404, `${endpoint}: ${result.text}`);
      assert.doesNotMatch(result.text, /SQLite format|class RuntimeController|createServer\(/);
    }
  });

  await t.test('action parameters cannot select arbitrary commands, files or service IDs', async () => {
    assert.equal((await post('/api/runtime/action', { ...target, action: `start; touch ${sentinel}` })).status, 400);
    assert.equal((await post('/api/runtime/action', { ...target, serviceId: '../../server.mjs', action: 'start' })).status, 400);
    const malformed = await httpCall(base, '/api/runtime/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-subboss-token': csrfToken }, body: '{',
    });
    assert.equal(malformed.status, 400);
    const result = await post('/api/runtime/action', {
      ...target, action: 'start', command: `touch ${sentinel}`, executable: '/bin/sh',
      args: ['-c', `touch ${sentinel}`], cwd: '/', env: { PORT: '1' },
    });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.payload.ok, true);
    await eventually(async () => (await httpCall(`http://127.0.0.1:${servicePort}`, '/')).text === 'isolated-runtime-fixture', 'fixture service did not start');
    const running = await eventually(async () => {
      const snapshot = await httpCall(base, '/api/runtime');
      const service = snapshot.payload?.projects[0]?.services[0];
      return service?.status === 'running' && service;
    }, 'fixture never reached running state');
    assert.equal(running.url, `http://127.0.0.1:${servicePort}`);
    assert.ok(running.pid > 0);
    await assert.rejects(access(sentinel), error => error.code === 'ENOENT');
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const run = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get();
      assert.equal(run.executable, process.execPath);
      assert.equal(run.cwd, projectDirectory);
      assert.deepEqual(JSON.parse(run.args), [path.join(projectDirectory, 'server.js')]);
      assert.equal(run.port, servicePort);
    } finally { db.close(); }
  });

  await t.test('a valid same-origin stop closes the managed fixture service', async () => {
    const result = await post('/api/runtime/action', { ...target, action: 'stop' }, { Origin: base });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.payload.ok, true);
    const snapshot = await httpCall(base, '/api/runtime');
    assert.equal(snapshot.payload.projects[0].services[0].status, 'stopped');
    await assert.rejects(httpCall(`http://127.0.0.1:${servicePort}`, '/'));
    const logs = await httpCall(base, `/api/runtime/logs?${new URLSearchParams(target)}`);
    assert.equal(logs.status, 200);
    assert.match(logs.payload.logs, /fixture ready/);
    await assert.rejects(access(sentinel), error => error.code === 'ENOENT');
  });
});
