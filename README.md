# usage-bar — Claude Code usage bar

A colorful status line and `/usage-bar:usage` report for Claude Code:

Collapsed (default) — one line with what matters most:

```
◆ Opus 5.5 │ ███░░░░░░░░░░░░░░░░░ 16% 156k/1.00M │ ⟲ 6.56M ✎ 121k ↑ 81.4k $3.91 │ 5h 18% · week 20% (session <1%)  ▸ /usage-bar:expand
```

Expanded (`/usage-bar:expand`) — adds detail lines:

```
■ sys 40.4k  ■ you 623  ■ claude 6.2k  ■ calls 74.2k  ■ results 34.6k  ░ free 844k
⟲ cache read 6.56M  ✎ cache write 121k (5m 0 · 1h 121k)  hit 98% │ in 126  out 81.4k (thinking 19.7k) │ reqs 63
⚙ mcp 25 calls │ openviking 14 · chrome 11 │ results 22.7k │ last openviking/search 2m ago
🧠 memory ↓ read 9 (6.1k)  ↑ write 5 (1.2k) │ last add_memory 4m ago
5h ━━──────── 18% +1 session ↻ 59m │ week ━━──────── 20% session <1% ↻ 4d 23h
```

Warnings stay visible even when collapsed: context ≥ 80% (compaction soon) and MCP errors from the last 10 minutes. `⟲` is cache read, `✎` cache write, `↑` output tokens.

- **Context bar**: each category has its own color (system/tools/memory, your messages, Claude replies, tool calls, tool results, free space). The bar shows the % of the window used and the limit.
- **Cache**: total cache-read and cache-write tokens for the session, including subagents. The report splits writes into 5-minute and 1-hour TTL.
- **MCP tools**: calls per server and tool, errors, result tokens (also shown as a separate teal part of the context bar). The report adds a history of recent calls with result previews, plus MCP use across all sessions this week.
- **Memory read/write**: MCP servers that look like memory stores (OpenViking, mem0, `*memory*`) are split into reads (search/read/find…) and writes (add/commit/store…). Override with `memoryServers` (a regex) in `config.json`.
- **Weekly limit**: how much of the weekly limit this session has used, and the total for the week.

## Install

Inside Claude Code:

```
/plugin marketplace add dangerousplay/claude-usage-bar
/plugin install usage-bar@usage-bar-local
/usage-bar:setup --plan max5        # or pro / max20; writes statusLine to ~/.claude/settings.json
```

Or from a shell:

```
claude plugin marketplace add dangerousplay/claude-usage-bar
claude plugin install usage-bar@usage-bar-local
```

Then restart Claude Code and run `/usage-bar:setup`. Note that setup replaces any existing `statusLine` in `~/.claude/settings.json`.

Without the plugin system:

```
git clone https://github.com/dangerousplay/claude-usage-bar.git ~/claude-usage-bar
node ~/claude-usage-bar/scripts/setup.js
```

## Expand and collapse

Claude Code doesn't let a status line take clicks or keys, so the plugin draws a small toggle above the prompt (`▸ usage details` / `▾ hide usage details`):

- **Mouse**: click it.
- **Keyboard**: `ctrl+x tab` to focus the row above the prompt, then `e` (or `enter`). `esc` goes back to the prompt.
- **Command**: `/usage-bar:expand`. This one goes through the model; the toggle doesn't.

The status line redraws right away. To force that, the toggle adds or removes a trailing ` #` (a shell comment) on the `statusLine` command in `~/.claude/settings.json`, because Claude Code re-runs a status line at once only when its command changes.

## Commands

| Command | What it does |
|---|---|
| `/usage-bar:expand [on\|off\|hint-off]` | Expand/collapse the status line details (toggles with no argument) |
| `/usage-bar:usage` | Full report with emoji color bars and tables |
| `/usage-bar:setup [--plan p] [--compact\|--full] [--remove]` | Install, configure or remove the status line |
| `/usage-bar:calibrate <pct> [--reset-in "3d 4h"]` | Calibrate the weekly estimate against the real % |

## How the numbers are computed

- **Context used** = `input + cache_read + cache_creation` tokens of the latest main-thread request (or `context_window.current_usage` when Claude Code provides it).
- **Breakdown**: the context of the first request, minus the first prompt, is treated as the fixed prefix (system prompt, tool definitions, CLAUDE.md, skills, MCP). The remaining tokens are split across message types by their character counts, so this part is an estimate.
- **Weekly %**: Anthropic doesn't publish the limits as token counts. Every request in `~/.claude/projects/**/*.jsonl` is weighted by API list price (cache reads ×0.1, 5m writes ×1.25, 1h writes ×2), which gives an "API-equivalent $" figure.
  - Recent Claude Code versions pass `rate_limits` (weekly and 5-hour %) to the status line. When they do, the real weekly % is shown.
  - **Session %, measured**: the plugin records the weekly % the first time it sees a session. It then shows how much that % has risen since (`+3%`), and the same for the 5-hour window. The value only changes in whole-percent steps, so it shows `<1%` until the first step.
  - **Auto-calibration**: the limit is shared with claude.ai, the desktop app and other machines. So the plugin learns from how fast the weekly % rises as local cost grows (needs a 3-point rise), not from the total ratio.
  - If Claude Code doesn't pass `rate_limits`, run `/usage-bar:calibrate 37` with the weekly % from claude.ai/settings/usage.
  - Until it is calibrated, a rough default for your plan is used. The plan is detected from `~/.claude.json` (for example `default_claude_max_5x`). The estimate is shown with `~`.

Config and cache are stored in `~/.claude/usage-plugin/` (`config.json`: `plan`, `weeklyBudgetUsd`, `weekResetAt`, `barWidth`, `layout`, `prices`, `memoryServers`).
