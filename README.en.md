<h1 align="center">glm-status-line</h1>

<p align="center">
  An all-in-one Zhipu GLM Coding Plan status line for Claude Code<br>
  <strong>One bar: quota · weekly pace · consumption multiplier · context · MCP usage</strong>
</p>

<p align="center">
  <a href="./README.md">简体中文</a>
</p>

## What it is

`glm-status-line` aggregates every key GLM (Zhipu / ZAI) Coding Plan usage metric into a **single** status line at the bottom of Claude Code:

```
GLM Lite █████████░ 91% | W █████▒▒▒░░ 47% 11:10 | 14:47 | 倍率 3x | ctx ███░░░ 45% (glm-4.7/200K) | MCP ████░░░░░░ 47%
```

**At a glance**:

| Segment | Meaning |
|---|---|
| `GLM Lite █████████░ 91%` | 5-hour plan quota remaining + bar |
| `W █████▒▒▒░░ 47% 11:10` | Weekly consumption + theoretical-budget shade (▒) + reset time |
| `14:47` | 5-hour quota reset time |
| `倍率 3x` | Current model **consumption multiplier** (premium models, > 1x only) |
| `ctx ███░░░ 45% (glm-4.7/200K)` | Context-window usage + model / window size |
| `MCP ████░░░░░░ 47%` | MCP tool usage (used / total) |

Segments turn red as you near a cap or outpace your budget.

## 30-second start

**One-off query (no install):**

```bash
npx glm-status-line
```

**Status-line integration (recommended):**

```bash
npm install -g glm-status-line
glm-status-line install
```

## Consumption multiplier (倍率)

Premium models consume quota at a multiplied rate during **peak hours**. The tool computes it automatically from the current model and time (**UTC+8**):

| Window | Rate |
|---|---|
| Peak (default 14:00–18:00 UTC+8) | `3x` |
| Off-peak (during promo, default through 2026-09-30) | `1x` (≤1x hidden) |
| Off-peak (after promo) | `2x` |

**Shown only when the model is premium AND the rate > 1x.** Default premium models: `glm-5`, `glm-5.1`, `glm-5.2`, `glm-5-turbo`.

### Customize

Override locally when Zhipu changes pricing — no package update needed:

```bash
glm-status-line config set multiplier-premium-models glm-5,glm-5.2,glm-5.3
glm-status-line config set multiplier-peak-start 14:00      # UTC+8
glm-status-line config set multiplier-peak-end 18:00
glm-status-line config set multiplier-peak 3.0
glm-status-line config set multiplier-off-peak 2.0
glm-status-line config set multiplier-promo-off-peak 1.0
glm-status-line config set multiplier-promo-expires 2026-09-30
```

Clear one: `glm-status-line config unset multiplier-peak`.

## Workflows

```bash
glm-status-line                 # quick check
glm-status-line configure       # interactive TUI with live preview
glm-status-line --json          # structured JSON for scripting
glm-status-line model set glm-5.3 400K
glm-status-line config set theme light
glm-status-line config set display used
```

The `configure` TUI exposes every component (`level`, `5h`, `week`, `reset`, `倍率`, `ctx`, `mcp`) for individual toggling and styling.

## Color logic

- **Quota %** (by remaining): green ≥ 60%, yellow 30–60%, red < 30%.
- **Weekly pace** (usage vs theoretical budget): green ≤ 1.1x, yellow 1.1–1.3x, red > 1.3x.
- **MCP usage** (by used share): green ≤ 80%, yellow 81–90%, red ≥ 91%.
- **Multiplier**: always red (peak surcharge alert).

## Auth override (proxy / gateway)

```bash
glm-status-line config set auth-token <your-real-token>
glm-status-line config set base-url https://open.bigmodel.cn/api/anthropic   # CN
# or
glm-status-line config set base-url https://api.z.ai/api/anthropic           # intl
```

Priority: persisted config > `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` env > `~/.claude/settings.json` `env`.

Run `glm-status-line --help` for the full command reference. Debug: `GLM_STATUS_DEBUG=1 glm-status-line`.

## Technical notes

Zero runtime dependencies. Auto-detects CN (`open.bigmodel.cn`) vs intl (`api.z.ai`) endpoints and disables itself for non-GLM providers. Multiplier time is judged in **UTC+8** to match GLM's billing timezone. Smart per-session/TTL caching with a `SessionStart` pre-refresh hook.

## License

[MIT](./LICENSE)
