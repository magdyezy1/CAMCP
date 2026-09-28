/** Outcome stage: whether the provider's response to the one mutation shows that it took effect. */
import {snapUpdateKind, snapUpdateOutcome} from './snapchat-nested-updates.js';
import {snapPixelNameKind, snapPixelNameOutcome} from './snapchat-pixel-names.js';
import {snapEventKind, snapEventOutcome} from './snapchat-event-details.js';
import {snapTemplateKind, snapTemplateOutcome} from './snapchat-dynamic-templates.js';
import {snapProductSetKind, snapProductSetOutcome} from './snapchat-product-sets.js';
import {snapConversionKind, snapConversionOutcome} from './snapchat-custom-conversions.js';
import {snapSegmentDeleteKind, snapSegmentDeleteOutcome} from './snapchat-segment-deletions.js';
import {snapDisclaimerKind, snapDisclaimerOutcome} from './snapchat-offer-disclaimers.js';
import {snapchatMediaCopyKind, snapchatMediaCopyOutcome} from './snapchat-media-copy.js';
import {metaCopyKind, metaCopyOutcome} from './meta-copies.js';
import {tiktokLookalikeKind} from './tiktok-lookalikes.js';
import {tiktokSavedAudienceKind} from './tiktok-saved-audiences.js';
import {tiktokSmartPlusStatusKind, tiktokSmartPlusStatusOutcome} from './tiktok-smart-plus-status.js';
import {tiktokSmartPlusCampaignKind, tiktokSmartPlusCampaignId} from './tiktok-smart-plus-campaigns.js';
import {tiktokSmartPlusAdgroupKind, tiktokSmartPlusAdgroupId} from './tiktok-smart-plus-adgroups.js';
import {tiktokCtaPortfolioKind, tiktokCtaPortfolioId} from './tiktok-cta-portfolios.js';
import {tiktokSmartPlusAdKind, tiktokSmartPlusAdId} from './tiktok-smart-plus-ads.js';
import {
  tiktokSmartPlusMaterialStatusKind,
  tiktokSmartPlusMaterialStatusOutcome,
} from './tiktok-smart-plus-material-status.js';
import {linkedinLeadFormKind, linkedinLeadFormOutcome} from './linkedin-lead-forms.js';
import {googlePreviewKind, googlePreviewOutcome} from './google-preview-writes.js';
import {criteoCampaignKind, criteoCampaignOutcome} from './criteo-campaign-writes.js';
import {metaReportKind, metaReportOutcome} from './meta-insights-jobs.js';
import {xReportKind, xReportOutcome} from './x-report-jobs.js';
import {tiktokReportKind, tiktokReportOutcome} from './tiktok-report-jobs.js';
import {criteoReportKind, criteoReportOutcome} from './criteo-report-jobs.js';
import {placeActionKind, placeActionOutcome, placeActionSafe} from './google-place-action-links.js';
import {businessNotificationKind, businessNotificationOutcome} from './google-business-notifications.js';
import {businessAccessKind, businessAccessOutcome} from './google-business-access.js';
import {googleDismissalKind, googleDismissalOutcome} from './google-recommendation-dismissal.js';
import {googleAccessKind, googleAccessOutcome} from './google-user-access.js';
import {xDraftKind, xDraftOutcome} from './x-draft-writes.js';
import {linkedinRuleKind, linkedinRuleOutcome} from './linkedin-conversion-rules.js';
import {googleBidKind, googleBidOutcome} from './google-bid-modifiers.js';
import {linkedinConversionKind, linkedinConversionOutcome} from './linkedin-conversion-links.js';
import {metaLabelKind, metaLabelOutcome} from './meta-label-writes.js';
import {criteoTargetingKind, criteoTargetingOutcome} from './criteo-targeting-writes.js';
import {gtmWorkspaceKind, gtmWorkspaceOutcome, gtmWorkspaceReceipt} from './gtm-workspace-writes.js';
import {gtmWorkflowKind, gtmSafeConfiguration, gtmWorkflowOutcome} from './gtm-workflow-writes.js';
import {dv360ListKind, dv360ListOutcome} from './dv360-list-writes.js';
import {dv360TargetingKind, dv360TargetingOutcome} from './dv360-line-item-targeting.js';
import {googleListingGroupKind, googleListingGroupOutcome} from './google-listing-groups.js';
import {tiktokNegativeKeywordKind, tiktokNegativeKeywordOutcome} from './tiktok-negative-keywords.js';
import {tiktokBrandSafetyKind, tiktokBrandSafetyOutcome} from './tiktok-brand-safety.js';
import {metaValueRuleKind, metaValueRuleOutcome} from './meta-value-rules.js';
import {metaBrandSafetyKind, metaBrandSafetyOutcome} from './meta-brand-safety.js';
import {criteoCatalogKind, criteoCatalogOutcome} from './criteo-catalog-requests.js';
import {criteoOverrideKind, criteoOverrideOutcome} from './criteo-budget-overrides.js';
import {criteoLineItemKind, criteoLineItemOutcome} from './criteo-auction-line-items.js';
import {criteoPromotedProductsKind, criteoPromotedProductsOutcome} from './criteo-promoted-products.js';
import {criteoKeywordKind, criteoBidMultiplierKind, criteoLineItemBiddingOutcome} from './criteo-line-item-bidding.js';
import {dv360AdAssetKind, dv360AdAssetOutcome} from './dv360-ad-assets.js';
import {dv360SdfKind, dv360SdfOutcome} from './dv360-sdf-downloads.js';
import {dv360AdKind, dv360AdOutcome} from './dv360-demand-gen-ads.js';
import {googleConfigurationKind, googleConfigurationOutcome} from './google-configuration-writes.js';
import {googleConversionGoalKind, googleConversionGoalOutcome} from './google-conversion-goals.js';
import {googleBiddingEventKind, googleBiddingEventOutcome} from './google-bidding-events.js';
import {googlePortfolioKind, googlePortfolioOutcome} from './google-portfolio-strategies.js';
import {googleConversionActionKind, googleConversionActionOutcome} from './google-conversion-actions.js';
import {linkedinDSC, linkedinPostId} from './linkedin-posts.js';
import {type TransportResult} from './transport.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {xCreativeKind, xCreativeOutcome} from './x-creative-writes.js';
import {googleAssetLinkKind, googleAssetLinkOutcome} from './google-asset-links.js';
import {xTargetingBatchRoute, xTargetingBatchOutcome} from './x-targeting-batch.js';
import {linkedinTemplateKind, linkedinTemplateOutcome} from './linkedin-audience-templates.js';
import {redditOutcome} from './reddit-writes.js';
import {microsoftGateway, microsoftOutcome} from './microsoft-native.js';
import {measurementWriteGateways, measurementOutcome} from './measurement-writes.js';
import {familyOf} from './reviewed-families.js';
import {object} from './write-common.js';

export function writeOutcome(result: TransportResult, plan?: CompiledRequest, before: unknown[] = []): JsonObject {
  const errors: JsonObject[] = [];
  const walk = (value: unknown, path = '$') => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, path + '[' + i + ']'));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value)) {
      // Microsoft batch errors can align with request items using null success
      // slots. This exception is exact and provider-specific; false/objects fail.
      if (
        plan?.gateway === microsoftGateway &&
        path === '$' &&
        key === 'PartialErrors' &&
        Array.isArray(v) &&
        v.every(item => item === null)
      )
        continue;
      const nonempty =
        v !== null &&
        v !== false &&
        v !== '' &&
        v !== 0 &&
        (!Array.isArray(v) || v.length > 0) &&
        (!v || typeof v !== 'object' || Object.keys(v).length > 0);
      if (
        (nonempty && /error|fail/i.test(key)) ||
        (/^(?:is_)?success$/.test(key) && v === false) ||
        (/status$/i.test(key) &&
          ((typeof v === 'string' && /ERROR|FAIL|PARTIAL/i.test(v)) || (typeof v === 'number' && v >= 400)))
      )
        errors.push({path: path + '.' + key, value: v});
      else walk(v, path + '.' + key);
    }
  };
  walk(result.data);
  if (
    !plan &&
    result.status !== 204 &&
    result.status !== 205 &&
    !result.headers['x-restli-id'] &&
    (result.data === null || typeof result.data !== 'object' || !Object.keys(result.data).length)
  )
    errors.push({path: '$', value: 'Provider returned no verifiable mutation result.'});
  if (plan && !confirmedMutationResult(plan, result, before))
    errors.push({
      path: '$',
      value: 'The response does not confirm every mutation under this provider response contract.',
    });
  const outcome = {
    success: errors.length === 0,
    executed: true,
    outcome: errors.length ? 'partial_or_failed' : 'succeeded',
    data: plan?.gateway === 'gtm_native_action' ? gtmSafeConfiguration(result.data) : result.data,
    status: result.status,
    headers: result.headers,
    ...(result.headers['x-restli-id'] ? {created_id: result.headers['x-restli-id']} : {}),
    ...(errors.length
      ? {failures: plan?.gateway === 'gtm_native_action' ? gtmSafeConfiguration(errors) : errors, retry_safe: false}
      : {}),
    ...(plan && gtmWorkspaceKind(plan) ? gtmWorkspaceReceipt(plan, result) : {}),
  };
  return plan && (placeActionKind(plan) || businessNotificationKind(plan) || businessAccessKind(plan))
    ? placeActionSafe(outcome)
    : outcome;
}
function confirmedMutationResult(plan: CompiledRequest, result: TransportResult, before: unknown[]): boolean {
  if (linkedinTemplateKind(plan)) return linkedinTemplateOutcome(plan, result, before);
  if (xTargetingBatchRoute(plan)) return xTargetingBatchOutcome(plan, result, before);
  if (googlePreviewKind(plan)) return googlePreviewOutcome(plan, result);
  if (xDraftKind(plan)) return xDraftOutcome(plan, result, before);
  if (placeActionKind(plan)) return placeActionOutcome(plan, result, before);
  if (businessNotificationKind(plan)) return businessNotificationOutcome(plan, result, before);
  if (businessAccessKind(plan)) return businessAccessOutcome(plan, result, before);
  if (googleDismissalKind(plan)) return googleDismissalOutcome(plan, result);
  if (googleAccessKind(plan)) return googleAccessOutcome(plan, result, before);
  if (linkedinRuleKind(plan)) return linkedinRuleOutcome(plan, result);
  if (linkedinConversionKind(plan)) return linkedinConversionOutcome(plan, result);
  // Registered families (reviewed-families.ts) are consulted here; the lines around this one belong to families not yet registered.
  const family = familyOf(plan);
  if (family?.outcome) return family.outcome(plan, result, before);
  if (googleBidKind(plan)) return googleBidOutcome(plan, result);
  if (googleBiddingEventKind(plan)) return googleBiddingEventOutcome(plan, result, before);
  if (googlePortfolioKind(plan)) return googlePortfolioOutcome(plan, result, before);
  if (googleConversionActionKind(plan)) return googleConversionActionOutcome(plan, result, before);
  if (googleConversionGoalKind(plan)) return googleConversionGoalOutcome(plan, result, before);
  if (metaReportKind(plan)) return metaReportOutcome(plan, result);
  if (criteoCampaignKind(plan)) return criteoCampaignOutcome(plan, result);
  if (snapUpdateKind(plan)) return snapUpdateOutcome(plan, result);
  if (snapchatMediaCopyKind(plan)) return snapchatMediaCopyOutcome(plan, result);
  if (snapDisclaimerKind(plan)) return snapDisclaimerOutcome(plan, result);
  if (snapSegmentDeleteKind(plan)) return snapSegmentDeleteOutcome(plan, result);
  if (snapConversionKind(plan)) return snapConversionOutcome(plan, result);
  if (snapProductSetKind(plan)) return snapProductSetOutcome(plan, result);
  if (snapTemplateKind(plan)) return snapTemplateOutcome(plan, result);
  if (snapEventKind(plan)) return snapEventOutcome(plan, result);
  if (snapPixelNameKind(plan)) return snapPixelNameOutcome(plan, result);
  if (xReportKind(plan)) return xReportOutcome(plan, result);
  if (tiktokReportKind(plan)) return tiktokReportOutcome(plan, result);
  if (criteoReportKind(plan)) return criteoReportOutcome(plan, result);
  if (metaLabelKind(plan)) return metaLabelOutcome(plan, result, before);
  if (criteoTargetingKind(plan)) return criteoTargetingOutcome(plan, result);
  if (gtmWorkspaceKind(plan)) return gtmWorkspaceOutcome(plan, result, before);
  if (gtmWorkflowKind(plan)) return gtmWorkflowOutcome(plan, result);
  if (dv360TargetingKind(plan)) return dv360TargetingOutcome(plan, result);
  if (googleListingGroupKind(plan)) return googleListingGroupOutcome(plan, result);
  if (tiktokNegativeKeywordKind(plan)) return tiktokNegativeKeywordOutcome(plan, result);
  if (tiktokBrandSafetyKind(plan)) return tiktokBrandSafetyOutcome(plan, result);
  if (metaValueRuleKind(plan)) return metaValueRuleOutcome(plan, result);
  if (metaBrandSafetyKind(plan)) return metaBrandSafetyOutcome(plan, result);
  if (criteoLineItemKind(plan)) return criteoLineItemOutcome(plan, result);
  if (criteoOverrideKind(plan)) return criteoOverrideOutcome(plan, result);
  if (criteoCatalogKind(plan)) return criteoCatalogOutcome(plan, result);
  if (criteoPromotedProductsKind(plan)) return criteoPromotedProductsOutcome(plan, result);
  if (criteoKeywordKind(plan) || criteoBidMultiplierKind(plan)) return criteoLineItemBiddingOutcome(plan, result);
  if (dv360AdAssetKind(plan)) return dv360AdAssetOutcome(plan, result);
  if (dv360AdKind(plan)) return dv360AdOutcome(plan, result);
  if (dv360SdfKind(plan)) return dv360SdfOutcome(plan, result);
  if (dv360ListKind(plan)) return dv360ListOutcome(plan, result);
  if (googleConfigurationKind(plan)) return googleConfigurationOutcome(plan, result);
  if (googleAssetLinkKind(plan)) return googleAssetLinkOutcome(plan, result);
  if (linkedinLeadFormKind(plan)) return linkedinLeadFormOutcome(plan, result);
  if (linkedinDSC(plan)) return result.status === 201 && linkedinPostId(result.headers['x-restli-id']);
  if (xCreativeKind(plan)) return xCreativeOutcome(plan, result);
  if (plan.gateway === 'reddit_native_action') return redditOutcome(plan, result);
  if (plan.gateway === microsoftGateway) return microsoftOutcome(plan, result);
  if (measurementWriteGateways.has(plan.gateway)) return measurementOutcome(plan, result);
  const d = object(result.data),
    b = object(plan.body),
    segments = plan.path.split('/'),
    last = segments.at(-1)!,
    hasId = (v: unknown) =>
      (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isSafeInteger(v));
  if (plan.gateway === 'meta_native_action')
    return metaCopyKind(plan)
      ? metaCopyOutcome(plan, d)
      : /^\/v[^/]+\/act_/.test(plan.path)
        ? hasId(d.id)
        : d.success === true;
  if (plan.gateway === 'google_ads_native_action')
    return (
      Array.isArray(d.results) &&
      d.results.length === b.operations.length &&
      d.results.every((r: JsonObject, i: number) => {
        const op = b.operations[i],
          expected = op.remove ?? op.update?.resource_name ?? op.update?.resourceName;
        return (
          typeof r.resourceName === 'string' &&
          (expected
            ? r.resourceName === expected
            : r.resourceName.startsWith('customers/' + plan.accountId + '/' + last.replace(':mutate', '') + '/'))
        );
      })
    );
  if (plan.gateway === 'tiktok_native_action') {
    if (d.code !== 0) return false;
    if (tiktokLookalikeKind(plan)) return hasId(object(d.data).custom_audience_id);
    if (tiktokSavedAudienceKind(plan)) return hasId(object(d.data).saved_audience_id);
    if (tiktokSmartPlusStatusKind(plan)) return tiktokSmartPlusStatusOutcome(plan, d);
    if (tiktokSmartPlusCampaignKind(plan)) return !!tiktokSmartPlusCampaignId(d);
    if (tiktokSmartPlusAdgroupKind(plan)) return !!tiktokSmartPlusAdgroupId(d);
    if (tiktokCtaPortfolioKind(plan)) return !!tiktokCtaPortfolioId(d);
    if (tiktokSmartPlusAdKind(plan)) return !!tiktokSmartPlusAdId(d);
    if (tiktokSmartPlusMaterialStatusKind(plan)) return tiktokSmartPlusMaterialStatusOutcome(plan, d);
    if (!plan.path.endsWith('/create/')) return true;
    const kind = segments[2]!,
      data = object(d.data);
    if (kind === 'ad') {
      const ids = data.ad_ids ?? [data.ad_id];
      return Array.isArray(ids) && ids.length === 1 && typeof ids[0] === 'string' && /^\d+$/.test(ids[0]);
    }
    return (
      hasId(data[kind + '_id']) ||
      (Array.isArray(data[kind + '_ids']) && data[kind + '_ids'].length > 0 && data[kind + '_ids'].every(hasId))
    );
  }
  if (plan.gateway === 'snapchat_native_action') {
    if (String(d.request_status).toUpperCase() !== 'SUCCESS') return false;
    const kind = [...segments]
        .reverse()
        .find(k => ['campaigns', 'adsquads', 'ads', 'creatives', 'lead_generation_forms', 'segments'].includes(k))!,
      rows = d[kind];
    if (plan.method === 'DELETE') return Array.isArray(rows) && rows.length === 0;
    const singular = kind === 'adsquads' ? 'adsquad' : kind.slice(0, -1),
      expected = Array.isArray(b[kind]) ? b[kind].length : 1;
    return (
      Array.isArray(rows) &&
      rows.length === expected &&
      rows.every(
        (r, i) =>
          String(r.sub_request_status).toUpperCase() === 'SUCCESS' &&
          hasId(r[singular]?.id) &&
          (plan.method === 'POST' || String(r[singular].id) === String(plan.method === 'PUT' ? b[kind][i].id : last)),
      )
    );
  }
  if (plan.gateway === 'linkedin_native_action')
    return result.status === 201 ? hasId(result.headers['x-restli-id']) : result.status === 204;
  if (plan.gateway === 'x_ads_native_action')
    return Array.isArray(d.data)
      ? plan.method === 'POST' && d.data.length > 0 && d.data.every(r => hasId(r.id))
      : hasId(d.data?.id) && (plan.method === 'POST' || String(d.data.id) === last);
  if (plan.gateway === 'dv360_native_action') {
    if (plan.method === 'DELETE')
      return (result.status === 200 && result.data !== null && Object.keys(d).length === 0) || result.status === 204;
    const kind = plan.method === 'POST' ? last : segments.at(-2)!,
      key: Record<string, string> = {
        campaigns: 'campaignId',
        insertionOrders: 'insertionOrderId',
        lineItems: 'lineItemId',
        creatives: 'creativeId',
      };
    return hasId(d[key[kind]!]) && (plan.method === 'POST' || String(d[key[kind]!]) === last);
  }
  return false;
}
