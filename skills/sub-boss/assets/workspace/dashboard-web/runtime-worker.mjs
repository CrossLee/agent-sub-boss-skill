// A detached supervisor keeps process ownership and logs across dashboard restarts.
import { spawn } from 'node:child_process';
import { appendFileSync, statSync, renameSync } from 'node:fs';
import { openRuntimeStore } from './runtime-store.mjs';

const [database, id, token] = process.argv.slice(2);
const db = openRuntimeStore(database);
const run = db.prepare('SELECT * FROM runs WHERE id=? AND token=?').get(Number(id), token);
if (!run || run.status !== 'starting') process.exit(1);
db.prepare('UPDATE runs SET pid=? WHERE id=?').run(process.pid, run.id);
let stopping = false;
let finished = false;
function log(value) {
  const text = String(value).replace(/(authorization\s*[=:]\s*)[^\r\n]+/gi, '$1[已隐藏]')
    .replace(/(\b(?:password|secret|access_token|api_key)\s*[=:]\s*)([^\s,;]+)/gi, '$1[已隐藏]');
  try {
    if (statSync(run.log_path).size > 2 * 1024 * 1024) renameSync(run.log_path, `${run.log_path}.1`);
  } catch {}
  try { appendFileSync(run.log_path, text, { mode: 0o600 }); } catch { /* Disk failure must not orphan children. */ }
}
log(`\n[${new Date().toISOString()}] 启动 ${run.executable} ${JSON.parse(run.args).join(' ')}\n工作目录: ${run.cwd}\n`);
const child = spawn(run.executable, JSON.parse(run.args), {
  cwd: run.cwd, env: { ...process.env, ...JSON.parse(run.env), BROWSER: 'none' },
  stdio: ['ignore', 'pipe', 'pipe'], shell: false,
});
function capture(stream) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    const end = pending.lastIndexOf('\n');
    if (end >= 0) { log(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
    if (pending.length > 65536) { log('[单行日志超过长度限制，已省略]\n'); pending = ''; }
  });
  stream.on('end', () => { if (pending) log(pending); });
}
capture(child.stdout);
capture(child.stderr);
async function finish(error, code) {
  if (finished) return;
  finished = true;
  const status = stopping ? 'stopped' : 'failed';
  const message = stopping ? null : error || `启动命令已退出（退出码 ${code ?? '未知'}），请查看日志`;
  // Keep the token-bearing supervisor alive until its entire process group is
  // terminated. A launcher may exit before its grandchildren do.
  try { process.kill(-process.pid, 'SIGTERM'); } catch {}
  await new Promise(resolve => setTimeout(resolve, 650));
  log(`\n[${new Date().toISOString()}] ${message || '服务已停止'}\n`);
  try {
    db.prepare('UPDATE runs SET status=?,stopped_at=?,error=?,exit_code=? WHERE id=?').run(status, new Date().toISOString(), message, code ?? null, run.id);
  } finally {
    // Database or disk errors must never prevent process-group cleanup.
    try { db.close(); } finally { process.kill(-process.pid, 'SIGKILL'); }
  }
}
child.once('error', error => finish(error.message, null));
child.once('exit', code => finish(null, code));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (finished) return;
  stopping = true;
  try { db.prepare("UPDATE runs SET status='stopping' WHERE id=?").run(run.id); } catch {}
  child.kill(signal);
  // The controller signals this entire process group and escalates if necessary.
});
