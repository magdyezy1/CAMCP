import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {Introspection} from '../dist/src/introspection.js';
import {Store} from '../dist/src/store.js';
import {MirrorService, strictOptions} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
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
    assert.equal(registry.action(gateway, used), registry.action(gateway, canonical), used);
    assert.equal(resolved.action.canonical_name || resolved.action.name, canonical, used);
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
      assert.ok(forms.has(spelling), gateway + ' ' + spelling + ' is not a form of ' + keys.join(' | '));
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
  // The catalog's counts are unchanged by the table.
  assert.equal(registry.catalogs.get(TIKTOK).actions.length, 561);
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
function fixture() {
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
    allowWrites: true,
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
