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
import {readXTargetingBatchState} from '../dist/src/x-targeting-batch.js';
import fs from 'node:fs';
import {actionContracts} from '../dist/src/action-contracts.js';
const evidence = JSON.parse(fs.readFileSync('tests/fixtures/x-targeting-batch-evidence.json', 'utf8'));

const registry = new Registry(),
  gateway = 'x_ads_native_action',
  account = 'acct1';
const actor = {tenantId: 'x-batch-test', userId: 'operator', role: 'operator'},
  admin = {...actor, role: 'admin'};
const secret = {
  accessToken: 'synthetic-token',
  consumerKey: 'synthetic-key',
  consumerSecret: 'synthetic-secret',
  tokenSecret: 'synthetic-token-secret',
};
const action = 'x_batch_accounts_account_id_targeting_criteria_post';
const create = (value = 'technology', parent = 'line1') => ({
  operation_type: 'Create',
  params: {line_item_id: parent, targeting_type: 'BROAD_KEYWORD', targeting_value: value},
});
const remove = id => ({operation_type: 'Delete', params: {targeting_criterion_id: id}});
const copy = x => structuredClone(x);
function setup(options = {}) {
  const store = new Store(options.db ?? ':memory:', Buffer.alloc(32, 73).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'x',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    secret,
  );
  const state = {
    account: {id: account, deleted: false, currency: 'USD', approval_status: 'ACCEPTED'},
    lines: {
      line1: {
        id: 'line1',
        campaign_id: 'camp1',
        deleted: false,
        entity_status: 'PAUSED',
        bid_amount_local_micro: 1000000,
        placements: ['ALL_ON_TWITTER'],
      },
    },
    campaigns: {
      camp1: {
        id: 'camp1',
        deleted: false,
        entity_status: 'ACTIVE',
        currency: 'USD',
        daily_budget_amount_local_micro: 100000000,
      },
    },
    criteria: [
      {
        id: 'old1',
        line_item_id: 'line1',
        targeting_type: 'LOCATION',
        targeting_value: 'loc1',
        operator_type: 'EQ',
        deleted: false,
      },
    ],
    audiences: {},
    users: [],
  };
  const calls = [];
  let writes = 0,
    reads = 0;
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      method = init?.method ?? 'GET';
    calls.push({
      method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      body: init?.body,
      headers: init?.headers,
    });
    if (method !== 'GET') {
      writes++;
      const ops = JSON.parse(init.body);
      await options.beforeWrite?.(state, store, ops);
      const data = ops.map((op, i) => {
        if (op.operation_type === 'Delete') {
          const row = state.criteria.find(r => r.id === op.params.targeting_criterion_id);
          if (row) row.deleted = true;
          return copy(row);
        }
        const row = {...op.params, id: 'new' + i, operator_type: op.params.operator_type ?? 'EQ', deleted: false};
        state.criteria.push(row);
        return copy(row);
      });
      let response = {data, request: ops.map(op => ({...copy(op), params: {...op.params, account_id: account}}))};
      response = (await options.receipt?.(response, state, store)) ?? response;
      return Response.json(response);
    }
    reads++;
    await options.beforeRead?.(u, state, store, reads);
    const suffix = u.pathname.replace('/12/accounts/' + account, '');
    let data;
    if (!suffix) data = state.account;
    else if (suffix.startsWith('/line_items/')) data = state.lines[suffix.split('/').at(-1)];
    else if (suffix.startsWith('/campaigns/')) data = state.campaigns[suffix.split('/').at(-1)];
    else if (suffix.startsWith('/custom_audiences/')) data = state.audiences[suffix.split('/').at(-1)];
    else if (suffix === '/promotable_users') data = state.users;
    else if (suffix === '/targeting_criteria')
      data = state.criteria.filter(
        r => !r.deleted && u.searchParams.get('line_item_ids').split(',').includes(r.line_item_id),
      );
    else if (suffix.startsWith('/targeting_criteria/'))
      data = state.criteria.find(r => r.id === suffix.split('/').at(-1));
    else throw Error('Unexpected synthetic read ' + suffix);
    let response = {
      data: copy(data),
      request: {params: {account_id: account, ...Object.fromEntries(u.searchParams)}},
      next_cursor: null,
    };
    response = (await options.readResponse?.(response, u, state, store, reads)) ?? response;
    return Response.json(response);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (ops = [create(), remove('old1')], extra = {}) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: account, payload: ops, ...extra}},
      actor,
    );
  const execute = (review, who = actor, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: review.data.review_id,
        idempotency_key: review.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      who,
    );
  const verify = review => service.call('amcp_campaign', {action: 'verify', review_id: review.data.review_id}, actor);
  return {store, service, state, calls, prepare, execute, verify, reads: () => reads, writes: () => writes};
}

test('X atomic targeting batch prepares, sends JSON once, verifies full membership and replays', async () => {
  const x = setup();
  try {
    const p = await x.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(x.writes(), 0);
    const r = await x.execute(p);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(x.writes(), 1);
    const v = await x.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    const call = x.calls.find(c => c.method === 'POST');
    assert.match(call.path, /\/12\/batch\/accounts\/acct1\/targeting_criteria$/);
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(call.body), [create(), remove('old1')]);
    const replay = await x.execute(p);
    assert.equal(replay.data.replayed, true);
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('X targeting batch refuses live parents before a mutation', async () => {
  const x = setup();
  try {
    x.state.lines.line1.entity_status = 'ACTIVE';
    const p = await x.prepare();
    assert.equal(p.success, false);
    assert.equal(p.error.code, 'TARGETING_PARENT_NOT_PAUSED', JSON.stringify(p));
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('X targeting batch rejects malformed and unqualified operations before reads', async () => {
  const x = setup();
  try {
    const invalid = [
      [],
      Array.from({length: 101}, (_, i) => create('key' + i)),
      [{operation_type: 'Update', params: create().params}],
      [{...create(), params: {...create().params, targeting_type: 'APP_LIST'}}],
      [{...create(), params: {...create().params, targeting_type: 'TV_SHOW'}}],
      [{...create(), params: {...create().params, operator_type: 'GTE'}}],
      [{...create(), params: {...create().params, targeting_value: 1}}],
      [{...create(), params: {...create().params, account_id: 'foreign'}}],
      [create(), create()],
      [remove('old1'), remove('old1')],
      [{...remove('old1'), params: {targeting_criterion_id: 'old1', line_item_id: 'line1'}}],
      [{...create(), params: {...create().params, line_item_id: '../else'}}],
    ];
    for (const ops of invalid) {
      const p = await x.prepare(ops);
      assert.equal(p.success, false, JSON.stringify(ops));
    }
    assert.equal(x.reads(), 0);
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('X targeting batch accepts its full 100-operation local bound and preserves Unicode', async () => {
  const x = setup();
  try {
    const ops = Array.from({length: 100}, (_, i) => create('عقار 😀 ' + i)),
      p = await x.prepare(ops);
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await x.execute(p)).success, true);
    assert.equal((await x.verify(p)).data.status, 'verified');
    assert.equal(x.writes(), 1);
    assert.equal(x.state.criteria.length, 101);
  } finally {
    x.store.close();
  }
});

test('X targeting batch changes multiple paused parents while preserving untouched membership', async () => {
  const x = setup();
  try {
    x.state.lines.line2 = {...x.state.lines.line1, id: 'line2'};
    x.state.criteria.push({...x.state.criteria[0], id: 'old2', line_item_id: 'line2'});
    const p = await x.prepare([create('alpha'), create('beta', 'line2'), remove('old1')]);
    assert.equal(p.success, true, JSON.stringify(p));
    await x.execute(p);
    assert.equal((await x.verify(p)).data.status, 'verified');
    assert.equal(x.state.criteria.find(r => r.id === 'old2').deleted, false);
  } finally {
    x.store.close();
  }
});

test('X targeting batch refuses missing, deleted, foreign and ambiguous current resources', async () => {
  for (const mutate of [
    s => {
      s.criteria[0].account_id = 'else';
    },
    s => {
      s.criteria[0].deleted = true;
    },
    s => {
      s.criteria[0].line_item_id = 'else';
    },
    s => {
      s.lines.line1.campaign_id = 'else';
    },
    s => {
      s.campaigns.camp1.currency = 'SAR';
    },
    s => {
      s.account.currency = null;
    },
    s => {
      s.criteria.push(copy(s.criteria[0]));
    },
  ]) {
    const x = setup();
    try {
      mutate(x.state);
      const p = await x.prepare();
      assert.equal(p.success, false, JSON.stringify(p));
      assert.equal(x.writes(), 0);
    } finally {
      x.store.close();
    }
  }
});

test('X targeting batch ignores response telemetry and set order, but protects real audience and parent configuration', async () => {
  for (const change of ['telemetry', 'criteria', 'bid', 'budget', 'name', 'unknown_array']) {
    const x = setup();
    try {
      x.state.lines.line1.name = 'original';
      x.state.lines.line1.future_ordered = ['a', 'b'];
      x.state.criteria.push({...x.state.criteria[0], id: 'keep', targeting_value: 'loc2'});
      const p = await x.prepare();
      assert.equal(p.success, true, JSON.stringify(p));
      if (change === 'telemetry') {
        x.state.criteria.reverse();
        x.state.criteria.forEach(r => {
          r.updated_at = 'later';
          r.name = 'Localized new name';
        });
        x.state.lines.line1.effective_status = 'NEW';
        x.state.lines.line1.placements.reverse();
      }
      if (change === 'criteria') x.state.criteria.find(r => r.id === 'keep').targeting_value = 'loc3';
      if (change === 'bid') x.state.lines.line1.bid_amount_local_micro++;
      if (change === 'budget') x.state.campaigns.camp1.daily_budget_amount_local_micro++;
      if (change === 'name') x.state.lines.line1.name = 'changed';
      if (change === 'unknown_array') x.state.lines.line1.future_ordered.reverse();
      const out = await x.execute(p);
      if (change === 'telemetry') {
        assert.equal(out.success, true, JSON.stringify(out));
        assert.equal((await x.verify(p)).data.status, 'verified');
      } else {
        assert.equal(out.error.code, 'STATE_CHANGED', JSON.stringify(out));
        assert.ok(out.error.details.changed_fields.length);
        // R25 M1 (r25-m1-diff, lead review S1-1): the family keeps its whole state in one entry, so every changed field of
        // the line items, criteria and campaigns is material, whichever read of the review its first subscript names.
        assert.deepEqual(out.error.details.material, out.error.details.changed_fields, change);
        assert.equal(x.writes(), 0);
      }
    } finally {
      x.store.close();
    }
  }
});

test('X targeting batch checks the complete projected audience for duplicate, age and custom-lookalike conflicts', async () => {
  for (const kind of ['duplicate', 'opposite', 'age', 'custom']) {
    const x = setup();
    try {
      let op = create();
      if (kind === 'duplicate' || kind === 'opposite')
        op = {
          operation_type: 'Create',
          params: {
            line_item_id: 'line1',
            targeting_type: 'LOCATION',
            targeting_value: 'loc1',
            ...(kind === 'opposite' ? {operator_type: 'NE'} : {}),
          },
        };
      if (kind === 'age') {
        x.state.criteria.push({
          id: 'age1',
          line_item_id: 'line1',
          targeting_type: 'AGE',
          targeting_value: 'AGE_18_TO_24',
          deleted: false,
        });
        op.params.targeting_type = 'AGE';
        op.params.targeting_value = 'AGE_25_TO_34';
      }
      if (kind === 'custom') {
        x.state.criteria.push({
          id: 'aud1',
          line_item_id: 'line1',
          targeting_type: 'CUSTOM_AUDIENCE',
          targeting_value: 'audience1',
          deleted: false,
        });
        op.params.targeting_type = 'CUSTOM_AUDIENCE_EXPANDED';
        op.params.targeting_value = 'audience2';
      }
      const p = await x.prepare([op]);
      assert.equal(p.error.code, 'INVALID_X_TARGETING_BATCH', JSON.stringify(p));
      assert.equal(x.writes(), 0);
    } finally {
      x.store.close();
    }
  }
});

test('X targeting batch requires account-owned targetable audiences and current FULL authors', async () => {
  for (const kind of ['audience', 'author'])
    for (const valid of [true, false]) {
      const x = setup();
      try {
        const op = create();
        op.params.targeting_type = kind === 'audience' ? 'CUSTOM_AUDIENCE' : 'FOLLOWERS_OF_USER';
        op.params.targeting_value = kind === 'audience' ? 'audience1' : '9000000000000000001';
        if (kind === 'audience') x.state.audiences.audience1 = {id: 'audience1', deleted: false, targetable: valid};
        else
          x.state.users = [
            {
              id: 'user1',
              user_id: op.params.targeting_value,
              deleted: false,
              promotable_user_type: valid ? 'FULL' : 'RETWEETS_ONLY',
            },
          ];
        const p = await x.prepare([op]);
        assert.equal(p.success, valid, JSON.stringify(p));
        if (valid) {
          await x.execute(p);
          assert.equal((await x.verify(p)).data.status, 'verified');
        } else {
          assert.equal(p.error.code, 'RESOURCE_SCOPE_REQUIRED');
          assert.equal(x.writes(), 0);
        }
      } finally {
        x.store.close();
      }
    }
});

test('X targeting batch fails closed on incomplete, failed and repeated pagination', async () => {
  for (const kind of ['partial', 'foreign', 'error', 'item_error', 'loop', 'count', 'missing']) {
    const x = setup({
      readResponse: (d, u) => {
        if (!u.pathname.endsWith('/targeting_criteria')) return d;
        if (kind === 'partial') d.truncated = true;
        if (kind === 'foreign') d.request.params.account_id = 'else';
        if (kind === 'error') d.errors = [{code: 'ERROR'}];
        if (kind === 'item_error') d.operation_errors = [{code: 'ERROR'}];
        if (kind === 'loop') d.next_cursor = 'repeat';
        if (kind === 'count') d.total_count = 9;
        if (kind === 'missing') delete d.data;
        return d;
      },
    });
    try {
      const p = await x.prepare();
      assert.equal(p.success, false, kind);
      assert.equal(x.writes(), 0);
    } finally {
      x.store.close();
    }
  }
});

test('X targeting batch follows and reconciles all native pages without silently dropping criteria', async () => {
  const x = setup({
    readResponse: (d, u) => {
      if (!u.pathname.endsWith('/targeting_criteria')) return d;
      const rows = d.data;
      d.data = u.searchParams.has('cursor') ? rows.slice(1) : rows.slice(0, 1);
      d.next_cursor = u.searchParams.has('cursor') ? null : 'next';
      return d;
    },
  });
  try {
    x.state.criteria.push({...x.state.criteria[0], id: 'keep', targeting_value: 'loc2'});
    const p = await x.prepare();
    assert.equal(p.success, true, JSON.stringify(p));
    await x.execute(p);
    assert.equal((await x.verify(p)).data.status, 'verified');
    assert.ok(x.calls.some(c => c.query.cursor === 'next'));
  } finally {
    x.store.close();
  }
});

test('X targeting batch detects changes during initial dependency reads', async () => {
  const x = setup({
    beforeRead: (u, s, _store, n) => {
      if (n === 6) s.lines.line1.name = 'raced';
    },
  });
  try {
    const p = await x.prepare();
    assert.equal(p.error.code, 'X_TARGETING_STATE_UNVERIFIED', JSON.stringify(p));
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('X targeting batch preserves authorization, review immutability, expiry and owner deletion controls', async () => {
  for (const kind of ['grant', 'connection', 'reader', 'tenant', 'user', 'confirm', 'tamper', 'expiry', 'deletion']) {
    const x = setup();
    try {
      const p = await x.prepare();
      assert.equal(p.success, true, JSON.stringify(p));
      if (kind === 'grant' || kind === 'connection') {
        const c = x.store.listConnections(actor.tenantId)[0];
        x.store.putConnection(admin, {...c, ...(kind === 'grant' ? {writeAccounts: []} : {enabled: false})}, secret);
      }
      if (kind === 'deletion')
        saveSpendPolicy(x.store, admin, {
          gateway,
          account_id: account,
          policy: {allow_deletion: false},
          confirmed: true,
        });
      if (kind === 'tamper' || kind === 'expiry') {
        const review = x.store.document(actor.tenantId, 'write_review', p.data.review_id);
        if (kind === 'tamper') review.plan.body[0].params.targeting_value = 'tampered';
        else review.expires_at = 0;
        x.store.putDocument(actor.tenantId, 'write_review', p.data.review_id, review);
      }
      const who =
        kind === 'reader'
          ? {...actor, role: 'reader'}
          : kind === 'tenant'
            ? {...actor, tenantId: 'other'}
            : kind === 'user'
              ? {...actor, userId: 'other'}
              : actor;
      const r = await x.execute(p, who, kind === 'confirm' ? {confirmed: false} : {});
      assert.equal(r.success, false, kind + JSON.stringify(r));
      assert.equal(x.writes(), 0);
    } finally {
      x.store.close();
    }
  }
});

for (const kind of ['login', 'account', 'write_grant', 'actor'])
  test('X targeting batch stops after in-flight ' + kind + ' withdrawal', async () => {
    let active = false;
    const x = setup({
      readResponse: (d, _u, _s, store) => {
        if (active) {
          active = false;
          const c = store.listConnections(actor.tenantId)[0];
          if (kind === 'actor')
            store.assertActorActive = () => {
              throw Error('Synthetic withdrawn actor');
            };
          else
            store.putConnection(
              admin,
              {
                ...c,
                ...(kind === 'account'
                  ? {accounts: ['different'], writeAccounts: []}
                  : kind === 'write_grant'
                    ? {writeAccounts: []}
                    : {}),
              },
              kind === 'login' ? {...secret, accessToken: 'replaced'} : secret,
            );
        }
        return d;
      },
    });
    try {
      const p = await x.prepare();
      assert.equal(p.success, true, JSON.stringify(p));
      const before = x.reads();
      active = true;
      const r = await x.execute(p);
      assert.equal(r.success, false);
      assert.equal(x.reads(), before + 1);
      assert.equal(x.writes(), 0);
    } finally {
      x.store.close();
    }
  });

test('X targeting batch validates every ordered receipt and never resubmits failed or lost outcomes', async () => {
  for (const kind of ['missing', 'reversed', 'foreign', 'wrong_parent', 'old_id', 'partial', 'item_error', 'loss']) {
    const x = setup({
      receipt: d => {
        if (kind === 'loss') throw Error('Lost accepted response');
        if (kind === 'missing') d.data.pop();
        if (kind === 'reversed') d.data.reverse();
        if (kind === 'foreign') d.request[0].params.account_id = 'else';
        if (kind === 'wrong_parent') d.data[0].line_item_id = 'else';
        if (kind === 'old_id') d.data[0].id = 'old1';
        if (kind === 'partial') d.partial = true;
        if (kind === 'item_error') d.operation_errors = [null, {code: 'INVALID_PARAMETER'}];
        return d;
      },
    });
    try {
      const p = await x.prepare();
      assert.equal(p.success, true);
      const r = await x.execute(p);
      assert.ok(!r.success || !r.data.success, kind);
      await x.execute(p);
      assert.equal(x.writes(), 1);
      assert.notEqual((await x.verify(p)).data?.status, 'verified');
    } finally {
      x.store.close();
    }
  }
});

test('X targeting batch reads complete resulting membership and refuses ignored or extra changes', async () => {
  for (const kind of ['ignored_create', 'ignored_delete', 'extra', 'changed_parent']) {
    const x = setup({
      receipt: (d, s) => {
        if (kind === 'ignored_create') s.criteria.pop();
        if (kind === 'ignored_delete') s.criteria.find(r => r.id === 'old1').deleted = false;
        if (kind === 'extra')
          s.criteria.push({...s.criteria[0], id: 'unexpected', targeting_value: 'other', deleted: false});
        if (kind === 'changed_parent') s.lines.line1.entity_status = 'ACTIVE';
        return d;
      },
    });
    try {
      const p = await x.prepare();
      assert.equal(p.success, true);
      assert.equal((await x.execute(p)).success, true);
      const v = await x.verify(p);
      assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
      assert.ok(v.data.checks[0].changed_fields.length);
      assert.equal(x.writes(), 1);
    } finally {
      x.store.close();
    }
  }
});

test('X targeting batch retains accepted receipts before late account withdrawal', async () => {
  const x = setup({
    receipt: (d, _s, store) => {
      const c = store.listConnections(actor.tenantId)[0];
      store.putConnection(admin, {...c, accounts: ['different'], writeAccounts: []}, secret);
      return d;
    },
  });
  try {
    const p = await x.prepare(),
      r = await x.execute(p);
    assert.equal(r.success, false);
    const saved = x.store.db
      .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
      .get(actor.tenantId, p.data.review_id);
    assert.equal(saved.state, 'complete', JSON.stringify(r));
    assert.equal(JSON.parse(saved.result).success, true);
    assert.equal(x.writes(), 1);
  } finally {
    x.store.close();
  }
});

test('X targeting batch durable claims survive concurrent execution and SQLite reopen', async () => {
  for (const lost of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'amcp-xbatch-')),
      db = join(dir, 'test.sqlite');
    let x = setup({
      db,
      receipt: d => {
        if (lost) throw Error('Lost accepted response');
        return d;
      },
    });
    try {
      const p = await x.prepare();
      assert.equal(p.success, true);
      await Promise.all([x.execute(p), x.execute(p)]);
      assert.equal(x.writes(), 1);
      x.store.close();
      x = setup({db});
      const replay = await x.execute(p);
      assert.equal(x.writes(), 0);
      if (lost) assert.equal(replay.error.code, 'WRITE_OUTCOME_UNCERTAIN');
      else assert.equal(replay.data.replayed, true);
    } finally {
      x.store.close();
      removeTestDirectory(dir, 'amcp-xbatch-');
    }
  }
});

test('X targeting batch cannot bypass review through the native gateway', async () => {
  const x = setup();
  try {
    const r = await x.service.call(
      gateway,
      {action, account_id: account, payload: [create()], dry_run: false, confirmed: true, skip_preflight: true},
      actor,
    );
    assert.equal(r.success, false);
    assert.equal(x.writes(), 0);
    assert.equal(x.reads(), 0);
  } finally {
    x.store.close();
  }
});

test('X targeting batch enforces monotonic read deadlines before further egress', async t => {
  const x = setup();
  try {
    const r = await x.service.call(
        'amcp_write',
        {action: 'inspect', gateway, arguments: {action, account_id: account, payload: [create()]}},
        actor,
      ),
      plan = r.data.request;
    let clock = 0,
      calls = 0;
    t.mock.method(performance, 'now', () => clock);
    await assert.rejects(
      readXTargetingBatchState(plan, async () => {
        calls++;
        clock = 60001;
        return {
          status: 200,
          headers: {},
          data: {data: copy(x.state.account), request: {params: {account_id: account}}},
        };
      }),
      e => e.code === 'X_TARGETING_LIMIT',
    );
    assert.equal(calls, 1);
  } finally {
    t.mock.restoreAll();
    x.store.close();
  }
});

test('X targeting batch accepts the official ordered create/delete example with exact account substitution', async () => {
  const x = setup({receipt: d => ({...d, data_type: 'targeting_criterion'})});
  try {
    const ops = copy(evidence.request_example),
      nativeRows = evidence.response_example.data;
    x.state.lines = {};
    x.state.criteria = [];
    for (const row of nativeRows)
      x.state.lines[row.line_item_id] = {
        id: row.line_item_id,
        campaign_id: 'camp1',
        deleted: false,
        entity_status: 'PAUSED',
      };
    x.state.criteria.push({...copy(nativeRows[1]), deleted: false});
    const p = await x.prepare(ops);
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await x.execute(p)).success, true);
    assert.equal((await x.verify(p)).data.status, 'verified');
    assert.equal(evidence.documented_maximum, 500);
    assert.equal(evidence.amcp_limits.operations, 100);
    assert.match(evidence.source.sha256, /^[a-f0-9]{64}$/);
  } finally {
    x.store.close();
  }
});

test('X targeting batch publishes a distinct tested action family and inspect example', async () => {
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].family, 'x_targeting_batch');
  assert.equal(rows[0].status, 'reviewed_write_family');
  assert.ok(rows[0].tests.includes('tests/x-targeting-batch.test.mjs'));
});

test('X targeting batch freezes shared-audience access while ignoring audience size telemetry', async () => {
  for (const mode of ['size', 'access', 'targetable']) {
    const x = setup();
    try {
      const op = create();
      op.params.targeting_type = 'CUSTOM_AUDIENCE';
      op.params.targeting_value = 'audience1';
      x.state.audiences.audience1 = {
        id: 'audience1',
        deleted: false,
        targetable: true,
        owner_account_id: 'sharedowner',
        permission_level: 'READ_ONLY',
        audience_size: 1000,
      };
      const p = await x.prepare([op]);
      assert.equal(p.success, true, JSON.stringify(p));
      if (mode === 'size') x.state.audiences.audience1.audience_size = 1100;
      if (mode === 'access') x.state.audiences.audience1.permission_level = 'READ_WRITE';
      if (mode === 'targetable') x.state.audiences.audience1.targetable = false;
      const r = await x.execute(p);
      if (mode === 'size') {
        assert.equal(r.success, true, JSON.stringify(r));
        assert.equal((await x.verify(p)).data.status, 'verified');
      } else {
        assert.equal(r.success, false);
        assert.equal(x.writes(), 0);
      }
      assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM resource_ownership').get().n, 0);
    } finally {
      x.store.close();
    }
  }
});

test('X targeting batch refuses more than 20 parent line items or 25 private references', async () => {
  for (const kind of ['parents', 'private']) {
    const x = setup();
    try {
      const ops = Array.from({length: kind === 'parents' ? 21 : 26}, (_, i) => ({
        ...create('term' + i, kind === 'parents' ? 'line' + i : 'line1'),
        ...(kind === 'private'
          ? {params: {line_item_id: 'line1', targeting_type: 'CUSTOM_AUDIENCE', targeting_value: 'aud' + i}}
          : {}),
      }));
      const p = await x.prepare(ops);
      assert.equal(p.success, false, JSON.stringify(p));
      assert.equal(x.writes(), 0);
      if (kind === 'parents') assert.equal(x.reads(), 0);
    } finally {
      x.store.close();
    }
  }
});

test('X targeting batch retains membership ordering for unknown arrays and canonicalizes only known sets', async () => {
  const x = setup();
  try {
    x.state.lines.line1.placements = ['ALL_ON_TWITTER', 'PUBLISHER_NETWORK'];
    x.state.criteria[0].future_ordered = ['first', 'second'];
    const p = await x.prepare();
    assert.equal(p.success, true);
    x.state.lines.line1.placements.reverse();
    assert.equal((await x.execute(p)).success, true);
    assert.equal((await x.verify(p)).data.status, 'verified');
  } finally {
    x.store.close();
  }
});

test('X targeting batch transport deadline aborts once with the correct provider-specific error', async t => {
  let clock = 0;
  const x = setup({
    readResponse: d => {
      clock = 60001;
      return d;
    },
  });
  try {
    t.mock.method(performance, 'now', () => clock);
    const p = await x.prepare();
    assert.equal(p.error.code, 'X_TARGETING_LIMIT', JSON.stringify(p));
    assert.equal(x.reads(), 1);
    assert.equal(x.writes(), 0);
  } finally {
    t.mock.restoreAll();
    x.store.close();
  }
});

test('X targeting batch enforces aggregate state byte limits before further reads', async () => {
  const x = setup();
  try {
    const inspected = await x.service.call(
      'amcp_write',
      {action: 'inspect', gateway, arguments: {action, account_id: account, payload: [create()]}},
      actor,
    );
    let calls = 0;
    await assert.rejects(
      readXTargetingBatchState(inspected.data.request, async () => {
        calls++;
        return {
          status: 200,
          headers: {},
          data: {
            data: x.state.account,
            request: {params: {account_id: account}},
            telemetry: 'x'.repeat(8 * 1024 * 1024),
          },
        };
      }),
      e => e.code === 'X_TARGETING_LIMIT',
    );
    assert.equal(calls, 1);
  } finally {
    x.store.close();
  }
});

for (const mode of ['login', 'account', 'actor'])
  test('X targeting verification stops on in-flight ' + mode + ' withdrawal', async () => {
    let active = false;
    const x = setup({
      readResponse: (d, _u, _s, store) => {
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
              {...c, ...(mode === 'account' ? {accounts: ['different'], writeAccounts: []} : {})},
              mode === 'login' ? {...secret, accessToken: 'replaced'} : secret,
            );
        }
        return d;
      },
    });
    try {
      const p = await x.prepare();
      assert.equal(p.success, true);
      await x.execute(p);
      const before = x.reads();
      active = true;
      const v = await x.verify(p);
      assert.notEqual(v.data?.status, 'verified');
      assert.equal(x.reads(), before + 1);
      assert.equal(x.writes(), 1);
    } finally {
      x.store.close();
    }
  });

test('X targeting batch remains bound to its original login when another connection grants the same account', async () => {
  const x = setup();
  try {
    const p = await x.prepare();
    assert.equal(p.success, true);
    const c = x.store.listConnections(actor.tenantId)[0];
    x.store.putConnection(admin, {...c, id: 'another', label: 'Another login'}, secret);
    x.store.putConnection(admin, {...c, writeAccounts: []}, secret);
    const r = await x.execute(p);
    assert.equal(r.success, false);
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});
