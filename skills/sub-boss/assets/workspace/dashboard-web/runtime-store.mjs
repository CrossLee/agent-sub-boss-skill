import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function openRuntimeStore(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS roots (path TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'project');
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      stack TEXT NOT NULL, databases TEXT NOT NULL, notes TEXT NOT NULL, scanned_at TEXT NOT NULL, present INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS services (project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL,
      label TEXT NOT NULL, cwd TEXT NOT NULL, executable TEXT NOT NULL, args TEXT NOT NULL, env TEXT NOT NULL,
      port INTEGER, url TEXT, kind TEXT NOT NULL, source TEXT NOT NULL, available INTEGER NOT NULL,
      disabled_reason TEXT, dependencies TEXT NOT NULL DEFAULT '[]', present INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(project_id,id));
    CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, service_id TEXT NOT NULL,
      token TEXT NOT NULL, pid INTEGER, status TEXT NOT NULL, started_at TEXT NOT NULL, stopped_at TEXT,
      error TEXT, exit_code INTEGER, log_path TEXT NOT NULL, cwd TEXT NOT NULL, executable TEXT NOT NULL,
      args TEXT NOT NULL, env TEXT NOT NULL, port INTEGER, url TEXT);
    CREATE INDEX IF NOT EXISTS run_service ON runs(project_id,service_id,id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(project_id,service_id) WHERE status IN ('starting','running','stopping');
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, service_id TEXT,
      action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
  `);
  return db;
}

export function decodeService(row) {
  return { id: row.id, label: row.label, cwd: row.cwd, executable: row.executable,
    args: JSON.parse(row.args), env: JSON.parse(row.env), port: row.port, url: row.url, kind: row.kind,
    source: row.source, available: !!row.available, disabledReason: row.disabled_reason,
    dependencies: JSON.parse(row.dependencies) };
}
