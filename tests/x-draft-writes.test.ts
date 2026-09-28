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
import {actionContracts} from '../src/action-contracts.js';
import {assertXDraft, xDraftKind, xDraftOutcome, readXDraftState} from '../src/x-draft-writes.js';
import {removeTestDirectory} from './temp.js';
import type {Connection, JsonObject, CompiledRequest} from '../src/types.js';

const gateway = 'x_ads_native_action',
  account = 'acct1',
  prefix = '/12/accounts/' + account,
  user = '9000000000000000001',
  target = '9000000000000000002',
  created = '9000000000000000003',
  card = 'card://9000000000000000004',
  media = '3_9000000000000000005',
  video = '13_9000000000000000006';
const actor = {tenantId: 'x-drafts', userId: 'operator', role: 'operator' as const},
  owner = {...actor, role: 'admin' as const},
  key = Buffer.alloc(32, 17).toString('base64'),
  registry = new Registry();
const nativeAction = (kind: string) =>
  (
    ({
      create: 'x_accounts_account_id_draft_tweets_post',
      update: 'x_accounts_account_id_draft_tweets_draft_tweet_id_put',
      delete: 'x_accounts_account_id_draft_tweets_draft_tweet_id_delete',
      preview: 'x_accounts_account_id_draft_tweets_preview_draft_tweet_id_post',
    }) as Record<string, string>
  )[kind]!;
const definition = () => ({
  id: target,
  user_id: user,
  nullcast: true,
  text: 'Approved draft',
  name: 'Initial',
  card_uri: null,
  media_keys: [],
});
const createBody = () => ({as_user_id: user, nullcast: true, text: 'Approved draft', name: 'Initial'});
const plan = (kind = 'create', body: JsonObject = createBody()): CompiledRequest => ({
  gateway,
  action: nativeAction(kind),
  accountId: account,
  path: prefix + '/draft_tweets' + (kind === 'create' ? '' : kind === 'preview' ? '/preview/' + target : '/' + target),
  method: kind === 'update' ? 'PUT' : kind === 'delete' ? 'DELETE' : 'POST',
  query: {},
  body,
  headers: {},
  readOnly: false,
  destructive: kind === 'delete',
  requiresConfirmation: true,
  evidence: 'synthetic',
  warnings: [],
});

function fixture(file = ':memory:') {
  const store = new Store(file, key),
    c: Connection = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      scopes: [],
      enabled: true,
      label: 'Synthetic selected author',
    },
    credentials = {
      accessToken: 'synthetic',
      consumerKey: 'synthetic',
      consumerSecret: 'synthetic',
      tokenSecret: 'synthetic',
    },
    calls: JsonObject[] = [],
    records = new Map<string, JsonObject>(),
    mediaRows = new Map<string, JsonObject>([
      [media, {media_key: media, media_type: 'IMAGE', media_status: 'TRANSCODE_COMPLETED', deleted: false}],
      [video, {media_key: video, media_type: 'VIDEO', media_status: 'TRANSCODE_COMPLETED', deleted: false}],
    ]);
  if (!store.listConnections(actor.tenantId).length) store.putConnection(owner, c, credentials);
  let mode = 'success',
    clock = 0,
    hook: ((s: string) => void) | undefined;
  const transport = new NativeTransport(
    async (input, init) => {
      const u = new URL(String(input)),
        method = init?.method ?? 'GET',
        headers = new Headers(init?.headers),
        body = Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))),
        suffix = u.pathname.slice(prefix.length);
      assert.equal(u.origin, 'https://ads-api.x.com');
      assert.ok(u.pathname.startsWith(prefix));
      assert.match(headers.get('authorization') ?? '', /^OAuth /);
      calls.push({method, suffix, query: Object.fromEntries(u.searchParams), body, type: headers.get('content-type')});
      if (method === 'GET') {
        hook?.(suffix);
        if (mode === 'revoke') store.putConnection(owner, {...c, writeAccounts: []}, credentials);
        if (mode === 'disabled') store.putConnection(owner, {...c, enabled: false}, credentials);
        if (mode === 'read_error')
          return Response.json({errors: [{code: 'FORBIDDEN', message: 'Synthetic'}]}, {status: 403});
        const envelope = (value: unknown, extra: JsonObject = {}) =>
          Response.json({
            data: value,
            request: {params: {account_id: account}},
            ...extra,
            ...(mode === 'partial' ? {truncated: true} : {}),
          });
        if (suffix === '') return envelope({id: account, name: 'Synthetic', currency: 'USD'});
        if (suffix === '/promotable_users')
          return envelope([{user_id: user, promotable_user_type: mode === 'retweets' ? 'RETWEETS_ONLY' : 'FULL'}]);
        if (suffix === '/cards/all') {
          assert.equal(u.searchParams.get('card_uris'), card);
          return envelope(
            mode === 'wrong_card'
              ? []
              : [{id: 'card1', card_uri: card, name: 'Approved card', components: [], deleted: false}],
          );
        }
        if (suffix.startsWith('/media_library/'))
          return envelope(
            mode === 'wrong_media'
              ? {...mediaRows.get(media), media_key: '3_99'}
              : {
                  ...mediaRows.get(suffix.split('/').at(-1)!),
                  media_url: 'https://example.com/signed?token=' + clock,
                  tweeted: clock % 2 === 0,
                  ...(mode === 'pending_media' ? {media_status: 'TRANSCODE_IN_PROGRESS'} : {}),
                },
          );
        if (suffix === '/draft_tweets') {
          assert.equal(u.searchParams.get('user_id'), user);
          assert.equal(u.searchParams.get('count'), '200');
          let rows = [...records.values()].map(v => structuredClone(v));
          if (mode === 'large') rows = Array.from({length: 1001}, (_, i) => ({...definition(), id: String(1000 + i)}));
          if (mode === 'foreign_user') rows = rows.map(v => ({...v, user_id: '99'}));
          if (mode === 'foreign_account') rows = rows.map(v => ({...v, account_id: 'other'}));
          if (mode === 'duplicate') rows = [...rows, ...rows];
          if (mode === 'cursor_loop' || mode === 'paged')
            return envelope(u.searchParams.has('cursor') ? rows.slice(1) : rows.slice(0, 1), {
              next_cursor: mode === 'cursor_loop' || !u.searchParams.has('cursor') ? 'next' : null,
            });
          return envelope(rows, {next_cursor: null});
        }
        if (suffix.startsWith('/draft_tweets/')) {
          const row = records.get(suffix.split('/').at(-1)!);
          if (!row) return Response.json({errors: [{code: 'NOT_FOUND', message: 'Synthetic'}]}, {status: 404});
          return envelope({
            ...structuredClone(row),
            updated_at: String(++clock),
            ...(mode === 'foreign_user' ? {user_id: '99'} : {}),
            ...(mode === 'foreign_account' ? {account_id: 'other'} : {}),
          });
        }
        throw Error('Unexpected read ' + suffix);
      }
      if (init?.body) assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
      const rid = method === 'POST' && !suffix.includes('/preview/') ? created : suffix.split('/').at(-1)!;
      let receipt: JsonObject;
      if (suffix.includes('/preview/'))
        receipt = {
          request: {params: {account_id: account, draft_tweet_id: rid}},
          message: 'Synthetic notification accepted',
        };
      else {
        let row: JsonObject =
          method === 'POST'
            ? {id: rid, user_id: body.as_user_id, text: '', name: null, card_uri: null, media_keys: [], nullcast: true}
            : {...records.get(rid)!};
        if (method === 'DELETE') {
          receipt = {data: {...row, status: 'DELETED'}};
          if (mode !== 'ignored') records.delete(rid);
        } else {
          for (const k of ['name', 'text']) if (Object.hasOwn(body, k)) row[k] = body[k];
          if (Object.hasOwn(body, 'card_uri')) row.card_uri = body.card_uri || null;
          if (Object.hasOwn(body, 'media_keys')) row.media_keys = body.media_keys ? body.media_keys.split(',') : [];
          if (Object.hasOwn(body, 'nullcast')) row.nullcast = body.nullcast === 'true';
          if (mode !== 'ignored') records.set(rid, row);
          receipt = {data: row};
        }
      }
      if (mode === 'loss') throw Error('Synthetic response loss after mutation');
      if (mode === 'bad_receipt') return Response.json({data: {...receipt.data, user_id: '99'}, message: 'Synthetic'});
      if (mode === 'empty_receipt') return Response.json({});
      if (mode === 'error_receipt')
        return Response.json({...receipt, errors: [{code: 'INVALID_PARAMETER', message: 'Synthetic'}]});
      return Response.json(receipt);
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
  const args = (kind: string, payload: JsonObject = {}) => ({
    action: nativeAction(kind),
    account_id: account,
    ...(kind === 'create' ? {} : {params: {draft_tweet_id: target}}),
    ...(Object.keys(payload).length ? {payload} : {}),
  });
  const prepare = (kind = 'create', payload = createBody() as JsonObject) =>
      service.call('amcp_write', {action: 'prepare', gateway, arguments: args(kind, payload)}, actor),
    execute = (r: JsonObject, extra: JsonObject = {}) =>
      service.call(
        'amcp_write',
        {
          action: 'execute',
          review_id: r.data.review_id,
          idempotency_key: r.data.idempotency_key,
          confirmed: true,
          ...extra,
        },
        actor,
      ),
    verify = (r: JsonObject) => service.call('amcp_campaign', {action: 'verify', review_id: r.data.review_id}, actor);
  return {
    store,
    c,
    credentials,
    service,
    calls,
    records,
    mediaRows,
    args,
    prepare,
    execute,
    verify,
    setMode: (m: string) => (mode = m),
    onRead: (fn: typeof hook) => (hook = fn),
    seed: () => records.set(target, definition()),
    writes: () => calls.filter(v => v.method !== 'GET').length,
  };
}

test('all four X draft routes have closed native contracts and preview is a reviewed side effect', () => {
  for (const kind of ['create', 'update', 'delete', 'preview']) assert.equal(xDraftKind(plan(kind)), kind);
  for (const payload of [
    {...createBody(), as_user_id: 123},
    {...createBody(), nullcast: 'true'},
    {...createBody(), media_keys: [media]},
    {...createBody(), card_uri: card, media_keys: media},
    {...createBody(), text: '\ud800'},
    {...createBody(), schedule_time: '2030-01-01'},
    {...createBody(), entity_status: 'PAUSED'},
  ])
    assert.throws(() => assertXDraft(plan('create', payload)));
  assert.throws(() => assertXDraft({...plan(), query: {method: 'DELETE'}}));
  assert.equal(xDraftKind({...plan(), origin: 'https://api.x.com'}), undefined);
});

test('a draft saves explicit intent without publishing, preserves Unicode/form encoding, and replays once', async () => {
  const f = fixture();
  try {
    saveSpendPolicy(f.store, owner, {
      gateway,
      account_id: account,
      policy: {allow_activation: false, max_budget_native: 0},
      confirmed: true,
    });
    const r = await f.prepare('create', {...createBody(), text: 'Budget homes & منازل + family', nullcast: false});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.creative_impact.publishes, false);
    const out = await f.execute(r);
    assert.equal(out.data.success, true, JSON.stringify(out));
    assert.equal((await f.verify(r)).data.status, 'verified');
    const wire = f.calls.find(v => v.method === 'POST')!;
    assert.equal(wire.body.nullcast, 'false');
    assert.equal(wire.body.text, 'Budget homes & منازل + family');
    await f.execute(r);
    assert.equal(f.writes(), 1);
    assert.ok(f.calls.every(v => !v.suffix.includes('/tweet/') && !v.suffix.includes('/scheduled_tweets')));
  } finally {
    f.store.close();
  }
});

test('draft updates verify fields and explicit attachment clears, while author transfer stays forbidden', async () => {
  const f = fixture();
  try {
    f.seed();
    f.records.get(target)!.card_uri = card;
    const r = await f.prepare('update', {
      text: 'Changed',
      name: 'New',
      card_uri: '',
      media_keys: media,
      nullcast: false,
    });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal((await f.execute(r)).data.success, true);
    assert.equal((await f.verify(r)).data.status, 'verified');
    const wire = f.calls.find(v => v.method === 'PUT')!;
    assert.equal(wire.body.card_uri, '');
    const bad = await f.prepare('update', {as_user_id: '99'});
    assert.equal(bad.success, false);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('media-only drafts require ready account media and verify ordered native attachment lists', async () => {
  const f = fixture();
  try {
    const second = '3_9000000000000000010';
    f.mediaRows.set(second, {
      media_key: second,
      media_type: 'IMAGE',
      media_status: 'TRANSCODE_COMPLETED',
      deleted: false,
    });
    const r = await f.prepare('create', {as_user_id: user, nullcast: true, media_keys: media + ',' + second});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal((await f.execute(r)).data.success, true);
    f.records.get(created)!.media_keys.reverse();
    const v = await f.verify(r);
    assert.equal(v.data.status, 'inconclusive');
    assert.ok(v.data.checks[0].changed_fields.includes('media_keys'));
  } finally {
    f.store.close();
  }
});

test('draft hard deletion verifies complete author-scoped absence rather than interpreting a 404', async () => {
  const f = fixture();
  try {
    f.seed();
    f.records.set(created, {...definition(), id: created});
    const r = await f.prepare('delete', {});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal((await f.execute(r)).data.success, true);
    f.setMode('paged');
    const v = await f.verify(r);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal(v.data.checks[0].verification_scope, 'complete_author_collection_absence');
    assert.equal(f.records.has(created), true);
  } finally {
    f.store.close();
  }
});

test('draft preview records provider acceptance only and never resends a notification during verification or replay', async () => {
  const f = fixture();
  try {
    f.seed();
    const r = await f.prepare('preview', {});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.match(r.data.creative_impact.notification, /notification/);
    assert.equal((await f.execute(r)).data.success, true);
    const v = await f.verify(r);
    assert.equal(v.data.status, 'verified');
    assert.equal(v.data.checks[0].notification_delivery, 'unverified');
    await f.verify(r);
    await f.execute(r);
    assert.equal(f.writes(), 1);
  } finally {
    f.store.close();
  }
});

test('draft malformed reads, missing author, partial results and cursor loops cannot yield a review', async () => {
  for (const mode of [
    'retweets',
    'read_error',
    'foreign_user',
    'foreign_account',
    'duplicate',
    'partial',
    'cursor_loop',
    'large',
  ]) {
    const f = fixture();
    try {
      f.seed();
      f.setMode(mode);
      assert.equal((await f.prepare()).success, false, mode);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('draft cards, media processing and media-type combinations are checked before submission', async () => {
  for (const mode of ['wrong_card', 'wrong_media', 'pending_media', 'mixed']) {
    const f = fixture();
    try {
      f.setMode(mode);
      const body = {
        ...createBody(),
        ...(mode === 'wrong_card' ? {card_uri: card} : {media_keys: mode === 'mixed' ? media + ',' + video : media}),
      };
      assert.equal((await f.prepare('create', body)).success, false, mode);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('draft telemetry changes pass while real text and unknown configuration edits conflict', async () => {
  for (const unknown of [false, true]) {
    const f = fixture();
    try {
      f.seed();
      const first = await f.prepare('update', {name: 'Changed'});
      assert.equal(first.success, true);
      assert.equal((await f.execute(first)).data.success, true);
      const r = await f.prepare('update', {name: 'Again'});
      if (unknown) f.records.get(target)!.futureSetting = ['a', 'b'];
      else f.records.get(target)!.text = 'Changed elsewhere';
      const out = await f.execute(r);
      assert.equal(out.error.code, 'STATE_CHANGED');
      assert.match(JSON.stringify(out.error.details.changed_fields), unknown ? /futureSetting/ : /text/);
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});

test('a draft or author race while reading dependencies refuses preview and update', async () => {
  for (const kind of ['update', 'preview']) {
    const f = fixture();
    try {
      f.seed();
      f.records.get(target)!.media_keys = [media];
      f.onRead(s => {
        if (s.startsWith('/media_library/')) f.records.get(target)!.text = 'Concurrent new copy';
      });
      assert.equal((await f.prepare(kind, kind === 'update' ? {name: 'Changed'} : {})).success, false);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('current draft grants, disabled connection, confirmation, deletion and reader role remain enforced', async () => {
  for (const mode of ['revoke', 'disabled', 'no_confirm', 'delete_policy', 'reader']) {
    const f = fixture();
    try {
      f.seed();
      const kind = mode === 'delete_policy' ? 'delete' : 'preview',
        r = await f.prepare(kind, {});
      assert.equal(r.success, true);
      if (mode === 'revoke' || mode === 'disabled') f.setMode(mode);
      if (mode === 'delete_policy')
        saveSpendPolicy(f.store, owner, {
          gateway,
          account_id: account,
          policy: {allow_deletion: false},
          confirmed: true,
        });
      const out =
        mode === 'reader'
          ? await f.service.call(
              'amcp_write',
              {action: 'prepare', gateway, arguments: f.args('preview', {})},
              {...actor, role: 'reader'},
            )
          : await f.execute(r, mode === 'no_confirm' ? {confirmed: false} : {});
      assert.equal(out.success, false, mode);
      assert.equal(f.writes(), 0);
    } finally {
      f.store.close();
    }
  }
});

test('draft errors, substituted receipts and lost responses retain a single submission claim', async () => {
  for (const kind of ['create', 'update', 'delete', 'preview'])
    for (const mode of ['bad_receipt', 'empty_receipt', 'error_receipt', 'loss']) {
      const f = fixture();
      try {
        f.seed();
        const r = await f.prepare(kind, kind === 'create' ? createBody() : kind === 'update' ? {text: 'Changed'} : {});
        assert.equal(r.success, true, JSON.stringify(r));
        f.setMode(mode);
        const out = await f.execute(r);
        assert.ok(!out.success || !out.data?.success, kind + mode);
        await f.execute(r);
        assert.equal(f.writes(), 1);
        assert.notEqual((await f.verify(r)).data?.status, 'verified');
      } finally {
        f.store.close();
      }
    }
});

test('ignored draft update and deletion never pass read-back, and failed lists never prove absence', async () => {
  for (const kind of ['update', 'delete']) {
    const f = fixture();
    try {
      f.seed();
      const r = await f.prepare(kind, kind === 'update' ? {text: 'Changed'} : {});
      f.setMode('ignored');
      assert.equal((await f.execute(r)).data.success, true);
      assert.equal((await f.verify(r)).data.status, 'inconclusive');
      f.setMode('read_error');
      assert.notEqual((await f.verify(r)).data.status, 'verified');
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  }
});

test('draft durable claims survive concurrent execution and restart without duplicate saves or notifications', async () => {
  for (const kind of ['create', 'preview'])
    for (const lost of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), 'amcp-xdraft-'));
      let f = fixture(join(dir, 'store.sqlite'));
      try {
        f.seed();
        const r = await f.prepare(kind, kind === 'create' ? createBody() : {});
        if (lost) f.setMode('loss');
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
        removeTestDirectory(dir, 'amcp-xdraft-');
      }
    }
});

test('the draft review binds its connection despite duplicate account IDs and cannot be bypassed through the native gateway', async () => {
  const f = fixture();
  try {
    f.seed();
    const r = await f.prepare('preview', {});
    f.store.putConnection(owner, {...f.c, id: 'other'}, f.credentials);
    f.store.putConnection(owner, {...f.c, writeAccounts: []}, f.credentials);
    assert.equal((await f.execute(r)).success, false);
    f.store.putConnection(owner, f.c, f.credentials);
    const direct = await f.service.call(
      gateway,
      {
        ...f.args('preview', {}),
        connection_id: f.c.id,
        dry_run: false,
        confirmed: true,
        idempotency_key: '12345678-1234-4234-9234-123456789abc',
      },
      actor,
    );
    assert.equal(direct.error.code, 'WRITE_REVIEW_REQUIRED');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('X draft receipt validation refuses reused creation IDs and ambiguous notification echoes', () => {
  const before = [{author: {user_id: user}, existing_draft_ids: [target]}];
  assert.equal(xDraftOutcome(plan(), {status: 200, headers: {}, data: {data: definition()}}, before), false);
  assert.equal(
    xDraftOutcome(
      plan('preview', {}),
      {
        status: 200,
        headers: {},
        data: {message: 'Accepted', request: {params: {account_id: 'wrong', draft_tweet_id: target}}},
      },
      before,
    ),
    false,
  );
});

test('all four captured X draft routes retain their action rows and reference lifecycle evidence', () => {
  const names = new Set(['create', 'update', 'delete', 'preview'].map(nativeAction)),
    rows = actionContracts(registry).filter(r => r.gateway === gateway && names.has(r.action));
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => r.family === 'x_drafts' && r.tests.includes('tests/x-draft-writes.test.ts')));
});

test('draft response-byte limits refuse oversized dependency metadata', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      readXDraftState(plan(), async p => {
        calls++;
        return {
          status: 200,
          headers: {},
          data: {data: p.path === prefix ? {id: account, name: 'x'.repeat(4 * 1024 * 1024)} : []},
        };
      }),
    e => e instanceof Error && e.message.includes('bound'),
  );
  assert.equal(calls, 1);
});

test('native successful creation receipts accept the documented 200-series envelope only with exact author and a new identity', () => {
  const before = [{author: {user_id: user}, existing_draft_ids: []}];
  assert.equal(xDraftOutcome(plan(), {status: 201, headers: {}, data: {data: definition()}}, before), true);
  assert.equal(xDraftOutcome(plan(), {status: 400, headers: {}, data: {data: definition()}}, before), false);
  assert.equal(
    xDraftOutcome(plan(), {status: 200, headers: {}, data: {data: definition(), partial: true}}, before),
    false,
  );
});

test('draft read deadlines use monotonic time and are checked again after a slow response', async t => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  await assert.rejects(
    () =>
      readXDraftState(plan(), async () => {
        clock = 61001;
        return {status: 200, headers: {}, data: {data: {id: account}}};
      }),
    e => e instanceof Error && e.message.includes('deadline'),
  );
});

test('draft preparation supports native card and video variants and never changes the media library', async () => {
  for (const extra of [{card_uri: card}, {media_keys: video}]) {
    const f = fixture();
    try {
      const r = await f.prepare('create', {...createBody(), ...extra});
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal((await f.execute(r)).data.success, true);
      assert.equal((await f.verify(r)).data.status, 'verified');
      assert.ok(f.calls.filter(c => c.method !== 'GET').every(c => c.suffix === '/draft_tweets'));
    } finally {
      f.store.close();
    }
  }
});

test('draft read-back rechecks selected account access before returning a cached result', async () => {
  const f = fixture();
  try {
    const r = await f.prepare();
    await f.execute(r);
    assert.equal((await f.verify(r)).data.status, 'verified');
    f.store.putConnection(owner, {...f.c, enabled: false}, f.credentials);
    assert.equal((await f.verify(r)).success, false);
  } finally {
    f.store.close();
  }
});
