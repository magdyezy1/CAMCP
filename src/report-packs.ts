import {audit, bad, fingerprint, optional, read, validate, writer} from './workspace-core.js';
import {MirrorError} from './errors.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {reportPlatforms, recommendationValidityMs} from './report-metrics.js';
import {normalizeAccount} from './scope.js';
export const defaultPresentation = {brand_name: '', accent_color: '#354B67', footer: '', template: 'standard'};
export function presentationStyle(value: JsonObject = {}) {
  validate(value, ['brand_name', 'accent_color', 'footer', 'template', 'artifact_language'], 4096, 'presentation');
  if (value.artifact_language !== undefined && !['en', 'ar'].includes(value.artifact_language))
    bad('Choose English or Arabic for PDF and Excel files.');
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
  return {
    presentation: presentationStyle(record?.presentation),
    presentation_revision: record?.revision ?? 0,
    presentation_source: record?.profile_source ?? null,
  };
}
/** Caller checks all report sources first. The transaction has no provider side effects. */
export function savePresentation(
  store: Store,
  actor: Actor,
  id: string,
  input: JsonObject,
  profileSource?: JsonObject,
) {
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
      ...(profileSource ? {profile_source: profileSource} : {}),
    });
    audit(store, actor, 'report_presentation_saved', {report_id: id, revision: input.presentation_revision + 1});
    return retainedPresentation(store, actor.tenantId, id);
  });
}
function approvedProfileStyle(profile: JsonObject, report: JsonObject) {
  if (
    typeof profile.approved_by !== 'string' ||
    !profile.approved_by ||
    !Number.isFinite(profile.approved_at) ||
    profile.report_presentation === undefined
  )
    bad('Choose an approved client profile with report branding.', 'PROFILE_NOT_APPROVED');
  if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 100)
    bad('The approved profile has no valid name.', 'INVALID_PROFILE');
  const bindings = profile.bindings ?? [];
  if (!Array.isArray(bindings)) bad('The approved profile has invalid account bindings.', 'INVALID_PROFILE');
  if (
    bindings.length &&
    report.config.sources.some((source: JsonObject) => {
      const gateway = reportPlatforms[source.platform]?.gateway;
      if (!gateway) return true;
      return !bindings.some(
        (binding: JsonObject) =>
          binding?.gateway === gateway &&
          binding.connection_id === source.connection_id &&
          normalizeAccount(gateway, binding.account_id) === normalizeAccount(gateway, source.account_id),
      );
    })
  )
    bad(
      "Every report source must belong to this profile's exact account and login bindings.",
      'PROFILE_ACCOUNT_MISMATCH',
    );
  return presentationStyle(profile.report_presentation);
}
/** Caller has checked all snapshot sources. Project only reusable branding metadata, never campaign templates. */
export function presentationProfiles(store: Store, actor: Actor, report: JsonObject, input: JsonObject) {
  store.assertActorActive(actor);
  const offset = input.offset ?? 0,
    limit = input.limit ?? 30;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    bad('Use an offset >= 0 and a page size of 1–100.');
  const rows = store.db
    .prepare(
      `SELECT id,revision,json_object('name',json_extract(data,'$.name'),
    'approved_by',json_extract(data,'$.approved_by'),'approved_at',json_extract(data,'$.approved_at'),
    'bindings',json_extract(data,'$.bindings'),'report_presentation',json_extract(data,'$.report_presentation')) AS data
    FROM documents WHERE tenant_id=? AND kind='client_profile' AND json_type(data,'$.report_presentation')='object'
    ORDER BY id LIMIT 100 OFFSET ?`,
    )
    .all(actor.tenantId, offset) as JsonObject[];
  const profiles: JsonObject[] = [];
  let scanned = 0;
  for (const row of rows) {
    scanned++;
    const p = JSON.parse(row.data);
    try {
      profiles.push({
        id: row.id,
        revision: row.revision,
        name: p.name,
        approved_at: p.approved_at,
        presentation: approvedProfileStyle(p, report),
      });
    } catch (e) {
      if (!(e instanceof MirrorError)) throw e;
    }
    if (profiles.length >= limit) break;
  }
  return {
    profiles,
    next_offset: scanned < rows.length || rows.length === 100 ? offset + scanned : null,
    network_requests: 0,
  };
}
/** Copy an exact approved profile revision; later profile edits/deletion never rewrite saved report presentations. */
export function applyProfilePresentation(store: Store, actor: Actor, report: JsonObject, input: JsonObject) {
  writer(store, actor);
  if (!Number.isSafeInteger(input.profile_revision) || input.profile_revision < 1)
    bad('Supply the exact approved profile_revision.');
  return store.transaction(() => {
    const profile = read(store, actor, 'client_profile', input.profile_id);
    if (profile.revision !== input.profile_revision)
      throw new MirrorError(
        'REVISION_CONFLICT',
        'Reload the approved client profile before applying its branding.',
        {},
        409,
      );
    const presentation = approvedProfileStyle(profile, report);
    return savePresentation(
      store,
      actor,
      report.id,
      {...input, presentation},
      {
        profile_id: profile.id,
        profile_revision: profile.revision,
        profile_name: profile.name,
        approved_at: profile.approved_at,
      },
    );
  });
}
/** A presentation of an existing snapshot. No fresh queries, currency conversion or extra aggregation. */
export function reportPack(
  report: JsonObject,
  retained = {presentation: defaultPresentation, presentation_revision: 0},
  now = Date.now(),
) {
  if (!['complete', 'partial'].includes(report.state))
    bad('Create a report pack from a finished snapshot.', 'REPORT_NOT_READY');
  // DEC-01: frozen recommendations carry an as-of time; the pack says when they stop being current.
  const validUntil = (report.rows ?? []).reduce((earliest: number | null, row: JsonObject) => {
      const at =
        typeof row.recommendation?.valid_until === 'number'
          ? row.recommendation.valid_until
          : typeof row.captured_at === 'number'
            ? row.captured_at + recommendationValidityMs
            : null;
      return at === null ? earliest : earliest === null ? at : Math.min(earliest, at);
    }, null),
    expired = validUntil !== null && now > validUntil;
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
    // RPT-05: the pack names platforms as AMCP displays them ("Meta", not "meta").
    platform_names: Object.fromEntries(
      [
        ...(report.summary ?? []).map((s: JsonObject) => s.platform),
        ...(report.sources ?? []).map((s: JsonObject) => s.source?.platform),
      ]
        .filter((p): p is string => typeof p === 'string' && Object.hasOwn(reportPlatforms, p))
        .map(p => [p, reportPlatforms[p]!.name]),
    ),
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
    recommendations_valid_until: validUntil === null ? null : new Date(validUntil).toISOString(),
    recommendations_expired: expired,
    limitations: [
      'Account currencies, timezones, attribution and conversion definitions remain separate.',
      'Reach and frequency are not summed. Calculated ratios come from compatible additive totals.',
      'Recommendations are advisory; a separate review is required for advertising changes.',
      ...(expired ? ['Recommendations in this snapshot have expired. Refresh the report before acting on them.'] : []),
    ],
    network_requests: 0,
  };
}
