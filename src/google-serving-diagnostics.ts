import {bad, fingerprint, obj, validate, type ToolCall} from './workspace-core.js';
import {normalizeAccount} from './account-id.js';
import {googleAdsVersion} from './google-version.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {storedLogin} from './connection-authority.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

/**
 * google_serving_diagnostics (CMP-07): why Google entities do or do not serve, as Google reports it. Fixed GAQL
 * projections read the primary status and its reasons, policy summaries, ad strength and action items of campaigns,
 * ad groups, ads, asset groups and asset-group assets of one customer (optionally one campaign), each level one bounded
 * page. Native enum symbols pass through unchanged; a symbol outside the pinned v25 lists below lands in an explicit
 * unknown bucket instead of being dropped or renamed (enum values grow with each API version). Policy evidence text and
 * asset contents are not returned. This is a read: it grants no write authority and saves nothing.
 *
 * The lists are the enums of the pinned Discovery document (.mirror/VENDOR/google-ads-v25.json);
 * tests/google-serving-diagnostics.test.mjs fails when they drift from it.
 */
export const googleServingEnums = {
  campaign: {
    primary_status: [
      'UNSPECIFIED',
      'UNKNOWN',
      'ELIGIBLE',
      'PAUSED',
      'REMOVED',
      'ENDED',
      'PENDING',
      'MISCONFIGURED',
      'LIMITED',
      'LEARNING',
      'NOT_ELIGIBLE',
    ],
    primary_status_reasons: [
      'UNSPECIFIED',
      'UNKNOWN',
      'CAMPAIGN_REMOVED',
      'CAMPAIGN_PAUSED',
      'CAMPAIGN_PENDING',
      'CAMPAIGN_ENDED',
      'CAMPAIGN_DRAFT',
      'BIDDING_STRATEGY_MISCONFIGURED',
      'BIDDING_STRATEGY_LIMITED',
      'BIDDING_STRATEGY_LEARNING',
      'BIDDING_STRATEGY_CONSTRAINED',
      'BUDGET_CONSTRAINED',
      'BUDGET_MISCONFIGURED',
      'SEARCH_VOLUME_LIMITED',
      'AD_GROUPS_PAUSED',
      'NO_AD_GROUPS',
      'KEYWORDS_PAUSED',
      'NO_KEYWORDS',
      'AD_GROUP_ADS_PAUSED',
      'NO_AD_GROUP_ADS',
      'HAS_ADS_LIMITED_BY_POLICY',
      'HAS_ADS_DISAPPROVED',
      'MOST_ADS_UNDER_REVIEW',
      'MISSING_LEAD_FORM_EXTENSION',
      'MISSING_CALL_EXTENSION',
      'LEAD_FORM_EXTENSION_UNDER_REVIEW',
      'LEAD_FORM_EXTENSION_DISAPPROVED',
      'CALL_EXTENSION_UNDER_REVIEW',
      'CALL_EXTENSION_DISAPPROVED',
      'NO_MOBILE_APPLICATION_AD_GROUP_CRITERIA',
      'CAMPAIGN_GROUP_PAUSED',
      'CAMPAIGN_GROUP_ALL_GROUP_BUDGETS_ENDED',
      'APP_NOT_RELEASED',
      'APP_PARTIALLY_RELEASED',
      'HAS_ASSET_GROUPS_DISAPPROVED',
      'HAS_ASSET_GROUPS_LIMITED_BY_POLICY',
      'MOST_ASSET_GROUPS_UNDER_REVIEW',
      'NO_ASSET_GROUPS',
      'ASSET_GROUPS_PAUSED',
      'MISSING_LOCATION_TARGETING',
      'CAMPAIGN_NOT_BOOKED',
      'BOOKING_HOLD_EXPIRING',
      'BOOKING_HOLD_EXPIRED',
      'BOOKING_CANCELLED',
    ],
  },
  ad_group: {
    primary_status: ['UNSPECIFIED', 'UNKNOWN', 'ELIGIBLE', 'PAUSED', 'REMOVED', 'PENDING', 'NOT_ELIGIBLE', 'LIMITED'],
    primary_status_reasons: [
      'UNSPECIFIED',
      'UNKNOWN',
      'CAMPAIGN_REMOVED',
      'CAMPAIGN_PAUSED',
      'CAMPAIGN_PENDING',
      'CAMPAIGN_ENDED',
      'AD_GROUP_PAUSED',
      'AD_GROUP_REMOVED',
      'AD_GROUP_INCOMPLETE',
      'KEYWORDS_PAUSED',
      'NO_KEYWORDS',
      'AD_GROUP_ADS_PAUSED',
      'NO_AD_GROUP_ADS',
      'HAS_ADS_DISAPPROVED',
      'HAS_ADS_LIMITED_BY_POLICY',
      'MOST_ADS_UNDER_REVIEW',
      'CAMPAIGN_DRAFT',
      'AD_GROUP_PAUSED_DUE_TO_LOW_ACTIVITY',
    ],
  },
  ad: {
    primary_status: ['UNSPECIFIED', 'UNKNOWN', 'ELIGIBLE', 'PAUSED', 'REMOVED', 'PENDING', 'LIMITED', 'NOT_ELIGIBLE'],
    primary_status_reasons: [
      'UNSPECIFIED',
      'UNKNOWN',
      'CAMPAIGN_REMOVED',
      'CAMPAIGN_PAUSED',
      'CAMPAIGN_PENDING',
      'CAMPAIGN_ENDED',
      'AD_GROUP_PAUSED',
      'AD_GROUP_REMOVED',
      'AD_GROUP_AD_PAUSED',
      'AD_GROUP_AD_REMOVED',
      'AD_GROUP_AD_DISAPPROVED',
      'AD_GROUP_AD_UNDER_REVIEW',
      'AD_GROUP_AD_POOR_QUALITY',
      'AD_GROUP_AD_NO_ADS',
      'AD_GROUP_AD_APPROVED_LABELED',
      'AD_GROUP_AD_AREA_OF_INTEREST_ONLY',
      'AD_GROUP_AD_UNDER_APPEAL',
    ],
  },
  asset_group: {
    primary_status: ['UNSPECIFIED', 'UNKNOWN', 'ELIGIBLE', 'PAUSED', 'REMOVED', 'NOT_ELIGIBLE', 'LIMITED', 'PENDING'],
    primary_status_reasons: [
      'UNSPECIFIED',
      'UNKNOWN',
      'ASSET_GROUP_PAUSED',
      'ASSET_GROUP_REMOVED',
      'CAMPAIGN_REMOVED',
      'CAMPAIGN_PAUSED',
      'CAMPAIGN_PENDING',
      'CAMPAIGN_ENDED',
      'ASSET_GROUP_LIMITED',
      'ASSET_GROUP_DISAPPROVED',
      'ASSET_GROUP_UNDER_REVIEW',
    ],
  },
  asset_group_asset: {
    primary_status: ['UNSPECIFIED', 'UNKNOWN', 'ELIGIBLE', 'PAUSED', 'REMOVED', 'PENDING', 'LIMITED', 'NOT_ELIGIBLE'],
    primary_status_reasons: [
      'UNSPECIFIED',
      'UNKNOWN',
      'ASSET_LINK_PAUSED',
      'ASSET_LINK_REMOVED',
      'ASSET_DISAPPROVED',
      'ASSET_UNDER_REVIEW',
      'ASSET_APPROVED_LABELED',
    ],
  },
  approval_status: ['UNSPECIFIED', 'UNKNOWN', 'DISAPPROVED', 'APPROVED_LIMITED', 'APPROVED', 'AREA_OF_INTEREST_ONLY'],
  review_status: ['UNSPECIFIED', 'UNKNOWN', 'REVIEW_IN_PROGRESS', 'REVIEWED', 'UNDER_APPEAL', 'ELIGIBLE_MAY_SERVE'],
  policy_topic_type: [
    'UNSPECIFIED',
    'UNKNOWN',
    'PROHIBITED',
    'LIMITED',
    'FULLY_LIMITED',
    'DESCRIPTIVE',
    'BROADENING',
    'AREA_OF_INTEREST_ONLY',
  ],
  ad_strength: ['UNSPECIFIED', 'UNKNOWN', 'PENDING', 'NO_ADS', 'POOR', 'AVERAGE', 'GOOD', 'EXCELLENT'],
};
export type ServingLevel = 'campaign' | 'ad_group' | 'ad' | 'asset_group' | 'asset_group_asset';
export const servingLevels: ServingLevel[] = ['campaign', 'ad_group', 'ad', 'asset_group', 'asset_group_asset'];
const gateway = 'google_ads_native_action';
const maxInt64 = 9223372036854775807n;
const nativeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= maxInt64;
const invalid = (message: string): never => bad(message, 'SERVING_DIAGNOSTICS_INVALID_RESPONSE');
/** The fixed projection of each level: its GAQL resource, selected fields and immutable ordering key. */
const projections: Record<ServingLevel, {resource: string; fields: string[]; order: string}> = {
  campaign: {
    resource: 'campaign',
    fields: [
      'campaign.id',
      'campaign.name',
      'campaign.status',
      'campaign.serving_status',
      'campaign.primary_status',
      'campaign.primary_status_reasons',
      'campaign.bidding_strategy_system_status',
      'campaign.advertising_channel_type',
    ],
    order: 'campaign.id',
  },
  ad_group: {
    resource: 'ad_group',
    fields: [
      'campaign.id',
      'ad_group.id',
      'ad_group.name',
      'ad_group.status',
      'ad_group.primary_status',
      'ad_group.primary_status_reasons',
    ],
    order: 'ad_group.id',
  },
  ad: {
    resource: 'ad_group_ad',
    fields: [
      'campaign.id',
      'ad_group.id',
      'ad_group_ad.ad.id',
      'ad_group_ad.ad.name',
      'ad_group_ad.status',
      'ad_group_ad.primary_status',
      'ad_group_ad.primary_status_reasons',
      'ad_group_ad.policy_summary.approval_status',
      'ad_group_ad.policy_summary.review_status',
      'ad_group_ad.policy_summary.policy_topic_entries',
      'ad_group_ad.ad_strength',
      'ad_group_ad.action_items',
    ],
    order: 'ad_group_ad.ad.id',
  },
  asset_group: {
    resource: 'asset_group',
    fields: [
      'campaign.id',
      'asset_group.id',
      'asset_group.name',
      'asset_group.status',
      'asset_group.primary_status',
      'asset_group.primary_status_reasons',
      'asset_group.ad_strength',
    ],
    order: 'asset_group.id',
  },
  asset_group_asset: {
    resource: 'asset_group_asset',
    fields: [
      'campaign.id',
      'asset_group.id',
      'asset_group_asset.resource_name',
      'asset_group_asset.asset',
      'asset_group_asset.field_type',
      'asset_group_asset.status',
      'asset_group_asset.primary_status',
      'asset_group_asset.primary_status_reasons',
      'asset_group_asset.policy_summary.approval_status',
      'asset_group_asset.policy_summary.review_status',
      'asset_group_asset.policy_summary.policy_topic_entries',
    ],
    order: 'asset_group.id',
  },
};
/** A native enum symbol passed through; anything that is not one is a malformed response. */
function symbol(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(value))
    invalid('Google returned a malformed status symbol.');
  return value as string;
}
function text(value: unknown, max = 2000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) invalid('Google returned a malformed text field.');
  return value as string;
}
function symbols(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) invalid('Google returned malformed status reasons.');
  return (value as unknown[]).map(v => symbol(v) as string).filter(Boolean);
}
function policy(summary: unknown) {
  if (summary === undefined) return null;
  if (!obj(summary)) return invalid('Google returned a malformed policy summary.');
  const entries = summary.policyTopicEntries ?? [];
  if (!Array.isArray(entries) || entries.length > 100) invalid('Google returned malformed policy findings.');
  return {
    approval_status: symbol(summary.approvalStatus),
    review_status: symbol(summary.reviewStatus),
    // Topic and type only: evidence can quote ad text, destinations or trademarks and is read in Google Ads.
    topics: (entries as unknown[]).map(entry => {
      if (!obj(entry)) invalid('Google returned a malformed policy finding.');
      return {topic: text((entry as JsonObject).topic, 200), type: symbol((entry as JsonObject).type)};
    }),
  };
}
function resource(value: unknown, expected: string) {
  if (value !== undefined && value !== expected)
    bad('Google returned a different account or native resource identity.', 'STATE_TARGET_MISMATCH');
}
/** One row of a level, with its customer, campaign and parent identities checked against the request. */
export function servingRow(level: ServingLevel, row: JsonObject, account: string, campaignId?: string): JsonObject {
  const c = row.campaign,
    customer = row.customer;
  if (!obj(customer) || customer.id !== account || !obj(c) || !nativeId(c.id))
    invalid('Google diagnostics require the exact account and campaign IDs.');
  resource(customer.resourceName, 'customers/' + account);
  resource(c.resourceName, 'customers/' + account + '/campaigns/' + c.id);
  if (campaignId && c.id !== campaignId) bad('Google returned a different parent campaign.', 'STATE_TARGET_MISMATCH');
  const enums = googleServingEnums[level],
    parent = (key: string, collection: string) => {
      const p = row[key];
      if (!obj(p) || !nativeId(p.id)) invalid('Google returned a parent without an exact native ID.');
      resource(p.resourceName, 'customers/' + account + '/' + collection + '/' + p.id);
      return p.id as string;
    };
  let main: JsonObject, id: string, name: string | null, status: string | null;
  const out: JsonObject = {level, campaign_id: c.id};
  if (level === 'campaign') {
    main = c;
    id = c.id;
    name = text(c.name);
    status = symbol(c.status);
    Object.assign(out, {
      serving_status: symbol(c.servingStatus),
      bidding_strategy_system_status: symbol(c.biddingStrategySystemStatus),
      advertising_channel_type: symbol(c.advertisingChannelType),
      resource_name: 'customers/' + account + '/campaigns/' + id,
    });
  } else if (level === 'ad_group') {
    main = row.adGroup;
    id = parent('adGroup', 'adGroups');
    name = text(main.name);
    status = symbol(main.status);
    out.resource_name = 'customers/' + account + '/adGroups/' + id;
  } else if (level === 'ad') {
    const groupId = parent('adGroup', 'adGroups');
    main = row.adGroupAd;
    if (!obj(main) || !obj(main.ad) || !nativeId(main.ad.id))
      return invalid('Google returned an incomplete ad record.');
    id = main.ad.id;
    resource(main.resourceName, 'customers/' + account + '/adGroupAds/' + groupId + '~' + id);
    name = text(main.ad.name);
    status = symbol(main.status);
    const items = main.actionItems ?? [];
    if (!Array.isArray(items) || items.length > 20) invalid('Google returned malformed action items.');
    Object.assign(out, {
      ad_group_id: groupId,
      resource_name: 'customers/' + account + '/adGroupAds/' + groupId + '~' + id,
      policy: policy(main.policySummary),
      ad_strength: symbol(main.adStrength),
      // Google-authored suggestions, shown as Google wrote them.
      action_items: (items as unknown[]).map(v => text(v, 500)),
    });
  } else if (level === 'asset_group') {
    main = row.assetGroup;
    id = parent('assetGroup', 'assetGroups');
    name = text(main.name);
    status = symbol(main.status);
    Object.assign(out, {
      resource_name: 'customers/' + account + '/assetGroups/' + id,
      ad_strength: symbol(main.adStrength),
    });
  } else {
    const groupId = parent('assetGroup', 'assetGroups');
    main = row.assetGroupAsset;
    if (!obj(main)) return invalid('Google returned an incomplete asset link.');
    const m = new RegExp(
      '^customers/' + account + '/assetGroupAssets/' + groupId + '~([1-9][0-9]{0,18})~([A-Z_]+)$',
    ).exec(String(main.resourceName));
    if (!m || main.asset !== 'customers/' + account + '/assets/' + m[1] || main.fieldType !== m[2])
      invalid('Google returned an asset link outside this asset group.');
    id = m![1]! + '~' + m![2]!;
    name = null;
    status = symbol(main.status);
    Object.assign(out, {
      asset_group_id: groupId,
      asset_id: m![1],
      field_type: m![2],
      resource_name: main.resourceName,
      policy: policy(main.policySummary),
    });
  }
  if (!obj(main)) invalid('Google returned an incomplete record.');
  const primary = symbol(main.primaryStatus),
    reasons = symbols(main.primaryStatusReasons);
  out.id = id;
  out.name = name;
  out.status = status;
  out.primary_status = primary;
  out.primary_status_reasons = reasons;
  // Symbols this build does not know stay visible, as themselves, in the unknown bucket.
  const unknown = [
    ...(primary !== null && !enums.primary_status.includes(primary) ? [primary] : []),
    ...reasons.filter(r => !enums.primary_status_reasons.includes(r)),
    ...(typeof out.ad_strength === 'string' && !googleServingEnums.ad_strength.includes(out.ad_strength)
      ? [out.ad_strength]
      : []),
    ...(out.policy
      ? [
          ...[out.policy.approval_status].filter(
            (s: unknown) => typeof s === 'string' && !googleServingEnums.approval_status.includes(s),
          ),
          ...[out.policy.review_status].filter(
            (s: unknown) => typeof s === 'string' && !googleServingEnums.review_status.includes(s),
          ),
          ...out.policy.topics
            .map((t: JsonObject) => t.type)
            .filter((s: unknown) => typeof s === 'string' && !googleServingEnums.policy_topic_type.includes(s)),
        ]
      : []),
  ];
  out.unknown_symbols = [...new Set(unknown)];
  return out;
}
/** Counts by primary status and by reason; unknown symbols are counted under their own name and listed. */
export function servingSummary(rows: JsonObject[]): JsonObject {
  const summary: JsonObject = {};
  for (const level of servingLevels) {
    const own = rows.filter(r => r.level === level);
    if (!own.length) continue;
    const by = (values: string[]) => values.reduce<Record<string, number>>((n, v) => ((n[v] = (n[v] ?? 0) + 1), n), {});
    summary[level] = {
      rows: own.length,
      primary_status: by(own.map(r => r.primary_status ?? 'NOT_RETURNED')),
      reasons: by(own.flatMap(r => r.primary_status_reasons)),
      unknown_symbols: [...new Set(own.flatMap(r => r.unknown_symbols))].sort(),
    };
  }
  return summary;
}

/**
 * Reads the diagnostics of one Google customer: each selected level is one bounded page (1–100 rows, default 50) of
 * non-removed entities ordered by immutable ID, optionally under one campaign. A level with more rows says so
 * (has_more) rather than being continued silently.
 */
export async function googleServingDiagnostics(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  const options = input.options ?? {};
  validate(options, ['levels', 'limit'], undefined, 'option');
  const levels: ServingLevel[] = options.levels ?? servingLevels,
    limit = options.limit ?? 50;
  if (
    !Array.isArray(levels) ||
    !levels.length ||
    levels.some(l => !servingLevels.includes(l)) ||
    new Set(levels).size !== levels.length
  )
    bad('Choose one or more distinct levels: campaign, ad_group, ad, asset_group or asset_group_asset.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad('Diagnostics pages contain 1–100 entities per level.');
  if (input.gateway !== undefined && input.gateway !== gateway)
    bad('Serving diagnostics read Google Ads accounts.', 'DIAGNOSTICS_UNSUPPORTED_GATEWAY');
  if (typeof input.account_id !== 'string') bad('Choose an exact Google account ID.');
  const account = normalizeAccount(gateway, input.account_id);
  if (!nativeId(account)) bad('Choose an exact Google account ID.');
  const campaignId = input.campaign_id;
  if (campaignId !== undefined && !nativeId(campaignId)) bad('campaign_id is the numeric Google campaign ID.');
  const connection = store.resolveConnection(actor, gateway, account, input.connection_id);
  const authorization = fingerprint({login: storedLogin(store, connection), scopes: [...connection.scopes].sort()});
  const current = () => {
    const c = store.resolveConnection(actor, gateway, account, connection.id);
    if (fingerprint({login: storedLogin(store, c), scopes: [...c.scopes].sort()}) !== authorization)
      bad('The Google login or permissions changed. Read the diagnostics again.', 'CONNECTION_AUTHORITY_CHANGED');
  };
  const budget = new ReportCollectionBudget(
    undefined,
    fingerprint({actor: actor.userId, account, campaignId, levels, limit, version: googleAdsVersion}),
    () => {},
    {requests: levels.length + 1, rows: levels.length * (limit + 1), elapsed_ms: 60000, bytes: 8 * 1024 * 1024},
  );
  const rows: JsonObject[] = [],
    pages: JsonObject[] = [];
  try {
    await budget.run(async () => {
      for (const level of levels) {
        const p = projections[level],
          where = [
            `${p.resource}.status != 'REMOVED'`,
            ...(level !== 'campaign' ? [`campaign.status != 'REMOVED'`] : []),
            ...(campaignId ? [`campaign.id = ${campaignId}`] : []),
          ],
          query = `SELECT customer.id, ${p.fields.join(', ')} FROM ${p.resource} WHERE ${where.join(' AND ')} ORDER BY ${p.order} LIMIT ${limit + 1}`;
        current();
        const response = await call(
          gateway,
          {
            action: 'google_ads_v23_google_ads_search',
            account_id: account,
            connection_id: connection.id,
            payload: {query},
            aggregate_pages: false,
            dry_run: false,
          },
          actor,
        );
        current();
        if (!response.success)
          bad(
            response.error?.message ?? 'Google diagnostics read failed.',
            response.error?.code ?? 'SERVING_DIAGNOSTICS_FAILED',
          );
        const d = response.data?.data;
        if (
          !obj(d) ||
          response.data?.truncated ||
          d.partialFailureError ||
          d.error ||
          (d.nextPageToken !== undefined && d.nextPageToken !== '')
        )
          bad('Google diagnostics did not return one complete bounded page.', 'SERVING_DIAGNOSTICS_INCOMPLETE');
        const raw: unknown = d.results === undefined && d.totalResultsCount === '0' ? [] : (d.results ?? []);
        if (!Array.isArray(raw) || raw.length > limit + 1) invalid('Google did not return a bounded diagnostics page.');
        budget.rows('page', (raw as unknown[]).length);
        const own = (raw as unknown[]).map(row => {
          if (!obj(row)) invalid('Google returned a malformed diagnostics row.');
          return servingRow(level, row as JsonObject, account, campaignId);
        });
        pages.push({level, query, response_hash: fingerprint(d), returned: own.length});
        rows.push(...own.slice(0, limit));
        pages.at(-1)!.has_more = own.length > limit;
      }
    });
    budget.check();
  } finally {
    budget.close();
  }
  return {
    record_kind: 'google_serving_diagnostics',
    gateway,
    connection_id: connection.id,
    account_id: account,
    campaign_id: campaignId ?? null,
    levels,
    rows,
    summary: servingSummary(rows),
    pages,
    has_more: pages.some(p => p.has_more),
    captured_at: Date.now(),
    network_requests: pages.length,
    meaning:
      'Google’s own primary status, reasons, policy summary and ad strength of current non-removed entities, one bounded page per level. Native symbols are unchanged; unknown_symbols lists any this version of AMCP does not name. Policy evidence and asset contents are not returned. A status explains serving as Google reports it at read time; it is not delivery or performance evidence. Nothing is saved and no write is authorized.',
  };
}
