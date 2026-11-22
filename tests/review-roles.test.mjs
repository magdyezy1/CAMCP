// always-run: lists src/ for the roles of every review
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {normalizeSnapshot, reviewStateHash, changedStateFields, reviewVolatile} from '../dist/src/review-state.js';
import {snapshotPlans} from '../dist/src/write-snapshots.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {lifecycle} from './helpers/review-lifecycle.mjs';
import {standardCreates} from './helpers/tiktok-standard-creates.mjs';
import {advertiserWorld} from './helpers/tiktok-advertiser-noise.mjs';
import {familyFixture} from './helpers/family-conformance.mjs';
import xCreatives from './family-descriptors/x-creatives.mjs';
import microsoftSearch from './family-descriptors/microsoft-search.mjs';
import redditClassic from './family-descriptors/reddit-classic.mjs';
import redditFunding from './family-descriptors/variants/reddit-classic-funding-instrument.mjs';
import smartPlusAds from './family-descriptors/tiktok-smart-plus-ads.mjs';
import smartPlusAdgroups from './family-descriptors/tiktok-smart-plus-adgroups.mjs';

/**
 * R2.5 M1 (package r25-m1-hash, plan idea 1, the three read roles; L5-01, L4-13, M0's "Found, not fixed" 3 and 4).
 *
 * Only the ACCOUNT container is kept to its identity: the account a create is made in shows who it is, its status, its
 * currency and time zone, and nothing else of it is something a write depends on, so a field that changes without the user
 * (a balance, a signed link, a counter, a last-modified time) never refuses a write (TikTok's advertiser row was the first,
 * T1; X, LinkedIn and DV360 had the same hash of a whole account row). A PARENT read (the campaign or ad group a child is
 * created under, the X line item and campaign a promotion goes under) is a TARGET read: the whole row, minus the fields the
 * provider says change by themselves. A parent's budget, bid, flight, schedule, targeting and status are what the child
 * spends by, so each of them that changes still refuses (for an X promotion, which goes live at once, that is a spend
 * change; lead review S2-1). These tests pin the account field lists by hand (not from the code), prove the account
 * projections idempotent and monotone, and drive the real lifecycle: rotation passes, a real change refuses with nothing
 * sent, and the gates that read a parent row still read it. Every value is synthetic.
 */
const registry = new Registry();
/**
 * Merge r25-m1-merge (r25-m1-diff's `material` over this package's roles, through the real services): what a review refused
 * is also what its refusal reports as material. A changed field of a parent, a target or a reference is always material, and
 * so is an identity field of an account (only known noise of an account is left out, and none of these is noise).
 */
const assertMaterial = (done, message) =>
  assert.deepEqual(done.error.details.material, done.error.details.changed_fields, message + ' is material');
const read = (gateway, path, fields = {}) => ({
  gateway,
  action: 'AMCP_STATE_READ',
  method: 'GET',
  path,
  query: {},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '123',
  evidence: 'TEST',
  warnings: [],
  ...fields,
});
// What changes at every read of an account or a parent, none of it identity: a signed link, a balance, a creation
// time, a contact and a counter (the White Friday signature, T1), under names no table lists.
const rotating = n => ({
  license_url: 'https://docs.example.test/licence?ticket=ticket-' + n + '&x-expires=' + (1700000000 + n),
  balance: 1000 - n * 3.25,
  create_time: 1700000000 + n,
  contact_email: 'synthetic' + n + '@example.test',
  notes_count: n,
  logo_url: 'https://cdn.example.test/l.png?x-signature=s' + n + '&v=2',
});

// --- The field lists, written out by hand -------------------------------------------------------------------------------

const scenarios = [
  {
    name: 'X account',
    gateway: 'x_ads_native_action',
    path: '/12/accounts/acct1',
    role: 'account',
    wrap: row => ({data: row, request: {params: {account_id: 'acct1'}}}),
    state: row => ({data: row}),
    identity: {
      id: 'acct1',
      name: 'Synthetic account',
      approval_status: 'ACCEPTED',
      deleted: false,
      timezone: 'Asia/Riyadh',
      business_id: 'b1',
      business_name: 'Synthetic business',
      currency: 'USD',
    },
    where: field => '$["data"]["' + field + '"]',
  },
  {
    name: 'LinkedIn account',
    gateway: 'linkedin_native_action',
    path: '/rest/adAccounts/123',
    role: 'account',
    wrap: row => row,
    state: row => row,
    identity: {
      id: 123,
      name: 'Synthetic account',
      status: 'ACTIVE',
      currency: 'USD',
      type: 'BUSINESS',
      reference: 'urn:li:organization:9',
      test: false,
    },
    where: field => '$["' + field + '"]',
  },
  {
    name: 'DV360 advertiser',
    gateway: 'dv360_native_action',
    path: '/v4/advertisers/123',
    role: 'account',
    wrap: row => row,
    state: row => row,
    identity: {
      advertiserId: '123',
      partnerId: '9',
      name: 'advertisers/123',
      displayName: 'Synthetic account',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
      generalConfig: {currencyCode: 'USD', timeZone: 'Asia/Riyadh'},
    },
    where: field => '$["' + field.replace('.', '"]["') + '"]',
    // Non-identity fields of the same record: the domain of the advertiser is its configuration, not who it is.
    nested: {generalConfig: {domainUrl: 'https://shop.example.test'}},
  },
  {
    // The `AdvertiserAccount` of the Customer Management API (.mirror/VENDOR/microsoft-customer-management-v13.json): no
    // balance, but a row version, the user who last modified it and its financial status change without any edit (S3-3).
    name: 'Microsoft account',
    gateway: 'microsoft_ads_native_action',
    path: '/CustomerManagement/v13/Account/Query',
    action: 'GetAccount',
    role: 'account',
    wrap: row => ({Account: row, TrackingId: 'synthetic-tracking'}),
    state: row => ({Account: row}),
    identity: {
      Id: '123',
      Number: 'X0000123',
      Name: 'Synthetic account',
      ParentCustomerId: '456',
      CurrencyCode: 'USD',
      TimeZone: 'ArabianStandardTime',
      AccountLifeCycleStatus: 'Active',
      PauseReason: 0,
    },
    rotating: n => ({
      TimeStamp: 'AAAAAAAA' + n,
      LastModifiedByUserId: 5000 + n,
      LastModifiedTime: '2026-11-16T10:0' + n + ':00Z',
      AccountFinancialStatus: n % 2 ? 'ClearFinancialStatus' : 'PendingFinancialStatus',
    }),
    where: field => '$["Account"]["' + field + '"]',
  },
  {
    // The `AdAccount` of the Reddit Ads API (.mirror/VENDOR/reddit-v3.json): no balance either; `modified_at` changes by itself,
    // and `admin_approval` and `suspension_reason` change at Reddit's decision (status, so they stay).
    name: 'Reddit ad account',
    gateway: 'reddit_native_action',
    path: '/api/v3/ad_accounts/a2_111',
    role: 'account',
    wrap: row => ({data: row, request_id: 'synthetic-request'}),
    state: row => ({data: row}),
    identity: {
      id: 'a2_111',
      name: 'Synthetic account',
      currency: 'USD',
      time_zone_id: 'Asia/Riyadh',
      business_id: 'b_1',
      type: 'STANDARD',
      admin_approval: 'APPROVED',
      suspension_reason: null,
    },
    rotating: n => ({modified_at: '2026-11-16T10:0' + n + ':00Z'}),
    where: field => '$["data"]["' + field + '"]',
  },
  {
    // The `FundingInstrument` of the Reddit Ads API (.mirror/VENDOR/reddit-v3.json): its meter, `billable_amount`, is the
    // outstanding debt and grows with every day the account spends, and `is_servable` and `reasons_not_servable` are what Reddit
    // computes from it. A campaign that names the instrument depends on which one it is, its currency, its credit limit and the
    // flight it allows: a REFERENCE, kept to those fields (S3-4).
    name: 'Reddit funding instrument (reference)',
    gateway: 'reddit_native_action',
    path: '/api/v3/ad_accounts/a2_111/funding_instruments',
    role: 'reference',
    wrap: row => ({data: [row], request_id: 'synthetic-request'}),
    state: row => ({data: [row]}),
    identity: {
      id: 'fi_1',
      currency: 'USD',
      credit_limit: 5000000000,
      start_time: '2026-11-01T00:00:00Z',
      end_time: null,
    },
    // What the instrument also carries, none of it what a campaign depends on.
    nested: {
      name: 'Synthetic card',
      ad_account_id: 'a2_111',
      authorize_status: 'AUTHORIZED',
      invoice_group_status: null,
    },
    rotating: n => ({
      billable_amount: 120000 + n * 1000,
      is_servable: n % 2 === 0,
      reasons_not_servable: n % 2 ? ['CREDIT_LIMIT_REACHED'] : [],
    }),
    where: field => '$["data"][0]["' + field + '"]',
  },
];
const isRecord = v => !!v && typeof v === 'object' && !Array.isArray(v);
/** The identity of a row with the non-identity fields of the same record beside it (a nested record merges). */
const merged = (identity, nested = {}) =>
  Object.fromEntries(
    [...new Set([...Object.keys(identity), ...Object.keys(nested)])].map(k => [
      k,
      isRecord(identity[k]) && isRecord(nested[k]) ? {...identity[k], ...nested[k]} : (nested[k] ?? identity[k]),
    ]),
  );
const identityPaths = identity =>
  Object.entries(identity).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).map(n => k + '.' + n) : [k],
  );
const valueAt = (row, path) => path.split('.').reduce((v, k) => v[k], row);
const withValue = (row, path, value) => {
  const copy = structuredClone(row),
    parts = path.split('.');
  let at = copy;
  for (const part of parts.slice(0, -1)) at = at[part];
  at[parts.at(-1)] = value;
  return copy;
};
// A list that gains an item sorting last (membership lists such as `placements` are compared as sets, in sorted order).
const other = value =>
  typeof value === 'boolean' ? !value : Array.isArray(value) ? [...value, 'ZZ_CHANGED'] : String(value) + '-changed';

for (const s of scenarios) {
  // A scenario may name the action of the read (Microsoft's snapshot reads its result field by it) and what its provider
  // changes by itself under its own names, beside the noise every account has.
  const asRead = read(s.gateway, s.path, {stateRole: s.role, ...(s.action ? {action: s.action} : {})}),
    asTarget = read(s.gateway, s.path, s.action ? {action: s.action} : {}),
    row = (n = 1) => ({...merged(structuredClone(s.identity), s.nested), ...rotating(n), ...s.rotating?.(n)});

  test(s.name + ': a review keeps its identity and nothing that changes without the user', () => {
    const kept = normalizeSnapshot(asRead, s.wrap(row(1)));
    assert.deepEqual(kept, s.state(s.identity));
    // The same row rotating, with the whole answer wrapped as the provider sends it: the same state.
    assert.deepEqual(normalizeSnapshot(asRead, s.wrap(row(2))), kept);
    const volatile = reviewVolatile(s.gateway);
    assert.equal(reviewStateHash(kept, volatile), reviewStateHash(normalizeSnapshot(asRead, s.wrap(row(7))), volatile));
  });

  test(s.name + ': a read of the objects a write changes is not an identity read', () => {
    // Without the role the same row is a target: its unknown fields stay protected.
    const a = normalizeSnapshot(asTarget, s.wrap(row(1))),
      b = normalizeSnapshot(asTarget, s.wrap(row(2))),
      volatile = reviewVolatile(s.gateway);
    assert.notEqual(reviewStateHash(a, volatile), reviewStateHash(b, volatile));
    assert.match(JSON.stringify(a), /contact_email|notes_count/);
  });

  test(s.name + ': a real change of each identity field changes the state and names that field', () => {
    const volatile = reviewVolatile(s.gateway),
      before = normalizeSnapshot(asRead, s.wrap(row(1)));
    for (const path of identityPaths(s.identity)) {
      const was = valueAt(s.identity, path),
        changed = normalizeSnapshot(asRead, s.wrap(withValue(row(2), path, other(was))));
      assert.notEqual(reviewStateHash(before, volatile), reviewStateHash(changed, volatile), path);
      // A list that gains an item differs at that item.
      const expected = Array.isArray(was) ? s.where(path) + '[' + was.length + ']' : s.where(path);
      assert.deepEqual(changedStateFields(before, changed, volatile), [expected], path);
    }
  });

  test(s.name + ': the projection is idempotent and monotone, and only identity decides (property, 300 rows)', () => {
    let seed = 20261116 + s.name.length;
    const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0), seed / 4294967296),
      volatile = reviewVolatile(s.gateway),
      subset = (out, input) =>
        Array.isArray(input)
          ? Array.isArray(out) && out.length === input.length && out.every((v, i) => subset(v, input[i]))
          : input && typeof input === 'object'
            ? !!out &&
              typeof out === 'object' &&
              Object.keys(out).every(k => Object.hasOwn(input, k) && subset(out[k], input[k]))
            : out === input;
    const quiet = normalizeSnapshot(asRead, s.wrap(merged(structuredClone(s.identity), s.nested)));
    for (let i = 0; i < 300; i++) {
      const noisy = {
        ...merged(structuredClone(s.identity), s.nested),
        ...Object.fromEntries(
          Array.from({length: 1 + Math.floor(r() * 5)}, (_, k) => [
            'noise_' + k + '_' + Math.floor(r() * 9),
            r() < 0.5 ? Math.floor(r() * 1e6) : {n: r(), s: 'https://x.example/a?sig=' + Math.floor(r() * 1e6)},
          ]),
        ),
      };
      const answer = s.wrap(noisy),
        once = normalizeSnapshot(asRead, answer);
      // Re-projecting the state it kept (as a saved review is, at execute) changes nothing.
      assert.deepEqual(normalizeSnapshot(asRead, once), once, 'idempotent');
      assert.ok(subset(once, s.wrap(noisy)) || subset(once, s.state(noisy)), 'monotone');
      // Only identity decides: the noise alone never changes the hash.
      assert.equal(reviewStateHash(once, volatile), reviewStateHash(quiet, volatile));
    }
  });
}

// --- A PARENT read is a target read: everything but what the provider changes by itself (S2-1) -------------------------------

// What a parent says it is and what a child under it spends by: budget, bid, flight, schedule, targeting. None of it changes
// by itself; `telemetry(n)` is what the provider's table lists, which does (a delivery state, a modification time).
const parentScenarios = [
  {
    name: 'X line item (parent)',
    gateway: 'x_ads_native_action',
    path: '/12/accounts/acct1/line_items/line1',
    wrap: row => ({data: row, request: {params: {}}}),
    state: row => ({data: row}),
    settings: {
      id: 'line1',
      name: 'Synthetic line item',
      account_id: 'acct1',
      campaign_id: 'campaign1',
      entity_status: 'PAUSED',
      deleted: false,
      objective: 'WEBSITE_CLICKS',
      product_type: 'PROMOTED_TWEETS',
      total_budget_amount_local_micro: '50000000',
      bid_amount_local_micro: '1000000',
      bid_type: 'MAX',
      start_time: '2026-12-01T00:00:00Z',
      end_time: '2026-12-31T00:00:00Z',
      placements: ['ALL_ON_TWITTER'],
    },
    telemetry: n => ({
      servable: n % 2 === 0,
      reasons_not_servable: n % 2 ? ['PAUSED_BY_ADVERTISER'] : [],
      effective_status: n % 2 ? 'PAUSED' : 'ACTIVE',
      updated_at: '2026-11-16T10:0' + (n % 10) + ':00Z',
    }),
    where: field => '$["data"]["' + field + '"]',
  },
  {
    name: 'X campaign (parent)',
    gateway: 'x_ads_native_action',
    path: '/12/accounts/acct1/campaigns/campaign1',
    wrap: row => ({data: row, request: {params: {}}}),
    state: row => ({data: row}),
    settings: {
      id: 'campaign1',
      name: 'Synthetic campaign',
      account_id: 'acct1',
      entity_status: 'ACTIVE',
      deleted: false,
      funding_instrument_id: 'fi1',
      daily_budget_amount_local_micro: '5000000',
      total_budget_amount_local_micro: '50000000',
      start_time: '2026-12-01T00:00:00Z',
      end_time: '2026-12-31T00:00:00Z',
      standard_delivery: true,
    },
    telemetry: n => ({
      servable: n % 2 === 0,
      reasons_not_servable: n % 2 ? ['PAUSED_BY_ADVERTISER'] : [],
      effective_status: n % 2 ? 'PAUSED' : 'RUNNING',
      updated_at: '2026-11-16T10:0' + (n % 10) + ':00Z',
    }),
    where: field => '$["data"]["' + field + '"]',
  },
  {
    name: 'TikTok campaign (parent)',
    gateway: 'tiktok_native_action',
    path: '/v1.3/campaign/get/',
    wrap: row => ({code: 0, message: 'OK', request_id: 'r', data: {list: [row], page_info: {page: 1, total_page: 1}}}),
    state: row => ({data: {list: [row]}}),
    settings: {
      campaign_id: '300',
      campaign_name: 'Synthetic campaign',
      advertiser_id: '9000000000000000001',
      operation_status: 'DISABLE',
      objective_type: 'TRAFFIC',
      campaign_type: 'REGULAR_CAMPAIGN',
      // The budget, and the switch that decides what an ad group's own budget means (campaign budget optimisation).
      budget: 100,
      budget_mode: 'BUDGET_MODE_DAY',
      budget_optimize_on: true,
      roas_bid: 2.5,
    },
    telemetry: n => ({
      secondary_status: n % 2 ? 'CAMPAIGN_STATUS_DELIVERY_OK' : 'CAMPAIGN_STATUS_BUDGET_EXCEED',
      modify_time: '2026-11-1' + (n % 9) + ' 10:00:00',
    }),
    where: field => '$["data"]["list"][0]["' + field + '"]',
  },
  {
    name: 'TikTok ad group (parent)',
    gateway: 'tiktok_native_action',
    path: '/v1.3/adgroup/get/',
    wrap: row => ({code: 0, message: 'OK', request_id: 'r', data: {list: [row], page_info: {page: 1, total_page: 1}}}),
    state: row => ({data: {list: [row]}}),
    settings: {
      adgroup_id: '200',
      adgroup_name: 'Synthetic ad group',
      campaign_id: '300',
      advertiser_id: '9000000000000000001',
      operation_status: 'DISABLE',
      // The gate of an ad create reads these (src/tiktok-manual-ad-identities.ts).
      placement_type: 'PLACEMENT_TYPE_NORMAL',
      placements: ['PLACEMENT_PANGLE'],
      budget_mode: 'BUDGET_MODE_DAY',
      budget: 50,
      bid_type: 'BID_TYPE_CUSTOM',
      bid_price: 0.2,
      schedule_type: 'SCHEDULE_START_END',
      schedule_start_time: '2026-12-01 00:00:00',
      schedule_end_time: '2026-12-31 00:00:00',
      location_ids: ['6252001'],
      age_groups: ['AGE_25_34'],
      pixel_id: '7000',
    },
    telemetry: n => ({
      secondary_status: n % 2 ? 'ADGROUP_STATUS_DELIVERY_OK' : 'ADGROUP_STATUS_BUDGET_EXCEED',
      modify_time: '2026-11-1' + (n % 9) + ' 10:00:00',
    }),
    where: field => '$["data"]["list"][0]["' + field + '"]',
  },
];
const telemetryNames = p => Object.keys(p.telemetry(1));

for (const p of parentScenarios) {
  const asParent = read(p.gateway, p.path, {stateRole: 'parent'}),
    asTarget = read(p.gateway, p.path),
    volatile = reviewVolatile(p.gateway),
    row = (n = 1) => ({...structuredClone(p.settings), ...p.telemetry(n)});

  test(p.name + ': is kept as a target is, whole but for what the provider changes by itself', () => {
    const kept = normalizeSnapshot(asParent, p.wrap(row(1)));
    // Every setting of the parent is in the state (the budget, the bid, the flight, the targeting), and the telemetry is not.
    assert.deepEqual(kept, p.state(p.settings));
    assert.deepEqual(kept, normalizeSnapshot(asTarget, p.wrap(row(1))));
    for (const name of telemetryNames(p)) assert.equal(JSON.stringify(kept).includes('"' + name + '"'), false, name);
  });

  test(p.name + ': what changes by itself rotates without changing the hash', () => {
    const hash = n => reviewStateHash(normalizeSnapshot(asParent, p.wrap(row(n))), volatile);
    for (const n of [2, 3, 7]) assert.equal(hash(n), hash(1), 'read ' + n);
  });

  test(p.name + ': a real change of any setting changes the state and names that field', () => {
    const before = normalizeSnapshot(asParent, p.wrap(row(1)));
    for (const path of Object.keys(p.settings)) {
      const changed = normalizeSnapshot(asParent, p.wrap(withValue(row(2), path, other(p.settings[path]))));
      assert.notEqual(reviewStateHash(before, volatile), reviewStateHash(changed, volatile), path);
      // A list that gains an item differs at that item.
      const was = p.settings[path],
        expected = Array.isArray(was) ? p.where(path) + '[' + was.length + ']' : p.where(path);
      assert.deepEqual(changedStateFields(before, changed, volatile), [expected], path);
    }
  });

  test(p.name + ': a field the provider does not list is protected, wherever it appears', () => {
    const before = normalizeSnapshot(asParent, p.wrap(row(1))),
      extra = normalizeSnapshot(asParent, p.wrap({...row(1), synthetic_unlisted_setting: 'x'}));
    assert.notEqual(reviewStateHash(before, volatile), reviewStateHash(extra, volatile));
  });
}

// --- The gates that read a parent row still read it ---------------------------------------------------------------------

const tiktok = (parentExtra, tenant) => standardCreates(advertiserWorld({rotating: true}), {parentExtra, tenant});
// A parent row as TikTok returns it: its settings stay put and its telemetry moves at every read. `change` edits a setting.
const campaignRow = (n, change = {}) => ({
  campaign_name: 'Synthetic campaign',
  objective_type: 'TRAFFIC',
  campaign_type: 'REGULAR_CAMPAIGN',
  budget: 100,
  budget_mode: 'BUDGET_MODE_DAY',
  budget_optimize_on: false,
  roas_bid: 2.5,
  create_time: '2026-11-01 10:00:00',
  modify_time: '2026-11-1' + (n % 8) + ' 10:00:00',
  secondary_status: n % 2 ? 'CAMPAIGN_STATUS_DELIVERY_OK' : 'CAMPAIGN_STATUS_BUDGET_EXCEED',
  ...change,
});
const adgroupRow = (n, change = {}) => ({
  adgroup_name: 'Synthetic ad group',
  placement_type: 'PLACEMENT_TYPE_NORMAL',
  placements: ['PLACEMENT_PANGLE'],
  budget_mode: 'BUDGET_MODE_DAY',
  budget: 50,
  bid_type: 'BID_TYPE_CUSTOM',
  bid_price: 0.2,
  schedule_type: 'SCHEDULE_START_END',
  schedule_start_time: '2026-12-01 00:00:00',
  schedule_end_time: '2026-12-31 00:00:00',
  location_ids: ['6252001'],
  age_groups: ['AGE_25_34'],
  modify_time: '2026-11-1' + (n % 8) + ' 10:00:00',
  secondary_status: n % 2 ? 'ADGROUP_STATUS_DELIVERY_OK' : 'ADGROUP_STATUS_BUDGET_EXCEED',
  ...change,
});

test('TikTok parents: an ad group is created under a campaign whose delivery state and modification time move, and sends what was reviewed', async () => {
  const f = tiktok((kind, n) => (kind === 'campaign' ? campaignRow(n) : {}), 'roles-adgroup-rotation');
  try {
    const p = await f.prepare('adgroup');
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    const done = await f.execute(p.data);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 700));
    assert.equal(f.sent.length, 1);
  } finally {
    f.close();
  }
});

test('TikTok parents: the parent campaign changing status between review and execute is STATE_CHANGED, nothing sent', async () => {
  const f = tiktok((kind, n) => (kind === 'campaign' ? campaignRow(n) : {}), 'roles-adgroup-status');
  try {
    const p = await f.prepare('adgroup');
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    f.parents.campaign = 'ENABLE';
    const done = await f.execute(p.data);
    assertRefused(done, 'STATE_CHANGED', {writes: () => f.sent.length});
    assert.deepEqual(done.error.details.changed_fields, ['$[1]["data"]["list"][0]["operation_status"]']);
    assertMaterial(done, 'the parent campaign status');
  } finally {
    f.close();
  }
});

test('TikTok parents: a budget, a bid or a budget optimisation switch of the parent campaign that changes is STATE_CHANGED, nothing sent', async () => {
  for (const [field, was, now] of [
    ['budget', 100, 5000],
    ['budget_mode', 'BUDGET_MODE_DAY', 'BUDGET_MODE_TOTAL'],
    ['budget_optimize_on', false, true],
    ['roas_bid', 2.5, 9],
  ]) {
    let setting = was;
    const f = tiktok(
      (kind, n) => (kind === 'campaign' ? campaignRow(n, {[field]: setting}) : {}),
      'roles-adgroup-' + field,
    );
    try {
      const p = await f.prepare('adgroup');
      assert.equal(p.success, true, field + ' ' + JSON.stringify(p).slice(0, 700));
      setting = now;
      const done = await f.execute(p.data);
      assertRefused(done, 'STATE_CHANGED', {writes: () => f.sent.length});
      assert.deepEqual(done.error.details.changed_fields, ['$[1]["data"]["list"][0]["' + field + '"]'], field);
      assertMaterial(done, field);
    } finally {
      f.close();
    }
  }
});

test('TikTok parents: an ad is created under an ad group whose delivery state and modification time move, and sends what was reviewed', async () => {
  const f = tiktok((kind, n) => (kind === 'adgroup' ? adgroupRow(n) : {}), 'roles-ad-rotation');
  try {
    const p = await f.prepare('ad');
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    const done = await f.execute(p.data);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 700));
    assert.equal(f.sent.length, 1);
  } finally {
    f.close();
  }
});

test('TikTok parents: a budget, a bid, a flight or a targeting of the parent ad group that changes is STATE_CHANGED, nothing sent', async () => {
  for (const [field, was, now, at = '["' + field + '"]'] of [
    ['budget', 50, 5000],
    ['bid_price', 0.2, 9],
    ['schedule_start_time', '2026-12-01 00:00:00', '2026-11-20 00:00:00'],
    ['schedule_end_time', '2026-12-31 00:00:00', '2027-06-30 00:00:00'],
    // A list that gains an item differs at that item.
    ['location_ids', ['6252001'], ['6252001', '99'], '["location_ids"][1]'],
    ['age_groups', ['AGE_25_34'], ['AGE_25_34', 'AGE_55_100'], '["age_groups"][1]'],
  ]) {
    let setting = was;
    const f = tiktok((kind, n) => (kind === 'adgroup' ? adgroupRow(n, {[field]: setting}) : {}), 'roles-ad-' + field);
    try {
      const p = await f.prepare('ad');
      assert.equal(p.success, true, field + ' ' + JSON.stringify(p).slice(0, 700));
      setting = now;
      const done = await f.execute(p.data);
      assertRefused(done, 'STATE_CHANGED', {writes: () => f.sent.length});
      assert.deepEqual(done.error.details.changed_fields, ['$[1]["data"]["list"][0]' + at], field);
      assertMaterial(done, field);
    } finally {
      f.close();
    }
  }
});

test('TikTok parents: a custom identity under an ad group that delivers on TikTok is still refused at review', async () => {
  // src/tiktok-manual-ad-identities.ts reads the PARENT ad group's placement_type, and skips its refusal when the field is
  // absent from the state: a parent is kept whole, so the gate still sees it (the check is the negative test).
  const f = tiktok(
    (kind, n) =>
      kind === 'adgroup' ? adgroupRow(n, {placement_type: 'PLACEMENT_TYPE_AUTOMATIC', placements: []}) : {},
    'roles-ad-gate',
  );
  try {
    assertRefused(await f.prepare('ad'), 'TIKTOK_CUSTOM_IDENTITY_PLACEMENT', {writes: () => f.sent.length});
  } finally {
    f.close();
  }
});

test('TikTok parents: an ad group that starts to deliver on TikTok after review is refused by that gate at execute', async () => {
  let placements = ['PLACEMENT_PANGLE'];
  const f = tiktok((kind, n) => (kind === 'adgroup' ? adgroupRow(n, {placements}) : {}), 'roles-ad-gate-execute');
  try {
    const p = await f.prepare('ad');
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    placements = ['PLACEMENT_PANGLE', 'PLACEMENT_TIKTOK'];
    assertRefused(await f.execute(p.data), 'TIKTOK_CUSTOM_IDENTITY_PLACEMENT', {writes: () => f.sent.length});
  } finally {
    f.close();
  }
});

test('TikTok parents: a change of the placements the ad group delivers on is a change, though no gate forbids it', async () => {
  // Neither list names TikTok, so the gate of the ad create has nothing to refuse; the list is compared as a set, in order.
  let placements = ['PLACEMENT_GLOBAL_APP_BUNDLE'];
  const f = tiktok((kind, n) => (kind === 'adgroup' ? adgroupRow(n, {placements}) : {}), 'roles-ad-placements');
  try {
    const p = await f.prepare('ad');
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 700));
    placements = ['PLACEMENT_GLOBAL_APP_BUNDLE', 'PLACEMENT_PANGLE'];
    const done = await f.execute(p.data);
    assertRefused(done, 'STATE_CHANGED', {writes: () => f.sent.length});
    assert.deepEqual(done.error.details.changed_fields, ['$[1]["data"]["list"][0]["placements"][1]']);
    assertMaterial(done, 'the placements of the parent ad group');
  } finally {
    f.close();
  }
});

// --- X, LinkedIn and DV360 creates: the account row ---------------------------------------------------------------------

const account = {
  x: {id: '123', name: 'Synthetic account', approval_status: 'ACCEPTED', timezone: 'Asia/Riyadh', deleted: false},
  linkedin: {id: 123, name: 'Synthetic account', status: 'ACTIVE', currency: 'USD', type: 'BUSINESS', test: false},
  dv360: {
    advertiserId: '123',
    partnerId: '9',
    name: 'advertisers/123',
    displayName: 'Synthetic account',
    entityStatus: 'ENTITY_STATUS_ACTIVE',
    generalConfig: {currencyCode: 'USD', timeZone: 'Asia/Riyadh', domainUrl: 'https://shop.example.test'},
  },
};
const creates = {
  x: (change = {}) => ({
    gateway: 'x_ads',
    args: {action: 'x_accounts_account_id_campaigns_post', payload: {name: 'Draft', entity_status: 'PAUSED'}},
    reply: {response: {data: {id: '111'}}},
    answer: (path, phase) =>
      path === '/12/accounts/123'
        ? {
            data: {...account.x, ...rotating(phase === 'prepare' ? 1 : 2), ...(phase === 'execute' ? change : {})},
            request: {params: {}},
          }
        : {data: {}},
    // The path of the field in the state the review kept: the account read is the one read.
    where: field => '$[0]["data"]["' + field + '"]',
  }),
  linkedin: (change = {}) => ({
    gateway: 'linkedin',
    args: {
      action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
      payload: {name: 'Draft', status: 'PAUSED', account: 'urn:li:sponsoredAccount:123'},
    },
    reply: {response: null, status: 201, headers: {'x-restli-id': '111'}},
    answer: (path, phase) => ({
      ...account.linkedin,
      ...rotating(phase === 'prepare' ? 1 : 2),
      servingStatuses: phase === 'prepare' ? ['RUNNABLE'] : ['STOPPED'],
      version: {versionTag: phase === 'prepare' ? '1' : '2'},
      ...(phase === 'execute' ? change : {}),
    }),
    where: field => '$[0]["' + field + '"]',
  }),
  dv360: (change = {}) => ({
    gateway: 'dv360',
    accountArgument: false,
    args: {
      action: 'DV360_ADVERTISERS_CAMPAIGNS_CREATE',
      params: {advertiserId: '123'},
      body: {displayName: 'Draft', entityStatus: 'ENTITY_STATUS_PAUSED'},
    },
    reply: {response: {campaignId: '111'}},
    answer: (path, phase) =>
      path === '/v4/advertisers/123'
        ? {
            ...account.dv360,
            ...rotating(phase === 'prepare' ? 1 : 2),
            updateTime: phase === 'prepare' ? '2026-11-16T10:00:00Z' : '2026-11-16T10:04:00Z',
            billingConfig: {billingProfileId: phase === 'prepare' ? '1' : '2'},
            ...(phase === 'execute' ? structuredClone(change) : {}),
          }
        : {},
    where: field => '$[0]["' + field.replace('.', '"]["') + '"]',
  }),
};
const changes = {
  x: [
    ['approval_status', {approval_status: 'UNDER_REVIEW'}],
    ['timezone', {timezone: 'Europe/London'}],
    ['deleted', {deleted: true}],
    ['name', {name: 'Renamed elsewhere'}],
  ],
  linkedin: [
    ['currency', {currency: 'EUR'}],
    ['status', {status: 'CANCELED'}],
    ['name', {name: 'Renamed elsewhere'}],
  ],
  dv360: [
    ['generalConfig.currencyCode', {generalConfig: {...account.dv360.generalConfig, currencyCode: 'EUR'}}],
    ['entityStatus', {entityStatus: 'ENTITY_STATUS_PAUSED'}],
    ['displayName', {displayName: 'Renamed elsewhere'}],
  ],
};
for (const provider of ['x', 'linkedin', 'dv360']) {
  test(
    provider + ' create: an account row whose link, balance, counters and times rotate is the same account',
    async () => {
      const {done, writes} = await lifecycle(creates[provider]());
      assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
      assert.equal(writes(), 1);
    },
  );
  test(provider + ' create: a real change of the account’s identity is STATE_CHANGED and nothing is sent', async () => {
    for (const [field, change] of changes[provider]) {
      const {done, writes, where} = await (async () => {
        const c = creates[provider](change),
          out = await lifecycle(c);
        return {...out, where: c.where};
      })();
      assertRefused(done, 'STATE_CHANGED', {writes});
      assert.deepEqual(done.error.details.changed_fields, [where(field)], provider + ' ' + field);
      assertMaterial(done, provider + ' ' + field);
    }
  });
}

// --- Microsoft and Reddit: the account row, through the real lifecycle of their families (S3-3) -------------------------------

/**
 * The descriptor's family prepared and executed with its provider's answer to the read `isRead` names rewritten by
 * `rewrite(json, phase)`: at review (`prepare`) and at execute, so a field may differ between the two.
 */
async function rewrittenFlow(descriptor, isRead, rewrite) {
  let phase = 'prepare';
  const f = familyFixture({
    ...descriptor,
    provider: async request => {
      const answer = await descriptor.provider(request);
      if (!answer || answer instanceof Response || !isRead(request)) return answer;
      return {...answer, json: rewrite(structuredClone(answer.json), phase)};
    },
  });
  try {
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
    phase = 'execute';
    const done = await f.execute(p.data);
    return {done, writes: () => f.sent.length};
  } finally {
    f.close();
  }
}
const microsoftAccount = (phase, change = {}) => ({
  Id: '123',
  Number: 'X0000123',
  Name: 'Synthetic account',
  ParentCustomerId: '456',
  CurrencyCode: 'USD',
  TimeZone: 'ArabianStandardTime',
  AccountLifeCycleStatus: 'Active',
  PauseReason: 0,
  TimeStamp: phase === 'prepare' ? 'AAAAAAAA1' : 'AAAAAAAA2',
  LastModifiedByUserId: phase === 'prepare' ? 5001 : 9001,
  LastModifiedTime: phase === 'prepare' ? '2026-11-16T10:00:00Z' : '2026-11-16T10:04:00Z',
  AccountFinancialStatus: phase === 'prepare' ? 'ClearFinancialStatus' : 'PendingFinancialStatus',
  ...(phase === 'execute' ? change : {}),
});
const microsoftFlow = change =>
  rewrittenFlow(
    microsoftSearch,
    ({path}) => path.endsWith('/Account/Query'),
    (json, phase) => ({...json, Account: microsoftAccount(phase, change)}),
  );
const redditAccount = (phase, change = {}) => ({
  id: 'a2_111',
  name: 'Account',
  currency: 'USD',
  time_zone_id: 'Asia/Riyadh',
  business_id: 'b_1',
  type: 'STANDARD',
  admin_approval: 'APPROVED',
  suspension_reason: null,
  modified_at: phase === 'prepare' ? '2026-11-16T10:00:00Z' : '2026-11-16T10:04:00Z',
  ...(phase === 'execute' ? change : {}),
});
const redditFlow = change =>
  rewrittenFlow(
    redditClassic,
    ({method, path}) => method === 'GET' && path === '/api/v3/ad_accounts/a2_111',
    (json, phase) => ({...json, data: redditAccount(phase, change)}),
  );

test('microsoft write: an account row whose row version, last modifier and financial status change is the same account', async () => {
  const {done, writes} = await microsoftFlow({});
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
  assert.equal(writes(), 1);
});
test('microsoft write: a real change of the account’s identity is STATE_CHANGED naming that field, and nothing is sent', async () => {
  for (const [field, change] of [
    ['Number', {Number: 'X0000124'}],
    ['Name', {Name: 'Renamed elsewhere'}],
    ['ParentCustomerId', {ParentCustomerId: '457'}],
    ['CurrencyCode', {CurrencyCode: 'EUR'}],
    ['TimeZone', {TimeZone: 'GMTStandardTime'}],
    ['AccountLifeCycleStatus', {AccountLifeCycleStatus: 'Pause'}],
    ['PauseReason', {PauseReason: 2}],
  ]) {
    const {done, writes} = await microsoftFlow(change);
    assertRefused(done, 'STATE_CHANGED', {writes});
    assert.deepEqual(done.error.details.changed_fields, ['$[0]["Account"]["' + field + '"]'], field);
    assertMaterial(done, field);
  }
  // A different account ID is refused by the contract's own check of the answer, before any comparison.
  const {done, writes} = await microsoftFlow({Id: '124'});
  assertRefused(done, 'STATE_TARGET_MISMATCH', {writes});
});
test('reddit write: an ad account row whose modification time changes is the same account', async () => {
  const {done, writes} = await redditFlow({});
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
  assert.equal(writes(), 1);
});
test('reddit write: a real change of the ad account’s identity or state is STATE_CHANGED naming that field, and nothing is sent', async () => {
  for (const [field, change] of [
    ['name', {name: 'Renamed elsewhere'}],
    ['currency', {currency: 'EUR'}],
    ['time_zone_id', {time_zone_id: 'Europe/London'}],
    ['business_id', {business_id: 'b_2'}],
    ['type', {type: 'AGENCY'}],
    ['admin_approval', {admin_approval: 'SUSPENDED'}],
    ['suspension_reason', {suspension_reason: 'POLICY'}],
  ]) {
    const {done, writes} = await redditFlow(change);
    assertRefused(done, 'STATE_CHANGED', {writes});
    assert.deepEqual(done.error.details.changed_fields, ['$[0]["data"]["' + field + '"]'], field);
    assertMaterial(done, field);
  }
});

const instrument = (phase, change = {}) => ({
  id: 'fi_1',
  ad_account_id: 'a2_111',
  name: 'Synthetic card',
  currency: 'USD',
  credit_limit: 5000000000,
  // The meter grows and Reddit recomputes the servable state: both move between review and execute.
  billable_amount: phase === 'prepare' ? 120000 : 480000,
  start_time: '2026-11-01T00:00:00Z',
  end_time: null,
  is_servable: phase === 'prepare',
  reasons_not_servable: phase === 'prepare' ? [] : ['CREDIT_LIMIT_REACHED'],
  ...(phase === 'execute' ? change : {}),
});
const fundingFlow = change =>
  rewrittenFlow(
    redditFunding,
    ({method, path}) => method === 'GET' && path === '/api/v3/ad_accounts/a2_111/funding_instruments',
    (json, phase) => ({...json, data: [instrument(phase, change)]}),
  );
test('reddit write: a funding instrument whose meter and servable state move between review and execute is the same instrument', async () => {
  const {done, writes} = await fundingFlow({});
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 800));
  assert.equal(writes(), 1);
});
test('reddit write: a real change of the funding instrument a campaign names is STATE_CHANGED naming that field, and nothing is sent', async () => {
  for (const [field, change] of [
    ['currency', {currency: 'EUR'}],
    ['credit_limit', {credit_limit: 1000}],
    ['start_time', {start_time: '2026-12-01T00:00:00Z'}],
    ['end_time', {end_time: '2026-11-20T00:00:00Z'}],
  ]) {
    // The state is [the account, the campaign being changed, the funding instrument]: the third read.
    const {done, writes} = await fundingFlow(change);
    assertRefused(done, 'STATE_CHANGED', {writes});
    assert.deepEqual(done.error.details.changed_fields, ['$[2]["data"][0]["' + field + '"]'], field);
    assertMaterial(done, field);
  }
  // A different instrument is refused by the family's own check of the answer, before any comparison.
  const {done, writes} = await fundingFlow({id: 'fi_2'});
  assertRefused(done, 'STATE_TARGET_MISMATCH', {writes});
});

// --- X creatives: the account and the parents of a promotion --------------------------------------------------------------

// `setup` gives the line item and the campaign what X returns of them at review; `change` edits them before execute.
const promotion = async (change, check, setup = () => {}) => {
  const f = familyFixture(xCreatives);
  try {
    setup(f.state);
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 600));
    change(f.state);
    return await check(f, await f.execute(p.data));
  } finally {
    f.close();
  }
};
// What a line item and a campaign of X carry beside who they are: the budget a promotion under them spends by, its bid and its
// flight (none of it changes by itself), and the four fields X computes (src/x-review-volatile.ts), which do.
const withSettings = state => {
  Object.assign(state.line, {
    bid_amount_local_micro: '1000000',
    daily_budget_amount_local_micro: '2000000',
    total_budget_amount_local_micro: '50000000',
    start_time: '2026-12-01T00:00:00Z',
    end_time: '2026-12-31T00:00:00Z',
    placements: ['ALL_ON_TWITTER'],
    servable: true,
    reasons_not_servable: [],
    effective_status: 'ACTIVE',
    updated_at: '2026-11-16T10:00:00Z',
  });
  Object.assign(state.campaign, {
    daily_budget_amount_local_micro: '5000000',
    total_budget_amount_local_micro: '50000000',
    start_time: '2026-12-01T00:00:00Z',
    end_time: '2026-12-31T00:00:00Z',
    servable: true,
    effective_status: 'RUNNING',
    updated_at: '2026-11-16T10:00:00Z',
  });
};

test('X promotion: a line item and a campaign whose servable state and update time flip are the same parents (L4-13)', async () => {
  await promotion(
    state => {
      Object.assign(state.line, {
        servable: false,
        reasons_not_servable: ['EXPIRED'],
        effective_status: 'PAUSED',
        updated_at: '2026-11-16T10:04:00Z',
      });
      Object.assign(state.campaign, {servable: false, effective_status: 'PAUSED', updated_at: '2026-11-16T10:04:00Z'});
    },
    (f, done) => {
      assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
      assert.equal(f.sent.length, 1);
    },
    withSettings,
  );
});

test('X promotion: a budget, a bid, a flight or a placement of the line item or the campaign that changes is STATE_CHANGED (L4-13, S2-1)', async () => {
  // The promotion goes live at once, so what its parents spend by is what the confirmed spend runs under.
  for (const [what, change, path] of [
    [
      'line item daily budget',
      s => (s.line.daily_budget_amount_local_micro = '4500000000'),
      '$[1]["line_item"]["daily_budget_amount_local_micro"]',
    ],
    [
      'line item total budget',
      s => (s.line.total_budget_amount_local_micro = '50000000000'),
      '$[1]["line_item"]["total_budget_amount_local_micro"]',
    ],
    ['line item bid', s => (s.line.bid_amount_local_micro = '9000000'), '$[1]["line_item"]["bid_amount_local_micro"]'],
    ['line item flight start', s => (s.line.start_time = '2026-11-17T00:00:00Z'), '$[1]["line_item"]["start_time"]'],
    ['line item flight end', s => (s.line.end_time = '2027-12-31T00:00:00Z'), '$[1]["line_item"]["end_time"]'],
    [
      'line item placements',
      s => (s.line.placements = ['ALL_ON_TWITTER', 'PUBLISHER_NETWORK']),
      '$[1]["line_item"]["placements"][1]',
    ],
    [
      'campaign daily budget',
      s => (s.campaign.daily_budget_amount_local_micro = '9000000000'),
      '$[1]["campaign"]["daily_budget_amount_local_micro"]',
    ],
    [
      'campaign total budget',
      s => (s.campaign.total_budget_amount_local_micro = '9000000000'),
      '$[1]["campaign"]["total_budget_amount_local_micro"]',
    ],
    ['campaign flight end', s => (s.campaign.end_time = '2027-12-31T00:00:00Z'), '$[1]["campaign"]["end_time"]'],
  ])
    await promotion(
      change,
      (f, done) => {
        assertRefused(done, 'STATE_CHANGED', {writes: () => f.sent.length});
        assert.deepEqual(done.error.details.changed_fields, [path], what);
        assertMaterial(done, what);
      },
      withSettings,
    );
});

test('X promotion: the parent line item or campaign changing status or name is STATE_CHANGED', async () => {
  for (const [what, change, path] of [
    ['line item status', s => (s.line.entity_status = 'ACTIVE'), '$[1]["line_item"]["entity_status"]'],
    ['line item name', s => (s.line.name = 'Renamed elsewhere'), '$[1]["line_item"]["name"]'],
    ['campaign status', s => (s.campaign.entity_status = 'PAUSED'), '$[1]["campaign"]["entity_status"]'],
  ])
    await promotion(change, (f, done) => {
      assertRefused(done, 'STATE_CHANGED', {writes: () => f.sent.length});
      assert.ok(
        done.error.details.changed_fields.includes(path),
        what + ': ' + JSON.stringify(done.error.details.changed_fields),
      );
      assert.ok(
        done.error.details.material.includes(path),
        what + ' is material: ' + JSON.stringify(done.error.details.material),
      );
    });
});

// --- Every create names its account and its parents -----------------------------------------------------------------------

test('lint: a Microsoft or Reddit write reads its account as an ACCOUNT, and the object it changes carries no role (S3-3)', async () => {
  for (const descriptor of [microsoftSearch, redditClassic]) {
    const f = familyFixture(descriptor);
    try {
      const p = await f.prepare();
      assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
      const stored = f.store.document('conformance-' + descriptor.family, 'write_review', p.data.review_id);
      // The account first; then what the write changes (its target), never marked.
      assert.deepEqual(
        stored.reads.map(r => r.stateRole ?? null),
        ['account', null],
        descriptor.family,
      );
    } finally {
      f.close();
    }
  }
});
test('lint: a Reddit campaign write reads the funding instrument it names as a REFERENCE, after the account and its own target (S3-4)', async () => {
  const f = familyFixture(redditFunding);
  try {
    const p = await f.prepare();
    assert.equal(p.success, true, JSON.stringify(p.error ?? p).slice(0, 600));
    const stored = f.store.document('conformance-' + redditFunding.family, 'write_review', p.data.review_id);
    assert.deepEqual(
      stored.reads.map(r => r.stateRole ?? null),
      ['account', null, 'reference'],
    );
    assert.match(stored.reads[2].path, /\/funding_instruments$/);
  } finally {
    f.close();
  }
});

test('lint: the Smart+ ad group an ad is created in, and the Smart+ campaign an ad group is created in, carry the role of a parent (S3-5)', async () => {
  // Found by the rotation harness's own list of parent reads, not by the roles the code stamps: they were the first two it saw
  // without one. A parent is read whole whatever its role; the role is metadata for the review's ordering.
  for (const [descriptor, roles] of [
    [smartPlusAds, ['parent', null, null, null, null]],
    [smartPlusAdgroups, ['account', 'parent', null]],
  ]) {
    const f = familyFixture(descriptor);
    try {
      const p = await f.prepare();
      assert.equal(p.success, true, descriptor.family + ' ' + JSON.stringify(p.error ?? p).slice(0, 600));
      const stored = f.store.document('conformance-' + descriptor.family, 'write_review', p.data.review_id);
      assert.deepEqual(
        stored.reads.map(r => r.stateRole ?? null),
        roles,
        descriptor.family,
      );
    } finally {
      f.close();
    }
  }
});

test('a read declares its role under one name, `stateRole`, and the values are the vocabulary the diff package reads (S3-6)', () => {
  // r25-m1-diff orders what a STATE_CHANGED names by the role of each read: account, parent, target, reference. After the merge
  // (r25-m1-merge) it asks `readRole` (src/review-state-core.ts), the one lookup this package's state stage asks too, and
  // tests/review-read-role.test.mjs holds that. This package stamps exactly `account`, `parent` and `reference`; the target is a
  // read with none (the objects a write changes keep their whole protection). A fourth value, or a second name for the same
  // thing, would leave `material` placing a read wrongly without any test saying so.
  const stamped = new Set(),
    names = new Set();
  for (const file of fs.readdirSync('src').filter(n => n.endsWith('.ts'))) {
    const text = fs.readFileSync('src/' + file, 'utf8');
    for (const m of text.matchAll(/\bstateRole\s*[:=]\s*'([a-z_]+)'/g)) stamped.add(m[1]);
    for (const m of text.matchAll(/\b(\w*[rR]ole)\??:\s*'account'/g)) names.add(m[1]);
  }
  assert.deepEqual([...stamped].sort(), ['account', 'parent', 'reference']);
  assert.deepEqual([...names], ['stateRole'], 'the role of a read has one name');
  assert.match(fs.readFileSync('src/types.ts', 'utf8'), /stateRole\?: 'account' \| 'parent' \| 'reference';/);
});

test('lint: the reads a create makes of its account and its parent carry their role, and no other read does', () => {
  const plan = (gateway, path, body, fields = {}) => ({
    gateway,
    action: 'native',
    method: 'POST',
    path,
    query: {},
    headers: {},
    body,
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    accountId: '123',
    evidence: 'TEST',
    warnings: [],
    ...fields,
  });
  const roles = p => snapshotPlans(p, registry).map(r => r.stateRole ?? null);
  const tiktokAdvertiser = '9000000000000000001';
  assert.deepEqual(
    roles(
      plan(
        'tiktok_native_action',
        '/v1.3/campaign/create/',
        {advertiser_id: tiktokAdvertiser},
        {accountId: tiktokAdvertiser},
      ),
    ),
    ['account'],
  );
  assert.deepEqual(
    roles(
      plan(
        'tiktok_native_action',
        '/v1.3/adgroup/create/',
        {advertiser_id: tiktokAdvertiser, campaign_id: '300'},
        {accountId: tiktokAdvertiser},
      ),
    ),
    ['account', 'parent'],
  );
  assert.deepEqual(
    roles(
      plan(
        'tiktok_native_action',
        '/v1.3/ad/create/',
        {advertiser_id: tiktokAdvertiser, adgroup_id: '200', creatives: [{ad_name: 'a'}]},
        {accountId: tiktokAdvertiser},
      ),
    ),
    ['account', 'parent'],
  );
  assert.deepEqual(roles(plan('x_ads_native_action', '/12/accounts/123/campaigns', {name: 'Draft'})), ['account']);
  assert.deepEqual(roles(plan('x_ads_native_action', '/12/accounts/123/line_items', {name: 'Draft'})), ['account']);
  assert.deepEqual(roles(plan('linkedin_native_action', '/rest/adAccounts/123/adCampaigns', {name: 'Draft'})), [
    'account',
  ]);
  assert.deepEqual(roles(plan('dv360_native_action', '/v4/advertisers/123/campaigns', {displayName: 'Draft'})), [
    'account',
  ]);
  // An edit reads the object it changes: no role.
  assert.deepEqual(
    roles(
      plan(
        'tiktok_native_action',
        '/v1.3/campaign/update/',
        {advertiser_id: tiktokAdvertiser, campaign_id: '300'},
        {accountId: tiktokAdvertiser},
      ),
    ),
    [null],
  );
  assert.deepEqual(
    roles(plan('x_ads_native_action', '/12/accounts/123/campaigns/111', {name: 'Renamed'}, {method: 'PUT'})),
    [null],
  );
  assert.deepEqual(
    roles(plan('linkedin_native_action', '/rest/adAccounts/123/adCampaigns/111', {patch: {$set: {name: 'R'}}})),
    [null],
  );
});
