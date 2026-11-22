import test from 'node:test';
import assert from 'node:assert/strict';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Package r25-field3-refs, item 8 (the owner's second Google report of 2026-11-21, the two v25 fields the reporter listed, F6-1): a campaign create that
 * named `start_date` or `url_expansion_opt_out` was refused locally, before any request, by the check of every Google request against the pinned v25
 * Discovery document (INVALID_VENDOR_BODY, "Field absent from the pinned vendor request schema"), and the refusal named no way forward. v25's Campaign has
 * `start_date_time` and `end_date_time` ("yyyy-MM-dd HH:mm:ss" in the customer's time zone) and no start or end date, and no `url_expansion_opt_out`: its
 * `asset_automation_settings` take the opt-out in their place (the pinned document, and Google's release notes for v22). The refusal stays, as does the
 * old call shape's failure; it now carries `replacement` on each such issue. Customer 123 and invented values only.
 */
const campaignAction = 'google_ads_v23_campaign_mutate_campaigns',
  build = 'google_ads_v23_google_ads_mutate';
let tenants = 0;
const google = () => googleReconcileFixture({tenant: 'google-field-replacements-' + ++tenants});
const campaign = extra => ({
  name: 'Synthetic campaign',
  status: 'PAUSED',
  advertising_channel_type: 'SEARCH',
  campaign_budget: at('campaignBudgets', '5'),
  manual_cpc: {},
  ...extra,
});
const errorsOf = refusal => refusal.error.details.errors;

test('F6-1: a campaign create with start_date or end_date is refused locally, and the issue names start_date_time or end_date_time', async () => {
  const f = google();
  try {
    for (const [field, replacement, value] of [
      ['start_date', 'start_date_time', '2026-12-01'],
      ['end_date', 'end_date_time', '2026-12-31'],
    ]) {
      const refused = await f.prepare(campaignAction, {operations: [{create: campaign({[field]: value})}]});
      assertRefused(refused, 'INVALID_VENDOR_BODY', {writes: f.writes.length});
      assert.equal(f.requests.length, 0, 'refused before any request');
      const issue = errorsOf(refused).find(
        e => e.field === '/operations/0/create/' + field.replace(/_(.)/g, (_, c) => c.toUpperCase()),
      );
      assert.ok(issue, JSON.stringify(errorsOf(refused)));
      assert.equal(issue.replacement, replacement, field);
      assert.equal(issue.format, 'yyyy-MM-dd HH:mm:ss', 'the format Google documents for the field it has');
      assert.match(
        issue.reason,
        /absent from the pinned vendor request schema/i,
        'the refusal itself says what it said',
      );
    }
  } finally {
    f.close();
  }
});

test('F6-1: url_expansion_opt_out is refused locally, and the issue names asset_automation_settings and the values that opt out', async () => {
  const f = google();
  try {
    const refused = await f.prepare(campaignAction, {operations: [{create: campaign({url_expansion_opt_out: true})}]});
    assertRefused(refused, 'INVALID_VENDOR_BODY', {writes: f.writes.length});
    assert.equal(f.requests.length, 0);
    const issue = errorsOf(refused).find(e => e.field === '/operations/0/create/urlExpansionOptOut');
    assert.ok(issue, JSON.stringify(errorsOf(refused)));
    assert.equal(issue.replacement, 'asset_automation_settings');
    assert.deepEqual(issue.replacement_values, {
      asset_automation_type: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION',
      asset_automation_status: 'OPTED_OUT',
    });
  } finally {
    f.close();
  }
});

test('F6-1: the same fields in an update of a campaign and inside a build name the same replacement, and each of several issues carries its own', async () => {
  const f = google();
  try {
    const update = await f.prepare(campaignAction, {
      operations: [{update: {resource_name: at('campaigns', '10'), end_date: '2026-12-31'}, update_mask: 'end_date'}],
    });
    assertRefused(update, 'INVALID_VENDOR_BODY', {writes: f.writes.length});
    assert.equal(errorsOf(update).find(e => e.field === '/operations/0/update/endDate')?.replacement, 'end_date_time');
    const built = await f.prepare(build, {
      mutate_operations: [
        {
          campaign_operation: {
            create: campaign({
              start_date: '2026-12-01',
              url_expansion_opt_out: true,
              resource_name: at('campaigns', '-2'),
            }),
          },
        },
      ],
    });
    assertRefused(built, 'INVALID_VENDOR_BODY', {writes: f.writes.length});
    const replacements = Object.fromEntries(
      errorsOf(built)
        .filter(e => e.replacement)
        .map(e => [e.field, e.replacement]),
    );
    assert.deepEqual(replacements, {
      '/mutateOperations/0/campaignOperation/create/startDate': 'start_date_time',
      '/mutateOperations/0/campaignOperation/create/urlExpansionOptOut': 'asset_automation_settings',
    });
    assert.equal(f.requests.length, 0);
  } finally {
    f.close();
  }
});

// N1 (the refusal stays, and only a field of a campaign has a replacement): the same name on another resource is refused as before, with no way forward
// that the table does not know, and the table is not consulted for a field v25 has.
test('N1: start_date on an ad group is still refused with no replacement, and a field v25 has is not refused', async () => {
  const f = google();
  try {
    const refused = await f.prepare('google_ads_v23_ad_group_mutate_ad_groups', {
      operations: [
        {
          create: {
            name: 'Synthetic group',
            campaign: at('campaigns', '10'),
            status: 'PAUSED',
            start_date: '2026-12-01',
          },
        },
      ],
    });
    assertRefused(refused, 'INVALID_VENDOR_BODY', {writes: f.writes.length});
    const issue = errorsOf(refused).find(e => e.field === '/operations/0/create/startDate');
    assert.ok(issue, JSON.stringify(errorsOf(refused)));
    assert.equal(issue.replacement, undefined);
    assert.equal(issue.replacement_values, undefined);
    // The field v25 has is not an issue: a campaign with start_date_time is not refused by the contract check.
    const fine = await f.prepare(campaignAction, {
      operations: [{create: campaign({start_date_time: '2026-12-01 00:00:00'})}],
    });
    assert.notEqual(fine.error?.code, 'INVALID_VENDOR_BODY', JSON.stringify(fine).slice(0, 400));
  } finally {
    f.close();
  }
});

test('the table of replacements is the one place that names a field v25 no longer has', async () => {
  const {googleAdsFieldReplacement} = await import('../dist/src/google-version.js');
  assert.deepEqual(googleAdsFieldReplacement('/v25/customers/123/campaigns:mutate', '/operations/0/create/startDate'), {
    replacement: 'start_date_time',
    format: 'yyyy-MM-dd HH:mm:ss',
  });
  assert.equal(
    googleAdsFieldReplacement('/v25/customers/123/adGroups:mutate', '/operations/0/create/startDate'),
    undefined,
  );
  assert.equal(
    googleAdsFieldReplacement('/v25/customers/123/campaigns:mutate', '/operations/0/create/name'),
    undefined,
  );
  assert.equal(googleAdsFieldReplacement('/v25/customers/123/campaigns:mutate', '/operations/0/remove'), undefined);
  assert.equal(
    googleAdsFieldReplacement(
      '/v25/customers/123/googleAds:mutate',
      '/mutateOperations/3/adGroupOperation/create/startDate',
    ),
    undefined,
  );
});
