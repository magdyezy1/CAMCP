import {MirrorError} from './errors.js';
import type {Actor, JsonObject} from './types.js';
import {obj, type ToolCall} from './workspace-core.js';
import {pick, read, type Step} from './campaign-clone-core.js';

// Google Search's campaign clone, its adapter's `campaign.clone` (ARC-01 phase B, wave 4c: moved verbatim from
// src/campaign-clone.ts, which keeps the checks every clone passes and the spec's changes).
// Google Search: the shapes the Google Search recipe creates (campaign-recipes.ts).
const googleBidding: Record<string, string> = {
  MANUAL_CPC: 'manualCpc',
  MAXIMIZE_CONVERSIONS: 'maximizeConversions',
  MAXIMIZE_CONVERSION_VALUE: 'maximizeConversionValue',
  TARGET_SPEND: 'targetSpend',
};
// An ad text asset's other fields (performance label, policy summary) are Google's output (google-ads-v25.json).
const textFields = ['text', 'pinnedField'];
const snakeKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(snakeKeys)
    : obj(v)
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), snakeKeys(x)]),
        )
      : v;
/** The keys of `source` that choose what a Google clone copies, besides campaign_id (the adapter declares them). */
export const googleCloneSelection: readonly string[] = Object.freeze(['ad_group_ids', 'languages']);
const maxInt64 = 9223372036854775807n;
/** A Google ID: digits without a leading zero, within int64 (the rule of src/google-serving-diagnostics.ts). */
const googleId = (value: unknown): string | undefined => {
  const text =
    typeof value === 'number'
      ? Number.isSafeInteger(value)
        ? String(value)
        : ''
      : typeof value === 'string'
        ? value
        : '';
  return /^[1-9][0-9]{0,18}$/.test(text) && BigInt(text) <= maxInt64 ? text : undefined;
};
/**
 * source.ad_group_ids (field fix r25-field-gclone, owner 2026-11-19: copy only the ad groups named): 1 to 1,000 numeric
 * ad group IDs of the source campaign. Left out, or null, every ad group that is not removed is copied, as before.
 */
function adGroupSelection(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const ids = Array.isArray(value) && value.length <= 1000 ? value.map(googleId) : [];
  if (!ids.length || ids.some(id => id === undefined))
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'source.ad_group_ids is a list of 1–1,000 numeric ad group IDs of the source campaign.',
      {field: 'source.ad_group_ids'},
    );
  return [...new Set(ids as string[])];
}
const languageConstant = /^languageConstants\/[1-9][0-9]{0,9}$/;
/**
 * source.languages (field fix r25-field-gclone, owner 2026-11-19): 1 to 100 language constants, each one the source campaign
 * already targets; only those LANGUAGE criteria are copied. Left out, or null, every language is copied, as before.
 */
function languageSelection(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 100 ||
    value.some(v => typeof v !== 'string' || !languageConstant.test(v))
  )
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'source.languages is a list of 1–100 language constants such as languageConstants/1000, each one the source campaign targets.',
      {field: 'source.languages'},
    );
  return [...new Set(value as string[])];
}
/** The ID of an ad group, from its resource name (customers/<customer>/adGroups/<id>). */
const adGroupIdOf = (resourceName: unknown) =>
  String(resourceName ?? '')
    .split('/')
    .at(-1) ?? '';
export async function googleClone(call: ToolCall, actor: Actor, input: JsonObject) {
  const account = String(input.account_id).replace(/-/g, ''),
    id = String(input.source.campaign_id);
  if (!/^\d+$/.test(id))
    throw new MirrorError('INVALID_ARGUMENT', 'source.campaign_id is the numeric Google campaign ID.', {
      field: 'source.campaign_id',
    });
  // The selection is checked before anything is read.
  const adGroupIds = adGroupSelection(input.source.ad_group_ids),
    languages = languageSelection(input.source.languages),
    // GAQL's IN list of numbers is not quoted; the IDs were checked to be digits, so nothing else can enter the query.
    inAdGroups = adGroupIds ? ' AND ad_group.id IN (' + adGroupIds.join(', ') + ')' : '';
  const campaignName = 'customers/' + account + '/campaigns/' + id;
  const search = async (query: string) => {
    const d = await read(call, actor, 'google_ads_native_action', {
      action: 'google_ads_v23_google_ads_search',
      connection_id: input.connection_id,
      account_id: input.account_id,
      payload: {query},
      aggregate_pages: true,
    });
    return (obj(d) && Array.isArray(d.results) ? d.results : []) as JsonObject[];
  };
  const where = " WHERE campaign.resource_name = '" + campaignName + "'";
  const [source] = await search(
    'SELECT campaign.resource_name, campaign.name, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.contains_eu_political_advertising, campaign.network_settings.target_google_search, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign.network_settings.target_partner_search_network, campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas, campaign.target_spend.cpc_bid_ceiling_micros, campaign_budget.amount_micros, campaign_budget.delivery_method, campaign_budget.explicitly_shared FROM campaign' +
      where,
  );
  const c = source?.campaign as JsonObject | undefined;
  if (!c)
    throw new MirrorError('CLONE_SOURCE_NOT_FOUND', 'Campaign ' + id + ' is not in this customer.', {
      field: 'source.campaign_id',
    });
  if (c.advertisingChannelType !== 'SEARCH')
    throw new MirrorError(
      'CLONE_UNSUPPORTED',
      'AMCP clones Google Search campaigns; this one is ' + c.advertisingChannelType + '.',
      {
        field: 'source.campaign_id',
      },
    );
  const bidding = googleBidding[String(c.biddingStrategyType)];
  if (!bidding)
    throw new MirrorError(
      'CLONE_UNSUPPORTED',
      'AMCP clones manual CPC, maximize conversions, maximize conversion value and maximize clicks bidding; this campaign uses ' +
        c.biddingStrategyType +
        '.',
      {field: 'source.campaign_id', supported: Object.keys(googleBidding)},
    );
  const budget = (source!.campaignBudget ?? {}) as JsonObject;
  // Each read below is ordered by ID (field fix r25-field-gclone, owner 2026-11-19). A query names an order only through
  // ORDER BY (Google's GAQL structure page: "The ORDER BY clause specifies the order in which results are returned"), and
  // the clone's step IDs (adgroup_<n>) and the paths of changes.set into a step's operations (/payload/operations/<k>) are
  // positions in these reads: without the clause the same position could name another ad group, keyword or criterion on the
  // next read. Every field ordered by is Sortable in Google's v23 field reference, and is selected too, because Google
  // refuses a field of WHERE or ORDER BY that the SELECT leaves out in some queries (QueryError
  // EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE). The second ordering key breaks a tie: Google documents a criterion ID as the
  // ID of the criterion, not as unique across criterion types, and a keyword or ad ID not as unique across ad groups.
  const criteria = await search(
    'SELECT campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion' +
      where +
      " AND campaign_criterion.status != 'REMOVED'" +
      ' ORDER BY campaign_criterion.criterion_id, campaign_criterion.type',
  );
  if (languages) {
    const targeted = [
        ...new Set(
          criteria
            .map(r => r.campaignCriterion as JsonObject | undefined)
            .filter(k => k?.type === 'LANGUAGE')
            .map(k => String(k?.language?.languageConstant)),
        ),
      ],
      missing = languages.filter(l => !targeted.includes(l));
    if (missing.length)
      throw new MirrorError(
        'CLONE_SOURCE_NOT_FOUND',
        'Some languages in source.languages are not targeted by the source campaign; details.missing lists them, and details.targeted those it does target.',
        {field: 'source.languages', missing, targeted},
      );
  }
  const groups = await search(
    'SELECT ad_group.id, ad_group.resource_name, ad_group.name, ad_group.type, ad_group.cpc_bid_micros, ad_group.status FROM ad_group' +
      where +
      " AND ad_group.status != 'REMOVED'" +
      inAdGroups +
      ' ORDER BY ad_group.id',
  );
  if (adGroupIds) {
    // The read names the source campaign too, so an ad group of another campaign is as missing as one that is removed.
    const found = new Set(groups.map(g => adGroupIdOf((g.adGroup as JsonObject | undefined)?.resourceName))),
      missing = adGroupIds.filter(n => !found.has(n));
    if (missing.length)
      throw new MirrorError(
        'CLONE_SOURCE_NOT_FOUND',
        'Some ad groups in source.ad_group_ids are not in the source campaign, or are removed; details.missing lists them.',
        {
          field: 'source.ad_group_ids',
          missing: missing.slice(0, 100),
          ...(missing.length > 100 ? {missing_count: missing.length} : {}),
        },
      );
  }
  const keywords = await search(
    'SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.ad_group, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.negative, ad_group_criterion.cpc_bid_micros, ad_group_criterion.status FROM ad_group_criterion' +
      where +
      " AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'" +
      inAdGroups +
      ' ORDER BY ad_group.id, ad_group_criterion.criterion_id',
  );
  const ads = await search(
    'SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad_group, ad_group_ad.status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2 FROM ad_group_ad' +
      where +
      " AND ad_group_ad.status != 'REMOVED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'" +
      inAdGroups +
      ' ORDER BY ad_group.id, ad_group_ad.ad.id',
  );
  const response = '/data/results/0/resourceName',
    ref = (sid: string) => ({$ref: sid + '#' + response});
  const step = (sid: string, action: string, operations: JsonObject[], depends: string[] = []): Step => ({
    id: sid,
    kind: 'write',
    gateway: 'google_ads_native_action',
    connection_id: input.connection_id,
    account_id: input.account_id,
    arguments: {action, payload: {operations}},
    depends_on: depends,
  });
  const network = snakeKeys(c.networkSettings ?? {}) as JsonObject,
    strategy = snakeKeys((c as JsonObject)[bidding] ?? {}) as JsonObject;
  const steps: Step[] = [
    step('budget', 'google_ads_v23_campaign_budget_mutate_campaign_budgets', [
      {
        create: {
          name: input.name + ' budget',
          amount_micros: budget.amountMicros,
          delivery_method: budget.deliveryMethod ?? 'STANDARD',
          explicitly_shared: false,
        },
      },
    ]),
    step(
      'campaign',
      'google_ads_v23_campaign_mutate_campaigns',
      [
        {
          create: {
            name: input.name,
            status: 'PAUSED',
            advertising_channel_type: 'SEARCH',
            campaign_budget: ref('budget'),
            [bidding.replace(/[A-Z]/g, ch => '_' + ch.toLowerCase())]: strategy,
            network_settings: network,
            contains_eu_political_advertising: c.containsEuPoliticalAdvertising,
          },
        },
      ],
      ['budget'],
    ),
  ];
  const notCopied: JsonObject[] = [],
    skipped = new Set<string>();
  if (budget.explicitlyShared)
    notCopied.push({entity: 'budget', fields: ['explicitly_shared (the copy has its own budget of the same amount)']});
  const targeting = criteria.flatMap((r): JsonObject[] => {
    const k = r.campaignCriterion as JsonObject;
    if (k.type === 'LOCATION')
      return [
        {
          create: {
            campaign: ref('campaign'),
            location: {geo_target_constant: k.location?.geoTargetConstant},
            ...(k.negative ? {negative: true} : {}),
          },
        },
      ];
    if (k.type === 'LANGUAGE')
      // A language the caller left out of source.languages is not copied; it is not a field AMCP cannot copy, so it is
      // not listed as one.
      return languages && !languages.includes(k.language?.languageConstant)
        ? []
        : [{create: {campaign: ref('campaign'), language: {language_constant: k.language?.languageConstant}}}];
    if (k.type === 'KEYWORD' && k.negative)
      return [
        {
          create: {
            campaign: ref('campaign'),
            negative: true,
            keyword: {text: k.keyword?.text, match_type: k.keyword?.matchType},
          },
        },
      ];
    skipped.add(String(k.type) + (k.negative ? ' (negative)' : '') + ' criteria');
    return [];
  });
  if (skipped.size) notCopied.push({entity: 'targeting', fields: [...skipped]});
  if (targeting.length)
    steps.push(
      step('targeting', 'google_ads_v23_campaign_criterion_mutate_campaign_criteria', targeting, ['campaign']),
    );
  groups.forEach((g, i) => {
    const group = g.adGroup as JsonObject,
      sid = 'adgroup_' + (i + 1);
    steps.push(
      step(
        sid,
        'google_ads_v23_ad_group_mutate_ad_groups',
        [
          {
            create: {
              name: group.name,
              campaign: ref('campaign'),
              status: group.status,
              type: group.type,
              ...(group.cpcBidMicros !== undefined ? {cpc_bid_micros: String(group.cpcBidMicros)} : {}),
            },
          },
        ],
        ['campaign'],
      ),
    );
    const kws = keywords
      .map(k => k.adGroupCriterion as JsonObject)
      .filter(k => k.adGroup === group.resourceName)
      .map(k => ({
        create: {
          ad_group: ref(sid),
          ...(k.negative ? {negative: true} : {status: k.status}),
          keyword: {text: k.keyword?.text, match_type: k.keyword?.matchType},
          ...(k.cpcBidMicros !== undefined && !k.negative ? {cpc_bid_micros: String(k.cpcBidMicros)} : {}),
        },
      }));
    if (kws.length)
      steps.push(step(sid + '_keywords', 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria', kws, [sid]));
    const rsas = ads
      .map(a => a.adGroupAd as JsonObject)
      .filter(a => a.adGroup === group.resourceName)
      .map(a => ({
        create: {
          ad_group: ref(sid),
          status: a.status,
          ad: {
            responsive_search_ad: {
              ...pick(a.ad?.responsiveSearchAd ?? {}, ['path1', 'path2']),
              ...Object.fromEntries(
                (['headlines', 'descriptions'] as const).map(k => [
                  k,
                  ((a.ad?.responsiveSearchAd?.[k] ?? []) as JsonObject[]).map(t => snakeKeys(pick(t, textFields))),
                ]),
              ),
            },
            final_urls: a.ad?.finalUrls ?? [],
          },
        },
      }));
    if (rsas.length) steps.push(step(sid + '_ads', 'google_ads_v23_ad_group_ad_mutate_ad_group_ads', rsas, [sid]));
  });
  return {
    steps,
    notCopied,
    source: {campaign_id: id, ad_groups: groups.length, keywords: keywords.length, ads: ads.length},
    // The positions of the adgroup_<n> steps, in the ID order the read gives, named for the caller (owner 2026-11-19).
    adGroups: groups.map((g, i) => ({
      step_id: 'adgroup_' + (i + 1),
      source_ad_group_id: adGroupIdOf((g.adGroup as JsonObject).resourceName),
      name: (g.adGroup as JsonObject).name,
    })),
  };
}
