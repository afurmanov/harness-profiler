'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sessionSummary, branchSummary, renderBranchTree, renderBranchHtml, tree } = require('../plugin/libexec/hp.js');
const { tempRepo } = require('./helpers.js');

const assistant = (id, usage) => JSON.stringify({ type: 'assistant', message: { id, usage, content: [] } });
const usage = (fresh, cached, out) => ({ input_tokens: 1, cache_creation_input_tokens: fresh - 1, cache_read_input_tokens: cached, output_tokens: out });

// A session of two Reads on branch `feature`, `hour` hours past 10:00 UTC. With
// `spent`, its transcript holds one model call of that usage.
function session(id, hour, spent) {
  const at = (second) => `2026-11-20T${10 + hour}:00:${second}.000Z`;
  const records = ['t1', 't2'].map((t, i) => ({ session: id, branch: 'feature', tool: 'Read', name: 'a.txt', tool_use_id: `${id}-${t}`, at: at(10 + i * 20), duration_ms: 1000, ok: true }));
  if (spent) {
    const transcript = path.join(tempRepo(), `${id}.jsonl`);
    fs.writeFileSync(transcript, assistant(`${id}-m1`, usage(...spent)) + '\n');
    records.unshift({ session: id, event: 'SessionStart', at: at('09'), transcript });
  }
  return { id, records };
}

const twoSessions = () => [session('aaaa', 0, [20, 70, 10]), session('bbbb', 3, [180, 630, 90])];

test('a session summary has its start, duration, counts and totals', () => {
  assert.deepEqual(sessionSummary(twoSessions()[0]), {
    id: 'aaaa', start: Date.parse('2026-11-20T10:00:09.000Z'), duration: 21000, calls: 2, contexts: 1, totals: { new: 20, cached: 70, out: 10 },
  });
});

test('a branch summary adds its sessions up', () => {
  const summary = branchSummary(twoSessions().map(sessionSummary));
  assert.deepEqual(summary, {
    sessions: 2, first: Date.parse('2026-11-20T10:00:09.000Z'), last: Date.parse('2026-11-20T13:00:09.000Z'),
    totals: { new: 200, cached: 700, out: 100 }, cachedShare: 0.7,
  });
});

test('a session with no token data has no totals and leaves the branch totals alone', () => {
  const summaries = [session('aaaa', 0, [20, 70, 10]), session('cccc', 1)].map(sessionSummary);
  assert.equal(summaries[1].totals, undefined);
  assert.deepEqual(branchSummary(summaries).totals, { new: 20, cached: 70, out: 10 });
  const bare = branchSummary([summaries[1]]);
  assert.equal(bare.totals, undefined);
  assert.equal(bare.cachedShare, undefined);
});

test('the text of a branch ends with its total and cached share', () => {
  const lines = renderBranchTree(twoSessions(), 'feature', {}).split('\n');
  assert.equal(lines[0], '# session aaaa (2026-11-20 10:00:09 UTC, 21 s, 2 calls, 1 context)');
  assert.equal(lines.filter((l) => l.startsWith('# session ')).length, 2);
  assert.match(lines.at(-1), /^ +200 +700 +100 {2}branch total, feature: 2 sessions, 70% of tokens cached$/);
  assert.match(lines.at(-2), /^ +-+ -+ -+$/);
  const header = lines[1];
  assert.equal(lines.at(-1).indexOf('branch total'), header.indexOf('call'), 'the total sits in the token columns');
});

test('a branch with no token data still gets its line, without numbers', () => {
  assert.match(renderBranchTree([session('cccc', 1)], 'feature', {}).split('\n').at(-1), /^ +branch total, feature: 1 session$/);
});

function inlined(page) {
  return { data: JSON.parse(page.match(/const D = (.*);\n/)[1]), sessionPage: JSON.parse(page.match(/const SESSION_PAGE = (.*);\n/)[1]) };
}

test('the branch page holds every session, and the rows add up to the summary', () => {
  const page = renderBranchHtml(twoSessions(), 'feature');
  const { data, sessionPage } = inlined(page);
  assert.equal(data.branch, 'feature');
  assert.deepEqual(data.sessions.map((s) => s.id), ['aaaa', 'bbbb']);
  assert.deepEqual(data.sessions.map((s) => s.data.calls.length), [2, 2]);
  for (const k of ['new', 'cached', 'out']) {
    assert.equal(data.sessions.reduce((sum, s) => sum + s.totals[k], 0), data.summary.totals[k], k);
  }
  assert.equal(sessionPage, fs.readFileSync(path.join(__dirname, '..', 'plugin', 'libexec', 'view.html'), 'utf8'), 'the session template, once');
  assert.equal(page.split('</script>').length, 2, 'only the page closes its script');
  assert.doesNotMatch(page, /<(script|link|img)[^>]+(src|href)=["']?(https?:)?\/\//i, 'loads nothing from the network');
});

test('slot text inside a trace stays text', () => {
  const sessions = twoSessions();
  sessions[0].records.at(-1).args = 'const D = /*DATA*/null; const T = /*TEMPLATE*/null;';
  const { data } = inlined(renderBranchHtml(sessions, 'feature'));
  assert.equal(data.sessions[0].data.calls.at(-1).args, 'const D = /*DATA*/null; const T = /*TEMPLATE*/null;');
});

test('tree --branch --format html gives the branch page, also for one session', () => {
  const dir = tempRepo();
  fs.mkdirSync(path.join(dir, '.harness-profile'));
  const write = (s) => fs.writeFileSync(path.join(dir, '.harness-profile', `${s.id}.jsonl`), s.records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  twoSessions().reverse().forEach(write);
  write({ id: 'dddd', records: session('dddd', 5).records.map((r) => ({ ...r, branch: 'solo' })) });
  assert.deepEqual(inlined(tree(['--branch', 'feature', '--format', 'html'], dir)).data.sessions.map((s) => s.id), ['aaaa', 'bbbb'], 'oldest first');
  const solo = inlined(tree(['--branch', 'solo', '--format', 'html'], dir)).data;
  assert.equal(solo.summary.sessions, 1);
  assert.equal(solo.summary.totals, undefined);
});
