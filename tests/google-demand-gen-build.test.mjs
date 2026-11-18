import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {
  demandGenAccount,
  demandGenAssets,
  demandGenBuild,
  demandGenBuildArguments,
  demandGenResponder,
} from './fixtures/google-demand-gen-build.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * The J12 build and its budget (R2.5 M3, G6, L2-12; package r25-m3-targeting): a Demand Gen campaign built through AMCP is two MCP
 * calls, `amcp_write` prepare and execute, whatever its operations: the budget, the campaign (PAUSED), the ad group with its location
 * and language, and the ads that link the account's images. Validate-only adds no MCP call; it adds one provider request to the
 * prepare. The numbers below are what this build measures against the synthetic Google of tests/fixtures/google-demand-gen-build.mjs,
 * the first baseline of J12's build (the lead's decision on Q1: M3 records them and M5, L2-11, lowers them). Customer 123.
 */
const owner = {tenantId: 'demand-gen-j12', userId: 'operator', role: 'admin'};
function setup(options = {}) {
  const responder = demandGenResponder(options),
    store = new Store(':memory:', Buffer.alloc(32, 88).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId: owner.tenantId,
      gateway: 'google_ads_native_action',
      accounts: [demandGenAccount],
      writeAccounts: [demandGenAccount],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(responder.fetcher, async () => {}, 30000, 8 * 1024 * 1024, 100000),
    undefined,
    // The policy of the journey harness: writes on, and the default provider check on, as in production.
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true, providerCheckByDefault: true},
  );
  let calls = 0;
  const call = (tool, input) => {
    calls++;
    return service.call(tool, input, owner);
  };
  const count = kind => responder.log.filter(r => r.kind === kind).length;
  return {
    responder,
    store,
    mcpCalls: () => calls,
    count,
    requests: () => responder.log.length,
    prepare: (extra = {}, build = demandGenBuild()) =>
      call('amcp_write', {
        action: 'prepare',
        gateway: 'google_ads_native_action',
        connection_id: 'g',
        arguments: demandGenBuildArguments(build),
        ...extra,
      }),
    execute: (review, extra = {spend_change_confirmed: true}) =>
      call('amcp_write', {action: 'execute', review_id: review.data.review_id, confirmed: true, ...extra}),
  };
}

test('the J12 build is two MCP calls, one provider mutate and six provider requests, the default validation included', async () => {
  const x = setup();
  try {
    const review = await x.prepare();
    assert.equal(review.success, true, JSON.stringify(review).slice(0, 900));
    // Validate-only adds no MCP call: it is one provider request of the prepare, marked as the default.
    assert.equal(x.mcpCalls(), 1);
    assert.equal(review.data.provider_check.status, 'provider_validated');
    assert.equal(review.data.provider_check.default, true);
    const validation = x.responder.log.find(r => r.kind === 'validation');
    assert.equal(validation.body.validate_only, true);
    assert.equal(validation.body.mutate_operations.length, 7, 'the whole build is what Google validates');
    // The prepare: the customer (currency and time zone), the two bounded lookups of what the build's campaign and ad group names could
    // collide with (the review freezes their answers), and the one validate-only request. Nothing is applied.
    assert.deepEqual(
      {reads: x.count('read'), validations: x.count('validation'), writes: x.count('write'), requests: x.requests()},
      {reads: 3, validations: 1, writes: 0, requests: 4},
    );
    assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
    const done = await x.execute(review);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 900));
    // The whole build: two MCP calls, and the execute reads the customer again and sends the one all-or-nothing request. The read-back
    // of the seven created resources is the verification, a call of its own (L2-11 batches it in M5), and is not counted here.
    assert.equal(x.mcpCalls(), 2, 'prepare and execute');
    assert.deepEqual(
      {reads: x.count('read'), validations: x.count('validation'), writes: x.count('write'), requests: x.requests()},
      {reads: 4, validations: 1, writes: 1, requests: 6},
    );
    // What was sent is the build, whole: the geography is on the ad group, and no campaign-level criterion is in it.
    const sent = x.responder.log.find(r => r.kind === 'write').body.mutate_operations;
    assert.equal(sent.length, 7);
    const criteria = sent
      .filter(o => o.ad_group_criterion_operation)
      .map(o => Object.keys(o.ad_group_criterion_operation.create));
    assert.deepEqual(criteria, [
      ['ad_group', 'location'],
      ['ad_group', 'language'],
    ]);
    assert.ok(!sent.some(o => o.campaign_criterion_operation), 'no campaign-level location or language');
    const campaign = sent.find(o => o.campaign_operation).campaign_operation.create;
    assert.equal(campaign.status, 'PAUSED');
    assert.equal(campaign.advertising_channel_type, 'DEMAND_GEN');
    // The ads link the account's existing images.
    const linked = JSON.stringify(sent.filter(o => o.ad_group_ad_operation));
    for (const asset of Object.values(demandGenAssets)) assert.ok(linked.includes(asset), asset);
  } finally {
    x.store.close();
  }
});

test('the J12 build asks for the spend flag at execute, and a second execute replays instead of sending again', async () => {
  const x = setup();
  try {
    const review = await x.prepare();
    assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: () => x.count('write')});
    assert.equal((await x.execute(review)).success, true);
    assert.equal((await x.execute(review)).data.replayed, true);
    assert.equal(x.count('write'), 1);
  } finally {
    x.store.close();
  }
});
test('the fake serves the existing images and what the build created', async () => {
  const x = setup();
  try {
    const review = await x.prepare();
    assert.equal((await x.execute(review)).success, true);
    // The images the ads link are the account's own: a search of its assets lists them.
    const assets = await x.responder.fetcher('https://googleads.googleapis.com/v25/customers/123/googleAds:search', {
      method: 'POST',
      body: JSON.stringify({query: 'SELECT asset.resource_name, asset.name FROM asset WHERE asset.type = IMAGE'}),
    });
    const rows = (await assets.json()).results.map(r => r.asset.resourceName);
    assert.deepEqual(rows.sort(), Object.values(demandGenAssets).sort());
    // And what the build created is readable by name, as the build's read-back reads it.
    assert.equal(x.responder.created.size, 7);
    assert.ok([...x.responder.created.keys()].every(n => /^customers\/123\/[A-Za-z]+\/\d+(~\d+)?$/.test(n)));
  } finally {
    x.store.close();
  }
});

test('the J12 build keeps its gates: the default check can reject it, cannot run, or be left out; and the campaign-level form is refused', async () => {
  // A rejection blocks execute and names the field path; nothing is applied.
  const rejected = setup({validation: 'reject'});
  try {
    const review = await rejected.prepare();
    assert.equal(review.data.provider_check.status, 'provider_rejected');
    // The path Google names for a build: the build's own operation, by its index, and the field of its criterion.
    assert.deepEqual(review.data.provider_check.field_paths, [
      'mutate_operations[3].ad_group_criterion_operation.create.location',
    ]);
    assertRefused(await rejected.execute(review), 'PROVIDER_VALIDATION_FAILED', {
      writes: () => rejected.count('write'),
    });
  } finally {
    rejected.store.close();
  }
  // An outage of the check prepares the review without it, and the build still executes.
  const outage = setup({validation: 'outage'});
  try {
    const review = await outage.prepare();
    assert.equal(review.data.provider_check.status, 'not_run');
    assert.equal((await outage.execute(review)).success, true);
    assert.equal(outage.count('write'), 1);
  } finally {
    outage.store.close();
  }
  // The caller may leave the check out: one provider request fewer, the same review.
  const optedOut = setup();
  try {
    const review = await optedOut.prepare({provider_check: false});
    assert.equal(review.success, true);
    assert.equal(optedOut.count('validation'), 0);
    assert.equal(Object.hasOwn(review.data, 'provider_check'), false);
  } finally {
    optedOut.store.close();
  }
  // The form Google refuses is refused here, in the build's prerequisites (after the build's reads, before any validation is sent),
  // naming the operation and the ad-group route.
  const wrongLevel = setup();
  try {
    const build = demandGenBuild();
    build.splice(3, 2, {
      campaign_criterion_operation: {
        create: {campaign: 'customers/123/campaigns/-2', location: {geo_target_constant: 'geoTargetConstants/2818'}},
      },
    });
    const refused = await wrongLevel.prepare({}, build);
    assertRefused(refused, 'INVALID_TARGETING_MUTATION', {writes: () => wrongLevel.count('write')});
    assert.equal(refused.error.details.operation, 3);
    assert.equal(refused.error.details.channel, 'DEMAND_GEN');
    assert.equal(wrongLevel.count('validation'), 0, 'a request AMCP refuses is never sent to Google');
  } finally {
    wrongLevel.store.close();
  }
});
