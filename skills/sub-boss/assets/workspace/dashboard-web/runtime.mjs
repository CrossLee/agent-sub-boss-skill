import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, realpath, open } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { openRuntimeStore, decodeService } from './runtime-store.mjs';
import { discoverProjects, discoverProject } from './runtime-discovery.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, 'runtime-worker.mjs');
const active = new Set(['starting', 'running', 'stopping']);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = (project, service) => `${project}\0${service}`;
const enrichedPath = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', process.env.PATH || ''].join(':');

async function processTable() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command='], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').flatMap(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m ? [{ pid: +m[1], parent: +m[2], group: +m[3], command: m[4] }] : [];
  });
}
function ownsWorker(run, processes) {
  return !!run?.pid && processes.some(p => p.pid === run.pid && p.group === run.pid && p.command.includes(worker) && p.command.includes(run.token));
}
async function listeners() {
  let stdout = '';
  try { ({ stdout } = await exec(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { maxBuffer: 4 * 1024 * 1024 })); }
  catch (error) { if (error.code !== 1) throw new Error('无法读取端口归属，暂不执行进程操作'); }
  const result = new Map();
  let pid = null;
  for (const line of stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    if (line[0] === 'n') {
      const port = Number(line.match(/:(\d+)$/)?.[1]);
      if (port && pid) result.set(port, [...(result.get(port) || []), pid]);
    }
  }
  return result;
}
async function portOccupied(port) {
  if (!port) return false;
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(400);
    const done = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}
async function processCwd(pid) {
  try {
    const { stdout } = await exec(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    return stdout.split('\n').find(s => s.startsWith('n'))?.slice(1) || '';
  } catch { return ''; }
}

export class RuntimeController {
  constructor({ root = process.env.SUBBOSS_PROJECT_ROOT || path.resolve(here, '../..'), database = process.env.SUBBOSS_RUNTIME_DB || path.join(here, 'state', 'runtime.sqlite') } = {}) {
    this.root = path.resolve(root);
    this.database = path.resolve(database);
    this.db = openRuntimeStore(this.database);
    this.token = randomBytes(32).toString('hex');
    this.queue = Promise.resolve();
    this.scanPromise = null;
    this.snapshotPromise = null;
    this.db.prepare("INSERT OR IGNORE INTO roots(path,mode) VALUES (?,'children')").run(this.root);
  }
  event(project, service, action, detail = '') {
    this.db.prepare('INSERT INTO events(project_id,service_id,action,detail,created_at) VALUES (?,?,?,?,?)').run(project, service, action, detail, new Date().toISOString());
  }
  addRoot(directory, mode = 'project') {
    this.db.prepare('INSERT OR REPLACE INTO roots(path,mode) VALUES (?,?)').run(path.resolve(directory), mode);
  }
  async scan() {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.scanNow().finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }
  async scanNow() {
    const roots = this.db.prepare('SELECT * FROM roots ORDER BY path').all();
    const found = new Map();
    const errors = [];
    for (const source of roots) {
      try {
        const projects = source.mode === 'children' ? await discoverProjects(source.path) : [await discoverProject(source.path)];
        for (const project of projects.filter(Boolean)) found.set(project.path, project);
      } catch (error) { errors.push(`${source.path}: ${error.message}`); }
    }
    // A failed scan must not wipe the last usable catalog.
    if (errors.length) throw new Error(`扫描未完成，保留已有目录。${errors.join('；')}`);
    const now = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      this.db.exec('UPDATE projects SET present=0; UPDATE services SET present=0;');
      const projectInsert = this.db.prepare(`INSERT INTO projects(id,name,path,stack,databases,notes,scanned_at,present) VALUES (?,?,?,?,?,?,?,1)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,path=excluded.path,stack=excluded.stack,databases=excluded.databases,notes=excluded.notes,scanned_at=excluded.scanned_at,present=1`);
      const serviceInsert = this.db.prepare(`INSERT INTO services(project_id,id,label,cwd,executable,args,env,port,url,kind,source,available,disabled_reason,dependencies,present)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(project_id,id) DO UPDATE SET label=excluded.label,cwd=excluded.cwd,executable=excluded.executable,args=excluded.args,env=excluded.env,
        port=excluded.port,url=excluded.url,kind=excluded.kind,source=excluded.source,available=excluded.available,disabled_reason=excluded.disabled_reason,dependencies=excluded.dependencies,present=1`);
      for (const project of found.values()) {
        const id = `${path.basename(project.path)}-${createHash('sha256').update(project.path).digest('hex').slice(0, 10)}`;
        projectInsert.run(id, project.name, project.path, JSON.stringify(project.stack || []), JSON.stringify(project.databases || []), JSON.stringify(project.notes || []), now);
        for (const service of project.services) serviceInsert.run(id, service.id, service.label, service.cwd, service.executable || '', JSON.stringify(service.args || []), JSON.stringify(service.env || {}), service.port ?? null,
          service.url ?? null, service.kind, service.source || '', Number(service.available), service.disabledReason || null, JSON.stringify(service.dependencies || []));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.event(null, null, 'scan', `${found.size} 个项目`);
    return { ok: true, count: found.size, scannedAt: now };
  }
  latest(project, service) { return this.db.prepare('SELECT * FROM runs WHERE project_id=? AND service_id=? ORDER BY id DESC LIMIT 1').get(project, service); }
  async context() {
    const [processes, ports] = await Promise.all([processTable(), listeners()]);
    return { processes, ports, cwd: new Map() };
  }
  async serviceState(project, service, context) {
    const run = this.latest(project.id, service.id);
    const owned = ownsWorker(run, context.processes);
    const port = owned ? run.port : service.port;
    const url = owned ? run.url : service.url;
    const portPids = context.ports.get(port) || [];
    const ourPort = owned && portPids.some(pid => context.processes.some(p => p.pid === pid && p.group === run.pid));
    let status = 'stopped';
    let error = run?.error || null;
    if (owned) {
      status = run.status;
      if (status === 'starting' && ourPort) {
        let ready = false;
        try { const response = await fetch(url, { signal: AbortSignal.timeout(1200), redirect: 'manual' }); ready = response.status < 500; await response.body?.cancel(); } catch {}
        if (ready) {
          status = 'running'; error = null;
          this.db.prepare("UPDATE runs SET status='running',error=NULL WHERE id=? AND status='starting'").run(run.id);
        }
      }
      if (status === 'running' && !ourPort) status = 'starting';
      if (status === 'starting' && Date.now() - Date.parse(run.started_at) > 120000) error = '启动超过 2 分钟，服务尚未就绪；请查看日志或停止后重试';
    } else if (run && active.has(run.status) && Date.now() - Date.parse(run.started_at) < 3000) {
      status = 'starting';
    } else if (run && active.has(run.status)) {
      // A second controller can have launched after this request sampled ps.
      if (ownsWorker(run, await processTable())) return this.serviceState(project, service, await this.context());
      status = 'failed'; error = '启动进程已退出或归属失效，请查看日志';
      this.db.prepare("UPDATE runs SET status='failed',error=?,stopped_at=? WHERE id=? AND status IN ('starting','running','stopping')").run(error, new Date().toISOString(), run.id);
    } else if (run?.status === 'failed') status = 'failed';
    if (!owned && portPids.length) {
      let external = false;
      for (const pid of portPids) {
        if (!context.cwd.has(pid)) context.cwd.set(pid, await processCwd(pid));
        const cwd = context.cwd.get(pid);
        const process = context.processes.find(p => p.pid === pid);
        const entry = service.args.find(arg => path.isAbsolute(arg) && !arg.includes('.bin'));
        const knownNext = service.args.some(arg => /next\/dist\/bin\/next$/.test(arg)) && process?.command.includes('next-server');
        const knownEntry = entry && process?.command.includes(entry);
        const knownPython = service.args.includes('http.server') && /\s-m\s+http\.server\s/.test(process?.command || '');
        if ((cwd === service.cwd || cwd.startsWith(`${service.cwd}${path.sep}`)) && (knownEntry || knownNext || knownPython)) external = true;
      }
      status = external ? 'external' : 'conflict';
      error = external ? '已由外部进程启动；总控台不停止外部进程' : `端口 ${port} 已被其他进程占用（PID ${[...new Set(portPids)].join('、')}）`;
    }
    return { ...service, env: {}, port, url, status, pid: owned ? run.pid : (status === 'external' ? portPids[0] : null), startedAt: run?.started_at || null, lastError: error };
  }
  async snapshot() {
    if (this.snapshotPromise) return this.snapshotPromise;
    const next = this.queue.then(() => this.snapshotNow());
    this.queue = next.catch(() => {});
    this.snapshotPromise = next.finally(() => { this.snapshotPromise = null; });
    return this.snapshotPromise;
  }
  async snapshotNow() {
    if (!this.db.prepare('SELECT id FROM projects LIMIT 1').get()) await this.scan();
    const context = await this.context();
    // Keep vanished-but-running services reachable so they can still be stopped.
    const rows = this.db.prepare(`SELECT * FROM projects p WHERE present=1 OR EXISTS(SELECT 1 FROM runs r WHERE r.project_id=p.id AND r.status IN ('starting','running','stopping')) ORDER BY name`).all();
    const projects = [];
    for (const row of rows) {
      const project = { id: row.id, name: row.name, path: row.path, stack: JSON.parse(row.stack), databases: JSON.parse(row.databases), notes: JSON.parse(row.notes), services: [] };
      const services = this.db.prepare(`SELECT * FROM services s WHERE project_id=? AND (present=1 OR EXISTS(SELECT 1 FROM runs r WHERE r.project_id=s.project_id AND r.service_id=s.id AND r.status IN ('starting','running','stopping')))`).all(row.id);
      project.services = await Promise.all(services.map(service => this.serviceState(project, decodeService(service), context)));
      projects.push(project);
    }
    return { projects, root: this.root, roots: this.db.prepare('SELECT path,mode FROM roots').all(), scannedAt: rows.reduce((v,r) => r.scanned_at > v ? r.scanned_at : v, ''), csrfToken: this.token };
  }
  action(project, service, action) {
    const next = this.queue.then(async () => {
      if (!['start', 'stop', 'restart'].includes(action)) throw new Error('不支持的操作');
      if (!this.db.prepare('SELECT id FROM services WHERE project_id=? AND id=?').get(project, service)) throw new Error('服务不存在，请刷新扫描');
      if (action === 'stop' || action === 'restart') await this.stop(project, service, action === 'restart');
      if (action === 'start' || action === 'restart') await this.start(project, service);
      this.event(project, service, action);
      return { ok: true };
    });
    this.queue = next.catch(() => {});
    return next;
  }
  async start(projectId, serviceId, chain = new Set()) {
    const serviceKey = key(projectId, serviceId);
    if (chain.has(serviceKey)) throw new Error('服务依赖存在循环');
    const row = this.db.prepare('SELECT * FROM services WHERE project_id=? AND id=? AND present=1').get(projectId, serviceId);
    if (!row) throw new Error('服务配置已失效，请重新扫描');
    const service = decodeService(row);
    if (!service.available) throw new Error(service.disabledReason || '服务尚未配置');
    const project = this.db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    const actual = await realpath(service.cwd);
    const projectPath = await realpath(project.path);
    if (actual !== projectPath && !actual.startsWith(`${projectPath}${path.sep}`)) throw new Error('启动目录超出项目范围');
    const context = await this.context();
    const state = await this.serviceState(project, service, context);
    const latest = this.latest(projectId, serviceId);
    if (ownsWorker(latest, context.processes)) {
      if (latest.status === 'stopping') throw new Error('服务正在停止，请稍后重试');
      return;
    }
    if (state.status === 'external') throw new Error('服务已在外部运行，请在原终端管理');
    if (latest && active.has(latest.status) && Date.now() - Date.parse(latest.started_at) < 3000) throw new Error('服务正在启动，请稍后查看状态');
    if (context.ports.has(service.port) || await portOccupied(service.port)) throw new Error(`端口 ${service.port} 已占用，请先处理占用的服务`);
    if (!service.port || !Number.isInteger(service.port) || service.port < 1024 || service.port > 65535) throw new Error('缺少有效的本地预览端口');
    const nextChain = new Set(chain).add(serviceKey);
    for (const dependency of service.dependencies) await this.start(projectId, dependency, nextChain);
    const token = randomBytes(24).toString('hex');
    const logDirectory = path.join(path.dirname(this.database), 'runtime-logs');
    await mkdir(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, `${token}.log`);
    const env = { ...service.env, PATH: enrichedPath };
    const result = this.db.prepare(`INSERT INTO runs(project_id,service_id,token,status,started_at,log_path,cwd,executable,args,env,port,url) VALUES (?,?,?,'starting',?,?,?,?,?,?,?,?)`)
      .run(projectId, serviceId, token, new Date().toISOString(), logPath, service.cwd, service.executable, JSON.stringify(service.args), JSON.stringify(env), service.port, service.url);
    const id = Number(result.lastInsertRowid);
    const child = spawn(process.execPath, [worker, this.database, String(id), token], { detached: true, stdio: 'ignore', env: { ...process.env, PATH: enrichedPath } });
    child.on('error', error => this.db.prepare("UPDATE runs SET status='failed',error=? WHERE id=?").run(error.message, id));
    if (child.pid) this.db.prepare('UPDATE runs SET pid=? WHERE id=?').run(child.pid, id);
    child.unref();
    await wait(120);
  }
  async stop(projectId, serviceId, allowStopped = false) {
    const run = this.latest(projectId, serviceId);
    const processes = await processTable();
    if (!ownsWorker(run, processes)) {
      if (allowStopped && (!run || !active.has(run.status))) return;
      throw new Error('没有可安全停止的受管进程；外部启动的服务请在原终端停止');
    }
    this.db.prepare("UPDATE runs SET status='stopping' WHERE id=?").run(run.id);
    process.kill(-run.pid, 'SIGTERM');
    for (let i = 0; i < 20; i++) {
      await wait(200);
      if (!ownsWorker(run, await processTable())) break;
    }
    if (ownsWorker(run, await processTable())) process.kill(-run.pid, 'SIGKILL');
    for (let i = 0; i < 20; i++) {
      if (!(await processTable()).some(p => p.group === run.pid)) break;
      await wait(100);
    }
    if ((await processTable()).some(p => p.group === run.pid)) throw new Error('进程尚未完全退出，请查看日志后重试');
    this.db.prepare("UPDATE runs SET status='stopped',stopped_at=?,error=NULL WHERE id=?").run(new Date().toISOString(), run.id);
  }
  async logs(projectId, serviceId) {
    const run = this.latest(projectId, serviceId);
    if (!run) return { logs: '尚未由总控台启动，没有运行日志。' };
    let handle;
    try {
      handle = await open(run.log_path, 'r');
      const { size } = await handle.stat();
      const start = Math.max(0, size - 64 * 1024);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return { logs: `${start ? '（仅显示最近 64 KB）\n' : ''}${buffer.toString('utf8')}` };
    } catch { return { logs: '正在创建日志，请稍后刷新。' }; }
    finally { await handle?.close(); }
  }
}
