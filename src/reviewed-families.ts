import {MirrorError} from './errors.js';
import type {Reader, ReviewedFamily} from './reviewed-family.js';
import type {TransportResult} from './transport.js';
import {appleCampaignFamily} from './measurement-writes.js';
import {appleEntityFamily} from './apple-entity-writes.js';
import {criteoLineItemFamily} from './criteo-auction-line-items.js';
import {criteoSegmentFamily} from './criteo-audience-segments.js';
import {criteoBidMultiplierFamily} from './criteo-line-item-bidding.js';
import {criteoOverrideFamily} from './criteo-budget-overrides.js';
import {criteoCampaignFamily} from './criteo-campaign-writes.js';
import {criteoCatalogFamily} from './criteo-catalog-requests.js';
import {criteoKeywordFamily} from './criteo-line-item-bidding.js';
import {criteoPreferredFamily} from './criteo-preferred-line-items.js';
import {criteoPromotedProductsFamily} from './criteo-promoted-products.js';
import {criteoReportFamily} from './criteo-report-jobs.js';
import {criteoTargetingFamily} from './criteo-targeting-writes.js';
import {dv360AdAssetFamily} from './dv360-ad-assets.js';
import {dv360AdGroupTargetingFamily} from './dv360-line-item-targeting.js';
import {dv360AdvertiserFamily} from './dv360-advertiser-settings.js';
import {dv360AdvertiserTargetingFamily} from './dv360-line-item-targeting.js';
import {dv360AudienceEditFamily} from './dv360-audience-edits.js';
import {dv360BiddingFamily} from './dv360-custom-bidding.js';
import {dv360BiddingFileFamily} from './dv360-custom-bidding-files.js';
import {dv360AdGroupFamily} from './dv360-demand-gen-ad-groups.js';
import {dv360AdFamily} from './dv360-demand-gen-ads.js';
import {dv360InventoryGroupFamily} from './dv360-inventory-source-groups.js';
import {dv360LineItemBulkFamily} from './dv360-line-item-bulk-update.js';
import {dv360LineItemDuplicateFamily} from './dv360-line-item-duplicate.js';
import {dv360LineItemTargetingFamily} from './dv360-line-item-targeting.js';
import {dv360ListFamily} from './dv360-list-writes.js';
import {dv360SdfFamily} from './dv360-sdf-downloads.js';
import {ga4ExportFamily} from './measurement-writes.js';
import {googleAssetLinkFamily} from './google-asset-links.js';
import {googleAtomicFamily} from './google-atomic-builds.js';
import {googleAutoAssetFamily} from './google-auto-assets.js';
import {googleBidFamily} from './google-bid-modifiers.js';
import {googleBiddingEventFamily} from './google-bidding-events.js';
import {businessAccessFamily} from './google-business-access.js';
import {businessAttributeFamily} from './google-business-location-attributes.js';
import {businessLocationEditFamily} from './google-business-location-edits.js';
import {businessLodgingFamily} from './google-business-lodging.js';
import {businessNotificationFamily} from './google-business-notifications.js';
import {googleDraftFamily} from './google-campaign-drafts.js';
import {googleConfigurationFamily} from './google-configuration-writes.js';
import {googleConversionActionFamily} from './google-conversion-actions.js';
import {googleConversionGoalFamily} from './google-conversion-goals.js';
import {googleCustomerSettingsFamily} from './google-customer-settings.js';
import {googleExperimentFamily} from './google-experiments.js';
import {googleLifecycleGoalFamily} from './google-lifecycle-goals.js';
import {googleListingGroupFamily} from './google-listing-groups.js';
import {placeActionFamily} from './google-place-action-links.js';
import {googleBrandGuidelinesFamily} from './google-pmax-brand-guidelines.js';
import {googlePortfolioFamily} from './google-portfolio-strategies.js';
import {googleApplyFamily} from './google-recommendation-apply.js';
import {googleDismissalFamily} from './google-recommendation-dismissal.js';
import {googleCustomerLabelFamily} from './google-customer-labels.js';
import {googleSubscriptionFamily} from './google-recommendation-subscriptions.js';
import {googlePreviewFamily} from './google-preview-writes.js';
import {googleSmartFamily} from './google-smart-campaign-settings.js';
import {googleTargetingFamily} from './google-targeting-writes.js';
import {googleAccessFamily} from './google-user-access.js';
import {googleCustomerTypeFamily} from './google-user-list-customer-types.js';
import {googleUploadFamily} from './google-youtube-uploads.js';
import {gtmEntityFamily} from './measurement-writes.js';
import {gtmWorkflowFamily} from './gtm-workflow-writes.js';
import {gtmWorkspaceFamily} from './gtm-workspace-writes.js';
import {linkedinAbFamily} from './linkedin-ab-tests.js';
import {linkedinAccountSettingsFamily} from './linkedin-account-settings.js';
import {linkedinTemplateFamily} from './linkedin-audience-templates.js';
import {linkedinConversionFamily} from './linkedin-conversion-links.js';
import {linkedinRuleFamily} from './linkedin-conversion-rules.js';
import {linkedinDSCFamily} from './linkedin-posts.js';
import {linkedinDscEditFamily} from './linkedin-dsc-edits.js';
import {linkedinDeleteFamily} from './linkedin-entity-deletes.js';
import {linkedinDomainFamily} from './linkedin-insight-domains.js';
import {linkedinInsightFamily} from './linkedin-insight-tags.js';
import {linkedinLeadFormStateFamily} from './linkedin-lead-form-states.js';
import {linkedinLeadFormFamily} from './linkedin-lead-forms.js';
import {linkedinMessageFamily} from './linkedin-message-ads.js';
import {linkedinPublisherFamily} from './linkedin-publisher-restrictions.js';
import {linkedinThirdPartyFamily} from './linkedin-third-party-tracking.js';
import {linkedinTrackingFamily} from './linkedin-tracking-parameters.js';
import {metaAccountSettingsFamily} from './meta-account-settings.js';
import {metaImageFamily} from './meta-ad-images.js';
import {metaVideoFamily} from './meta-ad-videos.js';
import {metaBudgetScheduleFamily} from './meta-budget-schedules.js';
import {metaProductSetFamily} from './meta-product-sets.js';
import {metaCatalogProductFamily} from './meta-catalog-products.js';
import {metaProductFeedFamily} from './meta-product-feeds.js';
import {metaBrandSafetyFamily} from './meta-brand-safety.js';
import {metaCopyFamily} from './meta-copies.js';
import {metaConversionFamily} from './meta-custom-conversions.js';
import {metaReportFamily} from './meta-insights-jobs.js';
import {metaLabelFamily} from './meta-label-writes.js';
import {metaLookalikeFamily} from './meta-lookalikes.js';
import {metaObjectFamily} from './meta-object-edits.js';
import {metaPixelFamily} from './meta-pixels.js';
import {metaSplitTestFamily} from './meta-split-tests.js';
import {metaValueRuleFamily} from './meta-value-rules.js';
import {microsoftAssociationFamily} from './microsoft-associations.js';
import {microsoftSearchFamily} from './microsoft-native.js';
import {redditWriteFamily} from './reddit-writes.js';
import {redditCreativeFamily} from './reddit-creative-writes.js';
import {searchConsoleSiteFamily} from './measurement-writes.js';
import {snapConversionFamily} from './snapchat-custom-conversions.js';
import {snapTemplateFamily} from './snapchat-dynamic-templates.js';
import {snapEventFamily} from './snapchat-event-details.js';
import {snapchatMediaCopyFamily} from './snapchat-media-copy.js';
import {snapUpdateFamily} from './snapchat-nested-updates.js';
import {snapDisclaimerFamily} from './snapchat-offer-disclaimers.js';
import {snapPixelNameFamily} from './snapchat-pixel-names.js';
import {snapProductSetFamily} from './snapchat-product-sets.js';
import {snapProductFeedFamily} from './snapchat-product-feeds.js';
import {snapCatalogFamily} from './snapchat-catalogs.js';
import {snapSegmentDeleteFamily} from './snapchat-segment-deletions.js';
import {tiktokAudienceEditFamily} from './tiktok-audience-edits.js';
import {tiktokBlockedWordFamily} from './tiktok-blocked-words.js';
import {tiktokBrandSafetyFamily} from './tiktok-brand-safety.js';
import {tiktokBudgetFamily} from './tiktok-budgets.js';
import {tiktokChangeLogFamily} from './tiktok-change-logs.js';
import {tiktokCtaPortfolioFamily} from './tiktok-cta-portfolios.js';
import {tiktokConversionEditFamily} from './tiktok-conversion-edits.js';
import {tiktokCustomConversionFamily} from './tiktok-custom-conversions.js';
import {tiktokDeletionFamily} from './tiktok-deletions.js';
import {tiktokIdentityFamily} from './tiktok-identities.js';
import {tiktokImageEditFamily} from './tiktok-image-edits.js';
import {tiktokLibraryFamily} from './tiktok-library-assets.js';
import {tiktokLookalikeFamily} from './tiktok-lookalikes.js';
import {tiktokNegativeKeywordFamily} from './tiktok-negative-keywords.js';
import {tiktokReportFamily} from './tiktok-report-jobs.js';
import {tiktokRuleAudienceFamily} from './tiktok-rule-audiences.js';
import {tiktokPixelFamily} from './tiktok-pixels.js';
import {tiktokSavedAudienceFamily} from './tiktok-saved-audiences.js';
import {tiktokSmartPlusAdUpdateFamily} from './tiktok-smart-plus-ad-updates.js';
import {tiktokSmartPlusAdgroupUpdateFamily} from './tiktok-smart-plus-adgroup-updates.js';
import {tiktokSmartPlusAdgroupFamily} from './tiktok-smart-plus-adgroups.js';
import {tiktokSmartPlusAdFamily} from './tiktok-smart-plus-ads.js';
import {tiktokSmartPlusBudgetFamily} from './tiktok-smart-plus-budgets.js';
import {tiktokSmartPlusCampaignUpdateFamily} from './tiktok-smart-plus-campaign-updates.js';
import {tiktokSmartPlusCampaignFamily} from './tiktok-smart-plus-campaigns.js';
import {tiktokSmartPlusMaterialStatusFamily} from './tiktok-smart-plus-material-status.js';
import {tiktokSmartPlusStatusFamily} from './tiktok-smart-plus-status.js';
import {xConversationCardFamily} from './x-conversation-cards.js';
import {xCreativeFamily} from './x-creative-writes.js';
import {xCuratedFamily} from './x-curated-categories.js';
import {xAudienceFamily} from './x-custom-audiences.js';
import {xDraftFamily} from './x-draft-writes.js';
import {xEntityBatchFamily} from './x-entity-batches.js';
import {xAssociationFamily} from './x-line-item-associations.js';
import {xMediaFamily} from './x-media-library.js';
import {xPrerollCtaFamily} from './x-preroll-ctas.js';
import {xReportFamily} from './x-report-jobs.js';
import {xScheduledFamily} from './x-scheduled-tweets.js';
import {xTargetingBatchRouteFamily} from './x-targeting-batch.js';
import {xTrackingTagFamily} from './x-tracking-tags.js';
import type {CompiledRequest} from './types.js';

/*
 * The reviewed write families registered with the lifecycle. Each lifecycle stage (write-review, write-verification,
 * write-impact, preflight, review-state, reviewed-routes, scope, spend-policy, execution-risk, action-contracts)
 * consults this list at one point; families not yet registered are still wired into those modules one line each.
 * docs/ADDING-A-REVIEWED-FAMILY.md explains how to add one.
 */
let registered: readonly ReviewedFamily[] | undefined;

/** Every registered family. Built on first use, because family modules import the lifecycle modules that import this one. */
export function reviewedFamilies(): readonly ReviewedFamily[] {
  return (registered ??= Object.freeze([
    appleCampaignFamily, // apple_campaigns
    appleEntityFamily, // apple_entities
    criteoLineItemFamily, // criteo_auction_line_items
    criteoSegmentFamily, // criteo_audience_segments
    criteoBidMultiplierFamily, // criteo_bid_multipliers
    criteoOverrideFamily, // criteo_budget_overrides
    criteoCampaignFamily, // criteo_campaigns
    criteoCatalogFamily, // criteo_catalog_requests
    criteoKeywordFamily, // criteo_keywords
    criteoPreferredFamily, // criteo_preferred_line_items
    criteoPromotedProductsFamily, // criteo_promoted_products
    criteoReportFamily, // criteo_report_jobs
    criteoTargetingFamily, // criteo_targeting
    dv360AdAssetFamily, // dv360_ad_assets
    dv360AdGroupTargetingFamily, // dv360_ad_group_targeting
    dv360AdvertiserFamily, // dv360_advertiser_settings
    dv360AdvertiserTargetingFamily, // dv360_advertiser_targeting
    dv360AudienceEditFamily, // dv360_audience_edits
    dv360BiddingFamily, // dv360_custom_bidding
    dv360BiddingFileFamily, // dv360_custom_bidding_files
    dv360AdGroupFamily, // dv360_demand_gen_ad_groups
    dv360AdFamily, // dv360_demand_gen_ads
    dv360InventoryGroupFamily, // dv360_inventory_source_groups
    dv360LineItemBulkFamily, // dv360_line_item_bulk_update
    dv360LineItemDuplicateFamily, // dv360_line_item_duplicate
    dv360LineItemTargetingFamily, // dv360_line_item_targeting
    dv360ListFamily, // dv360_lists
    dv360SdfFamily, // dv360_sdf_downloads
    ga4ExportFamily, // ga4_export_jobs
    googleAssetLinkFamily, // google_asset_links
    googleAtomicFamily, // google_atomic_builds
    googleAutoAssetFamily, // google_auto_assets
    googleBidFamily, // google_bid_modifiers
    googleBiddingEventFamily, // google_bidding_events
    businessAccessFamily, // google_business_access
    businessAttributeFamily, // google_business_location_attributes
    businessLocationEditFamily, // google_business_location_edits
    businessLodgingFamily, // google_business_lodging
    businessNotificationFamily, // google_business_notifications
    googleDraftFamily, // google_campaign_drafts
    googleConfigurationFamily, // google_configuration
    googleConversionActionFamily, // google_conversion_actions
    googleConversionGoalFamily, // google_conversion_goals
    googleCustomerSettingsFamily, // google_customer_settings
    googleExperimentFamily, // google_experiments
    googleLifecycleGoalFamily, // google_lifecycle_goals
    googleListingGroupFamily, // google_listing_groups
    placeActionFamily, // google_place_actions
    googleBrandGuidelinesFamily, // google_pmax_brand_guidelines
    googlePortfolioFamily, // google_portfolio_strategies
    googleApplyFamily, // google_recommendation_apply
    googleDismissalFamily, // google_recommendation_dismissal
    googleCustomerLabelFamily, // google_customer_labels
    googleSubscriptionFamily, // google_recommendation_subscriptions
    googlePreviewFamily, // google_shareable_previews
    googleSmartFamily, // google_smart_campaign_settings
    googleTargetingFamily, // google_targeting
    googleAccessFamily, // google_user_access
    googleCustomerTypeFamily, // google_user_list_customer_types
    googleUploadFamily, // google_youtube_uploads
    gtmEntityFamily, // gtm_entities
    gtmWorkflowFamily, // gtm_workflows
    gtmWorkspaceFamily, // gtm_workspace
    linkedinAbFamily, // linkedin_ab_tests
    linkedinAccountSettingsFamily, // linkedin_account_settings
    linkedinTemplateFamily, // linkedin_audience_templates
    linkedinConversionFamily, // linkedin_conversion_links
    linkedinRuleFamily, // linkedin_conversion_rules
    linkedinDSCFamily, // linkedin_dsc
    linkedinDscEditFamily, // linkedin_dsc_edits
    linkedinDeleteFamily, // linkedin_entity_deletes
    linkedinDomainFamily, // linkedin_insight_tag_domains
    linkedinInsightFamily, // linkedin_insight_tags
    linkedinLeadFormStateFamily, // linkedin_lead_form_states
    linkedinLeadFormFamily, // linkedin_lead_forms
    linkedinMessageFamily, // linkedin_message_ads
    linkedinPublisherFamily, // linkedin_publisher_restrictions
    linkedinThirdPartyFamily, // linkedin_third_party_tracking
    linkedinTrackingFamily, // linkedin_tracking_parameters
    metaAccountSettingsFamily, // meta_account_settings
    metaImageFamily, // meta_ad_images
    metaVideoFamily, // meta_ad_videos
    metaBudgetScheduleFamily, // meta_budget_schedules
    metaProductSetFamily, // meta_product_sets
    metaCatalogProductFamily, // meta_catalog_products
    metaProductFeedFamily, // meta_product_feeds
    metaBrandSafetyFamily, // meta_brand_safety
    metaCopyFamily, // meta_copies
    metaConversionFamily, // meta_custom_conversions
    metaReportFamily, // meta_insights_jobs
    metaLabelFamily, // meta_labels
    metaLookalikeFamily, // meta_lookalikes
    metaObjectFamily, // meta_object_edits
    metaPixelFamily, // meta_pixels
    metaSplitTestFamily, // meta_split_tests
    metaValueRuleFamily, // meta_value_rules
    microsoftAssociationFamily, // microsoft_asset_links
    microsoftSearchFamily, // microsoft_search
    redditWriteFamily, // reddit_classic
    redditCreativeFamily, // reddit_creatives
    searchConsoleSiteFamily, // search_console_sites
    snapConversionFamily, // snapchat_custom_conversions
    snapTemplateFamily, // snapchat_dynamic_templates
    snapEventFamily, // snapchat_event_details
    snapchatMediaCopyFamily, // snapchat_media_copy
    snapUpdateFamily, // snapchat_nested_updates
    snapDisclaimerFamily, // snapchat_offer_disclaimers
    snapPixelNameFamily, // snapchat_pixel_names
    snapProductSetFamily, // snapchat_product_sets
    snapProductFeedFamily, // snapchat_product_feeds
    snapCatalogFamily, // snapchat_catalogs
    snapSegmentDeleteFamily, // snapchat_segment_deletions
    tiktokAudienceEditFamily, // tiktok_audience_edits
    tiktokBlockedWordFamily, // tiktok_blocked_words
    tiktokBrandSafetyFamily, // tiktok_brand_safety
    tiktokBudgetFamily, // tiktok_budgets
    tiktokChangeLogFamily, // tiktok_change_log_tasks
    tiktokCtaPortfolioFamily, // tiktok_cta_portfolios
    tiktokConversionEditFamily, // tiktok_custom_conversion_edits
    tiktokCustomConversionFamily, // tiktok_custom_conversions
    tiktokDeletionFamily, // tiktok_deletions
    tiktokIdentityFamily, // tiktok_identities
    tiktokImageEditFamily, // tiktok_image_edits
    tiktokLibraryFamily, // tiktok_library_assets
    tiktokLookalikeFamily, // tiktok_lookalikes
    tiktokNegativeKeywordFamily, // tiktok_negative_keywords
    tiktokReportFamily, // tiktok_report_jobs
    tiktokRuleAudienceFamily, // tiktok_rule_audiences
    tiktokPixelFamily, // tiktok_pixels
    tiktokSavedAudienceFamily, // tiktok_saved_audiences
    tiktokSmartPlusAdUpdateFamily, // tiktok_smart_plus_ad_edits
    tiktokSmartPlusAdgroupUpdateFamily, // tiktok_smart_plus_adgroup_edits
    tiktokSmartPlusAdgroupFamily, // tiktok_smart_plus_adgroups
    tiktokSmartPlusAdFamily, // tiktok_smart_plus_ads
    tiktokSmartPlusBudgetFamily, // tiktok_smart_plus_budgets
    tiktokSmartPlusCampaignUpdateFamily, // tiktok_smart_plus_campaign_edits
    tiktokSmartPlusCampaignFamily, // tiktok_smart_plus_campaigns
    tiktokSmartPlusMaterialStatusFamily, // tiktok_smart_plus_material_status
    tiktokSmartPlusStatusFamily, // tiktok_smart_plus_status
    xConversationCardFamily, // x_conversation_cards
    xCreativeFamily, // x_creatives
    xCuratedFamily, // x_curated_categories
    xAudienceFamily, // x_custom_audiences
    xDraftFamily, // x_drafts
    xEntityBatchFamily, // x_entity_batches
    xAssociationFamily, // x_line_item_associations
    xMediaFamily, // x_media_library
    xPrerollCtaFamily, // x_preroll_ctas
    xReportFamily, // x_report_jobs
    xScheduledFamily, // x_scheduled_tweets
    xTargetingBatchRouteFamily, // x_targeting_batch
    xTrackingTagFamily, // x_tracking_tags
  ]));
}

function only(families: ReviewedFamily[], what: string): ReviewedFamily | undefined {
  if (families.length > 1)
    throw new MirrorError(
      'REVIEWED_FAMILY_CONFLICT',
      'Two reviewed write families claim this ' +
        what +
        ' (' +
        families.map(f => f.name).join(', ') +
        '); nothing was sent.',
      {families: families.map(f => f.name)},
      500,
    );
  return families[0];
}

/** The registered family that owns a compiled mutation. Two families claiming one request is a wiring defect and is refused. */
export function familyOf(plan: CompiledRequest, families = reviewedFamilies()): ReviewedFamily | undefined {
  return only(
    families.filter(family => family.kind(plan)),
    'request',
  );
}

/** The registered family that marked a snapshot or verification read. */
export function familyOfRead(read: CompiledRequest, families = reviewedFamilies()): ReviewedFamily | undefined {
  return only(
    families.filter(family => family.isRead?.(read)),
    'read',
  );
}

/** Performs a read through every registered family reader, then `next`; each reader handles only the reads it marked. */
export function readThroughFamilies(read: CompiledRequest, next: Reader): Promise<TransportResult> {
  let reader = next;
  for (const family of reviewedFamilies())
    if (family.reader) {
      const inner = reader,
        own = family.reader;
      reader = r => own(r, inner);
    }
  return reader(read);
}

/** Ledger implementation and test files of a registered family. */
export function reviewedFamilyFiles(name: string): [string, string[]] | undefined {
  const family = reviewedFamilies().find(f => f.name === name);
  return family && [family.files[0], [...family.files[1]]];
}
