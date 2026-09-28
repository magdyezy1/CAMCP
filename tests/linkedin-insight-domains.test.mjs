import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {parseLinkedInValue} from '../dist/src/linkedin-restli.js';

/**
 * LinkedIn Insight Tag domains ("Conversion Tracking", li-lms-2025-10 to li-lms-2026-09, checked 2026-09-27): blocking and
 * allowing the domains LinkedIn found for the tag of an ad account, one at a time or in a batch.
 */
const registry = new Registry(),
  gateway = 'linkedin_native_action';
const actor = {tenantId: 'linkedin-insight-domains', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const actions = {
  single: 'linkedin_rest_insight_tag_domains_insight_tag_domain_id_post',
  batch: 'linkedin_rest_insight_tag_domains_post',
};
const urn = id => 'urn:li:sponsoredAccount:' + id,
  key = (account, domainName) => '(account:' + urn(account) + ',domainName:' + domainName + ')';
const set = blocked => ({patch: {$set: {blocked}}});
function fixture(o = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 94).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'li',
      tenantId: actor.tenantId,
      gateway,
      enabled: true,
      accounts: ['507', '508', '509'],
      writeAccounts: ['507', '508', '509'],
      scopes: ['rw_ads'],
      label: 'Synthetic LinkedIn',
    },
    {accessToken: 'synthetic'},
  );
  // Account 508 owns tag 100 (FULL) and shares it with 509 (USE_ONLY); 507 has no tag.
  const tags = [{id: 100, sponsoredAccounts: [urn(508), urn(509)], firstPartyTrackingEnabled: true}];
  const roles = {
    508: [{insightTag: 'urn:li:insightTag:100', accessRole: 'FULL'}],
    509: [{insightTag: 'urn:li:insightTag:100', accessRole: 'USE_ONLY'}],
    507: [],
  };
  const domains = new Map([
    ['www.example.com', false],
    ['shop.example.com', false],
    ['old.example.net', true],
  ]);
  let writes = 0,
    callback = 1560228798550;
  const calls = [];
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET',
      headers = new Headers(init?.headers);
    calls.push({method, path: url.pathname, search: url.search, restli: headers.get('x-restli-method')});
    assert.equal(headers.get('x-restli-protocol-version'), '2.0.0');
    const a = /^\/rest\/adAccounts\/(\d+)$/.exec(url.pathname);
    if (method === 'GET' && a) return Response.json({id: Number(a[1]), status: 'ACTIVE', currency: 'USD'});
    if (method === 'GET' && url.pathname === '/rest/insightTags')
      return Response.json({
        elements: tags.filter(t => t.sponsoredAccounts.includes(url.searchParams.get('account'))),
        paging: {count: 10, start: 0, links: []},
      });
    if (method === 'GET' && url.pathname === '/rest/insightTagsPermission')
      return Response.json({
        elements: roles[url.searchParams.get('account').split(':').at(-1)] ?? [],
        paging: {count: 10, start: 0, links: []},
      });
    if (method === 'GET' && url.pathname === '/rest/insightTagDomains') {
      const acct = url.searchParams.get('account'),
        name = url.searchParams.get('domainName');
      assert.equal(url.searchParams.get('q'), 'account');
      const listed = tags.some(t => t.sponsoredAccounts.includes(acct)) && domains.has(name);
      // The callback time moves with traffic between reads.
      return Response.json({
        elements: listed
          ? [
              {
                created: 1560228798550,
                blocked: domains.get(name),
                lastCallbackAt: callback++,
                domainName: name,
                insightTag: 'urn:tscp:insightTag:100',
              },
            ]
          : [],
        paging: {count: 10, start: 0, links: []},
      });
    }
    writes++;
    const b = JSON.parse(String(init.body));
    if (url.pathname === '/rest/insightTagDomains') {
      assert.equal(headers.get('x-restli-method'), 'BATCH_PARTIAL_UPDATE');
      const ids = parseLinkedInValue(url.searchParams.get('ids'));
      assert.deepEqual(
        Object.keys(b.entities).map(k => parseLinkedInValue(k)),
        ids,
      );
      if (o.mode === 'partial') {
        const [first, ...rest] = Object.keys(b.entities);
        domains.set(ids[0].domainName, b.entities[first].patch.$set.blocked);
        return Response.json({
          results: {[first]: {status: 204}},
          errors: Object.fromEntries(rest.map(k => [k, {status: 403, message: 'Not allowed'}])),
        });
      }
      if (o.mode !== 'ignore')
        for (const [k, v] of Object.entries(b.entities))
          domains.set(parseLinkedInValue(k).domainName, v.patch.$set.blocked);
      return Response.json({
        results: Object.fromEntries(Object.keys(b.entities).map(k => [k, {status: 204}])),
        errors: {},
      });
    }
    const single = /^\/rest\/insightTagDomains\/(.+)$/.exec(url.pathname);
    if (single) {
      const k = parseLinkedInValue(single[1]);
      if (o.mode !== 'ignore') domains.set(k.domainName, b.patch.$set.blocked);
      return new Response(null, {status: 204});
    }
    throw Error('Unexpected ' + method + ' ' + url.pathname);
  };
  const service = new MirrorService(registry, store, new NativeTransport(fetcher), undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const one = (account, k, body, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: actions.single,
          account_id: account,
          path_params: {insight_tag_domain_id: k},
          payload: body,
          ...extra,
        },
      },
      actor,
    );
  const many = (account, ids, entities, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action: actions.batch,
          account_id: account,
          restli_method: 'BATCH_PARTIAL_UPDATE',
          query: {ids},
          payload: {entities},
          ...extra,
        },
      },
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, domains, one, many, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('the tag owner blocks one domain and allows and blocks two in a batch, each verified with the reference key encoding; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const p = ok(await f.one('508', key(508, 'www.example.com'), set(true)));
    assert.equal(p.data.creative_impact.scope, 'insight_tag_domain');
    assert.equal(p.data.creative_impact.may_affect_serving, true);
    assert.deepEqual(p.data.creative_impact.shared_with, [urn(508), urn(509)]);
    assert.match(p.data.creative_impact.effect, /no longer captured/);
    ok(await f.execute(p));
    assert.equal(f.domains.get('www.example.com'), true);
    assert.ok(
      f.calls.some(
        c =>
          c.method === 'POST' &&
          c.path === '/rest/insightTagDomains/(account:urn%3Ali%3AsponsoredAccount%3A508,domainName:www.example.com)',
      ),
      JSON.stringify(f.calls.filter(c => c.method === 'POST')),
    );
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const ids = [
      {account: urn(508), domainName: 'old.example.net'},
      {account: urn(508), domainName: 'shop.example.com'},
    ];
    const b = ok(
      await f.many('508', ids, {[key(508, 'old.example.net')]: set(false), [key(508, 'shop.example.com')]: set(true)}),
    );
    assert.deepEqual(
      b.data.creative_impact.domains.map(d => [d.domainName, d.before, d.after]),
      [
        ['old.example.net', true, false],
        ['shop.example.com', false, true],
      ],
    );
    ok(await f.execute(b));
    assert.equal(f.domains.get('old.example.net'), false);
    assert.equal(f.domains.get('shop.example.com'), true);
    assert.equal(ok(await f.verify(b)).data.status, 'verified');
    // The reference's own encoded key form is accepted too; allowing needs no serving warning.
    const e = ok(
      await f.one('508', '(account:urn%3Ali%3AsponsoredAccount%3A508,domainName:www.example.com)', set(false), {
        restli_method: 'PARTIAL_UPDATE',
      }),
    );
    assert.equal(e.data.creative_impact.may_affect_serving, false);
    ok(await f.execute(e));
    assert.equal(ok(await f.verify(e)).data.status, 'verified');
    assert.equal(f.writes(), 3);
  } finally {
    f.store.close();
  }
});

test('malformed domain updates are refused before any request; accounts without the tag or FULL access, unknown domains and unchanged values after reading', async () => {
  const k = key(508, 'www.example.com'),
    ids = [{account: urn(508), domainName: 'www.example.com'}];
  const cases = [
    ['another account in the key', f => f.one('508', key(509, 'www.example.com'), set(true))],
    ['key without a domain', f => f.one('508', '(account:' + urn(508) + ')', set(true))],
    ['domain with a protocol', f => f.one('508', key(508, 'https://www.example.com'), set(true))],
    ['not a boolean', f => f.one('508', k, set('true'))],
    ['another field', f => f.one('508', k, {patch: {$set: {blocked: true, domainName: 'x.example.com'}}})],
    ['removal instead of a set', f => f.one('508', k, {patch: {$delete: ['blocked']}})],
    ['a query on a single update', f => f.one('508', k, set(true), {query: {fields: 'blocked'}})],
    ['a batch without the batch method', f => f.many('508', ids, {[k]: set(true)}, {restli_method: 'PARTIAL_UPDATE'})],
    [
      'an entity that is not an id',
      f => f.many('508', ids, {[k]: set(true), [key(508, 'shop.example.com')]: set(true)}),
    ],
    [
      'an id without an entity',
      f => f.many('508', [...ids, {account: urn(508), domainName: 'shop.example.com'}], {[k]: set(true)}),
    ],
    ['a repeated id', f => f.many('508', [ids[0], ids[0]], {[k]: set(true)})],
    [
      'twenty-one domains',
      f =>
        f.many(
          '508',
          Array.from({length: 21}, (_, i) => ({account: urn(508), domainName: 'd' + i + '.example.com'})),
          Object.fromEntries(Array.from({length: 21}, (_, i) => [key(508, 'd' + i + '.example.com'), set(true)])),
        ),
    ],
  ];
  for (const [label, run] of cases) {
    const f = fixture();
    try {
      const r = await run(f);
      assert.equal(r.error?.code, 'INVALID_LINKEDIN_INSIGHT_DOMAIN', label + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal((await f.one('507', key(507, 'www.example.com'), set(true))).error?.code, 'STATE_NOT_FOUND');
    assert.equal((await f.one('509', key(509, 'www.example.com'), set(true))).error?.code, 'ACCOUNT_SCOPE_MISMATCH');
    assert.equal((await f.one('508', key(508, 'unknown.example.org'), set(true))).error?.code, 'STATE_NOT_FOUND');
    assert.equal(
      (await f.one('508', key(508, 'old.example.net'), set(true))).error?.code,
      'INVALID_LINKEDIN_INSIGHT_DOMAIN',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a batch with errors is never resubmitted, ignored updates are not verified, and the ledger lists both writes', async () => {
  const e = fixture({mode: 'partial'});
  try {
    const ids = [
      {account: urn(508), domainName: 'www.example.com'},
      {account: urn(508), domainName: 'shop.example.com'},
    ];
    const p = ok(
      await e.many('508', ids, {[key(508, 'www.example.com')]: set(true), [key(508, 'shop.example.com')]: set(true)}),
    );
    assert.equal((await e.execute(p)).success, false);
    assert.equal((await e.execute(p)).success, false);
    assert.equal(e.writes(), 1);
  } finally {
    e.store.close();
  }
  const g = fixture({mode: 'ignore'});
  try {
    for (const p of [
      ok(await g.one('508', key(508, 'www.example.com'), set(true))),
      ok(
        await g.many('508', [{account: urn(508), domainName: 'old.example.net'}], {
          [key(508, 'old.example.net')]: set(false),
        }),
      ),
    ]) {
      ok(await g.execute(p));
      assert.notEqual(ok(await g.verify(p)).data.status, 'verified');
    }
  } finally {
    g.store.close();
  }
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'linkedin_insight_tag_domains', action);
  }
});
