import type {Actor, CompiledRequest, JsonObject} from './types.js';
import type {Store} from './store.js';
import type {Registry} from './catalog.js';
import type {NativeTransport} from './transport.js';
import type {CredentialProvider} from './auth.js';
import {creativeAssetView} from './creative-library.js';
import {bad, fingerprint, obj, validate} from './workspace-core.js';
import {googleAdsContract, googleAdsCustomers, googleAdsVersion} from './google-version.js';
import {assertGoogleAdsScope} from './google-contracts.js';
import {ScopeGuard, normalizeAccount} from './scope.js';
import {nativeAuthority} from './native-authority.js';
import {ReportCollectionBudget} from './report-collection-budget.js';
import {pinnedJson} from './pinned-json.js';
import {MirrorError} from './errors.js';
import {pmaxImageFields, projectPmaxImageLinks, pmaxImageMeaning} from './google-pmax-image-links.js';
import {
  pmaxBrandImageFields,
  projectPmaxBrandImageLinks,
  pmaxBrandImageRoles,
  pmaxBrandImageMeaning,
} from './google-pmax-brand-image-links.js';

const gateway = 'google_ads_native_action';
const id = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v);
const invalid = (message: string): never => bad(message, 'ASSET_USAGE_INVALID_RESPONSE');
const changed = (): never =>
  bad('The original image, login or native references changed. Read the original asset again.', 'ASSET_USAGE_CHANGED');
const only = (value: unknown, keys: string[]): JsonObject => {
  if (!obj(value) || Object.keys(value).some(k => !keys.includes(k)))
    invalid('Google returned malformed or unselected native image-reference fields.');
  return value as JsonObject;
};
const known = (resource: string, field: string, value: unknown): string | null => {
  if (value == null) return null;
  const schema = pinnedJson('.mirror/VENDOR/' + googleAdsContract + '.json').document.schemas[
    'GoogleAdsGoogleads' + googleAdsVersion.toUpperCase() + 'Resources__' + resource
  ];
  if (typeof value !== 'string' || !schema.properties[field].enum.includes(value))
    invalid('Google returned an unqualified native image-reference type or status.');
  return ['UNKNOWN', 'UNSPECIFIED'].includes(value as string) ? null : (value as string);
};
const signature = (asset: JsonObject) =>
  fingerprint(
    Object.fromEntries(
      [
        'asset_id',
        'platform',
        'account_id',
        'connection_id',
        'media_type',
        'media_id',
        'uploaded_sha256',
        'metadata_revision',
      ].map(k => [k, asset[k]]),
    ),
  );
const referenceFields = [
  'ad_group_ad_asset_view.ad_group_ad',
  'ad_group_ad_asset_view.asset',
  'ad_group_ad_asset_view.field_type',
  'ad_group_ad_asset_view.enabled',
  'campaign.id',
  'campaign.resource_name',
  'campaign.status',
  'ad_group.id',
  'ad_group.resource_name',
  'ad_group.campaign',
  'ad_group.status',
  'ad_group_ad.resource_name',
  'ad_group_ad.ad_group',
  'ad_group_ad.status',
  'ad_group_ad.ad.id',
  'ad_group_ad.ad.resource_name',
  'ad_group_ad.ad.name',
  'ad_group_ad.ad.type',
];
const supportedAds = new Set([
  'APP_AD',
  'APP_ENGAGEMENT_AD',
  'APP_PRE_REGISTRATION_AD',
  'RESPONSIVE_SEARCH_AD',
  'DEMAND_GEN_MULTI_ASSET_AD',
  'DEMAND_GEN_CAROUSEL_AD',
  'DEMAND_GEN_VIDEO_RESPONSIVE_AD',
]);
// Only documented image placements establish an image reference; other known roles remain unresolved.
const imageRoles = new Set([
  'AD_IMAGE',
  'BUSINESS_LOGO',
  'CLASSIC_DISPLAY_IMAGE',
  'LANDING_PAGE_PREVIEW',
  'LANDSCAPE_LOGO',
  'LOGO',
  'MARKETING_IMAGE',
  'PORTRAIT_MARKETING_IMAGE',
  'SQUARE_MARKETING_IMAGE',
  'TALL_PORTRAIT_MARKETING_IMAGE',
]);

/** Complete bounded selected-image links only. No file bytes, ad text, metrics, people, history or mutations. */
export async function googleImageUsage(
  store: Store,
  registry: Registry,
  transport: NativeTransport,
  credentials: CredentialProvider,
  actor: Actor,
  input: JsonObject,
) {
  validate(input, ['action', 'asset_id', 'limit', 'cursor', 'reference_view']);
  const asset = creativeAssetView(store, actor, input.asset_id),
    account = normalizeAccount(gateway, asset.account_id),
    limit = input.limit ?? 50,
    referenceView = input.reference_view ?? 'ad_images',
    pmax = referenceView === 'performance_max',
    pmaxBrand = referenceView === 'performance_max_brand',
    configuredLinks = pmax || pmaxBrand,
    selectedResource = pmaxBrand ? 'campaign_asset' : pmax ? 'asset_group_asset' : 'ad_group_ad_asset_view';
  if (!['ad_images', 'performance_max', 'performance_max_brand'].includes(referenceView))
    bad(
      'Choose the selected Google ad-image, Performance Max asset-group or campaign-logo reference view.',
      'INVALID_ARGUMENT',
    );
  if (
    asset.platform !== 'google_ads' ||
    asset.media_type !== 'image' ||
    !/^\d{1,20}$/.test(account) ||
    typeof asset.media_id !== 'string' ||
    !new RegExp('^customers/' + account + '/assets/[1-9][0-9]{0,19}$').test(asset.media_id) ||
    typeof asset.uploaded_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(asset.uploaded_sha256)
  )
    bad(
      'Current Google image references require the exact original account asset resource and uploaded SHA-256.',
      'ASSET_USAGE_UNQUALIFIED',
    );
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || input.cursor !== undefined)
    bad(
      'Choose a complete Google image-reference limit of 1–1000. This read has no native continuation.',
      'INVALID_ARGUMENT',
    );
  const base: CompiledRequest = {
      gateway,
      accountId: account,
      action: 'AMCP_GOOGLE_IMAGE_REFERENCES',
      method: 'POST',
      path: googleAdsCustomers + account + '/googleAds:search',
      query: {},
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'Selected v25 original-image ' + selectedResource + ' links',
      warnings: [],
    },
    connection = store.resolveConnection(actor, gateway, account, asset.connection_id),
    original = signature(asset);
  assertGoogleAdsScope(connection);
  new ScopeGuard(registry, store).authorize(base, connection);
  const auth = await credentials.get(connection),
    active = store.resolveConnection(actor, gateway, account, connection.id),
    requested_at = Date.now();
  const current = () => {
    store.assertActorActive(actor);
    assertGoogleAdsScope(store.resolveConnection(actor, gateway, account, connection.id));
    if (signature(creativeAssetView(store, actor, input.asset_id)) !== original || Date.now() >= requested_at + 60000)
      changed();
  };
  let usage: JsonObject = {};
  const references: JsonObject[] = [];
  const budget = new ReportCollectionBudget(
    undefined,
    fingerprint({original, requested_at, limit, referenceView}),
    state => {
      usage = state;
    },
    {requests: 24, rows: 2100, bytes: 4 * 1024 * 1024, elapsed_ms: 60000},
  );
  const read = async (resource: string, query: string, pass: number) => {
    const plan = {...base, body: {query}},
      authority = nativeAuthority(store, registry, actor, plan, active, auth, current),
      response = await transport.request(plan, authority(), auth, undefined, {beforeAttempt: authority});
    authority();
    budget.check();
    const body = only(response.data, [
      'results',
      'totalResultsCount',
      'nextPageToken',
      'fieldMask',
      'queryResourceConsumption',
    ]);
    if (
      response.status !== 200 ||
      (body.results !== undefined && !Array.isArray(body.results)) ||
      (body.nextPageToken != null && body.nextPageToken !== '')
    )
      invalid('Google returned incomplete native image-reference evidence.');
    const rows = body.results ?? [];
    budget.rows(resource + ':' + pass, rows.length);
    if (
      body.totalResultsCount !== undefined &&
      (typeof body.totalResultsCount !== 'string' ||
        !/^\d{1,7}$/.test(body.totalResultsCount) ||
        BigInt(body.totalResultsCount) < BigInt(rows.length))
    )
      invalid('Google returned unqualified image-reference result counts.');
    if (
      resource === selectedResource &&
      (rows.length > limit || (body.totalResultsCount !== undefined && BigInt(body.totalResultsCount) > BigInt(limit)))
    )
      bad(
        'The Google image-reference collection exceeds your selected limit. No partial inventory was returned.',
        'ASSET_USAGE_LIMIT',
      );
    if (
      resource === selectedResource &&
      body.totalResultsCount !== undefined &&
      BigInt(body.totalResultsCount) !== BigInt(rows.length)
    )
      invalid('Google returned an incomplete native image-reference collection.');
    references.push({
      resource,
      pass,
      source_request: {method: base.method, path: base.path, query},
      source_hash: fingerprint(body),
      captured_at: Date.now(),
      rows: rows.length,
    });
    return rows as JsonObject[];
  };
  const customer = (rows: JsonObject[]) => {
    if (rows.length !== 1) invalid('One exact Google upload customer is required.');
    const c = only(only(rows[0], ['customer']).customer, ['id', 'manager']);
    if (c.id !== account || (c.manager != null && typeof c.manager !== 'boolean'))
      invalid('Google returned a different or unqualified image upload customer.');
    if (c.manager !== false)
      bad('Select the original client upload account for Google image references.', 'ASSET_USAGE_UNQUALIFIED');
    return {id: c.id, manager: false};
  };
  const nativeAsset = (rows: JsonObject[]) => {
    if (rows.length !== 1) invalid('One exact original Google image asset is required.');
    const a = only(only(rows[0], ['asset']).asset, ['id', 'resourceName', 'type']);
    if (
      !id(a.id) ||
      a.resourceName !== asset.media_id ||
      a.resourceName !== 'customers/' + account + '/assets/' + a.id ||
      a.type !== 'IMAGE'
    )
      invalid('Google returned a different original image asset or native type.');
    return a;
  };
  const projectAds = (rows: JsonObject[]) => {
    const identities = new Set<string>();
    return rows
      .map(raw => {
        const r = only(raw, ['adGroupAdAssetView', 'campaign', 'adGroup', 'adGroupAd']),
          v = only(r.adGroupAdAssetView, ['adGroupAd', 'asset', 'fieldType', 'enabled']),
          c = only(r.campaign, ['id', 'resourceName', 'status']),
          g = only(r.adGroup, ['id', 'resourceName', 'campaign', 'status']),
          a = only(r.adGroupAd, ['resourceName', 'adGroup', 'status', 'ad']),
          ad = only(a.ad, ['id', 'resourceName', 'name', 'type']);
        if (
          !id(c.id) ||
          !id(g.id) ||
          !id(ad.id) ||
          c.resourceName !== 'customers/' + account + '/campaigns/' + c.id ||
          g.resourceName !== 'customers/' + account + '/adGroups/' + g.id ||
          g.campaign !== c.resourceName ||
          a.adGroup !== g.resourceName ||
          a.resourceName !== 'customers/' + account + '/adGroupAds/' + g.id + '~' + ad.id ||
          ad.resourceName !== 'customers/' + account + '/ads/' + ad.id ||
          v.adGroupAd !== a.resourceName ||
          v.asset !== asset.media_id ||
          (v.enabled != null && typeof v.enabled !== 'boolean') ||
          (ad.name != null &&
            (typeof ad.name !== 'string' || [...ad.name].length > 255 || /[\u0000-\u001f\ud800-\udfff]/u.test(ad.name)))
        )
          invalid('Google returned a foreign, inconsistent or malformed native image-reference identity.');
        const role = known('AdGroupAdAssetView', 'fieldType', v.fieldType),
          adType = known('Ad', 'type', ad.type),
          status = known('AdGroupAd', 'status', a.status),
          identity = fingerprint([a.resourceName, role]);
        if (identities.has(identity) || status === 'REMOVED')
          invalid('Google returned a repeated or removed native image-reference ad.');
        identities.add(identity);
        return {
          ad_id: ad.id,
          ad_resource_name: a.resourceName,
          name: ad.name ?? ad.id,
          campaign_id: c.id,
          ad_group_id: g.id,
          field_type: role,
          media_id: v.asset,
          match_field: 'ad_group_ad_asset_view.asset',
          link_enabled: v.enabled ?? null,
          ad_type: adType,
          configured_status: status,
          campaign_status: known('Campaign', 'status', c.status),
          ad_group_status: known('AdGroup', 'status', g.status),
        };
      })
      .sort(
        (a, b) =>
          a.ad_resource_name.localeCompare(b.ad_resource_name) ||
          String(a.field_type).localeCompare(String(b.field_type)),
      );
  };
  const customerQuery = 'SELECT customer.id, customer.manager FROM customer LIMIT 1',
    assetQuery =
      "SELECT asset.id, asset.resource_name, asset.type FROM asset WHERE asset.resource_name = '" +
      asset.media_id +
      "' LIMIT 1",
    adQuery =
      'SELECT ' +
      referenceFields.join(', ') +
      " FROM ad_group_ad_asset_view WHERE ad_group_ad_asset_view.asset = '" +
      asset.media_id +
      "' AND ad_group_ad.status != 'REMOVED' LIMIT " +
      (limit + 1);
  const linkQuery = pmaxBrand
    ? 'SELECT ' +
      pmaxBrandImageFields.join(', ') +
      " FROM campaign_asset WHERE campaign_asset.asset = '" +
      asset.media_id +
      "' AND campaign.status != 'REMOVED' AND campaign.advertising_channel_type = 'PERFORMANCE_MAX' AND campaign.brand_guidelines_enabled = TRUE LIMIT " +
      (limit + 1)
    : pmax
      ? 'SELECT ' +
        pmaxImageFields.join(', ') +
        " FROM asset_group_asset WHERE asset_group_asset.asset = '" +
        asset.media_id +
        "' AND asset_group.status != 'REMOVED' AND campaign.status != 'REMOVED' LIMIT " +
        (limit + 1)
      : adQuery;
  const project = (rows: JsonObject[]): JsonObject[] =>
    pmaxBrand
      ? projectPmaxBrandImageLinks(rows, {account, mediaId: asset.media_id, id, only, known, invalid})
      : pmax
        ? projectPmaxImageLinks(rows, {account, mediaId: asset.media_id, id, only, known, invalid})
        : projectAds(rows);
  try {
    return await budget.run(async () => {
      const c = customer(await read('customer', customerQuery, 1)),
        a = nativeAsset(await read('asset', assetQuery, 1)),
        first = project(await read(selectedResource, linkQuery, 1)),
        second = project(await read(selectedResource, linkQuery, 2)),
        again = nativeAsset(await read('asset', assetQuery, 2)),
        end = customer(await read('customer', customerQuery, 2));
      if (
        fingerprint(c) !== fingerprint(end) ||
        fingerprint(a) !== fingerprint(again) ||
        fingerprint(first) !== fingerprint(second)
      )
        changed();
      current();
      budget.check();
      const roles = pmaxBrand ? pmaxBrandImageRoles : imageRoles,
        rows = configuredLinks
          ? first.filter(r => ['ENABLED', 'PAUSED'].includes(r.link_status) && roles.has(r.field_type))
          : first.filter(
              r =>
                r.link_enabled === true &&
                r.field_type !== null &&
                imageRoles.has(r.field_type) &&
                r.ad_type !== null &&
                supportedAds.has(r.ad_type),
            ),
        removed = first.filter(r => (configuredLinks ? r.link_status === 'REMOVED' : r.link_enabled === false)).length;
      return {
        record_kind: 'native_asset_references',
        asset_id: asset.asset_id,
        platform: 'google_ads',
        account_id: account,
        connection_id: connection.id,
        media_type: 'image',
        media_id: asset.media_id,
        api_version: googleAdsVersion,
        qualified_view: selectedResource,
        reference_view: referenceView,
        complete: true,
        rows,
        examined_links: first.length,
        ...(pmaxBrand
          ? {examined_campaigns: new Set(first.map(r => r.campaign_resource_name)).size}
          : pmax
            ? {examined_asset_groups: new Set(first.map(r => r.asset_group_resource_name)).size}
            : {examined_ads: new Set(first.map(r => r.ad_resource_name)).size}),
        unresolved_links: first.length - rows.length - removed,
        removed_links: removed,
        has_more: false,
        next_cursor: null,
        selected_limit: limit,
        requested_at,
        captured_at: Date.now(),
        source_hash: fingerprint(first),
        source_references: references,
        collection: usage,
        provider_mutations: 0,
        saved_snapshot: false,
        meaning: pmaxBrand
          ? pmaxBrandImageMeaning
          : pmax
            ? pmaxImageMeaning
            : 'Current explicit latest-version image links in the selected Google ad asset view and original upload account. The view covers App, Demand Gen and Responsive Search ads; Responsive Display, Performance Max and other formats remain outside this evidence. Missing link flags or types remain unknown, and removed links are counted separately. Configured statuses do not prove serving, historical attribution, performance, reuse eligibility or complete all-format absence. This read grants no write authority.',
      };
    });
  } catch (error) {
    current();
    if (error instanceof MirrorError && error.code === 'REPORT_COLLECTION_LIMIT')
      bad(
        'Google image-reference inspection reached its bounded request, row, byte or time limit.',
        'ASSET_USAGE_LIMIT',
      );
    throw error;
  } finally {
    budget.close();
  }
}
