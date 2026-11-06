---
status: current
tier: operator
---

# Operations

This runbook covers the current single-host deployment with read access by default and optional reviewed writes. It does not certify production release.

Its sections are task pages in [docs/operations/](operations/), each moved there on 2026-10-24 with its text unchanged (DOC-03); the table at the end says where each section went, and its old address still opens here.

## Task pages

- [Configuration](operations/CONFIGURATION.md): the environment, credentials and provider grants, the reviewed-write switches and the MCP surface flags.
- [Database storage and media staging](operations/STORAGE.md): encrypted media chunks, bounded writes, free-space admission and video conversion time.
- [Health and diagnostics](operations/HEALTH.md): `/healthz`, owner health, request IDs, job lines and event-loop delay.
- [Backup and recovery](operations/BACKUP-AND-RECOVERY.md): encrypted backups, verification, restore and the restore quarantine.
- [Secret rotation](operations/SECRET-ROTATION.md): app secrets, the master key and the other keys.
- [Account erasure, retention and the restore drill](operations/ERASURE-AND-RETENTION.md): account erasure, retention periods, backups that complete and the restore drill.
- [Schema migrations and rollback](operations/MIGRATIONS.md): start-up migrations and rolling a release back.
- [Workers, schedules and provider pacing](operations/WORKERS.md): the workers, schedules, provider request pacing and quotas.
- [HTTP deployment and service keys](operations/HTTP-DEPLOYMENT.md): the HTTP bind, service keys, AI-client registration and the hosted workflow.
- [Qualification records](operations/QUALIFICATION.md): qualification records, generated-artifact provenance and the journey and MCP evaluations.
- [Provider lifecycle](operations/PROVIDER-LIFECYCLE.md): provider API versions, sunsets and the lifecycle checks.
- [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md): workbook records, legacy names, provider access, website loading, owner oversight, catalogs and release-source verification.

The feature and batch notes it collected from the October 2026 deliveries are kept as written in [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md).

## Before a rollback

Rolling back to the previous image (Work-here) keeps every saved report, template, schedule and snapshot, because each saved report also holds its earlier form beside its current one, and the earlier build reads that form. Most reports keep running there. A report that uses several reporting levels, ID scopes, a status filter, a declared-incomplete campaign window, an undeclared detail window or a level only this build has (LinkedIn campaigns in the ad set position, the detail levels of X) cannot be written in the earlier form. On the earlier build such a report refuses to run with `INVALID_REPORT_LEVEL` before any provider request, and its schedule pauses with the same error when it next falls due. They need this build.

Before rolling back, read how many there are: the reporting overview's `bootstrap` returns `rollback.unsafe_definitions` (saved reports, templates and schedules that stop on the earlier build), and each of those records has `rollback_safe: false`. A report that someone edited on the earlier build is read again by this build as it was edited; settings only this build supports are then no longer part of it, and `bootstrap` shows a warning on that record until its next run or save. The image and database side is in [Schema migrations and rollback](operations/MIGRATIONS.md#schema-migrations-and-rollback).

## Where each section went

| Section | Now in |
|---|---|
| <a id="configuration"></a>Configuration | [Configuration](operations/CONFIGURATION.md#configuration) |
| <a id="database-storage-and-media-staging"></a>Database storage and media staging | [Database storage and media staging](operations/STORAGE.md#database-storage-and-media-staging) |
| &nbsp;&nbsp;<a id="video-conversion-time"></a>Video conversion time | [Database storage and media staging](operations/STORAGE.md#video-conversion-time) |
| <a id="health-and-diagnostics"></a>Health and diagnostics | [Health and diagnostics](operations/HEALTH.md#health-and-diagnostics) |
| &nbsp;&nbsp;<a id="correlation-and-runtime-identity"></a>Correlation and runtime identity | [Health and diagnostics](operations/HEALTH.md#correlation-and-runtime-identity) |
| <a id="backup-and-recovery"></a>Backup and recovery | [Backup and recovery](operations/BACKUP-AND-RECOVERY.md#backup-and-recovery) |
| &nbsp;&nbsp;<a id="restore-quarantine"></a>Restore quarantine | [Backup and recovery](operations/BACKUP-AND-RECOVERY.md#restore-quarantine) |
| <a id="secret-rotation"></a>Secret rotation | [Secret rotation](operations/SECRET-ROTATION.md#secret-rotation) |
| <a id="account-erasure-and-retention"></a>Account erasure and retention | [Account erasure, retention and the restore drill](operations/ERASURE-AND-RETENTION.md#account-erasure-and-retention) |
| &nbsp;&nbsp;<a id="backups-that-complete"></a>Backups that complete | [Account erasure, retention and the restore drill](operations/ERASURE-AND-RETENTION.md#backups-that-complete) |
| &nbsp;&nbsp;<a id="restore-drill"></a>Restore drill | [Account erasure, retention and the restore drill](operations/ERASURE-AND-RETENTION.md#restore-drill) |
| <a id="schema-migrations-and-rollback"></a>Schema migrations and rollback | [Schema migrations and rollback](operations/MIGRATIONS.md#schema-migrations-and-rollback) |
| <a id="workers-and-schedules"></a>Workers and schedules | [Workers, schedules and provider pacing](operations/WORKERS.md#workers-and-schedules) |
| <a id="provider-request-pacing"></a>Provider request pacing | [Workers, schedules and provider pacing](operations/WORKERS.md#provider-request-pacing) |
| &nbsp;&nbsp;<a id="provider-quota-by-issuer"></a>Provider quota by issuer | [Workers, schedules and provider pacing](operations/WORKERS.md#provider-quota-by-issuer) |
| <a id="http-deployment"></a>HTTP deployment | [HTTP deployment and service keys](operations/HTTP-DEPLOYMENT.md#http-deployment) |
| <a id="qualification-records"></a>Qualification records | [Qualification records](operations/QUALIFICATION.md#qualification-records) |
| &nbsp;&nbsp;<a id="generated-artifacts-and-catalog-provenance-arc-03"></a>Generated artifacts and catalog provenance (ARC-03) | [Qualification records](operations/QUALIFICATION.md#generated-artifacts-and-catalog-provenance-arc-03) |
| &nbsp;&nbsp;<a id="journey-and-mcp-evaluation-qa-04"></a>Journey and MCP evaluation (QA-04) | [Qualification records](operations/QUALIFICATION.md#journey-and-mcp-evaluation-qa-04) |
| &nbsp;&nbsp;&nbsp;&nbsp;<a id="mcp-evaluation-set-and-the-mcp-builder-llm-runner"></a>MCP evaluation set and the mcp-builder LLM runner | [Qualification records](operations/QUALIFICATION.md#mcp-evaluation-set-and-the-mcp-builder-llm-runner) |
| <a id="provider-lifecycle"></a>Provider lifecycle | [Provider lifecycle](operations/PROVIDER-LIFECYCLE.md#provider-lifecycle) |
| <a id="accounts-reporting-and-operating-controls"></a>Accounts, reporting and operating controls | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#accounts-reporting-and-operating-controls) |
| &nbsp;&nbsp;<a id="workbook-records-withheld-from-operations"></a>Workbook records withheld from Operations | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#workbook-records-withheld-from-operations) |
| &nbsp;&nbsp;<a id="legacy-google-action-names"></a>Legacy Google action names | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#legacy-google-action-names) |
| &nbsp;&nbsp;<a id="provider-access"></a>Provider access | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#provider-access) |
| &nbsp;&nbsp;<a id="website-feature-loading"></a>Website feature loading | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#website-feature-loading) |
| &nbsp;&nbsp;<a id="owner-tool-timings"></a>Owner tool timings | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#owner-tool-timings) |
| &nbsp;&nbsp;<a id="owner-review-oversight"></a>Owner review oversight | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#owner-review-oversight) |
| &nbsp;&nbsp;<a id="encoded-native-reporting-definitions"></a>Encoded native reporting definitions | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#encoded-native-reporting-definitions) |
| &nbsp;&nbsp;<a id="bounded-catalog-comparisons"></a>Bounded catalog comparisons | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#bounded-catalog-comparisons) |
| &nbsp;&nbsp;<a id="exact-x-catalog-prices-after-upgrade"></a>Exact X catalog prices after upgrade | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#exact-x-catalog-prices-after-upgrade) |
| &nbsp;&nbsp;<a id="search-conversion-strategy-read-back"></a>Search conversion strategy read-back | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#search-conversion-strategy-read-back) |
| &nbsp;&nbsp;<a id="google-conversion-configuration-inspection"></a>Google conversion configuration inspection | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#google-conversion-configuration-inspection) |
| &nbsp;&nbsp;<a id="local-schedule-and-worker-measurements"></a>Local schedule and worker measurements | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#local-schedule-and-worker-measurements) |
| &nbsp;&nbsp;<a id="explicit-local-product-imports-into-x"></a>Explicit local product imports into X | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#explicit-local-product-imports-into-x) |
| &nbsp;&nbsp;<a id="read-exact-supplied-x-catalog-differences"></a>Read exact supplied X catalog differences | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#read-exact-supplied-x-catalog-differences) |
| &nbsp;&nbsp;<a id="original-x-identities-and-verification-upgrade"></a>Original X identities and verification upgrade | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#original-x-identities-and-verification-upgrade) |
| &nbsp;&nbsp;<a id="explicit-selected-x-product-removals"></a>Explicit selected X product removals | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#explicit-selected-x-product-removals) |
| &nbsp;&nbsp;<a id="catalog-sale-prices-and-retirement-com-02-a-b"></a>Catalog sale prices and retirement (COM-02 A, B) | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#catalog-sale-prices-and-retirement-com-02-a-b) |
| &nbsp;&nbsp;<a id="read-only-snapchat-catalog-comparison-com-02-d"></a>Read-only Snapchat catalog comparison (COM-02 D) | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#read-only-snapchat-catalog-comparison-com-02-d) |
| &nbsp;&nbsp;<a id="catalog-destinations-sources-mappings-lineage-and-plan-groups-com-03"></a>Catalog destinations, sources, mappings, lineage and plan groups (COM-03) | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#catalog-destinations-sources-mappings-lineage-and-plan-groups-com-03) |
| &nbsp;&nbsp;<a id="verify-the-committed-release-source"></a>Verify the committed release source | [Accounts, reporting and operating controls](operations/OPERATING-CONTROLS.md#verify-the-committed-release-source) |
| <a id="current-primary-action-value-defaults"></a>Current primary-action value defaults | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#current-primary-action-value-defaults) |
| <a id="current-primary-action-activity-dates"></a>Current primary-action activity dates | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#current-primary-action-activity-dates) |
| <a id="original-google-image-reference-reads"></a>Original Google image reference reads | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#original-google-image-reference-reads) |
| <a id="selected-performance-max-image-reference-view"></a>Selected Performance Max image reference view | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#selected-performance-max-image-reference-view) |
| &nbsp;&nbsp;<a id="original-performance-max-campaign-logo-references"></a>Original Performance Max campaign logo references | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#original-performance-max-campaign-logo-references) |
| &nbsp;&nbsp;<a id="selected-woocommerce-source-products"></a>Selected WooCommerce source products | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#selected-woocommerce-source-products) |
| &nbsp;&nbsp;<a id="original-snapchat-top-snap-references"></a>Original Snapchat top-snap references | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#original-snapchat-top-snap-references) |
| &nbsp;&nbsp;<a id="current-owner-directed-release-checks"></a>Current owner-directed release checks | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#current-owner-directed-release-checks) |
| &nbsp;&nbsp;<a id="batch-149--local-rendered-workflow-checks"></a>Batch 149 — local rendered workflow checks | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#batch-149--local-rendered-workflow-checks) |
| &nbsp;&nbsp;<a id="batch-150--product-readability-and-source-mapping-blockers"></a>Batch 150 — product readability and source mapping blockers | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#batch-150--product-readability-and-source-mapping-blockers) |
| &nbsp;&nbsp;<a id="batch-151--complete-privacy-languages"></a>Batch 151 — complete privacy languages | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#batch-151--complete-privacy-languages) |
| <a id="campaigndeviceday-evidence-qualification"></a>Campaign/device/day evidence qualification | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#campaigndeviceday-evidence-qualification) |
| <a id="persistent-evidence-capture-feedback"></a>Persistent evidence capture feedback | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#persistent-evidence-capture-feedback) |
| &nbsp;&nbsp;<a id="worker-health-under-sqlite-contention"></a>Worker health under SQLite contention | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#worker-health-under-sqlite-contention) |
| &nbsp;&nbsp;<a id="capture-diagnostic-language-ownership"></a>Capture diagnostic language ownership | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#capture-diagnostic-language-ownership) |
| &nbsp;&nbsp;<a id="measurement-read-diagnostics"></a>Measurement read diagnostics | [Operations runbook notes of the October 2026 deliveries](records/OPERATIONS-NOTES-2026-10.md#measurement-read-diagnostics) |
