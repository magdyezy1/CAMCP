// QA-03: the browser qualification's checks that do not need a browser: run options (axe mandatory in qualification
// mode), the honest run summary, the rendered Arabic leak classifier and its ratchet, and focus-indicator contrast.
// The rendered runner (tools/browser-workflow-qa.mjs) applies the same functions to real pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {browserQaArguments, runFixtureLanes, summarizeBrowserEvidence} from '../tools/browser-qualification.mjs';
import {
  arabicLeakFindings,
  leakRatchet,
  ratchetLeakBaseline,
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
  const run = spawnSync(
    process.execPath,
    ['tools/browser-workflow-qa.mjs', '--output-dir', output, '--qualification'],
    {
      env,
      encoding: 'utf8',
      timeout: 60000,
    },
  );
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
    started_at: '2026-10-10T10:00:00.000Z',
    finished_at: '2026-10-10T10:59:30.000Z',
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
        focus_indicators: [
          {measured: true, passed: false},
          {measured: false, reason: 'no_indicator'},
        ],
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
        intermediate_states: [
          {state: 'review-open', wcag: wcag(['color-contrast'], ['region']), arabic_leaks: {count: 2}},
        ],
      },
    ],
  };
  const summary = summarizeBrowserEvidence(evidence, {critical_routes: ['/dashboard', '/reports', '/measurement']});
  assert.equal(summary.total, 4);
  // D26: the run's duration against the qualification runtime budget (75 minutes proposed, pending the owner).
  assert.deepEqual(
    [summary.duration_minutes, summary.runtime_budget_minutes, summary.within_runtime_budget],
    [59.5, 75, true],
  );
  // Review fix: the budget is configurable until the owner sets it; an invalid value is refused, never ignored.
  const tight = summarizeBrowserEvidence(evidence, {critical_routes: []}, {AMCP_QA_RUNTIME_BUDGET_MINUTES: '50'});
  assert.deepEqual([tight.runtime_budget_minutes, tight.within_runtime_budget], [50, false]);
  for (const value of ['0', '75.5', 'ninety', '601'])
    assert.throws(
      () => summarizeBrowserEvidence(evidence, {critical_routes: []}, {AMCP_QA_RUNTIME_BUDGET_MINUTES: value}),
      /AMCP_QA_RUNTIME_BUDGET_MINUTES/,
      value,
    );
  assert.equal(summarizeBrowserEvidence({cases: []}).within_runtime_budget, null, 'an unfinished run is not judged');
  assert.equal(summary.passed, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.distinct_scenarios, 3);
  assert.equal(summary.fixture_kinds, 2);
  assert.equal(summary.presentation_variants, 3, 'ar/1280/light appears twice');
  assert.deepEqual(summary.wcag_incomplete_by_rule, {'aria-valid-attr-value': 1, 'color-contrast': 3});
  assert.deepEqual(summary.wcag_violations_by_rule, {region: 1});
  assert.deepEqual(summary.intermediate_states, {'review-open': 1});
  assert.deepEqual(summary.arabic_leaks_by_intermediate_state, {
    'write-journey review-open': {cases: 1, max: 2, total: 2},
  });
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
  assert.equal(summary.unhandled_rejections, 0, 'a record without the field has none');
  assert.equal(summary.wcag_slowest_inspection, null, 'a record without inspection timings names none');
});

// Browser QA wave 3: one wave 2 case failed only because its axe inspection ran past the 10-second deadline. Each
// inspection now records how long it took, and the summary names the slowest one with its deadline.
test('the summary names the slowest WCAG inspection, intermediate states included, against its deadline', () => {
  const timed = (elapsed_ms, deadline_ms = 20000) => ({incomplete: [], violations: [], elapsed_ms, deadline_ms});
  const summary = summarizeBrowserEvidence(
    {
      cases: [
        {id: 'a', kind: 'empty', route: '/', wcag_initial: timed(900), wcag_final: timed(4200)},
        {
          id: 'b',
          kind: 'export-outcomes',
          route: '/reporting-overview',
          wcag_initial: timed(1100),
          intermediate_states: [{state: 'delivery-dialog-complete', wcag: timed(5100)}],
        },
      ],
    },
    {critical_routes: []},
  );
  assert.deepEqual(summary.wcag_slowest_inspection, {elapsed_ms: 5100, deadline_ms: 20000, case: 'b'});
});

// Browser QA wave 3: a browser promise that rejected after its case closed its context ended the whole run without a
// record. The runner keeps such rejections in the record, and the summary counts them so the run still fails.
test('the summary counts unhandled browser rejections kept in the record', () => {
  const summary = summarizeBrowserEvidence(
    {cases: [], unhandled_rejections: ['page.waitForEvent: Target page, context or browser has been closed']},
    {critical_routes: []},
  );
  assert.equal(summary.unhandled_rejections, 1);
  const source = fs.readFileSync('tools/browser-workflow-qa.mjs', 'utf8');
  assert.match(source, /process\.on\('unhandledRejection'/);
  assert.match(source, /if \(evidence\.failed \|\| evidence\.unhandled_rejections\.length\) process\.exitCode = 1;/);
});

// Browser QA wave 3 (runtime budget): the wave 2 qualification took 81 of its 75 minutes, and one of its two lanes sat
// idle for 33 of them, waiting behind the adjacent kinds of one tenant identity. A lane now parks a fixture whose tenant
// is busy and runs another kind; fixtures of one tenant still never overlap.
test('fixture lanes never overlap one tenant and run another kind instead of waiting behind it', async () => {
  const tenants = {a1: 'a', a2: 'a', a3: 'a', b1: 'b', c1: 'c'},
    log = [],
    active = new Map(),
    overlaps = [];
  let concurrent = 0,
    peak = 0;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await runFixtureLanes(['a1', 'a2', 'a3', 'b1', 'c1'], {
    lanes: 2,
    open: async kind => {
      await tick();
      return {tenantId: tenants[kind], kind};
    },
    run: async (kind, site) => {
      assert.equal(site.kind, kind);
      if (active.has(site.tenantId)) overlaps.push(kind + ' with ' + active.get(site.tenantId));
      active.set(site.tenantId, kind);
      peak = Math.max(peak, ++concurrent);
      log.push('start ' + kind);
      for (let i = 0; i < (kind.startsWith('a') ? 20 : 2); i++) await tick();
      log.push('end ' + kind);
      concurrent--;
      active.delete(site.tenantId);
    },
  });
  assert.deepEqual(overlaps, [], 'one tenant never runs twice at once');
  assert.equal(peak, 2);
  assert.deepEqual(log.filter(line => line.startsWith('start')).sort(), [
    'start a1',
    'start a2',
    'start a3',
    'start b1',
    'start c1',
  ]);
  // The second lane parked a2 (tenant a busy) and ran b1 and c1 while a1 was still running.
  assert.ok(log.indexOf('start b1') < log.indexOf('end a1'), log.join(', '));
  assert.ok(log.indexOf('start c1') < log.indexOf('end a1'), log.join(', '));
});

test('fixture lanes finish the other kinds after a failure, discard parked sites, then report the failure', async () => {
  const started = [],
    discarded = [];
  await assert.rejects(
    runFixtureLanes(['x1', 'x2', 'y1'], {
      lanes: 1,
      open: async kind => ({tenantId: kind.slice(0, 1), kind}),
      run: async kind => {
        started.push(kind);
        if (kind === 'x1') throw Error('fixture x1 failed');
      },
      discard: async site => discarded.push(site.kind),
    }),
    /fixture x1 failed/,
  );
  assert.deepEqual(started, ['x1'], 'one lane stops at its failure');
  assert.deepEqual(discarded, [], 'nothing was parked');
  const ran = [];
  await assert.rejects(
    runFixtureLanes(['x1', 'x2', 'y1', 'y2'], {
      lanes: 2,
      open: async kind => ({tenantId: kind.slice(0, 1), kind}),
      run: async kind => {
        ran.push(kind);
        await new Promise(resolve => setImmediate(resolve));
        if (kind === 'x1') throw Error('fixture x1 failed');
      },
    }),
    /fixture x1 failed/,
  );
  assert.deepEqual(ran.sort(), ['x2', 'y1', 'y2', 'x1'].sort(), 'the other lane still runs every remaining kind');
  await assert.rejects(runFixtureLanes(['x1'], {lanes: 0, open: async () => ({}), run: async () => {}}), /lanes/);
});

test('the leak probe flags the English Home capability block that WEB-05 translated, and not its Arabic', () => {
  // The Home "Capabilities and evidence" block once rendered AMCP's own capability vocabulary untranslated.
  const source = fs.readFileSync('web/workspace.js', 'utf8'),
    block = source.slice(
      source.indexOf('const capabilityFeatureLabels'),
      source.indexOf('async function workspaceCall'),
    );
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
  for (const route of ['/dashboard', '/connections', '/campaigns', '/reports', '/capabilities', '/measurement']) {
    assert.ok(baseline.critical_routes.includes(route), route);
    // QA-03 acceptance: the critical routes are ratcheted to zero non-allow-listed leaks.
    assert.equal(baseline.routes[route], 0, route);
  }
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
    const fixture = readLeakBaseline(
      write({schema_version: 1, critical_routes: ['/dashboard'], routes: {'/dashboard': 0, '/x': 3}}),
    );
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
    fs.writeFileSync(
      path.join(temporary, 'allow.json'),
      JSON.stringify({schema_version: 1, selectors: [''], terms: []}),
    );
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
  assert.deepEqual(focusIndicatorProblems([before]), [
    'Focus ring on sidebar link (a.nav-item) needs 3:1, measured 2.32',
  ]);
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
  assert.deepEqual(focusIndicatorProblems(findings), [
    'Focused primary button (button.primary) shows no focus indicator',
  ]);
  assert.deepEqual(cssColours('rgba(1, 2, 3, 0.5) rgb(4 5 6)'), [
    {r: 1, g: 2, b: 3, a: 0.5},
    {r: 4, g: 5, b: 6, a: 1},
  ]);
  assert.equal(Math.round(contrastRatio({r: 0, g: 0, b: 0}, {r: 255, g: 255, b: 255})), 21);
});

test('ratcheting a baseline lowers limits to the measured maximum, adds new routes and never raises one', () => {
  const baseline = {schema_version: 1, critical_routes: ['/dashboard'], routes: {'/dashboard': 2, '/settings': 3}};
  const lowered = ratchetLeakBaseline(baseline, {
    arabic_leaks_by_route: {
      '/dashboard': {cases: 4, max: 0, total: 0},
      '/settings': {cases: 4, max: 1, total: 3},
      'write-journey /campaigns': {cases: 2, max: 4, total: 6},
    },
  });
  assert.deepEqual(lowered, {
    baseline: {
      schema_version: 1,
      critical_routes: ['/dashboard'],
      routes: {'/dashboard': 0, '/settings': 1, 'write-journey /campaigns': 4},
    },
    rose: [],
  });
  const rose = ratchetLeakBaseline(baseline, {arabic_leaks_by_route: {'/settings': {cases: 1, max: 5, total: 5}}});
  assert.equal(rose.baseline.routes['/settings'], 3, 'a rise is never absorbed into the baseline');
  assert.deepEqual(rose.rose, [{route: '/settings', limit: 3, measured: 5}]);
});

test('report panels and evidence controls use the theme focus colour; the fixed purple measured 2.57:1 in dark mode', () => {
  const tokens = fs.readFileSync('web/tokens.css', 'utf8'),
    dark = tokens.slice(tokens.indexOf(":root[data-theme='dark']")),
    hex = (block, name) => block.match(new RegExp('--' + name + ':\\s*(#[0-9a-f]{6})', 'i'))[1],
    rgb = value => 'rgb(' + [1, 3, 5].map(i => Number.parseInt(value.slice(i, i + 2), 16)).join(', ') + ')',
    sample = ring => ({
      name: 'primary button',
      found: true,
      target: 'button.primary',
      focus_visible: true,
      outline_style: 'solid',
      outline_width: '3px',
      box_shadow: 'none',
      ring,
      backgrounds: [rgb(hex(dark, 'white'))],
    });
  // Regression (QA-03 focus contrast): the dark report panel behind #overview-new and #overview-saved.
  const [before] = focusIndicatorFindings([sample('rgb(115, 81, 161)')]);
  assert.equal(before.ratio, 2.57);
  assert.equal(before.passed, false);
  const [after] = focusIndicatorFindings([sample(rgb(hex(dark, 'iris-700')))]);
  assert.equal(after.passed, true);
  for (const file of ['web/reporting.css', 'web/workflows.css']) {
    const css = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(css, /outline:\s*\d+px solid #7[23]5[12]a[1a]/i, file + ' keeps no fixed focus purple');
  }
  // The focus role token (WEB-07 design system), which is --iris-700 in both themes.
  assert.match(
    fs.readFileSync('web/reporting.css', 'utf8'),
    /\.report-delivery-dialog :focus-visible \{\s*outline: 3px solid var\(--focus\)/,
  );
  assert.match(fs.readFileSync('web/tokens.css', 'utf8'), /--focus: var\(--iris-700\);/);
});

test('names and native values the leak probe met are marked literal where rendered, and step errors are translated', () => {
  const read = file => fs.readFileSync('web/' + file, 'utf8');
  for (const [file, marked] of [
    // CMP-05 renders campaign plan rows in campaignPlanRow.
    ['campaign-workflows.js', '<strong dir="auto" data-native>${esc(c.name)}</strong>'],
    ['report-library.js', '<strong dir="auto" data-native>${esc(overviewLabel(r.config))}</strong>'],
    ['reporting-overview.js', '<h2 dir="auto" data-native>${esc(r.config.name)}</h2>'],
    ['reporting-overview.js', '<caption>${uiBidi(overviewLabel(r.config))}'],
    ['report-delivery.js', '{name: uiBidi(r.config.name)'],
    ['identity.js', '<h2 dir="auto" data-native>${esc(account.name)}</h2>'],
    ['account-security.js', '<strong dir="auto" data-native>${esc(m.name)}</strong>'],
    ['owner-operations.js', '<strong dir="auto" data-native>${esc(c.name)}</strong>'],
    ['campaign-workflows.js', "{native: path => !path.startsWith('/warnings')}"],
    // WEB-07: the measurement trace markup moved with the Measurement page into its own module.
    ['measurement.js', '<code dir="ltr">$1</code>'],
  ])
    assert.ok(read(file).includes(marked), file + ': ' + marked);
  // Regression: a failed or uncertain step showed AMCP's English message raw in the Arabic interface.
  // WEB-03 (design review 2026-10): a step error the page words itself (an uncertain write) comes first, translated.
  assert.match(
    read('campaign-workflows.js'),
    /<p class="error">\$\{esc\(\(typeof websiteOwnMessage === 'function' && websiteOwnMessage\(s\.error\)\) \|\| uiOwnedError\(s\.error\)\.message\)\}<\/p>/,
  );
  for (const message of [
    'The provider configuration changed after preparation. Prepare and review a fresh request.',
    'The write response was lost. Do not retry with a new key; inspect platform state.',
  ]) {
    assert.equal(typeof catalog[message], 'string', message);
    assert.deepEqual(arabicLeakFindings([{text: catalog[message]}], allowlist), [], message);
    assert.equal(arabicLeakFindings([{text: message}], allowlist).length, 1, 'the English message is a leak');
  }
});
