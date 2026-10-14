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

// Rough API-equivalent USD per week for each plan. These are guesses, replaced by auto
// calibration (when Claude Code reports rate_limits) or /usage-bar:calibrate.
const PLAN_BUDGETS = { pro: 120, max5: 600, max20: 1200 };

const DEFAULT_CONFIG = {
  plan: 'max5',
  weeklyBudgetUsd: null, // set by calibration
  calibratedAt: null,
  weekResetAt: null, // ISO time of a known weekly reset; otherwise rolling 7 days
  barWidth: 20,
  expanded: false, // toggled by /usage-bar:expand
  hint: true, // show the ▸ /usage-bar:expand hint
  memoryServers: null, // regex for MCP servers treated as memory stores (default matches openviking, mem0, memory...)
  prices: DEFAULT_PRICES,
};

// ---------- io helpers ----------
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, v) { try { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(v, null, 2)); } catch {} }
// Reads the subscription tier Claude Code caches in ~/.claude.json (e.g. default_claude_max_5x).
function detectPlan() {
  const j = readJson(path.join(path.dirname(CLAUDE_DIR), '.claude.json'), null) || readJson(path.join(os.homedir(), '.claude.json'), {});
  const a = j.oauthAccount || {};
  const tier = String(a.userRateLimitTier || a.organizationRateLimitTier || '').toLowerCase();
  if (tier.includes('20x')) return 'max20';
  if (tier.includes('5x')) return 'max5';
  if (tier.includes('pro')) return 'pro';
  return null;
}

function loadConfig() {
  const user = readJson(CONFIG_FILE, {});
  const cfg = { ...DEFAULT_CONFIG, ...user };
  if (!user.plan) cfg.plan = detectPlan() || DEFAULT_CONFIG.plan;
  // v1.1 saved a ratio-based budget without a method; it over-attributes shared usage, so drop it.
  if (cfg.weeklyBudgetUsd && !cfg.calibrationMethod) cfg.weeklyBudgetUsd = null;
  return cfg;
}
function saveConfig(patch) { const c = { ...readJson(CONFIG_FILE, {}), ...patch }; writeJson(CONFIG_FILE, c); return { ...DEFAULT_CONFIG, ...c }; }
// Claude Code re-runs the status line at once when its command changes (other updates wait
// for the next message), so flip a trailing shell comment on our command to redraw now.
function refreshStatusLine() {
  const p = path.join(CLAUDE_DIR, 'settings.json');
  const settings = readJson(p, null);
  const line = settings && settings.statusLine;
  if (!line || !String(line.command || '').includes('statusline-launcher')) return false;
  line.command = line.command.endsWith(' #') ? line.command.slice(0, -2) : line.command + ' #';
  try { fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n'); return true; } catch { return false; }
}
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

// ---------- MCP ----------
// Tool names look like mcp__<server>__<tool> (plugin servers: mcp__plugin_<plugin>_<server>__<tool>).
function parseMcpName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
  if (!m) return null;
  return { server: m[1].replace(/^plugin_[^_]+_/, ''), tool: m[2] };
}

const MEMORY_SERVER_RE = /viking|memory|mem0|memo|recall|knowledge|context-db/i;
const MEMORY_WRITE_RE = /add|write|save|store|commit|create|update|upsert|insert|remember|put|append|delete|remove|forget|import|ingest/i;
const MEMORY_READ_RE = /read|search|find|get|list|query|recall|retrieve|fetch|ls|tree|glob|grep|abstract|overview|browse|stat/i;

/** Returns 'read' | 'write' | null for memory-style MCP tools (e.g. OpenViking). */
function memoryOp(server, tool, cfg) {
  const re = cfg && cfg.memoryServers ? new RegExp(cfg.memoryServers, 'i') : MEMORY_SERVER_RE;
  if (!re.test(server) && !re.test(tool)) return null;
  if (MEMORY_WRITE_RE.test(tool)) return 'write';
  if (MEMORY_READ_RE.test(tool)) return 'read';
  return 'read';
}

function resultText(b) {
  const c = b.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => (x && x.type === 'text' ? x.text : '')).join(' ');
  return '';
}

/**
 * Parses one transcript. Streamed chunks of one API response share a message id
 * and repeat the usage, so we dedupe by id (last one wins).
 */
function analyzeTranscript(file, cfg) {
  const chars = { user: 0, assistant: 0, toolUse: 0, toolResult: 0, mcp: 0 };
  const mcpCalls = []; // { ts, server, tool, inputChars, resultChars, error, memory, preview }
  const pending = new Map(); // tool_use id -> call
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
          preFirstChars = chars.user + chars.assistant + chars.toolUse + chars.toolResult + chars.mcp;
        }
      }
    }
    const content = typeof msg.content === 'string' ? [msg.content] : (msg.content || []);
    const ts = Date.parse(o.timestamp) || 0;
    const mcpResults = new Set();
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        const p = parseMcpName(b.name);
        if (p && !pending.has(b.id)) {
          const call = { ts, ...p, inputChars: JSON.stringify(b.input || {}).length, resultChars: 0, error: false,
            memory: memoryOp(p.server, p.tool, cfg), sidechain: !!o.isSidechain, preview: '' };
          pending.set(b.id, call);
          mcpCalls.push(call);
        }
      } else if (b.type === 'tool_result' && pending.has(b.tool_use_id)) {
        const call = pending.get(b.tool_use_id);
        call.resultChars = blockChars(b);
        call.error = !!b.is_error;
        call.preview = resultText(b).replace(/\s+/g, ' ').slice(0, 80);
        mcpResults.add(b);
      }
    }
    if (o.isSidechain) continue;

    for (const b of content) {
      const n = blockChars(b);
      if (mcpResults.has(b)) chars.mcp += n;
      else if (b && b.type === 'tool_result') chars.toolResult += n;
      else if (b && b.type === 'tool_use') chars.toolUse += n;
      else if (o.type === 'assistant') chars.assistant += n;
      else chars.user += n;
    }
  }

  const totals = zeroTotals();
  for (const { u, model: m } of responses.values()) addUsage(totals, u, m, cfg);
  return { totals, chars, firstContext, preFirstChars, lastUsage, model, compactions, mcpCalls };
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

function contextWindowSize(input, modelId, used) {
  const cw = input && input.context_window;
  if (cw && cw.context_window_size) return cw.context_window_size;
  const id = String(modelId || (input && input.model && input.model.id) || '').toLowerCase();
  // Without a size from Claude Code, anything past 200k must be a 1M-context session.
  return /\b1m\b|\[1m\]/.test(id) || used > 200_000 ? 1_000_000 : 200_000;
}

const CATEGORIES = [
  { key: 'system', label: 'System, tools & memory', short: 'sys', rgb: [167, 139, 250], emoji: '🟪' },
  { key: 'user', label: 'Your messages', short: 'you', rgb: [56, 189, 248], emoji: '🟦' },
  { key: 'assistant', label: 'Claude replies', short: 'claude', rgb: [52, 211, 153], emoji: '🟩' },
  { key: 'toolUse', label: 'Tool calls', short: 'calls', rgb: [250, 204, 21], emoji: '🟨' },
  { key: 'toolResult', label: 'Tool results', short: 'results', rgb: [251, 146, 60], emoji: '🟧' },
  { key: 'mcp', label: 'MCP tool results', short: 'mcp', rgb: [45, 212, 191], emoji: '🟫' },
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
  const totalChars = a.chars.user + a.chars.assistant + a.chars.toolUse + a.chars.toolResult + a.chars.mcp;
  if (totalChars === 0) { out.user = rest; return out; }
  let assigned = 0;
  for (const k of ['assistant', 'toolUse', 'toolResult', 'mcp']) {
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
  const mcpCalls = main ? main.mcpCalls.slice() : [];
  for (const f of subs) {
    const a = analyzeTranscript(f, cfg);
    for (const k in subTotals) subTotals[k] += a.totals[k];
    for (const c of a.mcpCalls) mcpCalls.push({ ...c, sidechain: true });
  }
  mcpCalls.sort((x, y) => x.ts - y.ts);
  for (const k in totals) totals[k] += subTotals[k];

  const cu = input && input.context_window && input.context_window.current_usage;
  const used = cu ? contextOf(cu) : contextOf(main && main.lastUsage);
  const modelId = (input && input.model && input.model.id) || (main && main.model);
  const size = contextWindowSize(input, modelId, used);
  const breakdown = main ? contextBreakdown(main, used) : { system: used };
  const costUsd = input && input.cost && typeof input.cost.total_cost_usd === 'number' ? input.cost.total_cost_usd : totals.cost;

  return {
    modelId,
    modelName: (input && input.model && input.model.display_name) || prettyModel(modelId),
    used, size, pct: size ? (used / size) * 100 : 0,
    breakdown, totals, subTotals, subagents: subs.length,
    compactions: main ? main.compactions : 0,
    sessionCost: totals.cost, reportedCost: costUsd,
    mcp: summarizeMcp(mcpCalls),
  };
}

function summarizeMcp(calls) {
  const servers = new Map();
  const tools = new Map();
  const memory = { read: 0, write: 0, readTokens: 0, writeTokens: 0, last: null };
  let resultTokens = 0, errors = 0;
  for (const c of calls) {
    const tok = Math.round(c.resultChars / 4);
    resultTokens += tok;
    if (c.error) errors++;
    const s = servers.get(c.server) || { server: c.server, calls: 0, errors: 0, tokens: 0, last: 0 };
    s.calls++; s.errors += c.error ? 1 : 0; s.tokens += tok; s.last = Math.max(s.last, c.ts);
    servers.set(c.server, s);
    const key = c.server + '/' + c.tool;
    const t = tools.get(key) || { server: c.server, tool: c.tool, calls: 0, errors: 0, tokens: 0, memory: c.memory };
    t.calls++; t.errors += c.error ? 1 : 0; t.tokens += tok;
    tools.set(key, t);
    if (c.memory === 'read') { memory.read++; memory.readTokens += tok; memory.last = c; }
    if (c.memory === 'write') { memory.write++; memory.writeTokens += Math.round(c.inputChars / 4); memory.last = c; }
  }
  const byCalls = (a, b) => b.calls - a.calls;
  return {
    calls: calls.length, errors, resultTokens, memory,
    servers: [...servers.values()].sort(byCalls),
    tools: [...tools.values()].sort(byCalls),
    history: calls,
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

function fileMcp(file) {
  const out = [];
  for (const line of readLines(file)) {
    if (!line || line.indexOf('"mcp__') === -1) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const content = o.type === 'assistant' && o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const b of content) {
      const p = b && b.type === 'tool_use' && parseMcpName(b.name);
      if (p) out.push([b.id, Date.parse(o.timestamp) || 0, p.server, p.tool]);
    }
  }
  return out;
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

  let cache = readJson(WEEK_CACHE_FILE, { files: {} });
  if (cache.v !== 2) cache = { files: {} };
  const files = walkJsonl(PROJECTS_DIR, windowStart, []);
  const next = { v: 2, files: {} };
  const seen = new Set();
  const seenMcp = new Set();
  const mcpServers = {};
  let cost = 0;
  for (const f of files) {
    let rec = cache.files[f.p];
    if (!rec || rec.mtime !== f.mtime || rec.size !== f.size) rec = { mtime: f.mtime, size: f.size, e: fileEntries(f.p, cfg), m: fileMcp(f.p) };
    next.files[f.p] = rec;
    for (const [id, ts, c] of rec.e) {
      if (ts < windowStart || seen.has(id)) continue;
      seen.add(id);
      cost += c;
    }
    for (const [id, ts, server] of rec.m || []) {
      if (ts < windowStart || seenMcp.has(id)) continue;
      seenMcp.add(id);
      mcpServers[server] = (mcpServers[server] || 0) + 1;
    }
  }
  writeJson(WEEK_CACHE_FILE, next);
  writeJson(WEEK_RESULT_FILE, { windowStart, at: Date.now(), cost, mcpServers });
  return cost;
}

/**
 * Learns $/% from how the real weekly % moves as local usage grows. The weekly limit
 * is shared with claude.ai and other machines, so the plain ratio week$/week% would
 * blame all of that on local usage; the slope between two samples mostly doesn't.
 */
function autoCalibrate(windowStart, pct, weekCost, cfg) {
  const file = path.join(DATA_DIR, 'slope.json');
  let s = readJson(file, null);
  if (!s || s.windowStart !== windowStart || pct < s.pct) {
    s = { windowStart, pct, cost: weekCost, at: Date.now() };
    writeJson(file, s);
  }
  const dPct = pct - s.pct, dCost = weekCost - s.cost;
  if (dPct >= 3 && dCost > 0) {
    const budget = dCost / (dPct / 100);
    if (cfg.calibrationMethod === 'manual' && Date.now() - Date.parse(cfg.calibratedAt) < WEEK) return cfg;
    if (!cfg.weeklyBudgetUsd || Math.abs(budget - cfg.weeklyBudgetUsd) / cfg.weeklyBudgetUsd > 0.02) {
      return saveConfig({ weeklyBudgetUsd: +budget.toFixed(2), calibratedAt: new Date().toISOString(), calibrationMethod: 'slope' });
    }
  }
  return cfg;
}

function weeklyEstimate({ input, session, cfg }) {
  cfg = cfg || loadConfig();
  const { start: windowStart, rolling } = weekWindow(input, cfg);
  const weekCost = weeklyCost(rolling ? Math.floor(windowStart / 60e3) * 60e3 : windowStart, cfg);
  const weekMcp = (readJson(WEEK_RESULT_FILE, {}) || {}).mcpServers || {};
  const rl = (input && input.rate_limits) || {};
  const seven = rl.seven_day || rl.weekly;
  const five = rl.five_hour;
  const realWeekPct = seven && typeof seven.used_percentage === 'number' ? seven.used_percentage : null;

  if (realWeekPct != null) cfg = autoCalibrate(windowStart, realWeekPct, weekCost, cfg);
  const budget = cfg.weeklyBudgetUsd || PLAN_BUDGETS[cfg.plan] || PLAN_BUDGETS.max5;
  const calibrated = !!cfg.weeklyBudgetUsd;
  const weekPct = realWeekPct != null ? realWeekPct : (weekCost / budget) * 100;
  const estimatedSessionPct = (session.sessionCost / budget) * 100;

  // Measured session share: weekly % now minus weekly % when we first saw this session.
  let sessionPct = estimatedSessionPct, sessionPctSource = 'estimated', sessionSince = null, fiveHourDelta = null;
  const sid = input && input.session_id;
  if (sid && realWeekPct != null) {
    const bfile = path.join(SESSIONS_DIR, sid + '.baseline.json');
    let b = readJson(bfile, null);
    const weekReset = parseResetAt(seven.resets_at);
    if (!b || b.weekResetsAt !== weekReset) {
      b = { at: Date.now(), weekPct: realWeekPct, weekResetsAt: weekReset, cost: session.sessionCost,
        fivePct: five ? five.used_percentage : null, fiveResetsAt: five ? parseResetAt(five.resets_at) : null };
      writeJson(bfile, b);
    }
    // Usage that happened before the baseline existed can only be estimated.
    const preBaseline = (b.cost / budget) * 100;
    const delta = Math.max(0, realWeekPct - b.weekPct);
    sessionPct = delta >= 1 ? delta + preBaseline : Math.min(estimatedSessionPct, 0.99 + preBaseline);
    sessionPctSource = delta >= 1 ? 'measured' : 'estimated';
    sessionSince = b.at;
    if (five && b.fivePct != null && b.fiveResetsAt === parseResetAt(five.resets_at)) {
      fiveHourDelta = Math.max(0, five.used_percentage - b.fivePct);
    }
  }

  return {
    windowStart, rolling, resetsAt: windowStart + WEEK, weekMcp, weekCost, budget, calibrated,
    calibrationMethod: cfg.calibrationMethod || (calibrated ? 'manual' : null),
    weekPct, weekPctIsReal: realWeekPct != null, sessionPct, sessionPctSource, sessionSince, fiveHourDelta,
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
  saveConfig({ weeklyBudgetUsd: +budget.toFixed(2), calibratedAt: new Date().toISOString(), calibrationMethod: 'manual' });
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
function fmtAgo(ms) {
  const d = Date.now() - ms;
  if (d < 60e3) return 'just now';
  if (d < HOUR) return Math.floor(d / 60e3) + 'm ago';
  if (d < 24 * HOUR) return Math.floor(d / HOUR) + 'h ago';
  return Math.floor(d / (24 * HOUR)) + 'd ago';
}
function fmtUntil(ms) {
  const d = ms - Date.now();
  if (!(d > 0)) return 'now';
  const h = Math.floor(d / HOUR), m = Math.floor((d % HOUR) / 60e3);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** Allocates `width` cells to segments by largest remainder; tiny non-zero segments still get 1 cell. */
function allocateCells(values, total, width) {
  total = Math.max(total, values.reduce((a, b) => a + b, 0));
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
  loadConfig, saveConfig, refreshStatusLine, readJson, writeJson, findTranscript,
  analyzeSession, weeklyEstimate, calibrate, allocateCells,
  fmtTok, fmtPct, fmtUsd, fmtUntil, fmtAgo,
};
