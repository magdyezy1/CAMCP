// ACC-02: the real AI-client interoperability matrix had no record for any must-pass client (D14). The harness prints
// the 12-check record per client, validates a filled one (references only, staging only, a reason for every failure),
// and probes a staging origin's unauthenticated discovery only with an explicit flag, refusing production. The
// scripted per-profile checks are tests/mcp-client-conformance.test.ts; real clients stay a manual check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {
  interopChecks,
  interopSummary,
  interopTemplate,
  mustPassClients,
  probeStaging,
  syntheticTest,
  validateInteropRecord,
} from '../tools/acceptance/client-interop.mjs';

const filled = (result = 'pass') => {
  const record = interopTemplate();
  record.release = {revision: '5054822', package_sha256: 'c'.repeat(64)};
  record.staging_origin = 'https://staging.example.test';
  record.evaluator = 'Workspace owner';
  for (const client of Object.values(record.clients)) {
    client.client_version = '1.2.3';
    for (const check of Object.values(client.checks))
      Object.assign(check, {result, date: '2026-10-20', evidence_ref: 'mcp_refused/req-123', note: ''});
  }
  return record;
};

test('the record covers every must-pass client of D14 with the 12 checks, check 7 at 1 hour, 24 hours and 7 days', () => {
  assert.deepEqual(Object.values(mustPassClients), [
    'Claude.ai and Claude Desktop connector',
    'Claude Code',
    'ChatGPT',
    'Codex',
    'Cursor',
    'VS Code',
  ]);
  assert.deepEqual(
    interopChecks.map(c => c.id),
    ['1', '2', '3', '4', '5', '6', '7.1h', '7.24h', '7.7d', '8', '9', '10', '11', '12'],
  );
  const template = interopTemplate();
  assert.deepEqual(Object.keys(template.clients), Object.keys(mustPassClients));
  for (const client of Object.values(template.clients))
    assert.ok(Object.values(client.checks).every(c => c.result === 'not_run'));
  // A blank record names what is still to be filled in, and claims nothing.
  const problems = validateInteropRecord(template);
  assert.ok(problems.some(p => /release is/.test(p)));
  assert.ok(problems.some(p => /evaluator/.test(p)));
  assert.ok(interopSummary(template).every(s => s.not_run === interopChecks.length && !s.complete));
  // The scripted per-profile checks exist and cover the checks they claim.
  assert.ok(fs.existsSync(syntheticTest));
  const conformance = fs.readFileSync('tests/mcp-client-conformance.test.ts', 'utf8');
  for (const name of Object.values(mustPassClients)) assert.ok(conformance.includes("name: '" + name + "'"), name);
});

test('a filled record validates only with references, staging, its release and a reason for every failure', () => {
  assert.deepEqual(validateInteropRecord(filled()), []);
  assert.ok(interopSummary(filled()).every(s => s.complete && s.pass === interopChecks.length));
  const cases = [
    ['a bearer token in a note', r => (r.clients.cursor.checks['4'].note = 'Bearer abc.def'), /token-like/],
    ['a JWT', r => (r.clients.codex.checks['4'].evidence_ref = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx.x'), /token-like/],
    [
      'an opaque token',
      r => (r.clients.claude_code.checks['7.1h'].note = 'refreshed ya29.' + 'A1b'.repeat(20)),
      /token-like/,
    ],
    ['production', r => (r.staging_origin = 'https://amcp.shop'), /never production/],
    ['plain HTTP', r => (r.staging_origin = 'http://staging.example.test'), /HTTPS staging/],
    ['a failure without a reason', r => (r.clients.chatgpt.checks['2'].result = 'fail'), /says why/],
    ['no evidence', r => (r.clients.vscode.checks['9'].evidence_ref = null), /evidence_ref/],
    ['a missing client', r => delete r.clients.claude_code, /claude_code: every must-pass client/],
    ['an unknown client', r => (r.clients.other = r.clients.cursor), /not a must-pass client/],
    ['an unknown check', r => (r.clients.cursor.checks['13'] = {result: 'pass'}), /unknown check 13/],
  ];
  for (const [label, change, pattern] of cases) {
    const record = filled();
    change(record);
    assert.ok(
      validateInteropRecord(record).some(p => pattern.test(p)),
      label + ': ' + validateInteropRecord(record).join('; '),
    );
  }
  const failing = filled();
  Object.assign(failing.clients.cursor.checks['2'], {result: 'fail', note: 'A custom-scheme redirect was refused.'});
  assert.deepEqual(validateInteropRecord(failing), []);
  assert.equal(interopSummary(failing).find(s => s.client === 'cursor').complete, false);
});

test('the staging probe sends nothing without its flag, and refuses production, plain HTTP and paths', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return Response.json({});
  };
  for (const [origin, env, reason] of [
    ['https://staging.example.test', {}, /AMCP_INTEROP_PROBE=true/],
    ['https://amcp.shop', {AMCP_INTEROP_PROBE: 'true'}, /never on the production origin/],
    ['http://staging.example.test', {AMCP_INTEROP_PROBE: 'true'}, /bare HTTPS origin/],
    ['https://staging.example.test/mcp', {AMCP_INTEROP_PROBE: 'true'}, /bare HTTPS origin/],
    ['not an origin', {AMCP_INTEROP_PROBE: 'true'}, /Name the staging origin/],
  ]) {
    const out = await probeStaging(origin, env, fetcher);
    assert.equal(out.status, 'refused', origin);
    assert.match(out.reason, reason);
    assert.equal(out.requests, 0);
  }
  assert.equal(calls, 0);
  // The CLI without the flag refuses too.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'AMCP_INTEROP_PROBE'));
  const cli = spawnSync(
    process.execPath,
    ['tools/acceptance/client-interop.mjs', 'probe', 'https://staging.example.test'],
    {
      encoding: 'utf8',
      env,
    },
  );
  assert.equal(cli.status, 1);
  assert.equal(JSON.parse(cli.stdout).status, 'refused');
});

test('the staging probe reads only unauthenticated discovery of an in-process AMCP and finds its challenge', async t => {
  const origin = 'https://staging.example.test',
    master = Buffer.alloc(32, 92).toString('base64'),
    store = new Store(':memory:', master),
    listener = await listenForFetch(
      createHttpApp(new MirrorService(new Registry(), store), store, {
        publicOrigin: origin,
        website: {
          origin,
          masterKey: master,
          adminPassword: 'synthetic-interop-admin-password',
          fetcher: async () => {
            throw Error('No provider traffic allowed');
          },
        },
        log: () => {},
      }),
    );
  t.after(async () => {
    const closing = new Promise(r => listener.close(() => r()));
    listener.closeAllConnections();
    await closing;
    store.close();
  });
  const base = 'http://127.0.0.1:' + listener.address().port,
    seen = [];
  const fetcher = (url, init) => {
    const href = String(url);
    assert.ok(href.startsWith(origin + '/'), href);
    seen.push([init?.method ?? 'GET', new URL(href).pathname, init?.headers?.Authorization ?? null]);
    return fetch(base + href.slice(origin.length), {...init, redirect: 'manual'});
  };
  const out = await probeStaging(origin, {AMCP_INTEROP_PROBE: 'true'}, fetcher);
  assert.equal(out.checks.protected_resource, true, JSON.stringify(out));
  assert.equal(out.checks.authorization_server, true, JSON.stringify(out));
  assert.equal(out.checks.challenge_401, true, JSON.stringify(out));
  assert.equal(out.requests, 4);
  // Read-only and anonymous: no token, no registration, no consent.
  assert.deepEqual(
    seen.map(([method, path]) => method + ' ' + path),
    [
      'GET /.well-known/oauth-protected-resource/mcp',
      'GET /.well-known/oauth-authorization-server',
      'POST /mcp',
      'GET /versionz',
    ],
  );
  assert.ok(seen.every(([, , authorization]) => authorization === null));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM amcp_mcp_clients').get().n, 0);
});
