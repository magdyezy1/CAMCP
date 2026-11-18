import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

/**
 * Performance Max inside an all-or-nothing Google build (CMP-07, a pack owner decision P7 names). For a non-retail
 * Performance Max campaign Google requires the asset group and the links to its minimum assets in the same mutate
 * request (AssetGroupService cannot create them alone), which the atomic build provides (google-atomic-builds.ts). This
 * module holds the local rules a build must meet before anything is sent:
 *
 * - The asset group belongs to a Performance Max campaign this build creates, PAUSED, with brand guidelines off
 *   (`brand_guidelines_enabled: false`), so the business name and logos link to the asset group and every minimum can
 *   be counted here. A brand-guideline campaign (business name and logos as campaign assets) is not created by a build.
 *   Or (R2.5 M3, G1) it belongs to an EXISTING Performance Max campaign that is ENABLED or PAUSED: the review reads the
 *   campaign's channel, brand-guideline mode and Merchant Center account with its other existing parents, and judges
 *   the counts in that mode (assertPmaxExistingCampaigns). The one-service link review of an asset group that already
 *   exists is judged by the same counting function (google-asset-links.ts, G3).
 * - Each new asset group links its minimum assets in the same build: the pinned requirements below, sourced from
 *   Google's "Performance Max asset requirements" page as read in the engineering review (accessed 2026-10-08), read
 *   again in full on 2026-11-17 (R2.5 M3, Q6: two maxima differed and are re-pinned) and pinned in
 *   tests/fixtures/google-pmax-asset-requirements.json, including at least one short description (a
 *   DESCRIPTION of at most 60 characters; the pinned v25 Discovery document lists SHORT_DESCRIPTION_REQUIRED, "At
 *   least one short description asset is required for a valid asset group"). A missing minimum is refused before any
 *   request; finer rules (image ratios and sizes, policy, duplicate text) stay with Google, whose refusal leaves nothing.
 * - Text assets may be created in the build; images, logos and videos are existing assets of the account (uploaded
 *   with amcp_media first), whose type the review reads before sending.
 */
export const pmaxAssetRequirements: {
  source: string;
  accessed: string;
  fields: Record<string, {min: number; max: number; max_length?: number; asset_type: string}>;
  combined: {fields: string[]; max: number}[];
  short_description: {field_type: string; max_length: number; min: number};
} = {
  source: 'https://developers.google.com/google-ads/api/performance-max/asset-requirements',
  accessed: '2026-11-17',
  fields: {
    HEADLINE: {min: 3, max: 15, max_length: 30, asset_type: 'TEXT'},
    LONG_HEADLINE: {min: 1, max: 5, max_length: 90, asset_type: 'TEXT'},
    DESCRIPTION: {min: 2, max: 5, max_length: 90, asset_type: 'TEXT'},
    BUSINESS_NAME: {min: 1, max: 1, max_length: 25, asset_type: 'TEXT'},
    MARKETING_IMAGE: {min: 1, max: 20, asset_type: 'IMAGE'},
    SQUARE_MARKETING_IMAGE: {min: 1, max: 20, asset_type: 'IMAGE'},
    PORTRAIT_MARKETING_IMAGE: {min: 0, max: 20, asset_type: 'IMAGE'},
    LOGO: {min: 1, max: 5, asset_type: 'IMAGE'},
    // Q6, owner decision 2026-11-17: the page read that day gives these two maxima as 20 and 15 (the 2026-10-08 transcription
    // had 5 and 5). `combined` below is unchanged: the page states no combined cap, so its two caps stay UNVERIFIED.
    LANDSCAPE_LOGO: {min: 0, max: 20, asset_type: 'IMAGE'},
    YOUTUBE_VIDEO: {min: 0, max: 15, asset_type: 'YOUTUBE_VIDEO'},
    CALL_TO_ACTION_SELECTION: {min: 0, max: 1, asset_type: 'CALL_TO_ACTION'},
  },
  combined: [
    {fields: ['MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE'], max: 20},
    {fields: ['LOGO', 'LANDSCAPE_LOGO'], max: 5},
  ],
  short_description: {field_type: 'DESCRIPTION', max_length: 60, min: 1},
};
/**
 * Field types a build links that carry no count: no minimum, no maximum and no place in a combined cap (R2.5 M3, G2).
 * TALL_PORTRAIT_MARKETING_IMAGE is a value of the pinned v25 AssetFieldType (the enum lists it apart from
 * PORTRAIT_MARKETING_IMAGE), and Google's AssetFieldType page, read 2026-11-17, says only that the asset is linked for use as
 * a tall portrait marketing image. Its asset-requirements page gives it no count and no aspect ratio, so both are UNVERIFIED
 * (live check LV-14). Counting too few risks only Google's own all-or-nothing refusal; counting too many would refuse a build
 * Google accepts, so a build links it to an image asset and counts it nowhere.
 */
export const pmaxUncountedFieldTypes: Record<string, {asset_type: string; max_length?: number}> = {
  TALL_PORTRAIT_MARKETING_IMAGE: {asset_type: 'IMAGE'},
};
/** The build's view of one operation (google-atomic-builds.ts). */
export interface PmaxOp {
  index: number;
  kind: string;
  create: JsonObject;
  temp?: string;
}
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * Every refusal of this module names the operation it came from as `operation` (R2.5 M3, L2-07): the index its `field` path
 * (`mutate_operations[7].asset_group_operation.create.campaign`) already carried, unless the caller names another.
 */
function invalid(message: string, field: string, extra: JsonObject = {}): never {
  const at = /^mutate_operations\[(\d+)\]/.exec(field);
  throw new MirrorError('INVALID_GOOGLE_BUILD', message, {...(at ? {operation: Number(at[1])} : {}), field, ...extra});
}
function minimums(message: string, details: JsonObject): never {
  throw new MirrorError('PMAX_ASSET_MINIMUMS', message, details);
}
const where = (op: PmaxOp) => 'mutate_operations[' + op.index + ']';
/** Characters as Google counts them for these limits (code points; a wider count stays Google's refusal). */
const length = (text: string) => [...text].length;

/**
 * How the counts of one asset group are judged (R2.5 M3, G1 and G3): by what its campaign says. A group of a campaign this
 * build creates is judged as it always was (brand guidelines off, no Merchant Center account, every minimum).
 */
export interface PmaxMode {
  /**
   * The campaign has brand guidelines on: the business name and the logos are the campaign's assets, so the group's minimums
   * for BUSINESS_NAME and LOGO are 0. Their maximums stay.
   */
  brandGuidelines: boolean;
  /**
   * A retail campaign (a Merchant Center account is linked): Google generates the minimum set itself, so a group with no link
   * is accepted. A group with any link must meet every minimum (Google's caution for retail asset groups).
   */
  retail: boolean;
}
const ownCampaignMode: PmaxMode = {brandGuidelines: false, retail: false};
const brandAssetTypes: ReadonlySet<string> = new Set(['BUSINESS_NAME', 'LOGO']);
export interface PmaxCountProblems {
  outside_range: {field_type: string; min: number; max: number; found: number}[];
  combined_over: {fields: string[]; max: number; found: number}[];
}
/**
 * The counts of one asset group against the pinned requirements: the one place a build (`range`) and a one-service link
 * review (`minimums`) judge them. `range` refuses a count below its minimum, above its maximum, and over a combined cap, as a
 * build always did. `minimums` refuses only a count below its minimum, as Google's NOT_ENOUGH_* refusals do (lead review
 * 2026-11-17): the pinned maximums may be stale (Q6), and a check of them on every link review would be a new gate built on a
 * stale pin. A retail group with no link at all is not judged (see PmaxMode): `linked` says whether it links anything, which
 * the counts say unless the caller keeps them capped at the minimums (a link review does, round 2 S1-1), where a link of a type
 * with no minimum is in no count.
 */
export function pmaxCountProblems(
  counts: Record<string, number>,
  mode: PmaxMode,
  limits: 'range' | 'minimums',
  linked: boolean = Object.values(counts).some(n => n > 0),
): PmaxCountProblems {
  if (mode.retail && !linked) return {outside_range: [], combined_over: []};
  const outside_range = Object.entries(pmaxAssetRequirements.fields)
    .map(([type, rule]) => ({
      field_type: type,
      min: mode.brandGuidelines && brandAssetTypes.has(type) ? 0 : rule.min,
      max: rule.max,
      found: counts[type] ?? 0,
    }))
    .filter(r => r.found < r.min || (limits === 'range' && r.found > r.max));
  const combined_over =
    limits === 'range'
      ? pmaxAssetRequirements.combined
          .map(c => ({fields: c.fields, max: c.max, found: c.fields.reduce((n, f) => n + (counts[f] ?? 0), 0)}))
          .filter(c => c.found > c.max)
      : [];
  return {outside_range, combined_over};
}
/** The links of a build to one of its asset groups, counted by field type. */
function linkCounts(links: PmaxOp[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const l of links) counts[l.create.field_type] = (counts[l.create.field_type] ?? 0) + 1;
  return counts;
}
/** The refusal of a group whose counts are outside what the pinned requirements allow in its mode; nothing when they are not. */
function refuseCounts(group: PmaxOp, counts: Record<string, number>, found: PmaxCountProblems, extra: JsonObject = {}) {
  if (!found.outside_range.length && !found.combined_over.length) return;
  minimums(
    'Asset group ' +
      group.create.name +
      ' does not link the asset counts Performance Max requires in the same request; Google would refuse the whole build. Add or remove the listed assets.',
    {
      operation: group.index,
      asset_group: group.temp,
      ...extra,
      counts,
      ...(found.outside_range.length ? {outside_range: found.outside_range} : {}),
      ...(found.combined_over.length ? {combined_over: found.combined_over} : {}),
      source: pmaxAssetRequirements.source,
    },
  );
}
const pick = (o: unknown, snakeName: string): unknown =>
  object(o) ? (o[snakeName] ?? o[snakeName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())]) : undefined;
/**
 * What a read campaign (the `campaign` object of a state row, in Google's camelCase or AMCP's snake_case) says of how its
 * asset groups are judged: its channel and status, and the mode (brand guidelines on, a Merchant Center account linked).
 * Undefined for a value that is no campaign.
 */
export function pmaxCampaignFacts(
  campaign: unknown,
): {channel: string | null; status: string | null; mode: PmaxMode} | undefined {
  if (!object(campaign)) return undefined;
  const text = (v: unknown) => (typeof v === 'string' ? v : null),
    merchant = pick(pick(campaign, 'shopping_setting'), 'merchant_id');
  return {
    channel: text(pick(campaign, 'advertising_channel_type')),
    status: text(pick(campaign, 'status')),
    mode: {
      brandGuidelines: pick(campaign, 'brand_guidelines_enabled') === true,
      retail: merchant !== undefined && merchant !== null && !['', '0'].includes(String(merchant)),
    },
  };
}

/** Local Performance Max rules of a build; no-op for a build without assets or asset groups. */
export function assertPmaxBuild(ops: PmaxOp[]) {
  const assets = ops.filter(o => o.kind === 'assets'),
    groups = ops.filter(o => o.kind === 'assetGroups'),
    links = ops.filter(o => o.kind === 'assetGroupAssets'),
    signals = ops.filter(o => o.kind === 'assetGroupSignals');
  if (!assets.length && !groups.length && !links.length && !signals.length) return;
  for (const op of assets) {
    const keys = Object.keys(op.create).filter(k => k !== 'resource_name');
    const text = op.create.text_asset?.text;
    if (
      keys.join() !== 'text_asset' ||
      !object(op.create.text_asset) ||
      Object.keys(op.create.text_asset).join() !== 'text'
    )
      invalid(
        where(op) +
          ': a build creates text assets only ({text_asset: {text}}). Link images, logos and videos that already exist in the account; upload them with amcp_media first.',
        where(op) + '.asset_operation.create',
      );
    if (typeof text !== 'string' || !text.trim() || /[\x00-\x1f\x7f]/.test(text))
      invalid(where(op) + ': a text asset needs plain text.', where(op) + '.asset_operation.create.text_asset.text');
    if (!op.temp)
      invalid(
        where(op) + ': a text asset of a build needs a temporary resource_name, so its asset group can link it.',
        where(op) + '.asset_operation.create.resource_name',
      );
  }
  const campaigns = new Map(ops.filter(o => o.kind === 'campaigns' && o.temp).map(o => [o.temp!, o]));
  for (const group of groups) {
    const campaign = campaigns.get(group.create.campaign);
    if (campaign) {
      // A campaign this build creates: its channel and brand-guideline mode are in the build itself, so they are checked here.
      if (campaign.create.advertising_channel_type !== 'PERFORMANCE_MAX')
        invalid(
          where(group) + ': asset groups belong to a PERFORMANCE_MAX campaign.',
          where(campaign) + '.campaign_operation.create.advertising_channel_type',
        );
      if (campaign.create.brand_guidelines_enabled !== false)
        invalid(
          where(campaign) +
            ': set brand_guidelines_enabled: false. This build links the business name and logos to the asset group; brand-guideline campaigns link them as campaign assets, which a build does not create.',
          where(campaign) + '.campaign_operation.create.brand_guidelines_enabled',
        );
    } else if (typeof group.create.campaign !== 'string')
      invalid(
        where(group) +
          ': an asset group needs its campaign: a Performance Max campaign this build creates, or an existing one of this customer.',
        where(group) + '.asset_group_operation.create.campaign',
      );
    // R2.5 M3 (G1, the owner's 2026-11-15 item): an asset group may also be created under an EXISTING Performance Max campaign.
    // Its channel, brand-guideline mode and Merchant Center account are read, so they are judged with the state
    // (assertPmaxExistingCampaigns); everything below is without state and holds for every group.
    const urls = group.create.final_urls;
    if (
      !Array.isArray(urls) ||
      !urls.length ||
      urls.some((u: unknown) => typeof u !== 'string' || !/^https:\/\/[^\s/?#@]+\.[^\s/?#@]+(?:[/?#]\S*)?$/.test(u))
    )
      invalid(
        where(group) + ': an asset group needs final_urls of public HTTPS pages.',
        where(group) + '.asset_group_operation.create.final_urls',
      );
    if (typeof group.create.name !== 'string' || !group.create.name.trim())
      invalid(where(group) + ': name the asset group.', where(group) + '.asset_group_operation.create.name');
    if (!group.temp)
      invalid(
        where(group) + ': an asset group of a build needs a temporary resource_name, so its assets can link to it.',
        where(group) + '.asset_group_operation.create.resource_name',
      );
  }
  const groupNames = new Set(groups.map(g => g.temp));
  for (const op of [...links, ...signals])
    if (!groupNames.has(op.create.asset_group))
      invalid(
        where(op) +
          ': in a build, asset links and signals name an asset group the same build creates. Change an existing asset group with its own reviewed asset-link or signal change.',
        where(op) + '.create.asset_group',
      );
  const textOf = new Map(assets.map(a => [a.temp!, a.create.text_asset.text as string]));
  for (const link of links) {
    const rule =
      pmaxAssetRequirements.fields[link.create.field_type] ?? pmaxUncountedFieldTypes[link.create.field_type];
    if (!rule) {
      const allowed = [...Object.keys(pmaxAssetRequirements.fields), ...Object.keys(pmaxUncountedFieldTypes)];
      invalid(
        where(link) + ': a build links the Performance Max asset field types ' + allowed.join(', ') + '.',
        where(link) + '.asset_group_asset_operation.create.field_type',
        {allowed},
      );
    }
    const asset = link.create.asset;
    const text = textOf.get(asset);
    if (textOf.has(asset) && rule!.asset_type !== 'TEXT')
      invalid(
        where(link) +
          ': ' +
          link.create.field_type +
          ' links an existing ' +
          rule!.asset_type.toLowerCase() +
          ' asset, not text.',
        where(link) + '.asset_group_asset_operation.create.asset',
      );
    if (rule!.asset_type === 'TEXT' && !textOf.has(asset) && typeof asset === 'string' && /\/-\d+$/.test(asset))
      invalid(where(link) + ': this text asset is not created by the build.', where(link) + '.create.asset');
    if (text !== undefined && rule!.max_length !== undefined && length(text) > rule!.max_length)
      minimums(
        'A ' +
          link.create.field_type +
          ' has at most ' +
          rule!.max_length +
          ' characters; Google would refuse the whole build. Shorten it.',
        {operation: link.index, field_type: link.create.field_type, max_length: rule!.max_length, length: length(text)},
      );
  }
  for (const group of groups) {
    const own = links.filter(l => l.create.asset_group === group.temp),
      counts = linkCounts(own);
    const seen = new Set<string>();
    for (const l of own) {
      const key = l.create.field_type + '|' + l.create.asset;
      if (seen.has(key))
        invalid(where(l) + ': this asset is linked twice with the same field type.', where(l) + '.create.asset');
      seen.add(key);
    }
    // A group of a campaign this build creates is judged here, in the mode its rules have always had; one under an existing
    // campaign is judged once the review has read that campaign (assertPmaxExistingCampaigns).
    if (campaigns.has(group.create.campaign))
      refuseCounts(group, counts, pmaxCountProblems(counts, ownCampaignMode, 'range'));
    // A short description: Google refuses an asset group whose descriptions are all longer than 60 characters
    // (SHORT_DESCRIPTION_REQUIRED). Only texts this build creates are measured; a linked existing text asset's length
    // is not read, so Google decides for it.
    const short = pmaxAssetRequirements.short_description,
      described = own.filter(l => l.create.field_type === short.field_type);
    if (
      described.length &&
      described.every(l => textOf.has(l.create.asset)) &&
      described.filter(l => length(textOf.get(l.create.asset)!) <= short.max_length).length < short.min
    )
      minimums(
        'An asset group needs at least one description of at most 60 characters (Google’s short description); Google would refuse the whole build. Shorten one of its descriptions.',
        {
          operation: group.index,
          asset_group: group.temp,
          field_type: short.field_type,
          short_max_length: short.max_length,
          lengths: described.map(l => length(textOf.get(l.create.asset)!)),
          source: pmaxAssetRequirements.source,
        },
      );
  }
}
/** The existing assets a build links, with the asset type each link needs. */
export function pmaxExistingAssets(ops: PmaxOp[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of ops.filter(o => o.kind === 'assetGroupAssets')) {
    const asset = l.create.asset,
      rule = pmaxAssetRequirements.fields[l.create.field_type] ?? pmaxUncountedFieldTypes[l.create.field_type];
    if (typeof asset === 'string' && !/\/-\d+$/.test(asset) && rule) out.set(asset, rule.asset_type);
  }
  return out;
}
/** Checks the read existing assets: each exists in the account with the type its link needs. */
export function assertPmaxExistingAssets(ops: PmaxOp[], rows: JsonObject[]) {
  for (const [name, type] of pmaxExistingAssets(ops)) {
    const row = rows.find(r => object(r.asset) && (r.asset.resourceName ?? r.asset.resource_name) === name),
      // The first operation of the build that links it, and the field that names the asset there (R2.5 M3, L2-07).
      linking = ops.find(o => o.kind === 'assetGroupAssets' && o.create.asset === name),
      at = linking
        ? {operation: linking.index, field: where(linking) + '.asset_group_asset_operation.create.asset'}
        : {};
    if (!row)
      throw new MirrorError('PMAX_ASSET_TYPE_MISMATCH', 'The build links an asset this account does not return.', {
        ...at,
        asset: name,
        expected_type: type,
      });
    if (row.asset.type !== type)
      throw new MirrorError(
        'PMAX_ASSET_TYPE_MISMATCH',
        'The build links an existing asset of another type than its field type needs.',
        {...at, asset: name, expected_type: type, actual_type: row.asset.type ?? null},
      );
  }
}
/**
 * The asset groups a build creates under an EXISTING campaign (R2.5 M3, G1), judged with the campaign rows the review read
 * (`rows`, with its other existing parents): the campaign must be a PERFORMANCE_MAX campaign that is ENABLED or PAUSED, and the
 * group's counts are judged in its mode (brand guidelines on lifts the business name and logo minimums; a retail campaign
 * accepts a group with no link, because Google generates the minimum set). A group of a campaign the build creates was judged
 * without state (assertPmaxBuild) and is left alone.
 */
export function assertPmaxExistingCampaigns(ops: PmaxOp[], rows: JsonObject[]) {
  const own = new Set(ops.filter(o => o.kind === 'campaigns' && o.temp).map(o => o.temp!)),
    links = ops.filter(o => o.kind === 'assetGroupAssets');
  for (const group of ops.filter(o => o.kind === 'assetGroups')) {
    const ref = group.create.campaign;
    if (typeof ref !== 'string' || own.has(ref)) continue;
    const row = rows.find(r => object(r.campaign) && (r.campaign.resourceName ?? r.campaign.resource_name) === ref),
      facts = pmaxCampaignFacts(row?.campaign);
    if (!facts || facts.channel !== 'PERFORMANCE_MAX' || !['ENABLED', 'PAUSED'].includes(facts.status ?? ''))
      invalid(
        where(group) +
          ': an asset group belongs to a PERFORMANCE_MAX campaign that is ENABLED or PAUSED; the campaign ' +
          ref +
          ' is ' +
          (facts
            ? (facts.channel ?? 'of no known type') + ' and ' + (facts.status ?? 'of no known status')
            : 'not returned') +
          '.',
        where(group) + '.asset_group_operation.create.campaign',
        {operation: group.index, channel: facts?.channel ?? null, ...(facts ? {status: facts.status} : {})},
      );
    const counts = linkCounts(links.filter(l => l.create.asset_group === group.temp));
    refuseCounts(group, counts, pmaxCountProblems(counts, facts!.mode, 'range'), {
      campaign: ref,
      brand_guidelines_enabled: facts!.mode.brandGuidelines,
      retail: facts!.mode.retail,
    });
  }
}
/** The impact summary of the build's asset groups: their asset counts per field type. */
export function pmaxImpact(ops: PmaxOp[]): JsonObject[] {
  return ops
    .filter(o => o.kind === 'assetGroups')
    .map(g => {
      const counts: Record<string, number> = {};
      for (const l of ops.filter(o => o.kind === 'assetGroupAssets' && o.create.asset_group === g.temp))
        counts[l.create.field_type] = (counts[l.create.field_type] ?? 0) + 1;
      return {
        name: g.create.name,
        status: g.create.status ?? null,
        final_urls: g.create.final_urls,
        assets: counts,
        signals: ops.filter(o => o.kind === 'assetGroupSignals' && o.create.asset_group === g.temp).length,
      };
    });
}
