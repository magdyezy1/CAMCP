import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService, strictOptions} from '../dist/src/service.js';
import {NativeTransport, oauth1} from '../dist/src/transport.js';
import {MirrorError} from '../dist/src/errors.js';
import {independentlyReadOnly} from '../dist/src/execution-risk.js';
import {xAudienceEstimateRoute, runXAudienceEstimate, xAudienceCriteriaTypes} from '../dist/src/x-audience-estimate.js';
import {actionContracts} from '../dist/src/action-contracts.js';

const registry = new Registry(),
  gateway = 'x_ads_native_action',
  action = 'x_accounts_account_id_audience_estimate_post',
  account = 'abc12',
  actor = {tenantId: 'estimate', userId: 'reader', role: 'reader'},
  owner = {...actor, role: 'admin'};
const keyword = (value = 'homes', operator = 'EQ') => ({
  targeting_type: 'BROAD_KEYWORD',
  targeting_value: value,
  operator_type: operator,
});
const response = (min = 100, max = 200) => ({
  request: {params: {account_id: account, targeting_criteria: null}},
  data: {audience_size: {min, max}},
});
const evidence = JSON.parse(fs.readFileSync('tests/fixtures/audience-availability-evidence.json', 'utf8'));
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 38).toString('base64')),
    connection = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [],
      scopes: [],
      enabled: true,
      label: 'Synthetic X',
    },
    credentials = {
      accessToken: 'synthetic-access',
      tokenSecret: 'synthetic-secret',
      consumerKey: 'synthetic-key',
      consumerSecret: 'synthetic-consumer-secret',
    };
  store.putConnection(owner, connection, credentials);
  const calls = [];
  let respond = () => Response.json(response());
  const transport = new NativeTransport(
    async (url, init) => {
      calls.push({url: String(url), method: init.method, headers: init.headers, body: init.body});
      return respond(url, init, calls.length);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
      allowWrites: false,
      requireBeforeState: true,
      maxBudgetChange: 0,
    }),
    args = {
      action,
      account_id: account,
      connection_id: connection.id,
      payload: {targeting_criteria: [keyword()]},
      dry_run: false,
    };
  return {
    store,
    connection,
    credentials,
    calls,
    service,
    args,
    call: (extra = {}, who = actor) => service.call(gateway, {...args, ...extra}, who),
    respond: fn => {
      respond = fn;
    },
  };
}
test('X audience estimate uses JSON through a read-only deployment and never claims a mutation', async () => {
  const f = fixture();
  try {
    const out = await f.call();
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.success, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, 'POST');
    assert.equal(f.calls[0].headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(f.calls[0].body), f.args.payload);
    assert.match(f.calls[0].headers.Authorization, /^OAuth /);
    assert.deepEqual(out.data.data.data.audience_size, {min: 100, max: 200});
    assert.equal(out.data.estimate.kind, 'potential_audience_range');
    assert.equal(out.data.estimate.guaranteed_delivery, false);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM idempotency').get().n, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM resource_ownership').get().n, 0);
  } finally {
    f.store.close();
  }
});
test('X estimate canonical action and alias share a classified native read preview', async () => {
  const f = fixture();
  try {
    for (const name of [action, 'ESTIMATE_AUDIENCE_SIZE']) {
      const out = await f.call({action: name, dry_run: true});
      assert.equal(out.success, true, JSON.stringify(out));
      assert.equal(out.data.request.readOnly, true);
      assert.equal(out.data.executed, false);
    }
    const row = actionContracts(registry).find(r => r.gateway === gateway && r.action === action);
    assert.equal(row.status, 'native_read');
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});

test('X estimate signs JSON without form body fields and preserves Unicode and native query', async () => {
  const f = fixture();
  try {
    const body = {
      targeting_criteria: [
        keyword('منازل + family 🏠', 'NE'),
        {targeting_type: 'LOCATION', targeting_value: '96683cc9126741d1'},
      ],
    };
    const out = await f.call({payload: body, query: {operator_type: 'NE'}});
    assert.equal(out.success, true, JSON.stringify(out));
    const call = f.calls[0],
      auth = Object.fromEntries(
        [...call.headers.Authorization.matchAll(/(oauth_[a-z_]+)="([^"]*)"/g)].map(m => [
          m[1],
          decodeURIComponent(m[2]),
        ]),
      );
    assert.equal(
      call.headers.Authorization,
      oauth1('POST', new URL(call.url), f.credentials, undefined, auth.oauth_nonce, auth.oauth_timestamp),
    );
    assert.deepEqual(JSON.parse(call.body), body);
    assert.equal(new URL(call.url).searchParams.get('operator_type'), 'NE');
    assert.equal(new URL(call.url).searchParams.has('targeting_criteria'), false);
  } finally {
    f.store.close();
  }
});
test('X audience request rejects unsupported shapes, fabricated fields and contradictory criteria before network', async () => {
  const invalid = [
    {},
    [],
    {targeting_criteria: []},
    {targeting_criteria: [null]},
    {targeting_criteria: [keyword()], line_item_id: 'foo'},
    {targeting_criteria: [{...keyword(), line_item_id: 'foo'}]},
    {targeting_criteria: [keyword(), keyword()]},
    {targeting_criteria: [keyword(), keyword('homes', 'NE')]},
    {targeting_criteria: [keyword('x', 'GTE')]},
    {targeting_criteria: [keyword(123)]},
    {targeting_criteria: [keyword('')]},
    {targeting_criteria: [keyword('a\nb')]},
    {targeting_criteria: [keyword('\ud800')]},
    {targeting_criteria: [keyword('x'.repeat(1025))]},
    {targeting_criteria: [{targeting_type: 'LOCATION', targeting_value: 'geo'}]},
    {targeting_criteria: [{targeting_type: 'APP_LIST', targeting_value: 'apps'}]},
    {targeting_criteria: [{targeting_type: 'INVENTED', targeting_value: 'x'}]},
    {
      targeting_criteria: [
        keyword(),
        {targeting_type: 'AGE', targeting_value: 'AGE_18_TO_24'},
        {targeting_type: 'AGE', targeting_value: 'AGE_25_TO_34'},
      ],
    },
    {targeting_criteria: [{targeting_type: 'FOLLOWERS_OF_USER', targeting_value: 9007199254740992}]},
    {targeting_criteria: [{targeting_type: 'CUSTOM_AUDIENCE', targeting_value: '../other'}]},
    {targeting_criteria: Array.from({length: 201}, (_, i) => keyword(String(i)))},
  ];
  for (const payload of invalid) {
    const f = fixture();
    try {
      const out = await f.call({payload});
      assert.equal(out.success, false, JSON.stringify(out));
      assert.equal(f.calls.length, 0, JSON.stringify(payload));
    } finally {
      f.store.close();
    }
  }
});
test('X audience estimate has no mutation header/query, pagination or alternate-origin bypass', async () => {
  const f = fixture();
  try {
    for (const extra of [
      {query: {_method: 'DELETE'}},
      {query: {line_item_id: 'other'}},
      {query: {operator_type: 'LT'}},
      {headers: {'X-HTTP-Method-Override': 'DELETE'}},
      {headers: {Authorization: 'Bearer secret'}},
      {aggregate_pages: true},
      {allPages: true},
      {paginate: true},
      {path_params: {account_id: 'foreign'}},
    ]) {
      const out = await f.call(extra);
      assert.equal(out.success, false, JSON.stringify({extra, out}));
      assert.equal(f.calls.length, 0);
    }
    const p = f.service.compiler.compile(gateway, f.args, strictOptions);
    for (const changed of [
      {method: 'DELETE'},
      {method: 'PUT'},
      {origin: 'https://attacker.invalid'},
      {path: p.path + '/create'},
      {specialTransport: 'upload'},
    ]) {
      const other = {...p, ...changed};
      assert.equal(xAudienceEstimateRoute(other), false);
      assert.equal(independentlyReadOnly(other), false);
    }
    assert.equal(independentlyReadOnly({...p, headers: {'X-HTTP-Method-Override': 'DELETE'}}), false);
  } finally {
    f.store.close();
  }
});
test('X audience zero is preserved; null, missing, inverted and unsafe ranges never become success', async () => {
  for (const [min, max] of [
    [0, 0],
    [0, 10],
    [23, 23],
    [123456789, 987654321],
  ]) {
    const f = fixture();
    try {
      f.respond(() => Response.json(response(min, max)));
      const out = await f.call();
      assert.equal(out.success, true, JSON.stringify(out));
      assert.deepEqual(out.data.data.data.audience_size, {min, max});
    } finally {
      f.store.close();
    }
  }
  for (const value of [
    null,
    {},
    [],
    {min: null, max: 100},
    {min: 0},
    {max: 1},
    {min: -1, max: 20},
    {min: 100, max: 99},
    {min: 1.1, max: 3},
    {min: '10', max: '20'},
    {min: 0, max: Number.MAX_SAFE_INTEGER + 1},
    {min: 0, max: 1, average: 0.5},
  ]) {
    const f = fixture();
    try {
      const data = response();
      data.data.audience_size = value;
      f.respond(() => Response.json(data));
      const out = await f.call();
      assert.equal(out.success, false, JSON.stringify(out));
      assert.equal(out.error.code, 'X_AUDIENCE_RESPONSE_INVALID');
      assert.equal(f.calls.length, 1);
    } finally {
      f.store.close();
    }
  }
});
test('X wrong-account, partial, HTTP 200 error and malformed envelopes cannot become estimates', async () => {
  for (const value of [
    {},
    {data: response().data},
    {...response(), request: {params: {account_id: 'other'}}},
    {...response(), next_cursor: 'more'},
    {...response(), next_cursor: 0},
    {...response(), errors: [{code: 'BAD', message: 'Synthetic'}]},
    {...response(), errors: {}},
    {...response(), error: {code: 'BAD'}},
    {...response(), operation_errors: []},
    {...response(), partial_failure: true},
    {...response(), partialFailure: true},
    {...response(), data: {...response().data, partial: true}},
    {...response(), request: {params: {account_id: account, targeting_criteria: [keyword('changed')]}}},
  ]) {
    const f = fixture();
    try {
      f.respond(() => Response.json(value));
      const out = await f.call();
      assert.equal(out.success, false, JSON.stringify(out));
      assert.equal(f.calls.length, 1);
    } finally {
      f.store.close();
    }
  }
  for (const status of [201, 202]) {
    const f = fixture();
    try {
      f.respond(() => Response.json(response(), {status}));
      const out = await f.call();
      assert.equal(out.error.code, 'X_AUDIENCE_RESPONSE_INVALID');
    } finally {
      f.store.close();
    }
  }
});
test('X explicit connection, actor and tenant remain required on estimate reads', async () => {
  for (const mode of ['other_tenant', 'disabled', 'grant', 'explicit_duplicate', 'revoked_actor']) {
    const f = fixture();
    try {
      if (mode === 'disabled') f.store.putConnection(owner, {...f.connection, enabled: false}, f.credentials);
      if (mode === 'grant') f.store.putConnection(owner, {...f.connection, accounts: ['foreign']}, f.credentials);
      if (mode === 'explicit_duplicate')
        f.store.putConnection(
          owner,
          {...f.connection, id: '22222222-2222-4222-8222-222222222222', accounts: ['other'], isDefault: true},
          f.credentials,
        );
      if (mode === 'revoked_actor')
        f.store.bindActorCheck(actor, () => {
          throw new MirrorError('FORBIDDEN', 'Synthetic revoked actor', {}, 403);
        });
      const out = await f.call({}, mode === 'other_tenant' ? {...actor, tenantId: 'foreign'} : actor);
      assert.equal(out.success, mode === 'explicit_duplicate', JSON.stringify(out));
      assert.equal(f.calls.length, mode === 'explicit_duplicate' ? 1 : 0);
    } finally {
      f.store.close();
    }
  }
});
test('X estimate denies stale login or grant after response and before a transient retry', async () => {
  for (const mutation of ['grant', 'login', 'disabled', 'actor'])
    for (const retry of [false, true]) {
      const f = fixture();
      let active = true;
      try {
        f.store.bindActorCheck(actor, () => {
          if (!active) throw new MirrorError('FORBIDDEN', 'Synthetic revoked actor', {}, 403);
        });
        f.respond(() => {
          if (mutation === 'actor') active = false;
          else
            f.store.putConnection(
              owner,
              {
                ...f.connection,
                ...(mutation === 'grant' ? {accounts: ['foreign']} : {}),
                ...(mutation === 'disabled' ? {enabled: false} : {}),
              },
              mutation === 'login' ? {...f.credentials, accessToken: 'changed'} : f.credentials,
            );
          return retry ? Response.json({errors: [{code: 'UNAVAILABLE'}]}, {status: 503}) : Response.json(response());
        });
        const out = await f.call();
        assert.equal(out.success, false, JSON.stringify(out));
        assert.equal(f.calls.length, 1);
        assert.equal(JSON.stringify(out).includes('synthetic-secret'), false);
      } finally {
        f.store.close();
      }
    }
});
test('X estimate retries transient read failure but preserves terminal and rate-limit semantics', async () => {
  for (const status of [400, 403, 429, 503]) {
    const f = fixture();
    try {
      f.respond((_u, _i, n) =>
        n === 1
          ? Response.json(
              {errors: [{code: 'SYNTHETIC'}]},
              {status, headers: status === 429 ? {'retry-after': '60'} : {}},
            )
          : Response.json(response()),
      );
      const out = await f.call();
      assert.equal(out.success, status === 503, JSON.stringify(out));
      assert.equal(f.calls.length, status === 503 ? 2 : 1);
      if (status === 403) assert.equal(out.error.code, 'PROVIDER_ACCESS_DENIED');
      if (status === 429) assert.equal(out.error.code, 'PLATFORM_RATE_LIMIT');
    } finally {
      f.store.close();
    }
  }
});
const scoped = (data, extra = {}) => ({request: {params: {account_id: account}}, data, ...extra});
test('X private custom-audience and campaign references are fetched once in the same account before estimating', async () => {
  const f = fixture();
  try {
    const criteria = [
      {targeting_type: 'CUSTOM_AUDIENCE', targeting_value: 'aud1'},
      {targeting_type: 'CUSTOM_AUDIENCE_EXPANDED', targeting_value: 'aud1'},
      {targeting_type: 'CAMPAIGN_ENGAGEMENT', targeting_value: 'camp1'},
    ];
    f.respond(url => {
      const path = new URL(url).pathname;
      if (path.endsWith('/custom_audiences/aud1'))
        return Response.json(scoped({id: 'aud1', deleted: false, targetable: true, owner_account_id: 'sharedowner'}));
      if (path.endsWith('/campaigns/camp1')) return Response.json(scoped({id: 'camp1', deleted: false}));
      return Response.json(response());
    });
    const out = await f.call({payload: {targeting_criteria: criteria}});
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.estimate.reference_reads, 2);
    assert.deepEqual(
      f.calls.map(c => c.method),
      ['GET', 'GET', 'POST'],
    );
    assert.equal(
      f.calls.every(c => new URL(c.url).pathname.startsWith('/12/accounts/' + account + '/')),
      true,
    );
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM resource_ownership').get().n, 0);
  } finally {
    f.store.close();
  }
});
test('X missing or inaccessible private references stop before the estimate POST', async () => {
  for (const row of [
    null,
    {id: 'wrong', deleted: false, targetable: true},
    {id: 'aud1', deleted: true, targetable: true},
    {id: 'aud1', deleted: false, targetable: false},
    {id: 'aud1', deleted: false},
    {id: 'aud1', deleted: false, targetable: true, account_id: 'other'},
  ]) {
    const f = fixture();
    try {
      f.respond(() => Response.json(scoped(row)));
      const out = await f.call({
        payload: {targeting_criteria: [{targeting_type: 'CUSTOM_AUDIENCE', targeting_value: 'aud1'}]},
      });
      assert.equal(out.success, false, JSON.stringify(out));
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].method, 'GET');
    } finally {
      f.store.close();
    }
  }
});
test('X follows bounded promotable-user pages and preserves large native user strings', async () => {
  const f = fixture();
  try {
    const target = '9007199254740993123';
    f.respond(url => {
      const u = new URL(url);
      if (u.pathname.endsWith('promotable_users'))
        return Response.json(
          scoped(
            [
              {
                id: u.searchParams.has('cursor') ? 'nextuser' : 'firstuser',
                user_id: u.searchParams.has('cursor') ? target : '123',
                promotable_user_type: 'FULL',
                deleted: false,
              },
            ],
            {next_cursor: u.searchParams.has('cursor') ? null : 'page2'},
          ),
        );
      return Response.json(response());
    });
    const out = await f.call({
      payload: {
        targeting_criteria: [
          {targeting_type: 'FOLLOWERS_OF_USER', targeting_value: target},
          {targeting_type: 'USER_ENGAGEMENT', targeting_value: target},
        ],
      },
    });
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(f.calls.length, 3);
    assert.equal(new URL(f.calls[1].url).searchParams.get('cursor'), 'page2');
    assert.equal(JSON.parse(f.calls[2].body).targeting_criteria[0].targeting_value, target);
  } finally {
    f.store.close();
  }
});
test('X cannot estimate private-user audiences with a partial, duplicated or non-FULL member', async () => {
  for (const mode of [
    'missing',
    'retweets',
    'numeric',
    'wrongaccount',
    'deleted',
    'loop',
    'badcursor',
    'error',
    'page_limit',
  ]) {
    const f = fixture();
    try {
      f.respond((_u, _i, n) => {
        const row = {
          id: mode === 'loop' ? 'same' : 'member' + n,
          user_id:
            mode === 'numeric'
              ? 9007199254740992
              : mode === 'missing' || mode === 'loop' || mode === 'page_limit'
                ? '222'
                : '111',
          promotable_user_type: mode === 'retweets' ? 'RETWEETS_ONLY' : 'FULL',
          deleted: mode === 'deleted',
        };
        const out = scoped([row], {
          next_cursor: ['loop', 'page_limit'].includes(mode) ? 'page' + n : mode === 'badcursor' ? {} : null,
        });
        if (mode === 'wrongaccount') out.request.params.account_id = 'foreign';
        if (mode === 'error') out.errors = {code: 'BAD'};
        return Response.json(out);
      });
      const out = await f.call({
        payload: {targeting_criteria: [{targeting_type: 'FOLLOWERS_OF_USER', targeting_value: '111'}]},
      });
      assert.equal(out.success, false, JSON.stringify({mode, out}));
      assert.ok(f.calls.every(c => c.method === 'GET'));
      assert.ok(f.calls.length <= 5);
    } finally {
      f.store.close();
    }
  }
});
test('X audience limits bound criteria, private lookups, bytes and the monotonic deadline', async t => {
  const f = fixture();
  try {
    const out = await f.call({payload: {targeting_criteria: Array.from({length: 200}, (_, i) => keyword('term' + i))}});
    assert.equal(out.success, true, JSON.stringify(out));
    const refs = await f.call({
      payload: {
        targeting_criteria: Array.from({length: 26}, (_, i) => ({
          targeting_type: 'CUSTOM_AUDIENCE',
          targeting_value: 'aud' + i,
        })),
      },
    });
    assert.equal(refs.error.code, 'INVALID_X_AUDIENCE_ESTIMATE');
    assert.equal(f.calls.length, 1);
    const p = f.service.compiler.compile(gateway, f.args, strictOptions);
    await assert.rejects(
      () => runXAudienceEstimate(p, async () => ({...response(), telemetry: 'x'.repeat(2 * 1024 * 1024)})),
      {code: 'X_AUDIENCE_LIMIT'},
    );
    let elapsed = 0;
    t.mock.method(performance, 'now', () => elapsed);
    await assert.rejects(
      () =>
        runXAudienceEstimate(p, async () => {
          elapsed = 60001;
          return response();
        }),
      {code: 'X_AUDIENCE_LIMIT'},
    );
  } finally {
    t.mock.restoreAll();
    f.store.close();
  }
});
test('X authority is rechecked between private prerequisite and the estimate POST', async () => {
  const f = fixture();
  try {
    f.respond(() => {
      f.store.putConnection(owner, f.connection, {...f.credentials, accessToken: 'replacement'});
      return Response.json(scoped({id: 'aud1', deleted: false, targetable: true}));
    });
    const out = await f.call({
      payload: {targeting_criteria: [{targeting_type: 'CUSTOM_AUDIENCE', targeting_value: 'aud1'}]},
    });
    assert.equal(out.success, false, JSON.stringify(out));
    assert.equal(out.error.code, 'CONNECTION_AUTHORITY_CHANGED');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, 'GET');
  } finally {
    f.store.close();
  }
});
test('X estimate preview works with no stored credentials and records no review', async () => {
  const store = new Store(':memory:');
  try {
    const service = new MirrorService(
      registry,
      store,
      new NativeTransport(async () => {
        throw Error('No egress');
      }),
    );
    const out = await service.call(
      gateway,
      {action, account_id: account, payload: {targeting_criteria: [keyword()]}, dry_run: true},
      actor,
    );
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.executed, false);
    assert.equal(out.data.request.readOnly, true);
    assert.equal(store.listConnections(actor.tenantId).length, 0);
  } finally {
    store.close();
  }
});
test('X official request and range examples agree with the qualified vocabulary and wire format', async () => {
  assert.deepEqual(
    [...xAudienceCriteriaTypes, ...evidence.x.amcp_unqualified_types].sort(),
    evidence.x.criterion_types,
  );
  const f = fixture();
  try {
    const native = structuredClone(evidence.x.response_example);
    native.request.params.account_id = account;
    f.respond(() => Response.json(native));
    const out = await f.call({payload: evidence.x.request_example});
    assert.equal(out.success, true, JSON.stringify(out));
    assert.deepEqual(JSON.parse(f.calls[0].body), evidence.x.request_example);
    assert.deepEqual(out.data.data.data.audience_size, {min: 38236294, max: 42261167});
    for (const s of Object.values(evidence.sources)) assert.match(s.sha256, /^[a-f0-9]{64}$/);
  } finally {
    f.store.close();
  }
});
test('X estimate total deadline aborts the request and does not use another provider error code', async t => {
  const f = fixture();
  let elapsed = 0;
  try {
    t.mock.method(performance, 'now', () => elapsed);
    f.respond(() => {
      elapsed = 60001;
      return Response.json(response());
    });
    const out = await f.call();
    assert.equal(out.success, false, JSON.stringify(out));
    assert.equal(out.error.code, 'X_AUDIENCE_LIMIT');
    assert.equal(f.calls.length, 1);
  } finally {
    t.mock.restoreAll();
    f.store.close();
  }
});
