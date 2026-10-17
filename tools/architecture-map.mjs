// The architecture ratchet (ARC-01 phase A, ARC-04 stage A; owner decision D26: it blocks only regressions). It measures
// the compiled backend and compares the measurements with docs/review/architecture-baseline.json:
//   - runtime import cycles: strongly connected components of the static imports Node evaluates (dist/src and
//     dist/server; type-only imports are elided by tsc, dynamic import() is not an evaluation edge);
//   - shared modules with gateway literals: src/ and server/ modules outside the provider groups that name a provider
//     gateway ('meta_native_action'...) in a string literal;
//   - shared -> provider runtime imports: runtime edges from any shared module (src/ or server/) to a provider module,
//     except the provider registries, which shared modules are meant to consult instead. The review's "core ->
//     provider" count (220 at 60ec2cc) counted 28 core modules only; this one counts every shared module, so its value
//     is larger and is compared only with its own baseline.
// Reported but not ratcheted: the number of gateway literals in shared modules and the modules with a local fail().
// A ratcheted measurement may fall or stay; one that rises, or a module that joins a cycle, is a regression. `--write`
// records the current measurements as the new baseline (after an intended improvement, or a regression the owner
// accepted; say which in the commit).
// Usage: npm run build && node tools/architecture-map.mjs [--check] [--write] [--json]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const baselineFile = 'docs/review/architecture-baseline.json';
/**
 * Filename groups that hold one provider's code (the R28 provider grouping). Everything else in src/ and server/ is
 * shared: the lifecycle, composite tools, reporting, the website and the composition root.
 */
export const providerPrefixes = Object.freeze([
  'adjust',
  'apple',
  'criteo',
  'dv360',
  'ga4',
  'google',
  'gtm',
  'linkedin',
  'measurement',
  'meta',
  'microsoft',
  'reddit',
  'snapchat',
  'tiktok',
  'woocommerce',
  'x',
]);
/**
 * Registries where provider facts belong: the provider adapter registry (ARC-01) names every gateway on purpose, and the
 * portfolio adapter and report source registries (ARC-04 stages E and F) import one module per provider so that shared
 * code consults them instead of branching on providers. Each counts with the provider modules rather than as a shared
 * module, and an import of one is not counted as coupling.
 */
export const providerRegistries = Object.freeze([
  'src/provider-adapters.ts',
  'src/portfolio.ts',
  'src/report-sources.ts',
]);
const roots = ['src', 'server'];
const posix = file => file.replaceAll('\\', '/');

/** True for a provider module id such as `src/meta-portfolio.ts`, or a provider registry. */
export function isProviderModule(id) {
  const name = path.posix.basename(id).replace(/\.(?:ts|js)$/, '');
  return (id.startsWith('src/') && providerPrefixes.includes(name.split('-')[0])) || providerRegistries.includes(id);
}

/** The relative specifiers of a compiled module's static imports and re-exports (not `import()`). */
export function staticSpecifiers(text) {
  const out = [];
  for (const match of String(text).matchAll(
    /^\s*(?:import\s+(?:[\w*{}\s,$]+?\s+from\s+)?|export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+)['"](\.{1,2}\/[^'"\n]+)['"]/gm,
  ))
    out.push(match[1]);
  return out;
}

/** Compiled modules of src/ and server/ by source id (`src/scope.ts`), with the source ids they import at runtime. */
export function runtimeGraph(root) {
  const graph = new Map();
  for (const directory of roots) {
    const compiled = path.join(root, 'dist', directory);
    if (!fs.existsSync(compiled)) throw Error('dist/' + directory + ' is missing: run npm run build first.');
    for (const name of fs.readdirSync(compiled).sort()) {
      if (!name.endsWith('.js')) continue;
      const id = directory + '/' + name.replace(/\.js$/, '.ts'),
        edges = new Set();
      for (const specifier of staticSpecifiers(fs.readFileSync(path.join(compiled, name), 'utf8'))) {
        const target = posix(path.posix.normalize(path.posix.join(directory, specifier)));
        if (target.endsWith('.js') && roots.includes(target.split('/')[0])) edges.add(target.replace(/\.js$/, '.ts'));
      }
      graph.set(id, edges);
    }
  }
  return graph;
}

/** Strongly connected components with more than one module (Tarjan), largest first, members sorted. */
export function stronglyConnected(graph) {
  let index = 0;
  const indices = new Map(),
    low = new Map(),
    stack = [],
    onStack = new Set(),
    components = [];
  const visit = start => {
    // Iterative Tarjan: a frame is [node, its remaining neighbours].
    const frames = [[start, [...(graph.get(start) ?? [])]]];
    indices.set(start, index);
    low.set(start, index++);
    stack.push(start);
    onStack.add(start);
    while (frames.length) {
      const frame = frames.at(-1),
        [node, pending] = frame;
      if (pending.length) {
        const next = pending.shift();
        if (!graph.has(next)) continue;
        if (!indices.has(next)) {
          indices.set(next, index);
          low.set(next, index++);
          stack.push(next);
          onStack.add(next);
          frames.push([next, [...(graph.get(next) ?? [])]]);
        } else if (onStack.has(next)) low.set(node, Math.min(low.get(node), indices.get(next)));
        continue;
      }
      frames.pop();
      if (frames.length) {
        const parent = frames.at(-1)[0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === indices.get(node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== node);
        if (component.length > 1) components.push(component.sort());
      }
    }
  };
  for (const node of [...graph.keys()].sort()) if (!indices.has(node)) visit(node);
  return components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/** Source text of every src/ and server/ module, by id. */
function sources(root) {
  const out = new Map();
  for (const directory of roots)
    for (const name of fs.readdirSync(path.join(root, directory)).sort())
      if (name.endsWith('.ts') && !name.endsWith('.d.ts'))
        out.set(directory + '/' + name, fs.readFileSync(path.join(root, directory, name), 'utf8'));
  return out;
}

const gatewayLiteral = /['"]([a-z0-9]+(?:_[a-z0-9]+)*)_native_action['"]/g;
const localFail = /^(?:export\s+)?(?:const\s+fail\s*(?::[^=]+)?=|function\s+fail\s*[(<])/m;

/** Every measurement the ratchet compares, plus the cycle membership it reports. */
export function architectureMetrics(root) {
  root = fs.realpathSync(root);
  const graph = runtimeGraph(root),
    components = stronglyConnected(graph),
    text = sources(root);
  let literals = 0,
    sharedToProvider = 0;
  const shared = [],
    fails = [];
  for (const [id, source] of text) {
    // The family kit's fail (ARC-04 stage C) is the one copy the others should import.
    if (localFail.test(source) && id !== 'src/family-kit.ts') fails.push(id);
    if (isProviderModule(id)) continue;
    const named = [...source.matchAll(gatewayLiteral)].filter(m => m[1] !== 'amcp').length;
    if (named) {
      shared.push(id);
      literals += named;
    }
  }
  // Consulting a provider registry is the decoupled form of a provider dependency, so it is not counted.
  for (const [from, edges] of graph)
    if (!isProviderModule(from))
      for (const to of edges) if (isProviderModule(to) && !providerRegistries.includes(to)) sharedToProvider++;
  return {
    metrics: {
      largest_runtime_scc: components[0]?.length ?? 0,
      cyclic_modules: components.reduce((n, c) => n + c.length, 0),
      shared_modules_with_gateway_literals: shared.length,
      shared_to_provider_runtime_imports: sharedToProvider,
    },
    reported: {
      runtime_scc_sizes: components.map(c => c.length),
      shared_gateway_literals: literals,
      local_fail_copies: fails.length,
    },
    cycles: components,
    modules: graph.size,
  };
}

/** Measurements that may only fall, and what each one counts. */
export const ratchetedMetrics = Object.freeze({
  largest_runtime_scc: 'modules in the largest runtime import cycle',
  cyclic_modules: 'modules in any runtime import cycle',
  shared_modules_with_gateway_literals: 'shared modules that name a provider gateway',
  shared_to_provider_runtime_imports: 'runtime imports from shared modules into provider modules',
});

/** Compares measurements with a baseline: regressions fail the check, improvements can be recorded with --write. */
export function compareToBaseline(current, baseline) {
  const regressions = [],
    improvements = [];
  for (const [key, meaning] of Object.entries(ratchetedMetrics)) {
    const now = current.metrics[key],
      before = baseline.metrics?.[key];
    if (typeof before !== 'number') {
      regressions.push(key + ': the baseline has no value (' + meaning + '); record one with --write');
      continue;
    }
    if (now > before) regressions.push(key + ' rose from ' + before + ' to ' + now + ' (' + meaning + ')');
    else if (now < before) improvements.push(key + ' fell from ' + before + ' to ' + now);
  }
  const known = new Set((baseline.cycles ?? []).flat());
  const joined = current.cycles.flat().filter(id => !known.has(id));
  if (joined.length)
    regressions.push(
      'modules joined a runtime import cycle: ' +
        joined.join(', ') +
        '. Import the pure helper from a leaf module instead of a module that imports the family registry.',
    );
  return {regressions, improvements};
}

export function baselineRecord(current) {
  return {
    schema_version: 1,
    description:
      'Architecture ratchet baseline (ARC-01 phase A, ARC-04 stage A). node tools/architecture-map.mjs --check fails when a measurement rises or a module joins a runtime import cycle; --write records the current state. See docs/review/ARCHITECTURE.md.',
    metrics: current.metrics,
    reported: current.reported,
    cycles: current.cycles,
  };
}

function main(argv) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    current = architectureMetrics(root),
    file = path.join(root, baselineFile);
  if (argv.includes('--write')) {
    fs.writeFileSync(file, JSON.stringify(baselineRecord(current), null, 2) + '\n');
    console.log('Recorded ' + baselineFile + ': ' + JSON.stringify(current.metrics));
    return 0;
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(current, null, 2));
    return 0;
  }
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8')),
    {regressions, improvements} = compareToBaseline(current, baseline);
  console.log(
    JSON.stringify({
      event: 'architecture_ratchet',
      modules: current.modules,
      ...current.metrics,
      ...current.reported,
      regressions,
      improvements,
    }),
  );
  if (regressions.length) {
    for (const line of regressions) console.error('Architecture regression: ' + line);
    console.error(
      'Keep new provider logic in the provider’s own modules and import pure helpers from their leaf modules; an accepted regression is recorded with --write and named in the commit.',
    );
    return 1;
  }
  if (improvements.length) console.log('Improved; record it with node tools/architecture-map.mjs --write.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
