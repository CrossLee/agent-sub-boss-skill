import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COVERAGE = {
  scope: "本机 Codex 对话",
  description: "包含本机已保存的用户对话和已归档对话；不包含子代理、其他设备或未同步的云端对话。",
};

async function databasePath(env) {
  // An explicit override must never fall back to the real user's database.
  if (env.SUBBOSS_CODEX_DB) return path.resolve(env.SUBBOSS_CODEX_DB);
  const directory = path.resolve(env.CODEX_HOME || path.join(homedir(), ".codex"));
  const names = (await readdir(directory))
    .filter(name => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  if (!names.length) throw new Error("No local conversation database");
  return path.join(directory, names[0]);
}

async function query(database, sql) {
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", database, sql], {
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
  });
  return JSON.parse(stdout.trim() || "[]");
}

function dateIso(milliseconds, seconds) {
  const value = Number(milliseconds) > 0 ? Number(milliseconds) : Number(seconds) * 1000;
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Read metadata only. Never opens rollout files, transcripts, or first_user_message. */
export async function readConversations({ env = process.env, now = new Date() } = {}) {
  const coverage = { ...COVERAGE, readAt: now.toISOString() };
  if (env.SUBBOSS_CODEX_CATALOG !== '1' && !env.SUBBOSS_CODEX_DB) {
    return {
      items: [],
      coverage: { ...coverage, available: false, total: null, active: null, archived: null, truncated: false },
      error: "对话目录尚未启用，可在总控台配置中开启后重启。",
      errorCode: "CONVERSATIONS_DISABLED",
    };
  }
  try {
    const database = await databasePath(env);
    if (!(await stat(database)).isFile()) throw new Error("Invalid conversation database");
    const schema = await query(database, `
      SELECT 'threads' AS table_name, name FROM pragma_table_info('threads')
      UNION ALL
      SELECT 'projects' AS table_name, name FROM pragma_table_info('projects');
    `);
    const columns = new Set(schema.filter(row => row.table_name === "threads").map(row => row.name));
    const projectColumns = new Set(schema.filter(row => row.table_name === "projects").map(row => row.name));
    for (const required of ["id", "title", "source", "cwd", "archived", "updated_at"]) {
      if (!columns.has(required)) throw new Error("Unsupported conversation schema");
    }
    const field = (name, fallback = "NULL") => columns.has(name) ? `t.${name}` : fallback;
    const hasProjects = columns.has("project_id") && projectColumns.has("id") && projectColumns.has("name");
    const name = field("name", "''");
    const rows = await query(database, `
      SELECT t.id,
        CASE WHEN trim(COALESCE(${name}, '')) <> '' THEN ${name} ELSE t.title END AS title,
        substr(${field("preview", "''")}, 1, 1200) AS summary,
        t.cwd, ${field("project_id")} AS project_id,
        ${hasProjects ? "p.name" : "NULL"} AS project_name,
        t.archived, t.updated_at, ${field("updated_at_ms")} AS updated_at_ms,
        ${field("recency_at", "0")} AS recency_at, ${field("recency_at_ms", "0")} AS recency_at_ms
      FROM threads AS t
      ${hasProjects ? "LEFT JOIN projects AS p ON p.id = t.project_id" : ""}
      WHERE lower(COALESCE(t.source, '')) NOT LIKE '%subagent%'
        AND trim(COALESCE(${field("agent_path", "''")}, '')) = ''
        AND (lower(t.source) IN ('vscode', 'cli') OR ${field("has_user_event", "0")} = 1)
        AND trim(COALESCE(t.id, '')) <> ''
        AND trim(CASE WHEN trim(COALESCE(${name}, '')) <> '' THEN ${name} ELSE t.title END) <> ''
      ORDER BY max(COALESCE(${field("recency_at_ms", "0")}, 0),
        COALESCE(${field("updated_at_ms", "0")}, 0),
        COALESCE(${field("recency_at", "0")}, 0) * 1000, t.updated_at * 1000) DESC, t.id;
    `);
    const items = rows.map(row => ({
      id: row.id,
      title: row.title,
      sourceTitle: row.title,
      summary: row.summary || "",
      project: row.project_name || (row.cwd ? path.basename(row.cwd) : "独立对话"),
      projectId: row.project_id || null,
      cwd: row.cwd || "",
      archived: Number(row.archived) === 1,
      updatedAt: dateIso(row.updated_at_ms, row.updated_at),
      lastActivityAt: dateIso(
        Math.max(Number(row.recency_at_ms) || 0, Number(row.updated_at_ms) || 0,
          (Number(row.recency_at) || 0) * 1000, (Number(row.updated_at) || 0) * 1000), 0),
    }));
    const archived = items.filter(item => item.archived).length;
    return {
      items,
      coverage: { ...coverage, available: true, total: items.length, active: items.length - archived, archived, truncated: false },
    };
  } catch {
    // Avoid returning command stderr or internal database details in an HTTP response.
    return {
      items: [],
      coverage: { ...coverage, available: false, total: null, active: null, archived: null, truncated: false },
      error: "本机对话目录本次未核实；原有看板待办仍可使用。",
      errorCode: "CONVERSATIONS_UNAVAILABLE",
    };
  }
}
