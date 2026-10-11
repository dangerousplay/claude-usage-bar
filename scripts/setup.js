#!/usr/bin/env node
'use strict';
// Points ~/.claude/settings.json statusLine at this plugin's statusline.js (backs up first).
// Usage: node setup.js [--remove] [--plan pro|max5|max20] [--compact]
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const settingsPath = path.join(L.CLAUDE_DIR, 'settings.json');
const settings = L.readJson(settingsPath, {});
const has = f => process.argv.includes(f);
const planIdx = process.argv.indexOf('--plan');

if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, settingsPath + '.bak-claude-usage');

if (has('--remove')) {
  delete settings.statusLine;
  console.log('Removed statusLine from ' + settingsPath);
} else {
  const script = path.join(__dirname, 'statusline.js').replace(/\\/g, '/');
  if (settings.statusLine && !String(settings.statusLine.command || '').includes('statusline.js')) {
    console.log('Replacing existing statusLine: ' + JSON.stringify(settings.statusLine));
  }
  settings.statusLine = { type: 'command', command: `node "${script}"`, padding: 0 };
  console.log('statusLine -> ' + settings.statusLine.command);
}

const patch = {};
if (planIdx >= 0) {
  const plan = process.argv[planIdx + 1];
  if (!L.PLAN_BUDGETS[plan]) { console.error('Unknown plan: ' + plan); process.exit(1); }
  patch.plan = plan;
}
if (has('--compact')) patch.layout = 'compact';
if (has('--full')) patch.layout = 'full';
if (Object.keys(patch).length) { L.saveConfig(patch); console.log('Config updated: ' + JSON.stringify(patch)); }

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log('Saved ' + settingsPath + ' (backup: settings.json.bak-claude-usage)');
