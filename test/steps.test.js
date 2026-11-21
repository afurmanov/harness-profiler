'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { renderTree, renderHtml } = require('../plugin/libexec/hp.js');
const { callColumn, tempRepo } = require('./helpers.js');

const assistant = (id, usage, calls = []) => JSON.stringify({ type: 'assistant', message: { id, usage, content: calls.map((c) => ({ type: 'tool_use', id: c })) } });
// `new` is input plus cache writes, so this usage has exactly `fresh` new tokens.
const usage = (fresh, cached, out) => ({ input_tokens: 1, cache_creation_input_tokens: fresh - 1, cache_read_input_tokens: cached, output_tokens: out });
const call = (tool, name, id, second, ms, more = {}) => ({ tool, name, tool_use_id: id, at: `2026-11-09T16:21:${second}.000Z`, duration_ms: ms, ok: true, result: 'ok', session_id: 's', ...more });

function write(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

// Main makes three model calls: the first calls a skill, the second a Read, the
// third replies. New per model call: 300, 277, 389.
function oneCallPerModelCall() {
  const transcript = path.join(tempRepo(), 's.jsonl');
  write(transcript, [assistant('m1', usage(300, 1000, 40), ['t1']), assistant('m2', usage(277, 1300, 194), ['t2']), assistant('m3', usage(389, 1600, 69))]);
  return [{ event: 'SessionStart', transcript }, call('Skill', 'planner', 't1', 10, 1000), call('Read', 'index.html', 't2', 20, 5)];
}

// Main's first model call makes two Reads at once, and its second reads both results.
function twoCallsTogether() {
  const transcript = path.join(tempRepo(), 's.jsonl');
  write(transcript, [assistant('m1', usage(300, 1000, 40), ['t1']), assistant('m1', usage(300, 1000, 40), ['t2']), assistant('m2', usage(900, 1300, 69))]);
  return [{ event: 'SessionStart', transcript }, call('Read', 'a.txt', 't1', 10, 5), call('Read', 'b.txt', 't2', 11, 5)];
}

// Main starts a subagent, which runs one Bash call and reports.
function withSubagent() {
  const transcript = path.join(tempRepo(), 's.jsonl');
  write(transcript, [assistant('m1', usage(500, 1000, 30), ['t1']), assistant('m2', usage(120, 1500, 20))]);
  write(path.join(transcript.replace(/\.jsonl$/, ''), 'subagents', 'agent-a1.jsonl'), [assistant('s1', usage(700, 900, 10), ['t2']), assistant('s2', usage(50, 1600, 60))]);
  return [
    { event: 'SessionStart', transcript },
    call('Bash', 'wc -l', 't2', 15, 20, { agent_id: 'a1' }),
    call('Agent', 'counter', 't1', 20, 9000, { child_agent_id: 'a1', child_agent_type: 'general-purpose' }),
  ];
}

const numbers = (text) => text.split('\n').slice(1).map((l) => l.slice(27).replace(/\s+/g, ' ').trim());

test('verbose: each row carries the model call that came right after it', () => {
  assert.deepEqual(numbers(renderTree(oneCallPerModelCall(), { verbose: true })), [
    '966 3.9k 303 main context',
    '+300 +1.0k +40 prompt',
    '+277 +1.3k +194 planner (skill) inline -> ok',
    '+389 +1.6k +69 index.html (Read)',
    '966 3.9k 303 session',
  ]);
});

test('verbose: calls made together share the model call after them', () => {
  assert.deepEqual(numbers(renderTree(twoCallsTogether(), { verbose: true })).slice(1, 4), [
    '+300 +1.0k +40 prompt',
    '↓ ↓ ↓ a.txt (Read)',
    '+900 +1.3k +69 b.txt (Read)',
  ]);
});

test('verbose: a context keeps its totals, and what it cost its caller is on the return row', () => {
  assert.deepEqual(numbers(renderTree(withSubagent(), { verbose: true })).map((l) => l.replace(/^[█▏▎▍▌▋▊▉]+ /, '')), [
    '620 2.5k 50 main context',
    '+500 +1.0k +30 prompt',
    '750 2.5k 70 counter (agent) new context a1 -> ok',
    '+700 +900 +10 prompt',
    '+50 +1.6k +60 wc -l (Bash)',
    '+120 +1.5k +20 <- counter returned',
    '1.4k 5.0k 120 session',
  ]);
});

test('the plain tree has the totals and no steps', () => {
  assert.deepEqual(callColumn(renderTree(withSubagent())), ['main context', 'counter (agent) new context a1 -> ok', 'session']);
});

test('html carries each step, the prompt and return rows, and the totals', () => {
  const page = renderHtml({ id: 's', records: withSubagent() });
  const data = JSON.parse(/const D = (.*);\n/.exec(page)[1]);
  assert.deepEqual(data.ledger.map((r) => [r.ctx, r.label, r.step.new]), [['main', 'prompt', 500], ['a1', 'prompt', 700], ['main', 'counter returned', 120]]);
  assert.deepEqual(data.calls.find((c) => c.name === 'wc -l').step.after, { new: 750, cached: 2500, out: 70 });
  assert.deepEqual(data.totals.session, { new: 1370, cached: 5000, out: 120 });
});
