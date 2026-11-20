import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {googleAdsCustomers} from './google-version.js';
import {defineFamily, readOf} from './family-kit.js';
import {narrowingExempt, parentReading} from './google-paused-parents.js';
import {googleShoppingTreeKind} from './google-shopping-tree.js';

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * A refusal of this module. Its details name where the agent has to look (R2.5 M3, L5-10 and L2-07): `operation`, the index
 * of the refused operation in the request's list, and `field`, the request path of what to change, with `allowed` where the
 * field takes a closed list. A refusal that has none of them cannot say which of 19 criteria it means.
 */
function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new MirrorError('INVALID_TARGETING_MUTATION', message, details);
}
/**
 * A refusal of operation `index`: `field` is relative to that operation (`create.keyword.text`), its path in the request is
 * built here. It is a forwarder of `invalid` that takes its message as a parameter, so the locale inventory
 * (tools/check-locales.mjs) still finds every literal sentence passed to it, as it found those passed to `invalid`.
 */
function refuse(index: number, message: string, field: string, extra: Record<string, unknown> = {}): never {
  return invalid(message, {
    operation: index,
    field: 'operations[' + index + ']' + (field ? '.' + field : ''),
    ...extra,
  });
}
function normalized(value: unknown, path = ''): any {
  if (Array.isArray(value)) return value.map((v, i) => normalized(v, path + '[' + i + ']'));
  if (!object(value)) return value;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) {
    const key = snake(k),
      at = path ? path + '.' + key : key,
      operation = /^operations\[(\d+)\]/.exec(at)?.[1];
    if (Object.hasOwn(out, key))
      invalid('Conflicting native field aliases: ' + key, {
        ...(operation !== undefined ? {operation: Number(operation)} : {}),
        field: at,
      });
    out[key] = normalized(v, at);
  }
  return out;
}
const criteria: Record<string, string[]> = {
  keyword: ['text', 'match_type'],
  location: ['geo_target_constant'],
  language: ['language_constant'],
  device: ['type'],
  ad_schedule: ['day_of_week', 'start_hour', 'end_hour', 'start_minute', 'end_minute'],
  age_range: ['type'],
  gender: ['type'],
  income_range: ['type'],
  parental_status: ['type'],
  placement: ['url'],
  topic: ['topic_constant'],
  user_list: ['user_list'],
  user_interest: ['user_interest_category'],
  audience: ['audience'],
};
const campaignKinds = [
  'keyword',
  'location',
  'language',
  'device',
  'ad_schedule',
  'age_range',
  'gender',
  'income_range',
  'parental_status',
  'placement',
  'topic',
  'user_list',
  'user_interest',
];
// R2.5 M3, G6 (owner 2026-11-15): a Demand Gen campaign takes location and language on its ad groups. Which campaigns' ad
// groups may is decided on the state, where the channel is read (validateGoogleTargetingState).
const groupKinds = [
  'keyword',
  'location',
  'language',
  'age_range',
  'gender',
  'income_range',
  'parental_status',
  'placement',
  'topic',
  'user_list',
  'user_interest',
  'audience',
];
const config = {
  campaignCriteria: {
    resource: 'campaign_criterion',
    fields: ['campaign', 'type', 'negative', 'status', 'bid_modifier'],
    mutable: ['status', 'bid_modifier'],
    parent: 'campaign',
    types: campaignKinds,
  },
  adGroupCriteria: {
    resource: 'ad_group_criterion',
    fields: [
      'ad_group',
      'type',
      'negative',
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
    mutable: [
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
    parent: 'ad_group',
    types: groupKinds,
  },
  sharedSets: {resource: 'shared_set', fields: ['name', 'type', 'status'], mutable: ['name'], parent: '', types: []},
  sharedCriteria: {
    resource: 'shared_criterion',
    fields: ['shared_set', 'type', 'keyword.text', 'keyword.match_type', 'placement.url'],
    mutable: [],
    parent: 'shared_set',
    types: ['keyword', 'placement'],
  },
  campaignSharedSets: {
    resource: 'campaign_shared_set',
    fields: ['campaign', 'shared_set', 'status'],
    mutable: [],
    parent: 'campaign',
    types: [],
  },
};
export const googleTargetingKinds = Object.keys(config);
export function googleTargetingKind(plan: CompiledRequest) {
  const kind = plan.path.match(/^\/v\d+\/customers\/\d+\/([^/]+):mutate$/)?.[1];
  return plan.gateway === 'google_ads_native_action' && plan.method === 'POST' && kind && Object.hasOwn(config, kind)
    ? (kind as keyof typeof config)
    : undefined;
}
function resource(value: unknown, account: string, kind: string, index: number, field: string) {
  const composite = ['campaignCriteria', 'adGroupCriteria', 'sharedCriteria', 'campaignSharedSets'].includes(kind);
  if (
    typeof value !== 'string' ||
    !new RegExp('^customers/' + account + '/' + kind + '/[1-9][0-9]*' + (composite ? '~[1-9][0-9]*' : '') + '$').test(
      value,
    )
  )
    refuse(index, 'Expected an existing ' + kind + ' resource in the selected customer.', field);
  return value;
}
/** `at` is the path of `r` within its operation: '' for the operation itself, 'create' or 'update' for its record. */
function fieldSet(r: JsonObject, allowed: string[], index: number, at: string) {
  for (const k of Object.keys(r))
    if (!allowed.includes(k)) refuse(index, 'Unqualified or immutable field: ' + k, at ? at + '.' + k : k, {allowed});
}
const adScheduleDays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const adScheduleMinutes = ['ZERO', 'FIFTEEN', 'THIRTY', 'FORTY_FIVE'];
const keywordMatchTypes = ['EXACT', 'PHRASE', 'BROAD'];
const sharedListTypes = ['NEGATIVE_KEYWORDS', 'NEGATIVE_PLACEMENTS'];
function criterion(r: JsonObject, kinds: string[], index: number, campaign = false, shared = false) {
  const supplied = kinds.filter(k => r[k] !== undefined);
  if (supplied.length !== 1) refuse(index, 'Supply exactly one qualified criterion type.', 'create', {allowed: kinds});
  const type = supplied[0]!,
    v = r[type],
    at = 'create.' + type;
  if (!object(v)) refuse(index, type + ' must be a native object.', at);
  fieldSet(v, criteria[type]!, index, at);
  for (const field of criteria[type]!)
    if (type !== 'ad_schedule' && (typeof v[field] !== 'string' || !v[field].trim()))
      refuse(index, type + '.' + field + ' is required as a native string.', at + '.' + field);
  if (type === 'keyword') {
    if (typeof v.text !== 'string' || !v.text.trim() || Buffer.byteLength(v.text) > 1024)
      refuse(index, 'Keywords require text and EXACT, PHRASE or BROAD match_type.', at + '.text');
    if (!keywordMatchTypes.includes(v.match_type))
      refuse(index, 'Keywords require text and EXACT, PHRASE or BROAD match_type.', at + '.match_type', {
        allowed: keywordMatchTypes,
      });
    if (campaign && r.negative !== true)
      refuse(
        index,
        'Campaign-level keywords must be negative. Positive Search keywords belong to an ad group.',
        'create.negative',
      );
  }
  if (r.negative !== undefined && typeof r.negative !== 'boolean')
    refuse(index, 'negative must be a boolean.', 'create.negative');
  if (
    ((campaign && ['age_range', 'gender', 'income_range', 'parental_status'].includes(type)) ||
      (type === 'placement' && !shared)) &&
    r.negative !== true
  )
    refuse(index, type + ' is only qualified for exclusions in this contract.', 'create.negative');
  if (campaign && ['language', 'device', 'ad_schedule'].includes(type) && r.negative === true)
    refuse(index, type + ' does not support campaign exclusion through this contract.', 'create.negative');
  // Round 2 (the lead's answer 4, 2026-11-18; developers.google.com/google-ads/api/docs/targeting/criteria, supported criteria): Google
  // takes language as a positive criterion only, at either level (the campaign level is refused above), so an ad group's language
  // exclusion is refused, saying so. A location exclusion is not refused here: it is documented as supported in general and
  // undocumented for Demand Gen, so the default validate-only answers at prepare (round 1 refused it, "not yet verified").
  if (!campaign && !shared && type === 'language' && r.negative === true)
    refuse(
      index,
      'Google does not take language exclusions. Add the languages to target; a language cannot be excluded.',
      'create.negative',
    );
  if (type === 'ad_schedule') {
    if (!adScheduleDays.includes(v.day_of_week))
      refuse(index, 'Invalid ad schedule hours or day.', at + '.day_of_week', {allowed: adScheduleDays});
    if (!Number.isInteger(v.start_hour) || v.start_hour < 0 || v.start_hour > 23)
      refuse(index, 'Invalid ad schedule hours or day.', at + '.start_hour');
    if (!Number.isInteger(v.end_hour) || v.end_hour < 0 || v.end_hour > 24)
      refuse(index, 'Invalid ad schedule hours or day.', at + '.end_hour');
    if (!adScheduleMinutes.includes(v.start_minute))
      refuse(index, 'Ad schedules require an increasing same-day interval in quarter hours.', at + '.start_minute', {
        allowed: adScheduleMinutes,
      });
    if (!adScheduleMinutes.includes(v.end_minute))
      refuse(index, 'Ad schedules require an increasing same-day interval in quarter hours.', at + '.end_minute', {
        allowed: adScheduleMinutes,
      });
    if (
      (v.end_hour === 24 && v.end_minute !== 'ZERO') ||
      v.start_hour * 60 + adScheduleMinutes.indexOf(v.start_minute) * 15 >=
        v.end_hour * 60 + adScheduleMinutes.indexOf(v.end_minute) * 15
    )
      refuse(index, 'Ad schedules require an increasing same-day interval in quarter hours.', at);
  }
  const constants: Record<string, [string, string]> = {
    location: ['geo_target_constant', 'geoTargetConstants'],
    language: ['language_constant', 'languageConstants'],
    topic: ['topic_constant', 'topicConstants'],
    user_interest: ['user_interest_category', 'userInterests'],
  };
  if (constants[type]) {
    const [field, collection] = constants[type]!;
    if (typeof v[field] !== 'string' || !new RegExp('^' + collection + '/[1-9][0-9]*$').test(v[field]))
      refuse(index, 'Use an existing ' + collection + ' constant.', at + '.' + field);
  }
  if (
    type === 'placement' &&
    (typeof v.url !== 'string' || !v.url.trim() || v.url.length > 250 || /[\r\n]/.test(v.url))
  )
    refuse(index, 'Provide a native placement URL of at most 250 characters.', at + '.url');
  return type;
}
export function assertGoogleTargeting(plan: CompiledRequest) {
  const kind = googleTargetingKind(plan);
  if (!kind) return;
  const cfg = config[kind],
    account = plan.accountId!,
    body = normalized(plan.body),
    seen = new Set<string>();
  for (const [index, op] of body.operations.entries()) {
    fieldSet(op, ['create', 'update', 'remove', 'update_mask'], index, '');
    const r = op.create ?? op.update,
      side = op.create !== undefined ? 'create' : 'update';
    if (r !== undefined && !object(r)) refuse(index, 'Mutation records must be native objects.', side);
    if (op.remove !== undefined) {
      const id = resource(op.remove, account, kind, index, 'remove');
      if (seen.has(id)) refuse(index, 'A target cannot appear twice in a mutation.', 'remove');
      seen.add(id);
      continue;
    }
    if (op.update) {
      const name = resource(r.resource_name, account, kind, index, 'update.resource_name');
      if (seen.has(name)) refuse(index, 'A target cannot appear twice in a mutation.', 'update.resource_name');
      seen.add(name);
      if (typeof op.update_mask !== 'string' || !op.update_mask)
        refuse(index, 'Updates require update_mask.', 'update_mask');
      const mask = op.update_mask.split(',').map(snake);
      if (
        !cfg.mutable.length ||
        mask.some((f: string) => !(cfg.mutable as readonly string[]).includes(f)) ||
        new Set(mask).size !== mask.length
      )
        refuse(
          index,
          'The mask contains an immutable or unqualified field. Remove and create a criterion to change its identity.',
          'update_mask',
          {allowed: cfg.mutable},
        );
      fieldSet(r, ['resource_name', ...mask], index, 'update');
    } else {
      if (op.update_mask !== undefined) refuse(index, 'Only updates accept update_mask.', 'update_mask');
      fieldSet(
        r,
        [
          ...cfg.types,
          ...cfg.mutable,
          ...(cfg.parent ? [cfg.parent] : []),
          ...(kind === 'campaignCriteria' || kind === 'adGroupCriteria' ? ['negative'] : []),
          ...(kind === 'sharedSets' ? ['name', 'type'] : []),
          ...(kind === 'campaignSharedSets' ? ['shared_set'] : []),
        ],
        index,
        'create',
      );
      if (kind === 'campaignCriteria' || kind === 'adGroupCriteria' || kind === 'sharedCriteria') {
        const t = criterion(r, cfg.types, index, kind === 'campaignCriteria', kind === 'sharedCriteria');
        if (t === 'user_list')
          resource(r.user_list.user_list, account, 'userLists', index, 'create.user_list.user_list');
        if (t === 'audience') resource(r.audience.audience, account, 'audiences', index, 'create.audience.audience');
      }
      if (kind === 'sharedSets') {
        if (!sharedListTypes.includes(r.type))
          refuse(
            index,
            'Shared lists require a name and NEGATIVE_KEYWORDS or NEGATIVE_PLACEMENTS type.',
            'create.type',
            {
              allowed: sharedListTypes,
            },
          );
        if (typeof r.name !== 'string' || !r.name.trim() || Buffer.byteLength(r.name) > 255)
          refuse(
            index,
            'Shared lists require a name and NEGATIVE_KEYWORDS or NEGATIVE_PLACEMENTS type.',
            'create.name',
          );
      }
      if (cfg.parent)
        resource(
          r[cfg.parent],
          account,
          cfg.parent === 'campaign' ? 'campaigns' : cfg.parent === 'ad_group' ? 'adGroups' : 'sharedSets',
          index,
          'create.' + cfg.parent,
        );
      if (kind === 'campaignSharedSets') resource(r.shared_set, account, 'sharedSets', index, 'create.shared_set');
    }
    if (r.status !== undefined && !['ENABLED', 'PAUSED'].includes(r.status))
      refuse(index, 'Use ENABLED/PAUSED where supported, or a remove operation.', side + '.status', {
        allowed: ['ENABLED', 'PAUSED'],
      });
    for (const [k, v] of Object.entries(r))
      if (k.endsWith('_micros') && (typeof v !== 'string' || !/^\d+$/.test(v) || BigInt(v) > 9223372036854775807n))
        refuse(index, 'Bid micros must be nonnegative signed 64-bit decimal strings.', side + '.' + k);
    if (
      r.bid_modifier !== undefined &&
      (typeof r.bid_modifier !== 'number' ||
        !Number.isFinite(r.bid_modifier) ||
        r.bid_modifier < 0 ||
        r.bid_modifier > 10)
    )
      refuse(
        index,
        'bid_modifier must be between 0 and 10; the provider enforces type-specific limits.',
        side + '.bid_modifier',
      );
  }
}
export function googleTargetingSnapshots(plan: CompiledRequest): CompiledRequest[] {
  const kind = googleTargetingKind(plan)!,
    cfg = config[kind],
    account = plan.accountId!,
    body = normalized(plan.body),
    reads: CompiledRequest[] = [],
    seen = new Set<string>();
  const search = (entity: string, fields: string[], names: string[], related: string[] = []) => {
    const query =
      'SELECT ' +
      [...new Set(['resource_name', ...fields])].map(f => entity + '.' + f).join(', ') +
      related.map(f => ', ' + f).join('') +
      ' FROM ' +
      entity +
      ' WHERE ' +
      entity +
      '.resource_name IN (' +
      names.map(n => "'" + n + "'").join(', ') +
      ')';
    if (seen.has(query)) return;
    seen.add(query);
    reads.push(
      readOf(plan, {
        action: 'AMCP_STATE_READ',
        method: 'POST',
        path: googleAdsCustomers + account + '/googleAds:search',
        query: {},
        body: {query},
        clears: [],
      }),
    );
  };
  const fields = [...cfg.fields, ...cfg.types.flatMap(t => (criteria[t] ?? []).map(f => t + '.' + f))],
    targets = body.operations
      .filter((o: JsonObject) => o.update || o.remove)
      .map((o: JsonObject) => o.remove ?? o.update.resource_name);
  if (targets.length) search(cfg.resource, fields, targets);
  if (body.operations.some((o: JsonObject) => o.create))
    reads.push(
      readOf(plan, {
        action: 'AMCP_STATE_READ',
        method: 'POST',
        path: googleAdsCustomers + account + '/googleAds:search',
        query: {},
        body: {query: 'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'},
        clears: [],
      }),
    );
  for (const op of body.operations) {
    const r = op.create ?? op.update;
    if (!r) continue;
    // A Demand Gen campaign's upgraded targeting (R2.5 M3 round 2, S2-1) decides the level it takes location and language at.
    if (r.campaign)
      search(
        'campaign',
        [
          'name',
          'status',
          'advertising_channel_type',
          'campaign_budget',
          'demand_gen_campaign_settings.upgraded_targeting',
        ],
        [r.campaign],
      );
    // The campaign's status too: a new keyword may start ENABLED only under a paused parent (owner item 6). And its channel
    // (R2.5 M3, G6): only a Demand Gen campaign's ad groups take location and language, and, round 2, only when its upgraded
    // targeting is on. A review prepared before this read asked for them keeps the query it froze, and reads them as not there.
    if (r.ad_group)
      search(
        'ad_group',
        ['name', 'status', 'campaign'],
        [r.ad_group],
        [
          'campaign.status',
          'campaign.advertising_channel_type',
          'campaign.demand_gen_campaign_settings.upgraded_targeting',
        ],
      );
    if (r.shared_set) search('shared_set', config.sharedSets.fields, [r.shared_set]);
    if (r.user_list) search('user_list', ['name', 'type', 'membership_status'], [r.user_list.user_list]);
    if (r.audience) search('audience', ['name', 'status', 'scope'], [r.audience.audience]);
  }
  return reads;
}
/**
 * A new positive ad-group criterion serves as soon as it and its ad group and campaign are enabled. It may start
 * ENABLED while its ad group or campaign is paused, as read for this review: then nothing serves until that parent is
 * enabled, which is its own reviewed activation (the owner's item 6, 2026-09-29: requiring PAUSED under a paused
 * campaign added a second pass per keyword set and protected nothing). Q1, owner 2026-11-15 (R2.5 M3, G8): it may also
 * start ENABLED, or with no status, under a parent that reads as serving. A positive criterion asks for the spend
 * acknowledgement (googleTargetingWidens) unless the review reads its ad group or campaign as PAUSED (the owner's decision of
 * 2026-11-19, googleCreatesUnderPausedParents, which the rollback switch turns off), and the owner's allow_activation switch
 * refuses one that starts serving (googleTargetingActivates). What refuses is a parent whose status the review could not read.
 * A tree node of a Shopping ad group (a create with `listing_group`) follows the Shopping tree family's rules instead
 * (package r25-m3-trees).
 */
function pausedParentsCoverChildren(plan: CompiledRequest, states: unknown[]) {
  if (googleTargetingKind(plan) !== 'adGroupCriteria') return;
  const rows = states.flatMap(s => (s as JsonObject)?.results ?? []).map(r => normalized(r));
  for (const [index, op] of normalized(plan.body).operations.entries()) {
    const r = op.create;
    if (!r || r.negative === true || r.status === 'PAUSED' || r.listing_group !== undefined) continue;
    const row = rows.find(x => x.ad_group?.resource_name === r.ad_group),
      adGroup = row?.ad_group?.status,
      campaign = row?.campaign?.status;
    if (parentReading([adGroup, campaign]) === 'unread')
      throw new MirrorError(
        'TARGETING_PARENT_SERVING',
        'A new positive ad-group criterion must start PAUSED while the status of its ad group or campaign cannot be read (ad group ' +
          (adGroup ?? 'unread') +
          ', campaign ' +
          (campaign ?? 'unread') +
          '). Once both are read it may start ENABLED: under a paused ad group or campaign as it is, under a serving one with spend_change_confirmed.',
        {
          operation: index,
          field: 'status',
          parent_unread: true,
          ad_group: r.ad_group,
          ad_group_status: adGroup ?? null,
          campaign_status: campaign ?? null,
        },
      );
  }
}
/**
 * Where a Demand Gen campaign takes location and language, from its `demand_gen_campaign_settings.upgraded_targeting` as the
 * review read it (R2.5 M3 round 2, S2-1; the pinned v25 text: "Immutable. ... When this field is set to `true`, you can use
 * location and language targeting at the ad group level as opposed to the standard campaign-level targeting. This field
 * defaults to `true`, and can only be set when creating a campaign"). An explicit `true` is the ad-group level and an explicit
 * `false` the campaign level, like any other channel. Anything else is unknown and decides nothing: the default validate-only does,
 * and a positive criterion still asks for the spend acknowledgement. In particular a value ABSENT from the row of an existing
 * campaign is unknown, not true (the lead's correction of 2026-11-19): Google's JSON responses can omit a field, and an older
 * campaign that is not upgraded may come back without it, so reading absent as true would refuse the campaign-level form on exactly
 * the campaigns this rule is about. "Absent means Google's default, true" holds only for a campaign AMCP itself creates, whose
 * rows AMCP writes (a build's temporary campaign: src/google-atomic-builds.ts gives its row the value of its own create).
 */
function demandGenLevel(campaign: unknown): 'ad_group' | 'campaign' | 'unread' {
  const settings = object(campaign) ? campaign.demand_gen_campaign_settings : undefined;
  const value = object(settings) ? settings.upgraded_targeting : undefined;
  return value === true ? 'ad_group' : value === false ? 'campaign' : 'unread';
}
/**
 * Where location and language targeting goes, by the campaign's channel as the review read it (R2.5 M3, G6; owner
 * 2026-11-15). Google's Demand Gen pages put `location` and `language` on the AD GROUP (AdGroupCriterion); the owner's live
 * execute of the campaign-level form was refused with `requestError: UNKNOWN` three times. So an ad group's criterion needs
 * its campaign to read DEMAND_GEN, an unread channel refusing (fail closed), and a campaign-level create on a DEMAND_GEN
 * campaign is refused with the ad-group route named. Removals and updates of an existing campaign-level criterion are
 * not creates and stay allowed, for cleanup. VIDEO is not added: nothing confirms it (QUESTIONS Q5, lead 2026-11-17).
 *
 * Round 2, S2-1 (the lead's review of 2026-11-18): that is the rule of a Demand Gen campaign read with upgraded targeting on,
 * which is what a new one has by default. One read with it off (an older one) takes them on the campaign, which is the one route
 * Google accepts there, so there the ad-group form is refused (naming the campaign route) and the campaign-level form is not
 * (`demandGenLevel`). A campaign whose value the review does not read as true or false, an absent one included (the lead's
 * correction of 2026-11-19), refuses neither form. And only a positive campaign-level create is refused on an upgraded
 * campaign: a location exclusion goes to the default validate-only (answer 4, the lead, 2026-11-18), a language exclusion is
 * refused by the contract before this check (Google takes none).
 */
function demandGenLocationRules(plan: CompiledRequest, states: unknown[]) {
  const kind = googleTargetingKind(plan);
  if (kind !== 'adGroupCriteria' && kind !== 'campaignCriteria') return;
  const rows = states.flatMap(s => (s as JsonObject)?.results ?? []).map(r => normalized(r));
  for (const [index, op] of normalized(plan.body).operations.entries()) {
    const r = op.create,
      type = r ? (['location', 'language'] as const).find(k => r[k] !== undefined) : undefined;
    if (!r || !type) continue;
    if (kind === 'adGroupCriteria') {
      const campaign = rows.find(x => x.ad_group?.resource_name === r.ad_group)?.campaign,
        channel = campaign?.advertising_channel_type;
      if (channel === 'DEMAND_GEN') {
        if (demandGenLevel(campaign) !== 'campaign') continue;
        refuse(
          index,
          'This Demand Gen campaign was created without upgraded targeting, so it takes location and language on the campaign, not on its ad groups. Set them through google_ads_v23_campaign_criterion_mutate_campaign_criteria.',
          'create.' + type,
          {channel, upgraded_targeting: false},
        );
      }
      const route = {channel: channel ?? null, allowed_channels: ['DEMAND_GEN']};
      if (typeof channel !== 'string')
        refuse(
          index,
          'The channel of the campaign this ad group belongs to could not be read, so AMCP cannot tell whether the ad group takes location and language. Only a Demand Gen campaign’s ad groups do; set them on any other campaign through google_ads_v23_campaign_criterion_mutate_campaign_criteria.',
          'create.' + type,
          route,
        );
      refuse(
        index,
        'An ad group takes location and language targeting only under a Demand Gen campaign. Set them on the campaign instead, through google_ads_v23_campaign_criterion_mutate_campaign_criteria.',
        'create.' + type,
        route,
      );
    } else {
      const campaign = rows.find(x => x.campaign?.resource_name === r.campaign)?.campaign,
        channel = campaign?.advertising_channel_type;
      // A location exclusion is not refused (the lead's answer 4, 2026-11-18): only the positive form is known to be refused by
      // Google here; the default validate-only answers for the other, which only narrows delivery. A language exclusion never
      // gets this far: its contract refusal comes first.
      if (channel === 'DEMAND_GEN' && demandGenLevel(campaign) === 'ad_group' && r.negative !== true)
        refuse(
          index,
          'A Demand Gen campaign takes location and language on its ad groups, not on the campaign. Create them through google_ads_v23_ad_group_criterion_mutate_ad_group_criteria, one criterion per ad group.',
          'create.' + type,
          {channel},
        );
    }
  }
}
export function validateGoogleTargetingState(plan: CompiledRequest, states: unknown[]) {
  pausedParentsCoverChildren(plan, states);
  demandGenLocationRules(plan, states);
  if (googleTargetingKind(plan) !== 'sharedCriteria') return;
  const body = normalized(plan.body),
    sets = states
      .flatMap(s => (s as JsonObject)?.results ?? [])
      .map(r => normalized(r).shared_set)
      .filter(Boolean);
  for (const [index, op] of body.operations.entries()) {
    if (!op.create) continue;
    const r = op.create,
      parent = sets.find(s => s.resource_name === r.shared_set),
      expected = r.keyword ? 'NEGATIVE_KEYWORDS' : 'NEGATIVE_PLACEMENTS';
    if (parent?.type !== expected || parent.status !== 'ENABLED')
      throw new MirrorError(
        'INVALID_TARGETING_PARENT',
        'The shared list must be enabled and match the criterion type.',
        {
          operation: index,
          field: 'operations[' + index + '].create.shared_set',
          shared_set: r.shared_set,
          expected_type: expected,
        },
      );
  }
}

/**
 * AMCP_GOOGLE_NARROWING_EXEMPT=false is the owner's rollback (WRT-07 Stage D) of what the exemptions of Google targeting writes removed.
 * It restores the spend acknowledgement on every targeting write: a negative-only create (googleTargetingWidens, below) and, since
 * r25-field-pausedspend, a positive keyword or location created under a campaign or ad group the review reads PAUSED
 * (googleCreatesUnderPausedParents). It governs targeting writes only: a campaign, ad group, ad or asset group create is no targeting
 * write and keeps its exemption. The switch is defined in src/google-paused-parents.ts, which this module imports, so that both read it.
 */
export {narrowingExempt};
/**
 * Whether a Google targeting write can widen delivery, and so needs the spend acknowledgement (WRT-07 Stage D, owner
 * decision P5). Only an exact negative-only create narrows: every operation creates a campaign or ad-group criterion
 * with negative: true, or a shared criterion (its list is a negative keyword or placement list, which the review's
 * state read checks before anything is sent). Any removal, update, positive criterion, list attachment or unrecognised
 * shape still asks; removing a negative widens delivery. That is the family's own answer: a positive criterion created under a
 * campaign or ad group the review reads as PAUSED is lifted before it is asked, in src/preflight.ts through
 * googleCreatesUnderPausedParents (and asks again with the rollback switch off).
 */
export function googleTargetingWidens(plan: CompiledRequest): boolean {
  if (!narrowingExempt()) return true;
  const kind = googleTargetingKind(plan);
  let body: JsonObject;
  try {
    body = normalized(plan.body);
  } catch {
    return true;
  }
  const ops = object(body) && Array.isArray(body.operations) ? body.operations : [];
  if (!ops.length) return true;
  return !ops.every(
    (op: unknown) =>
      object(op) &&
      Object.keys(op).length === 1 &&
      object(op.create) &&
      (kind === 'sharedCriteria' ||
        ((kind === 'campaignCriteria' || kind === 'adGroupCriteria') && op.create.negative === true)),
  );
}
/**
 * Whether a Google targeting write activates delivery for the owner's "nothing goes live" switch (allow_activation:
 * false). Removing an exclusion widens delivery: a removed campaign or ad-group criterion counts unless the review's
 * state shows it positive; a removed shared criterion (a negative list's) or a detached list always counts. And, after
 * Q1 (owner 2026-11-15; R2.5 M3, G8), a new positive ad-group criterion that names no status: Google's default for a
 * status left out at create is UNVERIFIED here, so it is read as ENABLED, failing closed. It counts under a parent the
 * review reads as serving or could not read; under a parent it reads as PAUSED nothing newly counts. (An explicit
 * ENABLED is counted by the generic scan of the status field, under a paused parent too; an explicit PAUSED never.)
 */
function googleTargetingActivates(plan: CompiledRequest, before: unknown): boolean {
  const kind = googleTargetingKind(plan);
  let body: JsonObject;
  try {
    body = normalized(plan.body);
  } catch {
    return true;
  }
  const operations: unknown[] = Array.isArray(body?.operations) ? body.operations : [],
    states = (Array.isArray(before) ? before : [before])
      .flatMap(s => (object(s) && Array.isArray(s.results) ? s.results : []))
      .map(r => normalized(r));
  if (
    kind === 'adGroupCriteria' &&
    operations.some(op => {
      const r = object(op) ? op.create : undefined;
      if (!object(r) || r.negative === true || r.status !== undefined) return false;
      const row = states.find(x => x?.ad_group?.resource_name === r.ad_group);
      return parentReading([row?.ad_group?.status, row?.campaign?.status]) !== 'paused';
    })
  )
    return true;
  const removals = operations
    .filter((op): op is JsonObject => object(op) && typeof op.remove === 'string')
    .map(op => op.remove as string);
  if (!removals.length) return false;
  if (kind === 'sharedCriteria' || kind === 'campaignSharedSets') return true;
  if (kind !== 'campaignCriteria' && kind !== 'adGroupCriteria') return false;
  const resource = config[kind].resource,
    rows = states.map(r => r?.[resource]).filter(object);
  return removals.some(name => rows.find(r => r.resource_name === name)?.negative !== false);
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleTargetingFamily: ReviewedFamily = defineFamily({
  name: 'google_targeting',
  files: ['src/google-targeting-writes.ts', ['tests/google-targeting-writes.test.ts']],
  // A mutation of ad group criteria that creates a Standard Shopping listing group is that tree review's (R2.5 M3, G5; the
  // family google_listing_groups serves it as a second request shape), so no request has two owners.
  kind: plan => !!googleTargetingKind(plan) && !googleShoppingTreeKind(plan),
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertGoogleTargeting(plan);
  },
  snapshots: googleTargetingSnapshots,
  activates: googleTargetingActivates,
  spendConfirmation: {
    needed: googleTargetingWidens,
    message: 'Targeting, serving and shared-list changes require spend_change_confirmed=true.',
  },
});
