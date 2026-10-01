import {bad, validate, fingerprint} from './workspace-core.js';
import type {JsonObject} from './types.js';
export function reportScenarios(report: JsonObject, input: JsonObject) {
  validate(input, ['budgets', 'efficiency_low', 'efficiency_high']);
  const budgets = input.budgets,
    low = input.efficiency_low,
    high = input.efficiency_high;
  if (
    !Array.isArray(budgets) ||
    !budgets.length ||
    budgets.length > 12 ||
    budgets.some(v => !/^\d+(\.\d{1,6})?$/.test(String(v)) || Number(v) > 1e12)
  )
    bad('Use 1–12 nonnegative budgets with up to six decimal places.');
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low || high > 10)
    bad('Declare efficiency factors with 0 < low ≤ high ≤ 10.');
  const spend = Number(report.totals.spend),
    conversions = Number(report.totals.conversions);
  if (report.totals.spend === null || report.totals.conversions === null || spend <= 0 || conversions <= 0)
    bad('Scenarios require observed positive spend and conversions.', 'SCENARIO_EVIDENCE_REQUIRED');
  return {
    version: 1,
    report_id: report.id,
    currency: report.semantics.currency,
    source_hash: report.source_hash,
    captured_at: report.captured_at,
    semantics: report.semantics,
    observed: {spend: report.totals.spend, conversions: report.totals.conversions, cpa: spend / conversions},
    assumptions: {response: 'linear at the observed cost per conversion', efficiency_low: low, efficiency_high: high},
    scenarios: budgets.map(budget => ({
      budget: String(budget),
      modeled_conversions_low: (Number(budget) / spend) * conversions * low,
      modeled_conversions_high: (Number(budget) / spend) * conversions * high,
    })),
    evidence_status:
      report.semantics.complete && Date.now() - report.captured_at <= 7 * 86400000
        ? 'recent_complete'
        : 'stale_or_incomplete',
    model_fingerprint: fingerprint({source: report.source_hash, budgets, low, high}),
    limitations: [
      'Illustrative sensitivity model, not a forecast or a statistical confidence interval.',
      'Assumes unchanged prices, auction conditions, targeting, creative and measurement. Actual delivery can differ.',
      'These scenarios never change budgets, activate campaigns or create an approval.',
    ],
    advertising_writes: 0,
  };
}
