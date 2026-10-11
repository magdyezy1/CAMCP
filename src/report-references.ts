import {bad, fingerprint, obj, validate} from './workspace-core.js';
import {reportPresets} from './report-presets.js';
import {normalizeAccount} from './scope.js';
import type {JsonObject} from './types.js';

/** Only the declared fields are comparable; a client's file hash is not independently verified here. */
export function compareDeclaredReference(report: JsonObject, reference: JsonObject) {
  if (reference.context === undefined && reference.file === undefined) return false;
  const context = reference.context;
  if (!obj(context))
    bad('Declare the reference report settings before importing file totals.', 'REPORT_REFERENCE_REQUIRED');
  const settings = ['currency', 'timezone', 'date_from', 'date_to', 'attribution', 'conversion_definition'];
  validate(
    context,
    ['gateway', 'account_id', ...settings, 'grain', 'complete', 'same_entities_and_filters'],
    undefined,
    'reference context',
  );
  const mismatch: string[] = [];
  if (
    context.gateway !== report.gateway ||
    typeof context.account_id !== 'string' ||
    !context.account_id ||
    normalizeAccount(context.gateway, context.account_id) !== normalizeAccount(report.gateway, report.account_id)
  )
    mismatch.push('account');
  for (const key of settings) {
    const value = context[key];
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      /^(unknown|unspecified|n\/a)$/i.test(value.trim()) ||
      value !== report.semantics?.[key]
    )
      mismatch.push(key);
  }
  if (context.complete !== true || report.semantics?.complete !== true) mismatch.push('complete');
  if (context.same_entities_and_filters !== true) mismatch.push('entities and filters');
  const preset =
    report.source === 'provider_read' &&
    reportPresets.find(p => p.id === report.preset && p.gateway === report.gateway);
  const overview =
    report.source === 'overview_snapshot' &&
    report.source_lineage?.definition_fingerprint &&
    report.source_request?.group_id &&
    ['total', 'daily', 'weekly', 'monthly'].includes(report.source_request.grain);
  const grain =
    preset && report.grain === preset.grain ? preset.grain : overview ? report.source_request.grain : undefined;
  if (!grain || context.grain !== grain) mismatch.push('native grain');
  if (mismatch.length)
    bad('Declared reference settings do not match: ' + mismatch.join(', ') + '.', 'REPORT_SEMANTICS_MISMATCH', {
      fields: mismatch,
    });
  if (reference.file !== undefined) {
    const file = reference.file;
    if (!obj(file)) bad('Provide bounded CSV source metadata.', 'REPORT_REFERENCE_REQUIRED');
    validate(
      file,
      ['sha256', 'bytes', 'encoding', 'delimiter', 'rows', 'number_format', 'columns', 'money_scales'],
      undefined,
      'reference file metadata',
    );
    const metrics = ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value'];
    const keys = Object.keys(reference.totals ?? {});
    if (
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 65536 ||
      !['utf-8', 'utf-16le', 'utf-16be'].includes(file.encoding) ||
      ![',', ';', '\t'].includes(file.delimiter) ||
      file.rows !== 1 ||
      !['decimal_dot', 'decimal_comma'].includes(file.number_format) ||
      !obj(file.columns) ||
      !obj(file.money_scales) ||
      !keys.length ||
      keys.some(k => !metrics.includes(k)) ||
      Object.keys(file.columns).length !== keys.length ||
      keys.some(k => typeof file.columns[k] !== 'string' || !file.columns[k].trim() || file.columns[k].length > 200) ||
      new Set(Object.values(file.columns)).size !== keys.length ||
      Object.keys(file.money_scales).some(k => !['spend', 'conversion_value'].includes(k) || !keys.includes(k)) ||
      keys.filter(k => ['spend', 'conversion_value'].includes(k)).some(k => ![0, 2, 6].includes(file.money_scales[k]))
    )
      bad(
        'CSV provenance must name one bounded totals row, exact mapped columns, encoding, units and SHA-256.',
        'REPORT_REFERENCE_REQUIRED',
      );
  }
  return true;
}

/**
 * The preset, grain and mapping part of the definition check. `guided` (reconcile) requires a qualified preset at its
 * own grain; otherwise (analyze baselines, RPT-04) manual captures qualify when they use the same native action,
 * grain and mapping.
 */
function nativeDefinitionMismatch(report: JsonObject, reference: JsonObject, guided: boolean): string[] {
  const mismatch: string[] = [];
  const preset = reportPresets.find(p => p.id === report.preset && p.gateway === report.gateway);
  if (
    report.preset !== reference.preset ||
    report.grain !== reference.grain ||
    (guided
      ? !preset || report.grain !== preset.grain
      : (report.preset !== undefined && !preset) ||
        (report.preset === undefined && report.source_request?.action !== reference.source_request?.action))
  )
    mismatch.push('guided native grain');
  if (!obj(report.mapping) || !obj(reference.mapping) || fingerprint(report.mapping) !== fingerprint(reference.mapping))
    mismatch.push('native field mapping');
  if (
    ['snapchat_adsquad', 'snapchat_adsquad_leads', 'snapchat_ad_leads'].includes(report.preset) &&
    (typeof report.source_request?.path_params?.campaign_id !== 'string' ||
      report.source_request.path_params.campaign_id !== reference.source_request?.path_params?.campaign_id)
  )
    mismatch.push('native parent campaign');
  return mismatch;
}
/**
 * RPT-04: an analyze baseline is another window of the same report definition: the same source type, preset or
 * native action, grain and mapping (Overview captures: the same grouping and mapping). Windows differ by design, so
 * dates and the Overview definition fingerprint are not compared here.
 */
export function assertCompatibleBaseline(report: JsonObject, baseline: JsonObject) {
  const mismatch: string[] = [];
  if (report.source !== baseline.source) mismatch.push('source type');
  else if (report.source === 'provider_read') mismatch.push(...nativeDefinitionMismatch(report, baseline, false));
  else if (report.source === 'overview_snapshot') {
    if (report.source_request?.grain !== baseline.source_request?.grain) mismatch.push('grain');
    if (fingerprint(report.mapping ?? null) !== fingerprint(baseline.mapping ?? null))
      mismatch.push('native field mapping');
  }
  if (mismatch.length)
    bad(
      'The baseline is not another window of the same report: ' + mismatch.join(', ') + '.',
      'REPORT_SEMANTICS_MISMATCH',
      {fields: mismatch},
    );
}
/** This checks retained declarations and scope, not an independent audit of a provider's attribution model. */
export function compareReportContext(report: JsonObject, reference: JsonObject) {
  if (report.id === reference.id) bad('Choose a different retained report.', 'REPORT_REFERENCE_REQUIRED');
  const mismatch: string[] = [];
  if (
    typeof report.account_id !== 'string' ||
    !report.account_id ||
    typeof reference.account_id !== 'string' ||
    !reference.account_id ||
    report.gateway !== reference.gateway ||
    normalizeAccount(report.gateway, report.account_id) !== normalizeAccount(reference.gateway, reference.account_id)
  )
    mismatch.push('account');
  for (const key of ['currency', 'timezone', 'date_from', 'date_to', 'attribution', 'conversion_definition']) {
    const a = report.semantics?.[key],
      b = reference.semantics?.[key];
    if (typeof a !== 'string' || !a.trim() || a !== b || /^(unknown|unspecified|n\/a)$/i.test(a.trim()))
      mismatch.push(key);
  }
  if (report.semantics?.complete !== true || reference.semantics?.complete !== true) mismatch.push('complete');
  if (report.source === 'provider_read' && reference.source === 'provider_read')
    mismatch.push(...nativeDefinitionMismatch(report, reference, true));
  else if (report.source === 'overview_snapshot' && reference.source === 'overview_snapshot') {
    if (
      !report.source_lineage?.definition_fingerprint ||
      report.source_lineage.definition_fingerprint !== reference.source_lineage?.definition_fingerprint ||
      !report.source_request?.group_id ||
      report.source_request.group_id !== reference.source_request?.group_id ||
      !['total', 'daily', 'weekly', 'monthly'].includes(report.source_request?.grain) ||
      report.source_request.grain !== reference.source_request?.grain
    )
      mismatch.push('retained definition and group');
  } else mismatch.push('source type');
  if (mismatch.length)
    bad('Retained reports cannot be reconciled: ' + mismatch.join(', ') + '.', 'REPORT_SEMANTICS_MISMATCH', {
      fields: mismatch,
    });
  return {
    gateway: report.gateway,
    account_id: report.account_id,
    currency: report.semantics.currency,
    timezone: report.semantics.timezone,
    date_from: report.semantics.date_from,
    date_to: report.semantics.date_to,
    attribution: report.semantics.attribution,
    conversion_definition: report.semantics.conversion_definition,
    grain: report.grain ?? report.source_request.grain,
  };
}
