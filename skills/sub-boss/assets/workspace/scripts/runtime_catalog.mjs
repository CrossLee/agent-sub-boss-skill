#!/usr/bin/env node
import { stat, realpath, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RuntimeController } from '../dashboard-web/runtime.mjs';
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let config = {};
try { config = JSON.parse(await readFile(path.join(workspace, '.subboss/config.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const [command = 'list', ...directories] = process.argv.slice(2);
if (!['list', 'add', 'scan'].includes(command)) throw new Error('用法: node scripts/runtime_catalog.mjs list | scan | add /项目目录 ...');
const runtime = new RuntimeController({ root: process.env.SUBBOSS_PROJECT_ROOT || config.projectRoot || path.dirname(workspace) });
try {
  if (command === 'add') {
    if (!directories.length) throw new Error('请填写要纳入的项目绝对路径');
    for (const directory of directories) {
      if (!path.isAbsolute(directory) || !(await stat(directory)).isDirectory()) throw new Error(`不是项目绝对路径: ${directory}`);
      runtime.addRoot(await realpath(directory));
    }
  }
  if (command !== 'list') console.log(await runtime.scan());
  console.log(runtime.db.prepare('SELECT path,mode FROM roots ORDER BY path').all());
} finally { runtime.db.close(); }
