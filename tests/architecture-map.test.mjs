import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  architectureMetrics,
  baselineFile,
  compareToBaseline,
  isProviderModule,
  staticSpecifiers,
  stronglyConnected,
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
  assert.equal(missing.regressions.length, 3);
});

test('the compiled tree is within the committed architecture baseline', () => {
  const baseline = JSON.parse(fs.readFileSync(new URL('../' + baselineFile, import.meta.url), 'utf8')),
    current = architectureMetrics('.'),
    {regressions} = compareToBaseline(current, baseline);
  assert.deepEqual(regressions, [], 'node tools/architecture-map.mjs --check explains each regression');
});
