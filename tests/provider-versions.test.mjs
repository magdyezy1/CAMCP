import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {isProviderModule, providerRegistries, runtimeGraph} from '../tools/architecture-map.mjs';
import {providerHooks, providerVersions, registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {providerAdapters, providerById} from '../dist/src/provider-adapters.js';
import * as linkedin from '../dist/src/linkedin-version.js';
import * as google from '../dist/src/google-version.js';
import * as meta from '../dist/src/meta-version.js';
import * as criteo from '../dist/src/criteo-version.js';
import {googleLegacyCoverage} from '../dist/src/google-legacy.js';
import {ga4TestProperties, saveGa4TestProperty} from '../dist/src/measurement-test-properties.js';
import {microsoftGateway} from '../dist/src/microsoft-native.js';
import {microsoftReportSubmit} from '../dist/src/effect-class.js';
import {providerContracts} from '../dist/src/provider-contracts.js';
import {acceptedVersions, sentVersion} from '../dist/src/provider-sunsets.js';
import {delegatedWriteGateways, withoutExecutableActions} from '../dist/src/tool-notes.js';

// ARC-01, wave 4c round 6 (w4c-arc6-versions): the API version each provider sends is one typed fact of its adapter
// (ProviderHooks.versions, src/<provider>-adapter.ts), which shared modules ask through providerVersions
// (src/provider-hooks.ts) instead of importing a provider's version module. These cases pin every answer through the
// registry against the version module's own export, with the same environment reading; tests/tool-surface-golden.test.mjs
// pins the tool notes, listings, introspection and provider contracts built from them, byte for byte.

const outcome = f => {
  try {
    return {returns: f()};
  } catch (e) {
    return {throws: {name: e.name, code: e.code, message: e.message, details: e.details}};
  }
};
const restoring = (name, f) => {
  const original = process.env[name];
  try {
    return f();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
};

test('each version answer the registry gives is its provider version module’s own export', () => {
  const g = providerVersions('google'),
    m = providerVersions('meta'),
    l = providerVersions('linkedin'),
    c = providerVersions('criteo');
  // Google Ads: v25, its REST paths and the developer token warning (src/google-version.ts).
  assert.equal(g.current(), google.googleAdsVersion);
  assert.equal(g.current(), 'v25');
  assert.equal(g.path, google.googleAdsPath);
  // The prefix src/media-upload.ts reads as googleAdsCustomers.
  assert.equal(g.path('/customers/'), google.googleAdsCustomers);
  assert.equal(g.path('/customers/1/googleAds:search'), '/v25/customers/1/googleAds:search');
  assert.equal(g.warning, google.googleDeveloperTokenWarning);
  const token = {AMCP_GOOGLE_DEVELOPER_TOKEN: 'synthetic-developer-token'};
  assert.equal(g.warning({}), undefined);
  assert.equal(g.warning(token), google.googleDeveloperTokenWarning(token));
  assert.match(g.warning(token), /^AMCP_GOOGLE_DEVELOPER_TOKEN is set, but Google sunset developer tokens/);
  // Meta: the Graph API version read at load (src/meta-version.ts) and the versions that setting may name.
  assert.equal(m.current(), meta.metaApiVersion);
  // The prefix src/catalog-comparison.ts and src/media-upload.ts read as metaPrefix.
  assert.equal(m.path('/'), meta.metaPrefix);
  for (const rest of ['me', 'act_1/campaigns', 'act_1/adimages'])
    assert.equal(m.path('/' + rest), meta.metaPrefix + rest);
  assert.equal(m.configurable, meta.metaApiVersions);
  assert.deepEqual(m.configurable, ['v25.0', 'v26.0']);
  // LinkedIn: each answer is src/linkedin-version.ts's own function, so it reads the environment at each call as before.
  assert.equal(l.current, linkedin.linkedinDescribedVersion);
  // What src/conditional-programs.ts, src/media-upload.ts and src/overview-parents.ts read as linkedinVersion.
  assert.equal(l.request, linkedin.linkedinVersion);
  // What src/allocation-plan.ts reads as linkedinStoredVersion.
  assert.equal(l.stored, linkedin.linkedinStoredVersion);
  assert.equal(l.reviewed, linkedin.linkedinVersions);
  assert.equal(l.status, linkedin.linkedinVersionStatus);
  assert.equal(l.header, 'LinkedIn-Version');
  // Criteo: the Retail Media version and its guides (src/criteo-version.ts).
  assert.equal(c.current(), criteo.criteoApiVersion);
  assert.equal(c.current(), '2026-07');
  assert.equal(c.docs, criteo.criteoDocs);
  assert.equal(c.docs('performance-report'), 'https://developers.criteo.com/retail-media/docs/performance-report');
});

test('LinkedIn’s answers read AMCP_LINKEDIN_API_VERSION at each call, exactly as its module’s do', () => {
  const l = providerVersions('linkedin'),
    // Today; inside the 90-day alarm window of 202609 (sunset 2027-09 by LinkedIn's one-year policy); at its sunset.
    nows = ['2026-10-30T12:00:00Z', '2027-07-01T00:00:00Z', '2027-09-01T00:00:00Z'].map(Date.parse);
  const answers = (v, now) => ({
    current: outcome(() => v.current(now)),
    request: outcome(() => v.request(undefined, now)),
    explicit: ['202609', '202605', '2026-09', 202609, null].map(value => outcome(() => v.request(value, now))),
    stored: ['202609', '202605', undefined, 7].map(value => outcome(() => v.stored(value, now))),
    status: outcome(() => v.status(now)),
    configured: ['202609', '202605', 'x'].map(value => outcome(() => v.status(now, value))),
  });
  const module = {
    current: linkedin.linkedinDescribedVersion,
    request: linkedin.linkedinVersion,
    stored: linkedin.linkedinStoredVersion,
    status: linkedin.linkedinVersionStatus,
  };
  const seen = {};
  restoring('AMCP_LINKEDIN_API_VERSION', () => {
    for (const setting of [undefined, '202609', '202605', 'not-a-version', ''])
      for (const now of nows) {
        if (setting === undefined) delete process.env.AMCP_LINKEDIN_API_VERSION;
        else process.env.AMCP_LINKEDIN_API_VERSION = setting;
        const through = answers(l, now);
        assert.deepEqual(through, answers(module, now), String(setting) + ' ' + now);
        seen[String(setting) + ' ' + now] = through;
      }
  });
  const [today, alarm, sunset] = nows;
  // Unset: the reviewed default, sent and described; no override and no alarm until the window.
  assert.deepEqual(seen['undefined ' + today].request, {returns: '202609'});
  assert.equal(seen['undefined ' + today].status.returns.linkedin_version_override, null);
  assert.equal(seen['undefined ' + today].status.returns.alarm, false);
  assert.equal(seen['undefined ' + alarm].status.returns.alarm, true);
  // A stored reviewed version inside the window is sent at the current version, read from the setting.
  assert.deepEqual(seen['undefined ' + today].stored[0], {returns: '202609'});
  assert.equal(seen['202605 ' + alarm].stored[0].throws.code, 'API_VERSION_UNREVIEWED');
  assert.deepEqual(seen['202605 ' + today].stored[0], {returns: '202609'});
  // An unreviewed or invalid setting refuses each request with its reason; describing never throws.
  assert.equal(seen['202605 ' + today].request.throws.code, 'API_VERSION_UNREVIEWED');
  assert.deepEqual(seen['202605 ' + today].request.throws.details, {
    api_version: '202605',
    default_version: '202609',
    reviewed_versions: ['202609'],
  });
  assert.equal(seen['202605 ' + today].status.returns.problem, 'API_VERSION_UNREVIEWED');
  assert.equal(seen['202605 ' + today].status.returns.linkedin_version_override, '202605');
  assert.equal(seen['not-a-version ' + today].request.throws.code, 'INVALID_API_VERSION');
  for (const setting of ['202605', 'not-a-version'])
    assert.deepEqual(seen[setting + ' ' + today].current, {returns: '202609'}, setting);
  // At the sunset the default itself is refused, and still described.
  assert.equal(seen['undefined ' + sunset].request.throws.code, 'API_VERSION_SUNSET');
  assert.deepEqual(seen['undefined ' + sunset].current, {returns: '202609'});
});

// Run in a child process: Meta's version is read once, when src/meta-version.ts loads.
const dist = file => JSON.stringify(new URL('../dist/src/' + file, import.meta.url).href);
const child = `
const {providerVersions} = await import(${dist('provider-hooks.js')});
const meta = await import(${dist('meta-version.js')});
const google = await import(${dist('google-version.js')});
const linkedin = await import(${dist('linkedin-version.js')});
const outcome = f => {
  try {
    return {returns: f()};
  } catch (e) {
    return {throws: {code: e.code, message: e.message, details: e.details}};
  }
};
const now = Date.parse('2026-10-30T12:00:00Z'),
  m = providerVersions('meta'),
  g = providerVersions('google'),
  l = providerVersions('linkedin');
console.log(JSON.stringify({
  registry: {
    meta: [m.current(), m.path('/'), m.path('/act_1/campaigns')],
    google: [g.current(), g.warning() ?? null],
    linkedin: [l.current(now), outcome(() => l.request(undefined, now)), outcome(() => l.stored('202605', now)), l.status(now)],
  },
  module: {
    meta: [meta.metaApiVersion, meta.metaPrefix, meta.metaPrefix + 'act_1/campaigns'],
    google: [google.googleAdsVersion, google.googleDeveloperTokenWarning() ?? null],
    linkedin: [
      linkedin.linkedinDescribedVersion(now),
      outcome(() => linkedin.linkedinVersion(undefined, now)),
      outcome(() => linkedin.linkedinStoredVersion('202605', now)),
      linkedin.linkedinVersionStatus(now),
    ],
  },
}));
`;
function inChild(settings) {
  const env = {...process.env};
  for (const name of ['AMCP_META_API_VERSION', 'AMCP_GOOGLE_DEVELOPER_TOKEN', 'AMCP_LINKEDIN_API_VERSION'])
    delete env[name];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: process.cwd(),
    env: {...env, ...settings},
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('the deployment’s version settings reach the registry’s answers as they reach the modules’', () => {
  const rollback = inChild({
    AMCP_META_API_VERSION: 'v25.0',
    AMCP_GOOGLE_DEVELOPER_TOKEN: 'synthetic-developer-token',
    AMCP_LINKEDIN_API_VERSION: '202605',
  });
  assert.deepEqual(rollback.registry, rollback.module);
  // The Meta rollback moves every path; the Google token earns its warning; LinkedIn refuses an unreviewed setting.
  assert.deepEqual(rollback.registry.meta, ['v25.0', '/v25.0/', '/v25.0/act_1/campaigns']);
  assert.match(rollback.registry.google[1], /^AMCP_GOOGLE_DEVELOPER_TOKEN is set/);
  assert.equal(rollback.registry.linkedin[0], '202609');
  assert.equal(rollback.registry.linkedin[1].throws.code, 'API_VERSION_UNREVIEWED');
  assert.equal(rollback.registry.linkedin[3].problem, 'API_VERSION_UNREVIEWED');
  const defaults = inChild({});
  assert.deepEqual(defaults.registry, defaults.module);
  assert.deepEqual(defaults.registry.meta, ['v26.0', '/v26.0/', '/v26.0/act_1/campaigns']);
  assert.deepEqual(defaults.registry.google, ['v25', null]);
  assert.deepEqual(defaults.registry.linkedin.slice(0, 2), ['202609', {returns: '202609'}]);
  assert.deepEqual(defaults.registry.linkedin[2], {returns: '202609'});
  // In this process a later change of the Meta setting changes nothing: the version was read at load.
  restoring('AMCP_META_API_VERSION', () => {
    process.env.AMCP_META_API_VERSION = meta.metaApiVersion === 'v25.0' ? 'v26.0' : 'v25.0';
    assert.equal(providerVersions('meta').current(), meta.metaApiVersion);
    assert.equal(providerVersions('meta').path('/'), meta.metaPrefix);
  });
});

test('Google Ads, Meta, LinkedIn and Criteo declare a version, frozen; no other provider declares one', () => {
  const declared = providerAdapters
    .filter(a => providerVersions(a.id))
    .map(a => [a.id, Object.keys(providerVersions(a.id)).sort()]);
  assert.deepEqual(declared, [
    ['google', ['current', 'path', 'warning']],
    ['meta', ['configurable', 'current', 'path']],
    ['linkedin', ['current', 'header', 'request', 'reviewed', 'status', 'stored']],
    ['criteo', ['current', 'docs']],
  ]);
  for (const [id] of declared) {
    assert.ok(Object.isFrozen(providerVersions(id)), id);
    // The provider ID is the leaf registry's: the version is the one its gateway's hooks declare.
    assert.equal(providerVersions(id), providerHooks(providerById(id).gateway).versions, id);
  }
  // Only LinkedIn sends its version in a request header, which a plan's headers report (PRV-02).
  assert.deepEqual(
    declared.filter(([id]) => providerVersions(id).header).map(([id]) => id),
    ['linkedin'],
  );
  // A provider without hooks, an unknown ID, an inherited name or a gateway (not an ID) has none.
  for (const name of [
    'gsc',
    'drive',
    'sheets',
    'x',
    'woocommerce',
    '',
    'nope',
    'constructor',
    '__proto__',
    'google_ads',
  ])
    assert.equal(providerVersions(name), undefined, name);
  assert.equal(providerVersions('google_ads_native_action'), undefined);
});

test('the notes, listings, jobs, owner settings and legacy names the shared modules ask for are the providers’ own', () => {
  const declaring = key => registeredProviderHooks.filter(h => h[key] !== undefined).map(h => h.gateway);
  for (const key of ['versions', 'notes', 'listing', 'jobs', 'ownerSetting'])
    for (const hooks of registeredProviderHooks)
      if (hooks[key] !== undefined) assert.ok(Object.isFrozen(hooks[key]), hooks.gateway + ' ' + key);
  // Tool notes (src/tool-notes.ts): a description of their own for the gateways the shared table described before.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.notes?.description !== undefined).map(h => h.gateway),
    [
      'google_business_native_action',
      'meta_native_action',
      'tiktok_native_action',
      'snapchat_native_action',
      'apple_ads_native_action',
      'dv360_native_action',
      'ga4_native_action',
      'gtm_native_action',
      'google_search_console_native_action',
      'adjust_native_action',
      'amazon_native_action',
      'commerce_native_action',
    ],
  );
  assert.equal(declaring('notes').length, 15);
  assert.deepEqual([...withoutExecutableActions], ['amazon_native_action']);
  assert.deepEqual(
    [...delegatedWriteGateways],
    [
      'criteo_native_action',
      'ga4_native_action',
      'google_business_native_action',
      'google_search_console_native_action',
      'gtm_native_action',
      'reddit_native_action',
    ],
  );
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.notes?.version).map(h => [h.gateway, h.notes.version]),
    [
      [
        'google_ads_native_action',
        'Requests go to Google Ads API v25; action names keep their recorded google_ads_v23_ spelling.',
      ],
    ],
  );
  // Listings (src/introspection.ts): Google Ads' counts, Meta's DESCRIBE_ACTION record, Snapchat's cursor pages of 25.
  assert.deepEqual(declaring('listing'), ['google_ads_native_action', 'meta_native_action', 'snapchat_native_action']);
  assert.deepEqual({...providerHooks('snapchat_native_action').listing}, {defaultLimit: 25, cursorPages: true});
  // Provider jobs (src/effect-class.ts): Microsoft's report submission, as the effect taxonomy answered before.
  assert.deepEqual(declaring('jobs'), ['microsoft_ads_native_action']);
  const before = plan =>
    plan.gateway === microsoftGateway && plan.action === 'SubmitGenerateReport' && plan.method === 'POST';
  for (const gateway of [...providerAdapters.map(a => a.gateway), 'amcp_native_action', undefined])
    for (const action of ['SubmitGenerateReport', 'PollGenerateReport', undefined])
      for (const method of ['POST', 'GET', 'post']) {
        const plan = {gateway, action, method, path: '/Reporting/v13/GenerateReport/Submit'};
        assert.equal(microsoftReportSubmit(plan), before(plan), [gateway, action, method].join(' '));
      }
  // Owner settings (src/owner-operations.ts): GA4's realtime test properties (MSR-04, P4), listed and saved as before.
  assert.deepEqual(declaring('ownerSetting'), ['ga4_native_action']);
  const setting = providerHooks('ga4_native_action').ownerSetting;
  assert.deepEqual([setting.field, setting.action], ['ga4_test_properties', 'save_ga4_test_property']);
  assert.equal(setting.list, ga4TestProperties);
  assert.equal(setting.save, saveGa4TestProperty);
  // Legacy names (src/legacy-alias-usage.ts): Google Ads' legacy coverage, every entry in its order.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.legacyAliases).map(h => h.gateway),
    ['google_ads_native_action'],
  );
  const aliases = providerHooks('google_ads_native_action').legacyAliases();
  assert.deepEqual(
    aliases,
    googleLegacyCoverage().entries.map(e => e.action),
  );
  assert.equal(aliases.length, googleLegacyCoverage().total);
  // Accepted versions (src/provider-sunsets.ts): the version sent, plus Meta's rollback, as before.
  for (const {id} of providerContracts) {
    const sent = sentVersion(id);
    assert.deepEqual(
      acceptedVersions(id),
      [...new Set([...(sent ? [sent] : []), ...(id === 'meta' ? meta.metaApiVersions : [])])],
      id,
    );
  }
});

const graph = runtimeGraph(process.cwd());
const providerImports = file =>
  [...graph.get(file)].filter(id => isProviderModule(id) && !providerRegistries.includes(id)).sort();
const source = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
// The architecture ratchet's rule (tools/architecture-map.mjs): a provider gateway in a string literal, AMCP's excepted.
const gatewayLiterals = file =>
  [...source(file).matchAll(/['"]([a-z0-9]+(?:_[a-z0-9]+)*)_native_action['"]/g)]
    .filter(m => m[1] !== 'amcp')
    .map(m => m[0]);
function reached(from) {
  const seen = new Set(),
    stack = [from];
  while (stack.length)
    for (const next of graph.get(stack.pop()) ?? [])
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
  return seen;
}

test('the shared modules that held a provider’s version, notes or checks import no provider module and name no gateway', () => {
  const modules = [
    'src/provider-contracts.ts',
    'src/contract-evidence.ts',
    'src/provider-sunsets.ts',
    'src/owner-operations.ts',
    'src/legacy-alias-usage.ts',
    'src/effect-class.ts',
    'src/creative-validation.ts',
    'src/tool-notes.ts',
    'src/introspection.ts',
  ];
  const fromHooks = reached('src/provider-hooks.ts');
  for (const file of modules) {
    assert.deepEqual(providerImports(file), [], file + ' imports no provider module');
    assert.deepEqual(gatewayLiterals(file), [], file + ' names no gateway');
    // A module that asks the hooks registry is not reached from it: no import cycle, so a read at load (the contracts
    // table's versions, the tool notes' gateway sets) finds every adapter's hooks initialized.
    if (graph.get(file).has('src/provider-hooks.ts'))
      assert.ok(!fromHooks.has(file), file + ' is not reached from the hooks');
  }
  // The Meta creative check moved to Meta's creative module; the contract's fields import nothing.
  assert.equal(graph.get('src/creative-validation.ts').size, 0);
  assert.ok(graph.get('src/meta-creative-features.ts').has('src/creative-validation.ts'));
  assert.doesNotMatch(source('src/creative-validation.ts'), /export function validateMetaCreative/);
  assert.match(source('src/meta-creative-features.ts'), /export function validateMetaCreative\(/);
});
