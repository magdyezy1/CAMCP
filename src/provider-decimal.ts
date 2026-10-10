import {MirrorError} from './errors.js';

/**
 * Provider report metrics arrive as JSON doubles (shortest round-trip text, sometimes exponent form) or as decimal
 * strings of any length. Owner decision D10 fixes the retained precision: nine decimal places, rounded half to even,
 * with the rounding recorded in the evidence. Parsing works on the decimal digit text only, never on float arithmetic.
 * Caller-declared totals and tolerances keep their stricter grammar (see scaledDeclared in decision-reporting.ts).
 */
export const providerMetricRounding = Object.freeze({places: 9, rule: 'half_even'} as const);
export type ProviderDecimal = {scaled: bigint; rounded: boolean};
type Exact = {digits: bigint; scale: number};

const grammar = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/;
const powers = new Set(['1', '10', '100', '1000', '10000', '100000', '1000000', '10000000', '100000000', '1000000000']);

function shape(field: string, message: string, code = 'REPORT_SHAPE_CHANGED'): never {
  throw new MirrorError(code, message, {field}, 502);
}
function exact(value: unknown, field: string, divisor: unknown = 1): Exact {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0)
      shape(field, 'Provider metric ' + field + ' is not a finite nonnegative number.');
    if (value > Number.MAX_SAFE_INTEGER)
      shape(
        field,
        'Provider metric ' + field + ' exceeds exact JSON number precision. The native decimal text is required.',
        'METRIC_PRECISION_LOSS',
      );
  } else if (typeof value !== 'string') shape(field, 'Provider metric ' + field + ' is not a decimal value.');
  // String(number) is the shortest round-trip text of the double, for example 0.30000000000000004 or 1e-7.
  const text = typeof value === 'number' ? String(value) : value;
  const match = text.length <= 400 ? grammar.exec(text) : null;
  if (!match) shape(field, 'Provider metric ' + field + ' is not a nonnegative decimal value.');
  if (!powers.has(String(divisor))) shape(field, 'Provider metric ' + field + ' uses an unsupported native unit.');
  const fraction = match![2] ?? '';
  return {
    digits: BigInt(match![1] + fraction),
    scale: fraction.length - Number(match![3] ?? 0) + (String(divisor).length - 1),
  };
}
/** Exact native value at nine decimal places, rounded half to even when the provider sent more precision. */
export function parseProviderDecimal(
  value: unknown,
  options: {field: string; divisor?: unknown; places?: number},
): ProviderDecimal {
  const places = options.places ?? providerMetricRounding.places,
    {digits, scale} = exact(value, options.field, options.divisor);
  if (scale <= places) return {scaled: digits * 10n ** BigInt(places - scale), rounded: false};
  const unit = 10n ** BigInt(scale - places),
    quotient = digits / unit,
    remainder = digits % unit,
    twice = remainder * 2n,
    up = twice > unit || (twice === unit && quotient % 2n === 1n);
  return {scaled: up ? quotient + 1n : quotient, rounded: remainder !== 0n};
}
/** Lossless decimal text for display-only native values such as reach and frequency, which are never summed. */
export function providerDecimalText(value: unknown, options: {field: string; divisor?: unknown}): string {
  const {digits, scale} = exact(value, options.field, options.divisor);
  if (scale <= 0) return (digits * 10n ** BigInt(-scale)).toString();
  const text = digits.toString().padStart(scale + 1, '0'),
    whole = text.slice(0, text.length - scale),
    fraction = text.slice(text.length - scale).replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : whole;
}
/** Evidence record for semantics.metric_rounding; absent when no provider value needed rounding. */
export function metricRoundingRecord(counts: Record<string, number>): Record<string, JsonRounding> | undefined {
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  return entries.length
    ? Object.fromEntries(
        entries.map(([metric, rows_rounded]) => [
          metric,
          {places: providerMetricRounding.places, rule: providerMetricRounding.rule, rows_rounded},
        ]),
      )
    : undefined;
}
/** Combine per-period rounding records without inventing rounding for periods that were exact. */
export function mergeMetricRounding(records: unknown[]): Record<string, JsonRounding> | undefined {
  const counts: Record<string, number> = {};
  for (const record of records)
    if (record && typeof record === 'object' && !Array.isArray(record))
      for (const [metric, entry] of Object.entries(record as Record<string, JsonRounding>))
        if (Number.isSafeInteger(entry?.rows_rounded)) counts[metric] = (counts[metric] ?? 0) + entry.rows_rounded;
  return metricRoundingRecord(counts);
}
/** Disclosed wherever retained evidence carrying semantics.metric_rounding feeds a model. Arabic copy: web/locales/ar.json. */
export const metricRoundingLimitation =
  'Provider values with more than nine decimal places were rounded half to even to nine places. Each rounded value differs from the provider value by at most 0.0000000005, so totals can differ slightly from provider totals.';
type JsonRounding = {places: number; rule: string; rows_rounded: number};
