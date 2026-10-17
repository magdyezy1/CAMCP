import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  architectureDocument,
  architectureMetrics,
  baselineFile,
  baselineMarkdown,
  compareToBaseline,
  declaresLocalFail,
  isProviderModule,
  ratchetedMetrics,
  staticSpecifiers,
  stronglyConnected,
  withBaselineBlock,
} from '../tools/architecture-map.mjs';

// The architecture ratchet (ARC-01 phase A, ARC-04 stage A, owner decision D26): measurements may only fall, and no
// module may join a runtime import cycle.

const graph = edges => new Map(Object.entries(edges).map(([id, to]) => [id, new Set(to)]));

test('static specifiers are the evaluated imports and re-exports, never a dynamic import()', () => {
  const text = [
    "import { a, b } from './a.js';",
    "import './side-effect.js';",
    "import * as all from '../server/all.js';",
    "export { c } from './c.js';",
    "export * from './d.js';",
    "const later = await import('./lazy.js');",
    "import fs from 'node:fs';",
  ].join('\n');
  assert.deepEqual(staticSpecifiers(text), ['./a.js', './side-effect.js', '../server/all.js', './c.js', './d.js']);
});

test('cycles are the strongly connected components, largest first; a self-free chain is no cycle', () => {
  const components = stronglyConnected(
    graph({
      'src/a.ts': ['src/b.ts'],
      'src/b.ts': ['src/c.ts'],
      'src/c.ts': ['src/a.ts', 'src/d.ts'],
      'src/d.ts': ['src/e.ts'],
      'src/e.ts': ['src/d.ts'],
      'src/f.ts': ['src/a.ts'],
      'src/g.ts': [],
    }),
  );
  assert.deepEqual(components, [
    ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    ['src/d.ts', 'src/e.ts'],
  ]);
});

test('provider modules are the provider filename groups; the lifecycle and the website are shared', () => {
  assert.equal(isProviderModule('src/meta-portfolio.ts'), true);
  assert.equal(isProviderModule('src/x-report-jobs.ts'), true);
  assert.equal(isProviderModule('src/woocommerce-source.ts'), true);
  // The provider adapter registry names every gateway on purpose: it counts with the providers (ARC-01).
  assert.equal(isProviderModule('src/provider-adapters.ts'), true);
  // The registries shared code consults instead of naming providers (ARC-04 stages E and F, and the reviewed-family
  // registry the lifecycle consults: ARC-01 phase B).
  assert.equal(isProviderModule('src/portfolio.ts'), true);
  assert.equal(isProviderModule('src/report-sources.ts'), true);
  assert.equal(isProviderModule('src/reviewed-families.ts'), true);
  assert.equal(isProviderModule('src/reviewed-family.ts'), false, 'the family contract is shared');
  assert.equal(isProviderModule('src/portfolio-runner.ts'), false);
  assert.equal(isProviderModule('src/report-source.ts'), false);
  assert.equal(isProviderModule('src/provider-offering.ts'), false);
  assert.equal(isProviderModule('src/scope.ts'), false);
  assert.equal(isProviderModule('src/report-native.ts'), false);
  assert.equal(isProviderModule('server/platform-oauth.ts'), false);
});

test('a rising measurement or a module joining a cycle is a regression; a fall is an improvement', () => {
  const baseline = {
    metrics: {
      largest_runtime_scc: 3,
      cyclic_modules: 5,
      shared_modules_with_gateway_literals: 10,
      shared_to_provider_runtime_imports: 20,
      local_fail_copies: 0,
    },
    cycles: [
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      ['src/d.ts', 'src/e.ts'],
    ],
  };
  const same = {metrics: {...baseline.metrics}, cycles: baseline.cycles};
  assert.deepEqual(compareToBaseline(same, baseline), {regressions: [], improvements: []});
  // A shared module that starts naming a gateway, and a new runtime import into a provider module.
  const grown = compareToBaseline(
    {
      metrics: {...baseline.metrics, shared_modules_with_gateway_literals: 11, shared_to_provider_runtime_imports: 21},
      cycles: baseline.cycles,
    },
    baseline,
  );
  assert.equal(grown.regressions.length, 2);
  assert.match(grown.regressions[0], /shared_modules_with_gateway_literals rose from 10 to 11/);
  assert.match(grown.regressions[1], /shared_to_provider_runtime_imports rose from 20 to 21/);
  // A module joining an existing cycle is refused even when another cycle shrank by the same amount.
  const swapped = compareToBaseline(
    {
      metrics: baseline.metrics,
      cycles: [
        ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        ['src/d.ts', 'src/z.ts'],
      ],
    },
    baseline,
  );
  assert.deepEqual(swapped.regressions.length, 1);
  assert.match(swapped.regressions[0], /joined a runtime import cycle: src\/z\.ts/);
  // Breaking a cycle is an improvement, never a failure.
  const broken = compareToBaseline(
    {metrics: {...baseline.metrics, largest_runtime_scc: 2, cyclic_modules: 2}, cycles: [['src/d.ts', 'src/e.ts']]},
    baseline,
  );
  assert.deepEqual(broken.regressions, []);
  assert.deepEqual(broken.improvements, ['largest_runtime_scc fell from 3 to 2', 'cyclic_modules fell from 5 to 2']);
  // A baseline without a value for a ratcheted measurement fails rather than passing silently.
  const missing = compareToBaseline(same, {metrics: {largest_runtime_scc: 3}, cycles: baseline.cycles});
  assert.equal(missing.regressions.length, 4);
});

test('ARC-04 stage C: a module that declares its own fail is a regression that names it; a kit-built refusal is not one', () => {
  for (const source of [
    'function fail(code: string, message: string): never {',
    'export function fail(code: string, message: string, details = {}): never {',
    'const fail = (message: string, code = "INVALID_X"): never => {',
    'const fail = message => {',
    'export const fail = function (message) {',
  ])
    assert.equal(declaresLocalFail(source, 'src/x-example.ts'), true, source);
  for (const source of [
    "import {fail} from './family-kit.js';",
    "const fail: ReasonFirstRefusal = familyErrors('INVALID_X', {X_STATE_UNVERIFIED: 502});",
    'const fail: StatusRefusal = failWithStatus(409);',
    'export {fail};',
    'const failure = (message: string) => {',
    '  const fail = (message: string) => {',
  ])
    assert.equal(declaresLocalFail(source, 'src/x-example.ts'), false, source);
  // The kit's own fail is the one the others import.
  assert.equal(declaresLocalFail('export function fail(code, message) {', 'src/family-kit.ts'), false);
  const baseline = {
    metrics: {
      largest_runtime_scc: 3,
      cyclic_modules: 5,
      shared_modules_with_gateway_literals: 10,
      shared_to_provider_runtime_imports: 20,
      local_fail_copies: 0,
    },
    cycles: [],
  };
  const copied = compareToBaseline(
    {metrics: {...baseline.metrics, local_fail_copies: 1}, cycles: [], local_fail_modules: ['src/x-example.ts']},
    baseline,
  );
  assert.equal(copied.regressions.length, 1);
  assert.match(copied.regressions[0], /local_fail_copies rose from 0 to 1 .*: src\/x-example\.ts; import fail/);
  // Every module of the tree imports the kit instead (local fail copies: 153 before stage C).
  const {metrics, local_fail_modules} = architectureMetrics('.');
  assert.deepEqual([metrics.local_fail_copies, local_fail_modules], [0, []]);
});

test('the compiled tree is within the committed architecture baseline', () => {
  const baseline = JSON.parse(fs.readFileSync(new URL('../' + baselineFile, import.meta.url), 'utf8')),
    current = architectureMetrics('.'),
    {regressions} = compareToBaseline(current, baseline);
  assert.deepEqual(regressions, [], 'node tools/architecture-map.mjs --check explains each regression');
});

test('ARC-04 stage B: no runtime import cycle holds the family registry, the lifecycle or the workspace tool, and none exceeds three modules', () => {
  const {cycles, metrics} = architectureMetrics('.');
  // 34 modules before stage B, with the registry, review-state, scope, execution-risk and write-shape among them, and a
  // separate 13-module cycle through workspace.ts and the reporting modules.
  assert.ok(metrics.largest_runtime_scc <= 3, JSON.stringify(cycles));
  const kept = [
    'src/reviewed-families.ts',
    'src/reviewed-routes.ts',
    'src/review-state.ts',
    'src/scope.ts',
    'src/execution-risk.ts',
    'src/write-shape.ts',
    'src/native-authority.ts',
    'src/workspace.ts',
    'src/report-native.ts',
    'src/reporting.ts',
    'src/action-contracts.ts',
  ];
  for (const cycle of cycles) for (const module of kept) assert.ok(!cycle.includes(module), module + ' in ' + cycle);
});

test('owner direction P11: the architecture document shows the recorded baseline in the table the ratchet writes', () => {
  const baseline = {
    metrics: {
      largest_runtime_scc: 3,
      cyclic_modules: 5,
      shared_modules_with_gateway_literals: 10,
      shared_to_provider_runtime_imports: 20,
      local_fail_copies: 0,
    },
    reported: {shared_gateway_literals: 42},
    cycles: [
      ['src/a.ts', 'src/b.ts'],
      ['src/c.ts', 'src/d.ts', 'src/e.ts'],
    ],
  };
  const table = baselineMarkdown(baseline);
  for (const key of Object.keys(ratchetedMetrics))
    assert.match(table, new RegExp('\\| `' + key + '` \\| ' + baseline.metrics[key] + ' \\|'), key);
  assert.match(table, /\| `shared_gateway_literals` \(reported\) \| 42 \|/);
  assert.match(table, /`src\/a\.ts` ↔ `src\/b\.ts`; `src\/c\.ts` ↔ `src\/d\.ts` ↔ `src\/e\.ts`/);
  // Only the block between the markers changes; a document without one, or with two, is refused.
  const document = 'Before.\n\n' + table.replace('| 42 |', '| 41 |') + '\n\nAfter.\n';
  assert.equal(withBaselineBlock(document, baseline), 'Before.\n\n' + table + '\n\nAfter.\n');
  assert.equal(withBaselineBlock('No block.\n', baseline), undefined);
  assert.equal(withBaselineBlock(table + '\n' + table, baseline), undefined);
  // The committed document shows the committed baseline, so a hand edit or a stale table fails the check.
  const committed = fs.readFileSync(new URL('../' + architectureDocument, import.meta.url), 'utf8'),
    recorded = JSON.parse(fs.readFileSync(new URL('../' + baselineFile, import.meta.url), 'utf8'));
  assert.equal(withBaselineBlock(committed, recorded), committed);
});
