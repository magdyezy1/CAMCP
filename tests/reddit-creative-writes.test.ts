import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {saveSpendPolicy} from '../src/spend-policy.js';
import type {JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';

const gateway = 'reddit_native_action',
  account = 'a2_111',
  actor = {tenantId: 'reddit-creative', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const};
const form = {
  name: 'Research enquiry',
  privacy_link: 'https://example.com/privacy',
  prompt: 'Ask the business to contact you',
  questions: [
    {type: 'EMAIL', required: true},
    {type: 'FIRST_NAME', required: false},
  ],
};
const profile = {
  id: '123',
  reddit_user_id: 't2_abc',
  name: 'Example',
  business_id: '11111111-1111-4111-8111-111111111111',
};
function fixture(options: {scopes?: string[]; grant?: boolean; enabled?: boolean; observed?: boolean} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 67).toString('base64')),
    registry = new Registry(),
    calls: JsonObject[] = [];
  const connection = {
    id: 'reddit',
    tenantId: actor.tenantId,
    gateway,
    accounts: [account],
    writeAccounts: options.grant === false ? [] : [account],
    enabled: true,
    label: 'Synthetic',
    scopes: options.scopes ?? ['adsread', 'adsedit'],
    userAgent: 'server:amcp-tests:1 (synthetic)',
  };
  const auth = {accessToken: 'synthetic'};
  store.putConnection(owner, connection, auth);
  const records = new Map<string, JsonObject>();
  for (const kind of ['posts', 'structured_posts']) {
    const id = 't3_abc';
    records.set('/api/v3/' + kind + '/' + id, {
      id,
      profile_id: 't2_abc',
      allow_comments: false,
      ...(kind === 'posts'
        ? {type: 'TEXT', headline: 'Current headline', body: 'Current body'}
        : {creative: {type: 'TEXT', headline: 'Current headline', body: 'Current body', text_format: 'PLAIN_TEXT'}}),
    });
    if (options.observed !== false) store.rememberResource(connection, account, kind + '/' + id);
  }
  let profiles: JsonObject[] = [structuredClone(profile)],
    writes = 0,
    foreign = false,
    lose = false,
    ignore = false;
  let onRead: (path: string, url: URL, data: JsonObject) => JsonObject = (_path, _url, data) => data;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(
      async (url, init) => {
        const parsed = new URL(String(url)),
          path = parsed.pathname,
          method = init?.method ?? 'GET';
        calls.push({path, method, query: parsed.search});
        if (method === 'GET') {
          const data =
            path === '/api/v3/ad_accounts/' + account
              ? {data: {id: account, name: 'Synthetic account'}}
              : path.endsWith('/profiles')
                ? {data: structuredClone(profiles), pagination: {next_url: null}}
                : {data: structuredClone(records.get(path))};
          assert.ok(data.data, 'Missing synthetic state ' + path);
          return Response.json(onRead(path, parsed, {...data, request_id: 'volatile-' + calls.length}));
        }
        writes++;
        const data = JSON.parse(String(init?.body)).data,
          target = method === 'POST' ? '/api/v3/lead_gen_forms/456' : path;
        const current = records.get(target),
          value =
            method === 'POST' ? {...data, id: '456', ad_account_id: account} : {...current, ...(!ignore ? data : {})};
        records.set(target, value);
        if (lose) throw Error('Synthetic response lost after mutation');
        return Response.json(
          {data: foreign ? {...value, ad_account_id: 'a2_999', profile_id: 't2_foreign'} : value},
          {status: method === 'POST' ? 201 : 200},
        );
      },
      async () => {},
      30000,
      8 * 1024 * 1024,
      10000,
    ),
    undefined,
    {allowWrites: options.enabled !== false, requireBeforeState: true, maxBudgetChange: 0},
  );
  const prepare = (action: string, data: JsonObject, params: JsonObject = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          operation: action.includes('LEAD') ? 'reddit_leadgen_ops' : 'reddit_post_ops',
          arguments: {action, account_id: account, payload: {data}, params},
        },
      },
      actor,
    );
  const execute = (p: JsonObject) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        spend_change_confirmed: true,
      },
      actor,
    );
  return {
    store,
    service,
    connection,
    records,
    calls,
    prepare,
    execute,
    writes: () => writes,
    profiles: (value: JsonObject[]) => {
      profiles = value;
    },
    onRead: (fn: typeof onRead) => {
      onRead = fn;
    },
    foreign: () => {
      foreign = true;
    },
    lose: () => {
      lose = true;
    },
    ignore: () => {
      ignore = true;
    },
    revoke: () => store.putConnection(owner, {...connection, writeAccounts: []}, auth),
  };
}

for (const [action, kind] of [
  ['UPDATE_POST', 'posts'],
  ['UPDATE_STRUCTURED_POST', 'structured_posts'],
])
  test(
    action + ' reviews current account/profile binding, executes once and verifies the exact comment setting',
    async () => {
      const x = fixture();
      try {
        const p = await x.prepare(action!, {allow_comments: true}, {post_id: 't3_abc'});
        assert.equal(p.success, true, JSON.stringify(p));
        assert.equal(x.writes(), 0);
        assert.equal((await x.execute(p)).success, true);
        assert.equal((await x.execute(p)).data.replayed, true);
        assert.equal(x.writes(), 1);
        assert.equal(x.records.get('/api/v3/' + kind + '/t3_abc')!.allow_comments, true);
        const v = await x.service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
        assert.equal(v.data.status, 'verified', JSON.stringify(v));
      } finally {
        x.store.close();
      }
    },
  );

test('lead-form lifecycle verifies exact account, question ordering and response ownership before sunset', async t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-09-20T12:00:00Z')});
  const x = fixture();
  try {
    const p = await x.prepare('CREATE_LEAD_GEN_FORM', form);
    assert.equal(p.success, true, JSON.stringify(p));
    assert.match(JSON.stringify(p), /2026-09-21/);
    const r = await x.execute(p);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(x.store.ownsResource(x.connection, account, 'lead_gen_forms/456'), true);
    assert.equal((await x.execute(p)).data.replayed, true);
    assert.equal(x.writes(), 1);
    const v = await x.service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
  } finally {
    x.store.close();
  }
});

test('Reddit rejects unknown authors, stale profile associations, missing grants and profile enumeration tricks', async () => {
  for (const mode of ['foreign', 'missing', 'ambiguous', 'unobserved', 'scope', 'grant', 'disabled'] as const) {
    const x = fixture({
      observed: mode !== 'unobserved',
      scopes: mode === 'scope' ? ['adsedit'] : undefined,
      grant: mode !== 'grant',
      enabled: mode !== 'disabled',
    });
    try {
      if (mode === 'foreign') x.records.get('/api/v3/posts/t3_abc')!.profile_id = 't2_other';
      if (mode === 'missing') x.profiles([]);
      if (mode === 'ambiguous') x.profiles([profile, {...profile, id: '999'}]);
      const p = await x.prepare('UPDATE_POST', {allow_comments: true}, {post_id: 't3_abc'});
      if (p.success) assert.equal((await x.execute(p)).success, false);
      else
        assertRefused(p, [
          'RESOURCE_SCOPE_REQUIRED',
          'INSUFFICIENT_SCOPE',
          'WRITE_ACCOUNT_FORBIDDEN',
          'LIVE_WRITES_DISABLED',
        ]);
      assert.equal(x.writes(), 0);
    } finally {
      x.store.close();
    }
  }
});

test('profile discovery follows safe pages and rejects repeated cursors, foreign pagination, duplicate identities and errors', async () => {
  for (const mode of ['paged', 'loop', 'foreign', 'duplicate', 'error', 'missing-envelope'] as const) {
    const x = fixture();
    try {
      x.onRead((path, url, data) => {
        if (!path.endsWith('/profiles')) return data;
        if (mode === 'error') return {error: {message: 'Synthetic failure'}};
        if (mode === 'missing-envelope') return {data: [profile]};
        if (mode === 'duplicate') return {data: [profile, profile], pagination: {next_url: null}};
        if (mode === 'foreign')
          return {
            data: [],
            pagination: {next_url: 'https://ads-api.reddit.com/api/v3/ad_accounts/a2_999/profiles?page.token=next'},
          };
        const link = 'https://ads-api.reddit.com' + path + '?page.token=next';
        return mode === 'loop' || !url.searchParams.has('page.token') ? {data: [], pagination: {next_url: link}} : data;
      });
      const p = await x.prepare('UPDATE_POST', {allow_comments: true}, {post_id: 't3_abc'});
      assert.equal(p.success, mode === 'paged', JSON.stringify(p));
      assert.equal(x.writes(), 0);
    } finally {
      x.store.close();
    }
  }
});

test('selected post edits and profile revocation conflict while unrelated profile changes and timestamps do not', async () => {
  for (const mode of ['content', 'revoked-profile', 'unrelated', 'telemetry'] as const) {
    const x = fixture();
    try {
      const p = await x.prepare('UPDATE_POST', {allow_comments: true}, {post_id: 't3_abc'});
      assert.equal(p.success, true, JSON.stringify(p));
      if (mode === 'content') x.records.get('/api/v3/posts/t3_abc')!.headline = 'Changed content';
      if (mode === 'revoked-profile') x.profiles([]);
      if (mode === 'unrelated') x.profiles([profile, {...profile, id: '999', reddit_user_id: 't2_other'}]);
      if (mode === 'telemetry') x.profiles([{...profile, modified_at: '2026-09-19T13:00:00Z'}]);
      const r = await x.execute(p);
      assert.equal(r.success, ['unrelated', 'telemetry'].includes(mode), JSON.stringify(r));
      if (!r.success) assert.equal(x.writes(), 0);
    } finally {
      x.store.close();
    }
  }
});

test('post metadata changes retain owner activation policy and detect ignored mutations', async () => {
  const x = fixture();
  try {
    const p = await x.prepare('UPDATE_STRUCTURED_POST', {allow_comments: true}, {post_id: 't3_abc'});
    assert.equal(p.success, true);
    saveSpendPolicy(x.store, owner, {gateway, account_id: account, confirmed: true, policy: {allow_activation: false}});
    const r = await x.execute(p);
    assert.equal(r.error.code, 'POLICY_ACTIVATION_FORBIDDEN');
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
  const y = fixture();
  try {
    const p = await y.prepare('UPDATE_POST', {allow_comments: true}, {post_id: 't3_abc'});
    y.ignore();
    const r = await y.execute(p);
    assertRefused(r, 'WRITE_PARTIAL_OR_FAILED');
    assert.equal(y.writes(), 1);
    assertRefused(await y.execute(p), 'WRITE_PARTIAL_OR_FAILED');
    assert.equal(y.writes(), 1);
  } finally {
    y.store.close();
  }
});

test('invalid forms and attempted post-content updates are refused before provider calls', async t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-09-20T12:00:00Z')});
  for (const data of [
    {...form, privacy_link: 'http://example.com'},
    {...form, privacy_link: 'https://private:password@example.com'},
    {...form, questions: [{type: 'EMAIL', required: false}]},
    {...form, questions: [{type: 'EMAIL'}]},
    {
      ...form,
      questions: [
        {type: 'EMAIL', required: true},
        {type: 'EMAIL', required: false},
      ],
    },
    {...form, ad_account_id: 'a2_999'},
    {...form, id: 'forged'},
  ]) {
    const x = fixture();
    try {
      assert.equal((await x.prepare('CREATE_LEAD_GEN_FORM', data)).success, false);
      assert.equal(x.calls.length, 0);
    } finally {
      x.store.close();
    }
  }
  for (const data of [{allow_comments: 'true'}, {allow_comments: true, headline: 'Edit content'}, {}]) {
    const x = fixture();
    try {
      assert.equal((await x.prepare('UPDATE_POST', data, {post_id: 't3_abc'})).success, false);
      assert.equal(x.calls.length, 0);
    } finally {
      x.store.close();
    }
  }
});

test('sunset stops new and in-flight lead-form writes but retains completed replay and read-back', async t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-09-20T23:59:58Z')});
  const x = fixture();
  try {
    const first = await x.prepare('CREATE_LEAD_GEN_FORM', form);
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal((await x.execute(first)).success, true);
    const pending = await x.prepare('CREATE_LEAD_GEN_FORM', {...form, name: 'A separate review'});
    assert.equal(pending.success, true);
    x.onRead((_path, _url, data) => {
      t.mock.timers.tick(3000);
      return data;
    });
    assert.equal((await x.execute(pending)).error.code, 'PROVIDER_ACTION_UNSUPPORTED');
    assert.equal(x.writes(), 1);
    assert.equal((await x.execute(first)).data.replayed, true);
    assert.equal((await x.prepare('CREATE_LEAD_GEN_FORM', form)).error.code, 'PROVIDER_ACTION_UNSUPPORTED');
    const v = await x.service.call('amcp_campaign', {action: 'verify', review_id: first.data.review_id}, actor);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('foreign and lost creative responses never resubmit and a grant revoked during discovery prevents dispatch', async () => {
  for (const mode of ['foreign', 'lost', 'revoke', 'concurrent'] as const) {
    const x = fixture();
    try {
      const p = await x.prepare('UPDATE_POST', {allow_comments: true}, {post_id: 't3_abc'});
      assert.equal(p.success, true);
      if (mode === 'foreign') x.foreign();
      if (mode === 'lost') x.lose();
      if (mode === 'revoke')
        x.onRead((path, _url, data) => {
          if (path.endsWith('/profiles')) x.revoke();
          return data;
        });
      if (mode === 'concurrent') await Promise.all([x.execute(p), x.execute(p)]);
      else {
        assertRefused(await x.execute(p), [
          'UPSTREAM_RESPONSE_INVALID',
          'WRITE_OUTCOME_UNCERTAIN',
          'WRITE_ACCOUNT_FORBIDDEN',
        ]);
        assertRefused(await x.execute(p), ['WRITE_OUTCOME_UNCERTAIN', 'WRITE_ACCOUNT_FORBIDDEN']);
      }
      assert.equal(x.writes(), mode === 'revoke' ? 0 : 1);
    } finally {
      x.store.close();
    }
  }
});
