import test from 'node:test';
import assert from 'node:assert/strict';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';

/**
 * R2.5 r25-fr-verify (the owner's friction B1), negative: a campaign plan already reads each of its steps back itself, right after the step's
 * execute (src/campaign-runner.ts), so the inline read-back of an execute that a person makes on their own must not run a second time for it. The same
 * approved plan runs under a policy without `inlineVerifyMs` and under the production one: the same requests, the same steps, and no step carries the block.
 */
const assetAction = 'google_ads_v23_asset_mutate_assets';
const step = (id, args) => ({
  id,
  kind: 'write',
  gateway: 'google_ads_native_action',
  connection_id: 'g',
  account_id: '123',
  description: id,
  arguments: args,
  depends_on: [],
});

async function run(policy, tenant) {
  const f = googleReconcileFixture({tenant, policy});
  try {
    f.row('campaign', {resource_name: at('campaigns', '10'), name: 'Existing campaign', status: 'PAUSED'});
    const push = f.db.asset.push;
    f.db.asset.push = function (row) {
      if (row.text_asset) Object.assign(row, {type: 'TEXT', source: 'ADVERTISER'});
      return push.call(this, row);
    };
    const created = await f.call('amcp_campaign', {
      action: 'create',
      name: 'Synthetic plan',
      brief: 'Synthetic.',
      steps: [
        step('texts', {
          action: assetAction,
          payload: {
            operations: ['Synthetic headline A', 'Synthetic headline B'].map(text => ({create: {text_asset: {text}}})),
          },
        }),
      ],
    });
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
    const id = created.data.id,
      call = input => f.call('amcp_campaign', {id, ...input}),
      preview = (await call({action: 'approve'})).data;
    assert.equal(
      (await call({...preview.next_call.arguments, ...preview.next_call.add_after_user_approval})).success,
      true,
    );
    const ran = await call({action: 'run'});
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 800));
    assert.equal(ran.data.run.stopped, 'complete');
    const stored = (await call({action: 'get', detail: 'full'})).data.steps[0];
    return {
      writes: f.writes.length,
      requests: f.requests.length,
      status: stored.status,
      verification: stored.verification?.status,
      marker: stored.result?.verification,
    };
  } finally {
    f.close();
  }
}

test('N6: an approved plan makes the same requests under the inline policy, and no step answers with an inline block', async () => {
  const without = await run({}, 'inline-plan-off'),
    inline = await run({inlineVerifyMs: 5000}, 'inline-plan-on');
  assert.deepEqual(inline.status, 'verified');
  assert.equal(inline.verification, 'verified', 'the plan read the step back itself');
  assert.deepEqual(
    [inline.writes, inline.requests],
    [without.writes, without.requests],
    'the same writes, and the same reads: no second read-back',
  );
  assert.equal(
    inline.marker?.inline,
    undefined,
    'the step holds the answer the execute gave the plan: the queued marker',
  );
  assert.equal(inline.marker?.status, without.marker?.status);
});
