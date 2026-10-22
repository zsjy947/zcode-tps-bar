/* tpsbar overlay —— 注入 ZCode 渲染进程（Tokmon overlay.js 骨架 + 自研四槽位数据渲染）。
 * 挂载：600ms 扫描视口下半部的可见 composer；优先 findCard 嵌入输入卡片内部（in-flow，
 *       React 删了自动重插）；找不到卡片兜底 fixed 跟随矩形。单实例策略。
 * 数据：主进程泵推送 window.__tpsbarUpdate(payload)，payload 同 server.mjs /api/bar：
 *   {ok,state,rate,rateAgeSec,ttftSec,median,peak,spark[],sessionTokens,todayTokens}
 * 四槽位：⚡速率+走势(矩形,底线齐平) │ 首字↔均峰 │ 会话累计 │ 今日总量。
 * 速率按会话中位数着色：≥85% 绿 · 50-85% 黄 · <50% 红；空闲转灰（同样显示 tok/s 单位）。
 * 悬浮提示：Tokmon 同款悬浮卡片（标题+标签/值行+说明），组级 mouseenter 触发。
 * 热更新：inject-main 重执行本文件时经 __tpsbarLoaded 标记自清理。
 */
(function () {
  "use strict";
  var VERSION = "tpsbar-overlay-v2.4";

  function cleanup() {
    try { clearInterval(window.__tpsbarCoordTimer); } catch (e) { }
    try { clearInterval(window.__tpsbarPosTimer); } catch (e) { }
    try {
      if (window.__tpsbarWinHide) {
        window.removeEventListener("scroll", window.__tpsbarWinHide, true);
        window.removeEventListener("resize", window.__tpsbarWinHide);
        window.__tpsbarWinHide = null;
      }
    } catch (e) { }
    try { hideTip(); } catch (e) { }
    var olds = document.querySelectorAll(".tpsbar-root,.tpsbar-tip");
    for (var i = 0; i < olds.length; i++) olds[i].remove();
    try {
      var arr = window.__tpsbarInstances || [];
      for (var k = 0; k < arr.length; k++) { try { arr[k].dispose(); } catch (e) { } }
      arr.length = 0;
    } catch (e) { }
  }
  if (window.__tpsbarLoaded) cleanup();
  window.__tpsbarLoaded = true;

  var payload = null;

  /* ---------- CSS（Tokmon 同款：跟随客户端 --color-* 主题；in-card 嵌入态去装饰） ---------- */
  var CSS =
    ".tpsbar-root{position:fixed;box-sizing:border-box;z-index:50;" +
    "display:flex;align-items:center;justify-content:center;white-space:nowrap;max-width:96vw;" +
    "font-family:var(--font-mono,ui-monospace,Consolas,Menlo,monospace);" +
    "font-size:11.5px;line-height:1.2;letter-spacing:.01em;" +
    "font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1;" +
    "color:var(--color-foreground-subtle,#8791a3);" +
    "border:1px solid var(--color-border,rgba(255,255,255,.07));border-radius:10px;" +
    "padding:5px 10px;user-select:none;cursor:default;" +
    "backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);" +
    "box-shadow:0 4px 14px rgba(0,0,0,.28)}" +
    ".tpsbar-root.tpsbar-in{position:static;width:100%;max-width:none;z-index:auto;" +
    "background:none;border:0;border-radius:0;box-shadow:none;" +
    "backdrop-filter:none;-webkit-backdrop-filter:none;padding:4px 2px 2px;opacity:.96;" +
    "justify-content:flex-start}" +
    ".tpsbar-grp{display:inline-flex;align-items:baseline;gap:6px;padding:1px 8px;" +
    "border-radius:7px}" +
    ".tpsbar-ic{display:inline-flex;align-items:center;justify-content:center;align-self:center;" +
    "color:var(--color-foreground-subtle,#7e8899);opacity:.8;flex:0 0 auto}" +
    ".tpsbar-ic svg{display:block}" +
    ".tpsbar-val{font-weight:600;color:var(--color-foreground,#e9edf4)}" +
    ".tpsbar-unit{font-size:10px;font-weight:400;margin-left:-2px;" +
    "color:var(--color-foreground-subtle,#7e8899)}" +
    ".tpsbar-div{width:1px;height:10px;flex:0 0 auto;margin:0 2px;opacity:.7;" +
    "background:var(--color-border,rgba(255,255,255,.09))}" +
    /* 速率组着色：--tpsbar-rate-color 由 ok/warn/bad/dim 四档类切换 */
    ".tpsbar-rate-ok{--tpsbar-rate-color:var(--color-success,#4ade80)}" +
    ".tpsbar-rate-warn{--tpsbar-rate-color:var(--color-warning,#fbbf24)}" +
    ".tpsbar-rate-bad{--tpsbar-rate-color:var(--color-danger,#f87171)}" +
    ".tpsbar-rate-dim{--tpsbar-rate-color:var(--color-foreground-subtle,#8791a3)}" +
    ".tpsbar-grp.tpsbar-rate .tpsbar-val{color:var(--tpsbar-rate-color,var(--color-foreground,#e9edf4))}" +
    ".tpsbar-grp.tpsbar-rate .tpsbar-ic{color:var(--tpsbar-rate-color,var(--color-foreground-subtle,#7e8899));opacity:1}" +
    ".tpsbar-spark{display:inline-flex;align-items:flex-end;align-self:baseline;height:11px;gap:2px;" +
    "margin-left:2px;color:var(--tpsbar-rate-color,var(--color-foreground-subtle,#8791a3))}" +
    ".tpsbar-bar{width:4px;height:2px;border-radius:1px;background:currentColor}" +
    /* 悬浮提示卡片（Tokmon 同款） */
    ".tpsbar-tip{position:fixed;z-index:9999;pointer-events:none;max-width:320px;" +
    "padding:8px 11px;border-radius:9px;font-size:11px;line-height:1.55;text-align:left;" +
    "font-family:-apple-system,'PingFang SC',system-ui,sans-serif;white-space:normal;" +
    "color:var(--color-foreground,#e9edf4);background:var(--color-background,#12151d);" +
    "border:1px solid var(--color-border,rgba(255,255,255,.10));" +
    "box-shadow:0 10px 28px rgba(0,0,0,.45);opacity:0}" +
    ".tpsbar-tip.on{opacity:1}" +
    ".tpsbar-tip-h{font-size:11.5px;font-weight:600;letter-spacing:.02em;margin-bottom:3px}" +
    ".tpsbar-tip-l{color:var(--color-foreground-subtle,#8791a3);margin-top:2px}" +
    ".tpsbar-tip-row{display:flex;justify-content:space-between;gap:16px;padding:1px 0}" +
    ".tpsbar-tip-k{color:var(--color-foreground-subtle,#8791a3)}" +
    ".tpsbar-tip-v{color:var(--color-foreground,#e9edf4);font-weight:600;" +
    "font-variant-numeric:tabular-nums}" +
    /* 图例行（Tokmon 同款：彩色色块 + 标签 + 右对齐数值） */
    ".tpsbar-tip-legend{margin-top:6px;padding-top:6px;" +
    "border-top:1px solid var(--color-border,rgba(255,255,255,.08))}" +
    ".tpsbar-tip-legend-row{display:flex;align-items:center;gap:6px;padding:1px 3px;" +
    "border-radius:4px;font-size:10.5px;line-height:1.5}" +
    ".tpsbar-tip-legend-cur{background:var(--color-hover,rgba(255,255,255,.06))}" +
    ".tpsbar-tip-swatch{width:9px;height:9px;border-radius:2px;flex:0 0 auto;" +
    "box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)}" +
    ".tpsbar-tip-legend-label{color:var(--color-foreground-subtle,#8791a3)}" +
    ".tpsbar-tip-legend-cur .tpsbar-tip-legend-label{color:var(--color-foreground,#e9edf4);font-weight:600}" +
    ".tpsbar-tip-legend-range{margin-left:auto;color:var(--color-foreground-subtle,#8791a3);" +
    "font-variant-numeric:tabular-nums}";

  /* 矢量图标（不依赖字体覆盖；stroke currentColor） */
  var ICONS = {
    bolt: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
      '<path d="M6.8,0.5 L1,7.4 L4.9,7.4 L4.2,11.5 L11,4.4 L6.6,4.4 Z" fill="currentColor"/></svg>',
    timer: '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" ' +
      'stroke-width="1.2" stroke-linecap="round" aria-hidden="true">' +
      '<circle cx="6" cy="6.8" r="4.4"/><path d="M4.4,1 L7.6,1"/><path d="M6,4.6 L6,6.8 L7.8,7.8"/></svg>',
    chat: '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" ' +
      'stroke-width="1.1" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M1.2,1.4 L10.8,1.4 L10.8,8 L5.3,8 L2.7,10.8 L2.7,8 L1.2,8 Z"/></svg>',
    box: '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" ' +
      'stroke-width="1.1" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M6,1.2 L10.8,3.5 L10.8,8.5 L6,10.8 L1.2,8.5 L1.2,3.5 Z"/>' +
      '<path d="M1.2,3.5 L6,5.8 L10.8,3.5 M6,5.8 L6,10.8"/></svg>'
  };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function divider() { return el("span", "tpsbar-div"); }
  function fmtTok(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }
  function fmtTps(t) { return (t && t > 0) ? (Math.round(t * 10) / 10).toFixed(1) : "—"; }

  /* ---------- 悬浮提示卡片（Tokmon 同款机制） ---------- */
  var tipEl = null, tipTimer = 0, tipTarget = null, tipRaf = 0;

  function ensureTipEl() {
    if (tipEl && tipEl.isConnected) return tipEl;
    tipEl = el("div", "tpsbar-tip");
    document.body.appendChild(tipEl);
    return tipEl;
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tipTimer = 0;
    tipTarget = null;
    if (tipRaf) { cancelAnimationFrame(tipRaf); tipRaf = 0; }
    if (tipEl) tipEl.classList.remove("on");
  }
  function placeTip(target) {
    var tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    var r = target.getBoundingClientRect();
    var left = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 8));
    var top = r.top - th - 8;
    if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - th - 8);
    tipEl.style.left = left + "px";
    tipEl.style.top = Math.max(8, top) + "px";
  }
  function showTip(target, secs) {
    var t = ensureTipEl();
    tipTarget = target;
    t.textContent = "";
    for (var i = 0; i < secs.length; i++) {
      var s = secs[i];
      if (s && s.h) t.appendChild(el("div", "tpsbar-tip-h", s.h));
      else if (s && s.legend) {
        var box = el("div", "tpsbar-tip-legend");
        for (var j = 0; j < s.legend.length; j++) {
          var item = s.legend[j];
          var lrow = el("div", "tpsbar-tip-legend-row" + (item.current ? " tpsbar-tip-legend-cur" : ""));
          var sw = el("span", "tpsbar-tip-swatch");
          sw.style.background = item.color;
          lrow.appendChild(sw);
          lrow.appendChild(el("span", "tpsbar-tip-legend-label", item.label));
          lrow.appendChild(el("span", "tpsbar-tip-legend-range", item.range));
          box.appendChild(lrow);
        }
        t.appendChild(box);
      } else if (s && s.r) {
        var row = el("div", "tpsbar-tip-row");
        row.appendChild(el("span", "tpsbar-tip-k", s.r[0]));
        row.appendChild(el("span", "tpsbar-tip-v", s.r[1]));
        t.appendChild(row);
      } else {
        t.appendChild(el("div", "tpsbar-tip-l", s == null ? "" : String(s)));
      }
    }
    t.classList.remove("on");
    t.style.left = "-9999px";
    t.style.top = "-9999px";
    placeTip(target);
    t.classList.add("on");
  }
  function repositionTip(target) {
    if (!tipEl || !target || !target.isConnected) return;
    var r = target.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) { hideTip(); return; }
    placeTip(target);
  }
  function onViewportChange() {
    if (tipEl && tipEl.classList.contains("on") && tipTarget && tipTarget.isConnected) {
      if (tipRaf) return;
      tipRaf = requestAnimationFrame(function () {
        tipRaf = 0;
        if (tipEl && tipEl.classList.contains("on")) repositionTip(tipTarget);
      });
      return;
    }
    hideTip();
  }
  function scheduleTip(target, secs) {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(function () { showTip(target, secs); }, 140);
  }
  function refreshOpenTip(bar) {
    var g = bar.__tipTarget;
    if (!g || !bar.contains(g) || !g.__tip) return;
    if (bar.__tipTarget === g && tipEl && tipEl.classList.contains("on")) showTip(g, g.__tip());
  }

  /* 数据组：图标 + 数值 + 单位；mouseenter/leave 挂悬浮卡片 */
  function makeGroup(iconHtml, unitText) {
    var g = el("span", "tpsbar-grp");
    var ui = { g: g };
    if (iconHtml) {
      ui.ic = el("span", "tpsbar-ic");
      ui.ic.innerHTML = iconHtml;
      g.appendChild(ui.ic);
    }
    ui.val = el("span", "tpsbar-val", "");
    g.appendChild(ui.val);
    ui.unit = el("span", "tpsbar-unit", unitText || "");
    g.appendChild(ui.unit);
    g.addEventListener("mouseenter", function () {
      var bar = g.closest(".tpsbar-root");
      if (!bar || bar.__tipSuppressed) return;
      if (bar.__tipTarget === g && tipEl && tipEl.classList.contains("on")) return;
      bar.__tipTarget = g;
      if (g.__tip) scheduleTip(g, g.__tip());
      else hideTip();
    });
    g.addEventListener("mouseleave", function () {
      var bar = g.closest(".tpsbar-root");
      if (!bar) return;
      bar.__tipSuppressed = false;
      if (bar.__tipTarget === g) { bar.__tipTarget = null; hideTip(); }
    });
    return ui;
  }
  function setGroup(ui, value, unit) {
    ui.val.textContent = value == null ? "" : String(value);
    ui.unit.textContent = unit || "";
  }

  /* ---------- 条子 UI：四槽位 ---------- */
  function createBarUI(bar) {
    var ui = {};
    ui.rate = makeGroup(ICONS.bolt, "tok/s");
    ui.rate.g.classList.add("tpsbar-rate");
    ui.rate.g.classList.add("tpsbar-rate-dim");
    bar.appendChild(ui.rate.g);
    ui.spark = el("span", "tpsbar-spark");
    ui.sparkBars = [];
    for (var i = 0; i < 8; i++) {
      var b = el("span", "tpsbar-bar");
      ui.spark.appendChild(b);
      ui.sparkBars.push(b);
    }
    bar.appendChild(ui.spark);
    bar.appendChild(divider());
    ui.mid = makeGroup(ICONS.timer, "");
    bar.appendChild(ui.mid.g);
    bar.appendChild(divider());
    ui.sess = makeGroup(ICONS.chat, "");
    bar.appendChild(ui.sess.g);
    bar.appendChild(divider());
    ui.today = makeGroup(ICONS.box, "");
    bar.appendChild(ui.today.g);
    /* 按下条子时抑制悬浮卡片（拖选/点击不弹） */
    bar.addEventListener("mousedown", function () {
      bar.__tipSuppressed = true;
      hideTip();
    });
    bar.addEventListener("mouseleave", function () { bar.__tipSuppressed = false; });
    return ui;
  }

  function setRateTier(ui, tier) { // ok | warn | bad | dim
    ui.rate.g.classList.remove("tpsbar-rate-ok", "tpsbar-rate-warn", "tpsbar-rate-bad", "tpsbar-rate-dim");
    ui.rate.g.classList.add("tpsbar-rate-" + tier);
  }

  function renderBar(bar) {
    var ui = bar.__ui;
    if (!payload || !payload.ok) {
      setRateTier(ui, "dim");
      setGroup(ui.rate, "服务离线", "");
      for (var i = 0; i < ui.sparkBars.length; i++) ui.sparkBars[i].style.height = "2px";
      setGroup(ui.mid, "—", "");
      setGroup(ui.sess, "—", "");
      setGroup(ui.today, "—", "");
      return;
    }
    var rate = payload.rate != null ? Number(payload.rate) : null;
    var median = payload.median != null ? Number(payload.median) : null;
    var peak = payload.peak != null ? Number(payload.peak) : null;
    var generating = payload.state === "generating";

    var tier = "dim";
    if (rate != null && median != null && median > 0) {
      var ratio = rate / median;
      if (ratio >= 0.85) tier = "ok";
      else if (ratio >= 0.5) tier = "warn";
      else tier = "bad";
    }
    setRateTier(ui, generating && rate != null ? tier : "dim");

    if (generating) {
      setGroup(ui.rate, rate != null ? fmtTps(rate) : "生成中…", rate != null ? "tok/s" : "");
      setGroup(ui.mid,
        payload.ttftSec != null ? Number(payload.ttftSec).toFixed(1) : "—",
        payload.ttftSec != null ? "s 首字" : "首字");
    } else {
      /* 空闲：同样显示 tok/s 单位（灰色弱化），不显示"几秒前" */
      setGroup(ui.rate, rate != null ? fmtTps(rate) : "暂无数据", rate != null ? "tok/s" : "");
      setGroup(ui.mid,
        median != null ? fmtTps(median) : "—",
        median != null ? "· 峰 " + fmtTps(peak || 0) : "");
    }

    setGroup(ui.sess, fmtTok(payload.sessionTokens), "");
    setGroup(ui.today, fmtTok(payload.todayTokens), "");

    /* 悬浮卡片内容（函数：悬停时取最新值） */
    var TIER_VAR = {
      ok: "var(--color-success,#4ade80)",
      warn: "var(--color-warning,#fbbf24)",
      bad: "var(--color-danger,#f87171)",
      dim: "var(--color-foreground-subtle,#8791a3)"
    };
    ui.rate.g.__tip = function () {
      return [
        { h: "输出速率" },
        { legend: [
          { color: TIER_VAR[generating && rate != null ? tier : "dim"],
            label: "最近完成段", range: rate != null ? fmtTps(rate) + " tok/s" : "暂无", current: true },
          { color: "var(--color-foreground-subtle,#8791a3)",
            label: "近5段中位", range: median != null ? fmtTps(median) + " tok/s" : "—" },
          { color: "var(--color-success,#4ade80)",
            label: "会话峰值", range: peak != null ? fmtTps(peak) + " tok/s" : "—" }
        ] },
        { legend: [
          { color: "var(--color-success,#4ade80)", label: "≥85% 中位", range: "绿" },
          { color: "var(--color-warning,#fbbf24)", label: "50–85% 中位", range: "黄" },
          { color: "var(--color-danger,#f87171)", label: "<50% 中位", range: "红" }
        ] },
        "口径：(输出+思考) ÷ 生成时长（首token→完成）"
      ];
    };
    if (generating) {
      ui.mid.g.__tip = function () {
        return [
          { h: "首字延迟" },
          { r: ["本轮首字", payload.ttftSec != null ? Number(payload.ttftSec).toFixed(1) + " s" : "—"] },
          "发出消息到收到第一个 token 的等待时间"
        ];
      };
    } else {
      ui.mid.g.__tip = function () {
        return [
          { h: "速率统计" },
          { r: ["近5段加权均值", median != null ? fmtTps(median) + " tok/s" : "—"] },
          { r: ["会话峰值", peak != null ? fmtTps(peak) + " tok/s" : "—"] }
        ];
      };
    }
    var ss = payload.sessionStats || {};
    ui.sess.g.__tip = function () {
      return [
        { h: "本会话累计" },
        { legend: [
          { color: "var(--color-info,#8791a3)", label: "输入（含缓存读）", range: fmtTok(ss.input) },
          { color: "var(--color-success,#4ade80)", label: "输出", range: fmtTok(ss.output) },
          { color: "var(--color-warning,#fbbf24)", label: "其中缓存读", range: fmtTok(ss.cacheRead) }
        ] },
        { r: ["合计（输入+输出）", fmtTok(ss.tokens != null ? ss.tokens : payload.sessionTokens)] },
        { r: ["完成请求", (ss.requests || 0) + " 次"] },
        "口径：computed_total_tokens = 输入(含缓存读) + 输出，仅已完成请求"
      ];
    };
    var ts = payload.todayStats || {};
    ui.today.g.__tip = function () {
      return [
        { h: "今日累计（全部会话）" },
        { legend: [
          { color: "var(--color-info,#8791a3)", label: "输入（含缓存读）", range: fmtTok(ts.input) },
          { color: "var(--color-success,#4ade80)", label: "输出", range: fmtTok(ts.output) },
          { color: "var(--color-warning,#fbbf24)", label: "其中缓存读", range: fmtTok(ts.cacheRead) }
        ] },
        { r: ["合计（输入+输出）", fmtTok(ts.tokens != null ? ts.tokens : payload.todayTokens)] },
        { r: ["完成请求", (ts.requests || 0) + " 次"] },
        "统计范围：本地当天 0 点起"
      ];
    };

    var spark = (payload.spark && payload.spark.length) ? payload.spark : [];
    var peakSpark = 0;
    for (var j = 0; j < spark.length; j++) if (Number(spark[j]) > peakSpark) peakSpark = Number(spark[j]);
    for (var k = 0; k < ui.sparkBars.length; k++) {
      var b = ui.sparkBars[k];
      if (k < spark.length && peakSpark > 0) {
        b.style.height = (2 + Math.round((Number(spark[k]) / peakSpark) * 9)) + "px";
      } else {
        b.style.height = "2px";
      }
    }

    refreshOpenTip(bar);
  }

  /* ---------- 实例：一个 composer 一条（优先嵌入输入卡片内部，兜底 fixed 悬浮） ---------- */
  function findCard(composer) {
    /* 从输入框向上找「卡片容器」：有圆角的边框/背景盒，宽度包住 composer。
     * ZCode 界面改版频繁，不认类名，只认视觉特征。（Tokmon 同款） */
    var cr = composer.getBoundingClientRect();
    var p = composer.parentElement;
    for (var i = 0; p && i < 8 && p !== document.body; i++, p = p.parentElement) {
      var cs = window.getComputedStyle(p);
      var radius = parseFloat(cs.borderRadius) || 0;
      var boxed = radius >= 8 && (cs.borderStyle !== "none" && cs.borderWidth !== "0px" ||
        cs.backgroundColor !== "rgba(0, 0, 0, 0)" || cs.backgroundImage !== "none");
      var r = p.getBoundingClientRect();
      var wraps = r.width >= cr.width * 0.9 && r.width <= cr.width * 1.6 &&
        r.bottom >= cr.bottom - 4 && r.top <= cr.top + 4;
      if (boxed && wraps && p.clientHeight > cr.height) return p;
    }
    return null;
  }

  function spawnInstance(composer) {
    var bar = el("div", "tpsbar-root");
    var style = document.createElement("style");
    style.textContent = CSS;
    bar.appendChild(style);
    bar.__ui = createBarUI(bar);

    var disposed = false, mode = "fixed", host = null, mo = null, posTimer = 0;
    renderBar(bar);

    function attach() {
      var card = findCard(composer);
      if (card) {
        mode = "in";
        host = card;
        bar.classList.add("tpsbar-in");
        card.appendChild(bar);
        /* React 重渲染可能移除外来子节点：卡片子树变化时若条被移除则重插 */
        if (mo) mo.disconnect();
        mo = new MutationObserver(function () {
          if (disposed) return;
          if (bar.parentElement !== card && card.isConnected) {
            card.appendChild(bar);
          }
        });
        mo.observe(card, { childList: true });
      } else {
        mode = "fixed";
        host = document.body;
        document.body.appendChild(bar);
      }
    }

    function position() {   /* 仅 fixed 形态需要跟随；含屏幕外保护 */
      if (disposed || mode !== "fixed") return;
      var c = composer;
      if (!c.isConnected) return;
      var r = c.getBoundingClientRect();
      if (r.width <= 40 || r.bottom <= 0 || r.top > window.innerHeight) return;
      var top = r.bottom + 6;
      var bh = bar.offsetHeight || 24;
      if (top + bh > window.innerHeight - 4) top = Math.max(4, r.top - bh - 6);
      bar.style.top = top + "px";
      var left = r.left;
      var bw = bar.offsetWidth;
      if (left + bw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - bw - 8);
      bar.style.left = left + "px";
    }

    attach();
    if (mode === "fixed") {
      posTimer = setInterval(position, 500);
      window.addEventListener("resize", position);
    }
    position();

    return {
      _el: null,
      render: function () {
        if (!disposed) renderBar(bar);
      },
      dispose: function () {
        disposed = true;
        if (mo) mo.disconnect();
        if (posTimer) clearInterval(posTimer);
        bar.remove();
      }
    };
  }
  var MODES = window.__tpsbarModes = { count: 0 };

  /* ---------- 协调器：600ms 扫描可见 composer（Tokmon 同款：视口下半部、最靠下者） ---------- */
  var SEL = 'textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor';
  var instances = window.__tpsbarInstances = [];

  function tick() {
    try {
      var best = null, bestTop = -1;
      var all = document.querySelectorAll(SEL);
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        if (e.closest && e.closest('[role="dialog"]')) continue;   // 弹窗内不是聊天输入框
        if (e.closest && e.closest(".tpsbar-root")) continue;
        var r = e.getBoundingClientRect();
        if (!(r.width > 40 && r.height > 8 && r.bottom > 0 && r.top < window.innerHeight)) continue;
        if (r.top < window.innerHeight * 0.45) continue;           // 输入框在视口下半部
        if (r.top > bestTop) { best = e; bestTop = r.top; }
      }
      if (!best) return;
      /* 单窗口单条策略：只保留锚在当前 composer 上的实例，其余原地销毁 */
      for (var k = instances.length - 1; k >= 0; k--) {
        var inst = instances[k];
        if (inst._el !== best || !inst._el || !inst._el.isConnected) {
          try { inst.dispose(); } catch (e) { }
          instances.splice(k, 1);
        }
      }
      if (instances.length === 0) {
        var fresh = spawnInstance(best);
        fresh._el = best;
        instances.push(fresh);
        MODES.count = instances.length;
      }
    } catch (e) { }
  }

  tick();
  window.__tpsbarCoordTimer = setInterval(tick, 600);
  window.addEventListener("scroll", tick, true);
  window.addEventListener("resize", tick);
  window.__tpsbarWinHide = onViewportChange;
  window.addEventListener("scroll", window.__tpsbarWinHide, true);
  window.addEventListener("resize", window.__tpsbarWinHide);

  /* ---------- 主进程数据入口 ---------- */
  window.__tpsbarUpdate = function (p) {
    payload = p;
    for (var i = 0; i < instances.length; i++) instances[i].render();
  };
})();
