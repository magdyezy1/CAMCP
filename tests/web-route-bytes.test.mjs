// WEB-07: what each page downloads before it renders (tools/web-route-bytes.mjs: Brotli bytes of its stylesheets, scripts,
// feature scripts and, in Arabic, catalog chunks), against the baseline recorded on the merged Work-here tree before
// WEB-07 (tools/web-route-bytes-baseline.json). Before WEB-07, Live portfolio, Measurement and Commerce loaded one 388 KB
// script with all three pages and the parked WooCommerce source, every Arabic page waited for the whole 1.9 MB catalog,
// and the landing and sign-in pages carried the report builder. check-web refuses a page above its baseline unless it
// is an open gap, which may not grow and leaves the list once it closes; the ratio tests keep the split's gains.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {loaderFiles, planLocaleChunks} from '../tools/locale-chunks.mjs';
import {
  readRouteBytesBaseline,
  routeBytes,
  routeBytesOpen,
  routeBytesProblems,
  routeLocaleChunks,
} from '../tools/web-route-bytes.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const current = routeBytes(),
  recorded = readRouteBytesBaseline(),
  baseline = recorded.routes,
  ratio = key => current[key].bytes / baseline[key];

test('the baseline covers every page in both languages and the tool measures each of them', () => {
  assert.deepEqual(Object.keys(current).sort(), Object.keys(baseline).sort());
  for (const [key, value] of Object.entries(current)) assert.ok(value.bytes > 0 && value.files > 0, key);
});

test('no page downloads more than before WEB-07; an open gap stays within its limit and names its reason', () => {
  assert.deepEqual(routeBytesProblems(current, recorded), []);
  // The open gaps are exactly the pages still above their baseline (regression: the gate ran nowhere and five pages
  // exceeded it unnoticed); each is a gap WEB-07 has not closed, not an accepted exception.
  const above = Object.keys(current).filter(key => current[key].bytes > baseline[key]);
  assert.deepEqual(Object.keys(recorded.open ?? {}).sort(), above.sort());
  for (const gap of routeBytesOpen(current, recorded)) {
    assert.ok(gap.bytes <= gap.limit && gap.bytes > gap.baseline, gap.key);
    assert.match(gap.reason, /not an accepted exception/);
  }
  assert.match(fs.readFileSync('tools/check-web.mjs', 'utf8'), /routeBytesProblems\(bytesNow, bytesBaseline\)/);
});

test('each account workflow page downloads well under what it did before (regression: one 388 KB bundle)', () => {
  for (const locale of ['en', 'ar'])
    for (const route of ['/portfolio', '/commerce', '/measurement'])
      assert.ok(ratio(locale + ' ' + route) < 0.9, locale + ' ' + route + ': ' + ratio(locale + ' ' + route));
  assert.ok(ratio('en /portfolio') < 0.7, 'Live portfolio loads only its own code');
});

test('every Arabic page downloads less than before, and the public pages a fraction (regression: one catalog)', () => {
  // R25 ar-lazy: every Arabic page keeps the default 0.95. The report builder's page had its own margin, raised three times
  // (0.97679, then 0.98220, then 0.995) as each package added provider messages, which were a third of the page's bytes. Those
  // sentences are no page's before it renders now (the next test), so a new one costs no page a byte.
  for (const key of Object.keys(current).filter(key => key.startsWith('ar ')))
    assert.ok(ratio(key) < 0.95, key + ': ' + ratio(key));
  for (const route of ['/', '/login', '/signup', '/forgot-password', '/about'])
    assert.ok(ratio('ar ' + route) < 0.5, 'ar ' + route + ': ' + ratio('ar ' + route));
});

test('no signed-in page waits for a chunk the plan names lazy: an error sentence costs a page no byte before it renders', () => {
  // The chunk of provider refusal sentences (web/locales/ar/providers.json, 160 KB of Brotli) was in every signed-in Arabic page's
  // set before rendering, and then what only an error shows (web/locales/ar/answers.json: remedies, next steps, the core's refusals)
  // was in `workspace`. The loader names both in `answerLocaleChunks`: an answer that carries one of their sentences loads them, and
  // the browser fetches them when idle after a page has rendered (tests/web-locale-chunks.test.mjs, tests/web-answer-chunks.test.mjs).
  const {lazy} = loaderFiles(),
    chunks = routeLocaleChunks(),
    signedIn = Object.entries(chunks).filter(([, names]) => names.length);
  assert.deepEqual(lazy, ['answers', 'providers']);
  assert.ok(signedIn.length >= 25, 'the signed-in routes are read: ' + signedIn.length);
  for (const [route, names] of signedIn)
    for (const name of lazy) assert.equal(names.includes(name), false, route + ' waits for ' + name);
  // Regression guard: a page that waited for the providers chunk again would be back at 0.99 of its pre-WEB-07 value, and one that
  // waited for answers too, at 0.74 more than now. The report builder is at 0.65 (389,963 of 601,471 at r25-ar-answers; it was
  // 0.73 at r25-ar-lazy), which holds the messages a page shows from an answer that refused nothing. If ordinary growth of
  // `workspace` nears 0.75 again, the remedy is to move what it holds that only an answer shows into a chunk no page waits for,
  // as `providers` and `answers` were, never a raise.
  assert.ok(ratio('ar /reporting-overview') < 0.75, 'ar /reporting-overview: ' + ratio('ar /reporting-overview'));
});

test('workspace holds no key owned only by error sources: answers carries them, and answers carries nothing else', () => {
  // The classifier (tools/locale-chunks.mjs `answerOnlyKeys`) names the keys that only an error's message, remedy or next step
  // writes: a declared error source (src/errors.ts, src/report-errors.ts, src/transport.ts, src/*-remedies.ts), or any other file
  // that does nothing but throw them, and no page script or success answer. The committed chunks must have split them.
  const plan = planLocaleChunks(),
    read = name => Object.keys(JSON.parse(fs.readFileSync('web/locales/ar/' + name + '.json', 'utf8'))),
    workspace = read('workspace'),
    answers = read('answers');
  assert.deepEqual(
    workspace.filter(key => plan.answerOnly.has(key)),
    [],
    'a key only an error shows is in workspace: node tools/locale-chunks.mjs --write',
  );
  assert.deepEqual(answers.toSorted(), Object.keys(plan.chunks.answers).toSorted());
  assert.deepEqual(
    answers.filter(key => !plan.answerOnly.has(key)),
    [],
    'answers carries only what an error alone shows',
  );
  // The split is real, and fails safe: a remedy and a message of the transport are in answers; a warning a report shows from a
  // success answer, and a word a page writes, are in workspace.
  assert.ok(answers.length > 500, 'answers: ' + answers.length);
  assert.ok(answers.includes('Use the request ID to inspect the audit trail.'), 'a remedy of src/errors.ts');
  assert.ok(answers.includes('An authenticated platform connection is required.'), 'a message of src/transport.ts');
  assert.ok(workspace.includes('Yes'), 'a word a page script writes');
  assert.ok(
    workspace.includes('Document not found in this tenant.') === false &&
      read('answers').includes('Document not found in this tenant.'),
    'a refusal of the core several modules throw',
  );
});
test('the landing and sign-in pages no longer download the report builder (regression: part of the shell)', () => {
  for (const route of ['/', '/login', '/signup', '/connections'])
    assert.ok(ratio('en ' + route) < 0.95, 'en ' + route + ': ' + ratio('en ' + route));
});

test('a page above its baseline is refused unless open; an open gap may not grow and must leave once closed', () => {
  const sample = {routes: {'en /a': 10, 'en /b': 10, 'en /c': 10, 'en /d': 10}},
    bytes = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {bytes: value, files: 1}]));
  assert.deepEqual(routeBytesProblems(bytes({'en /a': 11, 'en /b': 10, 'en /new': 99}), sample), [
    'en /a: 11 Brotli bytes before rendering, above the recorded 10 (WEB-07)',
  ]);
  const open = {...sample, open: {'en /a': {limit: 12, reason: 'gap'}, 'en /b': {limit: 12, reason: 'gap'}}};
  assert.deepEqual(
    routeBytesProblems(bytes({'en /a': 12, 'en /b': 10, 'en /c': 10, 'en /d': 10}), open),
    ['en /b: back at or below its baseline of 10; remove it from the open gaps (WEB-07)'],
    'An open gap within its limit passes; a closed one must leave the list',
  );
  assert.deepEqual(
    routeBytesProblems(bytes({'en /a': 13, 'en /c': 10}), {...open, open: {'en /a': open.open['en /a']}}),
    ['en /a: 13 Brotli bytes before rendering, above its open limit of 12 (WEB-07)'],
  );
  assert.deepEqual(routeBytesProblems(bytes({'en /a': 11}), {...sample, open: {'en /a': {limit: 12}}}), [
    'en /a: an open gap needs a limit and a reason',
  ]);
  assert.deepEqual(routeBytesProblems(bytes({}), {...sample, open: {'en /z': {limit: 1, reason: 'gap'}}}), [
    'en /z: an open gap for a page that is not measured',
  ]);
});

test('a stylesheet inside <noscript> is not counted: a browser that runs scripts never downloads it', () => {
  // About loads the public pages' tokens only without JavaScript (their dark system); with it, theme.js sets the theme.
  const about = fs.readFileSync('web/about.html', 'utf8'),
    visible = about.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
  assert.match(about, /<noscript><link rel="stylesheet" href="\/assets\/public-tokens\.css"><\/noscript>/);
  assert.doesNotMatch(visible, /public-tokens\.css/);
  const files = [
    ...visible.matchAll(/<link rel="stylesheet" href="\/assets\/([^"]+)">/g),
    ...visible.matchAll(/<script src="\/assets\/([^"]+)"/g),
  ];
  assert.equal(current['en /about'].files, files.length);
});

test('About takes its colours from tokens and loads no override layer (regression: English About above its baseline)', () => {
  // WEB-07 left English About 1,020 Brotli bytes above its baseline (16,868 against 15,848): it downloaded theme.css,
  // the workspace's dark override layer, although about.css already took its colours from tokens.
  const about = fs.readFileSync('web/about.html', 'utf8'),
    css = fs.readFileSync('web/about.css', 'utf8');
  assert.doesNotMatch(about, /theme\.css/);
  assert.ok(current['en /about'].bytes <= baseline['en /about'], 'en /about: ' + current['en /about'].bytes);
  assert.equal(recorded.open?.['en /about'], undefined, 'English About is no longer an open gap');
  // The Appearance control keeps the layout theme.css gave it, and no rule re-colours About for one theme only.
  assert.match(css, /\.theme-control \{[^}]*display: inline-flex;[^}]*color: var\(--muted\);/);
  assert.match(css, /\.theme-control select \{[^}]*border: 1px solid var\(--line-strong\);/);
  assert.match(css, /@media \(max-width: 600px\) \{\s*\.theme-control > span \{/);
  assert.doesNotMatch(css, /data-theme/);
});

test('recording a new baseline keeps an open gap and its target (regression: a recording could absorb the gap)', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-route-bytes-'));
  try {
    fs.mkdirSync(path.join(directory, 'tools'));
    fs.copyFileSync('tools/web-route-bytes-baseline.json', path.join(directory, 'tools/web-route-bytes-baseline.json'));
    const result = spawnSync(
      process.execPath,
      [path.resolve('tools/web-route-bytes.mjs'), '--root', process.cwd(), '--write', '--label', 'this tree'],
      {cwd: directory, encoding: 'utf8'},
    );
    assert.equal(result.status, 0, result.stderr);
    const written = JSON.parse(fs.readFileSync(path.join(directory, 'tools/web-route-bytes-baseline.json'), 'utf8'));
    assert.equal(written.recorded_from, 'this tree');
    assert.deepEqual(written.open, recorded.open);
    for (const key of Object.keys(recorded.open ?? {})) assert.equal(written.routes[key], baseline[key], key);
    for (const key of Object.keys(current).filter(key => !recorded.open?.[key]))
      assert.equal(written.routes[key], current[key].bytes, key);
  } finally {
    removeTestDirectory(directory, 'amcp-route-bytes-');
  }
});
