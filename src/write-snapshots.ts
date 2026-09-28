/** Snapshot plan stage: the reads that record the state a reviewed write depends on. */
import {snapUpdateKind, snapUpdateSnapshots} from './snapchat-nested-updates.js';
import {snapPixelNameKind, snapPixelNameSnapshots} from './snapchat-pixel-names.js';
import {snapEventKind, snapEventSnapshots} from './snapchat-event-details.js';
import {snapTemplateKind, snapTemplateSnapshots} from './snapchat-dynamic-templates.js';
import {snapProductSetKind, snapProductSetSnapshots} from './snapchat-product-sets.js';
import {snapConversionKind, snapConversionSnapshots} from './snapchat-custom-conversions.js';
import {snapSegmentDeleteKind, snapSegmentDeleteSnapshots} from './snapchat-segment-deletions.js';
import {snapDisclaimerKind, snapDisclaimerSnapshots} from './snapchat-offer-disclaimers.js';
import {snapchatMediaCopyKind, snapchatMediaCopySnapshots} from './snapchat-media-copy.js';
import {snapLeadDependencyPaths} from './snapchat-lead-forms.js';
import {snapSegmentDependencyPaths} from './snapchat-segments.js';
import {tiktokIdentityKind, tiktokIdentityImage, tiktokImageInfoPath} from './tiktok-identities.js';
import {metaCopyKind, metaCopySnapshots} from './meta-copies.js';
import {tiktokLookalikeKind, tiktokLookalikeSeed, tiktokAudienceGetPath} from './tiktok-lookalikes.js';
import {metaLookalikeKind, metaLookalikeSeed, metaSeedFields} from './meta-lookalikes.js';
import {tiktokBudgetKind, tiktokBudgetAdgroupIds} from './tiktok-budgets.js';
import {tiktokCustomConversionKind, tiktokCustomConversionReads} from './tiktok-custom-conversions.js';
import {tiktokAdgroupConversionRead} from './tiktok-adgroup-conversions.js';
import {tiktokSavedAudienceKind, tiktokSavedAudienceAudiences} from './tiktok-saved-audiences.js';
import {tiktokSmartPlusStatusKind, tiktokSmartPlusStatusRead} from './tiktok-smart-plus-status.js';
import {tiktokSmartPlusBudgetKind, tiktokSmartPlusBudgetRead} from './tiktok-smart-plus-budgets.js';
import {tiktokSmartPlusCampaignKind} from './tiktok-smart-plus-campaigns.js';
import {tiktokSmartPlusAdgroupKind, tiktokSmartPlusAdgroupReads} from './tiktok-smart-plus-adgroups.js';
import {
  tiktokSmartPlusCampaignUpdateKind,
  tiktokSmartPlusCampaignUpdateRead,
} from './tiktok-smart-plus-campaign-updates.js';
import {tiktokCtaPortfolioKind, tiktokCtaPortfolioReads} from './tiktok-cta-portfolios.js';
import {tiktokSmartPlusAdKind, tiktokSmartPlusAdReads} from './tiktok-smart-plus-ads.js';
import {tiktokSmartPlusAdUpdateKind, tiktokSmartPlusAdUpdateReads} from './tiktok-smart-plus-ad-updates.js';
import {
  tiktokSmartPlusAdgroupUpdateKind,
  tiktokSmartPlusAdgroupUpdateRead,
} from './tiktok-smart-plus-adgroup-updates.js';
import {
  tiktokSmartPlusMaterialStatusKind,
  tiktokSmartPlusMaterialStatusRead,
} from './tiktok-smart-plus-material-status.js';
import {linkedinLeadFormKind} from './linkedin-lead-forms.js';
import {googlePreviewKind, googlePreviewSnapshots} from './google-preview-writes.js';
import {criteoCampaignKind, criteoCampaignSnapshots} from './criteo-campaign-writes.js';
import {metaReportKind, metaReportSnapshots} from './meta-insights-jobs.js';
import {xReportKind, xReportSnapshots} from './x-report-jobs.js';
import {tiktokReportKind, tiktokReportSnapshots} from './tiktok-report-jobs.js';
import {criteoReportKind, criteoReportSnapshots} from './criteo-report-jobs.js';
import {metaCreativeCreate, metaCreativeIdentityReads} from './meta-creative-state.js';
import {placeActionKind, placeActionSnapshots} from './google-place-action-links.js';
import {businessNotificationKind, businessNotificationSnapshots} from './google-business-notifications.js';
import {businessAccessKind, businessAccessSnapshots} from './google-business-access.js';
import {googleDismissalKind, googleDismissalSnapshots} from './google-recommendation-dismissal.js';
import {googleAccessKind, googleAccessSnapshots} from './google-user-access.js';
import {xDraftKind, xDraftSnapshots} from './x-draft-writes.js';
import {linkedinRuleKind, linkedinRuleSnapshots} from './linkedin-conversion-rules.js';
import {googleBidKind, googleBidSnapshots} from './google-bid-modifiers.js';
import {linkedinConversionKind, linkedinConversionSnapshots} from './linkedin-conversion-links.js';
import {metaLabelKind, metaLabelSnapshots} from './meta-label-writes.js';
import {criteoTargetingKind, criteoTargetingSnapshots} from './criteo-targeting-writes.js';
import {gtmWorkspaceKind, gtmWorkspaceSnapshots} from './gtm-workspace-writes.js';
import {gtmWorkflowKind, gtmWorkflowSnapshots} from './gtm-workflow-writes.js';
import {dv360ListKind, dv360ListSnapshots} from './dv360-list-writes.js';
import {dv360TargetingKind, dv360TargetingSnapshots} from './dv360-line-item-targeting.js';
import {googleListingGroupKind, googleListingGroupSnapshots} from './google-listing-groups.js';
import {tiktokNegativeKeywordKind, tiktokNegativeKeywordReads} from './tiktok-negative-keywords.js';
import {tiktokBrandSafetyKind, tiktokBrandSafetyReads} from './tiktok-brand-safety.js';
import {metaValueRuleKind, metaValueRuleReads} from './meta-value-rules.js';
import {metaBrandSafetyKind, metaBrandSafetyReads} from './meta-brand-safety.js';
import {criteoCatalogKind, criteoCatalogSnapshots} from './criteo-catalog-requests.js';
import {criteoOverrideKind, criteoOverrideSnapshots} from './criteo-budget-overrides.js';
import {criteoLineItemKind, criteoLineItemReads} from './criteo-auction-line-items.js';
import {criteoPromotedProductsKind, criteoPromotedProductsReads} from './criteo-promoted-products.js';
import {criteoKeywordKind, criteoBidMultiplierKind, criteoLineItemBiddingReads} from './criteo-line-item-bidding.js';
import {dv360AdAssetKind, dv360AdAssetReads} from './dv360-ad-assets.js';
import {dv360SdfKind, dv360SdfSnapshots} from './dv360-sdf-downloads.js';
import {dv360AdKind, dv360AdReads} from './dv360-demand-gen-ads.js';
import {googleConfigurationKind, googleConfigurationSnapshots} from './google-configuration-writes.js';
import {googleConversionGoalKind, googleConversionGoalSnapshots} from './google-conversion-goals.js';
import {googleBiddingEventKind, googleBiddingEventSnapshots} from './google-bidding-events.js';
import {googlePortfolioKind, googlePortfolioSnapshots} from './google-portfolio-strategies.js';
import {googleConversionActionKind, googleConversionActionSnapshots} from './google-conversion-actions.js';
import {linkedinDSC, linkedinDSCReads} from './linkedin-posts.js';
import {Registry} from './catalog.js';
import {normalizeAccount} from './scope.js';
import {applyExecutionRisk} from './execution-risk.js';
import type {CompiledRequest, JsonObject} from './types.js';
import {xCreativeKind, xCreativeSnapshots} from './x-creative-writes.js';
import {googleTargetingKind, googleTargetingSnapshots} from './google-targeting-writes.js';
import {googleAssetLinkKind, googleAssetLinkSnapshots} from './google-asset-links.js';
import {xTargetingKind, xTargetingSnapshots} from './x-targeting-writes.js';
import {xTargetingBatchRoute, xTargetingBatchSnapshots} from './x-targeting-batch.js';
import {linkedinTemplateKind, linkedinTemplateSnapshots} from './linkedin-audience-templates.js';
import {redditSnapshots} from './reddit-writes.js';
import {microsoftGateway, microsoftSnapshots} from './microsoft-native.js';
import {measurementWriteGateways, measurementSnapshots} from './measurement-writes.js';
import {familyOf} from './reviewed-families.js';
import {googleAdsCustomers} from './google-version.js';
import {object, fail, snake} from './write-common.js';

/** Reads are explicitly derived from the target, never supplied by the caller as proof. */
export function snapshotPlans(plan: CompiledRequest, registry: Registry): CompiledRequest[] {
  if (snapUpdateKind(plan)) return snapUpdateSnapshots(plan);
  if (snapchatMediaCopyKind(plan)) return snapchatMediaCopySnapshots(plan);
  if (snapDisclaimerKind(plan)) return snapDisclaimerSnapshots(plan);
  if (snapSegmentDeleteKind(plan)) return snapSegmentDeleteSnapshots(plan);
  if (snapConversionKind(plan)) return snapConversionSnapshots(plan);
  if (snapProductSetKind(plan)) return snapProductSetSnapshots(plan);
  const family = familyOf(plan);
  if (family?.snapshots) return family.snapshots(plan);
  if (snapTemplateKind(plan)) return snapTemplateSnapshots(plan);
  if (snapEventKind(plan)) return snapEventSnapshots(plan);
  if (snapPixelNameKind(plan)) return snapPixelNameSnapshots(plan);
  if (googlePreviewKind(plan)) return googlePreviewSnapshots(plan);
  if (placeActionKind(plan)) return placeActionSnapshots(plan);
  if (businessNotificationKind(plan)) return businessNotificationSnapshots(plan);
  if (businessAccessKind(plan)) return businessAccessSnapshots(plan);
  if (googleDismissalKind(plan)) return googleDismissalSnapshots(plan);
  if (googleAccessKind(plan)) return googleAccessSnapshots(plan);
  if (linkedinTemplateKind(plan)) return linkedinTemplateSnapshots(plan);
  if (xTargetingBatchRoute(plan)) return xTargetingBatchSnapshots(plan);
  if (xDraftKind(plan)) return xDraftSnapshots(plan);
  if (linkedinRuleKind(plan)) return linkedinRuleSnapshots(plan);
  if (linkedinConversionKind(plan)) return linkedinConversionSnapshots(plan);
  if (googleBidKind(plan)) return googleBidSnapshots(plan);
  if (googleBiddingEventKind(plan)) return googleBiddingEventSnapshots(plan);
  if (googlePortfolioKind(plan)) return googlePortfolioSnapshots(plan);
  if (googleConversionActionKind(plan)) return googleConversionActionSnapshots(plan);
  if (googleConversionGoalKind(plan)) return googleConversionGoalSnapshots(plan);
  if (metaReportKind(plan)) return metaReportSnapshots(plan);
  if (criteoCampaignKind(plan)) return criteoCampaignSnapshots(plan);
  if (xReportKind(plan)) return xReportSnapshots(plan);
  if (tiktokReportKind(plan)) return tiktokReportSnapshots(plan);
  if (criteoReportKind(plan)) return criteoReportSnapshots(plan);
  if (metaLabelKind(plan)) return metaLabelSnapshots(plan);
  if (criteoTargetingKind(plan)) return criteoTargetingSnapshots(plan);
  if (gtmWorkflowKind(plan)) return gtmWorkflowSnapshots(plan);
  if (gtmWorkspaceKind(plan)) return gtmWorkspaceSnapshots(plan);
  if (dv360TargetingKind(plan)) return dv360TargetingSnapshots(plan);
  if (googleListingGroupKind(plan)) return googleListingGroupSnapshots(plan);
  if (tiktokNegativeKeywordKind(plan)) return tiktokNegativeKeywordReads(plan);
  if (tiktokBrandSafetyKind(plan)) return tiktokBrandSafetyReads(plan);
  if (metaValueRuleKind(plan)) return metaValueRuleReads(plan);
  if (metaBrandSafetyKind(plan)) return metaBrandSafetyReads(plan);
  if (criteoLineItemKind(plan)) return criteoLineItemReads(plan);
  if (criteoOverrideKind(plan)) return criteoOverrideSnapshots(plan);
  if (criteoCatalogKind(plan)) return criteoCatalogSnapshots(plan);
  if (criteoPromotedProductsKind(plan)) return criteoPromotedProductsReads(plan);
  if (criteoKeywordKind(plan) || criteoBidMultiplierKind(plan)) return criteoLineItemBiddingReads(plan);
  if (dv360AdAssetKind(plan)) return dv360AdAssetReads(plan);
  if (dv360AdKind(plan)) return dv360AdReads(plan);
  if (dv360SdfKind(plan)) return dv360SdfSnapshots(plan);
  if (dv360ListKind(plan)) return dv360ListSnapshots(plan);
  if (googleConfigurationKind(plan)) return googleConfigurationSnapshots(plan);
  if (googleAssetLinkKind(plan)) return googleAssetLinkSnapshots(plan);
  if (linkedinDSC(plan)) return linkedinDSCReads(plan);
  if (xCreativeKind(plan)) return xCreativeSnapshots(plan);
  if (googleTargetingKind(plan)) return googleTargetingSnapshots(plan);
  if (xTargetingKind(plan)) return xTargetingSnapshots(plan);
  if (plan.gateway === 'reddit_native_action') return redditSnapshots(plan);
  if (plan.gateway === microsoftGateway) return microsoftSnapshots(plan);
  if (measurementWriteGateways.has(plan.gateway)) return measurementSnapshots(plan);
  const base = (path: string, query: JsonObject = {}, body?: JsonObject, method = 'GET'): CompiledRequest =>
    applyExecutionRisk({
      ...plan,
      action: 'AMCP_STATE_READ',
      method,
      path,
      query,
      body,
      headers:
        plan.gateway === 'linkedin_native_action'
          ? Object.fromEntries(
              Object.entries(plan.headers).filter(([k]) =>
                ['LinkedIn-Version', 'X-Restli-Protocol-Version'].includes(k),
              ),
            )
          : {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      responseControls: undefined,
      specialTransport: undefined,
    });
  const id = normalizeAccount(plan.gateway, plan.accountId!),
    body = object(plan.body);
  if (linkedinLeadFormKind(plan)) return [base('/rest/adAccounts/' + id)];
  if (plan.gateway === 'google_ads_native_action') {
    const kind = plan.path.match(/\/([^/]+):mutate$/)?.[1],
      map: Record<string, string> = {
        assets: 'asset',
        campaigns: 'campaign',
        adGroups: 'ad_group',
        adGroupAds: 'ad_group_ad',
        campaignBudgets: 'campaign_budget',
        ads: 'ad',
        assetGroups: 'asset_group',
        campaignCriteria: 'campaign_criterion',
        adGroupCriteria: 'ad_group_criterion',
      };
    if (!kind || !map[kind])
      fail('WRITE_CONTRACT_UNAVAILABLE', 'This Google mutation has no implemented state-read contract.');
    const resource = map[kind]!,
      snapshots: CompiledRequest[] = [],
      fields = new Set([resource + '.resource_name']),
      names: string[] = [];
    for (const op of body.operations) {
      const record = object(op.update),
        name = op.remove ?? record.resource_name ?? record.resourceName;
      if (name !== undefined) {
        if (typeof name !== 'string' || !new RegExp('^customers/' + id + '/' + kind + '/[0-9~_-]+$').test(name))
          fail('ACCOUNT_SCOPE_MISMATCH', 'Google mutation resource does not match the selected customer/type.');
        names.push(name);
      }
      if (op.update) {
        const mask = op.update_mask ?? op.updateMask;
        if (typeof mask !== 'string' || !mask) fail('MISSING_UPDATE_MASK', 'Updates require an explicit field mask.');
        for (const f of mask.split(',')) {
          if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(f)) fail('INVALID_UPDATE_MASK', 'Invalid field mask.');
          fields.add(resource + '.' + snake(f));
        }
      }
      if (op.remove) {
        const deletionFields: Record<string, string[]> = {
          asset: ['name', 'type'],
          campaign: ['name', 'status', 'campaign_budget', 'advertising_channel_type'],
          ad_group: ['name', 'status', 'campaign', 'cpc_bid_micros'],
          ad_group_ad: ['status', 'ad.id', 'ad.final_urls'],
          campaign_budget: ['name', 'amount_micros', 'delivery_method'],
          ad: ['name', 'final_urls'],
          asset_group: ['name', 'status', 'campaign'],
        };
        for (const f of deletionFields[resource] ?? []) fields.add(resource + '.' + f);
      }
    }
    const search = (query: string) => base(googleAdsCustomers + id + '/googleAds:search', {}, {query}, 'POST');
    if (names.length)
      snapshots.push(
        search(
          'SELECT ' +
            [...fields].join(', ') +
            ' FROM ' +
            resource +
            ' WHERE ' +
            resource +
            '.resource_name IN (' +
            names.map(n => "'" + n + "'").join(', ') +
            ')',
        ),
      );
    if (body.operations.some((op: JsonObject) => op.create))
      snapshots.push(search('SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'));
    const parents: Record<string, {kind: string; fields: string}> = {
      campaign_budget: {
        kind: 'campaignBudgets',
        fields: 'campaign_budget.resource_name, campaign_budget.amount_micros',
      },
      campaign: {kind: 'campaigns', fields: 'campaign.resource_name, campaign.status, campaign.campaign_budget'},
      ad_group: {kind: 'adGroups', fields: 'ad_group.resource_name, ad_group.status, ad_group.campaign'},
    };
    const seen = new Set<string>();
    for (const op of body.operations)
      for (const [field, parent] of Object.entries(parents)) {
        const record = object(op.create ?? op.update),
          name = record[field] ?? record[field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
        if (name === undefined || seen.has(name)) continue;
        if (typeof name !== 'string' || !new RegExp('^customers/' + id + '/' + parent.kind + '/[0-9]+$').test(name))
          fail(
            'INVALID_PARENT_RESOURCE',
            'Parent resources must exist in the selected customer. Create temporary resources in a separate review.',
          );
        seen.add(name);
        snapshots.push(
          search(
            'SELECT ' + parent.fields + ' FROM ' + field + ' WHERE ' + field + ".resource_name IN ('" + name + "')",
          ),
        );
      }
    if (!snapshots.length) fail('WRITE_CONTRACT_UNAVAILABLE', 'Each operation must contain create, update or remove.');
    return snapshots;
  }
  if (plan.gateway === 'tiktok_native_action') {
    if (tiktokCustomConversionKind(plan))
      return tiktokCustomConversionReads(plan).map(r => {
        const read = base(r.path, r.query);
        read.action = r.action;
        return read;
      });
    if (tiktokSmartPlusStatusKind(plan)) {
      const r = tiktokSmartPlusStatusRead(plan),
        read = base(r.path, r.query);
      read.action = r.action;
      return [read];
    }
    if (tiktokSmartPlusBudgetKind(plan)) {
      const r = tiktokSmartPlusBudgetRead(plan),
        read = base(r.path, r.query);
      read.action = r.action;
      return [read];
    }
    if (tiktokSmartPlusCampaignKind(plan)) return [base('/v1.3/advertiser/info/', {advertiser_ids: [id]})];
    if (tiktokCtaPortfolioKind(plan)) return [base('/v1.3/advertiser/info/', {advertiser_ids: [id]})];
    if (tiktokSmartPlusAdKind(plan))
      return tiktokSmartPlusAdReads(plan).map(r => {
        const read = base(r.path, r.query);
        read.action = r.action;
        return read;
      });
    if (tiktokSmartPlusAdUpdateKind(plan))
      return tiktokSmartPlusAdUpdateReads(plan).map(r => {
        const read = base(r.path, r.query);
        read.action = r.action;
        return read;
      });
    if (tiktokSmartPlusAdgroupUpdateKind(plan)) {
      const r = tiktokSmartPlusAdgroupUpdateRead(plan),
        read = base(r.path, r.query);
      read.action = r.action;
      return [read];
    }
    if (tiktokSmartPlusMaterialStatusKind(plan)) {
      const r = tiktokSmartPlusMaterialStatusRead(plan),
        read = base(r.path, r.query);
      read.action = r.action;
      return [read];
    }
    if (tiktokSmartPlusCampaignUpdateKind(plan)) {
      const r = tiktokSmartPlusCampaignUpdateRead(plan),
        read = base(r.path, r.query);
      read.action = r.action;
      return [read];
    }
    if (tiktokSmartPlusAdgroupKind(plan))
      return [
        base('/v1.3/advertiser/info/', {advertiser_ids: [id]}),
        ...tiktokSmartPlusAdgroupReads(plan).map(r => {
          const read = base(r.path, r.query);
          read.action = r.action;
          return read;
        }),
      ];
    if (tiktokSavedAudienceKind(plan)) {
      const reads = [base('/v1.3/advertiser/info/', {advertiser_ids: [id]})],
        audiences = tiktokSavedAudienceAudiences(plan);
      if (audiences.length) {
        const read = base(tiktokAudienceGetPath, {advertiser_id: id, custom_audience_ids: audiences});
        read.action = 'tiktok_dmp_custom_audience_get';
        reads.push(read);
      }
      return reads;
    }
    if (tiktokBudgetKind(plan)) {
      const read = base('/v1.3/adgroup/get/', {
        advertiser_id: id,
        filtering: {adgroup_ids: tiktokBudgetAdgroupIds(plan)},
        page_size: 100,
      });
      read.action = 'tiktok_adgroup_get';
      return [read];
    }
    if (tiktokLookalikeKind(plan)) {
      const seed = base(tiktokAudienceGetPath, {advertiser_id: id, custom_audience_ids: [tiktokLookalikeSeed(plan)]});
      seed.action = 'tiktok_dmp_custom_audience_get';
      return [base('/v1.3/advertiser/info/', {advertiser_ids: [id]}), seed];
    }
    if (tiktokIdentityKind(plan)) {
      const reads = [base('/v1.3/advertiser/info/', {advertiser_ids: [id]})],
        image = tiktokIdentityImage(plan);
      if (image !== undefined) {
        const read = base(tiktokImageInfoPath, {advertiser_id: id, image_ids: [image]});
        read.action = 'tiktok_file_image_ad_info_get';
        reads.push(read);
      }
      return reads;
    }
    const match = /^\/v1\.3\/(campaign|adgroup|ad)\/(?:status\/)?(create|update|delete)\/$/.exec(plan.path);
    if (!match) fail('WRITE_CONTRACT_UNAVAILABLE', 'This TikTok action has no implemented state-read contract.');
    if (match[2] === 'create') {
      const reads = [base('/v1.3/advertiser/info/', {advertiser_ids: [id]})],
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
      ids = body[kind + '_ids'] ?? (body[kind + '_id'] ? [body[kind + '_id']] : undefined);
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 25 ||
      ids.some(v => typeof v !== 'string' || !/^\d+$/.test(v))
    )
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
  if (plan.gateway === 'meta_native_action') {
    if (metaCopyKind(plan)) return metaCopySnapshots(plan).map(r => base(r.path, r.query));
    const create = /^\/v[^/]+\/act_[^/]+\//.test(plan.path) && plan.method === 'POST';
    if (create) {
      const reads = [base(plan.path.match(/^\/v[^/]+\/act_[^/]+/)![0], {fields: 'id,account_status,currency'})];
      const parent = plan.path.endsWith('/adsets')
        ? body.campaign_id
        : plan.path.endsWith('/ads')
          ? body.adset_id
          : undefined;
      if (plan.path.endsWith('/adsets') || plan.path.endsWith('/ads')) {
        if (typeof parent !== 'string' || !/^\d+$/.test(parent))
          fail('MISSING_PARAMETER', 'Child creates require their exact parent ID.');
        reads.push(base(plan.path.split('/').slice(0, 2).join('/') + '/' + parent, {fields: 'id,name,status'}));
      }
      if (metaCreativeCreate(plan)) reads.push(...metaCreativeIdentityReads(plan));
      if (metaLookalikeKind(plan))
        reads.push(
          base(plan.path.split('/').slice(0, 2).join('/') + '/' + metaLookalikeSeed(plan), {fields: metaSeedFields}),
        );
      return reads;
    }
    if (/^\/v[^/]+\/\d+$/.test(plan.path)) {
      const fields = new Set(['id', 'name', 'status']);
      for (const k of Object.keys(body))
        if (/^[a-z_]+$/.test(k) && !['execution_options', 'fields'].includes(k)) fields.add(k);
      return [base(plan.path, {fields: [...fields].join(',')})];
    }
  }
  if (plan.gateway === 'snapchat_native_action' && plan.method === 'PUT') {
    const kind = plan.path.split('/').at(-1)!,
      rows = body[kind];
    if (!Array.isArray(rows) || !rows.length || rows.length > 25)
      fail('MISSING_PAYLOAD', 'Provide 1–25 native update records.');
    if (new Set(rows.map(row => row?.id)).size !== rows.length)
      fail('INVALID_ARGUMENT', 'Each updated Snapchat resource ID must be unique.');
    return rows.map(row => {
      if (typeof row?.id !== 'string' || !/^[-a-zA-Z0-9]+$/.test(row.id))
        fail('MISSING_PARAMETER', 'Each update record requires its exact ID.');
      return base('/v1/' + kind + '/' + row.id);
    });
  }
  if (plan.gateway === 'snapchat_native_action' && plan.method === 'PATCH') {
    const match = /\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives)\/([^/]+)$/.exec(plan.path)!;
    return [base('/v1/' + match[1] + '/' + match[2])];
  }
  const catalog = registry.catalogs.get(plan.gateway);
  const samePath = [
    ...(catalog?.actions ?? []),
    ...registry.data.supplemental.filter(a => a.gateway === plan.gateway),
  ].some(
    a =>
      a.method === 'GET' &&
      a.path &&
      new RegExp(
        '^' +
          a.path
            .split('?')[0]!
            .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
            .replace(/\{[^}]+\}/g, '[^/]+') +
          '$',
      ).test(plan.path),
  );
  const accountPaths: Record<string, RegExp> = {
    snapchat_native_action: /^\/v1\/adaccounts\/[^/]+/,
    x_ads_native_action: /^\/12\/accounts\/[^/]+/,
    linkedin_native_action: /^\/rest\/adAccounts\/[^/]+/,
    dv360_native_action: /^\/v\d+\/advertisers\/[^/]+/,
  };
  const account = accountPaths[plan.gateway]?.exec(plan.path)?.[0];
  if (plan.gateway === 'snapchat_native_action' && plan.method === 'POST' && !account)
    return [base(plan.path.slice(0, plan.path.lastIndexOf('/')))];
  // Account creates also read owned dependencies: a lead form's banner media, a lead creative's form, a lookalike's seed.
  if (
    plan.gateway === 'snapchat_native_action' &&
    plan.method === 'POST' &&
    account &&
    plan.path.slice(account.length).split('/').filter(Boolean).length === 1
  )
    return [
      base(account),
      ...[...snapLeadDependencyPaths(plan), ...snapSegmentDependencyPaths(plan)].map(path => base(path)),
    ];
  // On collection creates, snapshot the account. On edits/deletes, the catalog must expose a matching GET.
  if (plan.method === 'POST' && account && plan.path.slice(account.length).split('/').filter(Boolean).length === 1)
    return [base(account)];
  if (samePath && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(plan.method)) return [base(plan.path)];
  fail(
    'WRITE_CONTRACT_UNAVAILABLE',
    'This operation lacks an implemented target-state read. It remains available as a local dry run.',
  );
}
