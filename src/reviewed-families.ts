import {MirrorError} from './errors.js';
import type {Reader, ReviewedFamily} from './reviewed-family.js';
import type {TransportResult} from './transport.js';
import type {CompiledRequest} from './types.js';
import {criteoSegmentFamily} from './criteo-audience-segments.js';
import {criteoPreferredFamily} from './criteo-preferred-line-items.js';
import {dv360AdvertiserFamily} from './dv360-advertiser-settings.js';
import {dv360AudienceEditFamily} from './dv360-audience-edits.js';
import {dv360BiddingFamily} from './dv360-custom-bidding.js';
import {dv360BiddingFileFamily} from './dv360-custom-bidding-files.js';
import {dv360AdGroupFamily} from './dv360-demand-gen-ad-groups.js';
import {dv360InventoryGroupFamily} from './dv360-inventory-source-groups.js';
import {dv360LineItemBulkFamily} from './dv360-line-item-bulk-update.js';
import {dv360LineItemDuplicateFamily} from './dv360-line-item-duplicate.js';
import {googleAutoAssetFamily} from './google-auto-assets.js';
import {businessAttributeFamily} from './google-business-location-attributes.js';
import {businessLocationEditFamily} from './google-business-location-edits.js';
import {businessLodgingFamily} from './google-business-lodging.js';
import {googleDraftFamily} from './google-campaign-drafts.js';
import {googleCustomerSettingsFamily} from './google-customer-settings.js';
import {googleExperimentFamily} from './google-experiments.js';
import {googleBrandGuidelinesFamily} from './google-pmax-brand-guidelines.js';
import {googleApplyFamily} from './google-recommendation-apply.js';
import {googleSubscriptionFamily} from './google-recommendation-subscriptions.js';
import {googleSmartFamily} from './google-smart-campaign-settings.js';
import {googleCustomerTypeFamily} from './google-user-list-customer-types.js';
import {googleUploadFamily} from './google-youtube-uploads.js';
import {linkedinAbFamily} from './linkedin-ab-tests.js';
import {linkedinAccountSettingsFamily} from './linkedin-account-settings.js';
import {linkedinDscEditFamily} from './linkedin-dsc-edits.js';
import {linkedinDeleteFamily} from './linkedin-entity-deletes.js';
import {linkedinDomainFamily} from './linkedin-insight-domains.js';
import {linkedinInsightFamily} from './linkedin-insight-tags.js';
import {linkedinLeadFormStateFamily} from './linkedin-lead-form-states.js';
import {linkedinMessageFamily} from './linkedin-message-ads.js';
import {linkedinPublisherFamily} from './linkedin-publisher-restrictions.js';
import {linkedinThirdPartyFamily} from './linkedin-third-party-tracking.js';
import {linkedinTrackingFamily} from './linkedin-tracking-parameters.js';
import {metaAccountSettingsFamily} from './meta-account-settings.js';
import {metaImageFamily} from './meta-ad-images.js';
import {metaConversionFamily} from './meta-custom-conversions.js';
import {metaObjectFamily} from './meta-object-edits.js';
import {metaPixelFamily} from './meta-pixels.js';
import {metaSplitTestFamily} from './meta-split-tests.js';
import {tiktokAudienceEditFamily} from './tiktok-audience-edits.js';
import {tiktokBlockedWordFamily} from './tiktok-blocked-words.js';
import {tiktokChangeLogFamily} from './tiktok-change-logs.js';
import {tiktokConversionEditFamily} from './tiktok-conversion-edits.js';
import {tiktokDeletionFamily} from './tiktok-deletions.js';
import {tiktokImageEditFamily} from './tiktok-image-edits.js';
import {tiktokLibraryFamily} from './tiktok-library-assets.js';
import {tiktokRuleAudienceFamily} from './tiktok-rule-audiences.js';
import {xConversationCardFamily} from './x-conversation-cards.js';
import {xCuratedFamily} from './x-curated-categories.js';
import {xAudienceFamily} from './x-custom-audiences.js';
import {xEntityBatchFamily} from './x-entity-batches.js';
import {xAssociationFamily} from './x-line-item-associations.js';
import {xMediaFamily} from './x-media-library.js';
import {xPrerollCtaFamily} from './x-preroll-ctas.js';
import {xScheduledFamily} from './x-scheduled-tweets.js';
import {xTrackingTagFamily} from './x-tracking-tags.js';

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
    criteoSegmentFamily, // criteo_audience_segments
    criteoPreferredFamily, // criteo_preferred_line_items
    dv360AdvertiserFamily, // dv360_advertiser_settings
    dv360AudienceEditFamily, // dv360_audience_edits
    dv360BiddingFamily, // dv360_custom_bidding
    dv360BiddingFileFamily, // dv360_custom_bidding_files
    dv360AdGroupFamily, // dv360_demand_gen_ad_groups
    dv360InventoryGroupFamily, // dv360_inventory_source_groups
    dv360LineItemBulkFamily, // dv360_line_item_bulk_update
    dv360LineItemDuplicateFamily, // dv360_line_item_duplicate
    googleAutoAssetFamily, // google_auto_assets
    businessAttributeFamily, // google_business_location_attributes
    businessLocationEditFamily, // google_business_location_edits
    businessLodgingFamily, // google_business_lodging
    googleDraftFamily, // google_campaign_drafts
    googleCustomerSettingsFamily, // google_customer_settings
    googleExperimentFamily, // google_experiments
    googleBrandGuidelinesFamily, // google_pmax_brand_guidelines
    googleApplyFamily, // google_recommendation_apply
    googleSubscriptionFamily, // google_recommendation_subscriptions
    googleSmartFamily, // google_smart_campaign_settings
    googleCustomerTypeFamily, // google_user_list_customer_types
    googleUploadFamily, // google_youtube_uploads
    linkedinAbFamily, // linkedin_ab_tests
    linkedinAccountSettingsFamily, // linkedin_account_settings
    linkedinDscEditFamily, // linkedin_dsc_edits
    linkedinDeleteFamily, // linkedin_entity_deletes
    linkedinDomainFamily, // linkedin_insight_tag_domains
    linkedinInsightFamily, // linkedin_insight_tags
    linkedinLeadFormStateFamily, // linkedin_lead_form_states
    linkedinMessageFamily, // linkedin_message_ads
    linkedinPublisherFamily, // linkedin_publisher_restrictions
    linkedinThirdPartyFamily, // linkedin_third_party_tracking
    linkedinTrackingFamily, // linkedin_tracking_parameters
    metaAccountSettingsFamily, // meta_account_settings
    metaImageFamily, // meta_ad_images
    metaConversionFamily, // meta_custom_conversions
    metaObjectFamily, // meta_object_edits
    metaPixelFamily, // meta_pixels
    metaSplitTestFamily, // meta_split_tests
    tiktokAudienceEditFamily, // tiktok_audience_edits
    tiktokBlockedWordFamily, // tiktok_blocked_words
    tiktokChangeLogFamily, // tiktok_change_log_tasks
    tiktokConversionEditFamily, // tiktok_custom_conversion_edits
    tiktokDeletionFamily, // tiktok_deletions
    tiktokImageEditFamily, // tiktok_image_edits
    tiktokLibraryFamily, // tiktok_library_assets
    tiktokRuleAudienceFamily, // tiktok_rule_audiences
    xConversationCardFamily, // x_conversation_cards
    xCuratedFamily, // x_curated_categories
    xAudienceFamily, // x_custom_audiences
    xEntityBatchFamily, // x_entity_batches
    xAssociationFamily, // x_line_item_associations
    xMediaFamily, // x_media_library
    xPrerollCtaFamily, // x_preroll_ctas
    xScheduledFamily, // x_scheduled_tweets
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
