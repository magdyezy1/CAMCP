// ACC-02: the real AI-client interoperability matrix. The owner (or a named evaluator) connects each must-pass client
// of owner decision D14 to a staging deployment and records the 12 checks of docs/acceptance/CLIENT-INTEROP.md; this
// tool prints the blank record, runs the scripted synthetic checks, probes a staging origin's unauthenticated discovery,
// and validates a filled record. It never stores or prints a token.
// Usage:
//   node tools/acceptance/client-interop.mjs template                  a blank record for every must-pass client
//   node tools/acceptance/client-interop.mjs synthetic                 the scripted checks (needs npm run build)
//   node tools/acceptance/client-interop.mjs probe <staging-origin>    unauthenticated discovery of a staging origin;
//                                                                      needs AMCP_INTEROP_PROBE=true and refuses production
//   node tools/acceptance/client-interop.mjs check <record.json>       validate a filled record and print its summary
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
/** The must-pass AI clients of owner decision D14. */
export const mustPassClients = {
  claude_connector: 'Claude.ai and Claude Desktop connector',
  claude_code: 'Claude Code',
  chatgpt: 'ChatGPT',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
};
/**
 * The 12 checks of ACC-02, check 7 split by elapsed time. `synthetic` names the scripted test that covers the check for
 * every client profile, when one does; the real client is still checked by hand.
 */
export const interopChecks = [
  {id: '1', name: 'Discovery through the 401 challenge', synthetic: 'conformance'},
  {id: '2', name: 'Registration result and the registration count delta', synthetic: 'conformance'},
  {id: '3', name: 'Consent content, and a read-only downgrade', synthetic: null},
  {id: '4', name: 'Token exchange and tools/list', synthetic: 'conformance'},
  {id: '5', name: 'A viewer is refused writes', synthetic: 'conformance'},
  {id: '6', name: 'Operator inspect and prepare; execute only on a synthetic target', synthetic: null},
  {id: '7.1h', name: 'Refresh after 1 hour', synthetic: null},
  {id: '7.24h', name: 'Refresh after 24 hours, two sessions in parallel', synthetic: null},
  {id: '7.7d', name: 'Refresh after 7 idle days', synthetic: null},
  {id: '8', name: 'Revocation in both directions', synthetic: 'conformance'},
  {id: '9', name: 'The negotiated protocol version', synthetic: 'conformance'},
  {id: '10', name: 'Whether the client sends an Origin header', synthetic: null},
  {id: '11', name: 'How an error raised before MCP starts is shown', synthetic: null},
  {id: '12', name: 'Binding to one of several workspaces', synthetic: null},
];
export const syntheticTest = 'dist/tests/mcp-client-conformance.test.js';
const results = ['pass', 'fail', 'blocked', 'not_run'];
const reference = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,119}$/;
/** Text that must never be in a record: a bearer token, a JWT, a long opaque secret or a HAR file name. */
const secretText = text =>
  /bearer\s|eyJ[A-Za-z0-9_-]{10,}\.|\.har\b/i.test(text) ||
  // A long opaque run is a secret unless it is a hex digest (a commit or a SHA-256).
  (text.match(/[A-Za-z0-9_-]{40,}/g) ?? []).some(run => !/^[0-9a-f]+$/.test(run));

/** A blank record: every must-pass client with every check not run. */
export function interopTemplate() {
  return {
    schema_version: 1,
    ticket: 'ACC-02',
    release: {revision: 'REPLACE', package_sha256: 'REPLACE'},
    staging_origin: 'https://REPLACE',
    evaluator: 'REPLACE: the person who ran the sessions (owner decision D14 names who)',
    clients: Object.fromEntries(
      Object.keys(mustPassClients).map(id => [
        id,
        {
          client_version: 'REPLACE',
          checks: Object.fromEntries(
            interopChecks.map(c => [c.id, {result: 'not_run', date: null, evidence_ref: null, note: ''}]),
          ),
        },
      ]),
    ),
  };
}

/** Every problem with a filled record; an empty list means it is valid (not that every check passed). */
export function validateInteropRecord(record) {
  const problems = [];
  if (!record || record.schema_version !== 1 || record.ticket !== 'ACC-02') return ['the record is a ACC-02 record'];
  if (secretText(JSON.stringify(record))) problems.push('the record holds a token-like value; keep references only');
  if (
    !/^[0-9a-f]{7,40}$/.test(String(record.release?.revision)) ||
    !/^[0-9a-f]{64}$/.test(String(record.release?.package_sha256))
  )
    problems.push('release is the /versionz revision and package_sha256 of the staging build');
  let origin;
  try {
    origin = new URL(record.staging_origin);
  } catch {
    problems.push('staging_origin is the staging deployment origin');
  }
  if (origin && (origin.protocol !== 'https:' || productionHosts.includes(origin.hostname)))
    problems.push('staging_origin is an HTTPS staging origin, never production');
  if (typeof record.evaluator !== 'string' || !record.evaluator.trim() || /^REPLACE/.test(record.evaluator))
    problems.push('evaluator names who ran the sessions');
  for (const id of Object.keys(mustPassClients)) {
    const client = record.clients?.[id];
    if (!client) {
      problems.push(id + ': every must-pass client has a row');
      continue;
    }
    if (typeof client.client_version !== 'string' || !client.client_version || /^REPLACE/.test(client.client_version))
      problems.push(id + ': client_version is the version the session used');
    for (const check of interopChecks) {
      const row = client.checks?.[check.id],
        at = message => problems.push(id + ' check ' + check.id + ': ' + message);
      if (!row) {
        at('missing');
        continue;
      }
      if (!results.includes(row.result)) at('result is pass, fail, blocked or not_run');
      if (row.result === 'not_run') continue;
      if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) at('date is the day it ran');
      if (typeof row.evidence_ref !== 'string' || !reference.test(row.evidence_ref))
        at('evidence_ref names the log event, request ID or screenshot reference');
      if (row.result !== 'pass' && (typeof row.note !== 'string' || row.note.trim().length < 10))
        at('a failed or blocked check says why; a failing client becomes a defect ticket');
      if (typeof row.note === 'string' && (row.note.length > 300 || /[\r\n]/.test(row.note))) at('note is one line');
    }
    for (const key of Object.keys(client.checks ?? {}))
      if (!interopChecks.some(c => c.id === key)) problems.push(id + ': unknown check ' + key);
  }
  for (const key of Object.keys(record.clients ?? {}))
    if (!mustPassClients[key]) problems.push(key + ': not a must-pass client of D14');
  return problems;
}

/** Per client: how many checks passed, failed, were blocked or not run, and whether its matrix is complete. */
export function interopSummary(record) {
  return Object.keys(mustPassClients).map(id => {
    const checks = Object.values(record.clients?.[id]?.checks ?? {}),
      count = result => checks.filter(c => c.result === result).length;
    return {
      client: id,
      name: mustPassClients[id],
      pass: count('pass'),
      fail: count('fail'),
      blocked: count('blocked'),
      not_run: count('not_run'),
      complete: count('pass') === interopChecks.length,
    };
  });
}

/** Production origins the probe and the record refuse: acceptance runs on staging only. */
export const productionHosts = ['amcp.shop', 'www.amcp.shop'];
/**
 * Unauthenticated discovery of a staging origin: the protected-resource and authorization-server metadata, the 401
 * challenge of an unauthenticated initialize, and /versionz. Read-only, no token, no registration. It refuses
 * production and anything but HTTPS, and needs AMCP_INTEROP_PROBE=true.
 */
export async function probeStaging(originText, env = process.env, fetcher = fetch) {
  if (env.AMCP_INTEROP_PROBE !== 'true')
    return {status: 'refused', reason: 'Set AMCP_INTEROP_PROBE=true to probe a staging origin.', requests: 0};
  let origin;
  try {
    origin = new URL(originText);
  } catch {
    return {status: 'refused', reason: 'Name the staging origin, such as https://staging.example.com.', requests: 0};
  }
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.username)
    return {status: 'refused', reason: 'The staging origin is a bare HTTPS origin.', requests: 0};
  if (productionHosts.includes(origin.hostname))
    return {status: 'refused', reason: 'ACC-02 runs on staging, never on the production origin.', requests: 0};
  let requests = 0;
  const get = async (pathname, init = {}) => {
    requests++;
    const response = await fetcher(new URL(pathname, origin), {redirect: 'error', ...init});
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {status: response.status, headers: response.headers, body};
  };
  const prm = await get('/.well-known/oauth-protected-resource/mcp'),
    as = await get('/.well-known/oauth-authorization-server'),
    challenge = await get('/mcp', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'},
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'acc-02-probe', version: '1'}},
      }),
    }),
    version = await get('/versionz');
  const authenticate = challenge.headers.get('www-authenticate') ?? '';
  const checks = {
    protected_resource: prm.status === 200 && prm.body?.resource === new URL('/mcp', origin).href,
    authorization_server:
      as.status === 200 && Array.isArray(prm.body?.authorization_servers)
        ? prm.body.authorization_servers.includes(as.body?.issuer)
        : false,
    pkce_s256_only:
      Array.isArray(as.body?.code_challenge_methods_supported) &&
      as.body.code_challenge_methods_supported.join() === 'S256',
    challenge_401: challenge.status === 401 && /resource_metadata=/.test(authenticate),
    release_identity: version.status === 200 && version.body?.status === 'matches_build',
  };
  return {
    status: Object.values(checks).every(Boolean) ? 'discovery_ok' : 'discovery_problem',
    origin: origin.origin,
    checks,
    release: version.body?.build
      ? {revision: version.body.build.source_revision ?? null, package_sha256: version.body.build.sha256 ?? null}
      : null,
    requests,
    meaning:
      'Unauthenticated discovery only: the 12 checks need each real client connected by hand on this staging origin.',
  };
}

async function main(argv) {
  const [command, argument] = argv;
  if (command === 'template') {
    console.log(JSON.stringify(interopTemplate(), null, 2));
    return;
  }
  if (command === 'synthetic') {
    const file = path.join(root, syntheticTest);
    if (!fs.existsSync(file)) throw Error('Run npm run build first: ' + syntheticTest + ' is missing.');
    const run = spawnSync(process.execPath, ['--test', file], {encoding: 'utf8', cwd: root});
    console.log(
      JSON.stringify(
        {
          test: syntheticTest,
          passed: run.status === 0,
          profiles: Object.values(mustPassClients),
          covers: interopChecks.filter(c => c.synthetic).map(c => c.id),
          manual_only: interopChecks.filter(c => !c.synthetic).map(c => c.id),
          meaning:
            'Synthetic stand-ins of each client profile against an in-process server. They do not certify a real client.',
        },
        null,
        2,
      ),
    );
    if (run.status !== 0) {
      console.error(
        run.stdout
          .split('\n')
          .filter(l => /✖|not ok/.test(l))
          .join('\n'),
      );
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'probe') {
    const out = await probeStaging(argument);
    console.log(JSON.stringify(out, null, 2));
    if (out.status !== 'discovery_ok') process.exitCode = 1;
    return;
  }
  if (command === 'check') {
    if (!argument) throw Error('Name the filled record: node tools/acceptance/client-interop.mjs check <record.json>');
    const record = JSON.parse(fs.readFileSync(argument, 'utf8')),
      problems = validateInteropRecord(record);
    console.log(JSON.stringify({valid: !problems.length, problems, summary: interopSummary(record)}, null, 2));
    if (problems.length) process.exitCode = 1;
    return;
  }
  throw Error(
    'Usage: node tools/acceptance/client-interop.mjs template | synthetic | probe <origin> | check <record.json>',
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(e => {
    console.error(e.message);
    process.exitCode = 1;
  });
