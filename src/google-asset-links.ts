import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {MirrorError} from './errors.js';
import {googleJson} from './google-contracts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {googleAdsCustomers} from './google-version.js';
import {defineFamily, readOf} from './family-kit.js';

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
    roles: [...common, 'AD_IMAGE', 'BUSINESS_NAME', 'BUSINESS_LOGO', 'LEAD_FORM'],
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
    ],
  },
} as const;
type Kind = keyof typeof googleAssetLinkContracts;
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const invalid = (message: string): never => {
  throw new MirrorError('INVALID_ASSET_LINK', message);
};
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
  LOGO: 'IMAGE',
  LANDSCAPE_LOGO: 'IMAGE',
  YOUTUBE_VIDEO: 'YOUTUBE_VIDEO',
  CALL_TO_ACTION_SELECTION: 'CALL_TO_ACTION',
};
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
function resource(value: unknown, account: string, collection: string): string {
  if (
    typeof value !== 'string' ||
    !new RegExp('^customers/' + account + '/' + collection + '/[1-9][0-9]*$').test(value)
  )
    invalid(
      'Use an existing ' +
        collection +
        ' resource in the selected customer; temporary and cross-account resources are unavailable.',
    );
  return value as string;
}
function identity(plan: CompiledRequest, op: JsonObject): {name: string; asset: string; parent?: string; role: string} {
  const kind = googleAssetLinkKind(plan)!,
    cfg = googleAssetLinkContracts[kind],
    account = plan.accountId!.replaceAll('-', '');
  if (op.create) {
    const r = op.create,
      asset = resource(r.asset, account, 'assets'),
      parent = cfg.parent ? resource(r[cfg.parent], account, cfg.collection) : undefined;
    if (!(cfg.roles as readonly unknown[]).includes(r.fieldType))
      invalid('The asset fieldType is not supported at this association level.');
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
    );
  const ids = match![1]!.split('~');
  return {
    name,
    asset: 'customers/' + account + '/assets/' + ids.at(-1),
    parent: cfg.parent ? 'customers/' + account + '/' + cfg.collection + '/' + ids[0] : undefined,
    role: match![2]!,
  };
}
export function assertGoogleAssetLinks(plan: CompiledRequest): void {
  const kind = googleAssetLinkKind(plan);
  if (!kind) return;
  const cfg = googleAssetLinkContracts[kind],
    seen = new Set<string>(),
    b = googleJson(plan.body);
  for (const op of b.operations) {
    if (!object(op) || Object.keys(op).some(k => !['create', 'update', 'remove', 'updateMask'].includes(k)))
      invalid('Use one native create, update or remove per operation.');
    const r = op.create ?? op.update;
    if (r !== undefined && !object(r)) invalid('The association must be a native object.');
    if (op.create) {
      if (
        Object.keys(r).some(k => !['asset', 'fieldType', 'status', ...(cfg.parent ? [cfg.parent] : [])].includes(k)) ||
        op.updateMask !== undefined
      )
        invalid('A create accepts asset, fieldType, status and its parent only.');
    } else if (op.update) {
      if (
        op.updateMask !== 'status' ||
        Object.keys(r).some(k => !['resourceName', 'status'].includes(k)) ||
        !Object.hasOwn(r, 'status')
      )
        invalid(
          'Only status can be updated. Changing an association identity requires a separately reviewed remove and create.',
        );
    } else if (op.updateMask !== undefined) invalid('A remove does not accept updateMask.');
    if (r && Object.hasOwn(r, 'status') && !['ENABLED', 'PAUSED'].includes(r.status))
      invalid('Use ENABLED or PAUSED status, or an explicit remove operation.');
    const target = identity(plan, op);
    if (seen.has(target.name)) invalid('Each association may occur only once in a reviewed batch.');
    seen.add(target.name);
  }
}
function search(
  plan: CompiledRequest,
  entity: string,
  fields: string[],
  names: string[],
  allowMissing = false,
  removedAsAbsent = false,
): CompiledRequest {
  const targets = [...new Set(names)].sort();
  const query =
    'SELECT ' +
    [...new Set(['resource_name', ...fields])].map(f => entity + '.' + f).join(', ') +
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
    targets = ops.map(op => identity(plan, op)),
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
          ? ['name', 'status', 'advertising_channel_type', 'campaign_budget']
          : ['name', 'status', 'campaign'],
        targets.map(t => t.parent!),
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
  return reads;
}
export function validateGoogleAssetLinkState(plan: CompiledRequest, states: unknown[], preparing = false): void {
  const kind = googleAssetLinkKind(plan);
  if (!kind) return;
  const cfg = googleAssetLinkContracts[kind],
    rows = states.flatMap(s => (s as JsonObject).results ?? []).map(googleJson),
    ops = googleJson(plan.body).operations as JsonObject[];
  for (const op of ops) {
    const t = identity(plan, op),
      asset = rows.map(r => r.asset).find(r => r?.resourceName === t.asset),
      expected = assetTypes[t.role] ?? t.role;
    if (!asset || asset.type !== expected)
      throw new MirrorError(
        'ASSET_TYPE_MISMATCH',
        'The selected asset type does not match the requested association role.',
        {resource_name: t.asset, expected_type: expected},
      );
    if (op.create && asset.source === 'AUTOMATICALLY_CREATED')
      throw new MirrorError(
        'INVALID_ASSET_LINK',
        'Automatically created assets cannot be attached through this advertiser-owned contract.',
      );
    if (cfg.parent) {
      const parent = rows.map(r => r[cfg.parent]).find(r => r?.resourceName === t.parent);
      if (!parent || !['ENABLED', 'PAUSED'].includes(parent.status))
        throw new MirrorError('INVALID_ASSET_PARENT', 'The exact parent must exist and be enabled or paused.');
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
      );
    if (preparing && op.create && link && link.status !== 'REMOVED')
      throw new MirrorError(
        'ASSET_LINK_EXISTS',
        'This asset is already attached with the requested role. Review its status; do not create a duplicate.',
        {resource_name: t.name},
      );
    if (!op.create && (!link || link.status === 'REMOVED'))
      throw new MirrorError('STATE_NOT_FOUND', 'The association to update or remove must still exist.');
  }
}
export function googleAssetLinkOutcome(plan: CompiledRequest, result: TransportResult): boolean {
  const operations = googleJson(plan.body).operations as JsonObject[],
    rows = (result.data as JsonObject)?.results;
  return (
    [200, 201].includes(result.status) &&
    Array.isArray(rows) &&
    rows.length === operations.length &&
    rows.every((r, i) => r?.resourceName === identity(plan, operations[i]!).name)
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
export function googleAssetLinkVerification(
  plan: CompiledRequest,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const kind = googleAssetLinkKind(plan)!;
  return (googleJson(plan.body).operations as JsonObject[]).map(op => {
    const t = identity(plan, op),
      removed = typeof op.remove === 'string';
    return {
      read: search(plan, googleAssetLinkContracts[kind].resource, linkFields(kind), [t.name], removed, removed),
      expected: removed ? {status: 'REMOVED'} : (op.create ?? op.update),
      id: t.name,
    };
  });
}

/** What an asset link write changes, as prepare returns it for review. */
export function googleAssetLinkImpact(plan: CompiledRequest): JsonObject {
  return {
    provider: 'google',
    effect:
      'Changes associations of existing assets; it does not create new assets. Enabled links may serve under enabled parents. An omitted create status is treated as activation for owner policy checks.',
    may_activate: googleAssetLinkActivates(plan),
    scope: googleAssetLinkKind(plan),
    source: 'https://developers.google.com/google-ads/api/docs/assets/working-with-assets',
    limits:
      'Provider policy approval, campaign-type rules and asset-count requirements remain provider checks. Link read-back proves configuration, not impressions or approval. Lead-form delivery credentials are never read by this contract.',
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
  prerequisites: (plan, state) => validateGoogleAssetLinkState(plan, state),
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
