#!/usr/bin/env node
// zcode-tps-bar 数据服务:只读打开 ZCode usage 库,提供 /api/bar JSON 快照。
//   GET /api/bar   → 悬浮条消费的快照
//   GET /api/quit  → 停止服务(start-bar.cmd 的 stop 用)
//   node server.mjs --once          打印一次快照并退出(调试)
//   node server.mjs --port 7493     改端口
//   node server.mjs --idle-exit 0   关闭空闲自退(默认 30 分钟)
// 口径与 zcode-tps-monitor 对齐:
//   段速率 = (output_tokens+reasoning_tokens) / (completed_at-first_token_at)
//   速率不区分模型,是"本会话最近完成段"的真实库内数据。
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? Number(argv[i + 1]) : dflt;
};
const PORT = argOf("--port", 7493);
const IDLE_EXIT_MS = argOf("--idle-exit", 30 * 60) * 1000;
const DB_PATH = process.env.ZCODE_USAGE_DB || path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const STATE_FILE = path.join(os.homedir(), ".zcode", "tps-bar", "state.json");
const MIN_GEN_MS = 200;
const MAX_GEN_MS = 10 * 60 * 1000;

// 总 token 口径(实测对齐 Tokmon): input_tokens 已含缓存读,computed_total_tokens = input+output;
// 缺行回退为 input+output+reasoning,勿再叠加 cache_read(会重复计数)。
const TOTAL_EXPR =
  "COALESCE(computed_total_tokens," +
  " COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(reasoning_tokens,0))";

function openDb() {
  if (!existsSync(DB_PATH)) return null;
  try {
    return new DatabaseSync(DB_PATH, { readOnly: true });
  } catch {
    return null;
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function snapshot(sidFilter) {
  const db = openDb();
  if (!db) return { ok: false, error: "usage 库不可读: " + DB_PATH };
  try {
    /* sidFilter 提供时按该会话取数（多窗口各自跟自己的会话）；否则取全局最近活跃会话 */
    const hasFilter = !!(sidFilter && /^[A-Za-z0-9_-]{1,255}$/.test(sidFilter));
    let sidRow;
    if (hasFilter) {
      sidRow = db
        .prepare("SELECT session_id, MAX(completed_at) AS last FROM model_usage" +
          " WHERE status = 'completed' AND session_id = ? GROUP BY session_id")
        .get(sidFilter);
    } else {
      sidRow = db
        .prepare("SELECT session_id, MAX(completed_at) AS last FROM model_usage" +
          " WHERE status = 'completed' GROUP BY session_id ORDER BY last DESC LIMIT 1")
        .get();
    }
    const out = { ok: true, state: "idle", ts: Date.now() };
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const todayRow = db
      .prepare(
        "SELECT COALESCE(SUM(" + TOTAL_EXPR + "),0) AS t," +
        " COALESCE(SUM(COALESCE(input_tokens,0)),0) AS i," +
        " COALESCE(SUM(COALESCE(output_tokens,0)+COALESCE(reasoning_tokens,0)),0) AS o," +
        " COALESCE(SUM(COALESCE(cache_read_input_tokens,0)),0) AS c," +
        " COUNT(*) AS n" +
        " FROM model_usage WHERE status = 'completed' AND completed_at >= ?"
      )
      .get(dayStart.getTime());
    out.todayTokens = todayRow ? todayRow.t : 0;
    out.todayStats = {
      tokens: out.todayTokens,
      input: todayRow ? todayRow.i : 0,
      output: todayRow ? todayRow.o : 0,
      cacheRead: todayRow ? todayRow.c : 0,
      requests: todayRow ? todayRow.n : 0,
    };
    if (!sidRow) return out;   // 指定会话还没有完成请求：今日照常，会话槽位为空
    const sid = sidRow.session_id;

    const rows = db
      .prepare(
        "SELECT started_at, first_token_at, completed_at, time_to_first_token_ms," +
        " output_tokens, reasoning_tokens, COALESCE(input_tokens,0) AS input_tokens," +
        " COALESCE(cache_read_input_tokens,0) AS cache_read, " + TOTAL_EXPR + " AS total_tokens" +
        " FROM model_usage WHERE session_id = ? AND status = 'completed' ORDER BY completed_at ASC"
      )
      .all(sid);

    const items = rows.map((r) => {
      const tok = (r.output_tokens ?? 0) + (r.reasoning_tokens ?? 0);
      const genMs =
        Number.isFinite(r.first_token_at) && Number.isFinite(r.completed_at) && r.completed_at > r.first_token_at
          ? r.completed_at - r.first_token_at
          : null;
      const valid = genMs != null && genMs >= MIN_GEN_MS && genMs < MAX_GEN_MS && tok > 0;
      return {
        rate: valid ? Math.round((tok / genMs) * 10000) / 10 : null,
        ttftSec: Number.isFinite(r.time_to_first_token_ms) ? Math.round(r.time_to_first_token_ms) / 1000 : null,
        completedAt: r.completed_at,
        total: r.total_tokens ?? 0,
        input: r.input_tokens ?? 0,
        output: (r.output_tokens ?? 0) + (r.reasoning_tokens ?? 0),
        cacheRead: r.cache_read ?? 0,
      };
    });
    const rated = items.filter((i) => i.rate != null);
    const last = rated.length ? rated[rated.length - 1] : null;

    // "生成中"判定:钩子记录的提问时刻晚于上一轮收尾时刻,且同属当前活跃会话
    const st = readState();
    const inflight =
      st.promptTs > 0 &&
      (!st.turnEndTs || st.turnEndTs < st.promptTs) &&
      Date.now() - st.promptTs < 2 * 3600e3 &&
      (!st.sid || st.sid === sid);

    out.session = sid;
    out.state = inflight ? "generating" : "idle";
    out.rate = last ? last.rate : null;
    out.rateAgeSec = last ? Math.max(0, Math.round((Date.now() - last.completedAt) / 1000)) : null;
    out.ttftSec = last ? last.ttftSec : null;
    const recent = rated.slice(-5).map((i) => i.rate).sort((a, b) => a - b);
    out.median = recent.length ? recent[recent.length >> 1] : null;
    out.peak = rated.length ? Math.max(...rated.map((i) => i.rate)) : null;
    out.spark = rated.slice(-8).map((i) => i.rate);
    out.sessionTokens = items.reduce((s, i) => s + i.total, 0);
    /* 分类明细（悬浮卡片用）：total = 输入(含缓存读) + 输出 */
    out.sessionStats = {
      tokens: out.sessionTokens,
      input: items.reduce((s, i) => s + i.input, 0),
      output: items.reduce((s, i) => s + i.output, 0),
      cacheRead: items.reduce((s, i) => s + i.cacheRead, 0),
      requests: items.length,
    };
    return out;
  } finally {
    db.close();
  }
}

if (argv.includes("--once")) {
  console.log(JSON.stringify(snapshot(), null, 1));
  process.exit(0);
}

let lastHit = Date.now();
const server = http.createServer((req, res) => {
  lastHit = Date.now();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const url = req.url || "/";
  if (url.startsWith("/api/quit")) {
    res.end('{"ok":true,"bye":true}');
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (url.startsWith("/api/bar")) {
    let sid = "";
    try {
      const u = new URL(url, "http://127.0.0.1");
      sid = u.searchParams.get("sid") || "";
    } catch (e) { }
    res.end(JSON.stringify(snapshot(sid)));
    return;
  }
  res.statusCode = 404;
  res.end('{"ok":false,"error":"not found"}');
});
server.listen(PORT, "127.0.0.1", () => {
  console.error(`[tps-bar] listening on http://127.0.0.1:${PORT}/api/bar`);
});
setInterval(() => {
  if (Date.now() - lastHit > IDLE_EXIT_MS) process.exit(0);
}, 60_000).unref();
