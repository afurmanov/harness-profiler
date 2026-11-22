#!/usr/bin/env node
'use strict';
// Renders e2e/<harness>/output/trace.jsonl into tree.txt, tree-verbose.txt
// and trace.html beside it, and the two sessions together into e2e/branch/output/
// as a branch: tree.txt and branch.html. With --png it also screenshots the pages
// so GitHub can show them: trace.png, then with every tool call shown, the call
// tree of the toy (steps.png) and the whole page of the others (trace-all-calls.png),
// and branch.png with the first session open. That needs Playwright, a dev-only dependency.
const fs = require('fs');
const path = require('path');
const { renderTree, renderHtml, renderBranchTree, renderBranchHtml } = require('../plugin/libexec/hp.js');

const HARNESSES = ['claude', 'toy'];
const BRANCH = 'main';

function readRecords(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function session(dir) {
  // collect.js stores transcript paths relative to the output directory.
  const records = readRecords(path.join(dir, 'trace.jsonl'))
    .map((r) => (r.transcript && !path.isAbsolute(r.transcript) ? { ...r, transcript: path.join(dir, r.transcript) } : r));
  return { id: records.find((r) => r.session).session, records };
}

function outputs(dir) {
  const { id, records } = session(dir);
  return {
    'tree.txt': renderTree(records) + '\n',
    'tree-verbose.txt': renderTree(records, { verbose: true }) + '\n',
    'trace.html': renderHtml({ id, records }),
  };
}

// Both recorded sessions ran on `main`, each in its own temporary repository.
// Together they stand for a branch with two sessions, oldest first.
function branchOutputs(root) {
  const sessions = HARNESSES.map((h) => session(path.join(root, h, 'output')))
    .sort((a, b) => Date.parse(a.records[0].at) - Date.parse(b.records[0].at));
  return {
    'tree.txt': renderBranchTree(sessions, BRANCH, {}) + '\n',
    'branch.html': renderBranchHtml(sessions, BRANCH),
  };
}

async function screenshotBranch(dir) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
    await page.goto(`file://${path.join(dir, 'branch.html')}`);
    await page.click('.session summary');
    await page.frameLocator('iframe').locator('#tree .row').first().waitFor();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(dir, 'branch.png'), fullPage: true });
  } finally {
    await browser.close();
  }
}

async function screenshot(dir, allCalls) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
    await page.goto(`file://${path.join(dir, 'trace.html')}`);
    // The diagram scrolls sideways when its lifelines don't fit; a screenshot can't, so widen the page.
    const overflow = await page.evaluate(() => { const p = document.querySelector('.panel'); return p.scrollWidth - p.clientWidth; });
    if (overflow > 0) await page.setViewportSize({ width: 1280 + overflow + 8, height: 800 });
    await page.screenshot({ path: path.join(dir, 'trace.png'), fullPage: true });
    await page.check('#all');
    // The pointer rests on the checkbox's row otherwise, and that row shows as hovered.
    await page.mouse.move(0, 0);
    if (allCalls) await page.screenshot({ path: path.join(dir, 'trace-all-calls.png'), fullPage: true });
    else await page.locator('#tree').screenshot({ path: path.join(dir, 'steps.png') });
  } finally {
    await browser.close();
  }
}

async function main(argv) {
  const png = argv.includes('--png');
  const harnesses = argv.filter((a) => !a.startsWith('--'));
  for (const harness of harnesses.length ? harnesses : HARNESSES) {
    const dir = path.join(__dirname, harness, 'output');
    for (const [name, text] of Object.entries(outputs(dir))) fs.writeFileSync(path.join(dir, name), text);
    if (png) await screenshot(dir, harness !== 'toy');
    console.log(`Rendered ${path.relative(process.cwd(), dir)}`);
  }
  if (harnesses.length) return;
  const dir = path.join(__dirname, 'branch', 'output');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(branchOutputs(__dirname))) fs.writeFileSync(path.join(dir, name), text);
  if (png) await screenshotBranch(dir);
  console.log(`Rendered ${path.relative(process.cwd(), dir)}`);
}

module.exports = { outputs, branchOutputs };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e); process.exitCode = 1; });
