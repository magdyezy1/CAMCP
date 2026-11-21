/**
 * TikTok's state reads of a reviewed campaign, ad group or ad write no family plans (ARC-01 phase B, wave 4c: its
 * adapter's `writes.snapshots`, moved verbatim from src/write-snapshots.ts, which asks it where it named TikTok): a
 * create reads the advertiser and its exact parent, an edit reads its exact targets, and either reads the custom
 * conversion and CTA portfolios it references. An ad update in TikTok's own shape names its targets in its creatives
 * (R2.5 M4, L1-03); its checks after the read, and its read-back, are below.
 */
import {MirrorError} from './errors.js';
import type {CompiledRequest, DeclaredOperation, JsonObject} from './types.js';
import type {ProviderVerificationRead, StateReadBuilder} from './provider-adapter.js';
import {normalizeAccount} from './account-id.js';
import {object, fail} from './write-common.js';
import {tiktokAdgroupConversionRead} from './tiktok-adgroup-conversions.js';
import {tiktokAdvertiserRead} from './tiktok-advertiser-state.js';
import {tiktokCtaPortfolioReads} from './tiktok-cta-portfolios.js';

const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const adUpdatePath = '/v1.3/ad/update/';
/**
 * The most creatives one update holds: "Update manual ads" gives `creatives` a "Max size: 20" (API for Business v1.3,
 * https://business-api.tiktok.com/portal/docs/update-ads/v1.3, read 2026-11-20 in the lead's documentation session,
 * impl/r25-m4-DOCS-EVIDENCE.md section 5). The top-level list of the earlier shape keeps the 25 it always had, below.
 */
const maxAdUpdate = 20;
/**
 * The fields of a creative that TikTok's incremental update (`patch_update: true`) keeps the omitted values of, the same page: "Whether to
 * use incremental update mode" for only these ten. Every other field needs full update mode, where TikTok says that some omitted
 * parameters "may be overwritten as null value". So the shape that names its ads in the creatives alone changes these and nothing else.
 */
const incrementalFields: readonly string[] = Object.freeze([
  'ad_name',
  'identity_id',
  'identity_type',
  'identity_authorized_bc_id',
  'video_id',
  'image_ids',
  'music_id',
  'tiktok_item_id',
  'ad_text',
  'ad_texts',
]);
/**
 * The ad IDs the creatives of an ad update carry (Q17, owner 2026-11-15; R2.5 M4, L1-03). TikTok's own request nests each ad's ID in its
 * creative, {advertiser_id, adgroup_id, patch_update, creatives: [{ad_id, ...}]} ("Update manual ads", read 2026-11-20), and the review
 * used to read ad IDs only from a top-level ad_ids or ad_id. Undefined when no creative carries an ad_id, and that body is read as
 * before. Once one does, every creative must carry its own, numeric and distinct, and at most maxAdUpdate: a list that cannot be read as
 * the ads of the update is refused before any request.
 */
function creativeAdIds(body: JsonObject): string[] | undefined {
  const creatives = body.creatives;
  if (!Array.isArray(creatives) || !creatives.some(c => obj(c) && c.ad_id !== undefined)) return undefined;
  if (creatives.length > maxAdUpdate)
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'An ad update in TikTok’s own shape names 1–20 ads, one in each creative; this request names {count}.',
      {field: 'creatives', count: creatives.length, max: maxAdUpdate},
      400,
      false,
      {count: creatives.length},
    );
  const seen = new Set<string>();
  return creatives.map((c, i) => {
    const field = 'creatives[' + i + '].ad_id',
      id = obj(c) ? c.ad_id : undefined;
    if (typeof id !== 'string' || !/^\d+$/.test(id))
      throw new MirrorError(
        'INVALID_ARGUMENT',
        '{field} must be the ID of the ad that creative updates, as numeric text. Each creative of an ad update carries the ad_id of its own ad.',
        {field},
        400,
        false,
        {field},
      );
    if (seen.has(id))
      throw new MirrorError(
        'INVALID_ARGUMENT',
        '{field} repeats an ad that an earlier creative names. Each ad appears in one creative of an update.',
        {field, ad_id: id},
        400,
        false,
        {field},
      );
    seen.add(id);
    return id;
  });
}
/**
 * The ads an ad update reads. A body whose creatives carry no ad_id is read as before, from a top-level ad_ids or ad_id. A body whose
 * creatives carry their IDs and that lists the ads at the top level as well (the workaround the native shape needed until now, which
 * keeps its rules and works byte for byte) must name the same ads in both, or the review would read other ads than the ones TikTok
 * updates; the caller's own list is then read as written. A body whose creatives alone name the ads is TikTok's own shape, accepted as
 * an incremental update only (QUESTIONS L6, as the documentation session of 2026-11-20 settled it): with patch_update: true, and only
 * when it changes the ten fields that mode keeps the omitted values of (incrementalFields). TikTok may overwrite every other field a
 * creative leaves out as null, and AMCP does not restate fields for the caller, so a change to any other field is refused before any
 * request, naming the earlier shape as the route of a full update, which the caller restates whole.
 */
function adUpdateIds(body: JsonObject, listed: unknown): unknown {
  const nested = creativeAdIds(body);
  if (!nested) return listed;
  if (listed === undefined) {
    // The fields first: adding the flag would not help a body that changes one of the others.
    const offending = (body.creatives as unknown[]).flatMap((c, i) =>
      Object.keys(obj(c) ? c : {})
        .filter(k => k !== 'ad_id' && !incrementalFields.includes(k))
        .map(k => 'creatives[' + i + '].' + k),
    );
    if (offending.length)
      throw new MirrorError(
        'INVALID_ARGUMENT',
        '{fields} cannot be changed in TikTok’s own shape: its incremental update (patch_update: true) keeps a field a creative leaves out only for ad_name, identity_id, identity_type, identity_authorized_bc_id, video_id, image_ids, music_id, tiktok_item_id, ad_text and ad_texts, and TikTok may overwrite every other field left out as null. AMCP does not restate fields for you: change any other field in the earlier shape, a top-level ad_ids or ad_id beside creatives that restate every field of each ad. Nothing was sent.',
        {field: offending[0], fields: offending, allowed: incrementalFields},
        400,
        false,
        {fields: offending.slice(0, 5).join(', ') + (offending.length > 5 ? ' …' : '')},
      );
    if (body.patch_update !== true)
      throw new MirrorError(
        'INVALID_ARGUMENT',
        'An ad update in TikTok’s own shape must set patch_update to true: without it TikTok may overwrite every field a creative leaves out as null, and AMCP sends a full update only in the earlier shape, a top-level ad_ids or ad_id beside creatives that restate every field of each ad. Nothing was sent.',
        {field: 'patch_update'},
      );
    // The ad group the ads are in is part of the request, and what the check after the read compares their rows with.
    if (typeof body.adgroup_id !== 'string' || !/^\d+$/.test(body.adgroup_id))
      throw new MirrorError(
        'INVALID_ARGUMENT',
        'An ad update in TikTok’s own shape names the ad group of its ads in adgroup_id, as numeric text. Nothing was sent.',
        {field: 'adgroup_id'},
      );
    return nested;
  }
  const named = Array.isArray(listed) ? listed.map(String) : [],
    missing = nested.findIndex(id => !named.includes(id)),
    extra = named.find(id => !nested.includes(id)),
    field =
      missing >= 0
        ? 'creatives[' + missing + '].ad_id'
        : extra !== undefined
          ? body.ad_ids !== undefined
            ? 'ad_ids'
            : 'ad_id'
          : undefined;
  if (field)
    throw new MirrorError(
      'INVALID_ARGUMENT',
      '{field} does not match: a top-level ad_ids or ad_id beside the creatives must name exactly the ads their ad_id fields name. Leave the top-level list out, as TikTok’s own shape has none.',
      {field},
      400,
      false,
      {field},
    );
  return listed;
}
/** The ads of an ad update that TikTok's own shape names in its creatives alone, for the checks after the read (undefined for any other). */
function nativeAdUpdate(plan: CompiledRequest): string[] | undefined {
  if (plan.gateway !== 'tiktok_native_action' || plan.method !== 'POST' || plan.path !== adUpdatePath) return undefined;
  const body = object(plan.body);
  return (body.ad_ids ?? (body.ad_id ? [body.ad_id] : undefined)) === undefined ? creativeAdIds(body) : undefined;
}
/**
 * The ads an ad update targets, in whichever shape names them: the caller's top-level list as written, else the ad_id fields of the
 * creatives. The state read has validated both before this is asked, so a body that cannot be read as a list gives none.
 */
function adUpdateTargets(plan: CompiledRequest): string[] | undefined {
  if (plan.gateway !== 'tiktok_native_action' || plan.method !== 'POST' || plan.path !== adUpdatePath) return undefined;
  const body = object(plan.body),
    listed = body.ad_ids ?? (body.ad_id ? [body.ad_id] : undefined);
  return listed === undefined ? creativeAdIds(body) : Array.isArray(listed) ? listed.map(String) : undefined;
}
/**
 * An ad update changes the ads of the one ad group it names (R2.5 M4, L1-03), in either shape: every ad the state read returned is in
 * `adgroup_id` of the body, at prepare and again at execute. The ads' own row says so; a row that says another ad group, or none, stops
 * the update before anything is sent. It changes no request: it reads the rows the review already holds.
 */
export function tiktokAdUpdatePrerequisites(plan: CompiledRequest, values: unknown[]): void {
  const ids = adUpdateTargets(plan),
    named = object(plan.body).adgroup_id;
  // A body that names no ad group (the earlier shape) has nothing to compare with: TikTok requires the field and refuses it, applying nothing.
  if (!ids || named === undefined || named === null || named === '') return;
  const group = String(named),
    rows = values.flatMap(v => (obj(v) && obj(v.data) && Array.isArray(v.data.list) ? v.data.list : [])).filter(obj);
  for (const id of ids) {
    const row = rows.find(r => String(r.ad_id) === id),
      // The row's ad group is a value TikTok returned (the lead's review S3-3): it is named only when it reads as an ID. Text, an object or a
      // missing value is never put into the message, its localization or its details, which say "another ad group" instead.
      shown = row?.adgroup_id,
      actual = typeof shown === 'string' || typeof shown === 'number' ? String(shown) : '';
    if (actual === group) continue;
    if (!/^\d+$/.test(actual))
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        'Ad {ad_id} is in another ad group than ad group {adgroup_id}, which this update names, or its row names no ad group AMCP can read. An ad update changes ads of the one ad group it names. Nothing was sent.',
        {ad_id: id, adgroup_id: group},
        400,
        false,
        {ad_id: id, adgroup_id: group},
      );
    throw new MirrorError(
      'STATE_TARGET_MISMATCH',
      'Ad {ad_id} is in ad group {actual_adgroup_id}, not in ad group {adgroup_id}, which this update names. An ad update changes ads of the one ad group it names. Nothing was sent.',
      {ad_id: id, adgroup_id: group, actual_adgroup_id: actual},
      400,
      false,
      {ad_id: id, actual_adgroup_id: actual, adgroup_id: group},
    );
  }
}
/**
 * The read-back of an update in TikTok's own shape: one read for each creative, of the ad it names, which must show what that creative
 * sent, in the form a create's read-back has (the creative and the ad group; `patch_update` is a flag of the request, not a field of the
 * ad). Undefined for the earlier shape, which is read back as before (src/tiktok-adapter.ts).
 */
export function tiktokAdUpdateVerification(
  plan: CompiledRequest,
  read: (path: string, query?: JsonObject) => CompiledRequest,
): ProviderVerificationRead[] | undefined {
  const ids = nativeAdUpdate(plan);
  if (!ids) return undefined;
  const body = object(plan.body),
    creatives = body.creatives as JsonObject[];
  return ids.map((id, i) => ({
    read: {
      ...read('/v1.3/ad/get/', {advertiser_id: plan.accountId, filtering: {ad_ids: [id]}, page_size: 100}),
      action: 'tiktok_ad_get',
    },
    expected: {...creatives[i], adgroup_id: body.adgroup_id},
    id,
  }));
}

/**
 * What a TikTok write does for the review's summary beyond the verb its path ends in (R2.5 S2-2, S3-2): the verb create is
 * read from the path, and so are update and delete, but a negative keyword is added with …/negative_keyword/add/, a create
 * the path rules did not know, and an ad create makes one ad for each of the creatives it lists (a Smart+ ad holds its
 * creatives in one ad, so its creative_list counts nothing).
 */
export function tiktokOperation(plan: CompiledRequest): DeclaredOperation | undefined {
  if (plan.method !== 'POST') return undefined;
  if (/\/negative_keyword\/add\/$/.test(plan.path)) return {operation: 'create', entity: 'negative keyword'};
  if (plan.path === '/v1.3/ad/create/') {
    const creatives = object(plan.body).creatives;
    return {operation: 'create', count: Array.isArray(creatives) ? creatives.length : undefined};
  }
  return undefined;
}

export function tiktokStateReads(plan: CompiledRequest, base: StateReadBuilder): CompiledRequest[] {
  const id = normalizeAccount(plan.gateway, plan.accountId!),
    body = object(plan.body);
  const match = /^\/v1\.3\/(campaign|adgroup|ad)\/(?:status\/)?(create|update|delete)\/$/.exec(plan.path);
  if (!match) fail('WRITE_CONTRACT_UNAVAILABLE', 'This TikTok action has no implemented state-read contract.');
  if (match[2] === 'create') {
    const reads = [tiktokAdvertiserRead(base, id)],
      parent = match[1] === 'adgroup' ? 'campaign' : match[1] === 'ad' ? 'adgroup' : undefined;
    if (parent) {
      const parentId = body[parent + '_id'];
      if (typeof parentId !== 'string' || !/^\d+$/.test(parentId))
        fail('MISSING_PARAMETER', 'Child creates require their exact parent ID.');
      const read = base('/v1.3/' + parent + '/get/', {
        advertiser_id: id,
        filtering: {[parent + '_ids']: [parentId]},
        page_size: 100,
      });
      read.action = 'tiktok_' + parent + '_get';
      // The parent a child is created under (R2.5 M1). It is kept whole, minus what TikTok's table lists: its budget, bid,
      // schedule and targeting are what the child is created under, and its placements are read by the gate of an ad create
      // (src/tiktok-manual-ad-identities.ts). The role marks the read for the review's ordering and the rotation harness.
      read.stateRole = 'parent';
      reads.push(read);
    }
    const conversion = tiktokAdgroupConversionRead(plan);
    if (conversion) {
      const read = base(conversion.path, conversion.query);
      read.action = conversion.action;
      reads.push(read);
    }
    for (const r of tiktokCtaPortfolioReads(plan)) {
      const read = base(r.path, r.query);
      read.action = r.action;
      reads.push(read);
    }
    return reads;
  }
  const kind = match[1]!,
    listed = body[kind + '_ids'] ?? (body[kind + '_id'] ? [body[kind + '_id']] : undefined),
    ids = plan.path === adUpdatePath ? adUpdateIds(body, listed) : listed;
  if (!Array.isArray(ids) || !ids.length || ids.length > 25 || ids.some(v => typeof v !== 'string' || !/^\d+$/.test(v)))
    fail('MISSING_PARAMETER', 'Supply 1–25 exact ' + kind + ' IDs.');
  const read = base('/v1.3/' + kind + '/get/', {
    advertiser_id: id,
    filtering: {[kind + '_ids']: ids},
    page_size: 100,
  });
  read.action = 'tiktok_' + kind + '_get';
  return [
    read,
    ...tiktokCtaPortfolioReads(plan).map(r => {
      const portfolio = base(r.path, r.query);
      portfolio.action = r.action;
      return portfolio;
    }),
  ];
}
