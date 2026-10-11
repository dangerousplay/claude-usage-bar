# usage-bar — Claude Code usage bar

A colorful status line and `/usage-bar:usage` report for Claude Code:

```
◆ Opus 5.5 │ ████████████░░░░░░░░░░░░░░░░░░░░ 37% 74.2k/200k
■ sys 40.4k  ■ you 436  ■ claude 186  ■ calls 25.3k  ■ results 7.8k  ░ free 126k
⟲ cache read 522k  ✎ cache write 40.1k │ in 20  out 26.9k │ reqs 10 │ $1.50
week ━━━━━━━───────── 42%  this session ~0.84%  resets 2d 23h │ 5h 18%
```

- **Context bar**: each category has its own color (system/tools/memory, your messages, Claude replies, tool calls, tool results, free space). The bar shows the % of the window used and the limit.
- **Cache**: total cache-read and cache-write tokens for the session, including subagents. The report splits writes into 5-minute and 1-hour TTL.
- **Weekly limit**: how much of the weekly limit this session has used, and the total for the week.

## Install

```
/plugin marketplace add ~/projects/claude-usage-plugin
/plugin install usage-bar@usage-bar-local
/usage-bar:setup --plan max5        # or pro / max20; writes statusLine to ~/.claude/settings.json
```

Without the plugin system: `node ~/projects/claude-usage-plugin/scripts/setup.js`.

## Commands

| Command | What it does |
|---|---|
| `/usage-bar:usage` | Full report with emoji color bars and tables |
| `/usage-bar:setup [--plan p] [--compact\|--full] [--remove]` | Install, configure or remove the status line |
| `/usage-bar:calibrate <pct> [--reset-in "3d 4h"]` | Calibrate the weekly estimate against the real % |

## How the numbers are computed

- **Context used** = `input + cache_read + cache_creation` tokens of the latest main-thread request (or `context_window.current_usage` when Claude Code provides it).
- **Breakdown**: the context of the first request, minus the first prompt, is treated as the fixed prefix (system prompt, tool definitions, CLAUDE.md, skills, MCP). The remaining tokens are split across message types by their character counts, so this part is an estimate.
- **Weekly %**: Anthropic doesn't publish the limits as token counts. Every request in `~/.claude/projects/**/*.jsonl` is weighted by API list price (cache reads ×0.1, 5m writes ×1.25, 1h writes ×2), which gives an "API-equivalent $" figure.
  - If Claude Code passes `rate_limits.seven_day` to the status line, that real % is shown and used to **auto-calibrate** the budget.
  - Otherwise run `/usage-bar:calibrate 37` with the weekly % from claude.ai/settings/usage. The budget becomes `week_cost / 0.37`.
  - Until it is calibrated, a rough default per plan is used, shown with `~` and "(uncalibrated)".
  - Session % = session cost ÷ weekly budget.

Config and cache are stored in `~/.claude/usage-plugin/` (`config.json`: `plan`, `weeklyBudgetUsd`, `weekResetAt`, `barWidth`, `layout`, `prices`).
