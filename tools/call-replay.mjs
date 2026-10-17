// The call-replay equivalence proof for ARC-01 phase B (the batch-33 technique, kept as a tool). A provider concern moves
// out of a shared module only when the provider requests and authorization decisions are the same before and after:
//   1. record: run test files on the build before the change with tools/call-replay-recorder.mjs preloaded. A loader
//      hook wraps the functions named in `targets` in their compiled modules (dist/src); every call is written with its
//      arguments and its result or refusal, the requests each NativeTransport sends included, normalized so that random
//      IDs, times and signatures do not count. Nothing is sent anywhere: the suites' synthetic fetchers answer.
//   2. change the source, build, and record the same test files again;
//   3. compare: the two recordings must hold the same records per test file (0 differences), and replay runs the
//      recorded calls of the pure functions in `replayable` through the current build and compares their results.
// Usage:
//   npm run build && node tools/call-replay.mjs record <dir> [test file ...] [--list file] [--related source file ...]
//   node tools/call-replay.mjs compare <before dir> <after dir> [--show N]
//   node tools/call-replay.mjs replay <before dir>
// Recordings stay outside the repository (they hold test payloads); the commit that moves a concern states the counts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

/**
 * What is recorded, by compiled module: free functions (`export function` or `export const` arrow) and class methods.
 * Each phase B concern adds the entry points of the shared module it changes; entry points stay in place (a shared
 * function that now consults the provider's adapter keeps its name), so both recordings see the same calls.
 */
export const targets = Object.freeze({
  'dist/src/transport.js': {
    functions: ['buildUrl', 'providerRetryDelay', 'losslessReportNumbers'],
    classes: {NativeTransport: ['request', 'uploadGoogleVideo', 'uploadLinkedIn']},
  },
  'dist/src/scope.js': {
    functions: ['ownershipReads', 'snapchatScopedResource', 'snapchatOrganizationPixels'],
    classes: {ScopeGuard: ['authorize', 'observe', 'observeCreated']},
  },
  'dist/src/store.js': {classes: {Store: ['rememberResource', 'ownsResource']}},
  'dist/src/account-id.js': {functions: ['normalizeAccount']},
  'dist/src/execution-risk.js': {
    functions: ['applyExecutionRisk', 'independentlyReadOnly', 'bodyDeletion', 'googleGlobalRead'],
  },
  'dist/src/pagination.js': {functions: ['paginate', 'nextPage', 'continuationArguments', 'nextPageCall']},
  'dist/src/account-metadata.js': {
    functions: ['accountPlan', 'accountMetadata', 'accountCurrency', 'accountTimezone', 'accountKind'],
  },
  'dist/src/provider-error-taxonomy.js': {
    functions: ['classifyProviderError', 'providerErrorCode', 'providerRequestId'],
  },
  'dist/src/write-shape.js': {functions: ['assertWriteShape', 'metaValidationOptions']},
  'dist/src/write-state.js': {functions: ['validateState']},
  'dist/src/review-state.js': {functions: ['normalizeSnapshot']},
  'dist/src/verification-reads.js': {
    functions: ['verificationReads', 'entity', 'verificationContractVersion', 'googleValueVerificationVersion'],
  },
  'dist/src/write-snapshots.js': {functions: ['snapshotPlans']},
  'dist/src/write-outcome.js': {functions: ['writeOutcome']},
  'dist/src/compiler.js': {classes: {Compiler: ['compile']}},
  'dist/src/delegated-native.js': {
    functions: ['delegatedParameterMatches'],
    classes: {DelegatedNativeCompiler: ['compile', 'validateResponse']},
  },
  'dist/src/auth.js': {classes: {CredentialProvider: ['get']}},
  'dist/server/platform-oauth.js': {
    functions: ['platform', 'selectionKind', 'selectableKinds'],
    classes: {PlatformOAuth: ['config', 'publicConfig', 'connectService', 'exchange']},
  },
  'dist/server/asset-discovery.js': {classes: {AssetDiscovery: ['sync', 'discoverWith']}},
});
/** Pure functions whose recorded calls replay through the current build (arguments and results are plain data). */
export const replayable = Object.freeze([
  'dist/src/account-id.js#normalizeAccount',
  'dist/src/execution-risk.js#applyExecutionRisk',
  'dist/src/execution-risk.js#independentlyReadOnly',
  'dist/src/execution-risk.js#bodyDeletion',
  'dist/src/execution-risk.js#googleGlobalRead',
  'dist/src/pagination.js#nextPage',
  'dist/src/pagination.js#continuationArguments',
  'dist/src/account-metadata.js#accountPlan',
  'dist/src/account-metadata.js#accountMetadata',
  'dist/src/account-metadata.js#accountCurrency',
  'dist/src/account-metadata.js#accountTimezone',
  'dist/src/account-metadata.js#accountKind',
  'dist/src/scope.js#ownershipReads',
  'dist/src/scope.js#snapchatScopedResource',
  'dist/src/scope.js#snapchatOrganizationPixels',
  'dist/src/transport.js#losslessReportNumbers',
  'dist/src/provider-error-taxonomy.js#providerErrorCode',
  'dist/src/write-shape.js#assertWriteShape',
  'dist/src/write-shape.js#metaValidationOptions',
  'dist/src/review-state.js#normalizeSnapshot',
  'dist/src/verification-reads.js#entity',
  'dist/src/verification-reads.js#verificationContractVersion',
  'dist/src/verification-reads.js#googleValueVerificationVersion',
  'dist/src/delegated-native.js#delegatedParameterMatches',
  'dist/server/platform-oauth.js#selectionKind',
  'dist/server/platform-oauth.js#selectableKinds',
]);

const posix = file => file.replaceAll('\\', '/');
/** The source text of a compiled target module with its targets wrapped; unchanged for any other module. */
export function instrument(source, spec, moduleId) {
  let out = String(source);
  const appended = [];
  for (const name of spec.functions ?? []) {
    const declaration = new RegExp('^export (async )?function ' + name + '\\(', 'm'),
      arrow = new RegExp('^export const ' + name + ' = ', 'm'),
      original = '__callReplayOriginal_' + name,
      id = JSON.stringify(moduleId + '#' + name),
      call = 'globalThis.__amcpCallReplay ? globalThis.__amcpCallReplay.call(' + id + ', ' + original;
    if (declaration.test(out)) {
      out = out.replace(declaration, (_m, async) => (async ?? '') + 'function ' + original + '(');
      appended.push(
        'export function ' +
          name +
          '(...args) { return ' +
          call +
          ', this, args) : ' +
          original +
          '.apply(this, args); }',
      );
    } else if (arrow.test(out)) {
      out = out.replace(arrow, 'const ' + original + ' = ');
      appended.push(
        'export const ' + name + ' = (...args) => ' + call + ', undefined, args) : ' + original + '(...args);',
      );
    } else appended.push('globalThis.__amcpCallReplay?.missing(' + id + ');');
  }
  for (const [name, methods] of Object.entries(spec.classes ?? {}))
    appended.push(
      'globalThis.__amcpCallReplay?.patchClass(' +
        name +
        ', ' +
        JSON.stringify(moduleId + '#' + name) +
        ', ' +
        JSON.stringify(methods) +
        ');',
    );
  return appended.length ? out + '\n// call-replay instrumentation\n' + appended.join('\n') + '\n' : out;
}

/** The target module id (`dist/src/scope.js`) of a file URL under the repository, or undefined. */
export function targetOf(url, root) {
  if (!String(url).startsWith('file:')) return undefined;
  const relative = posix(path.relative(root, fileURLToPath(url)));
  return Object.hasOwn(targets, relative) ? relative : undefined;
}

const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g,
  epochMs = /\b1[6-9]\d{11}\b/g,
  oauthPart = /\b(oauth_(?:nonce|timestamp|signature))="[^"]*"/g;
/** Values that differ between two runs of the same test without meaning anything: IDs, clocks, signatures. */
export function normalizeText(text) {
  return String(text)
    .replace(uuid, '<uuid>')
    .replace(iso, '<time>')
    .replace(epochMs, '<epoch-ms>')
    .replace(oauthPart, '$1="<oauth>"');
}
const secretKey =
  /^(?:authorization|access[-_]?token|refresh[-_]?token|client[-_]?secret|code[-_]?verifier|developer[-_]?token|x-api-key|api[-_]?key|cookie|password)$/i;
const secretField =
  /\b(client_secret|refresh_token|access_token|code_verifier|client_assertion|oauth_token_secret|password)=([^&\s"]+)/g;
const digest = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const clockRefusals = new Set([
  'TENANT_RATE_LIMIT',
  'PLATFORM_RATE_LIMIT',
  'CIRCUIT_OPEN',
  'PROVIDER_COORDINATION_BUSY',
]);
/**
 * A JSON-safe copy of a recorded value: undefined, functions, bytes, maps, sets and errors are marked; instances of
 * classes (a Store, a Registry) are named, not walked; header and credential values are digested, never written.
 */
export function encode(value, seen = new Set(), depth = 0, key = '') {
  if (value === undefined) return {$undefined: true};
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value)
      ? /deadline|timeout|until|_at$|At$/i.test(key) && !Number.isInteger(value)
        ? '<clock>'
        : value
      : {$number: String(value)};
  if (typeof value === 'bigint') return {$bigint: String(value)};
  if (typeof value === 'string') {
    if (
      secretKey.test(key) ||
      /^(?:accessToken|refreshToken|clientSecret|consumerSecret|tokenSecret|password|apiKey|applePrivateKey|developerToken)$/.test(
        key,
      )
    )
      return '<secret:' + digest(normalizeText(value)) + '>';
    const text = value.includes('=')
      ? value.replace(secretField, (_m, name, secret) => name + '=<secret:' + digest(secret) + '>')
      : value;
    return text.length > 20000 ? {$text: digest(normalizeText(text)), length: text.length} : text;
  }
  if (typeof value === 'function') return {$function: value.name || 'anonymous'};
  if (typeof value === 'symbol') return {$symbol: String(value.description)};
  if (depth > 40) return {$deep: true};
  if (seen.has(value)) return {$cycle: true};
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return {$bytes: value.byteLength, sha256: digest(Buffer.from(value.buffer, value.byteOffset, value.byteLength))};
  if (value instanceof ArrayBuffer) return {$bytes: value.byteLength, sha256: digest(Buffer.from(value))};
  if (value instanceof URL) return {$url: value.href};
  if (value instanceof Date) return {$date: Number.isFinite(value.getTime()) ? '<time>' : 'invalid'};
  if (value instanceof URLSearchParams) return {$search: value.toString()};
  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    const entries = [];
    for (const [name, part] of value.entries())
      entries.push([name, typeof part === 'string' ? part : {$blob: part.type, size: part.size, name: part.name}]);
    return {$form: entries};
  }
  if (typeof Headers !== 'undefined' && value instanceof Headers)
    return encode(Object.fromEntries([...value.entries()]), seen, depth + 1, key);
  if (value instanceof Error) {
    const details = encode(value.details, seen, depth + 1, 'details');
    // These refusals compute their wait from the process clock; a provider's own Retry-After stays compared.
    if (clockRefusals.has(value.code) && details && typeof details.retry_after_ms === 'number')
      details.retry_after_ms = '<clock>';
    return {
      $error: value.name,
      code: value.code,
      message: value.message,
      status: value.status,
      retryable: value.retryable,
      details,
    };
  }
  seen.add(value);
  try {
    if (value instanceof Map) return {$map: [...value.entries()].map(e => encode(e, seen, depth + 1))};
    if (value instanceof Set) return {$set: [...value].map(v => encode(v, seen, depth + 1))};
    if (Array.isArray(value)) return value.map(v => encode(v, seen, depth + 1, key));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return {$instance: value.constructor?.name ?? 'object'};
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = encode(value[k], seen, depth + 1, k);
    return out;
  } finally {
    seen.delete(value);
  }
}
/** Deterministic JSON of an encoded value (keys are already sorted by encode). */
export const recordText = record => normalizeText(JSON.stringify(record));

/**
 * The records of a recording directory, per test file: a map of record text to its count. `failed` names the test
 * files whose process exited with a failure (the recorder's `$exit` record), kept apart from the calls.
 */
export function readRecording(directory) {
  const perTest = new Map(),
    failed = new Set();
  for (const name of fs.readdirSync(directory).sort()) {
    if (!name.endsWith('.calls.jsonl')) continue;
    const test = name.replace(/\.\d+\.calls\.jsonl$/, '');
    const records = perTest.get(test) ?? new Map();
    for (const line of fs.readFileSync(path.join(directory, name), 'utf8').split('\n')) {
      if (!line) continue;
      const {count = 1, ...record} = JSON.parse(line);
      if (record.id === '$exit') {
        if (record.code) failed.add(test);
        continue;
      }
      const text = recordText(record);
      records.set(text, (records.get(text) ?? 0) + count);
    }
    perTest.set(test, records);
  }
  perTest.failed = failed;
  return perTest;
}

/** Differences between two recordings: records whose count differs, per test file, and per-function totals. */
export function compareRecordings(before, after) {
  const differences = [],
    totals = {};
  const tests = [...new Set([...before.keys(), ...after.keys()])].sort();
  let records = 0;
  for (const test of tests) {
    const a = before.get(test) ?? new Map(),
      b = after.get(test) ?? new Map();
    for (const text of new Set([...a.keys(), ...b.keys()])) {
      const id = JSON.parse(text).id,
        x = a.get(text) ?? 0,
        y = b.get(text) ?? 0;
      totals[id] = (totals[id] ?? 0) + Math.max(x, y);
      records += Math.max(x, y);
      if (x !== y) differences.push({test, id, before: x, after: y, record: text});
    }
  }
  return {
    tests: tests.length,
    records,
    totals,
    differences,
    failed_before: [...(before.failed ?? [])].sort(),
    failed_after: [...(after.failed ?? [])].sort(),
  };
}

/** Recorded calls of the replayable functions, distinct by their arguments. */
export function replayCalls(directory) {
  const calls = new Map();
  for (const name of fs.readdirSync(directory).sort()) {
    if (!name.endsWith('.replay.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(directory, name), 'utf8').split('\n')) {
      if (!line) continue;
      const call = JSON.parse(line),
        key = call.id + '\n' + call.args;
      if (!calls.has(key)) calls.set(key, call);
    }
  }
  return [...calls.values()];
}

/** Revives arguments written by the recorder's raw encoder (`$undefined` markers become undefined). */
export function revive(value) {
  if (Array.isArray(value)) return value.map(revive);
  if (!value || typeof value !== 'object') return value;
  if (value.$undefined === true && Object.keys(value).length === 1) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const r = revive(v);
    if (r !== undefined || (v && v.$undefined === true)) out[k] = r;
  }
  return out;
}

function main(argv) {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    [mode, ...rest] = argv;
  if (mode === 'record') {
    const [directory, ...args] = rest;
    if (!directory) throw Error('record needs an output directory');
    fs.mkdirSync(directory, {recursive: true});
    for (const name of fs.readdirSync(directory))
      if (/\.(?:calls|replay)\.jsonl$/.test(name)) fs.rmSync(path.join(directory, name));
    // Test files: those named, those listed one per line in --list files, and with --related the related selection
    // (tools/related-tests.mjs) of the source files named after it.
    const named = [],
      changed = [];
    for (let i = 0, related = false; i < args.length; i++) {
      if (args[i] === '--list') named.push(...fs.readFileSync(args[++i], 'utf8').split(/\r?\n/).filter(Boolean));
      else if (args[i] === '--related') related = true;
      else (related ? changed : named).push(args[i]);
    }
    if (changed.length) {
      const plan = JSON.parse(
        spawnSync(process.execPath, ['tools/related-tests.mjs', '--plan', ...changed], {cwd: root, encoding: 'utf8'})
          .stdout,
      );
      named.push(...plan.selected);
    }
    const run = [...new Set(named.map(t => (t.endsWith('.ts') ? 'dist/' + t.replace(/\.ts$/, '.js') : t)))].sort();
    if (!run.length) throw Error('no test files to record');
    console.log(JSON.stringify({event: 'call_replay_record', directory, test_files: run.length}));
    const recorder = pathToFileURL(path.join(root, 'tools/call-replay-recorder.mjs')).href;
    let output = '',
      exit = 0;
    // Batches keep each command line short (Windows) while the test runner still runs a batch's files in parallel.
    const batch = 300;
    for (let start = 0; start < run.length; start += batch) {
      const result = spawnSync(
        process.execPath,
        ['--test', '--import', recorder, '--test-reporter=dot', ...run.slice(start, start + batch)],
        {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
          maxBuffer: 1024 * 1024 * 1024,
          env: {...process.env, AMCP_CALL_REPLAY_DIR: path.resolve(directory), AMCP_CALL_REPLAY_ROOT: root},
        },
      );
      output += result.stdout + result.stderr;
      if (result.status !== 0) exit = result.status ?? 1;
    }
    fs.writeFileSync(path.join(directory, 'test-output.txt'), output);
    const recording = readRecording(directory);
    console.log(
      JSON.stringify({
        event: 'call_replay_recorded',
        exit,
        test_processes: recording.size,
        failed_test_files: [...recording.failed].sort(),
        output: 'test-output.txt',
      }),
    );
    return exit === 0 ? 0 : 2;
  }
  if (mode === 'compare') {
    const [a, b] = rest,
      show = Number(rest[rest.indexOf('--show') + 1] ?? 10) || 10;
    const result = compareRecordings(readRecording(a), readRecording(b));
    console.log(
      JSON.stringify({
        event: 'call_replay_compare',
        tests: result.tests,
        records: result.records,
        differences: result.differences.length,
        failed_before: result.failed_before,
        failed_after: result.failed_after,
        totals: result.totals,
      }),
    );
    for (const d of result.differences.slice(0, show)) console.log(JSON.stringify(d));
    return result.differences.length ? 1 : 0;
  }
  if (mode === 'replay') {
    const [directory] = rest;
    return replay(root, directory);
  }
  console.error('Usage: node tools/call-replay.mjs record|compare|replay ...');
  return 1;
}

async function replay(root, directory) {
  const calls = replayCalls(directory),
    modules = new Map(),
    counts = {},
    differences = [];
  for (const call of calls) {
    const [moduleId, name] = call.id.split('#');
    if (!modules.has(moduleId)) modules.set(moduleId, await import(pathToFileURL(path.join(root, moduleId)).href));
    const fn = modules.get(moduleId)[name];
    let outcome;
    if (typeof fn !== 'function') outcome = {missing: true};
    else
      try {
        outcome = {returns: encode(fn(...revive(JSON.parse(call.args))))};
      } catch (error) {
        outcome = {throws: encode(error)};
      }
    const now = normalizeText(JSON.stringify(outcome)),
      then = normalizeText(JSON.stringify(call.outcome));
    counts[call.id] = (counts[call.id] ?? 0) + 1;
    if (now !== then)
      differences.push({
        id: call.id,
        args: call.args.slice(0, 400),
        before: then.slice(0, 400),
        after: now.slice(0, 400),
      });
  }
  console.log(
    JSON.stringify({event: 'call_replay_replay', calls: calls.length, differences: differences.length, counts}),
  );
  for (const d of differences.slice(0, 10)) console.log(JSON.stringify(d));
  return differences.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const status = main(process.argv.slice(2));
  if (status instanceof Promise) status.then(code => (process.exitCode = code));
  else process.exitCode = status;
}
