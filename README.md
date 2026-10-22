# zcode-tps-bar · TPS Bar

> ZCode 输入框下方的 TPS 吞吐条 —— 速率、首字延迟、会话与今日用量，一眼可得。

本仓库是一个 **ZCode 本地插件市场**，当前收录：

| 插件 | 版本 | 说明 |
|---|---|---|
| [zcode-tps-bar](zcode-tps-bar/) | 0.3.0 | 注入式吞吐条：四槽位、按会话中位数三档着色、生成中/空闲双态 |

```text
⚡ 87.3 tok/s ▂▄▆█▅▃▂▁ │ ⏱ 首字 1.2s │ 💬 52.3k │ 📦 1.2M     ← 生成中（挂在输入框正下方）
⚡ 71.2 tok/s          │ 均 45.3 · 峰 108.1 │ 💬 52.3k │ 📦 1.2M   ← 空闲（灰色弱化）
```

（走势为 DOM 矩形底对齐，无字体 fallback 齐平问题；方块字符仅作示意。）

## 安装

1. **装插件**：ZCode → 插件市场 → 添加 → 添加插件市场 → 粘贴本仓库根目录（或推到 GitHub 后填仓库地址）→ 个人 → TPS Bar → 安装。
2. **注入条子**：完全退出 ZCode → 双击 `zcode-tps-bar/install-bar.cmd` → 重开 ZCode。

> 卸载：`uninstall-bar.cmd` 剥离注入（asar 入口逐字节还原），再在 设置→插件 里移除。

## 特性

- **Tokmon 同款挂点**：asar 注入渲染进程，条子跟随输入框矩形、优先嵌入输入卡片内部，React 重渲染自动重插。
- **四槽位**：⚡ 速率 + 8 根矩形走势 │ 首 token 延迟 ↔ 近5段均值·峰值 │ 💬 会话累计 │ 📦 今日累计。
- **中位数三档着色**：≥85% 中位 绿 · 50–85% 黄 · <50% 红——相对该模型自身基线，跨模型可比；空闲转灰。
- **悬浮卡片**：速率三色图例 + 着色示例；累计给出输入/输出/缓存读/请求数分类明细。
- **生成中/空闲双态**：钩子记录提问/收尾时刻，生成中看即时速度与首字，空闲看统计与余量。
- **零依赖**：纯 Node（≥22.5，内置 node:sqlite）+ 原生 JS，无第三方包。

## 数据口径

- 段速率 = `(output_tokens + reasoning_tokens) ÷ (completed_at − first_token_at)`；<200ms 或 >10min 的段不计入。
- 累计 = `computed_total_tokens`（= 输入(含缓存读) + 输出），仅统计已完成请求。
- 数据源：只读 `~/.zcode/cli/db/db.sqlite`，不修改任何客户端业务数据；条子 UI 经 asar 注入，`uninstall` 可逐字节还原。

## 架构一览

```text
app.asar 入口尾部 ──dynamic import──▶ ~/.zcode/tps-bar-runtime/inject-main.cjs
                                        ├─ 守护并轮询 server.mjs（1.5s）
                                        ├─ 推送快照 → window.__tpsbarUpdate
                                        └─ 注入 overlay.js（mtime 热更新）
overlay.js ── 扫描 composer → 嵌入输入卡片（兜底 fixed）
hooks/ ── UserPromptSubmit/Stop 记录提问/收尾时刻 → 生成中/空闲 判定
scripts/patch-asar.mjs ── asar 重打包（install/remove/check）
```

细节见 [zcode-tps-bar/README.md](zcode-tps-bar/README.md)。

## License

[MIT](LICENSE)
