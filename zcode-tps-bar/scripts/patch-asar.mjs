#!/usr/bin/env node
// tpsbar asar 注入/卸载/检查工具（算法与 tokmon patch_asar.py 同源，Node 实现）。
//
// 用法：
//   node patch-asar.mjs install   # 同步运行时文件到 ~/.zcode/tps-bar-runtime 并注入（需先完全退出 ZCode）
//   node patch-asar.mjs remove    # 剥离 [tpsbar] 注入行（剥离后入口与官方版本逐字节一致）
//   node patch-asar.mjs check     # 只读检查注入状态与运行时一致性
//
// 原理：asar 主入口 out/main/index.js 尾部追加一行 dynamic import 指向运行时目录的
// inject-main.cjs（入口是 ESM，必须 dynamic import）。安装/卸载只增删本工具自己的
// 注入行（[tpsbar] 标记识别），不做 asar 备份；remove 后入口与官方版本逐字节一致。
// ZCode 升级会覆盖 app.asar，届时重跑 install 即可。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const ALIGN = 4;
const BLOCK = 4 * 1024 * 1024;
const ENTRY = "out/main/index.js";
const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNTIME = path.join(os.homedir(), ".zcode", "tps-bar-runtime");
const RUNTIME_FILES = ["inject-main.cjs", "overlay.js"];

const ASAR = process.env.ZCODE_ASAR ||
  (fs.existsSync("D:\\ZCode\\resources\\app.asar") ? "D:\\ZCode\\resources\\app.asar" : "app.asar");

const INJECT_LINE_RE = /\n;import\("[^"]*inject-main\.cjs"\)\.then\(\(\)=>null,\(e\)=>console\.error\("\[tpsbar\] load failed",e\)\);/;
const stripLine = (s) => s.replace(new RegExp(INJECT_LINE_RE.source, "g"), "");

function injectLine() {
  const uri = pathToFileURL(path.join(RUNTIME, "inject-main.cjs")).href;
  return `\n;import("${uri}").then(()=>null,(e)=>console.error("[tpsbar] load failed",e));`;
}

function readHeader(fd) {
  const buf = Buffer.alloc(16);
  fs.readSync(fd, buf, 0, 16, 0);
  const a = buf.readUInt32LE(0), b = buf.readUInt32LE(4), c = buf.readUInt32LE(8), d = buf.readUInt32LE(12);
  if (a !== 4) throw new Error(`unexpected pickle prefix ${a}`);
  const jsonBuf = Buffer.alloc(d);
  fs.readSync(fd, jsonBuf, 0, d, 16);
  return { header: JSON.parse(jsonBuf.toString("utf8")), base: 8 + b };
}

function iterFiles(node, out, prefix = "") {
  for (const [name, ch] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (ch.files) iterFiles(ch, out, p);
    else out.set(p, ch);
  }
}

function integrity(data) {
  const blocks = [];
  for (let i = 0; i < data.length; i += BLOCK) {
    blocks.push(crypto.createHash("sha256").update(data.subarray(i, i + BLOCK)).digest("hex"));
  }
  return { algorithm: "SHA256", hash: crypto.createHash("sha256").update(data).digest("hex"), blockSize: BLOCK, blocks };
}

function repack(srcPath, modify, dstPath) {
  const src = fs.openSync(srcPath, "r");
  try {
    let { header, base } = readHeader(src);
    header = JSON.parse(JSON.stringify(header));
    const nodes = new Map();
    iterFiles(header, nodes);
    for (const p of modify.keys()) {
      if (!nodes.has(p)) throw new Error(`path not in asar: ${p}`);
    }
    const parts = [];
    let offset = 0;
    for (const [p, node] of nodes) {
      if (node.unpacked) { node.offset = "0"; continue; }
      let data;
      if (modify.has(p)) {
        data = modify.get(p);
        node.size = data.length;
        node.integrity = integrity(data);
      } else {
        data = Buffer.alloc(node.size);
        fs.readSync(src, data, 0, node.size, base + Number(node.offset));
      }
      node.offset = String(offset);
      parts.push(data);
      offset += data.length;
    }
    const payload = Buffer.concat(parts);
    const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    const d = headerBytes.length;
    const c = Math.ceil((d + 4) / ALIGN) * ALIGN;
    const bTotal = c + 4;
    const out = fs.openSync(dstPath, "w");
    try {
      const head = Buffer.alloc(16);
      head.writeUInt32LE(4, 0); head.writeUInt32LE(bTotal, 4);
      head.writeUInt32LE(c, 8); head.writeUInt32LE(d, 12);
      fs.writeSync(out, head);
      fs.writeSync(out, headerBytes);
      fs.writeSync(out, Buffer.alloc(c - d - 4, 0));
      if (fs.fstatSync(out).size !== 8 + bTotal) throw new Error("header pad mismatch");
      fs.writeSync(out, payload);
    } finally { fs.closeSync(out); }
  } finally { fs.closeSync(src); }
}

function entryBytes(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const { header, base } = readHeader(fd);
    const nodes = new Map();
    iterFiles(header, nodes);
    const node = nodes.get(ENTRY);
    if (!node) throw new Error(`entry not found: ${ENTRY}`);
    const data = Buffer.alloc(node.size);
    fs.readSync(fd, data, 0, node.size, base + Number(node.offset));
    return data;
  } finally { fs.closeSync(fd); }
}

function syncRuntime() {
  fs.mkdirSync(RUNTIME, { recursive: true });
  for (const name of RUNTIME_FILES) {
    const src = path.join(PLUGIN_ROOT, "inject", name);
    const dst = path.join(RUNTIME, name);
    if (!fs.existsSync(src)) throw new Error(`runtime source missing: ${src}`);
    fs.copyFileSync(src, dst);
  }
  const cfgPath = path.join(RUNTIME, "config.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (e) {}
  cfg.nodePath = process.execPath;                 // 固化当前 node 绝对路径（GUI 环境 PATH 很瘦）
  cfg.serverPath = path.join(PLUGIN_ROOT, "scripts", "server.mjs");
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log(`  [runtime] 同步 → ${RUNTIME}（node=${cfg.nodePath}）`);
}

function syntaxCheck(asarPath) {
  let entry;
  try { entry = entryBytes(asarPath); } catch (e) { return true; }
  const tmp = path.join(os.tmpdir(), `.tpsbar-check.${process.pid}.mjs`); // .mjs → 按 ESM 解析
  fs.writeFileSync(tmp, entry);
  try {
    const r = spawnSync(process.execPath, ["--check", tmp], { timeout: 60000, encoding: "utf8" });
    if (r.status === 0) { console.log("  [check] 语法检查 exit=0 ✓"); return true; }
    console.log("  [check] 语法检查失败:\n" + String(r.stderr || "").slice(0, 400));
    return false;
  } catch (e) {
    console.log(`  [check] 语法检查无法执行（${e.message}），跳过`);
    return true;
  } finally { fs.unlinkSync(tmp); }
}

function selfCheck(asarPath, expect) {
  const entry = entryBytes(asarPath).toString("utf8");
  return INJECT_LINE_RE.test(entry) === expect;
}

function install() {
  console.log(`[install] 目标 ${ASAR}`);
  if (!fs.existsSync(ASAR)) { console.log(`✗ 找不到 ${ASAR}（自定义位置请设 ZCODE_ASAR）`); return 1; }
  syncRuntime();
  let entry = entryBytes(ASAR);
  const line = Buffer.from(injectLine(), "utf8");
  if (entry.includes(line)) {
    console.log("✓ 已注入（幂等，无需重复）；运行时已在上方同步");
    return 0;
  }
  entry = Buffer.from(stripLine(entry.toString("utf8")), "utf8"); // 幂等：剥历史行
  const newEntry = Buffer.concat([entry, line]);
  const tmp = ASAR + ".tpsbar.tmp";
  console.log("  重打包（追加注入行，约需十几秒）...");
  repack(ASAR, new Map([[ENTRY, newEntry]]), tmp);
  try {
    fs.renameSync(tmp, ASAR);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    console.log(`✗ 替换 asar 失败（${e.message}）——ZCode 是否正在运行？请先完全退出 ZCode 再执行 install。`);
    return 1;
  }
  if (!selfCheck(ASAR, true) || !syntaxCheck(ASAR)) {
    console.log("✗ 自检失败，回滚");
    const plain = Buffer.from(stripLine(entryBytes(ASAR).toString("utf8")), "utf8");
    repack(ASAR, new Map([[ENTRY, plain]]), tmp);
    fs.renameSync(tmp, ASAR);
    return 1;
  }
  console.log("✓ 注入完成。重启 ZCode 后输入框下方出现吞吐条。");
  return 0;
}

function remove() {
  console.log(`[remove] 目标 ${ASAR}`);
  if (!fs.existsSync(ASAR)) { console.log(`✗ 找不到 ${ASAR}`); return 1; }
  const entry = entryBytes(ASAR);
  if (!INJECT_LINE_RE.test(entry.toString("utf8"))) {
    console.log("✓ 未注入（无需卸载）");
    return 0;
  }
  const newEntry = Buffer.from(stripLine(entry.toString("utf8")), "utf8");
  const tmp = ASAR + ".tpsbar.tmp";
  console.log("  重打包（剥离注入行）...");
  repack(ASAR, new Map([[ENTRY, newEntry]]), tmp);
  try { fs.renameSync(tmp, ASAR); } catch (e) {
    fs.rmSync(tmp, { force: true });
    console.log(`✗ 替换 asar 失败（${e.message}）——请先完全退出 ZCode。`);
    return 1;
  }
  console.log(selfCheck(ASAR, false) ? "✓ 卸载完成" : "✗ 自检异常，请检查");
  return selfCheck(ASAR, false) ? 0 : 1;
}

function check() {
  console.log(`[check] 目标 ${ASAR}`);
  if (!fs.existsSync(ASAR)) { console.log(`✗ 找不到 ${ASAR}`); return 1; }
  const entry = entryBytes(ASAR).toString("utf8");
  const injected = INJECT_LINE_RE.test(entry);
  console.log(`注入状态: ${injected ? "已注入 [tpsbar]" : "未注入"}`);
  const stale = RUNTIME_FILES.filter((n) => {
    const src = path.join(PLUGIN_ROOT, "inject", n);
    const dst = path.join(RUNTIME, n);
    if (!fs.existsSync(dst)) return true;
    return Buffer.compare(fs.readFileSync(src), fs.readFileSync(dst)) !== 0;
  });
  console.log(`运行时 ${RUNTIME}: ${stale.length ? "与源不一致(" + stale.join(",") + ")，重跑 install 同步" : "完整一致"}`);
  return 0;
}

const cmd = process.argv[2] || "check";
let code = 0;
try {
  if (cmd === "install") code = install();
  else if (cmd === "remove") code = remove();
  else code = check();
} catch (e) {
  console.error(`✗ ${e.message}`);
  code = 1;
}
process.exit(code);
