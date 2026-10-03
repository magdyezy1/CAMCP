import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotPlans} from '../dist/src/write-snapshots.js';
import {Registry} from '../dist/src/catalog.js';
import {trafficFixture, trafficBusiness, actor} from './fixtures/snapchat-traffic-data.mjs';
const gateway = 'snapchat_native_action';
function prepare(f, creativeId = trafficBusiness.creative_id) {
  f.squads.set('owned-squad', {
    id: 'owned-squad',
    campaign_id: 'owned-campaign',
    status: 'PAUSED',
    name: 'Synthetic parent',
  });
  const connection = f.store.resolveConnection(actor, gateway, 'acct1', trafficBusiness.connection_id);
  f.store.rememberResource(connection, 'acct1', 'adsquads/owned-squad');
  return f.service.call(
    'amcp_write',
    {
      action: 'prepare',
      gateway,
      connection_id: connection.id,
      arguments: {
        action: 'snapchat_ad_create',
        account_id: 'acct1',
        path_params: {ad_squad_id: 'owned-squad'},
        payload: {
          ads: [
            {
              name: 'Synthetic ad',
              ad_squad_id: 'owned-squad',
              creative_id: creativeId,
              type: 'REMOTE_WEBPAGE',
              status: 'PAUSED',
            },
          ],
        },
      },
    },
    actor,
  );
}
test('a native Snapchat ad cannot review an unobserved creative even under an owned paused squad', async t => {
  const f = trafficFixture();
  t.after(() => f.close());
  const out = await prepare(f, '99999999-9999-4999-8999-999999999999');
  assert.equal(out.success, false);
  assert.equal(out.error.code, 'RESOURCE_SCOPE_REQUIRED');
  assert.equal(f.adWrites.length, 0);
  assert.ok(
    !f.requests.some(r => r.includes('/creatives/99999999')),
    'Never read a globally addressed foreign creative',
  );
});
test('a known creative returning a foreign or absent owner cannot be reviewed', async t => {
  for (const owner of ['foreign-account', undefined]) {
    const f = trafficFixture();
    t.after(() => f.close());
    assert.equal((await f.readCreative()).success, true);
    f.creative.ad_account_id = owner;
    const out = await prepare(f);
    assert.equal(out.success, false);
    assert.equal(out.error.code, 'ACCOUNT_SCOPE_MISMATCH');
    assert.equal(f.adWrites.length, 0);
  }
});
test('native ad review binds the original creative destination and rejects changed content before submission', async t => {
  for (const changed of ['destination', 'owner']) {
    const f = trafficFixture();
    t.after(() => f.close());
    assert.equal((await f.readCreative()).success, true);
    const review = await prepare(f);
    assert.equal(review.success, true, JSON.stringify(review.error));
    assert.equal(review.data.before_state.length, 2, 'Parent and original creative are frozen in the native review');
    if (changed === 'destination') f.creative.web_view_properties.url = 'https://example.com/changed';
    else f.creative.ad_account_id = 'foreign-account';
    const out = await f.service.call(
      'amcp_write',
      {action: 'execute', review_id: review.data.review_id, confirmed: true, spend_change_confirmed: true},
      actor,
    );
    assert.equal(out.success, false);
    assert.equal(out.error.code, changed === 'owner' ? 'ACCOUNT_SCOPE_MISMATCH' : 'STATE_CHANGED');
    assert.equal(f.adWrites.length, 0);
  }
});
test('the native website-ad review rechecks creative type and HTTPS syntax after collection discovery', async t => {
  for (const scenario of ['type', 'url']) {
    const f = trafficFixture();
    t.after(() => f.close());
    assert.equal((await f.readCreative()).success, true);
    if (scenario === 'type') f.creative.type = 'SNAP_AD';
    else f.creative.web_view_properties.url = 'http://example.test';
    const out = await prepare(f);
    assert.equal(out.success, false);
    assert.equal(out.error.code, scenario === 'type' ? 'CAMPAIGN_PREREQUISITE_REQUIRED' : 'DESTINATION_REQUIRED');
    assert.equal(f.adWrites.length, 0);
  }
});
test('ad creative replacements read unique referenced creatives and reject malformed references locally', async () => {
  const registry = new Registry(),
    base = {
      gateway,
      accountId: 'acct1',
      action: 'synthetic',
      method: 'PUT',
      path: '/v1/adaccounts/acct1/ads',
      query: {},
      headers: {},
      readOnly: false,
      destructive: false,
      requiresConfirmation: true,
      warnings: [],
    };
  const paths = body => snapshotPlans({...base, body}, registry).map(r => r.path);
  assert.deepEqual(
    paths({
      ads: [
        {id: 'ad-1', creative_id: 'creative-1'},
        {id: 'ad-2', creative_id: 'creative-1'},
      ],
    }),
    ['/v1/ads/ad-1', '/v1/ads/ad-2', '/v1/creatives/creative-1'],
  );
  assert.deepEqual(paths({ads: [{id: 'ad-1', name: 'Rename only'}]}), ['/v1/ads/ad-1']);
  for (const id of [null, {}, '../foreign', 'creative?token=x', 'a'.repeat(201)])
    assert.throws(
      () => paths({ads: [{id: 'ad-1', creative_id: id}]}),
      e => e.code === 'INVALID_PARAMETER',
    );
  const patch = {...base, method: 'PATCH', path: '/v1/adaccounts/acct1/ads/ad-1'};
  assert.deepEqual(
    snapshotPlans({...patch, body: [{op: 'replace', path: '/creative_id', value: 'creative-2'}]}, registry).map(
      r => r.path,
    ),
    ['/v1/ads/ad-1', '/v1/creatives/creative-2'],
  );
  assert.throws(
    () => snapshotPlans({...patch, body: [{op: 'remove', path: '/creative_id'}]}, registry),
    e => e.code === 'INVALID_PATCH',
  );
  const {snapAdCreativePrerequisites} = await import('../dist/src/snapchat-ad-creatives.js');
  const replacement = {...patch, body: [{op: 'replace', path: '/creative_id', value: 'creative-2'}]},
    state = [
      {ads: [{ad: {id: 'ad-1', type: 'REMOTE_WEBPAGE'}}]},
      {creatives: [{creative: {id: 'creative-2', type: 'SNAP_AD', ad_account_id: 'acct1'}}]},
    ];
  assert.throws(
    () => snapAdCreativePrerequisites(replacement, state),
    e => e.code === 'CAMPAIGN_PREREQUISITE_REQUIRED',
  );
});
