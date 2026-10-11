import {authorizePlaceActionDiscovery} from './google-place-action-discovery.js';
import {authorizeLinkedInConversionEvidenceRead} from './linkedin-conversion-evidence.js';
import type {CompiledRequest, Connection, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {Registry} from './catalog.js';
import {Store} from './store.js';
import {stable} from './security.js';
import {microsoftGateway, microsoftCustomer, microsoftContracts} from './microsoft-native.js';
import {microsoftReportKey} from './microsoft-report-download.js';
import {authorizeLinkedInSpecial} from './linkedin-posts.js';
import {linkedinPlanningAccount, linkedinPlanningRoute} from './linkedin-planning-reads.js';
import {googleGlobalRead} from './execution-risk.js';
import {authorizeQualifiedProviderRead} from './provider-read-contracts.js';
import {authorizeDV360TargetingSearch} from './dv360-targeting-search.js';
import {authorizeDV360AudienceRead} from './dv360-audiences.js';
import {authorizeXAudienceEstimate} from './x-audience-estimate.js';
import {assertGoogleGenerationScope} from './google-generation.js';
import {assertMetaLabelScope, metaLabelIdentities} from './meta-label-writes.js';
import {authorizeLinkedInAdPreview, observeLinkedInCreatives} from './linkedin-ad-previews.js';
import {metaAdLibraryRead} from './meta-ad-library.js';
import {reviewedFamilies, familyOf} from './reviewed-families.js';
import {metaRoute} from './meta-version.js';
import {criteoPrefix, criteoRoute} from './criteo-version.js';
import {assertNotPersonalDataRead} from './personal-data.js';
import {authorizeMetaDatasetRead, observeMetaPixels} from './meta-dataset-scope.js';

export function normalizeAccount(gateway: string, id: unknown): string {
  const value = String(id);
  return gateway === 'meta_native_action'
    ? value.replace(/^act_/, '')
    : gateway === 'google_ads_native_action'
      ? value.replaceAll('-', '')
      : value;
}
const accountFields: Record<string, Set<string>> = {
  microsoft_ads_native_action: new Set(['AccountId', 'AccountIds', 'CustomerAccountId']),
  meta_native_action: new Set(['account_id', 'ad_account_id']),
  google_ads_native_action: new Set(['customer_id', 'customerId']),
  tiktok_native_action: new Set(['advertiser_id', 'advertiser_ids']),
  snapchat_native_action: new Set(['ad_account_id', 'ad_account_ids']),
  linkedin_native_action: new Set(['ad_account_id', 'account_id']),
  apple_ads_native_action: new Set(['adAccountId', 'account_id', 'ad_account_id']),
  x_ads_native_action: new Set(['account_id']),
  dv360_native_action: new Set(['advertiserId', 'advertiser_id']),
  reddit_native_action: new Set(['ad_account_id', 'account_id']),
};
function mismatch(field: string): never {
  throw new MirrorError(
    'ACCOUNT_SCOPE_MISMATCH',
    'The final request targets a resource outside the selected account binding.',
    {field},
    403,
  );
}

/** This guard runs on every final page, before token refresh or authenticated egress. */
/** The global Snapchat entity that scopes a path (campaigns/<id>, adsquads/<id>, …), as held in resource ownership. */
/**
 * The account collection reads whose results establish ownership of a standalone resource (observe() below), as
 * ready-to-send calls. Meta object IDs do not reveal their type, so Meta gets one call per collection.
 */
export function ownershipReads(
  gateway: string,
  path: string,
  account: string,
  connectionId: string,
  template?: string,
): {tool: string; arguments: JsonObject}[] {
  const call = (action: string, extra: JsonObject = {}) => ({
    tool: gateway,
    arguments: {action, account_id: account, connection_id: connectionId, ...extra},
  });
  // A Meta pixel's aggregate reads are opened by the account's pixel list, which the measurement ledger reads (MSR-03).
  if (
    gateway === 'meta_native_action' &&
    (/^\/v[^/]+\/\{pixel_id\}\/stats$/.test(template ?? '') || /^\/v[^/]+\/dataset_quality$/.test(path))
  )
    return [
      {
        tool: 'amcp_workspace',
        arguments: {action: 'measurement_ledger', gateway, account_id: account, connection_id: connectionId},
      },
    ];
  if (gateway === 'meta_native_action' && /^\/v[^/]+\/\d+(?:\/|$)/.test(path)) {
    // A typed action names its object's type in its route ({campaign_id}, {ad_set_id}...), so one list read establishes
    // its ownership (MCP-09); a bare ID of unknown type still offers each candidate list.
    const typed = (
      {
        campaign_id: 'meta_campaign_list',
        ad_set_id: 'meta_adset_list',
        ad_id: 'meta_ad_list',
        creative_id: 'meta_creative_list',
        custom_audience_id: 'meta_custom_audience_list',
      } as Record<string, string>
    )[/^\/v[^/]+\/\{([a-z_]+)\}/.exec(template ?? '')?.[1] ?? ''];
    return (
      typed
        ? [typed]
        : ['meta_campaign_list', 'meta_adset_list', 'meta_ad_list', 'meta_creative_list', 'meta_custom_audience_list']
    ).map(a => call(a, {query: {fields: 'id'}}));
  }
  if (gateway === 'snapchat_native_action') {
    // An organization's pixel list is readable once the account's own read names the organization (Snapchat S6).
    if (snapchatOrganizationPixels(path)) return [call('snapchat_account_get')];
    const [kind, resource] = snapchatScopedResource(path)?.split('/') ?? [],
      action =
        kind &&
        (
          {
            campaigns: 'snapchat_campaign_list',
            adsquads: 'snapchat_adsquad_list',
            ads: 'snapchat_ad_list',
            creatives: 'snapchat_creative_list',
            media: 'snapchat_media_list',
            pixels: 'snapchat_pixel_list',
            lead_generation_forms: 'snapchat_lead_generation_forms_list',
            segments: 'snapchat_audience_list',
          } as Record<string, string>
        )[kind];
    // Only the refused ID comes back, however long the account's list (Snapchat S3: 312 creatives were 52 KB).
    return action ? [call(action, resource && /^[\w-]{1,64}$/.test(resource) ? {result_ids: [resource]} : {})] : [];
  }
  if (gateway === 'linkedin_native_action' && path === '/rest/adPreviews')
    return [
      call('linkedin_rest_ad_accounts_ad_account_id_creatives_get', {
        restli_method: 'FINDER',
        query: {q: 'criteria', pageSize: 100},
      }),
    ];
  if (gateway === 'reddit_native_action') {
    const kind = /^\/api\/v3\/(campaigns|ad_groups|ads)\//.exec(path)?.[1],
      action =
        kind &&
        ({campaigns: 'LIST_CAMPAIGNS', ad_groups: 'LIST_AD_GROUPS', ads: 'LIST_ADS'} as Record<string, string>)[kind];
    return action
      ? [
          {
            tool: gateway,
            arguments: {
              operation: 'reddit_campaign_ops',
              arguments: {action, account_id: account, connection_id: connectionId},
            },
          },
        ]
      : [];
  }
  return [];
}
/** The organization of GET /v1/organizations/{id}/pixels: the only organization read an account binding reaches. */
export function snapchatOrganizationPixels(path: string): string | undefined {
  return /^\/v1\/organizations\/([\w-]{1,64})\/pixels$/.exec(path)?.[1];
}
export function snapchatScopedResource(path: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  return /^\/v1\/(campaigns|adsquads|ads|creatives|media|pixels|lead_generation_forms|segments)\/([^/]+)/
    .exec(decoded)
    ?.slice(1)
    .join('/');
}
export class ScopeGuard {
  constructor(
    private registry: Registry,
    private store: Store,
  ) {}
  authorize(plan: CompiledRequest, connection: Connection): string {
    if (connection.gateway !== plan.gateway)
      throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'Connection gateway does not match request.', {}, 403);
    // Submitted leads stay out of reach: no resource binding below may open them (SEC-04).
    assertNotPersonalDataRead(plan);
    if (metaAdLibraryRead(plan)) return 'public_ad_library';
    const id = normalizeAccount(
      plan.gateway,
      plan.accountId ?? (connection.accounts.length === 1 ? connection.accounts[0] : ''),
    );
    if (!id || !connection.accounts.some(a => normalizeAccount(plan.gateway, a) === id))
      throw new MirrorError('ACCOUNT_REQUIRED', 'Select an explicitly bound account for this request.', {}, 403);
    let decoded: string;
    try {
      decoded = decodeURIComponent(plan.path);
    } catch {
      throw new MirrorError('INVALID_PATH', 'Malformed path encoding.');
    }
    const compare = (value: unknown, field: string) => {
      for (const item of Array.isArray(value) ? value : [value])
        if (normalizeAccount(plan.gateway, item) !== id) mismatch(field);
    };
    const walk = (value: unknown, field = '$'): void => {
      // Customer-level RPCs use customers/{id}:method. The colon ends the ID,
      // just like the slash in customers/{id}/resources; it is not account data.
      if (typeof value === 'string' && plan.gateway === 'google_ads_native_action')
        for (const m of value.matchAll(/\bcustomers\/([^/:\s'"),]+)/g)) compare(m[1], field);
      if (typeof value === 'string' && plan.gateway === 'linkedin_native_action')
        for (const m of value.matchAll(/urn:li:sponsoredAccount:(\d+)/g)) compare(m[1], field);
      if (Array.isArray(value)) {
        value.forEach(v => walk(v, field));
        return;
      }
      if (value && typeof value === 'object' && plan.gateway === 'snapchat_native_action' && plan.method === 'PATCH') {
        const patch = value as JsonObject;
        if (typeof patch.path === 'string' && accountFields[plan.gateway]?.has(patch.path.split('/').at(-1)!)) {
          if (patch.op === 'remove' || patch.value === undefined) mismatch('account patch');
          compare(patch.value, 'account patch');
        }
      }
      if (value && typeof value === 'object')
        for (const [key, v] of Object.entries(value)) {
          if (/^(?:access_token|oauth_token|refresh_token|client_secret|developer_token|authorization)$/i.test(key))
            throw new MirrorError(
              'CREDENTIAL_PARAMETER_FORBIDDEN',
              'Credentials must come from the encrypted connection provider.',
              {field: key},
              403,
            );
          if (accountFields[plan.gateway]?.has(key)) {
            let candidate = v;
            if (typeof v === 'string' && v.startsWith('[')) {
              try {
                candidate = JSON.parse(v);
              } catch {
                mismatch(key);
              }
            }
            compare(candidate, key);
          }
          walk(v, field + '.' + key);
        }
    };
    walk(plan.query);
    walk(plan.body);
    walk(decoded, 'path');
    assertGoogleGenerationScope(plan, connection);
    if (
      plan.gateway === 'meta_native_action' &&
      (plan.action === 'AMCP_META_LABEL_READ' ||
        (plan.method === 'GET' && metaRoute('act_\\d+/adlabels$').test(plan.path)))
    )
      assertMetaLabelScope(connection);
    if (authorizeQualifiedProviderRead(plan, connection, id)) return id;
    if (authorizeMetaDatasetRead(plan, connection, id, this.store)) return id;
    if (authorizeLinkedInConversionEvidenceRead(plan, connection, id)) return id;
    if (authorizePlaceActionDiscovery(plan, connection, id)) return id;
    if (authorizeDV360TargetingSearch(plan, connection, id)) return id;
    if (authorizeDV360AudienceRead(plan, connection, id)) return id;
    if (authorizeXAudienceEstimate(plan, connection, id)) return id;
    for (const family of reviewedFamilies()) if (family.authorize?.(plan, connection, id, this.store)) return id;
    if (authorizeLinkedInAdPreview(plan, connection, this.store, id)) return id;
    if (
      plan.gateway === 'google_ads_native_action' &&
      plan.readOnly &&
      plan.method === 'POST' &&
      googleGlobalRead(decoded)
    )
      return id;
    if (authorizeLinkedInSpecial(plan, connection, this.store, id)) return id;
    const patterns: Record<string, RegExp> = {
      google_ads_native_action: /\/customers\/([^/:]+)/,
      meta_native_action: /^\/v[^/]+\/act_([^/]+)/,
      snapchat_native_action: /^\/v1\/adaccounts\/([^/]+)/,
      linkedin_native_action: /^\/rest\/(?:adAccounts|adAccountTrustPreferences)\/([^/]+)/,
      x_ads_native_action: /\/accounts\/([^/]+)/,
      dv360_native_action: /\/advertisers\/([^/:]+)/,
      ga4_native_action: /\/properties\/([^/:]+)/,
      gtm_native_action: /\/accounts\/([^/:]+)/,
      criteo_native_action: /\/accounts\/([^/:]+)/,
      reddit_native_action: /^\/api\/v3\/ad_accounts\/([^/]+)/,
    };
    const match = patterns[plan.gateway]?.exec(decoded);
    if (match) {
      compare(match[1], 'path');
      return id;
    }
    if (plan.gateway === 'google_search_console_native_action') {
      const site = /\/sites\/([^/]+)/.exec(plan.path)?.[1];
      const value = site ? decodeURIComponent(site) : (plan.body as JsonObject)?.siteUrl;
      if (value !== undefined) {
        compare(value, 'siteUrl');
        return id;
      }
    }
    if (plan.gateway === 'google_business_native_action') {
      const account = /\/accounts\/([^/:]+)/.exec(decoded)?.[1];
      if (account) {
        compare(account, 'path');
        return id;
      }
      const location = /\/locations\/([^/:]+)/.exec(decoded)?.[1];
      if (location && id.startsWith('locations/')) {
        compare('locations/' + location, 'path');
        return id;
      }
    }
    // adBudgetPricing (read-only) states an account's daily budget limits for allocation drafts (WRT-07); like the
    // reporting reads it names exactly one sponsored account, which must be the bound one.
    if (
      plan.gateway === 'linkedin_native_action' &&
      (['/rest/adAnalytics', '/rest/audienceCounts'].includes(decoded) ||
        (plan.readOnly && plan.method === 'GET' && decoded === '/rest/adBudgetPricing'))
    ) {
      const value = plan.query.accounts ?? plan.query.account;
      if (typeof value === 'string') {
        let decodedValue: string;
        try {
          decodedValue = decodeURIComponent(value);
        } catch {
          mismatch('account filter');
        }
        const filter = /^(?:List\()?urn:li:sponsoredAccount:(\d+)\)?$/.exec(decodedValue);
        if (filter) {
          compare(filter[1], 'account filter');
          return id;
        }
      }
    }
    if (plan.gateway === 'linkedin_native_action' && plan.readOnly && linkedinPlanningRoute(plan)) {
      const planned = linkedinPlanningAccount(plan);
      if (planned !== undefined) {
        compare(planned, 'request account');
        return id;
      }
    }
    if (plan.gateway === 'tiktok_native_action') {
      if (
        plan.readOnly &&
        plan.method === 'GET' &&
        // The ad group list is the Overview's optimization-event read (RPT-04), scoped like the campaign list.
        ['/v1.3/report/integrated/get/', '/v1.3/campaign/get/', '/v1.3/adgroup/get/'].includes(decoded) &&
        plan.query.advertiser_id === id
      )
        return id;
      if (
        plan.readOnly &&
        decoded === '/v1.3/advertiser/info/' &&
        Array.isArray(plan.query.advertiser_ids) &&
        plan.query.advertiser_ids.length === 1
      ) {
        compare(plan.query.advertiser_ids, 'advertiser_ids');
        return id;
      }
      // /page/get/ takes advertiser_id or a Business Center library_id; only the advertiser's own pages are in scope.
      if (
        plan.readOnly &&
        plan.method === 'GET' &&
        decoded === '/v1.3/page/get/' &&
        plan.query.advertiser_id === id &&
        plan.query.library_id === undefined
      )
        return id;
      const action = this.registry.action(plan.gateway, plan.action);
      // Some Business Center routes ignore advertiser_id. Only vendor-declared required
      // advertiser parameters establish this automatic boundary.
      if (
        action?.required.includes('advertiser_id') &&
        (plan.query.advertiser_id === id || (plan.body as JsonObject)?.advertiser_id === id)
      )
        return id;
    }
    if (plan.gateway === microsoftGateway) {
      microsoftCustomer(connection, id);
      const contract = microsoftContracts.get(plan.action);
      if (!contract || contract.path !== plan.path || contract.method !== plan.method)
        throw new MirrorError('RESOURCE_SCOPE_REQUIRED', 'Unqualified Microsoft request contract.', {}, 403);
      const body = plan.body as JsonObject;
      if (plan.action === 'PollGenerateReport') {
        let receipt: JsonObject | undefined;
        try {
          receipt = this.store.document(
            connection.tenantId,
            'microsoft_report',
            microsoftReportKey(connection.id, id, body.ReportRequestId),
          );
        } catch (e) {
          if (!(e instanceof MirrorError) || e.code !== 'NOT_FOUND') throw e;
        }
        const ownsReport =
          receipt?.connection_id === connection.id && receipt.account_id === id && receipt.expires_at > Date.now();
        if (!ownsReport && !this.store.ownsResource(connection, id, 'report/' + body.ReportRequestId))
          throw new MirrorError(
            'RESOURCE_SCOPE_REQUIRED',
            'Submit the Microsoft report using this account and connection before polling.',
            {},
            403,
          );
      }
      // Mandatory CustomerAccountId header confines CampaignManagement resources;
      // report scope is additionally validated by the compiler and caller cannot override headers.
      return id;
    }
    if (['amazon_native_action', 'apple_ads_native_action'].includes(plan.gateway)) return id; // account header scope is mandatory in transport
    if (plan.gateway === 'reddit_native_action') {
      if (
        [
          '/api/v3/time_zones',
          '/api/v3/targeting/interests',
          '/api/v3/targeting/geolocations',
          '/api/v3/targeting/communities/search',
        ].includes(decoded) &&
        plan.readOnly
      )
        return id;
      if (decoded === '/api/v3/me/businesses' && plan.query.ad_account_id === id) return id;
      const entity =
        /^\/api\/v3\/(campaigns|ad_groups|ads|profiles|saved_audiences|lead_gen_forms|posts|structured_posts|funding_instruments)\/([^/]+)/.exec(
          decoded,
        );
      if (entity && this.store.ownsResource(connection, id, entity[1] + '/' + entity[2])) return id;
    }
    // Global object paths need an ownership observation from an account-scoped list.
    if (plan.gateway === 'criteo_native_action') {
      const line = criteoRoute(
        String.raw`/preferred-line-items/(\d+)(?:/targeting/(?:audiences|stores|add-to-basket)(?:/(?:append|delete))?)?$`,
      ).exec(decoded)?.[1];
      if (line && this.store.ownsResource(connection, id, 'preferred-line-items/' + line)) return id;
    }
    const resource =
      plan.gateway === 'meta_native_action'
        ? /^\/v[^/]+\/([^/]+)/.exec(decoded)?.[1]
        : plan.gateway === 'snapchat_native_action'
          ? snapchatScopedResource(plan.path)
          : undefined;
    if (resource && this.store.ownsResource(connection, id, resource)) return id;
    const organization =
      plan.gateway === 'snapchat_native_action' && plan.method === 'GET' && snapchatOrganizationPixels(decoded);
    if (organization && this.store.ownsResource(connection, id, 'organizations/' + organization)) return id;
    // Administrative provisioning can declare otherwise unscoped Business/Profile resources.
    for (const binding of connection.resourceBindings ?? []) {
      if (normalizeAccount(plan.gateway, binding.accountId) !== id) continue;
      if (
        (decoded === binding.pathPrefix ||
          decoded.startsWith(binding.pathPrefix + '/') ||
          decoded.startsWith(binding.pathPrefix + ':')) &&
        Object.entries(binding.query ?? {}).every(([k, v]) => stable(plan.query[k]) === stable(v))
      )
        return id;
    }
    const reads = ownershipReads(
      plan.gateway,
      decoded,
      id,
      connection.id,
      this.registry.action(plan.gateway, plan.action)?.path ?? undefined,
    );
    throw new MirrorError(
      'RESOURCE_SCOPE_REQUIRED',
      'Resource ownership is not established. ' +
        (reads.length
          ? 'List it through ' +
            (reads.length === 1 ? 'its account collection' : 'the account collection of its type') +
            ' with this connection (details.ownership_reads); the IDs that read returns are usable for five minutes. Page through the collection if the ID is not on the first page.'
          : 'Read its account-scoped collection first, or have an administrator provision an exact resource binding.'),
      {
        gateway: plan.gateway,
        path: plan.path,
        account_id: id,
        ...(reads.length ? {ownership_reads: reads, ...(reads.length === 1 ? {next_call: reads[0]} : {})} : {}),
      },
      403,
    );
  }
  observe(plan: CompiledRequest, connection: Connection, data: unknown): void {
    if (!plan.readOnly) return;
    const id = this.authorize(plan, connection),
      d = data as JsonObject;
    for (const family of reviewedFamilies()) family.observe?.(plan, connection, id, data, this.store);
    observeLinkedInCreatives(plan, connection, this.store, id, data);
    observeMetaPixels(plan, connection, id, data, this.store);
    if (
      plan.gateway === microsoftGateway &&
      plan.action === 'SubmitGenerateReport' &&
      typeof d?.ReportRequestId === 'string'
    ) {
      this.store.rememberResource(connection, id, 'report/' + d.ReportRequestId);
      this.store.db
        .prepare(
          "DELETE FROM documents WHERE tenant_id=? AND kind='microsoft_report' AND json_extract(data,'$.expires_at')<=?",
        )
        .run(connection.tenantId, Date.now());
      this.store.putDocument(
        connection.tenantId,
        'microsoft_report',
        microsoftReportKey(connection.id, id, d.ReportRequestId),
        {
          connection_id: connection.id,
          account_id: id,
          request: (plan.body as JsonObject).ReportRequest,
          expires_at: Date.now() + 86400000,
        },
      );
    }
    // Only named entity collections are ownership evidence; never learn from arbitrary
    // nested IDs, reports, user supplied state, search results or unscoped account lists.
    if (
      plan.gateway === 'criteo_native_action' &&
      new RegExp('^' + criteoPrefix + '/accounts/' + id + '/line-items$').test(plan.path) &&
      Array.isArray(d?.data) &&
      !d.error &&
      (!d.errors || (Array.isArray(d.errors) && !d.errors.length))
    ) {
      for (const row of d.data)
        if (
          typeof row?.id === 'string' &&
          /^[1-9][0-9]*$/.test(row.id) &&
          row.attributes?.type === 'preferred' &&
          typeof row.attributes?.campaignId === 'string' &&
          /^[1-9][0-9]*$/.test(row.attributes.campaignId)
        )
          this.store.rememberResource(connection, id, 'preferred-line-items/' + row.id);
    }
    if (
      plan.gateway === 'meta_native_action' &&
      /^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads|adcreatives|customaudiences)$/.test(plan.path) &&
      Array.isArray(d?.data)
    ) {
      // Explicit foreign ownership can never grant access, even on an account edge. Audience lists additionally
      // show shared resources, so they require an explicit matching account rather than relying on the edge.
      const audiences = plan.path.endsWith('/customaudiences');
      for (const entity of d.data)
        if (
          typeof entity?.id === 'string' &&
          /^\d+$/.test(entity.id) &&
          (entity.account_id === undefined
            ? !audiences
            : typeof entity.account_id === 'string' && normalizeAccount(plan.gateway, entity.account_id) === id)
        )
          this.store.rememberResource(connection, id, entity.id);
    }
    // The account's value rule set list is ownership evidence for later edits and deletion of those sets by ID.
    if (
      plan.gateway === 'meta_native_action' &&
      metaRoute('act_\\d+/value_rule_set$').test(plan.path) &&
      Array.isArray(d?.data)
    ) {
      for (const set of d.data)
        if (typeof set?.id === 'string' && /^\d+$/.test(set.id)) this.store.rememberResource(connection, id, set.id);
    }
    if (plan.gateway === 'meta_native_action' && metaRoute('act_\\d+/adlabels$').test(plan.path)) {
      const labels = metaLabelIdentities(d, id);
      for (const label of labels) this.store.rememberResource(connection, id, label);
    }
    if (plan.gateway === 'snapchat_native_action') {
      const failed = (status: unknown) =>
        status !== undefined && (typeof status !== 'string' || status.toUpperCase() !== 'SUCCESS');
      const usable = (wrapped: unknown): wrapped is JsonObject => {
        if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) return false;
        const value = wrapped as JsonObject;
        return !value.error && !failed(value.sub_request_status);
      };
      if (failed(d?.request_status) || d?.error || (Array.isArray(d?.errors) && d.errors.length)) return;
      const m =
        /^\/v1\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives|media|pixels|lead_generation_forms|segments)$/.exec(
          plan.path,
        );
      const kind = m?.[1];
      if (kind && Array.isArray(d?.[kind]))
        for (const wrapped of d[kind]) {
          if (!usable(wrapped)) continue;
          const entity = wrapped[kind === 'media' ? 'media' : kind.slice(0, -1)] ?? wrapped;
          // Account segment lists also show segments shared from other accounts; only the account's own are owned.
          if (
            typeof entity?.id === 'string' &&
            /^[\w-]+$/.test(entity.id) &&
            (entity.ad_account_id === undefined
              ? kind !== 'segments'
              : typeof entity.ad_account_id === 'string' && entity.ad_account_id === id)
          )
            this.store.rememberResource(connection, id, kind + '/' + entity.id);
        }
      // The account's own read names its organization; that binds only the organization's pixel list (S6).
      const own = /^\/v1\/adaccounts\/([\w-]+)$/.exec(plan.path)?.[1],
        account =
          own && String(d?.request_status).toUpperCase() === 'SUCCESS' && usable(d.adaccounts?.[0])
            ? d.adaccounts[0].adaccount
            : undefined;
      if (
        own &&
        normalizeAccount(plan.gateway, own) === id &&
        account?.id === own &&
        typeof account.organization_id === 'string' &&
        /^[\w-]{1,64}$/.test(account.organization_id)
      )
        this.store.rememberResource(connection, id, 'organizations/' + account.organization_id);
      // A read of an entity authorize() already required ownership for keeps that ownership fresh when the
      // provider names the owning account, or a parent this login still owns. It never learns a new ID.
      const single = /^\/v1\/(campaigns|adsquads|ads|creatives|media|lead_generation_forms|segments)\/([\w-]+)$/.exec(
        plan.path,
      );
      if (single && String(d?.request_status).toUpperCase() === 'SUCCESS') {
        const kind = single[1]!,
          wrapped = d[kind]?.[0],
          entity = usable(wrapped) ? wrapped[kind === 'media' ? 'media' : kind.slice(0, -1)] : undefined,
          parentField = kind === 'adsquads' ? 'campaign_id' : kind === 'ads' ? 'ad_squad_id' : undefined;
        const confirmed = parentField
          ? typeof entity?.[parentField] === 'string' &&
            this.store.ownsResource(
              connection,
              id,
              (kind === 'adsquads' ? 'campaigns/' : 'adsquads/') + entity[parentField],
            )
          : entity?.ad_account_id === id;
        if (entity?.id === single[2] && confirmed) this.store.rememberResource(connection, id, kind + '/' + single[2]);
      }
    }
    if (plan.gateway === 'reddit_native_action') {
      const collection =
        /^\/api\/v3\/ad_accounts\/[^/]+\/(campaigns|ad_groups|ads|profiles|saved_audiences|lead_gen_forms|funding_instruments)$/.exec(
          plan.path,
        )?.[1] ?? /^\/api\/v3\/profiles\/[^/]+\/(posts|structured_posts)$/.exec(plan.path)?.[1];
      if (collection && Array.isArray(d?.data))
        for (const entity of d.data)
          if (
            typeof entity?.id === 'string' &&
            /^[A-Za-z0-9_-]+$/.test(entity.id) &&
            (!entity.ad_account_id || entity.ad_account_id === id)
          )
            this.store.rememberResource(connection, id, collection + '/' + entity.id);
    }
  }
  /** Called only after a verified successful mutation, never on caller-supplied data. */
  observeCreated(plan: CompiledRequest, connection: Connection, data: unknown): void {
    if (plan.readOnly || plan.method !== 'POST') return;
    const id = normalizeAccount(plan.gateway, plan.accountId),
      d = data as JsonObject;
    for (const created of familyOf(plan)?.created?.(plan, d) ?? [])
      this.store.rememberResource(connection, id, created);
    if (plan.gateway === 'reddit_native_action') {
      // Only an accepted, account/profile-bound original creation may authorize a job read.
      const kind = /^\/api\/v3\/ad_accounts\/[^/]+\/(campaigns|ad_groups|ads|saved_audiences|lead_gen_forms)$/.exec(
          plan.path,
        )?.[1],
        entity = d?.data;
      if (
        kind &&
        typeof entity?.id === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(entity.id) &&
        entity.ad_account_id === id
      )
        this.store.rememberResource(connection, id, kind + '/' + entity.id);
    }
    // Other qualified gateways carry the account in every child path/body. These two
    // use global IDs and therefore need this extra, connection-bound observation.
    if (
      plan.gateway === 'meta_native_action' &&
      /^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads|adcreatives|customaudiences)$/.test(plan.path) &&
      typeof d?.id === 'string' &&
      /^\d+$/.test(d.id)
    ) {
      if (d.account_id !== undefined && normalizeAccount(plan.gateway, d.account_id) !== id) return;
      this.store.rememberResource(connection, id, d.id);
    }
    if (plan.gateway === 'snapchat_native_action') {
      const match =
        /^\/v1\/(?:adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives|media|lead_generation_forms|segments)|adaccounts\/[^/]+\/(media)_copy|campaigns\/[^/]+\/(adsquads)|adsquads\/[^/]+\/(ads))$/.exec(
          plan.path,
        );
      const kind = match?.slice(1).find(Boolean);
      if (!kind || String(d?.request_status).toUpperCase() !== 'SUCCESS' || !Array.isArray(d[kind])) return;
      for (const row of d[kind]) {
        const entity = row[kind === 'media' ? 'media' : kind.slice(0, -1)];
        if (
          String(row.sub_request_status).toUpperCase() !== 'SUCCESS' ||
          typeof entity?.id !== 'string' ||
          !/^[-\w]+$/.test(entity.id)
        )
          continue;
        if (entity.ad_account_id !== undefined && entity.ad_account_id !== id) continue;
        const parent = /^\/v1\/(campaigns|adsquads)\/([^/]+)\//.exec(plan.path);
        if (
          parent &&
          entity[parent[1] === 'campaigns' ? 'campaign_id' : 'ad_squad_id'] !== undefined &&
          entity[parent[1] === 'campaigns' ? 'campaign_id' : 'ad_squad_id'] !== parent[2]
        )
          continue;
        this.store.rememberResource(connection, id, kind + '/' + entity.id);
      }
    }
  }
}
