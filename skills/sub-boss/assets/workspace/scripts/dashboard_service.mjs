#!/usr/bin/env node
import { readFile, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import net from 'node:net';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = path.join(workspace, '.subboss');
const pidFile = path.join(state, 'dashboard-process.json');
const server = path.join(workspace, 'dashboard-web/server.mjs');
const exec = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function json(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
async function owned(record) {
  if (!Number.isInteger(record?.pid) || record.pid <= 1 || !/^[a-f0-9]{48}$/.test(record.token || '')) return false;
  try {
    const { stdout } = await exec('ps', ['-p', String(record.pid), '-o', 'args=']);
    return stdout.includes(server) && stdout.includes(`--subboss-owner=${record.token}`);
  } catch { return false; }
}
async function health(port, token) {
  try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
    const body = await response.json(); return response.ok && body.ok && body.instanceToken === token;
  } catch { return false; }
}
async function available(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`端口 ${port} 已被占用，请修改 .subboss/config.json 中的 port。`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
async function main() {
  if (process.platform === 'win32') throw new Error('本版本的进程管理支持 macOS/Linux，尚不支持 Windows。');
  const command = process.argv[2] || 'start';
  if (!['start', 'stop'].includes(command)) throw new Error('用法：node scripts/dashboard_service.mjs start|stop');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const lock = await open(path.join(state, 'service.lock'), 'wx').catch(() => { throw new Error('另一个启停操作正在执行。如上次操作异常中断，确认无启停操作后删除 .subboss/service.lock。'); });
  try {
    const record = await json(pidFile, null);
    if (command === 'stop') {
      if (await owned(record)) {
        process.kill(record.pid, 'SIGTERM');
        for (let i = 0; i < 30 && await owned(record); i++) await wait(100);
        if (await owned(record)) throw new Error('看板尚未退出；未强制停止，请检查日志。');
      }
      await unlink(pidFile).catch(e => { if (e.code !== 'ENOENT') throw e; });
      console.log('看板已停止；独立启动的项目服务保持运行。');
      return;
    }
    if (await owned(record)) {
      if (!await health(record.port, record.token)) throw new Error('已有看板进程尚未就绪，请查看 .subboss/dashboard.log。');
      console.log(`http://127.0.0.1:${record.port}`); return;
    }
    const config = await json(path.join(state, 'config.json'), {});
    const port = Number(process.env.SUBBOSS_DASHBOARD_PORT || config.port || 4317);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须在 1024–65535 之间。');
    await available(port);
    const token = randomBytes(24).toString('hex');
    const log = await open(path.join(state, 'dashboard.log'), 'a', 0o600);
    const child = spawn(process.execPath, [server, `--subboss-owner=${token}`], {
      cwd: workspace, detached: true, stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, SUBBOSS_DASHBOARD_HOST: '127.0.0.1', SUBBOSS_DASHBOARD_PORT: String(port),
        SUBBOSS_PROJECT_ROOT: process.env.SUBBOSS_PROJECT_ROOT || config.projectRoot || path.dirname(workspace),
        SUBBOSS_CODEX_CATALOG: process.env.SUBBOSS_CODEX_CATALOG || (config.includeCodexCatalog ? '1' : '0'),
        SUBBOSS_INSTANCE_TOKEN: token },
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await log.close(); child.unref();
    const next = { pid: child.pid, token, port };
    await writeFile(pidFile, JSON.stringify(next), { mode: 0o600 });
    for (let i = 0; i < 50; i++) {
      if (await health(port, token)) { console.log(`http://127.0.0.1:${port}`); return; }
      if (!await owned(next)) break;
      await wait(100);
    }
    if (await owned(next)) process.kill(next.pid, 'SIGTERM');
    throw new Error('看板启动失败，请查看 .subboss/dashboard.log。');
  } finally { await lock.close(); await unlink(path.join(state, 'service.lock')); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
