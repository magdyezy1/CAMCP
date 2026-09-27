import {snapUpdateKind,assertSnapUpdate,snapUpdateSnapshots,readSnapUpdateState,snapUpdateOutcome} from './snapchat-nested-updates.js';
import {snapProductSetKind,assertSnapProductSet,snapProductSetSnapshots,readSnapProductSets,isSnapProductSetRead,validateSnapProductSetState,snapProductSetPrerequisites,snapProductSetOutcome} from './snapchat-product-sets.js';
import {snapConversionKind,assertSnapConversion,snapConversionSnapshots,readSnapConversions,isSnapConversionRead,validateSnapConversionState,snapConversionPrerequisites,snapConversionOutcome} from './snapchat-custom-conversions.js';
import {snapSegmentDeleteKind,assertSnapSegmentDelete,snapSegmentDeleteSnapshots,readSnapSegmentDelete,isSnapSegmentDeleteRead,validateSnapSegmentDeleteState,snapSegmentDeletePrerequisites,snapSegmentDeleteOutcome} from './snapchat-segment-deletions.js';
import {snapDisclaimerKind,assertSnapDisclaimers,snapDisclaimerSnapshots,readSnapDisclaimers,isSnapDisclaimerRead,validateSnapDisclaimerState,snapDisclaimerPrerequisites,snapDisclaimerOutcome} from './snapchat-offer-disclaimers.js';
import {snapchatMediaCopyKind,assertSnapchatMediaCopy,snapchatMediaCopySnapshots,isSnapchatMediaCopyRead,validateSnapchatMediaCopyState,snapchatMediaCopyPrerequisites,snapchatMediaCopyOutcome,readSnapchatMediaCopy} from './snapchat-media-copy.js';
import {assertSnapLeadForms,assertSnapLeadCreativeRefs,snapLeadDependencyPaths,assertSnapCreativeReferences} from './snapchat-lead-forms.js';
import {assertSnapSegments,assertSnapSegmentUpdates,snapSegmentDependencyPaths} from './snapchat-segments.js';
import {tiktokIdentityKind,assertTiktokIdentity,tiktokIdentityImage,tiktokImageInfoPath} from './tiktok-identities.js';
import {metaCopyKind,assertMetaCopy,metaCopySnapshots,metaCopyChildrenRead,metaCopyOutcome} from './meta-copies.js';
import {tiktokLookalikeKind,assertTiktokLookalike,tiktokLookalikeSeed,tiktokAudienceGetPath} from './tiktok-lookalikes.js';
import {metaLookalikeKind,assertMetaLookalike,metaLookalikeSeed,metaSeedFields} from './meta-lookalikes.js';
import {tiktokBudgetKind,assertTiktokBudget,tiktokBudgetAdgroupIds} from './tiktok-budgets.js';
import {tiktokCustomConversionKind,assertTiktokCustomConversion,tiktokCustomConversionReads,validateTiktokConversionState} from './tiktok-custom-conversions.js';
import {tiktokAdgroupConversion,tiktokAdgroupConversionRead,tiktokAdgroupConversionPrerequisites} from './tiktok-adgroup-conversions.js';
import {tiktokSavedAudienceKind,assertTiktokSavedAudience,tiktokSavedAudienceAudiences,validateTiktokSavedAudienceState} from './tiktok-saved-audiences.js';
import {tiktokSmartPlusStatusKind,assertTiktokSmartPlusStatus,tiktokSmartPlusStatusRead,validateTiktokSmartPlusState,tiktokSmartPlusStatusOutcome} from './tiktok-smart-plus-status.js';
import {tiktokSmartPlusBudgetKind,assertTiktokSmartPlusBudget,tiktokSmartPlusBudgetRead} from './tiktok-smart-plus-budgets.js';
import {tiktokSmartPlusCampaignKind,assertTiktokSmartPlusCampaign,tiktokSmartPlusCampaignId} from './tiktok-smart-plus-campaigns.js';
import {tiktokSmartPlusAdgroupKind,assertTiktokSmartPlusAdgroup,tiktokSmartPlusAdgroupReads,tiktokSmartPlusAdgroupId} from './tiktok-smart-plus-adgroups.js';
import {tiktokSmartPlusCampaignUpdateKind,assertTiktokSmartPlusCampaignUpdate,tiktokSmartPlusCampaignUpdateRead} from './tiktok-smart-plus-campaign-updates.js';
import {tiktokCtaPortfolioKind,assertTiktokCtaPortfolio,tiktokCtaReferences,tiktokCtaPortfolioReads,tiktokCtaPortfolioPrerequisites,tiktokCtaPortfolioId,validateTiktokCtaPortfolioState} from './tiktok-cta-portfolios.js';
import {tiktokSmartPlusAdKind,assertTiktokSmartPlusAd,tiktokSmartPlusAdReads,tiktokSmartPlusAdPrerequisites,tiktokSmartPlusAdId,validateTiktokSmartPlusAdState} from './tiktok-smart-plus-ads.js';
import {tiktokSmartPlusAdUpdateKind,assertTiktokSmartPlusAdUpdate,tiktokSmartPlusAdUpdateReads,tiktokSmartPlusAdUpdatePrerequisites} from './tiktok-smart-plus-ad-updates.js';
import {tiktokSmartPlusAdgroupUpdateKind,assertTiktokSmartPlusAdgroupUpdate,tiktokSmartPlusAdgroupUpdateRead,tiktokSmartPlusAdgroupUpdateSiblingRead,validateTiktokSmartPlusAdgroupCampaignState,tiktokSmartPlusAdgroupUpdatePrerequisites} from './tiktok-smart-plus-adgroup-updates.js';
import {tiktokSmartPlusMaterialStatusKind,assertTiktokSmartPlusMaterialStatus,tiktokSmartPlusMaterialStatusRead,tiktokSmartPlusMaterialStatusPrerequisites,tiktokSmartPlusMaterialStatusOutcome} from './tiktok-smart-plus-material-status.js';
import {tiktokManualAdIdentityPrerequisites} from './tiktok-manual-ad-identities.js';
import {tiktokInstantFormFollowUps,validateTiktokInstantFormState} from './tiktok-instant-forms.js';
import {linkedinLeadFormKind,assertLinkedInLeadForm,linkedinLeadFormOutcome,rememberLinkedInLeadForm,isLinkedInLeadFormRead,validateLinkedInLeadFormState} from './linkedin-lead-forms.js';
import {googlePreviewKind,assertGooglePreview,googlePreviewSnapshots,readGooglePreviewState,googlePreviewOutcome,googlePreviewDelivery,googlePreviewSafeOutcome} from './google-preview-writes.js';
import {criteoCampaignKind,assertCriteoCampaign,assertCriteoCampaignScopes,criteoCampaignSnapshots,readCriteoCampaignState,criteoCampaignOutcome} from './criteo-campaign-writes.js';
import {metaReportKind,assertMetaReport,assertMetaReportScope,metaReportSnapshots,readMetaReportState,metaReportOutcome} from './meta-insights-jobs.js';
import {xReportKind,assertXReport,xReportSnapshots,readXReportState,xReportOutcome,xReportSafeData,retainXReport,xReportIdentity,admitXReport} from './x-report-jobs.js';
import {tiktokReportKind,assertTiktokReport,tiktokReportSnapshots,readTiktokReportState,tiktokReportOutcome,retainTiktokReport,admitTiktokReport} from './tiktok-report-jobs.js';
import {criteoReportKind,assertCriteoReport,assertCriteoReportScopes,criteoReportSnapshots,readCriteoReportState,criteoReportOutcome} from './criteo-report-jobs.js';
import {metaCreativeCreate,metaCreativeIdentityReads,metaCreativeState} from './meta-creative-state.js';
import {placeActionKind,assertPlaceAction,assertPlaceActionScope,placeActionSnapshots,readPlaceActionState,placeActionOutcome,placeActionSafe,placeActionSafeError} from './google-place-action-links.js';
import {businessNotificationKind,assertBusinessNotification,assertBusinessNotificationActor,assertBusinessNotificationScope,businessNotificationSnapshots,readBusinessNotificationState,businessNotificationOutcome} from './google-business-notifications.js';
import {businessAccessKind,assertBusinessAccess,assertBusinessAccessActor,assertBusinessAccessScope,businessAccessSnapshots,readBusinessAccessState,businessAccessOutcome} from './google-business-access.js';
import {googleDismissalKind,assertGoogleDismissal,assertGoogleDismissalPrerequisites,googleDismissalSnapshots,readGoogleDismissalState,googleDismissalOutcome} from './google-recommendation-dismissal.js';
import {googleAccessKind,assertGoogleAccess,assertGoogleAccessActor,assertGoogleAccessPrerequisites,googleAccessSnapshots,readGoogleAccessState,googleAccessOutcome} from './google-user-access.js';
import {readRedditProfiles,validateRedditProfiles,validateRedditCreativePrerequisites,assertRedditCreativeAvailable} from './reddit-creative-writes.js';
import {readKeywordPlanTree,validateKeywordPlanTree} from './google-keyword-plan-writes.js';
import {reviewedWriteFamily} from './reviewed-routes.js';
import {xDraftKind,assertXDraft,xDraftSnapshots,readXDraftState,xDraftOutcome} from './x-draft-writes.js';
import {linkedinRuleKind,assertLinkedInRule,linkedinRuleSnapshots,readLinkedInRules,isLinkedInRuleRead,validateLinkedInRuleState,linkedinRulePrerequisites,linkedinRuleOutcome} from './linkedin-conversion-rules.js';
import {googleBrandGuidelinesKind,assertGoogleBrandGuidelines,googleBrandGuidelinesSnapshots,readGoogleBrandGuidelines,isGoogleBrandGuidelinesRead,validateGoogleBrandGuidelinesState,googleBrandGuidelinesPrerequisites,googleBrandGuidelinesOutcome} from './google-pmax-brand-guidelines.js';
import {assertGoogleAdsScope as assertBrandGuidelinesScope} from './google-contracts.js';
import {googleSubscriptionKind,assertGoogleSubscriptions,googleSubscriptionSnapshots,readGoogleSubscriptions,isGoogleSubscriptionRead,validateGoogleSubscriptionState,googleSubscriptionPrerequisites,googleSubscriptionOutcome} from './google-recommendation-subscriptions.js';
import {googleApplyKind,assertGoogleApply,googleApplySnapshots,readGoogleApply,isGoogleApplyRead,validateGoogleApplyState,googleApplyPrerequisites,googleApplyOutcome} from './google-recommendation-apply.js';
import {googleSmartKind,assertGoogleSmart,googleSmartSnapshots,readGoogleSmart,isGoogleSmartRead,validateGoogleSmartState,googleSmartPrerequisites,googleSmartOutcome} from './google-smart-campaign-settings.js';
import {googleCustomerSettingsKind,assertGoogleCustomerSettings,googleCustomerSettingsSnapshots,readGoogleCustomerSettings,isGoogleCustomerSettingsRead,validateGoogleCustomerSettingsState,googleCustomerSettingsPrerequisites,googleCustomerSettingsOutcome} from './google-customer-settings.js';
import {googleAutoAssetKind,assertGoogleAutoAssets,googleAutoAssetSnapshots,readGoogleAutoAssets,isGoogleAutoAssetRead,validateGoogleAutoAssetState,googleAutoAssetPrerequisites,googleAutoAssetOutcome} from './google-auto-assets.js';
import {googleUploadKind,assertGoogleUploads,googleUploadSnapshots,readGoogleUploads,isGoogleUploadRead,validateGoogleUploadState,googleUploadPrerequisites,googleUploadOutcome} from './google-youtube-uploads.js';
import {googleExperimentKind,assertGoogleExperiments,googleExperimentSnapshots,readGoogleExperiments,isGoogleExperimentRead,validateGoogleExperimentState,googleExperimentPrerequisites,googleExperimentOutcome} from './google-experiments.js';
import {googleDraftKind,assertGoogleDrafts,googleDraftSnapshots,readGoogleDrafts,isGoogleDraftRead,validateGoogleDraftState,googleDraftPrerequisites,googleDraftOutcome} from './google-campaign-drafts.js';
import {googleCustomerTypeKind,assertGoogleCustomerTypes,googleCustomerTypeSnapshots,readGoogleCustomerTypes,isGoogleCustomerTypeRead,validateGoogleCustomerTypeState,googleCustomerTypePrerequisites,googleCustomerTypeOutcome} from './google-user-list-customer-types.js';
import {googleBidKind,assertGoogleBid,assertGoogleBidScope,googleBidSnapshots,readGoogleBidState,isGoogleBidRead,validateGoogleBidState,googleBidPrerequisites,googleBidOutcome} from './google-bid-modifiers.js';
import {linkedinMessageKind,assertLinkedInMessage,assertLinkedInMessageScope,linkedinMessageSnapshots,readLinkedInMessage,isLinkedInMessageRead,validateLinkedInMessageState,linkedinMessagePrerequisites,linkedinMessageOutcome} from './linkedin-message-ads.js';
import {linkedinAbKind,assertLinkedInAb,assertLinkedInAbScope,linkedinAbSnapshots,readLinkedInAb,isLinkedInAbRead,validateLinkedInAbState,linkedinAbPrerequisites,linkedinAbOutcome} from './linkedin-ab-tests.js';
import {linkedinInsightKind,assertLinkedInInsight,assertLinkedInInsightScope,linkedinInsightSnapshots,readLinkedInInsight,isLinkedInInsightRead,validateLinkedInInsightState,linkedinInsightPrerequisites,linkedinInsightOutcome} from './linkedin-insight-tags.js';
import {linkedinThirdPartyKind,assertLinkedInThirdParty,assertLinkedInThirdPartyScope,linkedinThirdPartySnapshots,readLinkedInThirdParty,isLinkedInThirdPartyRead,validateLinkedInThirdPartyState,linkedinThirdPartyPrerequisites,linkedinThirdPartyOutcome} from './linkedin-third-party-tracking.js';
import {linkedinTrackingKind,assertLinkedInTracking,assertLinkedInTrackingScope,linkedinTrackingSnapshots,readLinkedInTracking,isLinkedInTrackingRead,validateLinkedInTrackingState,linkedinTrackingPrerequisites,linkedinTrackingOutcome} from './linkedin-tracking-parameters.js';
import {linkedinConversionKind,assertLinkedInConversion,assertLinkedInConversionScope,linkedinConversionSnapshots,readLinkedInConversions,isLinkedInConversionRead,validateLinkedInConversionState,linkedinConversionPrerequisites,linkedinConversionOutcome} from './linkedin-conversion-links.js';
import {metaLabelKind,assertMetaLabel,assertMetaLabelScope,metaLabelSnapshots,readMetaLabels,validateMetaLabelState,validateMetaLabelPrerequisites,metaLabelOutcome} from './meta-label-writes.js';
import {criteoTargetingKind,assertCriteoTargeting,assertCriteoTargetingScopes,criteoTargetingSnapshots,readCriteoTargeting,validateCriteoTargetState,validateCriteoTargetingPrerequisites,criteoTargetingOutcome} from './criteo-targeting-writes.js';
import {readAssetSetContents,validateAssetSetContents} from './google-asset-set-writes.js';
import {assertProviderActionAvailable,unsupportedProviderAlias} from './retired-provider-actions.js';
import {gtmWorkspaceKind,assertGtmWorkspace,gtmWorkspaceSnapshots,validateGtmWorkspaceState,readGtmWorkspace,validateGtmWorkspacePrerequisites,gtmWorkspaceOutcome,gtmWorkspaceReceipt} from './gtm-workspace-writes.js';
import {gtmWorkflowKind,assertGtmWorkflow,assertGtmWorkflowActor,gtmWorkflowSnapshots,validateGtmWorkflowState,readGtmWorkflow,gtmSafeConfiguration,validateGtmWorkflowPrerequisites,gtmWorkflowOutcome} from './gtm-workflow-writes.js';
import {appleEntityKind,appleSharedAccounts,appleSharedAccountReads,validateAppleEntityPrerequisites} from './apple-entity-writes.js';
import {dv360ListKind,assertDV360ListWrite,dv360ListSnapshots,validateDV360ListState,readDV360List,validateDV360ListPrerequisites,dv360ListOutcome} from './dv360-list-writes.js';
import {dv360TargetingKind,assertDV360Targeting,dv360TargetingSnapshots,isDV360TargetingRead,validateDV360TargetingState,readDV360Targeting,validateDV360TargetingPrerequisites,dv360TargetingOutcome} from './dv360-line-item-targeting.js';
import {googleListingGroupKind,assertGoogleListingGroups,googleListingGroupSnapshots,isGoogleListingGroupRead,validateGoogleListingGroupState,validateGoogleListingGroupPrerequisites,googleListingGroupOutcome} from './google-listing-groups.js';
import {tiktokNegativeKeywordKind,assertTiktokNegativeKeywords,tiktokNegativeKeywordReads,isTiktokNegativeKeywordRead,validateTiktokNegativeKeywordState,readTiktokNegativeKeywords,validateTiktokNegativeKeywordPrerequisites,tiktokNegativeKeywordOutcome} from './tiktok-negative-keywords.js';
import {tiktokBrandSafetyKind,assertTiktokBrandSafety,tiktokBrandSafetyReads,isTiktokBrandSafetyRead,validateTiktokBrandSafetyState,validateTiktokBrandSafetyPrerequisites,tiktokBrandSafetyOutcome} from './tiktok-brand-safety.js';
import {metaImageKind,assertMetaImage,assertMetaImageScope,metaImageSnapshots,readMetaImage,isMetaImageRead,validateMetaImageState,metaImagePrerequisites,metaImageOutcome} from './meta-ad-images.js';
import {metaConversionKind,assertMetaConversion,assertMetaConversionScope,metaConversionSnapshots,readMetaConversions,isMetaConversionRead,validateMetaConversionState,metaConversionPrerequisites,metaConversionOutcome} from './meta-custom-conversions.js';
import {metaObjectKind,assertMetaObject,assertMetaObjectScope,metaObjectSnapshots,readMetaObject,isMetaObjectRead,validateMetaObjectState,metaObjectPrerequisites,metaObjectOutcome} from './meta-object-edits.js';
import {metaValueRuleKind,assertMetaValueRule,metaValueRuleReads,isMetaValueRuleRead,validateMetaValueRuleState,validateMetaValueRulePrerequisites,metaValueRuleOutcome} from './meta-value-rules.js';
import {metaBrandSafetyKind,assertMetaBrandSafety,metaBrandSafetyReads,isMetaBrandSafetyRead,validateMetaBrandSafetyState,validateMetaBrandSafetyPrerequisites,metaBrandSafetyOutcome} from './meta-brand-safety.js';
import {criteoSegmentKind,assertCriteoSegments,assertCriteoSegmentScopes,criteoSegmentSnapshots,readCriteoSegments,isCriteoSegmentRead,validateCriteoSegmentState,criteoSegmentPrerequisites,criteoSegmentOutcome} from './criteo-audience-segments.js';
import {criteoCatalogKind,assertCriteoCatalog,assertCriteoCatalogScopes,criteoCatalogSnapshots,readCriteoCatalog,isCriteoCatalogRead,validateCriteoCatalogState,criteoCatalogPrerequisites,criteoCatalogOutcome} from './criteo-catalog-requests.js';
import {criteoPreferredKind,assertCriteoPreferred,assertCriteoPreferredScopes,criteoPreferredSnapshots,readCriteoPreferred,isCriteoPreferredRead,validateCriteoPreferredState,criteoPreferredPrerequisites,criteoPreferredOutcome} from './criteo-preferred-line-items.js';
import {criteoOverrideKind,assertCriteoOverride,assertCriteoOverrideScopes,criteoOverrideSnapshots,readCriteoOverrides,isCriteoOverrideRead,validateCriteoOverrideState,criteoOverridePrerequisites,criteoOverrideOutcome} from './criteo-budget-overrides.js';
import {criteoLineItemKind,assertCriteoLineItem,assertCriteoLineItemScopes,criteoLineItemReads,isCriteoLineItemRead,validateCriteoLineItemState,validateCriteoLineItemPrerequisites,criteoLineItemOutcome,readCriteoLineItems} from './criteo-auction-line-items.js';
import {criteoPromotedProductsKind,assertCriteoPromotedProducts,criteoPromotedProductsReads,validateCriteoPromotedProductsPrerequisites,criteoPromotedProductsOutcome} from './criteo-promoted-products.js';
import {criteoKeywordKind,criteoBidMultiplierKind,assertCriteoKeywords,assertCriteoBidMultipliers,criteoLineItemBiddingReads,validateCriteoLineItemBiddingPrerequisites,criteoLineItemBiddingOutcome} from './criteo-line-item-bidding.js';
import {dv360AdGroupKind,assertDV360AdGroup,dv360AdGroupReads,isDV360AdGroupRead,validateDV360AdGroupState,validateDV360AdGroupPrerequisites,dv360AdGroupOutcome,readDV360AdGroups} from './dv360-demand-gen-ad-groups.js';
import {dv360AdAssetKind,assertDV360AdAsset,dv360AdAssetReads,isDV360AdAssetRead,validateDV360AdAssetState,validateDV360AdAssetPrerequisites,dv360AdAssetOutcome} from './dv360-ad-assets.js';
import {xCuratedKind,assertXCurated,xCuratedSnapshots,isXCuratedRead,validateXCuratedState,xCuratedPrerequisites,xCuratedOutcome,readXCurated} from './x-curated-categories.js';
import {xAssociationKind,assertXAssociation,xAssociationSnapshots,isXAssociationRead,validateXAssociationState,xAssociationPrerequisites,xAssociationOutcome,readXAssociations} from './x-line-item-associations.js';
import {xAudienceKind,assertXAudience,xAudienceSnapshots,isXAudienceRead,validateXAudienceState,xAudiencePrerequisites,xAudienceOutcome,readXAudience} from './x-custom-audiences.js';
import {xScheduledKind,assertXScheduled,xScheduledSnapshots,isXScheduledRead,validateXScheduledState,xScheduledPrerequisites,xScheduledOutcome,readXScheduled} from './x-scheduled-tweets.js';
import {xMediaKind,assertXMedia,xMediaSnapshots,isXMediaRead,validateXMediaState,xMediaPrerequisites,xMediaOutcome,readXMedia} from './x-media-library.js';
import {xPrerollCtaKind,assertXPrerollCta,xPrerollCtaSnapshots,isXPrerollCtaRead,validateXPrerollCtaState,xPrerollCtaPrerequisites,xPrerollCtaOutcome,readXPrerollCtas} from './x-preroll-ctas.js';
import {xTrackingTagKind,assertXTrackingTag,xTrackingTagSnapshots,isXTrackingTagRead,validateXTrackingTagState,xTrackingTagPrerequisites,xTrackingTagOutcome,readXTrackingTags} from './x-tracking-tags.js';
import {dv360SdfKind,assertDV360Sdf,dv360SdfSnapshots,readDV360Sdf,isDV360SdfRead,validateDV360SdfState,dv360SdfPrerequisites,dv360SdfOutcome} from './dv360-sdf-downloads.js';
import {dv360BiddingKind,assertDV360Bidding,dv360BiddingSnapshots,readDV360Bidding,isDV360BiddingRead,validateDV360BiddingState,dv360BiddingPrerequisites,dv360BiddingOutcome} from './dv360-custom-bidding.js';
import {dv360AdvertiserKind,assertDV360Advertiser,dv360AdvertiserSnapshots,readDV360Advertiser,isDV360AdvertiserRead,validateDV360AdvertiserState,dv360AdvertiserPrerequisites,dv360AdvertiserOutcome} from './dv360-advertiser-settings.js';
import {dv360InventoryGroupKind,assertDV360InventoryGroup,dv360InventoryGroupSnapshots,readDV360InventoryGroup,isDV360InventoryGroupRead,validateDV360InventoryGroupState,dv360InventoryGroupPrerequisites,dv360InventoryGroupOutcome} from './dv360-inventory-source-groups.js';
import {dv360LineItemDuplicateKind,assertDV360LineItemDuplicate,dv360LineItemDuplicateSnapshots,isDV360LineItemDuplicateRead,validateDV360LineItemDuplicateState,dv360LineItemDuplicatePrerequisites,dv360LineItemDuplicateOutcome,readDV360LineItemDuplicate} from './dv360-line-item-duplicate.js';
import {dv360LineItemBulkKind,assertDV360LineItemBulk,dv360LineItemBulkSnapshots,isDV360LineItemBulkRead,validateDV360LineItemBulkState,dv360LineItemBulkPrerequisites,dv360LineItemBulkOutcome,readDV360LineItemBulk} from './dv360-line-item-bulk-update.js';
import {dv360AdKind,assertDV360Ad,dv360AdReads,isDV360AdRead,validateDV360AdState,validateDV360AdPrerequisites,dv360AdOutcome,readDV360Ads} from './dv360-demand-gen-ads.js';
import {googleConfigurationKind,assertGoogleConfiguration,googleConfigurationSnapshots,validateGoogleConfigurationState,googleConfigurationOutcome} from './google-configuration-writes.js';
import {checkSpendPolicy} from './spend-policy.js';
import {randomUUID} from 'node:crypto';
import {MirrorError,errorRemedy} from './errors.js';
import {validateMetaCampaign} from './meta-contracts.js';
import {validateGoogleRequest,assertGoogleAdsScope} from './google-contracts.js';
import {googleSegmentKind} from './google-custom-segments.js';
import {googleConversionGoalKind,assertGoogleConversionGoal,googleConversionGoalSnapshots,readGoogleConversionGoalState,googleConversionGoalOutcome} from './google-conversion-goals.js';
import {googleBiddingEventKind,assertGoogleBiddingEvent,googleBiddingEventSnapshots,readGoogleBiddingEventState,googleBiddingEventOutcome} from './google-bidding-events.js';
import {googlePortfolioKind,assertGooglePortfolio,googlePortfolioSnapshots,readGooglePortfolioState,googlePortfolioOutcome} from './google-portfolio-strategies.js';
import {googleConversionActionKind,assertGoogleConversionAction,googleConversionActionSnapshots,readGoogleConversionActionState,googleConversionActionOutcome} from './google-conversion-actions.js';
import {linkedinDSC,assertLinkedInDSC,linkedinDSCReads,linkedinMediaProjection,linkedinPostId} from './linkedin-posts.js';
import {writeImpact} from './write-impact.js';
import {executionEvidence} from './contract-evidence.js';
import {Registry} from './catalog.js';
import {Compiler} from './compiler.js';
import {Store} from './store.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport,type TransportResult} from './transport.js';
import {ScopeGuard,normalizeAccount} from './scope.js';
import {applyExecutionRisk} from './execution-risk.js';
import {authorizeExecution,type ExecutionPolicy} from './preflight.js';
import {guardInput,redact,sha256,stable} from './security.js';
import type {Actor,CallOptions,CompiledRequest,Connection,Credentials,JsonObject} from './types.js';
import {nativeAuthority} from './native-authority.js';
import {DelegatedNativeCompiler} from './delegated-native.js';
import {normalizeSnapshot,reviewStateHash,changedStateFields} from './review-state.js';
import {nextPage} from './pagination.js';
import {assertAccountWrite} from './write-access.js';
import {assertXCreative,xCreativeKind,xCreativeEdit,xCreativeSnapshots,readXCreativeState,xCreativeOutcome} from './x-creative-writes.js';
import {validateMetaCreative} from './creative-validation.js';
import {googleTargetingKind,assertGoogleTargeting,googleTargetingSnapshots,validateGoogleTargetingState} from './google-targeting-writes.js';
import {googleAssetLinkKind,assertGoogleAssetLinks,googleAssetLinkSnapshots,validateGoogleAssetLinkState,googleAssetLinkOutcome} from './google-asset-links.js';
import {xTargetingKind,assertXTargeting,xTargetingSnapshots,validateXTargetingState} from './x-targeting-writes.js';
import {xTargetingBatchRoute,assertXTargetingBatch,xTargetingBatchSnapshots,readXTargetingBatchState,xTargetingBatchOutcome} from './x-targeting-batch.js';
import {linkedinTemplateKind,assertLinkedInTemplate,linkedinTemplateSnapshots,readLinkedInTemplateState,linkedinTemplateOutcome} from './linkedin-audience-templates.js';
import {assertRedditWrite,assertRedditWriteScopes,redditSnapshots,validateRedditState,redditOutcome} from './reddit-writes.js';
import {microsoftGateway,microsoftScope,assertMicrosoftWrite,microsoftSnapshots,validateMicrosoftResponse,microsoftOutcome} from './microsoft-native.js';
import {validateMicrosoftAssociationState} from './microsoft-associations.js';
import {measurementWriteGateways,assertMeasurementWrite,assertMeasurementScopes,measurementSnapshots,optionalMissingState,validateMeasurementState,measurementOutcome} from './measurement-writes.js';

export const writeTool={name:'amcp_write',description:'Inspect, prepare and execute a reviewed native advertising or measurement mutation. inspect checks local write-contract support without credentials or network calls. Preparation reads account/resource state and returns a five-minute, actor-bound frozen request. Execution requires its review_id, idempotency_key and explicit confirmation. Operator role and administrator account write grants are required. This is an AMCP extension, not a captured AMCP tool.',inputSchema:{type:'object',required:['action'],properties:{action:{type:'string',enum:['inspect','prepare','execute']},gateway:{type:'string'},arguments:{type:'object'},connection_id:{type:'string'},review_id:{type:'string'},idempotency_key:{type:'string'},confirmed:{type:'boolean'},spend_change_confirmed:{type:'boolean'},creative_edit_confirmed:{type:'boolean',description:'Explicitly acknowledge a reviewed X card edit/deletion or Tweet rename that may disrupt promoted ads. Freeze this choice during prepare and repeat it during execute.'}},additionalProperties:false}};
export const writeContractGateways=new Set(['meta_native_action','tiktok_native_action','snapchat_native_action','google_ads_native_action','google_business_native_action','linkedin_native_action','x_ads_native_action','dv360_native_action','reddit_native_action','criteo_native_action',microsoftGateway,...measurementWriteGateways]);
const object=(v:unknown):JsonObject=>v&&typeof v==='object'&&!Array.isArray(v)?v as JsonObject:{};
const snake=(s:string)=>s.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase();
function fail(code:string,message:string,details:JsonObject={}):never{throw new MirrorError(code,message,details);}
export function writeOutcome(result:TransportResult,plan?:CompiledRequest,before:unknown[]=[]):JsonObject {
 const errors:JsonObject[]=[];
 const walk=(value:unknown,path='$')=>{
  if(Array.isArray(value)){value.forEach((v,i)=>walk(v,path+'['+i+']'));return;}
  if(!value||typeof value!=='object')return;
  for(const [key,v]of Object.entries(value)){
   // Microsoft batch errors can align with request items using null success
   // slots. This exception is exact and provider-specific; false/objects fail.
   if(plan?.gateway===microsoftGateway&&path==='$'&&key==='PartialErrors'&&Array.isArray(v)&&v.every(item=>item===null))continue;
   const nonempty=v!==null&&v!==false&&v!==''&&v!==0&&(!Array.isArray(v)||v.length>0)&&(!v||typeof v!=='object'||Object.keys(v).length>0);
   if(nonempty&&/error|fail/i.test(key)||/^(?:is_)?success$/.test(key)&&v===false||/status$/i.test(key)&&(typeof v==='string'&&/ERROR|FAIL|PARTIAL/i.test(v)||typeof v==='number'&&v>=400))errors.push({path:path+'.'+key,value:v});
   else walk(v,path+'.'+key);
  }
 };walk(result.data);
 if(!plan&&result.status!==204&&result.status!==205&&!result.headers['x-restli-id']&&(result.data===null||typeof result.data!=='object'||!Object.keys(result.data).length))errors.push({path:'$',value:'Provider returned no verifiable mutation result.'});
 if(plan&&!confirmedMutationResult(plan,result,before))errors.push({path:'$',value:'The response does not confirm every mutation under this provider response contract.'});
 const outcome={success:errors.length===0,executed:true,outcome:errors.length?'partial_or_failed':'succeeded',data:plan?.gateway==='gtm_native_action'?gtmSafeConfiguration(result.data):result.data,status:result.status,headers:result.headers,...(result.headers['x-restli-id']?{created_id:result.headers['x-restli-id']}:{ }),...(errors.length?{failures:plan?.gateway==='gtm_native_action'?gtmSafeConfiguration(errors):errors,retry_safe:false}:{}),...(plan&&gtmWorkspaceKind(plan)?gtmWorkspaceReceipt(plan,result):{})}; return plan&&(placeActionKind(plan)||businessNotificationKind(plan)||businessAccessKind(plan))?placeActionSafe(outcome):outcome;
}
function confirmedMutationResult(plan:CompiledRequest,result:TransportResult,before:unknown[]):boolean {
 if(linkedinTemplateKind(plan))return linkedinTemplateOutcome(plan,result,before);
 if(xTargetingBatchRoute(plan))return xTargetingBatchOutcome(plan,result,before);
 if(googlePreviewKind(plan))return googlePreviewOutcome(plan,result);
 if(xDraftKind(plan))return xDraftOutcome(plan,result,before);
 if(placeActionKind(plan))return placeActionOutcome(plan,result,before);
 if(businessNotificationKind(plan))return businessNotificationOutcome(plan,result,before);
 if(businessAccessKind(plan))return businessAccessOutcome(plan,result,before);
 if(googleDismissalKind(plan))return googleDismissalOutcome(plan,result);
 if(googleAccessKind(plan))return googleAccessOutcome(plan,result,before);
 if(linkedinRuleKind(plan))return linkedinRuleOutcome(plan,result);
 if(linkedinConversionKind(plan))return linkedinConversionOutcome(plan,result);
 if(linkedinTrackingKind(plan))return linkedinTrackingOutcome(plan,result);
 if(linkedinThirdPartyKind(plan))return linkedinThirdPartyOutcome(plan,result);
 if(linkedinInsightKind(plan))return linkedinInsightOutcome(plan,result);
 if(linkedinAbKind(plan))return linkedinAbOutcome(plan,result);
 if(linkedinMessageKind(plan))return linkedinMessageOutcome(plan,result);
 if(googleBidKind(plan))return googleBidOutcome(plan,result);
 if(googleBrandGuidelinesKind(plan))return googleBrandGuidelinesOutcome(plan,result);
 if(googleCustomerTypeKind(plan))return googleCustomerTypeOutcome(plan,result);
 if(googleDraftKind(plan))return googleDraftOutcome(plan,result);
 if(googleExperimentKind(plan))return googleExperimentOutcome(plan,result);
 if(googleCustomerSettingsKind(plan))return googleCustomerSettingsOutcome(plan,result);
 if(googleAutoAssetKind(plan))return googleAutoAssetOutcome(plan,result);
 if(googleUploadKind(plan))return googleUploadOutcome(plan,result);
 if(googleSubscriptionKind(plan))return googleSubscriptionOutcome(plan,result);
 if(googleSmartKind(plan))return googleSmartOutcome(plan,result);
 if(googleApplyKind(plan))return googleApplyOutcome(plan,result);
 if(googleBiddingEventKind(plan))return googleBiddingEventOutcome(plan,result,before);
 if(googlePortfolioKind(plan))return googlePortfolioOutcome(plan,result,before);
 if(googleConversionActionKind(plan))return googleConversionActionOutcome(plan,result,before);
 if(googleConversionGoalKind(plan))return googleConversionGoalOutcome(plan,result,before);
 if(metaReportKind(plan))return metaReportOutcome(plan,result);
 if(criteoCampaignKind(plan))return criteoCampaignOutcome(plan,result);
 if(snapUpdateKind(plan))return snapUpdateOutcome(plan,result);
 if(snapchatMediaCopyKind(plan))return snapchatMediaCopyOutcome(plan,result);
 if(snapDisclaimerKind(plan))return snapDisclaimerOutcome(plan,result);
 if(snapSegmentDeleteKind(plan))return snapSegmentDeleteOutcome(plan,result);
 if(snapConversionKind(plan))return snapConversionOutcome(plan,result);
 if(snapProductSetKind(plan))return snapProductSetOutcome(plan,result);
 if(xReportKind(plan))return xReportOutcome(plan,result);
 if(tiktokReportKind(plan))return tiktokReportOutcome(plan,result);
 if(criteoReportKind(plan))return criteoReportOutcome(plan,result);
 if(metaLabelKind(plan))return metaLabelOutcome(plan,result,before);
 if(criteoTargetingKind(plan))return criteoTargetingOutcome(plan,result);
 if(gtmWorkspaceKind(plan))return gtmWorkspaceOutcome(plan,result,before);
 if(gtmWorkflowKind(plan))return gtmWorkflowOutcome(plan,result);
 if(dv360TargetingKind(plan))return dv360TargetingOutcome(plan,result);
 if(googleListingGroupKind(plan))return googleListingGroupOutcome(plan,result);
 if(tiktokNegativeKeywordKind(plan))return tiktokNegativeKeywordOutcome(plan,result);
 if(tiktokBrandSafetyKind(plan))return tiktokBrandSafetyOutcome(plan,result);
 if(metaValueRuleKind(plan))return metaValueRuleOutcome(plan,result);
 if(metaObjectKind(plan))return metaObjectOutcome(plan,result);
 if(metaImageKind(plan))return metaImageOutcome(plan,result);
 if(metaConversionKind(plan))return metaConversionOutcome(plan,result);
 if(metaBrandSafetyKind(plan))return metaBrandSafetyOutcome(plan,result);
 if(criteoLineItemKind(plan))return criteoLineItemOutcome(plan,result);
 if(criteoOverrideKind(plan))return criteoOverrideOutcome(plan,result);
 if(criteoPreferredKind(plan))return criteoPreferredOutcome(plan,result);
 if(criteoCatalogKind(plan))return criteoCatalogOutcome(plan,result);
 if(criteoSegmentKind(plan))return criteoSegmentOutcome(plan,result);
 if(criteoPromotedProductsKind(plan))return criteoPromotedProductsOutcome(plan,result);
 if(criteoKeywordKind(plan)||criteoBidMultiplierKind(plan))return criteoLineItemBiddingOutcome(plan,result);
 if(dv360AdGroupKind(plan))return dv360AdGroupOutcome(plan,result);
 if(dv360AdAssetKind(plan))return dv360AdAssetOutcome(plan,result);
 if(dv360AdKind(plan))return dv360AdOutcome(plan,result);
 if(dv360LineItemBulkKind(plan))return dv360LineItemBulkOutcome(plan,result);
 if(dv360LineItemDuplicateKind(plan))return dv360LineItemDuplicateOutcome(plan,result);
 if(dv360InventoryGroupKind(plan))return dv360InventoryGroupOutcome(plan,result);
 if(dv360AdvertiserKind(plan))return dv360AdvertiserOutcome(plan,result);
 if(dv360BiddingKind(plan))return dv360BiddingOutcome(plan,result);
 if(dv360SdfKind(plan))return dv360SdfOutcome(plan,result);
 if(xTrackingTagKind(plan))return xTrackingTagOutcome(plan,result);
 if(xPrerollCtaKind(plan))return xPrerollCtaOutcome(plan,result);
 if(xMediaKind(plan))return xMediaOutcome(plan,result);
 if(xScheduledKind(plan))return xScheduledOutcome(plan,result);
 if(xAudienceKind(plan))return xAudienceOutcome(plan,result);
 if(xAssociationKind(plan))return xAssociationOutcome(plan,result);
 if(xCuratedKind(plan))return xCuratedOutcome(plan,result);
 if(dv360ListKind(plan))return dv360ListOutcome(plan,result);
 if(googleConfigurationKind(plan))return googleConfigurationOutcome(plan,result);
 if(googleAssetLinkKind(plan))return googleAssetLinkOutcome(plan,result);
 if(linkedinLeadFormKind(plan))return linkedinLeadFormOutcome(plan,result);
 if(linkedinDSC(plan))return result.status===201&&linkedinPostId(result.headers['x-restli-id']);
 if(xCreativeKind(plan))return xCreativeOutcome(plan,result);
 if(plan.gateway==='reddit_native_action')return redditOutcome(plan,result);
 if(plan.gateway===microsoftGateway)return microsoftOutcome(plan,result);
 if(measurementWriteGateways.has(plan.gateway))return measurementOutcome(plan,result);
 const d=object(result.data),b=object(plan.body),segments=plan.path.split('/'),last=segments.at(-1)!,hasId=(v:unknown)=>typeof v==='string'&&v.length>0||typeof v==='number'&&Number.isSafeInteger(v);
 if(plan.gateway==='meta_native_action')return metaCopyKind(plan)?metaCopyOutcome(plan,d):/^\/v[^/]+\/act_/.test(plan.path)?hasId(d.id):d.success===true;
 if(plan.gateway==='google_ads_native_action')return Array.isArray(d.results)&&d.results.length===b.operations.length&&d.results.every((r:JsonObject,i:number)=>{
  const op=b.operations[i],expected=op.remove??op.update?.resource_name??op.update?.resourceName;return typeof r.resourceName==='string'&&(expected?r.resourceName===expected:r.resourceName.startsWith('customers/'+plan.accountId+'/'+last.replace(':mutate','')+'/'));
 });
 if(plan.gateway==='tiktok_native_action'){
  if(d.code!==0)return false;if(tiktokLookalikeKind(plan))return hasId(object(d.data).custom_audience_id);if(tiktokSavedAudienceKind(plan))return hasId(object(d.data).saved_audience_id);if(tiktokSmartPlusStatusKind(plan))return tiktokSmartPlusStatusOutcome(plan,d);if(tiktokSmartPlusCampaignKind(plan))return !!tiktokSmartPlusCampaignId(d);if(tiktokSmartPlusAdgroupKind(plan))return !!tiktokSmartPlusAdgroupId(d);if(tiktokCtaPortfolioKind(plan))return !!tiktokCtaPortfolioId(d);if(tiktokSmartPlusAdKind(plan))return !!tiktokSmartPlusAdId(d);if(tiktokSmartPlusMaterialStatusKind(plan))return tiktokSmartPlusMaterialStatusOutcome(plan,d);if(!plan.path.endsWith('/create/'))return true;
  const kind=segments[2]!,data=object(d.data);
  if(kind==='ad'){const ids=data.ad_ids??[data.ad_id];return Array.isArray(ids)&&ids.length===1&&typeof ids[0]==='string'&&/^\d+$/.test(ids[0]);}
  return hasId(data[kind+'_id'])||Array.isArray(data[kind+'_ids'])&&data[kind+'_ids'].length>0&&data[kind+'_ids'].every(hasId);
 }
 if(plan.gateway==='snapchat_native_action'){
  if(String(d.request_status).toUpperCase()!=='SUCCESS')return false;
  const kind=[...segments].reverse().find(k=>['campaigns','adsquads','ads','creatives','lead_generation_forms','segments'].includes(k))!,rows=d[kind];
  if(plan.method==='DELETE')return Array.isArray(rows)&&rows.length===0;
  const singular=kind==='adsquads'?'adsquad':kind.slice(0,-1),expected=Array.isArray(b[kind])?b[kind].length:1;
  return Array.isArray(rows)&&rows.length===expected&&rows.every((r,i)=>String(r.sub_request_status).toUpperCase()==='SUCCESS'&&hasId(r[singular]?.id)&&(plan.method==='POST'||String(r[singular].id)===String(plan.method==='PUT'?b[kind][i].id:last)));
 }
 if(plan.gateway==='linkedin_native_action')return result.status===201?hasId(result.headers['x-restli-id']):result.status===204;
 if(plan.gateway==='x_ads_native_action')return Array.isArray(d.data)?plan.method==='POST'&&d.data.length>0&&d.data.every(r=>hasId(r.id)):hasId(d.data?.id)&&(plan.method==='POST'||String(d.data.id)===last);
 if(plan.gateway==='dv360_native_action'){
  if(plan.method==='DELETE')return result.status===200&&result.data!==null&&Object.keys(d).length===0||result.status===204;
  const kind=plan.method==='POST'?last:segments.at(-2)!,key:Record<string,string>={campaigns:'campaignId',insertionOrders:'insertionOrderId',lineItems:'lineItemId',creatives:'creativeId'};return hasId(d[key[kind]!])&&(plan.method==='POST'||String(d[key[kind]!])===last);
 }
 return false;
}
export function validateState(read:CompiledRequest,result:TransportResult):void {
 if(isLinkedInRuleRead(read)){validateLinkedInRuleState(read,result);return;}
 if(isDV360TargetingRead(read)){validateDV360TargetingState(read,result);return;}
 if(isGoogleListingGroupRead(read)){validateGoogleListingGroupState(read,result);return;}
 if(isTiktokNegativeKeywordRead(read)){validateTiktokNegativeKeywordState(read,result);return;}
 if(isTiktokBrandSafetyRead(read)){validateTiktokBrandSafetyState(read,result);return;}
 if(isMetaValueRuleRead(read)){validateMetaValueRuleState(read,result);return;}
 if(isMetaObjectRead(read)){validateMetaObjectState(read,result);return;}
 if(isMetaImageRead(read)){validateMetaImageState(read,result);return;}
 if(isMetaConversionRead(read)){validateMetaConversionState(read,result);return;}
 if(isMetaBrandSafetyRead(read)){validateMetaBrandSafetyState(read,result);return;}
 if(isCriteoLineItemRead(read)){validateCriteoLineItemState(read,result);return;}
 if(isCriteoOverrideRead(read)){validateCriteoOverrideState(read,result);return;}
 if(isCriteoPreferredRead(read)){validateCriteoPreferredState(read,result);return;}
 if(isCriteoCatalogRead(read)){validateCriteoCatalogState(read,result);return;}
 if(isCriteoSegmentRead(read)){validateCriteoSegmentState(read,result);return;}
 if(isDV360AdGroupRead(read)){validateDV360AdGroupState(read,result);return;}
 if(isDV360AdAssetRead(read)){validateDV360AdAssetState(read,result);return;}
 if(isDV360AdRead(read)){validateDV360AdState(read,result);return;}
 if(isSnapchatMediaCopyRead(read)){validateSnapchatMediaCopyState(read,result);return;}
 if(isSnapDisclaimerRead(read)){validateSnapDisclaimerState(read,result);return;}
 if(isSnapSegmentDeleteRead(read)){validateSnapSegmentDeleteState(read,result);return;}
 if(isSnapConversionRead(read)){validateSnapConversionState(read,result);return;}
 if(isSnapProductSetRead(read)){validateSnapProductSetState(read,result);return;}
 if(isDV360LineItemBulkRead(read)){validateDV360LineItemBulkState(read,result);return;}
 if(isDV360LineItemDuplicateRead(read)){validateDV360LineItemDuplicateState(read,result);return;}
 if(isDV360InventoryGroupRead(read)){validateDV360InventoryGroupState(read,result);return;}
 if(isDV360AdvertiserRead(read)){validateDV360AdvertiserState(read,result);return;}
 if(isDV360BiddingRead(read)){validateDV360BiddingState(read,result);return;}
 if(isDV360SdfRead(read)){validateDV360SdfState(read,result);return;}
 if(isXTrackingTagRead(read)){validateXTrackingTagState(read,result);return;}
 if(isXPrerollCtaRead(read)){validateXPrerollCtaState(read,result);return;}
 if(isXMediaRead(read)){validateXMediaState(read,result);return;}
 if(isXScheduledRead(read)){validateXScheduledState(read,result);return;}
 if(isXAudienceRead(read)){validateXAudienceState(read,result);return;}
 if(isXAssociationRead(read)){validateXAssociationState(read,result);return;}
 if(isXCuratedRead(read)){validateXCuratedState(read,result);return;}
 if(isLinkedInLeadFormRead(read)){validateLinkedInLeadFormState(read,result);return;}
 if(isLinkedInConversionRead(read)){validateLinkedInConversionState(read,result);return;}
 if(isLinkedInTrackingRead(read)){validateLinkedInTrackingState(read,result);return;}
 if(isLinkedInThirdPartyRead(read)){validateLinkedInThirdPartyState(read,result);return;}
 if(isLinkedInInsightRead(read)){validateLinkedInInsightState(read,result);return;}
 if(isLinkedInAbRead(read)){validateLinkedInAbState(read,result);return;}
 if(isLinkedInMessageRead(read)){validateLinkedInMessageState(read,result);return;}
 if(isGoogleBidRead(read)){validateGoogleBidState(read,result);return;}
 if(isGoogleBrandGuidelinesRead(read)){validateGoogleBrandGuidelinesState(read,result);return;}
 if(isGoogleCustomerTypeRead(read)){validateGoogleCustomerTypeState(read,result);return;}
 if(isGoogleDraftRead(read)){validateGoogleDraftState(read,result);return;}
 if(isGoogleExperimentRead(read)){validateGoogleExperimentState(read,result);return;}
 if(isGoogleCustomerSettingsRead(read)){validateGoogleCustomerSettingsState(read,result);return;}
 if(isGoogleAutoAssetRead(read)){validateGoogleAutoAssetState(read,result);return;}
 if(isGoogleUploadRead(read)){validateGoogleUploadState(read,result);return;}
 if(isGoogleSubscriptionRead(read)){validateGoogleSubscriptionState(read,result);return;}
 if(isGoogleSmartRead(read)){validateGoogleSmartState(read,result);return;}
 if(isGoogleApplyRead(read)){validateGoogleApplyState(read,result);return;}
 if(read.metaLabelState){validateMetaLabelState(read,result);return;}
 if(read.criteoTargetState){validateCriteoTargetState(read,result);return;}
 if(read.gateway==='reddit_native_action'&&read.redditProfilesState){validateRedditProfiles(read,result);return;}
 if(read.gateway==='google_ads_native_action'&&read.googleKeywordPlanState){validateKeywordPlanTree(read,result);return;}
 if(read.gateway==='google_ads_native_action'&&read.googleAssetSetState){validateAssetSetContents(read,result);return;}
 if(read.gateway==='gtm_native_action'&&read.gtmWorkspaceState){validateGtmWorkspaceState(read,result);return;}
 if(read.gateway==='gtm_native_action'&&read.gtmState){validateGtmWorkflowState(read,result);return;}
 if(read.gateway==='dv360_native_action'&&read.dv360ListState&&!read.dv360ListState.collection&&result.status===404){const d=object(result.data);if(read.action!=='AMCP_STATE_OPTIONAL'||d.amcp_absent!==true||d.path!==read.path)fail('STATE_TARGET_MISMATCH','Unqualified absent DV360 target.');return;}
 if(read.gateway===microsoftGateway)validateMicrosoftResponse(read,result,true);
 if(result.status===404&&measurementWriteGateways.has(read.gateway)){validateMeasurementState(read,result);return;}
 if(read.gateway==='gtm_native_action'&&read.path.endsWith('/status')&&result.status===200){validateMeasurementState(read,result);return;}
 const data=object(result.data),id=normalizeAccount(read.gateway,read.accountId!);
 // Search Console's sitemap `errors` is a documented content-error count, not
 // a failed API envelope. Real error objects and malformed counts still fail.
 const sitemap=read.gateway==='google_search_console_native_action'&&read.path.includes('/sitemaps/');
 const sitemapCount=sitemap&&(typeof data.errors==='number'&&Number.isSafeInteger(data.errors)&&data.errors>=0||typeof data.errors==='string'&&/^\d+$/.test(data.errors));
 if(sitemap&&Object.hasOwn(data,'errors')&&!sitemapCount)fail('STATE_READ_FAILED','Search Console sitemap content-error counts must be nonnegative integers.');
 // ProtoJSON omits an empty repeated `results` field. Only a server-derived
 // optional association query can interpret that as absence, after raw errors
 // and continuation fields have still been checked.
 const optionalGoogle=read.gateway==='google_ads_native_action'&&read.googleState?.allowMissing===true;
 const emptyGoogle=optionalGoogle&&result.status===200&&result.data!==null&&typeof result.data==='object'&&!Array.isArray(result.data)&&data.results===undefined&&(Object.keys(data).length===0||typeof data.fieldMask==='string'||typeof data.queryResourceConsumption==='string');
 // A failed GA4 export is a readable job resource, not a failed HTTP read.
 // Preserve its native errorMessage for verification while still rejecting
 // API error envelopes, malformed errors and incomplete responses normally.
 const ga4Job=read.gateway==='ga4_native_action'&&/^\/v1(?:alpha|beta)\/properties\/\d+\/(?:audienceExports|reportTasks)\/[^/]+$/.test(read.path);
 let jobData=data;
 const withoutJobError=(value:JsonObject)=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='errorMessage'));
 if(ga4Job&&data.state==='FAILED'&&typeof data.errorMessage==='string')jobData=withoutJobError(jobData);
 if(ga4Job&&data.reportMetadata?.state==='FAILED'&&typeof data.reportMetadata.errorMessage==='string')jobData={...jobData,reportMetadata:withoutJobError(data.reportMetadata)};
 const statusResult=sitemapCount?{...result,data:{...data,errors:0}}:emptyGoogle?{...result,data:{...data,results:[]}}:jobData!==data?{...result,data:jobData}:result;
 if(read.gateway!==microsoftGateway&&writeOutcome(statusResult).success!==true)fail('STATE_READ_FAILED','Failed or partial provider responses cannot verify before-state.');
 // Published Instant Forms cannot be read by ID; every page is read through follow-up reads
 // (src/tiktok-instant-forms.ts), so their page information is expected rather than incomplete.
 if(validateTiktokInstantFormState(read,data))return;
 // Reuse provider pagination contracts (including Reddit pagination.next_url)
 // before envelope projection; discarding cursors is never proof of completeness.
 if(nextPage(read,data))fail('INCOMPLETE_STATE','State read was paginated; narrow the mutation.');
 const inspect=(v:unknown)=>{if(Array.isArray(v)){v.forEach(inspect);return;}if(!v||typeof v!=='object')return;
  const r=object(v);if(r.has_more===true||r.hasMore===true||r.nextPageToken||r.next_page_token||r.next_cursor&&r.next_cursor!=='0'||r.next_link||r.paging?.next||r.page_info?.total_page>1||Array.isArray(r.links)&&r.links.some((l:JsonObject)=>l.rel==='next'))fail('INCOMPLETE_STATE','State read was paginated; narrow the mutation.');Object.values(r).forEach(inspect);
 };inspect(data);
 if(read.gateway===microsoftGateway)return;
 if(measurementWriteGateways.has(read.gateway)){validateMeasurementState(read,result);return;}
 if(read.gateway==='dv360_native_action'&&(read.action==='AMCP_DV360_LIST_STATE'||read.dv360ListState)){validateDV360ListState(read,result);return;}
 if(read.gateway==='reddit_native_action'){validateRedditState(read,result);return;}
 const sameIds=(actual:unknown[],expected:unknown[])=>{const clean=(ids:unknown[])=>ids.map(x=>String(x)).sort();if(actual.length!==expected.length||stable(clean(actual))!==stable(clean(expected)))fail('STATE_TARGET_MISMATCH','State read did not return every exact requested target.');};
 if(read.gateway==='google_ads_native_action'){
  if(emptyGoogle)data.results=[];
  if(!Array.isArray(data.results)||!data.results.length&&!optionalGoogle)fail('STATE_NOT_FOUND','Google state query returned no target rows.');
  const q=String(object(read.body).query),type=q.match(/ FROM ([a-z_]+)/)?.[1];
  if(type==='customer'){sameIds(data.results.map((r:JsonObject)=>r.customer?.id),[id]);return;}
  if(!type)fail('STATE_READ_FAILED','Unrecognized Google state query.');
  const expected=[...q.matchAll(/'(customers\/[^']+)'/g)].map(m=>m[1]),camel=type.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),actual=data.results.map((r:JsonObject)=>(r[camel]??r[type])?.resourceName??(r[camel]??r[type])?.resource_name);
  if(optionalGoogle){if(read.googleState!.resource!==type||stable(read.googleState!.names)!==stable(expected)||new Set(actual).size!==actual.length||actual.some((name:unknown)=>typeof name!=='string'||!expected.includes(name)))fail('STATE_TARGET_MISMATCH','Optional state must contain only unique, exactly requested association identities.');}
  else sameIds(actual,expected);return;
 }
 if(read.gateway==='tiktok_native_action'){
  if(read.path==='/v1.3/identity/info/'){const info=data.data?.identity_info;if(data.code!==0||!info||typeof info!=='object'||Array.isArray(info))fail('STATE_READ_FAILED','TikTok identity info must confirm success and contain identity_info.');sameIds([info.identity_id],[read.query.identity_id]);return;}
  if(validateTiktokConversionState(read,data,sameIds)||validateTiktokSavedAudienceState(read,data,sameIds)||validateTiktokSmartPlusAdState(read,data,sameIds)||validateTiktokSmartPlusAdgroupCampaignState(read,data)||validateTiktokSmartPlusState(read,data,sameIds)||validateTiktokCtaPortfolioState(read,data,sameIds))return;
  if(data.code!==0||!Array.isArray(data.data?.list))fail('STATE_READ_FAILED','TikTok state must confirm success and contain its native list.');
  if(read.path===tiktokImageInfoPath){sameIds(data.data.list.map((r:JsonObject)=>r.image_id),read.query.image_ids);return;}
  if(read.path===tiktokAudienceGetPath){sameIds(data.data.list.map((r:JsonObject)=>r?.audience_details?.audience_id),read.query.custom_audience_ids);return;}
  const kind=read.path.split('/')[2]!,key=kind==='advertiser'?'advertiser_id':kind+'_id';
  sameIds(data.data.list.map((r:JsonObject)=>r[key]),kind==='advertiser'?[id]:read.query.filtering[kind+'_ids']);return;
 }
 const target=decodeURIComponent(read.path.split('/').at(-1)!).replace(/^act_/,'').split(':').at(-1);
 if(read.gateway==='meta_native_action'){
  if(metaCopyChildrenRead(read)){if(!Array.isArray(data.data))fail('STATE_READ_FAILED','Meta did not return the source ad list.');return;}
  sameIds([String(data.id).replace(/^act_/,'')],[target]);
  if(String(read.query.fields).split(',').includes('status')&&!Object.hasOwn(data,'status'))fail('STATE_READ_FAILED','Meta did not return the requested target status.');return;
 }
 if(read.gateway==='snapchat_native_action'){
  const kind=read.path.split('/').at(-2)!,rows=data[kind];if(!Array.isArray(rows)||rows.length!==1)fail('STATE_READ_FAILED','Snapchat must return one exact target record.');const singular=kind==='adsquads'?'adsquad':kind==='media'?'media':kind.slice(0,-1);sameIds(rows.map((r:JsonObject)=>(r[singular]??r).id),[target]);return;
 }
 if(read.gateway==='x_ads_native_action'){sameIds([data.data?.id],[target]);return;}
 if(read.gateway==='linkedin_native_action'){const exact=decodeURIComponent(read.path.split('/').at(-1)!);if(exact.startsWith('urn:li:')&&data.id!==exact)fail('STATE_TARGET_MISMATCH','LinkedIn returned a different resource URN.');sameIds([String(data.id??'').split(':').at(-1)],[target]);return;}
 if(read.gateway==='dv360_native_action'){const key:Record<string,string>={advertisers:'advertiserId',campaigns:'campaignId',insertionOrders:'insertionOrderId',lineItems:'lineItemId',creatives:'creativeId',adAssets:'adAssetId'};sameIds([data[key[read.path.split('/').at(-2)!]!]], [target]);return;}
 fail('STATE_READ_FAILED','No response contract exists for this state read.');
}
export function assertWriteShape(plan:CompiledRequest){
 assertProviderActionAvailable(plan);
 validateGoogleRequest(plan);
 validateMetaCampaign(plan);
 if(!writeContractGateways.has(plan.gateway))fail('WRITE_CONTRACT_UNAVAILABLE','This platform has no reviewed mutation contract.');
 if(plan.readOnly)fail('MUTATION_REQUIRED','Use the original native gateway to perform this read.');
 if(linkedinTemplateKind(plan)){assertLinkedInTemplate(plan);return;}
 if(xTargetingBatchRoute(plan)){assertXTargetingBatch(plan);return;}
 if(googlePreviewKind(plan)){assertGooglePreview(plan);return;}
 if(plan.gateway==='reddit_native_action'){assertRedditWrite(plan);return;}
 if(plan.gateway===microsoftGateway){assertMicrosoftWrite(plan);return;}
 if(plan.specialTransport)fail('WRITE_CONTRACT_UNAVAILABLE','For Google Drive media imports, use amcp_media prepare and execute. Other binary transports need a dedicated upload contract.');
 if(placeActionKind(plan)){assertPlaceAction(plan);return;}
 if(businessNotificationKind(plan)){assertBusinessNotification(plan);return;}
 if(businessAccessKind(plan)){assertBusinessAccess(plan);return;}
 if(googleDismissalKind(plan)){assertGoogleDismissal(plan);return;}
 if(googleAccessKind(plan)){assertGoogleAccess(plan);return;}
 if(linkedinRuleKind(plan)){assertLinkedInRule(plan);return;}
 if(linkedinLeadFormKind(plan)){assertLinkedInLeadForm(plan);return;}
 if(linkedinConversionKind(plan)){assertLinkedInConversion(plan);return;}
 if(linkedinTrackingKind(plan)){assertLinkedInTracking(plan);return;}
 if(linkedinThirdPartyKind(plan)){assertLinkedInThirdParty(plan);return;}
 if(linkedinInsightKind(plan)){assertLinkedInInsight(plan);return;}
 if(linkedinAbKind(plan)){assertLinkedInAb(plan);return;}
 if(linkedinMessageKind(plan)){assertLinkedInMessage(plan);return;}
 if(googleBrandGuidelinesKind(plan)){assertGoogleBrandGuidelines(plan);return;}
 if(googleCustomerTypeKind(plan)){assertGoogleCustomerTypes(plan);return;}
 if(googleDraftKind(plan)){assertGoogleDrafts(plan);return;}
 if(googleExperimentKind(plan)){assertGoogleExperiments(plan);return;}
 if(googleCustomerSettingsKind(plan)){assertGoogleCustomerSettings(plan);return;}
 if(googleAutoAssetKind(plan)){assertGoogleAutoAssets(plan);return;}
 if(googleUploadKind(plan)){assertGoogleUploads(plan);return;}
 if(googleSubscriptionKind(plan)){assertGoogleSubscriptions(plan);return;}
 if(googleSmartKind(plan)){assertGoogleSmart(plan);return;}
 if(googleApplyKind(plan)){assertGoogleApply(plan);return;}
 if(xDraftKind(plan)){assertXDraft(plan);return;}
 if(xTrackingTagKind(plan)){assertXTrackingTag(plan);return;}
 if(xPrerollCtaKind(plan)){assertXPrerollCta(plan);return;}
 if(xMediaKind(plan)){assertXMedia(plan);return;}
 if(xScheduledKind(plan)){assertXScheduled(plan);return;}
 if(xAudienceKind(plan)){assertXAudience(plan);return;}
 if(xAssociationKind(plan)){assertXAssociation(plan);return;}
 if(xCuratedKind(plan)){assertXCurated(plan);return;}
 if(dv360TargetingKind(plan)){assertDV360Targeting(plan);return;}
 if(googleListingGroupKind(plan)){assertGoogleListingGroups(plan);return;}
 if(tiktokNegativeKeywordKind(plan)){assertTiktokNegativeKeywords(plan);return;}
 if(tiktokBrandSafetyKind(plan)){assertTiktokBrandSafety(plan);return;}
 if(metaValueRuleKind(plan)){assertMetaValueRule(plan);return;}
 if(metaObjectKind(plan)){assertMetaObject(plan);return;}
 if(metaImageKind(plan)){assertMetaImage(plan);return;}
 if(metaConversionKind(plan)){assertMetaConversion(plan);return;}
 if(metaBrandSafetyKind(plan)){assertMetaBrandSafety(plan);return;}
 if(criteoLineItemKind(plan)){assertCriteoLineItem(plan);return;}
 if(criteoOverrideKind(plan)){assertCriteoOverride(plan);return;}
 if(criteoPreferredKind(plan)){assertCriteoPreferred(plan);return;}
 if(criteoCatalogKind(plan)){assertCriteoCatalog(plan);return;}
 if(criteoSegmentKind(plan)){assertCriteoSegments(plan);return;}
 if(criteoPromotedProductsKind(plan)){assertCriteoPromotedProducts(plan);return;}
 if(criteoKeywordKind(plan)||criteoBidMultiplierKind(plan)){assertCriteoKeywords(plan);assertCriteoBidMultipliers(plan);return;}
 if(dv360AdGroupKind(plan)){assertDV360AdGroup(plan);return;}
 if(dv360AdAssetKind(plan)){assertDV360AdAsset(plan);return;}
 if(dv360AdKind(plan)){assertDV360Ad(plan);return;}
 if(dv360LineItemBulkKind(plan)){assertDV360LineItemBulk(plan);return;}
 if(dv360LineItemDuplicateKind(plan)){assertDV360LineItemDuplicate(plan);return;}
 if(dv360InventoryGroupKind(plan)){assertDV360InventoryGroup(plan);return;}
 if(dv360AdvertiserKind(plan)){assertDV360Advertiser(plan);return;}
 if(dv360BiddingKind(plan)){assertDV360Bidding(plan);return;}
 if(dv360SdfKind(plan)){assertDV360Sdf(plan);return;}
 if(plan.headers['X-HTTP-Method-Override']||plan.headers['X-RestLi-Method']&&!['CREATE','PARTIAL_UPDATE','DELETE'].includes(plan.headers['X-RestLi-Method'].toUpperCase()))fail('WRITE_CONTRACT_UNAVAILABLE','This REST.li method override is not qualified for reviewed execution.');
 if(gtmWorkflowKind(plan)){assertGtmWorkflow(plan);return;}
 if(gtmWorkspaceKind(plan)){assertGtmWorkspace(plan);return;}
 if(linkedinDSC(plan)){if(Object.keys(plan.query).length)fail('WRITE_CONTRACT_UNAVAILABLE','DSC creation does not accept query actions or method overrides.');assertLinkedInDSC(plan);return;}
 const body=object(plan.body);
 const route=plan.path,method=plan.method;
 if(measurementWriteGateways.has(plan.gateway))assertMeasurementWrite(plan);
 const supported=reviewedWriteFamily(plan);
 if(!supported)fail('WRITE_CONTRACT_UNAVAILABLE','This route is outside the reviewed campaign-management execution contracts. Use a local dry run.');
 if(dv360ListKind(plan))assertDV360ListWrite(plan);
 if(criteoTargetingKind(plan))assertCriteoTargeting(plan);
 if(metaReportKind(plan))assertMetaReport(plan);
 if(criteoCampaignKind(plan))assertCriteoCampaign(plan);
 if(snapUpdateKind(plan)){assertSnapUpdate(plan);return;}
 if(snapchatMediaCopyKind(plan)){assertSnapchatMediaCopy(plan);return;}
 if(snapDisclaimerKind(plan)){assertSnapDisclaimers(plan);return;}
 if(snapSegmentDeleteKind(plan)){assertSnapSegmentDelete(plan);return;}
 if(snapConversionKind(plan)){assertSnapConversion(plan);return;}
 if(snapProductSetKind(plan)){assertSnapProductSet(plan);return;}
 if(xReportKind(plan)){assertXReport(plan);return;}
 if(tiktokReportKind(plan))assertTiktokReport(plan);
 if(criteoReportKind(plan))assertCriteoReport(plan);
 if(metaLabelKind(plan))assertMetaLabel(plan);
 if(plan.gateway==='meta_native_action'&&route.endsWith('/adcreatives'))validateMetaCreative(body);
 if(Object.keys(plan.query).some(k=>!(plan.gateway==='dv360_native_action'&&k==='updateMask'||plan.gateway==='gtm_native_action'&&k==='fingerprint')))fail('WRITE_CONTRACT_UNAVAILABLE','Reviewed writes accept body fields and qualified concurrency parameters only.');
 if(plan.gateway==='linkedin_native_action'&&method==='POST'&&/^\/rest\/adAccounts\/[^/]+\/[^/]+\/[^/]+$/.test(route)&&(!body.patch||plan.headers['X-RestLi-Method']?.toUpperCase()!=='PARTIAL_UPDATE'))fail('WRITE_CONTRACT_UNAVAILABLE','LinkedIn entity POST requires a native patch and restli_method PARTIAL_UPDATE.');
 if(['method','_method','http_method','method_override','batch','adbatch'].some(k=>plan.query[k]!==undefined||body[k]!==undefined)||/\/batch\//.test(plan.path))fail('WRITE_CONTRACT_UNAVAILABLE','Batch and method-tunneled writes require individual reviewed native requests.');
 if(plan.method==='GET'||plan.method==='HEAD')fail('WRITE_CONTRACT_UNAVAILABLE','Side-effecting GET/HEAD actions are not qualified for execution.');
 const expect=(record:JsonObject,key:string,values:string[])=>{if(!values.includes(record[key]))fail('PAUSED_CREATION_REQUIRED','New serving entities require an explicit paused or draft state.',{field:key,allowed:values});};
 if(plan.gateway==='meta_native_action'&&/^\/v[^/]+\/act_[^/]+\/(campaigns|adsets|ads)$/.test(plan.path)&&plan.method==='POST')expect(body,'status',['PAUSED']);
 if(plan.gateway==='tiktok_native_action'&&/^\/v1\.3\/(?:campaign|adgroup)\/create\/$/.test(plan.path))expect(body,'operation_status',['DISABLE']);
 if(tiktokIdentityKind(plan))assertTiktokIdentity(plan,body);
 if(metaCopyKind(plan))assertMetaCopy(plan,body);
 if(tiktokLookalikeKind(plan))assertTiktokLookalike(plan,body);
 if(metaLookalikeKind(plan))assertMetaLookalike(body);
 if(tiktokBudgetKind(plan))assertTiktokBudget(plan,body);
 if(tiktokCustomConversionKind(plan))assertTiktokCustomConversion(plan,body);
 if(tiktokSavedAudienceKind(plan))assertTiktokSavedAudience(plan,body);
 if(tiktokSmartPlusStatusKind(plan))assertTiktokSmartPlusStatus(plan,body);
 if(tiktokSmartPlusBudgetKind(plan))assertTiktokSmartPlusBudget(plan,body);
 if(tiktokSmartPlusCampaignKind(plan))assertTiktokSmartPlusCampaign(plan,body);
 if(tiktokSmartPlusAdgroupKind(plan))assertTiktokSmartPlusAdgroup(plan,body);
 if(tiktokSmartPlusCampaignUpdateKind(plan))assertTiktokSmartPlusCampaignUpdate(plan,body);
 if(plan.gateway==='tiktok_native_action')tiktokAdgroupConversion(plan);
 if(tiktokCtaPortfolioKind(plan))assertTiktokCtaPortfolio(plan,body);
 if(tiktokSmartPlusAdKind(plan))assertTiktokSmartPlusAd(plan,body);
 if(tiktokSmartPlusAdUpdateKind(plan))assertTiktokSmartPlusAdUpdate(plan,body);
 if(tiktokSmartPlusAdgroupUpdateKind(plan))assertTiktokSmartPlusAdgroupUpdate(plan,body);
 if(tiktokSmartPlusMaterialStatusKind(plan))assertTiktokSmartPlusMaterialStatus(plan,body);
 if(plan.gateway==='tiktok_native_action')tiktokCtaReferences(plan);
 if(plan.gateway==='tiktok_native_action'&&plan.path==='/v1.3/ad/create/'){
  if(!Array.isArray(body.creatives)||body.creatives.length!==1||!body.creatives[0]||Array.isArray(body.creatives[0])||typeof body.creatives[0]!=='object')fail('WRITE_CONTRACT_UNAVAILABLE','Reviewed TikTok ad creation requires exactly one native creatives record per review. Put the ad fields and operation_status inside that record.');
  if(Object.hasOwn(body,'operation_status'))fail('INVALID_ARGUMENT','TikTok ad creation uses creatives[0].operation_status; a top-level status does not pause the creative.');
  expect(body.creatives[0],'operation_status',['DISABLE']);
 }
 if(plan.gateway==='snapchat_native_action'&&plan.method==='POST'){
  const kind=plan.path.split('/').at(-1)!;if(!Array.isArray(body[kind])||!body[kind].length||body[kind].length>25)fail('MISSING_PAYLOAD','Provide 1–25 native '+kind+' records.');if(kind==='lead_generation_forms')assertSnapLeadForms(plan,body[kind]);else if(kind==='segments')assertSnapSegments(plan,body[kind]);else if(kind==='creatives')assertSnapLeadCreativeRefs(body[kind]);else for(const row of body[kind])expect(object(row),'status',['PAUSED']);
 }
 if(plan.gateway==='snapchat_native_action'&&plan.method==='PUT'&&/^\/v1\/adaccounts\/[^/]+\/segments$/.test(plan.path)){
  if(!Array.isArray(body.segments)||!body.segments.length||body.segments.length>25)fail('MISSING_PAYLOAD','Provide 1–25 native segments records.');assertSnapSegmentUpdates(plan,body.segments);
 }
 if(plan.gateway==='snapchat_native_action'&&plan.method==='PATCH'){
  if(!Array.isArray(plan.body)||!plan.body.length||plan.body.length>25||plan.body.some(op=>!op||!['add','remove','replace','test'].includes(op.op)||typeof op.path!=='string'||!/^\/[a-zA-Z0-9_/-]+$/.test(op.path)||op.path.split('/').some((part:string)=>['__proto__','constructor','prototype'].includes(part))||op.op!=='remove'&&!Object.hasOwn(op,'value')))fail('INVALID_PATCH','Use 1–25 native JSON Patch add, remove, replace or test operations.');
 }
 if(plan.gateway==='x_ads_native_action'&&/^\/12\/accounts\/[^/]+\/(campaigns|line_items)$/.test(plan.path)&&plan.method==='POST')expect(body,'entity_status',['PAUSED']);
 assertXCreative(plan);
 assertXTargeting(plan);
 if(plan.gateway==='linkedin_native_action'&&/^\/rest\/adAccounts\/[^/]+\/(adCampaigns|adCampaignGroups|creatives)$/.test(plan.path)&&plan.method==='POST'){
  const creative=plan.path.endsWith('/creatives');if(creative&&Object.hasOwn(body,'status'))fail('INVALID_ARGUMENT','LinkedIn creatives use intendedStatus; remove the unsupported status field.');
  expect(body,creative?'intendedStatus':'status',['PAUSED','DRAFT']);
 }
 if(plan.gateway==='dv360_native_action'&&/^\/v\d+\/advertisers\/[^/]+\/(campaigns|insertionOrders|lineItems)$/.test(plan.path)&&plan.method==='POST')expect(body,'entityStatus',['ENTITY_STATUS_PAUSED','ENTITY_STATUS_DRAFT']);
 if(plan.gateway==='google_ads_native_action'){
  if(!Array.isArray(body.operations)||!body.operations.length||body.operations.length>25)fail('WRITE_CONTRACT_UNAVAILABLE','Reviewed Google mutations require 1–25 homogeneous native operations.');
  if(/\/(campaigns|adGroups|adGroupAds|assetGroups):mutate$/.test(plan.path))for(const op of body.operations)if(op.create)expect(op.create,'status',['PAUSED']);
  if(body.partial_failure===true||body.partialFailure===true)fail('WRITE_CONTRACT_UNAVAILABLE','Execute homogeneous Google mutations atomically; partial_failure must be false.');
  if(body.validate_only===true||body.validateOnly===true)fail('WRITE_CONTRACT_UNAVAILABLE','This tool executes mutations; use a local dry run for validation-only plans.');
  for(const op of body.operations)if(!op||typeof op!=='object'||['create','update','remove'].filter(k=>op[k]!==undefined).length!==1)fail('INVALID_MUTATION','Each Google operation must contain exactly one create, update or remove.');
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

/** Reads are explicitly derived from the target, never supplied by the caller as proof. */
export function snapshotPlans(plan:CompiledRequest,registry:Registry):CompiledRequest[]{
 if(snapUpdateKind(plan))return snapUpdateSnapshots(plan);
 if(snapchatMediaCopyKind(plan))return snapchatMediaCopySnapshots(plan);
 if(snapDisclaimerKind(plan))return snapDisclaimerSnapshots(plan);
 if(snapSegmentDeleteKind(plan))return snapSegmentDeleteSnapshots(plan);
 if(snapConversionKind(plan))return snapConversionSnapshots(plan);
 if(snapProductSetKind(plan))return snapProductSetSnapshots(plan);
 if(googlePreviewKind(plan))return googlePreviewSnapshots(plan);
 if(placeActionKind(plan))return placeActionSnapshots(plan);
 if(businessNotificationKind(plan))return businessNotificationSnapshots(plan);
 if(businessAccessKind(plan))return businessAccessSnapshots(plan);
 if(googleDismissalKind(plan))return googleDismissalSnapshots(plan);
 if(googleAccessKind(plan))return googleAccessSnapshots(plan);
 if(linkedinTemplateKind(plan))return linkedinTemplateSnapshots(plan);
 if(xTargetingBatchRoute(plan))return xTargetingBatchSnapshots(plan);
 if(xDraftKind(plan))return xDraftSnapshots(plan);
 if(linkedinRuleKind(plan))return linkedinRuleSnapshots(plan);
 if(linkedinConversionKind(plan))return linkedinConversionSnapshots(plan);
 if(linkedinTrackingKind(plan))return linkedinTrackingSnapshots(plan);
 if(linkedinThirdPartyKind(plan))return linkedinThirdPartySnapshots(plan);
 if(linkedinInsightKind(plan))return linkedinInsightSnapshots(plan);
 if(linkedinAbKind(plan))return linkedinAbSnapshots(plan);
 if(linkedinMessageKind(plan))return linkedinMessageSnapshots(plan);
 if(googleBidKind(plan))return googleBidSnapshots(plan);
 if(googleBrandGuidelinesKind(plan))return googleBrandGuidelinesSnapshots(plan);
 if(googleCustomerTypeKind(plan))return googleCustomerTypeSnapshots(plan);
 if(googleDraftKind(plan))return googleDraftSnapshots(plan);
 if(googleExperimentKind(plan))return googleExperimentSnapshots(plan);
 if(googleCustomerSettingsKind(plan))return googleCustomerSettingsSnapshots(plan);
 if(googleAutoAssetKind(plan))return googleAutoAssetSnapshots(plan);
 if(googleUploadKind(plan))return googleUploadSnapshots(plan);
 if(googleSubscriptionKind(plan))return googleSubscriptionSnapshots(plan);
 if(googleSmartKind(plan))return googleSmartSnapshots(plan);
 if(googleApplyKind(plan))return googleApplySnapshots(plan);
 if(googleBiddingEventKind(plan))return googleBiddingEventSnapshots(plan);
 if(googlePortfolioKind(plan))return googlePortfolioSnapshots(plan);
 if(googleConversionActionKind(plan))return googleConversionActionSnapshots(plan);
 if(googleConversionGoalKind(plan))return googleConversionGoalSnapshots(plan);
 if(metaReportKind(plan))return metaReportSnapshots(plan);
 if(criteoCampaignKind(plan))return criteoCampaignSnapshots(plan);
 if(xReportKind(plan))return xReportSnapshots(plan);
 if(tiktokReportKind(plan))return tiktokReportSnapshots(plan);
 if(criteoReportKind(plan))return criteoReportSnapshots(plan);
 if(metaLabelKind(plan))return metaLabelSnapshots(plan);
 if(criteoTargetingKind(plan))return criteoTargetingSnapshots(plan);
 if(gtmWorkflowKind(plan))return gtmWorkflowSnapshots(plan);
 if(gtmWorkspaceKind(plan))return gtmWorkspaceSnapshots(plan);
 if(dv360TargetingKind(plan))return dv360TargetingSnapshots(plan);
 if(googleListingGroupKind(plan))return googleListingGroupSnapshots(plan);
 if(tiktokNegativeKeywordKind(plan))return tiktokNegativeKeywordReads(plan);
 if(tiktokBrandSafetyKind(plan))return tiktokBrandSafetyReads(plan);
 if(metaValueRuleKind(plan))return metaValueRuleReads(plan);
 if(metaObjectKind(plan))return metaObjectSnapshots(plan);
 if(metaImageKind(plan))return metaImageSnapshots(plan);
 if(metaConversionKind(plan))return metaConversionSnapshots(plan);
 if(metaBrandSafetyKind(plan))return metaBrandSafetyReads(plan);
 if(criteoLineItemKind(plan))return criteoLineItemReads(plan);
 if(criteoOverrideKind(plan))return criteoOverrideSnapshots(plan);
 if(criteoPreferredKind(plan))return criteoPreferredSnapshots(plan);
 if(criteoCatalogKind(plan))return criteoCatalogSnapshots(plan);
 if(criteoSegmentKind(plan))return criteoSegmentSnapshots(plan);
 if(criteoPromotedProductsKind(plan))return criteoPromotedProductsReads(plan);
 if(criteoKeywordKind(plan)||criteoBidMultiplierKind(plan))return criteoLineItemBiddingReads(plan);
 if(dv360AdGroupKind(plan))return dv360AdGroupReads(plan);
 if(dv360AdAssetKind(plan))return dv360AdAssetReads(plan);
 if(dv360AdKind(plan))return dv360AdReads(plan);
 if(dv360LineItemBulkKind(plan))return dv360LineItemBulkSnapshots(plan);
 if(dv360LineItemDuplicateKind(plan))return dv360LineItemDuplicateSnapshots(plan);
 if(dv360InventoryGroupKind(plan))return dv360InventoryGroupSnapshots(plan);
 if(dv360AdvertiserKind(plan))return dv360AdvertiserSnapshots(plan);
 if(dv360BiddingKind(plan))return dv360BiddingSnapshots(plan);
 if(dv360SdfKind(plan))return dv360SdfSnapshots(plan);
 if(xTrackingTagKind(plan))return xTrackingTagSnapshots(plan);
 if(xPrerollCtaKind(plan))return xPrerollCtaSnapshots(plan);
 if(xMediaKind(plan))return xMediaSnapshots(plan);
 if(xScheduledKind(plan))return xScheduledSnapshots(plan);
 if(xAudienceKind(plan))return xAudienceSnapshots(plan);
 if(xAssociationKind(plan))return xAssociationSnapshots(plan);
 if(xCuratedKind(plan))return xCuratedSnapshots(plan);
 if(dv360ListKind(plan))return dv360ListSnapshots(plan);
 if(googleConfigurationKind(plan))return googleConfigurationSnapshots(plan);
 if(googleAssetLinkKind(plan))return googleAssetLinkSnapshots(plan);
 if(linkedinDSC(plan))return linkedinDSCReads(plan);
 if(xCreativeKind(plan))return xCreativeSnapshots(plan);
 if(googleTargetingKind(plan))return googleTargetingSnapshots(plan);
 if(xTargetingKind(plan))return xTargetingSnapshots(plan);
 if(plan.gateway==='reddit_native_action')return redditSnapshots(plan);
 if(plan.gateway===microsoftGateway)return microsoftSnapshots(plan);
 if(measurementWriteGateways.has(plan.gateway))return measurementSnapshots(plan);
 const base=(path:string,query:JsonObject={},body?:JsonObject,method='GET'):CompiledRequest=>applyExecutionRisk({...plan,action:'AMCP_STATE_READ',method,path,query,body,headers:plan.gateway==='linkedin_native_action'?Object.fromEntries(Object.entries(plan.headers).filter(([k])=>['LinkedIn-Version','X-Restli-Protocol-Version'].includes(k))):{},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,specialTransport:undefined});
 const id=normalizeAccount(plan.gateway,plan.accountId!),body=object(plan.body);
 if(linkedinLeadFormKind(plan))return [base('/rest/adAccounts/'+id)];
 if(plan.gateway==='google_ads_native_action'){
  const kind=plan.path.match(/\/([^/]+):mutate$/)?.[1],map:Record<string,string>={assets:'asset',campaigns:'campaign',adGroups:'ad_group',adGroupAds:'ad_group_ad',campaignBudgets:'campaign_budget',ads:'ad',assetGroups:'asset_group',campaignCriteria:'campaign_criterion',adGroupCriteria:'ad_group_criterion'};
  if(!kind||!map[kind])fail('WRITE_CONTRACT_UNAVAILABLE','This Google mutation has no implemented state-read contract.');
  const resource=map[kind]!,snapshots:CompiledRequest[]=[],fields=new Set([resource+'.resource_name']),names:string[]=[];
  for(const op of body.operations){const record=object(op.update),name=op.remove??record.resource_name??record.resourceName;
   if(name!==undefined){if(typeof name!=='string'||!new RegExp('^customers/'+id+'/'+kind+'/[0-9~_-]+$').test(name))fail('ACCOUNT_SCOPE_MISMATCH','Google mutation resource does not match the selected customer/type.');names.push(name);}
   if(op.update){const mask=op.update_mask??op.updateMask;if(typeof mask!=='string'||!mask)fail('MISSING_UPDATE_MASK','Updates require an explicit field mask.');for(const f of mask.split(',')){if(!/^[A-Za-z][A-Za-z0-9_.]*$/.test(f))fail('INVALID_UPDATE_MASK','Invalid field mask.');fields.add(resource+'.'+snake(f));}}
   if(op.remove){const deletionFields:Record<string,string[]>={asset:['name','type'],campaign:['name','status','campaign_budget','advertising_channel_type'],ad_group:['name','status','campaign','cpc_bid_micros'],ad_group_ad:['status','ad.id','ad.final_urls'],campaign_budget:['name','amount_micros','delivery_method'],ad:['name','final_urls'],asset_group:['name','status','campaign']};for(const f of deletionFields[resource]??[])fields.add(resource+'.'+f);}
  }
  const search=(query:string)=>base('/v23/customers/'+id+'/googleAds:search',{}, {query},'POST');
  if(names.length)snapshots.push(search('SELECT '+[...fields].join(', ')+' FROM '+resource+' WHERE '+resource+'.resource_name IN ('+names.map(n=>"'"+n+"'").join(', ')+')'));
  if(body.operations.some((op:JsonObject)=>op.create))snapshots.push(search('SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1'));
  const parents:Record<string,{kind:string;fields:string}>= {campaign_budget:{kind:'campaignBudgets',fields:'campaign_budget.resource_name, campaign_budget.amount_micros'},campaign:{kind:'campaigns',fields:'campaign.resource_name, campaign.status, campaign.campaign_budget'},ad_group:{kind:'adGroups',fields:'ad_group.resource_name, ad_group.status, ad_group.campaign'}};
  const seen=new Set<string>();for(const op of body.operations)for(const [field,parent]of Object.entries(parents)){
   const record=object(op.create??op.update),name=record[field]??record[field.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase())];if(name===undefined||seen.has(name))continue;
   if(typeof name!=='string'||!new RegExp('^customers/'+id+'/'+parent.kind+'/[0-9]+$').test(name))fail('INVALID_PARENT_RESOURCE','Parent resources must exist in the selected customer. Create temporary resources in a separate review.');
   seen.add(name);snapshots.push(search('SELECT '+parent.fields+' FROM '+field+' WHERE '+field+'.resource_name IN (\''+name+'\')'));
  }
  if(!snapshots.length)fail('WRITE_CONTRACT_UNAVAILABLE','Each operation must contain create, update or remove.');return snapshots;
 }
 if(plan.gateway==='tiktok_native_action'){
  if(tiktokCustomConversionKind(plan))return tiktokCustomConversionReads(plan).map(r=>{const read=base(r.path,r.query);read.action=r.action;return read;});
  if(tiktokSmartPlusStatusKind(plan)){const r=tiktokSmartPlusStatusRead(plan),read=base(r.path,r.query);read.action=r.action;return [read];}
  if(tiktokSmartPlusBudgetKind(plan)){const r=tiktokSmartPlusBudgetRead(plan),read=base(r.path,r.query);read.action=r.action;return [read];}
  if(tiktokSmartPlusCampaignKind(plan))return [base('/v1.3/advertiser/info/',{advertiser_ids:[id]})];
  if(tiktokCtaPortfolioKind(plan))return [base('/v1.3/advertiser/info/',{advertiser_ids:[id]})];
  if(tiktokSmartPlusAdKind(plan))return tiktokSmartPlusAdReads(plan).map(r=>{const read=base(r.path,r.query);read.action=r.action;return read;});
  if(tiktokSmartPlusAdUpdateKind(plan))return tiktokSmartPlusAdUpdateReads(plan).map(r=>{const read=base(r.path,r.query);read.action=r.action;return read;});
  if(tiktokSmartPlusAdgroupUpdateKind(plan)){const r=tiktokSmartPlusAdgroupUpdateRead(plan),read=base(r.path,r.query);read.action=r.action;return [read];}
  if(tiktokSmartPlusMaterialStatusKind(plan)){const r=tiktokSmartPlusMaterialStatusRead(plan),read=base(r.path,r.query);read.action=r.action;return [read];}
  if(tiktokSmartPlusCampaignUpdateKind(plan)){const r=tiktokSmartPlusCampaignUpdateRead(plan),read=base(r.path,r.query);read.action=r.action;return [read];}
  if(tiktokSmartPlusAdgroupKind(plan))return [base('/v1.3/advertiser/info/',{advertiser_ids:[id]}),...tiktokSmartPlusAdgroupReads(plan).map(r=>{const read=base(r.path,r.query);read.action=r.action;return read;})];
  if(tiktokSavedAudienceKind(plan)){const reads=[base('/v1.3/advertiser/info/',{advertiser_ids:[id]})],audiences=tiktokSavedAudienceAudiences(plan);if(audiences.length){const read=base(tiktokAudienceGetPath,{advertiser_id:id,custom_audience_ids:audiences});read.action='tiktok_dmp_custom_audience_get';reads.push(read);}return reads;}
  if(tiktokBudgetKind(plan)){const read=base('/v1.3/adgroup/get/',{advertiser_id:id,filtering:{adgroup_ids:tiktokBudgetAdgroupIds(plan)},page_size:100});read.action='tiktok_adgroup_get';return [read];}
  if(tiktokLookalikeKind(plan)){const seed=base(tiktokAudienceGetPath,{advertiser_id:id,custom_audience_ids:[tiktokLookalikeSeed(plan)]});seed.action='tiktok_dmp_custom_audience_get';return [base('/v1.3/advertiser/info/',{advertiser_ids:[id]}),seed];}
  if(tiktokIdentityKind(plan)){
   const reads=[base('/v1.3/advertiser/info/',{advertiser_ids:[id]})],image=tiktokIdentityImage(plan);
   if(image!==undefined){const read=base(tiktokImageInfoPath,{advertiser_id:id,image_ids:[image]});read.action='tiktok_file_image_ad_info_get';reads.push(read);}
   return reads;
  }
  const match=/^\/v1\.3\/(campaign|adgroup|ad)\/(?:status\/)?(create|update|delete)\/$/.exec(plan.path);
  if(!match)fail('WRITE_CONTRACT_UNAVAILABLE','This TikTok action has no implemented state-read contract.');
  if(match[2]==='create'){
   const reads=[base('/v1.3/advertiser/info/',{advertiser_ids:[id]})],parent=match[1]==='adgroup'?'campaign':match[1]==='ad'?'adgroup':undefined;
   if(parent){const parentId=body[parent+'_id'];if(typeof parentId!=='string'||!/^\d+$/.test(parentId))fail('MISSING_PARAMETER','Child creates require their exact parent ID.');const read=base('/v1.3/'+parent+'/get/',{advertiser_id:id,filtering:{[parent+'_ids']:[parentId]},page_size:100});read.action='tiktok_'+parent+'_get';reads.push(read);}
   const conversion=tiktokAdgroupConversionRead(plan);if(conversion){const read=base(conversion.path,conversion.query);read.action=conversion.action;reads.push(read);}
   for(const r of tiktokCtaPortfolioReads(plan)){const read=base(r.path,r.query);read.action=r.action;reads.push(read);}
   return reads;
  }
  const kind=match[1]!,ids=body[kind+'_ids']??(body[kind+'_id']?[body[kind+'_id']]:undefined);
  if(!Array.isArray(ids)||!ids.length||ids.length>25||ids.some(v=>typeof v!=='string'||!/^\d+$/.test(v)))fail('MISSING_PARAMETER','Supply 1–25 exact '+kind+' IDs.');
  const read=base('/v1.3/'+kind+'/get/',{advertiser_id:id,filtering:{[kind+'_ids']:ids},page_size:100});read.action='tiktok_'+kind+'_get';return [read,...tiktokCtaPortfolioReads(plan).map(r=>{const portfolio=base(r.path,r.query);portfolio.action=r.action;return portfolio;})];
 }
 if(plan.gateway==='meta_native_action'){
  if(metaCopyKind(plan))return metaCopySnapshots(plan).map(r=>base(r.path,r.query));
  const create=/^\/v[^/]+\/act_[^/]+\//.test(plan.path)&&plan.method==='POST';
  if(create){const reads=[base(plan.path.match(/^\/v[^/]+\/act_[^/]+/)![0],{fields:'id,account_status,currency'})];const parent=plan.path.endsWith('/adsets')?body.campaign_id:plan.path.endsWith('/ads')?body.adset_id:undefined;
   if(plan.path.endsWith('/adsets')||plan.path.endsWith('/ads')){if(typeof parent!=='string'||!/^\d+$/.test(parent))fail('MISSING_PARAMETER','Child creates require their exact parent ID.');reads.push(base(plan.path.split('/').slice(0,2).join('/')+'/'+parent,{fields:'id,name,status'}));}if(metaCreativeCreate(plan))reads.push(...metaCreativeIdentityReads(plan));if(metaLookalikeKind(plan))reads.push(base(plan.path.split('/').slice(0,2).join('/')+'/'+metaLookalikeSeed(plan),{fields:metaSeedFields}));return reads;}
  if(/^\/v[^/]+\/\d+$/.test(plan.path)){const fields=new Set(['id','name','status']);for(const k of Object.keys(body))if(/^[a-z_]+$/.test(k)&&!['execution_options','fields'].includes(k))fields.add(k);return [base(plan.path,{fields:[...fields].join(',')})];}
 }
 if(plan.gateway==='snapchat_native_action'&&plan.method==='PUT'){
  const kind=plan.path.split('/').at(-1)!,rows=body[kind];if(!Array.isArray(rows)||!rows.length||rows.length>25)fail('MISSING_PAYLOAD','Provide 1–25 native update records.');
  if(new Set(rows.map(row=>row?.id)).size!==rows.length)fail('INVALID_ARGUMENT','Each updated Snapchat resource ID must be unique.');
  return rows.map(row=>{if(typeof row?.id!=='string'||!/^[-a-zA-Z0-9]+$/.test(row.id))fail('MISSING_PARAMETER','Each update record requires its exact ID.');return base('/v1/'+kind+'/'+row.id);});
 }
 if(plan.gateway==='snapchat_native_action'&&plan.method==='PATCH'){const match=/\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives)\/([^/]+)$/.exec(plan.path)!;return [base('/v1/'+match[1]+'/'+match[2])];}
 const catalog=registry.catalogs.get(plan.gateway);
 const samePath=[...(catalog?.actions??[]),...registry.data.supplemental.filter(a=>a.gateway===plan.gateway)].some(a=>a.method==='GET'&&a.path&&new RegExp('^'+a.path.split('?')[0]!.replace(/[.*+?^$()|[\]\\]/g,'\\$&').replace(/\{[^}]+\}/g,'[^/]+')+'$').test(plan.path));
 const accountPaths:Record<string,RegExp>={snapchat_native_action:/^\/v1\/adaccounts\/[^/]+/,x_ads_native_action:/^\/12\/accounts\/[^/]+/,linkedin_native_action:/^\/rest\/adAccounts\/[^/]+/,dv360_native_action:/^\/v\d+\/advertisers\/[^/]+/};
 const account=accountPaths[plan.gateway]?.exec(plan.path)?.[0];
 if(plan.gateway==='snapchat_native_action'&&plan.method==='POST'&&!account)return [base(plan.path.slice(0,plan.path.lastIndexOf('/')))];
 // Account creates also read owned dependencies: a lead form's banner media, a lead creative's form, a lookalike's seed.
 if(plan.gateway==='snapchat_native_action'&&plan.method==='POST'&&account&&plan.path.slice(account.length).split('/').filter(Boolean).length===1)return [base(account),...[...snapLeadDependencyPaths(plan),...snapSegmentDependencyPaths(plan)].map(path=>base(path))];
 // On collection creates, snapshot the account. On edits/deletes, the catalog must expose a matching GET.
 if(plan.method==='POST'&&account&&plan.path.slice(account.length).split('/').filter(Boolean).length===1)return [base(account)];
 if(samePath&&['POST','PUT','PATCH','DELETE'].includes(plan.method))return [base(plan.path)];
 fail('WRITE_CONTRACT_UNAVAILABLE','This operation lacks an implemented target-state read. It remains available as a local dry run.');
}

export class WriteReviewService {
 constructor(private registry:Registry,private compiler:Compiler,private store:Store,private transport:NativeTransport,private credentials:CredentialProvider,private options:CallOptions,private policy:ExecutionPolicy,private delegated=new DelegatedNativeCompiler()){}
 private authority(actor:Actor,reviewPlan:CompiledRequest,request:CompiledRequest,connection:Connection,auth:Credentials){
  return nativeAuthority(this.store,this.registry,actor,request,connection,auth,()=>{
   this.access(actor,reviewPlan,connection.id);
   if(tiktokReportKind(reviewPlan)&&sha256(this.store.credentials(actor.tenantId,connection.id).accessToken??'')!==sha256(auth.accessToken??''))fail('TIKTOK_REPORT_TOKEN_CHANGED','The original task access token changed. Preserve existing reviews and task receipts; do not automatically regenerate the task.');
  });
 }
 private async request(actor:Actor,reviewPlan:CompiledRequest,request:CompiledRequest,connection:Connection,auth:Credentials){
  const access=this.authority(actor,reviewPlan,request,connection,auth);
  const response=await this.transport.request(request,access(),auth,undefined,{beforeAttempt:access});
  // A received mutation outcome must be retained before any post-response permission check.
  if(request.readOnly)access();return response;
 }
 private access(actor:Actor,plan:CompiledRequest,connectionId?:string):Connection {
  this.store.assertActorActive(actor);
  assertGtmWorkflowActor(plan,actor);
  assertBusinessNotificationActor(plan,actor);
  assertBusinessAccessActor(plan,actor);
  assertGoogleAccessActor(plan,actor);
  if(!this.policy.allowWrites)fail('LIVE_WRITES_DISABLED','Enable MIRROR_ALLOW_WRITES=true for reviewed write support.');
  if(actor.role==='reader')throw new MirrorError('FORBIDDEN','A writer connector and administrator account grant are required.',{},403);
  const c=this.store.resolveConnection(actor,plan.gateway,plan.accountId,connectionId),id=normalizeAccount(plan.gateway,plan.accountId??(c.accounts.length===1?c.accounts[0]:''));
  assertAccountWrite(this.store,c,id);
  for(const account of appleSharedAccounts(plan)){this.store.resolveConnection(actor,plan.gateway,account,c.id);assertAccountWrite(this.store,c,account);}
  if(plan.gateway==='reddit_native_action')assertRedditWriteScopes(c);
  if(criteoTargetingKind(plan))assertCriteoTargetingScopes(c);
  if(metaReportKind(plan))assertMetaReportScope(c);
  if(criteoCampaignKind(plan))assertCriteoCampaignScopes(c,true);
  if(criteoLineItemKind(plan)||criteoPromotedProductsKind(plan)||criteoKeywordKind(plan)||criteoBidMultiplierKind(plan))assertCriteoLineItemScopes(c,true);
  if(criteoOverrideKind(plan))assertCriteoOverrideScopes(c,true);
  if(criteoPreferredKind(plan))assertCriteoPreferredScopes(c,true);
  if(criteoCatalogKind(plan))assertCriteoCatalogScopes(c,criteoCatalogKind(plan));
  if(criteoSegmentKind(plan))assertCriteoSegmentScopes(c,true,plan);
  if(criteoReportKind(plan))assertCriteoReportScopes(c,criteoReportKind(plan));
  if(placeActionKind(plan))assertPlaceActionScope(c);
  if(businessNotificationKind(plan))assertBusinessNotificationScope(c);
  if(businessAccessKind(plan))assertBusinessAccessScope(c);
  if(metaLabelKind(plan))assertMetaLabelScope(c,true);
  if(metaObjectKind(plan))assertMetaObjectScope(c,true);
  if(metaImageKind(plan))assertMetaImageScope(c,true);
  if(metaConversionKind(plan))assertMetaConversionScope(c,true);
  if(googleBidKind(plan))assertGoogleBidScope(c);
  if(googleBrandGuidelinesKind(plan))assertBrandGuidelinesScope(c);
  if(googleCustomerTypeKind(plan))assertBrandGuidelinesScope(c);
  if(googleDraftKind(plan))assertBrandGuidelinesScope(c);
  if(googleExperimentKind(plan)||googleCustomerSettingsKind(plan)||googleAutoAssetKind(plan)||googleUploadKind(plan)||googleSubscriptionKind(plan)||googleSmartKind(plan)||googleApplyKind(plan))assertBrandGuidelinesScope(c);
  if(googlePreviewKind(plan)||googleDismissalKind(plan)||googleAccessKind(plan))assertGoogleAdsScope(c);
  if(googleSegmentKind(plan)||googleBiddingEventKind(plan)||googleConversionGoalKind(plan)||googlePortfolioKind(plan)||googleConversionActionKind(plan)||googleListingGroupKind(plan))assertGoogleAdsScope(c);
  if(linkedinConversionKind(plan)||linkedinRuleKind(plan))assertLinkedInConversionScope(c,true);
  if(linkedinTrackingKind(plan))assertLinkedInTrackingScope(c,true);
  if(linkedinThirdPartyKind(plan))assertLinkedInThirdPartyScope(c,true);
  if(linkedinInsightKind(plan))assertLinkedInInsightScope(c,true);
  if(linkedinAbKind(plan))assertLinkedInAbScope(c,true);
  if(linkedinMessageKind(plan))assertLinkedInMessageScope(c,true);
  if((dv360ListKind(plan)||dv360TargetingKind(plan)||dv360AdGroupKind(plan)||dv360AdAssetKind(plan)||dv360AdKind(plan)||dv360LineItemBulkKind(plan)||dv360LineItemDuplicateKind(plan)||dv360InventoryGroupKind(plan)||dv360AdvertiserKind(plan)||dv360BiddingKind(plan)||dv360SdfKind(plan))&&!c.scopes.includes('https://www.googleapis.com/auth/display-video'))fail('PROVIDER_WRITE_SCOPE_REQUIRED','Reconnect DV360 with the display-video OAuth scope.');
  if(plan.gateway===microsoftGateway&&!c.scopes.some(s=>s===microsoftScope||s==='msads.manage'))fail('INSUFFICIENT_SCOPE','Reconnect Microsoft Advertising with msads.manage permission.');
  plan.accountId=id;new ScopeGuard(this.registry,this.store).authorize(plan,c);assertMeasurementScopes(plan,c);return c;
 }
 private async state(actor:Actor,plan:CompiledRequest,connectionId:string,reads:CompiledRequest[]):Promise<unknown[]> {
  if(criteoCampaignKind(plan)){
   let credentialHash:string|undefined;
   return readCriteoCampaignState(plan,async read=>{
    if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Campaign prerequisites must remain read-only.');
    const access=()=>{const c=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,c);if(credentialHash&&sha256(stable(this.store.credentials(actor.tenantId,c.id)))!==credentialHash)fail('REAUTHORIZATION_REQUIRED','The selected login changed during campaign preparation. Prepare again.');return c;};
    const c=access(),auth=await this.credentials.get(c);credentialHash??=sha256(stable(auth));access();const response=await this.request(actor,plan,read,c,auth);access();return response;
   });
  }
  if(xReportKind(plan)){
   let identity:string|undefined;
   return readXReportState(plan,async read=>{
    if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Report prerequisites must remain read-only.');
    const access=()=>{const c=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,c);if(identity&&xReportIdentity(this.store.credentials(actor.tenantId,c.id))!==identity)fail('X_REPORT_LOGIN_CHANGED','The X login changed during preparation.');return c;};
    const c=access(),auth=await this.credentials.get(c);identity??=xReportIdentity(auth);access();const response=await this.request(actor,plan,read,c,auth);access();return response;
   },()=>identity!);
  }
  if(tiktokReportKind(plan)){
   let tokenHash:string|undefined;
   return readTiktokReportState(plan,async read=>{
    if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Report prerequisites must remain read-only.');
    const access=()=>{const c=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,c);const token=this.store.credentials(actor.tenantId,c.id).accessToken;if(!token||tokenHash&&sha256(token)!==tokenHash)fail('TIKTOK_REPORT_TOKEN_CHANGED','The original task access token changed. Preserve the task; do not automatically regenerate it.');return c;};
    const c=access(),auth=await this.credentials.get(c);tokenHash??=sha256(auth.accessToken??'');access();const response=await this.request(actor,plan,read,c,auth);access();return response;
   },()=>tokenHash!);
  }
  if(criteoReportKind(plan)){
   let credentialHash:string|undefined;
   return readCriteoReportState(plan,async read=>{
    if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Report prerequisites must remain read-only.');
    const access=()=>{const c=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,c);if(credentialHash&&sha256(stable(this.store.credentials(actor.tenantId,c.id)))!==credentialHash)fail('REAUTHORIZATION_REQUIRED','The selected login changed during report preparation. Prepare again.');return c;};
    const c=access(),auth=await this.credentials.get(c);credentialHash??=sha256(stable(auth));access();const response=await this.request(actor,plan,read,c,auth);access();return response;
   });
  }
  if(snapUpdateKind(plan)){
   let credentialHash:string|undefined;
   return readSnapUpdateState(plan,async read=>{
    if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Snapchat prerequisites must remain read-only.');
    const access=()=>{const current=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,current);if(credentialHash&&sha256(stable(this.store.credentials(actor.tenantId,current.id)))!==credentialHash)fail('REAUTHORIZATION_REQUIRED','The selected login changed during Snapchat checks. Prepare again with the current login.');return current;};
    const c=access(),auth=await this.credentials.get(c);credentialHash??=sha256(stable(auth));access();const response=await this.request(actor,plan,read,c,auth);access();return response;
   });
  }
  if(googlePreviewKind(plan)||googlePortfolioKind(plan)||googleConversionActionKind(plan)){
   let credentialHash:string|undefined;
   return (googlePreviewKind(plan)?readGooglePreviewState:googleConversionActionKind(plan)?readGoogleConversionActionState:readGooglePortfolioState)(plan,async read=>{
    if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Portfolio prerequisites must remain read-only.');
    const access=()=>{const current=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,current);if(credentialHash&&sha256(stable(this.store.credentials(actor.tenantId,current.id)))!==credentialHash)fail('REAUTHORIZATION_REQUIRED','The selected login changed during portfolio checks. Prepare again with the current login.');return current;};
    const c=access(),auth=await this.credentials.get(c);credentialHash??=sha256(stable(auth));access();const response=await this.request(actor,plan,read,c,auth);access();return response;
   });
  }
  if(metaCreativeCreate(plan)){
   const read=reads[0]!,access=()=>this.access(actor,plan,connectionId),c=access();new ScopeGuard(this.registry,this.store).authorize(read,c);
   const auth=await this.credentials.get(c);access();const result=await this.request(actor,plan,read,c,auth);access();validateState(read,result);
   return [normalizeSnapshot(read,result.data),{creative_source:await metaCreativeState(plan,this.store,this.transport,this.credentials,actor,access)}];
  }
  if(googleAccessKind(plan))return readGoogleAccessState(plan,async read=>{
   if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Google access prerequisites must remain read-only.');
   const access=()=>{const current=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,current);return current;};
   const c=access(),auth=await this.credentials.get(c);access();const result=await this.request(actor,plan,read,c,auth);access();return result;
  });
  if(googleDismissalKind(plan))return readGoogleDismissalState(plan,async read=>{
   if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Recommendation dismissal prerequisites must remain read-only.');
   const access=()=>{const current=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,current);return current;};
   const c=access(),auth=await this.credentials.get(c);access();const result=await this.request(actor,plan,read,c,auth);access();return result;
  });
  if(businessAccessKind(plan))return readBusinessAccessState(plan,async read=>{
   if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Business access prerequisites must remain read-only.');
   const access=()=>{const current=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,current);return current;};
   const c=access(),auth=await this.credentials.get(c);access();const result=await this.request(actor,plan,read,c,auth);access();return result;
  });
  if(placeActionKind(plan)||businessNotificationKind(plan))return (placeActionKind(plan)?readPlaceActionState:readBusinessNotificationState)(plan,async read=>{
   if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Place-action prerequisites must remain read-only.');
   const access=()=>{const current=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,current);return current;};
   const c=access(),auth=await this.credentials.get(c);access();const result=await this.request(actor,plan,read,c,auth);access();return result;
  });
  if(metaReportKind(plan))return readMetaReportState(plan,async read=>{
   if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Report prerequisites must remain read-only.');
   const c=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,c);const auth=await this.credentials.get(c);this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id));
   const result=await this.request(actor,plan,read,c,auth);this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,this.store.resolveConnection(actor,plan.gateway,plan.accountId,c.id));return result;
  });
  if(googleBiddingEventKind(plan)||googleConversionGoalKind(plan))return (googleConversionGoalKind(plan)?readGoogleConversionGoalState:readGoogleBiddingEventState)(plan,async read=>{
   if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Google goal and bidding-event dependency checks must be read-only.');
   const c=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,c);const auth=await this.credentials.get(c);this.access(actor,plan,connectionId);
   const result=await this.request(actor,plan,read,c,auth);this.access(actor,plan,connectionId);return result;
  });
  if(xTargetingBatchRoute(plan)||linkedinTemplateKind(plan)){
   let credentialHash:string|undefined;
   return (linkedinTemplateKind(plan)?readLinkedInTemplateState:readXTargetingBatchState)(plan,async read=>{
    if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Targeting dependencies must remain read-only.');
    const access=()=>{const current=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,current);if(credentialHash&&sha256(stable(this.store.credentials(actor.tenantId,current.id)))!==credentialHash)fail('REAUTHORIZATION_REQUIRED','The selected login changed during targeting checks.');return current;};
    const current=access(),auth=await this.credentials.get(current);credentialHash??=sha256(stable(auth));access();const result=await this.request(actor,plan,read,current,auth);access();return result;
   });
  }
  if(xCreativeKind(plan)||xDraftKind(plan))return (xDraftKind(plan)?readXDraftState:readXCreativeState)(plan,async read=>{
   if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','Creative dependency checks must be read-only.');
   const c=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,c);const auth=await this.credentials.get(c);this.access(actor,plan,connectionId);
   const result=await this.request(actor,plan,read,c,auth);this.access(actor,plan,connectionId);return result;
  });
  const values:unknown[]=[];
  for(const read of reads){if(!applyExecutionRisk(read).readOnly)fail('STATE_READ_UNSAFE','The state check must be independently read-only.');const c=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(read,c);const auth=await this.credentials.get(c);this.access(actor,plan,connectionId);let result:TransportResult;
   try{result=await readSnapProductSets(read,productSetPage=>readSnapConversions(productSetPage,conversionReadPage=>readLinkedInAb(conversionReadPage,abPage=>readDV360Sdf(abPage,sdfPage=>readGoogleApply(sdfPage,applyPage=>readLinkedInInsight(applyPage,insightPage=>readSnapSegmentDelete(insightPage,segmentDeletePage=>readMetaImage(segmentDeletePage,imagePage=>readMetaConversions(imagePage,conversionPage=>readDV360Bidding(conversionPage,biddingPage=>readCriteoCatalog(biddingPage,catalogPage=>readCriteoPreferred(catalogPage,preferredPage=>readXAudience(preferredPage,audiencePage=>readXScheduled(audiencePage,scheduledPage=>readXMedia(scheduledPage,mediaPage=>readXPrerollCtas(mediaPage,ctaPage=>readSnapDisclaimers(ctaPage,disclaimerPage=>readMetaObject(disclaimerPage,metaObjectPage=>readCriteoSegments(metaObjectPage,segmentPage=>readDV360Advertiser(segmentPage,advertiserPage=>readGoogleSubscriptions(advertiserPage,subscriptionPage=>readGoogleSmart(subscriptionPage,smartPage=>readGoogleCustomerSettings(smartPage,settingsPage=>readGoogleAutoAssets(settingsPage,autoAssetPage=>readGoogleUploads(autoAssetPage,uploadPage=>readGoogleExperiments(uploadPage,experimentPage=>readDV360InventoryGroup(experimentPage,inventoryPage=>readCriteoOverrides(inventoryPage,overridePage=>readLinkedInMessage(overridePage,messagePage=>readXCurated(messagePage,curatedPage=>readGoogleDrafts(curatedPage,draftPage=>readXAssociations(draftPage,xAssociationPage=>readLinkedInThirdParty(xAssociationPage,thirdPartyPage=>readXTrackingTags(thirdPartyPage,xTagPage=>readDV360LineItemDuplicate(xTagPage,copyLinePage=>readGoogleCustomerTypes(copyLinePage,typePage=>readSnapchatMediaCopy(typePage,copyPage=>readDV360LineItemBulk(copyPage,bulkPage=>readGoogleBrandGuidelines(bulkPage,brandPage=>readLinkedInTracking(brandPage,trackingPage=>readLinkedInRules(trackingPage,rulePage=>readLinkedInConversions(rulePage,linkPage=>readGoogleBidState(linkPage,bidPage=>readMetaLabels(bidPage,metaPage=>readCriteoTargeting(metaPage,criteoPage=>readRedditProfiles(criteoPage,redditPage=>readKeywordPlanTree(redditPage,planningPage=>readAssetSetContents(planningPage,feedPage=>readGtmWorkspace(feedPage,workspacePage=>readGtmWorkflow(workspacePage,gtmPage=>readDV360List(gtmPage,listPage=>readDV360Targeting(listPage,targetingPage=>readTiktokNegativeKeywords(targetingPage,negativePage=>readCriteoLineItems(negativePage,lineItemPage=>readDV360AdGroups(lineItemPage,groupPage=>readDV360Ads(groupPage,async page=>{const current=this.access(actor,plan,connectionId);new ScopeGuard(this.registry,this.store).authorize(page,current);const response=await this.request(actor,plan,page,current,auth);this.access(actor,plan,connectionId);return response;}))))))))))))))))))))))))))))))))))))))))))))))))))))))));}catch(e){const absent=optionalMissingState(read,e);if(!absent)throw e;result=absent;}
   const reader=this.access(actor,plan,connectionId);validateState(read,result);if(read.gateway==='snapchat_native_action')new ScopeGuard(this.registry,this.store).observe(read,reader,result.data);
   // A Smart+ bid edit also reads the campaign's ad groups once the ad group names its campaign.
   const sibling=tiktokSmartPlusAdgroupUpdateSiblingRead(plan,read,result.data);if(sibling&&!reads.some(r=>r.path===sibling.path&&stable(r.query)===stable(sibling.query)))reads.push(sibling);
   // Instant Forms cannot be read by ID; the first page names how many more pages to read.
   for(const more of tiktokInstantFormFollowUps(read,result.data))if(!reads.some(r=>r.path===more.path&&stable(r.query)===stable(more.query)))reads.push(more);
   if(appleEntityKind(plan)==='shared_budget'&&read.path===plan.path){
    const accounts=appleSharedAccounts(plan,result.data),frozen=plan.scopeContext?.appleSharedAccountIds;
    for(const account of accounts){const current=this.store.resolveConnection(actor,plan.gateway,account,connectionId);assertAccountWrite(this.store,current,account);}
    if(!frozen){
     plan.scopeContext={...plan.scopeContext,appleSharedAccountIds:accounts};
     for(const extra of appleSharedAccountReads(plan,accounts))if(!reads.some(r=>r.path===extra.path))reads.push(extra);
    }
   }
   values.push(linkedinDSC(plan)&&/^\/rest\/(images|videos)\//.test(read.path)?linkedinMediaProjection(plan,object(result.data)):normalizeSnapshot(read,result.data));
  }
  validateRedditCreativePrerequisites(plan,values);
  validateCriteoTargetingPrerequisites(plan,values);
  validateMetaLabelPrerequisites(plan,values);
  googleBidPrerequisites(plan,values);
  snapchatMediaCopyPrerequisites(plan,values);
  snapDisclaimerPrerequisites(plan,values);
  snapSegmentDeletePrerequisites(plan,values);
  snapConversionPrerequisites(plan,values);
  snapProductSetPrerequisites(plan,values);
  googleBrandGuidelinesPrerequisites(plan,values);
  googleCustomerTypePrerequisites(plan,values);
  googleDraftPrerequisites(plan,values);
  googleExperimentPrerequisites(plan,values);
  googleCustomerSettingsPrerequisites(plan,values);
  googleAutoAssetPrerequisites(plan,values);
  googleUploadPrerequisites(plan,values);
  googleSubscriptionPrerequisites(plan,values);
  googleSmartPrerequisites(plan,values);
  googleApplyPrerequisites(plan,values);
  linkedinConversionPrerequisites(plan,values);
  linkedinTrackingPrerequisites(plan,values);
  linkedinThirdPartyPrerequisites(plan,values);
  linkedinInsightPrerequisites(plan,values);
  linkedinAbPrerequisites(plan,values);
  linkedinMessagePrerequisites(plan,values);
  linkedinRulePrerequisites(plan,values);
  tiktokAdgroupConversionPrerequisites(plan,values);
  tiktokCtaPortfolioPrerequisites(plan,values);
  tiktokManualAdIdentityPrerequisites(plan,values);
  tiktokSmartPlusAdPrerequisites(plan,values);
  tiktokSmartPlusAdUpdatePrerequisites(plan,values);
  tiktokSmartPlusAdgroupUpdatePrerequisites(plan,values);
  tiktokSmartPlusMaterialStatusPrerequisites(plan,values);
  validateAppleEntityPrerequisites(plan,reads,values);
  validateGtmWorkflowPrerequisites(plan,values);
  validateGtmWorkspacePrerequisites(plan,values);
  validateDV360ListPrerequisites(plan,values);
  validateDV360TargetingPrerequisites(plan,values);
  validateGoogleListingGroupPrerequisites(plan,values);
  validateTiktokNegativeKeywordPrerequisites(plan,values);
  validateTiktokBrandSafetyPrerequisites(plan,values);
  validateMetaValueRulePrerequisites(plan,values);
  metaObjectPrerequisites(plan,values);
  metaImagePrerequisites(plan,values);
  metaConversionPrerequisites(plan,values);
  validateMetaBrandSafetyPrerequisites(plan,values);
  validateCriteoLineItemPrerequisites(plan,values);
  criteoOverridePrerequisites(plan,values);
  criteoPreferredPrerequisites(plan,values);
  criteoCatalogPrerequisites(plan,values);
  criteoSegmentPrerequisites(plan,values);
  validateCriteoPromotedProductsPrerequisites(plan,values);
  validateCriteoLineItemBiddingPrerequisites(plan,values);
  validateDV360AdGroupPrerequisites(plan,values);
  validateDV360AdAssetPrerequisites(plan,values);
  validateDV360AdPrerequisites(plan,values);
  dv360LineItemBulkPrerequisites(plan,values);
  dv360LineItemDuplicatePrerequisites(plan,values);
  dv360InventoryGroupPrerequisites(plan,values);
  dv360AdvertiserPrerequisites(plan,values);
  dv360BiddingPrerequisites(plan,values);
  dv360SdfPrerequisites(plan,values);
  xTrackingTagPrerequisites(plan,values);
  xPrerollCtaPrerequisites(plan,values);
  xMediaPrerequisites(plan,values);
  xScheduledPrerequisites(plan,values);
  xAudiencePrerequisites(plan,values);
  xAssociationPrerequisites(plan,values);
  xCuratedPrerequisites(plan,values);
  if(appleEntityKind(plan)==='shared_budget'&&!plan.scopeContext?.appleSharedOrgId){
   const account=object(values[reads.findIndex(r=>r.path==='/v1/ad-accounts/'+plan.accountId)]).result;
   const target=object(values[reads.findIndex(r=>r.path===plan.path)]).result;
   plan.scopeContext={...plan.scopeContext,appleSharedAccountIds:appleSharedAccounts(plan),appleSharedOrgId:String(account.orgId),appleSharedResultAccounts:(object(plan.body).adAccountIds??target.adAccountIds).map(String)};
  }
  validateGoogleTargetingState(plan,values);validateGoogleAssetLinkState(plan,values);validateGoogleConfigurationState(plan,values);validateMicrosoftAssociationState(plan,values);validateXTargetingState(plan,values);return values;
 }
 async call(input:JsonObject,actor:Actor):Promise<unknown>{
  guardInput(input);for(const key of Object.keys(input))if(!Object.hasOwn(writeTool.inputSchema.properties,key))fail('INVALID_ARGUMENT','Unknown write-tool parameter.',{parameter:key});
  if(input.creative_edit_confirmed!==undefined&&typeof input.creative_edit_confirmed!=='boolean')fail('INVALID_ARGUMENT','creative_edit_confirmed must be a boolean.');
  if(input.action==='prepare'||input.action==='inspect'){
   if(typeof input.gateway!=='string'||!input.arguments||typeof input.arguments!=='object'||Array.isArray(input.arguments))fail('INVALID_ARGUMENT','prepare requires gateway and arguments.');
   const isDelegated=this.registry.tools.get(input.gateway)?.mode==='delegated',nativeArgs=isDelegated?object(input.arguments.arguments):input.arguments;
   if(['aggregate_pages','paginate','allPages'].some(k=>input.arguments[k]||nativeArgs[k]))fail('MUTATION_PAGINATION_FORBIDDEN','A reviewed mutation executes exactly one request.');
   const args=isDelegated?{...input.arguments}:{...input.arguments,dry_run:true};this.registry.validate(input.gateway,args,this.options);
   const unavailable=unsupportedProviderAlias(input.gateway,nativeArgs.action);if(input.action==='inspect'&&unavailable){const e=new MirrorError('PROVIDER_ACTION_UNSUPPORTED',unavailable.reason,unavailable),remedy=errorRemedy(e);return {executed:false,network_requests:0,review_contract_supported:false,request:null,error:{code:e.code,message:e.message,details:e.details,category:remedy.category,remedy},live_permissions_verified:false,next_step:unavailable.replacement};}
   const plan=applyExecutionRisk(isDelegated?this.delegated.compile(input.gateway,args):this.compiler.compile(input.gateway,args,this.options));
   if(input.connection_id&&nativeArgs.connection_id&&input.connection_id!==nativeArgs.connection_id)fail('CONFLICTING_PARAMETER','Connection IDs must agree.');
   if(input.action==='inspect'){
    let accountCapability:JsonObject;try{const c=this.store.resolveConnection(actor,plan.gateway,plan.accountId,input.connection_id??nativeArgs.connection_id);accountCapability={connection_id:c.id,account_id:plan.accountId,selected:true,write_granted:c.writeAccounts?.includes(plan.accountId!)??false,granted_scopes:c.scopes,provider_access:'requires live preparation'};}catch(e){accountCapability={selected:false,error:e instanceof MirrorError?{code:e.code,message:e.message}:undefined};}
    try{assertWriteShape(plan);assertRedditCreativeAvailable(plan);const reads=snapshotPlans(plan,this.registry);return {executed:false,network_requests:0,review_contract_supported:true,request:redact(plan.gateway==='google_business_native_action'?placeActionSafe(plan):plan),contract_evidence:executionEvidence(plan),state_reads:reads.map(r=>({method:r.method,path:r.path})),live_permissions_verified:false,account_capability:accountCapability,requirements:{deployment_writes_enabled:this.policy.allowWrites,operator_role:actor.role!=='reader',account_write_grant_required:true,...(businessNotificationKind(plan)||businessAccessKind(plan)||googleAccessKind(plan)?{administrator_role_required:true,administrator_role:actor.role==='admin'&&actor.testAccount!==true}:{})},next_step:'Use prepare to verify live state and account access.'};}
    catch(e){if(!(e instanceof MirrorError))throw e;const remedy=errorRemedy(e);return {executed:false,network_requests:0,review_contract_supported:false,request:redact(plan.gateway==='google_business_native_action'?placeActionSafe(plan):plan),contract_evidence:executionEvidence(plan),error:{code:e.code,message:e.message,details:e.details,category:remedy.category,remedy},live_permissions_verified:false};}
   }
   assertWriteShape(plan);assertRedditCreativeAvailable(plan);const c=this.access(actor,plan,input.connection_id??nativeArgs.connection_id),reads=snapshotPlans(plan,this.registry),state=await this.state(actor,plan,c.id,reads);
   validateGoogleAssetLinkState(plan,state,true);
   assertGoogleDismissalPrerequisites(plan,state);
   assertGoogleAccessPrerequisites(plan,state);
   validateGoogleConfigurationState(plan,state,true);
   validateDV360ListPrerequisites(plan,state,true);
   validateGtmWorkflowPrerequisites(plan,state,true);
   validateMicrosoftAssociationState(plan,state,true);
   if(plan.gateway==='gtm_native_action'&&!gtmWorkspaceKind(plan)){
    const route=this.delegated.data.routes.find(r=>r.gateway===plan.gateway&&r.operation+(r.action?'/'+r.action:'')===plan.action),fingerprint=object(state[0]).fingerprint;
    if(route?.parameters.fingerprint&&typeof fingerprint==='string'&&fingerprint){
     if(plan.query.fingerprint!==undefined&&plan.query.fingerprint!==fingerprint)fail('STATE_CHANGED','The supplied Tag Manager fingerprint is stale.');
     plan.query.fingerprint=fingerprint;
    }
   }
   if(input.creative_edit_confirmed!==undefined&&!xCreativeEdit(plan)&&!tiktokSmartPlusAdUpdateKind(plan))fail('INVALID_ARGUMENT','creative_edit_confirmed is only for an X creative edit or deletion, or a TikTok Smart+ ad edit.');
   const creativeImpact=writeImpact(plan,state,input.creative_edit_confirmed===true,c.id);
   assertSnapCreativeReferences(plan,state,resource=>this.store.ownsResource(c,normalizeAccount(plan.gateway,plan.accountId!),resource));
   const override=input.creative_edit_confirmed===true?{creative_edit_confirmed:true}:{};
   const reviewId=randomUUID(),fingerprint=sha256(stable({tenant:actor.tenantId,user:actor.userId,connection:c.id,plan,...override})),expiresAt=Date.now()+300000;
   const stateHash=reviewStateHash(state),spendPolicy=checkSpendPolicy(this.store,actor,plan,state);
   this.store.putDocument(actor.tenantId,'write_review',reviewId,{user_id:actor.userId,connection_id:c.id,plan,reads,state,state_hash:stateHash,fingerprint,expires_at:expiresAt,...override});
   this.store.appendAudit(actor.tenantId,reviewId,{event:'write_prepared',request:plan,fingerprint,expires_at:expiresAt});
   return {success:true,executed:false,review_id:reviewId,idempotency_key:reviewId,expires_at:new Date(expiresAt).toISOString(),request:redact(plan.gateway==='google_business_native_action'?placeActionSafe(plan):plan),contract_evidence:executionEvidence(plan),before_state:redact(state),spend_policy:spendPolicy,state_hash:stateHash,state_reads:reads.map(r=>({method:r.method,path:r.path})),fingerprint,confirmation_required:true,...(creativeImpact?{creative_impact:creativeImpact}:{})};
  }
  if(input.action!=='execute'||typeof input.review_id!=='string')fail('INVALID_ARGUMENT','Use prepare or execute with a review_id.');
  if(input.arguments!==undefined)fail('INVALID_ARGUMENT','Execute takes only review_id, idempotency_key and confirmation flags; the request was frozen at prepare. Prepare a new review to change it.');
  const review=this.store.document(actor.tenantId,'write_review',input.review_id);
  if(review.user_id!==actor.userId)throw new MirrorError('FORBIDDEN','The review belongs to a different actor.',{},403);
  const plan=review.plan as CompiledRequest;assertWriteShape(plan);
  // Repeating the review's own gateway/connection is harmless; a different one would silently change the request.
  if(input.gateway!==undefined&&input.gateway!==plan.gateway||input.connection_id!==undefined&&input.connection_id!==review.connection_id)fail('INVALID_ARGUMENT','This review is bound to its original gateway and connection. Omit them, or prepare a new review to use another.',{gateway:plan.gateway,connection_id:review.connection_id});
  this.access(actor,plan,review.connection_id);
  if(input.idempotency_key!==input.review_id)fail('IDEMPOTENCY_REQUIRED','Use the exact idempotency_key returned by prepare.');
  authorizeExecution(actor,plan,{...input,dry_run:false},this.policy,true);
  if(review.creative_edit_confirmed===true&&input.creative_edit_confirmed!==true)fail('CREATIVE_EDIT_CONFIRMATION_REQUIRED','This review permits a potentially destructive creative edit. Also provide creative_edit_confirmed=true to execute.');
  if(input.creative_edit_confirmed===true&&review.creative_edit_confirmed!==true)fail('REVIEW_CHANGED','Prepare a new review to acknowledge creative-edit risk. Execute cannot add an override.');
  const fingerprint=sha256(stable({tenant:actor.tenantId,user:actor.userId,connection:review.connection_id,plan,...(review.creative_edit_confirmed===true?{creative_edit_confirmed:true}:{})}));if(fingerprint!==review.fingerprint)fail('REVIEW_CHANGED','The stored reviewed request failed its integrity check.');
  const previous=this.store.db.prepare('SELECT state,result,fingerprint FROM idempotency WHERE tenant_id=? AND key=?').get(actor.tenantId,input.idempotency_key) as JsonObject|undefined;
  if(previous){if(previous.fingerprint!==fingerprint)fail('IDEMPOTENCY_CONFLICT','The key is bound to another request.');if(previous.state==='complete'){const saved={...JSON.parse(previous.result),replayed:true};return googlePreviewKind(plan)?googlePreviewDelivery(plan,saved,this.store.previewReceipt(actor.tenantId,input.review_id)):saved;}fail('WRITE_OUTCOME_UNCERTAIN','This review was already submitted. Inspect provider state; do not retry with a new key.');}
  assertRedditCreativeAvailable(plan);
  if(review.expires_at<=Date.now())fail('REVIEW_EXPIRED','Prepare and review a fresh request.');
  // Reproject saved envelopes as well: a still-valid review prepared before an
  // upgrade must not conflict solely because its stored envelope was wider.
  // X creative discovery already returns its own validated resource projection.
  const expectedState=xCreativeKind(plan)?review.state:review.state.map((value:unknown,i:number)=>normalizeSnapshot(review.reads[i],value));
  const current=await this.state(actor,plan,review.connection_id,review.reads),expectedHash=reviewStateHash(expectedState),actualHash=reviewStateHash(current);
  const creativeImpact=writeImpact(plan,current,review.creative_edit_confirmed===true,review.connection_id);
  if(actualHash!==expectedHash)fail('STATE_CHANGED','The provider configuration changed after preparation. Prepare and review a fresh request.',{expected_state_hash:expectedHash,actual_state_hash:actualHash,changed_fields:changedStateFields(expectedState,current)});
  assertGoogleDismissalPrerequisites(plan,current);
  assertGoogleAccessPrerequisites(plan,current);
  const c=this.access(actor,plan,review.connection_id),auth=await this.credentials.get(c);this.access(actor,plan,review.connection_id);
  assertSnapCreativeReferences(plan,current,resource=>this.store.ownsResource(c,normalizeAccount(plan.gateway,plan.accountId!),resource));
  if(review.expires_at<=Date.now())fail('REVIEW_EXPIRED','Review expired during state verification.');
  assertRedditCreativeAvailable(plan);
  if(xReportKind(plan)&&xReportIdentity(auth)!==(current[0] as JsonObject).login_fingerprint)fail('X_REPORT_LOGIN_CHANGED','The X login changed after preparation.');
  if(tiktokReportKind(plan)&&sha256(auth.accessToken??'')!==(current[0] as JsonObject).token_fingerprint)fail('TIKTOK_REPORT_TOKEN_CHANGED','TikTok credentials changed after the prerequisite read. Preserve the review and task.');
  const submittedAt=Date.now(),actorBinding=this.store.bindJobActor(actor,input.review_id);
  const claim=this.store.transaction(()=>{checkSpendPolicy(this.store,actor,plan,current,input.review_id);const claim=this.store.claim(actor.tenantId,input.idempotency_key,fingerprint);if(claim.fresh){admitTiktokReport(plan,this.store,auth);admitXReport(plan,this.store,input.review_id);}return claim;});if(!claim.fresh){const saved={...object(claim.result),replayed:true};return googlePreviewKind(plan)?googlePreviewDelivery(plan,saved,this.store.previewReceipt(actor.tenantId,input.review_id)):saved;}
  let completed=false;
  try{
   this.store.appendAudit(actor.tenantId,input.review_id,{event:'write_started',request:plan,fingerprint,before_state:current});
   const response=await this.request(actor,plan,plan,c,auth);this.delegated.validateResponse(plan,response.data,response.status);const rawResult=writeOutcome(response,plan,current),result=googlePreviewKind(plan)?googlePreviewSafeOutcome(plan,rawResult):rawResult;
   if(xReportKind(plan))result.data=xReportSafeData(response.data);
   const outcome:JsonObject={...result,review_id:input.review_id,action:plan.action,fingerprint,...(creativeImpact?{creative_impact:creativeImpact}:{})};
   this.store.transaction(()=>{
    if(googlePreviewKind(plan)&&object(response.data)===response.data)this.store.savePreviewReceipt(actor.tenantId,input.review_id,response.data as JsonObject);
    // A valid native job receipt remains useful even when the job immediately
    // failed. Retain its binding and release terminal processing admission;
    // the failed outcome still stays failed and must never be resubmitted.
    retainXReport(plan,c,this.store,response,current,input.review_id,auth,submittedAt);
    if(result.success===true)retainTiktokReport(plan,c,this.store,response,current,input.review_id,auth,submittedAt);
    if(result.success===true)new ScopeGuard(this.registry,this.store).observeCreated(plan,c,response.data);
    if(result.success===true&&linkedinLeadFormKind(plan))rememberLinkedInLeadForm(this.store,c,plan,response);
    if(result.success===true){
     const job=this.store.enqueue(actor.tenantId,'write_verification',{review_id:input.review_id,actor_binding:actorBinding});
     outcome.verification={status:'queued',job_id:job,next_call:{tool:'amcp_campaign',arguments:{action:'verify',review_id:input.review_id}}};
    }
    this.store.complete(actor.tenantId,input.idempotency_key,outcome);this.store.appendAudit(actor.tenantId,input.review_id,{event:'write_completed',outcome});
   });completed=true;
   // Retain accepted outcomes first, then withhold delivery if this caller lost access.
   this.authority(actor,plan,plan,c,auth)();
   if(googlePreviewKind(plan)){this.access(actor,plan,review.connection_id);return googlePreviewDelivery(plan,outcome,this.store.previewReceipt(actor.tenantId,input.review_id));}
   return outcome;
  // The spend reservation taken above is deliberately NOT released here. A write that failed in
  // transport may still have reached the provider — that is why the outcome is recorded as
  // uncertain rather than failed — and releasing the reservation would let repeated "failures"
  // walk past the owner's cumulative daily cap. The accepted cost is that a deterministic
  // rejection, which certainly did not land, still consumes part of the day's allowance. Only
  // release on errors provably raised before dispatch, never on transport-layer uncertainty.
  }catch(e){if(!completed)this.store.uncertain(actor.tenantId,input.idempotency_key);this.store.appendAudit(actor.tenantId,input.review_id,{event:completed?'write_result_withheld':'write_uncertain',code:e instanceof MirrorError?e.code:'INTERNAL_ERROR'});throw placeActionKind(plan)||businessNotificationKind(plan)||businessAccessKind(plan)?placeActionSafeError(e):e;}
 }
}
