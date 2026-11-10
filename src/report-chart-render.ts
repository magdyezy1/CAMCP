import {
  chartBarPath,
  chartLayout,
  chartTexture,
  sceneInDrawingOrder,
  type SceneHue,
  type SceneItem,
} from './report-chart-layout.js';
import type {ChartSpec} from './report-chart-spec.js';
import {
  chartMessageText,
  chartNoteText,
  chartPalette,
  chartSeriesName,
  escapeChartText,
  chartTextInk,
  hueColor,
  type ChartColors,
  type ChartLocale,
  type ChartTheme,
} from './report-chart-theme.js';

/**
 * The SVG back end (V2-EXP-01): draws the scene of src/report-chart-layout.ts as a string, with the colours of one theme, the
 * words of one language, and no script, style sheet or link: it is a picture that can be saved, embedded in an HTML report or
 * attached, and it draws the same thing the page and the PDF do. Every string that reaches the output, text or attribute,
 * goes through `escapeChartText`: names are provider data.
 */

export interface ChartSvgOptions {
  theme: ChartTheme;
  locale: ChartLocale;
  /** Print texture: the second hue, the third hue and Other carry a pattern, so colour is not the only encoding. */
  texture?: boolean;
  width?: number;
}
const defaultWidth = 640,
  minWidth = 240,
  maxWidth = 1600;
/** The width a chart is drawn at: a finite number between a chart that can still be read and one that is no wider than a page. */
export const chartSvgWidth = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(maxWidth, Math.max(minWidth, value)))
    : defaultWidth;
const fontFamily = 'Aptos, Segoe UI, Noto Sans Arabic, sans-serif';
const {period: stripe, stripe: stripeWidth, dot} = chartTexture;

/** A short, stable text from a chart's identity: the ids inside one SVG must not collide with another chart's on a page. */
function identity(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, 'utf8')) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(36);
}
type Attributes = Record<string, string | number | undefined>;
function element(name: string, attributes: Attributes, inner = ''): string {
  const written = Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}="${escapeChartText(value)}"`)
    .join('');
  return inner ? `<${name}${written}>${inner}</${name}>` : `<${name}${written}/>`;
}

export function chartSvg(spec: ChartSpec, options: ChartSvgOptions): string | null {
  const {locale} = options,
    colors: ChartColors = chartPalette[options.theme],
    width = chartSvgWidth(options.width),
    scene = chartLayout(spec, {width, language: locale.language, t: locale.text});
  if (!scene) return null;
  const uid = 'amcp-' + identity(spec.id + ':' + options.theme),
    texture = options.texture === true,
    fill = (hue: SceneHue) =>
      texture && hue !== 0 ? `url(#${uid}-${hue === null ? 'o' : 'h' + hue})` : hueColor(colors, hue),
    say = (english: string) => locale.text(english),
    entry = (index: number | undefined) => {
      const item = index === undefined ? undefined : spec.x?.items[index];
      return item ? (item.other ? say('Other') : item.label) : '';
    },
    value = (series: number, index: number | undefined) =>
      (index === undefined ? null : spec.series[series]?.value_labels[index]) ?? say('No data');
  /** What a mark is, for a reader who hovers it or a screen reader that reaches it. */
  const titleOf = (item: SceneItem): string | null => {
    if (item.t === 'rect' && item.role === 'bar') return `${entry(item.i)}: ${value(item.s, item.i)}`;
    if (item.t === 'rect' && item.role === 'segment')
      return `${entry(item.i)} · ${chartSeriesName(spec.series[item.s]!, locale)}: ${value(item.s, item.i)}`;
    if (item.t === 'circle') return `${entry(item.i)}: ${value(item.s, item.i)}`;
    return null;
  };
  /** A mark with its title inside it: browsers show it on hover, and a screen reader reads it. */
  const mark = (name: string, attributes: Attributes, item: SceneItem) => {
    const title = titleOf(item);
    return element(name, attributes, title === null ? '' : element('title', {}, escapeChartText(title)));
  };

  const lineStyle = (role: string): Attributes =>
    role === 'axis'
      ? {stroke: colors.axis, 'stroke-width': 1, 'shape-rendering': 'crispEdges'}
      : role === 'grid'
        ? {stroke: colors.grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges'}
        : {stroke: colors.ink, 'stroke-width': 2};
  const draw = (item: SceneItem): string => {
    switch (item.t) {
      case 'rect': {
        const geometry = {x: item.x, y: item.y, width: item.w, height: item.h};
        if (item.role === 'legend-swatch') return element('rect', {...geometry, fill: fill(item.color)});
        return item.round
          ? mark('path', {d: chartBarPath(item), fill: fill(item.color)}, item)
          : mark('rect', {...geometry, fill: fill(item.color)}, item);
      }
      case 'line':
        return element('line', {x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2, ...lineStyle(item.role)});
      case 'polyline':
        return element('polyline', {
          points: item.points.map(([x, y]) => `${x},${y}`).join(' '),
          fill: 'none',
          stroke: hueColor(colors, item.color),
          'stroke-width': 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        });
      case 'circle': {
        const hue = hueColor(colors, item.color);
        // A solid mark carries a 2px ring of the surface, so it stays whole where it crosses the line; a hollow one is
        // the ring of its hue around the surface: a short period, off the line.
        return item.role === 'point'
          ? element('circle', {cx: item.cx, cy: item.cy, r: item.r + 2, fill: colors.surface}) +
              mark('circle', {cx: item.cx, cy: item.cy, r: item.r, fill: hue}, item)
          : mark(
              'circle',
              {cx: item.cx, cy: item.cy, r: item.r, fill: colors.surface, stroke: hue, 'stroke-width': 2},
              item,
            );
      }
      case 'text': {
        const start = (item.anchor === 'left') !== item.rtl;
        // A label inside a patterned fill has a halo of the fill's colour, so the stripes do not run through its letters.
        const halo = texture && item.role === 'inside' && item.color !== 0;
        return element(
          'text',
          {
            x: item.x,
            y: item.y,
            'text-anchor': item.anchor === 'center' ? 'middle' : start ? 'start' : 'end',
            'font-size': item.size,
            'font-weight': item.bold ? 700 : undefined,
            fill: chartTextInk(colors, item),
            direction: item.rtl ? 'rtl' : undefined,
            'unicode-bidi': item.rtl ? 'embed' : undefined,
            stroke: halo ? hueColor(colors, item.color ?? null) : undefined,
            'stroke-width': halo ? 3 : undefined,
            'stroke-linejoin': halo ? 'round' : undefined,
            'paint-order': halo ? 'stroke' : undefined,
          },
          escapeChartText(item.text),
        );
      }
    }
  };
  const notes = [
    spec.takeaway ? chartMessageText(spec.takeaway, locale) : null,
    ...spec.notes.map(note => chartNoteText(note, locale)),
  ].filter((text): text is string => text !== null);
  const definitions = texture
    ? element(
        'defs',
        {},
        [
          [1, 45],
          [2, -45],
        ]
          .map(([hue, angle]) =>
            element(
              'pattern',
              {
                id: `${uid}-h${hue}`,
                width: stripe,
                height: stripe,
                patternUnits: 'userSpaceOnUse',
                patternTransform: `rotate(${angle})`,
              },
              element('rect', {width: stripe, height: stripe, fill: colors.hues[hue as 1 | 2]}) +
                element('rect', {width: stripeWidth, height: stripe, fill: colors.surface}),
            ),
          )
          .concat(
            element(
              'pattern',
              {id: `${uid}-o`, width: stripe, height: stripe, patternUnits: 'userSpaceOnUse'},
              element('rect', {width: stripe, height: stripe, fill: colors.other}) +
                element('circle', {cx: stripe / 2, cy: stripe / 2, r: dot, fill: colors.surface}),
            ),
          )
          .join(''),
      )
    : null;
  return (
    element(
      'svg',
      {
        xmlns: 'http://www.w3.org/2000/svg',
        viewBox: `0 0 ${width} ${scene.height}`,
        width,
        height: scene.height,
        role: 'img',
        'aria-labelledby': `${uid}-t ${uid}-d`,
        lang: locale.language,
        // The marks are placed physically (x grows to the right): the picture does not inherit the direction of a
        // right-to-left page it is embedded in, which would turn every text-anchor around. A text that reads right to
        // left says so itself.
        direction: 'ltr',
        'font-family': fontFamily,
      },
      '\n' +
        [
          element('title', {id: `${uid}-t`}, escapeChartText(chartMessageText(spec.title, locale))),
          element('desc', {id: `${uid}-d`}, escapeChartText(notes.join(' '))),
          definitions,
          element('rect', {width, height: scene.height, fill: colors.surface}),
          ...sceneInDrawingOrder(scene).map(draw),
        ]
          .filter(part => part !== null)
          .join('\n') +
        '\n',
    ) + '\n'
  );
}
