import {bad} from './workspace-core.js';

/**
 * A retained evidence date: a YYYY-MM-DD calendar day, as the epoch milliseconds of its UTC midnight; anything else is
 * refused (SCENARIO_EVIDENCE_REQUIRED). The allocation models (src/report-allocation.ts) and the guided platforms'
 * checks of their allocation evidence share it.
 */
export function evidenceDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    bad('Retain valid evidence dates.', 'SCENARIO_EVIDENCE_REQUIRED');
  const time = Date.parse(value as string);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value)
    bad('Retain valid evidence dates.', 'SCENARIO_EVIDENCE_REQUIRED');
  return time;
}
