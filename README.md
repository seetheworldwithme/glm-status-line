<h1 align="center">glm-status-line</h1>

<p align="center">
  为 Claude Code 打造的智谱 GLM Coding Plan 全功能状态栏<br>
  <strong>一条状态栏看清：配额 · 周配速 · 消耗倍率 · 上下文 · MCP 用量</strong>
</p>

<p align="center">
  <a href="./README.en.md">English</a>
</p>

## 这是什么

`glm-status-line` 把 GLM（智谱 / ZAI）Coding Plan 的所有关键用量聚合成**一行**状态栏，直接显示在 Claude Code 底部：

```
GLM Lite █████████░ 91% | W █████▒▒▒░░ 47% 11:10 | 14:47 | 倍率 3x | ctx ███░░░ 45% (glm-4.7/200K) | MCP ████░░░░░░ 47% | 今日 in 1.2k out 0.8k cr 45k cw 3k | 180 tok/s
```

**一眼看清**：

| 段 | 含义 |
|---|---|
| `GLM Lite █████████░ 91%` | 套餐 5 小时配额剩余量 + 进度条 |
| `W █████▒▒▒░░ 47% 11:10` | 周配额消耗 + 理论预算阴影（▒）+ 重置时间 |
| `14:47` | 5 小时配额重置时间 |
| `倍率 3x` | 当前模型的**消耗倍率**（仅 premium 模型且 > 1x 时显示） |
| `ctx ███░░░ 45% (glm-4.7/200K)` | 上下文窗口用量 + 模型 / 窗口大小 |
| `MCP ████░░░░░░ 47%` | MCP 工具用量（已用 / 总计） |
| `今日 in 1.2k out 0.8k cr 45k cw 3k` | 当日 token 吞吐量（input / output / cache-read / cache-write；<1M 显示 `k`，≥1M 显示 `M`） |
| `180 tok/s` | 当前会话实时生成速度（最近几轮 output token / 秒） |

超速或临近上限时自动变色警示，避免配额耗尽中断工作流。


## 30 秒快速开始

**一次性查询（无需安装）：**

```bash
npx glm-status-line
```

**状态栏集成（推荐）：**

```bash
npm install -g glm-status-line
glm-status-line install
```

安装后，Claude Code 底部状态栏会自动显示完整用量。可随时在终端运行 `glm-status-line` 快速查看，无需启动 Claude Code。

## 消耗倍率（倍率）

premium 模型在**高峰时段**会按倍率消耗配额。本工具自动根据当前模型与时间（**UTC+8**）计算并显示：

| 时段 | 倍率 |
|---|---|
| 高峰（默认 14:00–18:00 UTC+8） | `3x` |
| 非高峰（促销期内，默认至 2026-09-30） | `1x`（≤1x 不显示） |
| 非高峰（促销期后） | `2x` |

**显示规则**：仅当模型为 premium **且**倍率 > 1x 时才显示（默认 premium 模型：`glm-5`、`glm-5.1`、`glm-5.2`、`glm-5-turbo`）。

### 自定义倍率

智谱调整定价时，无需等更新，直接本地覆盖：

```bash
glm-status-line config set multiplier-premium-models glm-5,glm-5.2,glm-5.3
glm-status-line config set multiplier-peak-start 14:00      # UTC+8
glm-status-line config set multiplier-peak-end 18:00
glm-status-line config set multiplier-peak 3.0
glm-status-line config set multiplier-off-peak 2.0
glm-status-line config set multiplier-promo-off-peak 1.0
glm-status-line config set multiplier-promo-expires 2026-09-30
```

清除单项：`glm-status-line config unset multiplier-peak`。

## 常见工作流

### 📊 快速查看用量

```bash
glm-status-line
```

### 🎨 定制状态栏样式

```bash
glm-status-line configure   # 交互式 TUI，实时预览，所见即所得
```

操作：`↑↓` 选择组件，`Enter` 编辑，`Tab` 切换样式，`Space` 开关显示；`g` 全局选项；`s` 保存，`q` 退出。
组件列表现已包含 `level`、`5h`、`week`、`reset`、`倍率`、`ctx`、`mcp`、`today`、`rate`，可单独开关。

非交互式：

```bash
glm-status-line config set style compact   # 紧凑模式
glm-status-line config set theme light     # 浅色主题
glm-status-line config set display used    # 显示已用量而非剩余量
```

### 🔧 脚本中调用

```bash
glm-status-line --json
```

输出结构化 JSON（含 `quotas` 与 `mcp`），便于自动化。

### 🤖 更换模型 / 调整上下文窗口

```bash
glm-status-line model set glm-5.3 400K
glm-status-line model list
```

## 配色逻辑

**配额百分比**（按剩余量）：
- 🟢 绿 — 剩余 ≥ 60%
- 🟡 黄 — 剩余 30%–60%
- 🔴 红 — 剩余 < 30%

**周配速**（按使用速度 vs 理论预算）：
- 🟢 ≤ 1.1x ｜ 🟡 1.1x–1.3x ｜ 🔴 > 1.3x

**MCP 用量**（按已用占比）：
- 🟢 ≤ 80% ｜ 🟡 81%–90% ｜ 🔴 ≥ 91%

**倍率**：始终红色高亮（提醒高峰加价）。

## 命令参考

```bash
glm-status-line [--style text|compact|bar] [--display left|used] [--theme dark|light|mono] [--json]
glm-status-line install [--force]
glm-status-line uninstall
glm-status-line version
glm-status-line check-update
glm-status-line configure
glm-status-line config show
glm-status-line config set <key> <value>        # 见下表
glm-status-line config unset <key>
glm-status-line config reset [--models] [--yes]
glm-status-line model list | get | set | remove
glm-status-line commands [--json]
```

`config set` 支持的 key：

| 分组 | key |
|---|---|
| 显示 | `style`、`display`、`theme`、`minimalist`、`raw-values`、`reset-format` |
| 鉴权 | `auth-token`、`base-url` |
| 配速 | `work-days` |
| 倍率 | `multiplier-premium-models`、`multiplier-peak-start`、`multiplier-peak-end`、`multiplier-peak`、`multiplier-off-peak`、`multiplier-promo-off-peak`、`multiplier-promo-expires` |

运行 `glm-status-line --help` 查看完整说明。

## 自定义鉴权（代理 / 网关）

```bash
glm-status-line config set auth-token <your-real-token>
glm-status-line config set base-url https://open.bigmodel.cn/api/anthropic   # 国内
# 或
glm-status-line config set base-url https://api.z.ai/api/anthropic           # 国际
```

**鉴权优先级**（从高到低）：
1. `config set` 持久化的值
2. 环境变量 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`
3. `~/.claude/settings.json` 中的 `env` 字段

## 故障排查

- **状态栏不显示配额**：检查鉴权（`glm-status-line`），或端点不是 `open.bigmodel.cn` / `api.z.ai`。
- **显示 quota unavailable**：智谱接口异常或网络问题，稍后会自动重试。
- **重装**：`glm-status-line uninstall && glm-status-line install --force`。
- **调试**：`GLM_STATUS_DEBUG=1 glm-status-line`（上下文窗口调试信息输出到 stderr）。

## 技术说明

- 展示 `TOKENS_LIMIT`（5h / 周）与 `MCP_LIMIT` / `TIME_LIMIT` 配额。
- 周配额进度条阴影（▒）是按已过工作日计算的每日应耗基准线。
- 上下文窗口使用率优先从原始 token 数计算，模型映射缺失时该段自动隐藏。
- 倍率按 **UTC+8** 时间判定高峰/非高峰，与 GLM 实际计费时区一致。
- **当日 token（今日）**：智谱未开放当日用量接口，本段从 Claude Code 本地 transcript（`~/.claude/projects/*/*.jsonl`）累加当日 `message.usage`，按本地自然日过滤，60 秒缓存。仅统计 Claude Code 会话吞吐量（含 cache read/write），非 GLM 配额加权值；`cr` 通常远大于其它三项（每轮都重读缓存上下文）。数值 <1M 显示 `k`、≥1M 显示 `M`。
- **实时速度（tok/s）**：取当前会话 transcript 最近 2~3 轮 assistant 消息，用 `output_tokens ÷ 该轮墙钟耗时`（含 prefill）求平均；10 秒缓存。反映最近一次完成的生成速度，正在生成的轮次尚未落盘故不计入。
- 智能缓存：按会话、TTL 和 token 用量分级刷新；`SessionStart` hook 预刷新。
- 自动识别国内（`open.bigmodel.cn`）与国际（`api.z.ai`）端点；非 GLM 提供商自动禁用。
- **零运行时依赖**。

## 许可证

[MIT](./LICENSE)
