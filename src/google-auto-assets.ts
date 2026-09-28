import {MirrorError} from './errors.js';
import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {googleAdsCustomers} from './google-version.js';

/**
 * Removal of automatically created assets, Google Ads API v23 (pinned Discovery document:
 * AdGroupAdService.RemoveAutomaticallyCreatedAssets with AssetsWithFieldType, and
 * AutomaticallyCreatedAssetRemovalService.RemoveCampaignAutomaticallyCreatedAsset with its operations; the asset links'
 * AssetSource AUTOMATICALLY_CREATED; checked 2026-09-27). Google may create assets for an ad or a campaign, such as
 * headlines; these requests remove such an asset from one ad or one campaign. Assets the advertiser added are not touched.
 */
type Kind = 'ad' | 'campaign';
type Link = {owner: string; asset: string; fieldType: string};
type Read = CompiledRequest & {googleAutoAssetState?: {kind: Kind; owners: string[]; check?: string[]}};
const maxLinks = 50;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
function invalid(message: string): never {
  return fail('INVALID_GOOGLE_AUTO_ASSET_REMOVAL', message);
}
function unverified(message: string): never {
  return fail('AUTO_ASSET_STATE_UNVERIFIED', message, {}, 502);
}
const account = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) invalid('Select one Google Ads customer.');
  return id!;
};
export function googleAutoAssetKind(p: CompiledRequest): Kind | undefined {
  if (
    p.gateway !== 'google_ads_native_action' ||
    p.method !== 'POST' ||
    p.specialTransport ||
    (p.origin && p.origin !== 'https://googleads.googleapis.com')
  )
    return;
  if (/^\/v\d+\/customers\/\d+\/adGroupAds\/[^/:]+:removeAutomaticallyCreatedAssets$/.test(p.path)) return 'ad';
  if (/^\/v\d+\/customers\/\d+:removeCampaignAutomaticallyCreatedAsset$/.test(p.path)) return 'campaign';
  return;
}
const fieldTypes = (v: unknown) =>
  typeof v === 'string' && /^[A-Z][A-Z_]{1,63}$/.test(v) && !['UNSPECIFIED', 'UNKNOWN'].includes(v);
const adOf = (p: CompiledRequest) => p.path.slice(5).replace(/:removeAutomaticallyCreatedAssets$/, '');
/** The links a request removes, keyed by owner (an ad or a campaign), asset and field type. */
function links(p: CompiledRequest): Link[] {
  const kind = googleAutoAssetKind(p),
    b = googleJson(p.body) ?? {};
  if (kind === 'ad')
    return ((b.assetsWithFieldType ?? []) as JsonObject[]).map(a => ({
      owner: adOf(p),
      asset: String(a.asset),
      fieldType: String(a.assetFieldType),
    }));
  return ((b.operations ?? []) as JsonObject[]).map(o => ({
    owner: String(o.campaign),
    asset: String(o.asset),
    fieldType: String(o.fieldType),
  }));
}
const key = (l: Link) => l.owner + '|' + l.asset + '|' + l.fieldType;
export function assertGoogleAutoAssets(p: CompiledRequest): void {
  const kind = googleAutoAssetKind(p);
  if (!kind) return;
  const id = account(p),
    asset = new RegExp('^customers/' + id + '/assets/[1-9][0-9]*$');
  if (p.path.split('/')[3] !== id && !p.path.startsWith(googleAdsCustomers + id + ':'))
    fail('ACCOUNT_SCOPE_MISMATCH', 'The path must use the selected customer.', {}, 403);
  if (Object.keys(p.query).length || Object.keys(p.headers).length)
    invalid('These reviews take no query or header overrides.');
  const b = googleJson(p.body);
  if (!object(b)) invalid('Send the native request object.');
  if (kind === 'ad') {
    if (!new RegExp('^customers/' + id + '/adGroupAds/[1-9][0-9]*~[1-9][0-9]*$').test(adOf(p)))
      invalid('The path names customers/{customer}/adGroupAds/{ad group}~{ad} of the selected customer.');
    if (
      Object.keys(b).some(k => k !== 'assetsWithFieldType') ||
      !Array.isArray(b.assetsWithFieldType) ||
      !b.assetsWithFieldType.length ||
      b.assetsWithFieldType.length > maxLinks
    )
      invalid('Send assetsWithFieldType with 1–' + maxLinks + ' {asset, assetFieldType} entries.');
    b.assetsWithFieldType.forEach((a: unknown, i: number) => {
      if (
        !object(a) ||
        Object.keys(a).some(k => !['asset', 'assetFieldType'].includes(k)) ||
        typeof a.asset !== 'string' ||
        !asset.test(a.asset) ||
        !fieldTypes(a.assetFieldType)
      )
        invalid('assetsWithFieldType[' + i + '] is {asset: customers/{customer}/assets/{asset}, assetFieldType}.');
    });
  } else {
    if (Object.keys(b).some(k => !['operations', 'partialFailure'].includes(k)))
      invalid('Send {operations, partialFailure: false}.');
    if (b.partialFailure !== false)
      invalid('partialFailure is required and must be false: every removal happens, or none.');
    if (!Array.isArray(b.operations) || !b.operations.length || b.operations.length > maxLinks)
      invalid('Send 1–' + maxLinks + ' operations.');
    b.operations.forEach((o: unknown, i: number) => {
      if (
        !object(o) ||
        Object.keys(o).some(k => !['campaign', 'asset', 'fieldType'].includes(k)) ||
        typeof o.campaign !== 'string' ||
        !new RegExp('^customers/' + id + '/campaigns/[1-9][0-9]*$').test(o.campaign) ||
        typeof o.asset !== 'string' ||
        !asset.test(o.asset) ||
        !fieldTypes(o.fieldType)
      )
        invalid('operations[' + i + '] is {campaign, asset, fieldType} of the selected customer.');
    });
  }
  const all = links(p);
  if (new Set(all.map(key)).size !== all.length) invalid('Each asset and field type appears once per owner.');
}
const quote = (v: string[]) => v.map(n => "'" + n + "'").join(', ');
function read(p: CompiledRequest, query: string): Read {
  return {
    ...p,
    action: 'AMCP_GOOGLE_AUTO_ASSET_READ',
    method: 'POST',
    path: googleAdsCustomers + account(p) + '/googleAds:search',
    body: {query},
    query: {},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
    googleAutoAssetState: undefined,
  };
}
const customerQuery = 'SELECT customer.id FROM customer LIMIT 1';
function context(p: CompiledRequest) {
  return {kind: googleAutoAssetKind(p)!, owners: [...new Set(links(p).map(l => l.owner))].sort()};
}
export function googleAutoAssetSnapshots(p: CompiledRequest): Read[] {
  return [{...read(p, customerQuery), googleAutoAssetState: context(p)}];
}
export function isGoogleAutoAssetRead(p: CompiledRequest): p is Read {
  return !!(p as Read).googleAutoAssetState;
}
/** Every automatically created asset link of each owner named, and each owner itself. */
export async function readGoogleAutoAssets(
  p: CompiledRequest,
  send: (p: Read) => Promise<TransportResult>,
): Promise<TransportResult> {
  const c = (p as Read).googleAutoAssetState;
  if (!c) return send(p);
  let requests = 0,
    count = 0;
  const search = async (query: string): Promise<JsonObject[]> => {
    const out: JsonObject[] = [],
      tokens = new Set<string>();
    let token: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 10 || ++requests > 20) unverified('Asset link state exceeded its page or request bound.');
      const plan = read(p, query);
      if (token) (plan.body as JsonObject).pageToken = token;
      const r = await send(plan),
        d = r.data;
      if (
        r.status !== 200 ||
        !object(d) ||
        (d.results !== undefined && !Array.isArray(d.results)) ||
        (d.nextPageToken !== undefined && typeof d.nextPageToken !== 'string')
      )
        unverified('Google returned a failed or unrecognized search response.');
      const values = (d.results ?? []) as unknown[];
      count += values.length;
      if (count > 2000) unverified('Asset link state exceeded 2000 rows.');
      for (const v of values) {
        if (!object(v)) unverified('A search row is malformed.');
        out.push(v);
      }
      if (!d.nextPageToken) return out;
      if (tokens.has(d.nextPageToken) || !values.length) unverified('Search pagination is repeated or incomplete.');
      tokens.add(d.nextPageToken);
      token = d.nextPageToken;
    }
  };
  const customer = await search(customerQuery);
  if (customer.length !== 1 || !object(customer[0]!.customer) || String(customer[0]!.customer.id) !== account(p))
    unverified('Verify the selected customer.');
  const owners: JsonObject = {},
    autoLinks: JsonObject = {};
  if (c.kind === 'ad') {
    for (const r of await search(
      'SELECT ad_group_ad.resource_name, ad_group_ad.status FROM ad_group_ad WHERE ad_group_ad.resource_name IN (' +
        quote(c.owners) +
        ')',
    )) {
      const v = object(r.adGroupAd) ? r.adGroupAd : {};
      if (!c.owners.includes(String(v.resourceName))) unverified('An ad row is foreign.');
      owners[String(v.resourceName)] = {status: v.status ?? null};
    }
    for (const r of await search(
      'SELECT ad_group_ad_asset_view.ad_group_ad, ad_group_ad_asset_view.asset, ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.enabled FROM ad_group_ad_asset_view WHERE ad_group_ad_asset_view.ad_group_ad IN (' +
        quote(c.owners) +
        ") AND ad_group_ad_asset_view.source = 'AUTOMATICALLY_CREATED'",
    )) {
      const v = object(r.adGroupAdAssetView) ? r.adGroupAdAssetView : {},
        l = {owner: String(v.adGroupAd), asset: String(v.asset), fieldType: String(v.fieldType)};
      if (!c.owners.includes(l.owner)) unverified('An asset link row is foreign.');
      if (v.enabled !== false) autoLinks[key(l)] = l;
    }
  } else {
    for (const r of await search(
      'SELECT campaign.resource_name, campaign.status FROM campaign WHERE campaign.resource_name IN (' +
        quote(c.owners) +
        ')',
    )) {
      const v = object(r.campaign) ? r.campaign : {};
      if (!c.owners.includes(String(v.resourceName))) unverified('A campaign row is foreign.');
      owners[String(v.resourceName)] = {status: v.status ?? null};
    }
    for (const r of await search(
      'SELECT campaign_asset.campaign, campaign_asset.asset, campaign_asset.field_type, campaign_asset.status FROM campaign_asset WHERE campaign_asset.campaign IN (' +
        quote(c.owners) +
        ") AND campaign_asset.source = 'AUTOMATICALLY_CREATED'",
    )) {
      const v = object(r.campaignAsset) ? r.campaignAsset : {},
        l = {owner: String(v.campaign), asset: String(v.asset), fieldType: String(v.fieldType)};
      if (!c.owners.includes(l.owner)) unverified('An asset link row is foreign.');
      if (v.status !== 'REMOVED') autoLinks[key(l)] = l;
    }
  }
  return {status: 200, headers: {}, data: {customer: {id: account(p)}, kind: c.kind, owners, links: autoLinks}};
}
export function validateGoogleAutoAssetState(p: CompiledRequest, r: TransportResult): void {
  const d = r.data;
  if (
    !(p as Read).googleAutoAssetState ||
    r.status !== 200 ||
    !object(d) ||
    !object(d.customer) ||
    d.customer.id !== account(p) ||
    !object(d.owners) ||
    !object(d.links)
  )
    unverified('Complete asset link state is missing.');
}
export function googleAutoAssetPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const kind = googleAutoAssetKind(p);
  if (!kind) return;
  const s = states[0];
  if (!object(s) || !object(s.owners) || !object(s.links)) unverified('Complete asset link state is missing.');
  for (const l of links(p)) {
    const o = s.owners[l.owner];
    if (!object(o))
      fail(
        'STATE_TARGET_MISMATCH',
        (kind === 'ad' ? 'Ad ' : 'Campaign ') + l.owner + ' is not in the selected customer.',
        {resource: l.owner},
        409,
      );
    if (o.status === 'REMOVED') invalid((kind === 'ad' ? 'Ad ' : 'Campaign ') + l.owner + ' is removed.');
    if (!Object.hasOwn(s.links, key(l)))
      fail(
        'STATE_NOT_FOUND',
        'Asset ' +
          l.asset +
          ' is not an automatically created ' +
          l.fieldType +
          ' asset of ' +
          l.owner +
          '; assets the advertiser added are removed with ordinary asset link requests.',
        {asset: l.asset},
      );
  }
}
/** Removing assets narrows what ads show; the owner rule counts it as a deletion. */
export function googleAutoAssetRemoves(p: CompiledRequest): boolean {
  return !!googleAutoAssetKind(p);
}
export function googleAutoAssetImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const kind = googleAutoAssetKind(p);
  if (!kind) return;
  const first = state[0],
    s: JsonObject = object(first) ? first : {};
  return {
    provider: 'google',
    scope: kind === 'ad' ? 'ad_automatically_created_assets' : 'campaign_automatically_created_assets',
    removing: links(p),
    owners: object(s.owners) ? s.owners : null,
    may_affect_serving: true,
    effect:
      'Removes these automatically created assets from the ' +
      (kind === 'ad' ? 'ad' : 'campaign') +
      '; ads stop showing them. Google may create other assets while automatic asset creation stays on.',
    verification: 'Reads the automatically created asset links again and expects the removed ones to be gone.',
    source:
      'https://developers.google.com/google-ads/api/reference/rpc/v25/' +
      (kind === 'ad' ? 'AdGroupAdService' : 'AutomaticallyCreatedAssetRemovalService'),
  };
}
export function googleAutoAssetOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const d = r.data;
  if (r.status !== 200) return false;
  // Both methods answer with an empty body, or a partial failure error that means some removals failed.
  return (
    d == null ||
    (object(d) &&
      (d.partialFailureError === undefined || d.partialFailureError === null) &&
      Object.keys(d).every(k => k === 'partialFailureError'))
  );
}
export function googleAutoAssetVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const c = context(p),
    check = links(p).map(key),
    probe: Read = {...read(p, customerQuery), googleAutoAssetState: {...c, check}};
  return [{read: probe, expected: {removed: Object.fromEntries(check.map(k => [k, true]))}, id: c.owners.join(',')}];
}
export function googleAutoAssetObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const present = object(data.links) ? data.links : {},
    check = (read as Read).googleAutoAssetState?.check ?? [];
  return {removed: Object.fromEntries(check.map(k => [k, !Object.hasOwn(present, k)]))};
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleAutoAssetFamily: ReviewedFamily = {
  name: 'google_auto_assets',
  files: ['src/google-auto-assets.ts', ['tests/google-auto-assets.test.mjs']],
  kind: googleAutoAssetKind,
  assert: assertGoogleAutoAssets,
  scope: assertGoogleAdsScope,
  snapshots: googleAutoAssetSnapshots,
  isRead: isGoogleAutoAssetRead,
  reader: readGoogleAutoAssets,
  validateState: validateGoogleAutoAssetState,
  prerequisites: googleAutoAssetPrerequisites,
  impact: googleAutoAssetImpact,
  outcome: googleAutoAssetOutcome,
  verification: googleAutoAssetVerification,
  observed: googleAutoAssetObserved,
  exemptFromSpendTextMatch: true,
  destructive: googleAutoAssetRemoves,
};
