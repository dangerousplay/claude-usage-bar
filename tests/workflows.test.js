'use strict';
// node --test tests/workflows.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bar-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
const L = require('../scripts/lib');

function assistant(id, model, usage, sidechain = true) {
  return JSON.stringify({ type: 'assistant', isSidechain: sidechain, timestamp: new Date().toISOString(),
    message: { id, model, role: 'assistant', usage, content: [{ type: 'text', text: 'ok' }] } });
}

const project = path.join(tmp, 'claude', 'projects', 'p');
const transcript = path.join(project, 'sess.jsonl');
const run = path.join(project, 'sess', 'subagents', 'workflows', 'wf_abc');
fs.mkdirSync(run, { recursive: true });
fs.mkdirSync(path.join(project, 'sess', 'workflows', 'scripts'), { recursive: true });
fs.writeFileSync(path.join(project, 'sess', 'workflows', 'scripts', 'tlc-execute-wf_abc.js'), '');
fs.writeFileSync(transcript, assistant('m0', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 5 }, false) + '\n');
fs.writeFileSync(path.join(run, 'journal.jsonl'), [
  { type: 'launched' },
  { type: 'started', agentId: 'a1', label: 'impl T1', phase: 'Implement' },
  { type: 'result', agentId: 'a1' },
  { type: 'started', agentId: 'a2', label: 'verify T1', phase: 'Verify' },
].map(o => JSON.stringify(o)).join('\n') + '\n');
fs.writeFileSync(path.join(run, 'agent-a1.jsonl'), assistant('m1', 'claude-sonnet-5-5', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 }) + '\n');
fs.writeFileSync(path.join(run, 'agent-a1.meta.json'), JSON.stringify({ workflowPhase: 'Implement', model: 'sonnet' }));
fs.writeFileSync(path.join(run, 'agent-a2.jsonl'), assistant('m2', 'claude-haiku-5-5', { input_tokens: 20, output_tokens: 10 }) + '\n');
fs.writeFileSync(path.join(run, 'agent-a2.meta.json'), JSON.stringify({ workflowPhase: 'Verify', model: 'haiku' }));
fs.writeFileSync(path.join(project, 'sess', 'subagents', 'agent-x.jsonl'), assistant('m3', 'claude-haiku-5-5', { input_tokens: 1, output_tokens: 1 }) + '\n');

test('workflow runs: agents, running, phases, models, tokens', () => {
  const [r] = L.workflowRuns(transcript);
  assert.strictEqual(r.name, 'tlc-execute');
  assert.strictEqual(r.agents, 2);
  assert.strictEqual(r.done, 1);
  assert.strictEqual(r.running, 1);
  assert.ok(r.active);
  assert.strictEqual(r.tokens, 100 + 50 + 1000 + 20 + 10);
  assert.deepStrictEqual(Object.keys(r.byPhase).sort(), ['Implement', 'Verify']);
  assert.strictEqual(r.byModel['Sonnet 5.5'].tokens, 1150);
  assert.strictEqual(r.byModel['Haiku 5.5'].agents, 1);
});

test('a run idle past the window is not active and reports stopped agents', () => {
  const [r] = L.workflowRuns(transcript, null, Date.now() + 10 * 60e3);
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.running, 0);
  assert.strictEqual(r.stalled, true);
});

test('session totals include workflow agents and plain subagents', () => {
  const s = L.analyzeSession({ input: {}, transcriptPath: transcript });
  assert.strictEqual(s.subagents, 3);
  assert.strictEqual(s.subTotals.output, 50 + 10 + 1);
  assert.strictEqual(s.totals.output, 5 + 50 + 10 + 1);
  assert.strictEqual(s.workflows.length, 1);
});

test('any workflow: name comes from the script meta, also for runs launched from a reused script path', () => {
  const run2 = path.join(project, 'sess', 'subagents', 'workflows', 'wf_def');
  fs.mkdirSync(run2, { recursive: true });
  const script = path.join(project, 'sess', 'workflows', 'scripts', 'whatever-wf_old.js');
  fs.writeFileSync(script, "export const meta = {\n  name: 'audit-deps',\n  description: 'x',\n}\n");
  fs.writeFileSync(path.join(run2, 'journal.jsonl'), JSON.stringify({ type: 'started', agentId: 'b1', phase: 'Scan' }) + '\n');
  fs.writeFileSync(path.join(run2, 'agent-b1.jsonl'), assistant('m4', 'claude-sonnet-5-5', { input_tokens: 7, output_tokens: 3 }) + '\n');
  const launch = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content:
    `Workflow launched in background.\nTranscript dir: ${run2}\nScript file: ${script}\n` }] } };
  fs.appendFileSync(transcript, JSON.stringify(launch) + '\n');
  const r = L.workflowRuns(transcript).find(x => x.id === 'wf_def');
  assert.strictEqual(r.name, 'audit-deps');
  assert.deepStrictEqual(Object.keys(r.byPhase), ['Scan']);
  assert.strictEqual(r.tokens, 10);
});
