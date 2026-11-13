/**
 * The arithmetic every chart renderer shares (V2-EXP-01). A chart's scale, its tick labels and a share are computed here,
 * once, on the server, in exact decimal text: BigInt units, never a binary double, so a label a reader sees is never a
 * floating-point artefact ("0.30000000000000004") and the SVG, PDF and DOM renderers cannot disagree about them.
 * `Number()` is for pixel geometry only, and only in the renderers.
 */

/** A decimal as a whole number of 10^-places: 12.50 is {units: 1250n, places: 2}. */
export interface ChartDecimal {
  units: bigint;
  places: number;
}
/** A scale that starts at zero. `ticks` are exact decimal text; `tick_labels` the same values for a reader. */
export interface ChartScale {
  min: string;
  max: string;
  ticks: string[];
  tick_labels: string[];
}

const maxTextLength = 400;
/**
 * A plain decimal (an optional minus, digits, an optional fraction) or a finite number written without an exponent. Anything
 * else (an exponent, NaN, grouping commas, an empty string) is not a value: it is unknown, never zero.
 */
export function parseChartDecimal(value: unknown): ChartDecimal | null {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === 'string') text = value;
  else return null;
  if (text.length > maxTextLength) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[3] ?? '';
  return {units: BigInt(match[1]! + match[2]! + fraction), places: fraction.length};
}

const pow10 = (n: number) => 10n ** BigInt(n);
/** -1, 0 or 1, exactly, whatever the number of places of each. */
export function compareChartDecimals(a: ChartDecimal, b: ChartDecimal): -1 | 0 | 1 {
  const places = Math.max(a.places, b.places),
    x = a.units * pow10(places - a.places),
    y = b.units * pow10(places - b.places);
  return x < y ? -1 : x > y ? 1 : 0;
}
/** The shortest plain text of a decimal: no trailing zeros, no exponent. */
export function chartDecimalText(value: ChartDecimal): string {
  const negative = value.units < 0n,
    digits = (negative ? -value.units : value.units).toString().padStart(value.places + 1, '0'),
    whole = digits.slice(0, digits.length - value.places),
    fraction = digits.slice(digits.length - value.places).replace(/0+$/, '');
  return (negative && (whole !== '0' || fraction) ? '-' : '') + whole + (fraction ? '.' + fraction : '');
}
/** Thousands grouped with commas, Latin digits in every language (owner decision D27). */
const grouped = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** A decimal text as a reader sees it: grouped thousands, its own fraction without trailing zeros. */
export function formatChartNumber(text: string): string {
  const value = parseChartDecimal(text);
  if (!value) return String(text);
  const plain = chartDecimalText(value),
    negative = plain.startsWith('-'),
    [whole = '0', fraction] = (negative ? plain.slice(1) : plain).split('.');
  return (negative ? '-' : '') + grouped(whole) + (fraction ? '.' + fraction : '');
}
/**
 * A decimal text with exactly `places` decimals, rounded half up on the exact digits (what Intl does for a positive
 * number), with grouped thousands: a currency amount in its minor units.
 */
export function formatFixed(text: string, places: number): string {
  const value = parseChartDecimal(text);
  if (!value) return String(text);
  const negative = value.units < 0n,
    magnitude = negative ? -value.units : value.units;
  let units = magnitude;
  if (value.places > places) {
    const divisor = pow10(value.places - places);
    units = magnitude / divisor + (magnitude % divisor >= divisor / 2n ? 1n : 0n);
  } else units = magnitude * pow10(places - value.places);
  const digits = units.toString().padStart(places + 1, '0'),
    whole = digits.slice(0, digits.length - places),
    fraction = digits.slice(digits.length - places);
  return (negative && units !== 0n ? '-' : '') + grouped(whole) + (places ? '.' + fraction : '');
}
/**
 * `numerator` as a percentage of `denominator`, cut and never rounded (as the website cuts a percentage), with the places
 * asked and more only where the cut would read as 0 although the share is not. Null when it cannot be said: no whole, a
 * negative part, or a share below a billionth of a percent.
 */
export function percentText(numerator: ChartDecimal, denominator: ChartDecimal, places = 1): string | null {
  if (denominator.units <= 0n || numerator.units < 0n) return null;
  if (numerator.units === 0n) return '0';
  const top = numerator.units * pow10(denominator.places) * 100n,
    bottom = denominator.units * pow10(numerator.places);
  for (let shown = places; shown <= 9; shown++) {
    const cut = (top * pow10(shown)) / bottom;
    if (cut === 0n) continue;
    return chartDecimalText({units: cut, places: shown});
  }
  return null;
}

/**
 * A scale from zero to the smallest "nice" value that holds `max`: a step of 1, 2 or 5 times a power of ten, with at most
 * `maxIntervals` steps. Every bar chart and line chart starts at zero (a truncated axis is a way to mislead). The ticks are
 * whole multiples of the step in exact decimal text.
 */
export function zeroBasedScale(max: ChartDecimal, maxIntervals = 4): ChartScale {
  if (max.units <= 0n) return {min: '0', max: '1', ticks: ['0', '1'], tick_labels: ['0', '1']};
  // Two more places than the data has, so a step may be a fraction of the finest unit it was reported in.
  const places = max.places + 2,
    scaled = max.units * 100n;
  let step = 1n,
    count = scaled;
  search: for (let power = 0; ; power++)
    for (const multiple of [1n, 2n, 5n]) {
      step = multiple * pow10(power);
      count = (scaled + step - 1n) / step;
      if (count <= BigInt(maxIntervals)) break search;
    }
  const ticks = Array.from({length: Number(count) + 1}, (_, index) =>
    chartDecimalText({units: step * BigInt(index), places}),
  );
  return {min: '0', max: ticks.at(-1)!, ticks, tick_labels: ticks.map(formatChartNumber)};
}

/** The three data hues of the palette (plan 7.1); "Other" has no index: it is the neutral. */
export type ChartColorIndex = 0 | 1 | 2;
const hues = 3;
/**
 * The home hue of a key: FNV-1a of its UTF-8 bytes. The colour follows the entity, never its rank, so a filter or a shorter
 * list cannot repaint a series that stays. The salt was chosen so the eight objective groups use all three hues.
 */
export function chartColorIndex(key: string): ChartColorIndex {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from('amcp-chart:' + key, 'utf8')) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return (hash % hues) as ChartColorIndex;
}
/**
 * The hues of up to three series shown together. A series takes its home hue; when two want the same one, the first in key
 * order keeps it and the other takes the next free hue, so two series never look alike. The order the keys arrive in does
 * not matter. A series whose home hue nobody else wants keeps it when another series is filtered away.
 */
export function assignChartColors(keys: readonly string[]): ChartColorIndex[] {
  if (keys.length > hues) throw Error('At most three series can be coloured; fold the rest into Other.');
  const taken = new Set<number>(),
    result: ChartColorIndex[] = [];
  const order = keys
    .map((key, index) => ({key, index, home: chartColorIndex(key)}))
    .sort((a, b) => a.home - b.home || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const {index, home} of order) {
    let slot = home;
    while (taken.has(slot)) slot = ((slot + 1) % hues) as ChartColorIndex;
    taken.add(slot);
    result[index] = slot as ChartColorIndex;
  }
  return result;
}
const measureColors: Readonly<Record<string, ChartColorIndex>> = {spend: 0, primary_result: 1, cost_per_result: 2};
/** A measure keeps one hue in every chart: spend is violet wherever it is drawn. */
export function chartMeasureColor(measure: string): ChartColorIndex {
  return Object.hasOwn(measureColors, measure) ? measureColors[measure]! : chartColorIndex(measure);
}
