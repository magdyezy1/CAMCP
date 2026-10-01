import {bad, fingerprint, obj} from './workspace-core.js';
import {reportPresets} from './report-presets.js';
import {normalizeAccount} from './scope.js';
import type {JsonObject} from './types.js';

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
  if (report.source === 'provider_read' && reference.source === 'provider_read') {
    const preset = reportPresets.find(p => p.id === report.preset && p.gateway === report.gateway);
    if (
      !preset ||
      report.preset !== reference.preset ||
      report.grain !== preset.grain ||
      reference.grain !== preset.grain
    )
      mismatch.push('guided native grain');
    if (
      !obj(report.mapping) ||
      !obj(reference.mapping) ||
      fingerprint(report.mapping) !== fingerprint(reference.mapping)
    )
      mismatch.push('native field mapping');
  } else if (report.source === 'overview_snapshot' && reference.source === 'overview_snapshot') {
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
