import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {MirrorError} from './errors.js';
import {bad, fingerprint, optional, validate, writer} from './workspace-core.js';
import {sha256} from './security.js';
import {presentationStyle} from './report-packs.js';
import {assertReportExportable} from './report-table.js';
import {providerById} from './provider-adapters.js';
import {activeReportJobCount} from './job-repository.js';

type Format = 'pdf' | 'xlsx';
export const fileDeliveryLimits = {output_bytes: 20 * 1024 * 1024, tenant_storage_bytes: 256 * 1024 * 1024};
export const fileMime = (format: Format) =>
  format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const sourceHash = (report: JsonObject) =>
  fingerprint({
    config: report.config,
    rows: report.rows,
    summary: report.summary,
    sources: report.sources,
    state: report.state,
    completed_at: report.completed_at,
  });

/** File destinations contain only local formats/branding. They never grant provider or filesystem access. */
export function reportDestination(store: Store, actor: Actor, id: unknown): JsonObject {
  store.assertActorActive(actor);
  if (typeof id !== 'string' || !id || id.length > 160)
    bad('Choose a saved reporting destination.', 'INVALID_DESTINATION');
  if (id.startsWith('files-')) return store.document(actor.tenantId, 'report_file_destination', id);
  const d = store.document(actor.tenantId, 'sheets_destination', id);
  // A Sheets destination's connection belongs to the Google Sheets provider (its gateway from the adapter registry).
  store.resolveConnection(actor, providerById('sheets')!.gateway, d.spreadsheet_id, d.connection_id);
  return {...d, kind: 'google_sheets'};
}

export class ReportFileDelivery {
  render = async (tenant: string, report: JsonObject, format: Format, presentation: JsonObject): Promise<Buffer> =>
    (await import('./report-artifacts.js')).reportArtifact(tenant, report, format, presentation);
  constructor(
    readonly store: Store,
    readonly access: (actor: Actor, config: JsonObject) => void,
    readonly current: (tenant: string, id: string) => JsonObject,
    // Called in the transaction that records the export as delivered, with the snapshot it delivered.
    readonly delivered: (tenant: string, report: JsonObject) => void = () => {},
  ) {}

  bind(actor: Actor, input: JsonObject) {
    writer(this.store, actor);
    if (input.confirmed !== true) bad('Confirm saving this local file destination.', 'CONFIRMATION_REQUIRED');
    const v = input.file_destination;
    validate(v, ['name', 'formats', 'presentation'], 8192, 'file destination');
    if (
      typeof v.name !== 'string' ||
      !v.name.trim() ||
      v.name.trim().length > 100 ||
      /[\u0000-\u001f\u007f]/.test(v.name) ||
      !Array.isArray(v.formats) ||
      v.formats.length < 1 ||
      v.formats.length > 2 ||
      new Set(v.formats).size !== v.formats.length ||
      v.formats.some((f: unknown) => f !== 'pdf' && f !== 'xlsx')
    )
      bad('Name the local destination and explicitly choose PDF, XLSX, or both.', 'INVALID_DESTINATION');
    if (typeof input.idempotency_key !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(input.idempotency_key))
      bad('Use a stable file destination creation key.', 'INVALID_DESTINATION');
    const value = {
      kind: 'report_files',
      name: v.name.trim(),
      formats: [...v.formats].sort(),
      presentation: presentationStyle(v.presentation),
    };
    const id = 'files-' + sha256(input.idempotency_key),
      hash = fingerprint(value);
    return this.store.transaction(() => {
      const old = optional(this.store, actor.tenantId, 'report_file_destination', id);
      if (old) {
        if (old.request_fingerprint !== hash)
          bad('This key belongs to different file destination settings.', 'IDEMPOTENCY_CONFLICT');
        return old;
      }
      if (this.store.repo('report_file_destination', actor.tenantId).count() >= 100)
        bad('Use at most 100 file destinations in this workspace.', 'DESTINATION_LIMIT');
      this.store.putDocument(actor.tenantId, 'report_file_destination', id, {
        ...value,
        request_fingerprint: hash,
        created_at: Date.now(),
      });
      this.store.appendAudit(actor.tenantId, 'report-files/' + id, {
        event: 'report_file_destination_created',
        actor: actor.userId,
        formats: value.formats,
      });
      return this.store.document(actor.tenantId, 'report_file_destination', id);
    });
  }

  queue(actor: Actor, report: JsonObject, destinationId: string) {
    this.access(actor, report.config);
    assertReportExportable(report);
    if (report.state === 'partial' && report.config.partial_delivery === 'complete_only')
      bad(
        'This destination waits for a complete snapshot; the retained partial evidence is unchanged.',
        'PARTIAL_DELIVERY_BLOCKED',
      );
    const destination = reportDestination(this.store, actor, destinationId);
    if (destination.kind !== 'report_files') bad('Choose a local PDF/XLSX destination.', 'INVALID_DESTINATION');
    const hash = sourceHash(report),
      id = sha256('report-files:' + report.id + ':' + destination.id + ':' + hash);
    return this.store.transaction(() => {
      const prior = optional(this.store, actor.tenantId, 'overview_export', id);
      if (prior)
        return {
          id,
          report_id: report.id,
          job_id: prior.job_id,
          state: this.store.job(actor.tenantId, prior.job_id).state,
          files: prior.files,
        };
      // Retryable like the run's (src/reporting-overview.ts queue): the queue drains as its jobs finish (r25-mf-jobs 2).
      if (activeReportJobCount(this.store, actor.tenantId) >= 100)
        throw new MirrorError(
          'REPORT_QUEUE_FULL',
          'This workspace already has 100 active reporting jobs.',
          {},
          400,
          true,
        );
      const job = this.store.enqueue(actor.tenantId, 'report_file_export', {report_id: report.id, export_id: id});
      this.store.putDocument(actor.tenantId, 'overview_export', id, {
        report_id: report.id,
        destination_id: destination.id,
        destination_kind: 'report_files',
        destination_name: destination.name,
        formats: destination.formats,
        presentation: destination.presentation,
        presentation_fingerprint: fingerprint(destination.presentation),
        source_hash: hash,
        job_id: job,
        actor_binding: this.store.bindJobActor(actor, id),
        state: 'queued',
        files: [],
        created_at: Date.now(),
      });
      return {id, report_id: report.id, job_id: job, state: 'queued', files: []};
    });
  }

  async work(tenant: string, input: JsonObject, leaseCheck: () => void) {
    let e = this.store.document(tenant, 'overview_export', input.export_id);
    if (
      e.destination_kind !== 'report_files' ||
      e.report_id !== input.report_id ||
      (input.__job_id && e.job_id !== input.__job_id)
    )
      bad('The file job does not match its original export.', 'INVALID_FILE_EXPORT');
    const actor = this.store.restoreJobActor(tenant, e.id, e.actor_binding);
    this.store.bindActorCheck(actor, leaseCheck);
    const check = () => {
      leaseCheck();
      const r = this.current(tenant, e.report_id);
      this.access(actor, r.config);
      if (sourceHash(r) !== e.source_hash)
        bad('The snapshot changed after this export was queued. Create a new export.', 'REPORT_FILE_SOURCE_CHANGED');
      return r;
    };
    for (const format of e.formats as Format[]) {
      const report = check(),
        id = e.id + '.' + format;
      const retained = optional(this.store, tenant, 'report_file', id);
      if (retained) {
        this.retainedBytes(tenant, e, retained, format);
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await this.render(tenant, report, format, e.presentation);
      } catch (error) {
        if (error instanceof MirrorError && error.code === 'REPORT_DOWNLOAD_BUSY')
          throw new MirrorError(error.code, error.message, {retry_after_ms: 5000}, 429, true);
        throw error;
      }
      check();
      if (
        !Buffer.isBuffer(bytes) ||
        bytes.length > fileDeliveryLimits.output_bytes ||
        (format === 'pdf' ? bytes.subarray(0, 5).toString() !== '%PDF-' : bytes.subarray(0, 2).toString() !== 'PK')
      )
        bad('The renderer did not produce a bounded valid file.', 'REPORT_FILE_INVALID');
      this.store.transaction(() => {
        check();
        const retained = optional(this.store, tenant, 'report_file', id);
        if (retained) {
          this.retainedBytes(tenant, this.store.document(tenant, 'overview_export', e.id), retained, format);
          return;
        }
        const sealed = this.store.sealValue(tenant, 'report-file', id, {bytes: bytes.toString('base64')}),
          storageBytes = Buffer.byteLength(sealed);
        const stored = this.store.repo('report_file', tenant).sum('storage_bytes');
        if (stored + storageBytes > fileDeliveryLimits.tenant_storage_bytes)
          bad(
            'Stored report files reached the 256 MiB workspace limit. Delete old snapshots or set report retention before retrying.',
            'REPORT_FILE_QUOTA',
          );
        const receipt = {
          id,
          format,
          mime_type: fileMime(format),
          size_bytes: bytes.length,
          sha256: sha256(bytes),
          download_path: '/api/reporting-files/' + encodeURIComponent(e.id) + '.' + format,
          created_at: Date.now(),
        };
        this.store.putDocument(tenant, 'report_file', id, {
          ...receipt,
          export_id: e.id,
          report_id: e.report_id,
          source_hash: e.source_hash,
          storage_bytes: storageBytes,
          sealed,
        });
        e = this.store.document(tenant, 'overview_export', e.id);
        e = {...e, files: [...e.files, receipt], updated_at: Date.now()};
        this.store.putDocument(tenant, 'overview_export', e.id, e);
      });
    }
    const report = check();
    this.store.transaction(() => {
      e = {...this.store.document(tenant, 'overview_export', e.id), state: 'delivered', completed_at: Date.now()};
      this.store.putDocument(tenant, 'overview_export', e.id, e);
      this.store.appendAudit(tenant, 'report-files/' + e.id, {
        event: 'report_files_delivered',
        report_id: e.report_id,
        files: e.files.map((f: JsonObject) => ({format: f.format, sha256: f.sha256, size_bytes: f.size_bytes})),
        external_writes: false,
      });
      // The notes this snapshot carried reached the client with it (F-L6-03).
      this.delivered(tenant, report);
    });
    return {export_id: e.id, report_id: e.report_id, state: 'delivered', files: e.files, external_writes: false};
  }

  download(actor: Actor, exportId: string, format: Format) {
    this.store.assertActorActive(actor);
    if (!['pdf', 'xlsx'].includes(format)) bad('Choose an available PDF or XLSX file.', 'INVALID_FILE_EXPORT');
    const e = this.store.document(actor.tenantId, 'overview_export', exportId),
      report = this.store.document(actor.tenantId, 'overview_report', e.report_id);
    this.access(actor, report.config);
    if (e.destination_kind !== 'report_files' || sourceHash(report) !== e.source_hash)
      bad('The stored file no longer matches its snapshot.', 'REPORT_FILE_SOURCE_CHANGED');
    const f = this.store.document(actor.tenantId, 'report_file', e.id + '.' + format);
    const bytes = this.retainedBytes(actor.tenantId, e, f, format);
    this.access(actor, report.config);
    return {bytes, mime_type: fileMime(format), sha256: f.sha256};
  }

  private retainedBytes(tenant: string, e: JsonObject, f: JsonObject, format: Format): Buffer {
    const receipt = e.files?.find((r: JsonObject) => r.format === format);
    if (
      f.id !== e.id + '.' + format ||
      f.export_id !== e.id ||
      f.report_id !== e.report_id ||
      f.source_hash !== e.source_hash ||
      f.format !== format ||
      !receipt ||
      receipt.sha256 !== f.sha256 ||
      receipt.size_bytes !== f.size_bytes
    )
      bad('The retained file receipt failed its integrity check.', 'REPORT_FILE_INTEGRITY');
    try {
      const opened = this.store.openValue(tenant, 'report-file', f.id, f.sealed),
        bytes = Buffer.from(opened.bytes, 'base64');
      if (bytes.length > fileDeliveryLimits.output_bytes || bytes.length !== f.size_bytes || sha256(bytes) !== f.sha256)
        bad('The retained file failed its integrity check.', 'REPORT_FILE_INTEGRITY');
      return bytes;
    } catch {
      bad('The retained file failed its integrity check.', 'REPORT_FILE_INTEGRITY');
    }
  }
}
