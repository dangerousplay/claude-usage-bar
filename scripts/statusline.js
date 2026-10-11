#!/usr/bin/env node
'use strict';
// Claude Code status line: reads the session JSON on stdin, prints a colored usage bar.
const path = require('path');
const L = require('./lib');

const ESC = '\x1b[';
const reset = ESC + '0m';
const dim = s => ESC + '2m' + s + reset;
const bold = s => ESC + '1m' + s + reset;
const fg = ([r, g, b], s) => `${ESC}38;2;${r};${g};${b}m${s}${reset}`;
const GRAY = [75, 85, 99], WHITE = [229, 231, 235], CYAN = [103, 232, 249], PINK = [244, 114, 182];

function heat(p) {
  if (p < 50) return [74, 222, 128];
  if (p < 75) return [250, 204, 21];
  if (p < 90) return [251, 146, 60];
  return [248, 113, 113];
}

function contextBar(s, width) {
  const vals = L.CATEGORIES.map(c => s.breakdown[c.key] || 0);
  const cells = L.allocateCells(vals, s.size, width);
  let bar = '';
  L.CATEGORIES.forEach((c, i) => { bar += fg(c.rgb, '█'.repeat(cells[i])); });
  const used = cells.reduce((a, b) => a + b, 0);
  return bar + fg(GRAY, '░'.repeat(Math.max(0, width - used)));
}

function meter(pct, width) {
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return fg(heat(pct), '━'.repeat(n)) + fg(GRAY, '─'.repeat(width - n));
}

function render(input) {
  const cfg = L.loadConfig();
  const transcript = (input.transcript_path && require('fs').existsSync(input.transcript_path) && input.transcript_path) || L.findTranscript(input.session_id);
  const s = L.analyzeSession({ input, transcriptPath: transcript, cfg });
  let w = null;
  try { w = L.weeklyEstimate({ input, session: s, cfg }); } catch {}

  if (input.session_id) L.writeJson(path.join(L.SESSIONS_DIR, input.session_id + '.json'), { at: Date.now(), input });

  const sep = fg(GRAY, ' │ ');
  const t = s.totals;
  const lines = [];

  lines.push(
    bold(fg(PINK, '◆ ' + s.modelName)) + sep +
    contextBar(s, cfg.barWidth) + ' ' +
    bold(fg(heat(s.pct), L.fmtPct(s.pct))) + ' ' +
    dim(`${L.fmtTok(s.used)}/${L.fmtTok(s.size)}`)
  );

  if (cfg.layout !== 'compact') {
    lines.push(L.CATEGORIES
      .map(c => fg(c.rgb, '■ ') + fg(WHITE, c.short + ' ') + dim(L.fmtTok(s.breakdown[c.key] || 0)))
      .join('  ') + '  ' + fg(GRAY, '░ ') + dim('free ' + L.fmtTok(Math.max(0, s.size - s.used))));
  }

  lines.push(
    fg(CYAN, '⟲ cache read ') + bold(L.fmtTok(t.cacheRead)) + '  ' +
    fg([192, 132, 252], '✎ cache write ') + bold(L.fmtTok(t.cacheWrite)) + sep +
    dim('in ') + L.fmtTok(t.input) + dim('  out ') + L.fmtTok(t.output) + sep +
    dim('reqs ') + t.requests + sep + fg([134, 239, 172], L.fmtUsd(s.reportedCost))
  );

  if (w) {
    const tilde = w.weekPctIsReal ? '' : '~';
    let line = dim('week ') + meter(w.weekPct, 16) + ' ' + bold(fg(heat(w.weekPct), tilde + L.fmtPct(w.weekPct))) +
      dim('  this session ') + bold('~' + L.fmtPct(w.sessionPct)) +
      dim(w.rolling ? '  rolling 7d' : '  resets ' + L.fmtUntil(w.resetsAt));
    if (w.fiveHourPct != null) line += sep + dim('5h ') + bold(fg(heat(w.fiveHourPct), L.fmtPct(w.fiveHourPct)));
    if (!w.calibrated && !w.weekPctIsReal) line += dim('  (uncalibrated)');
    lines.push(line);
  }
  return lines.join('\n');
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch {}
  try { process.stdout.write(render(input)); }
  catch (e) { process.stdout.write('usage-bar: ' + e.message); }
});
