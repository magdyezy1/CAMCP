import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readPinnedWcagEngine,
  summarizeWcagResult,
  inspectBrowserWcag,
  atDocumentStart,
  wcagEngineVersion,
  wcagEngineSha256,
} from '../tools/browser-wcag.mjs';
const result = () => ({
  testEngine: {name: 'axe-core', version: wcagEngineVersion},
  violations: [],
  incomplete: [],
  passes: [{id: 'label'}],
  inapplicable: [{id: 'video'}],
});
const rule = () => ({
  id: 'color-contrast',
  impact: 'serious',
  tags: ['wcag2aa'],
  help: 'Contrast',
  helpUrl: 'https://dequeuniversity.com/rules/axe/4.14/color-contrast',
  nodes: [
    {
      target: ['.caption'],
      html: '<span class="caption">Sample</span>',
      failureSummary: 'Contrast below threshold',
      any: [{id: 'color-contrast', data: {contrastRatio: 2.42}, message: 'Below 4.5'}],
      all: [],
      none: [],
    },
  ],
});
test('optional WCAG qualification remains unselected without a local asset and refuses private/relative targets before reading', () => {
  assert.equal(readPinnedWcagEngine(undefined), null);
  for (const file of [null, 42, '', 'relative/axe.min.js', 'C:/PRIVATE-CANARY/.env', 'C:/PRIVATE-CANARY/private.json'])
    assert.throws(() => readPinnedWcagEngine(file), /explicit absolute path/);
});
test('missing local engine asset returns fixed diagnostics without exposing its path', () => {
  const file = (process.platform === 'win32' ? 'C:/' : '/') + 'CAMCP-PRIVATE-MISSING-CANARY/axe.min.js';
  assert.throws(
    () => readPinnedWcagEngine(file),
    error =>
      error.message === 'WCAG test asset is unavailable or outside its received-byte bound.' &&
      !error.message.includes('PRIVATE'),
  );
});
test('automated violations remain failures and unresolved rules remain explicit manual evidence without input mutation', () => {
  const raw = result();
  raw.violations = [rule()];
  raw.incomplete = [{...rule(), id: 'label-content-name-mismatch'}];
  const before = JSON.stringify(raw),
    summary = summarizeWcagResult(raw);
  assert.equal(summary.automated_passed, false);
  assert.equal(summary.manual_review_required, true);
  assert.equal(summary.violations.length, 1);
  assert.equal(summary.incomplete.length, 1);
  assert.equal(summary.violations[0].nodes[0].checks[0].data.contrastRatio, 2.42);
  assert.equal(summary.passed_rules, 1);
  assert.equal(summary.inapplicable_rules, 1);
  assert.equal(JSON.stringify(raw), before);
  const manual = result();
  manual.incomplete = [rule()];
  const limited = summarizeWcagResult(manual);
  assert.equal(limited.automated_passed, true);
  assert.equal(limited.manual_review_required, true);
  assert.equal(limited.incomplete.length, 1);
});
test('wrong engine and missing result groups cannot become a passing WCAG result', () => {
  for (const raw of [
    null,
    {},
    {...result(), testEngine: {name: 'PRIVATE-ENGINE', version: wcagEngineVersion}},
    {...result(), testEngine: {name: 'axe-core', version: 'future'}},
    {...result(), incomplete: undefined},
  ])
    assert.throws(() => summarizeWcagResult(raw), /incomplete or unexpected engine evidence/);
});
test('malformed rule or node evidence cannot be silently dropped', () => {
  for (const row of [
    {id: '', nodes: []},
    {id: 'rule', nodes: null},
    {id: 'rule', nodes: [{target: null}]},
    {id: 'rule', nodes: [{target: [42]}]},
  ])
    assert.throws(() => summarizeWcagResult({...result(), violations: [row]}), /malformed (rule|node) evidence/);
});
test('forged engine ownership or an unbounded deadline is refused before any page operation', async () => {
  let calls = 0;
  const page = {
    evaluate: async () => {
      calls++;
      throw Error('Unexpected browser operation');
    },
  };
  for (const engine of [
    null,
    {version: 'future', sha256: wcagEngineSha256, source: 'FORGED'},
    {version: wcagEngineVersion, sha256: wcagEngineSha256, source: 'FORGED'},
  ])
    await assert.rejects(inspectBrowserWcag(page, engine), /qualified engine bytes/);
  for (const timeout of [0, 1.5, 30001])
    await assert.rejects(
      inspectBrowserWcag(page, {version: wcagEngineVersion, sha256: wcagEngineSha256, source: 'FORGED'}, timeout),
      /bounded local deadline/,
    );
  assert.equal(calls, 0);
});
// Browser QA wave 2: target-size reported a control half beneath the sticky phone top bar wherever the last automated
// scroll happened to leave it. The inspection runs at the document start and gives the reader's position back, also
// when the inspection fails.
test('a page-level inspection runs at the document start and restores the scroll position, also on failure', async () => {
  const window = {scrollX: 3, scrollY: 4891},
    log = [];
  const page = {
    evaluate: async (fn, arg) => {
      const saved = Object.fromEntries(['scrollX', 'scrollY', 'scrollTo'].map(key => [key, globalThis[key]]));
      Object.assign(globalThis, {
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        scrollTo: (x, y) => {
          window.scrollX = x;
          window.scrollY = y;
          log.push('scroll ' + x + ',' + y);
        },
      });
      try {
        return fn(arg);
      } finally {
        for (const [key, value] of Object.entries(saved))
          if (value === undefined) delete globalThis[key];
          else globalThis[key] = value;
      }
    },
  };
  const evidence = await atDocumentStart(page, async () => {
    log.push('inspect at ' + window.scrollX + ',' + window.scrollY);
    return {automated_passed: true};
  });
  assert.deepEqual(evidence, {automated_passed: true});
  assert.deepEqual(log, ['scroll 0,0', 'inspect at 0,0', 'scroll 3,4891']);
  log.length = 0;
  await assert.rejects(
    atDocumentStart(page, async () => {
      throw Error('WCAG inspection exceeded its local deadline.');
    }),
    /local deadline/,
  );
  assert.deepEqual(log, ['scroll 0,0', 'scroll 3,4891'], 'A failed inspection still restores the position');
});
