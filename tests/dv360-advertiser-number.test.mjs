// Package r25-m0-live, the lead's review of 2026-11-15, S3-2: item 4 (error 11 of the live checks) extended to DV360. An agent that
// types an ID as JSON writes the advertiser as a number: advertiserId 123 for the selected advertiser "123". DV360's typed
// write contracts compared the body's advertiserId with the selected advertiser by `!==`, so the number was refused as
// ACCOUNT_SCOPE_MISMATCH with the grant remedy ("Check the selected workspace, connection, account and per-account write
// grant"), although it names the selected advertiser and no grant is involved. The number of the selected advertiser's digits
// is now the same advertiser: it is sent as the string DV360's JSON takes, before any review is frozen (the DV360 compile hook,
// src/dv360-adapter.ts, asks `sameNativeAccount` of src/account-id.ts, as Microsoft's compile does). An ID that is another
// advertiser, and a value that is no ID, are still refused; a refusal of an advertiserId the request names that is not the
// selected advertiser says that the request is at fault (`account_conflict`), and the ownership refusal of an algorithm that
// another advertiser owns stays a grant matter. All IDs below are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorError, errorRemedy, errorResult} from '../dist/src/errors.js';
import {assertDV360Bidding, dv360BiddingPrerequisites} from '../dist/src/dv360-custom-bidding.js';
import {assertDV360Sdf} from '../dist/src/dv360-sdf-downloads.js';
import {assertDV360InventoryGroup} from '../dist/src/dv360-inventory-source-groups.js';
import {assertDV360AudienceEdit} from '../dist/src/dv360-audience-edits.js';
import {assertDV360BiddingFile} from '../dist/src/dv360-custom-bidding-files.js';
import {validateDV360TargetingSearch} from '../dist/src/dv360-targeting-search.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const gateway = 'dv360_native_action',
  registry = new Registry(),
  C = 'DV360_CUSTOM_BIDDING_ALGORITHMS_',
  account = '123',
  strict = {mode: 'strict', flags: {}};
const compile = input => new Compiler(registry).compile(gateway, input, strict);
const algorithm = {displayName: 'Store visits model', customBiddingAlgorithmType: 'SCRIPT_BASED'};

// ---- The compile step: where the number becomes the string ----

test('an advertiserId written as the number of the selected advertiser is sent as the string, in the body and in the query', () => {
  for (const value of [Number(account), account]) {
    const plan = compile({action: C + 'CREATE', params: {}, body: {advertiserId: value, ...algorithm}});
    assert.equal(plan.body.advertiserId, account, JSON.stringify(value));
    assert.equal(typeof plan.body.advertiserId, 'string');
    assert.equal(plan.accountId, account);
  }
  // The query of a read, and of a write that names the advertiser there.
  for (const value of [Number(account), account]) {
    const read = compile({action: C + 'GET', params: {advertiserId: value, customBiddingAlgorithmId: '801'}});
    assert.equal(read.query.advertiserId, account, JSON.stringify(value));
    assert.equal(typeof read.query.advertiserId, 'string');
  }
  // The call's other fields are untouched.
  const plan = compile({action: C + 'CREATE', params: {}, body: {advertiserId: Number(account), ...algorithm}});
  assert.deepEqual(plan.body, {advertiserId: account, ...algorithm});
});

test('an advertiserId that is another advertiser, or no ID, is not made the selected one', () => {
  // The selected advertiser is named at the top of the call; the body names another, in any form: refused by the shared alias
  // check as a fault of the request.
  const selected = body => ({action: C + 'CREATE', advertiserId: account, params: {}, body: {...body, ...algorithm}});
  for (const other of [
    124,
    '124',
    9007199254740991,
    -123,
    '0123',
    ' ' + account,
    'act_' + account,
    account + '.0',
    '',
    true,
    {},
  ])
    assert.throws(
      () => compile(selected({advertiserId: other})),
      error => {
        assertRefused(error, 'ACCOUNT_SCOPE_MISMATCH', {status: 403, message: /^Conflicting account identifiers/});
        assert.equal(error.details.account_conflict, true);
        return true;
      },
      JSON.stringify(other),
    );
  // A number that is not a safe integer has lost digits and names no ID, a fraction is no ID: the guard of every call refuses them.
  for (const value of [1.5, 9007199254740993])
    assert.throws(
      () => compile(selected({advertiserId: value})),
      error => assertRefused(error, 'UNSAFE_NUMERIC_ID'),
      String(value),
    );
  // A list of the digits reads as the account to the shared check (a list is joined to text); it is not rewritten, so the
  // contract of the write still refuses it, as a conflict.
  const listed = compile(selected({advertiserId: [Number(account)]}));
  assert.deepEqual(listed.body.advertiserId, [Number(account)]);
  conflictFlagged(() => assertDV360Bidding(listed), 'a list');
});

// ---- The real call path ----

function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 74).toString('base64')),
    actor = {tenantId: 'synthetic-dv360-advertiser', userId: 'operator', role: 'admin'},
    sent = [];
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: 'dv360',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic DV360',
      scopes: ['https://www.googleapis.com/auth/display-video'],
    },
    {accessToken: 'synthetic'},
  );
  const algorithms = new Map();
  let next = 900;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (url, init) => {
      const u = new URL(String(url)),
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({method: init.method, path: u.pathname, raw: init.body === undefined ? undefined : String(init.body)});
      if (init.method === 'GET') {
        if (u.pathname === '/v4/advertisers/' + account)
          return Response.json({name: 'advertisers/' + account, advertiserId: account, partnerId: '1'});
        const m = /^\/v4\/customBiddingAlgorithms\/(\d+)$/.exec(u.pathname);
        if (m && algorithms.has(m[1])) return Response.json(algorithms.get(m[1]));
        return Response.json({error: {code: 404, status: 'NOT_FOUND', message: 'Not found.'}}, {status: 404});
      }
      const id = String(next++),
        created = {
          name: 'customBiddingAlgorithms/' + id,
          customBiddingAlgorithmId: id,
          entityStatus: 'ENTITY_STATUS_ACTIVE',
          ...body,
        };
      algorithms.set(id, created);
      return Response.json(created);
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const prepare = body =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action: C + 'CREATE', params: {}, body}},
      actor,
    );
  const execute = prepared =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: prepared.data.review_id,
        idempotency_key: prepared.data.idempotency_key,
        confirmed: true,
      },
      actor,
    );
  return {sent, prepare, execute, writes: () => sent.filter(request => request.method === 'POST')};
}

test('a prepared write that names the advertiser as a number is reviewed and sent with the string', async t => {
  const f = fixture(t),
    prepared = await f.prepare({advertiserId: Number(account), ...algorithm});
  assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 600));
  const executed = await f.execute(prepared);
  assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 600));
  const [write] = f.writes();
  assert.ok(write, 'the create was sent');
  assert.equal(JSON.parse(write.raw).advertiserId, account);
  assert.match(write.raw, new RegExp('"advertiserId":"' + account + '"'), 'a JSON string on the wire');
});

test('a prepare that names another advertiser or no ID is still refused, and nothing is written', async t => {
  const f = fixture(t);
  // Another advertiser, as a number or a string, is one this connection does not grant: a grant matter, refused before any
  // contract is read. A value that is no ID is refused by the contract as a fault of the request, in the request's own words.
  for (const [value, code] of [
    [124, 'CONNECTION_REQUIRED'],
    ['124', 'CONNECTION_REQUIRED'],
    [[Number(account)], 'ACCOUNT_SCOPE_MISMATCH'],
    [true, 'ACCOUNT_SCOPE_MISMATCH'],
    [{}, 'ACCOUNT_SCOPE_MISMATCH'],
    ['0123', 'ACCOUNT_SCOPE_MISMATCH'],
    [-123, 'ACCOUNT_SCOPE_MISMATCH'],
    ['act_' + account, 'ACCOUNT_SCOPE_MISMATCH'],
    [' ' + account, 'ACCOUNT_SCOPE_MISMATCH'],
    ['', 'ACCOUNT_SCOPE_MISMATCH'],
  ]) {
    const refused = await f.prepare({advertiserId: value, ...algorithm});
    assertRefused(refused, code);
    // An empty string names no advertiser, so it is no conflict: its refusal keeps its grant remedy rather than say "leave it out".
    if (code === 'ACCOUNT_SCOPE_MISMATCH')
      assert.equal(refused.error.category, value === '' ? 'grant' : 'request', JSON.stringify(value));
  }
  assert.equal(f.writes().length, 0, 'nothing was written');
});

// ---- The refusals of a request that names another advertiser ----

const conflictFlagged = (fn, label) =>
  assert.throws(
    fn,
    error => {
      assertRefused(error, 'ACCOUNT_SCOPE_MISMATCH', {status: 403});
      assert.equal(error.details.account_conflict, true, label + ' flags a conflict');
      const sent = errorResult(error, 'request-1', 1).error;
      assert.equal(sent.category, 'request', label);
      assert.match(sent.remedy.action, /^Nothing was sent, and no permission needs to change\./, label);
      return true;
    },
    label,
  );
const base = {gateway, headers: {}, query: {}, accountId: account};
const plans = {
  'custom bidding (body)': {
    ...base,
    method: 'POST',
    path: '/v4/customBiddingAlgorithms',
    body: {advertiserId: '124', ...algorithm},
  },
  'SDF download (body)': {
    ...base,
    method: 'POST',
    path: '/v4/sdfdownloadtasks',
    body: {version: 'SDF_VERSION_9', advertiserId: '124', idFilter: {lineItemIds: ['5']}},
  },
  'inventory source group, bulk edit (body)': {
    ...base,
    method: 'POST',
    path: '/v4/inventorySourceGroups/7/assignedInventorySources:bulkEdit',
    body: {advertiserId: '124', createdAssignedInventorySources: [{inventorySourceId: '8'}]},
  },
  'inventory source group, create (query)': {
    ...base,
    method: 'POST',
    path: '/v4/inventorySourceGroups',
    query: {advertiserId: '124'},
    body: {displayName: 'Group'},
  },
  'audience edit (query)': {
    ...base,
    method: 'PATCH',
    path: '/v4/firstPartyAndPartnerAudiences/5',
    query: {advertiserId: '124', updateMask: 'displayName'},
    body: {displayName: 'Audience'},
  },
  'custom bidding file (query)': {
    ...base,
    method: 'POST',
    path: '/v4/customBiddingAlgorithms/801/scripts',
    query: {advertiserId: '124'},
    body: {script: {resourceName: 'customBiddingAlgorithms/801/scriptRef/abc'}},
  },
  'targeting search (body)': {
    ...base,
    method: 'POST',
    path: '/v4/targetingTypes/TARGETING_TYPE_GEO_REGION/targetingOptions:search',
    body: {advertiserId: '124', geoRegionSearchTerms: {geoRegionQuery: 'Riyadh'}},
  },
};
const validators = {
  'custom bidding (body)': assertDV360Bidding,
  'SDF download (body)': assertDV360Sdf,
  'inventory source group, bulk edit (body)': assertDV360InventoryGroup,
  'inventory source group, create (query)': assertDV360InventoryGroup,
  'audience edit (query)': assertDV360AudienceEdit,
  'custom bidding file (query)': assertDV360BiddingFile,
  'targeting search (body)': validateDV360TargetingSearch,
};

test('every DV360 contract that compares the request’s advertiserId with the selected one says the request is at fault when it differs', () => {
  for (const [label, plan] of Object.entries(plans))
    conflictFlagged(() => validators[label](structuredClone(plan)), label);
});

test('a request that names no advertiser is not called a conflict, and a different owner is still a grant matter', () => {
  // Missing is not different: no flag, so the remedy never says "leave it out: AMCP fills it" where AMCP would not.
  const missing = structuredClone(plans['custom bidding (body)']);
  delete missing.body.advertiserId;
  assert.throws(
    () => assertDV360Bidding(missing),
    error => {
      assertRefused(error, 'ACCOUNT_SCOPE_MISMATCH', {status: 403});
      assert.equal(Object.hasOwn(error.details, 'account_conflict'), false);
      return true;
    },
  );
  // An algorithm that another advertiser owns (a state read, not the request): the grant remedy stays.
  const patch = {
    ...base,
    method: 'PATCH',
    path: '/v4/customBiddingAlgorithms/801',
    query: {updateMask: 'displayName'},
    body: {advertiserId: account, displayName: 'Renamed'},
  };
  assert.throws(
    () => dv360BiddingPrerequisites(patch, [{advertiser: {}, algorithm: {present: true, advertiserId: '999'}}]),
    error => {
      assertRefused(error, 'ACCOUNT_SCOPE_MISMATCH', {status: 403});
      assert.equal(Object.hasOwn(error.details, 'account_conflict'), false);
      assert.equal(errorRemedy(error).category, 'grant');
      return true;
    },
  );
});
