import {MirrorError} from './errors.js';
import {providerDecimalText} from './provider-decimal.js';
import {metricDefinitions, parseMetricFormula} from './report-metrics.js';
import type {JsonObject} from './types.js';

const scale = 1000000000n;
type Rational = {n: bigint; d: bigint};
type Tree = ReturnType<typeof parseMetricFormula>['tree'];
const trees = new Map<string, Tree>();
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
  const factor = gcd(n, d),
    sign = d < 0n ? -1n : 1n;
  const value = {n: (n / factor) * sign, d: (d / factor) * sign};
  if (value.n.toString().length > 4096 || value.d.toString().length > 4096)
    throw new MirrorError('METRIC_PRECISION_LOSS', 'The calculated metric exceeds the report precision limit.');
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
function evaluate(tree: Tree, values: JsonObject): Rational | null {
  if (tree.kind === 'value') return decimal(tree.value);
  if (tree.kind === 'field') return decimal(values[tree.name]);
  if (tree.kind === 'unary') {
    const value = evaluate(tree.value, values);
    return value ? {...value, n: -value.n} : null;
  }
  const a = evaluate(tree.left, values),
    b = evaluate(tree.right, values);
  if (!a || !b) return null;
  if (tree.op === '+') return fraction(a.n * b.d + b.n * a.d, a.d * b.d);
  if (tree.op === '-') return fraction(a.n * b.d - b.n * a.d, a.d * b.d);
  if (tree.op === '*') return fraction(a.n * b.n, a.d * b.d);
  return b.n === 0n ? null : fraction(a.n * b.d, a.d * b.n);
}
export function reportScaledText(value: bigint): string {
  const negative = value < 0n,
    magnitude = negative ? -value : value,
    fraction = (magnitude % scale).toString().padStart(9, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + (magnitude / scale).toString() + (fraction ? '.' + fraction : '');
}
/** Keep the rational expression exact between operations; round only its final value, half to even, to nine places. */
export function evaluateReportFormulaV4(formula: string, values: JsonObject) {
  let tree = trees.get(formula);
  if (!tree) {
    tree = parseMetricFormula(formula).tree;
    if (trees.size >= 1000) trees.clear();
    trees.set(formula, tree);
  }
  return retained(evaluate(tree, values));
}
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
    sum = sum ? fraction(sum.n * current.d + current.n * sum.d, sum.d * current.d) : current;
  }
  return {...retained(sum), coverage: {known, total: values.length}};
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
/** Standard and custom row formulas, retaining exact additive inputs and unknowns. No native provider facts. */
export function calculateMetricsV4(metrics: JsonObject, custom: JsonObject[] = []) {
  const values = {...metrics},
    rounding: Record<string, number> = {};
  for (const [id, definition] of [
    ...Object.entries(metricDefinitions),
    ...custom.map(metric => [metric.id, metric] as [string, JsonObject]),
  ]) {
    if (!definition.formula) continue;
    const result = evaluateReportFormulaV4(definition.formula, values);
    values[id] = result.value;
    if (result.rounded) rounding[id] = 1;
  }
  return {metrics: values, rounding};
}
