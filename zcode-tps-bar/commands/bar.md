---
description: 安装/卸载/检查 TPS Bar 的输入框下方吞吐条（asar 注入）
---

操作 zcode-tps-bar 吞吐条（asar 注入式，插件根目录为本命令文件上两级目录）。

执行步骤：

1. 用户要"安装/恢复悬浮条"时：提醒**先完全退出 ZCode**，然后运行根目录 `install-bar.cmd`（或 `node scripts/patch-asar.mjs install`），再重开 ZCode；
2. 用户要"卸载悬浮条"时：同样先退出 ZCode，运行 `uninstall-bar.cmd`；
3. 用户问吞吐数据本身时：运行 `node scripts/server.mjs --once` 打印一次快照 JSON，用中文解读关键数字（速率/中位/峰/首字/会话/今日），不要原样贴 JSON；
4. 用户报告"条子消失"时：通常是 ZCode 升级覆盖了 app.asar，按第 1 步重新注入即可。
