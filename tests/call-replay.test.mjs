import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  compareRecordings,
  differingPaths,
  encode,
  instrument,
  noiseProfile,
  normalizeText,
  normalizeValue,
  readRecording,
  recordText,
  recordingKey,
  replayable,
  revive,
  targetOf,
  targets,
  timingOption,
} from '../tools/call-replay.mjs';
import {removeTestPath} from '../dist/tests/temp.js';

// The call-replay equivalence proof of ARC-01 phase B: the recorder must see every call of a target without changing
// it, and two recordings compare equal exactly when the same calls had the same results.

const moduleSource = [
  'export function plain(a, b) { return a + b; }',
  'export async function later(a) { return a * 2; }',
  'export const arrow = (a) => { if (a < 0) throw new Error("negative"); return -a; };',
  'export function internal(a) { return plain(a, 1); }',
  'export class Box { open(x) { return "open:" + x; } }',
].join('\n');
const spec = {functions: ['plain', 'later', 'arrow', 'internal', 'absent'], classes: {Box: ['open', 'shut']}};

test('instrumented targets call through unchanged and every call is reported, refusals included', async () => {
  const calls = [];
  globalThis.__amcpCallReplay = {
    call(id, fn, self, args) {
      try {
        const result = fn.apply(self, args);
        calls.push([id, args, result instanceof Promise ? 'promise' : result]);
        return result;
      } catch (error) {
        calls.push([id, args, 'throws ' + error.message]);
        throw error;
      }
    },
    patchClass(cls, id, methods) {
      for (const method of methods) {
        const original = cls.prototype[method];
        if (typeof original !== 'function') {
          calls.push([id + '.' + method, 'missing']);
          continue;
        }
        cls.prototype[method] = function (...args) {
          return globalThis.__amcpCallReplay.call(id + '.' + method, original, this, args);
        };
      }
    },
    missing(id) {
      calls.push([id, 'missing']);
    },
  };
  try {
    const source = instrument(moduleSource, spec, 'dist/src/sample.js');
    const m = await import('data:text/javascript,' + encodeURIComponent(source));
    assert.equal(m.plain(2, 3), 5);
    assert.equal(await m.later(4), 8);
    assert.equal(m.arrow(5), -5);
    assert.throws(() => m.arrow(-1), /negative/);
    assert.equal(m.internal(1), 2, 'a call inside the module goes through the wrapper too');
    assert.equal(new m.Box().open('lid'), 'open:lid');
    assert.deepEqual(calls, [
      ['dist/src/sample.js#absent', 'missing'],
      ['dist/src/sample.js#Box.shut', 'missing'],
      ['dist/src/sample.js#plain', [2, 3], 5],
      ['dist/src/sample.js#later', [4], 'promise'],
      ['dist/src/sample.js#arrow', [5], -5],
      ['dist/src/sample.js#arrow', [-1], 'throws negative'],
      ['dist/src/sample.js#plain', [1, 1], 2],
      ['dist/src/sample.js#internal', [1], 2],
      ['dist/src/sample.js#Box.open', ['lid'], 'open:lid'],
    ]);
  } finally {
    delete globalThis.__amcpCallReplay;
  }
  // Without a recorder the wrappers are plain pass-throughs.
  const m = await import('data:text/javascript,' + encodeURIComponent(instrument(moduleSource, spec, 'x') + '//2'));
  assert.equal(m.plain(1, 1), 2);
});

test('only the compiled target modules are instrumented', () => {
  const root = path.resolve('.');
  assert.equal(targetOf(pathToFileURL(path.join(root, 'dist/src/scope.js')).href, root), 'dist/src/scope.js');
  assert.equal(targetOf(pathToFileURL(path.join(root, 'dist/src/service.js')).href, root), undefined);
  assert.equal(targetOf('node:fs', root), undefined);
  assert.equal(instrument('export const x = 1;', {}, 'dist/src/x.js'), 'export const x = 1;');
  for (const [id, entry] of Object.entries(targets)) {
    assert.match(id, /^dist\/(?:src|server)\/[a-z0-9-]+\.js$/);
    assert.ok((entry.functions?.length ?? 0) + Object.keys(entry.classes ?? {}).length, id);
  }
});

test('every target is a function or method of its compiled module; every replayable call is a target', async () => {
  // A target that moved away (googleGlobalRead left execution-risk.js for Google Ads' adapter) wrote a `missing`
  // record into every recording and a `missing` replay outcome; the recorder only wraps what this finds.
  const functions = new Set();
  for (const [id, entry] of Object.entries(targets)) {
    const source = fs.readFileSync(id, 'utf8'),
      loaded = await import(pathToFileURL(path.resolve(id)).href);
    for (const name of entry.functions ?? []) {
      functions.add(id + '#' + name);
      assert.doesNotMatch(
        instrument(source, {functions: [name]}, id),
        /__amcpCallReplay\?\.missing\(/,
        id + '#' + name,
      );
      assert.equal(typeof loaded[name], 'function', id + '#' + name);
    }
    for (const [cls, methods] of Object.entries(entry.classes ?? {}))
      for (const method of methods)
        assert.equal(typeof loaded[cls]?.prototype?.[method], 'function', id + '#' + cls + '.' + method);
  }
  for (const id of replayable) assert.ok(functions.has(id), id + ' is a target function');
  assert.ok(functions.has('dist/src/google-ads-adapter.js#googleGlobalRead'));
  assert.ok(!functions.has('dist/src/execution-risk.js#googleGlobalRead'));
});

test('recorded values are JSON-safe, secrets are digested and clock-derived values do not count', () => {
  const error = Object.assign(new Error('Per-tenant platform request budget exhausted.'), {
    code: 'TENANT_RATE_LIMIT',
    status: 429,
    retryable: true,
    details: {retry_after_ms: 109},
  });
  const value = encode({
    headers: {Authorization: 'Bearer TEST_CREDENTIAL_NOT_REAL', Accept: 'application/json'},
    credentials: {accessToken: 'TEST_CREDENTIAL_NOT_REAL', clientId: 'app'},
    body: 'grant_type=refresh_token&refresh_token=TEST_REFRESH&client_secret=TEST_SECRET',
    missing: undefined,
    bytes: Buffer.from('abc'),
    fn: function named() {},
    store: new (class Store {})(),
    deadline: 1234.5678,
    xReportDeadline: 76562,
    oauth: {verifier: 'Xg4RG83uK4sjxWO8AeocwWZJ', state: 'ENABLED'},
    error,
  });
  const text = JSON.stringify(value);
  for (const secret of ['TEST_CREDENTIAL_NOT_REAL', 'TEST_REFRESH', 'TEST_SECRET']) assert.ok(!text.includes(secret));
  assert.match(value.headers.Authorization, /^<secret:[0-9a-f]{16}>$/);
  assert.equal(value.headers.Accept, 'application/json');
  assert.equal(value.credentials.clientId, 'app');
  assert.deepEqual(value.missing, {$undefined: true});
  assert.deepEqual(value.bytes, {$bytes: 3, sha256: value.bytes.sha256});
  assert.deepEqual(value.fn, {$function: 'named'});
  assert.deepEqual(value.store, {$instance: 'Store'});
  assert.equal(value.deadline, '<clock>');
  assert.equal(value.xReportDeadline, '<clock>', 'a deadline is clock-relative, whole number or not');
  assert.deepEqual(value.oauth, {verifier: '<random>', state: 'ENABLED'}, 'only a random token is masked');
  assert.equal(value.error.code, 'TENANT_RATE_LIMIT');
  assert.equal(value.error.details.retry_after_ms, '<clock>', "the throttle's wait comes from the process clock");
  const provider = encode(Object.assign(new Error('x'), {code: 'PLATFORM_ERROR', details: {retry_after_ms: 30000}}));
  assert.equal(provider.details.retry_after_ms, 30000, "a provider's own delay stays compared");
  const quota = encode(
    Object.assign(new Error('x'), {code: 'PROVIDER_QUOTA_SHARE_EXHAUSTED', details: {retry_after_ms: 1}}),
  );
  assert.equal(quota.details.retry_after_ms, '<clock>', 'the daily reset is clock-relative');
  // Identical secrets digest identically, so a changed credential still shows as a difference.
  assert.equal(encode({accessToken: 'a'}).accessToken, encode({accessToken: 'a'}).accessToken);
  assert.notEqual(encode({accessToken: 'a'}).accessToken, encode({accessToken: 'b'}).accessToken);
  assert.deepEqual(revive(JSON.parse(JSON.stringify([{a: {$undefined: true}, b: 1}, {$undefined: true}]))), [
    {a: undefined, b: 1},
    undefined,
  ]);
});

test('normalization removes run-to-run noise only', () => {
  assert.equal(
    normalizeText(
      'id 0f8fad5b-d9cb-469f-a165-70867728950e at 2026-10-17T10:00:00.123Z ms 1760000000000 ' +
        'OAuth oauth_nonce="abc", oauth_timestamp="1760000000", oauth_signature="sig", oauth_token="kept"',
    ),
    'id <uuid> at <time> ms <epoch-ms> OAuth oauth_nonce="<oauth>", oauth_timestamp="<oauth>", oauth_signature="<oauth>", oauth_token="kept"',
  );
  // Account and object IDs are kept, longer digit runs included.
  assert.equal(
    normalizeText('act_123 7890123456789012345 customers/1234567890'),
    'act_123 7890123456789012345 customers/1234567890',
  );
  // A multipart boundary, a clock time without a zone, epoch seconds and PKCE values in a form body.
  assert.equal(
    normalizeText('boundary=amcp_82b33feb-776c-4ffc-ad54-df925aa10122 at 2026-10-17 10:00:00 t=1790000000'),
    'boundary=amcp_<uuid> at <time> t=<epoch-s>',
  );
  assert.equal(
    normalizeText('code=c&code_verifier=Xg4RG83&state=aHOlucxd&redirect_uri=x'),
    'code=c&code_verifier=<random>&state=<random>&redirect_uri=x',
  );
  assert.deepEqual(normalizeValue({at: 1760000000000, s: 1790000000, n: 42, id: 1234567890}), {
    at: '<epoch-ms>',
    s: '<epoch-s>',
    n: 42,
    id: 1234567890,
  });
});

test('two recordings compare equal only with the same calls and results per test file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'call-replay-'));
  try {
    const write = (name, records) =>
      fs.writeFileSync(path.join(directory, name), records.map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.mkdirSync(path.join(directory, 'a'));
    fs.mkdirSync(path.join(directory, 'b'));
    const call = review => ({
      id: 'dist/src/scope.js#ScopeGuard.authorize',
      in: [{path: '/v1/x', review}],
      out: {returns: '1'},
    });
    const allowed = call('0f8fad5b-d9cb-469f-a165-70867728950e');
    const refused = {...allowed, out: {throws: {$error: 'MirrorError', code: 'RESOURCE_SCOPE_REQUIRED'}}};
    write('a/dist_tests_x.test.js.11.calls.jsonl', [{...allowed, count: 2}]);
    // Another process of the same test file: the second call differs only by its random review ID.
    write('b/dist_tests_x.test.js.12.calls.jsonl', [allowed, call('7c9e6679-7425-40de-944b-e07fc1f90ae7')]);
    const same = compareRecordings(readRecording(path.join(directory, 'a')), readRecording(path.join(directory, 'b')));
    assert.deepEqual([same.tests, same.records_before, same.records_after, same.differences.length], [1, 2, 2, 0]);
    write('b/dist_tests_x.test.js.12.calls.jsonl', [allowed, refused]);
    const changed = compareRecordings(
      readRecording(path.join(directory, 'a')),
      readRecording(path.join(directory, 'b')),
    );
    // One allowed call became a refusal: the two records pair up by function and show where they differ.
    assert.deepEqual(
      changed.differences.map(d => [d.test, d.id, d.paths]),
      [['dist_tests_x.test.js', 'dist/src/scope.js#ScopeGuard.authorize', ['/out/returns', '/out/throws']]],
    );
    assert.equal(recordText({id: 'x', in: ['0f8fad5b-d9cb-469f-a165-70867728950e']}), '{"id":"x","in":["<uuid>"]}');
    // A failed test process is reported apart from the calls.
    write('b/dist_tests_x.test.js.12.calls.jsonl', [
      {id: '$exit', code: 1},
      {...allowed, count: 2},
    ]);
    const failed = compareRecordings(
      readRecording(path.join(directory, 'a')),
      readRecording(path.join(directory, 'b')),
    );
    assert.deepEqual(
      [failed.differences.length, failed.failed_before, failed.failed_after],
      [0, [], ['dist_tests_x.test.js']],
    );
  } finally {
    removeTestPath(directory);
  }
});

test('a calibration of two recordings of one build sets the noise a comparison may ignore, and nothing else', () => {
  const recording = records =>
    Object.assign(new Map([['dist_tests_x.test.js', new Map(records.map(r => [recordText(r), 1]))]]), {
      failed: new Set(),
    });
  const read = (token, out = {returns: '1'}) => ({
    id: 'dist/src/transport.js#NativeTransport.request',
    in: [{path: '/v1/x'}],
    out: {...out, fixture: token},
  });
  // The same build twice: a fixture's random token differs.
  const noise = noiseProfile(recording([read('r1')]), recording([read('r2')]));
  assert.deepEqual(
    [...noise.paths.values()].map(p => [...p]),
    [['/out/fixture']],
  );
  // Before and after the change: the token differs again, so it is noise; a refusal in place of a result is not.
  const same = compareRecordings(recording([read('r3')]), recording([read('r4')]), noise);
  assert.deepEqual([same.differences.length, same.noise], [0, {'dist/src/transport.js#NativeTransport.request': 1}]);
  const refused = compareRecordings(recording([read('r3')]), recording([read('r4', {throws: {code: 'X'}})]), noise);
  assert.deepEqual(refused.differences[0].paths, ['/out/fixture', '/out/returns', '/out/throws']);
  assert.deepEqual([...differingPaths({a: [1, {b: 2}]}, {a: [1, {b: 3}]})], ['/a/#/b']);
});

// Records of one test file, each [record, count], as readRecording returns them.
const recordingOf = (...entries) =>
  Object.assign(new Map([['dist_tests_x.test.js', new Map(entries.map(([r, n = 1]) => [recordText(r), n]))]]), {
    failed: new Set(),
  });
const request = (path, out = {returns: '1'}) => ({
  id: 'dist/src/transport.js#NativeTransport.request',
  in: [{path}],
  out,
});
const refusedWith = (path, code) => request(path, {throws: {$error: 'MirrorError', code}});

test('a function whose call count varied in the calibration is unsettled, never noise: a flip in it fails', () => {
  // The same build served /v1/a twice in one run and three times in the other (a test racing promises).
  const noise = noiseProfile(recordingOf([request('/v1/a'), 2]), recordingOf([request('/v1/a'), 3]));
  assert.deepEqual([...noise.counts], ['dist_tests_x.test.js\ndist/src/transport.js#NativeTransport.request']);
  // After the change one of those calls is refused. The count rule used to class it as noise, so the comparison passed.
  const flipped = compareRecordings(
    recordingOf([request('/v1/a'), 2]),
    recordingOf([request('/v1/a')], [refusedWith('/v1/a', 'RESOURCE_SCOPE_REQUIRED')]),
    noise,
  );
  assert.deepEqual([flipped.noise, flipped.differences.length], [{}, 0]);
  assert.deepEqual(
    flipped.unsettled.map(u => [u.reason, u.paths]),
    [['call_count_varied_in_calibration', ['/out/returns', '/out/throws']]],
  );
  // A different number of the same calls is unsettled as well: the calibration cannot tell it from noise either.
  const more = compareRecordings(recordingOf([request('/v1/a'), 2]), recordingOf([request('/v1/a'), 4]), noise);
  assert.deepEqual(
    [more.noise, more.differences.length, more.unsettled.map(u => u.reason)],
    [{}, 0, ['call_count_varied_in_calibration', 'call_count_varied_in_calibration']],
  );
  // The same recordings without that calibration: every one of those records is a plain difference.
  assert.equal(
    compareRecordings(recordingOf([request('/v1/a'), 2]), recordingOf([request('/v1/a'), 4])).differences.length,
    2,
  );
});

test('a flip where the calibration flipped too is unsettled, never noise', () => {
  // The same build allowed /v1/b in one run and refused it in the other: its paths are /out/returns and /out/throws.
  const noise = noiseProfile(
    recordingOf([request('/v1/b')]),
    recordingOf([refusedWith('/v1/b', 'RESOURCE_SCOPE_REQUIRED')]),
  );
  assert.deepEqual(
    [...noise.paths.values()].map(p => [...p].sort()),
    [['/out/returns', '/out/throws']],
  );
  assert.deepEqual([...noise.counts], []);
  const again = compareRecordings(
    recordingOf([request('/v1/b')]),
    recordingOf([refusedWith('/v1/b', 'RESOURCE_SCOPE_REQUIRED')]),
    noise,
  );
  assert.deepEqual(
    [again.noise, again.differences.length, again.unsettled.map(u => u.reason)],
    [{}, 0, ['outcome_flipped_in_calibration']],
  );
  // A difference at a path the calibration did differ at, with the outcome kind kept, is still noise.
  const kept = noiseProfile(
    recordingOf([request('/v1/b', {returns: 'r1'})]),
    recordingOf([request('/v1/b', {returns: 'r2'})]),
  );
  const same = compareRecordings(
    recordingOf([request('/v1/b', {returns: 'r3'})]),
    recordingOf([request('/v1/b', {returns: 'r4'})]),
    kept,
  );
  assert.deepEqual(
    [same.differences.length, same.unsettled.length, same.noise],
    [0, 0, {'dist/src/transport.js#NativeTransport.request': 1}],
  );
});

test('a named timing-dependent test file counts apart only its clock-decided refusals and repeated records', () => {
  const limited = path => refusedWith(path, 'TENANT_RATE_LIMIT'),
    sent = url => ({id: 'provider_request', in: {url, method: 'GET'}});
  assert.equal(recordingKey('tests/x.test.ts'), 'dist_tests_x.test.js');
  assert.equal(recordingKey('dist_tests_x.test.js'), 'dist_tests_x.test.js');
  assert.equal(recordingKey('tests/x.test.mjs'), 'tests_x.test.mjs');
  const timing = timingOption(['tests/x.test.ts=TENANT_RATE_LIMIT']);
  assert.deepEqual(timing, {'dist_tests_x.test.js': ['TENANT_RATE_LIMIT']});
  assert.throws(() => timingOption(['tests/x.test.ts=a=b']), /--timing-dependent/);
  assert.throws(() => timingOption(['=TENANT_RATE_LIMIT']), /--timing-dependent/);
  // The burst-pacing shape: of 80 concurrent requests the pacing budget served 62 in one run and 64 in the other.
  const before = recordingOf([request('/v1/c'), 62], [limited('/v1/c'), 18], [sent('https://x.test/v1/c'), 62]),
    after = recordingOf([request('/v1/c'), 64], [limited('/v1/c'), 16], [sent('https://x.test/v1/c'), 64]);
  assert.equal(compareRecordings(before, after).differences.length, 4, 'two flips and two more requests sent');
  const timed = compareRecordings(before, after, undefined, {timing});
  assert.deepEqual(
    [timed.differences.length, timed.unsettled.length, timed.timing_dependent],
    [0, 0, {'dist/src/transport.js#NativeTransport.request': 2, provider_request: 2}],
  );
  // In that file a refusal its clock does not decide still fails, and so does a request neither run of the build sent.
  const other = compareRecordings(
    before,
    recordingOf(
      [request('/v1/c'), 63],
      [refusedWith('/v1/c', 'RESOURCE_SCOPE_REQUIRED')],
      [limited('/v1/c'), 16],
      [sent('https://x.test/v1/c'), 64],
      [sent('https://x.test/v1/other')],
    ),
    undefined,
    {timing},
  );
  assert.deepEqual(other.timing_dependent, {'dist/src/transport.js#NativeTransport.request': 1, provider_request: 2});
  assert.deepEqual(other.differences.map(d => [d.id, d.paths ?? 'unpaired']).sort(), [
    ['dist/src/transport.js#NativeTransport.request', ['/out/throws/code']],
    ['provider_request', 'unpaired'],
  ]);
  // A file named without codes counts only its repeated records apart: the flips still fail.
  const counted = compareRecordings(before, after, undefined, {timing: timingOption(['tests/x.test.ts'])});
  assert.deepEqual([counted.differences.length, counted.timing_dependent], [2, {provider_request: 2}]);
});
