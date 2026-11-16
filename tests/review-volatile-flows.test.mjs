import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 M1 (package r25-m1-hash): the objects a review changes keep their protection, minus the fields that change by
 * themselves. Each case drives the real lifecycle (MirrorService, NativeTransport, the store) against a synthetic
 * provider whose answer to the target read changes between review and execute:
 *   - L4-13 (X): `servable` and `reasons_not_servable` are computed per read; a budget change is a real change.
 *   - L4-26 (LinkedIn): serving state, the creative review and the audit stamps change by themselves; a name or a
 *     status change is a real change.
 * Nothing leaves the process; every value is synthetic.
 */
const registry = new Registry(),
  key = Buffer.alloc(32, 61).toString('base64'),
  actor = {tenantId: 'test', userId: 'writer', role: 'operator'},
  admin = {...actor, role: 'admin'},
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};

/** Prepares, lets the provider change its answer, executes: what execute answered and how many writes were sent. */
async function lifecycle({gateway, args, answer}) {
  const store = new Store(':memory:', key),
    connection = {
      id: 'connection',
      tenantId: 'test',
      gateway: gateway + '_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    };
  store.putConnection(admin, connection, {
    accessToken: 'synthetic',
    consumerKey: 'synthetic',
    consumerSecret: 'synthetic',
    tokenSecret: 'synthetic',
  });
  store.rememberResource(connection, '123', '111');
  let phase = 'prepare',
    writes = 0;
  const service = new MirrorService(
    registry,
    store,
    new NativeTransport(async (input, init = {}) => {
      const url = new URL(String(input));
      if ((init.method ?? 'GET') === 'GET') return Response.json(answer(url.pathname, phase));
      writes++;
      return args.status === 204 ? new Response(null, {status: 204}) : Response.json(args.response);
    }),
    undefined,
    policy,
  );
  try {
    const {status: _s, response: _r, ...request} = args;
    const prepared = await service.call(
      'amcp_write',
      {action: 'prepare', gateway: gateway + '_native_action', arguments: {account_id: '123', ...request}},
      actor,
    );
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    phase = 'execute';
    const done = await service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: prepared.data.review_id,
        idempotency_key: prepared.data.idempotency_key,
        confirmed: true,
      },
      actor,
    );
    return {done, writes: () => writes};
  } finally {
    store.close();
  }
}

// --- X ---------------------------------------------------------------------------------------------------------------

const xCampaign = (extra = {}) => ({
  id: '111',
  name: 'Draft',
  entity_status: 'PAUSED',
  daily_budget_amount_local_micro: '1000000',
  ...extra,
});
const xCase = row => ({
  gateway: 'x_ads',
  args: {
    action: 'x_accounts_account_id_campaigns_campaign_id_put',
    path_params: {campaign_id: '111'},
    payload: {name: 'Renamed'},
    response: {data: {id: '111'}},
  },
  answer: (path, phase) => ({data: row(phase), request: {params: {}}}),
});

test('X (L4-13): a campaign whose servable state flips between review and execute is the same campaign', async () => {
  const flips = phase =>
    xCampaign(
      phase === 'prepare'
        ? {servable: true, reasons_not_servable: [], effective_status: 'RUNNING', updated_at: '2026-11-16T10:00:00Z'}
        : {
            servable: false,
            reasons_not_servable: ['EXPIRED', 'PAUSED_BY_ADVERTISER'],
            effective_status: 'PAUSED',
            updated_at: '2026-11-16T10:04:00Z',
          },
    );
  const {done, writes} = await lifecycle(xCase(flips));
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
  assert.equal(writes(), 1);
});

test('X (L4-13): a real change of the campaign budget is still STATE_CHANGED, and nothing is sent', async () => {
  const {done, writes} = await lifecycle(
    xCase(phase =>
      xCampaign({
        servable: phase === 'prepare',
        daily_budget_amount_local_micro: phase === 'prepare' ? '1000000' : '9000000',
      }),
    ),
  );
  assertRefused(done, 'STATE_CHANGED', {writes});
  assert.deepEqual(done.error.details.changed_fields, ['$[0]["data"]["daily_budget_amount_local_micro"]']);
});

test('X: a change of the status of the campaign being changed is STATE_CHANGED', async () => {
  const {done, writes} = await lifecycle(
    xCase(phase => xCampaign({entity_status: phase === 'prepare' ? 'PAUSED' : 'ACTIVE'})),
  );
  assertRefused(done, 'STATE_CHANGED', {writes});
  assert.deepEqual(done.error.details.changed_fields, ['$[0]["data"]["entity_status"]']);
});

// --- LinkedIn --------------------------------------------------------------------------------------------------------

const li = 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns';
const liCampaign = (extra = {}) => ({
  id: 111,
  name: 'Draft',
  status: 'PAUSED',
  account: 'urn:li:sponsoredAccount:123',
  ...extra,
});
const liCase = row => ({
  gateway: 'linkedin',
  args: {
    action: li + '_campaign_id_post',
    path_params: {campaign_id: '111'},
    restli_method: 'PARTIAL_UPDATE',
    payload: {patch: {$set: {name: 'Renamed'}}},
    status: 204,
  },
  answer: (path, phase) => row(phase),
});

test('LinkedIn (L4-26): serving state, the review of a creative and the audit stamps change by themselves', async () => {
  const telemetry = phase =>
    liCampaign(
      phase === 'prepare'
        ? {
            servingStatuses: ['RUNNABLE'],
            isServing: true,
            servingHoldReasons: [],
            review: {status: 'PENDING'},
            changeAuditStamps: {created: {time: 1}, lastModified: {time: 2}},
          }
        : {
            servingStatuses: ['STOPPED', 'BUDGET_EXHAUSTED'],
            isServing: false,
            servingHoldReasons: ['CAMPAIGN_GROUP_PAUSED'],
            review: {status: 'APPROVED'},
            changeAuditStamps: {created: {time: 1}, lastModified: {time: 9}},
          },
    );
  const {done, writes} = await lifecycle(liCase(telemetry));
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
  assert.equal(writes(), 1);
});

test('LinkedIn: a changed name or status of the campaign being changed is STATE_CHANGED, and nothing is sent', async () => {
  for (const [field, before, after] of [
    ['name', 'Draft', 'Edited elsewhere'],
    ['status', 'PAUSED', 'ACTIVE'],
  ]) {
    const {done, writes} = await lifecycle(
      liCase(phase => liCampaign({[field]: phase === 'prepare' ? before : after, review: {status: phase}})),
    );
    assertRefused(done, 'STATE_CHANGED', {writes});
    assert.deepEqual(done.error.details.changed_fields, ['$[0]["' + field + '"]'], field);
  }
});
