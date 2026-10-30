import {assertNoMethodOverride} from './write-common.js';
import type {ReviewedFamily} from './reviewed-family.js';
import {
  keywordPlanResources,
  assertKeywordPlanRecord,
  keywordPlanClear,
  keywordPlanSnapshots,
  validateKeywordPlanPrerequisites,
  keywordPlanCanonical,
  keywordPlanObserved,
  keywordPlanFieldHashes,
  validateKeywordPlanTree,
  keywordPlanKind,
  readKeywordPlanTree,
} from './google-keyword-plan-writes.js';
import {
  segmentFields,
  assertGoogleSegmentRecord,
  assertGoogleSegmentOperation,
  googleSegmentResource,
  googleSegmentCanonical,
  googleSegmentImpact,
  googleSegmentKind,
  googleSegmentRemoval,
} from './google-custom-segments.js';
import {assertGoogleAudienceRecord, googleAudienceCanonical} from './google-audiences.js';
import {
  assertGoogleUserListOperation,
  assertGoogleUserListRecord,
  validateGoogleUserListState,
  googleUserListCanonical,
  googleUserListImpact,
} from './google-user-lists.js';
import {
  assertGoogleValueRuleOperation,
  assertGoogleValueRuleRecord,
  valueRuleSetRuleNames,
  validateValueRuleSetPrerequisites,
  googleValueRuleCanonical,
  googleValueRuleImpact,
} from './google-value-rules.js';
import {MirrorError} from './errors.js';
import {googleJson, assertGoogleAdsScope} from './google-contracts.js';
import {
  googleAssetSetFields,
  googleFeedFields,
  assertAssetSetRecord,
  assetSetExtraSnapshots,
  validateAssetSetPrerequisites,
  assetSetObserved,
  assetSetCanonical,
  assetSetExactFields,
  validateAssetSetContents,
  readAssetSetContents,
} from './google-asset-set-writes.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import {googleAdsCustomers} from './google-version.js';
import {defineFamily, readOf} from './family-kit.js';

type Reference = {field: string; collection: string; parts: number; resource: string; fields: string[]};
type Contract = {
  resource: string;
  collection: string;
  parts: number;
  create: string[];
  required: string[];
  mutable: string[];
  fields: string[];
  references: Reference[];
  identity?: string[];
  serving: boolean;
};
const reference = (field: string, collection: string, resource: string, fields: string[], parts = 1): Reference => ({
  field,
  collection,
  resource,
  fields,
  parts,
});
const campaign = reference('campaign', 'campaigns', 'campaign', [
  'name',
  'status',
  'advertising_channel_type',
  'campaign_budget',
]);
const group = reference('adGroup', 'adGroups', 'ad_group', ['name', 'status', 'campaign']);
const criterion = reference(
  'adGroupCriterion',
  'adGroupCriteria',
  'ad_group_criterion',
  ['ad_group', 'type', 'status', 'negative', 'keyword.text', 'keyword.match_type'],
  2,
);
const label = reference('label', 'labels', 'label', [
  'name',
  'status',
  'text_label.background_color',
  'text_label.description',
]);
const attribute = reference('customizerAttribute', 'customizerAttributes', 'customizer_attribute', [
  'name',
  'type',
  'status',
]);
const assetSet = reference('assetSet', 'assetSets', 'asset_set', googleAssetSetFields);
const feedAsset = reference('asset', 'assets', 'asset', googleFeedFields);
const planningReference = (collection: string) => {
  const c = keywordPlanResources[collection]!;
  return reference(
    c.parent!.field,
    c.parent!.collection,
    keywordPlanResources[c.parent!.collection]!.resource,
    keywordPlanResources[c.parent!.collection]!.fields,
  );
};
const descriptor = (
  resource: string,
  collection: string,
  create: string[],
  required: string[],
  mutable: string[],
  fields: string[],
  options: Partial<Contract> = {},
): Contract => ({
  resource,
  collection,
  parts: 1,
  create,
  required,
  mutable,
  fields,
  references: [],
  serving: false,
  ...options,
});
const association = (resource: string, collection: string, parent: Reference) =>
  descriptor(
    resource,
    collection,
    [parent.field, 'label'],
    [parent.field, 'label'],
    [],
    [snake(parent.field), 'label'],
    {parts: parent.parts + 1, references: [parent, label], identity: [parent.field, 'label']},
  );
const customizer = (resource: string, collection: string, parent?: Reference) =>
  descriptor(
    resource,
    collection,
    [...(parent ? [parent.field] : []), 'customizerAttribute', 'value'],
    [...(parent ? [parent.field] : []), 'customizerAttribute', 'value'],
    [],
    [...(parent ? [snake(parent.field)] : []), 'customizer_attribute', 'value.type', 'value.string_value', 'status'],
    {
      parts: (parent?.parts ?? 0) + 1,
      references: [...(parent ? [parent] : []), attribute],
      identity: [...(parent ? [parent.field] : []), 'customizerAttribute'],
      serving: true,
    },
  );

// Each route has its own resource identity, fields, immutable bindings and effects.
// Discovery validates wire fields/enums; the checked GAQL reference fixture validates reads.
// A mapped mutation outside this table does not gain execution permission.
export const googleConfigurationContracts: Record<string, Contract> = {
  customAudiences: descriptor(
    'custom_audience',
    'customAudiences',
    ['name', 'description', 'type', 'members'],
    ['name', 'type', 'members'],
    ['name', 'description', 'members'],
    segmentFields,
    {serving: true},
  ),
  // Customer-scoped Performance Max / Demand Gen audience signals; the service exposes create and update only.
  audiences: descriptor(
    'audience',
    'audiences',
    ['name', 'description', 'dimensions', 'exclusionDimension', 'scope', 'assetGroup'],
    ['name', 'dimensions'],
    ['name', 'description', 'dimensions', 'exclusionDimension'],
    ['name', 'description', 'dimensions', 'exclusion_dimension', 'scope', 'status'],
    {serving: true},
  ),
  customInterests: descriptor(
    'custom_interest',
    'customInterests',
    ['name', 'description', 'type', 'members', 'status'],
    ['name', 'type', 'members'],
    ['name', 'description', 'members', 'status'],
    segmentFields,
    {serving: true},
  ),
  keywordPlans: descriptor(
    'keyword_plan',
    'keywordPlans',
    ['name', 'forecastPeriod'],
    ['name'],
    ['name', 'forecastPeriod'],
    keywordPlanResources.keywordPlans!.fields,
  ),
  keywordPlanCampaigns: descriptor(
    'keyword_plan_campaign',
    'keywordPlanCampaigns',
    ['name', 'keywordPlan', 'cpcBidMicros', 'keywordPlanNetwork', 'geoTargets', 'languageConstants'],
    ['name', 'keywordPlan', 'cpcBidMicros', 'keywordPlanNetwork'],
    ['name', 'keywordPlan', 'cpcBidMicros', 'keywordPlanNetwork', 'geoTargets', 'languageConstants'],
    keywordPlanResources.keywordPlanCampaigns!.fields,
    {references: [planningReference('keywordPlanCampaigns')]},
  ),
  keywordPlanAdGroups: descriptor(
    'keyword_plan_ad_group',
    'keywordPlanAdGroups',
    ['name', 'keywordPlanCampaign', 'cpcBidMicros'],
    ['name', 'keywordPlanCampaign'],
    ['name', 'keywordPlanCampaign', 'cpcBidMicros'],
    keywordPlanResources.keywordPlanAdGroups!.fields,
    {references: [planningReference('keywordPlanAdGroups')]},
  ),
  keywordPlanAdGroupKeywords: descriptor(
    'keyword_plan_ad_group_keyword',
    'keywordPlanAdGroupKeywords',
    ['keywordPlanAdGroup', 'text', 'matchType', 'negative', 'cpcBidMicros'],
    ['keywordPlanAdGroup', 'text', 'matchType'],
    ['keywordPlanAdGroup', 'text', 'matchType', 'cpcBidMicros'],
    keywordPlanResources.keywordPlanAdGroupKeywords!.fields,
    {references: [planningReference('keywordPlanAdGroupKeywords')]},
  ),
  keywordPlanCampaignKeywords: descriptor(
    'keyword_plan_campaign_keyword',
    'keywordPlanCampaignKeywords',
    ['keywordPlanCampaign', 'text', 'matchType', 'negative'],
    ['keywordPlanCampaign', 'text', 'matchType', 'negative'],
    ['keywordPlanCampaign', 'text', 'matchType'],
    keywordPlanResources.keywordPlanCampaignKeywords!.fields,
    {references: [planningReference('keywordPlanCampaignKeywords')]},
  ),
  assetSets: descriptor(
    'asset_set',
    'assetSets',
    ['name', 'type', 'merchantCenterFeed', 'locationGroupParentAssetSetId', 'businessProfileLocationGroup'],
    ['name', 'type'],
    [
      'name',
      'merchantCenterFeed',
      'merchantCenterFeed.merchantId',
      'merchantCenterFeed.feedLabel',
      'businessProfileLocationGroup',
      'businessProfileLocationGroup.dynamicBusinessProfileLocationGroupFilter',
      'businessProfileLocationGroup.dynamicBusinessProfileLocationGroupFilter.businessNameFilter',
      'businessProfileLocationGroup.dynamicBusinessProfileLocationGroupFilter.labelFilters',
      'businessProfileLocationGroup.dynamicBusinessProfileLocationGroupFilter.listingIdFilters',
    ],
    googleAssetSetFields,
    {serving: true},
  ),
  assetSetAssets: descriptor(
    'asset_set_asset',
    'assetSetAssets',
    ['assetSet', 'asset'],
    ['assetSet', 'asset'],
    [],
    ['asset_set', 'asset', 'status'],
    {parts: 2, references: [assetSet, feedAsset], identity: ['assetSet', 'asset'], serving: true},
  ),
  campaignAssetSets: descriptor(
    'campaign_asset_set',
    'campaignAssetSets',
    ['campaign', 'assetSet'],
    ['campaign', 'assetSet'],
    [],
    ['campaign', 'asset_set', 'status'],
    {parts: 2, references: [campaign, assetSet], identity: ['campaign', 'assetSet'], serving: true},
  ),
  adGroupAssetSets: descriptor(
    'ad_group_asset_set',
    'adGroupAssetSets',
    ['adGroup', 'assetSet'],
    ['adGroup', 'assetSet'],
    [],
    ['ad_group', 'asset_set', 'status'],
    {parts: 2, references: [group, assetSet], identity: ['adGroup', 'assetSet'], serving: true},
  ),
  customerAssetSets: descriptor(
    'customer_asset_set',
    'customerAssetSets',
    ['customer', 'assetSet'],
    ['assetSet'],
    [],
    ['asset_set', 'status'],
    {references: [assetSet], identity: ['assetSet'], serving: true},
  ),
  labels: descriptor(
    'label',
    'labels',
    ['name', 'textLabel'],
    ['name'],
    ['name', 'textLabel', 'textLabel.backgroundColor', 'textLabel.description'],
    ['name', 'status', 'text_label.background_color', 'text_label.description'],
  ),
  campaignLabels: association('campaign_label', 'campaignLabels', campaign),
  adGroupLabels: association('ad_group_label', 'adGroupLabels', group),
  adGroupAdLabels: association(
    'ad_group_ad_label',
    'adGroupAdLabels',
    reference('adGroupAd', 'adGroupAds', 'ad_group_ad', ['status', 'ad.id', 'ad.final_urls'], 2),
  ),
  adGroupCriterionLabels: association('ad_group_criterion_label', 'adGroupCriterionLabels', criterion),
  customizerAttributes: descriptor(
    'customizer_attribute',
    'customizerAttributes',
    ['name', 'type'],
    ['name', 'type'],
    [],
    ['name', 'type', 'status'],
    {serving: true},
  ),
  campaignCustomizers: customizer('campaign_customizer', 'campaignCustomizers', campaign),
  adGroupCustomizers: customizer('ad_group_customizer', 'adGroupCustomizers', group),
  AdGroupCriterionCustomizers: customizer('ad_group_criterion_customizer', 'adGroupCriterionCustomizers', criterion),
  CustomerCustomizers: customizer('customer_customizer', 'customerCustomizers'),
  adParameters: descriptor(
    'ad_parameter',
    'adParameters',
    ['adGroupCriterion', 'parameterIndex', 'insertionText'],
    ['adGroupCriterion', 'parameterIndex', 'insertionText'],
    ['insertionText'],
    ['ad_group_criterion', 'parameter_index', 'insertion_text'],
    {parts: 3, references: [criterion], identity: ['adGroupCriterion', 'parameterIndex'], serving: true},
  ),
  campaignGroups: descriptor(
    'campaign_group',
    'campaignGroups',
    ['name', 'status'],
    ['name'],
    ['name'],
    ['name', 'status'],
  ),
  conversionCustomVariables: descriptor(
    'conversion_custom_variable',
    'conversionCustomVariables',
    ['name', 'tag', 'status'],
    ['name', 'tag', 'status'],
    ['name', 'status'],
    ['name', 'tag', 'status', 'owner_customer'],
  ),
  remarketingActions: descriptor('remarketing_action', 'remarketingActions', ['name'], ['name'], ['name'], ['name']),
  // Rule-based remarketing lists only (src/google-user-lists.ts); closing a targeted list affects serving.
  // Conversion value rules and rule sets (src/google-value-rules.ts); a set applies its rules in list order.
  conversionValueRules: descriptor(
    'conversion_value_rule',
    'conversionValueRules',
    ['action', 'audienceCondition', 'deviceCondition', 'geoLocationCondition', 'status'],
    ['action'],
    ['action', 'audienceCondition', 'deviceCondition', 'geoLocationCondition', 'status'],
    [
      'action.operation',
      'action.value',
      'geo_location_condition.geo_target_constants',
      'geo_location_condition.geo_match_type',
      'geo_location_condition.excluded_geo_target_constants',
      'geo_location_condition.excluded_geo_match_type',
      'device_condition.device_types',
      'audience_condition.user_lists',
      'audience_condition.user_interests',
      'status',
    ],
    {serving: true},
  ),
  conversionValueRuleSets: descriptor(
    'conversion_value_rule_set',
    'conversionValueRuleSets',
    ['conversionValueRules', 'dimensions', 'attachmentType', 'campaign'],
    ['conversionValueRules', 'dimensions', 'attachmentType'],
    ['conversionValueRules', 'dimensions'],
    ['conversion_value_rules', 'dimensions', 'attachment_type', 'campaign', 'status'],
    {serving: true, references: [campaign]},
  ),
  userLists: descriptor(
    'user_list',
    'userLists',
    ['name', 'description', 'membershipStatus', 'ruleBasedUserList'],
    ['name', 'membershipStatus', 'ruleBasedUserList'],
    ['name', 'description', 'membershipStatus'],
    [
      'name',
      'description',
      'membership_status',
      'type',
      'read_only',
      'rule_based_user_list.prepopulation_status',
      'rule_based_user_list.flexible_rule_user_list.inclusive_rule_operator',
      'rule_based_user_list.flexible_rule_user_list.inclusive_operands',
      'rule_based_user_list.flexible_rule_user_list.exclusive_operands',
    ],
    {serving: true},
  ),
  assetGroupSignals: descriptor(
    'asset_group_signal',
    'assetGroupSignals',
    ['assetGroup', 'audience', 'searchTheme'],
    ['assetGroup'],
    [],
    ['asset_group', 'audience.audience', 'search_theme.text'],
    {
      parts: 2,
      references: [
        reference('assetGroup', 'assetGroups', 'asset_group', ['name', 'status', 'campaign']),
        reference('audience.audience', 'audiences', 'audience', ['name', 'status', 'scope']),
      ],
      serving: true,
    },
  ),
  customerNegativeCriteria: descriptor(
    'customer_negative_criterion',
    'customerNegativeCriteria',
    [
      'ipBlock',
      'placementList',
      'mobileAppCategory',
      'negativeKeywordList',
      'placement',
      'youtubeChannel',
      'contentLabel',
      'youtubeVideo',
      'mobileApplication',
    ],
    [],
    [],
    [
      'type',
      'ip_block.ip_address',
      'placement_list.shared_set',
      'mobile_app_category.mobile_app_category_constant',
      'negative_keyword_list.shared_set',
      'placement.url',
      'youtube_channel.channel_id',
      'content_label.type',
      'youtube_video.video_id',
      'mobile_application.app_id',
      'mobile_application.name',
    ],
    {
      references: [
        reference('placementList.sharedSet', 'sharedSets', 'shared_set', ['name', 'status', 'type']),
        reference('negativeKeywordList.sharedSet', 'sharedSets', 'shared_set', ['name', 'status', 'type']),
      ],
      serving: true,
    },
  ),
};

function snake(s: string) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const get = (v: JsonObject, field: string): any => field.split('.').reduce((r, k) => r?.[k], v);
const invalid = (message: string): never => {
  throw new MirrorError('INVALID_CONFIGURATION_MUTATION', message);
};
const failure = (message: string): never => {
  throw new MirrorError('STATE_TARGET_MISMATCH', message);
};
function account(p: CompiledRequest) {
  const id = p.accountId?.replaceAll('-', '');
  if (!id || !/^\d+$/.test(id)) invalid('Use a selected Google customer.');
  return id;
}
export function googleConfigurationKind(p: CompiledRequest): string | undefined {
  const kind = p.path.match(/^\/v\d+\/customers\/\d+\/([^/]+):mutate$/)?.[1];
  // Some historical UPDATE aliases target services whose fields are immutable.
  // Do not advertise a route-family match as support for that impossible update.
  if (kind && p.action.startsWith('UPDATE_') && googleConfigurationContracts[kind]?.mutable.length === 0) return;
  return p.gateway === 'google_ads_native_action' &&
    p.method === 'POST' &&
    (!p.origin || p.origin === 'https://googleads.googleapis.com') &&
    kind &&
    Object.hasOwn(googleConfigurationContracts, kind)
    ? kind
    : undefined;
}
function resource(value: unknown, p: CompiledRequest, collection: string, parts = 1): string {
  if (
    typeof value !== 'string' ||
    !new RegExp(
      '^customers/' + account(p) + '/' + collection + '/[1-9][0-9]*(?:~[1-9][0-9]*){' + (parts - 1) + '}$',
    ).test(value)
  )
    invalid('Use an existing ' + collection + ' resource with its exact composite identity in the selected customer.');
  return value as string;
}
function identity(p: CompiledRequest, c: Contract, op: JsonObject): string | undefined {
  if (op.remove !== undefined || op.update)
    return resource(op.remove ?? op.update.resourceName, p, c.collection, c.parts);
  if (!c.identity) return;
  const parts = c.identity.map(field =>
    field === 'parameterIndex' ? String(op.create[field]) : get(op.create, field).split('/').at(-1),
  );
  return resource('customers/' + account(p) + '/' + c.collection + '/' + parts.join('~'), p, c.collection, c.parts);
}
function keys(value: JsonObject, allowed: string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) invalid('Unqualified or immutable configuration field: ' + key);
}
function text(value: unknown, field: string, max: number, empty = false) {
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    (typeof value === 'string' && ([...value].length > max || /[\u0000\r\n]/.test(value)))
  )
    invalid(field + ' requires ' + (empty ? 'at most ' : '1–') + max + ' characters without line breaks.');
}
const leaves = (v: JsonObject, prefix = ''): string[] =>
  Object.entries(v).flatMap(([k, x]) =>
    object(x) && Object.keys(x).length ? leaves(x, prefix + k + '.') : [prefix + k],
  );
function validateRecord(kind: string, c: Contract, r: JsonObject, creating: boolean) {
  assertKeywordPlanRecord(kind, r, creating);
  assertGoogleSegmentRecord(kind, r, creating);
  assertGoogleUserListRecord(kind, r, creating);
  if (r.name !== undefined) {
    text(
      r.name,
      'name',
      kind === 'assetSets'
        ? 128
        : kind === 'labels'
          ? 80
          : kind === 'customizerAttributes'
            ? 40
            : kind === 'conversionCustomVariables'
              ? 100
              : 255,
    );
    if (kind === 'conversionCustomVariables' && r.name !== r.name.trim())
      invalid('Conversion variable names cannot have surrounding spaces.');
  }
  if (kind === 'assetSets') assertAssetSetRecord(r, creating);
  if (r.textLabel !== undefined) {
    if (!object(r.textLabel)) invalid('textLabel must be an object.');
    keys(r.textLabel, ['backgroundColor', 'description']);
    if (
      r.textLabel.backgroundColor !== undefined &&
      !/^#(?:[a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/.test(r.textLabel.backgroundColor)
    )
      invalid('Use a 3- or 6-digit label HEX color.');
    if (r.textLabel.description !== undefined) text(r.textLabel.description, 'textLabel.description', 200, true);
  }
  if (kind === 'customizerAttributes' && !['TEXT', 'NUMBER', 'PRICE', 'PERCENT'].includes(r.type))
    invalid('Choose a declared customizer attribute type.');
  if (r.value !== undefined) {
    if (!object(r.value)) invalid('value must be a CustomizerValue object.');
    keys(r.value, ['type', 'stringValue']);
    if (
      !['TEXT', 'NUMBER', 'PRICE', 'PERCENT'].includes(r.value.type) ||
      typeof r.value.stringValue !== 'string' ||
      !r.value.stringValue.trim()
    )
      invalid('A customizer value requires type and nonempty stringValue; the provider enforces native formatting.');
  }
  if (kind === 'adParameters') {
    if (creating && !['1', '2'].includes(String(r.parameterIndex))) invalid('parameterIndex must be 1 or 2.');
    if (
      r.insertionText !== undefined &&
      (typeof r.insertionText !== 'string' ||
        !r.insertionText.trim() ||
        /[\u0000\r\n]/.test(r.insertionText) ||
        !/[0-9]/.test(r.insertionText))
    )
      invalid(
        'insertionText must contain a numeric value without line breaks; Google validates its currency, separator and numeric formatting.',
      );
  }
  if (kind === 'campaignGroups' && r.status !== undefined && r.status !== 'ENABLED')
    invalid('Campaign groups use ENABLED on creation; deletion is a remove operation.');
  if (kind === 'conversionCustomVariables') {
    if (r.tag !== undefined && (typeof r.tag !== 'string' || !/^[a-z0-9_]{1,100}$/.test(r.tag)))
      invalid('Conversion tags use at most 100 lowercase letters, digits or underscores.');
    if (r.status !== undefined && !['ENABLED', 'PAUSED'].includes(r.status))
      invalid('Use ENABLED or PAUSED for a conversion custom variable.');
  }
  if (kind === 'assetGroupSignals' && creating) {
    if (['audience', 'searchTheme'].filter(k => r[k] !== undefined).length !== 1)
      invalid('Choose exactly one audience or searchTheme signal.');
    if (r.searchTheme !== undefined) {
      if (!object(r.searchTheme)) invalid('searchTheme must be an object.');
      keys(r.searchTheme, ['text']);
      text(r.searchTheme.text, 'searchTheme.text', 80);
    }
  }
  if (kind === 'customerNegativeCriteria' && creating) {
    const kinds = c.create.filter(k => r[k] !== undefined);
    if (kinds.length !== 1) invalid('Choose exactly one customer exclusion criterion.');
    const type = kinds[0]!,
      fields: Record<string, string[]> = {
        ipBlock: ['ipAddress'],
        placementList: ['sharedSet'],
        mobileAppCategory: ['mobileAppCategoryConstant'],
        negativeKeywordList: ['sharedSet'],
        placement: ['url'],
        youtubeChannel: ['channelId'],
        contentLabel: ['type'],
        youtubeVideo: ['videoId'],
        mobileApplication: ['appId', 'name'],
      },
      value = r[type];
    if (!object(value)) invalid('A customer exclusion requires its native criterion object.');
    keys(value, fields[type]!);
    for (const field of fields[type]!)
      if (field !== 'name' || Object.hasOwn(value, field)) text(value[field], type + '.' + field, 1024);
    if (
      type === 'mobileAppCategory' &&
      !/^mobileAppCategoryConstants\/[1-9][0-9]*$/.test(value.mobileAppCategoryConstant)
    )
      invalid('Use a documented mobileAppCategoryConstants resource.');
  }
}
export function assertGoogleConfiguration(p: CompiledRequest): void {
  const kind = googleConfigurationKind(p);
  if (!kind) return;
  const c = googleConfigurationContracts[kind]!,
    b = googleJson(p.body),
    seen = new Set<string>();
  if (Object.keys(b).some(k => !['operations', 'partialFailure', 'validateOnly', 'responseContentType'].includes(k)))
    invalid('Unqualified Google mutation envelope field.');
  if (b.responseContentType !== undefined && b.responseContentType !== 'RESOURCE_NAME_ONLY')
    invalid('Use RESOURCE_NAME_ONLY receipts; verification reads the exact resource separately.');
  for (const op of b.operations) {
    assertGoogleSegmentOperation(kind, op);
    assertGoogleUserListOperation(kind, op);
    assertGoogleValueRuleOperation(kind, op);
    if (
      kind === 'conversionValueRuleSets' &&
      op.update?.dimensions !== undefined &&
      op.update?.conversionValueRules === undefined
    )
      invalid('Restate conversionValueRules with new dimensions so every rule is checked against them.');
    keys(op, ['create', 'update', 'remove', 'updateMask']);
    const r = op.create ?? op.update;
    if (r !== undefined && !object(r)) invalid('Configuration records must be native objects.');
    if (op.create) {
      keys(r, c.create);
      for (const field of c.required)
        if (get(r, field) === undefined || get(r, field) === null)
          invalid('Missing required configuration field: ' + field);
      if (op.updateMask !== undefined) invalid('Only updates accept updateMask.');
    } else if (op.update) {
      if (typeof op.updateMask !== 'string' || !op.updateMask) invalid('Updates require an explicit updateMask.');
      const mask = op.updateMask.split(',');
      if (
        mask.some((f: string) => !c.mutable.includes(f)) ||
        new Set(mask).size !== mask.length ||
        mask.some((f: string) => mask.some((g: string) => g !== f && f.startsWith(g + '.')))
      )
        invalid('The update mask must contain distinct qualified mutable fields.');
      keys(r, ['resourceName', ...mask.map((f: string) => f.split('.')[0])]);
      const values = leaves(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'resourceName')));
      if (
        mask.some(
          (f: string) => get(r, f) === undefined || (get(r, f) === null && !keywordPlanClear(kind, f, get(r, f))),
        ) ||
        values.some(f => !mask.some((m: string) => f === m || f.startsWith(m + '.')))
      )
        invalid('Every changed value must be covered by the mask, and every mask field must have an explicit value.');
    } else if (op.updateMask !== undefined) invalid('A remove does not accept updateMask.');
    if (r) {
      validateRecord(kind, c, r, !!op.create);
      if (kind === 'audiences') assertGoogleAudienceRecord(r, !!op.create, account(p)!);
      assertGoogleValueRuleRecord(kind, r, !!op.create, account(p)!);
      for (const ref of c.references) {
        const value = get(r, ref.field);
        if (value !== undefined) resource(value, p, ref.collection, ref.parts);
      }
    }
    if (kind === 'customerAssetSets' && r?.customer !== undefined && r.customer !== 'customers/' + account(p))
      invalid('The customer link must use the selected customer.');
    const name = identity(p, c, op);
    if (name) {
      if (seen.has(name)) invalid('Each configuration target may occur only once per review.');
      seen.add(name);
    }
    if (kind === 'adParameters' && name && !/[~][12]$/.test(name))
      invalid('Ad parameter resource names must end with parameter index 1 or 2.');
  }
}
function search(
  p: CompiledRequest,
  resource: string,
  fields: string[],
  names: string[],
  optional = false,
  removed = false,
): CompiledRequest {
  const ids = [...new Set(names)].sort();
  const query =
    'SELECT ' +
    [...new Set(['resource_name', ...fields])].map(f => resource + '.' + f).join(', ') +
    ' FROM ' +
    resource +
    ' WHERE ' +
    resource +
    '.resource_name IN (' +
    ids.map(id => "'" + id + "'").join(', ') +
    ')';
  return readOf(
    p,
    {
      action: 'AMCP_CONFIG_READ',
      method: 'POST',
      path: googleAdsCustomers + account(p) + '/googleAds:search',
      query: {},
      body: {query},
    },
    {googleState: {resource, names: ids, allowMissing: optional, removedAsAbsent: removed}},
  );
}
function references(p: CompiledRequest, c: Contract, op: JsonObject): {ref: Reference; name: string}[] {
  const r = op.create ?? op.update ?? {},
    name = identity(p, c, op),
    pieces = name?.split('/').at(-1)?.split('~');
  let offset = 0;
  return c.references.flatMap(ref => {
    let value = get(r, ref.field);
    if (value === undefined && pieces && c.identity?.includes(ref.field)) {
      value =
        'customers/' + account(p) + '/' + ref.collection + '/' + pieces.slice(offset, offset + ref.parts).join('~');
      offset += ref.parts;
    }
    return value !== undefined ? [{ref, name: resource(value, p, ref.collection, ref.parts)}] : [];
  });
}
export function googleConfigurationSnapshots(p: CompiledRequest): CompiledRequest[] {
  const c = googleConfigurationContracts[googleConfigurationKind(p)!]!,
    ops = googleJson(p.body).operations as JsonObject[],
    reads: CompiledRequest[] = [];
  for (const creating of [false, true]) {
    const ids = ops
      .filter(o => !!o.create === creating)
      .map(o => identity(p, c, o))
      .filter((n): n is string => !!n);
    if (ids.length) reads.push(search(p, c.resource, c.fields, ids, creating));
  }
  if (ops.some(o => o.create && !c.identity))
    reads.push(
      readOf(p, {
        action: 'AMCP_STATE_READ',
        method: 'POST',
        path: googleAdsCustomers + account(p) + '/googleAds:search',
        query: {},
        body: {query: 'SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'},
        clears: [],
      }),
    );
  const groups = new Map<Reference, string[]>();
  for (const op of ops)
    for (const {ref, name} of references(p, c, op)) {
      const list = groups.get(ref) ?? [];
      list.push(name);
      groups.set(ref, list);
    }
  for (const [ref, names] of groups) reads.push(search(p, ref.resource, ref.fields, names));
  const rules = valueRuleSetRuleNames(googleConfigurationKind(p)!, ops);
  if (rules.length)
    reads.push(search(p, 'conversion_value_rule', googleConfigurationContracts.conversionValueRules!.fields, rules));
  reads.push(...assetSetExtraSnapshots(p), ...keywordPlanSnapshots(p));
  return reads;
}
export function validateGoogleConfigurationState(p: CompiledRequest, states: unknown[], preparing = false): void {
  const kind = googleConfigurationKind(p);
  if (!kind) return;
  const c = googleConfigurationContracts[kind]!,
    ops = googleJson(p.body).operations as JsonObject[];
  validateAssetSetPrerequisites(p, states);
  validateKeywordPlanPrerequisites(p, states);
  const rows = states
    .flatMap(s => (s as JsonObject)?.results ?? [])
    .flatMap(row => Object.values(googleJson(row))) as JsonObject[];
  validateValueRuleSetPrerequisites(kind, ops, rows, op => {
    const n = identity(p, c, op);
    return n ? rows.find(r => r.resourceName === n) : undefined;
  });
  for (const op of ops) {
    const name = identity(p, c, op),
      found = name ? rows.find(r => r.resourceName === name) : undefined;
    if (found) {
      if (c.fields.includes('status') && !['ENABLED', 'PAUSED', 'ACTIVATION_NEEDED', 'REMOVED'].includes(found.status))
        failure('The provider omitted or returned an unknown configuration status.');
      if (c.fields.includes('name') && (typeof found.name !== 'string' || !found.name))
        failure('The provider omitted the configuration name.');
      if (googleSegmentResource(c.resource)) {
        if (
          !(
            kind === 'customInterests'
              ? ['CUSTOM_AFFINITY', 'CUSTOM_INTENT']
              : ['AUTO', 'SEARCH', 'INTEREST', 'PURCHASE_INTENT']
          ).includes(found.type)
        )
          failure('The provider omitted or returned an unknown segment type.');
        googleSegmentCanonical(c.resource, found, true);
      }
      if (preparing && op.create && found.status !== 'REMOVED')
        throw new MirrorError(
          'CONFIGURATION_EXISTS',
          'This exact association already exists. Inspect it instead of creating a duplicate.',
          {resource_name: name},
        );
      if (!op.create && found.status === 'REMOVED')
        throw new MirrorError('STATE_NOT_FOUND', 'The configuration target was already removed.');
      if (kind === 'userLists' && !op.create) validateGoogleUserListState(found);
    }
    const refs = references(p, c, op);
    for (const {ref, name: target} of refs) {
      const value = rows.find(r => r.resourceName === target);
      if (!value) failure('A referenced resource is missing.');
      if (ref.fields.includes('status') && !['ENABLED', 'PAUSED'].includes(value!.status))
        failure('A referenced resource must be enabled or paused.');
      if (found && c.identity?.includes(ref.field) && get(found, ref.field) !== target)
        failure('The returned association identity does not match its exact referenced resource.');
      if (
        ref === criterion &&
        ['adParameters', 'AdGroupCriterionCustomizers'].includes(kind) &&
        (value!.type !== 'KEYWORD' || value!.negative === true)
      )
        invalid('Ad parameters and keyword customizers require a positive keyword criterion.');
      if (ref === attribute && op.create && op.create.value.type !== value!.type)
        invalid('Customizer value type must match the exact referenced attribute.');
      if (
        (ref.field === 'placementList.sharedSet' && value!.type !== 'NEGATIVE_PLACEMENTS') ||
        (ref.field === 'negativeKeywordList.sharedSet' && value!.type !== 'NEGATIVE_KEYWORDS')
      )
        invalid('The shared list must match the requested exclusion type.');
    }
  }
}
export function googleConfigurationOutcome(p: CompiledRequest, r: TransportResult): boolean {
  const c = googleConfigurationContracts[googleConfigurationKind(p)!]!,
    ops = googleJson(p.body).operations as JsonObject[],
    results = (r.data as JsonObject)?.results;
  if (r.status !== 200 || !Array.isArray(results) || results.length !== ops.length) return false;
  const seen = new Set<string>();
  return results.every((row: JsonObject, i: number) => {
    try {
      const name = resource(row.resourceName, p, c.collection, c.parts),
        expected = identity(p, c, ops[i]!);
      if (seen.has(name) || (expected && name !== expected)) return false;
      if (
        c.collection === 'assetGroupSignals' &&
        ops[i]!.create &&
        name.split('/').at(-1)!.split('~')[0] !== ops[i]!.create.assetGroup.split('/').at(-1)
      )
        return false;
      seen.add(name);
      return true;
    } catch {
      return false;
    }
  });
}
export function googleConfigurationVerification(
  p: CompiledRequest,
  result: JsonObject,
): {read: CompiledRequest; expected: JsonObject; id: string}[] {
  const c = googleConfigurationContracts[googleConfigurationKind(p)!]!,
    ops = googleJson(p.body).operations as JsonObject[];
  return ops.map((op, i) => {
    const id = resource(result.data.results[i].resourceName, p, c.collection, c.parts),
      removed = !!op.remove || (c.resource === 'custom_interest' && op.update?.status === 'REMOVED'),
      expected: JsonObject = removed ? {status: 'REMOVED'} : {...(op.create ?? op.update), resourceName: id};
    if (c.collection === 'labels' && op.update?.textLabel && op.updateMask.split(',').includes('textLabel'))
      expected.textLabel = {backgroundColor: '', description: '', ...op.update.textLabel};
    if (c.collection === 'customerAssetSets') delete expected.customer; // GAQL cannot select customer; the scoped resource name binds it.
    const read = search(p, c.resource, c.fields, [id], removed, removed),
      normalized =
        c.resource === 'asset_set' && op.update ? assetSetCanonical(expected) : assetSetObserved(c.resource, expected);
    if (googleSegmentResource(c.resource)) return {id, expected: googleSegmentCanonical(c.resource, expected), read};
    if (c.resource === 'audience') return {id, expected: googleAudienceCanonical(expected), read};
    if (c.resource === 'user_list') return {id, expected: googleUserListCanonical(expected), read};
    if (c.resource === 'conversion_value_rule')
      return {id, expected: googleValueRuleCanonical(c.resource, expected), read};
    if (c.resource === 'asset_set' && op.update) {
      const fields = op.updateMask.split(',').filter((f: string) => object(get(op.update, f)));
      if (fields.length) {
        const defaults = assetSetObserved(c.resource, expected);
        for (const field of fields) {
          const path = field.split('.');
          let node = normalized;
          for (const key of path.slice(0, -1)) node = node[key] ??= {};
          node[path.at(-1)!] = get(defaults, field);
        }
        read.googleState!.exactFields = fields;
        normalized.amcpExactFieldHashes = assetSetExactFields(normalized, fields);
      }
    }
    if (c.resource.startsWith('keyword_plan')) {
      const planning = keywordPlanCanonical(expected),
        fields = Object.keys(expected).filter(k => ['forecastPeriod', 'geoTargets', 'languageConstants'].includes(k));
      if (fields.length) {
        read.googleState!.exactFields = fields;
        planning.amcpExactFieldHashes = keywordPlanFieldHashes(planning, fields);
      }
      return {id, expected: planning, read};
    }
    return {id, expected: normalized, read};
  });
}
export function googleConfigurationObserved(read: CompiledRequest, value: JsonObject): JsonObject {
  // ProtoJSON omits default strings after a cleared text-label field. This applies
  // only to documented optional label strings, never unknown fields or identities.
  if (read.action === 'AMCP_CONFIG_READ' && read.googleState?.resource === 'label' && value?.resourceName)
    return {...value, textLabel: {backgroundColor: '', description: '', ...value.textLabel}};
  const resource = read.googleState?.resource ?? '',
    normalized = googleSegmentResource(resource)
      ? googleSegmentCanonical(resource, value, true)
      : resource === 'audience'
        ? googleAudienceCanonical(value)
        : resource === 'user_list'
          ? googleUserListCanonical(value)
          : resource === 'conversion_value_rule'
            ? googleValueRuleCanonical(resource, value)
            : keywordPlanObserved(resource, assetSetObserved(resource, value));
  return read.googleState?.exactFields
    ? {...normalized, amcpExactFieldHashes: assetSetExactFields(normalized, read.googleState.exactFields)}
    : normalized;
}
export function googleConfigurationServing(p: CompiledRequest): boolean {
  const kind = googleConfigurationKind(p);
  return (
    !!kind &&
    googleConfigurationContracts[kind]!.serving &&
    (kind !== 'customizerAttributes' || googleJson(p.body).operations.some((o: JsonObject) => o.remove)) &&
    (!['assetSets', 'customAudiences', 'customInterests', 'audiences'].includes(kind) ||
      googleJson(p.body).operations.some((o: JsonObject) => !o.create)) &&
    (kind !== 'userLists' ||
      googleJson(p.body).operations.some((o: JsonObject) => o.update?.membershipStatus === 'CLOSED')) &&
    (kind !== 'conversionValueRules' || googleJson(p.body).operations.some((o: JsonObject) => !o.create))
  );
}

/** What a configuration write changes (custom segments, keyword plans, user lists, value rules and the rest), as prepare returns it for review. */
export function googleConfigurationImpact(plan: CompiledRequest): JsonObject {
  if (googleSegmentKind(plan)) return {...googleSegmentImpact, may_affect_serving: googleConfigurationServing(plan)};
  if (keywordPlanKind(plan))
    return {
      provider: 'google',
      scope: keywordPlanKind(plan),
      effect:
        'Edits saved Keyword Planner configuration. Planning bids are hypothetical, in native account-currency micros; no serving campaign is created or activated.',
      may_affect_serving: false,
      verification:
        'Exact saved configuration read-back; the whole existing planning hierarchy is frozen, including descendants of deleted parents. Forecast availability and accuracy require separate provider reads. Relative periods use the provider locale; custom forecast dates must be future dates when forecasting.',
      recovery:
        'Inspect the retained result before retrying. A lost or ambiguous response cannot resubmit this review; recover by reading the exact plan and preparing a new correction.',
    };
  if (googleConfigurationKind(plan) === 'userLists') return googleUserListImpact(googleJson(plan.body));
  if (['conversionValueRules', 'conversionValueRuleSets'].includes(googleConfigurationKind(plan) ?? ''))
    return googleValueRuleImpact(googleConfigurationKind(plan)!, googleJson(plan.body));
  return {
    provider: 'google',
    scope: googleConfigurationKind(plan),
    effect: googleConfigurationServing(plan)
      ? 'Changes configuration used by existing ads. Customizer values and ad parameters can change served text; signals, exclusions and feed membership can change eligible traffic. Shared feed edits affect all consumers.'
      : 'Changes organizational, measurement or unattached feed configuration.',
    may_affect_serving: googleConfigurationServing(plan),
    verification:
      'Exact selected-customer configuration read-back; no claim of serving, policy approval, conversion accrual or tracking installation. Feed snapshots cover current native membership and content, not future external inventory or synchronization.',
    recovery:
      'A rejected or lost response never authorizes replay. Inspect the original receipt and exact resources; corrections require a fresh review.',
  };
}

/** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
export const googleConfigurationFamily: ReviewedFamily = defineFamily({
  name: 'google_configuration',
  files: [
    'src/google-configuration-writes.ts',
    [
      'tests/google-configuration-writes.test.ts',
      'tests/google-custom-segments.test.ts',
      'tests/google-audiences.test.mjs',
      'tests/google-user-lists.test.mjs',
      'tests/google-value-rules.test.mjs',
    ],
  ],
  kind: googleConfigurationKind,
  assert: (plan, gateway) => {
    assertNoMethodOverride(plan);
    gateway();
    assertGoogleConfiguration(plan);
  },
  scope: (c, write, plan) => {
    if (googleSegmentKind(plan!)) assertGoogleAdsScope(c);
  },
  authorize: (plan, connection) => {
    if (
      googleSegmentKind(plan) ||
      (plan.gateway === 'google_ads_native_action' &&
        plan.action === 'AMCP_CONFIG_READ' &&
        googleSegmentResource(plan.googleState?.resource ?? ''))
    )
      assertGoogleAdsScope(connection);
    return false;
  },
  snapshots: googleConfigurationSnapshots,
  isRead: (read: CompiledRequest) =>
    read.gateway === 'google_ads_native_action' && !!(read.googleKeywordPlanState || read.googleAssetSetState),
  reader: (read, next) => readKeywordPlanTree(read, page => readAssetSetContents(page, next)),
  validateState: (read: CompiledRequest, result: TransportResult) =>
    read.googleKeywordPlanState ? validateKeywordPlanTree(read, result) : validateAssetSetContents(read, result),
  snapshotState: (read, data, gateway) => gateway(),
  prerequisites: (plan, state) => validateGoogleConfigurationState(plan, state),
  stateChecks: (plan, state, preparing) => {
    if (preparing) validateGoogleConfigurationState(plan, state, true);
  },
  impact: googleConfigurationImpact,
  outcome: googleConfigurationOutcome,
  verification: googleConfigurationVerification,
  spendConfirmation: {
    needed: plan => !!googleConfigurationServing(plan),
    message:
      'Customizer, ad-parameter, segment, signal, exclusion and feed changes can affect existing ads. Review their impact and provide spend_change_confirmed=true.',
  },
  exemptFromSpendTextMatch: plan => !!(keywordPlanKind(plan) || googleSegmentKind(plan)),
  activates: plan => !!googleConfigurationServing(plan),
  exemptFromActivationScan: plan => !!googleSegmentKind(plan),
  destructive: plan => !!googleSegmentRemoval(plan),
});
