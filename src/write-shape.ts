/** Validation stage: the request shapes each reviewed write family accepts, checked before any read. */
import {snapUpdateKind, assertSnapUpdate} from './snapchat-nested-updates.js';
import {snapPixelNameKind, assertSnapPixelName} from './snapchat-pixel-names.js';
import {snapEventKind, assertSnapEvent} from './snapchat-event-details.js';
import {snapTemplateKind, assertSnapTemplate} from './snapchat-dynamic-templates.js';
import {snapProductSetKind, assertSnapProductSet} from './snapchat-product-sets.js';
import {snapConversionKind, assertSnapConversion} from './snapchat-custom-conversions.js';
import {snapSegmentDeleteKind, assertSnapSegmentDelete} from './snapchat-segment-deletions.js';
import {snapDisclaimerKind, assertSnapDisclaimers} from './snapchat-offer-disclaimers.js';
import {snapchatMediaCopyKind, assertSnapchatMediaCopy} from './snapchat-media-copy.js';
import {assertSnapLeadForms, assertSnapLeadCreativeRefs} from './snapchat-lead-forms.js';
import {assertSnapSegments, assertSnapSegmentUpdates} from './snapchat-segments.js';
import {tiktokIdentityKind, assertTiktokIdentity} from './tiktok-identities.js';
import {metaCopyKind, assertMetaCopy} from './meta-copies.js';
import {tiktokLookalikeKind, assertTiktokLookalike} from './tiktok-lookalikes.js';
import {metaLookalikeKind, assertMetaLookalike} from './meta-lookalikes.js';
import {tiktokBudgetKind, assertTiktokBudget} from './tiktok-budgets.js';
import {tiktokCustomConversionKind, assertTiktokCustomConversion} from './tiktok-custom-conversions.js';
import {tiktokAdgroupConversion} from './tiktok-adgroup-conversions.js';
import {tiktokSavedAudienceKind, assertTiktokSavedAudience} from './tiktok-saved-audiences.js';
import {tiktokSmartPlusStatusKind, assertTiktokSmartPlusStatus} from './tiktok-smart-plus-status.js';
import {tiktokSmartPlusBudgetKind, assertTiktokSmartPlusBudget} from './tiktok-smart-plus-budgets.js';
import {tiktokSmartPlusCampaignKind, assertTiktokSmartPlusCampaign} from './tiktok-smart-plus-campaigns.js';
import {tiktokSmartPlusAdgroupKind, assertTiktokSmartPlusAdgroup} from './tiktok-smart-plus-adgroups.js';
import {
  tiktokSmartPlusCampaignUpdateKind,
  assertTiktokSmartPlusCampaignUpdate,
} from './tiktok-smart-plus-campaign-updates.js';
import {tiktokCtaPortfolioKind, assertTiktokCtaPortfolio, tiktokCtaReferences} from './tiktok-cta-portfolios.js';
import {tiktokSmartPlusAdKind, assertTiktokSmartPlusAd} from './tiktok-smart-plus-ads.js';
import {tiktokSmartPlusAdUpdateKind, assertTiktokSmartPlusAdUpdate} from './tiktok-smart-plus-ad-updates.js';
import {
  tiktokSmartPlusAdgroupUpdateKind,
  assertTiktokSmartPlusAdgroupUpdate,
} from './tiktok-smart-plus-adgroup-updates.js';
import {
  tiktokSmartPlusMaterialStatusKind,
  assertTiktokSmartPlusMaterialStatus,
} from './tiktok-smart-plus-material-status.js';
import {linkedinLeadFormKind, assertLinkedInLeadForm} from './linkedin-lead-forms.js';
import {googlePreviewKind, assertGooglePreview} from './google-preview-writes.js';
import {criteoCampaignKind, assertCriteoCampaign} from './criteo-campaign-writes.js';
import {metaReportKind, assertMetaReport} from './meta-insights-jobs.js';
import {xReportKind, assertXReport} from './x-report-jobs.js';
import {tiktokReportKind, assertTiktokReport} from './tiktok-report-jobs.js';
import {criteoReportKind, assertCriteoReport} from './criteo-report-jobs.js';
import {placeActionKind, assertPlaceAction} from './google-place-action-links.js';
import {businessNotificationKind, assertBusinessNotification} from './google-business-notifications.js';
import {businessAccessKind, assertBusinessAccess} from './google-business-access.js';
import {googleDismissalKind, assertGoogleDismissal} from './google-recommendation-dismissal.js';
import {googleAccessKind, assertGoogleAccess} from './google-user-access.js';
import {reviewedWriteFamily} from './reviewed-routes.js';
import {xDraftKind, assertXDraft} from './x-draft-writes.js';
import {linkedinRuleKind, assertLinkedInRule} from './linkedin-conversion-rules.js';
import {assertGoogleBid} from './google-bid-modifiers.js';
import {linkedinConversionKind, assertLinkedInConversion} from './linkedin-conversion-links.js';
import {metaLabelKind, assertMetaLabel} from './meta-label-writes.js';
import {criteoTargetingKind, assertCriteoTargeting} from './criteo-targeting-writes.js';
import {assertProviderActionAvailable} from './retired-provider-actions.js';
import {gtmWorkspaceKind, assertGtmWorkspace} from './gtm-workspace-writes.js';
import {gtmWorkflowKind, assertGtmWorkflow} from './gtm-workflow-writes.js';
import {dv360ListKind, assertDV360ListWrite} from './dv360-list-writes.js';
import {dv360TargetingKind, assertDV360Targeting} from './dv360-line-item-targeting.js';
import {googleListingGroupKind, assertGoogleListingGroups} from './google-listing-groups.js';
import {tiktokNegativeKeywordKind, assertTiktokNegativeKeywords} from './tiktok-negative-keywords.js';
import {tiktokBrandSafetyKind, assertTiktokBrandSafety} from './tiktok-brand-safety.js';
import {metaValueRuleKind, assertMetaValueRule} from './meta-value-rules.js';
import {metaBrandSafetyKind, assertMetaBrandSafety} from './meta-brand-safety.js';
import {criteoCatalogKind, assertCriteoCatalog} from './criteo-catalog-requests.js';
import {criteoOverrideKind, assertCriteoOverride} from './criteo-budget-overrides.js';
import {criteoLineItemKind, assertCriteoLineItem} from './criteo-auction-line-items.js';
import {criteoPromotedProductsKind, assertCriteoPromotedProducts} from './criteo-promoted-products.js';
import {
  criteoKeywordKind,
  criteoBidMultiplierKind,
  assertCriteoKeywords,
  assertCriteoBidMultipliers,
} from './criteo-line-item-bidding.js';
import {dv360AdAssetKind, assertDV360AdAsset} from './dv360-ad-assets.js';
import {dv360SdfKind, assertDV360Sdf} from './dv360-sdf-downloads.js';
import {dv360AdKind, assertDV360Ad} from './dv360-demand-gen-ads.js';
import {assertGoogleConfiguration} from './google-configuration-writes.js';
import {validateMetaCampaign} from './meta-contracts.js';
import {validateGoogleRequest} from './google-contracts.js';
import {assertGoogleConversionGoal} from './google-conversion-goals.js';
import {assertGoogleBiddingEvent} from './google-bidding-events.js';
import {assertGooglePortfolio} from './google-portfolio-strategies.js';
import {assertGoogleConversionAction} from './google-conversion-actions.js';
import {linkedinDSC, assertLinkedInDSC} from './linkedin-posts.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {assertXCreative} from './x-creative-writes.js';
import {validateMetaCreative} from './creative-validation.js';
import {assertGoogleTargeting} from './google-targeting-writes.js';
import {assertGoogleAssetLinks} from './google-asset-links.js';
import {assertXTargeting} from './x-targeting-writes.js';
import {xTargetingBatchRoute, assertXTargetingBatch} from './x-targeting-batch.js';
import {linkedinTemplateKind, assertLinkedInTemplate} from './linkedin-audience-templates.js';
import {assertRedditWrite} from './reddit-writes.js';
import {microsoftGateway, assertMicrosoftWrite} from './microsoft-native.js';
import {measurementWriteGateways, assertMeasurementWrite} from './measurement-writes.js';
import {familyOf} from './reviewed-families.js';
import {object, fail} from './write-common.js';

export const writeContractGateways = new Set([
  'meta_native_action',
  'tiktok_native_action',
  'snapchat_native_action',
  'google_ads_native_action',
  'google_business_native_action',
  'linkedin_native_action',
  'x_ads_native_action',
  'dv360_native_action',
  'reddit_native_action',
  'criteo_native_action',
  microsoftGateway,
  ...measurementWriteGateways,
]);
export function assertWriteShape(plan: CompiledRequest) {
  assertProviderActionAvailable(plan);
  validateGoogleRequest(plan);
  validateMetaCampaign(plan);
  if (!writeContractGateways.has(plan.gateway))
    fail('WRITE_CONTRACT_UNAVAILABLE', 'This platform has no reviewed mutation contract.');
  if (plan.readOnly) fail('MUTATION_REQUIRED', 'Use the original native gateway to perform this read.');
  if (linkedinTemplateKind(plan)) {
    assertLinkedInTemplate(plan);
    return;
  }
  if (xTargetingBatchRoute(plan)) {
    assertXTargetingBatch(plan);
    return;
  }
  if (googlePreviewKind(plan)) {
    assertGooglePreview(plan);
    return;
  }
  if (plan.gateway === 'reddit_native_action') {
    assertRedditWrite(plan);
    return;
  }
  if (plan.gateway === microsoftGateway) {
    assertMicrosoftWrite(plan);
    return;
  }
  if (plan.specialTransport)
    fail(
      'WRITE_CONTRACT_UNAVAILABLE',
      'For Google Drive media imports, use amcp_media prepare and execute. Other binary transports need a dedicated upload contract.',
    );
  if (placeActionKind(plan)) {
    assertPlaceAction(plan);
    return;
  }
  if (businessNotificationKind(plan)) {
    assertBusinessNotification(plan);
    return;
  }
  if (businessAccessKind(plan)) {
    assertBusinessAccess(plan);
    return;
  }
  if (googleDismissalKind(plan)) {
    assertGoogleDismissal(plan);
    return;
  }
  if (googleAccessKind(plan)) {
    assertGoogleAccess(plan);
    return;
  }
  if (linkedinRuleKind(plan)) {
    assertLinkedInRule(plan);
    return;
  }
  if (linkedinLeadFormKind(plan)) {
    assertLinkedInLeadForm(plan);
    return;
  }
  if (linkedinConversionKind(plan)) {
    assertLinkedInConversion(plan);
    return;
  }
  const family = familyOf(plan);
  if (family?.assert) {
    family.assert(plan);
    return;
  }
  if (xDraftKind(plan)) {
    assertXDraft(plan);
    return;
  }
  if (dv360TargetingKind(plan)) {
    assertDV360Targeting(plan);
    return;
  }
  if (googleListingGroupKind(plan)) {
    assertGoogleListingGroups(plan);
    return;
  }
  if (tiktokNegativeKeywordKind(plan)) {
    assertTiktokNegativeKeywords(plan);
    return;
  }
  if (tiktokBrandSafetyKind(plan)) {
    assertTiktokBrandSafety(plan);
    return;
  }
  if (metaValueRuleKind(plan)) {
    assertMetaValueRule(plan);
    return;
  }
  if (metaBrandSafetyKind(plan)) {
    assertMetaBrandSafety(plan);
    return;
  }
  if (criteoLineItemKind(plan)) {
    assertCriteoLineItem(plan);
    return;
  }
  if (criteoOverrideKind(plan)) {
    assertCriteoOverride(plan);
    return;
  }
  if (criteoCatalogKind(plan)) {
    assertCriteoCatalog(plan);
    return;
  }
  if (criteoPromotedProductsKind(plan)) {
    assertCriteoPromotedProducts(plan);
    return;
  }
  if (criteoKeywordKind(plan) || criteoBidMultiplierKind(plan)) {
    assertCriteoKeywords(plan);
    assertCriteoBidMultipliers(plan);
    return;
  }
  if (dv360AdAssetKind(plan)) {
    assertDV360AdAsset(plan);
    return;
  }
  if (dv360AdKind(plan)) {
    assertDV360Ad(plan);
    return;
  }
  if (dv360SdfKind(plan)) {
    assertDV360Sdf(plan);
    return;
  }
  if (
    plan.headers['X-HTTP-Method-Override'] ||
    (plan.headers['X-RestLi-Method'] &&
      !['CREATE', 'PARTIAL_UPDATE', 'DELETE'].includes(plan.headers['X-RestLi-Method'].toUpperCase()))
  )
    fail('WRITE_CONTRACT_UNAVAILABLE', 'This REST.li method override is not qualified for reviewed execution.');
  if (gtmWorkflowKind(plan)) {
    assertGtmWorkflow(plan);
    return;
  }
  if (gtmWorkspaceKind(plan)) {
    assertGtmWorkspace(plan);
    return;
  }
  if (linkedinDSC(plan)) {
    if (Object.keys(plan.query).length)
      fail('WRITE_CONTRACT_UNAVAILABLE', 'DSC creation does not accept query actions or method overrides.');
    assertLinkedInDSC(plan);
    return;
  }
  const body = object(plan.body);
  const route = plan.path,
    method = plan.method;
  if (measurementWriteGateways.has(plan.gateway)) assertMeasurementWrite(plan);
  const supported = reviewedWriteFamily(plan);
  if (!supported)
    fail(
      'WRITE_CONTRACT_UNAVAILABLE',
      'This route is outside the reviewed campaign-management execution contracts. Use a local dry run.',
    );
  if (dv360ListKind(plan)) assertDV360ListWrite(plan);
  if (criteoTargetingKind(plan)) assertCriteoTargeting(plan);
  if (metaReportKind(plan)) assertMetaReport(plan);
  if (criteoCampaignKind(plan)) assertCriteoCampaign(plan);
  if (snapUpdateKind(plan)) {
    assertSnapUpdate(plan);
    return;
  }
  if (snapchatMediaCopyKind(plan)) {
    assertSnapchatMediaCopy(plan);
    return;
  }
  if (snapDisclaimerKind(plan)) {
    assertSnapDisclaimers(plan);
    return;
  }
  if (snapSegmentDeleteKind(plan)) {
    assertSnapSegmentDelete(plan);
    return;
  }
  if (snapConversionKind(plan)) {
    assertSnapConversion(plan);
    return;
  }
  if (snapProductSetKind(plan)) {
    assertSnapProductSet(plan);
    return;
  }
  if (snapTemplateKind(plan)) {
    assertSnapTemplate(plan);
    return;
  }
  if (snapEventKind(plan)) {
    assertSnapEvent(plan);
    return;
  }
  if (snapPixelNameKind(plan)) {
    assertSnapPixelName(plan);
    return;
  }
  if (xReportKind(plan)) {
    assertXReport(plan);
    return;
  }
  if (tiktokReportKind(plan)) assertTiktokReport(plan);
  if (criteoReportKind(plan)) assertCriteoReport(plan);
  if (metaLabelKind(plan)) assertMetaLabel(plan);
  if (plan.gateway === 'meta_native_action' && route.endsWith('/adcreatives')) validateMetaCreative(body);
  if (
    Object.keys(plan.query).some(
      k =>
        !(
          (plan.gateway === 'dv360_native_action' && k === 'updateMask') ||
          (plan.gateway === 'gtm_native_action' && k === 'fingerprint')
        ),
    )
  )
    fail('WRITE_CONTRACT_UNAVAILABLE', 'Reviewed writes accept body fields and qualified concurrency parameters only.');
  if (
    plan.gateway === 'linkedin_native_action' &&
    method === 'POST' &&
    /^\/rest\/adAccounts\/[^/]+\/[^/]+\/[^/]+$/.test(route) &&
    (!body.patch || plan.headers['X-RestLi-Method']?.toUpperCase() !== 'PARTIAL_UPDATE')
  )
    fail(
      'WRITE_CONTRACT_UNAVAILABLE',
      'LinkedIn entity POST requires a native patch and restli_method PARTIAL_UPDATE.',
    );
  if (
    ['method', '_method', 'http_method', 'method_override', 'batch', 'adbatch'].some(
      k => plan.query[k] !== undefined || body[k] !== undefined,
    ) ||
    /\/batch\//.test(plan.path)
  )
    fail('WRITE_CONTRACT_UNAVAILABLE', 'Batch and method-tunneled writes require individual reviewed native requests.');
  if (plan.method === 'GET' || plan.method === 'HEAD')
    fail('WRITE_CONTRACT_UNAVAILABLE', 'Side-effecting GET/HEAD actions are not qualified for execution.');
  const expect = (record: JsonObject, key: string, values: string[]) => {
    if (!values.includes(record[key]))
      fail('PAUSED_CREATION_REQUIRED', 'New serving entities require an explicit paused or draft state.', {
        field: key,
        allowed: values,
      });
  };
  if (
    plan.gateway === 'meta_native_action' &&
    /^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads)$/.test(plan.path) &&
    plan.method === 'POST'
  )
    expect(body, 'status', ['PAUSED']);
  if (plan.gateway === 'tiktok_native_action' && /^\/v1\.3\/(?:campaign|adgroup)\/create\/$/.test(plan.path))
    expect(body, 'operation_status', ['DISABLE']);
  if (tiktokIdentityKind(plan)) assertTiktokIdentity(plan, body);
  if (metaCopyKind(plan)) assertMetaCopy(plan, body);
  if (tiktokLookalikeKind(plan)) assertTiktokLookalike(plan, body);
  if (metaLookalikeKind(plan)) assertMetaLookalike(body);
  if (tiktokBudgetKind(plan)) assertTiktokBudget(plan, body);
  if (tiktokCustomConversionKind(plan)) assertTiktokCustomConversion(plan, body);
  if (tiktokSavedAudienceKind(plan)) assertTiktokSavedAudience(plan, body);
  if (tiktokSmartPlusStatusKind(plan)) assertTiktokSmartPlusStatus(plan, body);
  if (tiktokSmartPlusBudgetKind(plan)) assertTiktokSmartPlusBudget(plan, body);
  if (tiktokSmartPlusCampaignKind(plan)) assertTiktokSmartPlusCampaign(plan, body);
  if (tiktokSmartPlusAdgroupKind(plan)) assertTiktokSmartPlusAdgroup(plan, body);
  if (tiktokSmartPlusCampaignUpdateKind(plan)) assertTiktokSmartPlusCampaignUpdate(plan, body);
  if (plan.gateway === 'tiktok_native_action') tiktokAdgroupConversion(plan);
  if (tiktokCtaPortfolioKind(plan)) assertTiktokCtaPortfolio(plan, body);
  if (tiktokSmartPlusAdKind(plan)) assertTiktokSmartPlusAd(plan, body);
  if (tiktokSmartPlusAdUpdateKind(plan)) assertTiktokSmartPlusAdUpdate(plan, body);
  if (tiktokSmartPlusAdgroupUpdateKind(plan)) assertTiktokSmartPlusAdgroupUpdate(plan, body);
  if (tiktokSmartPlusMaterialStatusKind(plan)) assertTiktokSmartPlusMaterialStatus(plan, body);
  if (plan.gateway === 'tiktok_native_action') tiktokCtaReferences(plan);
  if (plan.gateway === 'tiktok_native_action' && plan.path === '/v1.3/ad/create/') {
    if (
      !Array.isArray(body.creatives) ||
      body.creatives.length !== 1 ||
      !body.creatives[0] ||
      Array.isArray(body.creatives[0]) ||
      typeof body.creatives[0] !== 'object'
    )
      fail(
        'WRITE_CONTRACT_UNAVAILABLE',
        'Reviewed TikTok ad creation requires exactly one native creatives record per review. Put the ad fields and operation_status inside that record.',
      );
    if (Object.hasOwn(body, 'operation_status'))
      fail(
        'INVALID_ARGUMENT',
        'TikTok ad creation uses creatives[0].operation_status; a top-level status does not pause the creative.',
      );
    expect(body.creatives[0], 'operation_status', ['DISABLE']);
  }
  if (plan.gateway === 'snapchat_native_action' && plan.method === 'POST') {
    const kind = plan.path.split('/').at(-1)!;
    if (!Array.isArray(body[kind]) || !body[kind].length || body[kind].length > 25)
      fail('MISSING_PAYLOAD', 'Provide 1–25 native ' + kind + ' records.');
    if (kind === 'lead_generation_forms') assertSnapLeadForms(plan, body[kind]);
    else if (kind === 'segments') assertSnapSegments(plan, body[kind]);
    else if (kind === 'creatives') assertSnapLeadCreativeRefs(body[kind]);
    else for (const row of body[kind]) expect(object(row), 'status', ['PAUSED']);
  }
  if (
    plan.gateway === 'snapchat_native_action' &&
    plan.method === 'PUT' &&
    /^\/v1\/adaccounts\/[^/]+\/segments$/.test(plan.path)
  ) {
    if (!Array.isArray(body.segments) || !body.segments.length || body.segments.length > 25)
      fail('MISSING_PAYLOAD', 'Provide 1–25 native segments records.');
    assertSnapSegmentUpdates(plan, body.segments);
  }
  if (plan.gateway === 'snapchat_native_action' && plan.method === 'PATCH') {
    if (
      !Array.isArray(plan.body) ||
      !plan.body.length ||
      plan.body.length > 25 ||
      plan.body.some(
        op =>
          !op ||
          !['add', 'remove', 'replace', 'test'].includes(op.op) ||
          typeof op.path !== 'string' ||
          !/^\/[a-zA-Z0-9_/-]+$/.test(op.path) ||
          op.path.split('/').some((part: string) => ['__proto__', 'constructor', 'prototype'].includes(part)) ||
          (op.op !== 'remove' && !Object.hasOwn(op, 'value')),
      )
    )
      fail('INVALID_PATCH', 'Use 1–25 native JSON Patch add, remove, replace or test operations.');
  }
  if (
    plan.gateway === 'x_ads_native_action' &&
    /^\/12\/accounts\/[^/]+\/(campaigns|line_items)$/.test(plan.path) &&
    plan.method === 'POST'
  )
    expect(body, 'entity_status', ['PAUSED']);
  assertXCreative(plan);
  assertXTargeting(plan);
  if (
    plan.gateway === 'linkedin_native_action' &&
    /^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups|creatives)$/.test(plan.path) &&
    plan.method === 'POST'
  ) {
    const creative = plan.path.endsWith('/creatives');
    if (creative && Object.hasOwn(body, 'status'))
      fail('INVALID_ARGUMENT', 'LinkedIn creatives use intendedStatus; remove the unsupported status field.');
    expect(body, creative ? 'intendedStatus' : 'status', ['PAUSED', 'DRAFT']);
  }
  if (
    plan.gateway === 'dv360_native_action' &&
    /^\/v\d+\/advertisers\/[^/]+\/(campaigns|insertionOrders|lineItems)$/.test(plan.path) &&
    plan.method === 'POST'
  )
    expect(body, 'entityStatus', ['ENTITY_STATUS_PAUSED', 'ENTITY_STATUS_DRAFT']);
  if (plan.gateway === 'google_ads_native_action') {
    if (!Array.isArray(body.operations) || !body.operations.length || body.operations.length > 25)
      fail('WRITE_CONTRACT_UNAVAILABLE', 'Reviewed Google mutations require 1–25 homogeneous native operations.');
    // A new campaign starts PAUSED. Its ad groups, ads and asset groups may start ENABLED only under a parent the
    // review reads as PAUSED (google-paused-parents.ts, the owner's item 6).
    if (/\/campaigns:mutate$/.test(plan.path))
      for (const op of body.operations) if (op.create) expect(op.create, 'status', ['PAUSED']);
    if (/\/(adGroups|adGroupAds|assetGroups):mutate$/.test(plan.path))
      for (const op of body.operations) if (op.create) expect(op.create, 'status', ['PAUSED', 'ENABLED']);
    if (body.partial_failure === true || body.partialFailure === true)
      fail(
        'WRITE_CONTRACT_UNAVAILABLE',
        'Execute homogeneous Google mutations atomically; partial_failure must be false.',
      );
    if (body.validate_only === true || body.validateOnly === true)
      fail(
        'WRITE_CONTRACT_UNAVAILABLE',
        'This tool executes mutations; use a local dry run for validation-only plans.',
      );
    for (const op of body.operations)
      if (!op || typeof op !== 'object' || ['create', 'update', 'remove'].filter(k => op[k] !== undefined).length !== 1)
        fail('INVALID_MUTATION', 'Each Google operation must contain exactly one create, update or remove.');
    assertGoogleTargeting(plan);
    assertGoogleAssetLinks(plan);
    assertGoogleConfiguration(plan);
    assertGoogleBid(plan);
    assertGoogleBiddingEvent(plan);
    assertGooglePortfolio(plan);
    assertGoogleConversionAction(plan);
    assertGoogleConversionGoal(plan);
  }
}
