import type {
  AccountModel,
  BodyDeletions,
  // Wave 4c round 6 (w4c-arc6-catalog).
  CatalogDestinationFacts,
  EntityWrites,
  PagingFacts,
  ParkedReason,
  ProviderAdapter,
  ProviderApp,
  ProviderGrantFacts,
  ProviderParking,
  ProviderRenewal,
  ProviderStatus,
  ReportAttributionWindows,
} from './provider-adapter.js';
import type {CompiledRequest, JsonObject} from './types.js';
// Wave 4c round 6 (w4c-arc6-tables): the retired actions' facts and their freezing.
import type {RetiredActions} from './provider-adapter.js';
import {deepFrozen} from './frozen-facts.js';

/**
 * The provider adapter registry (ARC-01): one adapter per provider gateway, each with its lifecycle status. This module
 * is a leaf: it imports no provider module and no lifecycle module, so any module may consult it without joining an
 * import cycle (tools/architecture-map.mjs).
 *
 * A parked provider is not offered unless the deployment's AMCP_PROVIDERS (a comma- or space-separated list of
 * provider IDs) names it: it is not listed in tools/list, contracts, capabilities or the website, any tool call that
 * names its gateway is refused with GATEWAY_NOT_OFFERED before its arguments are read (a local read of retained audit
 * history may still filter by it), ScopeGuard refuses every request to it before credentials are fetched, and
 * NativeTransport refuses to send one whichever caller built it. Its reviewed families stay registered, by design: the
 * ledger keeps every family, and the listings that show families filter them by their gateway's status. Its code keeps
 * compiling and its tests keep running with the provider named in AMCP_PROVIDERS. AMCP_PROVIDERS is read at each
 * check, so a process sees one value from its environment.
 */

/** An adapter's account model as declared: its fields as a list. */
type AccountDeclaration = Omit<AccountModel, 'fields'> & {fields?: readonly string[]};

/** A set no module can change after load: ScopeGuard compares requests with these facts. */
function fixedSet(values: readonly string[]): ReadonlySet<string> {
  const set = new Set(values);
  const view: ReadonlySet<string> = Object.freeze({
    has: (value: string) => set.has(value),
    get size() {
      return set.size;
    },
    forEach(fn: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown) {
      set.forEach(value => fn.call(thisArg, value, value, view));
    },
    entries: () => set.entries(),
    keys: () => set.keys(),
    values: () => set.values(),
    [Symbol.iterator]: () => set.values(),
  });
  return view;
}

/**
 * The frozen account model of a provider. A reference pattern must be global (every reference in a string is
 * compared); a path pattern must not be, so it keeps no position between requests. Both are frozen, so a global
 * pattern's lastIndex cannot move: it is read only through matchAll, which clones it (AccountModel.references).
 */
function accountModel(id: string, {fields, ...declared}: AccountDeclaration): AccountModel {
  if (declared.references && !declared.references.global)
    throw new Error('Provider adapter ' + id + ': account references need a global pattern.');
  if (declared.path && (declared.path.global || declared.path.sticky))
    throw new Error('Provider adapter ' + id + ': the account path pattern must not be global or sticky.');
  if (declared.references) Object.freeze(declared.references);
  if (declared.path) Object.freeze(declared.path);
  return Object.freeze({...declared, ...(fields ? {fields: fixedSet(fields)} : {})});
}

/** A provider's OAuth app as frozen facts (SEC-07 S2): its setting table and its unsealed fields included. */
function providerApp(declared: ProviderApp): ProviderApp {
  return Object.freeze({
    ...declared,
    ...(declared.settings ? {settings: Object.freeze({...declared.settings})} : {}),
    ...(declared.unsealed ? {unsealed: Object.freeze([...declared.unsealed])} : {}),
  });
}

/** Body deletions as frozen facts: the field table and each value list. */
function bodyDeletions(declared: BodyDeletions): BodyDeletions {
  return Object.freeze({
    ...declared,
    fields: Object.freeze(
      Object.fromEntries(Object.entries(declared.fields).map(([k, v]) => [k, Object.freeze([...v])])),
    ),
  });
}

// The OAuth scope names the providers' grants use (CON-02, CON-03; src/provider-grants.ts re-exports them), which the
// write and readiness checks of those providers compare with a connection's recorded scopes.
const google = (s: string) => 'https://www.googleapis.com/auth/' + s;
export const gtmWriteScopes = [
  'tagmanager.edit.containers',
  'tagmanager.delete.containers',
  'tagmanager.edit.containerversions',
  'tagmanager.publish',
].map(google);
export const googleAdsScope = google('adwords');
export const dv360Scope = google('display-video');
export const businessScope = google('business.manage');
export const snapchatScope = 'snapchat-marketing-api';
export const microsoftManageScope = 'https://ads.microsoft.com/msads.manage';
export const analyticsScopes = [google('analytics.readonly'), google('analytics')];
export const searchConsoleWriteScope = google('webmasters');
export const appleScope = 'searchadsorg';

function adapter(
  id: string,
  gateway: string,
  options: {
    families?: readonly string[];
    parked?: ProviderParking;
    account?: AccountDeclaration;
    deletions?: BodyDeletions;
    paging?: PagingFacts;
    executionOptions?: true;
    grant?: ProviderGrantFacts;
    app?: ProviderApp;
    renewal?: ProviderRenewal;
    listsActions?: true;
  } = {},
): ProviderAdapter {
  const status: ProviderStatus = options.parked ? 'parked' : 'active';
  return Object.freeze({
    id,
    gateway,
    status,
    ...(options.parked ? {parked: Object.freeze({...options.parked})} : {}),
    familyPrefixes: Object.freeze([...(options.families ?? [id + '_'])]),
    ...(options.account ? {account: accountModel(id, options.account)} : {}),
    ...(options.deletions ? {deletions: bodyDeletions(options.deletions)} : {}),
    // Its entity writes are the table below's entry for its ID (ARC-01 phase B).
    ...(Object.hasOwn(entityWriteRoutes, id) ? {entityWrites: Object.freeze({...entityWriteRoutes[id]!})} : {}),
    // Its facts of the review's summary and spending stages, the table below's entry for its ID (ARC-01 phase B).
    ...(Object.hasOwn(reviewStageFacts, id) ? reviewStageFacts[id] : {}),
    ...(options.paging ? {paging: Object.freeze({...options.paging})} : {}),
    ...(options.executionOptions ? {executionOptions: true as const} : {}),
    // The grant's scope lists stay the declared arrays, as the grant registry kept them.
    ...(options.grant ? {grant: Object.freeze({...options.grant})} : {}),
    // ARC-01 phase B, the website platforms' OAuth apps (SEC-07 S2): frozen with their setting table and field list.
    ...(options.app ? {app: providerApp(options.app)} : {}),
    // ARC-01 phase B, the login and connection modules: how its logins renew without the user (CON-02).
    ...(options.renewal ? {renewal: Object.freeze({...options.renewal})} : {}),
    ...(options.listsActions ? {listsActions: true as const} : {}),
    // Wave 4c round 6 (w4c-arc6-tables): its withdrawn methods and unsupported aliases, the table below's entry for its ID.
    ...(Object.hasOwn(retiredActionFacts, id) ? {retired: deepFrozen(retiredActionFacts[id]!)} : {}),
    // Wave 4c round 6 (w4c-arc6-workspace): its facts of shared rules, the table's entry for its ID.
    ...(Object.hasOwn(sharedRuleFacts, id) ? sharedRuleFacts[id] : {}),
    // Wave 4c round 6 (w4c-arc6-catalog): its catalog destination (COM-03), the table below's entry for its ID.
    ...(Object.hasOwn(catalogDestinationFacts, id)
      ? {catalogDestination: Object.freeze({...catalogDestinationFacts[id]!})}
      : {}),
    // Wave 4c round 6 (w4c-arc6-reporting): its reports' explicit attribution windows, the table below's entry.
    ...(Object.hasOwn(reportWindowFacts, id) ? {reportWindows: reportWindowFacts[id]} : {}),
  });
}

/**
 * The generic entity writes of seven platforms (ARC-01 phase B: they were branches of src/reviewed-routes.ts), by
 * provider ID: the creations, edits and deletions of campaigns, ad groups, ads and creatives that no registered family
 * claims, which each gateway's generic reads, checks and projections serve. `claims` reads only the write's method,
 * path and action. reviewedWriteFamily keeps the read-only and special-transport exclusions and the registered families
 * first; tests/provider-entity-writes.test.mjs compares every reviewed route with the branches as they were.
 */
const entityWriteRoutes: Readonly<Record<string, EntityWrites>> = {
  google: {
    family: 'google_entities',
    claims: p =>
      p.method === 'POST' &&
      /^\/v\d+\/customers\/[^/]+\/(campaigns|adGroups|adGroupAds|campaignBudgets|ads|assetGroups|assets):mutate$/.test(
        p.path,
      ),
  },
  meta: {
    family: 'meta_entities',
    claims: p =>
      (p.method === 'POST' && /^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads|adcreatives)$/.test(p.path)) ||
      (['POST', 'DELETE'].includes(p.method) && /^meta_(campaign_id|ad_set_id|ad_id)_(update|delete)$/.test(p.action)),
  },
  snapchat: {
    family: 'snapchat_entities',
    claims: p =>
      (p.method === 'POST' &&
        /^\/v1\/(adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives|lead_generation_forms|segments)|campaigns\/[^/]+\/adsquads|adsquads\/[^/]+\/ads)$/.test(
          p.path,
        )) ||
      (p.method === 'PUT' && /^\/v1\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives|segments)$/.test(p.path)) ||
      (p.method === 'PATCH' && /^\/v1\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives)\/[^/]+$/.test(p.path)) ||
      (p.method === 'DELETE' && /^\/v1\/(campaigns|adsquads|ads)\/[^/]+$/.test(p.path)),
  },
  // Status changes (ENABLE, DISABLE, DELETE) belong to tiktok_entity_status (src/tiktok-entity-status.ts).
  tiktok: {
    family: 'tiktok_entities',
    claims: p => p.method === 'POST' && /^\/v1\.3\/(campaign|adgroup|ad)\/(create|update)\/$/.test(p.path),
  },
  x: {
    family: 'x_entities',
    claims: p =>
      (p.method === 'POST' && /^\/12\/accounts\/[^/]+\/(campaigns|line_items|targeting_criteria)$/.test(p.path)) ||
      (['PUT', 'DELETE'].includes(p.method) && /^\/12\/accounts\/[^/]+\/(campaigns|line_items)\/[^/]+$/.test(p.path)) ||
      (p.method === 'DELETE' && /^\/12\/accounts\/[^/]+\/(targeting_criteria|promoted_tweets)\/[^/]+$/.test(p.path)),
  },
  linkedin: {
    family: 'linkedin_entities',
    claims: p =>
      (p.method === 'POST' && /^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups|creatives)$/.test(p.path)) ||
      (['POST', 'PUT', 'PATCH', 'DELETE'].includes(p.method) &&
        /^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups|creatives)\/[^/]+$/.test(p.path)),
  },
  dv360: {
    family: 'dv360_entities',
    claims: p =>
      (p.method === 'POST' &&
        /^\/v\d+\/advertisers\/[^/]+\/(campaigns|insertionOrders|lineItems|creatives)$/.test(p.path)) ||
      (['PATCH', 'DELETE'].includes(p.method) &&
        /^\/v\d+\/advertisers\/[^/]+\/(campaigns|insertionOrders|lineItems|creatives)\/[^/]+$/.test(p.path)),
  },
};

// The entity each Google Ads service's :mutate names, for the review summary.
const googleMutateKinds: Record<string, string> = {
  campaigns: 'campaign',
  adGroups: 'ad group',
  adGroupAds: 'ad group ad',
  campaignBudgets: 'campaign budget',
  ads: 'ad',
  assets: 'asset',
  assetGroups: 'asset group',
  campaignCriteria: 'campaign criterion',
  adGroupCriteria: 'ad group criterion',
  sharedSets: 'shared set',
  sharedCriteria: 'shared criterion',
  campaignSharedSets: 'campaign shared set',
};
/**
 * A Google Ads request's operations: for a :mutate each a create, a remove or an update, one entity kind per service; for the
 * generation of shareable previews, which is no :mutate and lists no operations, that it generates the previews its body
 * lists (one for each, or one when it lists none). The review of a generation read "Change 1  in account …", an entity
 * blank between two spaces, because the branch below knew only the :mutate (r12-gpreview, found live 2026-11-16).
 */
function googleMutateOperations(plan: CompiledRequest): {operation: string; entity: string; count: number} {
  const body = plan.body as unknown;
  if (/\/customers\/\d+:generateShareablePreviews$/.test(plan.path)) {
    // The request keeps the caller's spelling of its fields (camelCase or snake_case), and Google Ads takes both.
    const operation = !!body && typeof body === 'object' ? (body as JsonObject).operation : undefined,
      listed =
        !!operation && typeof operation === 'object'
          ? ((operation as JsonObject).shareablePreviews ?? (operation as JsonObject).shareable_previews)
          : undefined;
    return {
      operation: 'generate',
      entity: 'shareable preview',
      count: Array.isArray(listed) && listed.length ? listed.length : 1,
    };
  }
  const kind = /\/([A-Za-z]+):mutate$/.exec(plan.path)?.[1] ?? '',
    operations =
      !!body && typeof body === 'object' && !Array.isArray(body) && Array.isArray((body as JsonObject).operations)
        ? ((body as JsonObject).operations as JsonObject[])
        : [];
  const ops = operations.map((op: JsonObject) =>
    op?.create !== undefined ? 'create' : op?.remove !== undefined ? 'remove' : 'update',
  );
  const kinds = [...new Set(ops)];
  return {
    operation: kinds.length === 1 ? (kinds[0] as string) : 'change',
    entity: googleMutateKinds[kind] ?? kind,
    count: ops.length || 1,
  };
}
/**
 * Q14, owner 2026-11-15: a TikTok create that cannot start spend. Its body pins what it creates paused: a campaign, or a
 * Smart+ campaign, ad group or ad, created DISABLE, or a standard ad group or ad created DISABLE or ENABLE. The ENABLE
 * child is allowed only under a parent the review reads as paused: src/paused-parents.ts checks that when the state is
 * read, at prepare and again at execute, before anything is sent, and refuses a serving or unread parent (PARENT_SERVING).
 * A key named budget_mode or budget in such a create, or its ENABLE under a paused parent, names no spend, so the
 * spending field-name match skips it. The owner's caps, allow_activation, and the flag on every ENABLE of an existing
 * object (a status update) and on every update that widens spend are other rules, not touched here.
 */
const tiktokCreateRoute = /^\/v1\.3\/(?:smart_plus\/)?(?:campaign|adgroup|ad)\/create\/$/;
function tiktokPausedCreation(plan: CompiledRequest): boolean {
  const body = plan.body;
  if (plan.method !== 'POST' || !tiktokCreateRoute.test(plan.path) || !parentRecord(body)) return false;
  // The standard ad group and ad are the paused-parent levels (their statuses are the ones that rule names).
  const child = providerOf(plan.gateway)?.pausedParents?.(plan),
    statuses: unknown[] = child ? child.statuses(body) : [body.operation_status],
    allowed: unknown[] = child ? [child.paused, child.active] : ['DISABLE'];
  return statuses.length === 1 && allowed.includes(statuses[0]);
}
/**
 * The owner's decision of 2026-11-19 (R2.5 field fix r25-field-pausedspend), Q14's principle for Google: a campaign create can start no
 * spend. The write shape pins every create's status PAUSED (googleWriteShape: PAUSED_CREATION_REQUIRED for anything else), and the budget
 * and bidding strategy it names move no money until the campaign is enabled, which is a reviewed write of its own that asks for
 * spend_change_confirmed (an update of an existing campaign's status is a delivery edit). So the spending field-name match skips it, as it
 * skips TikTok's creates. It needs no state, the shape being the proof, and it holds for the campaigns route alone and only for a request
 * whose every operation is a create that names PAUSED: an update, a removal or an operation that is two things is no create, and the request
 * keeps asking. The owner's caps, allow_activation, and the flag on every ENABLE and every budget or bid edit of an existing object are
 * other rules, not touched here.
 */
const googleCampaignCreateRoute = /^\/v\d+\/customers\/\d+\/campaigns:mutate$/;
function googlePausedCreation(plan: CompiledRequest): boolean {
  const body = plan.body;
  if (plan.method !== 'POST' || !googleCampaignCreateRoute.test(plan.path) || !parentRecord(body)) return false;
  const operations = body.operations;
  return (
    Array.isArray(operations) &&
    operations.length > 0 &&
    operations.every(
      op =>
        parentRecord(op) && Object.keys(op).length === 1 && parentRecord(op.create) && op.create.status === 'PAUSED',
    )
  );
}
/**
 * The facts of the review's summary and spending stages (ARC-01 phase B: branches of src/review-summary.ts,
 * src/preflight.ts and src/spend-effects.ts), by provider ID, each moved unchanged and frozen here; each adapter takes
 * its ID's entry. tests/provider-review-stages.test.mjs compares every stage with its branch as it was.
 */
const reviewStageFacts: Readonly<
  Record<
    string,
    Pick<ProviderAdapter, 'reviewOperations' | 'everyWriteConfirmsSpend' | 'spendNeutralCreation' | 'pausedCreation'>
  >
> = {
  google: {reviewOperations: Object.freeze({summarize: googleMutateOperations}), pausedCreation: googlePausedCreation},
  reddit: {everyWriteConfirmsSpend: true},
  // A new Meta campaign's top-level is_adset_budget_sharing_enabled: false names a budget but moves no money: each ad
  // set spends only its own budget, as every campaign did before Graph API v24.0 made the choice explicit (CMP-01).
  meta: {
    spendNeutralCreation: Object.freeze({
      path: Object.freeze(/^\/v[^/]+\/act_[^/]+\/campaigns$/),
      field: 'is_adset_budget_sharing_enabled',
      value: false,
    }),
  },
  tiktok: {pausedCreation: tiktokPausedCreation},
};

// Wave 4c round 6 (w4c-arc6-tables): each provider's withdrawn methods and unsupported aliases, moved unchanged from
// src/retired-provider-actions.ts, which lists them in this table's key order, each row after its provider's gateway;
// each adapter takes its ID's entry, frozen. tests/provider-tables.test.mjs compares the listed tables with the old ones.
const lifecycleReplacement =
  'In v25 new customer acquisition is a goal: a NEW_CUSTOMER_ACQUISITION goal (google_ads_v23_goal_mutate_goals) and its campaign settings (google_ads_v23_campaign_goal_config_mutate_campaign_goal_configs). Both are reviewed writes: create the goal with google_ads_v23_goal_mutate_goals, then link each campaign with google_ads_v23_campaign_goal_config_mutate_campaign_goal_configs.';
const retiredActionFacts: Readonly<Record<string, RetiredActions>> = {
  // X Ads API v5 reached end of life on 2020-03-03 (X Ads API Versioning, read 2026-10-08); AMCP sends v12, yet the
  // captured catalog still routed the two recommendation reads to /5/ (PRV-04, src/provider-deprecations.ts).
  x: {
    actions: (
      [
        ['x_accounts_account_id_recommendations_get', '^/5/accounts/[^/]+/recommendations$'],
        ['x_accounts_account_id_recommendations_recommendation_id_get', '^/5/accounts/[^/]+/recommendations/[^/]+$'],
      ] as const
    ).map(([action, path]) => ({
      action,
      method: 'GET',
      path: new RegExp(path),
      source: 'https://docs.x.com/x-ads-api/fundamentals/versioning',
      updated: '2020-03-03',
      checked: '2026-10-08',
      reason: 'X Ads API v5 reached end of life on 2020-03-03; AMCP sends v12, and v12 has no recommendations route.',
      replacement:
        'No current X Ads API equivalent has been established; review the account in X Ads Manager. AMCP does not invent a v12 route.',
    })),
  },
  // Google documents these Tag Manager methods as no longer supported; their refusal says the provider's words below.
  gtm: {
    actions: [
      {
        action: 'COMBINE_CONTAINERS',
        method: 'POST',
        path: /^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+:combine$/,
        source:
          'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers/combine',
        updated: '2026-08-25',
      },
      {
        action: 'MOVE_TAG_ID',
        method: 'POST',
        path: /^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+:move_tag_id$/,
        source:
          'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers/move_tag_id',
        updated: '2026-08-25',
      },
      {
        action: 'LINK_DESTINATION',
        method: 'POST',
        path: /^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+\/destinations:link$/,
        source:
          'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.destinations/link',
        updated: '2026-06-04',
      },
      {
        action: 'GET_DESTINATION',
        method: 'GET',
        path: /^\/tagmanager\/v2\/accounts\/[^/]+\/containers\/[^/:]+\/destinations\/[^/:]+$/,
        source:
          'https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.destinations/get',
        updated: '2026-06-04',
      },
    ],
    checked: '2026-09-19',
    reason: 'Google documents this method as no longer supported. A historical mapping cannot make it executable.',
    replacement:
      'Use the current Google tag management interface and supported list/get workflows; no equivalent API mutation has been established.',
  },
  google: {
    // Google Ads API v25 has no lifecycle goal methods, schemas or GAQL rows (pinned v25 Discovery document, revision
    // 20260923, compared with the v23 one); its Goal and CampaignGoalConfig resources gained new customer acquisition.
    actions: (['customer', 'campaign'] as const).map(kind => ({
      action: 'google_ads_v23_' + kind + '_lifecycle_goal_configure_' + kind + '_lifecycle_goals',
      method: 'POST',
      path: new RegExp(
        '^/v\\d+/customers/[^/]+/' +
          kind +
          'LifecycleGoal:configure' +
          (kind === 'customer' ? 'Customer' : 'Campaign') +
          'LifecycleGoals$',
      ),
      source: 'https://googleads.googleapis.com/$discovery/rest?version=v25',
      updated: '2026-09-23',
      reason: 'Google Ads API v25 no longer has lifecycle goal configuration.',
      replacement: lifecycleReplacement,
    })),
    // Legacy names that do not correspond to an operation of the current version: captured aliases that never did, and
    // aliases whose operation a newer version removed.
    aliases: [
      {
        action: 'UPDATE_CUSTOMIZER_ATTRIBUTE',
        version: 'v25',
        source:
          'https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/v25/services/customizer_attribute_service.proto (sha256 7eb3650bd6eee98d0ec2d60b785e2934cf91c8dc07ae75a42447bac779c1b2aa)',
        checked_at: '2026-09-28',
        reason:
          'The v25 CustomizerAttributeOperation oneof contains create and remove only. An update_mask field or broad service comment does not define an update operation.',
        replacement:
          'Create a new attribute with the correct name/type. Separately review replacement customizer associations and affected ads before considering removal of the old attribute. AMCP does not automatically migrate or delete it.',
      },
      ...(['CUSTOMER', 'CAMPAIGN'] as const).flatMap(kind => [
        {
          action: 'CONFIGURE_' + kind + '_LIFECYCLE_GOAL',
          version: 'v25',
          source: 'https://googleads.googleapis.com/$discovery/rest?version=v25',
          checked_at: '2026-09-28',
          reason: 'Google Ads API v25 no longer has lifecycle goal configuration.',
          replacement: lifecycleReplacement,
        },
        {
          action: 'LIST_' + kind + '_LIFECYCLE_GOALS',
          version: 'v25',
          source:
            'https://googleads.googleapis.com/$discovery/rest?version=v25 (GoogleAdsRow has no lifecycle goal rows)',
          checked_at: '2026-09-28',
          reason: 'Google Ads API v25 no longer has lifecycle goals to read.',
          replacement:
            'Read goals and their campaign settings with RUN_GAQL_QUERY: FROM goal, and FROM campaign_goal_config.',
        },
      ]),
      {
        action: 'SET_CAMPAIGN_BRAND_SAFETY',
        version: 'v25',
        source:
          'https://googleads.googleapis.com/$discovery/rest?version=v25 (Campaign has no videoBrandSafetySuitability)',
        checked_at: '2026-09-28',
        reason:
          'Google Ads API v25 removed the campaign-level video brand safety setting; only the account-level one remains.',
        replacement:
          "Set the account's videoBrandSafetySuitability with a reviewed customer change (google_ads_v23_customer_mutate_customer), or exclude content labels per campaign (SET_CAMPAIGN_CONTENT_LABEL_EXCLUSIONS).",
      },
    ],
    checked: '2026-09-28',
  },
  // LinkedIn deprecated its unversioned Marketing APIs on 2024-12-16; the current pages (li-lms-2026-05) for these
  // resources document only the versioned /rest routes, and the Content APIs replace adCreativesV2 (read 2026-09-29).
  // Other /v2 routes stay: geo is still documented under /v2, and me, people, endorsement, shares, ugcPosts and
  // adLiftTestBenchmark were not confirmed withdrawn (F-58).
  linkedin: {
    actions: (
      [
        [
          'ad_campaigns_v2_post',
          'POST',
          '^/v2/adCampaignsV2$',
          'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_post',
        ],
        [
          'ad_campaigns_v2_campaign_id_post',
          'POST',
          '^/v2/adCampaignsV2/[^/]+$',
          'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
        ],
        [
          'ad_creatives_v2_post',
          'POST',
          '^/v2/adCreativesV2$',
          'linkedin_rest_ad_accounts_ad_account_id_creatives_post',
        ],
        ['dmp_segments_post', 'POST', '^/v2/dmpSegments$', 'linkedin_rest_dmp_segments_post'],
        [
          'dmp_segments_segment_id_companies_post',
          'POST',
          '^/v2/dmpSegments/[^/]+/companies$',
          'linkedin_rest_dmp_segments_segment_id_companies_post',
        ],
        [
          'dmp_segments_segment_id_users_post',
          'POST',
          '^/v2/dmpSegments/[^/]+/users$',
          'linkedin_rest_dmp_segments_segment_id_users_post',
        ],
        [
          'dmp_segments_segment_id_destinations_destination_id_get',
          'GET',
          '^/v2/dmpSegments/[^/]+/destinations/[^/]+$',
          'linkedin_rest_dmp_segments_segment_id_destinations_destination_id_get',
        ],
        [
          'dmp_segments_dmp_segment_id_list_uploads_list_id_delete',
          'DELETE',
          '^/v2/dmpSegments/[^/]+/listUploads/[^/]+$',
          'linkedin_rest_dmp_segments_dmp_segment_id_list_uploads_list_id_get (read); AMCP’s catalog has no versioned list upload deletion',
        ],
        [
          'organizational_entity_acls_get',
          'GET',
          '^/v2/organizationalEntityAcls$',
          'linkedin_rest_organization_acls_get',
        ],
        [
          'organizational_entity_acls_post',
          'POST',
          '^/v2/organizationalEntityAcls$',
          'linkedin_rest_organization_acls_organization_organization_urn_role_direct_content_poster_role_assignee_person_urn_put (not yet a reviewed write in AMCP)',
        ],
      ] as const
    ).map(([action, method, path, replacement]) => ({
      action: 'linkedin_v2_' + action,
      method,
      path: new RegExp(path),
      source: 'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/migrations?view=li-lms-2026-05',
      updated: '2024-12-16',
      reason:
        'LinkedIn deprecated its unversioned Marketing APIs on 2024-12-16; the current documentation has only the versioned /rest route.',
      replacement: 'Use ' + replacement + '.',
    })),
    checked: '2026-09-19',
  },
};

// ---- Wave 4c round 6 (w4c-arc6-workspace) ----
// The paused-parent rule's records (moved verbatim from src/paused-parents.ts).
const parentRecord = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/** Snapchat wraps each record: {campaigns: [{sub_request_status, campaign}]}. */
const snapRow = (states: unknown[], kind: string, singular: string, id?: unknown): JsonObject | undefined =>
  states
    .flatMap(s => (parentRecord(s) && Array.isArray(s[kind]) ? s[kind] : []))
    .map(r => (parentRecord(r) && parentRecord(r[singular]) ? r[singular] : r))
    .find((r): r is JsonObject => parentRecord(r) && (id === undefined || String(r.id) === String(id)));
/** A TikTok campaign or ad group record; an ad group also names its campaign_id, so a campaign is one without an
 * adgroup_id. */
const tiktokRow = (states: unknown[], key: 'campaign_id' | 'adgroup_id', id: unknown): JsonObject | undefined =>
  states
    .flatMap(s => (parentRecord(s) && parentRecord(s.data) && Array.isArray(s.data.list) ? s.data.list : []))
    .find(
      (r): r is JsonObject =>
        parentRecord(r) && String(r[key]) === String(id) && (key === 'adgroup_id' || r.adgroup_id === undefined),
    );
const metaRow = (states: unknown[], id: unknown): JsonObject | undefined =>
  states.find((s): s is JsonObject => parentRecord(s) && String(s.id) === String(id));
const statusesOf = (rows: unknown, field: string) =>
  Array.isArray(rows) ? rows.map(r => (parentRecord(r) ? r[field] : undefined)) : [];
/**
 * The facts of shared rules (ARC-01 phase B, wave 4c round 6: they were branches of src/paused-parents.ts and
 * src/budget-units.ts), by provider ID, moved unchanged; each adapter takes its ID's entry. `pausedParents` reads a POST
 * child create (src/paused-parents.ts checks the method first).
 */
const sharedRuleFacts: Readonly<Record<string, Pick<ProviderAdapter, 'pausedParents' | 'currencyOffsetBudgets'>>> = {
  snapchat: {
    pausedParents: plan => {
      const squad = /^\/v1\/campaigns\/([^/]+)\/adsquads$/.exec(plan.path)?.[1];
      if (squad !== undefined)
        return {
          child: 'ad squad',
          parent: 'campaign',
          field: 'status',
          active: 'ACTIVE',
          paused: 'PAUSED',
          statuses: b => statusesOf(b.adsquads, 'status'),
          parentRow: (_, s) => snapRow(s, 'campaigns', 'campaign', squad),
        };
      const ad = /^\/v1\/adsquads\/([^/]+)\/ads$/.exec(plan.path)?.[1];
      if (ad !== undefined)
        return {
          child: 'ad',
          parent: 'ad squad',
          field: 'status',
          active: 'ACTIVE',
          paused: 'PAUSED',
          statuses: b => statusesOf(b.ads, 'status'),
          parentRow: (_, s) => snapRow(s, 'adsquads', 'adsquad', ad),
          campaign: {
            id: p => p.campaign_id,
            read: (r, id) => ({...r, path: '/v1/campaigns/' + id}),
            row: (s, id) => snapRow(s, 'campaigns', 'campaign', id),
          },
        };
      return undefined;
    },
  },
  meta: {
    pausedParents: plan => {
      const level = /^\/v[^/]+\/act_[^/]+\/(adsets|ads)$/.exec(plan.path)?.[1];
      if (level === 'adsets')
        return {
          child: 'ad set',
          parent: 'campaign',
          field: 'status',
          active: 'ACTIVE',
          paused: 'PAUSED',
          statuses: b => [b.status],
          parentRow: (b, s) => metaRow(s, b.campaign_id),
        };
      if (level === 'ads')
        return {
          child: 'ad',
          parent: 'ad set',
          field: 'status',
          active: 'ACTIVE',
          paused: 'PAUSED',
          statuses: b => [b.status],
          parentRow: (b, s) => metaRow(s, b.adset_id),
          campaign: {
            id: p => p.campaign_id,
            read: (r, id) => ({...r, path: r.path.replace(/[^/]+$/, id), query: {fields: 'id,name,status'}}),
            row: metaRow,
          },
        };
      return undefined;
    },
    // Its money counts the account currency's minor unit, the offset of its pinned currency capture (WRT-07 Stage C).
    currencyOffsetBudgets: true,
  },
  tiktok: {
    pausedParents: plan => {
      if (plan.path === '/v1.3/adgroup/create/')
        return {
          child: 'ad group',
          parent: 'campaign',
          field: 'operation_status',
          active: 'ENABLE',
          paused: 'DISABLE',
          statuses: b => [b.operation_status],
          parentRow: (b, s) => tiktokRow(s, 'campaign_id', b.campaign_id),
        };
      if (plan.path === '/v1.3/ad/create/')
        return {
          child: 'ad',
          parent: 'ad group',
          field: 'operation_status',
          active: 'ENABLE',
          paused: 'DISABLE',
          statuses: b => statusesOf(b.creatives, 'operation_status'),
          parentRow: (b, s) => tiktokRow(s, 'adgroup_id', b.adgroup_id),
          campaign: {
            id: p => p.campaign_id,
            read: (r, id) => ({
              ...r,
              action: 'tiktok_campaign_get',
              path: '/v1.3/campaign/get/',
              query: {advertiser_id: r.query?.advertiser_id, filtering: {campaign_ids: [id]}, page_size: 100},
            }),
            row: (s, id) => tiktokRow(s, 'campaign_id', id),
          },
        };
      return undefined;
    },
  },
};

// Wave 4c round 6 (w4c-arc6-catalog): the catalog destinations (COM-03; the table of src/catalog-destinations.ts), by
// provider ID, each moved unchanged; each adapter takes its ID's entry, and catalogDestinationOrder lists them.
// tests/catalog-destination-contract.test.mjs holds each projection and the website to its destination.
const catalogShared = ['retailer_id', 'name', 'price', 'currency', 'image_url'] as const,
  catalogDescribed = ['url', 'availability', 'condition', 'brand', 'description'] as const,
  // An optional sale in the product currency with literal start and end times (COM-02 A).
  catalogSale = ['sale_price', 'sale_price_start_date', 'sale_price_end_date'] as const;
const catalogDestinationFacts: Readonly<Record<string, CatalogDestinationFacts>> = {
  meta: {
    sourceFields: {
      required: catalogShared,
      optional: [...catalogDescribed, 'retailer_product_group_id', ...catalogSale],
    },
    catalogId: /^[1-9][0-9]{0,31}$/,
    identity: {source: 'retailer_id', native: 'product_id', pattern: /^[1-9][0-9]{0,31}$/},
    writes: 'reviewed_steps',
    upsert: 'explicit_choice',
    // Meta has no product delete contract: a discontinued product is retired (COM-02 B).
    removal: 'retire',
    // Owner decision P9 (2026-10-11): a populated Meta attribute the source does not send puts a product that otherwise
    // matches in the review set as `unknown`, because Meta does not say whether an upsert keeps or clears it; before P9
    // it was only a note on a matching product (COM-01). The native review of the upsert warns about the same values.
    destinationOnlyValues: 'review',
    // A gateway that is not a catalog destination keeps the Meta refusal it had before the destination contract.
    fallback: true,
    // One product create per step, its payload the product.
    stepRetailerId: payload => payload?.retailer_id,
  },
  x: {
    sourceFields: {required: [...catalogShared, ...catalogDescribed], optional: catalogSale},
    catalogId: /^[1-9][0-9]{0,24}$/,
    identity: {source: 'retailer_id', native: 'product_key', pattern: /^[1-9][0-9]{0,24}$/},
    writes: 'reviewed_steps',
    upsert: 'required',
    removal: 'retire_and_selected_deletion',
    destinationOnlyValues: 'note',
    // One product put per step, its payload a list of the one product.
    stepRetailerId: payload => (Array.isArray(payload?.products) ? payload.products[0]?.id : undefined),
  },
  // COM-02 D: Snapchat products change only through product feeds, so its comparison is read-only and names what to fix
  // in the feed. Its sale is a sale price only: the read format of Snapchat sale dates is not qualified.
  snapchat: {
    sourceFields: {required: catalogShared, optional: [...catalogDescribed, 'sale_price']},
    catalogId: /^[A-Za-z0-9-]{1,64}$/,
    identity: {source: 'retailer_id', native: 'retailer_id', pattern: /^[^\u0000-\u001f\u007f]{1,100}$/},
    writes: 'feed_only',
    upsert: 'none',
    removal: 'none',
    destinationOnlyValues: 'note',
  },
};

/**
 * Wave 4c round 6 (w4c-arc6-reporting): the attribution windows a provider's reports take as an explicit selection
 * (RPT-07), by provider ID, moved unchanged from src/meta-attribution-windows.ts, which re-exports Meta's. The Meta
 * Insights windows: Meta removed the 7-day and 28-day view windows on 2026-01-12 and retains 1-day, 7-day and 28-day
 * click, 1-day view and 1-day engaged-view (`1d_ev`) (Meta for Developers blog, 2025-10-16). A selection names at most
 * one click window, plus the optional view and engaged-view windows; the canonical order below is the order AMCP sends
 * and labels them in. tests/overview-attribution-windows.test.mjs compares them with the module as it was.
 */
const metaAttributionWindows = Object.freeze(['1d_click', '7d_click', '28d_click', '1d_view', '1d_ev']);
const metaClickWindows = Object.freeze(['1d_click', '7d_click', '28d_click']);
const reportWindowFacts: Readonly<Record<string, ReportAttributionWindows>> = {
  meta: Object.freeze({
    windows: metaAttributionWindows,
    clickWindows: metaClickWindows,
    message:
      'Choose at most one click window (1d_click, 7d_click or 28d_click), with optional 1d_view and 1d_ev (engaged view), or view windows alone.',
    valid: (windows: unknown): windows is string[] =>
      Array.isArray(windows) &&
      windows.length > 0 &&
      windows.length <= 3 &&
      new Set(windows).size === windows.length &&
      windows.every(v => typeof v === 'string' && metaAttributionWindows.includes(v)) &&
      windows.filter(v => metaClickWindows.includes(v)).length <= 1,
  }),
};

// The account fields, references and path patterns ScopeGuard compares (ARC-01 phase B: they were tables in
// src/scope.ts), and what a bound resource is (CON-05: src/account-metadata.ts). tests/provider-account-model.test.mjs
// pins them; a change changes what ScopeGuard compares and is reviewed with src/scope.ts. The body deletions were
// the table of src/execution-risk.ts (bodyDeletionValues, which tests/deletion-policy-coverage.test.mjs holds against
// every pinned provider document).
export const providerAdapters: readonly ProviderAdapter[] = Object.freeze([
  // Google Ads customer IDs are compared without the dashes of their display form (123-456-7890). Customer-level RPCs
  // use customers/{id}:method: the colon ends the ID, just like the slash in customers/{id}/resources.
  adapter('google', 'google_ads_native_action', {
    account: {
      normalize: id => id.replaceAll('-', ''),
      fields: ['customer_id', 'customerId'],
      references: /\bcustomers\/([^/:\s'"),]+)/g,
      path: /\/customers\/([^/:]+)/,
      // Each selected account's manager route, which its requests send as their login customer (CON-05).
      routes: 'accountLoginCustomers',
    },
    // A REMOVE account budget proposal, experiment asset detail or targeting restriction operation removes what it names.
    deletions: {
      fields: {
        status: ['REMOVED'],
        proposal_type: ['REMOVE'],
        asset_detail_operation: ['REMOVE'],
        operator: ['REMOVE'],
      },
      source: 'pinned Google Ads v25 Discovery document: writable enums of the request messages',
      removePrefix: 'customers/',
      mutateRemovals: true,
    },
    paging: {tokenParameter: 'page_token'},
    // Its developer token is the deployment's and no longer sent, so a login of its client never keeps a copy.
    app: {stem: 'GOOGLE', unsealed: ['developerToken']},
    renewal: {tokenEndpoint: 'https://oauth2.googleapis.com/token'},
    grant: {
      platform: 'google',
      requestedRead: [googleAdsScope, 'openid', 'profile'],
      // Customer Match and offline conversions through Google's Data Manager API (owner decision of 2026-09-30).
      requestedWrite: [google('datamanager')],
      read: {all: [googleAdsScope]},
      write: {all: [googleAdsScope]},
      grantSource: 'token_response',
      accountReadContract: true,
    },
  }),
  adapter('google_business', 'google_business_native_action', {
    account: {kind: 'business_profile'},
    app: {stem: 'GBP'},
    renewal: {tokenEndpoint: 'https://oauth2.googleapis.com/token'},
    grant: {
      platform: 'google_business',
      requestedRead: [businessScope],
      requestedWrite: [],
      read: {all: [businessScope]},
      write: {all: [businessScope]},
      grantSource: 'token_response',
      // One exact read of the selected location or business account (src/workspace.ts readinessPlan, CON-06).
      accountReadContract: true,
    },
  }),
  // Meta ad account IDs are compared without the act_ prefix of their Graph node form.
  adapter('meta', 'meta_native_action', {
    account: {
      normalize: id => id.replace(/^act_/, ''),
      fields: ['account_id', 'ad_account_id'],
      path: /^\/v[^/]+\/act_([^/]+)/,
    },
    deletions: {
      fields: {status: ['DELETED']},
      source: 'Marketing API campaign, ad set and ad updates: status ACTIVE, PAUSED, DELETED or ARCHIVED',
    },
    executionOptions: true,
    app: {stem: 'META'},
    grant: {
      platform: 'meta',
      requestedRead: ['ads_read', 'pages_show_list', 'pages_read_engagement', 'business_management'],
      requestedWrite: ['ads_management'],
      read: {any: ['ads_read', 'ads_management']},
      write: {all: ['ads_management']},
      grantSource: 'permissions_endpoint',
      accountReadContract: true,
    },
  }),
  adapter('tiktok', 'tiktok_native_action', {
    account: {fields: ['advertiser_id', 'advertiser_ids']},
    deletions: {
      fields: {operation_status: ['DELETE']},
      source:
        'API for Business v1.3 campaign, ad group and ad /status/update/: operation_status ENABLE, DISABLE or DELETE',
    },
    app: {stem: 'TIKTOK'},
    grant: {
      platform: 'tiktok',
      requestedRead: [],
      requestedWrite: [],
      // TikTok permissions are set on the developer app, not per authorization; a returned scope list is recorded
      // verbatim, but no documented mapping turns it into an AMCP requirement.
      read: null,
      write: null,
      grantSource: 'token_response',
      accountReadContract: true,
    },
  }),
  adapter('snapchat', 'snapchat_native_action', {
    account: {fields: ['ad_account_id', 'ad_account_ids'], patchFields: true, path: /^\/v1\/adaccounts\/([^/]+)/},
    app: {stem: 'SNAPCHAT'},
    renewal: {tokenEndpoint: 'https://accounts.snapchat.com/login/oauth2/access_token'},
    grant: {
      platform: 'snapchat',
      requestedRead: [snapchatScope],
      requestedWrite: [],
      read: {all: [snapchatScope]},
      write: {all: [snapchatScope]},
      grantSource: 'token_response',
      accountReadContract: true,
    },
  }),
  adapter('linkedin', 'linkedin_native_action', {
    account: {
      fields: ['ad_account_id', 'account_id'],
      references: /urn:li:sponsoredAccount:(\d+)/g,
      path: /^\/rest\/(?:adAccounts|adAccountTrustPreferences)\/([^/]+)/,
    },
    deletions: {
      fields: {status: ['PENDING_DELETION', 'REMOVED'], intended_status: ['PENDING_DELETION', 'REMOVED']},
      source:
        'LinkedIn campaign groups and creatives: "update the status to PENDING_DELETION" to delete (src/linkedin-entity-deletes.ts)',
    },
    app: {stem: 'LINKEDIN'},
    renewal: {tokenEndpoint: 'https://www.linkedin.com/oauth/v2/accessToken'},
    grant: {
      platform: 'linkedin',
      requestedRead: ['r_ads', 'r_ads_reporting'],
      requestedWrite: ['rw_ads'],
      read: {any: ['r_ads', 'rw_ads']},
      write: {all: ['rw_ads']},
      grantSource: 'token_response',
      accountReadContract: true,
    },
  }),
  adapter('x', 'x_ads_native_action', {
    account: {fields: ['account_id'], path: /\/accounts\/([^/]+)/},
    // OAuth 1.0a: the client is the consumer key and its secret the consumer secret.
    app: {stem: 'X', secretField: 'consumerSecret', clientField: 'consumerKey'},
    grant: {
      platform: 'x',
      requestedRead: [],
      requestedWrite: [],
      // OAuth 1.0a has no scopes; only the requested access type (read or write) is known.
      read: null,
      write: null,
      grantSource: 'requested_access_type',
      accountReadContract: true,
    },
  }),
  adapter('microsoft', 'microsoft_ads_native_action', {
    // Each selected account's parent customer, which its requests name (CustomerId).
    account: {fields: ['AccountId', 'AccountIds', 'CustomerAccountId'], routes: 'accountCustomers'},
    // Status Deleted on entities; Action Delete in AdGroupCriterionAction and AssetGroupListingGroupAction; a user's
    // UserLifeCycleStatus Deleted (Customer Management).
    deletions: {
      fields: {status: ['Deleted'], action: ['Delete'], user_life_cycle_status: ['Deleted']},
      source:
        'pinned Microsoft Advertising v13 Campaign and Customer Management WSDLs: entity statuses Deleted, ItemAction Delete, UserLifeCycleStatus Deleted',
    },
    // The developer token every request sends with the login's token.
    app: {stem: 'MICROSOFT', settings: {developerToken: 'AMCP_MICROSOFT_DEVELOPER_TOKEN'}},
    renewal: {tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token'},
    grant: {
      platform: 'microsoft',
      requestedRead: [microsoftManageScope, 'offline_access'],
      requestedWrite: [],
      // Microsoft uses one API scope for reads and writes; AMCP roles and account grants separate them.
      read: {any: [microsoftManageScope, 'msads.manage']},
      write: {any: [microsoftManageScope, 'msads.manage']},
      grantSource: 'token_response',
      accountReadContract: true,
    },
  }),
  adapter('apple', 'apple_ads_native_action', {
    account: {fields: ['adAccountId', 'account_id', 'ad_account_id']},
    // The signing key of its client-credentials token.
    app: {
      stem: 'APPLE',
      settings: {
        appleTeamId: 'AMCP_APPLE_TEAM_ID',
        appleKeyId: 'AMCP_APPLE_KEY_ID',
        applePrivateKey: 'AMCP_APPLE_PRIVATE_KEY',
      },
    },
    renewal: {clientCredentials: true},
    grant: {
      platform: 'apple',
      requestedRead: [appleScope],
      requestedWrite: [],
      read: {all: [appleScope]},
      write: {all: [appleScope]},
      grantSource: 'token_response',
      accountReadContract: true,
    },
  }),
  adapter('reddit', 'reddit_native_action', {
    account: {fields: ['ad_account_id', 'account_id'], path: /^\/api\/v3\/ad_accounts\/([^/]+)/},
    // effective_status is computed by Reddit, but its request schemas accept it; sent as DELETED it counts as a deletion.
    deletions: {
      fields: {configured_status: ['DELETED'], effective_status: ['DELETED'], status: ['DELETED']},
      source:
        'pinned Reddit Ads API v3 OpenAPI document: configured_status and status ACTIVE, ARCHIVED, DELETED or PAUSED',
    },
    app: {stem: 'REDDIT'},
    renewal: {tokenEndpoint: 'https://www.reddit.com/api/v1/access_token'},
    grant: {
      platform: 'reddit',
      // adsedit is requested only when the deployment allows reviewed writes (owner decision D19, item 5).
      requestedRead: ['adsread'],
      requestedWrite: ['adsedit'],
      read: {all: ['adsread']},
      write: {all: ['adsread', 'adsedit']},
      grantSource: 'token_response',
      accountReadContract: true,
    },
  }),
  adapter('dv360', 'dv360_native_action', {
    account: {fields: ['advertiserId', 'advertiser_id'], path: /\/advertisers\/([^/:]+)/},
    deletions: {
      fields: {entity_status: ['ENTITY_STATUS_SCHEDULED_FOR_DELETION']},
      source:
        'pinned Display & Video 360 v4 Discovery document: "the advertiser will be deleted 30 days from when it was first scheduled for deletion"',
    },
    app: {stem: 'DV360'},
    renewal: {tokenEndpoint: 'https://oauth2.googleapis.com/token'},
    grant: {
      platform: 'dv360',
      requestedRead: [dv360Scope],
      requestedWrite: [],
      read: {all: [dv360Scope]},
      write: {all: [dv360Scope]},
      grantSource: 'token_response',
      accountReadContract: true,
    },
    // Its captured schema has no LIST_ACTIONS; AMCP lists its actions from the catalog (MCP-05).
    listsActions: true,
  }),
  adapter('ga4', 'ga4_native_action', {
    account: {path: /\/properties\/([^/:]+)/, kind: 'analytics_property'},
    paging: {bodyArgument: 'request'},
    app: {stem: 'GA4'},
    renewal: {tokenEndpoint: 'https://oauth2.googleapis.com/token'},
    grant: {
      platform: 'ga4',
      requestedRead: [google('analytics.readonly')],
      requestedWrite: [],
      read: {any: analyticsScopes},
      // src/measurement-writes.ts accepts either recorded Analytics scope for its reviewed property writes.
      write: {any: analyticsScopes},
      grantSource: 'token_response',
      accountReadContract: true,
    },
  }),
  adapter('gtm', 'gtm_native_action', {
    // Tag Manager account IDs are numeric (src/gtm-login.ts), so only a number after /accounts/ is an account: the lookup route
    // /accounts/containers:lookup names none, and "containers" was read as one (r25-field2-access, B4; the same pattern is the
    // delegated compiler's, src/gtm-adapter.ts). The lookahead keeps "111abc" from naming account 111.
    account: {path: /\/accounts\/(\d+)(?=[/:]|$)/, kind: 'tag_account'},
    app: {stem: 'GTM'},
    renewal: {tokenEndpoint: 'https://oauth2.googleapis.com/token'},
    grant: {
      platform: 'gtm',
      requestedRead: [google('tagmanager.readonly')],
      requestedWrite: gtmWriteScopes,
      read: {any: [google('tagmanager.readonly'), ...gtmWriteScopes]},
      // Each Tag Manager action needs its own scope (src/measurement-writes.ts); any one of them enables some writes.
      write: {any: gtmWriteScopes},
      grantSource: 'token_response',
      accountReadContract: true,
    },
  }),
  adapter('gsc', 'google_search_console_native_action', {
    families: ['search_console_'],
    account: {kind: 'search_property'},
    app: {stem: 'GSC'},
    renewal: {tokenEndpoint: 'https://oauth2.googleapis.com/token'},
    grant: {
      platform: 'gsc',
      requestedRead: [google('webmasters.readonly')],
      requestedWrite: [searchConsoleWriteScope],
      read: {any: [google('webmasters.readonly'), searchConsoleWriteScope]},
      write: {all: [searchConsoleWriteScope]},
      grantSource: 'token_response',
      accountReadContract: true,
    },
  }),
  adapter('adjust', 'adjust_native_action'),
  adapter('drive', 'google_drive_native_action', {
    account: {kind: 'destination'},
    app: {stem: 'DRIVE'},
    renewal: {tokenEndpoint: 'https://oauth2.googleapis.com/token'},
    grant: {
      platform: 'drive',
      requestedRead: [google('drive.readonly')],
      requestedWrite: [],
      read: {all: [google('drive.readonly')]},
      write: null,
      grantSource: 'token_response',
      accountReadContract: false,
    },
  }),
  adapter('sheets', 'google_sheets_native_action', {
    account: {kind: 'destination'},
    app: {stem: 'SHEETS'},
    renewal: {tokenEndpoint: 'https://oauth2.googleapis.com/token'},
    grant: {
      platform: 'sheets',
      requestedRead: [google('drive.file'), google('spreadsheets')],
      requestedWrite: [],
      read: {any: [google('drive.file'), google('spreadsheets')]},
      write: null,
      grantSource: 'token_response',
      // Sheets and Drive are report destinations and media sources, not advertising accounts.
      accountReadContract: false,
    },
  }),
  // The owner parked Criteo and the store platforms (PRK-01, PRK-02); P9 gates them by this status (docs/DECISIONS.md).
  // WooCommerce is the only store platform with a gateway: Shopify and Salla have no connection or module to gate.
  adapter('criteo', 'criteo_native_action', {
    parked: {reason: 'owner_parked', decision: 'PRK-02 and P9, docs/DECISIONS.md'},
    account: {path: /\/accounts\/([^/:]+)/},
    // No website platform authorizes Criteo, and no OAuth scope distinguishes its capabilities.
    grant: {
      requestedRead: [],
      requestedWrite: [],
      read: null,
      write: null,
      grantSource: 'none',
      accountReadContract: false,
    },
  }),
  adapter('woocommerce', 'commerce_native_action', {
    parked: {reason: 'owner_parked', decision: 'PRK-01 and P9, docs/DECISIONS.md'},
  }),
  adapter('amazon', 'amazon_native_action', {
    parked: {reason: 'unimplemented', decision: 'CON-06 option (b), docs/DECISIONS.md'},
    renewal: {tokenEndpoint: 'https://api.amazon.com/auth/o2/token'},
  }),
]);

/**
 * The gateways with reviewed mutation contracts (src/write-shape.ts writeContractGateways), in the order the review
 * lists them: a request to any other gateway is refused WRITE_CONTRACT_UNAVAILABLE before anything else is checked.
 */
export const reviewedWriteGateways: readonly string[] = Object.freeze([
  'meta_native_action',
  'tiktok_native_action',
  'snapchat_native_action',
  'google_ads_native_action',
  'google_business_native_action',
  'linkedin_native_action',
  'x_ads_native_action',
  'dv360_native_action',
  'reddit_native_action',
  'criteo_native_action',
  'microsoft_ads_native_action',
  // The measurement providers (src/measurement-writes.ts measurementWriteGateways).
  'ga4_native_action',
  'gtm_native_action',
  'google_search_console_native_action',
  'apple_ads_native_action',
]);

const byGateway = new Map(providerAdapters.map(a => [a.gateway, a]));
const byId = new Map(providerAdapters.map(a => [a.id, a]));

/**
 * The order in which the grant registry (src/provider-grants.ts providerGrants) lists the providers' grants, by
 * provider ID. A load-time check: it names every adapter that declares a grant once, and no other.
 */
export const grantOrder: readonly string[] = Object.freeze([
  'meta',
  'google',
  'linkedin',
  'reddit',
  'microsoft',
  'snapchat',
  'tiktok',
  'x',
  'dv360',
  'ga4',
  'gtm',
  'gsc',
  'apple',
  'google_business',
  'criteo',
  'sheets',
  'drive',
]);
if (
  new Set(grantOrder).size !== grantOrder.length ||
  grantOrder.some(id => !byId.get(id)?.grant) ||
  providerAdapters.filter(a => a.grant).length !== grantOrder.length
)
  throw new Error('The grant order must name every provider adapter that declares a grant exactly once.');

/**
 * Wave 4c round 6 (w4c-arc6-tables): the providers whose withdrawn methods and unsupported aliases
 * src/retired-provider-actions.ts lists, in its table's order (the key order of their facts above). A load-time check:
 * each withdrawn method's refusal can say why, what instead and when it was checked, in its row's words or its
 * provider's.
 */
export const retiredActionProviders: readonly ProviderAdapter[] = Object.freeze(
  Object.keys(retiredActionFacts).map(id => {
    const provider = byId.get(id);
    if (!provider?.retired) throw new Error('Retired actions name no provider adapter: ' + id + '.');
    return provider;
  }),
);
for (const {id, retired} of retiredActionProviders)
  for (const row of retired!.actions ?? [])
    if (
      !(row.reason ?? retired!.reason) ||
      !(row.replacement ?? retired!.replacement) ||
      !(row.checked ?? retired!.checked)
    )
      throw new Error(
        'The withdrawn method ' + row.action + ' of ' + id + ' must say why, what instead and when it was checked.',
      );

/** The adapter of a gateway tool name, or undefined for AMCP's own tools and unknown names. */
export function providerOf(gateway: unknown): ProviderAdapter | undefined {
  return typeof gateway === 'string' ? byGateway.get(gateway) : undefined;
}

export function providerById(id: string): ProviderAdapter | undefined {
  return byId.get(id);
}

/** The provider IDs AMCP_PROVIDERS names. */
export function namedProviders(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set((env.AMCP_PROVIDERS ?? '').split(/[\s,]+/).filter(Boolean));
}

/** Names in AMCP_PROVIDERS that are no provider ID (a misspelt one offers nothing); startup reports them. */
export function unknownProviderIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...namedProviders(env)].filter(id => !byId.has(id)).sort();
}

/** True unless the gateway belongs to a parked provider that AMCP_PROVIDERS does not name. */
export function providerOffered(provider: ProviderAdapter | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return !provider || provider.status === 'active' || namedProviders(env).has(provider.id);
}

/** The adapter whose family prefix is the longest prefix of a reviewed family's name. */
export function familyProvider(family: string): ProviderAdapter | undefined {
  let found: ProviderAdapter | undefined,
    length = 0;
  for (const provider of providerAdapters)
    for (const prefix of provider.familyPrefixes)
      if (family.startsWith(prefix) && prefix.length > length) [found, length] = [provider, prefix.length];
  return found;
}

/** The IDs of parked providers, offered or not (tools/provider-lifecycle.ts does not watch their pages). */
export function parkedProviderIds(): ReadonlySet<string> {
  return new Set(providerAdapters.filter(a => a.status === 'parked').map(a => a.id));
}

export interface ProviderLifecycleEntry {
  provider: string;
  gateway: string;
  status: ProviderStatus;
  reason?: ParkedReason;
  offered: boolean;
}

/** Every provider's lifecycle status and whether this deployment offers it. */
export function providerLifecycle(env: NodeJS.ProcessEnv = process.env): ProviderLifecycleEntry[] {
  return providerAdapters.map(a => ({
    provider: a.id,
    gateway: a.gateway,
    status: a.status,
    ...(a.parked ? {reason: a.parked.reason} : {}),
    offered: providerOffered(a, env),
  }));
}

// Wave 4c round 6 (w4c-arc6-catalog).
/**
 * The order in which src/catalog-destinations.ts lists the catalog destinations (COM-03), by provider ID. A load-time
 * check: it names every adapter with a catalog destination once, and no other, and exactly one of them is the fallback.
 */
export const catalogDestinationOrder: readonly string[] = Object.freeze(['meta', 'x', 'snapchat']);
if (
  new Set(catalogDestinationOrder).size !== catalogDestinationOrder.length ||
  catalogDestinationOrder.some(id => !byId.get(id)?.catalogDestination) ||
  providerAdapters.filter(a => a.catalogDestination).length !== catalogDestinationOrder.length ||
  providerAdapters.filter(a => a.catalogDestination?.fallback).length !== 1
)
  throw new Error('The catalog destination order must name every catalog destination once, one of them the fallback.');
