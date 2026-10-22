#!/usr/bin/env node
// zcode-tps-bar UserPromptSubmit 钩子:记录提问时刻到 ~/.zcode/tps-bar/state.json。
// 完全静默:不读不写 stdout/stderr,不注入任何上下文。
import { writeFileSync, mkdirSync } from "node:fs";
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
    writeFileSync(path.join(dir, "state.json"), JSON.stringify({ sid, promptTs: Date.now() }));
  } catch {}
}
