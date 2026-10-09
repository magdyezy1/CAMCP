// PRV-02: the LinkedIn-Version is a member of a reviewed window, not a free YYYYMM parameter. Before this change any
// 20YYMM was sent (202401 and 209912 were accepted), the evidence and discovery reported 202605 while 202609 was sent,
// .env.example pinned 202605, and a LinkedIn 426 was a generic upstream error.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  linkedinDefaultVersion,
  linkedinStoredVersion,
  linkedinVersion,
  linkedinVersionStatus,
  linkedinVersions,
  linkedinSunsetTime,
} from '../src/linkedin-version.js';
import {Registry} from '../src/catalog.js';
import {Compiler} from '../src/compiler.js';
import {Introspection} from '../src/introspection.js';
import {MirrorService, strictOptions} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {Store} from '../src/store.js';
import {executionEvidence} from '../src/contract-evidence.js';
import {providerSunset} from '../src/provider-sunsets.js';
import {metaApiVersions} from '../src/meta-version.js';
import {createRuntime} from '../server/runtime.js';
import {MirrorError} from '../src/errors.js';
import type {Actor, Connection} from '../src/types.js';

const registry = new Registry(),
  at = (day: string) => Date.parse(day + 'T12:00:00Z'),
  refused = (code: string) => (e: unknown) => e instanceof MirrorError && e.code === code;

test('only reviewed LinkedIn versions before their sunset are sent; malformed values keep their format refusal', () => {
  assert.equal(linkedinVersion(), linkedinDefaultVersion);
  assert.equal(linkedinVersion('202609', at('2026-10-09')), '202609');
  for (const value of ['202001', '209912', '202509', '202510', '202605', '202608'])
    assert.throws(() => linkedinVersion(value, at('2026-10-09')), refused('API_VERSION_UNREVIEWED'), value);
  for (const value of ['2026-09', '20269', 202609, '202613'])
    assert.throws(() => linkedinVersion(value), refused('INVALID_API_VERSION'), String(value));
  const error = (() => {
    try {
      linkedinVersion('202605');
    } catch (e) {
      return e as MirrorError;
    }
  })()!;
  assert.equal(error.details.default_version, '202609');
  assert.deepEqual(error.details.reviewed_versions, ['202609']);
  // The reviewed default itself stops at its recorded sunset (the injected clock).
  assert.equal(linkedinVersion(undefined, at('2027-08-31')), '202609');
  assert.throws(() => linkedinVersion(undefined, at('2027-09-01')), refused('API_VERSION_SUNSET'));
  const previous = process.env.AMCP_LINKEDIN_API_VERSION;
  process.env.AMCP_LINKEDIN_API_VERSION = '202605';
  try {
    assert.throws(() => linkedinVersion(), refused('API_VERSION_UNREVIEWED'));
  } finally {
    if (previous === undefined) delete process.env.AMCP_LINKEDIN_API_VERSION;
    else process.env.AMCP_LINKEDIN_API_VERSION = previous;
  }
});

test('a stored version moves to the current one when unreviewed, sunset or inside its alarm window', () => {
  assert.equal(linkedinStoredVersion('202609', at('2026-10-09')), '202609');
  // 202510 sunsets on 2026-10-15: a saved report captured at it is read at the current version afterwards.
  assert.equal(linkedinStoredVersion('202510', at('2026-10-16')), '202609');
  assert.equal(linkedinStoredVersion('202605', at('2026-10-09')), '202609');
  assert.equal(linkedinStoredVersion(undefined, at('2026-10-09')), '202609');
  // Inside the 90-day alarm window the current version is used (here still 202609); after its sunset nothing is sent.
  assert.equal(linkedinStoredVersion('202609', at('2027-07-01')), '202609');
  assert.throws(() => linkedinStoredVersion('202609', at('2027-09-02')), refused('API_VERSION_SUNSET'));
});

const actor: Actor = {tenantId: 'li-version', userId: 'reader', role: 'reader'};
function service() {
  const store = new Store(':memory:', Buffer.alloc(32, 41).toString('base64')),
    calls: {url: string; headers: Headers}[] = [];
  const connection: Connection = {
    id: 'li',
    tenantId: actor.tenantId,
    gateway: 'linkedin_native_action',
    accounts: ['123'],
    enabled: true,
    label: 'Synthetic LinkedIn',
    scopes: ['r_ads'],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const transport = new NativeTransport((async (url, init) => {
    calls.push({url: String(url), headers: new Headers(init?.headers)});
    return Response.json({id: 123, name: 'Synthetic', currency: 'USD', status: 'ACTIVE'});
  }) as typeof fetch);
  return {store, calls, service: new MirrorService(registry, store, transport)};
}
const read = {action: 'linkedin_rest_ad_accounts_ad_account_id_get', path_params: {ad_account_id: '123'}};

test('a call naming an unreviewed version is refused before any request; evidence reports the header sent', async () => {
  const f = service();
  try {
    for (const api_version of ['202401', '209912', '202605']) {
      const out = await f.service.call('linkedin_native_action', {...read, api_version, dry_run: false}, actor);
      assert.equal(out.success, false);
      assert.equal(out.error.code, 'API_VERSION_UNREVIEWED', api_version);
    }
    assert.equal(f.calls.length, 0);
    const ok = await f.service.call('linkedin_native_action', {...read, dry_run: false}, actor);
    assert.equal(ok.success, true, JSON.stringify(ok));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.headers.get('LinkedIn-Version'), '202609');
  } finally {
    f.store.close();
  }
  const plan = new Compiler(registry).compile('linkedin_native_action', read, strictOptions);
  assert.equal(plan.headers['LinkedIn-Version'], '202609');
  const evidence = executionEvidence(plan),
    reference = executionEvidence(plan, 'ref');
  assert.equal(evidence.provider.api_version, plan.headers['LinkedIn-Version']);
  assert.equal(reference.provider.api_version, plan.headers['LinkedIn-Version']);
  assert.equal(evidence.provider.version_end.version, plan.headers['LinkedIn-Version']);
});

test('LIST_ACTIONS, DESCRIBE_ACTION, operation help and the tool description report the version sent', () => {
  const introspection = new Introspection(registry),
    gateway = 'linkedin_native_action';
  assert.equal(registry.data.catalogs.find(c => c.gateway === gateway)!.api_version, '202605', 'captured evidence');
  const listed = introspection.list(gateway, {action: 'LIST_ACTIONS', limit: 5}, strictOptions);
  assert.equal(listed.api_version, '202609');
  for (const key of Object.keys(registry.data.descriptions).filter(k => k.startsWith(gateway + '/'))) {
    const name = key.slice(gateway.length + 1);
    assert.equal(registry.data.descriptions[key]!.api_version, '202605', 'captured description stays unchanged');
    assert.equal(introspection.describe(gateway, {target_action: name}).api_version, '202609');
    assert.equal(registry.help({gateway, operation: name}, strictOptions).api_version, '202609');
  }
  assert.equal(introspection.describe(gateway, {target_action: read.action}).api_version, '202609');
  const tool = registry.listTools(strictOptions).find(t => t.name === gateway)!;
  assert.match(tool.description, /li-lms-2026-05 documentation snapshot \(AMCP sends LinkedIn-Version 202609\)/);
  assert.match(tool.inputSchema.properties.api_version.description, /reviewed is accepted \(202609\)/);
  assert.doesNotMatch(JSON.stringify(registry.help({gateway}, strictOptions)), /202605/);
});

test('startup refuses an unreviewed AMCP_LINKEDIN_API_VERSION before opening any store', () => {
  const previous = process.env.AMCP_LINKEDIN_API_VERSION;
  try {
    for (const value of ['202605', '209912', 'latest']) {
      process.env.AMCP_LINKEDIN_API_VERSION = value;
      assert.throws(() => createRuntime(), /AMCP_LINKEDIN_API_VERSION is not a reviewed provider version/, value);
    }
  } finally {
    if (previous === undefined) delete process.env.AMCP_LINKEDIN_API_VERSION;
    else process.env.AMCP_LINKEDIN_API_VERSION = previous;
  }
});

test('.env.example pins no provider version older than, or outside, what the code reviews', () => {
  // Fails on the pre-fix file, which set AMCP_LINKEDIN_API_VERSION=202605 uncommented.
  const lines = fs.readFileSync('.env.example', 'utf8').split(/\r?\n/);
  const value = (name: string) => lines.find(line => line.startsWith(name + '='))?.slice(name.length + 1) || undefined;
  const linkedin = value('AMCP_LINKEDIN_API_VERSION');
  if (linkedin !== undefined) {
    assert.ok(
      linkedinVersions.some(v => v.version === linkedin),
      'LinkedIn version ' + linkedin + ' is not reviewed',
    );
    assert.ok(Number(linkedin) >= Number(linkedinDefaultVersion), 'LinkedIn version older than the default');
  }
  const meta = value('AMCP_META_API_VERSION');
  if (meta !== undefined) assert.equal(meta, metaApiVersions.at(-1), 'Meta version older than the default');
  assert.match(lines.join('\n'), /^# AMCP_LINKEDIN_API_VERSION=202609$/m);
});

test('owner health flags an override and the sunset registry agrees with the version table', () => {
  const now = at('2026-10-09'),
    clean = linkedinVersionStatus(now, undefined);
  assert.equal(clean.version, '202609');
  assert.equal(clean.linkedin_version_override, null);
  assert.equal(clean.alarm, false);
  const pinned = linkedinVersionStatus(now, '202605');
  assert.equal(pinned.linkedin_version_override, '202605');
  assert.equal(pinned.problem, 'API_VERSION_UNREVIEWED');
  assert.equal(pinned.version, null);
  assert.equal(pinned.alarm, true);
  assert.equal(linkedinVersionStatus(at('2027-07-01'), undefined).alarm, true, 'inside the 90-day window');
  const entry = linkedinVersions.find(v => v.version === linkedinDefaultVersion)!,
    recorded = providerSunset('linkedin')!;
  assert.equal(recorded.version, entry.version);
  assert.equal(recorded.sunset, entry.sunset);
  assert.ok(Number.isFinite(linkedinSunsetTime(entry)));
});

test('a LinkedIn 426 is a version refusal naming the version sent and the reviewed default', async () => {
  let calls = 0;
  const transport = new NativeTransport((async () => {
    calls++;
    return Response.json(
      {status: 426, code: 'NONEXISTENT_VERSION', message: 'Requested version is not active'},
      {
        status: 426,
        headers: {'x-li-uuid': 'AAYzLi-uuid', 'x-li-fabric': 'prod-lva1'},
      },
    );
  }) as typeof fetch);
  const plan = new Compiler(registry).compile('linkedin_native_action', read, strictOptions),
    connection: Connection = {
      id: 'li',
      tenantId: 't',
      gateway: 'linkedin_native_action',
      accounts: ['123'],
      enabled: true,
      label: 'x',
      scopes: [],
    };
  const error = await transport.request(plan, connection, {accessToken: 'synthetic'}).then(
    () => assert.fail('expected a refusal'),
    (e: MirrorError) => e,
  );
  assert.equal(error.code, 'PROVIDER_VERSION_UNSUPPORTED');
  assert.equal(error.details.api_version_sent, '202609');
  assert.equal(error.details.default_version, '202609');
  assert.equal(error.details.request_id, 'AAYzLi-uuid');
  assert.equal(error.details.provider_fabric, 'prod-lva1');
  assert.equal(error.retryable, false);
  assert.equal(calls, 1);
});
