#!/usr/bin/env node
'use strict';
// Full markdown report (emoji colors so it renders inside the chat).
// Usage: node report.js [--session <id>]
const fs = require('fs');
const path = require('path');
const L = require('./lib');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function latestCachedInput() {
  try {
    const files = fs.readdirSync(L.SESSIONS_DIR).map(f => path.join(L.SESSIONS_DIR, f));
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files.length ? L.readJson(files[0], {}).input : null;
  } catch { return null; }
}

function main() {
  let sid = arg('--session');
  if (sid && /^\$\{|^\$CLAUDE/.test(sid)) sid = undefined; // unexpanded placeholder
  const cached = sid ? (L.readJson(path.join(L.SESSIONS_DIR, sid + '.json'), {}).input || null) : latestCachedInput();
  const input = cached || {};
  sid = sid || input.session_id;
  const transcript = (input.transcript_path && fs.existsSync(input.transcript_path) && input.transcript_path) || L.findTranscript(sid);
  if (!transcript) {
    console.log('No transcript found for this session yet. Send a message first, or install the status line with /usage-bar:setup.');
    return;
  }

  const cfg = L.loadConfig();
  const s = L.analyzeSession({ input, transcriptPath: transcript, cfg });
  const w = L.weeklyEstimate({ input, session: s, cfg });
  const t = s.totals;
  const out = [];

  // Context bar
  const width = 40;
  const cells = L.allocateCells(L.CATEGORIES.map(c => s.breakdown[c.key] || 0), s.size, width);
  let bar = '';
  L.CATEGORIES.forEach((c, i) => { bar += c.emoji.repeat(cells[i]); });
  bar += '⬜'.repeat(Math.max(0, width - cells.reduce((a, b) => a + b, 0)));

  out.push(`## 🧠 Context window — ${s.modelName}`);
  out.push('');
  out.push(bar);
  out.push('');
  out.push(`**${L.fmtPct(s.pct)} used** · ${s.used.toLocaleString('en-US')} / ${s.size.toLocaleString('en-US')} tokens · ${(s.size - s.used).toLocaleString('en-US')} free` +
    (s.compactions ? ` · compacted ${s.compactions}×` : ''));
  out.push('');
  out.push('| | Category | Tokens | % of window |');
  out.push('|---|---|---:|---:|');
  for (const c of L.CATEGORIES) {
    const v = s.breakdown[c.key] || 0;
    out.push(`| ${c.emoji} | ${c.label} | ${v.toLocaleString('en-US')} | ${L.fmtPct((v / s.size) * 100)} |`);
  }
  out.push(`| ⬜ | Free | ${Math.max(0, s.size - s.used).toLocaleString('en-US')} | ${L.fmtPct(Math.max(0, 100 - s.pct))} |`);
  out.push('');

  out.push('## 💾 Tokens this session');
  out.push('');
  out.push('| Metric | Tokens |');
  out.push('|---|---:|');
  out.push(`| ⟲ Cache read | ${t.cacheRead.toLocaleString('en-US')} |`);
  out.push(`| ✎ Cache write (total) | ${t.cacheWrite.toLocaleString('en-US')} |`);
  out.push(`| &nbsp;&nbsp;↳ 5-minute TTL | ${t.cacheWrite5m.toLocaleString('en-US')} |`);
  out.push(`| &nbsp;&nbsp;↳ 1-hour TTL | ${t.cacheWrite1h.toLocaleString('en-US')} |`);
  out.push(`| Input (uncached) | ${t.input.toLocaleString('en-US')} |`);
  out.push(`| Output | ${t.output.toLocaleString('en-US')} |`);
  if (t.thinking) out.push(`| &nbsp;&nbsp;↳ of which thinking | ${t.thinking.toLocaleString('en-US')} |`);
  out.push(`| API requests | ${t.requests.toLocaleString('en-US')} |`);
  const totalIn = t.input + t.cacheRead + t.cacheWrite;
  if (totalIn) out.push(`| Cache hit rate | ${L.fmtPct((t.cacheRead / totalIn) * 100)} |`);
  out.push(`| API-equivalent cost | ${L.fmtUsd(s.reportedCost)} |`);
  if (s.subagents) out.push(`| Subagents (included above) | ${s.subagents} runs · ${L.fmtUsd(s.subTotals.cost)} |`);
  out.push('');

  out.push('## 📅 Weekly limit');
  out.push('');
  const filled = Math.round(Math.min(100, w.weekPct) / 5);
  const sessCells = Math.min(filled, Math.max(w.sessionPct > 0.5 ? 1 : 0, Math.round(w.sessionPct / 5)));
  out.push('🟥'.repeat(sessCells) + '🟫'.repeat(filled - sessCells) + '⬜'.repeat(Math.max(0, 20 - filled)));
  out.push('🟥 this session · 🟫 rest of the week');
  out.push('');
  out.push(`- **This week:** ${w.weekPctIsReal ? '' : '~'}${L.fmtPct(w.weekPct)} ${w.weekPctIsReal ? '(reported by Claude Code)' : '(estimated)'}`);
  out.push(`- **This session:** ~${L.fmtPct(w.sessionPct)} of the weekly limit`);
  if (w.fiveHourPct != null) out.push(`- **5-hour window:** ${L.fmtPct(w.fiveHourPct)}${w.fiveHourResetsAt ? ` (resets in ${L.fmtUntil(w.fiveHourResetsAt)})` : ''}`);
  out.push(`- **Resets in:** ${w.rolling ? 'unknown — using a rolling 7-day window (pass `--reset-in "3d 4h"` to calibrate)' : L.fmtUntil(w.resetsAt)}`);
  out.push(`- **Week usage (API-equivalent):** ${L.fmtUsd(w.weekCost)} of ~${L.fmtUsd(w.budget)} budget`);
  out.push(w.calibrated
    ? `- Calibrated ${cfg.calibratedAt ? new Date(cfg.calibratedAt).toLocaleString('en-US') : ''}`
    : `- ⚠️ Uncalibrated (using the \`${cfg.plan}\` default). Run \`/usage-bar:calibrate <percent>\` with the weekly % shown at claude.ai/settings/usage.`);

  console.log(out.join('\n'));
}

main();
