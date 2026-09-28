import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

export function validateRecommendationContext(p: JsonObject, known: Set<string>) {
  const c = p.context;
  if (c === undefined) return;
  if (
    !c ||
    typeof c !== 'object' ||
    Array.isArray(c) ||
    Object.keys(c).some(
      k =>
        ![
          'note',
          'seasonal_event',
          'recent_change',
          'tracking_verified',
          'capacity_available',
          'budget_available',
          'secondary_kpi',
          'current_daily_budget',
          'maximum_daily_budget',
        ].includes(k),
    )
  )
    throw new MirrorError('INVALID_TARGET', 'Use supported recommendation context fields.');
  for (const k of ['note', 'seasonal_event'])
    if (c[k] !== undefined && (typeof c[k] !== 'string' || c[k].length > 1000))
      throw new MirrorError('INVALID_TARGET', 'Business context text is limited to 1,000 characters.');
  for (const k of ['recent_change', 'tracking_verified', 'capacity_available', 'budget_available'])
    if (c[k] !== undefined && typeof c[k] !== 'boolean')
      throw new MirrorError('INVALID_TARGET', 'Recommendation context flags must be booleans.');
  for (const k of ['current_daily_budget', 'maximum_daily_budget'])
    if (c[k] !== undefined && (typeof c[k] !== 'number' || !Number.isFinite(c[k]) || c[k] < 0))
      throw new MirrorError('INVALID_TARGET', 'Budget context must use nonnegative amounts in the target currency.');
  const s = c.secondary_kpi;
  if (
    s !== undefined &&
    (!s ||
      !known.has(s.kpi) ||
      typeof s.target !== 'number' ||
      !Number.isFinite(s.target) ||
      s.target <= 0 ||
      !['higher', 'lower'].includes(s.direction))
  )
    throw new MirrorError(
      'INVALID_TARGET',
      'A secondary KPI needs a valid metric, positive target and higher/lower direction.',
    );
}
export function recommendationContext(row: JsonObject, p: JsonObject): JsonObject | null {
  const c = p.context ?? {},
    base = {
      business_context: c,
      confidence: 'limited',
      limitations: ['Observational comparison; no causal lift or seasonal adjustment is inferred.'],
    };
  if (c.tracking_verified === false)
    return {
      decision: 'needs_review',
      reason: 'Tracking is marked unverified. Resolve measurement before changing delivery.',
      evidence: base,
    };
  if (c.recent_change || c.seasonal_event)
    return {
      decision: 'needs_review',
      reason:
        'A recent change or seasonal event may explain this result. Review the supplied context before changing budgets.',
      evidence: base,
    };
  const s = c.secondary_kpi,
    actual = s ? row.metrics[s.kpi] : null;
  if (s && (actual == null || (s.direction === 'higher' ? actual < s.target : actual > s.target)))
    return {
      decision: 'needs_review',
      reason:
        'The secondary KPI is unavailable or below its target. Resolve the conflicting evidence before changing delivery.',
      evidence: {...base, secondary_kpi: {...s, actual}},
    };
  return null;
}
