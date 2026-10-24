import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {fail, stateReadOf} from './family-kit.js';

/**
 * TikTok asset library edits, per API for Business v1.3 "Update the name of an image", "Update the name of a video",
 * "Delete creative assets", "Search for images" and "Search for videos" (checked 2026-09-27). A name has 1–100
 * characters; "If another image uses the same file name under the same advertiser_id, there will a millisecond timestamp
 * added at the end" (videos alike). A deletion takes at most 50 video IDs and 50 image IDs and answers with
 * failed_video_ids and failed_image_ids. TikTok does not document deleting an asset that ads use; AMCP refuses it.
 * Searches filtered by up to 100 IDs are the reads: the review reads the named assets (and, for deletions, the ads and
 * Upgraded Smart+ ads that use them) and verification reads them again.
 */
type Route = 'image_name' | 'video_name' | 'delete';
type State = {route: Route; images: string[]; videos: string[]; usage: boolean; name?: string};
type Read = CompiledRequest & {tiktokLibraryState?: State};
export const tiktokLibraryPaths = {
  image_name: '/v1.3/file/image/ad/update/',
  video_name: '/v1.3/file/video/ad/update/',
  delete: '/v1.3/creative/asset/delete/',
};
const gateway = 'tiktok_native_action',
  maxDelete = 50,
  nameMax = 100,
  adPageSize = 1000,
  maxAdPages = 10,
  smartPageSize = 100,
  maxSmartPages = 10,
  maxDepth = 6;
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
// Image IDs are web URIs such as ad-site-i18n-sg/202011165d0d...; video IDs are like v10033g50000abc.
const imageId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_.\/-]{1,256}$/.test(v) && !v.includes('..');
const videoId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function invalid(message: string): never {
  return fail('INVALID_TIKTOK_LIBRARY_ASSET', message);
}
function unverified(message: string): never {
  return fail('INCOMPLETE_STATE', message, {}, 502);
}
export function tiktokLibraryKind(p: CompiledRequest): Route | undefined {
  if (p.gateway !== gateway || p.method !== 'POST' || p.specialTransport) return;
  return Object.entries(tiktokLibraryPaths).find(([, path]) => path === p.path)?.[0] as Route | undefined;
}
const body = (p: CompiledRequest): JsonObject => (obj(p.body) ? p.body : {});
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).sort() : []);
function stateOf(p: CompiledRequest, verify = false): State {
  const route = tiktokLibraryKind(p)!,
    b = body(p);
  if (route === 'image_name')
    return {
      route,
      images: [String(b.image_id)],
      videos: [],
      usage: false,
      ...(verify ? {name: String(b.file_name)} : {}),
    };
  if (route === 'video_name')
    return {
      route,
      images: [],
      videos: [String(b.video_id)],
      usage: false,
      ...(verify ? {name: String(b.file_name)} : {}),
    };
  return {route, images: list(b.image_ids), videos: list(b.video_ids), usage: !verify};
}
export function assertTiktokLibraryAsset(p: CompiledRequest): void {
  const route = tiktokLibraryKind(p);
  if (!route) return;
  if (Object.keys(p.query).length) invalid('Asset library edits take no query parameters.');
  const b = p.body;
  if (!obj(b)) invalid('Send the request as a JSON object.');
  if (String(b.advertiser_id) !== p.accountId)
    fail('ACCOUNT_SCOPE_MISMATCH', 'advertiser_id must be the selected advertiser.', {}, 403);
  if (route !== 'delete') {
    const id = route === 'image_name' ? 'image_id' : 'video_id',
      extra = Object.keys(b).filter(k => !['advertiser_id', id, 'file_name'].includes(k));
    if (extra.length) invalid('A rename takes ' + id + ' and file_name, not ' + extra.join(', ') + '.');
    if (route === 'image_name' ? !imageId(b.image_id) : !videoId(b.video_id))
      invalid(id + ' names one ' + (route === 'image_name' ? 'image' : 'video') + ' of the asset library.');
    const n = b.file_name;
    if (
      typeof n !== 'string' ||
      !n.trim() ||
      n !== n.trim() ||
      [...n].length > nameMax ||
      /[\u0000-\u001f\u007f]/.test(n)
    )
      invalid(
        'file_name has 1–' + nameMax + ' characters, without leading or trailing spaces (TikTok cuts longer names).',
      );
    return;
  }
  const extra = Object.keys(b).filter(k => !['advertiser_id', 'image_ids', 'video_ids'].includes(k));
  if (extra.length) invalid('A deletion takes image_ids and video_ids, not ' + extra.join(', ') + '.');
  for (const [k, check] of [
    ['image_ids', imageId],
    ['video_ids', videoId],
  ] as const) {
    const v = b[k];
    if (v === undefined) continue;
    if (
      !Array.isArray(v) ||
      !v.length ||
      v.length > maxDelete ||
      v.some(x => !check(x)) ||
      new Set(v).size !== v.length
    )
      invalid(k + ' lists 1–' + maxDelete + ' different asset IDs.');
  }
  if (b.image_ids === undefined && b.video_ids === undefined) invalid('A deletion names image_ids, video_ids or both.');
}
const read = (p: CompiledRequest, action: string, path: string, query: JsonObject, state?: State): Read =>
  stateReadOf<Read>(p, action, path, {advertiser_id: p.accountId, ...query}, {tiktokLibraryState: state});
const imageSearch = (p: CompiledRequest, ids: string[], s?: State) =>
  read(
    p,
    'tiktok_file_image_ad_search',
    '/v1.3/file/image/ad/search/',
    {filtering: {image_ids: ids}, page: 1, page_size: 100},
    s,
  );
const videoSearch = (p: CompiledRequest, ids: string[], s?: State) =>
  read(
    p,
    'tiktok_file_video_ad_search',
    '/v1.3/file/video/ad/search/',
    {filtering: {video_ids: ids}, page: 1, page_size: 100},
    s,
  );
function stateRead(p: CompiledRequest, s: State): Read {
  return s.images.length ? imageSearch(p, s.images, s) : videoSearch(p, s.videos, s);
}
export function tiktokLibrarySnapshots(p: CompiledRequest): Read[] {
  return [stateRead(p, stateOf(p))];
}
export function isTiktokLibraryRead(p: CompiledRequest): p is Read {
  return p.gateway === gateway && !!(p as Read).tiktokLibraryState;
}
function ok(r: TransportResult, label: string): JsonObject {
  const d = r.data;
  if (r.status !== 200 || !obj(d) || d.code !== 0 || !obj(d.data))
    unverified('TikTok did not return the ' + label + '.');
  return (d as JsonObject).data;
}
async function pages(
  first: Read,
  label: string,
  max: number,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<JsonObject[]> {
  const out: JsonObject[] = [];
  let total = 1;
  for (let page = 1; page <= total; page++) {
    if (page > max) unverified('The advertiser has more ' + label + ' than one review reads.');
    const d = ok(
      await request({...first, tiktokLibraryState: undefined, query: {...first.query, page}} as Read),
      label,
    );
    if (d.list !== undefined && !Array.isArray(d.list)) unverified('TikTok did not list the ' + label + '.');
    const n = Number(obj(d.page_info) ? (d.page_info.total_page ?? 1) : 1);
    if (!Number.isInteger(n) || n < 0) unverified('TikTok returned an invalid page count.');
    if (page === 1) total = Math.max(n, 1);
    for (const row of (d.list ?? []) as unknown[]) {
      if (!obj(row)) unverified('A row of the ' + label + ' is malformed.');
      out.push(row as JsonObject);
    }
  }
  return out;
}
/** Every video and image an ad names: video_id and image_ids, and in Upgraded Smart+ creatives video_info and image_info. */
function assetsOf(v: unknown, depth = 0, out = new Set<string>()): Set<string> {
  if (depth > maxDepth) return out;
  if (Array.isArray(v)) {
    for (const x of v) assetsOf(x, depth + 1, out);
    return out;
  }
  if (!obj(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    if (['video_id', 'image_id', 'web_uri'].includes(k) && typeof x === 'string') {
      out.add(x);
      continue;
    }
    if (k === 'image_ids' && Array.isArray(x)) {
      for (const i of x) if (typeof i === 'string') out.add(i);
      continue;
    }
    if (obj(x) || Array.isArray(x)) assetsOf(x, depth + 1, out);
  }
  return out;
}
/** The named images or videos; for deletions also the ads and Upgraded Smart+ ads that use them. */
export async function readTiktokLibraryAssets(
  p: CompiledRequest,
  request: (p: CompiledRequest) => Promise<TransportResult>,
): Promise<TransportResult> {
  const s = (p as Read).tiktokLibraryState;
  if (!s) return request(p);
  const found = async (kind: 'image' | 'video', ids: string[]) => {
    if (!ids.length) return [];
    const rows = await pages(
      kind === 'image' ? imageSearch(p, ids) : videoSearch(p, ids),
      kind === 'image' ? 'images' : 'videos',
      1,
      request,
    );
    return rows
      .map(r => {
        const id = String(kind === 'image' ? r.image_id : r.video_id);
        if (!ids.includes(id)) unverified('TikTok listed a ' + kind + ' that was not named.');
        return {id, name: typeof r.file_name === 'string' ? r.file_name : null};
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };
  const out: JsonObject = {
    route: s.route,
    images: await found('image', s.images),
    videos: await found('video', s.videos),
  };
  if (s.usage) {
    const ads = [
      ...(await pages(
        read(p, 'tiktok_ad_get', '/v1.3/ad/get/', {page: 1, page_size: adPageSize}),
        'ads',
        maxAdPages,
        request,
      )),
      ...(await pages(
        read(p, 'tiktok_smart_plus_ad_get', '/v1.3/smart_plus/ad/get/', {page: 1, page_size: smartPageSize}),
        'Upgraded Smart+ ads',
        maxSmartPages,
        request,
      )),
    ];
    const uses = ads.map(a => ({ad: String(a.smart_plus_ad_id ?? a.ad_id), assets: assetsOf(a)}));
    out.used = [...s.images, ...s.videos]
      .map(id => ({id, ads: [...new Set(uses.filter(u => u.assets.has(id)).map(u => u.ad))].sort()}))
      .filter(u => u.ads.length);
  }
  return {status: 200, headers: {}, data: out};
}
export function validateTiktokLibraryState(p: CompiledRequest, r: TransportResult): void {
  const s = (p as Read).tiktokLibraryState,
    d = r.data;
  if (
    !s ||
    r.status !== 200 ||
    !obj(d) ||
    !Array.isArray(d.images) ||
    !Array.isArray(d.videos) ||
    s.usage !== Array.isArray(d.used)
  )
    unverified('Missing verified asset library state.');
}
export function tiktokLibraryPrerequisites(p: CompiledRequest, states: unknown[]): void {
  const route = tiktokLibraryKind(p);
  if (!route) return;
  const s = states[0];
  if (!obj(s) || !Array.isArray(s.images) || !Array.isArray(s.videos))
    unverified('Missing verified asset library state.');
  const want = stateOf(p),
    have = (rows: unknown[], id: string) => rows.find((r: any) => obj(r) && r.id === id) as JsonObject | undefined;
  const missing = [
    ...want.images.filter(id => !have(s.images as unknown[], id)),
    ...want.videos.filter(id => !have(s.videos as unknown[], id)),
  ];
  if (missing.length)
    fail('STATE_NOT_FOUND', 'Not an asset of the selected advertiser: ' + missing.join(', ') + '.', {ids: missing});
  if (route !== 'delete') {
    const row = have(
      (route === 'image_name' ? s.images : s.videos) as unknown[],
      [...want.images, ...want.videos][0]!,
    )!;
    if (row.name === body(p).file_name)
      invalid(
        'The ' +
          (route === 'image_name' ? 'image' : 'video') +
          ' is already named "' +
          String(body(p).file_name) +
          '".',
      );
    return;
  }
  if (!Array.isArray(s.used)) unverified('Missing verified asset usage.');
  const used = (s.used as JsonObject[]).filter(u => obj(u) && Array.isArray(u.ads) && u.ads.length);
  if (used.length)
    fail(
      'ASSET_IN_USE',
      'Ads ' +
        [...new Set(used.flatMap(u => u.ads as string[]))].join(', ') +
        ' use ' +
        used.map(u => String(u.id)).join(', ') +
        '; delete or change those ads first.',
      {in_use: Object.fromEntries(used.map(u => [String(u.id), u.ads]))},
      409,
    );
}
export function tiktokLibraryImpact(p: CompiledRequest, state: unknown[]): JsonObject | undefined {
  const route = tiktokLibraryKind(p);
  if (!route) return;
  const first = state[0],
    s: JsonObject = obj(first) ? first : {},
    b = body(p);
  if (route !== 'delete') {
    const kind = route === 'image_name' ? 'image' : 'video',
      id = String(route === 'image_name' ? b.image_id : b.video_id),
      rows = Array.isArray(s[kind + 's']) ? (s[kind + 's'] as JsonObject[]) : [];
    return {
      provider: 'tiktok',
      scope: kind,
      operation: 'rename',
      asset: rows.find(r => obj(r) && r.id === id) ?? {id},
      name: b.file_name,
      may_affect_serving: false,
      effect:
        'Renames the ' +
        kind +
        ' in the asset library; ads that use it are unchanged. If another ' +
        kind +
        ' of the advertiser already has the name, TikTok adds a millisecond timestamp at the end.',
      verification: 'Searches the ' + kind + " again and compares its name, allowing TikTok's timestamp.",
      source:
        'https://business-api.tiktok.com/portal/docs/update-the-name-of-' +
        (kind === 'image' ? 'an-image' : 'a-video') +
        '/v1.3',
    };
  }
  return {
    provider: 'tiktok',
    scope: 'creative_assets',
    operation: 'delete',
    deleting: {images: Array.isArray(s.images) ? s.images : [], videos: Array.isArray(s.videos) ? s.videos : []},
    may_affect_serving: false,
    effect:
      'Deletes the images and videos from the asset library; no ad or Upgraded Smart+ ad of the advertiser uses them.',
    verification: 'Searches the named images and videos again and expects them to be gone.',
    source: 'https://business-api.tiktok.com/portal/docs/delete-creative-assets/v1.3',
  };
}
/** A deletion reply that lists failed IDs is a failure: some assets may be gone and nothing is resubmitted. */
export function tiktokLibraryOutcome(p: CompiledRequest, r: TransportResult): boolean {
  if (r.status !== 200 || !obj(r.data) || r.data.code !== 0) return false;
  if (tiktokLibraryKind(p) !== 'delete') return true;
  const d = obj(r.data.data) ? r.data.data : {};
  return ['failed_image_ids', 'failed_video_ids'].every(
    k => d[k] === undefined || d[k] === null || (Array.isArray(d[k]) && !d[k].length),
  );
}
export function tiktokLibraryVerification(
  p: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const s = stateOf(p, true);
  if (s.route !== 'delete')
    return [{read: stateRead(p, s), expected: {present: true, name: s.name}, id: [...s.images, ...s.videos][0]!}];
  const reads = [];
  if (s.images.length)
    reads.push({read: imageSearch(p, s.images, {...s, videos: []}), expected: {images: []}, id: s.images.join(',')});
  if (s.videos.length)
    reads.push({read: videoSearch(p, s.videos, {...s, images: []}), expected: {videos: []}, id: s.videos.join(',')});
  return reads;
}
/** A renamed asset reads as the sent name, or the sent name with TikTok's millisecond timestamp for a taken name. */
export function tiktokLibraryObserved(read: CompiledRequest, data: JsonObject): JsonObject {
  const s = (read as Read).tiktokLibraryState,
    rows = [
      ...(Array.isArray(data.images) ? data.images : []),
      ...(Array.isArray(data.videos) ? data.videos : []),
    ] as JsonObject[];
  if (!s || s.route === 'delete')
    return {
      images: (Array.isArray(data.images) ? data.images : []).map((r: JsonObject) => r.id),
      videos: (Array.isArray(data.videos) ? data.videos : []).map((r: JsonObject) => r.id),
    };
  const row = rows[0];
  if (!obj(row)) return {present: false};
  const name = typeof row.name === 'string' ? row.name : null,
    sent = s.name ?? '';
  const suffixed =
    name !== null && name !== sent && name.startsWith(sent) && /^[ _-]?\d{13}$/.test(name.slice(sent.length));
  return {
    present: true,
    name: suffixed ? sent : name,
    ...(suffixed ? {timestamp_suffix: name!.slice(sent.length)} : {}),
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const tiktokLibraryFamily: ReviewedFamily = {
  name: 'tiktok_library_assets',
  files: ['src/tiktok-library-assets.ts', ['tests/tiktok-library-assets.test.mjs']],
  kind: tiktokLibraryKind,
  assert: assertTiktokLibraryAsset,
  snapshots: tiktokLibrarySnapshots,
  isRead: isTiktokLibraryRead,
  reader: readTiktokLibraryAssets,
  validateState: validateTiktokLibraryState,
  prerequisites: tiktokLibraryPrerequisites,
  impact: tiktokLibraryImpact,
  outcome: tiktokLibraryOutcome,
  verification: tiktokLibraryVerification,
  observed: tiktokLibraryObserved,
  exemptFromSpendTextMatch: true,
};
