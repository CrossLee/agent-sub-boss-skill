import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const workspaceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Discovery is read-only. It never sources .env files, executes a project's
// scripts, downloads dependencies, builds, seeds, migrates or deploys anything.
const SKIP = new Set(['node_modules', 'vendor', 'venv', '__pycache__', 'pods', 'build', 'dist', 'out', 'outputs', 'exports', 'coverage', 'deriveddata', 'screenshots', 'assets', 'uploads', 'backups', 'data', 'tmp']);
const FRAMEWORKS = { next: 'Next.js', vite: 'Vite', vinext: 'Vinext', react: 'React', vue: 'Vue', svelte: 'Svelte', nuxt: 'Nuxt', astro: 'Astro', express: 'Express', electron: 'Electron', hexo: 'Hexo', typescript: 'TypeScript', 'react-native': 'React Native' };
const DB_DEPS = { 'better-sqlite3': 'SQLite', sqlite3: 'SQLite', 'sql.js': 'SQLite', mysql2: 'MySQL', mysql: 'MySQL', pg: 'PostgreSQL', postgres: 'PostgreSQL', mongodb: 'MongoDB', mongoose: 'MongoDB', redis: 'Redis', ioredis: 'Redis', '@supabase/supabase-js': 'Supabase / PostgreSQL' };
const JS = /\.(?:[cm]?[jt]sx?|py|swift)$/;

async function textFile(file, limit = 100_000) {
  try { const stat = await fs.stat(file); return stat.isFile() && stat.size <= limit ? await fs.readFile(file, 'utf8') : ''; } catch { return ''; }
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function jsonFile(file) { try { return JSON.parse(await textFile(file)); } catch { return null; } }
async function dirs(directory) { try { return (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); } catch { return []; } }
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/') || '.';
const stableId = (root, cwd, suffix = '') => `${relative(root, cwd) === '.' ? 'root' : relative(root, cwd).replace(/[^\w-]+/g, '-')}${suffix}`;
const stablePort = (root, cwd, suffix = '') => 40000 + createHash('sha256').update(`${root}:${relative(root, cwd)}:${suffix}`).digest().readUInt32BE(0) % 15000;
const validPort = value => Number.isInteger(Number(value)) && Number(value) > 1023 && Number(value) < 65536 ? Number(value) : null;

async function inventory(root, maxDepth = 4) {
  const files = [];
  let visited = 0;
  async function walk(dir, depth) {
    if (++visited > 650) return;
    for (const entry of await dirs(dir)) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name.toLowerCase())) continue;
      const full = path.join(dir, entry.name);
      // Symlinks cannot lead discovery out of the selected project.
      if (entry.isDirectory() && depth < maxDepth) await walk(full, depth + 1);
      else if (entry.isFile() && files.length < 4000) files.push(full);
    }
  }
  await walk(root, 0);
  return files;
}

async function resolveBin(cwd, root, name) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '.bin', name);
    if (await exists(candidate)) {
      try { return await fs.realpath(candidate); } catch { return candidate; }
    }
    if (dir === root || path.dirname(dir) === dir || !dir.startsWith(root + path.sep)) break;
  }
  return null;
}

async function installedHyperframes(cwd, root, requestedVersion, options) {
  const candidates = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    candidates.push({ dir: path.join(dir, 'node_modules/hyperframes'), origin: '项目依赖' });
    if (dir === root || path.dirname(dir) === dir || !dir.startsWith(root + path.sep)) break;
  }
  // Without a pinned version, only the project's own dependency is trustworthy.
  if (requestedVersion) {
    const cache = options.npmCacheDir ?? process.env.npm_config_cache ?? path.join(os.homedir(), '.npm');
    for (const entry of (await dirs(path.join(cache, '_npx'))).slice(0, 300)) {
      if (entry.isDirectory()) candidates.push({ dir: path.join(cache, '_npx', entry.name, 'node_modules/hyperframes'), origin: '本机 npx 缓存' });
    }
    const globals = options.globalNodeModules ?? [path.resolve(path.dirname(process.execPath), '../lib/node_modules'), '/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules'];
    for (const directory of globals) candidates.push({ dir: path.join(directory, 'hyperframes'), origin: '全局已安装依赖' });
  }
  for (const candidate of candidates) {
    const pkg = await jsonFile(path.join(candidate.dir, 'package.json'));
    if (pkg?.name !== 'hyperframes' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version || '') || (requestedVersion && pkg.version !== requestedVersion)) continue;
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.hyperframes;
    if (!bin) continue;
    const executable = path.resolve(candidate.dir, bin);
    if (!executable.startsWith(candidate.dir + path.sep) || !/\.[cm]?js$/.test(executable) || !await exists(executable) || !await exists(path.join(candidate.dir, 'dist/studio/index.html'))) continue;
    // Audit options from the installed source without running CLI help (which
    // can itself initialize telemetry or schedule an automatic installation).
    const main = await textFile(path.join(candidate.dir, 'dist/cli.js'), 30_000_000);
    const chunkName = main.match(/import\(["']\.\/(preview-[\w-]+\.js)["']\)/)?.[1];
    const preview = chunkName ? await textFile(path.join(candidate.dir, 'dist', chunkName), 2_000_000) : main;
    const begin = preview.indexOf('preview_default = defineCommand(');
    const block = begin < 0 ? '' : preview.slice(begin, preview.indexOf('async run(', begin));
    if (!/\bport\s*:\s*\{/.test(block) || !/\bopen\s*:\s*\{/.test(block) || !/["']force-new["']\s*:/.test(block)) continue;
    let hostSupported = main.includes('HYPERFRAMES_PREVIEW_HOST');
    if (!hostSupported) {
      const imports = [...preview.matchAll(/from\s+["']\.\/(chunk-[\w-]+\.js)["']/g)].map(m => m[1]);
      for (const file of imports) {
        if ((await textFile(path.join(candidate.dir, 'dist', file), 2_000_000)).includes('HYPERFRAMES_PREVIEW_HOST')) { hostSupported = true; break; }
      }
    }
    if (!hostSupported) continue;
    try {
      // This alternate mode shells out to npx vite and links project folders.
      // Keep cached previews on the verified embedded Studio path instead.
      createRequire(path.join(cwd, 'package.json')).resolve('@hyperframes/studio/package.json');
      return { disabledReason: '项目存在独立 @hyperframes/studio，会切换至 npx 启动流程；请使用项目自己的预览入口' };
    } catch { /* The packaged embedded Studio is the normal installed mode. */ }
    return { executable, version: pkg.version, origin: candidate.origin, foreground: /\bforeground\s*:\s*\{/.test(block) };
  }
  return null;
}

async function pythonFor(cwd, root) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    for (const name of ['.venv/bin/python', '.venv/bin/python3', 'venv/bin/python', 'venv/bin/python3']) {
      const executable = path.join(dir, name);
      if (await exists(executable)) return { executable, venv: path.dirname(path.dirname(executable)) };
    }
    if (dir === root || path.dirname(dir) === dir || !dir.startsWith(root + path.sep)) break;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const executable = path.join(dir, 'python3');
    if (await exists(executable)) return { executable, venv: null };
  }
  return { executable: 'python3', venv: null, missing: true };
}

function explicitPort(script, config = '') {
  return validPort(script.match(/(?:--port(?:=|\s+)|-p\s+)(\d+)/)?.[1])
    || validPort(script.match(/\bPORT=(\d+)\b/)?.[1])
    || validPort(config.match(/\bport\s*:\s*(\d+)/)?.[1]);
}
function localPorts(source) {
  return [...source.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/g)].map(m => validPort(m[1])).filter(Boolean);
}

function parseDevCommand(script) {
  // We construct an allowlisted binary invocation instead of trusting npm
  // lifecycle hooks, shell chains, substitution or arbitrary "dev" scripts.
  let remaining = script.trim();
  const env = {};
  while (/^[A-Z_][A-Z0-9_]*=/.test(remaining)) {
    const match = remaining.match(/^([A-Z_][A-Z0-9_]*)=([^\s;&|`$<>]+)\s+/);
    if (!match) return null;
    if (['WRANGLER_LOG_PATH', 'WRANGLER_WRITE_LOGS', 'MINIFLARE_REGISTRY_PATH', 'PORT', 'HOST', 'NODE_ENV'].includes(match[1])) env[match[1]] = match[2];
    else return null;
    remaining = remaining.slice(match[0].length);
  }
  if (/[;&|`$<>\n\r]/.test(remaining)) return null;
  const tokens = remaining.split(/\s+/);
  const bin = tokens.shift();
  if (!['next', 'vite', 'vinext', 'astro', 'nuxt', 'hexo'].includes(bin)) return null;
  if (bin === 'vite') {
    if (tokens[0] && !tokens[0].startsWith('-') && tokens[0] !== 'dev') return null;
    if (tokens[0] === 'dev') tokens.shift();
  } else if (tokens.shift() !== (bin === 'hexo' ? 'server' : 'dev')) return null;
  // Preserve only known harmless development options. Ignore host/port here;
  // they are replaced below so every listener stays on the loopback interface.
  const kept = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (['--port', '-p', '--host', '--hostname', '-H', '--ip'].includes(t)) { i++; continue; }
    if (/^--(?:port|host|hostname|ip)=/.test(t)) continue;
    if (['--webpack', '--turbo', '--turbopack', '--strictPort'].includes(t)) { kept.push(t); continue; }
    return null;
  }
  return { bin, kept, env };
}

function service(root, cwd, fields) {
  return { id: stableId(root, cwd), label: relative(root, cwd) === '.' ? '网站预览' : relative(root, cwd), cwd, executable: '', args: [], env: {}, port: null, url: null, kind: 'web', source: '', available: false, disabledReason: null, ...fields };
}

async function databaseEvidence(root, files, docs, dependencies, databases) {
  for (const [name, db] of Object.entries(DB_DEPS)) if (dependencies.has(name)) databases.add(db);
  // Source-level evidence is preferred over README mentions of planned stores.
  const candidates = files.filter(file => JS.test(file) && /(?:database|schema|storage|sqlite|db\.|db\/|store\.|store\/|server\/)/i.test(relative(root, file))).slice(0, 100);
  // Common monorepo libraries sit below the manifest scan depth.
  for (const folder of ['apps/web/src/lib', 'app/apps/web/src/lib', 'app-prototype/apps/web/src/lib', 'src/lib']) {
    for (const entry of await dirs(path.join(root, folder))) {
      if (entry.isFile() && JS.test(entry.name) && /db|sqlite|storage|store/i.test(entry.name)) candidates.push(path.join(root, folder, entry.name));
      if (entry.isDirectory() && /db|storage|store/i.test(entry.name)) {
        for (const f of await dirs(path.join(root, folder, entry.name))) if (f.isFile() && JS.test(f.name)) candidates.push(path.join(root, folder, entry.name, f.name));
      }
    }
  }
  for (const file of [...new Set(candidates)].slice(0, 150)) {
    const content = await textFile(file, 160_000);
    if (/node:sqlite|(?:from|import)\s+sqlite3|better-sqlite3|sqlite3\.connect|import SQLite3/.test(content)) databases.add('SQLite');
    if (/from\s+['"]mysql2|require\(['"]mysql2/.test(content)) databases.add('MySQL');
    if (/from\s+['"]drizzle-orm\/pg-core['"]/.test(content) && /\bpgTable\s*\(/.test(content)) databases.add('PostgreSQL');
    if (/from\s+['"]drizzle-orm\/sqlite-core['"]/.test(content) && /\bsqliteTable\s*\(/.test(content)) databases.add('SQLite');
    if (/from\s+['"]drizzle-orm\/mysql-core['"]/.test(content) && /\bmysqlTable\s*\(/.test(content)) databases.add('MySQL');
  }
  if (!databases.size && /(?:本地\s*SQLite|SQLite\s*(?:数据库|业务数据)|data\/[^\s`]+\.sqlite)/i.test(docs)) databases.add('SQLite');
}

/** Inspect one directory. Never starts processes or reads environment secrets. */
export async function discoverProject(projectPath, options = {}) {
  const root = path.resolve(projectPath);
  const id = path.basename(root);
  const project = { id, name: id, path: root, stack: [], databases: [], notes: [], services: [] };
  if (!(await exists(root))) { project.notes.push('项目目录不存在或不可读取'); return project; }
  const files = await inventory(root, Math.min(options.maxDepth ?? 4, 5));
  const [readme, status, config] = await Promise.all([textFile(path.join(root, 'README.md')), textFile(path.join(root, 'PROJECT_STATUS.md')), jsonFile(path.join(root, 'project.config.json'))]);
  const docs = `${status}\n${readme}`;
  const stack = new Set();
  const databases = new Set();
  const dependencies = new Set();
  const manifests = [];
  const native = /native-ios|native-macos|swiftui/i.test(config?.stack || '') || files.some(file => /\.swift$|\.xcodeproj\/project\.pbxproj$/.test(file));
  const scaffoldWeb = native && !/\bNext\.js\s*\+\s*(?:MySQL|SQLite)/.test(readme.slice(0, 3000));
  if (native) { stack.add('Swift / SwiftUI'); project.notes.push('原生应用需 Xcode 或已安装的 App；网页预览不代表原生应用运行'); }
  if (files.some(file => /(?:^|\/)(?:wxmini|dymini|miniapp|miniprogram)\//.test(relative(root, file)))) { stack.add('小程序'); project.notes.push('小程序页面需在对应开发者工具打开'); }
  if (files.some(file => file.endsWith('/requirements.txt') || file.endsWith('/pyproject.toml'))) stack.add('Python');

  // Detect actual local API references in mini-program code, not README samples.
  const miniPorts = [];
  for (const file of files.filter(file => /\/wxmini\/.*\.(?:js|ts)$/.test(file) && /config|request|api|env|app\.js/.test(file)).slice(0, 30)) miniPorts.push(...localPorts(await textFile(file)));
  // Page-level Mini Program API modules can sit just beyond the general scan.
  for (const page of (await dirs(path.join(root, 'apps/wxmini/pages'))).slice(0, 80)) {
    if (!page.isDirectory() || page.name.startsWith('.')) continue;
    for (const entry of (await dirs(path.join(root, 'apps/wxmini/pages', page.name))).slice(0, 80)) {
      if (entry.isFile() && /^(?:api|request|config)\.(?:js|ts)$/.test(entry.name)) {
        miniPorts.push(...localPorts(await textFile(path.join(root, 'apps/wxmini/pages', page.name, entry.name))));
      }
    }
  }
  const miniPort = miniPorts.length && new Set(miniPorts).size === 1 ? miniPorts[0] : null;

  for (const file of files.filter(file => path.basename(file) === 'package.json')) {
    const pkg = await jsonFile(file);
    if (!pkg) continue;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const dep of Object.keys(deps)) { dependencies.add(dep); if (FRAMEWORKS[dep]) stack.add(FRAMEWORKS[dep]); }
    manifests.push({ file, cwd: path.dirname(file), pkg, deps });
  }
  if (manifests.length) stack.add('Node.js');
  for (const { file, cwd, pkg, deps } of manifests) {
    const scripts = pkg.scripts || {};
    const staticScript = Object.entries(scripts).find(([key, value]) => /^(?:preview|serve|start)$/.test(key) && /^python3?\s+-m\s+http\.server\s+\d+\b/.test(value));
    if (staticScript) {
      const match = staticScript[1].match(/^python3?\s+-m\s+http\.server\s+(\d+)(?:\s+--bind\s+(?:127\.0\.0\.1|localhost))?\s+(?:--directory|-d)\s+([\w./-]+)\s*$/);
      if (match) {
        const folder = path.resolve(cwd, match[2]);
        if (folder === root || folder.startsWith(root + path.sep)) {
          const python = await pythonFor(cwd, root);
          const port = validPort(match[1]) || stablePort(root, cwd);
          const hasBuild = await exists(path.join(folder, 'index.html'));
          project.services.push(service(root, cwd, { id: stableId(root, cwd, '-static'), label: cwd === root ? '静态网页' : `${relative(root, cwd)} · 静态网页`, executable: python.executable, args: ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', folder], port, url: `http://127.0.0.1:${port}/`, kind: 'static', source: `${relative(root, file)} → ${staticScript[0]}`, available: hasBuild && !python.missing, disabledReason: !hasBuild ? '静态构建目录缺少 index.html；请先在项目中构建' : python.missing ? '未找到 Python 3' : null }));
          stack.add('HTML / CSS / JavaScript');
          if (/IndexedDB/i.test(await textFile(path.join(cwd, 'README.md')))) databases.add('IndexedDB（浏览器本地）');
          continue;
        }
      }
    }
    if (scripts.studio && /^remotion studio\s+[\w./-]+(?:\s+--port(?:=|\s)\d+)?\s*$/.test(scripts.studio)) {
      stack.add('Remotion');
      const binary = await resolveBin(cwd, root, 'remotion');
      const entry = scripts.studio.split(/\s+/)[2];
      const port = explicitPort(scripts.studio) || stablePort(root, cwd);
      project.services.push(service(root, cwd, { executable: process.execPath, args: [binary || path.join(cwd, 'node_modules/.bin/remotion'), 'studio', entry, `--port=${port}`, '--no-open'], port, url: `http://127.0.0.1:${port}`, kind: 'tool', source: `${relative(root, file)} → studio`, available: Boolean(binary), disabledReason: binary ? null : '未安装 Remotion CLI 依赖' }));
      project.notes.push(`${relative(root, cwd)} 的 Remotion Studio 沿用工具默认网络监听，局域网设备也可能访问端口 ${port}`);
      continue;
    }
    const scriptKey = scripts.dev ? 'dev' : deps.hexo && scripts.server ? 'server' : /^node\s+((?:[\w-]+\/)*(?:server|index|main)\.(?:mjs|cjs|js))\s*$/.test(scripts.start || '') ? 'start' : null;
    const script = scriptKey ? scripts[scriptKey] : null;
    if (!script) continue;
    if (/electron-vite|electron\s/.test(script)) { project.notes.push(`${relative(root, cwd)} 是 Electron 桌面应用，需桌面启动流程`); continue; }
    const hyperframes = script.match(/^(?:npx\s+(?:--yes\s+)?)?hyperframes(?:@(\d+\.\d+\.\d+(?:-[\w.-]+)?))?\s+preview\s*$/);
    if (hyperframes) {
      stack.add('HyperFrames');
      const installed = await installedHyperframes(cwd, root, hyperframes[1], options);
      const available = Boolean(installed?.executable);
      const port = available ? stablePort(root, cwd, 'hyperframes') : null;
      project.services.push(service(root, cwd, { label: cwd === root ? '视频预览' : `${relative(root, cwd)} · 视频预览`, executable: available ? process.execPath : '', args: available ? [installed.executable, 'preview', '--port', String(port), '--no-open', '--force-new', ...(installed.foreground ? ['--foreground'] : [])] : [], env: available ? { HYPERFRAMES_PREVIEW_HOST: '127.0.0.1', HYPERFRAMES_NO_UPDATE_CHECK: '1', HYPERFRAMES_NO_AUTO_INSTALL: '1' } : {}, port, url: port ? `http://127.0.0.1:${port}` : null, kind: 'tool', source: `${relative(root, file)} → dev${available ? `；${installed.origin} hyperframes@${installed.version}（直接执行，禁用自动安装与更新）` : ''}`, available, disabledReason: installed?.disabledReason || (available ? null : `未找到可用的 HyperFrames ${hyperframes[1] || '项目固定版本'} 已安装依赖或精确版本缓存；未自动下载`) }));
      continue;
    }
    const nodeServer = script.match(/^node\s+((?:[\w-]+\/)*(?:server|index|main)\.(?:mjs|cjs|js))\s*$/);
    if (nodeServer) {
      const target = path.join(cwd, nodeServer[1]);
      const content = await textFile(target, 500_000);
      const hasListener = /\.(?:listen)\s*\(/.test(content);
      const loopback = /\.listen\s*\([^,]+,\s*['"](?:127\.0\.0\.1|localhost)['"]/.test(content);
      const suspicious = /child_process|\b(?:execSync|spawnSync|execFile|spawn)\s*\(/.test(content);
      const installed = !Object.keys(deps).length || await exists(path.join(cwd, 'node_modules'));
      const port = validPort(content.match(/process\.env\.PORT\s*\|\|\s*['"]?(\d+)/)?.[1]) || stablePort(root, cwd);
      const ready = hasListener && !suspicious && installed;
      project.services.push(service(root, cwd, { executable: process.execPath, args: [target], env: { PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development' }, port, url: `http://127.0.0.1:${port}`, source: `${relative(root, file)} → ${scriptKey}；已检查 ${nodeServer[1]} 的监听设置`, available: ready, disabledReason: !hasListener ? '未确认 HTTP 监听入口' : suspicious ? '入口包含子进程逻辑，需人工确认启动过程' : !installed ? '项目依赖未安装' : null }));
      if (!loopback) project.notes.push(`${relative(root, cwd)} 沿用项目的网络监听设置，未显式限制为本机地址；局域网设备也可能访问端口 ${port}`);
      stack.add(deps.express ? 'Express' : 'Node.js HTTP');
      if (/\.sqlite\b|node:sqlite/.test(content)) databases.add('SQLite');
      else if (/\.json['"]/.test(content) && /JSON\.parse/.test(content)) databases.add('JSON 文件（非关系数据库）');
      continue;
    }
    const parsed = parseDevCommand(script);
    if (!parsed) {
      if (!/^(?:npm|pnpm|yarn)\s/.test(script)) project.notes.push(`${relative(root, file)} 的 dev 命令需人工确认，未自动执行`);
      continue;
    }
    const configFiles = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'next.config.ts', 'next.config.js', 'next.config.mjs', 'astro.config.mjs', 'nuxt.config.ts'];
    const configText = (await Promise.all(configFiles.map(name => textFile(path.join(cwd, name))))).join('\n');
    const proxyPorts = /proxy|rewrites/.test(configText) ? [...new Set(localPorts(configText))] : [];
    const port = explicitPort(script, configText) || ((parsed.bin === 'next' && /(?:^|\/)apps\/web$/.test(relative(root, cwd))) ? miniPort : null) || stablePort(root, cwd);
    const binary = await resolveBin(cwd, root, parsed.bin);
    let args;
    if (parsed.bin === 'next' || parsed.bin === 'vinext') args = ['dev', ...parsed.kept, '--hostname', '127.0.0.1', '--port', String(port)];
    else if (parsed.bin === 'hexo') args = ['server', '--ip', '127.0.0.1', '--port', String(port)];
    else args = [...(parsed.bin === 'vite' ? [] : ['dev']), ...parsed.kept.filter(x => x !== '--strictPort'), '--host', '127.0.0.1', '--port', String(port), ...(['vite', 'vinext'].includes(parsed.bin) ? ['--strictPort'] : [])];
    const placeholder = scaffoldWeb && /(?:^|\/)apps\/web$/.test(relative(root, cwd));
    const item = service(root, cwd, { executable: process.execPath, args: [binary || path.join(cwd, 'node_modules/.bin', parsed.bin), ...args], env: { ...parsed.env, HOST: '127.0.0.1', PORT: String(port) }, port, url: `http://127.0.0.1:${port}`, source: `${relative(root, file)} → ${deps.vinext ? 'vinext' : parsed.bin} dev（固定本机地址；跳过 npm 生命周期钩子）`, available: Boolean(binary) && !placeholder, disabledReason: placeholder ? '保留的 Web 骨架，正式产品是原生应用' : binary ? null : `未找到已安装的 ${parsed.bin} 依赖；请先在项目中安装依赖` });
    if (placeholder) item.label += '（原生项目骨架）';
    if (miniPort && port === miniPort) project.notes.push(`${item.label} 沿用小程序代码中的端口 ${port}；其他同端口项目不能同时启动`);
    if (proxyPorts.length) { item.proxyPorts = proxyPorts; project.notes.push(`${item.label} 依赖本机 API 端口 ${proxyPorts.join('、')}`); }
    if (deps.vinext || deps['@cloudflare/vite-plugin']) {
      const hosting = await jsonFile(path.join(cwd, '.openai/hosting.json'));
      if (hosting?.d1) databases.add('Cloudflare D1 / SQLite');
      stack.add('Cloudflare Workers');
    }
    project.services.push(item);
  }

  // Uvicorn entrypoints are derived from checked-in README/start scripts and
  // verified against a Python module. Only a direct uvicorn invocation runs.
  const launchSources = [readme];
  for (const file of files.filter(file => /(?:^|\/)(?:start|dev|run)[^/]*\.(?:sh|command)$/.test(relative(root, file))).slice(0, 10)) launchSources.push(await textFile(file));
  const pythonEntries = new Map();
  for (const source of launchSources) {
    for (const match of source.matchAll(/(?:-m\s+)?uvicorn\s+([\w.]+):([\w]+)([^\n`]*)(?:\n|$)/g)) {
      const module = path.join(root, ...match[1].split('.')) + '.py';
      if (!await exists(module)) continue;
      const port = explicitPort(match[3]) || 8000;
      const key = `${match[1]}:${match[2]}`;
      if (!pythonEntries.has(key)) pythonEntries.set(key, { entry: key, port, module });
    }
  }
  if (!pythonEntries.size) {
    for (const name of ['server/main.py', 'backend/main.py', 'app/main.py', 'main.py']) {
      const content = await textFile(path.join(root, name));
      if (/\bapp\s*=\s*FastAPI\(/.test(content)) pythonEntries.set(name, { entry: `${name.slice(0, -3).replaceAll('/', '.')}:app`, port: 8000, module: path.join(root, name) });
    }
  }
  for (const entry of pythonEntries.values()) {
    stack.add('FastAPI');
    const python = await pythonFor(root, root);
    const proxy = project.services.flatMap(s => s.proxyPorts || []);
    const port = proxy.includes(entry.port) ? entry.port : proxy.length === 1 ? proxy[0] : entry.port;
    const venvFiles = python.venv ? await dirs(path.join(python.venv, 'lib')) : [];
    let installed = false;
    for (const entry of venvFiles) if (entry.name.startsWith('python') && await exists(path.join(python.venv, 'lib', entry.name, 'site-packages', 'uvicorn'))) installed = true;
    const s = service(root, root, { id: `api-${entry.entry.replace(/[^\w-]+/g, '-')}`, label: '后端 API', executable: python.executable, args: ['-m', 'uvicorn', entry.entry, '--host', '127.0.0.1', '--port', String(port)], port, url: `http://127.0.0.1:${port}/docs`, kind: 'api', source: `${relative(root, entry.module)} + README / 启动脚本`, available: installed, disabledReason: installed ? null : '未在项目虚拟环境中找到 uvicorn；请先准备项目 Python 依赖' });
    project.services.unshift(s);
  }
  for (const s of project.services) {
    if (s.proxyPorts?.length) s.dependencies = project.services.filter(api => api.kind === 'api' && s.proxyPorts.includes(api.port)).map(api => api.id);
    delete s.proxyPorts;
  }

  // Standalone HTML gets a local static server only when no package owns it.
  // A Vite source index.html is not a usable static build.
  const html = files.filter(file => /\.html?$/.test(file) && relative(root, file).split('/').length <= 3);
  const staticDirs = new Map();
  for (const file of html) {
    const dir = path.dirname(file);
    if (manifests.some(m => dir === m.cwd || dir.startsWith(m.cwd + path.sep))) continue;
    if (relative(root, file).split('/').some(part => ['tests', 'test', 'fixtures', 'docs', 'designs'].includes(part.toLowerCase()))) continue;
    const content = await textFile(file, 2_000_000);
    if (!content || /(?:src|href)=["'][^"']*\.(?:tsx|jsx)["']/.test(content)) continue;
    const previous = staticDirs.get(dir);
    if (!previous || path.basename(file) === 'index.html') staticDirs.set(dir, file);
  }
  // One service for a static root can reach its child pages.
  for (const [dir, file] of [...staticDirs].sort((a, b) => a[0].length - b[0].length)) {
    if (project.services.some(s => s.kind === 'static' && dir.startsWith(s.cwd + path.sep))) continue;
    if (project.services.filter(s => s.kind === 'static').length >= 12) break;
    const python = await pythonFor(root, root);
    const port = stablePort(root, dir, 'static');
    const page = path.basename(file) === 'index.html' ? '' : encodeURIComponent(path.basename(file));
    project.services.push(service(root, dir, { id: stableId(root, dir, '-static'), label: dir === root ? '静态网页' : `${relative(root, dir)} · 静态网页`, executable: python.executable, args: ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', dir], port, url: `http://127.0.0.1:${port}/${page}`, kind: 'static', source: relative(root, file), available: !python.missing, disabledReason: python.missing ? '未找到 Python 3 静态服务器' : null }));
    stack.add('HTML / CSS / JavaScript');
  }
  await databaseEvidence(root, files, docs, dependencies, databases);
  if (!project.services.length) project.notes.push('未发现可安全直接启动的本地网页服务');
  if (!databases.size) project.notes.push('未发现已确认的数据库依赖；未读取 .env 中的连接配置');
  project.stack = [...stack];
  project.databases = [...databases];
  project.notes = [...new Set(project.notes)];
  return project;
}

export async function discoverProjects(root = process.env.SUBBOSS_PROJECT_ROOT || path.dirname(workspaceDirectory), options = {}) {
  root = path.resolve(root);
  // Missing/unreadable roots must fail instead of erasing the previous catalog.
  const entries = (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const excludedPaths = new Set([workspaceDirectory, ...(options.excludedPaths || [])].map(directory => path.resolve(directory)));
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'subboss' || excludedPaths.has(path.join(root, entry.name))) continue;
    projects.push(await discoverProject(path.join(root, entry.name), options));
  }
  return projects;
}
