import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../src/catalog.js';
import {Store} from '../src/store.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import type {JsonObject} from '../src/types.js';
import {assertRefused} from './helpers/assert-refused.js';

/**
 * R2.5 M3 (L5-10, L2-07): every refusal of Google's targeting module names the operation it came from and the field to
 * change, and the allowed values where the field takes a closed list. Before, `invalid(message)` dropped all of it: an agent
 * that sent 19 criteria was told "Supply exactly one qualified criterion type." and not which one. The messages, codes and
 * statuses are as they were. Synthetic IDs only; `inspect` checks the contract locally, so no request leaves the process.
 */
const gateway = 'google_ads_native_action',
  actor = {tenantId: 'targeting-details', userId: 'u', role: 'operator' as const},
  admin = {...actor, role: 'admin' as const},
  actions: Record<string, string> = {
    campaignCriteria: 'google_ads_v23_campaign_criterion_mutate_campaign_criteria',
    adGroupCriteria: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
    sharedSets: 'google_ads_v23_shared_set_mutate_shared_sets',
    sharedCriteria: 'google_ads_v23_shared_criterion_mutate_shared_criteria',
    campaignSharedSets: 'google_ads_v23_campaign_shared_set_mutate_campaign_shared_sets',
  };
const adGroup = 'customers/123/adGroups/100',
  campaign = 'customers/123/campaigns/9',
  sharedSet = 'customers/123/sharedSets/5',
  criterion = 'customers/123/adGroupCriteria/100~200';
/** A valid first operation per kind, so that the refused one is the second and its index is not 0. */
const valid: Record<string, JsonObject> = {
  adGroupCriteria: {create: {adGroup, negative: true, keyword: {text: 'free', matchType: 'BROAD'}}},
  campaignCriteria: {create: {campaign, negative: true, keyword: {text: 'free', matchType: 'BROAD'}}},
  sharedSets: {create: {name: 'Ok words', type: 'NEGATIVE_KEYWORDS'}},
  sharedCriteria: {create: {sharedSet, keyword: {text: 'ok', matchType: 'BROAD'}}},
  campaignSharedSets: {create: {campaign, sharedSet}},
};
function setup() {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw new Error('inspect reaches no provider');
    }),
    undefined,
    {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  );
  return {
    store,
    inspect: async (kind: string, operations: JsonObject[]) => {
      const r: any = await service.call(
        'amcp_write',
        {action: 'inspect', gateway, arguments: {action: actions[kind], account_id: '123', payload: {operations}}},
        actor,
      );
      return r.data;
    },
  };
}
/** The allowed values a refusal lists: the exact list, or a check of it where the list is long and another package's to change. */
type Allowed = string[] | ((allowed: unknown) => void);
/** [label, kind, the refused operation, its message, the field it names, the allowed values]. */
const refusals: [string, string, JsonObject, string, string, Allowed?][] = [
  [
    'a create that carries a resource name',
    'adGroupCriteria',
    {create: {resourceName: criterion, adGroup, negative: true, keyword: {text: 'x', matchType: 'BROAD'}}},
    'Unqualified or immutable field: resource_name',
    'operations[1].create.resource_name',
    (allowed: unknown) => {
      assert.ok(Array.isArray(allowed) && allowed.includes('keyword') && !allowed.includes('resource_name'));
    },
  ],
  [
    'no criterion type',
    'adGroupCriteria',
    {create: {adGroup}},
    'Supply exactly one qualified criterion type.',
    'operations[1].create',
    (allowed: unknown) => {
      assert.ok(Array.isArray(allowed) && allowed.includes('keyword') && allowed.includes('age_range'));
    },
  ],
  [
    'two criterion types',
    'adGroupCriteria',
    {create: {adGroup, keyword: {text: 'x', matchType: 'BROAD'}, placement: {url: 'a.example'}}},
    'Supply exactly one qualified criterion type.',
    'operations[1].create',
  ],
  [
    'a keyword with no text',
    'adGroupCriteria',
    {create: {adGroup, keyword: {matchType: 'BROAD'}}},
    'keyword.text is required as a native string.',
    'operations[1].create.keyword.text',
  ],
  [
    'a positive placement on an ad group',
    'adGroupCriteria',
    {create: {adGroup, placement: {url: 'a.example'}}},
    'placement is only qualified for exclusions in this contract.',
    'operations[1].create.negative',
  ],
  [
    'a placement URL that is too long',
    'adGroupCriteria',
    {create: {adGroup, negative: true, placement: {url: 'a'.repeat(300)}}},
    'Provide a native placement URL of at most 250 characters.',
    'operations[1].create.placement.url',
  ],
  [
    'a status that is neither ENABLED nor PAUSED',
    'adGroupCriteria',
    {create: {adGroup, status: 'REMOVED', negative: true, keyword: {text: 'x', matchType: 'BROAD'}}},
    'Use ENABLED/PAUSED where supported, or a remove operation.',
    'operations[1].create.status',
    ['ENABLED', 'PAUSED'],
  ],
  [
    'a bid that is not a decimal string',
    'adGroupCriteria',
    {create: {adGroup, keyword: {text: 'x', matchType: 'BROAD'}, cpcBidMicros: '-5'}},
    'Bid micros must be nonnegative signed 64-bit decimal strings.',
    'operations[1].create.cpc_bid_micros',
  ],
  [
    'a bid modifier out of range',
    'adGroupCriteria',
    {create: {adGroup, negative: true, keyword: {text: 'x', matchType: 'BROAD'}, bidModifier: 99}},
    'bid_modifier must be between 0 and 10; the provider enforces type-specific limits.',
    'operations[1].create.bid_modifier',
  ],
  [
    'a parent in another customer',
    'adGroupCriteria',
    {create: {adGroup: 'customers/999/adGroups/1', negative: true, keyword: {text: 'x', matchType: 'BROAD'}}},
    'Expected an existing adGroups resource in the selected customer.',
    'operations[1].create.ad_group',
  ],
  [
    'a user list that is no resource name',
    'adGroupCriteria',
    {create: {adGroup, status: 'PAUSED', userList: {userList: 'customers/123/userLists/abc'}}},
    'Expected an existing userLists resource in the selected customer.',
    'operations[1].create.user_list.user_list',
  ],
  [
    'an update without a mask',
    'adGroupCriteria',
    {update: {resourceName: criterion, cpcBidMicros: '5'}},
    'Updates require update_mask.',
    'operations[1].update_mask',
  ],
  [
    'an update whose mask names an immutable field',
    'adGroupCriteria',
    {update: {resourceName: criterion, cpcBidMicros: '5'}, updateMask: 'keyword.text'},
    'The mask contains an immutable or unqualified field. Remove and create a criterion to change its identity.',
    'operations[1].update_mask',
    [
      'status',
      'bid_modifier',
      'cpc_bid_micros',
      'cpm_bid_micros',
      'cpv_bid_micros',
      'percent_cpc_bid_micros',
      'final_urls',
      'final_mobile_urls',
      'final_url_suffix',
      'tracking_url_template',
      'url_custom_parameters',
    ],
  ],
  [
    'a create with an update mask',
    'adGroupCriteria',
    {create: {adGroup, negative: true, keyword: {text: 'x', matchType: 'BROAD'}}, updateMask: 'status'},
    'Only updates accept update_mask.',
    'operations[1].update_mask',
  ],
  [
    'a removal that names no criterion',
    'adGroupCriteria',
    {remove: 'customers/123/adGroupCriteria/100'},
    'Expected an existing adGroupCriteria resource in the selected customer.',
    'operations[1].remove',
  ],
  [
    'a campaign keyword that is not negative',
    'campaignCriteria',
    {create: {campaign, keyword: {text: 'x', matchType: 'BROAD'}}},
    'Campaign-level keywords must be negative. Positive Search keywords belong to an ad group.',
    'operations[1].create.negative',
  ],
  [
    'a positive age range on a campaign',
    'campaignCriteria',
    {create: {campaign, ageRange: {type: 'AGE_RANGE_18_24'}}},
    'age_range is only qualified for exclusions in this contract.',
    'operations[1].create.negative',
  ],
  [
    'a negative language on a campaign',
    'campaignCriteria',
    {create: {campaign, negative: true, language: {languageConstant: 'languageConstants/1000'}}},
    'language does not support campaign exclusion through this contract.',
    'operations[1].create.negative',
  ],
  [
    'an ad schedule that ends before it starts',
    'campaignCriteria',
    {
      create: {
        campaign,
        adSchedule: {dayOfWeek: 'MONDAY', startHour: 17, startMinute: 'ZERO', endHour: 9, endMinute: 'ZERO'},
      },
    },
    'Ad schedules require an increasing same-day interval in quarter hours.',
    'operations[1].create.ad_schedule',
  ],
  [
    'a location that is no geo target constant',
    'campaignCriteria',
    {create: {campaign, location: {geoTargetConstant: 'geoTargetConstants/abc'}}},
    'Use an existing geoTargetConstants constant.',
    'operations[1].create.location.geo_target_constant',
  ],
  [
    'a list attached that is no shared set',
    'campaignSharedSets',
    {create: {campaign, sharedSet: 'customers/123/sharedSets/abc'}},
    'Expected an existing sharedSets resource in the selected customer.',
    'operations[1].create.shared_set',
  ],
];
for (const [label, kind, operation, message, field, allowed] of refusals)
  test('the targeting refusal for ' + label + ' names its operation and field (R2.5 M3, L5-10)', async () => {
    const x = setup();
    try {
      const answer = await x.inspect(kind, [valid[kind]!, operation]);
      assert.equal(answer.review_contract_supported, false, JSON.stringify(answer).slice(0, 400));
      const error = answer.error;
      assertRefused({success: false, error}, 'INVALID_TARGETING_MUTATION');
      // The sentence is as it was; the answer names the field after it (the message of every refusal that carries a field).
      assert.ok(
        error.message.startsWith(message.replace(/\.$/, '')) && error.message.endsWith(field + '.'),
        error.message,
      );
      assert.equal(error.details.operation, 1, 'the refused operation is the second');
      assert.equal(error.details.field, field);
      if (typeof allowed === 'function') allowed(error.details.allowed);
      else if (allowed) assert.deepEqual(error.details.allowed, allowed);
      else assert.ok(!('allowed' in error.details) || Array.isArray(error.details.allowed));
    } finally {
      x.store.close();
    }
  });
test('a removal named twice is refused at the second one, naming it (R2.5 M3, L5-10)', async () => {
  const x = setup();
  try {
    const answer = await x.inspect('adGroupCriteria', [{remove: criterion}, {remove: criterion}]);
    assertRefused({success: false, error: answer.error}, 'INVALID_TARGETING_MUTATION');
    assert.match(answer.error.message, /^A target cannot appear twice in a mutation: operations\[1\]\.remove\.$/);
    assert.deepEqual(
      {operation: answer.error.details.operation, field: answer.error.details.field},
      {operation: 1, field: 'operations[1].remove'},
    );
  } finally {
    x.store.close();
  }
});
test('the refusal of a second operation does not blame the first, which is valid (R2.5 M3)', async () => {
  const x = setup();
  try {
    // The same refusal at index 0 and at index 2 names 0 and 2: the index is the operation's own, not a count of refusals.
    const bad = {create: {adGroup, keyword: {matchType: 'BROAD'}}};
    for (const at of [0, 2]) {
      const operations = [valid.adGroupCriteria!, valid.adGroupCriteria!, valid.adGroupCriteria!];
      operations[at] = bad;
      const answer = await x.inspect('adGroupCriteria', operations);
      assert.equal(answer.error.details.operation, at);
      assert.equal(answer.error.details.field, 'operations[' + at + '].create.keyword.text');
    }
    // A valid request is still accepted: nothing here made the module stricter.
    const accepted = await x.inspect('adGroupCriteria', [valid.adGroupCriteria!]);
    assert.equal(accepted.review_contract_supported, true, JSON.stringify(accepted).slice(0, 400));
  } finally {
    x.store.close();
  }
});
