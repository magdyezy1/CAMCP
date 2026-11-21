// V2-MCP-06, decision 3, target probe 18: the response budget of the v2 contract profile. An MCP list result over a budget of JSON
// bytes (64 KiB, or `max_bytes` up to 256 KiB) is cut at a row boundary, with `truncated`, the counts and the `next_call` that
// continues it; the continuation is bound to the tenant, the AI client, the person, the access set, the tool and every argument,
// and not to the access token. A legacy client, the website and every other caller are answered whole.
//
// The tests ask it as a client does: real AI clients (registered, authorized, holding tokens) calling the real HTTP stack in both
// protocol eras, a legacy client's whole answer as the truth, and the pieces of a v2 client followed by their next_call until the
// last, whose rows, in order, once each, must be the truth's. Every list path is exercised: a catalogue listing (no provider), a
// provider read that returns a long page and names the next, the list of accounts (a plain array), and a saved report's rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setContractProfile} from '../dist/src/mcp-client-profile.js';
import {callIsRead} from '../dist/src/call-kind.js';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {
  budgetBinding,
  budgetRequest,
  defaultBudgetBytes,
  maxBudgetBytes,
  minBudgetBytes,
} from '../dist/server/mcp-budget.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {oauthStack} from './helpers/mcp-oauth-stack.mjs';
import {range, row} from './helpers/report-packets.mjs';

const eras = ['legacy', 'modern'];
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const call = async (client, name, args) => {
  const result = await client.callTool({name, arguments: args}),
    envelope = result.structuredContent;
  assert.equal(envelope.success, result.isError !== true, 'isError mirrors the envelope');
  assert.equal(result.content[0].text, JSON.stringify(envelope), 'the text is the same envelope');
  return envelope;
};
/** The value at a dotted path of an envelope, `data.data.data`. */
const at = (envelope, path) => path.split('.').reduce((value, key) => value?.[key], envelope);
/** The envelope's data with its list replaced, so what is left is the paging and everything else around the rows. */
const around = (envelope, path) => {
  const copy = structuredClone(envelope),
    keys = path.split('.').slice(1);
  if (!keys.length) return [];
  let node = copy.data;
  for (const key of keys.slice(0, -1)) node = node[key];
  node[keys.at(-1)] = [];
  return copy.data;
};
/** Follows a truncated read by the next_call each piece names; the pieces, first to last. */
async function follow(client, name, first, limit = 80) {
  const pieces = [first];
  while (pieces.at(-1).meta?.budget?.truncated === true) {
    assert.ok(pieces.length < limit, 'the continuation ends');
    const next = pieces.at(-1).meta.budget.next_call;
    assert.equal(next.tool, name);
    pieces.push(await call(client, next.tool, next.arguments));
    assert.equal(pieces.at(-1).success, true, JSON.stringify(pieces.at(-1).error));
  }
  return pieces;
}

/** Two AI clients of one workspace, one on v2 (the other legacy), and a client of each protocol era for either. */
async function stack(t, options) {
  const s = await oauthStack(t, options),
    older = await s.connect('Legacy client'),
    newer = await s.connect('Opted-in client'),
    other = await s.connect('Another opted-in client');
  for (const client of [newer, other]) assert.equal(setContractProfile(s.store, client.client.client_id, 'v2'), true);
  return {...s, older, newer, other};
}

/**
 * The checks every list path must pass, whichever the tool and wherever the rows are: the first piece is under the budget and
 * made of whole rows; the pieces, followed, are the legacy rows in order, once each; the last piece has the result's own paging;
 * a piece's own paging is emptied, so the continuation is the only way forward. `maxBytes` asks a v2 client for another budget
 * than the default (a legacy client cannot send one); `ignore` names the fields of the data that differ between two callers'
 * answers by nature, the moment of the answer and a cursor, which belongs to the client it was issued to: a test that ignores
 * one says what it checks of it instead.
 */
async function exercise(s, era, name, args, {minPieces = 3, maxBytes = defaultBudgetBytes, ignore = []} = {}) {
  const asked = maxBytes === defaultBudgetBytes ? args : {...args, max_bytes: maxBytes},
    legacy = await call(await s.client(era, s.older.access), name, args),
    v2 = await s.client(era, s.newer.access),
    moment = envelope => {
      const copy = structuredClone(envelope);
      for (const key of ignore) delete copy.data[key];
      return copy;
    };
  assert.equal(legacy.success, true, JSON.stringify(legacy.error));
  assert.equal(legacy.meta.budget, undefined, 'a legacy client is answered whole');
  assert.ok(bytes(legacy) > maxBytes, 'the answer is over the budget: ' + bytes(legacy));
  const first = await call(v2, name, asked);
  assert.equal(first.success, true, JSON.stringify(first.error));
  const budget = first.meta.budget,
    path = budget.path,
    truth = at(legacy, path);
  assert.ok(Array.isArray(truth) && truth.length > minPieces, path);
  assert.equal(budget.truncated, true);
  assert.equal(budget.max_bytes, maxBytes);
  assert.ok(bytes(first) <= maxBytes, 'the piece is under the budget: ' + bytes(first));
  assert.equal(budget.rows_total, truth.length);
  assert.equal(budget.rows_before, 0);
  assert.equal(budget.rows_returned + budget.rows_omitted, truth.length);
  // Whole rows, the legacy rows from the start.
  assert.deepEqual(at(first, path), truth.slice(0, budget.rows_returned));
  assert.ok(budget.rows_returned >= 1 && budget.rows_returned < truth.length);
  assert.deepEqual(budget.next_call.arguments, {...asked, continuation: budget.next_call.arguments.continuation});
  assert.equal(typeof budget.next_call.arguments.continuation, 'string');
  // The piece's own paging is emptied, whatever it was: only the continuation goes forward.
  if (first.data && !Array.isArray(first.data)) {
    assert.equal(first.data.truncated, true);
    assert.deepEqual(first.data.next_call, budget.next_call);
    for (const key of ['next_offset', 'next_cursor']) if (key in legacy.data) assert.equal(first.data[key], null, key);
    if ('has_more' in legacy.data) assert.equal(first.data.has_more, true);
  }
  const pieces = await follow(v2, name, first);
  assert.ok(pieces.length >= minPieces, 'pieces ' + pieces.length);
  assert.deepEqual(
    pieces.flatMap(piece => at(piece, path)),
    truth,
    'the rows, in order, once each',
  );
  for (const piece of pieces) assert.ok(bytes(piece) <= maxBytes, 'a piece is under the budget: ' + bytes(piece));
  // The counts add up from piece to piece, and the last piece is not truncated and has the result's own paging again.
  let before = 0;
  for (const piece of pieces) {
    assert.equal(piece.meta.budget.rows_before, before);
    before += piece.meta.budget.rows_returned;
  }
  assert.equal(before, truth.length);
  const last = pieces.at(-1);
  assert.equal(last.meta.budget.truncated, false);
  assert.equal(last.meta.budget.rows_omitted, 0);
  assert.equal(last.meta.budget.next_call, undefined);
  assert.deepEqual(
    around(moment(last), path),
    around(moment(legacy), path),
    'the last piece carries the result’s own paging',
  );
  return {legacy, first, pieces, path};
}

for (const era of eras)
  test(`${era} HTTP: a catalogue listing is cut at row boundaries and followed to the same rows (a list with its own offset paging)`, async t => {
    const s = await stack(t),
      args = {action: 'LIST_ACTIONS', limit: 500},
      {legacy, pieces} = await exercise(s, era, 'meta_native_action', args);
    assert.equal(legacy.data.has_more, true);
    assert.equal(pieces.at(-1).data.has_more, true, 'the page itself has more, as the legacy answer says');
    assert.equal(pieces.at(-1).data.next_offset, 500);
  });

test('the budget is the caller’s to ask for, within a cap, and an answer under it is the answer', async t => {
  const s = await stack(t),
    args = {action: 'LIST_ACTIONS', limit: 500},
    v2 = await s.client('modern', s.newer.access),
    legacy = await call(await s.client('modern', s.older.access), 'meta_native_action', args);
  const pieces = async maxBytes => {
    const first = await call(v2, 'meta_native_action', {...args, max_bytes: maxBytes});
    return {first, all: await follow(v2, 'meta_native_action', first, 200)};
  };
  const small = await pieces(minBudgetBytes),
    large = await pieces(maxBudgetBytes),
    normal = await pieces(defaultBudgetBytes);
  for (const [{first, all}, maxBytes] of [
    [small, minBudgetBytes],
    [large, maxBudgetBytes],
    [normal, defaultBudgetBytes],
  ]) {
    for (const piece of all) assert.ok(bytes(piece) <= maxBytes, bytes(piece) + ' > ' + maxBytes);
    assert.deepEqual(
      all.flatMap(piece => piece.data.actions),
      legacy.data.actions,
    );
    if (bytes(legacy) <= maxBytes) {
      // The whole answer fits the budget the caller asked for: it is the answer, with nothing added.
      assert.equal(all.length, 1);
      assert.equal(first.meta.budget, undefined);
      continue;
    }
    assert.equal(first.meta.budget.max_bytes, maxBytes);
    // The next_call repeats the budget it was asked for.
    assert.equal(first.meta.budget.next_call.arguments.max_bytes, maxBytes);
  }
  assert.ok(
    small.all.length > normal.all.length && normal.all.length > large.all.length,
    'a smaller budget, more pieces',
  );
  // Under the budget nothing is added: the answer is the legacy answer, byte for byte but for the request ID and timing.
  const tiny = {action: 'LIST_ACTIONS', limit: 5},
    plain = await call(v2, 'meta_native_action', tiny),
    whole = await call(await s.client('modern', s.older.access), 'meta_native_action', tiny);
  assert.equal(plain.meta.budget, undefined);
  assert.deepEqual(plain.data, whole.data);
  // A budget that is not a whole number of bytes within the cap is refused, naming the field and the limits.
  for (const bad of [0, 4095, 262145, 1.5, '65536', -1, null, true]) {
    const refused = await call(v2, 'meta_native_action', {...tiny, max_bytes: bad});
    assertRefused(refused, 'INVALID_ARGUMENT', {message: /max_bytes/});
    assert.equal(refused.error.details.field, 'max_bytes');
    assert.deepEqual([refused.error.details.minimum, refused.error.details.maximum], [minBudgetBytes, maxBudgetBytes]);
  }
});

test('probe 18: a continuation with changed arguments, another client, an altered or made-up token is INVALID_CURSOR', async t => {
  const s = await stack(t),
    args = {action: 'LIST_ACTIONS', limit: 500},
    v2 = await s.client('modern', s.newer.access),
    other = await s.client('modern', s.other.access),
    first = await call(v2, 'meta_native_action', args),
    next = first.meta.budget.next_call.arguments;
  assert.equal((await call(v2, 'meta_native_action', next)).success, true, 'the unchanged continuation continues');
  // Every argument changed, added or removed, and the budget with them.
  for (const change of [
    {limit: 499},
    {limit: undefined},
    {offset: 1},
    {max_bytes: 100000},
    {action: 'DESCRIBE_ACTION'},
    {search: 'campaign'},
    {unrelated: 'x'},
  ])
    assertRefused(await call(v2, 'meta_native_action', {...next, ...change}), 'INVALID_CURSOR');
  // The same continuation on another tool.
  assertRefused(await call(v2, 'tiktok_native_action', next), 'INVALID_CURSOR');
  // Another AI client of the same workspace, the same person approving it: the continuation is the first client's.
  assertRefused(await call(other, 'meta_native_action', next), 'INVALID_CURSOR');
  // An altered token, a made-up one, one that is not a token, one that is too long, and the token of a binding with nothing.
  const token = next.continuation,
    flipped = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA'),
    forged = Buffer.from(JSON.stringify({version: 1, binding: 'a'.repeat(64), offset: 3, path: ['actions']})).toString(
      'base64url',
    );
  for (const continuation of [flipped, forged, 'not-a-token', '!!', 'A'.repeat(3000), '', 7, {}, []]) {
    const out = await call(v2, 'meta_native_action', {...next, continuation});
    assertRefused(out, 'INVALID_CURSOR');
  }
  // A continuation of a call that reads nothing: refused before anything runs.
  assertRefused(
    await call(v2, 'meta_native_action', {action: 'no_such_action', continuation: token}),
    'INVALID_CURSOR',
  );
});

test('a continuation survives a token refresh: it is bound to the AI client and the person, not to the access token', async t => {
  const s = await stack(t),
    args = {action: 'LIST_ACTIONS', limit: 500},
    first = await call(await s.client('modern', s.newer.access), 'meta_native_action', args),
    next = first.meta.budget.next_call.arguments;
  const refreshed = await s.newer.refresh(),
    // The first token is no longer the only credential of the client: the refresh issued another, and either may continue.
    again = await s.client('modern', refreshed),
    second = await call(again, 'meta_native_action', next);
  assert.equal(second.success, true, JSON.stringify(second.error));
  assert.equal(second.meta.budget.rows_before, first.meta.budget.rows_returned);
  // And the other client's refresh does not make that client the first's.
  assertRefused(
    await call(await s.client('modern', await s.other.refresh()), 'meta_native_action', next),
    'INVALID_CURSOR',
  );
});

test('the binding is the tenant, the AI client, the person, the access set, the tool and the arguments, and never the credential', () => {
  const base = {tenantId: 'workspace', userId: 'oauth/client-1', role: 'operator', ownerUserId: 'person-1'},
    request = args => budgetRequest(args);
  const bind = (actor, tool = 'meta_native_action', args = {action: 'LIST_ACTIONS'}) =>
    budgetBinding(actor, tool, request(args));
  const reference = bind(base);
  assert.match(reference, /^[0-9a-f]{64}$/);
  // The same client and person with another token, another role after a narrower refresh, or a session: the same binding.
  assert.equal(bind({...base, role: 'reader'}), reference);
  assert.equal(bind({...base, accountVersion: 3, signedInAt: 5, mfaVerified: true}), reference);
  // Anyone or anything else is another binding.
  for (const [what, binding] of [
    ['tenant', bind({...base, tenantId: 'another-workspace'})],
    ['client', bind({...base, userId: 'oauth/client-2'})],
    ['person', bind({...base, ownerUserId: 'person-2'})],
    ['no person', bind({tenantId: 'workspace', userId: 'oauth/client-1', role: 'operator'})],
    ['access set', bind({...base, accessSetId: 'set-1'})],
    ['tool', bind(base, 'tiktok_native_action')],
    ['argument', bind(base, undefined, {action: 'LIST_ACTIONS', limit: 5})],
    ['budget', bind(base, undefined, {action: 'LIST_ACTIONS', max_bytes: 5000})],
  ])
    assert.notEqual(binding, reference, what);
  // The argument order is not part of it, nor is the continuation itself.
  assert.equal(
    bind(base, undefined, {limit: 5, action: 'LIST_ACTIONS'}),
    bind(base, undefined, {action: 'LIST_ACTIONS', limit: 5}),
  );
  assert.equal(bind(base, undefined, {action: 'LIST_ACTIONS', continuation: 'x'}), reference);
  // The same person through another AI client, and the same AI client for another person, are told apart: the person is the
  // approving account, never the credential or the client alone.
  assert.notEqual(bind({...base, userId: 'oauth/client-9'}), bind({...base, ownerUserId: 'person-9'}));
});

// ---- the other list paths ----

const admin = {tenantId: 'local', userId: 'budget-admin', role: 'admin'};
/** A Meta login of the workspace the AI clients belong to, and a provider that answers its campaigns in pages of `rows`. */
function metaCampaigns(s, {accounts = ['123']} = {}) {
  s.store.putConnection(
    admin,
    {
      id: 'meta-login',
      tenantId: 'local',
      gateway: 'meta_native_action',
      accounts,
      writeAccounts: [],
      label: 'Synthetic Meta',
      enabled: true,
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
}
const campaign = i => ({
  id: String(7000000 + i),
  name: 'Campaign ' + i + ' ' + 'spring-launch-'.repeat(8),
  status: 'PAUSED',
  objective: 'OUTCOME_TRAFFIC',
  daily_budget: '5000',
});
/** The provider's answer: three pages of 400 campaigns, each naming the next by its cursor. */
const campaignPages = async (input, init) => {
  const url = new URL(String(input));
  if ((init?.method ?? 'GET') !== 'GET' || !url.pathname.endsWith('/campaigns'))
    return Response.json({id: 'act_123', account_status: 1, currency: 'USD', name: 'Account'});
  const page = Number(url.searchParams.get('after') ?? 0);
  return Response.json({
    data: Array.from({length: 400}, (_, i) => campaign(page * 400 + i)),
    paging:
      page < 2
        ? {cursors: {after: String(page + 1)}, next: url.origin + url.pathname + '?after=' + (page + 1)}
        : {cursors: {after: '3'}},
  });
};

for (const era of eras)
  test(`${era} HTTP: a provider read that returns a long page is cut, and followed to the same rows`, async t => {
    const s = await stack(t, {fetcher: campaignPages});
    metaCampaigns(s);
    const {legacy} = await exercise(
      s,
      era,
      'meta_native_action',
      {action: 'meta_campaign_list', account_id: '123'},
      {minPieces: 2},
    );
    assert.equal(at(legacy, 'data.data.data').length, 400);
  });

for (const era of eras)
  test(`${era} HTTP: a capped read of the provider's pages is cut, and the last piece names the provider's next page again`, async t => {
    const s = await stack(t, {fetcher: campaignPages});
    metaCampaigns(s);
    const args = {action: 'meta_campaign_list', account_id: '123', paginate: true, max_pages: 2},
      {legacy, pieces} = await exercise(s, era, 'meta_native_action', args);
    // The result stops at two of three pages and names the third; the pieces do not, until the last: then it is that call.
    assert.equal(at(legacy, 'data.data.data').length, 800);
    assert.equal(legacy.data.next_call.tool, 'meta_native_action');
    assert.deepEqual(pieces.at(-1).data.next_call, legacy.data.next_call);
    for (const piece of pieces.slice(0, -1)) {
      assert.notDeepEqual(piece.data.next_call, legacy.data.next_call);
      assert.deepEqual(piece.data.next_call, piece.meta.budget.next_call);
    }
  });

test('a provider read that follows its own pages is one list: the pieces are the rows of every page', async t => {
  const s = await stack(t, {fetcher: campaignPages});
  metaCampaigns(s);
  const {legacy, pieces} = await exercise(s, 'modern', 'meta_native_action', {
    action: 'meta_campaign_list',
    account_id: '123',
    paginate: true,
    max_pages: 3,
  });
  assert.equal(at(legacy, 'data.data.data').length, 1200);
  assert.equal(pieces.flatMap(piece => at(piece, 'data.data.data')).length, 1200);
});

for (const era of eras)
  test(`${era} HTTP: the list of accounts, a plain array, is cut and followed through meta.budget alone`, async t => {
    const s = await stack(t);
    metaCampaigns(s, {accounts: Array.from({length: 800}, (_, i) => String(100000 + i))});
    const {first, pieces} = await exercise(s, era, 'amcp_platform_workspace', {
      operation: 'list_accounts',
      arguments: {},
    });
    // There is nowhere in a plain array to put a continuation: it is in meta.budget, and data is only rows.
    assert.ok(Array.isArray(first.data));
    for (const piece of pieces) assert.ok(piece.data.every(row => typeof row.id === 'string'));
  });

// ---- AMCP's own lists: offset paging, cursor paging, the media library and a saved report's rows ----

for (const era of eras)
  test(`${era} HTTP: an AMCP list with offset paging (the contract inventory) is cut and followed to the same rows`, async t => {
    const s = await stack(t),
      {legacy, pieces} = await exercise(
        s,
        era,
        'amcp_workspace',
        {action: 'contracts', gateway: 'meta_native_action', limit: 100},
        {minPieces: 2},
      );
    // The inventory is longer than the page: the answer says so, and the last piece says the same.
    assert.equal(legacy.data.has_more, true);
    assert.equal(legacy.data.next_offset, 100);
    assert.equal(pieces.at(-1).data.next_offset, 100);
    for (const piece of pieces.slice(0, -1)) assert.equal(piece.data.next_offset, null);
  });

for (const era of eras)
  test(`${era} HTTP: an AMCP list with cursor paging (the capabilities) is cut at the budget the caller asks for, and followed`, async t => {
    const s = await stack(t),
      {legacy, pieces} = await exercise(
        s,
        era,
        'amcp_workspace',
        {action: 'capabilities'},
        {maxBytes: 8192, minPieces: 3, ignore: ['captured_at', 'next_cursor', 'next_call']},
      );
    assert.equal(legacy.data.has_more, true);
    assert.equal(typeof legacy.data.next_cursor, 'string');
    // A piece's cursor is emptied (the continuation is the way forward), and the last piece has the capabilities' own paging again:
    // a cursor issued to the client that asked, and the call that reads the next page with it.
    for (const piece of pieces.slice(0, -1)) {
      assert.equal(piece.data.next_cursor, null);
      assert.equal(piece.data.has_more, true);
    }
    const own = pieces.at(-1).data;
    assert.equal(typeof own.next_cursor, 'string');
    assert.deepEqual(own.next_call, {
      ...legacy.data.next_call,
      arguments: {...legacy.data.next_call.arguments, cursor: own.next_cursor},
    });
  });

/** A hundred uploaded media receipts of the Meta login, the workspace's media library. */
function mediaLibrary(s, count = 100) {
  metaCampaigns(s, {accounts: ['123']});
  for (let i = 0; i < count; i++)
    s.store.putDocument('local', 'workspace_asset', 'asset-' + String(i).padStart(3, '0'), {
      platform: 'meta',
      connection_id: 'meta-login',
      account_id: '123',
      name: 'Launch image ' + i + ' ' + 'spring-launch-'.repeat(75),
      media_type: 'image',
      mime_type: 'image/png',
      size_bytes: 1000 + i,
      ready: true,
    });
}

for (const era of eras)
  test(`${era} HTTP: the media library list is cut and followed (a list that holds other lists beside it)`, async t => {
    const s = await stack(t);
    mediaLibrary(s);
    const {legacy, first, pieces} = await exercise(s, era, 'amcp_media', {action: 'list', limit: 60}, {minPieces: 2});
    // The library's rows are the largest list of the answer; the others (recovery, variants, presets, sources) stay as they were.
    assert.equal(first.meta.budget.path, 'data.assets');
    assert.equal(legacy.data.total, 100);
    assert.deepEqual(
      pieces.flatMap(piece => piece.data.assets.map(asset => asset.name)),
      legacy.data.assets.map(asset => asset.name),
    );
    for (const piece of pieces) assert.deepEqual(piece.data.presets, legacy.data.presets);
    // The page is 60 of the 100 receipts and names the offset of the rest; the pieces name it only at the last.
    assert.deepEqual([legacy.data.has_more, legacy.data.next_offset], [true, 60]);
    assert.equal(pieces.at(-1).data.next_offset, 60);
    for (const piece of pieces.slice(0, -1)) assert.equal(piece.data.next_offset, null);
  });

const overviewAdmin = {tenantId: 'local', userId: 'budget-admin', role: 'admin'};
/** A finished overview snapshot of `count` campaigns in the workspace the AI clients belong to: the real definition, queue, worker and row assembly over a fake collector. */
async function snapshot(s, count) {
  s.store.putConnection(
    overviewAdmin,
    {
      id: 'report-login',
      tenantId: 'local',
      gateway: 'meta_native_action',
      accounts: ['100'],
      writeAccounts: [],
      enabled: true,
      scopes: [],
      label: 'Synthetic report login',
    },
    {accessToken: 'synthetic'},
  );
  const refusedFetch = async () => {
      throw new Error('No provider traffic allowed');
    },
    overview = new ReportingOverview(s.service, refusedFetch);
  overview.native.collect = async (source, dates) => ({
    source,
    rows: Array.from({length: count}, (_, i) =>
      row(
        'campaign',
        'c' + i,
        {spend: String(i + 1)},
        {campaign_name: 'Campaign ' + i + ' ' + 'spring-launch-'.repeat(6)},
      ),
    ),
    currency: 'USD',
    timezone: 'UTC',
    complete: true,
    collection_complete: true,
    source_kind: 'ads',
    date_range: dates,
    warnings: [],
    lineage: [],
    captured_at: Date.now(),
    result_definition: 'Synthetic results',
    attribution: 'Synthetic click window',
    quality: {version: 2, status: 'complete'},
  });
  overview.native.verifyAccount = async () => undefined;
  const worker = new ReportWorker(
      s.store,
      async () => ({}),
      (tenant, kind, input) => overview.work(tenant, kind, input),
    ),
    queued = await overview.handle(
      {
        action: 'run',
        confirmed: true,
        config: {
          name: 'Synthetic budget report',
          contract_version: 'overview-config-v4',
          sources: [
            {
              platform: 'meta',
              account_id: '100',
              connection_id: 'report-login',
              levels: ['campaign'],
              report_options: {complete_window: true},
            },
          ],
          metrics: ['spend', 'impressions', 'clicks', 'cpc', 'cpm', 'primary_result', 'cost_per_result'],
          date_range: range,
        },
      },
      overviewAdmin,
    );
  await worker.once();
  return queued.id;
}

for (const era of eras)
  test(`${era} HTTP: a saved report's rows are cut and followed, read unfiltered (offset) and filtered (cursor)`, async t => {
    const s = await stack(t),
      id = await snapshot(s, 620);
    // Unfiltered: the page is 500 of the 620 rows and names the offset of the rest.
    const unfiltered = await exercise(s, era, 'amcp_reporting_overview', {action: 'get', id, limit: 500});
    assert.equal(unfiltered.first.meta.budget.path, 'data.rows');
    assert.equal(unfiltered.legacy.data.rows.length, 500);
    assert.equal(unfiltered.legacy.data.row_count, 620);
    assert.equal(unfiltered.legacy.data.next_offset, 500);
    assert.equal(
      unfiltered.pieces.at(-1).data.next_offset,
      500,
      'the last piece names the rest of the report, as the answer does',
    );
    for (const piece of unfiltered.pieces.slice(0, -1)) assert.equal(piece.data.next_offset, null);
    // Filtered: the same page, continued by a cursor bound to the caller and the arguments; a piece's cursor and next_call are
    // emptied or replaced, and the last has the report's own, which still reads the rest.
    const filtered = await exercise(
      s,
      era,
      'amcp_reporting_overview',
      {action: 'get', id, limit: 500, level: 'campaign'},
      {ignore: ['next_cursor', 'next_call']},
    );
    assert.equal(filtered.first.meta.budget.path, 'data.rows');
    assert.equal(typeof filtered.legacy.data.next_cursor, 'string');
    assert.equal(filtered.legacy.data.next_offset, null);
    for (const piece of filtered.pieces.slice(0, -1)) assert.equal(piece.data.next_cursor, null);
    // The cursor of the last piece is the v2 client's own (a cursor belongs to the client it was issued to), and its next_call is
    // the answer's, with that cursor.
    const own = filtered.pieces.at(-1).data;
    assert.equal(typeof own.next_cursor, 'string');
    assert.notEqual(own.next_cursor, filtered.legacy.data.next_cursor);
    assert.deepEqual(own.next_call, {
      ...filtered.legacy.data.next_call,
      arguments: {...filtered.legacy.data.next_call.arguments, cursor: own.next_cursor},
    });
    // That own next_call is a call the v2 client can make: its rows are the rest of the report, cut and followed in turn.
    const v2 = await s.client(era, s.newer.access),
      rest = await call(v2, 'amcp_reporting_overview', own.next_call.arguments);
    assert.equal(rest.success, true, JSON.stringify(rest.error));
    const restPieces = await follow(v2, 'amcp_reporting_overview', rest),
      rows = [...filtered.pieces, ...restPieces]
        .flatMap(piece => piece.data.rows)
        .map(r => r.campaign_id ?? r.entity_id);
    assert.equal(rows.length, 620);
    assert.equal(new Set(rows).size, 620, 'every campaign once');
  });

test('only a call that reads is cut, and a continuation of one that does not is refused before anything runs', async t => {
  const s = await stack(t);
  metaCampaigns(s);
  const v2 = await s.client('modern', s.newer.access);
  const token = (await call(v2, 'meta_native_action', {action: 'LIST_ACTIONS', limit: 500})).meta.budget.next_call
    .arguments.continuation;
  let ran = 0;
  const run = s.service.call.bind(s.service);
  s.service.call = (...rest) => (ran++, run(...rest));
  // A call that saves something takes no continuation: it is refused before it runs, once or twice, never re-run.
  for (const args of [
    {action: 'save_profile', continuation: token},
    {action: 'check', continuation: token, max_bytes: 5000},
  ]) {
    assertRefused(await call(v2, 'amcp_workspace', args), 'INVALID_CURSOR');
    assert.equal(ran, 0, 'the call did not run');
  }
  // max_bytes is this layer's, not the tool's: a call that does not read runs without it, exactly as it would have.
  const budget = {max_bytes: 5000},
    plain = await call(v2, 'amcp_workspace', {action: 'save_profile'}),
    asked = await call(v2, 'amcp_workspace', {action: 'save_profile', ...budget});
  assert.equal(ran, 2);
  assert.equal(typeof plain.error.code, 'string');
  assert.notEqual(plain.error.code, 'INVALID_CURSOR');
  assert.deepEqual(asked.error, plain.error);
  assert.equal(asked.meta.budget, undefined);
});
test('a legacy client is answered whole, and for it max_bytes and continuation are arguments like any other', async t => {
  const s = await stack(t, {fetcher: campaignPages});
  metaCampaigns(s);
  const legacy = await s.client('modern', s.older.access),
    v2 = await s.client('modern', s.newer.access),
    list = {action: 'meta_campaign_list', account_id: '123'},
    whole = await call(legacy, 'meta_native_action', list);
  assert.equal(whole.meta.budget, undefined);
  assert.ok(bytes(whole) > defaultBudgetBytes);
  // Sent to a native gateway they are unrecognised parameters, refused as before; a v2 client's layer takes them out first.
  for (const extra of [{max_bytes: 5000}, {continuation: 'x'}]) {
    assertRefused(await call(legacy, 'meta_native_action', {...list, ...extra}), 'UNSUPPORTED_PARAMETER');
    assert.equal((await call(v2, 'meta_native_action', {...list, max_bytes: 5000})).success, true);
  }
  assertRefused(await call(v2, 'meta_native_action', {...list, continuation: 'x'}), 'INVALID_CURSOR');
});

test('a call is a read when the contracts say it only reads: the budget cuts nothing else and runs nothing twice', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 29).toString('base64')),
    service = new MirrorService(new Registry(), store, new NativeTransport(async () => Response.json({})), undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  try {
    const reads = [
      ['meta_native_action', {action: 'meta_campaign_list', account_id: '1'}],
      ['meta_native_action', {action: 'LIST_ACTIONS', limit: 500}],
      ['meta_native_action', {action: 'DESCRIBE_ACTION', target_action: 'meta_campaign_list'}],
      ['google_ads_native_action', {action: 'LIST_ACTIONS'}],
      ['amcp_platform_workspace', {operation: 'list_accounts', arguments: {}}],
      ['amcp_workspace', {action: 'history'}],
      ['amcp_workspace', {action: 'dashboard'}],
      ['amcp_workspace', {action: 'capabilities'}],
      // The plan read the summary below is answered whole beside: get is cut as any read is.
      ['amcp_campaign', {action: 'get', id: 'x'}],
      ['amcp_reporting_overview', {action: 'get', id: 'x'}],
      ['amcp_reporting_overview', {action: 'list'}],
      ['amcp_media', {action: 'list'}],
      ['amcp_ad_previews', {platform: 'meta', account_id: '1'}],
      // A native change is previewed or refused by its gateway and never sent (amcp_write is the change path), so it reads.
      ['meta_native_action', {action: 'meta_campaign_create', account_id: '1'}],
    ];
    const notReads = [
      ['amcp_workspace', {action: 'save_profile'}],
      ['amcp_workspace', {action: 'check'}],
      ['amcp_workspace', {action: 'delete_profile'}],
      ['amcp_write', {action: 'prepare'}],
      ['amcp_write', {action: 'execute'}],
      ['amcp_campaign', {action: 'create'}],
      // R2.5 field3 (r25-field3-approvals, AMCP-07): the approval summary only reads, but it is what a person is shown to approve, so no budget
      // cuts it into pieces: it is answered whole at any max_bytes, and a continuation is refused for it as for a change.
      ['amcp_campaign', {action: 'approval_summary', id: 'x'}],
      ['amcp_media', {action: 'prepare'}],
      ['amcp_reporting_overview', {action: 'run'}],
      ['amcp_reporting_overview', {action: 'save'}],
      ['amcp_reporting', {action: 'capture'}],
      // The workflow gateway's operations that save, the measurement gateways that disconnect, Microsoft's report job.
      ['amcp_native_action', {operation: 'create_reporting_query', arguments: {}}],
      ['ga4_native_action', {operation: 'ga4_connection_ops', arguments: {action: 'disconnect'}}],
      ['microsoft_ads_native_action', {operation: 'SubmitGenerateReport', arguments: {}}],
      // Not a tool, not an action, not an operation: nothing is known of it, so it is never cut or re-run.
      ['no_such_tool', {action: 'list'}],
      ['amcp_workspace', {action: 'no_such_action'}],
      ['meta_native_action', {}],
      ['meta_native_action', {action: 'no_such_action'}],
    ];
    for (const [tool, args] of reads)
      assert.equal(callIsRead(service, tool, args), true, tool + ' ' + JSON.stringify(args));
    for (const [tool, args] of notReads)
      assert.equal(callIsRead(service, tool, args), false, tool + ' ' + JSON.stringify(args));
  } finally {
    store.close();
  }
});
