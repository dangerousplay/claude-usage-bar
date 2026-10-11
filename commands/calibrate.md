---
description: Calibrate the weekly-limit estimate with your real weekly % (from claude.ai/settings/usage)
argument-hint: "<percent> [--reset-in \"3d 4h\"]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/calibrate.js" $ARGUMENTS`

Relay the result above to the user in one or two lines.
