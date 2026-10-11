---
description: Install the claude-usage status line into ~/.claude/settings.json (args - --plan pro|max5|max20, --compact, --full, --remove)
argument-hint: "[--plan pro|max5|max20] [--compact|--full] [--remove]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js" $ARGUMENTS`

Tell the user the result above in one or two lines. If it succeeded, mention the status line appears on the next refresh, and suggest `/claude-usage:calibrate <percent>` using the weekly % from claude.ai/settings/usage for an accurate weekly estimate.
