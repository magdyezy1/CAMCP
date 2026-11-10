import type {ChartSpec} from './report-chart-spec.js';

/**
 * The geometry of a chart (V2-EXP-01), computed once from its spec and a width, as a flat list of marks with coordinates.
 * The SVG string, the PDF and the page all draw this scene, so they agree on where a bar ends, which labels fit and which
 * colour a mark has; the page keeps a port of this file (web/charts.js) and tests/report-chart-parity.test.mjs fails on any
 * drift between them. `Number()` appears here and only here, for pixels: every value a reader reads is text made by the spec.
 *
 * Positions are physical (x grows to the right), so a renderer never has to know about right-to-left layout: the scene of an
 * Arabic report is already mirrored. A text mark says which of its edges sits at x (`anchor`) and, separately, the direction
 * its own letters run (`rtl`, true only for an Arabic report's text that has Arabic letters); a renderer that draws in
 * logical terms (SVG `text-anchor`) maps `left` to the end of an rtl text and `right` to its start.
 */

/** The hue of a mark: 0, 1 or 2 of the three data hues, or null for the neutral "Other". */
export type SceneHue = 0 | 1 | 2 | null;
type Physical = 'left' | 'center' | 'right';
export interface LayoutOptions {
  width: number;
  language: 'en' | 'ar';
  /** Says a name AMCP wrote ("Other", "Sales", "No data") in the report's language. */
  t: (english: string) => string;
}
/** `s` is the series of a mark and `i` its entry (a bar, a period), as indexes into the spec. */
export type SceneItem =
  | {
      t: 'rect';
      role: 'bar' | 'segment' | 'legend-swatch';
      x: number;
      y: number;
      w: number;
      h: number;
      /** The end that is rounded, if any: the data end of a bar, square at the baseline. */
      round: 'left' | 'right' | null;
      s: number;
      i?: number;
      color: SceneHue;
    }
  | {
      t: 'line';
      role: 'axis' | 'grid' | 'target' | 'legend-target';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      i?: number;
    }
  | {t: 'polyline'; role: 'line'; points: [number, number][]; s: number; color: SceneHue}
  | {t: 'circle'; role: 'point' | 'hollow'; cx: number; cy: number; r: number; s: number; i: number; color: SceneHue}
  | {
      t: 'text';
      role:
        | 'label'
        | 'value'
        | 'tick'
        | 'nodata'
        | 'inside'
        | 'total'
        | 'legend-text'
        | 'kpi-label'
        | 'kpi-value'
        | 'kpi-unit'
        | 'kpi-change'
        | 'kpi-caption';
      x: number;
      y: number;
      text: string;
      anchor: Physical;
      size: number;
      bold?: true;
      rtl: boolean;
      s?: number;
      i?: number;
      /** A label inside a segment: the hue it sits on, which decides its ink. */
      color?: SceneHue;
    };
export interface Scene {
  width: number;
  height: number;
  rtl: boolean;
  items: SceneItem[];
}

// Sizes, in pixels. Text is never below 12.
const FS = 12,
  PAD = 4,
  BAR = 14,
  STACK = 18,
  ROW = 44,
  AXIS = 28,
  LEGEND_ROW = 22,
  POINT = 4,
  INSET = 8,
  GAP = 8,
  LINE = 16,
  // The height of a tile: 20px below its last baseline, which is the currency line (56) or, with a change, the last line of
  // its words (72 for the first, a line more for each other).
  TILE = 76,
  TILE_CHANGE = 92,
  KPI_SIZES = [22, 20, 18, 16, 14, 12];
/** The radius of the rounded data end of a bar: 4px. A bar too short to hold two of them stays square. */
export const chartBarRadius = 4;
const r2 = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * One estimate of a text's width, used by every renderer so that they place and cut labels the same way. It errs on the
 * wide side (a label may leave a little air; it must never leave the chart).
 */
export function chartTextWidth(text: string, size: number): number {
  let em = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    em +=
      code >= 0x30 && code <= 0x39
        ? 0.6
        : code >= 0x41 && code <= 0x5a
          ? 0.7
          : code >= 0x61 && code <= 0x7a
            ? 0.56
            : code === 0x20
              ? 0.3
              : code < 0x80
                ? 0.36
                : code >= 0x600 && code <= 0x6ff
                  ? 0.6
                  : code >= 0x2e80
                    ? 1
                    : 0.72;
  }
  return r2(em * size);
}
/** A text cut with an ellipsis to fit `max` pixels: it is never clipped by its own box. */
export function fitChartText(text: string, max: number, size: number): string {
  if (chartTextWidth(text, size) <= max) return text;
  const letters = [...text];
  while (letters.length && chartTextWidth(letters.join('') + '…', size) > max) letters.pop();
  return letters.join('').trimEnd() + '…';
}
/**
 * A text broken at its spaces into at most `lines` lines that each fit `max` pixels. When it needs more, the last line takes
 * the rest and is cut with an ellipsis; a single word wider than the room is cut too, so no line leaves its box.
 */
export function wrapChartText(content: string, max: number, size: number, lines: number): string[] {
  const broken: string[] = [];
  let current = '';
  for (const word of content.split(/\s+/).filter(Boolean)) {
    const next = current ? current + ' ' + word : word;
    if (chartTextWidth(next, size) <= max) current = next;
    else {
      if (current) broken.push(current);
      current = word;
    }
  }
  if (current) broken.push(current);
  if (broken.length <= lines) return broken.map(line => fitChartText(line, max, size));
  return [...broken.slice(0, lines - 1), fitChartText(broken.slice(lines - 1).join(' '), max, size)];
}
/** The largest size that holds a figure whole: a number is made smaller, never cut. Below the smallest it is cut at last. */
function fitFigure(content: string, max: number): {text: string; size: number} {
  for (const size of KPI_SIZES) if (chartTextWidth(content, size) <= max) return {text: content, size};
  const size = KPI_SIZES.at(-1)!;
  return {text: fitChartText(content, max, size), size};
}

const months = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
};
/** An ISO day as month and day (and the year when a series spans years): Latin digits in both languages (D27). */
export function chartDateLabel(iso: string, language: 'en' | 'ar', withYear: boolean): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return iso;
  const month = months[language][Number(match[2]) - 1]!,
    day = String(Number(match[3]));
  return language === 'ar'
    ? `${day} ${month}${withYear ? ' ' + match[1] : ''}`
    : `${month} ${day}${withYear ? ', ' + match[1] : ''}`;
}

const arabicLetters = /[؀-ۿ]/;
const ratio = (value: string, max: string) => {
  const part = Number(value) / Number(max);
  return Number.isFinite(part) ? clamp(part, 0, 1) : 0;
};
type TextItem = Extract<SceneItem, {t: 'text'}>;
function text(
  o: LayoutOptions,
  role: TextItem['role'],
  x: number,
  y: number,
  content: string,
  anchor: Physical,
  extra: {size?: number; bold?: true; s?: number; i?: number; color?: SceneHue} = {},
): TextItem {
  return {
    t: 'text',
    role,
    x: r2(x),
    y: r2(y),
    text: content,
    anchor,
    size: extra.size ?? FS,
    ...(extra.bold ? {bold: true as const} : {}),
    rtl: o.language === 'ar' && arabicLetters.test(content),
    ...(extra.s === undefined ? {} : {s: extra.s}),
    ...(extra.i === undefined ? {} : {i: extra.i}),
    ...(extra.color === undefined ? {} : {color: extra.color}),
  };
}
const line = (
  role: 'axis' | 'grid' | 'target' | 'legend-target',
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  i?: number,
): SceneItem => ({
  t: 'line',
  role,
  x1: r2(x1),
  y1: r2(y1),
  x2: r2(x2),
  y2: r2(y2),
  ...(i === undefined ? {} : {i}),
});

/**
 * The tick labels that fit: the first, then each that clears the last kept by a gap; the last tick takes the place of the
 * one before it when it crowds that one, so the end of the axis is always named.
 */
function visibleTicks(ticks: {x: number; text: string}[], width: number): {x: number; text: string}[] {
  const half = (tick: {text: string}) => chartTextWidth(tick.text, FS) / 2,
    left = (tick: {x: number; text: string}) => clamp(tick.x, PAD + half(tick), width - PAD - half(tick)) - half(tick),
    right = (tick: {x: number; text: string}) => left(tick) + half(tick) * 2;
  const chosen: typeof ticks = [];
  ticks.forEach((tick, index) => {
    const last = chosen.at(-1);
    if (!last || left(tick) >= right(last) + GAP) chosen.push(tick);
    else if (index === ticks.length - 1 && chosen.length > 1 && left(tick) >= right(chosen.at(-2)!) + GAP)
      chosen[chosen.length - 1] = tick;
  });
  return chosen;
}
function tickLabels(o: LayoutOptions, ticks: {x: number; text: string}[], y: number, width: number): SceneItem[] {
  return visibleTicks(ticks, width).map(tick => {
    const half = chartTextWidth(tick.text, FS) / 2;
    return text(o, 'tick', clamp(tick.x, PAD + half, width - PAD - half), y, tick.text, 'center');
  });
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
/** Whether the line from p to q passes through the box (grown by a 2px stroke): clipped to the box, then compared. */
function crosses(p: [number, number], q: [number, number], box: Box): boolean {
  let enter = 0,
    leave = 1;
  const dx = q[0] - p[0],
    dy = q[1] - p[1];
  for (const [direction, distance] of [
    [-dx, p[0] - (box.left - 2)],
    [dx, box.right + 2 - p[0]],
    [-dy, p[1] - (box.top - 2)],
    [dy, box.bottom + 2 - p[1]],
  ] as const) {
    if (direction === 0) {
      if (distance < 0) return false;
    } else {
      const along = distance / direction;
      if (direction < 0) enter = Math.max(enter, along);
      else leave = Math.min(leave, along);
      if (enter > leave) return false;
    }
  }
  return true;
}

/** Mirrors every mark about the middle: the layout of a right-to-left page, for charts whose horizontal axis is a value. */
function mirror(items: SceneItem[], width: number): SceneItem[] {
  const flip = (x: number) => r2(width - x),
    side = (round: 'left' | 'right' | null) => (round === 'right' ? 'left' : round === 'left' ? 'right' : null);
  return items.map((item): SceneItem => {
    if (item.t === 'rect') return {...item, x: flip(item.x + item.w), round: side(item.round)};
    if (item.t === 'line') return {...item, x1: flip(item.x1), x2: flip(item.x2)};
    if (item.t === 'circle') return {...item, cx: flip(item.cx)};
    if (item.t === 'polyline') return {...item, points: item.points.map(([x, y]) => [flip(x), y] as [number, number])};
    return {
      ...item,
      x: flip(item.x),
      anchor: item.anchor === 'left' ? 'right' : item.anchor === 'right' ? 'left' : 'center',
    };
  });
}

/** One entry for each series, in series order, wrapping to more rows when the width is short. */
function legend(spec: ChartSpec, o: LayoutOptions, y: number): {items: SceneItem[]; height: number} {
  const items: SceneItem[] = [];
  let x = PAD,
    row = 0;
  spec.series.forEach((series, s) => {
    const label = fitChartText(
        series.name_kind === 'label' ? o.t(series.name) : series.name,
        o.width - 2 * PAD - 16,
        FS,
      ),
      room = 10 + 6 + chartTextWidth(label, FS) + 16;
    if (x + room > o.width - PAD && x > PAD) {
      x = PAD;
      row++;
    }
    const top = y + row * LEGEND_ROW;
    items.push({
      t: 'rect',
      role: 'legend-swatch',
      x: r2(x),
      y: r2(top + 3),
      w: 10,
      h: 10,
      round: null,
      s,
      color: series.color_index,
    });
    items.push(text(o, 'legend-text', x + 16, top + 13, label, 'left', {s}));
    x += room;
  });
  return {items, height: (row + 1) * LEGEND_ROW};
}

/** The grid of a value axis along the bottom: the baseline at the left edge of the plot, a hairline at each tick. */
function valueAxis(
  o: LayoutOptions,
  scale: NonNullable<ChartSpec['scale']>,
  px: (value: string) => number,
  x0: number,
  top: number,
  bottom: number,
) {
  const items: SceneItem[] = [line('axis', x0, top - 2, x0, bottom)];
  for (const tick of scale.ticks.slice(1)) items.push(line('grid', px(tick), top - 2, px(tick), bottom));
  items.push(
    ...tickLabels(
      o,
      scale.ticks.map((tick, index) => ({x: px(tick), text: scale.tick_labels[index]!})),
      bottom + 16,
      o.width,
    ),
  );
  return items;
}

/** Ranked bars: each row has its name above a bar that starts at the baseline, the value at its tip and a target mark if it has one. */
function bars(spec: ChartSpec, o: LayoutOptions): Scene {
  const x = spec.x!,
    series = spec.series[0]!,
    count = x.items.length,
    hasTarget = !!series.targets?.some(Boolean),
    room = Math.max(0, ...series.value_labels.map(label => chartTextWidth(label ?? o.t('No data'), FS))) + 8,
    x0 = PAD,
    x1 = Math.max(x0 + 40, o.width - PAD - room),
    scale = spec.scale!,
    px = (value: string) => x0 + (x1 - x0) * ratio(value, scale.max),
    items: SceneItem[] = [];
  let top = PAD;
  if (hasTarget) {
    items.push(line('legend-target', x0 + 4, top + 4, x0 + 4, top + 16));
    items.push(text(o, 'legend-text', x0 + 14, top + 13, o.t('Target'), 'left'));
    top += LEGEND_ROW;
  }
  const bottom = top + (count - 1) * ROW + 18 + BAR;
  x.items.forEach((item, index) => {
    const rowTop = top + index * ROW,
      y = rowTop + 18,
      value = series.values[index]!;
    items.push(
      text(
        o,
        'label',
        x0,
        rowTop + 12,
        fitChartText(item.other ? o.t('Other') : item.label, o.width - 2 * PAD, FS),
        'left',
        {
          i: index,
        },
      ),
    );
    if (value === null) {
      items.push(text(o, 'nodata', x0 + 6, y + BAR / 2 + 4, o.t('No data'), 'left', {i: index}));
      return;
    }
    const end = px(value),
      width = r2(end - x0);
    if (width > 0)
      items.push({
        t: 'rect',
        role: 'bar',
        x: r2(x0),
        y: r2(y),
        w: Math.max(width, 1),
        h: BAR,
        round: width >= 2 * chartBarRadius ? 'right' : null,
        s: 0,
        i: index,
        color: item.other ? null : series.color_index,
      });
    const target = series.targets?.[index];
    if (series.label_at.includes(index)) {
      // Beside the end of the bar, or, when the target mark of this bar would cross it, beyond that mark.
      const label = series.value_labels[index] ?? '',
        targetAt = target ? px(target) : null;
      let at = end + 6;
      if (targetAt !== null && targetAt > at - 2 && targetAt < at + chartTextWidth(label, FS) + 2) at = targetAt + 6;
      items.push(text(o, 'value', at, y + BAR / 2 + 4, label, 'left', {s: 0, i: index}));
    }
    if (target) items.push(line('target', px(target), y - 3, px(target), y + BAR + 3, index));
  });
  items.push(...valueAxis(o, scale, px, x0, top, bottom));
  return {width: o.width, height: r2(bottom + AXIS), rtl: false, items};
}

/** A stack for each category: segments from the baseline in series order, 2px apart, labelled inside when the label fits. */
function stacks(spec: ChartSpec, o: LayoutOptions): Scene {
  const x = spec.x!,
    count = x.items.length,
    room = Math.max(0, ...x.items.map(item => chartTextWidth(item.total_label ?? '', FS))) + 8,
    x0 = PAD,
    x1 = Math.max(x0 + 40, o.width - PAD - room),
    scale = spec.scale!,
    px = (value: string) => x0 + (x1 - x0) * ratio(value, scale.max),
    key = legend(spec, o, PAD),
    items: SceneItem[] = [...key.items],
    top = PAD + key.height + 4,
    bottom = top + (count - 1) * ROW + 18 + STACK;
  x.items.forEach((item, index) => {
    const rowTop = top + index * ROW,
      y = rowTop + 18;
    items.push(text(o, 'label', x0, rowTop + 12, fitChartText(item.label, o.width - 2 * PAD, FS), 'left', {i: index}));
    // The stack: each known value takes its share of the scale after the one before it.
    let start = 0;
    const parts = spec.series.map((series, s) => {
      const value = series.values[index];
      if (value === null || value === undefined) return null;
      const begin = start,
        end = start + (x1 - x0) * ratio(value, scale.max);
      start = end;
      return end > begin ? {s, begin, end} : null;
    });
    const shown = parts.filter(part => part !== null);
    shown.forEach((part, order) => {
      const left = x0 + part.begin + (order > 0 ? 1 : 0),
        right = x0 + part.end - (order < shown.length - 1 ? 1 : 0),
        width = r2(right - left);
      if (width <= 0) return;
      const series = spec.series[part.s]!;
      items.push({
        t: 'rect',
        role: 'segment',
        x: r2(left),
        y: r2(y),
        w: width,
        h: STACK,
        round: order === shown.length - 1 && width >= 2 * chartBarRadius ? 'right' : null,
        s: part.s,
        i: index,
        color: series.color_index,
      });
      const label = series.value_labels[index] ?? '';
      if (label && series.label_at.includes(index) && chartTextWidth(label, FS) + 12 <= width)
        items.push(
          text(o, 'inside', left + width / 2, y + STACK / 2 + 4, label, 'center', {
            s: part.s,
            i: index,
            color: series.color_index,
          }),
        );
    });
    if (item.total_label)
      items.push(text(o, 'total', x0 + start + 6, y + STACK / 2 + 4, item.total_label, 'left', {i: index}));
  });
  items.push(...valueAxis(o, scale, px, x0, top, bottom));
  return {width: o.width, height: r2(bottom + AXIS), rtl: false, items};
}

/** A line over periods: time runs left to right in both languages, the value axis is on the start side. */
function lines(spec: ChartSpec, o: LayoutOptions): Scene {
  const x = spec.x!,
    series = spec.series[0]!,
    scale = spec.scale!,
    count = x.items.length,
    rtl = o.language === 'ar',
    axisWidth = Math.max(...scale.tick_labels.map(label => chartTextWidth(label, FS))) + 8,
    plotLeft = rtl ? PAD + 8 : PAD + axisWidth + 4,
    plotRight = rtl ? o.width - PAD - axisWidth - 4 : o.width - PAD - 8,
    plotTop = 22,
    plotHeight = Math.round(clamp(o.width * 0.38, 130, 210)),
    plotBottom = plotTop + plotHeight,
    // The first and last periods sit a little inside the plot, so their marks never touch the value axis or the edge.
    px = (index: number) =>
      plotLeft +
      (count === 1 ? (plotRight - plotLeft) / 2 : INSET + ((plotRight - plotLeft - 2 * INSET) * index) / (count - 1)),
    py = (value: string) => plotBottom - plotHeight * ratio(value, scale.max),
    items: SceneItem[] = [];
  scale.ticks.forEach((tick, index) => {
    items.push(line(index === 0 ? 'axis' : 'grid', plotLeft, py(tick), plotRight, py(tick)));
    items.push(
      text(
        o,
        'tick',
        rtl ? plotRight + 6 : plotLeft - 6,
        py(tick) + 4,
        scale.tick_labels[index]!,
        rtl ? 'left' : 'right',
      ),
    );
  });
  // The line joins consecutive whole points; a short point is a hollow mark off the line; a gap is a gap.
  let segment: [number, number][] = [];
  const joined: [number, number][][] = [];
  const flush = () => {
    if (segment.length > 1) {
      items.push({t: 'polyline', role: 'line', points: segment, s: 0, color: series.color_index});
      joined.push(segment);
    }
    segment = [];
  };
  series.values.forEach((value, index) => {
    if (value === null) return flush();
    const cx = r2(px(index)),
      cy = r2(py(value));
    if (series.short?.[index]) {
      flush();
      items.push({t: 'circle', role: 'hollow', cx, cy, r: POINT, s: 0, i: index, color: series.color_index});
      return;
    }
    segment.push([cx, cy]);
    items.push({t: 'circle', role: 'point', cx, cy, r: POINT, s: 0, i: index, color: series.color_index});
  });
  flush();
  // Direct labels: inside the plot (so a label at either end never reaches the numbers of the value axis), above the point
  // or, where the line comes down to it, below, and never on the line, on another label or on the axis. A label with no such
  // place is left out: the title of its mark and the table still have the value.
  const taken: Box[] = [];
  for (const index of series.label_at) {
    const label = series.value_labels[index];
    if (label === null || label === undefined) continue;
    const half = chartTextWidth(label, FS) / 2,
      cx = clamp(px(index), plotLeft + half, plotRight - half),
      cy = py(series.values[index]!);
    for (const offset of [-10, 18]) {
      const box = {left: cx - half, right: cx + half, top: cy + offset - FS, bottom: cy + offset + 3};
      if (
        box.top < 0 ||
        box.bottom > plotBottom - 2 ||
        joined.some(points => points.slice(1).some((point, k) => crosses(points[k]!, point, box))) ||
        taken.some(
          other =>
            other.left < box.right + 2 &&
            box.left < other.right + 2 &&
            other.top < box.bottom &&
            box.top < other.bottom,
        )
      )
        continue;
      taken.push(box);
      items.push(text(o, 'value', cx, cy + offset, label, 'center', {s: 0, i: index}));
      break;
    }
  }
  const withYear = x.items[0]!.key.slice(0, 4) !== x.items.at(-1)!.key.slice(0, 4),
    dates = x.items.map((item, index) => ({x: px(index), text: chartDateLabel(item.label, o.language, withYear)}));
  items.push(...tickLabels(o, dates, plotBottom + 18, o.width));
  return {width: o.width, height: r2(plotBottom + AXIS), rtl, items};
}

/** Key figures as a grid of tiles: the name, the value and its currency, the change in words, in the language of the page. */
function tiles(spec: ChartSpec, o: LayoutOptions): Scene {
  const rtl = o.language === 'ar',
    columns = o.width >= 600 ? 5 : o.width >= 420 ? 3 : 2,
    cell = (o.width - 2 * PAD - (columns - 1) * GAP) / columns,
    side: Physical = rtl ? 'right' : 'left',
    items: SceneItem[] = [];
  // The change and its caption are words: each is broken into at most two lines that fit the tile, never cut short. Every
  // tile is as tall as the one with the most lines, so the rows of the grid line up.
  const caption = wrapChartText(o.t('Since the previous period'), cell, FS, 2),
    changeOf = (series: ChartSpec['series'][number]) =>
      series.change
        ? wrapChartText(
            series.change.percent_label
              ? `${series.change.delta_label} (${series.change.percent_label})`
              : series.change.delta_label,
            cell,
            FS,
            2,
          )
        : [],
    extra = Math.max(0, ...spec.series.map(series => (series.change ? changeOf(series).length + caption.length : 0))),
    height = extra ? TILE_CHANGE + LINE * (extra - 1) : TILE;
  spec.series.forEach((series, s) => {
    const left = PAD + (s % columns) * (cell + GAP),
      top = PAD + Math.floor(s / columns) * height,
      at = rtl ? o.width - left : left,
      figure = fitFigure(series.value_labels[0] ?? o.t('No data'), cell);
    items.push(
      text(
        o,
        'kpi-label',
        at,
        top + 14,
        fitChartText(series.name_kind === 'label' ? o.t(series.name) : series.name, cell, FS),
        side,
        {s},
      ),
    );
    items.push(text(o, 'kpi-value', at, top + 40, figure.text, side, {size: figure.size, bold: true, s}));
    if (series.value_labels[0] && series.unit === 'currency' && series.currency)
      items.push(text(o, 'kpi-unit', at, top + 56, series.currency, side, {s}));
    if (series.change) {
      const words = changeOf(series);
      words.forEach((line, index) => items.push(text(o, 'kpi-change', at, top + 72 + LINE * index, line, side, {s})));
      caption.forEach((line, index) =>
        items.push(text(o, 'kpi-caption', at, top + 72 + LINE * (words.length + index), line, side, {s})),
      );
    }
  });
  return {width: o.width, height: r2(PAD + Math.ceil(spec.series.length / columns) * height), rtl, items};
}

/** The scene of a chart that is drawn, or null for one that is not (its notes and its table say why). */
export function chartLayout(spec: ChartSpec, options: LayoutOptions): Scene | null {
  if (!spec.drawn) return null;
  if (spec.type === 'kpi') return tiles(spec, options);
  if (!spec.x || !spec.scale || !spec.series.length) return null;
  if (spec.type === 'line') return lines(spec, options);
  const scene = spec.type === 'stacked_bar' ? stacks(spec, options) : bars(spec, options);
  return options.language === 'ar' ? {...scene, rtl: true, items: mirror(scene.items, scene.width)} : scene;
}
