import type {ReviewedFamily} from './reviewed-family.js';
import {defineFamily, familyStateErrors, readOf, type StateFlaggedRefusal} from './family-kit.js';
import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import {changedComparableFields} from './review-state-core.js';
import {googleAdsReviewVolatile} from './google-review-volatile.js';
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
const fail: StateFlaggedRefusal = familyStateErrors('INVALID_PREVIEW_REQUEST', 'PREVIEW_STATE_UNVERIFIED');
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
  return queries.map(query =>
    readOf(p, {
      action: 'AMCP_GOOGLE_PREVIEW_READ',
      method: 'POST',
      path: googleAdsCustomers + cid(p) + '/googleAds:search',
      query: {},
      body: {query},
      clears: ['responseControls'],
    }),
  );
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
/** Why a value is not an accepted preview link, as a closed-set reason, or undefined when it is one. The guard is what it
 * was: an https link with no credentials or port, on a host accepted for its kind of preview, whose query holds no
 * credential (r12-gpreview only names the condition that failed). */
function linkProblem(v: unknown, type: Target['previewType']): string | undefined {
  if (typeof v !== 'string') return 'not_text';
  if (!v) return 'empty';
  if (v.length > 8192) return 'too_long';
  if (/[\s\u0000-\u001f]/.test(v)) return 'whitespace_or_control';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'not_a_url';
  }
  if (u.protocol !== 'https:') return 'not_https';
  if (u.username || u.password) return 'credentials';
  if (u.port) return 'port';
  if (
    ![
      'ads.google.com',
      ...(type === 'YOUTUBE_LIVE_PREVIEW' ? ['youtube.com', 'www.youtube.com', 'tv.youtube.com'] : []),
    ].includes(u.hostname)
  )
    return 'host_not_accepted';
  if ([...u.searchParams.keys()].some(k => /^(?:access_token|refresh_token|client_secret|oauth_token)$/i.test(k)))
    return 'credential_parameter';
  return undefined;
}
/**
 * Where a response is not the pinned v25 shape, named as closed-set facts: the check that failed, why, the entry and the
 * documented field it concerns, and how many. When an entry fails more than one of its leaf checks (each link, the expiry),
 * the first is the mismatch and the others are listed beside it as `also`, in the same closed set. Never a value: the links
 * stay encrypted, and no text of the provider's reaches an outcome, an audit row or an error through it. The one thing of
 * the provider's it names is a field the pinned schema does not list, as a plain identifier. Found live 2026-11-16: Google
 * answered HTTP 200, the check refused the answer, and nothing said which part of it did not match (r12-gpreview).
 */
type Checked = {rows: JsonObject[]} | {mismatch: JsonObject};
const mismatch = (check: string, reason: string, more: JsonObject = {}): Checked => ({
  mismatch: {check, reason, ...more},
});
/** The fields of `v` the pinned schema does not list: plain identifiers by name, anything else as one "(other name)". */
const unlisted = (v: JsonObject, listed: readonly string[]): string[] =>
  [
    ...new Set(
      Object.keys(v)
        .filter(k => !listed.includes(k))
        .map(k => (/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) ? k : '(other name)')),
    ),
  ].slice(0, 8);
const resultFields = ['assetGroup', 'adGroupAd', 'uiPreviewResult', 'youtubeLivePreviewResult', 'expirationDateTime'],
  youtubeLinks = ['youtubePreviewUrl', 'youtubeTvPreviewUrl'];
/**
 * How a text is written, and nothing of what it says (r25-m3-gpreview, the lead's decision of 2026-11-18, item 4): each digit as
 * 9, each of T, Z, +, -, :, . and the space as it is, every other character as ?, at most 40 characters of that, then an
 * ellipsis when there were more. A closed alphabet, so the shape of a refused value reaches an outcome, an audit row and an
 * error without a word or a link of the provider's: those show as ?. A character is a code point, so one outside the basic
 * plane is one ?. The loop stops at the 41st, so the cost does not depend on the length of the provider's text.
 */
const shapeAlphabet = new Set(['T', 'Z', '+', '-', ':', '.', ' ']);
const shapeOf = (text: string): string => {
  let out = '',
    n = 0;
  for (const c of text) {
    if (++n > 40) return out + '…';
    out += c >= '0' && c <= '9' ? '9' : shapeAlphabet.has(c) ? c : '?';
  }
  return out;
};
/**
 * Why a value is not an accepted expiry, as a closed-set reason, or undefined when it is one. The document says only
 * "ISO-8601"; the guard accepts one profile of it (the T, seconds, at most nine fraction digits, then a Z or an offset with a
 * colon), and a zone-less time names no instant. Unchanged (r12-gpreview only names the condition that failed).
 */
const expiryProblem = (v: unknown): string | undefined =>
  typeof v !== 'string'
    ? 'not_text'
    : !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(v)
      ? 'format'
      : !Number.isFinite(Date.parse(v))
        ? 'not_a_date'
        : undefined;
/**
 * The validated previews of a v25 result ({result: {previews: [...]}}), one per reviewed target, or the mismatch that
 * refused it. The shape is the pinned Discovery document's (.mirror/VENDOR/google-ads-v25.json, revision 20260923): one
 * ShareablePreviewResult per preview, naming its target and holding the result of its kind. Google answers the whole
 * request or fails it: the document has no per-preview error, so an entry that carries one is a mismatch, as is the v23
 * list of per-preview answers (`responses`). Every guard stays: the count, the match of each entry to one reviewed
 * target, the closed field sets, the link and the expiry.
 */
function inspect(p: CompiledRequest, result: TransportResult): Checked {
  const data = result.data;
  if (result.status !== 200) return mismatch('status', 'not_200', {http_status: result.status});
  if (!object(data)) return mismatch('body', 'not_an_object');
  if (Object.keys(data).some(k => k !== 'result'))
    return mismatch('body', 'unexpected_fields', {unexpected: unlisted(data, ['result'])});
  if (data.result === undefined) return mismatch('result', 'missing');
  if (!object(data.result)) return mismatch('result', 'not_an_object');
  if (Object.keys(data.result).some(k => k !== 'previews'))
    return mismatch('result', 'unexpected_fields', {unexpected: unlisted(data.result, ['previews'])});
  if (data.result.previews === undefined) return mismatch('previews', 'missing');
  if (!Array.isArray(data.result.previews)) return mismatch('previews', 'not_a_list');
  const expected = targets(p),
    rows = data.result.previews,
    seen = new Set<string>(),
    out: JsonObject[] = [];
  if (rows.length !== expected.length)
    return mismatch('count', 'differs', {entries: rows.length, targets: expected.length});
  for (const [entry, row] of rows.entries()) {
    if (!object(row)) return mismatch('entry', 'not_an_object', {entry});
    if (Object.keys(row).some(k => !resultFields.includes(k)))
      return mismatch('entry', 'unexpected_fields', {entry, unexpected: unlisted(row, resultFields)});
    const named = Number(row.assetGroup !== undefined) + Number(row.adGroupAd !== undefined);
    if (named !== 1) return mismatch('identifier', named ? 'both' : 'none', {entry});
    const kind = row.assetGroup !== undefined ? 'asset_group' : 'ad_group_ad',
      target = expected.find(t => t.kind === kind && t.name === (row.assetGroup ?? row.adGroupAd));
    if (!target) return mismatch('identifier', 'not_reviewed', {entry});
    if (seen.has(target.name)) return mismatch('identifier', 'repeated', {entry});
    seen.add(target.name);
    // The leaf checks of an entry, each link and then the expiry, are independent of one another: all are made, the first failure
    // is the mismatch as it always was, and the others are named beside it (`also`), so that one replay of a refused answer names
    // every guard it fails and not one more deploy for each (r12-gpreview, lead review S3-3). An entry with any failing leaf is
    // refused, as before.
    const faults: JsonObject[] = [],
      urls: JsonObject = {};
    if (target.previewType === 'UI_PREVIEW') {
      const ui = row.uiPreviewResult;
      if (row.youtubeLivePreviewResult !== undefined)
        return mismatch('preview_result', 'wrong_type', {entry, field: 'youtubeLivePreviewResult'});
      if (ui === undefined) return mismatch('preview_result', 'missing', {entry, field: 'uiPreviewResult'});
      if (!object(ui)) return mismatch('preview_result', 'not_an_object', {entry, field: 'uiPreviewResult'});
      if (Object.keys(ui).some(k => k !== 'shareablePreviewUrl'))
        return mismatch('preview_result', 'unexpected_fields', {
          entry,
          field: 'uiPreviewResult',
          unexpected: unlisted(ui, ['shareablePreviewUrl']),
        });
      const bad = linkProblem(ui.shareablePreviewUrl, target.previewType);
      if (bad) faults.push({check: 'link', reason: bad, entry, field: 'shareablePreviewUrl'});
      else urls.shareablePreviewUrl = ui.shareablePreviewUrl;
    } else {
      const youtube = row.youtubeLivePreviewResult;
      if (row.uiPreviewResult !== undefined)
        return mismatch('preview_result', 'wrong_type', {entry, field: 'uiPreviewResult'});
      if (youtube === undefined)
        return mismatch('preview_result', 'missing', {entry, field: 'youtubeLivePreviewResult'});
      if (!object(youtube))
        return mismatch('preview_result', 'not_an_object', {entry, field: 'youtubeLivePreviewResult'});
      if (!Object.keys(youtube).length)
        return mismatch('preview_result', 'empty', {entry, field: 'youtubeLivePreviewResult'});
      if (Object.keys(youtube).some(k => !youtubeLinks.includes(k)))
        return mismatch('preview_result', 'unexpected_fields', {
          entry,
          field: 'youtubeLivePreviewResult',
          unexpected: unlisted(youtube, youtubeLinks),
        });
      for (const [field, v] of Object.entries(youtube)) {
        const bad = linkProblem(v, target.previewType);
        if (bad) faults.push({check: 'link', reason: bad, entry, field});
        else urls[field] = v;
      }
    }
    const expiration = row.expirationDateTime,
      late = expiration === undefined ? undefined : expiryProblem(expiration);
    // A refused expiry that is text names the shape of what was refused: a form that cannot be accepted by a guess is read, never
    // guessed (the lead's decision of 2026-11-18, item 4). A value that is not text has none.
    if (late)
      faults.push({
        check: 'expiration',
        reason: late,
        entry,
        ...(typeof expiration === 'string' ? {shape: shapeOf(expiration)} : {}),
      });
    if (faults.length) {
      const [first, ...others] = faults as [JsonObject, ...JsonObject[]];
      // The same closed set as the first, at most eight (an entry has three leaf checks today).
      return {mismatch: {...first, ...(others.length ? {also: others.slice(0, 8)} : {})}};
    }
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
  return {rows: expected.map(t => out.find(r => r.target === t.name)!)};
}
const receipt = (p: CompiledRequest, result: TransportResult): JsonObject[] | undefined => {
  const checked = inspect(p, result);
  return 'rows' in checked ? checked.rows : undefined;
};
export function googlePreviewOutcome(p: CompiledRequest, result: TransportResult): boolean {
  const rows = receipt(p, result);
  return !!rows && rows.every(r => r.status === 'generated');
}
export function googlePreviewSafeOutcome(p: CompiledRequest, outcome: JsonObject): JsonObject {
  const checked = inspect(p, {data: outcome.data, status: outcome.status, headers: {}});
  return {
    ...outcome,
    data:
      'rows' in checked
        ? {preview_results: redact(checked.rows)}
        : {
            native_response_valid: false,
            response_hash: sha256(stable(outcome.data)),
            response_mismatch: checked.mismatch,
          },
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
/**
 * Deliver only validated URLs, never an unrecognized response's links. Raw responses are separately encrypted for recovery;
 * normal receipts are redacted.
 *
 * What a delivery shows, and says to do, follows one condition: whether the stored outcome says it was refused
 * (`native_response_valid: false`). A stored refusal stays a refusal: its replay never delivers links, whatever the guard of
 * the delivering release says of the answer it kept (lead review S4-2). An outcome stored before the mismatch was named is
 * explained from the retained answer, at delivery, with the same closed-set facts and no value; if this release's guard accepts
 * that answer now, the fact is `{check: 'none', reason: 'accepted_now'}` and the step is a fresh generation. Nothing is invented
 * when the retained answer is gone (r12-gpreview).
 */
export function googlePreviewDelivery(p: CompiledRequest, outcome: JsonObject, raw?: JsonObject): JsonObject {
  const safe = redact(outcome),
    refused = safe.data?.native_response_valid === false,
    checked = raw ? inspect(p, {data: raw, status: outcome.status, headers: {}}) : undefined,
    accepted = checked && 'rows' in checked ? checked.rows : undefined,
    // Links go only to an outcome that was not refused.
    rows = refused ? undefined : accepted;
  return {
    ...safe,
    ...(refused && checked
      ? {
          data: {
            ...safe.data,
            response_mismatch: 'mismatch' in checked ? checked.mismatch : {check: 'none', reason: 'accepted_now'},
          },
        }
      : {}),
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
      // The next step follows the stored outcome (r12-gpreview): a refusal shows no link, so none is to be opened, and it says to
      // report the mismatch the delivered outcome names, or that a fresh generation is needed when this release accepts the
      // answer it kept; an acceptance keeps the step it had, unless this release no longer accepts the answer it kept.
      next_action: !raw
        ? 'Private preview links expired locally or are unavailable. The original submission remains recorded; a fresh generation requires an explicit new review.'
        : refused
          ? accepted
            ? 'No link is shown. This answer was not accepted when it arrived, and a refusal that was stored stays a refusal, though this release of AMCP accepts the answer now (data.response_mismatch says so). A fresh generation needs a new review. Never repeat a successful or uncertain generation automatically.'
            : 'No link is shown, because the provider’s answer did not match what AMCP reviewed. The answer stays encrypted for recovery; report the mismatch in data.response_mismatch to support. Never repeat a successful or uncertain generation automatically.'
          : rows
            ? rows.some(r => r.status === 'generated')
              ? 'Open a generated link in a separate browser tab. Never repeat a successful or uncertain generation automatically.'
              : // An accepted answer whose previews have all expired shows no link, so none is to be opened.
                'The links of this generation have expired and none is shown. A new generation needs a new review. Never repeat a successful or uncertain generation automatically.'
            : 'No link is shown, because this release of AMCP does not accept the answer kept for this generation. A new generation needs a new review. Never repeat a successful or uncertain generation automatically.',
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
    changed = changedComparableFields(state, actual, googleAdsReviewVolatile),
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

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googlePreviewFamily: ReviewedFamily = defineFamily({
  name: 'google_shareable_previews',
  files: ['src/google-preview-writes.ts', ['tests/google-preview-writes.test.ts']],
  kind: googlePreviewKind,
  assert: plan => assertGooglePreview(plan),
  scope: c => assertGoogleAdsScope(c),
  snapshots: googlePreviewSnapshots,
  state: (plan, readers) =>
    readGooglePreviewState(
      plan,
      readers.guarded(
        'Portfolio prerequisites must remain read-only.',
        readers.sameLogin('The selected login changed during portfolio checks. Prepare again with the current login.'),
      ).read,
    ),
  impact: () => googlePreviewImpact,
  outcome: googlePreviewOutcome,
  safeOutcome: (outcome, plan) => googlePreviewSafeOutcome(plan, outcome),
  retain: (plan, response, result, submission) => {
    if (response.data && typeof response.data === 'object' && !Array.isArray(response.data))
      submission.store.savePreviewReceipt(submission.tenantId, submission.reviewId, response.data as JsonObject);
  },
  deliver: (plan, outcome, review) =>
    googlePreviewDelivery(plan, outcome, review.store.previewReceipt(review.tenantId, review.reviewId)),
  verify: (plan, v) =>
    verifyGooglePreview(
      plan,
      v.state,
      v.result,
      v.store.previewReceipt(v.actor.tenantId, v.reviewId),
      v.guarded('Preview verification must remain read-only.', {
        check: assertGoogleAdsScope,
        binding: v.sameLogin('The selected login changed during preview verification.'),
      }),
    ).then(o => ({status: o.status, checks: o.checks})),
  verifyEveryTime: true,
});
