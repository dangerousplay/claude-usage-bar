'use strict';
// Shared logic: transcript parsing, context breakdown, weekly-limit estimation.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const DATA_DIR = path.join(CLAUDE_DIR, 'usage-plugin');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const WEEK_CACHE_FILE = path.join(DATA_DIR, 'week-cache.json');
const WEEK_RESULT_FILE = path.join(DATA_DIR, 'week-result.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

const HOUR = 3600e3;
const WEEK = 7 * 24 * HOUR;

// USD per million tokens. Only used to weight different token types into one
// comparable "usage" number (subscription limits are weighted similarly).
const DEFAULT_PRICES = {
  opus: { in: 5, out: 25 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
};

// Rough API-equivalent USD per week for each plan. These are guesses — run
// /claude-usage:calibrate with the % from claude.ai/settings/usage to fix them.
const PLAN_BUDGETS = { pro: 120, max5: 600, max20: 1200 };

const DEFAULT_CONFIG = {
  plan: 'max5',
  weeklyBudgetUsd: null, // set by calibration
  calibratedAt: null,
  weekResetAt: null, // ISO time of a known weekly reset; otherwise rolling 7 days
  barWidth: 32,
  layout: 'full', // 'full' | 'compact'
  prices: DEFAULT_PRICES,
};

// ---------- io helpers ----------
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, v) { try { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(v, null, 2)); } catch {} }
function loadConfig() { return { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) }; }
function saveConfig(patch) { const c = { ...readJson(CONFIG_FILE, {}), ...patch }; writeJson(CONFIG_FILE, c); return { ...DEFAULT_CONFIG, ...c }; }
function readLines(file) { try { return fs.readFileSync(file, 'utf8').split('\n'); } catch { return []; } }

// ---------- pricing ----------
function priceFor(model, cfg) {
  const prices = (cfg && cfg.prices) || DEFAULT_PRICES;
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return prices.haiku;
  if (m.includes('sonnet')) return prices.sonnet;
  return prices.opus;
}

function splitCacheWrite(u) {
  const total = u.cache_creation_input_tokens || 0;
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const w5m = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, total - w1h);
  return { w5m, w1h, total };
}

function costOf(u, model, cfg) {
  const p = priceFor(model, cfg);
  const { w5m, w1h } = splitCacheWrite(u);
  return ((u.input_tokens || 0) * p.in
    + w5m * p.in * 1.25
    + w1h * p.in * 2
    + (u.cache_read_input_tokens || 0) * p.in * 0.1
    + (u.output_tokens || 0) * p.out) / 1e6;
}

function contextOf(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

function zeroTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0, requests: 0, cost: 0 };
}

function addUsage(t, u, model, cfg) {
  const { w5m, w1h, total } = splitCacheWrite(u);
  t.input += u.input_tokens || 0;
  t.output += u.output_tokens || 0;
  t.cacheRead += u.cache_read_input_tokens || 0;
  t.cacheWrite += total;
  t.cacheWrite5m += w5m;
  t.cacheWrite1h += w1h;
  t.thinking += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
  t.requests += 1;
  t.cost += costOf(u, model, cfg);
}

// ---------- transcript analysis ----------
function blockChars(b) {
  if (b == null) return 0;
  if (typeof b === 'string') return b.length;
  if (b.type === 'text') return (b.text || '').length;
  if (b.type === 'thinking') return (b.thinking || '').length;
  if (b.type === 'image') return 6000; // ~1.5k tokens
  if (b.type === 'tool_use') return JSON.stringify(b.input || {}).length + 40;
  if (b.type === 'tool_result') {
    const c = b.content;
    if (typeof c === 'string') return c.length;
    if (Array.isArray(c)) return c.reduce((s, x) => s + blockChars(x), 0);
    return 0;
  }
  return JSON.stringify(b).length;
}

/**
 * Parses one transcript. Streamed chunks of one API response share a message id
 * and repeat the usage, so we dedupe by id (last one wins).
 */
function analyzeTranscript(file, cfg) {
  const chars = { user: 0, assistant: 0, toolUse: 0, toolResult: 0 };
  let firstContext = null, preFirstChars = 0, lastUsage = null, model = null, compactions = 0;
  const responses = new Map();

  for (const line of readLines(file)) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }

    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      compactions++;
      for (const k in chars) chars[k] = 0;
      firstContext = null;
      continue;
    }
    const msg = o.message;
    if (!msg || (o.type !== 'user' && o.type !== 'assistant')) continue;

    if (o.type === 'assistant' && msg.usage && msg.model !== '<synthetic>') {
      responses.set(msg.id || o.requestId || o.uuid, { u: msg.usage, model: msg.model });
      if (!o.isSidechain) {
        lastUsage = msg.usage;
        model = msg.model;
        if (firstContext == null) {
          firstContext = contextOf(msg.usage);
          preFirstChars = chars.user + chars.assistant + chars.toolUse + chars.toolResult;
        }
      }
    }
    if (o.isSidechain) continue;

    const content = typeof msg.content === 'string' ? [msg.content] : (msg.content || []);
    for (const b of content) {
      const n = blockChars(b);
      if (b && b.type === 'tool_result') chars.toolResult += n;
      else if (b && b.type === 'tool_use') chars.toolUse += n;
      else if (o.type === 'assistant') chars.assistant += n;
      else chars.user += n;
    }
  }

  const totals = zeroTotals();
  for (const { u, model: m } of responses.values()) addUsage(totals, u, m, cfg);
  return { totals, chars, firstContext, preFirstChars, lastUsage, model, compactions };
}

function subagentFiles(transcriptPath) {
  const dir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents');
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)); } catch { return []; }
}

function findTranscript(sessionId) {
  if (!sessionId) return null;
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, d, sessionId + '.jsonl');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

function contextWindowSize(input, modelId) {
  const cw = input && input.context_window;
  if (cw && cw.context_window_size) return cw.context_window_size;
  const id = String(modelId || (input && input.model && input.model.id) || '').toLowerCase();
  return /\b1m\b|\[1m\]/.test(id) ? 1_000_000 : 200_000;
}

const CATEGORIES = [
  { key: 'system', label: 'System, tools & memory', short: 'sys', rgb: [167, 139, 250], emoji: '🟪' },
  { key: 'user', label: 'Your messages', short: 'you', rgb: [56, 189, 248], emoji: '🟦' },
  { key: 'assistant', label: 'Claude replies', short: 'claude', rgb: [52, 211, 153], emoji: '🟩' },
  { key: 'toolUse', label: 'Tool calls', short: 'calls', rgb: [250, 204, 21], emoji: '🟨' },
  { key: 'toolResult', label: 'Tool results', short: 'results', rgb: [251, 146, 60], emoji: '🟧' },
];

/**
 * Splits the live context into categories. The first request's context minus the
 * first prompt approximates the fixed prefix (system prompt, tool defs, CLAUDE.md,
 * skills); the rest is split proportionally to message character counts.
 */
function contextBreakdown(a, used) {
  const out = Object.fromEntries(CATEGORIES.map(c => [c.key, 0]));
  if (!used) return out;
  const baseline = Math.min(used, Math.max(0, (a.firstContext || 0) - Math.round(a.preFirstChars / 4)));
  out.system = baseline;
  const rest = used - baseline;
  const totalChars = a.chars.user + a.chars.assistant + a.chars.toolUse + a.chars.toolResult;
  if (totalChars === 0) { out.user = rest; return out; }
  let assigned = 0;
  for (const k of ['assistant', 'toolUse', 'toolResult']) {
    out[k] = Math.round(rest * a.chars[k] / totalChars);
    assigned += out[k];
  }
  out.user = rest - assigned;
  return out;
}

function analyzeSession({ input, transcriptPath, cfg }) {
  cfg = cfg || loadConfig();
  const main = transcriptPath ? analyzeTranscript(transcriptPath, cfg) : null;
  const totals = main ? { ...main.totals } : zeroTotals();
  const subs = transcriptPath ? subagentFiles(transcriptPath) : [];
  const subTotals = zeroTotals();
  for (const f of subs) {
    const t = analyzeTranscript(f, cfg).totals;
    for (const k in subTotals) subTotals[k] += t[k];
  }
  for (const k in totals) totals[k] += subTotals[k];

  const cu = input && input.context_window && input.context_window.current_usage;
  const used = cu ? contextOf(cu) : contextOf(main && main.lastUsage);
  const modelId = (input && input.model && input.model.id) || (main && main.model);
  const size = contextWindowSize(input, modelId);
  const breakdown = main ? contextBreakdown(main, used) : { system: used };
  const costUsd = input && input.cost && typeof input.cost.total_cost_usd === 'number' ? input.cost.total_cost_usd : totals.cost;

  return {
    modelId,
    modelName: (input && input.model && input.model.display_name) || prettyModel(modelId),
    used, size, pct: size ? (used / size) * 100 : 0,
    breakdown, totals, subTotals, subagents: subs.length,
    compactions: main ? main.compactions : 0,
    sessionCost: totals.cost, reportedCost: costUsd,
  };
}

function prettyModel(id) {
  const m = String(id || '').match(/(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : (id || 'Claude');
}

// ---------- weekly estimate ----------
function walkJsonl(dir, sinceMs, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, sinceMs, out);
    else if (e.name.endsWith('.jsonl')) {
      try { const st = fs.statSync(p); if (st.mtimeMs >= sinceMs) out.push({ p, mtime: st.mtimeMs, size: st.size }); } catch {}
    }
  }
  return out;
}

function fileEntries(file, cfg) {
  const byId = new Map();
  for (const line of readLines(file)) {
    if (!line || line.indexOf('"usage"') === -1) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const msg = o.message;
    if (o.type !== 'assistant' || !msg || !msg.usage || msg.model === '<synthetic>') continue;
    byId.set(msg.id || o.requestId || o.uuid, [Date.parse(o.timestamp) || 0, +costOf(msg.usage, msg.model, cfg).toFixed(6)]);
  }
  return [...byId.entries()].map(([id, [ts, c]]) => [id, ts, c]);
}

function parseResetAt(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}

function weekWindowStart(input, cfg) { return weekWindow(input, cfg).start; }
function weekWindow(input, cfg) {
  const rl = input && input.rate_limits && (input.rate_limits.seven_day || input.rate_limits.weekly);
  const now = Date.now();
  let reset = parseResetAt(rl && rl.resets_at) || parseResetAt(cfg.weekResetAt);
  if (reset) {
    while (reset - WEEK > now) reset -= WEEK;
    while (reset <= now) reset += WEEK;
    return { start: reset - WEEK, rolling: false };
  }
  return { start: now - WEEK, rolling: true };
}

/** Sums usage across every transcript in the current weekly window (cached incrementally). */
function weeklyCost(windowStart, cfg, { maxAgeMs = 60e3 } = {}) {
  const prev = readJson(WEEK_RESULT_FILE, null);
  if (prev && prev.windowStart === windowStart && Date.now() - prev.at < maxAgeMs) return prev.cost;

  const cache = readJson(WEEK_CACHE_FILE, { files: {} });
  const files = walkJsonl(PROJECTS_DIR, windowStart, []);
  const next = { files: {} };
  const seen = new Set();
  let cost = 0;
  for (const f of files) {
    let rec = cache.files[f.p];
    if (!rec || rec.mtime !== f.mtime || rec.size !== f.size) rec = { mtime: f.mtime, size: f.size, e: fileEntries(f.p, cfg) };
    next.files[f.p] = rec;
    for (const [id, ts, c] of rec.e) {
      if (ts < windowStart || seen.has(id)) continue;
      seen.add(id);
      cost += c;
    }
  }
  writeJson(WEEK_CACHE_FILE, next);
  writeJson(WEEK_RESULT_FILE, { windowStart, at: Date.now(), cost });
  return cost;
}

function weeklyEstimate({ input, session, cfg }) {
  cfg = cfg || loadConfig();
  const { start: windowStart, rolling } = weekWindow(input, cfg);
  const weekCost = weeklyCost(rolling ? Math.floor(windowStart / 60e3) * 60e3 : windowStart, cfg);
  const rl = (input && input.rate_limits) || {};
  const seven = rl.seven_day || rl.weekly;
  const five = rl.five_hour;
  const realWeekPct = seven && typeof seven.used_percentage === 'number' ? seven.used_percentage : null;

  // Auto-calibrate whenever Claude Code tells us the real weekly %.
  if (realWeekPct != null && realWeekPct >= 2 && weekCost > 0) {
    const budget = weekCost / (realWeekPct / 100);
    if (!cfg.weeklyBudgetUsd || Math.abs(budget - cfg.weeklyBudgetUsd) / cfg.weeklyBudgetUsd > 0.02) {
      cfg = saveConfig({ weeklyBudgetUsd: +budget.toFixed(2), calibratedAt: new Date().toISOString() });
    }
  }
  const budget = cfg.weeklyBudgetUsd || PLAN_BUDGETS[cfg.plan] || PLAN_BUDGETS.max5;
  const calibrated = !!cfg.weeklyBudgetUsd;
  const weekPct = realWeekPct != null ? realWeekPct : (weekCost / budget) * 100;
  const sessionPct = (session.sessionCost / budget) * 100;

  return {
    windowStart, rolling, resetsAt: windowStart + WEEK, weekCost, budget, calibrated,
    weekPct, weekPctIsReal: realWeekPct != null, sessionPct,
    fiveHourPct: five && typeof five.used_percentage === 'number' ? five.used_percentage : null,
    fiveHourResetsAt: five ? parseResetAt(five.resets_at) : null,
  };
}

function calibrate(pct, cfg) {
  cfg = cfg || loadConfig();
  const windowStart = weekWindowStart(null, cfg);
  const weekCost = weeklyCost(windowStart, cfg, { maxAgeMs: 0 });
  if (!(pct > 0)) throw new Error('Percentage must be > 0');
  if (!(weekCost > 0)) throw new Error('No usage found in the current weekly window yet');
  const budget = weekCost / (pct / 100);
  saveConfig({ weeklyBudgetUsd: +budget.toFixed(2), calibratedAt: new Date().toISOString() });
  return { weekCost, budget };
}

// ---------- formatting ----------
function fmtTok(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
  return String(Math.round(n));
}
function fmtPct(p) { return p >= 10 ? p.toFixed(0) + '%' : p >= 1 ? p.toFixed(1) + '%' : p.toFixed(2) + '%'; }
function fmtUsd(n) { return '$' + (n >= 100 ? n.toFixed(0) : n.toFixed(2)); }
function fmtUntil(ms) {
  const d = ms - Date.now();
  if (!(d > 0)) return 'now';
  const h = Math.floor(d / HOUR), m = Math.floor((d % HOUR) / 60e3);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** Allocates `width` cells to segments by largest remainder; tiny non-zero segments still get 1 cell. */
function allocateCells(values, total, width) {
  const raw = values.map(v => (total ? (v / total) * width : 0));
  const cells = raw.map(Math.floor);
  raw.forEach((r, i) => { if (values[i] > 0 && cells[i] === 0 && r > 0.15) cells[i] = 1; });
  let used = cells.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  const cap = Math.min(width, Math.round((values.reduce((a, b) => a + b, 0) / (total || 1)) * width));
  for (const [, i] of order) { if (used >= cap) break; if (values[i] > 0) { cells[i]++; used++; } }
  return cells;
}

module.exports = {
  CLAUDE_DIR, DATA_DIR, SESSIONS_DIR, CATEGORIES, PLAN_BUDGETS,
  loadConfig, saveConfig, readJson, writeJson, findTranscript,
  analyzeSession, weeklyEstimate, calibrate, allocateCells,
  fmtTok, fmtPct, fmtUsd, fmtUntil,
};
