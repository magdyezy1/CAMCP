import test from 'node:test';
import assert from 'node:assert/strict';
import {compileEntityRead} from '../dist/src/workflows.js';
import {xAnalyticsTime} from '../dist/src/x-report-jobs.js';
import {providerHooks, registeredProviderHooks} from '../dist/src/provider-hooks.js';
import {launchCheckPlatforms} from '../dist/src/launch-check.js';
import {providerAdapters, providerById} from '../dist/src/provider-adapters.js';
import {pausedParentChildStatuses, pausedParentFollowUp, validatePausedParents} from '../dist/src/paused-parents.js';
import {nativeAmount, policyNativeUnit, setMetaCurrencyOffsetsForTest} from '../dist/src/budget-units.js';
import {assertLinkedInOrganization} from '../dist/src/linkedin-posts.js';
import {
  assertLinkedInResume,
  assertLinkedInWaiting,
  linkedInPartId,
  linkedInResumeReason,
  linkedInTransfer,
} from '../dist/src/linkedin-media-resume.js';
import {assertNamesNoProvider} from './helpers/shared-module-seams.mjs';

// ARC-01 phase B, wave 4c round 6: shared modules that named providers' gateways or imported their modules take those
// facts from the providers' adapters now. Each test's first assertion fails on the build before its move; the others pin
// the facts the shared module reads and pass on both builds.

test('the generic workflows take their platforms’ gateways from the adapters and X’s stats time from its hooks', () => {
  assertNamesNoProvider('src/workflows.ts');
  // The four platforms the generic workflows serve are adapter IDs; each step goes to that adapter's gateway.
  for (const [platform, gateway, account] of [
    ['google', 'google_ads_native_action', '1234567890'],
    ['linkedin', 'linkedin_native_action', '507404993'],
    ['x', 'x_ads_native_action', '18ce54d4x5t'],
    ['dv360', 'dv360_native_action', '4180000'],
  ])
    assert.equal(compileEntityRead('list_campaigns', {platform, account_id: account}).gateway, gateway, platform);
  // A native-only platform is still refused with its own gateway named, another with no adapter of these four.
  assert.throws(
    () => compileEntityRead('list_campaigns', {platform: 'meta', account_id: '1'}),
    e => e.code === 'NATIVE_ONLY_PLATFORM' && e.details.gateway === 'meta_native_action',
  );
  assert.throws(
    () => compileEntityRead('list_campaigns', {platform: 'reddit', account_id: '1'}),
    e => e.code === 'WORKFLOW_UNSUPPORTED' && e.details.platform === 'reddit',
  );
  assert.throws(
    () => compileEntityRead('list_campaigns', {platform: 'toString', account_id: '1'}),
    e => e.code === 'WORKFLOW_UNSUPPORTED',
  );
  // Only X declares a generic workflow fact: its analytics times, whole UTC hours, the function X's report jobs use.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.genericWorkflows).map(h => h.gateway),
    ['x_ads_native_action'],
  );
  const {statsTime} = providerHooks('x_ads_native_action').genericWorkflows;
  assert.equal(statsTime, xAnalyticsTime);
  assert.ok(Object.isFrozen(providerHooks('x_ads_native_action').genericWorkflows));
  assert.equal(statsTime(Date.UTC(2026, 0, 31, 23)), '2026-01-31T23:00:00Z');
  for (const instant of [Date.UTC(2026, 0, 1, 0, 30), 1.5, Number.NaN])
    assert.throws(
      () => statsTime(instant),
      e => e.code === 'INVALID_REPORT_RANGE' && e.message === 'X analytics times are expressed in whole hours.',
    );
});

test('the launch check reads each guided launch through its platform adapter’s gateway', () => {
  assertNamesNoProvider('src/launch-check.ts');
  // tests/launch-check.test.mjs checks each platform's reads, refusals and findings through the tool.
  assert.deepEqual(
    launchCheckPlatforms.map(platform => providerById(platform)?.gateway),
    ['meta_native_action', 'snapchat_native_action'],
  );
});

/** A reviewed request as the review compiles it. */
const request = (gateway, path, body, method = 'POST') => ({
  gateway,
  accountId: '1',
  action: 'reviewed_write',
  method,
  path,
  query: {},
  headers: {},
  ...(body === undefined ? {} : {body}),
  readOnly: method === 'GET',
  destructive: false,
  requiresConfirmation: method !== 'GET',
  evidence: 'test',
  warnings: [],
});

test('the paused-parent rule reads each platform’s child creates from its adapter’s facts', () => {
  assertNamesNoProvider('src/paused-parents.ts');
  assert.deepEqual(
    providerAdapters.filter(a => a.pausedParents).map(a => a.id),
    ['meta', 'tiktok', 'snapchat'],
  );
  for (const [gateway, path, statuses] of [
    ['snapchat_native_action', '/v1/campaigns/c1/adsquads', ['PAUSED', 'ACTIVE']],
    ['snapchat_native_action', '/v1/adsquads/s1/ads', ['PAUSED', 'ACTIVE']],
    ['meta_native_action', '/v24.0/act_1/adsets', ['PAUSED', 'ACTIVE']],
    ['meta_native_action', '/v24.0/act_1/ads', ['PAUSED', 'ACTIVE']],
    ['tiktok_native_action', '/v1.3/adgroup/create/', ['DISABLE', 'ENABLE']],
    ['tiktok_native_action', '/v1.3/ad/create/', ['DISABLE', 'ENABLE']],
  ]) {
    assert.deepEqual(pausedParentChildStatuses(request(gateway, path, {})), statuses, path);
    // The method is checked first: only a POST creates a child.
    assert.equal(pausedParentChildStatuses(request(gateway, path, {}, 'PATCH')), undefined, path);
  }
  // Another platform's child path, a campaign create, another gateway and an inherited name create no child.
  for (const [gateway, path] of [
    ['meta_native_action', '/v1/campaigns/c1/adsquads'],
    ['snapchat_native_action', '/v24.0/act_1/adsets'],
    ['tiktok_native_action', '/v1.3/campaign/create/'],
    ['google_ads_native_action', '/v1.3/adgroup/create/'],
    ['toString', '/v1.3/adgroup/create/'],
  ])
    assert.equal(pausedParentChildStatuses(request(gateway, path, {})), undefined, gateway + ' ' + path);
  // Meta: an active ad set is refused under a serving campaign and allowed under a paused one.
  const adset = request('meta_native_action', '/v24.0/act_1/adsets', {status: 'ACTIVE', campaign_id: '7'});
  assert.throws(
    () => validatePausedParents(adset, [{id: '7', status: 'ACTIVE'}]),
    e =>
      e.code === 'PARENT_SERVING' &&
      e.message ===
        'A new ad set must start PAUSED while its campaign can serve (campaign ACTIVE). Under a PAUSED campaign it may start ACTIVE.' &&
      JSON.stringify(e.details) ===
        JSON.stringify({field: 'status', parent: 'campaign', parent_status: 'ACTIVE', allowed: ['PAUSED']}),
  );
  assert.equal(validatePausedParents(adset, [{id: '7', status: 'PAUSED'}]), undefined);
  // An active ad under a serving ad set reads the campaign its ad set names; TikTok's ad its ad group's campaign.
  const metaRead = request('meta_native_action', '/v24.0/8', undefined, 'GET');
  assert.deepEqual(
    pausedParentFollowUp(
      request('meta_native_action', '/v24.0/act_1/ads', {status: 'ACTIVE', adset_id: '8'}),
      metaRead,
      {
        id: '8',
        status: 'ACTIVE',
        campaign_id: '7',
      },
    ),
    {...metaRead, path: '/v24.0/7', query: {fields: 'id,name,status'}},
  );
  const tiktokRead = {
    ...request('tiktok_native_action', '/v1.3/adgroup/get/', undefined, 'GET'),
    query: {advertiser_id: '5'},
  };
  assert.deepEqual(
    pausedParentFollowUp(
      request('tiktok_native_action', '/v1.3/ad/create/', {adgroup_id: '9', creatives: [{operation_status: 'ENABLE'}]}),
      tiktokRead,
      {data: {list: [{adgroup_id: '9', campaign_id: '3', operation_status: 'ENABLE'}]}},
    ),
    {
      ...tiktokRead,
      action: 'tiktok_campaign_get',
      path: '/v1.3/campaign/get/',
      query: {advertiser_id: '5', filtering: {campaign_ids: ['3']}, page_size: 100},
    },
  );
  // Snapchat's ad under a paused ad squad needs no campaign read.
  assert.equal(
    pausedParentFollowUp(
      request('snapchat_native_action', '/v1/adsquads/s1/ads', {ads: [{status: 'ACTIVE'}]}),
      request('snapchat_native_action', '/v1/adsquads/s1', undefined, 'GET'),
      {adsquads: [{adsquad: {id: 's1', status: 'PAUSED', campaign_id: 'c1'}}]},
    ),
    undefined,
  );
});

test('the budget units read which platform counts a per-currency offset from its adapter’s facts', () => {
  assertNamesNoProvider('src/budget-units.ts');
  assert.deepEqual(
    providerAdapters.filter(a => a.currencyOffsetBudgets).map(a => a.id),
    ['meta'],
  );
  setMetaCurrencyOffsetsForTest({USD: 100, JPY: 1});
  try {
    // Meta's caps convert with the currency's offset in its capture; without a currency, or for one the capture does
    // not list, they have no native amount.
    assert.equal(nativeAmount('meta_native_action', 12.5, 'USD'), 1250);
    assert.equal(nativeAmount('meta_native_action', 500, 'JPY'), 500);
    assert.equal(nativeAmount('meta_native_action', 12.5), undefined);
    assert.equal(nativeAmount('meta_native_action', 12.5, 'KWD'), undefined);
    // A documented unit stays the platform's own; an undocumented platform and an inherited name have none.
    assert.equal(nativeAmount('google_ads_native_action', 12.5, 'USD'), 12_500_000);
    assert.equal(nativeAmount('tiktok_native_action', 12.5, 'USD'), undefined);
    assert.equal(nativeAmount('toString', 12.5, 'USD'), undefined);
    assert.deepEqual(policyNativeUnit('meta_native_action', 'USD'), {
      perCurrencyUnit: 100,
      unit: '1/100 USD',
      evidence: 'Meta currency offset 100 for USD, synthetic test capture (test)',
    });
    assert.equal(policyNativeUnit('meta_native_action', 'JPY').unit, 'whole JPY');
    assert.equal(policyNativeUnit('meta_native_action', 7), undefined);
    assert.equal(policyNativeUnit('tiktok_native_action', 'USD'), undefined);
    assert.equal(policyNativeUnit('google_ads_native_action', 'USD').unit, 'micros');
    // Without a valid capture, Meta's caps stay native.
    setMetaCurrencyOffsetsForTest(null);
    assert.equal(nativeAmount('meta_native_action', 12.5, 'USD'), undefined);
    assert.equal(policyNativeUnit('meta_native_action', 'USD'), undefined);
  } finally {
    setMetaCurrencyOffsetsForTest(undefined);
  }
});

test('the media upload reaches LinkedIn’s organization owners and resumable transfers through its adapter’s hooks', () => {
  // Its Google Ads, LinkedIn and Meta versions are their adapters' version facts, asked through providerVersions, so it
  // imports no version module (tests/provider-versions.test.mjs pins each answer against the module's own export).
  assertNamesNoProvider('src/media-upload.ts');
  // Only LinkedIn declares media steps, its own functions, frozen; tests/linkedin-media-resume.test.mjs,
  // tests/linkedin-media-authority.test.mjs and tests/media-upload.test.ts exercise them through the tool.
  assert.deepEqual(
    registeredProviderHooks.filter(h => h.media).map(h => h.gateway),
    ['linkedin_native_action'],
  );
  const media = providerHooks('linkedin_native_action').media;
  assert.ok(Object.isFrozen(media));
  assert.deepEqual(media, {
    assertOrganization: assertLinkedInOrganization,
    transfer: linkedInTransfer,
    resumeReason: linkedInResumeReason,
    assertResume: assertLinkedInResume,
    assertWaiting: assertLinkedInWaiting,
    partId: linkedInPartId,
  });
  // An organization owner must be bound to the selected account and connection.
  const connection = {
    id: 'login',
    accounts: ['123'],
    resourceBindings: [{accountId: '123', pathPrefix: '/rest/organizations/500'}],
  };
  assert.equal(media.assertOrganization(connection, '123', 'urn:li:organization:500'), undefined);
  assert.throws(
    () => media.assertOrganization(connection, '123', 'urn:li:organization:501'),
    e => e.code === 'LINKEDIN_ORGANIZATION_BINDING_REQUIRED',
  );
  // A transfer resumes only with its own receipt, login and scopes, while LinkedIn still waits for its parts.
  const binding = {
      account_id: '123',
      connection_id: 'login',
      owner_urn: 'urn:li:organization:500',
      sha256: 'a'.repeat(64),
      size: 10,
    },
    auth = {accessToken: 'synthetic'},
    part = {uploadUrl: 'https://www.linkedin.com/dms-uploads/part', firstByte: 0, lastByte: 9},
    session = media.transfer(
      binding,
      auth,
      ['w_organization_social'],
      'urn:li:video:C1',
      {uploadToken: 't', uploadUrlsExpireAt: Date.now() + 600000},
      [part],
    );
  assert.equal(media.resumeReason(binding, session, auth, ['w_organization_social']), undefined);
  assert.equal(media.resumeReason(binding, session, auth, []), 'login_changed');
  assert.equal(media.resumeReason(binding, undefined), 'legacy_or_missing_transfer');
  assert.throws(
    () => media.assertResume(binding, undefined),
    e => e.code === 'RECOVERY_NOT_SAFE' && e.details.reason === 'legacy_or_missing_transfer',
  );
  const record = {id: 'urn:li:video:C1', owner: binding.owner_urn};
  assert.equal(media.assertWaiting(binding, session, {...record, status: 'WAITING_UPLOAD'}), undefined);
  assert.throws(
    () => media.assertWaiting(binding, session, {...record, status: 'AVAILABLE'}),
    e => e.code === 'RECOVERY_NOT_SAFE' && e.details.reason === 'provider_not_waiting',
  );
  assert.equal(media.partId('etag-1'), true);
  assert.equal(media.partId('etag"1'), false);
});
