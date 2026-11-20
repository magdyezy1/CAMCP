// Package r25-m3-live, F3 (the lead's live validate-only of 2026-11-20 on a Google test account): Google refused a campaign LANGUAGE criterion on a
// SHOPPING campaign in a build, applying nothing (contextError OPERATION_NOT_PERMITTED_FOR_CONTEXT, trigger SHOPPING, at
// mutate_operations[3].campaign_criterion_operation.create.language). AMCP refuses it at prepare: in a build from the channel of the campaign the
// build creates (before any request) or of an existing one it reads, and on the one-service campaignCriteria route from the campaign it reads.
// A synthetic Google answers; nothing reaches Google. Every ID and name is synthetic (customer 123).
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import * as shop from './fixtures/google-shopping-build.mjs';

const production = {providerCheckByDefault: true};
const languageOp = campaign => ({
  campaign_criterion_operation: {create: {campaign, language: {language_constant: 'languageConstants/1000'}}},
});
/** J11 with a language criterion on the campaign it creates, right after the campaign, and the index it stands at. */
function shoppingBuildWithLanguage() {
  const ops = shop.shoppingBuild(),
    at = ops.findIndex(o => o.campaign_operation) + 1;
  return {at, ops: [...ops.slice(0, at), languageOp(shop.at('campaigns', '-2')), ...ops.slice(at)]};
}
const existing = shop.at('campaigns', '40');
const shoppingCampaign = (extra = {}) => ({
  status: 'PAUSED',
  advertisingChannelType: 'SHOPPING',
  shoppingSetting: {merchantId: '555'},
  ...extra,
});
const message = /^(mutate_operations\[\d+\]: )?Google refuses a language criterion on a Shopping campaign/;
/** Nothing was written and nothing was sent to validate. */
const nothingSent = (x, label) => {
  assert.equal(x.mutates.length, 0, label + ': no write');
  assert.equal(x.validations.length, 0, label + ': no validate-only request');
};

test('a language criterion on a Shopping campaign the build creates is refused at prepare, before any request, naming the operation and the field of the build', async t => {
  const x = shop.shoppingCustomer({policy: production});
  t.after(() => x.store.close());
  const {at, ops} = shoppingBuildWithLanguage();
  const r = await x.prepare(ops);
  assertRefused(r, 'INVALID_TARGETING_MUTATION', {writes: x.mutates.length, message});
  assert.match(r.error.message, new RegExp('^mutate_operations\\[' + at + '\\]: '));
  assert.deepEqual(
    [r.error.details.operation, r.error.details.field, r.error.details.channel],
    [at, 'mutate_operations[' + at + '].campaign_criterion_operation.create.language', 'SHOPPING'],
  );
  nothingSent(x, 'in-build campaign');
  assert.equal(x.queries.length, 0, 'the campaign is the build’s own, so its channel is known without a read');
  // The same build without the language criterion (J11) prepares, and so does one with a location: only the language is refused.
  const ok = await x.prepare(shop.shoppingBuild());
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 600));
  assert.ok(shop.shoppingBuild().some(o => o.campaign_criterion_operation?.create.location));
});

test('a language criterion on a Search campaign still prepares, in a build as before', async t => {
  // The Search build of the suite of whole builds has a campaign criterion for its language and prepares today (tests/google-atomic-builds.test.ts);
  // here it is the same shape on the synthetic Shopping customer's read of an existing SEARCH campaign.
  const x = shop.shoppingCustomer({
    policy: production,
    campaigns: {[existing]: shoppingCampaign({advertisingChannelType: 'SEARCH', shoppingSetting: undefined})},
  });
  t.after(() => x.store.close());
  const r = await x.prepare([languageOp(existing)]);
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 800));
  assert.equal(r.data.provider_check.status, 'provider_validated');
});

test('a language criterion on an existing campaign read as SHOPPING is refused at prepare in a build, with its field; one whose channel is not read is left to the validate-only', async t => {
  const x = shop.shoppingCustomer({policy: production, campaigns: {[existing]: shoppingCampaign()}});
  t.after(() => x.store.close());
  const r = await x.prepare([languageOp(existing)]);
  assertRefused(r, 'INVALID_TARGETING_MUTATION', {
    writes: x.mutates.length,
    message: /^mutate_operations\[0\]: Google refuses/,
  });
  assert.deepEqual(
    [r.error.details.operation, r.error.details.field, r.error.details.channel],
    [0, 'mutate_operations[0].campaign_criterion_operation.create.language', 'SHOPPING'],
  );
  nothingSent(x, 'existing SHOPPING campaign');
  assert.ok(x.queries.length > 0, 'the campaign was read: its channel is what refused');
  // A campaign row that does not carry its channel decides nothing here (UNVERIFIED): the default validate-only does.
  const unread = shop.shoppingCustomer({
    policy: production,
    campaigns: {[existing]: shoppingCampaign({advertisingChannelType: undefined})},
  });
  t.after(() => unread.store.close());
  const ok = await unread.prepare([languageOp(existing)]);
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 800));
  assert.equal(unread.validations.length, 1, 'Google is asked to validate it');
});

/** The one-service review of campaign criteria, as a caller writes it (camelCase). */
const prepareCriteria = (x, operations) =>
  x.call('amcp_write', {
    action: 'prepare',
    gateway: shop.google,
    arguments: {
      action: 'google_ads_v23_campaign_criterion_mutate_campaign_criteria',
      account_id: shop.account,
      payload: {operations},
    },
  });
const createLanguage = campaign => ({create: {campaign, language: {languageConstant: 'languageConstants/1000'}}});

test('on the one-service campaignCriteria route a language criterion on a campaign read as SHOPPING is refused at prepare, with its field; a Search campaign’s, and a Shopping campaign’s location, prepare', async t => {
  const x = shop.shoppingCustomer({policy: production, campaigns: {[existing]: shoppingCampaign()}});
  t.after(() => x.store.close());
  const r = await prepareCriteria(x, [createLanguage(existing)]);
  assertRefused(r, 'INVALID_TARGETING_MUTATION', {writes: x.mutates.length, message});
  assert.deepEqual(
    [r.error.details.operation, r.error.details.field, r.error.details.channel],
    [0, 'operations[0].create.language', 'SHOPPING'],
  );
  nothingSent(x, 'route B');
  // The refusal names the operation that is at fault when the request has several.
  const second = await prepareCriteria(x, [
    {create: {campaign: existing, location: {geoTargetConstant: 'geoTargetConstants/2682'}}},
    createLanguage(existing),
  ]);
  assertRefused(second, 'INVALID_TARGETING_MUTATION', {writes: x.mutates.length, message});
  assert.deepEqual([second.error.details.operation, second.error.details.field], [1, 'operations[1].create.language']);
  // Only the language is refused: a location on the same Shopping campaign prepares.
  const location = await prepareCriteria(x, [
    {create: {campaign: existing, location: {geoTargetConstant: 'geoTargetConstants/2682'}}},
  ]);
  assert.equal(location.success, true, JSON.stringify(location).slice(0, 800));
  // A Search campaign takes a language criterion, as it always did.
  const search = shop.shoppingCustomer({
    policy: production,
    campaigns: {[existing]: shoppingCampaign({advertisingChannelType: 'SEARCH', shoppingSetting: undefined})},
  });
  t.after(() => search.store.close());
  const ok = await prepareCriteria(search, [createLanguage(existing)]);
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 800));
  assert.equal(search.validations.length, 1);
});
