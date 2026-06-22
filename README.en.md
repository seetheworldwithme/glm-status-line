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
GLM Lite █████████░ 91% | W █████▒▒▒░░ 47% 11:10 | 14:47 | 倍率 3x | ctx ███░░░ 45% (glm-4.7/200K) | MCP ████░░░░░░ 47% | 今日 in 1.2k out 0.8k cr 45k cw 3k | 180 tok/s
```

**At a glance**:

| Segment | Meaning |
|---|---|
| `GLM Lite █████████░ 91%` | 5-hour plan quota remaining + bar |
| `W █████▒▒▒░░ 47% 11:10` | Weekly consumption + theoretical-budget shade (▒) + reset time |
| `14:47` | 5-hour quota reset time |
| `倍率 3x` | Current model's **consumption multiplier** (premium models, > 1x only) |
| `ctx ███░░░ 45% (glm-4.7/200K)` | Context-window usage + model / window size |
| `MCP ████░░░░░░ 47%` | MCP tool usage (used / total) |
| `今日 in 1.2k out 0.8k cr 45k cw 3k` | Today's token throughput (input / output / cache-read / cache-write; `k` under 1M, `M` at 1M+) |
| `180 tok/s` | Current session's live generation speed (output tok/s over the last few turns) |

Segments turn red automatically as you near a cap or outpace your budget, so you don't get cut off mid-workflow.

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

After installing, the full usage appears in Claude Code's bottom status line. You can also run `glm-status-line` in any terminal for a quick check without launching Claude Code.

## Consumption multiplier (倍率)

Premium models consume quota at a multiplied rate during **peak hours**. The tool computes and displays it automatically from the current model and time (**UTC+8**):

| Window | Rate |
|---|---|
| Peak (default 14:00–18:00 UTC+8) | `3x` |
| Off-peak (during promo, default through 2026-09-30) | `1x` (≤1x hidden) |
| Off-peak (after promo) | `2x` |

**Display rule**: shown only when the model is premium **and** the rate > 1x. Default premium models: `glm-5`, `glm-5.1`, `glm-5.2`, `glm-5-turbo`.

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

## Common workflows

### 📊 Quick usage check

```bash
glm-status-line
```

### 🎨 Customize the status line

```bash
glm-status-line configure   # interactive TUI, live preview, WYSIWYG
```

Controls: `↑↓` to pick a component, `Enter` to edit, `Tab` to cycle styles, `Space` to toggle; `g` for global options; `s` to save, `q` to quit.
The component list now includes `level`, `5h`, `week`, `reset`, `倍率`, `ctx`, `mcp`, `today`, `rate` — each can be toggled individually.

Non-interactive:

```bash
glm-status-line config set style compact   # compact mode
glm-status-line config set theme light     # light theme
glm-status-line config set display used    # show used instead of remaining
```

### 🔧 Use in scripts

```bash
glm-status-line --json
```

Outputs structured JSON (with `quotas` and `mcp`) for automation.

### 🤖 Change model / adjust context window

```bash
glm-status-line model set glm-5.3 400K
glm-status-line model list
```

### ⚡ Live streaming speed (tok/s proxy)

By default, `tok/s` is taken from the **last few completed** turns in the transcript (token counts only appear after a whole turn ends, so it reflects the "previous turn"). To see the **instantaneous speed of the turn currently generating**, enable the local rate proxy: it transparently forwards requests between Claude Code and Zhipu, parses the SSE stream as it flows, and writes live output tok/s into a status file for the status line to read.

```bash
glm-status-line proxy install     # install a launchd/macOS or systemd/Linux service and rewrite ANTHROPIC_BASE_URL to point at the local proxy
```

After installing, **restart Claude Code** — the `tok/s` segment in the status line will update live during generation. To undo and restore:

```bash
glm-status-line proxy uninstall  # stop the service + restore ANTHROPIC_BASE_URL
```

Run it in the foreground without installing a service (Ctrl+C to stop):

```bash
glm-status-line proxy start [--port 7821] [--upstream https://open.bigmodel.cn/api/anthropic]
glm-status-line proxy status     # current live-rate snapshot
```

**Notes & safety**:

- The proxy listens only on `127.0.0.1` and is not exposed; it **does not store your token** (Claude Code sends the `Authorization` header to the proxy, which forwards it verbatim to Zhipu); it only writes token counts and the rate into a local status file — **nothing is persisted to disk**.
- Once the proxy is installed, `ANTHROPIC_BASE_URL` becomes `http://127.0.0.1:7821`. This tool handles the passthrough: quota detection (`isGLM`) and the quota endpoint are still derived from your original real upstream, so **quota display is unaffected**.
- If the proxy isn't running or you're not generating, `tok/s` falls back to the transcript algorithm.

## Color logic

**Quota %** (by remaining):
- 🟢 green — remaining ≥ 60%
- 🟡 yellow — remaining 30–60%
- 🔴 red — remaining < 30%

**Weekly pace** (usage speed vs theoretical budget):
- 🟢 ≤ 1.1x | 🟡 1.1–1.3x | 🔴 > 1.3x

**MCP usage** (by used share):
- 🟢 ≤ 80% | 🟡 81–90% | 🔴 ≥ 91%

**Multiplier**: always highlighted red (peak surcharge alert).

## Command reference

```bash
glm-status-line [--style text|compact|bar] [--display left|used] [--theme dark|light|mono] [--json]
glm-status-line install [--force]
glm-status-line uninstall
glm-status-line version
glm-status-line check-update
glm-status-line configure
glm-status-line config show
glm-status-line config set <key> <value>        # see table below
glm-status-line config unset <key>
glm-status-line config reset [--models] [--yes]
glm-status-line model list | get | set | remove
glm-status-line proxy install | uninstall        # install service + rewrite base-url; see "Live streaming speed" above
glm-status-line proxy start [--port <n>] [--upstream <url>]
glm-status-line proxy status
glm-status-line commands [--json]
```

Keys supported by `config set`:

| Group | key |
|---|---|
| Display | `style`, `display`, `theme`, `minimalist`, `raw-values`, `reset-format` |
| Auth | `auth-token`, `base-url` |
| Pace | `work-days` |
| Multiplier | `multiplier-premium-models`, `multiplier-peak-start`, `multiplier-peak-end`, `multiplier-peak`, `multiplier-off-peak`, `multiplier-promo-off-peak`, `multiplier-promo-expires` |

Run `glm-status-line --help` for the full reference.

## Auth override (proxy / gateway)

```bash
glm-status-line config set auth-token <your-real-token>
glm-status-line config set base-url https://open.bigmodel.cn/api/anthropic   # CN
# or
glm-status-line config set base-url https://api.z.ai/api/anthropic           # intl
```

**Auth priority** (high to low):
1. Values persisted via `config set`
2. `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` environment variables
3. The `env` field in `~/.claude/settings.json`

## Troubleshooting

- **No quota in the status line**: check auth (`glm-status-line`), or the endpoint isn't `open.bigmodel.cn` / `api.z.ai`.
- **Shows "quota unavailable"**: Zhipu API hiccup or network issue; it auto-retries shortly.
- **Reinstall**: `glm-status-line uninstall && glm-status-line install --force`.
- **Debug**: `GLM_STATUS_DEBUG=1 glm-status-line` (context-window debug info to stderr).

## Technical notes

- Renders `TOKENS_LIMIT` (5h / weekly) and `MCP_LIMIT` / `TIME_LIMIT` quotas.
- The weekly bar's shade (▒) is the per-day baseline computed from elapsed workdays.
- Context-window usage is computed from raw token counts when available; the segment hides itself if the model mapping is missing.
- The multiplier judges peak/off-peak by **UTC+8**, matching GLM's actual billing timezone.
- **Today's tokens**: Zhipu exposes no same-day usage API, so this segment sums the day's `message.usage` from Claude Code's local transcripts (`~/.claude/projects/*/*.jsonl`), filtered by local calendar day, 60-second cache. It counts only Claude Code session throughput (including cache read/write), not GLM's quota-weighted value; `cr` is usually far larger than the other three (the cached context is re-read every turn). Values under 1M show `k`, 1M+ show `M`.
- **Live speed (tok/s)**: two sources. ① Default, from transcripts: averages `output_tokens ÷ wall-clock for that turn` over the last 2–3 completed assistant messages, 10-second cache (counts only appear after a turn ends, so it reflects the "previous turn"). ② With the rate proxy enabled (`proxy install`), during generation it prefers the instantaneous rate the proxy writes live — the proxy parses cumulative `output_tokens` from `message_delta` events in the SSE stream and computes tok/s over a ~2.5-second sliding window. Falls back to ① if the proxy is unavailable.
- Smart caching: per-session, TTL, and token-usage-tiered refresh; a `SessionStart` hook pre-refreshes.
- Auto-detects CN (`open.bigmodel.cn`) vs intl (`api.z.ai`) endpoints; disables itself for non-GLM providers.
- **Zero runtime dependencies**.

## License

[MIT](./LICENSE)
