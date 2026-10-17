# Document kinds and retention

Generated from the document-kind registry, `src/document-kinds.ts` (ARC-02), by
`npm run build && node dist/tools/document-kinds-doc.js`. Do not edit it by hand: change the registry and generate
it again; `tests/document-registry.test.mjs` fails when the two differ. How to add or change a kind:
[Adding a document kind](ADDING-A-DOCUMENT-KIND.md).

AMCP keeps most of its records as JSON documents in one SQLite table, `documents`, keyed by workspace, kind and id.
The registry declares every kind once: the module that owns its shape, whether it belongs to a workspace or to the
service, the payload version this release writes, the fields the store layer reads (its store contract) and how
long its documents are kept. Code reads and writes a kind through a repository bound to one workspace
(`store.repo(kind, workspace)`) or, for a service record, to its reserved partition (`store.serviceRepo(kind)`), so
one workspace can never read, change or delete another workspace’s documents through it.

92 kinds are declared: 84 belong to a workspace and 8 to the service.

## Retention

Retention is designed to the GDPR and the KSA PDPL (owner decision P3, 2026-10-11) and set per document kind
(owner decision P11). Whatever its kind, every document of a workspace is deleted when the account and its workspace
are erased: by the person (Account → Delete your account), by the operator (`admin erase-account`) or by the
retention sweep (sign-ups never approved after 30 days, accounts revoked 90 days after revocation). Copies that
application retention cannot reach (the write-ahead log until its next checkpoint, volume snapshots and older
encrypted backups) expire on their own schedule; see docs/OPERATIONS.md, "Account erasure and retention".

| Rule | Kinds | Meaning |
|---|---:|---|
| Report retention | 4 | Deleted hourly once older than the workspace owner's report retention period (Settings, 7–365 days) or, without one, `AMCP_REPORT_RETENTION_DAYS` (365 days; `off` keeps them). |
| With its parent | 4 | Deleted with the document it belongs to. |
| Expires | 19 | Ignored past its deadline and deleted by the sweep or module named. |
| Fixed period | 6 | Deleted a fixed number of days after its clock field. |
| Owner opt-in | 1 | Deleted only after a period the workspace owner opts in to; kept otherwise. |
| Rewritten in place | 6 | One small document per key, rewritten in place: it does not grow. |
| While the workspace exists | 50 | Kept while the workspace exists; deleted when its account and workspace are erased. |
| With the deployment | 2 | Kept with the deployment: needed to re-apply erasures to a restored copy or to recognise the volume. |

### The hourly report cleanup

Per workspace, in this order, so that a snapshot deleted in a pass takes its presentation and files along:

1. `report_incident`: Deleted once resolved or superseded and not updated for the report retention period; open and acknowledged incidents are kept.
2. `decision_report`: Deleted once older than the report retention period, from its capture.
3. `overview_report`: Deleted once finished and older than the report retention period, from its creation, unless a job still runs for it or a Google Sheets delivery of it is unconfirmed.
4. `sheets_delivery`: Deleted once complete, rejected or abandoned, older than the report retention period and its snapshot is gone; an unconfirmed delivery keeps its snapshot.
5. `report_presentation`: Deleted with its snapshot: when the snapshot is deleted, or by the report cleanup once it is gone.
6. `report_file`: Deleted with its snapshot: when the snapshot is deleted, or by the report cleanup once it is gone.
7. Finished jobs of kinds `report_overview`, `sheets_export`, `report_file_export`, `report`, from their last update, unless a Google Sheets delivery of their snapshot is unconfirmed.

The same pass deletes provider job receipts after 90 days, spend reservations older than two days and, when the owner
opted in, archived campaign plans. Each pass that deleted something appends `report_retention_applied` to the
workspace's audit, with counts per kind.

### The maintenance timer

- `provider_budget`, `tiktok_report_quota`, `worker_heartbeat`: Deleted by the maintenance timer a day after its last use.
- `tiktok_report_run`, `x_report_result`, `x_report_run`: Deleted by the maintenance timer once expired.

### What follows a person, a login or a backup

- **Account erasure** also deletes, in other workspaces, the documents that belong to the erased person: `member_access_set`, `monitor_notice`, `monitor_subscription`, `workspace_invite`.
- **A local disconnect** deletes the documents read through the login: `account_metadata`, `conditional_program_observation`, `connection_health`, `decision_report`, `microsoft_report`, `oauth_progress`, `overview_report`, `readiness`, `report_incident`, `website_assets`, `website_connection`.
- **Encrypted backups** leave out: `media_source`, `media_variant`, `retained_media_source` (website uploads), `upload_session`.

## Workspace kinds

| Kind | What it holds | Retention | Owner module | Version | Store contract and bindings |
|---|---|---|---|---:|---|
| `access_set` | A client access set: the accounts a limited key, AI client or member may use (SEC-08). | **While the workspace exists**. | `src/access-sets.ts` | 1 |  |
| `account_metadata` | A provider account's name, currency and time zone as its last live read returned, per login. | **While the workspace exists**. Kept while the workspace and the login exist. | `src/account-metadata.ts` | 1 | Store contract: `connection_id` string, `account_id` string; Deleted with its login (`connection_id`) |
| `account_settings` | A workspace setting, one document per setting: the name, viewer downloads, the two-step baseline and other website switches. | **While the workspace exists**. | `server/account-security.ts` | 1 |  |
| `allocation_outcome` | The measured outcome of a verified allocation plan, captured after its window closed (DEC-02). | **While the workspace exists**. | `src/allocation-outcome.ts` | 1 |  |
| `allocation_preview` | A budget allocation proposal before it becomes a plan. | **Expires** (`expires_at` passed, by its owner module when it saves the next one). Deleted once expired, when the next proposal is saved. | `src/allocation-plan.ts` | 1 | Store contract: `expires_at` number |
| `backup_receipt` | The receipt of a verified encrypted backup, copied into every workspace (OPS-04). | **While the workspace exists**. | `src/backup.ts` | 1 | Store contract: `verified_at` number |
| `campaign_run` | A campaign plan: its steps, reviews and run state. | **Owner opt-in** (setting `archived_campaign_plans_days`). Archived plans are deleted after the owner’s archived-plan period (7–3650 days, off by default); plans that are not archived are kept. | `src/campaign-runner.ts` | 1 | Store contract: `state` string, `archived` object? |
| `catalog_lineage_binding` | A short-lived binding of a catalog comparison to the plan it seeds (COM-03). | **Expires** (`expires_at` reached, by its owner module when it saves the next one). Valid 90 seconds; deleted by the next binding. | `src/catalog-lineage.ts` | 1 | Store contract: `expires_at` number |
| `catalog_mapping_profile` | A saved catalog column mapping and its version (COM-03). | **While the workspace exists**. | `src/catalog-mapping.ts` | 1 |  |
| `client_brief` | A client brief saved for guided campaign recipes. | **While the workspace exists**. | `src/recipe-context.ts` | 1 |  |
| `client_profile` | A client of the workspace: its name, account bindings and approved report presentation (SEC-08). | **While the workspace exists**. | `src/client-scope.ts` | 1 |  |
| `conditional_program_observation` | A timestamped observation of a conditional provider program, never a grant (D20). | **Expires** (`expires_at` reached, by its owner module when it saves the next one). Kept 30 days; deleted once expired when the next observation is saved. | `src/conditional-programs.ts` | 1 | Store contract: `connection_id` string, `expires_at` number; Deleted with its login (`connection_id`) |
| `connection_disconnection` | The receipt of a local disconnect, kept so that a repeated disconnect replays it. | **While the workspace exists**. | `src/connection-disconnect.ts` | 1 |  |
| `connection_health` | Credential health of one login (CON-02); the document id is the connection id. | **While the workspace exists**. Kept while the workspace and the login exist. | `src/connection-health.ts` | 1 | Deleted with its login (document id) |
| `creative_metadata` | The name and tags a person gave a creative library item. | **While the workspace exists**. | `src/creative-library.ts` | 1 |  |
| `criteo_report_run` | A Criteo report job bound to its review. | **Expires** (`retained_until` reached, by its owner module when it saves the next one). Kept 7 days; deleted once expired when the next job is recorded. | `src/criteo-report-jobs.ts` | 1 | Store contract: `retained_until` number |
| `decision_report` | A captured analysis report. | **Report retention** (from `captured_at`, order 2). Deleted once older than the report retention period, from its capture. | `src/decision-reporting.ts` | 1 | Store contract: `captured_at` number, `connection_id` string?; Deleted with its login (`connection_id`) |
| `erasure_receipt` | An account erasure receipt in the deployment's workspace (SEC-07); random ids only, re-applied after a restore. | **With the deployment**. Kept with the deployment, so that an erasure can be applied again to a restored copy. | `src/account-erasure.ts` | 1 |  |
| `ga4_test_property` | A GA4 property the owner marked for the test-identity mode (MSR-04). | **While the workspace exists**. | `src/measurement-test-properties.ts` | 1 |  |
| `gtm_consent_preview` | A GTM consent plan preview before it becomes a plan. | **Expires** (`expires_at` reached, by its owner module when it saves the next one). Deleted once expired, when the next preview is saved. | `src/gtm-consent-plans.ts` | 1 | Store contract: `expires_at` number |
| `linkedin_post` | A LinkedIn post AMCP created, kept for its verification. | **While the workspace exists**. | `src/linkedin-posts.ts` | 1 |  |
| `media_review` | A media upload review: the frozen copy's plan and its transfer state. | **Expires** (`expires_at` reached, by the media cleanup timer). Deleted by the media cleanup once its staging expired. | `src/media-upload.ts` | 1 | Store contract: `expires_at` number; Indexes: `media_documents_by_kind` |
| `media_source` | An original file a person uploaded or imported, waiting to be pushed. | **Expires** (`expires_at` reached, by the media cleanup timer). Deleted by the media cleanup once expired; a website upload at most 30 minutes after it was made. | `src/media-sources.ts` | 1 | Store contract: `expires_at` number, `created_at` number?, `origin` string?, `state` string?; Left out of backups; Indexes: `media_documents_by_kind` |
| `media_variant` | A derived media variant and its transfer state. | **Expires** (`expires_at` reached, by the media cleanup timer). Deleted by the media cleanup once it or its original upload expired. | `src/media-upload.ts` | 1 | Store contract: `expires_at` number, `upload_expires_at` number?; Left out of backups; Indexes: `media_documents_by_kind` |
| `member_access_set` | The client access set a member is limited to; the document id is the member's user id. | **While the workspace exists**. Kept while the membership exists. | `src/access-sets.ts` | 1 | Store contract: `access_set_id` string; Erased with the person (document id) |
| `meta_report_run` | A Meta asynchronous insights job bound to its review. | **Expires** (`expires_at` reached, by nothing: it is ignored once expired). Valid 7 days; ignored once expired and kept while the workspace exists. | `src/meta-insights-jobs.ts` | 1 | Store contract: `expires_at` number |
| `microsoft_report` | A parsed Microsoft report download. | **Expires** (`expires_at` reached, by its owner module when it saves the next one). Deleted once expired, when the next download is parsed. | `src/scope.ts` | 1 | Store contract: `expires_at` number, `connection_id` string?; Deleted with its login (`connection_id`) |
| `monitor_notice` | A report monitor notice for one subscriber. | **Fixed period** (30 days after `created_at`, by its owner module when it saves the next one). Deleted 30 days after it was created, by the monitor delivery pass. | `src/monitor-delivery.ts` | 1 | Store contract: `user_id` string, `created_at` number, `expires_at` number?, `state` string?; Erased with the person (`user_id`) |
| `monitor_subscription` | A person's subscription to a report monitor. | **While the workspace exists**. Kept while the workspace exists and the person keeps it. | `src/monitor-delivery.ts` | 1 | Store contract: `user_id` string; Erased with the person (`user_id`) |
| `oauth_progress` | The progress of one provider authorization attempt. | **While the workspace exists**. Kept while the workspace exists; deleted with the login it connected. | `server/platform-oauth.ts` | 1 | Store contract: `connectionId` string?; Deleted with its login (`connectionId`) |
| `operation_journal` | The phase journal of one reviewed write, keyed by its idempotency key. | **While the workspace exists**. Kept with the workspace’s write claims, for reconciliation. | `src/store.ts` | 1 |  |
| `overview_checkpoint` | A resumable collection checkpoint of an Overview snapshot; its id starts with the snapshot id. | **With its parent** (parent `overview_report`, by a schema trigger, in the same statement). Deleted with its snapshot (trigger overview_report_parts_cleanup). | `src/report-checkpoints.ts` | 1 | Store contract: `report_id` string; Indexes: `overview_report_parts_cleanup` |
| `overview_export` | An export of an Overview snapshot to Google Sheets or report files. | **While the workspace exists**. Kept while the workspace exists; deleted with its snapshot when a person deletes the snapshot. | `src/reporting-overview.ts` | 1 | Store contract: `report_id` string, `state` string? |
| `overview_report` | An Overview report snapshot: its configuration, rows and delivery state. | **Report retention** (from `created_at`, order 3). Deleted once finished and older than the report retention period, from its creation, unless a job still runs for it or a Google Sheets delivery of it is unconfirmed. | `src/reporting-overview.ts` | 1 | Store contract: `created_at` number, `state` string; Deleted with its login (rows or sources); Indexes: `overview_report_parts_cleanup` |
| `overview_report_budget` | The split collection budget of an Overview snapshot; the document id is the snapshot id. | **With its parent** (parent `overview_report`, by a schema trigger, in the same statement). Deleted with its snapshot (trigger overview_report_parts_cleanup). | `src/report-checkpoints.ts` | 1 | Store contract: `report_id` string; Indexes: `overview_report_parts_cleanup` |
| `overview_schedule` | A saved Overview report schedule. | **While the workspace exists**. | `src/report-library.ts` | 1 | Store contract: `is_active` boolean?, `next_run_at` number?; Indexes: `overview_schedule_due`, `overview_schedule_due_global` |
| `overview_schedule_deleted` | A marker of a deleted Overview schedule, so that a repeated workbook migration does not recreate it. | **While the workspace exists**. | `src/report-library.ts` | 1 | Store contract: `deleted_at` number |
| `overview_template` | A saved Overview report template. | **While the workspace exists**. | `src/report-library.ts` | 1 |  |
| `overview_view` | A saved Overview report view. | **While the workspace exists**. | `src/report-library.ts` | 1 |  |
| `personal_data_account` | The owner's personal-data switch for one ad account. | **While the workspace exists**. | `src/personal-data-access.ts` | 1 |  |
| `plan_policy` | The workspace's campaign plan policy (CMP-05). | **While the workspace exists**. | `src/campaign-inventory.ts` | 1 |  |
| `preview_receipt` | The encrypted native preview of a reviewed write, recoverable for 24 hours. | **Expires** (`expires_at` reached, by the media cleanup timer). Deleted by the media cleanup 24 hours after it was saved. | `src/store.ts` | 1 | Store contract: `secret` string, `expires_at` number; Indexes: `media_documents_by_kind` |
| `provider_job` | The receipt of a provider report or export job (RPT-06). | **Fixed period** (90 days after `retain_until`, by the hourly report cleanup). Kept 90 days: a settled receipt from when it settled, a submitting or uncertain one from when it was created. | `src/provider-jobs.ts` | 1 | Store contract: `state` string, `created_at` number, `retain_until` number? |
| `provider_metrics` | Request counters of a workspace per provider gateway; the document id is the gateway. | **Rewritten in place**. One document per gateway, rewritten in place. | `src/store.ts` | 1 | Store contract: `at` number? |
| `provider_validation` | The receipt of a provider validate-only call, keyed by its request hash. | **While the workspace exists**. | `src/provider-validation.ts` | 1 |  |
| `readiness` | Readiness evidence of one of a login's accounts. | **While the workspace exists**. Kept while the workspace and the login exist. | `src/workspace.ts` | 1 | Store contract: `connection_id` string; Deleted with its login (`connection_id`) |
| `recipe_eligibility` | A cached guided-recipe eligibility check of one person's selection. | **Expires** (`expires_at` reached (none counts as expired), by its owner module when it saves the next one). Deleted once expired when the next check is saved; each person keeps at most the newest 20. | `src/recipe-eligibility.ts` | 1 | Store contract: `expires_at` number, `user_id` string, `saved_at` number? |
| `reddit_post_resolution` | How a Reddit post created for a review resolved; the document id is the review id. | **While the workspace exists**. | `src/reddit-post-creation.ts` | 1 |  |
| `report_file` | A generated report file (CSV, PDF or XLSX) of a snapshot, encrypted. | **With its parent** (parent `overview_report`, by the hourly report cleanup). Deleted with its snapshot: when the snapshot is deleted, or by the report cleanup once it is gone. | `src/report-file-delivery.ts` | 1 | Store contract: `report_id` string, `storage_bytes` number? |
| `report_file_destination` | A saved report-file destination: its formats and presentation. | **While the workspace exists**. | `src/report-file-delivery.ts` | 1 |  |
| `report_incident` | A monitoring incident a report monitor raised. | **Report retention** (from `updated_at`, order 1). Deleted once resolved or superseded and not updated for the report retention period; open and acknowledged incidents are kept. | `src/report-monitors.ts` | 1 | Store contract: `state` string?, `updated_at` number?, `superseded_by_version` integer?, `connection_id` string?; Deleted with its login (`connection_id`) |
| `report_job_grant` | The accounts of a login whose report jobs the owner allowed (RPT-06); the document id is the login's id. | **While the workspace exists**. | `src/provider-jobs.ts` | 1 |  |
| `report_monitor` | A report monitor rule. | **While the workspace exists**. | `src/report-monitors.ts` | 1 |  |
| `report_presentation` | The presentation of an Overview snapshot; the document id is the snapshot's. | **With its parent** (parent `overview_report`, by the hourly report cleanup). Deleted with its snapshot: when the snapshot is deleted, or by the report cleanup once it is gone. | `src/report-packs.ts` | 1 |  |
| `report_reconciliation` | A reconciliation of an analysis against its source report. | **While the workspace exists**. | `src/decision-reporting.ts` | 1 |  |
| `reporting_query` | A saved workbook reporting query. | **While the workspace exists**. | `src/reporting.ts` | 1 | Store contract: `workbook_binding_id` string?; Indexes: `reporting_query_workbook` |
| `reporting_schedule` | A workbook reporting schedule. | **While the workspace exists**. | `src/workbook-schedules.ts` | 1 | Store contract: `is_active` boolean?, `next_run_at` number?; Indexes: `reporting_schedule_due`, `reporting_schedule_due_global` |
| `retained_media_source` | A retained original file: provider media, or a website upload kept up to its 30-minute deadline. | **Expires** (`created_at` reached, by the media cleanup timer). A website upload is deleted by the media cleanup 30 minutes after it was made; other retained files are kept while the workspace exists. | `src/media-sources.ts` | 1 | Store contract: `origin` string?, `created_at` number?; Website uploads left out of backups; Indexes: `media_documents_by_kind` |
| `retention_policy` | The owner's retention periods: report days and archived campaign plan days. | **While the workspace exists**. | `src/owner-operations.ts` | 1 | Store contract: `days` integer?, `archived_campaign_plans_days` integer? |
| `sandbox_run` | A live sandbox run of the operator's sandbox tool. | **While the workspace exists**. | `tools/live-sandbox.ts` | 1 |  |
| `search_exclusion_preview` | A search exclusion plan preview before it becomes a plan. | **Expires** (`expires_at` passed, by its owner module when it saves the next one). Deleted once expired, when the next preview is saved. | `src/search-exclusion-plan.ts` | 1 | Store contract: `expires_at` number |
| `service_timings` | Rolling timings of a workspace's tool calls, per category. | **Rewritten in place**. One document per category, rewritten in place. | `src/service-timings.ts` | 1 |  |
| `sheets_creation` | A Google spreadsheet creation request and its outcome. | **While the workspace exists**. | `src/google-sheets.ts` | 1 |  |
| `sheets_delivery` | The receipt of one Google Sheets delivery of a snapshot. | **Report retention** (from `abandoned_at` or `completed_at` or `sent_at`, order 4). Deleted once complete, rejected or abandoned, older than the report retention period and its snapshot is gone; an unconfirmed delivery keeps its snapshot. | `src/google-sheets.ts` | 1 | Store contract: `report_id` string, `state` string, `abandoned_at` number?, `completed_at` number?, `sent_at` number? |
| `sheets_destination` | A saved Google Sheets destination. | **While the workspace exists**. | `src/google-sheets.ts` | 1 |  |
| `spend_policy` | An owner spending policy of an account; the document id is the account's policy key. | **While the workspace exists**. | `src/spend-policy.ts` | 1 |  |
| `spend_reservation` | A reviewed write's reservation against a daily spending limit. | **Fixed period** (2 days after `day`, by the hourly report cleanup). Readable only on its own UTC day; deleted by the hourly cleanup once older than two days, or when its write is released. | `src/spend-policy.ts` | 1 | Store contract: `day` string, `policy_id` string? |
| `tiktok_report_run` | A TikTok report task bound to its review. | **Expires** (`expires_at` reached, by the maintenance timer, once a minute). Deleted by the maintenance timer once expired. | `src/tiktok-report-jobs.ts` | 1 | Store contract: `expires_at` number |
| `upload_session` | An encrypted chunked-upload session. | **Expires** (`expires_at` reached, by the media cleanup timer). Deleted by the media cleanup once expired. | `src/store.ts` | 1 | Store contract: `secret` string, `expires_at` number; Left out of backups; Indexes: `media_documents_by_kind` |
| `website_assets` | The assets a login can select, as its last discovery listed them; the document id is the connection id. | **While the workspace exists**. Kept while the workspace and the login exist. | `server/website.ts` | 1 | Deleted with its login (document id) |
| `website_connection` | The website side of a login: its selection and settings; the document id is the connection id. | **While the workspace exists**. Kept while the workspace and the login exist. | `server/website.ts` | 1 | Store contract: `createdAt` number?; Deleted with its login (document id) |
| `website_mcp_token` | A connector token's record: its name, role, hash, creator and revocation. | **While the workspace exists**. | `server/website.ts` | 1 | Store contract: `hash` string |
| `workbook` | A workbook bound to a Google spreadsheet. | **While the workspace exists**. | `src/workbook-bindings.ts` | 1 | Store contract: `spreadsheet_id` string? |
| `workspace_asset` | A media asset saved to the workspace library; the document id is its review id. | **While the workspace exists**. | `src/media-upload.ts` | 1 |  |
| `workspace_invite` | An invitation to the workspace, naming the invited person's hashed e-mail address. | **While the workspace exists**. | `server/account-security.ts` | 1 | Store contract: `emailHash` string; Erased with the person (`emailHash`) |
| `write_approval` | An approval of a reviewed write (WRT-09); the document id is the review id. | **While the workspace exists**. | `src/write-approval.ts` | 1 |  |
| `write_pause` | The owner's pause of the workspace's reviewed writes. | **While the workspace exists**. Kept until an owner resumes writes. | `src/owner-operations.ts` | 1 |  |
| `write_reconciliation` | The reconciliation of an uncertain reviewed write. | **While the workspace exists**. | `src/write-reconciliation.ts` | 1 |  |
| `write_review` | A reviewed write: the prepared plan, its consent and its outcome. | **While the workspace exists**. Kept while the workspace exists, as the record of the change. | `src/write-review.ts` | 1 |  |
| `write_review_group` | A group of reviewed writes executed together. | **While the workspace exists**. | `src/write-groups.ts` | 1 |  |
| `write_verification` | The read-back verification of a reviewed write. | **While the workspace exists**. | `src/write-verification.ts` | 1 |  |
| `x_catalog_removal_preview` | An X catalog removal preview before it becomes a plan. | **Expires** (`expires_at` reached, unless `plan_id` is set, by its owner module when it saves the next one). Deleted once expired and not bound to a plan, when the next preview is saved. | `src/x-catalog-removal.ts` | 1 | Store contract: `expires_at` number, `plan_id` string? |
| `x_report_result` | An encrypted X report result. | **Expires** (`expires_at` reached, by the maintenance timer, once a minute). Deleted by the maintenance timer once expired. | `src/store.ts` | 1 | Store contract: `secret` string, `expires_at` number |
| `x_report_run` | An X asynchronous report job bound to its review. | **Expires** (`expires_at` reached, by the maintenance timer, once a minute). Deleted by the maintenance timer once expired. | `src/x-report-jobs.ts` | 1 | Store contract: `expires_at` number |

## Service kinds

Service records are stored under a reserved workspace id that is never a real workspace (the store refuses it as
one): `limits` is `__service_limits__`, `system` is `__amcp_system__`.

| Kind | Partition | What it holds | Retention | Owner module | Version | Store contract |
|---|---|---|---|---|---:|---|
| `provider_budget` | `limits` | A provider request budget (token bucket); the document id is the hashed provider key. | **Fixed period** (1 day after `at`, by the maintenance timer, once a minute). Deleted by the maintenance timer a day after its last use. | `src/store.ts` | 1 | Store contract: `at` number |
| `provider_job_quota` | `limits` | The rolling window of provider job submissions per provider key. | **Rewritten in place**. One document per key, rewritten in place with a bounded window. | `src/provider-jobs.ts` | 1 | Store contract: `times` array |
| `queue_cursor` | `limits` | The job dispatch cursor that orders the workspaces' jobs fairly. | **Rewritten in place**. One document, rewritten in place. | `src/store.ts` | 1 | Store contract: `ordinal` integer |
| `storage_volume` | `system` | The persistent-volume marker the start-up check compares with the data directory (OPS-03). | **With the deployment**. Kept with the deployment; an operator re-stamps it after a restore. | `server/volume.ts` | 1 | Store contract: `volume_id` string |
| `tenant_dispatch` | `limits` | A workspace's place in the fair job dispatch order; the document id is the workspace id. | **Rewritten in place**. One document per workspace, rewritten in place. | `src/store.ts` | 1 | Store contract: `ordinal` integer, `at` number |
| `tiktok_report_quota` | `limits` | TikTok report task counters per advertiser and per minute. | **Fixed period** (1 day after `at`, by the maintenance timer, once a minute). Deleted by the maintenance timer a day after its last use. | `src/tiktok-report-jobs.ts` | 1 | Store contract: `at` number |
| `worker_heartbeat` | `limits` | A worker process heartbeat; the document id is the worker id. | **Fixed period** (1 day after `at`, by the maintenance timer, once a minute). Deleted by the maintenance timer a day after its last beat. | `src/worker.ts` | 1 | Store contract: `at` number, `boot` string?, `state` string? |
| `x_report_quota` | `limits` | The active X report job slots of a provider key. | **Rewritten in place**. One document per key, rewritten in place and deleted when no slot is used. | `src/x-report-jobs.ts` | 1 | Store contract: `active` array |
