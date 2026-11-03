import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readConversations } from "./conversations.mjs";

const execFileAsync = promisify(execFile);
const now = new Date("2026-10-19T02:00:00.000Z");
const quote = value => value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;

async function fixture(t, filename = "fixture.sqlite") {
  const directory = await mkdtemp(path.join(tmpdir(), "subboss-conversations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, filename);
  await execFileAsync("sqlite3", [database, `
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, preview TEXT,
      source TEXT, cwd TEXT, project_id TEXT, archived INTEGER, updated_at INTEGER,
      updated_at_ms INTEGER, recency_at INTEGER, recency_at_ms INTEGER,
      has_user_event INTEGER, agent_path TEXT, first_user_message TEXT, rollout_path TEXT);
    INSERT INTO projects VALUES ('project-a', '中文产品空间');
  `]);
  async function insert(values) {
    const row = { id: "thread-a", title: "原始标题", name: null, preview: "摘要元数据", source: "vscode",
      cwd: "/fixture/独立目录", project_id: null, archived: 0, updated_at: 1792375200,
      updated_at_ms: null, recency_at: 0, recency_at_ms: 0, has_user_event: 0, agent_path: null,
      first_user_message: "PRIVATE_MESSAGE_NOT_EXPOSED", rollout_path: "/private/transcript.jsonl", ...values };
    await execFileAsync("sqlite3", [database, `INSERT INTO threads (${Object.keys(row).join(",")}) VALUES (${Object.values(row).map(quote).join(",")});`]);
  }
  return { directory, database, insert };
}

test("local catalog preserves renamed titles, archive state, unicode, and metadata-only boundaries", async t => {
  const { database, insert } = await fixture(t);
  await insert({ id: "renamed", name: "[PRODUCT] 测试产品", project_id: "project-a", preview: "Unicode 摘要：研究与问题", updated_at_ms: 1792375200123 });
  await insert({ id: "archived", title: "已归档调研", name: "  ", archived: 1, source: "cli", recency_at_ms: 1792375300000 });
  await insert({ id: "agent-source", name: "不应显示的代理", source: '{"subagent":{"other":"guardian"}}', has_user_event: 1 });
  await insert({ id: "agent-path", agent_path: "/root/worker", has_user_event: 1 });
  await insert({ id: "unknown-source", source: "internal" });
  await insert({ id: "internal-exec", source: "exec", title: "Internal design instructions" });
  await insert({ id: "explicit-user", title: "用户发起的其他客户端对话", source: "other-client", has_user_event: 1 });
  await insert({ id: "blank", title: "  ", name: " " });
  const before = await readFile(database);
  const result = await readConversations({ env: { SUBBOSS_CODEX_DB: database }, now });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.items.map(item => item.id), ["archived", "renamed", "explicit-user"]);
  assert.equal(result.coverage.scope, "本机 Codex 对话");
  assert.equal(result.coverage.available, true);
  assert.equal(result.coverage.total, 3);
  assert.equal(result.coverage.active, 2);
  assert.equal(result.coverage.archived, 1);
  assert.equal(result.coverage.truncated, false);
  assert.equal(result.coverage.readAt, now.toISOString());
  const renamed = result.items.find(item => item.id === "renamed");
  assert.equal(renamed.title, "[PRODUCT] 测试产品");
  assert.equal(renamed.sourceTitle, renamed.title);
  assert.equal(renamed.project, "中文产品空间");
  assert.equal(renamed.updatedAt, "2026-10-19T02:00:00.123Z");
  assert.equal(renamed.archived, false);
  assert.equal(result.items[0].archived, true);
  assert.equal(result.items[0].title, "已归档调研");
  assert.equal(result.items[0].project, "独立目录");
  assert.equal(result.items[0].lastActivityAt, "2026-10-19T02:01:40.000Z");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MESSAGE_NOT_EXPOSED|rollout_path|transcript\.jsonl|first_user_message|agent_path/);
  assert.deepEqual(await readFile(database), before, "read-only catalog must not mutate the database");
});

test("catalog has no fifty-thread cap and bounds preview metadata", async t => {
  const { database } = await fixture(t);
  await execFileAsync("sqlite3", [database, `
    WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 75)
    INSERT INTO threads (id,title,preview,source,cwd,archived,updated_at)
    SELECT 'thread-' || value, '对话 ' || value, '${"测".repeat(1400)}', 'vscode', '/fixture', 0, 1792375200 FROM n;
  `]);
  const result = await readConversations({ env: { SUBBOSS_CODEX_DB: database }, now });
  assert.equal(result.items.length, 75);
  assert.equal(result.coverage.total, 75);
  assert.equal(result.items[0].summary.length, 1200);
});

test("database discovery selects the newest numeric schema in CODEX_HOME", async t => {
  const { directory, database, insert } = await fixture(t, "state_12.sqlite");
  await insert({ name: "最新数据库" });
  await execFileAsync("sqlite3", [path.join(directory, "state_5.sqlite"), "CREATE TABLE obsolete (id TEXT);"]);
  const result = await readConversations({ env: { CODEX_HOME: directory, SUBBOSS_CODEX_CATALOG: "1" }, now });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, "最新数据库");
  assert.ok((await stat(database)).isFile());
});

test("missing or incompatible database gives a controlled unavailable result without creating files", async t => {
  const { directory } = await fixture(t);
  const missing = path.join(directory, "does-not-exist.sqlite");
  const result = await readConversations({ env: { SUBBOSS_CODEX_DB: missing, CODEX_HOME: directory }, now });
  assert.equal(result.coverage.available, false);
  assert.equal(result.coverage.total, null);
  assert.equal(result.errorCode, "CONVERSATIONS_UNAVAILABLE");
  assert.deepEqual(result.items, []);
  assert.doesNotMatch(result.error, /does-not-exist|sqlite3/);
  await assert.rejects(stat(missing), { code: "ENOENT" });
  const incompatible = path.join(directory, "incompatible.sqlite");
  await execFileAsync("sqlite3", [incompatible, "CREATE TABLE threads (id TEXT);"]);
  const invalid = await readConversations({ env: { SUBBOSS_CODEX_DB: incompatible }, now });
  assert.equal(invalid.errorCode, "CONVERSATIONS_UNAVAILABLE");
});


test("catalog is disabled until explicitly enabled and does not inspect CODEX_HOME", async () => {
  const result = await readConversations({ env: { CODEX_HOME: '/nonexistent/unused-home' }, now });
  assert.equal(result.errorCode, 'CONVERSATIONS_DISABLED');
  assert.equal(result.coverage.available, false);
  assert.deepEqual(result.items, []);
});
