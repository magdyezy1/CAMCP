import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeTestDirectory} from '../dist/tests/temp.js';
import {readLinkedInTemplateState} from '../dist/src/linkedin-audience-templates.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {readFileSync} from 'node:fs';

const registry = new Registry(),
  gateway = 'linkedin_native_action',
  actor = {tenantId: 'template-test', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const actions = {
  create: 'linkedin_rest_ad_target_templates_post',
  update: 'linkedin_rest_ad_target_templates_template_id_post',
  delete: 'linkedin_rest_ad_target_templates_template_id_delete',
  batch: 'linkedin_rest_ad_target_templates_delete',
};
const account = 'urn:li:sponsoredAccount:123',
  facet = n => 'urn:li:adTargetingFacet:' + n;
const targeting = () => ({
  include: {
    and: [
      {or: {[facet('locations')]: ['urn:li:country:sa']}},
      {or: {[facet('interfaceLocales')]: ['urn:li:locale:en_US']}},
    ],
  },
});
const body = () => ({
  name: 'Reusable KSA audience',
  account,
  targetingCriteria: targeting(),
  description: 'A synthetic saved audience',
});
const args = (kind = 'create') => ({
  action: actions[kind],
  account_id: '123',
  ...(kind === 'update' || kind === 'delete' ? {path_params: {template_id: '456'}} : {}),
  ...(kind === 'create'
    ? {payload: body()}
    : kind === 'update'
      ? {restli_method: 'PARTIAL_UPDATE', payload: {patch: {$set: {name: 'Renamed audience'}}}}
      : kind === 'batch'
        ? {query: {ids: ['456', '457']}}
        : {}),
});
function fixture(o = {}) {
  const store = new Store(o.db ?? ':memory:', Buffer.alloc(32, 81).toString('base64'));
  const connection = {
    id: o.connectionId ?? 'li',
    tenantId: actor.tenantId,
    gateway,
    enabled: true,
    accounts: ['123'],
    writeAccounts: ['123'],
    scopes: ['rw_ads'],
    label: 'Synthetic template account',
  };
  store.putConnection(admin, connection, {accessToken: 'synthetic'});
  const state = {
      account: {id: 123, currency: 'USD', status: 'ACTIVE', name: 'Synthetic'},
      templates: [
        {...body(), id: 456},
        {...body(), name: 'Another audience', id: 457},
      ],
      segments: {},
    },
    calls = [];
  let writes = 0,
    reads = 0;
  const fetcher = async (raw, init) => {
    const url = new URL(String(raw)),
      method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: init?.body,
      headers: init?.headers,
    });
    if (method === 'GET') {
      reads++;
      await o.beforeRead?.(url, state, store, reads);
      let data;
      if (url.pathname === '/rest/adAccounts/123') data = state.account;
      else if (url.pathname === '/rest/adTargetTemplates') {
        assert.equal(url.searchParams.get('q'), 'account');
        assert.equal(url.searchParams.get('account'), account);
        assert.equal(url.searchParams.get('sortField'), 'ID');
        const start = Number(url.searchParams.get('start') ?? 0),
          count = o.pageSize ?? Number(url.searchParams.get('count') ?? 100),
          all = [...state.templates].sort((a, b) => Number(a.id) - Number(b.id));
        data = {elements: all.slice(start, start + count), paging: {start, count, total: all.length, links: []}};
      } else if (url.pathname.startsWith('/rest/adTargetTemplates/'))
        data = state.templates.find(r => String(r.id) === url.pathname.split('/').at(-1));
      else if (url.pathname.startsWith('/rest/adSegments/')) data = state.segments[url.pathname.split('/').at(-1)];
      else throw Error('Unexpected synthetic read ' + url.pathname);
      const transformed = await o.read?.(url, structuredClone(data), state, store, reads);
      if (transformed instanceof Response) return transformed;
      if (data === undefined)
        return Response.json({status: 404, serviceErrorCode: 100, message: 'Key not found'}, {status: 404});
      return Response.json(transformed ?? data);
    }
    writes++;
    const data = init.body ? JSON.parse(String(init.body)) : undefined;
    await o.beforeWrite?.(state, store, data);
    const id = url.pathname.split('/').at(-1);
    let receipt;
    if (method === 'POST' && url.pathname === '/rest/adTargetTemplates') {
      state.templates.push({
        ...data,
        id: 789,
        created: {time: 1},
        lastModified: {time: 1},
        approximateMemberCount: 1234,
      });
      receipt = new Response(null, {status: 201, headers: {'x-restli-id': '789'}});
    } else if (method === 'POST') {
      assert.equal(init.headers['X-RestLi-Method'], 'PARTIAL_UPDATE');
      Object.assign(
        state.templates.find(r => String(r.id) === id),
        data.patch.$set,
      );
      receipt = new Response(null, {status: 204});
    } else if (method === 'DELETE' && url.pathname === '/rest/adTargetTemplates') {
      const ids = url.searchParams.get('ids').slice(5, -1).split(',');
      state.templates = state.templates.filter(r => !ids.includes(String(r.id)));
      receipt = Response.json({results: Object.fromEntries(ids.map(id => [id, {status: 204}])), errors: {}});
    } else if (method === 'DELETE') {
      state.templates = state.templates.filter(r => String(r.id) !== id);
      receipt = new Response(null, {status: 204});
    } else throw Error('Unexpected mutation ' + method);
    return (await o.receipt?.(receipt, state, store)) ?? receipt;
  };
  const service = new MirrorService(registry, store, new NativeTransport(fetcher, async () => {}), undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (input = args(), who = actor) =>
    service.call('amcp_write', {action: 'prepare', gateway, arguments: input}, who);
  const execute = (r, who = actor, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: r.data.review_id,
        idempotency_key: r.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      who,
    );
  const verify = r => service.call('amcp_campaign', {action: 'verify', review_id: r.data.review_id}, actor);
  return {store, service, connection, state, calls, prepare, execute, verify, writes: () => writes, reads: () => reads};
}
test('LinkedIn saved audience create uses its account and returns a verified template without activating a campaign', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    const r = await f.execute(p);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.success, true, JSON.stringify(r));
    assert.equal(f.writes(), 1);
    const v = await f.verify(p);
    assert.equal(v.data?.status, 'verified', JSON.stringify(v));
    await f.execute(p);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});
test('LinkedIn saved audience partial update and single/batch deletion verify exact scoped final state', async () => {
  for (const kind of ['update', 'delete', 'batch']) {
    const f = fixture();
    try {
      const p = await f.prepare(args(kind));
      assert.equal(p.success, true, JSON.stringify(p));
      const r = await f.execute(p);
      assert.equal(r.data?.success, true, JSON.stringify(r));
      const v = await f.verify(p);
      assert.equal(v.data?.status, 'verified', JSON.stringify(v));
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn template contracts preserve the exact native body, partial-update header and ID list', async () => {
  for (const kind of ['create', 'update', 'delete', 'batch']) {
    const f = fixture();
    try {
      const a = args(kind),
        p = await f.prepare(a);
      assert.equal(p.success, true, JSON.stringify(p));
      await f.execute(p);
      const c = f.calls.find(c => c.method !== 'GET');
      assert.deepEqual(c.body ? JSON.parse(c.body) : undefined, a.payload);
      assert.equal(c.headers['X-Restli-Protocol-Version'], '2.0.0');
      assert.equal(c.headers['LinkedIn-Version'], '202605');
      if (kind === 'update') assert.equal(c.headers['X-RestLi-Method'], 'PARTIAL_UPDATE');
      if (kind === 'batch') assert.equal(c.query.ids, 'List(456,457)');
      assert.equal(
        f.calls.some(c => /adCampaigns|adCreatives/.test(c.path)),
        false,
      );
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn templates reject malformed, immutable and unqualified requests before reads', async () => {
  const invalid = [
    {...args(), payload: {...body(), account: 'urn:li:sponsoredAccount:999'}},
    {...args(), payload: {...body(), id: 100}},
    {...args(), payload: {...body(), name: ''}},
    {...args(), payload: {...body(), name: 'x'.repeat(101)}},
    {...args(), payload: {...body(), description: 'x'.repeat(501)}},
    {...args(), payload: {...body(), name: 'bad\u0001'}},
    {...args(), payload: {...body(), targetingCriteria: {include: {and: []}}}},
    {
      ...args(),
      payload: {...body(), targetingCriteria: {include: {and: [{or: {[facet('invented')]: ['urn:li:unknown:1']}}]}}},
    },
    {
      ...args(),
      payload: {
        ...body(),
        targetingCriteria: {include: {and: [{or: {[facet('locations')]: ['urn:li:country:sa', 'urn:li:country:sa']}}]}},
      },
    },
    {
      ...args(),
      payload: {
        ...body(),
        targetingCriteria: {include: {and: [targeting().include.and[0], targeting().include.and[0]]}},
      },
    },
    {...args('update'), restli_method: 'UPDATE'},
    {...args('update'), payload: {patch: {$set: {account}}}},
    {...args('update'), payload: {patch: {$delete: ['name']}}},
    {...args('update'), payload: {patch: {$set: {}}}},
    {...args('delete'), payload: {name: 'extra'}},
    {...args('batch'), query: {ids: []}},
    {...args('batch'), query: {ids: ['456', '456']}},
    {...args('batch'), query: {ids: Array.from({length: 26}, (_, i) => String(i + 1))}},
    {...args('batch'), query: {ids: ['../456']}},
    {...args(), query: {action: 'alternate'}},
    {...args(), restli_method: 'PARTIAL_UPDATE'},
  ];
  const f = fixture();
  try {
    for (const a of invalid) {
      const p = await f.prepare(a);
      assert.equal(p.success, false, JSON.stringify(a));
    }
    assert.equal(f.reads(), 0);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('LinkedIn templates preserve Unicode, empty descriptions, empty exclusions and exact large IDs', async () => {
  const f = fixture();
  try {
    const a = args();
    a.payload.name = '😀'.repeat(100);
    a.payload.description = '';
    a.payload.targetingCriteria.exclude = {};
    const p = await f.prepare(a);
    assert.equal(p.success, true, JSON.stringify(p));
    await f.execute(p);
    assert.equal((await f.verify(p)).data.status, 'verified');
    assert.equal(f.state.templates.at(-1).name, a.payload.name);
    f.state.templates[0].id = '9007199254740993';
    const d = args('delete');
    d.path_params.template_id = '9007199254740993';
    const q = await f.prepare(d);
    assert.equal(q.success, true, JSON.stringify(q));
    await f.execute(q);
    assert.equal((await f.verify(q)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('LinkedIn templates reject incompatible native AND groups and target-count limits', async () => {
  const f = fixture();
  try {
    for (const clauses of [
      [{or: {[facet('employers')]: ['urn:li:organization:1']}}, {or: {[facet('industries')]: ['urn:li:industry:1']}}],
      [{or: {[facet('titles')]: ['urn:li:title:1']}}, {or: {[facet('seniorities')]: ['urn:li:seniority:1']}}],
      [{or: {[facet('dynamicSegments')]: ['urn:li:adSegment:1']}}, {or: {[facet('interests')]: ['urn:li:interest:1']}}],
      [{or: {[facet('skills')]: Array.from({length: 101}, (_, i) => 'urn:li:skill:' + (i + 1))}}],
    ]) {
      const a = args();
      a.payload.targetingCriteria = {include: {and: clauses}};
      const p = await f.prepare(a);
      assert.equal(p.success, false, JSON.stringify(p));
    }
    assert.equal(f.reads(), 0);
  } finally {
    f.store.close();
  }
});

test('LinkedIn saved templates paginate the complete collection before and after writes', async () => {
  const f = fixture({pageSize: 1});
  try {
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    await f.execute(p);
    assert.equal((await f.verify(p)).data.status, 'verified');
    assert.ok(f.calls.some(c => c.query.start === '2'));
    assert.ok(
      f.calls
        .filter(c => c.method === 'GET' && c.path === '/rest/adTargetTemplates')
        .every(c => c.query.count === '100'),
    );
  } finally {
    f.store.close();
  }
});

test('LinkedIn template pagination allows native empty collections with zero returned count', async () => {
  const f = fixture({
    read: (u, d) => {
      if (u.pathname === '/rest/adTargetTemplates' && d.elements.length === 0) d.paging.count = 0;
      return d;
    },
  });
  try {
    f.state.templates = [];
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    await f.execute(p);
    assert.equal((await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('LinkedIn templates handle absent totals and never follow provider-controlled paging URLs', async () => {
  const f = fixture({
    pageSize: 1,
    read: (u, d, s) => {
      if (u.pathname === '/rest/adTargetTemplates') {
        delete d.paging.total;
        d.paging.links =
          Number(u.searchParams.get('start')) + d.elements.length < s.templates.length
            ? [{rel: 'next', href: 'https://127.0.0.1/private', type: 'application/json'}]
            : [];
      }
      return d;
    },
  });
  try {
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    await f.execute(p);
    assert.equal((await f.verify(p)).data.status, 'verified');
    assert.equal(
      f.calls
        .filter(c => c.method === 'GET')
        .every(c => ['/rest/adAccounts/123', '/rest/adTargetTemplates'].includes(c.path)),
      true,
    );
  } finally {
    f.store.close();
  }
});

test('LinkedIn templates reject incomplete, duplicate, foreign and ambiguous collection envelopes', async () => {
  for (const mode of [
    'paging',
    'start',
    'count',
    'missing',
    'duplicate',
    'foreign',
    'unsafe_id',
    'total',
    'next_empty',
    'metadata',
    'partial',
    'error',
    'row_error',
    'account',
  ]) {
    const f = fixture({
      read: (u, d) => {
        if (mode === 'account' && u.pathname === '/rest/adAccounts/123') d.id = 999;
        if (u.pathname !== '/rest/adTargetTemplates') return d;
        if (mode === 'paging') delete d.paging;
        if (mode === 'start') d.paging.start = 10;
        if (mode === 'count') d.paging.count = 101;
        if (mode === 'missing') delete d.elements;
        if (mode === 'duplicate') d.elements.push(d.elements[0]);
        if (mode === 'foreign') d.elements[0].account = 'urn:li:sponsoredAccount:999';
        if (mode === 'unsafe_id') d.elements[0].id = 9007199254740992;
        if (mode === 'total') d.paging.total = 100;
        if (mode === 'next_empty') {
          d.elements = [];
          d.paging.links = [{rel: 'next', href: '/rest/adTargetTemplates'}];
        }
        if (mode === 'metadata') d.metadata = {partial: true};
        if (mode === 'partial') d.partial = true;
        if (mode === 'error') d.serviceErrorCode = 1;
        if (mode === 'row_error') d.elements[0].error = 'failed';
        return d;
      },
    });
    try {
      const p = await f.prepare();
      assert.equal(p.success, false, mode + JSON.stringify(p));
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn template state ignores audience estimates and Boolean set order while retaining true changes', async () => {
  for (const mode of ['telemetry', 'name', 'criteria', 'unknown', 'version', 'sibling', 'account']) {
    const f = fixture();
    try {
      f.state.templates[0].unknownOrdered = ['a', 'b'];
      f.state.templates[0].versionTag = 'one';
      const p = await f.prepare(args('update'));
      assert.equal(p.success, true, JSON.stringify(p));
      if (mode === 'telemetry') {
        f.state.templates.reverse();
        for (const row of f.state.templates) {
          row.created = {time: 2};
          row.lastModified = {time: 3};
          row.approximateMemberCount = 9999;
          row.targetingCriteria.include.and.reverse();
        }
      }
      if (mode === 'name') f.state.templates[0].name = 'changed';
      if (mode === 'criteria')
        f.state.templates[0].targetingCriteria.include.and[0].or[facet('locations')] = ['urn:li:country:ae'];
      if (mode === 'unknown') f.state.templates[0].unknownOrdered.reverse();
      if (mode === 'version') f.state.templates[0].versionTag = 'two';
      if (mode === 'sibling') f.state.templates[1].name = 'changed';
      if (mode === 'account') f.state.account.status = 'CANCELED';
      const r = await f.execute(p);
      if (mode === 'telemetry') {
        assert.equal(r.success, true, JSON.stringify(r));
        assert.equal((await f.verify(p)).data.status, 'verified');
      } else {
        assert.equal(r.error.code, 'STATE_CHANGED', JSON.stringify(r));
        assert.ok(
          r.error.details.changed_fields.some(k =>
            k.includes(
              {
                name: 'name',
                criteria: 'targetingCriteria',
                unknown: 'unknownOrdered',
                version: 'versionTag',
                sibling: 'name',
                account: 'status',
              }[mode],
            ),
          ),
        );
        assert.equal(f.writes(), 0);
      }
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn template dependency reads detect a race during the initial complete snapshot', async () => {
  const f = fixture({
    beforeRead: (_u, s, _store, n) => {
      if (n === 3) s.templates[1].name = 'Concurrent update';
    },
  });
  try {
    const p = await f.prepare();
    assert.equal(p.error.code, 'LINKEDIN_TEMPLATE_STATE_UNVERIFIED', JSON.stringify(p));
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('LinkedIn templates require every edited or deleted ID to belong to the selected account', async () => {
  for (const kind of ['update', 'delete', 'batch']) {
    const f = fixture();
    try {
      f.state.templates = f.state.templates.filter(r => r.id !== 456);
      const p = await f.prepare(args(kind));
      assert.equal(p.success, false);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn templates require exact ownership and ready compatible private segment references', async () => {
  for (const mode of ['valid', 'retargeting', 'archived', 'foreign', 'missing_owner', 'missing', 'building', 'type']) {
    const f = fixture();
    try {
      const a = args(),
        dynamic = mode === 'retargeting';
      a.payload.targetingCriteria.include.and.push({
        or: {[facet(dynamic ? 'dynamicSegments' : 'audienceMatchingSegments')]: ['urn:li:adSegment:88']},
      });
      f.state.segments['88'] = {
        id: 88,
        account,
        name: 'Synthetic segment',
        status: mode === 'archived' ? 'ARCHIVED' : mode === 'building' ? 'BUILDING' : 'READY',
        type: dynamic ? 'RETARGETING' : 'BULK',
        approximateMemberCount: 4000,
      };
      if (mode === 'foreign') f.state.segments['88'].account = 'urn:li:sponsoredAccount:999';
      if (mode === 'missing_owner') delete f.state.segments['88'].account;
      if (mode === 'missing') delete f.state.segments['88'];
      if (mode === 'type') f.state.segments['88'].type = 'RETARGETING';
      const p = await f.prepare(a);
      if (['valid', 'retargeting', 'archived'].includes(mode)) {
        assert.equal(p.success, true, JSON.stringify(p));
        f.state.segments['88'].approximateMemberCount++;
        await f.execute(p);
        assert.equal((await f.verify(p)).data.status, 'verified');
        assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM resource_ownership').get().n, 0);
      } else {
        assert.equal(p.success, false, JSON.stringify(p));
        assert.equal(f.writes(), 0);
      }
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn templates freeze private segment readiness and exclude private member-list reads', async () => {
  const f = fixture();
  try {
    const a = args();
    a.payload.targetingCriteria.exclude = {or: {[facet('audienceMatchingSegments')]: ['urn:li:adSegment:88']}};
    f.state.segments['88'] = {id: 88, account, name: 'Private', status: 'READY', type: 'BULK'};
    const p = await f.prepare(a);
    assert.equal(p.success, true, JSON.stringify(p));
    f.state.segments['88'].status = 'EXPIRED';
    const r = await f.execute(p);
    assert.equal(r.success, false);
    assert.equal(f.writes(), 0);
    assert.equal(
      f.calls.some(c => /users|members/.test(c.path)),
      false,
    );
  } finally {
    f.store.close();
  }
});

test('LinkedIn templates reject too many private references before egress', async () => {
  const f = fixture();
  try {
    const a = args();
    a.payload.targetingCriteria.include.and.push({
      or: {[facet('audienceMatchingSegments')]: Array.from({length: 26}, (_, i) => 'urn:li:adSegment:' + (i + 1))},
    });
    const p = await f.prepare(a);
    assert.equal(p.success, false, JSON.stringify(p));
    assert.equal(f.reads(), 0);
  } finally {
    f.store.close();
  }
});

test('LinkedIn templates require unexpired immutable reviews, current grants, write scope and confirmation', async () => {
  for (const mode of [
    'grant',
    'scope',
    'connection',
    'reader',
    'tenant',
    'user',
    'confirm',
    'tamper',
    'expiry',
    'deletion',
  ]) {
    const f = fixture();
    try {
      const p = await f.prepare(mode === 'deletion' ? args('delete') : args());
      assert.equal(p.success, true, JSON.stringify(p));
      if (['grant', 'scope', 'connection'].includes(mode))
        f.store.putConnection(
          admin,
          {
            ...f.connection,
            ...(mode === 'grant' ? {writeAccounts: []} : mode === 'scope' ? {scopes: ['r_ads']} : {enabled: false}),
          },
          {accessToken: 'synthetic'},
        );
      if (mode === 'deletion')
        saveSpendPolicy(f.store, admin, {gateway, account_id: '123', policy: {allow_deletion: false}, confirmed: true});
      if (mode === 'tamper' || mode === 'expiry') {
        const review = f.store.document(actor.tenantId, 'write_review', p.data.review_id);
        if (mode === 'tamper') review.plan.body.name = 'tampered';
        else review.expires_at = 0;
        f.store.putDocument(actor.tenantId, 'write_review', p.data.review_id, review);
      }
      const who =
        mode === 'reader'
          ? {...actor, role: 'reader'}
          : mode === 'tenant'
            ? {...actor, tenantId: 'other'}
            : mode === 'user'
              ? {...actor, userId: 'other'}
              : actor;
      const r = await f.execute(p, who, mode === 'confirm' ? {confirmed: false} : {});
      assert.equal(r.success, false, mode + JSON.stringify(r));
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

for (const mode of ['login', 'account', 'write_grant', 'scope', 'actor'])
  test('LinkedIn template execution stops after in-flight ' + mode + ' withdrawal', async () => {
    let active = false;
    const f = fixture({
      read: (u, d, s, store) => {
        if (active) {
          active = false;
          const c = store.listConnections(actor.tenantId)[0];
          if (mode === 'actor')
            store.assertActorActive = () => {
              throw Error('Synthetic withdrawn actor');
            };
          else
            store.putConnection(
              admin,
              {
                ...c,
                ...(mode === 'account'
                  ? {accounts: ['999'], writeAccounts: []}
                  : mode === 'write_grant'
                    ? {writeAccounts: []}
                    : mode === 'scope'
                      ? {scopes: ['r_ads']}
                      : {}),
              },
              {accessToken: mode === 'login' ? 'replacement' : 'synthetic'},
            );
        }
        return d;
      },
    });
    try {
      const p = await f.prepare();
      assert.equal(p.success, true);
      const before = f.reads();
      active = true;
      const r = await f.execute(p);
      assert.equal(r.success, false, JSON.stringify(r));
      assert.equal(f.reads(), before + 1);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  });

test('LinkedIn template create validates native status and new receipt IDs without uncertain resubmission', async () => {
  for (const mode of ['missing_id', 'old_id', 'bad_id', 'wrong_status', 'body_error', 'lost']) {
    const f = fixture({
      receipt: r => {
        if (mode === 'lost') throw Error('Synthetic accepted response lost');
        if (mode === 'body_error')
          return Response.json({error: 'native error'}, {status: 201, headers: {'x-restli-id': '789'}});
        return new Response(null, {
          status: mode === 'wrong_status' ? 200 : 201,
          headers:
            mode === 'missing_id'
              ? {}
              : {
                  'x-restli-id':
                    mode === 'old_id' ? '456' : mode === 'bad_id' ? 'urn:li:adTargetingTemplate:789' : '789',
                },
        });
      },
    });
    try {
      const p = await f.prepare();
      assert.equal(p.success, true);
      const r = await f.execute(p);
      assert.ok(!r.success || !r.data.success, mode + JSON.stringify(r));
      await f.execute(p);
      assert.equal(f.writes(), 1);
      assert.notEqual((await f.verify(p)).data?.status, 'verified');
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn template batch receipts require exactly one successful result per requested ID', async () => {
  for (const mode of ['missing', 'extra', 'partial', 'failed', 'malformed', 'status']) {
    const f = fixture({
      receipt: () => {
        const d = {results: {456: {status: 204}, 457: {status: 204}}, errors: {}};
        if (mode === 'missing') delete d.results['457'];
        if (mode === 'extra') d.results['999'] = {status: 204};
        if (mode === 'partial') d.errors['457'] = {status: 404};
        if (mode === 'failed') d.results['457'].status = 500;
        if (mode === 'malformed') d.results['457'].extra = true;
        return Response.json(d, {status: mode === 'status' ? 202 : 200});
      },
    });
    try {
      const p = await f.prepare(args('batch'));
      assert.equal(p.success, true);
      const r = await f.execute(p);
      assert.ok(!r.success || !r.data.success, mode + JSON.stringify(r));
      await f.execute(p);
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn template verification catches ignored, extra and modified sibling or account changes', async () => {
  for (const mode of ['ignored_create', 'ignored_update', 'ignored_delete', 'extra', 'sibling', 'account']) {
    const kind = mode === 'ignored_update' ? 'update' : mode === 'ignored_delete' ? 'delete' : 'create';
    let original;
    const f = fixture({
      beforeWrite: s => {
        original = structuredClone(s.templates);
      },
      receipt: (r, s) => {
        if (mode.startsWith('ignored')) s.templates = original;
        if (mode === 'extra') s.templates.push({...body(), id: 800});
        if (mode === 'sibling') s.templates[1].name = 'Unreviewed edit';
        if (mode === 'account') s.account.name = 'Unreviewed edit';
        return r;
      },
    });
    try {
      const p = await f.prepare(args(kind));
      assert.equal(p.success, true);
      assert.equal((await f.execute(p)).success, true);
      const v = await f.verify(p);
      assert.equal(v.data?.status, 'inconclusive', JSON.stringify(v));
      assert.ok(v.data.checks[0].changed_fields.length);
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn templates retain accepted receipts before late grant withdrawal', async () => {
  const f = fixture({
    receipt: (r, _s, store) => {
      const c = store.listConnections(actor.tenantId)[0];
      store.putConnection(admin, {...c, accounts: ['999'], writeAccounts: []}, {accessToken: 'synthetic'});
      return r;
    },
  });
  try {
    const p = await f.prepare(),
      r = await f.execute(p);
    assert.equal(r.success, false);
    const saved = f.store.db
      .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
      .get(actor.tenantId, p.data.review_id);
    assert.equal(saved.state, 'complete', JSON.stringify(r));
    assert.equal(JSON.parse(saved.result).success, true);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('LinkedIn template claims survive concurrent execution and a SQLite restart', async () => {
  for (const lost of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'amcp-li-template-')),
      db = join(dir, 'test.sqlite');
    let f = fixture({
      db,
      receipt: r => {
        if (lost) throw Error('Synthetic lost accepted response');
        return r;
      },
    });
    try {
      const p = await f.prepare();
      assert.equal(p.success, true);
      await Promise.all([f.execute(p), f.execute(p)]);
      assert.equal(f.writes(), 1);
      f.store.close();
      f = fixture({db});
      const replay = await f.execute(p);
      assert.equal(f.writes(), 0);
      if (lost) assert.equal(replay.error.code, 'WRITE_OUTCOME_UNCERTAIN');
      else assert.equal(replay.data.replayed, true);
    } finally {
      f.store.close();
      removeTestDirectory(dir, 'amcp-li-template-');
    }
  }
});

test('LinkedIn template verification rechecks current state rather than caching a previous success', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    await f.execute(p);
    assert.equal((await f.verify(p)).data.status, 'verified');
    f.state.templates[1].name = 'Changed later';
    const v = await f.verify(p);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
  } finally {
    f.store.close();
  }
});

for (const mode of ['login', 'account', 'scope', 'actor'])
  test('LinkedIn template verification stops after in-flight ' + mode + ' withdrawal', async () => {
    let active = false;
    const f = fixture({
      read: (u, d, s, store) => {
        if (active) {
          active = false;
          const c = store.listConnections(actor.tenantId)[0];
          if (mode === 'actor')
            store.assertActorActive = () => {
              throw Error('Synthetic withdrawn actor');
            };
          else
            store.putConnection(
              admin,
              {
                ...c,
                ...(mode === 'account' ? {accounts: ['999'], writeAccounts: []} : mode === 'scope' ? {scopes: []} : {}),
              },
              {accessToken: mode === 'login' ? 'replacement' : 'synthetic'},
            );
        }
        return d;
      },
    });
    try {
      const p = await f.prepare();
      await f.execute(p);
      const before = f.reads();
      active = true;
      const v = await f.verify(p);
      assert.notEqual(v.data?.status, 'verified');
      assert.equal(f.reads(), before + 1);
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  });

test('LinkedIn templates remain bound to the original login when two connections expose the same account', async () => {
  const f = fixture();
  try {
    const p = await f.prepare();
    assert.equal(p.success, true);
    f.store.putConnection(admin, {...f.connection, id: 'another'}, {accessToken: 'different'});
    f.store.putConnection(admin, {...f.connection, writeAccounts: []}, {accessToken: 'synthetic'});
    const r = await f.execute(p);
    assert.equal(r.success, false);
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('LinkedIn templates cannot bypass review through direct native execution or skip_preflight', async () => {
  const f = fixture();
  try {
    for (const kind of ['create', 'update', 'delete', 'batch']) {
      const r = await f.service.call(
        gateway,
        {...args(kind), dry_run: false, confirmed: true, skip_preflight: true},
        actor,
      );
      assert.equal(r.success, false);
    }
    assert.equal(f.writes(), 0);
    assert.equal(f.reads(), 0);
  } finally {
    f.store.close();
  }
});

test('LinkedIn template state enforces aggregate byte and monotonic time budgets', async t => {
  const f = fixture();
  try {
    const inspect = await f.service.call('amcp_write', {action: 'inspect', gateway, arguments: args()}, actor);
    assert.equal(inspect.success, true);
    const p = inspect.data.request;
    let calls = 0;
    await assert.rejects(
      readLinkedInTemplateState(p, async () => {
        calls++;
        return {status: 200, headers: {}, data: {...f.state.account, unknown: 'x'.repeat(8 * 1024 * 1024)}};
      }),
      e => e.code === 'LINKEDIN_TEMPLATE_LIMIT',
    );
    assert.equal(calls, 1);
    let clock = 0;
    calls = 0;
    t.mock.method(performance, 'now', () => clock);
    await assert.rejects(
      readLinkedInTemplateState(p, async () => {
        calls++;
        clock = 60001;
        return {status: 200, headers: {}, data: f.state.account};
      }),
      e => e.code === 'LINKEDIN_TEMPLATE_LIMIT',
    );
    assert.equal(calls, 1);
  } finally {
    t.mock.restoreAll();
    f.store.close();
  }
});

test('LinkedIn template transport enforces the family deadline before another network attempt', async t => {
  let clock = 0;
  const f = fixture({
    read: (_u, d) => {
      clock = 60001;
      return d;
    },
  });
  try {
    t.mock.method(performance, 'now', () => clock);
    const p = await f.prepare();
    assert.equal(p.error.code, 'LINKEDIN_TEMPLATE_LIMIT', JSON.stringify(p));
    assert.equal(f.reads(), 1);
    assert.equal(f.writes(), 0);
  } finally {
    t.mock.restoreAll();
    f.store.close();
  }
});

test('LinkedIn templates reject unbounded collections and creation beyond read-back capacity', async () => {
  for (const mode of ['pages', 'capacity']) {
    const f = fixture(mode === 'pages' ? {pageSize: 1} : {});
    try {
      f.state.templates = Array.from({length: mode === 'pages' ? 21 : 1000}, (_, i) => ({...body(), id: 10000 + i}));
      const p = await f.prepare();
      assert.equal(p.success, false, JSON.stringify(p));
      assert.equal(p.error.code, mode === 'pages' ? 'LINKEDIN_TEMPLATE_LIMIT' : 'INVALID_AUDIENCE_TEMPLATE');
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('LinkedIn template inventory declares all four captured routes with the qualified family and its tests', () => {
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].family, 'linkedin_audience_templates');
    assert.equal(rows[0].status, 'reviewed_write_family');
    assert.ok(rows[0].tests.includes('tests/linkedin-audience-templates.test.mjs'));
  }
});

test('LinkedIn saved-audience guidance examples execute through the exact reviewed lifecycle', async () => {
  const file = JSON.parse(
      readFileSync('Skills/amcp-campaign-builder/examples/linkedin-audience-templates.json', 'utf8'),
    ),
    evidence = JSON.parse(readFileSync('tests/fixtures/linkedin-audience-template-evidence.json', 'utf8'));
  assert.equal(file.examples.length, 4);
  assert.equal(evidence.live_verified, false);
  assert.match(evidence.source.sha256, /^[a-f0-9]{64}$/);
  for (const e of file.examples) {
    const f = fixture({
      connectionId: e.arguments.connection_id,
      read: (u, d) => {
        if (u.pathname === '/rest/adTargetTemplates')
          d.paging.links.push({rel: 'self', href: '/rest/adTargetTemplates', type: 'application/json'});
        return d;
      },
    });
    try {
      const i = await f.service.call(
        'amcp_write',
        {action: 'inspect', gateway: e.gateway, arguments: e.arguments},
        actor,
      );
      assert.equal(i.success, true, JSON.stringify(i));
      assert.equal(i.data.review_contract_supported, true);
      assert.equal(f.calls.length, 0);
      const p = await f.prepare(e.arguments);
      assert.equal(p.success, true, JSON.stringify(p));
      assert.equal((await f.execute(p)).data?.success, true);
      assert.equal((await f.verify(p)).data?.status, 'verified');
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});
