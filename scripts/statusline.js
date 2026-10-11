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

// Measured shares come from the real weekly % moving; "<1%" means it hasn't ticked yet.
function sessionLabel(w) {
  if (w.sessionPctSource === 'measured') return '+' + L.fmtPct(w.sessionPct);
  if (w.sessionSince && w.sessionPct < 1) return '<1%';
  return '~' + L.fmtPct(w.sessionPct);
}

const RED = [248, 113, 113], VIOLET = [192, 132, 252], GREEN = [134, 239, 172], TEAL = [45, 212, 191];

/** Always-visible line: context, session tokens, cost and the limits. */
function headLine(s, w, cfg, sep) {
  const t = s.totals;
  let line = bold(fg(PINK, '◆ ' + s.modelName)) + sep +
    contextBar(s, cfg.barWidth) + ' ' + bold(fg(heat(s.pct), L.fmtPct(s.pct))) + ' ' +
    dim(`${L.fmtTok(s.used)}/${L.fmtTok(s.size)}`) + sep +
    fg(CYAN, '⟲ ') + L.fmtTok(t.cacheRead) + ' ' + fg(VIOLET, '✎ ') + L.fmtTok(t.cacheWrite) + ' ' +
    fg(WHITE, '↑ ') + L.fmtTok(t.output) + ' ' + fg(GREEN, L.fmtUsd(s.reportedCost));
  if (w) {
    const parts = [];
    if (w.fiveHourPct != null) parts.push(dim('5h ') + bold(fg(heat(w.fiveHourPct), L.fmtPct(w.fiveHourPct))));
    parts.push(dim('week ') + bold(fg(heat(w.weekPct), (w.weekPctIsReal ? '' : '~') + L.fmtPct(w.weekPct))) +
      dim(' (session ') + sessionLabel(w) + dim(')'));
    line += sep + parts.join(dim(' · '));
  }
  return line;
}

/** Problems worth seeing even while collapsed. */
function alerts(s) {
  const out = [];
  if (s.pct >= 80) out.push(fg(RED, '⚠ context ' + L.fmtPct(s.pct) + ', compaction soon'));
  const last = s.mcp.history[s.mcp.history.length - 1];
  if (last && last.error && Date.now() - last.ts < 10 * 60e3) out.push(fg(RED, `⚠ mcp error ${last.server}/${last.tool}`));
  return out;
}

function detailLines(s, w, sep) {
  const t = s.totals;
  const lines = [];
  lines.push(L.CATEGORIES
    .filter(c => s.breakdown[c.key] > 0)
    .map(c => fg(c.rgb, '■ ') + fg(WHITE, c.short + ' ') + dim(L.fmtTok(s.breakdown[c.key] || 0)))
    .join('  ') + '  ' + fg(GRAY, '░ ') + dim('free ' + L.fmtTok(Math.max(0, s.size - s.used))));

  const totalIn = t.input + t.cacheRead + t.cacheWrite;
  lines.push(
    fg(CYAN, '⟲ cache read ') + bold(L.fmtTok(t.cacheRead)) + '  ' +
    fg(VIOLET, '✎ cache write ') + bold(L.fmtTok(t.cacheWrite)) + dim(` (5m ${L.fmtTok(t.cacheWrite5m)} · 1h ${L.fmtTok(t.cacheWrite1h)})`) +
    (totalIn ? dim('  hit ') + L.fmtPct((t.cacheRead / totalIn) * 100) : '') + sep +
    dim('in ') + L.fmtTok(t.input) + dim('  out ') + L.fmtTok(t.output) +
    (t.thinking ? dim(` (thinking ${L.fmtTok(t.thinking)})`) : '') + sep +
    dim('reqs ') + t.requests + (s.subagents ? dim(` · ${s.subagents} subagents`) : ''));

  const m = s.mcp;
  if (m.calls) {
    const top = m.servers.slice(0, 3).map(x => fg(WHITE, x.server) + dim(' ' + x.calls)).join(dim(' · '));
    const last = m.history[m.history.length - 1];
    lines.push(fg(TEAL, '⚙ mcp ') + bold(String(m.calls)) + dim(' calls') +
      (m.errors ? ' ' + fg(RED, m.errors + ' err') : '') + sep + top +
      (m.servers.length > 3 ? dim(` +${m.servers.length - 3}`) : '') + sep +
      dim('results ') + L.fmtTok(m.resultTokens) + sep +
      dim('last ') + fg(WHITE, `${last.server}/${last.tool}`) + dim(' ' + L.fmtAgo(last.ts)));
    if (m.memory.read || m.memory.write) {
      lines.push(fg([196, 181, 253], '🧠 memory ') +
        fg(CYAN, '↓ read ') + bold(String(m.memory.read)) + dim(` (${L.fmtTok(m.memory.readTokens)})`) + '  ' +
        fg([251, 146, 60], '↑ write ') + bold(String(m.memory.write)) + dim(` (${L.fmtTok(m.memory.writeTokens)})`) +
        sep + dim('last ') + m.memory.last.tool + dim(' ' + L.fmtAgo(m.memory.last.ts)));
    }
  }

  if (w) {
    const parts = [];
    if (w.fiveHourPct != null) {
      parts.push(dim('5h ') + meter(w.fiveHourPct, 10) + ' ' + bold(fg(heat(w.fiveHourPct), L.fmtPct(w.fiveHourPct))) +
        (w.fiveHourDelta ? dim(` +${w.fiveHourDelta} session`) : '') +
        (w.fiveHourResetsAt ? dim(' ↻ ' + L.fmtUntil(w.fiveHourResetsAt)) : ''));
    }
    parts.push(dim('week ') + meter(w.weekPct, 10) + ' ' + bold(fg(heat(w.weekPct), (w.weekPctIsReal ? '' : '~') + L.fmtPct(w.weekPct))) +
      dim(' session ') + sessionLabel(w) +
      dim(w.rolling ? ' ↻ rolling 7d' : ' ↻ ' + L.fmtUntil(w.resetsAt)) +
      (!w.calibrated && !w.weekPctIsReal ? dim(' (uncalibrated)') : ''));
    lines.push(parts.join(sep));
  }
  return lines;
}

function render(input) {
  const cfg = L.loadConfig();
  const transcript = (input.transcript_path && require('fs').existsSync(input.transcript_path) && input.transcript_path) || L.findTranscript(input.session_id);
  const s = L.analyzeSession({ input, transcriptPath: transcript, cfg });
  let w = null;
  try { w = L.weeklyEstimate({ input, session: s, cfg }); } catch {}

  if (input.session_id) L.writeJson(path.join(L.SESSIONS_DIR, input.session_id + '.json'), { at: Date.now(), input });

  const sep = fg(GRAY, ' │ ');
  const warn = alerts(s);
  let head = headLine(s, w, cfg, sep);
  if (warn.length) head += sep + warn.join('  ');
  if (!cfg.expanded) return head + (cfg.hint ? dim('  ▸ /usage-bar:expand') : '');
  const lines = [head, ...detailLines(s, w, sep)];
  if (cfg.hint) lines[lines.length - 1] += dim('  ▾ /usage-bar:expand off');
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
