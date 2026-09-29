import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {ScopeGuard} from '../src/scope.js';
import {actionContracts} from '../src/action-contracts.js';
import {parseLinkedInValue} from '../src/linkedin-restli.js';
import {linkedinRuleSnapshots, readLinkedInRules} from '../src/linkedin-conversion-rules.js';
import {removeTestDirectory} from './temp.js';
import type {CompiledRequest, Connection, JsonObject} from '../src/types.js';

const registry = new Registry(),
  gateway = 'linkedin_native_action',
  actor = {tenantId: 'li-rules', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const},
  key = Buffer.alloc(32, 54).toString('base64'),
  account = 'urn:li:sponsoredAccount:123';
const collection = 'linkedin_rest_conversions_post',
  single = 'linkedin_rest_conversions_conversion_id_post';
const defaults = {
  enabled: true,
  attributionType: 'LAST_TOUCH_BY_CAMPAIGN',
  postClickAttributionWindowSize: 30,
  viewThroughAttributionWindowSize: 7,
  valueType: 'DYNAMIC',
  campaigns: [],
  associatedCampaigns: [],
};
const make = (target: string, extra: JsonObject = {}) => ({
  id: Number(target),
  account,
  name: 'Rule ' + target,
  type: 'LEAD',
  ...structuredClone(defaults),
  ...extra,
});
function args(
  mode = 'CREATE',
  values: JsonObject[] = [{name: 'Purchase complete', type: 'PURCHASE', enabled: false}],
): JsonObject {
  return {
    action: mode === 'PARTIAL_UPDATE' ? single : collection,
    account_id: '123',
    restli_method: mode,
    ...(mode === 'PARTIAL_UPDATE' ? {path_params: {conversion_id: '789'}} : {}),
    query: {account, ...(mode === 'BATCH_PARTIAL_UPDATE' ? {ids: ['789', '790']} : {})},
    payload:
      mode === 'CREATE'
        ? values[0]
        : mode === 'BATCH_CREATE'
          ? {elements: values}
          : mode === 'PARTIAL_UPDATE'
            ? {patch: {$set: values[0]}}
            : {entities: Object.fromEntries(values.map((v, i) => [String(789 + i), {patch: {$set: v}}]))},
  };
}
function fixture(file = ':memory:') {
  const store = new Store(file, key),
    calls: JsonObject[] = [],
    rules: JsonObject = {'789': make('789'), '790': make('790')},
    campaigns: JsonObject = {
      '456': {id: 456, account, name: 'Campaign', status: 'ACTIVE', dailyBudget: {amount: '100', currencyCode: 'USD'}},
    },
    tags: JsonObject[] = [
      {id: 9, sponsoredAccounts: [account], firstPartyTrackingEnabled: true, tag: '<script>synthetic</script>'},
    ],
    c: Connection = {
      id: 'c',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      scopes: ['rw_ads'],
      label: 'Synthetic',
    };
  if (!store.listConnections(actor.tenantId).length) store.putConnection(owner, c, {accessToken: 'synthetic'});
  let mode = 'success',
    counter = 900,
    reads = 0,
    pageSize = 100;
  let hook: (u: URL, d: JsonObject) => JsonObject = (_u, d) => d;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        method = init!.method!,
        headers = new Headers(init!.headers);
      calls.push({url: u.href, method, body: init!.body?.toString()});
      assert.equal(u.origin, 'https://api.linkedin.com');
      assert.equal(headers.get('LinkedIn-Version'), '202609');
      assert.equal(headers.get('X-Restli-Protocol-Version'), '2.0.0');
      if (method === 'GET') {
        reads++;
        if (mode === 'revoked') store.putConnection(owner, {...c, writeAccounts: []}, {accessToken: 'synthetic'});
        if (mode === 'scope_revoked') store.putConnection(owner, {...c, scopes: []}, {accessToken: 'synthetic'});
        let data: JsonObject;
        if (u.pathname === '/rest/adAccounts/123') data = {id: 123, currency: 'USD', status: 'ACTIVE'};
        else if (u.pathname.startsWith('/rest/adAccounts/123/adCampaigns/'))
          data = structuredClone(campaigns[u.pathname.split('/').at(-1)!] ?? {});
        else if (u.pathname === '/rest/campaignConversions') {
          assert.equal(u.searchParams.get('q'), 'campaigns');
          data = {elements: [], paging: {start: 0, count: 100, total: 0, links: []}};
        } else {
          assert.equal(u.searchParams.get('account'), account);
          if (u.pathname.startsWith('/rest/conversions/')) {
            const target = u.pathname.split('/').at(-1)!;
            if (!rules[target]) return Response.json({message: 'Missing', status: 404}, {status: 404});
            data = structuredClone(rules[target]);
          } else {
            assert.equal(u.searchParams.get('q'), 'account');
            assert.ok(['/rest/conversions', '/rest/insightTags'].includes(u.pathname));
            const values = u.pathname === '/rest/conversions' ? Object.values(rules).slice().reverse() : tags,
              start = Number(u.searchParams.get('start'));
            data = {
              elements: structuredClone(values.slice(start, start + pageSize)),
              paging: {start, count: pageSize, total: values.length, links: []},
            };
          }
        }
        if (data.id && u.pathname.includes('/conversions/')) {
          data.lastModified = reads;
          data.lastCallbackAt = reads;
          data.latestFirstPartyCallbackAt = reads;
        }
        return Response.json(hook(u, data));
      }
      assert.equal(method, 'POST');
      const restli = headers.get('X-RestLi-Method') ?? 'CREATE',
        body = JSON.parse(String(init!.body)),
        created: string[] = [];
      let ids: string[] = [];
      if (restli === 'CREATE' || restli === 'BATCH_CREATE') {
        const values = restli === 'CREATE' ? [body] : body.elements;
        for (const [i, v] of values.entries()) {
          const target = String(++counter);
          created.push(target);
          if (mode !== 'ignored' && !(mode === 'partial' && i === 1)) rules[target] = make(target, {...v, account});
        }
        ids = created;
      } else {
        ids =
          restli === 'PARTIAL_UPDATE'
            ? [u.pathname.split('/').at(-1)!]
            : (parseLinkedInValue(u.searchParams.get('ids')!) as string[]).map(String);
        for (const [i, target] of ids.entries())
          if (mode !== 'ignored' && !(mode === 'partial' && i === 1))
            Object.assign(
              rules[target],
              restli === 'PARTIAL_UPDATE' ? body.patch.$set : body.entities[target].patch.$set,
            );
      }
      if (mode === 'lost') throw Error('Synthetic lost response after mutation');
      if (mode === 'empty') return Response.json({});
      if (mode === 'preexisting') return Response.json(rules['789'], {status: 201, headers: {'x-restli-id': '789'}});
      if (restli === 'CREATE') {
        const data = structuredClone(rules[ids[0]!] ?? make(ids[0]!, body));
        if (mode === 'foreign') data.account = 'urn:li:sponsoredAccount:999';
        return mode === 'empty_201'
          ? new Response(null, {status: 201, headers: {'x-restli-id': ids[0]!}})
          : Response.json(data, {status: 201, headers: mode === 'no_id' ? {} : {'x-restli-id': ids[0]!}});
      }
      if (restli === 'BATCH_CREATE')
        return Response.json({
          elements: ids.map((target, i) =>
            mode === 'partial' && i === 1
              ? {status: 403, error: {message: 'Synthetic denied'}}
              : {
                  id: mode === 'duplicate' ? ids[0] : target,
                  status: 201,
                  location: '/conversions/' + target,
                  entity: rules[target],
                },
          ),
        });
      if (restli === 'PARTIAL_UPDATE') return new Response(null, {status: 204});
      return Response.json({
        results: Object.fromEntries(
          ids.filter((_id, i) => mode !== 'partial' || i === 0).map(target => [target, {status: 204}]),
        ),
        errors: mode === 'partial' ? {[ids[1]!]: {status: 403}} : {},
      });
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    1000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const prepare = (a = args()) => service.call('amcp_write', {action: 'prepare', gateway, arguments: a}, actor),
    execute = (r: JsonObject, extra: JsonObject = {}) =>
      service.call(
        'amcp_write',
        {
          action: 'execute',
          review_id: r.data.review_id,
          idempotency_key: r.data.idempotency_key,
          confirmed: true,
          spend_change_confirmed: true,
          ...extra,
        },
        actor,
      ),
    verify = (r: JsonObject) => service.call('amcp_campaign', {action: 'verify', review_id: r.data.review_id}, actor);
  return {
    store,
    c,
    calls,
    rules,
    campaigns,
    tags,
    service,
    prepare,
    execute,
    verify,
    writes: () => calls.filter(v => v.method === 'POST').length,
    setMode: (v: string) => (mode = v),
    setHook: (f: typeof hook) => (hook = f),
    setPageSize: (v: number) => (pageSize = v),
  };
}
test('LinkedIn single and batch conversion rules complete prepare, execute, exact read-back and replay', async () => {
  for (const mode of ['CREATE', 'BATCH_CREATE', 'PARTIAL_UPDATE', 'BATCH_PARTIAL_UPDATE']) {
    const f = fixture();
    try {
      const input = mode.includes('UPDATE')
        ? [
            {name: 'Changed rule', enabled: false, postClickAttributionWindowSize: 1},
            {name: 'Other changed rule', viewThroughAttributionWindowSize: 1},
          ]
        : [
            {name: 'Purchase', type: 'PURCHASE', enabled: false},
            {name: 'Download', type: 'DOWNLOAD', enabled: false},
          ];
      const r = await f.prepare(args(mode, input));
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal((await f.execute(r)).data.success, true);
      const verification = await f.verify(r);
      assert.equal(verification.data.status, 'verified', JSON.stringify(verification));
      assert.equal((await f.execute(r)).data.success, true);
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});
test('LinkedIn rule bodies bind exact accounts, native defaults and empty 201 receipts', async () => {
  const f = fixture();
  try {
    const a = args();
    delete a.query;
    a.payload.account = account;
    const r = await f.prepare(a);
    assert.equal(r.success, true, JSON.stringify(r));
    f.setMode('empty_201');
    assert.equal((await f.execute(r)).data.success, true);
    assert.equal((await f.verify(r)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});
test('LinkedIn rule schema refuses unsafe IDs, injected fields, unsupported actions and unreviewed campaign changes before egress', async () => {
  const f = fixture();
  try {
    const malformed = [
      {...args(), query: {account, autoAssociationType: 'ALL_CAMPAIGNS'}},
      {...args(), query: {account: 'urn:li:sponsoredAccount:999'}},
      {...args(), payload: {...args().payload, account: 'urn:li:sponsoredAccount:999'}},
      {...args(), restli_method: 'ACTION'},
      args('PARTIAL_UPDATE', [{campaigns: ['urn:li:sponsoredCampaign:456']}]),
      args('CREATE', [{name: 'Bad', type: 'INVALID'}]),
      args('CREATE', [{name: 'Bad', type: 'LEAD', postClickAttributionWindowSize: 90}]),
      args('CREATE', [{name: 'Bad', type: 'LEAD', value: {amount: 5, currencyCode: 'USD'}}]),
      args('CREATE', [{name: 'Bad', type: 'LEAD', value: {amount: 'NaN', currencyCode: 'USD'}}]),
      args('PARTIAL_UPDATE', [{lastCallbackAt: 1}]),
      {...args('PARTIAL_UPDATE'), payload: {patch: {$delete: ['value']}}},
      {...args('PARTIAL_UPDATE'), path_params: {conversion_id: 9007199254740992}},
      {...args('BATCH_PARTIAL_UPDATE', [{name: 'First'}, {name: 'Second'}]), query: {account, ids: ['789', '789']}},
      args('CREATE', [{name: 'Bad', type: 'LEAD', urlMatchRuleExpression: [[{matchType: 'REGEX', matchValue: '.*'}]]}]),
    ];
    for (const a of malformed) assert.equal((await f.prepare(a)).success, false, JSON.stringify(a));
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('LinkedIn rule creation checks the existing tag, account currency and complete collection', async () => {
  for (const mode of [
    'tag_missing',
    'tag_foreign',
    'account_foreign',
    'rule_foreign',
    'rule_duplicate',
    'partial',
    'metadata',
    'empty_next',
    'fixed_missing',
    'currency',
  ]) {
    const f = fixture();
    try {
      if (mode === 'tag_missing') f.tags.splice(0);
      if (mode === 'tag_foreign') f.tags[0]!.sponsoredAccounts = ['urn:li:sponsoredAccount:999'];
      if (mode === 'rule_foreign') f.rules['789'].account = 'urn:li:sponsoredAccount:999';
      f.setHook((u, d) => {
        if (mode === 'account_foreign' && u.pathname.includes('/adAccounts/')) d.id = 999;
        if (u.pathname === '/rest/conversions') {
          if (mode === 'rule_duplicate') d.elements.push(d.elements[0]);
          if (mode === 'partial') d.paging.total = 100;
          if (mode === 'metadata') d.metadata = {partial: true};
          if (mode === 'empty_next') {
            d.elements = [];
            d.paging.links = [{rel: 'next', href: 'https://example.com'}];
          }
        }
        return d;
      });
      const input =
        mode === 'fixed_missing'
          ? args('CREATE', [{name: 'Fixed', type: 'PURCHASE', valueType: 'FIXED'}])
          : mode === 'currency'
            ? args('CREATE', [{name: 'Value', type: 'PURCHASE', value: {amount: '10', currencyCode: 'EUR'}}])
            : args();
      assert.equal((await f.prepare(input)).success, false, mode);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('LinkedIn conversion telemetry and OR/AND ordering do not mask actual configuration drift', async () => {
  const f = fixture();
  try {
    const v = f.rules['789'];
    v.urlMatchRuleExpression = [
      [
        {matchType: 'CONTAINS', matchValue: '/success'},
        {matchType: 'STARTS_WITH', matchValue: 'example.com'},
      ],
      [{matchType: 'EXACT', matchValue: 'example.com/thanks'}],
    ];
    v.value = {amount: '10.000', currencyCode: 'USD'};
    const r = await f.prepare(args('PARTIAL_UPDATE', [{name: 'Rename'}]));
    assert.equal(r.success, true);
    v.urlMatchRuleExpression.reverse();
    v.urlMatchRuleExpression[1].reverse();
    v.value.amount = '10';
    v.lastCallbackAt = 789;
    assert.equal((await f.execute(r)).data.success, true);
    const another = await f.prepare(args('PARTIAL_UPDATE', [{name: 'Again'}]));
    v.postClickAttributionWindowSize = 1;
    const failed = await f.execute(another);
    assert.equal(failed.error.code, 'STATE_CHANGED');
    assert.match(JSON.stringify(failed.error.details.changed_fields), /postClickAttributionWindowSize/);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('LinkedIn rule updates freeze every associated campaign and reject absent or foreign membership', async () => {
  for (const mode of ['changed', 'foreign', 'missing_membership', 'unknown_config']) {
    const f = fixture();
    try {
      const v = f.rules['789'];
      v.campaigns = ['urn:li:sponsoredCampaign:456'];
      v.associatedCampaigns = [
        {campaign: v.campaigns[0], conversion: 'urn:lla:llaPartnerConversion:789', associatedAt: 1},
      ];
      if (mode === 'foreign') f.campaigns['456'].account = 'urn:li:sponsoredAccount:999';
      if (mode === 'missing_membership') delete v.campaigns;
      const r = await f.prepare(args('PARTIAL_UPDATE', [{enabled: false}]));
      if (['foreign', 'missing_membership'].includes(mode)) assert.equal(r.success, false, mode);
      else {
        assert.equal(r.success, true, JSON.stringify(r));
        if (mode === 'changed') f.campaigns['456'].dailyBudget.amount = '200';
        else v.futureMode = 'DIFFERENT';
        assert.equal((await f.execute(r)).error.code, 'STATE_CHANGED');
      }
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('LinkedIn rule scopes, grants, activation policy and confirmation remain current through execution', async () => {
  for (const mode of ['scope', 'grant', 'activation', 'confirmation', 'revoked', 'scope_revoked']) {
    const f = fixture();
    try {
      const r = await f.prepare(args('PARTIAL_UPDATE', [{enabled: false}]));
      assert.equal(r.success, true);
      if (mode === 'scope') f.store.putConnection(owner, {...f.c, scopes: ['r_ads']}, {accessToken: 'synthetic'});
      if (mode === 'grant') f.store.putConnection(owner, {...f.c, writeAccounts: []}, {accessToken: 'synthetic'});
      if (mode === 'activation')
        saveSpendPolicy(f.store, owner, {
          gateway,
          account_id: '123',
          policy: {allow_activation: false},
          confirmed: true,
        });
      if (mode === 'revoked' || mode === 'scope_revoked') f.setMode(mode);
      assert.equal(
        (await f.execute(r, mode === 'confirmation' ? {spend_change_confirmed: false} : {})).success,
        false,
        mode,
      );
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});
test('LinkedIn reported conversion value is not charged as advertising budget and disabled creation obeys policy', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: '123',
      policy: {allow_activation: false, max_budget_native: 0, max_daily_increase_native: 0},
      confirmed: true,
    });
    const r = await f.prepare(
      args('CREATE', [
        {
          name: 'Revenue',
          type: 'PURCHASE',
          enabled: false,
          value: {amount: '1000000.0000', currencyCode: 'USD'},
          valueType: 'FIXED',
        },
      ]),
    );
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal((await f.execute(r, {spend_change_confirmed: false})).data.success, true);
    f.rules['901'].value.amount = '1000000';
    assert.equal((await f.verify(r)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});
test('LinkedIn conversion partial batches, missing/foreign/duplicate receipts and lost responses retain their claim', async () => {
  for (const mode of ['partial', 'empty', 'lost', 'no_id', 'foreign', 'duplicate']) {
    const f = fixture();
    try {
      const a = ['partial', 'duplicate'].includes(mode)
        ? args('BATCH_CREATE', [
            {name: 'One', type: 'LEAD'},
            {name: 'Two', type: 'LEAD'},
          ])
        : args();
      const r = await f.prepare(a);
      assert.equal(r.success, true);
      f.setMode(mode);
      const out = await f.execute(r);
      assert.ok(!out.success || out.data.success === false, mode + JSON.stringify(out));
      await f.execute(r);
      assert.equal(f.writes(), 1);
      assert.notEqual((await f.verify(r)).data?.status, 'verified');
    } finally {
      f.store.close();
    }
  }
});
test('LinkedIn conversion no-op and pre-existing creation receipts cannot verify successful creation', async () => {
  for (const mode of ['ignored', 'preexisting']) {
    const f = fixture();
    try {
      const r = await f.prepare(mode === 'ignored' ? args('PARTIAL_UPDATE', [{name: 'Different'}]) : args());
      f.setMode(mode);
      assert.equal((await f.execute(r)).data.success, true);
      assert.notEqual((await f.verify(r)).data.status, 'verified');
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});
test('LinkedIn rule claims survive concurrent calls and SQLite reopen', async () => {
  for (const lost of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'amcp-li-rules-'));
    let f = fixture(join(dir, 'store.sqlite'));
    try {
      const r = await f.prepare();
      if (lost) f.setMode('lost');
      await Promise.all([f.execute(r), f.execute(r)]);
      assert.equal(f.writes(), 1);
      f.store.close();
      f = fixture(join(dir, 'store.sqlite'));
      const out = await f.execute(r);
      assert.equal(f.writes(), 0);
      if (lost) assert.equal(out.error.code, 'WRITE_OUTCOME_UNCERTAIN');
      else assert.equal(out.data.success, true);
    } finally {
      f.store.close();
      removeTestDirectory(dir, 'amcp-li-rules-');
    }
  }
});
test('LinkedIn rule verification checks current scope before its cache and cannot bypass review', async () => {
  const f = fixture();
  try {
    const r = await f.prepare();
    await f.execute(r);
    assert.equal((await f.verify(r)).data.status, 'verified');
    f.store.putConnection(owner, {...f.c, scopes: []}, {accessToken: 'synthetic'});
    assert.equal((await f.verify(r)).error.code, 'INSUFFICIENT_SCOPE');
    f.store.putConnection(owner, f.c, {accessToken: 'synthetic'});
    const direct = await f.service.call(
      gateway,
      {...args(), dry_run: false, confirmed: true, idempotency_key: '12345678-1234-4234-9234-123456789abc'},
      actor,
    );
    assert.equal(direct.error.code, 'WRITE_REVIEW_REQUIRED');
    const cross = await f.service.call(
      'amcp_campaign',
      {action: 'verify', review_id: r.data.review_id},
      {...actor, tenantId: 'elsewhere'},
    );
    assert.equal(cross.success, false);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('LinkedIn rule internal reads cannot be supplied by untrusted native callers', () => {
  const f = fixture();
  try {
    const p: CompiledRequest = {
      gateway,
      action: 'AMCP_LINKEDIN_RULE_READ',
      method: 'GET',
      path: '/rest/conversions/789',
      query: {account},
      headers: {},
      accountId: '123',
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'test',
      warnings: [],
    };
    assert.throws(() => new ScopeGuard(registry, f.store).authorize(p, f.c), /ownership/i);
  } finally {
    f.store.close();
  }
});
test('LinkedIn rule collection/page/byte/deadline bounds remain explicit', async t => {
  for (const mode of ['pages', 'bytes', 'partial_page', 'entry_error']) {
    const f = fixture();
    try {
      if (mode === 'pages') {
        f.setPageSize(1);
        for (let i = 1; i <= 26; i++) f.rules[String(i)] = make(String(i));
      }
      f.setHook((u, d) => {
        if (mode === 'bytes' && u.pathname === '/rest/conversions') d.elements[0].extra = 'x'.repeat(4 * 1024 * 1024);
        if (mode === 'partial_page' && u.pathname === '/rest/conversions') d.paging.partial = true;
        if (mode === 'entry_error' && u.pathname === '/rest/conversions') d.elements[0].errors = [];
        return d;
      });
      assert.equal((await f.prepare()).success, false, mode);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
  const p: CompiledRequest = {
    gateway,
    action: collection,
    method: 'POST',
    path: '/rest/conversions',
    query: {account},
    body: {name: 'New', type: 'LEAD'},
    headers: {'LinkedIn-Version': '202609', 'X-Restli-Protocol-Version': '2.0.0'},
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    accountId: '123',
    evidence: 'test',
    warnings: [],
  };
  let tick = 0;
  t.mock.method(performance, 'now', () => tick);
  await assert.rejects(
    () =>
      readLinkedInRules(linkedinRuleSnapshots(p)[0]!, async () => {
        tick = 60001;
        return {status: 200, headers: {}, data: {id: 123, currency: 'USD', status: 'ACTIVE'}};
      }),
    /time bound/,
  );
});
test('both captured conversion-rule POST routes carry their specific reviewed family', () => {
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && [single, collection].includes(r.action));
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.family === 'linkedin_conversion_rules' && r.status === 'reviewed_write_family'));
});

test('a newly created conversion can immediately enter an association review through fresh scoped reads', async () => {
  const f = fixture();
  try {
    const r = await f.prepare();
    assert.equal((await f.execute(r)).data.success, true);
    const reviewed = await f.prepare({
      action: 'linkedin_rest_campaign_conversions_campaign_conversion_id_put',
      account_id: '123',
      path_params: {
        campaign_conversion_id: '(campaign:urn:li:sponsoredCampaign:456,conversion:urn:lla:llaPartnerConversion:901)',
      },
      payload: {campaign: 'urn:li:sponsoredCampaign:456', conversion: 'urn:lla:llaPartnerConversion:901'},
    });
    assert.equal(reviewed.success, true, JSON.stringify(reviewed));
    assert.ok(f.calls.some(c => c.url.includes('/conversions/901?account=')));
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('LinkedIn batch update partial receipts retain successful changes and never replay the batch', async () => {
  const f = fixture();
  try {
    const r = await f.prepare(args('BATCH_PARTIAL_UPDATE', [{name: 'First updated'}, {name: 'Second updated'}]));
    f.setMode('partial');
    const out = await f.execute(r);
    assert.equal(out.data.success, false);
    assert.equal(f.rules['789'].name, 'First updated');
    assert.notEqual(f.rules['790'].name, 'Second updated');
    await f.execute(r);
    assert.equal(f.writes(), 1);
    assert.notEqual((await f.verify(r)).data?.status, 'verified');
  } finally {
    f.store.close();
  }
});
test('LinkedIn complete conversion pagination handles an exact final page, membership order and shared-tag order', async () => {
  const f = fixture();
  try {
    f.setPageSize(1);
    f.tags[0]!.sponsoredAccounts.push('urn:li:sponsoredAccount:999');
    f.setHook((_u, d) => {
      if (d.paging) delete d.paging.total;
      return d;
    });
    const r = await f.prepare();
    assert.equal(r.success, true, JSON.stringify(r));
    f.tags[0]!.sponsoredAccounts.reverse();
    assert.equal((await f.execute(r)).data.success, true);
    assert.equal((await f.verify(r)).data.status, 'verified');
    assert.ok(f.calls.some(c => c.url.includes('/conversions?') && c.url.includes('start=2')));
  } finally {
    f.store.close();
  }
});
test('LinkedIn creation and update enforce all-batch capacity and every affected campaign', async () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 999; i++) f.rules[String(i)] = make(String(i));
    delete f.rules['789'];
    delete f.rules['790'];
    f.rules['789'] = make('789');
    f.rules['790'] = make('790');
    const r = await f.prepare(
      args('BATCH_CREATE', [
        {name: 'First', type: 'LEAD'},
        {name: 'Second', type: 'LEAD'},
      ]),
    );
    assert.equal(r.error.code, 'INVALID_CONVERSION_RULE');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    const v = g.rules['789'];
    v.campaigns = Array.from({length: 51}, (_, i) => 'urn:li:sponsoredCampaign:' + String(i + 1));
    v.associatedCampaigns = v.campaigns.map((c: string) => ({
      campaign: c,
      conversion: 'urn:lla:llaPartnerConversion:789',
    }));
    assert.equal(
      (await g.prepare(args('PARTIAL_UPDATE', [{name: 'Renamed'}]))).error.code,
      'CONVERSION_RULE_STATE_UNVERIFIED',
    );
    assert.equal(g.writes(), 0);
  } finally {
    g.store.close();
  }
});
test('LinkedIn rule reviews do not switch to another connection with matching IDs', async () => {
  const f = fixture();
  try {
    const r = await f.prepare();
    f.store.putConnection(owner, {...f.c, id: 'c2', accounts: ['999'], writeAccounts: ['999']}, {accessToken: 'other'});
    const switched = await f.service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: r.data.review_id,
        idempotency_key: r.data.idempotency_key,
        connection_id: 'c2',
        confirmed: true,
        spend_change_confirmed: true,
      },
      actor,
    );
    assert.equal(switched.error.code, 'INVALID_ARGUMENT');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});
test('LinkedIn native omission of default valueType does not make creation impossible to verify', async () => {
  const f = fixture();
  try {
    const r = await f.prepare();
    await f.execute(r);
    delete f.rules['901'].valueType;
    assert.equal((await f.verify(r)).data.status, 'verified');
    const updated = await f.prepare(args('PARTIAL_UPDATE', [{name: 'New name'}]));
    assert.equal(updated.success, true);
    f.rules['789'].valueType = 'FIXED';
    f.rules['789'].value = {amount: '3', currencyCode: 'USD'};
    assert.equal((await f.execute(updated)).error.code, 'STATE_CHANGED');
  } finally {
    f.store.close();
  }
});
