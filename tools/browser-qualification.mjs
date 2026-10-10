// Run options and the honest summary of a rendered browser qualification (QA-03). Pure functions: the runner uses
// them and tests/browser-qualification.test.mjs checks them without a browser.

const usage =
  'Use --output-dir .runtime/<fresh-directory> [--qualification] [--kinds <kind,...>]; configure ' +
  'AMCP_QA_PLAYWRIGHT_MODULE and AMCP_QA_BROWSER_PATH (and AMCP_QA_AXE_PATH for --qualification).';

/**
 * Parses the runner's arguments. `--qualification` is the release mode: it requires the pinned axe-core engine (an
 * automated WCAG result is part of the record, never optional) and runs every fixture kind. `--kinds` selects a
 * development subset and is refused in qualification mode, so a partial run is never recorded as a qualification.
 */
export function browserQaArguments(argv, env = {}, knownKinds = []) {
  const options = {output: undefined, qualification: false, kinds: null};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index],
      value = argv[index + 1];
    if (argument === '--output-dir' && options.output === undefined && value && !value.startsWith('--')) {
      options.output = value;
      index++;
    } else if (argument === '--qualification' && !options.qualification) options.qualification = true;
    else if (argument === '--kinds' && options.kinds === null && value && !value.startsWith('--')) {
      options.kinds = [...new Set(value.split(',').map(kind => kind.trim()))];
      index++;
    } else throw Error(usage);
  }
  if (!options.output) throw Error(usage);
  if (options.qualification && !env.AMCP_QA_AXE_PATH)
    throw Error(
      'Qualification mode requires the pinned axe-core engine: set AMCP_QA_AXE_PATH to the local axe.min.js test asset.',
    );
  if (options.qualification && options.kinds)
    throw Error('Qualification mode runs every fixture kind; --kinds selects a development subset only.');
  if (options.kinds) {
    const unknown = options.kinds.filter(kind => !kind || !knownKinds.includes(kind));
    if (!options.kinds.length || unknown.length) throw Error('Unknown browser fixture kind: ' + unknown.join(', '));
  }
  return options;
}

const increment = (map, key, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};
const sorted = map => Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * What a run actually covered, instead of one headline case count: distinct scenarios (a fixture kind on a route),
 * presentation variants (language × width × appearance), WCAG rules left incomplete (manual review) or violated, per
 * rule and including intermediate dialog and alert states, Arabic leaks per route against the committed ratchet, write
 * journey outcomes, the fixture's own synthetic writes, and focus rings measured.
 */
export function summarizeBrowserEvidence(evidence, baseline) {
  const cases = Array.isArray(evidence?.cases) ? evidence.cases : [],
    scenarios = new Set(),
    kinds = new Set(),
    variants = new Set(),
    incomplete = {},
    violations = {},
    leaks = {},
    outcomes = {},
    focus = {measured: 0, below_threshold: 0, without_indicator: 0, not_focus_visible: 0},
    intermediate = {};
  let passed = 0,
    synthetic = 0,
    providerWrites = 0;
  for (const item of cases) {
    if (item.passed === true) passed++;
    kinds.add(item.kind);
    scenarios.add(item.kind + ' ' + item.route);
    variants.add([item.locale, item.width, item.appearance ?? 'light'].join('/'));
    const states = [
      item.wcag_initial,
      item.wcag_final,
      ...(Array.isArray(item.intermediate_states) ? item.intermediate_states.map(state => state.wcag) : []),
    ];
    for (const wcag of states) {
      for (const rule of wcag?.incomplete ?? []) increment(incomplete, rule.id);
      for (const rule of wcag?.violations ?? []) increment(violations, rule.id);
    }
    for (const state of item.intermediate_states ?? []) increment(intermediate, state.state);
    if (item.arabic_leaks) {
      const route = (leaks[item.route] ??= {cases: 0, max: 0, total: 0});
      route.cases++;
      route.max = Math.max(route.max, item.arabic_leaks.count);
      route.total += item.arabic_leaks.count;
    }
    synthetic += Number.isInteger(item.synthetic_writes) ? item.synthetic_writes : 0;
    providerWrites += Number.isInteger(item.provider_writes) ? item.provider_writes : 0;
    for (const journey of item.write_journeys ?? []) increment(outcomes, journey.outcome);
    for (const finding of item.focus_indicators ?? []) {
      if (finding.measured) {
        focus.measured++;
        if (!finding.passed) focus.below_threshold++;
      } else if (finding.reason === 'no_indicator') focus.without_indicator++;
      else if (finding.reason === 'not_focus_visible') focus.not_focus_visible++;
    }
  }
  const critical = baseline?.critical_routes ?? [];
  return {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    distinct_scenarios: scenarios.size,
    fixture_kinds: kinds.size,
    presentation_variants: variants.size,
    wcag_incomplete_by_rule: sorted(incomplete),
    wcag_violations_by_rule: sorted(violations),
    intermediate_states: sorted(intermediate),
    arabic_leaks_by_route: sorted(leaks),
    arabic_critical_routes: {
      at_zero: critical.filter(route => leaks[route] && leaks[route].max === 0),
      with_leaks: critical.filter(route => leaks[route]?.max > 0),
      not_probed: critical.filter(route => !leaks[route]),
    },
    write_journey_outcomes: sorted(outcomes),
    synthetic_writes: synthetic,
    provider_writes: providerWrites,
    focus_indicators: focus,
  };
}
