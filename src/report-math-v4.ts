import {AsyncLocalStorage} from 'node:async_hooks';
import {MirrorError} from './errors.js';
import {providerDecimalText, providerMetricRounding} from './provider-decimal.js';
import {metricDefinitions, parseMetricFormula} from './report-metrics.js';
import type {JsonObject} from './types.js';

const places = providerMetricRounding.places,
  scale = 10n ** BigInt(places);
export type Rational = {n: bigint; d: bigint};
/** The exact values of the metrics a calculation has already produced, so a dependent metric starts from them. */
export type ExactValues = Map<string, Rational | null>;
type Tree = ReturnType<typeof parseMetricFormula>['tree'];
const trees = new Map<string, Tree>();
const dependencies = new Map<string, string[]>();
function parsed(formula: string) {
  let tree = trees.get(formula);
  if (!tree) {
    const found = parseMetricFormula(formula);
    tree = found.tree;
    if (trees.size >= 1000) {
      trees.clear();
      dependencies.clear();
    }
    trees.set(formula, tree);
    dependencies.set(formula, found.dependencies);
  }
  return tree;
}
/** The metrics a formula names, parsed once per formula. */
export function formulaDependencies(formula: string): string[] {
  parsed(formula);
  return dependencies.get(formula)!;
}

/*
 * Calculation limits (F-L9-01). A custom metric set that validation accepts must not stop the process that also serves
 * the website and the MCP endpoint, so a calculation is bounded three ways, and a metric that reaches a bound is
 * unavailable, never a rounded guess:
 * - a numerator or denominator never exceeds 4,096 digits, checked before an operation multiplies, not after;
 * - the arithmetic on large numbers one report may do is metered (work, below) and ends when it is spent;
 * - the time a report's calculations may take ends them too, which the row loop checks as it goes.
 * Numbers below about 58 digits are not metered: no legitimate metric comes near them.
 */
const maxBits = 13608;
const small = 1n << 192n;
const isBig = (value: bigint) => value > small || value < -small;
const bitLength = (value: bigint) => (value < 0n ? -value : value).toString(2).length;
/** The marker of a calculation that went past a bound: its metric is unavailable (`calculation_limit`), nothing fails. */
const bound = {calculation_limit: true};
const sizeLimit = () =>
  new MirrorError('METRIC_PRECISION_LOSS', 'The calculated metric exceeds the report precision limit.', bound);
const workLimit = () =>
  new MirrorError('CALCULATION_LIMIT', 'The calculated metric exceeds the report precision limit.', bound);
export const isCalculationLimit = (error: unknown): error is MirrorError =>
  error instanceof MirrorError && error.details.calculation_limit === true;
/** What one report's calculations may spend: units of about a microsecond of arithmetic on large numbers, and time. */
export const reportCalculationLimits: Readonly<{work: number; elapsed_ms: number}> = Object.freeze({
  work: 300000,
  elapsed_ms: 120000,
});
class CalculationBudget {
  used = 0;
  calls = 0;
  expired = false;
  readonly deadline: number;
  constructor(
    readonly work: number,
    elapsed: number,
  ) {
    this.deadline = performance.now() + elapsed;
  }
}
const budgets = new AsyncLocalStorage<CalculationBudget>();
/** Runs `fn` (and what it awaits) with one report's calculation budget. Outside a budget nothing is metered. */
export function withCalculationBudget<T>(
  fn: () => T,
  limits: {work: number; elapsed_ms: number} = reportCalculationLimits,
): T {
  return budgets.run(new CalculationBudget(limits.work, limits.elapsed_ms), fn);
}
/**
 * Called as a formula starts: notices when the report's time is spent, after which no formula is calculated. Spent work
 * ends only the arithmetic on large numbers (meter, below), so the ordinary metrics of later rows still calculate.
 */
function checkBudget() {
  const budget = budgets.getStore();
  if (!budget) return;
  if (++budget.calls % 256 === 0 && performance.now() > budget.deadline) budget.expired = true;
  if (budget.expired) throw workLimit();
}
// The cost of reducing a fraction is the steps of Euclid's algorithm (the smaller operand's bits) times a division of
// the larger: about a microsecond for two 100-bit numbers' worth, 14 ms for two 4,000-digit ones, and trivial when the
// denominator is 1.
function meter(n: bigint, d: bigint) {
  if (!isBig(n) && !isBig(d)) return;
  const budget = budgets.getStore();
  if (!budget) return;
  const a = bitLength(n),
    b = bitLength(d);
  budget.used += (Math.min(a, b) / 100 + 1) * (Math.max(a, b) / 100);
  if (budget.used > budget.work) throw workLimit();
}
/** Refuses an operation whose result would exceed the size bound, before it is computed. */
function checkSize(op: string, a: Rational, b: Rational) {
  if (!isBig(a.n) && !isBig(a.d) && !isBig(b.n) && !isBig(b.d)) return;
  const an = bitLength(a.n),
    ad = bitLength(a.d),
    bn = bitLength(b.n),
    bd = bitLength(b.d),
    [top, bottom] =
      op === '*' ? [an + bn, ad + bd] : op === '/' ? [an + bd, ad + bn] : [Math.max(an + bd, bn + ad) + 1, ad + bd];
  if (top > maxBits || bottom > maxBits) throw sizeLimit();
}

const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1n;
};
function fraction(n: bigint, d: bigint): Rational {
  meter(n, d);
  const factor = gcd(n, d),
    sign = d < 0n ? -1n : 1n;
  const value = {n: (n / factor) * sign, d: (d / factor) * sign};
  if ((isBig(value.n) && bitLength(value.n) > maxBits) || (isBig(value.d) && bitLength(value.d) > maxBits))
    throw sizeLimit();
  return value;
}
function decimal(value: unknown): Rational | null {
  if (value === undefined || value === null) return null;
  const negative = typeof value === 'number' ? value < 0 : typeof value === 'string' && value.startsWith('-'),
    unsigned = negative ? (typeof value === 'number' ? -value : (value as string).slice(1)) : value,
    text =
      typeof unsigned === 'string' && unsigned.length <= 4096 && /^\d+(?:\.\d+)?$/.test(unsigned)
        ? unsigned
        : providerDecimalText(unsigned, {field: 'calculated_metric'}),
    [whole, digits = ''] = text.split('.');
  return fraction(BigInt(whole! + digits) * (negative ? -1n : 1n), 10n ** BigInt(digits.length));
}
function evaluate(tree: Tree, values: JsonObject, exact?: ExactValues): Rational | null {
  if (tree.kind === 'value') return decimal(tree.value);
  if (tree.kind === 'field') return exact?.has(tree.name) ? (exact.get(tree.name) ?? null) : decimal(values[tree.name]);
  if (tree.kind === 'unary') {
    const value = evaluate(tree.value, values, exact);
    return value ? {...value, n: -value.n} : null;
  }
  const a = evaluate(tree.left, values, exact),
    b = evaluate(tree.right, values, exact);
  if (!a || !b) return null;
  if (tree.op === '/' && b.n === 0n) return null;
  checkSize(tree.op, a, b);
  if (tree.op === '+') return fraction(a.n * b.d + b.n * a.d, a.d * b.d);
  if (tree.op === '-') return fraction(a.n * b.d - b.n * a.d, a.d * b.d);
  if (tree.op === '*') return fraction(a.n * b.n, a.d * b.d);
  return fraction(a.n * b.d, a.d * b.n);
}
/** The one formatter of a nine-place scaled integer as exact decimal text: 1500000000n is "1.5", -1n is "-0.000000001". */
export function reportScaledText(value: bigint): string {
  const negative = value < 0n,
    magnitude = negative ? -value : value,
    fraction = (magnitude % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + (magnitude / scale).toString() + (fraction ? '.' + fraction : '');
}
/** Keep the rational expression exact between operations; round only its final value, half to even, to nine places. */
export function evaluateReportFormulaV4(formula: string, values: JsonObject) {
  checkBudget();
  return retained(evaluate(parsed(formula), values));
}
/**
 * The exact value of a formula. `exact` holds the exact values of the metrics already calculated, so a metric that
 * depends on another starts from its fraction, not from the text it was rounded to for display: a cost per click of 1/3
 * times 3 is 1, not 0.999999999. Round the result once, on output, with roundReportValue (F-L5-20).
 */
export function evaluateReportFormulaExact(formula: string, values: JsonObject, exact: ExactValues): Rational | null {
  checkBudget();
  return evaluate(parsed(formula), values, exact);
}
/** The single rounding of a calculation: nine places, half to even. */
export const roundReportValue = (value: Rational | null) => retained(value);
function retained(value: Rational | null) {
  if (!value) return {value: null, rounded: false};
  const negative = value.n < 0n,
    numerator = (negative ? -value.n : value.n) * scale,
    quotient = numerator / value.d,
    remainder = numerator % value.d,
    up = remainder * 2n > value.d || (remainder * 2n === value.d && quotient % 2n === 1n),
    scaled = (quotient + (up ? 1n : 0n)) * (negative ? -1n : 1n);
  return {value: reportScaledText(scaled), rounded: remainder !== 0n};
}
/** The caller declares additivity and units; unknown retained cells carry coverage instead of becoming zero. */
export function sumReportValuesV4(values: unknown[]) {
  let sum: Rational | null = null,
    known = 0;
  for (const value of values) {
    const current = decimal(value);
    if (!current) continue;
    known++;
    if (sum) {
      checkSize('+', sum, current);
      sum = fraction(sum.n * current.d + current.n * sum.d, sum.d * current.d);
    } else sum = current;
  }
  return {...retained(sum), coverage: {known_rows: known, total_rows: values.length}};
}
/**
 * The counts of a coverage object that was stored, whichever build wrote it. Builds before F-L5-31 wrote `known` and
 * `total` for a sum, `known_rows` and `total` for a formula and `known_pairs` and `total` for the cost per result; the
 * shape is now `known_rows` and `total_rows` for all of them
 * (docs/REPORTING-OVERVIEW.md). Code that reads a stored snapshot reads it here; code that reads a row it has just
 * calculated reads the new names.
 */
export function coverageCounts(coverage: JsonObject): {known: number; total: number} {
  return {
    known: coverage.known_rows ?? coverage.known_pairs ?? coverage.known,
    total: coverage.total_rows ?? coverage.total,
  };
}
/** Compare a with b * factor without binary floating-point thresholds. Unknown comparisons never become true. */
export function compareReportValuesV4(a: unknown, b: unknown, factor: unknown = 1): number {
  const left = decimal(a),
    right = decimal(b),
    multiplier = decimal(factor);
  if (!left || !right || !multiplier) return Number.NaN;
  const x = left.n * right.d * multiplier.d,
    y = right.n * multiplier.n * left.d;
  return x < y ? -1 : x > y ? 1 : 0;
}
/**
 * Standard and custom row formulas, retaining exact additive inputs and unknowns. No native provider facts. A metric
 * that depends on another uses its exact value and the row rounds each once, on output. A metric that reaches a
 * calculation bound is null and named in `limited`, as is a metric that depends on it.
 */
export function calculateMetricsV4(metrics: JsonObject, custom: JsonObject[] = []) {
  const values = {...metrics},
    rounding: Record<string, number> = {},
    limited: Record<string, 'calculation_limit'> = {},
    exact: ExactValues = new Map();
  for (const [id, definition] of [
    ...Object.entries(metricDefinitions),
    ...custom.map(metric => [metric.id, metric] as [string, JsonObject]),
  ]) {
    if (!definition.formula) continue;
    try {
      const value = evaluateReportFormulaExact(definition.formula, values, exact),
        result = roundReportValue(value);
      exact.set(id, value);
      values[id] = result.value;
      if (result.rounded) rounding[id] = 1;
      if (value === null && formulaDependencies(definition.formula).some(name => limited[name]))
        limited[id] = 'calculation_limit';
    } catch (error) {
      if (!isCalculationLimit(error)) throw error;
      exact.set(id, null);
      values[id] = null;
      limited[id] = 'calculation_limit';
    }
  }
  return {metrics: values, rounding, limited};
}
