import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverProject, discoverProjects } from './runtime-discovery.mjs';

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'subboss-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

test('finds workspace Next service with stable port and dependency facts; never invokes npm hooks', async t => {
  const root = await fixture(t, {
    'package.json': { scripts: { 'dev:web': 'npm run dev -w web' } },
    'apps/web/package.json': { scripts: { predev: 'rm -rf data', dev: 'next dev --webpack' }, dependencies: { next: '16', react: '19', 'better-sqlite3': '13' } },
    'node_modules/.bin/next': '#!/usr/bin/env node\n',
    '.env.local': 'VERY_SECRET=do-not-display',
  });
  const p = await discoverProject(root);
  const [s] = p.services;
  assert.equal(s.available, true);
  assert.equal(s.cwd, path.join(root, 'apps/web'));
  assert.ok(s.args.includes('--webpack'));
  assert.ok(s.args.includes('127.0.0.1'));
  assert.ok(!s.args.includes('npm'));
  assert.deepEqual(p.databases, ['SQLite']);
  assert.ok(p.stack.includes('Next.js'));
  assert.equal(s.port, (await discoverProject(root)).services[0].port);
  assert.ok(!JSON.stringify(p).includes('do-not-display'));
});

test('respects fixed mini-program API ports and flags uninstalled dependencies', async t => {
  const root = await fixture(t, {
    'apps/web/package.json': { scripts: { dev: 'next dev' }, dependencies: { next: '16' } },
    'apps/wxmini/config.js': 'module.exports = { apiBase: "http://127.0.0.1:3010/api/v1" };',
  });
  const p = await discoverProject(root);
  assert.equal(p.services[0].port, 3010);
  assert.equal(p.services[0].available, false);
  assert.match(p.services[0].disabledReason, /依赖/);
});

test('connects Vite proxy to verified Uvicorn service and prefers project Python', async t => {
  const root = await fixture(t, {
    'README.md': 'python -m uvicorn server.main:app --host 127.0.0.1 --port 8007 --reload\n',
    'requirements.txt': 'fastapi\nuvicorn\n',
    'server/main.py': 'import sqlite3\nfrom fastapi import FastAPI\napp = FastAPI()\n',
    'web/package.json': { scripts: { dev: 'vite --host 0.0.0.0' }, devDependencies: { vite: '6' } },
    'web/vite.config.ts': 'export default {server:{proxy:{"/api":"http://127.0.0.1:8007"}}}',
    'web/node_modules/.bin/vite': '',
    '.venv/bin/python': '',
    '.venv/lib/python3.13/site-packages/uvicorn/__init__.py': '',
  });
  const p = await discoverProject(root);
  const api = p.services.find(s => s.kind === 'api');
  const web = p.services.find(s => s.kind === 'web');
  assert.equal(api.port, 8007);
  assert.equal(api.executable, path.join(root, '.venv/bin/python'));
  assert.equal(api.available, true);
  assert.deepEqual(web.dependencies, [api.id]);
  assert.ok(web.args.includes('--strictPort'));
  assert.ok(!web.args.includes('0.0.0.0'));
  assert.ok(p.databases.includes('SQLite'));
});

test('does not execute shell chains, lifecycle commands, install or deployment scripts', async t => {
  const root = await fixture(t, {
    'package.json': { scripts: { dev: 'npm run sync && vite', start: 'npm install && node server.js', deploy: 'wrangler deploy' }, dependencies: { vite: '6' } },
    'index.html': '<html>source entry</html>',
    'node_modules/.bin/vite': '',
  });
  const p = await discoverProject(root);
  assert.equal(p.services.length, 0);
});

test('static previews work without node_modules and retain their documented port', async t => {
  const root = await fixture(t, {
    'package.json': { scripts: { start: 'python3 -m http.server 4318 --bind 127.0.0.1 -d dist' } },
    'dist/index.html': '<html>offline app</html>',
    'README.md': '本地 IndexedDB 存储',
  });
  const p = await discoverProject(root);
  const [s] = p.services;
  assert.equal(s.kind, 'static');
  assert.equal(s.label, '静态网页');
  assert.equal(s.port, 4318);
  assert.ok(s.args.includes(path.join(root, 'dist')));
  assert.ok(s.args.includes('127.0.0.1'));
  assert.ok(p.databases.includes('IndexedDB（浏览器本地）'));
});

test('does not mistake native app scaffold and test fixtures for live product previews', async t => {
  const root = await fixture(t, {
    'README.md': '原生 SwiftUI iPhone 应用，Web 目录只是占位。',
    'Package.swift': '// Actual Swift project manifest',
    'apps/web/package.json': { scripts: { dev: 'next dev' }, dependencies: { next: '16' } },
    'node_modules/.bin/next': '',
    'Tests/Fixtures/index.html': '<html>fixture</html>',
    'support-site/index.html': '<html>support</html>',
  });
  const p = await discoverProject(root);
  assert.equal(p.services.find(s => s.id === 'apps-web').available, false);
  assert.ok(p.services.some(s => s.kind === 'static' && s.cwd.endsWith('support-site')));
  assert.ok(!p.services.some(s => s.cwd.includes('Fixtures')));
});

test('Vinext uses its actual hostname flag; optional D1 template is not a database', async t => {
  const root = await fixture(t, {
    'package.json': { scripts: { dev: 'WRANGLER_LOG_PATH=.wrangler/wrangler.log vinext dev' }, dependencies: { vinext: '1', vite: '8', 'drizzle-orm': '1' } },
    'node_modules/.bin/vinext': '',
    '.openai/hosting.json': { d1: null, r2: null },
  });
  const p = await discoverProject(root);
  assert.ok(p.services[0].args.includes('--hostname'));
  assert.ok(!p.services[0].args.includes('--strictPort'));
  assert.deepEqual(p.databases, []);
  assert.equal(p.services[0].env.WRANGLER_LOG_PATH, '.wrangler/wrangler.log');
});

test('direct dev/start Node servers work without dependencies and disclose network-wide listeners', async t => {
  const root = await fixture(t, {
    'local/package.json': { scripts: { dev: 'node server.js' } },
    'local/server.js': 'const port = Number(process.env.PORT || 4173); server.listen(port, "127.0.0.1", () => {});',
    'all/package.json': { scripts: { start: 'node server.js' } },
    'all/server.js': 'const port = Number(process.env.PORT || 3000); const DATA_FILE = "data/db.json"; JSON.parse(raw); server.listen(port, () => {});',
  });
  const p = await discoverProject(root);
  assert.equal(p.services.find(s => s.id === 'local').available, true);
  assert.equal(p.services.find(s => s.id === 'all').available, true);
  assert.match(p.services.find(s => s.id === 'all').source, /start/);
  assert.ok(p.notes.some(note => /all.*局域网.*3000/.test(note)));
  assert.ok(p.databases.includes('JSON 文件（非关系数据库）'));
});

test('Remotion Studio includes a note about its default network listener', async t => {
  const root = await fixture(t, {
    'package.json': { scripts: { studio: 'remotion studio src/index.ts --port=3141' }, dependencies: { '@remotion/cli': '4' } },
    'node_modules/.bin/remotion': '',
  });
  const p = await discoverProject(root);
  assert.equal(p.services[0].available, true);
  assert.equal(p.services[0].port, 3141);
  assert.ok(p.notes.some(note => /Remotion Studio.*局域网.*3141/.test(note)));
});

test('scan excludes hidden and management directories and never follows directory symlinks', async t => {
  const root = await fixture(t, {
    'subboss/index.html': '<html>management</html>',
    '.hidden/index.html': '<html>hidden</html>',
    'site/index.html': '<html>site</html>',
    'site/outputs/fake/package.json': { scripts: { dev: 'vite' } },
  });
  await fs.symlink(path.join(root, 'site'), path.join(root, 'linked'));
  const result = await discoverProjects(root);
  assert.deepEqual(result.map(p => p.id), ['site']);
  assert.equal(result[0].services.length, 1);
});

test('reuses only exact installed HyperFrames cache versions and disables automatic updates', async t => {
  const root = await fixture(t, {
    'project/package.json': { scripts: { dev: 'npx --yes hyperframes@0.8.170 preview' } },
    'project/README.md': 'SwiftUI 开发教程的视频，不是原生应用源码。',
    'project/index.html': '<html>video composition</html>',
    'cache/_npx/ready/node_modules/hyperframes/package.json': { name: 'hyperframes', version: '0.8.170', bin: { hyperframes: './bin/hyperframes.mjs' } },
    'cache/_npx/ready/node_modules/hyperframes/bin/hyperframes.mjs': '// CLI wrapper, never executed during discovery',
    'cache/_npx/ready/node_modules/hyperframes/dist/cli.js': 'preview_default = defineCommand({ args: { port: {}, open: {}, "force-new": {}, foreground: {} }, async run() {} }); const host = process.env.HYPERFRAMES_PREVIEW_HOST;',
    'cache/_npx/ready/node_modules/hyperframes/dist/studio/index.html': '<html>packaged Studio</html>',
  });
  const options = { npmCacheDir: path.join(root, 'cache'), globalNodeModules: [] };
  const p = await discoverProject(path.join(root, 'project'), options);
  const [s] = p.services;
  assert.equal(s.available, true);
  assert.equal(s.label, '视频预览');
  assert.ok(s.args[0].includes('/cache/_npx/ready/'));
  assert.ok(s.args.includes('--foreground'));
  assert.ok(s.args.includes('--no-open'));
  assert.ok(s.args.includes('--force-new'));
  assert.ok(!s.args.includes('npx'));
  assert.match(s.source, /缓存 hyperframes@0\.8\.170/);
  assert.equal(s.env.HYPERFRAMES_PREVIEW_HOST, '127.0.0.1');
  assert.equal(s.env.HYPERFRAMES_NO_AUTO_INSTALL, '1');
  assert.equal(s.env.HYPERFRAMES_NO_UPDATE_CHECK, '1');
  assert.ok(!p.stack.includes('Swift / SwiftUI'));
  await fs.writeFile(path.join(root, 'project/package.json'), JSON.stringify({ scripts: { dev: 'npx --yes hyperframes@0.8.171 preview' } }));
  const missing = await discoverProject(path.join(root, 'project'), options);
  assert.equal(missing.services[0].available, false);
  assert.match(missing.services[0].disabledReason, /0\.8\.171.*未自动下载/);
});

test('older local HyperFrames packages omit unsupported foreground flags and require a built Studio', async t => {
  const root = await fixture(t, {
    'package.json': { scripts: { dev: 'hyperframes preview' } },
    'node_modules/hyperframes/package.json': { name: 'hyperframes', version: '0.6.93', bin: './dist/cli.js' },
    'node_modules/hyperframes/dist/cli.js': 'preview_default = defineCommand({ args: { port: {}, open: {}, "force-new": {} }, async run() {} }); const host = process.env.HYPERFRAMES_PREVIEW_HOST;',
    'node_modules/hyperframes/dist/studio/index.html': '<html>Studio</html>',
  });
  const p = await discoverProject(root);
  assert.equal(p.services[0].available, true);
  assert.ok(!p.services[0].args.includes('--foreground'));
  assert.match(p.services[0].source, /项目依赖 hyperframes@0\.6\.93/);
  await fs.unlink(path.join(root, 'node_modules/hyperframes/dist/studio/index.html'));
  assert.equal((await discoverProject(root)).services[0].available, false);
});

test('Drizzle databases require a specific schema import and an actual table declaration', async t => {
  const root = await fixture(t, {
    'package.json': { dependencies: { 'drizzle-orm': '1' } },
    'src/schema.ts': 'import { pgTable } from "drizzle-orm/pg-core"; export const users = pgTable("users", {});',
    'src/sqlite-schema.ts': 'import { sqliteTable } from "drizzle-orm/sqlite-core"; export const posts = sqliteTable("posts", {});',
    'src/mysql-schema.ts': 'import { mysqlTable } from "drizzle-orm/mysql-core"; export const things = mysqlTable("things", {});',
  });
  assert.deepEqual(new Set((await discoverProject(root)).databases), new Set(['PostgreSQL', 'SQLite', 'MySQL']));
  await fs.writeFile(path.join(root, 'src/schema.ts'), 'import { pgTable } from "drizzle-orm/pg-core"; // empty template');
  assert.ok(!(await discoverProject(root)).databases.includes('PostgreSQL'));
});

test('supports renamed management folders through explicit exclusions and rejects missing roots', async t => {
  const root = await fixture(t, {
    'control-room/index.html': '<html>management</html>',
    'site/index.html': '<html>site</html>',
  });
  const result = await discoverProjects(root, { excludedPaths: [path.join(root, 'control-room')] });
  assert.deepEqual(result.map(p => p.id), ['site']);
  await assert.rejects(discoverProjects(path.join(root, 'missing')), { code: 'ENOENT' });
});

test('finds page API ports without relying on a particular project or page name', async t => {
  const root = await fixture(t, {
    'apps/web/package.json': { scripts: { dev: 'next dev' }, dependencies: { next: '16' } },
    'apps/wxmini/pages/catalog/api.js': 'export const endpoint = "http://127.0.0.1:3123/api";',
  });
  const result = await discoverProject(root);
  assert.equal(result.services[0].port, 3123);
});
