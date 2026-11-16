import test from 'node:test';
import assert from 'node:assert/strict';
import {accountPlan, accountMetadata, accountCurrency, accountTimezone} from '../dist/src/account-metadata.js';

/**
 * R2.5 M1 (package r25-m1-hash; M0's "Found, not fixed" 3, L1-02): the adapter's own account read of a TikTok advertiser,
 * which readiness, report collection and plan preflight use, asks TikTok for the seven fields an advertiser is known by and
 * nothing else. Without `fields` TikTok's answer carries the advertiser's contact record, a signed licence link and its
 * balance, and AMCP kept them as evidence. The seven are the owner's Q15 list (2026-11-15), written out by hand here.
 * Nothing leaves the process.
 */
const seven = ['advertiser_id', 'name', 'status', 'role', 'currency', 'timezone', 'country'];

test('the adapter’s account read of a TikTok advertiser names the advertiser and the seven fields', () => {
  const read = accountPlan('tiktok_native_action', '9000000000000000001');
  assert.equal(read.method, 'GET');
  assert.equal(read.path, '/v1.3/advertiser/info/');
  assert.deepEqual(read.query, {advertiser_ids: ['9000000000000000001'], fields: seven});
});

test('the narrowed answer still gives its readers the name, currency and time zone', () => {
  const answer = {
    code: 0,
    data: {
      list: [
        {
          advertiser_id: '9000000000000000001',
          name: 'Synthetic advertiser',
          status: 'STATUS_ENABLE',
          role: 'ROLE_ADVERTISER',
          currency: 'SAR',
          timezone: 'Asia/Riyadh',
          country: 'SA',
        },
      ],
    },
  };
  assert.equal(accountMetadata('tiktok_native_action', answer).name, 'Synthetic advertiser');
  assert.equal(accountCurrency('tiktok_native_action', answer), 'SAR');
  assert.equal(accountTimezone('tiktok_native_action', answer), 'Asia/Riyadh');
});
