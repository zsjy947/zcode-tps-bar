#!/usr/bin/env node
// zcode-tps-bar Stop 钩子:记录收尾时刻。promptTs < turnEndTs ⇒ 悬浮条切回"空闲"。
// 完全静默:不读不写 stdout/stderr,不注入任何上下文。
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

let sid = "";
try {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  sid = String(input.session_id || "");
} catch {}
if (!sid) sid = process.env.ZCODE_SESSION_ID || "";
if (sid) {
  try {
    const dir = path.join(homedir(), ".zcode", "tps-bar");
    mkdirSync(dir, { recursive: true });
    let prev = {};
    try {
      prev = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    } catch {}
    writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({ sid, promptTs: prev.promptTs ?? 0, turnEndTs: Date.now() })
    );
  } catch {}
}
