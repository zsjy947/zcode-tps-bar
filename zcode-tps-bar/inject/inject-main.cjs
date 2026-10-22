/* tpsbar inject-main —— ZCode 主进程 loader（被 app.asar 入口尾部 dynamic import 加载）。
 * 职责：
 *   1) 确保数据服务 zcode-tps-bar/scripts/server.mjs 在跑（node 子进程，detached）；
 *   2) 1.5s 轮询 http://127.0.0.1:7493/api/bar，把快照推给全部窗口（window.__tpsbarUpdate）；
 *   3) 每个窗口注入 overlay.js（mtime 热更新，条子自清理后重挂）。
 * 运行时目录 ~/.zcode/tps-bar-runtime（本文件 + overlay.js + config.json + inject.log）。
 * 日志走 stderr（[tpsbar] 前缀）+ inject.log（256KB 上限）。
 */
(function () {
  "use strict";
  var electron;
  try { electron = require("electron"); } catch (e) { return; }
  var app = electron.app, BrowserWindow = electron.BrowserWindow;
  if (!app) return;

  var fs = require("fs");
  var path = require("path");
  var http = require("http");
  var os = require("os");
  var spawn = require("child_process").spawn;

  var HERE = __dirname; // ~/.zcode/tps-bar-runtime
  var LOGF = path.join(HERE, "inject.log");
  var LOG_SIZE = 0;
  try { LOG_SIZE = fs.statSync(LOGF).size; } catch (e) {}

  function LOG() {
    var args = Array.prototype.slice.call(arguments);
    try {
      console.error.apply(console, ["[tpsbar]"].concat(args));
      if (LOG_SIZE < 262144) {
        var line = "[" + new Date().toISOString() + "] " + args.join(" ") + "\n";
        fs.appendFileSync(LOGF, line);
        LOG_SIZE += line.length;
      }
    } catch (e) {}
  }

  var cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8")); } catch (e) {}
  var NODE = cfg.nodePath || "node";
  var SERVER = cfg.serverPath ||
    path.join(os.homedir(), ".zcode", "plugins", "zcode-tps-bar", "scripts", "server.mjs");
  var OVERLAY = path.join(HERE, "overlay.js");
  var API = "http://127.0.0.1:7493/api/bar";

  /* ---------- 数据服务守护 ---------- */
  function serverAlive(cb) {
    var req = http.get(API, function (res) { res.resume(); cb(res.statusCode === 200); });
    req.on("error", function () { cb(false); });
    req.setTimeout(700, function () { req.destroy(); cb(false); });
  }
  function ensureServer() {
    serverAlive(function (alive) {
      if (alive) return;
      try {
        var ch = spawn(NODE, [SERVER, "--idle-exit", "1800"],
          { detached: true, stdio: "ignore", windowsHide: true });
        ch.unref();
        LOG("server spawned pid=" + ch.pid);
      } catch (e) { LOG("server spawn failed: " + e.message); }
    });
  }

  /* ---------- overlay 注入（每个 webContents 按 mtime 注入一次；数据推送绝不重执行源码） ---------- */
  var overlaySrc = "", overlayMtime = 0;
  function loadOverlay(force) {
    try {
      var st = fs.statSync(OVERLAY);
      if (force || st.mtimeMs !== overlayMtime) {
        overlaySrc = fs.readFileSync(OVERLAY, "utf8");
        overlayMtime = st.mtimeMs;
        LOG("overlay loaded " + st.size + "B mtime=" + Math.round(st.mtimeMs));
      }
    } catch (e) { LOG("overlay read failed: " + e.message); }
  }
  var injected = new Map(); // webContents.id → overlayMtime
  function injectOverlay(wc) {
    if (!wc || wc.isDestroyed()) return;
    loadOverlay(false);
    if (!overlaySrc) return;
    try {
      injected.set(wc.id, overlayMtime);
      wc.executeJavaScript(
        "(function(){try{" + overlaySrc + "}catch(e){ if(window.console) console.error('[tpsbar]',e); }})();", true
      ).catch(function () { injected.delete(wc.id); });
    } catch (e) {
      injected.delete(wc.id);
      LOG("inject failed: " + e.message);
    }
  }
  function safeJson(o) {
    if (o == null) return "null";
    return JSON.stringify(o).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }
  function pushAll(p) {
    var ws = BrowserWindow.getAllWindows ? BrowserWindow.getAllWindows() : [];
    for (var i = 0; i < ws.length; i++) {
      var wc = ws[i].webContents;
      if (!wc || wc.isDestroyed()) continue;
      wc.executeJavaScript(
        "window.__tpsbarUpdate && window.__tpsbarUpdate(" + safeJson(p) + ");", true
      ).catch(function () {});
    }
  }

  /* ---------- 轮询泵 ---------- */
  var busy = false;
  function poll() {
    if (busy) return;
    busy = true;
    var req = http.get(API, function (res) {
      var buf = "";
      res.setEncoding("utf8");
      res.on("data", function (c) { buf += c; });
      res.on("end", function () {
        busy = false;
        var p;
        try { p = JSON.parse(buf); } catch (e) { return; }
        pushAll(p);
      });
    });
    req.on("error", function () { busy = false; });
    req.setTimeout(1200, function () { req.destroy(); busy = false; });
  }

  function start() {
    ensureServer();
    setTimeout(ensureServer, 3000); // 首次 spawn 竞态兜底
    loadOverlay(true);
    var ws = BrowserWindow.getAllWindows ? BrowserWindow.getAllWindows() : [];
    for (var i = 0; i < ws.length; i++) injectOverlay(ws[i].webContents);
    app.on("web-contents-created", function (e, wc) {
      wc.on("did-finish-load", function () { injectOverlay(wc); });
    });
    setInterval(ensureServer, 30000);
    setInterval(poll, 1500);
    poll();
    LOG("started node=" + NODE);
  }
  if (app.isReady && app.isReady()) start();
  else if (app.whenReady) app.whenReady().then(start).catch(function () {});
  else start();
})();
