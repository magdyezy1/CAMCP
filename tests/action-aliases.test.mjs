import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {Introspection} from '../dist/src/introspection.js';
import {Store} from '../dist/src/store.js';
import {MirrorService, strictOptions} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {withContractProfile} from '../dist/src/contract-profile.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {unsupportedProviderAliases} from '../dist/src/retired-provider-actions.js';
import {providerHooks} from '../dist/src/provider-hooks.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * T7 (Round 2.5, M0; L2-04, L6-21): a near-miss action name resolves to the one action it stands for, with a deprecation
 * warning that names the canonical name; an ambiguous one is still refused with did_you_mean; no alias is offered by
 * tools/list; a write alias goes through the same review as its canonical name. Every fixture is synthetic; nothing
 * contacts a provider.
 */
const TIKTOK = 'tiktok_native_action',
  GOOGLE = 'google_ads_native_action',
  META = 'meta_native_action',
  SNAPCHAT = 'snapchat_native_action';
const registry = new Registry(),
  compiler = new Compiler(registry);

/** The names a gateway's catalog holds, from the data the registry was built from (the registry's own table aside). */
function exactNames(gateway) {
  const names = new Set();
  for (const a of [
    ...(registry.data.catalogs.find(c => c.gateway === gateway)?.actions ?? []),
    ...registry.data.supplemental.filter(a => a.gateway === gateway),
    ...(providerHooks(gateway)?.catalog?.supplemental?.actions ?? []),
  ])
    for (const n of [a.name, a.canonical_name, ...a.aliases]) names.add(n);
  return names;
}

test('the near-miss names of the White Friday report resolve to the one action they stand for', () => {
  for (const [gateway, used, canonical] of [
    [TIKTOK, 'campaign_create', 'tiktok_campaign_create'],
    [TIKTOK, 'campaign_get', 'tiktok_campaign_get'],
    [TIKTOK, 'tiktok_file_image_ad_info', 'tiktok_file_image_ad_info_get'],
    [GOOGLE, 'google_ads_search', 'google_ads_v23_google_ads_search'],
    [GOOGLE, 'google_ads_v25_google_ads_search', 'google_ads_v23_google_ads_search'],
    [GOOGLE, 'google_ads_v25_campaign_mutate_campaigns', 'google_ads_v23_campaign_mutate_campaigns'],
    [GOOGLE, 'google_ads_mutate', 'google_ads_v23_google_ads_mutate'],
    [GOOGLE, 'google_ads_campaign_mutate_campaigns', 'google_ads_v23_campaign_mutate_campaigns'],
  ]) {
    const resolved = registry.resolveAction(gateway, used);
    assert.equal(resolved.alias?.used, used, used);
    assert.equal(resolved.alias?.canonical, canonical, used);
    // The alias reaches the very action its canonical name does: nothing about it is a second route.
    assert.ok(resolved.action, used);
    assert.equal(resolved.action, registry.action(gateway, canonical), used);
    // Registry.action() stays exact, as at the base (the review's S3-3): an alias is resolved only where it is warned of.
    assert.equal(registry.action(gateway, used), undefined, used);
    assert.equal(resolved.action.canonical_name || resolved.action.name, canonical, used);
  }
});

// The review's S3-3: Registry.action() resolved aliases for every caller, so amcp_tool_help answered an alias with a reduced
// record and no warning (it refused it at the base), and decision reporting, the workflow engine, capability eligibility
// and execution status resolved it silently. The sites that canonicalize and warn call resolveAction themselves.
test('Registry.action() is exact, as at the base: an alias is no name to the callers that do not warn of it', () => {
  for (const [gateway, near, canonical] of [
    [TIKTOK, 'campaign_get', 'tiktok_campaign_get'],
    [TIKTOK, 'tiktok_file_image_ad_info', 'tiktok_file_image_ad_info_get'],
    [GOOGLE, 'google_ads_search', 'google_ads_v23_google_ads_search'],
    [GOOGLE, 'google_ads_v25_google_ads_search', 'google_ads_v23_google_ads_search'],
    ['linkedin_native_action', 'rest_media_planning_post', 'linkedin_rest_media_planning_post'],
  ]) {
    assert.equal(registry.action(gateway, near), undefined, near);
    assert.equal(registry.action(gateway, near.toUpperCase()), undefined, near);
    assert.ok(registry.action(gateway, canonical), canonical);
    assert.equal(registry.resolveAction(gateway, near).action, registry.action(gateway, canonical), near);
  }
  // The exact lookups are what they were: a name, its lower case, a captured alias, a friendly name.
  for (const [gateway, name] of [
    [TIKTOK, 'tiktok_campaign_get'],
    [TIKTOK, 'TIKTOK_CAMPAIGN_GET'],
    [GOOGLE, 'FETCH_CAMPAIGNS'],
    [META, 'meta_campaign_id_update'],
    ['dv360_native_action', 'ADVERTISERS_AD_ASSETS_CREATE'],
  ])
    assert.ok(registry.action(gateway, name), name);
});

test('amcp_tool_help refuses a near-miss operation with the names it could have meant, as it did before aliases', async () => {
  const f = fixture();
  try {
    const canonical = await f.call('amcp_tool_help', {gateway: TIKTOK, operation: 'tiktok_campaign_get'});
    assert.equal(canonical.success, true, JSON.stringify(canonical));
    const near = await f.call('amcp_tool_help', {gateway: TIKTOK, operation: 'campaign_get'});
    assert.equal(near.success, false, JSON.stringify(near));
    assert.equal(near.error.code, 'UNKNOWN_OPERATION');
    assert.ok(near.error.details.did_you_mean.includes('tiktok_campaign_get'), JSON.stringify(near.error.details));
    // The help names no alias and carries no alias warning: nothing was resolved.
    assert.deepEqual(aliasWarnings(near), []);
  } finally {
    f.store.close();
  }
});

test('an exact name, a captured alias and a friendly catalog name resolve as before, with no alias to warn about', () => {
  for (const [gateway, name] of [
    [TIKTOK, 'tiktok_campaign_create'],
    [TIKTOK, 'tiktok_campaign_list'],
    [GOOGLE, 'google_ads_v23_google_ads_search'],
    [GOOGLE, 'FETCH_CAMPAIGNS'],
    [META, 'meta_campaign_update'],
    [META, 'meta_campaign_id_update'],
    ['x_ads_native_action', 'LIST_ACCOUNTS'],
    ['dv360_native_action', 'ADVERTISERS_AD_ASSETS_CREATE'],
  ]) {
    const resolved = registry.resolveAction(gateway, name);
    assert.ok(resolved.action, name);
    assert.equal(resolved.alias, undefined, name);
  }
});

test('a name that is neither exact nor a unique alias has no action: a typo is still refused', () => {
  for (const [gateway, name] of [
    [TIKTOK, 'campaign_gett'],
    [TIKTOK, 'campaign'],
    [TIKTOK, 'create_campaign'],
    [GOOGLE, 'google_ads_v23_google_ads_searchh'],
    [GOOGLE, 'google_ads_v24_google_ads_search'],
    [META, 'meta_ad_account_gett'],
  ])
    assert.equal(registry.resolveAction(gateway, name).action, undefined, name);
});

test('compiling a near-miss name gives the very request its canonical name does', () => {
  const required = name =>
    Object.fromEntries(
      registry
        .action(TIKTOK, name)
        .required.filter(k => k !== 'advertiser_id')
        .map(k => [k, 'test']),
    );
  for (const [gateway, used, canonical, input] of [
    [TIKTOK, 'campaign_get', 'tiktok_campaign_get', {advertiser_id: '7999999999999999999', params: {page_size: 1}}],
    [
      TIKTOK,
      'tiktok_file_image_ad_info',
      'tiktok_file_image_ad_info_get',
      {advertiser_id: '7999999999999999999', params: required('tiktok_file_image_ad_info_get')},
    ],
    [
      TIKTOK,
      'campaign_create',
      'tiktok_campaign_create',
      {advertiser_id: '7999999999999999999', payload: {campaign_name: 'Synthetic', objective_type: 'TRAFFIC'}},
    ],
    [
      GOOGLE,
      'google_ads_search',
      'google_ads_v23_google_ads_search',
      {account_id: '1234567890', payload: {query: 'SELECT campaign.id FROM campaign LIMIT 1'}},
    ],
    [
      GOOGLE,
      'google_ads_v25_google_ads_search',
      'google_ads_v23_google_ads_search',
      {account_id: '1234567890', payload: {query: 'SELECT campaign.id FROM campaign LIMIT 1'}},
    ],
  ]) {
    const near = compiler.compile(gateway, {...input, action: used}, strictOptions),
      exact = compiler.compile(gateway, {...input, action: canonical}, strictOptions);
    assert.deepEqual(near, exact, used);
    assert.equal(near.action, canonical, used);
  }
});

// Decision (b) of the lead's review, 2026-11-15: two curated read-only spellings that no rule can produce, because one drops
// a path-parameter word and the other is a synonym. Each is the provider's own hook entry, held to the generator's rules.
test('meta_ad_account_get and snapchat_adaccount_get resolve to their ad-account reads, with the deprecation warning', async () => {
  const f = fixture();
  try {
    for (const [gateway, near, canonical, input] of [
      [META, 'meta_ad_account_get', 'meta_ad_account_id_get', {ad_account_id: '123'}],
      [SNAPCHAT, 'snapchat_adaccount_get', 'snapchat_adaccounts_ad_account_id_get', {ad_account_id: '123'}],
    ]) {
      const resolved = registry.resolveAction(gateway, near);
      assert.equal(resolved.alias?.canonical, canonical, near);
      // A read: the very action its canonical name reaches, a GET that the captured catalog and the ledger both classify so.
      assert.equal(resolved.action, registry.action(gateway, canonical), near);
      assert.equal(resolved.action.read_only, true, near);
      assert.equal(resolved.action.method, 'GET', near);
      assert.equal(ledger.get(gateway + '/' + canonical), 'native_read', near);
      assert.equal(registry.actionAliases(gateway).ambiguous.has(near), false, near);
      // It compiles to the very read its canonical name does.
      const compiled = compiler.compile(gateway, {...input, action: near}, strictOptions);
      assert.deepEqual(compiled, compiler.compile(gateway, {...input, action: canonical}, strictOptions), near);
      assert.equal(compiled.readOnly, true, near);
      // The call that names it carries the warning that names the canonical action, and the canonical name carries none.
      const preview = await f.call(gateway, {...input, action: near, dry_run: true}),
        exact = await f.call(gateway, {...input, action: canonical, dry_run: true});
      assert.equal(preview.success, true, JSON.stringify(preview));
      assert.equal(preview.data.action, canonical, near);
      assert.equal(aliasWarnings(preview)[0]?.used, near);
      assert.equal(aliasWarnings(preview)[0]?.canonical, canonical);
      assert.deepEqual(aliasWarnings(exact), []);
      // It is no listing's: not an enum value, not a name any other lookup offers.
      assert.equal(registry.action(gateway, near), undefined, near);
    }
    // Nothing near them became an alias: the typo of one is refused, and the two writes beside the Meta read are not reached.
    assert.equal(registry.resolveAction(META, 'meta_ad_account_gett').action, undefined);
    assert.equal(registry.resolveAction(SNAPCHAT, 'snapchat_adaccount_gett').action, undefined);
    assert.equal(registry.resolveAction(META, 'meta_ad_account_create').alias, undefined);
  } finally {
    f.store.close();
  }
});

test('a write alias compiles to a write that reads nothing, and no read alias compiles to one', () => {
  const write = compiler.compile(
    TIKTOK,
    {action: 'campaign_create', advertiser_id: '7999999999999999999', payload: {campaign_name: 'Synthetic'}},
    strictOptions,
  );
  assert.equal(write.readOnly, false);
  assert.equal(write.method, 'POST');
  const read = compiler.compile(
    TIKTOK,
    {action: 'campaign_get', advertiser_id: '7999999999999999999', params: {page_size: 1}},
    strictOptions,
  );
  assert.equal(read.readOnly, true);
});

test('an ambiguous spelling is no alias: it still fails UNKNOWN_ACTION and offers did_you_mean', () => {
  let tried = 0;
  for (const gateway of [TIKTOK, META, SNAPCHAT]) {
    const {aliases, ambiguous} = registry.actionAliases(gateway);
    assert.ok(ambiguous.size > 0, gateway + ' has spellings two actions could claim');
    for (const spelling of [...ambiguous.keys()].slice(0, 3)) {
      assert.equal(aliases.has(spelling), false, spelling);
      assert.equal(registry.resolveAction(gateway, spelling).action, undefined, spelling);
      assert.throws(
        () => compiler.compile(gateway, {action: spelling, account_id: '123'}, strictOptions),
        e =>
          assertRefused(e, 'UNKNOWN_ACTION') &&
          Array.isArray(e.details.did_you_mean) &&
          e.details.did_you_mean.length > 0 &&
          e.details.list_call !== undefined,
        spelling,
      );
      tried++;
    }
  }
  assert.ok(tried >= 6, 'ambiguous spellings were tried: ' + tried);
});

/** The forms a name may take as an alias, written independently of the generator: what an alias may be, and nothing else. */
const prefixes = {
  [TIKTOK]: 'tiktok_',
  [META]: 'meta_',
  [SNAPCHAT]: 'snapchat_',
  linkedin_native_action: 'linkedin_',
  x_ads_native_action: 'x_',
  [GOOGLE]: 'google_ads_v23_',
};
/** The spellings no rule produces, which a provider's hook adds by decision (the lead's review, 2026-11-15): nothing else is exempt. */
const curated = {
  [META]: {meta_ad_account_get: 'meta_ad_account_id_get'},
  [SNAPCHAT]: {snapchat_adaccount_get: 'snapchat_adaccounts_ad_account_id_get'},
};
function structuralForms(name, prefix, read) {
  const bases = new Set([name]);
  const m = /^(.*)_(get|list)$/.exec(name);
  if (read && m) for (const base of [m[1], m[1] + '_' + (m[2] === 'get' ? 'list' : 'get')]) bases.add(base);
  const forms = new Set(bases);
  for (const base of bases) if (base.startsWith(prefix)) forms.add(base.slice(prefix.length));
  return forms;
}
/** Every name of a gateway's catalog that reaches the canonical action `canonical`: its own, and the friendly names that map to it. */
function namesOf(gateway, canonical) {
  const names = new Set();
  for (const a of [
    ...(registry.data.catalogs.find(c => c.gateway === gateway)?.actions ?? []),
    ...registry.data.supplemental.filter(a => a.gateway === gateway),
    ...(providerHooks(gateway)?.catalog?.supplemental?.actions ?? []),
  ])
    if ((a.canonical_name || a.name) === canonical)
      for (const n of [a.name, a.canonical_name, ...a.aliases]) names.add(n);
  return names;
}

// The second oracle of the read rule (the review's S4-1): AMCP's own classification, the action-contract ledger, which treats
// as writes some actions the captured catalog flags as reads (a report-task create, shareable previews).
const ledger = new Map(actionContracts(registry).map(c => [c.gateway + '/' + c.action, c.status])),
  ledgerWrites = new Set(['reviewed_write_family', 'blocked_write', 'media_workflow']);

test('the ledger classifies no action a read spelling leads to as a write, and it is a stricter oracle than the captured flag', () => {
  // Not vacuous: the ledger holds writes the captured flag calls reads, so the two oracles differ.
  const stricter = [...ledger].filter(
    ([key, status]) =>
      ledgerWrites.has(status) && registry.action(...key.split(/\/(.*)/s).slice(0, 2))?.read_only === true,
  );
  assert.ok(stricter.length >= 3, 'captured reads the ledger treats as writes: ' + stricter.length);
  let read = 0;
  for (const gateway of Object.keys(prefixes))
    for (const [spelling, entry] of registry.actionAliases(gateway).aliases)
      if (/_(get|list)$/.test(spelling)) {
        read++;
        const status = ledger.get(gateway + '/' + entry.canonical);
        assert.ok(status !== undefined, gateway + ' ' + entry.canonical + ' is in the ledger');
        assert.equal(
          ledgerWrites.has(status),
          false,
          gateway + ' ' + spelling + ' leads to ' + entry.canonical + ' (' + status + ')',
        );
      }
  assert.ok(read > 1000, 'read-looking aliases checked: ' + read);
});

// The review's S4-2: no generated spelling revives a spelling a provider has retired.
test('no generated alias is a spelling a provider has retired', () => {
  assert.ok(unsupportedProviderAliases.length >= 1);
  for (const row of unsupportedProviderAliases) {
    const {aliases, ambiguous} = registry.actionAliases(row.gateway);
    assert.equal(aliases.has(row.action), false, row.action);
    assert.equal(ambiguous.has(row.action), false, row.action);
    assert.equal(registry.resolveAction(row.gateway, row.action).alias, undefined, row.action);
  }
});

test('the registry leaves a spelling the provider has retired out of its alias table', () => {
  // None of today's retired spellings is one a rule would produce, so the wiring is shown with a synthetic row.
  const row = {
    gateway: TIKTOK,
    action: 'campaign_create',
    version: 'v0',
    source: 'synthetic',
    checked_at: '2026-11-15',
    reason: 'Synthetic.',
    replacement: 'tiktok_campaign_create',
  };
  assert.equal(new Registry().resolveAction(TIKTOK, 'campaign_create').alias?.canonical, 'tiktok_campaign_create');
  unsupportedProviderAliases.push(row);
  try {
    const fresh = new Registry();
    assert.equal(fresh.resolveAction(TIKTOK, 'campaign_create').action, undefined);
    assert.equal(fresh.actionAliases(TIKTOK).aliases.has('campaign_create'), false);
    assert.equal(fresh.actionAliases(TIKTOK).aliases.get('campaign_get')?.canonical, 'tiktok_campaign_get');
  } finally {
    unsupportedProviderAliases.splice(unsupportedProviderAliases.indexOf(row), 1);
  }
  assert.equal(new Registry().resolveAction(TIKTOK, 'campaign_create').alias?.canonical, 'tiktok_campaign_create');
});

test('across the gateways no alias collides with a name, leads to a write by a read spelling, or is anything but a form of a name', () => {
  let total = 0;
  for (const [gateway, prefix] of Object.entries(prefixes)) {
    const {aliases} = registry.actionAliases(gateway),
      exact = exactNames(gateway);
    assert.ok(aliases.size >= 100, gateway + ' has aliases: ' + aliases.size);
    for (const [spelling, entry] of aliases) {
      total++;
      assert.match(spelling, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/, spelling);
      assert.ok(spelling.length <= 200, spelling);
      // No collision with a name the gateway already has.
      assert.equal(exact.has(spelling), false, gateway + ' ' + spelling + ' is an exact name');
      // It resolves to exactly the action its canonical name does, with the alias recorded.
      const resolved = registry.resolveAction(gateway, spelling);
      assert.equal(resolved.alias?.canonical, entry.canonical, spelling);
      assert.equal(resolved.action, registry.action(gateway, entry.canonical), spelling);
      // A spelling that reads (ends _get or _list) never leads to an action that is not a read.
      if (/_(get|list)$/.test(spelling))
        assert.equal(resolved.action.read_only, true, gateway + ' ' + spelling + ' reads but leads to a write');
      // Nothing fuzzy: it is a form of one of the names that reach its action (or Google's version forms).
      const target = resolved.action,
        keys = [...namesOf(gateway, entry.canonical)],
        forms = new Set(keys.flatMap(k => [...structuralForms(k, prefix, target.read_only === true)]));
      assert.ok(keys.length > 0 && keys.includes(entry.canonical), entry.canonical + ' is a name of the catalog');
      if (gateway === GOOGLE)
        for (const k of keys)
          if (k.startsWith(prefix)) {
            forms.add('google_ads_v25_' + k.slice(prefix.length));
            forms.add('google_ads_' + k.slice(prefix.length));
          }
      assert.ok(
        forms.has(spelling) || curated[gateway]?.[spelling] === entry.canonical,
        gateway + ' ' + spelling + ' is not a form of ' + keys.join(' | '),
      );
    }
  }
  assert.ok(total > 3000, 'aliases generated: ' + total);
});

test('the gateways whose names are not lower-case snake words have no generated aliases', () => {
  for (const gateway of ['dv360_native_action', 'microsoft_ads_native_action', 'amcp_tool_help'])
    assert.equal(registry.actionAliases(gateway).aliases.size, 0, gateway);
});

test('aliases stay out of every listing: the schema enums, the catalog, and the names an unknown action offers', () => {
  const every = new Set();
  for (const gateway of registry.tools.keys())
    for (const spelling of registry.actionAliases(gateway).aliases.keys()) every.add(spelling);
  assert.ok(every.size > 3000);
  for (const options of [strictOptions, {mode: 'enhanced', flags: {compactSchemas: true}}])
    for (const tool of registry.listTools(options)) {
      const enumerated = tool.inputSchema?.properties?.action?.enum ?? [];
      for (const value of enumerated) assert.equal(every.has(value), false, tool.name + ' lists ' + value);
    }
  for (const gateway of [TIKTOK, GOOGLE, META, SNAPCHAT]) {
    const catalog = registry.catalogs.get(gateway),
      captured = registry.data.catalogs.find(c => c.gateway === gateway);
    assert.equal(catalog.actions.length, captured.actions.length, gateway);
    for (const a of catalog.actions) assert.equal(every.has(a.name), false, a.name);
    const refusal = registry.unknownAction(gateway, 'campaign_gett', 'action');
    for (const listed of [...refusal.details.allowed, ...refusal.details.did_you_mean])
      assert.equal(every.has(listed), false, gateway + ' offers ' + listed);
  }
  // The catalog's counts are unchanged by the table: each gateway's listed catalog is the captured one (asserted above).
});

test('DESCRIBE_ACTION answers a near-miss target_action as it answers its canonical name', () => {
  const introspection = new Introspection(registry);
  for (const [gateway, used, canonical] of [
    [TIKTOK, 'campaign_get', 'tiktok_campaign_get'],
    [TIKTOK, 'tiktok_file_image_ad_info', 'tiktok_file_image_ad_info_get'],
    [GOOGLE, 'google_ads_search', 'google_ads_v23_google_ads_search'],
  ])
    assert.deepEqual(
      introspection.describe(gateway, {target_action: used}),
      introspection.describe(gateway, {target_action: canonical}),
      used,
    );
});

// ---------------------------------------------------------------------------------------------------------------------
// The service: the warning, the review of a write alias, the campaign step.

const actor = {tenantId: 'action-aliases', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'},
  CONNECTION = '29292929-2929-4292-8292-292929292929',
  account = '7000000000000000002';
function fixture({allowWrites = true} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
  store.putConnection(
    owner,
    {
      id: CONNECTION,
      tenantId: actor.tenantId,
      gateway: TIKTOK,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const campaigns = new Map([['100', {campaign_id: '100', campaign_name: 'Spring', operation_status: 'ENABLE'}]]),
    requests = [],
    writes = [];
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'synthetic-request', data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path);
    if (method === 'GET' && path === '/v1.3/campaign/get/') {
      const filtering = JSON.parse(url.searchParams.get('filtering') ?? '{}'),
        list = [...campaigns.values()].filter(
          r => !filtering.campaign_ids || filtering.campaign_ids.includes(r.campaign_id),
        );
      return ok({
        list: structuredClone(list),
        page_info: {page: 1, page_size: 1000, total_number: list.length, total_page: 1},
      });
    }
    if (method === 'POST' && path === '/v1.3/campaign/status/update/') {
      const body = JSON.parse(init.body);
      writes.push(body);
      for (const id of body.campaign_ids)
        campaigns.set(id, {...campaigns.get(id), operation_status: body.operation_status});
      return ok({campaign_ids: body.campaign_ids, status: body.operation_status});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  store.rememberResource({id: CONNECTION, tenantId: actor.tenantId, gateway: TIKTOK}, account, '100');
  return {
    store,
    campaigns,
    requests,
    writes,
    call: (tool, input) => service.call(tool, input, actor),
    prepare: (name, status = 'DISABLE') =>
      service.call(
        'amcp_write',
        {
          action: 'prepare',
          gateway: TIKTOK,
          connection_id: CONNECTION,
          arguments: {action: name, account_id: account, payload: {campaign_ids: ['100'], operation_status: status}},
        },
        actor,
      ),
    execute: id =>
      service.call(
        'amcp_write',
        {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, spend_change_confirmed: true},
        actor,
      ),
  };
}
const aliasWarnings = result =>
  (result.meta?.argument_warnings ?? []).filter(w => w.code === 'ACTION_ALIAS_DEPRECATED');

test('a read through a near-miss name answers as its canonical name does and warns, naming the canonical name', async () => {
  const f = fixture();
  try {
    const near = await f.call(TIKTOK, {action: 'campaign_get', account_id: account, params: {page_size: 10}}),
      exact = await f.call(TIKTOK, {action: 'tiktok_campaign_get', account_id: account, params: {page_size: 10}});
    assert.equal(near.success, true, JSON.stringify(near));
    assert.deepEqual(near.data, exact.data);
    assert.deepEqual(f.requests, ['GET /v1.3/campaign/get/', 'GET /v1.3/campaign/get/']);
    const [warning, ...rest] = aliasWarnings(near);
    assert.equal(rest.length, 0);
    assert.equal(warning.field, 'action');
    assert.equal(warning.used, 'campaign_get');
    assert.equal(warning.canonical, 'tiktok_campaign_get');
    assert.match(warning.message, /tiktok_campaign_get/);
    // The canonical name draws no warning.
    assert.deepEqual(aliasWarnings(exact), []);
    assert.equal(exact.meta.argument_warnings, undefined);
  } finally {
    f.store.close();
  }
});

// The review's S3-1: the contract profile recognises a client's own call by the identity of its arguments object, and the
// copy a near-miss name is run as is another object, so a v2 client was answered in the legacy shape through an alias.
test('under the v2 contract profile a read through a near-miss name is answered exactly as its canonical name is', async () => {
  const f = fixture();
  try {
    f.campaigns.set('100', {...f.campaigns.get('100'), budget: null});
    // As the MCP layer makes a client's call: in the client's profile, naming the arguments of the call as its own.
    const ask = (profile, name) => {
      const args = {action: name, account_id: account, params: {page_size: 10}};
      return withContractProfile(profile, () => f.call(TIKTOK, args), args);
    };
    const exact = await ask('v2', 'tiktok_campaign_get'),
      near = await ask('v2', 'campaign_get');
    assert.equal(near.success, true, JSON.stringify(near));
    // The premise: v2 compacts the rows of a list, so the null a row carries is left out of the canonical answer.
    assert.equal(JSON.stringify(exact.data).includes('"budget"'), false, JSON.stringify(exact.data));
    assert.deepEqual(near.data, exact.data);
    assert.equal(aliasWarnings(near)[0]?.canonical, 'tiktok_campaign_get');
    // Legacy keeps the null, through either name, as before.
    const legacyExact = await ask('legacy', 'tiktok_campaign_get'),
      legacyNear = await ask('legacy', 'campaign_get');
    assert.equal(JSON.stringify(legacyExact.data).includes('"budget":null'), true);
    assert.deepEqual(legacyNear.data, legacyExact.data);
    // A call that is not the client's own, made inside its profile (what a workflow makes), is not compacted for an alias either.
    const made = await withContractProfile('v2', () =>
      f.call(TIKTOK, {action: 'campaign_get', account_id: account, params: {page_size: 10}}),
    );
    assert.deepEqual(made.data, legacyExact.data);
  } finally {
    f.store.close();
  }
});

// The review's S3-2: only Introspection.describe canonicalized target_action; the service passed the raw name to the
// conditional-program lookup and to the AMCP description, which match by exact name.
test('DESCRIBE_ACTION of a near-miss name is answered as its canonical name is, with its conditional program', async () => {
  const f = fixture();
  try {
    for (const [near, canonical] of [
      ['rest_media_planning_post', 'linkedin_rest_media_planning_post'],
      ['rest_targeting_audience_insights_post', 'linkedin_rest_targeting_audience_insights_post'],
    ]) {
      const exact = await f.call('linkedin_native_action', {action: 'DESCRIBE_ACTION', target_action: canonical}),
        alias = await f.call('linkedin_native_action', {action: 'DESCRIBE_ACTION', target_action: near});
      assert.equal(exact.success, true, JSON.stringify(exact));
      assert.equal(alias.success, true, JSON.stringify(alias));
      // The premise: the canonical name carries the block that says to inspect the conditional workflow first.
      assert.equal(typeof exact.data.amcp_conditional_program?.workflow_id, 'string', canonical);
      assert.deepEqual(alias.data.amcp_conditional_program, exact.data.amcp_conditional_program, near);
      assert.deepEqual(alias.data, exact.data, near);
      const [warning] = aliasWarnings(alias);
      assert.equal(warning?.field, 'target_action');
      assert.equal(warning?.used, near);
      assert.equal(warning?.canonical, canonical);
      assert.deepEqual(aliasWarnings(exact), []);
    }
  } finally {
    f.store.close();
  }
});

test('a refused call through a near-miss name carries the same warning, so the caller learns the name even when it fails', async () => {
  const f = fixture();
  try {
    const refused = await f.call(TIKTOK, {action: 'campaign_get', account_id: '999', params: {page_size: 10}});
    assert.equal(refused.success, false);
    assert.notEqual(refused.error.code, 'UNKNOWN_ACTION');
    assert.equal(aliasWarnings(refused)[0]?.canonical, 'tiktok_campaign_get');
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a write through a near-miss name is refused outside amcp_write exactly as its canonical name is, with nothing sent', async () => {
  const f = fixture();
  try {
    const input = {
      account_id: account,
      payload: {campaign_ids: ['100'], operation_status: 'DISABLE'},
      dry_run: false,
      confirmed: true,
      idempotency_key: 'direct-write-key',
    };
    const alias = await f.call(TIKTOK, {...input, action: 'campaign_status_update'}),
      canonical = await f.call(TIKTOK, {...input, action: 'tiktok_campaign_status_update'});
    assertRefused(canonical, 'WRITE_REVIEW_REQUIRED', {writes: () => f.writes.length});
    assertRefused(alias, 'WRITE_REVIEW_REQUIRED', {writes: () => f.writes.length});
    assert.equal(f.campaigns.get('100').operation_status, 'ENABLE');
    // The call it names instead is the canonical one: the caller is steered off the alias, not onto it again.
    assert.deepEqual(alias.error.details.next_call, canonical.error.details.next_call);
    assert.equal(alias.error.details.next_call.arguments.arguments.action, 'tiktok_campaign_status_update');
    assert.equal(aliasWarnings(alias)[0]?.canonical, 'tiktok_campaign_status_update');
  } finally {
    f.store.close();
  }
});

test('amcp_write prepares a near-miss name as a review of its canonical action, and executes it once', async () => {
  const f = fixture();
  try {
    const inspected = await f.call('amcp_write', {
      action: 'inspect',
      gateway: TIKTOK,
      arguments: {
        action: 'campaign_status_update',
        account_id: account,
        payload: {campaign_ids: ['100'], operation_status: 'DISABLE'},
      },
    });
    assert.equal(inspected.data.review_contract_supported, true, JSON.stringify(inspected));
    assert.equal(inspected.data.request.action, 'tiktok_campaign_status_update');
    assert.equal(aliasWarnings(inspected)[0]?.field, 'arguments.action');
    assert.equal(aliasWarnings(inspected)[0]?.canonical, 'tiktok_campaign_status_update');

    const near = await f.prepare('campaign_status_update'),
      exact = await f.prepare('tiktok_campaign_status_update');
    assert.equal(near.success, true, JSON.stringify(near));
    assert.equal(aliasWarnings(near)[0]?.used, 'campaign_status_update');
    assert.equal(aliasWarnings(near)[0]?.canonical, 'tiktok_campaign_status_update');
    assert.deepEqual(aliasWarnings(exact), []);
    // The review is the canonical one: the same request, the same fingerprint, the same words.
    assert.equal(near.data.request.action, 'tiktok_campaign_status_update');
    assert.equal(near.data.fingerprint, exact.data.fingerprint);
    assert.equal(near.data.summary.text, exact.data.summary.text);
    const stored = f.store.document(actor.tenantId, 'write_review', near.data.review_id);
    assert.equal(stored.plan.action, 'tiktok_campaign_status_update');
    // What a later prepare call re-sends names the canonical action too.
    assert.equal(stored.prepare_input.arguments.action, 'tiktok_campaign_status_update');

    const executed = await f.execute(near.data.review_id);
    assert.equal(executed.success, true, JSON.stringify(executed));
    assert.equal(f.writes.length, 1);
    assert.equal(f.campaigns.get('100').operation_status, 'DISABLE');
    const status = await f.call('amcp_write', {action: 'status', review_id: near.data.review_id});
    assert.equal(
      JSON.stringify(status).includes('"campaign_status_update"'),
      false,
      'status shows the canonical name only',
    );
  } finally {
    f.store.close();
  }
});

test('a write alias keeps every gate its canonical name has: an ambiguous or unknown name prepares nothing', async () => {
  const f = fixture();
  try {
    const unknown = await f.prepare('campaign_status_updat');
    assertRefused(unknown, 'UNKNOWN_ACTION', {writes: () => f.writes.length});
    assert.ok(Array.isArray(unknown.error.details.did_you_mean));
    // A read alias is a read: amcp_write refuses it as it refuses its canonical name, and nothing is prepared or sent.
    const read = await f.prepare('campaign_get'),
      canonicalRead = await f.prepare('tiktok_campaign_get');
    assertRefused(canonicalRead, 'UNSUPPORTED_PARAMETER', {writes: () => f.writes.length});
    assertRefused(read, 'UNSUPPORTED_PARAMETER', {writes: () => f.writes.length});
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE kind='write_review'").get().n, 0);
  } finally {
    f.store.close();
  }
});

// The review's S4-7: the R2.5 rule asks for a negative test per gate a package touches, and the alias gates are plan-based.
test('a spend-changing write prepared through a near-miss name needs the approval its canonical name needs, and sends nothing without it', async () => {
  const f = fixture();
  try {
    // ENABLE of a paused campaign is a spend change: its review says it needs the approval, and execute refuses without it.
    f.campaigns.set('100', {...f.campaigns.get('100'), operation_status: 'DISABLE'});
    const codes = [];
    for (const name of ['tiktok_campaign_status_update', 'campaign_status_update']) {
      const prepared = await f.prepare(name, 'ENABLE');
      assert.equal(prepared.success, true, name + ' ' + JSON.stringify(prepared));
      assert.equal(prepared.data.execute_requirements?.spend_change_confirmed, true, name);
      const refused = await f.call('amcp_write', {
        action: 'execute',
        review_id: prepared.data.review_id,
        idempotency_key: prepared.data.review_id,
        confirmed: true,
      });
      assertRefused(refused, refused.error?.code, {writes: () => f.writes.length});
      codes.push(refused.error.code);
    }
    assert.equal(codes[0], codes[1], 'the alias is refused as the canonical name is');
    assert.equal(f.writes.length, 0);
    assert.equal(f.campaigns.get('100').operation_status, 'DISABLE');
    // With the approval the same kind of review executes once: the refusal above was the missing approval, nothing else.
    const prepared = await f.prepare('campaign_status_update', 'ENABLE'),
      executed = await f.execute(prepared.data.review_id);
    assert.equal(executed.success, true, JSON.stringify(executed));
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('a write prepared through a near-miss name is refused on a read-only deployment as its canonical name is, with nothing sent', async () => {
  const f = fixture({allowWrites: false});
  try {
    const codes = [];
    for (const name of ['tiktok_campaign_status_update', 'campaign_status_update']) {
      const refused = await f.prepare(name);
      assert.equal(refused.success, false, name + ' ' + JSON.stringify(refused));
      codes.push(refused.error.code);
    }
    assert.equal(codes[0], 'LIVE_WRITES_DISABLED');
    assert.equal(codes[1], codes[0], 'the alias is refused as the canonical name is');
    assert.equal(f.writes.length, 0);
    assert.equal(f.requests.length, 0, 'nothing was sent to the provider, not even a read');
    // A direct call with dry_run:false through the alias is refused too, before any review.
    const direct = await f.call(TIKTOK, {
      action: 'campaign_status_update',
      account_id: account,
      payload: {campaign_ids: ['100'], operation_status: 'DISABLE'},
      dry_run: false,
      confirmed: true,
      idempotency_key: 'direct-write-key',
    });
    assert.equal(direct.success, false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.campaigns.get('100').operation_status, 'ENABLE');
  } finally {
    f.store.close();
  }
});

test('amcp_campaign saves a plan step written with a near-miss name under its canonical name and warns where it was written', async () => {
  const f = fixture();
  try {
    const step = (id, name) => ({
      id,
      kind: 'write',
      gateway: TIKTOK,
      connection_id: CONNECTION,
      account_id: account,
      arguments: {
        action: name,
        account_id: account,
        payload: {campaign_ids: ['100'], operation_status: 'DISABLE'},
      },
    });
    const created = await f.call('amcp_campaign', {
      action: 'create',
      name: 'Alias plan',
      brief: 'Synthetic.',
      steps: [step('first', 'campaign_status_update'), step('second', 'tiktok_campaign_status_update')],
    });
    assert.equal(created.success, true, JSON.stringify(created));
    const warnings = aliasWarnings(created);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].field, 'steps[0].arguments.action');
    assert.equal(warnings[0].used, 'campaign_status_update');
    assert.equal(warnings[0].canonical, 'tiktok_campaign_status_update');
    const run = f.store.document(actor.tenantId, 'campaign_run', created.data.id ?? created.data.plan?.id);
    assert.deepEqual(
      run.steps.map(s => s.arguments.action),
      ['tiktok_campaign_status_update', 'tiktok_campaign_status_update'],
    );
  } finally {
    f.store.close();
  }
});
