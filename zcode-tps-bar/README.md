# zcode-tps-bar

注入式输入框下方吞吐条（Tokmon 同款挂点，自研四槽位定稿设计）。只读 ZCode usage 数据库，不与 zcode-tps-monitor / Tokmon 冲突（三者同读 `~/.zcode/cli/db/db.sqlite`）。

```
⚡ 87.3 tok/s ▂▄▆█▅▃▂▁ │ ⏱ 首字 1.2s │ 💬 52.3k │ 📦 1.2M     ← 生成中（挂在输入框正下方 6px）
⚡ 71.2 · 18s前        │ 均 45.3 · 峰 108.1 │ 💬 52.3k │ 📦 1.2M   ← 空闲
```

（走势条为 DOM 矩形 flex 底对齐，**无字体 fallback 齐平问题**；方块字符仅作示意。）

## 槽位

| 槽位 | 生成中 | 空闲 |
|---|---|---|
| ⚡ 速率 | 最近完成段速率，按会话中位数着色：≥85% 绿 · 50–85% 黄 · <50% 红 | 上次速率 · Ns前（转灰） |
| ⏱ 中段 | 首 token 延迟 | 近 5 段均值 · 会话峰值（灰） |
| 💬 会话 | 本会话累计 token（含输入+输出，常驻） | 同左 |
| 📦 今日 | 今日全部会话累计 token（常驻） | 同左 |

## 安装 / 卸载（与 Tokmon 相同的 UX）

```cmd
install-bar.cmd     # 完全退出 ZCode 后运行：同步运行时 + 注入 asar
uninstall-bar.cmd   # 剥离注入（剥离后 asar 入口与官方版本逐字节一致）
```

装为 ZCode 插件（本地市场 `C:\Users\xiegq20\.zcode\plugins`）后，钩子生效：提问/收尾时刻驱动"生成中↔空闲"切换。

## 架构

```
app.asar 入口尾部 ──dynamic import──▶ ~/.zcode/tps-bar-runtime/inject-main.cjs（主进程）
                                        ├─ 守护并轮询 server.mjs（node 子进程，1.5s）
                                        ├─ 推送 payload → 各窗口 window.__tpsbarUpdate
                                        └─ 注入 overlay.js（mtime 热更新）
overlay.js（渲染进程）─── 扫描可见 composer → 条子挂其正下方 6px，跟随矩形
hooks/ ── UserPromptSubmit/Stop 记录提问/收尾时刻 → ~/.zcode/tps-bar/state.json
scripts/patch-asar.mjs ── asar 重打包（install/remove/check，[tpsbar] 标记幂等，remove 后逐字节还原）
```

- 客户端升级会覆盖 app.asar → 悬浮条消失 = 重跑 `install-bar.cmd`。
- ZCode 运行中无法注入（asar 被锁），必须先完全退出。

## 数据口径

- 段速率 = `(output_tokens + reasoning_tokens) / (completed_at - first_token_at)`（与 zcode-tps-monitor 对齐）；<200ms 或 >10min 的段不计入。
- 会话/今日累计 = `computed_total_tokens`（= input+output；input 列本身已含缓存读，勿再叠加），仅统计 `completed` 请求。
- "生成中"= 钩子记录的提问时刻晚于上一轮收尾时刻且同属当前活跃会话。
- 调试：`node scripts/server.mjs --once` 打印一次快照 JSON。

## 卸载

`uninstall-bar.cmd` 剥离注入 + 删除本目录 + 在 设置→插件 里移除即可，无其他残留。
