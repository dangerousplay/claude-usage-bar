#!/usr/bin/env node
'use strict';
// Expands/collapses the status line details. Usage: node toggle.js [on|off|hint-off|hint-on]
const L = require('./lib');

const arg = String(process.argv[2] || '').toLowerCase();
const cfg = L.loadConfig();

if (arg === 'hint-off' || arg === 'hint-on') {
  L.saveConfig({ hint: arg === 'hint-on' });
  console.log(`Status line hint ${arg === 'hint-on' ? 'shown' : 'hidden'}.`);
} else {
  const expanded = arg === 'on' ? true : arg === 'off' ? false : !cfg.expanded;
  L.saveConfig({ expanded });
  console.log(expanded
    ? 'Status line expanded: breakdown, cache/IO details, MCP, memory and limit timers are shown.'
    : 'Status line collapsed to one line: context, session tokens, cost and limits.');
}
