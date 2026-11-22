import test from 'node:test';
import assert from 'node:assert/strict';
import {checkOf, step as providerStep, world} from './helpers/plan-reference-world.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {MirrorError} from '../dist/src/errors.js';

/**
 * Package r25-field3-refs, fix round item 5 (the lead's review S4-3): Snapchat refuses an ad squad pixel the ad account does not own (E2405) only when the
 * squad is written, so the plan's preflight compares each literal pixel with the account's own pixel list. A reference to a pixel an earlier step creates
 * has a stand-in while the contract is checked, and the check must skip exactly that stand-in. The first round skipped every pixel ID that began with the
 * stand-in's prefix (a UUID of zeros), where before it skipped one value: a literal pixel of that form, which a synthetic test UUID has, passed the check
 * for the wrong reason. The preflight now tells the provider which stand-ins it generated for the step, and only those are skipped.
 * The synthetic account owns one pixel, `pixel-own`; nothing leaves the process and every value is invented.
 */
const gateway = 'snapchat_native_action',
  owned = 'pixel-own',
  standIn = n => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const campaign = providerStep(gateway, 'campaign', {
  action: 'snapchat_campaign_create',
  payload: {
    campaigns: [
      {
        name: 'Synthetic campaign',
        ad_account_id: 'acct1',
        status: 'PAUSED',
        start_time: '2026-10-01T00:00:00.000Z',
        buy_model: 'AUCTION',
        objective_v2_properties: {objective_v2_type: 'LEADS'},
      },
    ],
  },
});
const campaignRef = {$ref: 'campaign#/data/campaigns/0/campaign/id'};
const squad = pixel =>
  providerStep(
    gateway,
    'squad',
    {
      action: 'snapchat_adsquad_create',
      path_params: {campaign_id: campaignRef},
      payload: {
        adsquads: [
          {
            campaign_id: campaignRef,
            name: 'Synthetic squad',
            type: 'SNAP_ADS',
            status: 'PAUSED',
            targeting: {geos: [{country_code: 'sa', operation: 'INCLUDE'}]},
            placement_v2: {config: 'AUTOMATIC'},
            billing_event: 'IMPRESSION',
            bid_strategy: 'AUTO_BID',
            daily_budget_micro: 20000000,
            optimization_goal: 'PIXEL_SIGNUP',
            pixel_id: pixel,
          },
        ],
      },
    },
    ['campaign'],
  );
/** The preflight of the campaign and one squad, with the account's pixel list answered; the pixel reads are counted. */
async function checked(pixel) {
  const w = world([gateway]),
    reads = [];
  w.service.runPlan = async read => {
    if (read.action === 'AMCP_PREFLIGHT_PIXELS') {
      reads.push(read.path);
      return {data: {pixels: [{pixel: {id: owned}}]}};
    }
    throw new MirrorError('READINESS_CONTRACT_UNAVAILABLE', 'The synthetic world has no other account read.');
  };
  try {
    return {out: await w.preflight([campaign, squad(pixel)]), reads};
  } finally {
    w.close();
  }
}

test('R1: a pixel the account owns passes, and a reference to a pixel an earlier step creates is skipped without a read of the account’s pixels', async () => {
  const own = await checked(owned);
  assert.equal(checkOf(own.out, 'squad').status, 'contract_checked', JSON.stringify(checkOf(own.out, 'squad').error));
  assert.equal(own.reads.length, 1, 'a literal pixel is compared with the account’s own list');
  // The pixel is the second result the squad names, so its stand-in is the second one; no literal pixel is left to compare.
  const made = await checked({$ref: 'campaign#/data/campaigns/0/campaign/pixel_id'});
  assert.equal(checkOf(made.out, 'squad').status, 'contract_checked', JSON.stringify(checkOf(made.out, 'squad').error));
  assert.equal(made.reads.length, 0, 'the stand-in is skipped: there is nothing to compare');
});

// R2 (red before the fix): a literal pixel that merely looks like a stand-in is no stand-in of this step, so it is compared with the account’s pixels and
// refused when the account does not own it. The squad names one result (the campaign), so its only stand-in is the first one.
test('R2: a literal pixel of the stand-in’s form that this preflight did not generate is compared with the account’s pixels', async () => {
  for (const pixel of [standIn(2), standIn(255), '00000000-0000-4000-8000-0000000000ab']) {
    const {out, reads} = await checked(pixel),
      check = checkOf(out, 'squad');
    assert.equal(check.status, 'blocked', pixel + ': ' + JSON.stringify(check));
    assertRefused({code: check.error.code}, 'SNAPCHAT_PIXEL_NOT_OWNED');
    assert.deepEqual(check.error.details.pixel_ids, [pixel]);
    assert.equal(reads.length, 1, pixel);
  }
});

// N1 (the check stays): a pixel the account does not own is refused before anything is written, as before.
test('N1: a literal pixel the account does not own is still refused SNAPCHAT_PIXEL_NOT_OWNED, naming the pixels it owns', async () => {
  const {out} = await checked('pixel-shared-elsewhere'),
    check = checkOf(out, 'squad');
  assert.equal(check.status, 'blocked');
  assertRefused({code: check.error.code}, 'SNAPCHAT_PIXEL_NOT_OWNED');
  assert.deepEqual(check.error.details, {pixel_ids: ['pixel-shared-elsewhere'], owned_pixel_ids: [owned]});
});

// The same text twice is one stand-in: a squad whose pixel is the very result its campaign is (the first) has one stand-in, which is skipped.
test('N2: a pixel that is a reference to the first result the squad names is skipped', async () => {
  const same = await checked(campaignRef);
  assert.equal(checkOf(same.out, 'squad').status, 'contract_checked', JSON.stringify(checkOf(same.out, 'squad').error));
  assert.equal(same.reads.length, 0);
});
