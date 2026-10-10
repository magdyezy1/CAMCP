// QA-03: the browser qualification's checks that do not need a browser: run options (axe mandatory in qualification
// mode), the honest run summary, the rendered Arabic leak classifier and its ratchet, and focus-indicator contrast.
// The rendered runner (tools/browser-workflow-qa.mjs) applies the same functions to real pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {browserQaArguments, summarizeBrowserEvidence} from '../tools/browser-qualification.mjs';
import {
  arabicLeakFindings,
  leakRatchet,
  leakedWords,
  readLeakAllowlist,
  readLeakBaseline,
} from '../tools/browser-arabic-leaks.mjs';
import {
  contrastRatio,
  cssColours,
  focusIndicatorFindings,
  focusIndicatorProblems,
} from '../tools/browser-accessibility.mjs';

const kinds = ['empty', 'write-journey', 'spend-policy-edit', 'export-outcomes'];
const allowlist = readLeakAllowlist();
const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));

test('run options: an output directory, a development subset, or a qualification with the pinned axe engine', () => {
  assert.deepEqual(browserQaArguments(['--output-dir', '.runtime/x'], {}, kinds), {
    output: '.runtime/x',
    qualification: false,
    kinds: null,
  });
  assert.deepEqual(browserQaArguments(['--output-dir', '.runtime/x', '--kinds', 'empty,write-journey'], {}, kinds), {
    output: '.runtime/x',
    qualification: false,
    kinds: ['empty', 'write-journey'],
  });
  assert.equal(
    browserQaArguments(['--qualification', '--output-dir', '.runtime/x'], {AMCP_QA_AXE_PATH: 'C:/axe.min.js'}, kinds)
      .qualification,
    true,
  );
  for (const argv of [
    [],
    ['--output-dir'],
    ['--output-dir', '--qualification'],
    ['--output-dir', 'a', '--output-dir', 'b'],
    ['--output-dir', 'a', '--unknown'],
    ['--output-dir', 'a', 'extra'],
  ])
    assert.throws(() => browserQaArguments(argv, {}, kinds), /Use --output-dir/, JSON.stringify(argv));
  assert.throws(() => browserQaArguments(['--output-dir', 'a', '--kinds', 'empty,unknown'], {}, kinds), /unknown/);
});

test('a qualification run without the pinned axe engine is refused (QA-03: axe is mandatory in qualification)', () => {
  assert.throws(
    () => browserQaArguments(['--output-dir', '.runtime/x', '--qualification'], {}, kinds),
    /requires the pinned axe-core engine/,
  );
  assert.throws(
    () =>
      browserQaArguments(
        ['--output-dir', '.runtime/x', '--qualification', '--kinds', 'empty'],
        {AMCP_QA_AXE_PATH: 'C:/axe.min.js'},
        kinds,
      ),
    /runs every fixture kind/,
  );
});

test('the runner exits non-zero before any browser or output when --qualification has no axe engine', () => {
  const output = path.join('.runtime', 'qa03-refused-' + process.pid + '-' + Date.now()),
    env = {...process.env};
  delete env.AMCP_QA_AXE_PATH;
  delete env.AMCP_QA_PLAYWRIGHT_MODULE;
  delete env.AMCP_QA_BROWSER_PATH;
  const run = spawnSync(process.execPath, ['tools/browser-workflow-qa.mjs', '--output-dir', output, '--qualification'], {
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /requires the pinned axe-core engine/);
  assert.equal(fs.existsSync(output), false, 'nothing is created');
});

test('the summary reports distinct scenarios, variants, incomplete rules per rule and leaks per route', () => {
  const wcag = (incomplete, violations = []) => ({
    incomplete: incomplete.map(id => ({id})),
    violations: violations.map(id => ({id})),
  });
  const evidence = {
    cases: [
      {kind: 'empty', route: '/dashboard', locale: 'en', width: 320, appearance: 'light', passed: true},
      {
        kind: 'empty',
        route: '/dashboard',
        locale: 'ar',
        width: 320,
        appearance: 'dark',
        passed: true,
        leak_route: '/dashboard',
        arabic_leaks: {count: 0},
        wcag_initial: wcag(['color-contrast']),
        wcag_final: wcag(['color-contrast', 'aria-valid-attr-value']),
        focus_indicators: [
          {measured: true, passed: true},
          {measured: false, reason: 'not_present'},
        ],
      },
      {
        kind: 'empty',
        route: '/reports',
        locale: 'ar',
        width: 1280,
        passed: false,
        leak_route: '/reports',
        arabic_leaks: {count: 2},
        focus_indicators: [{measured: true, passed: false}, {measured: false, reason: 'no_indicator'}],
      },
      {
        kind: 'write-journey',
        route: '/campaigns',
        locale: 'ar',
        width: 1280,
        appearance: 'light',
        passed: true,
        leak_route: 'write-journey /campaigns',
        arabic_leaks: {count: 1},
        synthetic_writes: 2,
        provider_writes: 0,
        write_journeys: [{outcome: 'accepted'}, {outcome: 'uncertain'}, {outcome: 'refused'}],
        intermediate_states: [{state: 'review-open', wcag: wcag(['color-contrast'], ['region'])}],
      },
    ],
  };
  const summary = summarizeBrowserEvidence(evidence, {critical_routes: ['/dashboard', '/reports', '/measurement']});
  assert.equal(summary.total, 4);
  assert.equal(summary.passed, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.distinct_scenarios, 3);
  assert.equal(summary.fixture_kinds, 2);
  assert.equal(summary.presentation_variants, 3, "ar/1280/light appears twice");
  assert.deepEqual(summary.wcag_incomplete_by_rule, {'aria-valid-attr-value': 1, 'color-contrast': 3});
  assert.deepEqual(summary.wcag_violations_by_rule, {region: 1});
  assert.deepEqual(summary.intermediate_states, {'review-open': 1});
  assert.deepEqual(summary.arabic_leaks_by_route, {
    '/dashboard': {cases: 1, max: 0, total: 0},
    '/reports': {cases: 1, max: 2, total: 2},
    'write-journey /campaigns': {cases: 1, max: 1, total: 1},
  });
  assert.deepEqual(summary.arabic_critical_routes, {
    at_zero: ['/dashboard'],
    with_leaks: ['/reports'],
    not_probed: ['/measurement'],
  });
  assert.deepEqual(summary.write_journey_outcomes, {accepted: 1, refused: 1, uncertain: 1});
  assert.equal(summary.synthetic_writes, 2);
  assert.equal(summary.provider_writes, 0);
  assert.deepEqual(summary.focus_indicators, {
    measured: 2,
    below_threshold: 1,
    without_indicator: 1,
    not_focus_visible: 0,
  });
});

test('the leak probe flags the English Home capability block that WEB-05 translated, and not its Arabic', () => {
  // The Home "Capabilities and evidence" block once rendered AMCP's own capability vocabulary untranslated.
  const source = fs.readFileSync('web/workspace.js', 'utf8'),
    block = source.slice(source.indexOf('const capabilityFeatureLabels'), source.indexOf('async function workspaceCall'));
  const english = [...block.matchAll(/'([^']{12,})'/g)].map(match => match[1]);
  assert.ok(english.length >= 10);
  const leaks = arabicLeakFindings(
    english.map((text, index) => ({text, path: 'main > div.token-row:nth-child(' + index + ')'})),
    allowlist,
  );
  assert.ok(leaks.length >= english.length - 2, 'nearly every untranslated line is a leak');
  const arabic = english.map(text => ({text: catalog[text]}));
  assert.ok(arabic.every(node => typeof node.text === 'string' && node.text.length));
  assert.deepEqual(arabicLeakFindings(arabic, allowlist), []);
});

test('brand names, native identifiers, constants and single words are not leaks; English sentences are', () => {
  for (const text of [
    'Google Ads · Meta · TikTok',
    'meta_native_action meta_ad_account_id_campaigns_create',
    '/v26.0/act_123/campaigns',
    'عند عدم تحديده، يرفض AMCP الحذف (DELETE في TikTok وDELETED في Meta)',
    'ظهر X-Real-IP خلال الساعة الأخيرة. ظهر CF-Connecting-IP',
    'Superseded',
    'تصدير إلى Google Sheets عبر API · CSV · PDF',
    'Ctrl K',
  ])
    assert.deepEqual(arabicLeakFindings([{text}], allowlist), [], text);
  assert.deepEqual(leakedWords('The write response was lost.', allowlist), ['The', 'write', 'response', 'was', 'lost']);
  assert.equal(
    arabicLeakFindings([{text: 'دخول المراجع: Set AMCP_TEST_PASSWORD to give reviewers a sign-in button.'}], allowlist)
      .length,
    1,
    'an English sentence inside an Arabic line is still a leak',
  );
});

test('the committed allow-list and baseline are valid; the ratchet only lets counts go down', () => {
  assert.ok(allowlist.selectors.includes('[data-native]'));
  assert.ok(allowlist.selectors.includes('bdi'));
  assert.match(allowlist.sha256, /^[0-9a-f]{64}$/);
  const baseline = readLeakBaseline();
  for (const route of ['/dashboard', '/connections', '/campaigns', '/reports', '/capabilities', '/measurement'])
    assert.ok(baseline.critical_routes.includes(route), route);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-leaks-'));
  try {
    const write = value => {
      const file = path.join(temporary, 'baseline.json');
      fs.writeFileSync(file, JSON.stringify(value));
      return file;
    };
    for (const invalid of [
      {schema_version: 2, critical_routes: [], routes: {}},
      {schema_version: 1, critical_routes: ['/dashboard'], routes: {}},
      {schema_version: 1, critical_routes: [], routes: {'/x': -1}},
      {schema_version: 1, critical_routes: [], routes: {'/x': 1.5}},
    ])
      assert.throws(() => readLeakBaseline(write(invalid)), /ARABIC_LEAK_BASELINE_INVALID/);
    const fixture = readLeakBaseline(write({schema_version: 1, critical_routes: ['/dashboard'], routes: {'/dashboard': 0, '/x': 3}}));
    assert.equal(leakRatchet('/dashboard', 0, fixture).exceeded, false);
    assert.equal(leakRatchet('/dashboard', 1, fixture).exceeded, true);
    assert.equal(leakRatchet('/x', 3, fixture).exceeded, false);
    assert.equal(leakRatchet('/x', 4, fixture).exceeded, true);
    assert.deepEqual(leakRatchet('/unlisted', 9, fixture), {
      route: '/unlisted',
      count: 9,
      limit: null,
      critical: false,
      exceeded: false,
    });
    fs.writeFileSync(path.join(temporary, 'allow.json'), JSON.stringify({schema_version: 1, selectors: [''], terms: []}));
    assert.throws(() => readLeakAllowlist(path.join(temporary, 'allow.json')), /ARABIC_LEAK_ALLOWLIST_INVALID/);
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});

test('focus contrast flags the 2.32:1 iris ring on the dark sidebar that WEB-01 fixed, and passes its on-dark ring', () => {
  const sidebar = 'rgb(32, 29, 48)',
    sample = ring => ({
      name: 'sidebar link',
      found: true,
      target: 'a.nav-item',
      focus_visible: true,
      outline_style: 'solid',
      outline_width: '2px',
      box_shadow: 'none',
      ring,
      backgrounds: [sidebar],
    });
  const [before] = focusIndicatorFindings([sample('rgb(90, 67, 189)')]);
  assert.equal(before.measured, true);
  assert.equal(before.ratio, 2.32);
  assert.equal(before.passed, false);
  assert.deepEqual(focusIndicatorProblems([before]), ['Focus ring on sidebar link (a.nav-item) needs 3:1, measured 2.32']);
  const [after] = focusIndicatorFindings([sample('rgb(199, 173, 255)')]);
  assert.equal(after.passed, true);
  assert.ok(after.ratio >= 3);
  assert.deepEqual(focusIndicatorProblems([after]), []);
});

test('focus findings: the worst gradient stop counts; missing, hidden and shadow indicators are reported as such', () => {
  const base = {
    name: 'primary button',
    found: true,
    target: 'button.primary',
    focus_visible: true,
    outline_style: 'solid',
    outline_width: '2px',
    box_shadow: 'none',
    ring: 'rgb(90, 67, 189)',
  };
  const [gradient] = focusIndicatorFindings([
    {...base, backgrounds: ['linear-gradient(rgb(255, 255, 255), rgb(32, 29, 48))']},
  ]);
  assert.equal(gradient.ratio, 2.32, 'the darkest stop decides');
  const findings = focusIndicatorFindings([
    {name: 'form field', found: false},
    {...base, focus_visible: false},
    {...base, outline_style: 'none', box_shadow: 'rgb(90, 67, 189) 0px 0px 0px 3px'},
    {...base, outline_style: 'none', box_shadow: 'none'},
    {...base, ring: 'rgba(90, 67, 189, 0.5)', backgrounds: ['rgb(255, 255, 255)']},
  ]);
  assert.deepEqual(
    findings.map(f => f.reason),
    ['not_present', 'not_focus_visible', 'shadow_indicator', 'no_indicator', 'translucent_ring'],
  );
  assert.deepEqual(focusIndicatorProblems(findings), ['Focused primary button (button.primary) shows no focus indicator']);
  assert.deepEqual(cssColours('rgba(1, 2, 3, 0.5) rgb(4 5 6)'), [
    {r: 1, g: 2, b: 3, a: 0.5},
    {r: 4, g: 5, b: 6, a: 1},
  ]);
  assert.equal(Math.round(contrastRatio({r: 0, g: 0, b: 0}, {r: 255, g: 255, b: 255})), 21);
});
