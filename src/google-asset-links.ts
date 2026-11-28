import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {googleJson} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {googleAdsCustomers} from './google-version.js';
import {defineFamily, fail, readOf} from './family-kit.js';
import {pmaxAssetRequirements, pmaxBrandAssetTypes, pmaxCampaignFacts, pmaxCountProblems} from './google-pmax-build.js';
import {knownBehaviours} from './known-behaviours.js';

// Native association contracts, independent of whether the caller used an RPC
// name or a legacy alias. Source: Google Ads v23 resource and GAQL references.
const common = [
  'SITELINK',
  'CALLOUT',
  'STRUCTURED_SNIPPET',
  'PROMOTION',
  'PRICE',
  'CALL',
  'MOBILE_APP',
  'HOTEL_CALLOUT',
  'BUSINESS_MESSAGE',
];
export const googleAssetLinkContracts = {
  campaignAssets: {
    resource: 'campaign_asset',
    parent: 'campaign',
    collection: 'campaigns',
    // LOGO and LANDSCAPE_LOGO (R2.5 M3, round 2 S3-1): with brand guidelines on, a Performance Max campaign's business name and logos
    // are the campaign's own assets, which Google's create-campaign guide links as a CampaignAsset with BUSINESS_NAME, LOGO and
    // LANDSCAPE_LOGO. The refusal of such a link to an asset group (validateGoogleAssetGroupLinks) names this level as the place.
    roles: [...common, 'AD_IMAGE', 'BUSINESS_NAME', 'BUSINESS_LOGO', 'LOGO', 'LANDSCAPE_LOGO', 'LEAD_FORM'],
  },
  adGroupAssets: {
    resource: 'ad_group_asset',
    parent: 'adGroup',
    collection: 'adGroups',
    roles: [...common, 'AD_IMAGE'],
  },
  customerAssets: {
    resource: 'customer_asset',
    parent: '',
    collection: '',
    roles: [...common, 'BUSINESS_NAME', 'BUSINESS_LOGO'],
  },
  assetGroupAssets: {
    resource: 'asset_group_asset',
    parent: 'assetGroup',
    collection: 'assetGroups',
    roles: [
      'HEADLINE',
      'LONG_HEADLINE',
      'DESCRIPTION',
      'BUSINESS_NAME',
      'MARKETING_IMAGE',
      'SQUARE_MARKETING_IMAGE',
      'PORTRAIT_MARKETING_IMAGE',
      'LOGO',
      'LANDSCAPE_LOGO',
      'YOUTUBE_VIDEO',
      'CALL_TO_ACTION_SELECTION',
      // R2.5 M3, G2: a value of the pinned v25 AssetFieldType, linked to an image asset (src/google-pmax-build.ts).
      'TALL_PORTRAIT_MARKETING_IMAGE',
    ],
  },
} as const;
type Kind = keyof typeof googleAssetLinkContracts;
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * A refusal of the request's own shape. Its details name the operation and the field it came from (R2.5 M3, L2-07), as
 * `operations[7].create.fieldType`, and where the answer is a closed set, the values it allows.
 */
const invalid = (message: string, details: JsonObject = {}): never => {
  throw new MirrorError('INVALID_ASSET_LINK', message, details);
};
/** The path of an operation's field, as the request spells it: `operations[7].create.fieldType`. */
const at = (operation: number, path = '') => 'operations[' + operation + ']' + path;
const assetTypes: Record<string, string> = {
  AD_IMAGE: 'IMAGE',
  BUSINESS_NAME: 'TEXT',
  BUSINESS_LOGO: 'IMAGE',
  HEADLINE: 'TEXT',
  LONG_HEADLINE: 'TEXT',
  DESCRIPTION: 'TEXT',
  MARKETING_IMAGE: 'IMAGE',
  SQUARE_MARKETING_IMAGE: 'IMAGE',
  PORTRAIT_MARKETING_IMAGE: 'IMAGE',
  TALL_PORTRAIT_MARKETING_IMAGE: 'IMAGE',
  LOGO: 'IMAGE',
  LANDSCAPE_LOGO: 'IMAGE',
  YOUTUBE_VIDEO: 'YOUTUBE_VIDEO',
  CALL_TO_ACTION_SELECTION: 'CALL_TO_ACTION',
};
/**
 * The aspect ratio each asset-group image field type documents on Google's Performance Max asset requirements page (read
 * 2026-11-17), as width to height (R2.5 M3, G3). TALL_PORTRAIT_MARKETING_IMAGE has none there: its ratio is UNVERIFIED (live
 * check LV-14), so it is never judged here.
 */
const imageRatios: Record<string, {width: number; height: number; label: string}> = {
  MARKETING_IMAGE: {width: 191, height: 100, label: '1.91:1'},
  SQUARE_MARKETING_IMAGE: {width: 1, height: 1, label: '1:1'},
  PORTRAIT_MARKETING_IMAGE: {width: 4, height: 5, label: '4:5'},
  LOGO: {width: 1, height: 1, label: '1:1'},
  LANDSCAPE_LOGO: {width: 4, height: 1, label: '4:1'},
};
/**
 * How far an image's ratio may differ from its field type's before a link review refuses it, in percent. Google's own tolerance
 * is UNVERIFIED: its page says only that a link whose image does not conform to the aspect ratio is refused with
 * ASPECT_RATIO_NOT_ALLOWED. The value is wide on purpose, so no image Google accepts is refused here: 1200 x 627 and 1200 x 630
 * both pass as 1.91:1, and a 16:9 image (6.9 percent off) does not.
 */
const ratioTolerancePercent = 2;
/** The attributed campaign fields an asset group is judged by: its channel, brand-guideline mode and Merchant Center account. */
const groupCampaignFields = [
  'campaign.advertising_channel_type',
  'campaign.brand_guidelines_enabled',
  'campaign.shopping_setting.merchant_id',
];
/**
 * A read of the live links of the asset groups a review targets (R2.5 M3, G3): the marker, the groups it names, and the links
 * this review removes (round 2, S1-1), which the state does not count.
 */
type LinkRead = CompiledRequest & {googleAssetGroupLinkState?: {groups: string[]; removed: string[]}};
// These fields were checked against /google-ads/api/fields/v23/asset on
// 2026-09-18. Policy/serving observations and expiring image URLs are not config.
// Lead-form delivery credentials are deliberately never requested by a link.
const contentFields: Record<string, string[]> = {
  SITELINK: [
    'sitelink_asset.ad_schedule_targets',
    'sitelink_asset.description1',
    'sitelink_asset.description2',
    'sitelink_asset.end_date',
    'sitelink_asset.link_text',
    'sitelink_asset.start_date',
  ],
  CALLOUT: [
    'callout_asset.ad_schedule_targets',
    'callout_asset.callout_text',
    'callout_asset.end_date',
    'callout_asset.start_date',
  ],
  STRUCTURED_SNIPPET: ['structured_snippet_asset.header', 'structured_snippet_asset.values'],
  PROMOTION: [
    'promotion_asset.ad_schedule_targets',
    'promotion_asset.discount_modifier',
    'promotion_asset.end_date',
    'promotion_asset.language_code',
    'promotion_asset.money_amount_off.amount_micros',
    'promotion_asset.money_amount_off.currency_code',
    'promotion_asset.occasion',
    'promotion_asset.orders_over_amount.amount_micros',
    'promotion_asset.orders_over_amount.currency_code',
    'promotion_asset.percent_off',
    'promotion_asset.promotion_barcode_info.barcode_content',
    'promotion_asset.promotion_barcode_info.type',
    'promotion_asset.promotion_code',
    'promotion_asset.promotion_qr_code_info.qr_code_content',
    'promotion_asset.promotion_target',
    'promotion_asset.redemption_end_date',
    'promotion_asset.redemption_start_date',
    'promotion_asset.start_date',
    'promotion_asset.terms_and_conditions_text',
    'promotion_asset.terms_and_conditions_uri',
  ],
  PRICE: [
    'price_asset.language_code',
    'price_asset.price_offerings',
    'price_asset.price_qualifier',
    'price_asset.type',
  ],
  CALL: [
    'call_asset.ad_schedule_targets',
    'call_asset.call_conversion_action',
    'call_asset.call_conversion_reporting_state',
    'call_asset.country_code',
    'call_asset.phone_number',
  ],
  HOTEL_CALLOUT: ['hotel_callout_asset.language_code', 'hotel_callout_asset.text'],
  MOBILE_APP: [
    'mobile_app_asset.app_id',
    'mobile_app_asset.app_store',
    'mobile_app_asset.end_date',
    'mobile_app_asset.link_text',
    'mobile_app_asset.start_date',
  ],
  BUSINESS_MESSAGE: [
    'business_message_asset.call_to_action.call_to_action_description',
    'business_message_asset.call_to_action.call_to_action_selection',
    'business_message_asset.facebook_messenger_info.page_name',
    'business_message_asset.message_provider',
    'business_message_asset.starter_message',
    'business_message_asset.whatsapp_info.country_code',
    'business_message_asset.whatsapp_info.phone_number',
    'business_message_asset.zalo_info.custom_name',
    'business_message_asset.zalo_info.oa_id',
  ],
  LEAD_FORM: [
    'lead_form_asset.background_image_asset',
    'lead_form_asset.business_name',
    'lead_form_asset.call_to_action_description',
    'lead_form_asset.call_to_action_type',
    'lead_form_asset.custom_disclosure',
    'lead_form_asset.custom_question_fields',
    'lead_form_asset.description',
    'lead_form_asset.desired_intent',
    'lead_form_asset.fields',
    'lead_form_asset.headline',
    'lead_form_asset.post_submit_call_to_action_type',
    'lead_form_asset.post_submit_description',
    'lead_form_asset.post_submit_headline',
    'lead_form_asset.privacy_policy_url',
  ],
  TEXT: ['text_asset.text'],
  IMAGE: [
    'image_asset.file_size',
    'image_asset.full_size.height_pixels',
    'image_asset.full_size.width_pixels',
    'image_asset.mime_type',
  ],
  YOUTUBE_VIDEO: ['youtube_video_asset.youtube_video_id'],
  CALL_TO_ACTION: ['call_to_action_asset.call_to_action'],
};
export const googleAssetContentFields = contentFields;
export function googleAssetLinkKind(plan: CompiledRequest): Kind | undefined {
  const kind = plan.path.match(/^\/v\d+\/customers\/\d+\/([^/]+):mutate$/)?.[1];
  return plan.gateway === 'google_ads_native_action' &&
    plan.method === 'POST' &&
    kind &&
    Object.hasOwn(googleAssetLinkContracts, kind)
    ? (kind as Kind)
    : undefined;
}
function resource(value: unknown, account: string, collection: string, where: JsonObject): string {
  if (
    typeof value !== 'string' ||
    !new RegExp('^customers/' + account + '/' + collection + '/[1-9][0-9]*$').test(value)
  )
    invalid(
      'Use an existing ' +
        collection +
        ' resource in the selected customer; temporary and cross-account resources are unavailable.',
      where,
    );
  return value as string;
}
function identity(
  plan: CompiledRequest,
  op: JsonObject,
  index: number,
): {name: string; asset: string; parent?: string; role: string} {
  const kind = googleAssetLinkKind(plan)!,
    cfg = googleAssetLinkContracts[kind],
    account = plan.accountId!.replaceAll('-', '');
  if (op.create) {
    const r = op.create,
      asset = resource(r.asset, account, 'assets', {operation: index, field: at(index, '.create.asset')}),
      parent = cfg.parent
        ? resource(r[cfg.parent], account, cfg.collection, {
            operation: index,
            field: at(index, '.create.' + cfg.parent),
          })
        : undefined;
    if (!(cfg.roles as readonly unknown[]).includes(r.fieldType))
      invalid('The asset fieldType is not supported at this association level.', {
        operation: index,
        field: at(index, '.create.fieldType'),
        // The value the request gave (bounded), and every field type this level takes.
        field_type: typeof r.fieldType === 'string' ? r.fieldType.slice(0, 80) : null,
        allowed: [...cfg.roles],
      });
    return {
      asset,
      parent,
      role: r.fieldType,
      name:
        'customers/' +
        account +
        '/' +
        kind +
        '/' +
        (parent ? parent.split('/').at(-1) + '~' : '') +
        asset.split('/').at(-1) +
        '~' +
        r.fieldType,
    };
  }
  const name = op.remove ?? op.update?.resourceName;
  const match =
    typeof name === 'string'
      ? new RegExp(
          '^customers/' + account + '/' + kind + '/(' + (cfg.parent ? '[1-9][0-9]*~' : '') + '[1-9][0-9]*)~([A-Z_]+)$',
        ).exec(name)
      : null;
  if (!match || !(cfg.roles as readonly string[]).includes(match[2]!))
    invalid(
      'The association resource name must contain its exact selected-customer parent, asset and supported symbolic field type.',
      {
        operation: index,
        field: at(index, op.remove !== undefined ? '.remove' : op.update ? '.update.resourceName' : ''),
      },
    );
  const ids = match![1]!.split('~');
  return {
    name,
    asset: 'customers/' + account + '/assets/' + ids.at(-1),
    parent: cfg.parent ? 'customers/' + account + '/' + cfg.collection + '/' + ids[0] : undefined,
    role: match![2]!,
  };
}
/**
 * The links an all-create batch makes (R2.5 M2, L2-13): the entity they live in and the resource name each one has, in
 * order. A link's name is deterministic (customers/x/assetGroupAssets/{group}~{asset}~{FIELD}), so each can be looked up
 * by it. Undefined for a batch that updates or removes anything, and for a request that is no link batch.
 */
export function googleAssetLinkCreates(plan: CompiledRequest): {entity: string; names: string[]} | undefined {
  const kind = googleAssetLinkKind(plan);
  if (!kind) return undefined;
  try {
    const ops = googleJson(plan.body).operations as unknown[];
    if (!Array.isArray(ops) || !ops.length || !ops.every(op => object(op) && !!op.create)) return undefined;
    return {
      entity: googleAssetLinkContracts[kind].resource,
      names: (ops as JsonObject[]).map((op, i) => identity(plan, op, i).name),
    };
  } catch {
    return undefined;
  }
}
export function assertGoogleAssetLinks(plan: CompiledRequest): void {
  const kind = googleAssetLinkKind(plan);
  if (!kind) return;
  const cfg = googleAssetLinkContracts[kind],
    seen = new Map<string, number>(),
    b = googleJson(plan.body);
  // Every refusal names the operation and the field it came from (R2.5 M3, L2-07).
  for (const [i, op] of b.operations.entries()) {
    const keys = ['create', 'update', 'remove', 'updateMask'],
      level = op?.create ? '.create' : '.update';
    if (!object(op) || Object.keys(op).some(k => !keys.includes(k)))
      invalid('Use one native create, update or remove per operation.', {
        operation: i,
        field: at(i),
        allowed: keys,
      });
    const r = op.create ?? op.update;
    if (r !== undefined && !object(r))
      invalid('The association must be a native object.', {operation: i, field: at(i, level)});
    if (op.create) {
      const allowed = ['asset', 'fieldType', 'status', ...(cfg.parent ? [cfg.parent] : [])],
        extra = Object.keys(r).find(k => !allowed.includes(k));
      if (extra !== undefined || op.updateMask !== undefined)
        invalid('A create accepts asset, fieldType, status and its parent only.', {
          operation: i,
          field: extra !== undefined ? at(i, '.create.' + extra) : at(i, '.updateMask'),
          allowed,
        });
    } else if (op.update) {
      const extra = Object.keys(r).find(k => !['resourceName', 'status'].includes(k));
      if (op.updateMask !== 'status' || extra !== undefined || !Object.hasOwn(r, 'status'))
        invalid(
          'Only status can be updated. Changing an association identity requires a separately reviewed remove and create.',
          {
            operation: i,
            field:
              op.updateMask !== 'status'
                ? at(i, '.updateMask')
                : extra !== undefined
                  ? at(i, '.update.' + extra)
                  : at(i, '.update.status'),
            allowed: ['resourceName', 'status'],
          },
        );
    } else if (op.updateMask !== undefined)
      invalid('A remove does not accept updateMask.', {operation: i, field: at(i, '.updateMask')});
    if (r && Object.hasOwn(r, 'status') && !['ENABLED', 'PAUSED'].includes(r.status))
      invalid('Use ENABLED or PAUSED status, or an explicit remove operation.', {
        operation: i,
        field: at(i, level + '.status'),
        allowed: ['ENABLED', 'PAUSED'],
      });
    const target = identity(plan, op, i);
    if (seen.has(target.name))
      invalid('Each association may occur only once in a reviewed batch.', {
        operation: i,
        field: at(i),
        first_operation: seen.get(target.name),
      });
    seen.set(target.name, i);
  }
}
function search(
  plan: CompiledRequest,
  entity: string,
  fields: string[],
  names: string[],
  allowMissing = false,
  removedAsAbsent = false,
  // Fields of the resource the entity names, selected with it (an asset group's campaign: R2.5 M3, G3), as written in the query.
  related: string[] = [],
): CompiledRequest {
  const targets = [...new Set(names)].sort();
  const query =
    'SELECT ' +
    [...new Set(['resource_name', ...fields])].map(f => entity + '.' + f).join(', ') +
    related.map(f => ', ' + f).join('') +
    ' FROM ' +
    entity +
    ' WHERE ' +
    entity +
    '.resource_name IN (' +
    targets.map(n => "'" + n + "'").join(', ') +
    ')' +
    (entity.endsWith('_asset') && entity !== 'asset'
      ? ' AND ' + entity + ".status IN ('ENABLED', 'PAUSED', 'REMOVED')"
      : '');
  return readOf(
    plan,
    {
      action: 'AMCP_STATE_READ',
      method: 'POST',
      path: googleAdsCustomers + plan.accountId!.replaceAll('-', '') + '/googleAds:search',
      body: {query},
      query: {},
    },
    {googleState: {resource: entity, names: targets, allowMissing, removedAsAbsent}},
  );
}
const linkFields = (kind: Kind) => [
  'asset',
  'field_type',
  'status',
  ...(googleAssetLinkContracts[kind].parent ? [snake(googleAssetLinkContracts[kind].parent)] : []),
];
export function googleAssetLinkSnapshots(plan: CompiledRequest): CompiledRequest[] {
  const kind = googleAssetLinkKind(plan)!,
    cfg = googleAssetLinkContracts[kind],
    ops = googleJson(plan.body).operations as JsonObject[],
    targets = ops.map((op, i) => identity(plan, op, i)),
    reads: CompiledRequest[] = [];
  // Existing targets must exist; a create may be absent, but its parent and asset
  // never may. Capture absence too so concurrent attachments change the hash.
  for (const creating of [false, true]) {
    const names = targets.filter((_t, i) => !!ops[i]!.create === creating).map(t => t.name);
    if (names.length) reads.push(search(plan, cfg.resource, linkFields(kind), names, creating));
  }
  if (cfg.parent)
    reads.push(
      search(
        plan,
        snake(cfg.parent),
        cfg.parent === 'campaign'
          ? // A campaign is also read for its brand guideline mode (round 3, N2): a LOGO or LANDSCAPE_LOGO link is judged by it.
            ['name', 'status', 'advertising_channel_type', 'campaign_budget', 'brand_guidelines_enabled']
          : // An asset group is also read for its final URLs (round 2, S4-5): a retail group needs one before its first custom link.
            ['name', 'status', 'campaign', ...(kind === 'assetGroupAssets' ? ['final_urls'] : [])],
        targets.map(t => t.parent!),
        false,
        false,
        // An asset group is judged by its campaign's channel, brand-guideline mode and Merchant Center account (G3).
        kind === 'assetGroupAssets' ? groupCampaignFields : [],
      ),
    );
  else
    reads.push(
      readOf(plan, {
        action: 'AMCP_STATE_READ',
        method: 'POST',
        path: googleAdsCustomers + plan.accountId + '/googleAds:search',
        query: {},
        body: {query: 'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'},
        clears: [],
      }),
    );
  for (const type of [...new Set(targets.map(t => assetTypes[t.role] ?? t.role))]) {
    const fields = [
      'type',
      'source',
      'name',
      'final_urls',
      'final_mobile_urls',
      'tracking_url_template',
      'final_url_suffix',
      'url_custom_parameters',
      ...contentFields[type]!,
    ];
    reads.push(
      search(
        plan,
        'asset',
        fields,
        targets.filter(t => (assetTypes[t.role] ?? t.role) === type).map(t => t.asset),
      ),
    );
  }
  // The live advertiser links of each asset group the review targets, so the group's counts after it can be judged (G3). One
  // read for every group. The state it joins to the review's hash is not the links: only what the verdict depends on (round 2,
  // S1-1, see googleAssetGroupLinkState), so the links a longer request adds in its earlier parts do not change a later part.
  if (kind === 'assetGroupAssets')
    reads.push(
      groupLinks(
        plan,
        targets.map(t => t.parent!),
        targets.filter((_t, i) => typeof ops[i]!.remove === 'string').map(t => t.name),
      ),
    );
  return reads;
}
/**
 * The one read of the live links (ENABLED or PAUSED) of the asset groups named; `removed` are the links this review removes.
 * The pixel size of a linked image is not selected: the ratio check judges the images the review itself links, read as assets.
 */
function groupLinks(plan: CompiledRequest, groups: string[], removed: string[]): LinkRead {
  const names = [...new Set(groups)].sort(),
    selected = [
      'asset_group_asset.resource_name',
      'asset_group_asset.asset',
      'asset_group_asset.field_type',
      'asset_group_asset.status',
      'asset_group_asset.source',
    ];
  const query =
    'SELECT ' +
    selected.join(', ') +
    ' FROM asset_group_asset WHERE asset_group_asset.asset_group IN (' +
    names.map(n => "'" + n + "'").join(', ') +
    ") AND asset_group_asset.status IN ('ENABLED', 'PAUSED')";
  return readOf<LinkRead>(
    plan,
    {
      action: 'AMCP_ASSET_GROUP_LINKS_READ',
      method: 'POST',
      path: googleAdsCustomers + plan.accountId!.replaceAll('-', '') + '/googleAds:search',
      body: {query},
      query: {},
    },
    {googleAssetGroupLinkState: {groups: names, removed: [...new Set(removed)].sort()}},
  );
}
export function isGoogleAssetGroupLinkRead(read: CompiledRequest): boolean {
  return read.gateway === 'google_ads_native_action' && !!(read as LinkRead).googleAssetGroupLinkState;
}
/** The asset group a link's resource name belongs to, or undefined for a name that is no link of the customer. */
function groupOfLink(name: unknown, account: string): string | undefined {
  const m =
    typeof name === 'string'
      ? new RegExp('^customers/' + account + '/assetGroupAssets/([1-9][0-9]*)~[1-9][0-9]*~[A-Z_]+$').exec(name)
      : null;
  return m ? 'customers/' + account + '/assetGroups/' + m[1] : undefined;
}
/**
 * Refuses a read of live links that is incomplete or names another target: a failed or non-200 answer, a paged answer (an unread
 * page may hold the link that is missing), or a row that is no link of a group the review targets, a duplicate, or neither
 * ENABLED nor PAUSED. The codes are the ones every gateway state read gives (src/write-state.ts); the sentences name the links.
 */
export function validateGoogleAssetGroupLinkRead(read: CompiledRequest, result: TransportResult): void {
  const marker = (read as LinkRead).googleAssetGroupLinkState!,
    d = result.data,
    account = read.accountId!.replaceAll('-', '');
  if (result.status !== 200 || !object(d) || d.error || (d.results !== undefined && !Array.isArray(d.results)))
    fail('STATE_READ_FAILED', 'Google must return the live asset links of the asset group.');
  if (d.nextPageToken)
    fail(
      'INCOMPLETE_STATE',
      'The live asset links of the asset group were read incompletely; no mutation was submitted.',
    );
  const seen = new Set<string>();
  for (const row of (d.results ?? []) as unknown[]) {
    const link = object(row) ? googleJson(row).assetGroupAsset : undefined,
      group = object(link) ? groupOfLink(link.resourceName, account) : undefined;
    if (
      !object(link) ||
      !group ||
      !marker.groups.includes(group) ||
      seen.has(link.resourceName) ||
      !['ENABLED', 'PAUSED'].includes(link.status)
    )
      fail('STATE_TARGET_MISMATCH', 'Asset link rows must belong to the asset groups of this review, once each.');
    seen.add(link.resourceName);
  }
}
/**
 * What a review keeps of the live links (round 2, S1-1, the lead's decision on the review's option A): only what the precheck's
 * verdict depends on, in a form the creates of the same group cannot change. For each asset group and each field type that has a
 * minimum, the number of Google's ADVERTISER links of that type this review does not remove, capped at the minimum with brand
 * guidelines off (`min(n, m) + c >= m` holds exactly when `n + c >= m`, so the verdict is the same; a count below its minimum is not
 * capped, so a refusal reports it exactly); and whether any advertiser link would remain, for the retail rule. No link, status or
 * image size is kept. Google's AUTOMATICALLY_CREATED rows change by themselves and are no link of the advertiser, so they
 * neither count nor change the state.
 *
 * Before, the state was every link of the group with its status and the pixel size of its image. A request of more than 25 links to
 * one group is split into parts that are executed in order under one approval (src/write-groups.ts), each with its own state:
 * the links part 1 added changed the group part 2 had read, and part 2 was refused STATE_CHANGED with the group half applied.
 * Now a link added to a group that meets its minimums changes nothing here. Another person's removal that leaves a type below its
 * minimum still does, and the minimums are judged again at execute (validateGoogleAssetGroupLinks) before the hash is compared.
 */
export function googleAssetGroupLinkState(read: CompiledRequest, data: JsonObject): JsonObject {
  const marker = (read as LinkRead).googleAssetGroupLinkState;
  // Frozen review states are normalized again at execution; an already projected state stays as it is.
  if (!marker || Array.isArray(data.asset_group_link_counts)) return data;
  const account = read.accountId!.replaceAll('-', ''),
    removed = new Set(marker.removed),
    linked = new Map<string, string[]>();
  for (const row of ((data.results ?? []) as unknown[]).map(googleJson) as JsonObject[]) {
    const link = row.assetGroupAsset,
      group =
        link?.source === 'ADVERTISER' && !removed.has(link.resourceName)
          ? groupOfLink(link.resourceName, account)
          : undefined;
    if (group) linked.set(group, [...(linked.get(group) ?? []), link.fieldType]);
  }
  return {
    asset_group_link_counts: marker.groups.map(group => {
      const types = linked.get(group) ?? [];
      return {
        asset_group: group,
        counts: Object.fromEntries(
          Object.entries(pmaxAssetRequirements.fields)
            .filter(([, rule]) => rule.min > 0)
            .map(([type, rule]) => [type, Math.min(types.filter(t => t === type).length, rule.min)]),
        ),
        has_other_links: types.length > 0,
      };
    }),
  };
}
export function validateGoogleAssetLinkState(plan: CompiledRequest, states: unknown[], preparing = false): void {
  const kind = googleAssetLinkKind(plan);
  if (!kind) return;
  const cfg = googleAssetLinkContracts[kind],
    rows = states.flatMap(s => (s as JsonObject).results ?? []).map(googleJson),
    ops = googleJson(plan.body).operations as JsonObject[];
  // Every refusal names the operation and the field it came from (R2.5 M3, L2-07): a create's asset and parent are named in
  // the create, an update's or a remove's in the resource name it carries.
  for (const [i, op] of ops.entries()) {
    const t = identity(plan, op, i),
      named = at(i, op.create ? '.create' : op.remove !== undefined ? '.remove' : '.update.resourceName'),
      assetField = op.create ? at(i, '.create.asset') : named,
      asset = rows.map(r => r.asset).find(r => r?.resourceName === t.asset),
      expected = assetTypes[t.role] ?? t.role;
    if (!asset || asset.type !== expected)
      throw new MirrorError(
        'ASSET_TYPE_MISMATCH',
        'The selected asset type does not match the requested association role.',
        {operation: i, field: assetField, resource_name: t.asset, expected_type: expected},
      );
    if (op.create && asset.source === 'AUTOMATICALLY_CREATED')
      throw new MirrorError(
        'INVALID_ASSET_LINK',
        'Automatically created assets cannot be attached through this advertiser-owned contract.',
        {operation: i, field: assetField, resource_name: t.asset},
      );
    if (cfg.parent) {
      const parent = rows.map(r => r[cfg.parent]).find(r => r?.resourceName === t.parent);
      if (!parent || !['ENABLED', 'PAUSED'].includes(parent.status))
        throw new MirrorError('INVALID_ASSET_PARENT', 'The exact parent must exist and be enabled or paused.', {
          operation: i,
          field: op.create ? at(i, '.create.' + cfg.parent) : named,
          resource_name: t.parent,
        });
    }
    const link = rows
      .map(r => r[cfg.resource.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())])
      .find(r => r?.resourceName === t.name);
    if (
      link &&
      (link.asset !== t.asset ||
        link.fieldType !== t.role ||
        (cfg.parent && link[cfg.parent] !== t.parent) ||
        !['ENABLED', 'PAUSED', 'REMOVED'].includes(link.status))
    )
      throw new MirrorError(
        'STATE_TARGET_MISMATCH',
        'The provider returned inconsistent asset association identity or status.',
        {operation: i, field: named, resource_name: t.name},
      );
    if (preparing && op.create && link && link.status !== 'REMOVED')
      throw new MirrorError(
        'ASSET_LINK_EXISTS',
        'This asset is already attached with the requested role. Review its status; do not create a duplicate.',
        {operation: i, field: named, resource_name: t.name},
      );
    if (!op.create && (!link || link.status === 'REMOVED'))
      throw new MirrorError('STATE_NOT_FOUND', 'The association to update or remove must still exist.', {
        operation: i,
        field: named,
        resource_name: t.name,
      });
  }
}
/**
 * The precheck of an asset group's images and minimums in a one-service link review (R2.5 M3, G3). Before it, a link set without
 * a 1.91:1 marketing image passed here and Google refused it at execute (NOT_ENOUGH_MARKETING_IMAGE_ASSET), which spent the review.
 *
 * - A create of BUSINESS_NAME, LOGO or LANDSCAPE_LOGO in a group of a campaign with brand guidelines on is INVALID_ASSET_LINK
 *   (round 2, S3-1): they link to the campaign, and the refusal names that level. A removal is allowed.
 * - The first custom links of a retail group that has no final URL are INVALID_ASSET_PARENT (round 2, S4-5, part 1: Google's retail
 *   page). It is judged before the counts. The other retail rule on that page, the campaign's own brand assets in the same
 *   request when brand guidelines are on, is not prechecked.
 * - The shape of each image the review links, against its field type's documented ratio (imageRatios): outside the tolerance
 *   it is INVALID_ASSET_LINK with the ratio and the image's size. An image Google has not measured is not judged.
 * - The counts of each asset group after the review (its live advertiser links, less this review's removals, plus its
 *   creates), judged by pmaxCountProblems in the campaign's mode (brand guidelines, retail): below a minimum it is
 *   PMAX_ASSET_MINIMUMS. The live links come from the state as googleAssetGroupLinkState keeps them, each count capped at its
 *   minimum, which gives the same verdict. A retail group with no advertiser link afterwards is accepted, because Google
 *   generates the minimum set. It never refuses on a maximum (lead review 2026-11-17): the pinned maximums may be stale (Q6).
 *
 * A group whose campaign the read does not show as a Performance Max campaign is not judged: what is unknown stays unknown, and
 * Google decides, as it did before. Only the asset-group level is judged; the other levels have no such minimums.
 */
export function validateGoogleAssetGroupLinks(plan: CompiledRequest, states: unknown[]): void {
  if (googleAssetLinkKind(plan) !== 'assetGroupAssets') return;
  const rows = states.flatMap(s => (s as JsonObject).results ?? []).map(googleJson),
    held = states.flatMap(s =>
      object(s) && Array.isArray(s.asset_group_link_counts) ? s.asset_group_link_counts : [],
    ) as JsonObject[],
    ops = googleJson(plan.body).operations as JsonObject[],
    targets = ops.map((op, i) => identity(plan, op, i)),
    // What the group's campaign says of how its groups are judged; undefined when the read does not show it.
    factsOf = (groupName: string) =>
      pmaxCampaignFacts(rows.find(r => r.assetGroup?.resourceName === groupName)?.campaign);
  ops.forEach((op, i) => {
    // With brand guidelines on, the business name and the logos are the campaign's own (round 2, S3-1): Google refuses one linked to
    // an asset group (AssetLinkError.BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL). A rule of the level, so a create only: a link the
    // group already holds from before can be removed. Judged before the image's shape, the more basic fault.
    if (op.create && pmaxBrandAssetTypes.has(op.create.fieldType)) {
      const facts = factsOf(targets[i]!.parent!);
      if (facts?.channel === 'PERFORMANCE_MAX' && facts.mode.brandGuidelines)
        throw new MirrorError(
          'INVALID_ASSET_LINK',
          'With brand guidelines on, the business name and the logos belong to the campaign, not to its asset groups: Google refuses a BUSINESS_NAME, LOGO or LANDSCAPE_LOGO linked to an asset group (BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL). Leave it out of this review; brand assets are linked at the campaign level with google_ads_v23_campaign_asset_mutate_campaign_assets.',
          {operation: i, field: at(i, '.create.fieldType'), field_type: op.create.fieldType},
        );
    }
    const want = op.create ? imageRatios[op.create.fieldType] : undefined;
    if (!want) return;
    const size = rows.map(r => r.asset).find(a => a?.resourceName === op.create.asset)?.imageAsset?.fullSize,
      width = Number(size?.widthPixels),
      height = Number(size?.heightPixels);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return;
    // |width / height - ratio| / ratio > tolerance, in whole numbers: |width * h - height * w| * 100 > tolerance * height * w.
    if (Math.abs(width * want.height - height * want.width) * 100 > ratioTolerancePercent * height * want.width)
      throw new MirrorError(
        'INVALID_ASSET_LINK',
        'This image’s shape is outside the aspect ratio Performance Max documents for its field type, so Google would refuse the link (ASPECT_RATIO_NOT_ALLOWED). Link another image, or link this one as the field type that fits its shape. details.expected_ratio, details.width_pixels and details.height_pixels give the ratio and the image’s size.',
        {
          operation: i,
          field: at(i, '.create.asset'),
          field_type: op.create.fieldType,
          expected_ratio: want.label,
          width_pixels: width,
          height_pixels: height,
        },
      );
  });
  for (const groupName of [...new Set(targets.map(t => t.parent!))]) {
    // A review that only changes link statuses changes no count: it is not refused for a shortfall it did not cause.
    if (!ops.some((op, i) => targets[i]!.parent === groupName && (op.create || op.remove !== undefined))) continue;
    const facts = factsOf(groupName);
    if (facts?.channel !== 'PERFORMANCE_MAX') continue;
    // The group as the state holds it: the advertiser links this review does not remove, each count capped at its minimum.
    const before = held.find(h => h.asset_group === groupName);
    if (!before) continue;
    const counts: Record<string, number> = {...before.counts};
    let created = 0,
      first = -1;
    ops.forEach((op, i) => {
      if (targets[i]!.parent !== groupName || !op.create) return;
      counts[targets[i]!.role] = (counts[targets[i]!.role] ?? 0) + 1;
      if (first < 0) first = i;
      created++;
    });
    // Google's retail page (round 2, S4-5 part 1): a retail asset group may be left without custom assets, but linking custom assets
    // to it needs at least one final URL on the group, with every minimum asset in one atomic request. The first custom links of a
    // retail group that has no final URL are refused here; the group read selects `final_urls`, and Google leaves out an empty list.
    if (facts.mode.retail && created > 0 && before.has_other_links !== true) {
      const urls = rows.find(r => r.assetGroup?.resourceName === groupName)?.assetGroup?.finalUrls;
      if (!Array.isArray(urls) || !urls.length)
        throw new MirrorError(
          'INVALID_ASSET_PARENT',
          'This retail asset group has no final URL. Google requires at least one final URL on the group before the first custom assets are linked to it, and every minimum asset in the same request; without them it leaves the group in a state its editor cannot change. Set a final URL on the group first with google_ads_v23_asset_group_mutate_asset_groups (an update with update_mask final_urls, its own review), or create a new asset group with its final URL and all its links in one build under the same campaign (google_ads_v23_google_ads_mutate).',
          {operation: first, field: at(first, '.create.assetGroup'), resource_name: groupName},
        );
    }
    const found = pmaxCountProblems(counts, facts.mode, 'minimums', before.has_other_links === true || created > 0);
    if (found.outside_range.length) {
      const details = {
        asset_group: groupName,
        // A count below its minimum is exact; one at or above it shows the minimum or more (the state caps it).
        counts: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)),
        outside_range: found.outside_range,
        source: pmaxAssetRequirements.source,
      };
      // Google refuses a group without a 1.91:1 marketing image at execute: the message says what to upload (no amcp_media preset
      // makes 1.91:1 before M10) and to link it in the same review.
      if (found.outside_range.some(r => r.field_type === 'MARKETING_IMAGE'))
        throw new MirrorError(
          'PMAX_ASSET_MINIMUMS',
          'After this review the asset group would have no marketing image of the 1.91:1 ratio, which Performance Max requires (Google recommends 1200 x 628). Upload a 1.91:1 image and link it as MARKETING_IMAGE in the same review; outside_range lists every other asset that is short.',
          details,
        );
      throw new MirrorError(
        'PMAX_ASSET_MINIMUMS',
        'After this review the asset group would link fewer assets than Performance Max requires: Google refuses that, or, for a retail campaign, leaves the group in a state its editor cannot change. Add the assets that outside_range lists in the same review, or leave the group as it is.',
        details,
      );
    }
  }
}
/**
 * The brand-level rule of a campaign-level link, the other half of the asset group's (round 3, N2). With brand guidelines off, the
 * business name and the logos of a Performance Max campaign link to its asset groups, and Google refuses a LOGO or LANDSCAPE_LOGO
 * linked to the campaign (AssetLinkError.BRAND_ASSETS_NOT_LINKED_AT_ASSET_GROUP_LEVEL: "For Performance Max campaigns where
 * brand_guidelines_enabled is false, business name and logo assets must be linked as AssetGroupAssets"). Since round 2 those two are
 * roles of this level, which a campaign with brand guidelines on needs, so a create of one on a campaign that is PERFORMANCE_MAX
 * without brand guidelines is refused here, naming the asset-group level, and the review is not spent. Google leaves out a boolean
 * that is false, so a campaign whose read has no brand_guidelines_enabled is off. Another channel, or a campaign the read does not
 * show, is left to Google: its rule for them is not documented here. A removal or a status change is allowed.
 */
export function validateGoogleCampaignBrandLinks(plan: CompiledRequest, states: unknown[]): void {
  if (googleAssetLinkKind(plan) !== 'campaignAssets') return;
  const rows = states.flatMap(s => (s as JsonObject).results ?? []).map(googleJson),
    ops = googleJson(plan.body).operations as JsonObject[];
  ops.forEach((op, i) => {
    if (!op.create || !['LOGO', 'LANDSCAPE_LOGO'].includes(op.create.fieldType)) return;
    const parent = identity(plan, op, i).parent,
      facts = pmaxCampaignFacts(rows.map(r => r.campaign).find(c => c?.resourceName === parent));
    if (facts?.channel === 'PERFORMANCE_MAX' && !facts.mode.brandGuidelines)
      throw new MirrorError(
        'INVALID_ASSET_LINK',
        'With brand guidelines off, the business name and the logos of a Performance Max campaign belong to its asset groups, not to the campaign: Google refuses a LOGO or LANDSCAPE_LOGO linked to the campaign (BRAND_ASSETS_NOT_LINKED_AT_ASSET_GROUP_LEVEL). Leave it out of this review; link it to an asset group with google_ads_v23_asset_group_asset_mutate_asset_group_assets.',
        {operation: i, field: at(i, '.create.fieldType'), field_type: op.create.fieldType},
      );
  });
}
export function googleAssetLinkOutcome(plan: CompiledRequest, result: TransportResult): boolean {
  const operations = googleJson(plan.body).operations as JsonObject[],
    rows = (result.data as JsonObject)?.results;
  return (
    [200, 201].includes(result.status) &&
    Array.isArray(rows) &&
    rows.length === operations.length &&
    rows.every((r, i) => r?.resourceName === identity(plan, operations[i]!, i).name)
  );
}
export function googleAssetLinkActivates(plan: CompiledRequest): boolean {
  return (
    !!googleAssetLinkKind(plan) &&
    googleJson(plan.body).operations.some(
      (op: JsonObject) => (op.create && op.create.status !== 'PAUSED') || op.update?.status === 'ENABLED',
    )
  );
}
/**
 * A create that sends PAUSED for an image, which Google has been seen to switch on (src/known-behaviours.ts): the owner's round 1 (23-24 Nov 2026) created 48
 * image links PAUSED and Google served them for about 6 minutes. Images only, which is all the evidence there is; widen it when another role is seen.
 */
const switchedOn = 'GOOGLE_ASSET_LINK_PAUSED_SWITCHED_ON';
const pausedImage = (op: JsonObject): boolean =>
  !!op.create && op.create.status === 'PAUSED' && assetTypes[op.create.fieldType] === 'IMAGE';
export function googleAssetLinkVerification(
  plan: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string; known?: string}[] {
  const kind = googleAssetLinkKind(plan)!;
  return (googleJson(plan.body).operations as JsonObject[]).map((op, i) => {
    const t = identity(plan, op, i),
      removed = typeof op.remove === 'string';
    return {
      read: search(plan, googleAssetLinkContracts[kind].resource, linkFields(kind), [t.name], removed, removed),
      expected: removed ? {status: 'REMOVED'} : (op.create ?? op.update),
      id: t.name,
      ...(pausedImage(op) ? {known: switchedOn} : {}),
    };
  });
}

/** What an asset link write changes, as prepare returns it for review. */
export function googleAssetLinkImpact(plan: CompiledRequest): JsonObject {
  const known = (googleJson(plan.body).operations as JsonObject[]).filter(pausedImage).length;
  return {
    provider: 'google',
    effect:
      'Changes associations of existing assets; it does not create new assets. Enabled links may serve under enabled parents. An omitted create status is treated as activation for owner policy checks.',
    may_activate: googleAssetLinkActivates(plan) || known > 0,
    scope: googleAssetLinkKind(plan),
    source: 'https://developers.google.com/google-ads/api/docs/assets/working-with-assets',
    limits:
      'Provider policy approval, campaign-type rules and maximum asset counts remain provider checks; the minimum counts and image shapes of a Performance Max asset group are checked before this review is prepared. Link read-back proves configuration, not impressions or approval. Lead-form delivery credentials are never read by this contract.',
    // What Google has been seen to do to a PAUSED image link (src/known-behaviours.ts): the review copies it into its reasons, and the policy reads its code.
    ...(known ? {known_behaviour: {code: switchedOn, count: known, note: knownBehaviours[switchedOn]!.note}} : {}),
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleAssetLinkFamily: ReviewedFamily = defineFamily({
  name: 'google_asset_links',
  files: ['src/google-asset-links.ts', ['tests/google-asset-links.test.ts']],
  kind: googleAssetLinkKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertGoogleAssetLinks(plan);
  },
  snapshots: googleAssetLinkSnapshots,
  // The live links of an asset group are the family's own read (R2.5 M3, G3); its other reads are the gateway's.
  isRead: isGoogleAssetGroupLinkRead,
  validateState: validateGoogleAssetGroupLinkRead,
  snapshotState: googleAssetGroupLinkState,
  prerequisites: (plan, state) => {
    validateGoogleAssetLinkState(plan, state);
    validateGoogleCampaignBrandLinks(plan, state);
    validateGoogleAssetGroupLinks(plan, state);
  },
  stateChecks: (plan, state, preparing) => {
    if (preparing) validateGoogleAssetLinkState(plan, state, true);
  },
  impact: googleAssetLinkImpact,
  outcome: googleAssetLinkOutcome,
  verification: (plan: CompiledRequest) => googleAssetLinkVerification(plan),
  spendConfirmation: {
    needed: () => true,
    message:
      'Asset associations change which creative can serve. Review the parent state and provide spend_change_confirmed=true.',
  },
  activates: plan => !!googleAssetLinkActivates(plan),
});
