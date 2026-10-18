/**
 * Document-kind registry (ARC-02). The `documents` table holds JSON documents keyed by (workspace, kind, id); this
 * module declares every kind once: who owns its shape, whether it belongs to a workspace or to the service, the fields
 * the store layer reads, how long it is kept, and which person, login, backup and index rules apply to it. The store,
 * the retention sweeps (SEC-07, owner decisions P3 and P11 of 2026-10-11), account erasure and backups read these
 * declarations instead of keeping their own lists, and `tools/check-storage-boundary.mjs` fails when application code
 * names a kind that is not declared here. docs/DOCUMENT-KINDS.md is generated from this file.
 *
 * - `scope: 'tenant'` documents belong to one workspace and are read through `store.repo(kind, tenant)` or the store's
 *   document methods, which always bind the workspace. `scope: 'service'` documents belong to the deployment (limits,
 *   heartbeats, cursors, the volume marker) and are read through `store.serviceRepo(kind)`; they are stored under a
 *   reserved workspace id of their `partition`, which is never a real workspace (the store refuses it as one).
 * - `version` is the payload version this release writes. A change that an older release would misread bumps it and
 *   ships with readers of both versions and, when stored documents must be rewritten, a schema ledger step
 *   (src/schema-migrations.ts, docs/OPERATIONS.md "Schema migrations and rollback").
 * - `fields` is the store contract: the top-level fields the store layer's SQL, retention and erasure read, with their
 *   JSON types (a trailing `?` marks a field that may be absent). The owner module owns every other field.
 * - `retention` says when documents of the kind are deleted; see `Retention`.
 *
 * This module is a leaf: it imports types only, so the reviewed-write path that loads the store gains no refusals.
 */
import type {JsonObject} from './types.js';

export type DocumentScope = 'tenant' | 'service';
/** Service partitions: the reserved workspace ids that hold service documents, unchanged from earlier releases. */
export const servicePartitions = {limits: '__service_limits__', system: '__amcp_system__'} as const;
export type ServicePartition = keyof typeof servicePartitions;
export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
/**
 * When documents of a kind are deleted. Every rule also ends with the workspace: account erasure deletes every
 * document of an erased workspace (src/account-erasure.ts), and service documents never belong to one.
 * - `report`: the workspace's report retention (SEC-07): the owner's 7–365-day period, else
 *   `AMCP_REPORT_RETENTION_DAYS` (365 days, or `off`), counted from `from` (the first of the listed fields present),
 *   applied hourly by the report cleanup (src/retention-repository.ts) in `order`.
 * - `with_parent`: deleted with the parent document named by `link` (`id`: the same id; otherwise a field holding the
 *   parent's id), by `by` (a schema trigger, the report cleanup, or the parent's delete).
 * - `expires`: past the deadline in `field` it is ignored, and deleted by `by`: the store's maintenance timer (once a
 *   minute), the media cleanup timer, the owner module when it next writes the kind, or nothing (`read`: ignored after
 *   the deadline and kept until the workspace goes).
 * - `period`: deleted `days` after `from` by `by` (the hourly report cleanup, the maintenance timer, or the owner).
 * - `owner_opt_in`: deleted only when the workspace owner sets `setting` (archived campaign plans, CMP-05).
 * - `replaced`: one small document per key, rewritten in place (a counter, cursor or rolling window); it does not grow.
 * - `workspace`: kept while the workspace exists: settings, saved definitions and the records of reviewed work.
 * - `deployment`: kept with the deployment: erasure receipts (re-applied after a restore) and the volume marker.
 */
export type Retention =
  | {rule: 'report'; from: readonly string[]; order: number; summary: string}
  | {
      rule: 'with_parent';
      parent: string;
      link: 'id' | string;
      by: 'schema_trigger' | 'report_cleanup' | 'parent_delete';
      /** Its place in the report cleanup, after its parent's (`by: 'report_cleanup'` only). */
      order?: number;
      summary: string;
    }
  | {
      rule: 'expires';
      field: string;
      by: 'maintenance' | 'media_cleanup' | 'owner_module' | 'read';
      /** Deleted only once the deadline is before the clock (`<`); without it, once the clock reaches it (`<=`). */
      strict?: true;
      /** A document without the deadline counts as expired; without it, such a document is kept. */
      missing?: 'expired';
      /** A document whose `unless` field is set (not null) is kept whatever its deadline. */
      unless?: string;
      summary: string;
    }
  | {rule: 'period'; days: number; from: string; by: 'report_cleanup' | 'maintenance' | 'owner_module'; summary: string}
  | {rule: 'owner_opt_in'; setting: string; summary: string}
  | {rule: 'replaced'; summary: string}
  | {rule: 'workspace'; summary: string}
  | {rule: 'deployment'; summary: string};
export interface DocumentKindSpec {
  scope: DocumentScope;
  /** Service scope only: where its documents are stored. */
  partition?: ServicePartition;
  /** The module that owns the payload's shape (its main writer). */
  owner: string;
  version: number;
  summary: string;
  fields: Readonly<Record<string, FieldType>>;
  retention: Retention;
  /**
   * A person the document belongs to in another person's workspace: account erasure deletes it in every workspace
   * (`id`: the document id is the person's user id; `user_id`: the field holds it; `email_hash`: the field holds the
   * SHA-256 of the person's lower-case e-mail address).
   */
  person?: {match: 'id' | 'user_id' | 'email_hash'; field?: string};
  /**
   * Deleted with the login it was read through when an administrator disconnects it (src/connection-disconnect.ts):
   * the document id is the login's id (`id`), a field holds it (`field`), or, for a finished snapshot, its rows or
   * configured sources name it (`sources`).
   */
  connection?: {match: 'id' | 'field' | 'sources'; field?: string};
  /** Left out of encrypted backups: always, or only for a website upload (`origin: upload`). */
  backup?: 'excluded' | 'excluded_upload_origin';
  /** Indexes and triggers on `documents` that serve the kind; schema ledger steps create them. */
  indexes?: readonly string[];
}

const workspace = (summary = 'Kept while the workspace exists.'): Retention => ({rule: 'workspace', summary});
/** Expiry the owner module applies (`DocumentRepository.purgeExpired`), typically when it saves the next document. */
const ownerExpiry = (
  field: string,
  summary: string,
  options: {strict?: true; missing?: 'expired'; unless?: string} = {},
): Retention => ({
  rule: 'expires',
  field,
  by: 'owner_module',
  ...options,
  summary,
});

/** Every document kind AMCP stores, by name. Keys are the stored `documents.kind` values. */
export const documentKindSpecs = {
  access_set: {
    scope: 'tenant',
    owner: 'src/access-sets.ts',
    version: 1,
    summary: 'A client access set: the accounts a limited key, AI client or member may use (SEC-08).',
    fields: {},
    retention: workspace(),
  },
  account_metadata: {
    scope: 'tenant',
    owner: 'src/account-metadata.ts',
    version: 1,
    summary: "A provider account's name, currency and time zone as its last live read returned, per login.",
    fields: {connection_id: 'string', account_id: 'string'},
    retention: workspace('Kept while the workspace and the login exist.'),
    connection: {match: 'field', field: 'connection_id'},
  },
  account_settings: {
    scope: 'tenant',
    owner: 'server/account-security.ts',
    version: 1,
    summary:
      'A workspace setting, one document per setting: the name, viewer downloads, the two-step baseline and other website switches.',
    fields: {},
    retention: workspace(),
  },
  allocation_outcome: {
    scope: 'tenant',
    owner: 'src/allocation-outcome.ts',
    version: 1,
    summary: 'The measured outcome of a verified allocation plan, captured after its window closed (DEC-02).',
    fields: {},
    retention: workspace(),
  },
  allocation_preview: {
    scope: 'tenant',
    owner: 'src/allocation-plan.ts',
    version: 1,
    summary: 'A budget allocation proposal before it becomes a plan.',
    fields: {expires_at: 'number'},
    retention: ownerExpiry('expires_at', 'Deleted once expired, when the next proposal is saved.', {strict: true}),
  },
  backup_receipt: {
    scope: 'tenant',
    owner: 'src/backup.ts',
    version: 1,
    summary: 'The receipt of a verified encrypted backup, copied into every workspace (OPS-04).',
    fields: {verified_at: 'number'},
    retention: workspace(),
  },
  campaign_run: {
    scope: 'tenant',
    owner: 'src/campaign-runner.ts',
    version: 1,
    summary: 'A campaign plan: its steps, reviews and run state.',
    fields: {state: 'string', 'archived?': 'object'},
    retention: {
      rule: 'owner_opt_in',
      setting: 'archived_campaign_plans_days',
      summary:
        'Archived plans are deleted after the owner’s archived-plan period (7–3650 days, off by default); plans that are not archived are kept.',
    },
  },
  catalog_lineage_binding: {
    scope: 'tenant',
    owner: 'src/catalog-lineage.ts',
    version: 1,
    summary: 'A short-lived binding of a catalog comparison to the plan it seeds (COM-03).',
    fields: {expires_at: 'number'},
    retention: ownerExpiry('expires_at', 'Valid 90 seconds; deleted by the next binding.'),
  },
  catalog_mapping_profile: {
    scope: 'tenant',
    owner: 'src/catalog-mapping.ts',
    version: 1,
    summary: 'A saved catalog column mapping and its version (COM-03).',
    fields: {},
    retention: workspace(),
  },
  client_brief: {
    scope: 'tenant',
    owner: 'src/recipe-context.ts',
    version: 1,
    summary: 'A client brief saved for guided campaign recipes.',
    fields: {},
    retention: workspace(),
  },
  client_profile: {
    scope: 'tenant',
    owner: 'src/client-scope.ts',
    version: 1,
    summary: 'A client of the workspace: its name, account bindings and approved report presentation (SEC-08).',
    fields: {},
    retention: workspace(),
  },
  conditional_program_observation: {
    scope: 'tenant',
    owner: 'src/conditional-programs.ts',
    version: 1,
    summary: 'A timestamped observation of a conditional provider program, never a grant (D20).',
    fields: {connection_id: 'string', expires_at: 'number'},
    retention: ownerExpiry('expires_at', 'Kept 30 days; deleted once expired when the next observation is saved.'),
    connection: {match: 'field', field: 'connection_id'},
  },
  connection_disconnection: {
    scope: 'tenant',
    owner: 'src/connection-disconnect.ts',
    version: 1,
    summary: 'The receipt of a local disconnect, kept so that a repeated disconnect replays it.',
    fields: {},
    retention: workspace(),
  },
  connection_health: {
    scope: 'tenant',
    owner: 'src/connection-health.ts',
    version: 1,
    summary: 'Credential health of one login (CON-02); the document id is the connection id.',
    fields: {},
    retention: workspace('Kept while the workspace and the login exist.'),
    connection: {match: 'id'},
  },
  creative_metadata: {
    scope: 'tenant',
    owner: 'src/creative-library.ts',
    version: 1,
    summary: 'The name and tags a person gave a creative library item.',
    fields: {},
    retention: workspace(),
  },
  criteo_report_run: {
    scope: 'tenant',
    owner: 'src/criteo-report-jobs.ts',
    version: 1,
    summary: 'A Criteo report job bound to its review.',
    fields: {retained_until: 'number'},
    retention: ownerExpiry('retained_until', 'Kept 7 days; deleted once expired when the next job is recorded.'),
  },
  decision_report: {
    scope: 'tenant',
    owner: 'src/decision-reporting.ts',
    version: 1,
    summary: 'A captured analysis report.',
    fields: {captured_at: 'number', 'connection_id?': 'string'},
    retention: {
      rule: 'report',
      from: ['$.captured_at'],
      order: 2,
      summary: 'Deleted once older than the report retention period, from its capture.',
    },
    connection: {match: 'field', field: 'connection_id'},
  },
  erasure_receipt: {
    scope: 'tenant',
    owner: 'src/account-erasure.ts',
    version: 1,
    summary:
      "An account erasure receipt in the deployment's workspace (SEC-07); random ids only, re-applied after a restore.",
    fields: {},
    retention: {
      rule: 'deployment',
      summary: 'Kept with the deployment, so that an erasure can be applied again to a restored copy.',
    },
  },
  ga4_test_property: {
    scope: 'tenant',
    owner: 'src/measurement-test-properties.ts',
    version: 1,
    summary: 'A GA4 property the owner marked for the test-identity mode (MSR-04).',
    fields: {},
    retention: workspace(),
  },
  gtm_consent_preview: {
    scope: 'tenant',
    owner: 'src/gtm-consent-plans.ts',
    version: 1,
    summary: 'A GTM consent plan preview before it becomes a plan.',
    fields: {expires_at: 'number'},
    retention: ownerExpiry('expires_at', 'Deleted once expired, when the next preview is saved.'),
  },
  linkedin_post: {
    scope: 'tenant',
    owner: 'src/linkedin-posts.ts',
    version: 1,
    summary: 'A LinkedIn post AMCP created, kept for its verification.',
    fields: {},
    retention: workspace(),
  },
  media_review: {
    scope: 'tenant',
    owner: 'src/media-upload.ts',
    version: 1,
    summary: "A media upload review: the frozen copy's plan and its transfer state.",
    fields: {expires_at: 'number'},
    retention: {
      rule: 'expires',
      field: 'expires_at',
      by: 'media_cleanup',
      summary: 'Deleted by the media cleanup once its staging expired.',
    },
    indexes: ['media_documents_by_kind'],
  },
  media_source: {
    scope: 'tenant',
    owner: 'src/media-sources.ts',
    version: 1,
    summary: 'An original file a person uploaded or imported, waiting to be pushed.',
    fields: {expires_at: 'number', 'created_at?': 'number', 'origin?': 'string', 'state?': 'string'},
    retention: {
      rule: 'expires',
      field: 'expires_at',
      by: 'media_cleanup',
      summary: 'Deleted by the media cleanup once expired; a website upload at most 30 minutes after it was made.',
    },
    backup: 'excluded',
    indexes: ['media_documents_by_kind'],
  },
  media_variant: {
    scope: 'tenant',
    owner: 'src/media-upload.ts',
    version: 1,
    summary: 'A derived media variant and its transfer state.',
    fields: {expires_at: 'number', 'upload_expires_at?': 'number'},
    retention: {
      rule: 'expires',
      field: 'expires_at',
      by: 'media_cleanup',
      summary: 'Deleted by the media cleanup once it or its original upload expired.',
    },
    backup: 'excluded',
    indexes: ['media_documents_by_kind'],
  },
  member_access_set: {
    scope: 'tenant',
    owner: 'src/access-sets.ts',
    version: 1,
    summary: "The client access set a member is limited to; the document id is the member's user id.",
    fields: {access_set_id: 'string'},
    retention: workspace('Kept while the membership exists.'),
    person: {match: 'id'},
  },
  meta_report_run: {
    scope: 'tenant',
    owner: 'src/meta-insights-jobs.ts',
    version: 1,
    summary: 'A Meta asynchronous insights job bound to its review.',
    fields: {expires_at: 'number'},
    retention: {
      rule: 'expires',
      field: 'expires_at',
      by: 'read',
      summary: 'Valid 7 days; ignored once expired and kept while the workspace exists.',
    },
  },
  microsoft_report: {
    scope: 'tenant',
    // ScopeGuard's observation of a report submission writes it, through Microsoft's scope hooks (ARC-01 phase B).
    owner: 'src/microsoft-adapter.ts',
    version: 1,
    summary: 'A parsed Microsoft report download.',
    fields: {expires_at: 'number', 'connection_id?': 'string'},
    retention: ownerExpiry('expires_at', 'Deleted once expired, when the next report is submitted.'),
    connection: {match: 'field', field: 'connection_id'},
  },
  monitor_notice: {
    scope: 'tenant',
    owner: 'src/monitor-delivery.ts',
    version: 1,
    summary: 'A report monitor notice for one subscriber.',
    fields: {user_id: 'string', created_at: 'number', 'expires_at?': 'number', 'state?': 'string'},
    retention: {
      rule: 'period',
      days: 30,
      from: '$.created_at',
      by: 'owner_module',
      summary: 'Deleted 30 days after it was created, by the monitor delivery pass.',
    },
    person: {match: 'user_id', field: '$.user_id'},
  },
  monitor_subscription: {
    scope: 'tenant',
    owner: 'src/monitor-delivery.ts',
    version: 1,
    summary: "A person's subscription to a report monitor.",
    fields: {user_id: 'string'},
    retention: workspace('Kept while the workspace exists and the person keeps it.'),
    person: {match: 'user_id', field: '$.user_id'},
  },
  oauth_progress: {
    scope: 'tenant',
    owner: 'server/platform-oauth.ts',
    version: 1,
    summary: 'The progress of one provider authorization attempt.',
    fields: {'connectionId?': 'string'},
    retention: workspace('Kept while the workspace exists; deleted with the login it connected.'),
    connection: {match: 'field', field: 'connectionId'},
  },
  operation_journal: {
    scope: 'tenant',
    owner: 'src/store.ts',
    version: 1,
    summary: 'The phase journal of one reviewed write, keyed by its idempotency key.',
    fields: {},
    retention: workspace('Kept with the workspace’s write claims, for reconciliation.'),
  },
  overview_checkpoint: {
    scope: 'tenant',
    owner: 'src/report-checkpoints.ts',
    version: 1,
    summary: 'A resumable collection checkpoint of an Overview snapshot; its id starts with the snapshot id.',
    fields: {report_id: 'string'},
    retention: {
      rule: 'with_parent',
      parent: 'overview_report',
      link: 'id',
      by: 'schema_trigger',
      summary: 'Deleted with its snapshot (trigger overview_report_parts_cleanup).',
    },
    indexes: ['overview_report_parts_cleanup'],
  },
  overview_export: {
    scope: 'tenant',
    owner: 'src/reporting-overview.ts',
    version: 1,
    summary: 'An export of an Overview snapshot to Google Sheets or report files.',
    fields: {report_id: 'string', 'state?': 'string'},
    retention: workspace(
      'Kept while the workspace exists; deleted with its snapshot when a person deletes the snapshot.',
    ),
  },
  overview_report: {
    scope: 'tenant',
    owner: 'src/reporting-overview.ts',
    version: 1,
    summary: 'An Overview report snapshot: its configuration, rows and delivery state.',
    fields: {created_at: 'number', state: 'string'},
    retention: {
      rule: 'report',
      from: ['$.created_at'],
      order: 3,
      summary:
        'Deleted once finished and older than the report retention period, from its creation, unless a job still runs for it or a Google Sheets delivery of it is unconfirmed.',
    },
    connection: {match: 'sources'},
    indexes: ['overview_report_parts_cleanup'],
  },
  overview_report_budget: {
    scope: 'tenant',
    owner: 'src/report-checkpoints.ts',
    version: 1,
    summary: 'The split collection budget of an Overview snapshot; the document id is the snapshot id.',
    fields: {report_id: 'string'},
    retention: {
      rule: 'with_parent',
      parent: 'overview_report',
      link: 'id',
      by: 'schema_trigger',
      summary: 'Deleted with its snapshot (trigger overview_report_parts_cleanup).',
    },
    indexes: ['overview_report_parts_cleanup'],
  },
  overview_schedule: {
    scope: 'tenant',
    owner: 'src/report-library.ts',
    version: 1,
    summary: 'A saved Overview report schedule.',
    fields: {'is_active?': 'boolean', 'next_run_at?': 'number'},
    retention: workspace(),
    indexes: ['overview_schedule_due', 'overview_schedule_due_global'],
  },
  overview_schedule_deleted: {
    scope: 'tenant',
    owner: 'src/report-library.ts',
    version: 1,
    summary: 'A marker of a deleted Overview schedule, so that a repeated workbook migration does not recreate it.',
    fields: {deleted_at: 'number'},
    retention: workspace(),
  },
  overview_template: {
    scope: 'tenant',
    owner: 'src/report-library.ts',
    version: 1,
    summary: 'A saved Overview report template.',
    fields: {},
    retention: workspace(),
  },
  overview_view: {
    scope: 'tenant',
    owner: 'src/report-library.ts',
    version: 1,
    summary: 'A saved Overview report view.',
    fields: {},
    retention: workspace(),
  },
  personal_data_account: {
    scope: 'tenant',
    owner: 'src/personal-data-access.ts',
    version: 1,
    summary: "The owner's personal-data switch for one ad account.",
    fields: {},
    retention: workspace(),
  },
  plan_policy: {
    scope: 'tenant',
    owner: 'src/campaign-inventory.ts',
    version: 1,
    summary: "The workspace's campaign plan policy (CMP-05).",
    fields: {},
    retention: workspace(),
  },
  preview_receipt: {
    scope: 'tenant',
    owner: 'src/store.ts',
    version: 1,
    summary: 'The encrypted native preview of a reviewed write, recoverable for 24 hours.',
    fields: {secret: 'string', expires_at: 'number'},
    retention: {
      rule: 'expires',
      field: 'expires_at',
      by: 'media_cleanup',
      summary: 'Deleted by the media cleanup 24 hours after it was saved.',
    },
    indexes: ['media_documents_by_kind'],
  },
  provider_job: {
    scope: 'tenant',
    owner: 'src/provider-jobs.ts',
    version: 1,
    summary: 'The receipt of a provider report or export job (RPT-06).',
    fields: {state: 'string', created_at: 'number', 'retain_until?': 'number'},
    retention: {
      rule: 'period',
      days: 90,
      from: '$.retain_until',
      by: 'report_cleanup',
      summary:
        'Kept 90 days: a settled receipt from when it settled, a submitting or uncertain one from when it was created.',
    },
  },
  provider_metrics: {
    scope: 'tenant',
    owner: 'src/store.ts',
    version: 1,
    summary: 'Request counters of a workspace per provider gateway; the document id is the gateway.',
    fields: {'at?': 'number'},
    retention: {rule: 'replaced', summary: 'One document per gateway, rewritten in place.'},
  },
  provider_validation: {
    scope: 'tenant',
    owner: 'src/provider-validation.ts',
    version: 1,
    summary: 'The receipt of a provider validate-only call, keyed by its request hash.',
    fields: {},
    retention: workspace(),
  },
  readiness: {
    scope: 'tenant',
    owner: 'src/workspace.ts',
    version: 1,
    summary: "Readiness evidence of one of a login's accounts.",
    fields: {connection_id: 'string'},
    retention: workspace('Kept while the workspace and the login exist.'),
    connection: {match: 'field', field: 'connection_id'},
  },
  recipe_eligibility: {
    scope: 'tenant',
    owner: 'src/recipe-eligibility.ts',
    version: 1,
    summary: "A cached guided-recipe eligibility check of one person's selection.",
    fields: {expires_at: 'number', user_id: 'string', 'saved_at?': 'number'},
    retention: ownerExpiry(
      'expires_at',
      'Deleted once expired when the next check is saved; each person keeps at most the newest 20.',
      {missing: 'expired'},
    ),
  },
  reddit_post_resolution: {
    scope: 'tenant',
    owner: 'src/reddit-post-creation.ts',
    version: 1,
    summary: 'How a Reddit post created for a review resolved; the document id is the review id.',
    fields: {},
    retention: workspace(),
  },
  report_file: {
    scope: 'tenant',
    owner: 'src/report-file-delivery.ts',
    version: 1,
    summary: 'A generated report file (CSV, PDF or XLSX) of a snapshot, encrypted.',
    fields: {report_id: 'string', 'storage_bytes?': 'number'},
    retention: {
      rule: 'with_parent',
      parent: 'overview_report',
      link: '$.report_id',
      by: 'report_cleanup',
      order: 6,
      summary: 'Deleted with its snapshot: when the snapshot is deleted, or by the report cleanup once it is gone.',
    },
  },
  report_file_destination: {
    scope: 'tenant',
    owner: 'src/report-file-delivery.ts',
    version: 1,
    summary: 'A saved report-file destination: its formats and presentation.',
    fields: {},
    retention: workspace(),
  },
  report_incident: {
    scope: 'tenant',
    owner: 'src/report-monitors.ts',
    version: 1,
    summary: 'A monitoring incident a report monitor raised.',
    fields: {
      'state?': 'string',
      'updated_at?': 'number',
      'superseded_by_version?': 'integer',
      'connection_id?': 'string',
    },
    retention: {
      rule: 'report',
      from: ['$.updated_at'],
      order: 1,
      summary:
        'Deleted once resolved or superseded and not updated for the report retention period; open and acknowledged incidents are kept.',
    },
    connection: {match: 'field', field: 'connection_id'},
  },
  report_job_grant: {
    scope: 'tenant',
    owner: 'src/provider-jobs.ts',
    version: 1,
    summary: "The accounts of a login whose report jobs the owner allowed (RPT-06); the document id is the login's id.",
    fields: {},
    retention: workspace(),
  },
  report_monitor: {
    scope: 'tenant',
    owner: 'src/report-monitors.ts',
    version: 1,
    summary: 'A report monitor rule.',
    fields: {},
    retention: workspace(),
  },
  report_presentation: {
    scope: 'tenant',
    owner: 'src/report-packs.ts',
    version: 1,
    summary: "The presentation of an Overview snapshot; the document id is the snapshot's.",
    fields: {},
    retention: {
      rule: 'with_parent',
      parent: 'overview_report',
      link: 'id',
      by: 'report_cleanup',
      order: 5,
      summary: 'Deleted with its snapshot: when the snapshot is deleted, or by the report cleanup once it is gone.',
    },
  },
  report_reconciliation: {
    scope: 'tenant',
    owner: 'src/decision-reporting.ts',
    version: 1,
    summary: 'A reconciliation of an analysis against its source report.',
    fields: {},
    retention: workspace(),
  },
  reporting_query: {
    scope: 'tenant',
    owner: 'src/reporting.ts',
    version: 1,
    summary: 'A saved workbook reporting query.',
    fields: {'workbook_binding_id?': 'string'},
    retention: workspace(),
    indexes: ['reporting_query_workbook'],
  },
  reporting_schedule: {
    scope: 'tenant',
    owner: 'src/workbook-schedules.ts',
    version: 1,
    summary: 'A workbook reporting schedule.',
    fields: {'is_active?': 'boolean', 'next_run_at?': 'number'},
    retention: workspace(),
    indexes: ['reporting_schedule_due', 'reporting_schedule_due_global'],
  },
  retained_media_source: {
    scope: 'tenant',
    owner: 'src/media-sources.ts',
    version: 1,
    summary: 'A retained original file: provider media, or a website upload kept up to its 30-minute deadline.',
    fields: {'origin?': 'string', 'created_at?': 'number'},
    retention: {
      rule: 'expires',
      field: 'created_at',
      by: 'media_cleanup',
      summary:
        'A website upload is deleted by the media cleanup 30 minutes after it was made; other retained files are kept while the workspace exists.',
    },
    backup: 'excluded_upload_origin',
    indexes: ['media_documents_by_kind'],
  },
  retention_policy: {
    scope: 'tenant',
    owner: 'src/owner-operations.ts',
    version: 1,
    summary: "The owner's retention periods: report days and archived campaign plan days.",
    fields: {'days?': 'integer', 'archived_campaign_plans_days?': 'integer'},
    retention: workspace(),
  },
  sandbox_run: {
    scope: 'tenant',
    owner: 'tools/live-sandbox.ts',
    version: 1,
    summary: "A live sandbox run of the operator's sandbox tool.",
    fields: {},
    retention: workspace(),
  },
  search_exclusion_preview: {
    scope: 'tenant',
    owner: 'src/search-exclusion-plan.ts',
    version: 1,
    summary: 'A search exclusion plan preview before it becomes a plan.',
    fields: {expires_at: 'number'},
    retention: ownerExpiry('expires_at', 'Deleted once expired, when the next preview is saved.', {strict: true}),
  },
  service_timings: {
    scope: 'tenant',
    owner: 'src/service-timings.ts',
    version: 1,
    summary: "Rolling timings of a workspace's tool calls, per category.",
    fields: {},
    retention: {rule: 'replaced', summary: 'One document per category, rewritten in place.'},
  },
  sheets_creation: {
    scope: 'tenant',
    owner: 'src/google-sheets.ts',
    version: 1,
    summary: 'A Google spreadsheet creation request and its outcome.',
    fields: {},
    retention: workspace(),
  },
  sheets_delivery: {
    scope: 'tenant',
    owner: 'src/google-sheets.ts',
    version: 1,
    summary: 'The receipt of one Google Sheets delivery of a snapshot.',
    fields: {
      report_id: 'string',
      state: 'string',
      'abandoned_at?': 'number',
      'completed_at?': 'number',
      'sent_at?': 'number',
    },
    retention: {
      rule: 'report',
      from: ['$.abandoned_at', '$.completed_at', '$.sent_at'],
      order: 4,
      summary:
        'Deleted once complete, rejected or abandoned, older than the report retention period and its snapshot is gone; an unconfirmed delivery keeps its snapshot.',
    },
  },
  sheets_destination: {
    scope: 'tenant',
    owner: 'src/google-sheets.ts',
    version: 1,
    summary: 'A saved Google Sheets destination.',
    fields: {},
    retention: workspace(),
  },
  spend_policy: {
    scope: 'tenant',
    owner: 'src/spend-policy.ts',
    version: 1,
    summary: "An owner spending policy of an account; the document id is the account's policy key.",
    fields: {},
    retention: workspace(),
  },
  spend_reservation: {
    scope: 'tenant',
    owner: 'src/spend-policy.ts',
    version: 1,
    summary: "A reviewed write's reservation against a daily spending limit.",
    fields: {day: 'string', 'policy_id?': 'string'},
    retention: {
      rule: 'period',
      days: 2,
      from: '$.day',
      by: 'report_cleanup',
      summary:
        'Readable only on its own UTC day; deleted by the hourly cleanup once older than two days, or when its write is released.',
    },
  },
  storage_volume: {
    scope: 'service',
    partition: 'system',
    owner: 'server/volume.ts',
    version: 1,
    summary: 'The persistent-volume marker the start-up check compares with the data directory (OPS-03).',
    fields: {volume_id: 'string'},
    retention: {rule: 'deployment', summary: 'Kept with the deployment; an operator re-stamps it after a restore.'},
  },
  provider_budget: {
    scope: 'service',
    partition: 'limits',
    owner: 'src/store.ts',
    version: 1,
    summary: 'A provider request budget (token bucket); the document id is the hashed provider key.',
    fields: {at: 'number'},
    retention: {
      rule: 'period',
      days: 1,
      from: '$.at',
      by: 'maintenance',
      summary: 'Deleted by the maintenance timer a day after its last use.',
    },
  },
  provider_job_quota: {
    scope: 'service',
    partition: 'limits',
    owner: 'src/provider-jobs.ts',
    version: 1,
    summary: 'The rolling window of provider job submissions per provider key.',
    fields: {times: 'array'},
    retention: {rule: 'replaced', summary: 'One document per key, rewritten in place with a bounded window.'},
  },
  queue_cursor: {
    scope: 'service',
    partition: 'limits',
    owner: 'src/store.ts',
    version: 1,
    summary: "The job dispatch cursor that orders the workspaces' jobs fairly.",
    fields: {ordinal: 'integer'},
    retention: {rule: 'replaced', summary: 'One document, rewritten in place.'},
  },
  tenant_dispatch: {
    scope: 'service',
    partition: 'limits',
    owner: 'src/store.ts',
    version: 1,
    summary: "A workspace's place in the fair job dispatch order; the document id is the workspace id.",
    fields: {ordinal: 'integer', at: 'number'},
    retention: {rule: 'replaced', summary: 'One document per workspace, rewritten in place.'},
  },
  tiktok_report_quota: {
    scope: 'service',
    partition: 'limits',
    owner: 'src/tiktok-report-jobs.ts',
    version: 1,
    summary: 'TikTok report task counters per advertiser and per minute.',
    fields: {at: 'number'},
    retention: {
      rule: 'period',
      days: 1,
      from: '$.at',
      by: 'maintenance',
      summary: 'Deleted by the maintenance timer a day after its last use.',
    },
  },
  tiktok_report_run: {
    scope: 'tenant',
    owner: 'src/tiktok-report-jobs.ts',
    version: 1,
    summary: 'A TikTok report task bound to its review.',
    fields: {expires_at: 'number'},
    retention: {
      rule: 'expires',
      field: 'expires_at',
      by: 'maintenance',
      summary: 'Deleted by the maintenance timer once expired.',
    },
  },
  upload_session: {
    scope: 'tenant',
    owner: 'src/store.ts',
    version: 1,
    summary: 'An encrypted chunked-upload session.',
    fields: {secret: 'string', expires_at: 'number'},
    retention: {
      rule: 'expires',
      field: 'expires_at',
      by: 'media_cleanup',
      summary: 'Deleted by the media cleanup once expired.',
    },
    backup: 'excluded',
    indexes: ['media_documents_by_kind'],
  },
  website_assets: {
    scope: 'tenant',
    owner: 'server/website-connections.ts',
    version: 1,
    summary: 'The assets a login can select, as its last discovery listed them; the document id is the connection id.',
    fields: {},
    retention: workspace('Kept while the workspace and the login exist.'),
    connection: {match: 'id'},
  },
  website_connection: {
    scope: 'tenant',
    owner: 'server/website-connections.ts',
    version: 1,
    summary: 'The website side of a login: its selection and settings; the document id is the connection id.',
    fields: {'createdAt?': 'number'},
    retention: workspace('Kept while the workspace and the login exist.'),
    connection: {match: 'id'},
  },
  website_mcp_token: {
    scope: 'tenant',
    owner: 'server/access-routes.ts',
    version: 1,
    summary: "A connector token's record: its name, role, hash, creator and revocation.",
    fields: {hash: 'string'},
    retention: workspace(),
  },
  workbook: {
    scope: 'tenant',
    owner: 'src/workbook-bindings.ts',
    version: 1,
    summary: 'A workbook bound to a Google spreadsheet.',
    fields: {'spreadsheet_id?': 'string'},
    retention: workspace(),
  },
  worker_heartbeat: {
    scope: 'service',
    partition: 'limits',
    owner: 'src/worker.ts',
    version: 1,
    summary: 'A worker process heartbeat; the document id is the worker id.',
    fields: {at: 'number', 'boot?': 'string', 'state?': 'string'},
    retention: {
      rule: 'period',
      days: 1,
      from: '$.at',
      by: 'maintenance',
      summary: 'Deleted by the maintenance timer a day after its last beat.',
    },
  },
  workspace_asset: {
    scope: 'tenant',
    owner: 'src/media-upload.ts',
    version: 1,
    summary: 'A media asset saved to the workspace library; the document id is its review id.',
    fields: {},
    retention: workspace(),
  },
  workspace_invite: {
    scope: 'tenant',
    owner: 'server/account-security.ts',
    version: 1,
    summary: "An invitation to the workspace, naming the invited person's hashed e-mail address.",
    fields: {emailHash: 'string'},
    retention: workspace(),
    person: {match: 'email_hash', field: '$.emailHash'},
  },
  write_approval: {
    scope: 'tenant',
    owner: 'src/write-approval.ts',
    version: 1,
    summary: 'An approval of a reviewed write (WRT-09); the document id is the review id.',
    fields: {},
    retention: workspace(),
  },
  write_pause: {
    scope: 'tenant',
    owner: 'src/owner-operations.ts',
    version: 1,
    summary: "The owner's pause of the workspace's reviewed writes.",
    fields: {},
    retention: workspace('Kept until an owner resumes writes.'),
  },
  write_reconciliation: {
    scope: 'tenant',
    owner: 'src/write-reconciliation.ts',
    version: 1,
    summary: 'The reconciliation of an uncertain reviewed write.',
    fields: {},
    retention: workspace(),
  },
  write_review: {
    scope: 'tenant',
    owner: 'src/write-review.ts',
    version: 1,
    summary: 'A reviewed write: the prepared plan, its consent and its outcome.',
    fields: {},
    retention: workspace('Kept while the workspace exists, as the record of the change.'),
  },
  write_review_group: {
    scope: 'tenant',
    owner: 'src/write-groups.ts',
    version: 1,
    summary: 'A group of reviewed writes executed together.',
    fields: {},
    retention: workspace(),
  },
  write_verification: {
    scope: 'tenant',
    owner: 'src/write-verification.ts',
    version: 1,
    summary: 'The read-back verification of a reviewed write.',
    fields: {},
    retention: workspace(),
  },
  x_catalog_removal_preview: {
    scope: 'tenant',
    owner: 'src/x-catalog-removal.ts',
    version: 1,
    summary: 'An X catalog removal preview before it becomes a plan.',
    fields: {expires_at: 'number', 'plan_id?': 'string'},
    retention: ownerExpiry(
      'expires_at',
      'Deleted once expired and not bound to a plan, when the next preview is saved.',
      {unless: 'plan_id'},
    ),
  },
  x_report_quota: {
    scope: 'service',
    partition: 'limits',
    owner: 'src/x-report-jobs.ts',
    version: 1,
    summary: 'The active X report job slots of a provider key.',
    fields: {active: 'array'},
    retention: {
      rule: 'replaced',
      summary: 'One document per key, rewritten in place and deleted when no slot is used.',
    },
  },
  x_report_result: {
    scope: 'tenant',
    owner: 'src/store.ts',
    version: 1,
    summary: 'An encrypted X report result.',
    fields: {secret: 'string', expires_at: 'number'},
    retention: {
      rule: 'expires',
      field: 'expires_at',
      by: 'maintenance',
      summary: 'Deleted by the maintenance timer once expired.',
    },
  },
  x_report_run: {
    scope: 'tenant',
    owner: 'src/x-report-jobs.ts',
    version: 1,
    summary: 'An X asynchronous report job bound to its review.',
    fields: {expires_at: 'number'},
    retention: {
      rule: 'expires',
      field: 'expires_at',
      by: 'maintenance',
      summary: 'Deleted by the maintenance timer once expired.',
    },
  },
} as const satisfies Record<string, DocumentKindSpec>;

export type DocumentKindName = keyof typeof documentKindSpecs;
type Specs = typeof documentKindSpecs;
/** Kinds stored per workspace. */
export type TenantDocumentKind = {
  [K in DocumentKindName]: Specs[K]['scope'] extends 'tenant' ? K : never;
}[DocumentKindName];
/** Kinds stored for the service. */
export type ServiceDocumentKind = {
  [K in DocumentKindName]: Specs[K]['scope'] extends 'service' ? K : never;
}[DocumentKindName];
export interface DocumentKind extends DocumentKindSpec {
  name: DocumentKindName;
}

const specs: Readonly<Record<string, DocumentKindSpec>> = documentKindSpecs;
export const documentKindNames = Object.keys(documentKindSpecs).sort() as readonly DocumentKindName[];
export function isDocumentKind(name: unknown): name is DocumentKindName {
  return typeof name === 'string' && Object.hasOwn(specs, name);
}
/** The declaration of a kind. An undeclared kind is a programming error: declare it in this module first. */
export function documentKind(name: string): DocumentKind {
  if (!isDocumentKind(name))
    throw new Error('Undeclared document kind ' + JSON.stringify(name) + ' (src/document-kinds.ts).');
  return {name, ...specs[name]!};
}
export function documentKinds(): DocumentKind[] {
  return documentKindNames.map(name => documentKind(name));
}
/** The reserved workspace id that stores a service kind's documents. */
export function servicePartitionOf(name: string): string {
  const kind = documentKind(name);
  if (kind.scope !== 'service' || !kind.partition)
    throw new Error('Document kind ' + name + ' belongs to a workspace, not to the service.');
  return servicePartitions[kind.partition];
}
const reserved = new Set<string>(Object.values(servicePartitions));
/** Whether an id is a service partition (never a workspace). */
export const isServicePartition = (id: string) => reserved.has(id);

/** SQL string literal of a known kind name or field path (validated, so it never carries a quote). */
const literal = (value: string) => {
  if (!/^[$a-zA-Z0-9_.]+$/.test(value)) throw new Error('Invalid registry identifier ' + JSON.stringify(value));
  return "'" + value + "'";
};
const list = (names: readonly string[]) => names.map(literal).join(',');
/**
 * Account erasure (SEC-07): the documents of other workspaces that belong to the erased person, as one SQL condition
 * over `documents` with its parameters (the person's user id and e-mail hash), from the kinds' `person` declarations.
 * An empty user id or e-mail hash matches nothing (it would match every document whose field is empty, in every
 * workspace); `where` is empty when neither is known.
 */
export function personDocumentsCondition(userId: string, emailHash: string): {where: string; params: string[]} {
  const groups = new Map<string, {test: string; value: string; kinds: string[]}>();
  for (const kind of documentKinds()) {
    if (!kind.person) continue;
    const test = kind.person.match === 'id' ? 'id=?' : 'json_extract(data,' + literal(kind.person.field!) + ')=?',
      value = kind.person.match === 'email_hash' ? emailHash : userId,
      key = test + '|' + kind.person.match;
    if (!value) continue;
    const group = groups.get(key) ?? {test, value, kinds: []};
    group.kinds.push(kind.name);
    groups.set(key, group);
  }
  const parts = [...groups.values()];
  return {
    where: parts.map(g => '(kind IN (' + list(g.kinds) + ') AND ' + g.test + ')').join(' OR '),
    params: parts.map(g => g.value),
  };
}
/** The kinds a backup leaves out, as one SQL condition over `documents` (OPS-04, from the kinds' `backup`). */
export function backupExcludedCondition(): string {
  const always = documentKinds().filter(k => k.backup === 'excluded'),
    uploads = documentKinds().filter(k => k.backup === 'excluded_upload_origin');
  return [
    ...(always.length ? ['kind IN (' + list(always.map(k => k.name)) + ')'] : []),
    ...uploads.map(k => '(kind=' + literal(k.name) + " AND json_extract(data,'$.origin')='upload')"),
  ].join(' OR ');
}
/** The SQL `kind IN (...)` list of the named kinds, for store-layer statements. */
export const kindList = (names: readonly DocumentKindName[]) => 'kind IN (' + list(names) + ')';
const day = 86400000;
/** The JSON path literal of a payload field (a top-level name, or dotted names for a nested one). */
export function fieldPath(field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field))
    throw new Error('Invalid document field ' + JSON.stringify(field) + '.');
  return literal('$.' + field);
}
type Expiry = Extract<Retention, {rule: 'expires'}>;
/**
 * The SQL condition (one value: the clock) that selects the documents an `expires` declaration deletes: the deadline
 * reached (`<=`) or, with `strict`, passed (`<`); a document without it counts as expired with `missing`; one whose
 * `unless` field is set is kept.
 */
export function expiredCondition(r: Expiry): string {
  const deadline =
    r.missing === 'expired'
      ? 'coalesce(json_extract(data,' + fieldPath(r.field) + '),0)'
      : 'json_extract(data,' + fieldPath(r.field) + ')';
  return (
    deadline +
    (r.strict ? '<?' : '<=?') +
    (r.unless ? ' AND json_extract(data,' + fieldPath(r.unless) + ') IS NULL' : '')
  );
}
/** The SQL condition (one value: the clock) of the documents whose deadline is still ahead (not expired by it). */
export function unexpiredCondition(r: Expiry): string {
  const deadline =
    r.missing === 'expired'
      ? 'coalesce(json_extract(data,' + fieldPath(r.field) + '),0)'
      : 'json_extract(data,' + fieldPath(r.field) + ')';
  return deadline + (r.strict ? '>=?' : '>?');
}
/**
 * What the store's maintenance timer deletes (once a minute), from the kinds whose retention it applies (`by:
 * 'maintenance'`): an `expires` kind once the deadline in its field has passed (a document without one is kept), and a
 * `period` kind `days` after its clock field (a document without one counts as that old). A service kind is bound to
 * its partition; a workspace kind is swept in every workspace. Each statement takes one value, `cutoff(now)`.
 */
export function maintenanceSweeps(): {kinds: DocumentKindName[]; sql: string; cutoff: (now: number) => number}[] {
  const groups = new Map<
    string,
    {kinds: DocumentKindName[]; scope: string; clause: string; cutoff: (now: number) => number}
  >();
  for (const kind of documentKinds()) {
    const r = kind.retention,
      scope = kind.scope === 'service' ? 'tenant_id=' + literal(servicePartitions[kind.partition!]) + ' AND ' : '';
    const sweep =
      r.rule === 'expires' && r.by === 'maintenance'
        ? {key: 'expires|' + expiredCondition(r), clause: expiredCondition(r), cutoff: (now: number) => now}
        : r.rule === 'period' && r.by === 'maintenance'
          ? {
              key: 'period|' + r.from + '|' + r.days,
              clause: 'coalesce(json_extract(data,' + literal(r.from) + '),0)<?',
              cutoff: (now: number) => now - r.days * day,
            }
          : undefined;
    if (!sweep) continue;
    const key = scope + sweep.key,
      group = groups.get(key) ?? {kinds: [], scope, clause: sweep.clause, cutoff: sweep.cutoff};
    group.kinds.push(kind.name);
    groups.set(key, group);
  }
  return [...groups.values()].map(g => ({
    kinds: g.kinds,
    sql: 'DELETE FROM documents WHERE ' + g.scope + kindList(g.kinds) + ' AND ' + g.clause,
    cutoff: g.cutoff,
  }));
}
/**
 * The document kinds the hourly report cleanup deletes (SEC-07, owner decisions P3 and P11), in its order: those with
 * the `report` rule, then those that go with their snapshot (`with_parent` by the report cleanup).
 */
export function reportRetentionDocumentKinds(): DocumentKindName[] {
  return documentKinds()
    .flatMap(kind =>
      kind.retention.rule === 'report' ||
      (kind.retention.rule === 'with_parent' && kind.retention.by === 'report_cleanup')
        ? [{name: kind.name, order: kind.retention.order ?? Number.MAX_SAFE_INTEGER}]
        : [],
    )
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map(kind => kind.name);
}
/** Job kinds the report cleanup deletes once finished and older than the period: they are not documents. */
export const reportRetentionJobKinds = ['report_overview', 'sheets_export', 'report_file_export', 'report'] as const;

const typeOf = (value: unknown): FieldType | 'null' | undefined =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value === 'number'
        ? Number.isSafeInteger(value)
          ? 'integer'
          : 'number'
        : typeof value === 'string' || typeof value === 'boolean' || typeof value === 'object'
          ? (typeof value as FieldType)
          : undefined;
/**
 * The ways a payload breaks its kind's store contract: a missing required field, or a declared field of another JSON
 * type (an integer is also a number). Empty when it keeps it.
 */
export function documentProblems(name: string, data: unknown): string[] {
  const kind = documentKind(name);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [name + ' documents are JSON objects.'];
  const problems: string[] = [];
  for (const [declared, type] of Object.entries(kind.fields)) {
    const optional = declared.endsWith('?'),
      field = optional ? declared.slice(0, -1) : declared,
      value = (data as JsonObject)[field];
    if (value === undefined) {
      if (!optional) problems.push(name + '.' + field + ' is required.');
      continue;
    }
    const actual = typeOf(value);
    if (actual !== type && !(type === 'number' && actual === 'integer'))
      problems.push(name + '.' + field + ' must be ' + type + ', not ' + actual + '.');
  }
  return problems;
}
