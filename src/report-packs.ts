import {audit, bad, fingerprint, optional, validate, writer} from './workspace-core.js';
import {MirrorError} from './errors.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
export const defaultPresentation = {brand_name: '', accent_color: '#354B67', footer: '', template: 'standard'};
export function presentationStyle(value: JsonObject = {}) {
  validate(value, ['brand_name', 'accent_color', 'footer', 'template'], 4096, 'presentation');
  const style = {...defaultPresentation, ...value};
  for (const [key, limit] of [
    ['brand_name', 100],
    ['footer', 200],
  ] as const)
    if (typeof style[key] !== 'string' || style[key].length > limit || /[\u0000-\u001f\u007f]/.test(style[key]))
      bad('Use a short, single-line ' + key + '.');
  if (!/^#[0-9a-fA-F]{6}$/.test(style.accent_color) || !['standard', 'compact'].includes(style.template))
    bad('Choose a six-digit hex accent color and standard or compact template.');
  return style;
}
export function retainedPresentation(store: Store, tenant: string, id: string) {
  const record = optional(store, tenant, 'report_presentation', id);
  return {presentation: presentationStyle(record?.presentation), presentation_revision: record?.revision ?? 0};
}
/** Caller checks all report sources first. The transaction has no provider side effects. */
export function savePresentation(store: Store, actor: Actor, id: string, input: JsonObject) {
  writer(store, actor);
  if (input.confirmed !== true) bad('Confirm saving the client report presentation.', 'CONFIRMATION_REQUIRED');
  if (input.presentation === undefined)
    bad('Supply the presentation fields to save, or an empty object to reset them.');
  const presentation = presentationStyle(input.presentation);
  if (!Number.isSafeInteger(input.presentation_revision) || input.presentation_revision < 0)
    bad('Supply the current presentation_revision, or 0 for a new presentation.');
  return store.transaction(() => {
    const current = retainedPresentation(store, actor.tenantId, id);
    if (current.presentation_revision !== input.presentation_revision)
      throw new MirrorError('REVISION_CONFLICT', 'Reload the report pack before changing its presentation.', {}, 409);
    store.putDocument(actor.tenantId, 'report_presentation', id, {
      presentation,
      updated_at: Date.now(),
      updated_by: actor.userId,
    });
    audit(store, actor, 'report_presentation_saved', {report_id: id, revision: input.presentation_revision + 1});
    return retainedPresentation(store, actor.tenantId, id);
  });
}
/** A presentation of an existing snapshot. No fresh queries, currency conversion or extra aggregation. */
export function reportPack(
  report: JsonObject,
  retained = {presentation: defaultPresentation, presentation_revision: 0},
) {
  if (!['complete', 'partial'].includes(report.state))
    bad('Create a report pack from a finished snapshot.', 'REPORT_NOT_READY');
  return {
    version: 2,
    ...retained,
    snapshot_id: report.id,
    title: report.config.name,
    client_name: report.config.client_name ?? '',
    state: report.state,
    created_at: report.completed_at,
    date_range: report.config.date_range,
    grain: report.config.grain ?? 'total',
    row_count: report.rows.length,
    summary: report.summary ?? [],
    custom_metrics: report.config.custom_metrics ?? [],
    source_hash: fingerprint({rows: report.rows, config: report.config}),
    sources: (report.sources ?? []).map((s: JsonObject) => ({
      platform: s.source?.platform,
      account_id: s.source?.account_id,
      complete: s.complete,
      row_count: s.row_count,
      error: s.error ? {code: s.error.code, message: s.error.message} : null,
      attribution: s.attribution,
      result_definition: s.result_definition,
      query_fingerprint: s.query_fingerprint,
    })),
    csv_path: '/api/reporting-overview/' + encodeURIComponent(report.id) + '.csv',
    xlsx_path: '/api/reporting-overview/' + encodeURIComponent(report.id) + '.xlsx',
    pdf_path: '/api/reporting-overview/' + encodeURIComponent(report.id) + '.pdf',
    evidence_path: '/api/reporting-overview/' + encodeURIComponent(report.id) + '.metadata.json',
    limitations: [
      'Account currencies, timezones, attribution and conversion definitions remain separate.',
      'Reach and frequency are not summed. Calculated ratios come from compatible additive totals.',
      'Recommendations are advisory; a separate review is required for advertising changes.',
    ],
    network_requests: 0,
  };
}
