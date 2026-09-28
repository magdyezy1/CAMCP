import {MirrorError} from './errors.js';
import {googleJson} from './google-contracts.js';
import {changedStateFields} from './review-state.js';
import {redact, stable, sha256} from './security.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {googleAdsCustomers, googleAdsVersion} from './google-version.js';

type Send = (read: CompiledRequest) => Promise<TransportResult>;
type Target = {
  kind: 'asset_group' | 'ad_group_ad';
  name: string;
  previewType: 'UI_PREVIEW' | 'YOUTUBE_LIVE_PREVIEW';
};
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
function fail(message: string, state = false): never {
  throw new MirrorError(state ? 'PREVIEW_STATE_UNVERIFIED' : 'INVALID_PREVIEW_REQUEST', message, {}, state ? 502 : 400);
}
const only = (v: JsonObject, keys: string[], state = false) => {
  if (Object.keys(v).some(k => !keys.includes(k)))
    fail('An unqualified preview field or response envelope was returned.', state);
};
const pick = (v: JsonObject, keys: string[]) =>
  Object.fromEntries(keys.filter(k => v[k] !== undefined).map(k => [k, v[k]]));
function destinationState(v: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of ['finalUrls', 'finalMobileUrls'])
    if (v[key] !== undefined) {
      if (
        !Array.isArray(v[key]) ||
        v[key].length > 100 ||
        v[key].some((s: unknown) => typeof s !== 'string' || s.length > 8192)
      )
        fail('The source destination URL list is malformed.', true);
      out[key] = v[key].map((url: string) => ({sha256: sha256(url), display: redact(url)}));
    }
  for (const key of ['displayUrl', 'trackingUrlTemplate', 'finalUrlSuffix'])
    if (v[key] !== undefined) {
      if (typeof v[key] !== 'string' || v[key].length > 8192) fail('A source URL field is malformed.', true);
      out[key] = {sha256: sha256(v[key]), display: redact(v[key])};
    }
  return out;
}
const cid = (p: CompiledRequest) => {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^[1-9][0-9]*$/.test(id)) fail('Choose an exact Google Ads client customer.');
  return id!;
};
function resource(p: CompiledRequest, v: unknown, kind: string, pattern = '[1-9][0-9]*'): string {
  if (typeof v !== 'string' || !new RegExp('^customers/' + cid(p) + '/' + kind + '/' + pattern + '$').test(v))
    fail('The preview resource must belong to the selected customer.');
  return v as string;
}
export function googlePreviewKind(p: CompiledRequest): boolean {
  return (
    p.gateway === 'google_ads_native_action' &&
    p.method === 'POST' &&
    !p.specialTransport &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    /^\/v\d+\/customers\/\d+:generateShareablePreviews$/.test(p.path)
  );
}
/** The previews a request names. Google Ads v25 takes {operation: {shareablePreviews: [{assetGroup | adGroupAd,
 * previewType}]}} (actions/generate_shareable_previews.proto; tests/fixtures/google-preview-v25.json). */
function targets(p: CompiledRequest): Target[] {
  const body = googleJson(p.body);
  if (!object(body) || !object(body.operation)) fail('Supply the native operation with its shareablePreviews list.');
  only(body, ['operation']);
  only(body.operation, ['shareablePreviews']);
  const list = body.operation.shareablePreviews;
  if (!Array.isArray(list) || !list.length || list.length > 25) fail('Review 1–25 distinct previews per request.');
  const out: Target[] = list.map((r: unknown) => {
    if (!object(r)) fail('Each preview must be an object.');
    only(r, ['assetGroup', 'adGroupAd', 'previewType']);
    if (r.assetGroup !== undefined) {
      if (r.adGroupAd !== undefined || r.previewType !== 'UI_PREVIEW')
        fail('An asset group preview names previewType UI_PREVIEW and no adGroupAd.');
      return {kind: 'asset_group', name: resource(p, r.assetGroup, 'assetGroups'), previewType: 'UI_PREVIEW'};
    }
    if (r.previewType !== 'YOUTUBE_LIVE_PREVIEW') fail('An adGroupAd preview names previewType YOUTUBE_LIVE_PREVIEW.');
    return {
      kind: 'ad_group_ad',
      name: resource(p, r.adGroupAd, 'adGroupAds', '[1-9][0-9]*~[1-9][0-9]*'),
      previewType: 'YOUTUBE_LIVE_PREVIEW',
    };
  });
  if (new Set(out.map(r => r.name)).size !== out.length) fail('Each preview target may occur only once.');
  return out;
}
export function assertGooglePreview(p: CompiledRequest): void {
  if (
    p.path !== googleAdsCustomers + cid(p) + ':generateShareablePreviews' ||
    Object.keys(p.query).length ||
    Object.keys(p.headers).length
  )
    fail('Use the fixed customer RPC without query or header overrides.');
  targets(p);
}
const campaignFields = ['resource_name', 'id', 'name', 'status', 'advertising_channel_type'];
const groupFields = [
  'resource_name',
  'id',
  'name',
  'status',
  'campaign',
  'final_urls',
  'final_mobile_urls',
  'path1',
  'path2',
];
const adFields = [
  'resource_name',
  'status',
  'ad_group',
  'ad.resource_name',
  'ad.id',
  'ad.name',
  'ad.type',
  'ad.final_urls',
  'ad.final_mobile_urls',
  'ad.display_url',
  'ad.tracking_url_template',
  'ad.final_url_suffix',
];
export function googlePreviewSnapshots(p: CompiledRequest): CompiledRequest[] {
  const t = targets(p),
    queries = [
      'SELECT customer.id, customer.currency_code, customer.time_zone, customer.manager FROM customer LIMIT 1',
    ];
  for (const kind of ['asset_group', 'ad_group_ad'] as const) {
    const names = t.filter(x => x.kind === kind).map(x => x.name);
    if (!names.length) continue;
    const fields = [
      ...(kind === 'asset_group' ? groupFields : adFields).map(f => kind + '.' + f),
      ...campaignFields.map(f => 'campaign.' + f),
      ...(kind === 'ad_group_ad'
        ? ['ad_group.resource_name', 'ad_group.id', 'ad_group.campaign', 'ad_group.status']
        : []),
    ];
    queries.push(
      'SELECT ' +
        fields.join(', ') +
        ' FROM ' +
        kind +
        ' WHERE ' +
        kind +
        '.resource_name IN (' +
        names.map(n => "'" + n + "'").join(', ') +
        ')',
    );
  }
  return queries.map(query => ({
    ...p,
    action: 'AMCP_GOOGLE_PREVIEW_READ',
    method: 'POST',
    path: googleAdsCustomers + cid(p) + '/googleAds:search',
    query: {},
    body: {query},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    responseControls: undefined,
  }));
}
/** Preview approval authorizes sharing these existing sources, not campaign
 * changes or an assertion that the renderer freezes every inherited asset. */
export async function readGooglePreviewState(p: CompiledRequest, send: Send): Promise<unknown[]> {
  const expected = targets(p),
    started = performance.now();
  let requests = 0,
    bytes = 0;
  const snapshot = async () => {
    const state: JsonObject = {sources: {}};
    for (const read of googlePreviewSnapshots(p)) {
      const query = (read.body as JsonObject).query,
        kind = / FROM ([a-z_]+)/.exec(query)![1]!,
        all: JsonObject[] = [],
        tokens = new Set<string>();
      let token: string | undefined, count: string | undefined;
      for (let page = 0; ; page++) {
        if (++requests > 100 || page >= 25 || performance.now() - started > 60000)
          fail('Preview source reads exceeded their request, page or monotonic deadline bound.', true);
        const result = await send({...read, body: {query, ...(token ? {pageToken: token} : {})}}),
          data = result.data;
        if (result.status !== 200 || !object(data))
          fail('The source read did not return a successful native object.', true);
        only(
          data,
          ['results', 'nextPageToken', 'totalResultsCount', 'fieldMask', 'queryResourceConsumption', 'requestId'],
          true,
        );
        bytes += Buffer.byteLength(JSON.stringify(data));
        if (bytes > 8 * 1024 * 1024 || performance.now() - started > 60000)
          fail('Preview source reads exceeded their byte or deadline bound.', true);
        if (
          (data.results !== undefined && !Array.isArray(data.results)) ||
          (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string')
        )
          fail('Malformed native source page.', true);
        if (data.totalResultsCount !== undefined) {
          const n = String(data.totalResultsCount);
          if (!/^\d+$/.test(n) || (count !== undefined && count !== n))
            fail('The source count is malformed or changed between pages.', true);
          count = n;
        }
        const rows = data.results ?? [];
        if (rows.some((r: unknown) => !object(r))) fail('Source rows must be native objects.', true);
        all.push(...rows);
        if (all.length > (kind === 'customer' ? 1 : 25))
          fail('The source read exceeds the exact requested target count.', true);
        if (!data.nextPageToken) break;
        if (!rows.length || data.nextPageToken.length > 4096 || tokens.has(data.nextPageToken))
          fail('The source cursor repeated or returned an incomplete page.', true);
        token = data.nextPageToken;
        tokens.add(token!);
      }
      if (count !== undefined && BigInt(count) !== BigInt(all.length))
        fail('The source count proves incomplete data.', true);
      if (kind === 'customer') {
        const c = all[0]?.customer;
        if (
          all.length !== 1 ||
          !object(c) ||
          c.id !== cid(p) ||
          typeof c.currencyCode !== 'string' ||
          !/^[A-Z]{3}$/.test(c.currencyCode) ||
          typeof c.timeZone !== 'string' ||
          !c.timeZone ||
          (c.manager !== undefined && c.manager !== false)
        )
          fail('A current client customer identity, currency and timezone are required.', true);
        state.customer = {id: c.id, currencyCode: c.currencyCode, timeZone: c.timeZone, manager: false};
        continue;
      }
      const names = expected.filter(t => t.kind === kind).map(t => t.name),
        seen = new Set<string>();
      for (const row of all) {
        only(row, kind === 'asset_group' ? ['assetGroup', 'campaign'] : ['adGroupAd', 'adGroup', 'campaign'], true);
        const source = row[kind === 'asset_group' ? 'assetGroup' : 'adGroupAd'],
          campaign = row.campaign;
        if (
          !object(source) ||
          !object(campaign) ||
          !names.includes(source.resourceName) ||
          seen.has(source.resourceName) ||
          !['ENABLED', 'PAUSED'].includes(source.status) ||
          !['ENABLED', 'PAUSED'].includes(campaign.status)
        )
          fail('The preview target is absent, duplicated, removed or malformed.', true);
        seen.add(source.resourceName);
        const parent = resource(p, campaign.resourceName, 'campaigns');
        if (campaign.id !== parent.split('/').at(-1) || typeof campaign.name !== 'string')
          fail('Campaign identity or name is missing.', true);
        const selected: JsonObject = {
          campaign: pick(campaign, ['resourceName', 'id', 'name', 'status', 'advertisingChannelType']),
        };
        if (kind === 'asset_group') {
          if (
            source.campaign !== parent ||
            campaign.advertisingChannelType !== 'PERFORMANCE_MAX' ||
            source.id !== source.resourceName.split('/').at(-1) ||
            typeof source.name !== 'string'
          )
            fail('UI previews require the selected existing Performance Max asset group and its campaign.', true);
          selected.assetGroup = {
            ...pick(source, ['resourceName', 'id', 'name', 'status', 'campaign', 'path1', 'path2']),
            ...destinationState(source),
          };
        } else {
          const group = row.adGroup,
            ad = source.ad,
            parts = source.resourceName.split('/').at(-1)!.split('~');
          if (
            !object(group) ||
            !object(ad) ||
            group.resourceName !== resource(p, source.adGroup, 'adGroups') ||
            group.resourceName !== 'customers/' + cid(p) + '/adGroups/' + parts[0] ||
            group.id !== parts[0] ||
            group.campaign !== parent ||
            !['ENABLED', 'PAUSED'].includes(group.status) ||
            ad.id !== parts[1] ||
            ad.resourceName !== resource(p, 'customers/' + cid(p) + '/ads/' + parts[1], 'ads')
          )
            fail('The ad, ad group and campaign must have matching current identities.', true);
          if (
            ![
              'VIDEO_AD',
              'VIDEO_BUMPER_AD',
              'VIDEO_NON_SKIPPABLE_IN_STREAM_AD',
              'VIDEO_TRUEVIEW_IN_STREAM_AD',
              'VIDEO_RESPONSIVE_AD',
              'IN_FEED_VIDEO_AD',
              'DEMAND_GEN_VIDEO_RESPONSIVE_AD',
              'YOUTUBE_AUDIO_AD',
            ].includes(ad.type)
          )
            fail(
              'Google does not support this ad type for YouTube previews. Search/Display ads are not supported.',
              true,
            );
          selected.adGroup = pick(group, ['resourceName', 'id', 'campaign', 'status']);
          selected.adGroupAd = {
            ...pick(source, ['resourceName', 'status', 'adGroup']),
            ad: {...pick(ad, ['resourceName', 'id', 'type', 'name']), ...destinationState(ad)},
          };
        }
        state.sources[source.resourceName] = selected;
      }
      if (seen.size !== names.length) fail('Every requested preview source must be present in this customer.', true);
    }
    return state;
  };
  const first = await snapshot(),
    second = await snapshot();
  if (stable(first) !== stable(second))
    fail('Preview sources changed during discovery; review their current identities again.', true);
  return [first];
}
function link(v: unknown, type: Target['previewType']): string | undefined {
  if (typeof v !== 'string' || !v || v.length > 8192 || /[\s\u0000-\u001f]/.test(v)) return;
  try {
    const u = new URL(v);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      ![
        'ads.google.com',
        ...(type === 'YOUTUBE_LIVE_PREVIEW' ? ['youtube.com', 'www.youtube.com', 'tv.youtube.com'] : []),
      ].includes(u.hostname) ||
      [...u.searchParams.keys()].some(k => /^(?:access_token|refresh_token|client_secret|oauth_token)$/i.test(k))
    )
      return;
    return v;
  } catch {
    return;
  }
}
/** The validated previews of a v25 result ({result: {previews: [...]}}), one per reviewed target, or undefined when the
 * response is not exactly that. Google answers the whole request or fails it: there are no per-preview errors. */
function receipt(p: CompiledRequest, result: TransportResult): JsonObject[] | undefined {
  const data = result.data;
  if (
    result.status !== 200 ||
    !object(data) ||
    Object.keys(data).some(k => k !== 'result') ||
    !object(data.result) ||
    Object.keys(data.result).some(k => k !== 'previews') ||
    !Array.isArray(data.result.previews)
  )
    return;
  const expected = targets(p),
    rows = data.result.previews,
    seen = new Set<string>(),
    out: JsonObject[] = [];
  if (rows.length !== expected.length) return;
  for (const row of rows) {
    if (
      !object(row) ||
      Object.keys(row).some(
        k =>
          !['assetGroup', 'adGroupAd', 'uiPreviewResult', 'youtubeLivePreviewResult', 'expirationDateTime'].includes(k),
      ) ||
      Number(row.assetGroup !== undefined) + Number(row.adGroupAd !== undefined) !== 1
    )
      return;
    const kind = row.assetGroup !== undefined ? 'asset_group' : 'ad_group_ad',
      target = expected.find(t => t.kind === kind && t.name === (row.assetGroup ?? row.adGroupAd));
    if (!target || seen.has(target.name)) return;
    seen.add(target.name);
    const urls: JsonObject = {};
    if (target.previewType === 'UI_PREVIEW') {
      const ui = row.uiPreviewResult;
      if (
        row.youtubeLivePreviewResult !== undefined ||
        !object(ui) ||
        Object.keys(ui).some(k => k !== 'shareablePreviewUrl') ||
        !link(ui.shareablePreviewUrl, target.previewType)
      )
        return;
      urls.shareablePreviewUrl = ui.shareablePreviewUrl;
    } else {
      const youtube = row.youtubeLivePreviewResult;
      if (
        row.uiPreviewResult !== undefined ||
        !object(youtube) ||
        !Object.keys(youtube).length ||
        Object.keys(youtube).some(k => !['youtubePreviewUrl', 'youtubeTvPreviewUrl'].includes(k))
      )
        return;
      for (const [k, v] of Object.entries(youtube)) {
        if (!link(v, target.previewType)) return;
        urls[k] = v;
      }
    }
    const expiration = row.expirationDateTime;
    if (
      expiration !== undefined &&
      (typeof expiration !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(expiration) ||
        !Number.isFinite(Date.parse(expiration)))
    )
      return;
    const expired = expiration !== undefined && Date.parse(expiration) <= Date.now();
    out.push({
      target: target.name,
      preview_type: target.previewType,
      status: expired ? 'expired' : 'generated',
      ...(expired ? {} : urls),
      expiration_date_time: expiration ?? null,
      expiration_known: expiration !== undefined,
    });
  }
  return expected.map(t => out.find(r => r.target === t.name)!);
}
export function googlePreviewOutcome(p: CompiledRequest, result: TransportResult): boolean {
  const rows = receipt(p, result);
  return !!rows && rows.every(r => r.status === 'generated');
}
export function googlePreviewSafeOutcome(p: CompiledRequest, outcome: JsonObject): JsonObject {
  const rows = receipt(p, {data: outcome.data, status: outcome.status, headers: {}});
  return {
    ...outcome,
    data: rows
      ? {preview_results: redact(rows)}
      : {native_response_valid: false, response_hash: sha256(stable(outcome.data))},
    ...(outcome.failures
      ? {
          failures: outcome.failures.map((f: JsonObject) => ({
            path: f.path,
            message:
              'The response does not match the reviewed previews. Its native details remain only in encrypted recovery storage.',
          })),
        }
      : {}),
  };
}
/** Deliver only validated URLs, never an unrecognized response's links. Raw
 * responses are separately encrypted for recovery; normal receipts are redacted. */
export function googlePreviewDelivery(p: CompiledRequest, outcome: JsonObject, raw?: JsonObject): JsonObject {
  const safe = redact(outcome),
    rows = raw ? receipt(p, {data: raw, status: outcome.status, headers: {}}) : undefined;
  return {
    ...safe,
    previews: {
      status: rows
        ? rows.every(r => r.status === 'generated')
          ? 'generated'
          : rows.some(r => r.status === 'generated')
            ? 'partial'
            : 'unavailable'
        : 'unavailable',
      results: rows ?? [],
      links_retained: !!raw,
      automatic_regeneration: false,
      next_action: raw
        ? 'Open a generated link in a separate browser tab. Never repeat a successful or uncertain generation automatically.'
        : 'Private preview links expired locally or are unavailable. The original submission remains recorded; a fresh generation requires an explicit new review.',
    },
  };
}
export async function verifyGooglePreview(
  p: CompiledRequest,
  state: unknown[],
  outcome: JsonObject,
  raw: JsonObject | undefined,
  send: Send,
): Promise<JsonObject> {
  const actual = await readGooglePreviewState(p, send),
    changed = changedStateFields(state, actual),
    rows = raw ? receipt(p, {data: raw, status: outcome.status, headers: {}}) : undefined;
  const status = rows?.every(r => r.status === 'generated') && !changed.length ? 'verified' : 'inconclusive';
  return {
    status,
    checks: [
      {
        status,
        verification_scope: 'original provider receipt and current source identity/configuration',
        expected_hash: sha256(stable(state)),
        actual_hash: sha256(stable(actual)),
        changed_fields: changed,
        links_available: !!rows?.every(r => r.status === 'generated'),
        preview_rendering: 'unverified',
        link_fetched: false,
        provider_mutations: 0,
      },
    ],
  };
}
export const googlePreviewImpact = {
  provider: 'google_ads',
  effect:
    'Creates expiring shareable preview links for existing Performance Max asset groups or eligible YouTube ads. Does not edit, activate or publish an ad, send a message, or change a budget.',
  sharing:
    'Anyone receiving a link may be able to view the creative. Treat links as private capabilities. Only share with recipients the user authorizes. URLs are encrypted for at most 24 hours locally and redacted from normal receipts/audit.',
  state_boundary:
    'Freezes selected source IDs, names, delivery state, parent identity/channel and destination URLs. The preview is rendered by Google and can reflect inherited assets, feeds or later source changes; this is not approval or a byte-frozen rendering of creative content.',
  limits:
    'Google Ads ' +
    googleAdsVersion +
    ', 1–25 distinct targets: asset groups take UI_PREVIEW and eligible video ads YOUTUBE_LIVE_PREVIEW; Search and Display ads are unsupported. Google accepts or rejects the whole request, so one ineligible target fails every preview in it. Preview links cannot be embedded in iframes. Expiration is provider-controlled.',
  recovery:
    'One generation attempt per frozen review. Reuse its receipt and key after a lost client response. Read-back validates that receipt and current sources without fetching or regenerating links. An uncertain submission must not be repeated automatically.',
};
