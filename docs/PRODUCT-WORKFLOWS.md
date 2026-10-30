---
status: reference
tier: operator
---

# Connected product workflows

Implemented on `magdyezy1/CAMCP`, branch `Work-here`, on 1 October 2026. These website views call the same
first-party service operations as MCP. The [implementation record](review/IMPLEMENTATION-2026-10-01.md) records
qualification and remaining blueprint scope. Provider acceptance is account/action-specific and remains separate
from local implementation.

The workflows are task pages in [docs/workflows/](workflows/), each section moved there on 2026-10-24 with its text
unchanged (DOC-03); the table at the end says where each section went, and its old address still opens here.

## Workflow pages

- [Find and resume work](workflows/HOME-AND-NAVIGATION.md): Home, navigation, deep links, the working client, the interface language and page loading.
- [Errors, run stops and next actions](workflows/ERRORS-AND-RECOVERY.md): errors, run stops, next actions and recovery guidance.
- [Campaign review and recovery](workflows/CAMPAIGNS.md): campaign plans, guided packs, Search bidding recipes and prerequisite checks.
- [Creative preparation and durable uploads](workflows/CREATIVE.md): creative preparation, durable uploads and asset usage reads.
- [Reports, evidence and delivery](workflows/REPORTS.md): reports, evidence presets, saved evidence, delivery and capture refusals.
- [Read-only monitoring](workflows/MONITORING.md): monitors, incidents and notices.
- [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md): the live portfolio, measurement and catalog commerce.
- [Client report packs and recovery](workflows/REPORT-PACKS.md): client report packs, branding, files and recovery.
- [Allocation proposals and native budget drafts](workflows/ALLOCATION.md): allocation proposals, factors, outcome review and budget drafts.
- [Owner settings and workspace health](workflows/OWNER-SETTINGS.md): the owner's Settings sections and tool timings.

The sections that named their delivery batch are kept as written in [Workflow guide batch notes of the October 2026 deliveries](records/PRODUCT-WORKFLOWS-BATCH-NOTES-2026-10.md).

## Qualification boundaries

All additions use synthetic fixtures and existing provider contracts. No new OAuth scope, provider program,
advertising mutation, notification destination or deployment is authorized by this guide. Full Arabic translation,
broader objective recipes, additional portfolio providers, broader creative performance lineage and calibrated optimization
retain unfinished scope in the implementation matrix. See the dated implementation record for actual tests, browser checks and deployment
limitations rather than treating a capability card as live acceptance.

## Where each section went

| Section | Now in |
|---|---|
| <a id="find-and-resume-work"></a>Find and resume work | [Find and resume work](workflows/HOME-AND-NAVIGATION.md#find-and-resume-work) |
| <a id="interface-language"></a>Interface language | [Find and resume work](workflows/HOME-AND-NAVIGATION.md#interface-language) |
| <a id="opening-website-pages"></a>Opening website pages | [Find and resume work](workflows/HOME-AND-NAVIGATION.md#opening-website-pages) |
| <a id="errors-run-stops-and-next-actions"></a>Errors, run stops and next actions | [Errors, run stops and next actions](workflows/ERRORS-AND-RECOVERY.md#errors-run-stops-and-next-actions) |
| &nbsp;&nbsp;<a id="shared-recovery-guidance-in-your-interface-language"></a>Shared recovery guidance in your interface language | [Errors, run stops and next actions](workflows/ERRORS-AND-RECOVERY.md#shared-recovery-guidance-in-your-interface-language) |
| &nbsp;&nbsp;<a id="recovering-other-workspace-forms"></a>Recovering other workspace forms | [Errors, run stops and next actions](workflows/ERRORS-AND-RECOVERY.md#recovering-other-workspace-forms) |
| <a id="account-inventory-recovery-language"></a>Account inventory recovery language | [Errors, run stops and next actions](workflows/ERRORS-AND-RECOVERY.md#account-inventory-recovery-language) |
| <a id="effective-operation-help-and-inventory-read-recovery"></a>Effective operation help and inventory read recovery | [Errors, run stops and next actions](workflows/ERRORS-AND-RECOVERY.md#effective-operation-help-and-inventory-read-recovery) |
| <a id="campaign-review-and-recovery"></a>Campaign review and recovery | [Campaign review and recovery](workflows/CAMPAIGNS.md#campaign-review-and-recovery) |
| &nbsp;&nbsp;<a id="snapchat-website-traffic-with-an-existing-creative"></a>Snapchat website traffic with an existing creative | [Campaign review and recovery](workflows/CAMPAIGNS.md#snapchat-website-traffic-with-an-existing-creative) |
| &nbsp;&nbsp;<a id="snapchat-lead-generation-with-the-original-form"></a>Snapchat lead generation with the original form | [Campaign review and recovery](workflows/CAMPAIGNS.md#snapchat-lead-generation-with-the-original-form) |
| &nbsp;&nbsp;<a id="after-a-launch-launch-check-and-serving-diagnostics"></a>After a launch: launch check and serving diagnostics | [Campaign review and recovery](workflows/CAMPAIGNS.md#after-a-launch-launch-check-and-serving-diagnostics) |
| &nbsp;&nbsp;<a id="google-performance-max-as-one-build"></a>Google Performance Max as one build | [Campaign review and recovery](workflows/CAMPAIGNS.md#google-performance-max-as-one-build) |
| &nbsp;&nbsp;<a id="tiktok-website-traffic-and-purchases-with-an-existing-post"></a>TikTok website traffic and purchases with an existing post | [Campaign review and recovery](workflows/CAMPAIGNS.md#tiktok-website-traffic-and-purchases-with-an-existing-post) |
| &nbsp;&nbsp;<a id="linkedin-lead-generation-with-an-existing-post-and-form"></a>LinkedIn lead generation with an existing post and form | [Campaign review and recovery](workflows/CAMPAIGNS.md#linkedin-lead-generation-with-an-existing-post-and-form) |
| <a id="google-search-with-maximize-clicks"></a>Google Search with Maximize Clicks | [Campaign review and recovery](workflows/CAMPAIGNS.md#google-search-with-maximize-clicks) |
| &nbsp;&nbsp;<a id="google-search-conversion-bidding"></a>Google Search conversion bidding | [Campaign review and recovery](workflows/CAMPAIGNS.md#google-search-conversion-bidding) |
| &nbsp;&nbsp;<a id="google-search-conversion-value-bidding"></a>Google Search conversion-value bidding | [Campaign review and recovery](workflows/CAMPAIGNS.md#google-search-conversion-value-bidding) |
| &nbsp;&nbsp;<a id="current-conversion-configuration-before-activation"></a>Current conversion configuration before activation | [Campaign review and recovery](workflows/CAMPAIGNS.md#current-conversion-configuration-before-activation) |
| &nbsp;&nbsp;<a id="current-primary-conversion-value-settings"></a>Current primary conversion value settings | [Campaign review and recovery](workflows/CAMPAIGNS.md#current-primary-conversion-value-settings) |
| &nbsp;&nbsp;<a id="last-reported-google-conversion-activity"></a>Last reported Google conversion activity | [Campaign review and recovery](workflows/CAMPAIGNS.md#last-reported-google-conversion-activity) |
| <a id="creative-preparation-and-durable-uploads"></a>Creative preparation and durable uploads | [Creative preparation and durable uploads](workflows/CREATIVE.md#creative-preparation-and-durable-uploads) |
| <a id="current-google-image-links"></a>Current Google image links | [Creative preparation and durable uploads](workflows/CREATIVE.md#current-google-image-links) |
| <a id="performance-max-image-asset-group-links"></a>Performance Max image asset-group links | [Creative preparation and durable uploads](workflows/CREATIVE.md#performance-max-image-asset-group-links) |
| &nbsp;&nbsp;<a id="original-performance-max-campaign-logo-references"></a>Original Performance Max campaign logo references | [Creative preparation and durable uploads](workflows/CREATIVE.md#original-performance-max-campaign-logo-references) |
| &nbsp;&nbsp;<a id="original-snapchat-top-snap-references"></a>Original Snapchat top-snap references | [Creative preparation and durable uploads](workflows/CREATIVE.md#original-snapchat-top-snap-references) |
| <a id="reports-evidence-and-delivery"></a>Reports, evidence and delivery | [Reports, evidence and delivery](workflows/REPORTS.md#reports-evidence-and-delivery) |
| <a id="search-term-exclusions-from-retained-evidence"></a>Search-term exclusions from retained evidence | [Reports, evidence and delivery](workflows/REPORTS.md#search-term-exclusions-from-retained-evidence) |
| <a id="organic-and-paid-search-overlap"></a>Organic and paid search overlap | [Reports, evidence and delivery](workflows/REPORTS.md#organic-and-paid-search-overlap) |
| <a id="snapchat-daily-purchase-evidence"></a>Snapchat daily purchase evidence | [Reports, evidence and delivery](workflows/REPORTS.md#snapchat-daily-purchase-evidence) |
| &nbsp;&nbsp;<a id="recovering-encoded-workbook-definitions"></a>Recovering encoded workbook definitions | [Reports, evidence and delivery](workflows/REPORTS.md#recovering-encoded-workbook-definitions) |
| <a id="snapchat-submitted-native-lead-forms"></a>Snapchat submitted native lead forms | [Reports, evidence and delivery](workflows/REPORTS.md#snapchat-submitted-native-lead-forms) |
| <a id="finding-saved-evidence"></a>Finding saved evidence | [Reports, evidence and delivery](workflows/REPORTS.md#finding-saved-evidence) |
| &nbsp;&nbsp;<a id="choose-retained-evidence-page-length"></a>Choose retained evidence page length | [Reports, evidence and delivery](workflows/REPORTS.md#choose-retained-evidence-page-length) |
| &nbsp;&nbsp;<a id="retain-google-keyword-performance-by-day"></a>Retain Google keyword performance by day | [Reports, evidence and delivery](workflows/REPORTS.md#retain-google-keyword-performance-by-day) |
| &nbsp;&nbsp;<a id="readable-saved-report-controls"></a>Readable saved-report controls | [Reports, evidence and delivery](workflows/REPORTS.md#readable-saved-report-controls) |
| &nbsp;&nbsp;<a id="recover-from-a-refused-google-evidence-capture"></a>Recover from a refused Google evidence capture | [Reports, evidence and delivery](workflows/REPORTS.md#recover-from-a-refused-google-evidence-capture) |
| &nbsp;&nbsp;<a id="retain-google-campaign-performance-by-device"></a>Retain Google campaign performance by device | [Reports, evidence and delivery](workflows/REPORTS.md#retain-google-campaign-performance-by-device) |
| &nbsp;&nbsp;<a id="retain-google-campaign-performance-by-original-hour"></a>Retain Google campaign performance by original hour | [Reports, evidence and delivery](workflows/REPORTS.md#retain-google-campaign-performance-by-original-hour) |
| &nbsp;&nbsp;<a id="keep-a-refused-capture-reason-while-reviewing-settings"></a>Keep a refused capture reason while reviewing settings | [Reports, evidence and delivery](workflows/REPORTS.md#keep-a-refused-capture-reason-while-reviewing-settings) |
| &nbsp;&nbsp;<a id="provider-capture-refusals"></a>Provider capture refusals | [Reports, evidence and delivery](workflows/REPORTS.md#provider-capture-refusals) |
| <a id="read-only-monitoring"></a>Read-only monitoring | [Read-only monitoring](workflows/MONITORING.md#read-only-monitoring) |
| <a id="portfolio-measurement-and-commerce"></a>Portfolio, measurement and commerce | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#portfolio-measurement-and-commerce) |
| &nbsp;&nbsp;<a id="google-ads-change-history"></a>Google Ads change history | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#google-ads-change-history) |
| &nbsp;&nbsp;<a id="compare-an-import-before-saving-its-changes"></a>Compare an import before saving its changes | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#compare-an-import-before-saving-its-changes) |
| <a id="x-source-products-and-current-comparison"></a>X source products and current comparison | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#x-source-products-and-current-comparison) |
| &nbsp;&nbsp;<a id="preview-explicitly-selected-x-product-removal"></a>Preview explicitly selected X product removal | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#preview-explicitly-selected-x-product-removal) |
| &nbsp;&nbsp;<a id="sale-prices-retirement-variant-groups-and-snapchat-comparisons"></a>Sale prices, retirement, variant groups and Snapchat comparisons | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#sale-prices-retirement-variant-groups-and-snapchat-comparisons) |
| &nbsp;&nbsp;<a id="large-stores-saved-column-mappings-and-plan-lineage"></a>Large stores, saved column mappings and plan lineage | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#large-stores-saved-column-mappings-and-plan-lineage) |
| &nbsp;&nbsp;<a id="selected-woocommerce-source-products"></a>Selected WooCommerce source products | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#selected-woocommerce-source-products) |
| &nbsp;&nbsp;<a id="selected-woocommerce-variations-and-explicit-meta-groups"></a>Selected WooCommerce variations and explicit Meta groups | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#selected-woocommerce-variations-and-explicit-meta-groups) |
| &nbsp;&nbsp;<a id="explicit-meta-csv-product-groups"></a>Explicit Meta CSV product groups | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#explicit-meta-csv-product-groups) |
| &nbsp;&nbsp;<a id="readable-recent-ga4-event-evidence"></a>Readable recent GA4 event evidence | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#readable-recent-ga4-event-evidence) |
| &nbsp;&nbsp;<a id="inspect-other-listed-x-products-without-inferring-source-absence"></a>Inspect other listed X products without inferring source absence | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#inspect-other-listed-x-products-without-inferring-source-absence) |
| &nbsp;&nbsp;<a id="recovering-a-ga4-measurement-read"></a>Recovering a GA4 measurement read | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#recovering-a-ga4-measurement-read) |
| &nbsp;&nbsp;<a id="moving-between-measurement-inspections"></a>Moving between measurement inspections | [Portfolio, measurement and commerce](workflows/PORTFOLIO-MEASUREMENT-COMMERCE.md#moving-between-measurement-inspections) |
| <a id="client-report-packs-and-recovery"></a>Client report packs and recovery | [Client report packs and recovery](workflows/REPORT-PACKS.md#client-report-packs-and-recovery) |
| <a id="allocation-proposals-and-native-budget-drafts"></a>Allocation proposals and native budget drafts | [Allocation proposals and native budget drafts](workflows/ALLOCATION.md#allocation-proposals-and-native-budget-drafts) |
| &nbsp;&nbsp;<a id="factor-provenance-and-indicators-dec-02"></a>Factor provenance and indicators (DEC-02) | [Allocation proposals and native budget drafts](workflows/ALLOCATION.md#factor-provenance-and-indicators-dec-02) |
| &nbsp;&nbsp;<a id="meta-budget-drafts-dec-02"></a>Meta budget drafts (DEC-02) | [Allocation proposals and native budget drafts](workflows/ALLOCATION.md#meta-budget-drafts-dec-02) |
| &nbsp;&nbsp;<a id="outcome-review-dec-02"></a>Outcome review (DEC-02) | [Allocation proposals and native budget drafts](workflows/ALLOCATION.md#outcome-review-dec-02) |
| <a id="snapchat-ad-squad-allocation-drafts"></a>Snapchat ad-squad allocation drafts | [Allocation proposals and native budget drafts](workflows/ALLOCATION.md#snapchat-ad-squad-allocation-drafts) |
| &nbsp;&nbsp;<a id="allocation-selection-and-browser-review"></a>Allocation selection and browser review | [Allocation proposals and native budget drafts](workflows/ALLOCATION.md#allocation-selection-and-browser-review) |
| &nbsp;&nbsp;<a id="saved-budget-proposal-review"></a>Saved budget proposal review | [Allocation proposals and native budget drafts](workflows/ALLOCATION.md#saved-budget-proposal-review) |
| &nbsp;&nbsp;<a id="tool-timings-in-workspace-health"></a>Tool timings in workspace health | [Owner settings and workspace health](workflows/OWNER-SETTINGS.md#tool-timings-in-workspace-health) |
| &nbsp;&nbsp;<a id="owner-settings-sections"></a>Owner Settings sections | [Owner settings and workspace health](workflows/OWNER-SETTINGS.md#owner-settings-sections) |
| &nbsp;&nbsp;<a id="batch-149--local-rendered-workflow-checks"></a>Batch 149 — local rendered workflow checks | [Workflow guide batch notes of the October 2026 deliveries](records/PRODUCT-WORKFLOWS-BATCH-NOTES-2026-10.md#batch-149--local-rendered-workflow-checks) |
| &nbsp;&nbsp;<a id="batch-150--product-readability-and-source-mapping-blockers"></a>Batch 150 — product readability and source mapping blockers | [Workflow guide batch notes of the October 2026 deliveries](records/PRODUCT-WORKFLOWS-BATCH-NOTES-2026-10.md#batch-150--product-readability-and-source-mapping-blockers) |
| &nbsp;&nbsp;<a id="batch-151--complete-privacy-languages"></a>Batch 151 — complete privacy languages | [Workflow guide batch notes of the October 2026 deliveries](records/PRODUCT-WORKFLOWS-BATCH-NOTES-2026-10.md#batch-151--complete-privacy-languages) |
| <a id="website-account-diagnostics-and-references--batch-170"></a>Website account diagnostics and references — batch 170 | [Workflow guide batch notes of the October 2026 deliveries](records/PRODUCT-WORKFLOWS-BATCH-NOTES-2026-10.md#website-account-diagnostics-and-references--batch-170) |
| <a id="core-contract-diagnostics-and-public-source-comparison--batch-171"></a>Core contract diagnostics and public source comparison — batch 171 | [Workflow guide batch notes of the October 2026 deliveries](records/PRODUCT-WORKFLOWS-BATCH-NOTES-2026-10.md#core-contract-diagnostics-and-public-source-comparison--batch-171) |
| <a id="published-woocommerce-inventory-and-owner-worker-observations--batches-182183"></a>Published WooCommerce inventory and owner worker observations — batches 182/183 | [Workflow guide batch notes of the October 2026 deliveries](records/PRODUCT-WORKFLOWS-BATCH-NOTES-2026-10.md#published-woocommerce-inventory-and-owner-worker-observations--batches-182183) |
| <a id="administrator-store-connections--batch-184"></a>Administrator store connections — batch 184 | [Workflow guide batch notes of the October 2026 deliveries](records/PRODUCT-WORKFLOWS-BATCH-NOTES-2026-10.md#administrator-store-connections--batch-184) |
