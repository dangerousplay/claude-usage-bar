---
description: Show a colored breakdown of context usage, cache read/write tokens and the estimated weekly limit % for this session
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/report.js" --session "${CLAUDE_SESSION_ID}"`

Reproduce the report above for the user exactly as-is (keep the emoji bars and tables, add nothing before it). After it, add at most one short sentence of insight if something stands out (e.g. context above 75%, low cache hit rate, or the session using a large share of the weekly limit).
