// CMP-03 (owner decision P7): Microsoft campaign location criteria. Without location targets Microsoft can serve a
// campaign in any location it supports. Before this family AMCP had no campaign-criterion contract: the Microsoft Search
// pack set no geography and every campaign activation was refused outright. These tests drive the reviewed lifecycle
// against a synthetic Microsoft provider (no network): positive LocationCriterion rows only, on a paused campaign of the
// account, read back by ID, never resent after an uncertain outcome; and UpdateCampaigns Status Active now reads the
// campaign's location criteria and is refused only when none is positive.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {compileMicrosoft, assertMicrosoftWrite, microsoftScope} from '../src/microsoft-native.js';
import {
  locationCriteriaPayload,
  microsoftCriterionOutcome,
  microsoftCriterionSnapshots,
  positiveLocation,
} from '../src/microsoft-campaign-criteria.js';
import {wireContractCheck} from '../src/wire-contracts.js';
import {errorRemedy, MirrorError} from '../src/errors.js';
import type {JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';

const gateway = 'microsoft_ads_native_action',
  actor = {tenantId: 't', userId: 'owner', role: 'admin' as const};
const location = (LocationId: string, CampaignId = '501') => ({
  Type: 'BiddableCampaignCriterion',
  CampaignId,
  Criterion: {Type: 'LocationCriterion', LocationId},
});
const add = (ids = ['190', '32'], CampaignId = '501') => ({
  action: 'AddCampaignCriterions',
  account_id: '123',
  payload: {CriterionType: 'Targets', CampaignCriterions: ids.map(id => location(id, CampaignId))},
});
const activate = (Id = '501') => ({
  action: 'UpdateCampaigns',
  account_id: '123',
  payload: {Campaigns: [{Id, Status: 'Active'}]},
});

/** A synthetic Microsoft account: campaign 501 (paused), its criteria, and the requests it received. */
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
  store.putConnection(
    actor,
    {
      id: 'ms',
      tenantId: 't',
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      accountCustomers: {'123': '456'},
      scopes: [microsoftScope],
      enabled: true,
      label: 'Synthetic',
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const state = {
    campaigns: new Map<string, JsonObject>([
      ['501', {Id: '501', Name: 'Synthetic', Status: 'Paused', CampaignType: 'Search', DailyBudget: 25}],
    ]),
    criteria: new Map<string, JsonObject>(),
    next: 9000,
    writes: [] as {method: string; path: string; body: JsonObject}[],
    lost: false,
    nested: false,
    mismatch: false,
    nullWhenEmpty: false,
  };
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const path = new URL(String(url)).pathname,
        method = String(init?.method ?? 'GET'),
        b = JSON.parse(String(init?.body ?? '{}'));
      assert.equal(new Headers(init?.headers).get('CustomerAccountId'), '123');
      if (path.endsWith('/Account/Query')) return Response.json({Account: {Id: '123'}});
      if (path.endsWith('/Campaigns/QueryByIds'))
        return Response.json({
          Campaigns: b.CampaignIds.map((id: string) => structuredClone(state.campaigns.get(id) ?? null)),
        });
      if (path.endsWith('/CampaignCriterions/QueryByIds')) {
        assert.equal(b.CriterionType, 'Location', 'location criteria are read with CriterionType Location');
        const own = [...state.criteria.values()].filter(r => r.CampaignId === b.CampaignId);
        const rows =
          b.CampaignCriterionIds === null
            ? own
            : b.CampaignCriterionIds.map((id: string) => own.find(r => r.Id === id) ?? null);
        return Response.json({
          CampaignCriterions:
            state.nullWhenEmpty && !rows.length
              ? null
              : rows.map((r: JsonObject | null) =>
                  r && state.mismatch ? {...r, Criterion: {...r.Criterion, LocationId: '999'}} : structuredClone(r),
                ),
          PartialErrors: null,
        });
      }
      state.writes.push({method, path, body: b});
      if (path.endsWith('/Campaigns') && method === 'PUT') {
        for (const r of b.Campaigns) state.campaigns.set(r.Id, {...state.campaigns.get(r.Id), ...r});
        return Response.json({PartialErrors: null});
      }
      if (path.endsWith('/CampaignCriterions') && method === 'POST') {
        assert.equal(b.CriterionType, 'Targets');
        if (state.nested)
          return Response.json({
            CampaignCriterionIds: b.CampaignCriterions.map(() => null),
            NestedPartialErrors: [{Code: 1043, ErrorCode: 'Synthetic', Message: 'Synthetic refusal', Index: 0}],
          });
        const ids = b.CampaignCriterions.map((r: JsonObject) => {
          const Id = String(state.next++);
          state.criteria.set(Id, {
            ...r,
            Id,
            Status: 'Active',
            CriterionBid: {Type: 'BidMultiplier', Multiplier: 0},
            Criterion: {
              ...r.Criterion,
              DisplayName: 'Synthetic location ' + r.Criterion.LocationId,
              LocationType: 'Country',
            },
          });
          return Id;
        });
        if (state.lost) throw Error('Synthetic lost response');
        // Null entries are read as no error, as for PartialErrors; an empty list (as documented) says nothing failed.
        return Response.json({
          CampaignCriterionIds: ids,
          NestedPartialErrors: state.nullWhenEmpty ? ids.map(() => null) : [],
        });
      }
      if (path.endsWith('/CampaignCriterions') && method === 'DELETE') {
        for (const id of b.CampaignCriterionIds) state.criteria.delete(id);
        return Response.json({PartialErrors: null});
      }
      throw Error('Unexpected synthetic request ' + method + ' ' + path);
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  const prepare = (args: JsonObject) =>
    service.call('amcp_write', {action: 'prepare', gateway, connection_id: 'ms', arguments: args}, actor);
  const execute = (review: JsonObject, extra: JsonObject = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: review.data.review_id,
        idempotency_key: review.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = (review: JsonObject) =>
    service.call('amcp_campaign', {action: 'verify', review_id: review.data.review_id}, actor);
  const seed = (Id: string, row: JsonObject) => state.criteria.set(Id, {Id, Status: 'Active', ...row});
  return {store, service, state, prepare, execute, verify, seed};
}

test('CMP-03 the location-criterion contract: positive LocationCriterion rows of one campaign, CriterionType Targets, no bid', () => {
  const ok = compileMicrosoft(add());
  assert.equal(ok.path, '/CampaignManagement/v13/CampaignCriterions');
  assert.equal(ok.method, 'POST');
  assert.equal(ok.readOnly, false);
  assertMicrosoftWrite(ok);
  // The request is held to the REST page pinned from Microsoft Learn (method, URL, top-level fields).
  assert.equal(
    ok.contractEvidence?.rest?.page,
    'https://learn.microsoft.com/en-us/advertising/campaign-management-service/addcampaigncriterions?view=bingads-13',
  );
  const refused = (payload: JsonObject) =>
    assert.throws(
      () => assertMicrosoftWrite(compileMicrosoft({action: 'AddCampaignCriterions', account_id: '123', payload})),
      (e: MirrorError) => e.code === 'INVALID_MICROSOFT_REQUEST',
      JSON.stringify(payload),
    );
  const row = location('190');
  for (const r of [
    {...row, Type: 'NegativeCampaignCriterion'},
    {...row, Criterion: {Type: 'RadiusCriterion', LocationId: '190'}},
    {...row, Criterion: {Type: 'LocationIntentCriterion', IntentOption: 'PeopleIn'}},
    // Phase 1 sends no bid adjustment: a multiplier changes what is paid, and Microsoft applies 0 without one.
    {...row, CriterionBid: {Type: 'BidMultiplier', Multiplier: 20}},
    {...row, CriterionBid: {Type: 'BidMultiplier', Multiplier: 0}},
    {...row, Status: 'Paused'},
    {...row, Id: '9'},
    {...row, Criterion: {...row.Criterion, DisplayName: 'Somewhere'}},
    {...row, Criterion: {Type: 'LocationCriterion', LocationId: 190}},
    {...row, Criterion: {Type: 'LocationCriterion', LocationId: '0'}},
  ])
    refused({CriterionType: 'Targets', CampaignCriterions: [r]});
  refused({CriterionType: 'Location', CampaignCriterions: [row]});
  refused({CriterionType: 'Targets', CampaignCriterions: []});
  refused({CriterionType: 'Targets', CampaignCriterions: Array.from({length: 101}, (_, i) => location(String(i + 1)))});
  refused({CriterionType: 'Targets', CampaignCriterions: [row, location('32', '502')]});
  refused({CriterionType: 'Targets', CampaignCriterions: [row, row]});
  const remove = compileMicrosoft({
    action: 'DeleteCampaignCriterions',
    account_id: '123',
    payload: {CampaignId: '501', CriterionType: 'Targets', CampaignCriterionIds: ['9001']},
  });
  assert.equal(remove.destructive, true);
  assertMicrosoftWrite(remove);
  // The review reads the account, the exact parent campaign and its current location criteria.
  assert.deepEqual(
    microsoftCriterionSnapshots(ok).map(r => [r.action, r.body]),
    [
      ['GetAccount', {AccountId: '123'}],
      ['GetCampaignsByIds', {AccountId: '123', CampaignIds: ['501'], CampaignType: 'Search'}],
      ['GetCampaignCriterionsByIds', {CampaignId: '501', CriterionType: 'Location', CampaignCriterionIds: null}],
    ],
  );
  // A positive location is a biddable location criterion of that campaign; an exclusion or another campaign's is not.
  assert.equal(positiveLocation({...location('190'), Id: '1', Status: 'Active'}, '501'), true);
  assert.equal(positiveLocation({...location('190'), Criterion: {Type: 'Location', LocationId: '190'}}, '501'), true);
  assert.equal(positiveLocation({...location('190'), Type: 'NegativeCampaignCriterion'}, '501'), false);
  assert.equal(positiveLocation(location('190', '777'), '501'), false);
  // The add is confirmed only by an ID for every row and no nested error.
  const outcome = (data: JsonObject) => microsoftCriterionOutcome(ok, {status: 200, data});
  assert.equal(outcome({CampaignCriterionIds: ['1', '2'], NestedPartialErrors: []}), true);
  assert.equal(outcome({CampaignCriterionIds: ['1', '2'], NestedPartialErrors: null}), true);
  assert.equal(outcome({CampaignCriterionIds: ['1', null], NestedPartialErrors: [{Code: 1}]}), false);
  assert.equal(outcome({CampaignCriterionIds: ['1'], NestedPartialErrors: []}), false);
  assert.equal(outcome({CampaignCriterionIds: ['1', '1'], NestedPartialErrors: []}), false);
  assert.equal(outcome({CampaignCriterionIds: ['1', '2'], NestedPartialErrors: [null], PartialErrors: [{}]}), false);
});

test('CMP-03 the location-criterion requests conform to the pinned Campaign Management WSDL, and a field it lacks does not', () => {
  // The WSDL in .mirror/VENDOR (generated/microsoft-contracts.json) is the structural backstop of the family's exact
  // shape: every add, read and delete AMCP builds names only fields and types the WSDL defines.
  const check = (input: JsonObject) => wireContractCheck(compileMicrosoft(input), 'shadow');
  for (const input of [
    add(),
    {action: 'GetCampaignCriterionsByIds', account_id: '123', payload: locationCriteriaPayload('501')},
    {action: 'GetCampaignCriterionsByIds', account_id: '123', payload: locationCriteriaPayload('501', ['9001'])},
    {
      action: 'DeleteCampaignCriterions',
      account_id: '123',
      payload: {CampaignId: '501', CriterionType: 'Targets', CampaignCriterionIds: ['9001']},
    },
  ]) {
    const c = check(input);
    assert.equal(c?.status, 'conforms', JSON.stringify(c));
    assert.equal(c?.contract, 'microsoft-campaign-management-v13');
    assert.equal(c?.vendor_method, input.action);
  }
  const unknown = check({
    ...add(),
    payload: {
      CriterionType: 'Targets',
      CampaignCriterions: [{...location('190'), Criterion: {Type: 'LocationCriterion', LocationId: '190', Radius: 5}}],
    },
  });
  assert.equal(unknown?.status, 'violations');
  assert.deepEqual(
    unknown?.issues.map(i => i.field),
    ['/CampaignCriterions/0/Criterion/Radius'],
  );
});

test('CMP-03 a positive location is added to the paused campaign once and read back by ID with Microsoft’s name', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(add());
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(p.data.creative_impact.may_activate, false, JSON.stringify(p.data.creative_impact));
    assert.match(p.data.creative_impact.effect, /paused Microsoft Search campaign/);
    // The body is held to the pinned Campaign Management WSDL type model (recorded in shadow mode, the default).
    assert.equal(p.data.contract_evidence.wire_contract?.status, 'conforms', JSON.stringify(p.data.contract_evidence));
    assert.equal(p.data.contract_evidence.wire_contract.contract, 'microsoft-campaign-management-v13');
    assert.equal(f.state.writes.length, 0, 'prepare sends nothing');
    const [a, b] = await Promise.all([f.execute(p), f.execute(p)]);
    assert.ok(
      [a, b].some(x => x.success && x.data?.result?.success !== false),
      JSON.stringify([a, b]),
    );
    assert.equal(f.state.writes.length, 1, 'one add, however often execute is called');
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal(v.data.checks.length, 2);
    assert.deepEqual(
      [...f.state.criteria.values()].map(r => [r.CampaignId, r.Criterion.LocationId, r.Criterion.DisplayName]),
      [
        ['501', '190', 'Synthetic location 190'],
        ['501', '32', 'Synthetic location 32'],
      ],
    );
    // Adding a location the campaign already targets is refused before anything is sent.
    const again = await f.prepare(add(['32']));
    assert.equal(again.error.code, 'CONFIGURATION_EXISTS', JSON.stringify(again));
    assert.deepEqual(again.error.details.location_ids, ['32']);
    assert.equal(f.state.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('CMP-03 null answers are empty: a null whole set still takes the first location, null error slots are success', async () => {
  const f = fixture();
  try {
    f.state.nullWhenEmpty = true;
    const p = await f.prepare(add(['190']));
    assert.equal(p.success, true, JSON.stringify(p));
    const done = await f.execute(p);
    assert.equal(done.success, true, JSON.stringify(done));
    assert.equal(done.data.outcome, 'succeeded', JSON.stringify(done.data));
    assert.equal((await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('CMP-03 a foreign or missing parent and an unpaused parent are refused before anything is sent', async () => {
  const f = fixture();
  try {
    // Campaign 777 is not returned under this account's header: another account's campaign is never targeted.
    const foreign = await f.prepare(add(['190'], '777'));
    assert.equal(foreign.success, false);
    assert.equal(foreign.error.code, 'STATE_TARGET_MISMATCH', JSON.stringify(foreign.error));
    for (const Status of ['Active', 'BudgetPaused']) {
      f.state.campaigns.set('501', {...f.state.campaigns.get('501'), Status});
      const serving = await f.prepare(add(['190']));
      assert.equal(serving.error.code, 'LOCATION_PARENT_NOT_PAUSED', JSON.stringify(serving.error));
      assert.equal(serving.error.details.status, Status);
      assert.match(errorRemedy(new MirrorError('LOCATION_PARENT_NOT_PAUSED', 'x')).action, /UpdateCampaigns/);
    }
    assert.equal(f.state.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('CMP-03 (QA-02 exit) a location change refused on an active campaign reviews and runs once the campaign is paused', async () => {
  const f = fixture();
  try {
    f.state.campaigns.set('501', {...f.state.campaigns.get('501'), Status: 'Active'});
    assertRefused(await f.prepare(add(['190'])), 'LOCATION_PARENT_NOT_PAUSED', {writes: () => f.state.writes.length});
    // The way out: pause the campaign with its own reviewed change (a pause reads no location criteria)...
    const pause = await f.prepare({...activate(), payload: {Campaigns: [{Id: '501', Status: 'Paused'}]}});
    assert.equal(pause.success, true, JSON.stringify(pause));
    const paused = await f.execute(pause);
    assert.equal(paused.success, true, JSON.stringify(paused));
    assert.equal(f.state.campaigns.get('501')!.Status, 'Paused');
    // ...then the same location change reviews and runs once, and reads back verified.
    const p = await f.prepare(add(['190']));
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p)).success, true);
    assert.deepEqual(
      f.state.writes.map(w => w.method + ' ' + w.path),
      ['PUT /CampaignManagement/v13/Campaigns', 'POST /CampaignManagement/v13/CampaignCriterions'],
    );
    assert.equal((await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('CMP-03 an uncertain add is never sent again, and a nested partial error is not reported as success', async () => {
  // A lost answer is uncertain (the provider may hold the criteria); a NestedPartialErrors entry is a partial failure.
  for (const [field, code] of [
    ['lost', 'WRITE_OUTCOME_UNCERTAIN'],
    ['nested', 'WRITE_PARTIAL_OR_FAILED'],
  ] as const) {
    const f = fixture();
    try {
      const p = await f.prepare(add());
      assert.equal(p.success, true, JSON.stringify(p));
      f.state[field] = true;
      assertRefused(await f.execute(p), code);
      // Executing the same review again returns the retained outcome: nothing is sent again.
      const second = await f.execute(p);
      assertRefused(second, code);
      if (field === 'nested') assert.equal(second.data.replayed, true, JSON.stringify(second.data));
      assert.equal(f.state.writes.length, 1, field + ': never sent again');
      // Verification cannot turn either outcome into a verified one.
      assertRefused(await f.verify(p), code);
    } finally {
      f.store.close();
    }
  }
});

test('CMP-03 a read-back that shows another location is a mismatch, never verified', async () => {
  const f = fixture();
  try {
    const p = await f.prepare(add(['190']));
    assert.equal((await f.execute(p)).success, true);
    f.state.mismatch = true;
    let v = await f.verify(p);
    for (let i = 0; i < 3 && v.data?.status !== 'mismatch' && v.data?.status !== 'unverified'; i++)
      v = await f.verify(p);
    assert.notEqual(v.data?.status, 'verified', JSON.stringify(v));
    const check = v.data.checks[0];
    assert.ok(['mismatch', 'inconclusive'].includes(check.status), JSON.stringify(check));
    assert.ok(check.changed_fields.includes('/location_id'), JSON.stringify(check));
  } finally {
    f.store.close();
  }
});

test('CMP-03 only an existing positive location of the paused campaign is deleted, verified gone, under the deletion policy', async () => {
  const f = fixture();
  try {
    f.seed('9001', location('190'));
    f.seed('9002', {...location('32'), Type: 'NegativeCampaignCriterion'});
    const remove = (ids: string[]) => ({
      action: 'DeleteCampaignCriterions',
      account_id: '123',
      payload: {CampaignId: '501', CriterionType: 'Targets', CampaignCriterionIds: ids},
    });
    for (const ids of [['9002'], ['9999']]) {
      const refused = await f.prepare(remove(ids));
      assert.equal(refused.error.code, 'STATE_NOT_FOUND', JSON.stringify(refused));
    }
    await f.service.call(
      'amcp_workspace',
      {action: 'save_spend_policy', gateway, account_id: '123', confirmed: true, policy: {allow_deletion: false}},
      actor,
    );
    const forbidden = await f.prepare(remove(['9001']));
    assert.equal(forbidden.error.code, 'POLICY_DELETION_FORBIDDEN', JSON.stringify(forbidden));
    await f.service.call(
      'amcp_workspace',
      {action: 'save_spend_policy', gateway, account_id: '123', confirmed: true, policy: {allow_deletion: true}},
      actor,
    );
    const p = await f.prepare(remove(['9001']));
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal((await f.execute(p)).success, true);
    assert.equal(f.state.writes.length, 1);
    const v = await f.verify(p);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal(f.state.criteria.has('9001'), false);
  } finally {
    f.store.close();
  }
});

test('CMP-03 (P7) campaign activation reads its location criteria: refused without a positive one, allowed with one', async () => {
  const f = fixture();
  try {
    // No criteria, then only an exclusion: Microsoft could serve anywhere it supports, so activation is refused.
    for (const seed of [undefined, {...location('32'), Type: 'NegativeCampaignCriterion'}]) {
      if (seed) f.seed('9002', seed);
      const refused = await f.prepare(activate());
      assert.equal(refused.error.code, 'LOCATION_CRITERIA_REQUIRED', JSON.stringify(refused));
      assert.deepEqual(refused.error.details.campaign_ids, ['501']);
      assert.match(
        refused.error.remedy?.action ?? errorRemedy(new MirrorError('LOCATION_CRITERIA_REQUIRED', 'x')).action,
        /AddCampaignCriterions/,
      );
    }
    assert.equal(f.state.writes.length, 0);
    // Regression (the interim guard refused every activation): with a positive location the activation reviews.
    f.seed('9001', location('190'));
    const p = await f.prepare(activate());
    assert.equal(p.success, true, JSON.stringify(p));
    // The location is removed after review: execute reads again and refuses before sending anything.
    f.state.criteria.delete('9001');
    const stale = await f.execute(p, {spend_change_confirmed: true});
    assert.equal(stale.success, false, JSON.stringify(stale));
    assert.ok(['LOCATION_CRITERIA_REQUIRED', 'STATE_CHANGED'].includes(stale.error.code), JSON.stringify(stale.error));
    assert.equal(f.state.writes.length, 0);
    f.seed('9001', location('190'));
    const fresh = await f.prepare(activate());
    assert.equal(fresh.success, true, JSON.stringify(fresh));
    const done = await f.execute(fresh, {spend_change_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done));
    assert.equal(f.state.campaigns.get('501')!.Status, 'Active');
    // Pausing never needs a location criterion.
    const pause = await f.prepare({...activate(), payload: {Campaigns: [{Id: '501', Status: 'Paused'}]}});
    assert.equal(pause.success, true, JSON.stringify(pause));
  } finally {
    f.store.close();
  }
});
