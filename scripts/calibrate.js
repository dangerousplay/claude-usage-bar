#!/usr/bin/env node
'use strict';
// Calibrates the weekly budget from the real weekly % (claude.ai/settings/usage).
// Usage: node calibrate.js <percent> [--reset-in "<N>d <M>h"]
const L = require('./lib');

const pct = parseFloat(String(process.argv[2] || '').replace('%', ''));
if (!(pct > 0)) {
  console.log('Usage: /claude-usage:calibrate <weekly percent> [reset-in e.g. "3d 4h"]');
  process.exit(0);
}

const resetIdx = process.argv.indexOf('--reset-in');
if (resetIdx >= 0) {
  const s = process.argv.slice(resetIdx + 1).join(' ');
  const d = +(s.match(/(\d+)\s*d/) || [0, 0])[1], h = +(s.match(/(\d+)\s*h/) || [0, 0])[1], m = +(s.match(/(\d+)\s*m(?!s)/) || [0, 0])[1];
  const ms = ((d * 24 + h) * 60 + m) * 60e3;
  if (ms > 0) {
    L.saveConfig({ weekResetAt: new Date(Date.now() + ms).toISOString() });
    console.log('Weekly reset set to ' + new Date(Date.now() + ms).toLocaleString());
  }
}

try {
  const { weekCost, budget } = L.calibrate(pct);
  console.log(`Calibrated: ${L.fmtUsd(weekCost)} of API-equivalent usage this week = ${pct}%`);
  console.log(`=> weekly budget ≈ ${L.fmtUsd(budget)}. Session/week percentages now use this.`);
} catch (e) {
  console.log('Calibration failed: ' + e.message);
}
