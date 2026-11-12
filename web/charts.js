'use strict';
// V2-EXP-01: the charts of a report on the page. The server computes every chart (src/report-charts.ts) and stores it with
// the snapshot; this file only draws it: the layout is the one src/report-chart-layout.ts computes for the SVG and the PDF,
// ported line for line (tests/report-chart-parity.test.mjs feeds both the same chart and fails on any difference in a
// coordinate, a label or a colour), the words are the server's messages said through uiText, and the table is the same table
// the PDF lists. Nothing here formats a number a reader reads: values arrive as exact text and as the label the server made.
// Marks are SVG elements built with textContent and attributes (never markup from data); colours are classes read from the
// --chart-* tokens (web/charts.css), so both themes and forced colours work without a line of script.

// ----- the layout: a port of src/report-chart-layout.ts -----
const amcpChartFS = 12,
  amcpChartPAD = 4,
  amcpChartBAR = 14,
  amcpChartSTACK = 18,
  amcpChartROW = 44,
  amcpChartAXIS = 28,
  amcpChartLEGEND_ROW = 22,
  amcpChartPOINT = 4,
  amcpChartINSET = 8,
  amcpChartNAME_INSET = 6,
  amcpChartGAP = 8,
  amcpChartLINE = 16,
  amcpChartTILE = 76,
  amcpChartTILE_CHANGE = 92,
  amcpChartKPI_SIZES = [22, 20, 18, 16, 14, 12],
  amcpChartRadius = 4,
  amcpChartTexture = {period: 6, stripe: 2, dot: 1.2},
  amcpChartArabic = /\p{Script=Arabic}/u;
const amcpChartR2 = value => Math.round(value * 100) / 100;
const amcpChartClamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** One estimate of a text's width, used by every renderer so that they place and cut labels the same way (it errs wide). */
function amcpChartTextWidth(text, size) {
  let em = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
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
  return amcpChartR2(em * size);
}
function amcpChartFit(text, max, size, measure = amcpChartTextWidth) {
  if (measure(text, size) <= max) return text;
  const letters = [...text];
  while (letters.length && measure(letters.join('') + '…', size) > max) letters.pop();
  return letters.join('').trimEnd() + '…';
}
function amcpChartWrap(content, max, size, lines, measure = amcpChartTextWidth) {
  const broken = [];
  let current = '';
  for (const word of content.split(/\s+/).filter(Boolean)) {
    const next = current ? current + ' ' + word : word;
    if (measure(next, size) <= max) current = next;
    else {
      if (current) broken.push(current);
      current = word;
    }
  }
  if (current) broken.push(current);
  if (broken.length <= lines) return broken.map(line => amcpChartFit(line, max, size, measure));
  return [...broken.slice(0, lines - 1), amcpChartFit(broken.slice(lines - 1).join(' '), max, size, measure)];
}
function amcpChartFigure(content, max) {
  for (const size of amcpChartKPI_SIZES) if (amcpChartTextWidth(content, size) <= max) return {text: content, size};
  const size = amcpChartKPI_SIZES.at(-1);
  return {text: amcpChartFit(content, max, size), size};
}
const amcpChartMonths = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
};
function amcpChartDate(iso, language, withYear) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return iso;
  const month = amcpChartMonths[language][Number(match[2]) - 1],
    day = String(Number(match[3]));
  return language === 'ar'
    ? `${day} ${month}${withYear ? ' ' + match[1] : ''}`
    : `${month} ${day}${withYear ? ', ' + match[1] : ''}`;
}
const amcpChartRatio = (value, max) => {
  const part = Number(value) / Number(max);
  return Number.isFinite(part) ? amcpChartClamp(part, 0, 1) : 0;
};
function amcpChartText(o, role, x, y, content, anchor, extra = {}) {
  return {
    t: 'text',
    role,
    x: amcpChartR2(x),
    y: amcpChartR2(y),
    text: content,
    anchor,
    size: extra.size ?? amcpChartFS,
    ...(extra.bold ? {bold: true} : {}),
    rtl: o.language === 'ar' && amcpChartArabic.test(content),
    ...(extra.s === undefined ? {} : {s: extra.s}),
    ...(extra.i === undefined ? {} : {i: extra.i}),
    ...(extra.color === undefined ? {} : {color: extra.color}),
  };
}
const amcpChartLine = (role, x1, y1, x2, y2, i) => ({
  t: 'line',
  role,
  x1: amcpChartR2(x1),
  y1: amcpChartR2(y1),
  x2: amcpChartR2(x2),
  y2: amcpChartR2(y2),
  ...(i === undefined ? {} : {i}),
});
function amcpChartVisibleTicks(ticks, width) {
  const half = tick => amcpChartTextWidth(tick.text, amcpChartFS) / 2,
    left = tick => amcpChartClamp(tick.x, amcpChartPAD + half(tick), width - amcpChartPAD - half(tick)) - half(tick),
    right = tick => left(tick) + half(tick) * 2;
  const chosen = [];
  ticks.forEach((tick, index) => {
    const last = chosen.at(-1);
    if (!last || left(tick) >= right(last) + amcpChartGAP) chosen.push(tick);
    else if (index === ticks.length - 1 && chosen.length > 1 && left(tick) >= right(chosen.at(-2)) + amcpChartGAP)
      chosen[chosen.length - 1] = tick;
  });
  return chosen;
}
function amcpChartTickLabels(o, ticks, y, width) {
  return amcpChartVisibleTicks(ticks, width).map(tick => {
    const half = amcpChartTextWidth(tick.text, amcpChartFS) / 2;
    return amcpChartText(
      o,
      'tick',
      amcpChartClamp(tick.x, amcpChartPAD + half, width - amcpChartPAD - half),
      y,
      tick.text,
      'center',
    );
  });
}
function amcpChartCrosses(p, q, box) {
  let enter = 0,
    leave = 1;
  const dx = q[0] - p[0],
    dy = q[1] - p[1];
  for (const [direction, distance] of [
    [-dx, p[0] - (box.left - 2)],
    [dx, box.right + 2 - p[0]],
    [-dy, p[1] - (box.top - 2)],
    [dy, box.bottom + 2 - p[1]],
  ]) {
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
function amcpChartMirror(items, width) {
  const flip = x => amcpChartR2(width - x),
    side = round => (round === 'right' ? 'left' : round === 'left' ? 'right' : null);
  return items.map(item => {
    if (item.t === 'rect') return {...item, x: flip(item.x + item.w), round: side(item.round)};
    if (item.t === 'line') return {...item, x1: flip(item.x1), x2: flip(item.x2)};
    if (item.t === 'circle') return {...item, cx: flip(item.cx)};
    if (item.t === 'polyline') return {...item, points: item.points.map(([x, y]) => [flip(x), y])};
    return {
      ...item,
      x: flip(item.x),
      anchor: item.anchor === 'left' ? 'right' : item.anchor === 'right' ? 'left' : 'center',
    };
  });
}
function amcpChartLegend(spec, o, y) {
  const items = [];
  let x = amcpChartPAD,
    row = 0;
  spec.series.forEach((series, s) => {
    const label = amcpChartFit(
        series.name_kind === 'label' ? o.t(series.name) : series.name,
        o.width - 2 * amcpChartPAD - 16,
        amcpChartFS,
      ),
      room = 10 + 6 + amcpChartTextWidth(label, amcpChartFS) + 16;
    if (x + room > o.width - amcpChartPAD && x > amcpChartPAD) {
      x = amcpChartPAD;
      row++;
    }
    const top = y + row * amcpChartLEGEND_ROW;
    items.push({
      t: 'rect',
      role: 'legend-swatch',
      x: amcpChartR2(x),
      y: amcpChartR2(top + 3),
      w: 10,
      h: 10,
      round: null,
      s,
      color: series.color_index,
    });
    items.push(amcpChartText(o, 'legend-text', x + 16, top + 13, label, 'left', {s}));
    x += room;
  });
  return {items, height: (row + 1) * amcpChartLEGEND_ROW};
}
function amcpChartValueAxis(o, scale, px, x0, top, bottom) {
  const items = [amcpChartLine('axis', x0, top - 2, x0, bottom)];
  for (const tick of scale.ticks.slice(1)) items.push(amcpChartLine('grid', px(tick), top - 2, px(tick), bottom));
  items.push(
    ...amcpChartTickLabels(
      o,
      scale.ticks.map((tick, index) => ({x: px(tick), text: scale.tick_labels[index]})),
      bottom + 16,
      o.width,
    ),
  );
  return items;
}
function amcpChartBars(spec, o) {
  const x = spec.x,
    series = spec.series[0],
    count = x.items.length,
    hasTarget = !!series.targets?.some(Boolean),
    room =
      Math.max(0, ...series.value_labels.map(label => amcpChartTextWidth(label ?? o.t('No data'), amcpChartFS))) + 8,
    x0 = amcpChartPAD,
    x1 = Math.max(x0 + 40, o.width - amcpChartPAD - room),
    scale = spec.scale,
    px = value => x0 + (x1 - x0) * amcpChartRatio(value, scale.max),
    items = [];
  let top = amcpChartPAD;
  if (hasTarget) {
    items.push(amcpChartLine('legend-target', x0 + 4, top + 4, x0 + 4, top + 16));
    items.push(amcpChartText(o, 'legend-text', x0 + 14, top + 13, o.t('Target'), 'left'));
    top += amcpChartLEGEND_ROW;
  }
  const bottom = top + (count - 1) * amcpChartROW + 18 + amcpChartBAR;
  x.items.forEach((item, index) => {
    const rowTop = top + index * amcpChartROW,
      y = rowTop + 18,
      value = series.values[index];
    items.push(
      amcpChartText(
        o,
        'label',
        x0 + amcpChartNAME_INSET,
        rowTop + 12,
        amcpChartFit(
          item.other ? o.t('Other') : item.label,
          o.width - 2 * amcpChartPAD - amcpChartNAME_INSET,
          amcpChartFS,
        ),
        'left',
        {i: index},
      ),
    );
    if (value === null) {
      items.push(amcpChartText(o, 'nodata', x0 + 6, y + amcpChartBAR / 2 + 4, o.t('No data'), 'left', {i: index}));
      return;
    }
    const end = px(value),
      width = amcpChartR2(end - x0);
    if (width > 0)
      items.push({
        t: 'rect',
        role: 'bar',
        x: amcpChartR2(x0),
        y: amcpChartR2(y),
        w: Math.max(width, 1),
        h: amcpChartBAR,
        round: width >= 2 * amcpChartRadius ? 'right' : null,
        s: 0,
        i: index,
        color: item.other ? null : series.color_index,
      });
    const target = series.targets?.[index];
    if (series.label_at.includes(index)) {
      const label = series.value_labels[index] ?? '',
        targetAt = target ? px(target) : null;
      let at = end + 6;
      if (targetAt !== null && targetAt > at - 2 && targetAt < at + amcpChartTextWidth(label, amcpChartFS) + 2)
        at = targetAt + 6;
      items.push(amcpChartText(o, 'value', at, y + amcpChartBAR / 2 + 4, label, 'left', {s: 0, i: index}));
    }
    if (target) items.push(amcpChartLine('target', px(target), y - 3, px(target), y + amcpChartBAR + 3, index));
  });
  items.push(...amcpChartValueAxis(o, scale, px, x0, top, bottom));
  return {width: o.width, height: amcpChartR2(bottom + amcpChartAXIS), rtl: false, items};
}
function amcpChartStacks(spec, o) {
  const x = spec.x,
    count = x.items.length,
    room = Math.max(0, ...x.items.map(item => amcpChartTextWidth(item.total_label ?? '', amcpChartFS))) + 8,
    x0 = amcpChartPAD,
    x1 = Math.max(x0 + 40, o.width - amcpChartPAD - room),
    scale = spec.scale,
    px = value => x0 + (x1 - x0) * amcpChartRatio(value, scale.max),
    key = amcpChartLegend(spec, o, amcpChartPAD),
    items = [...key.items],
    top = amcpChartPAD + key.height + 4,
    bottom = top + (count - 1) * amcpChartROW + 18 + amcpChartSTACK;
  x.items.forEach((item, index) => {
    const rowTop = top + index * amcpChartROW,
      y = rowTop + 18;
    items.push(
      amcpChartText(
        o,
        'label',
        x0 + amcpChartNAME_INSET,
        rowTop + 12,
        amcpChartFit(item.label, o.width - 2 * amcpChartPAD - amcpChartNAME_INSET, amcpChartFS),
        'left',
        {i: index},
      ),
    );
    let start = 0;
    const parts = spec.series.map((series, s) => {
      const value = series.values[index];
      if (value === null || value === undefined) return null;
      const begin = start,
        end = start + (x1 - x0) * amcpChartRatio(value, scale.max);
      start = end;
      return end > begin ? {s, begin, end} : null;
    });
    const shown = parts.filter(part => part !== null);
    shown.forEach((part, order) => {
      const left = x0 + part.begin + (order > 0 ? 1 : 0),
        right = x0 + part.end - (order < shown.length - 1 ? 1 : 0),
        width = amcpChartR2(right - left);
      if (width <= 0) return;
      const series = spec.series[part.s];
      items.push({
        t: 'rect',
        role: 'segment',
        x: amcpChartR2(left),
        y: amcpChartR2(y),
        w: width,
        h: amcpChartSTACK,
        round: order === shown.length - 1 && width >= 2 * amcpChartRadius ? 'right' : null,
        s: part.s,
        i: index,
        color: series.color_index,
      });
      const label = series.value_labels[index] ?? '';
      if (label && series.label_at.includes(index) && amcpChartTextWidth(label, amcpChartFS) + 12 <= width)
        items.push(
          amcpChartText(o, 'inside', left + width / 2, y + amcpChartSTACK / 2 + 4, label, 'center', {
            s: part.s,
            i: index,
            color: series.color_index,
          }),
        );
    });
    if (item.total_label)
      items.push(
        amcpChartText(o, 'total', x0 + start + 6, y + amcpChartSTACK / 2 + 4, item.total_label, 'left', {i: index}),
      );
  });
  items.push(...amcpChartValueAxis(o, scale, px, x0, top, bottom));
  return {width: o.width, height: amcpChartR2(bottom + amcpChartAXIS), rtl: false, items};
}
function amcpChartLines(spec, o) {
  const x = spec.x,
    series = spec.series[0],
    scale = spec.scale,
    count = x.items.length,
    rtl = o.language === 'ar',
    axisWidth = Math.max(...scale.tick_labels.map(label => amcpChartTextWidth(label, amcpChartFS))) + 8,
    plotLeft = rtl ? amcpChartPAD + 8 : amcpChartPAD + axisWidth + 4,
    plotRight = rtl ? o.width - amcpChartPAD - axisWidth - 4 : o.width - amcpChartPAD - 8,
    plotTop = 22,
    plotHeight = Math.round(amcpChartClamp(o.width * 0.38, 130, 210)),
    plotBottom = plotTop + plotHeight,
    px = index =>
      plotLeft +
      (count === 1
        ? (plotRight - plotLeft) / 2
        : amcpChartINSET + ((plotRight - plotLeft - 2 * amcpChartINSET) * index) / (count - 1)),
    py = value => plotBottom - plotHeight * amcpChartRatio(value, scale.max),
    items = [];
  scale.ticks.forEach((tick, index) => {
    items.push(amcpChartLine(index === 0 ? 'axis' : 'grid', plotLeft, py(tick), plotRight, py(tick)));
    items.push(
      amcpChartText(
        o,
        'tick',
        rtl ? plotRight + 6 : plotLeft - 6,
        py(tick) + 4,
        scale.tick_labels[index],
        rtl ? 'left' : 'right',
      ),
    );
  });
  let segment = [];
  const joined = [];
  const flush = () => {
    if (segment.length > 1) {
      items.push({t: 'polyline', role: 'line', points: segment, s: 0, color: series.color_index});
      joined.push(segment);
    }
    segment = [];
  };
  series.values.forEach((value, index) => {
    if (value === null) return flush();
    const cx = amcpChartR2(px(index)),
      cy = amcpChartR2(py(value));
    if (series.short?.[index]) {
      flush();
      items.push({t: 'circle', role: 'hollow', cx, cy, r: amcpChartPOINT, s: 0, i: index, color: series.color_index});
      return;
    }
    segment.push([cx, cy]);
    items.push({t: 'circle', role: 'point', cx, cy, r: amcpChartPOINT, s: 0, i: index, color: series.color_index});
  });
  flush();
  const taken = [];
  for (const index of series.label_at) {
    const label = series.value_labels[index];
    if (label === null || label === undefined) continue;
    const half = amcpChartTextWidth(label, amcpChartFS) / 2,
      cx = amcpChartClamp(px(index), plotLeft + half, plotRight - half),
      cy = py(series.values[index]);
    for (const offset of [-10, 18]) {
      const box = {left: cx - half, right: cx + half, top: cy + offset - amcpChartFS, bottom: cy + offset + 3};
      if (
        box.top < 0 ||
        box.bottom > plotBottom - 2 ||
        joined.some(points => points.slice(1).some((point, k) => amcpChartCrosses(points[k], point, box))) ||
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
      items.push(amcpChartText(o, 'value', cx, cy + offset, label, 'center', {s: 0, i: index}));
      break;
    }
  }
  const withYear = x.items[0].key.slice(0, 4) !== x.items.at(-1).key.slice(0, 4),
    dates = x.items.map((item, index) => ({x: px(index), text: amcpChartDate(item.label, o.language, withYear)}));
  items.push(...amcpChartTickLabels(o, dates, plotBottom + 18, o.width));
  return {width: o.width, height: amcpChartR2(plotBottom + amcpChartAXIS), rtl, items};
}
function amcpChartTiles(spec, o) {
  const rtl = o.language === 'ar',
    columns = o.width >= 600 ? 5 : o.width >= 420 ? 3 : 2,
    cell = (o.width - 2 * amcpChartPAD - (columns - 1) * amcpChartGAP) / columns,
    side = rtl ? 'right' : 'left',
    items = [];
  const caption = amcpChartWrap(o.t('Since the previous period'), cell, amcpChartFS, 2),
    changeOf = series =>
      series.change
        ? amcpChartWrap(
            series.change.percent_label
              ? `${series.change.delta_label} (${series.change.percent_label})`
              : series.change.delta_label,
            cell,
            amcpChartFS,
            2,
          )
        : [],
    extra = Math.max(0, ...spec.series.map(series => (series.change ? changeOf(series).length + caption.length : 0))),
    height = extra ? amcpChartTILE_CHANGE + amcpChartLINE * (extra - 1) : amcpChartTILE;
  spec.series.forEach((series, s) => {
    const left = amcpChartPAD + (s % columns) * (cell + amcpChartGAP),
      top = amcpChartPAD + Math.floor(s / columns) * height,
      at = rtl ? o.width - left : left,
      figure = amcpChartFigure(series.value_labels[0] ?? o.t('No data'), cell);
    items.push(
      amcpChartText(
        o,
        'kpi-label',
        at,
        top + 14,
        amcpChartFit(series.name_kind === 'label' ? o.t(series.name) : series.name, cell, amcpChartFS),
        side,
        {s},
      ),
    );
    items.push(amcpChartText(o, 'kpi-value', at, top + 40, figure.text, side, {size: figure.size, bold: true, s}));
    if (series.value_labels[0] && series.unit === 'currency' && series.currency)
      items.push(amcpChartText(o, 'kpi-unit', at, top + 56, series.currency, side, {s}));
    if (series.change) {
      const words = changeOf(series);
      words.forEach((line, index) =>
        items.push(amcpChartText(o, 'kpi-change', at, top + 72 + amcpChartLINE * index, line, side, {s})),
      );
      caption.forEach((line, index) =>
        items.push(
          amcpChartText(o, 'kpi-caption', at, top + 72 + amcpChartLINE * (words.length + index), line, side, {s}),
        ),
      );
    }
  });
  return {
    width: o.width,
    height: amcpChartR2(amcpChartPAD + Math.ceil(spec.series.length / columns) * height),
    rtl,
    items,
  };
}
/** A bar's outline: square at the baseline, a quarter circle of 4px at each corner of the data end. */
function amcpChartBarPath(item) {
  const r = amcpChartRadius,
    {x, y} = item,
    right = x + item.w,
    bottom = y + item.h;
  return item.round === 'right'
    ? `M${x},${y}H${right - r}A${r},${r} 0 0 1 ${right},${y + r}V${bottom - r}A${r},${r} 0 0 1 ${right - r},${bottom}H${x}Z`
    : `M${right},${y}H${x + r}A${r},${r} 0 0 0 ${x},${y + r}V${bottom - r}A${r},${r} 0 0 0 ${x + r},${bottom}H${right}Z`;
}
/** The scene of a chart that is drawn, or null for one that is not (its notes and its table say why). */
function amcpChartLayout(spec, options) {
  if (!spec.drawn) return null;
  if (spec.type === 'kpi') return amcpChartTiles(spec, options);
  if (!spec.x || !spec.scale || !spec.series.length) return null;
  if (spec.type === 'line') return amcpChartLines(spec, options);
  const scene = spec.type === 'stacked_bar' ? amcpChartStacks(spec, options) : amcpChartBars(spec, options);
  return options.language === 'ar' ? {...scene, rtl: true, items: amcpChartMirror(scene.items, scene.width)} : scene;
}

// ----- exact decimal text: a port of the parts of src/report-chart-scale.ts the table needs -----
function amcpChartParse(value) {
  const match = typeof value === 'string' && value.length <= 400 ? /^(-?)(\d+)(?:\.(\d+))?$/.exec(value) : null;
  return match ? {units: BigInt(match[1] + match[2] + (match[3] ?? '')), places: (match[3] ?? '').length} : null;
}
const amcpChartGroup = whole => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** Grouped thousands, the value's own fraction without trailing zeros: Latin digits in both languages (D27). */
function amcpChartNumber(text) {
  const value = amcpChartParse(text);
  if (!value) return String(text);
  const negative = value.units < 0n,
    digits = (negative ? -value.units : value.units).toString().padStart(value.places + 1, '0'),
    whole = digits.slice(0, digits.length - value.places),
    fraction = digits.slice(digits.length - value.places).replace(/0+$/, '');
  return (
    (negative && (whole !== '0' || fraction) ? '-' : '') + amcpChartGroup(whole) + (fraction ? '.' + fraction : '')
  );
}
/** Exactly `places` decimals, rounded half up on the exact digits, thousands grouped: a currency in its minor units. */
function amcpChartFixed(text, places) {
  const value = amcpChartParse(text);
  if (!value) return String(text);
  const negative = value.units < 0n,
    magnitude = negative ? -value.units : value.units;
  let units;
  if (value.places > places) {
    const divisor = 10n ** BigInt(value.places - places);
    units = magnitude / divisor + (magnitude % divisor >= divisor / 2n ? 1n : 0n);
  } else units = magnitude * 10n ** BigInt(places - value.places);
  const digits = units.toString().padStart(places + 1, '0'),
    whole = digits.slice(0, digits.length - places),
    fraction = digits.slice(digits.length - places);
  return (negative && units !== 0n ? '-' : '') + amcpChartGroup(whole) + (places ? '.' + fraction : '');
}
/** The minor units a currency has (USD 2, JPY 0, KWD 3), as the platform's own number formatting knows them. */
function amcpChartMinorUnits(currency) {
  try {
    return new Intl.NumberFormat('en', {style: 'currency', currency}).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

// ----- the words: the server's messages through uiText, and the table of a chart as a reader reads it -----
const amcpChartMetricNames = {
  spend: 'Spend',
  impressions: 'Impressions',
  clicks: 'Clicks',
  primary_result: 'Results',
  cost_per_result: 'Cost per result',
};
const amcpChartIsolate = value => String.fromCodePoint(0x2068) + value + String.fromCodePoint(0x2069);
/**
 * A message of the spec said in the page's language: names AMCP wrote are translated, provider data and numbers are not, and
 * in Arabic every value is isolated from the sentence around it, so a date or an amount keeps its own order.
 */
function amcpChartMessage(message) {
  const params = {...message.params},
    words = new Set(message.labels ?? []);
  for (const [name, value] of Object.entries(params))
    params[name] = words.has(name) ? uiText(value) : uiLocale === 'ar' ? amcpChartIsolate(value) : value;
  return uiText(message.key, params);
}
/**
 * The same message as nodes for the page: AMCP's sentence is text, a value is a `bdi` (it keeps its own direction inside an
 * Arabic sentence), and a name from a provider is a `bdi` marked `data-native` too, so the Arabic leak probe and assistive
 * technology take it for the provider's words and not for a sentence AMCP forgot to translate.
 */
function amcpChartMessageNodes(message) {
  const words = new Set(message.labels ?? []),
    params = message.params ?? {},
    nodes = [];
  uiText(message.key)
    .split(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/)
    .forEach((part, index) => {
      if (index % 2 === 0) {
        if (part) nodes.push(document.createTextNode(part));
        return;
      }
      if (!Object.hasOwn(params, part)) return nodes.push(document.createTextNode('{' + part + '}'));
      if (words.has(part)) return nodes.push(document.createTextNode(uiText(params[part])));
      const value = document.createElement('bdi');
      value.textContent = params[part];
      if (part === 'name') value.setAttribute('data-native', '');
      nodes.push(value);
    });
  return nodes;
}
/** A note said in the page's language; a coverage note is re-worded from its counts with the page's own coverage words. */
function amcpChartNote(note) {
  if (note.kind !== 'coverage') return amcpChartMessage(note);
  const name = uiText(amcpChartMetricNames[note.metric] ?? note.metric),
    unavailable = reportUnavailableNote(note.reason, [name]);
  if (unavailable) return unavailable;
  const counts = reportCoverageLabel({
    known_rows: note.known,
    total_rows: note.total,
    basis: note.unit === 'measurements' ? 'native_measurements' : 'report_rows',
  });
  return counts ? name + ': ' + counts : note.text;
}
const amcpChartSeriesName = series => (series.name_kind === 'label' ? uiText(series.name) : series.name);
const amcpChartNumeric = column => ['decimal', 'currency', 'percent'].includes(column.type);
/** The table of a chart as text: the same cells the PDF lists (src/report-chart-theme.ts chartTableText). */
function amcpChartTable(spec) {
  const table = spec.table;
  if (!table) return {columns: [], rows: []};
  const heading = column => {
    const label = column.label_kind === 'label' ? uiText(column.label) : column.label;
    return column.type === 'currency' && column.currency ? `${label} (${column.currency})` : label;
  };
  const cell = (column, value, other) => {
    if (value === null) return amcpChartNumeric(column) ? uiText('No data') : '';
    if (column.type === 'currency')
      return column.currency ? amcpChartFixed(value, amcpChartMinorUnits(column.currency)) : amcpChartNumber(value);
    if (column.type === 'decimal') return amcpChartNumber(value);
    if (column.type === 'percent') return amcpChartNumber(value) + '%';
    return other || column.cell_kind === 'label' ? uiText(value) : value;
  };
  return {
    columns: table.columns.map(column => ({label: heading(column), align: amcpChartNumeric(column) ? 'end' : 'start'})),
    rows: table.rows.map((row, index) =>
      row.map((value, column) => cell(table.columns[column], value, column === 0 && table.other === index)),
    ),
  };
}

// ----- the page: the section, a figure for each chart, marks that can be focused, a tooltip, the table -----
const amcpChartSvgNs = 'http://www.w3.org/2000/svg';
function amcpChartSvg(name, attributes = {}, text) {
  const element = document.createElementNS(amcpChartSvgNs, name);
  for (const [key, value] of Object.entries(attributes))
    if (value !== undefined) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}
const amcpChartHue = color => (color === null ? 'other' : String(color));
/** Whether a text mark of the scene is a provider's name (an entry of a bar or stack, a series named after an entity). */
function amcpChartNative(spec, item) {
  if (item.role === 'label') return !spec.x?.items[item.i]?.other;
  if (item.role === 'legend-text') return spec.series[item.s]?.name_kind === 'entity';
  return false;
}
/** What a mark is, for a reader who hovers or focuses it: its entry, its series and its value. */
function amcpChartMarkWords(spec, item) {
  const entry = spec.x?.items[item.i],
    name = entry ? (entry.other ? uiText('Other') : entry.label) : '',
    series = spec.series[item.s],
    value = series?.value_labels[item.i] ?? uiText('No data'),
    lines = [item.role === 'segment' ? name + ' · ' + amcpChartSeriesName(series) : name, value];
  const target = series?.target_labels?.[item.i];
  if (target) lines.push(uiText('Target') + ': ' + target);
  if (entry?.detail) lines.push(entry.detail);
  const short = series?.short?.[item.i];
  if (short) {
    const counts = reportCoverageLabel({
      known_rows: short.known,
      total_rows: short.total,
      basis: short.unit === 'measurements' ? 'native_measurements' : 'report_rows',
    });
    if (counts) lines.push(counts);
  }
  return lines;
}
/** Draws the scene of a chart into its svg: marks that are focusable, texts, the texture overlays for print. */
function amcpChartDraw(svg, spec, scene, uid) {
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${scene.width} ${scene.height}`);
  svg.setAttribute('width', String(scene.width));
  svg.setAttribute('height', String(scene.height));
  // The print texture: stripes (up to the right for the second hue, down to the right for the third) and dots (Other), drawn
  // over a fill by an element that is hidden on screen and shown in print and in forced colours (web/charts.css).
  const defs = amcpChartSvg('defs'),
    {period, stripe, dot} = amcpChartTexture;
  for (const [hue, angle] of [
    [1, 45],
    [2, -45],
  ]) {
    const pattern = amcpChartSvg('pattern', {
      id: `${uid}-h${hue}`,
      width: period,
      height: period,
      patternUnits: 'userSpaceOnUse',
      patternTransform: `rotate(${angle})`,
    });
    pattern.append(amcpChartSvg('rect', {width: stripe, height: period, class: 'amcp-chart-hatch'}));
    defs.append(pattern);
  }
  const dots = amcpChartSvg('pattern', {id: `${uid}-o`, width: period, height: period, patternUnits: 'userSpaceOnUse'});
  dots.append(amcpChartSvg('circle', {cx: period / 2, cy: period / 2, r: dot, class: 'amcp-chart-hatch'}));
  defs.append(dots);
  svg.append(defs, amcpChartSvg('rect', {width: scene.width, height: scene.height, class: 'amcp-chart-surface'}));
  const order = item =>
    item.t === 'line'
      ? item.role === 'grid'
        ? 0
        : item.role === 'axis'
          ? 1
          : 4
      : {rect: 2, polyline: 3, circle: 5, text: 6}[item.t];
  const marks = [],
    bars = new Map();
  scene.items
    .map((item, index) => ({item, index}))
    .sort((a, b) => order(a.item) - order(b.item) || a.index - b.index)
    .forEach(({item}) => {
      const hue = item.color === undefined ? undefined : amcpChartHue(item.color);
      if (item.t === 'rect') {
        const shape = amcpChartSvg(item.round ? 'path' : 'rect', {
          ...(item.round ? {d: amcpChartBarPath(item)} : {x: item.x, y: item.y, width: item.w, height: item.h}),
          class: 'amcp-chart-fill',
          'data-role': item.role,
          'data-hue': hue,
        });
        svg.append(shape);
        if (item.role === 'bar') bars.set(item.i, shape);
        else if (item.role === 'segment') marks.push({element: shape, item});
        if (item.color !== 0) {
          const overlay = amcpChartSvg(item.round ? 'path' : 'rect', {
            ...(item.round ? {d: amcpChartBarPath(item)} : {x: item.x, y: item.y, width: item.w, height: item.h}),
            class: 'amcp-chart-texture',
            fill: `url(#${uid}-${item.color === null ? 'o' : 'h' + item.color})`,
            'aria-hidden': 'true',
          });
          svg.append(overlay);
        }
      } else if (item.t === 'line') {
        svg.append(
          amcpChartSvg('line', {
            x1: item.x1,
            y1: item.y1,
            x2: item.x2,
            y2: item.y2,
            class: 'amcp-chart-rule',
            'data-role': item.role,
          }),
        );
      } else if (item.t === 'polyline') {
        svg.append(
          amcpChartSvg('polyline', {
            points: item.points.map(point => point.join(',')).join(' '),
            class: 'amcp-chart-path',
            'data-hue': hue,
          }),
        );
      } else if (item.t === 'circle') {
        if (item.role === 'point')
          svg.append(amcpChartSvg('circle', {cx: item.cx, cy: item.cy, r: item.r + 2, class: 'amcp-chart-ring'}));
        const shape = amcpChartSvg('circle', {
          cx: item.cx,
          cy: item.cy,
          r: item.r,
          class: 'amcp-chart-dot',
          'data-role': item.role,
          'data-hue': hue,
        });
        svg.append(shape);
        marks.push({element: shape, item});
      } else {
        svg.append(
          amcpChartSvg(
            'text',
            {
              x: item.x,
              y: item.y,
              'text-anchor':
                item.anchor === 'center' ? 'middle' : (item.anchor === 'left') !== item.rtl ? 'start' : 'end',
              'font-size': item.size,
              'font-weight': item.bold ? 700 : undefined,
              direction: item.rtl ? 'rtl' : undefined,
              'unicode-bidi': item.rtl ? 'embed' : undefined,
              class: 'amcp-chart-text',
              'data-role': item.role,
              'data-hue': item.color === undefined ? undefined : amcpChartHue(item.color),
              // A name from a provider keeps its own words and direction: it is data, not one of AMCP's.
              'data-native': amcpChartNative(spec, item) ? 'true' : undefined,
            },
            item.text,
          ),
        );
      }
    });
  // The marks of a bar chart are its rows, so an entry with no bar to see (a zero, or a value too small to draw) is reached
  // like any other, and the target is the size of a row. Its tooltip hangs from the bar when there is one.
  if (spec.type === 'bar')
    for (const label of scene.items.filter(item => item.t === 'text' && item.role === 'label')) {
      const row = amcpChartSvg('rect', {
        x: 0,
        y: amcpChartR2(label.y - 12),
        width: scene.width,
        height: amcpChartROW - 4,
        rx: amcpChartRadius,
        class: 'amcp-chart-hit',
        'data-role': 'row',
      });
      svg.append(row);
      marks.push({element: row, anchor: bars.get(label.i), item: {t: 'row', role: 'bar', i: label.i, s: 0}});
    }
  // Marks in reading order, each with the words of its tooltip; one of them is in the tab order at a time.
  marks.sort((a, b) => (a.item.i ?? 0) - (b.item.i ?? 0) || (a.item.s ?? 0) - (b.item.s ?? 0));
  marks.forEach(({element, item}, index) => {
    element.setAttribute('tabindex', index === 0 ? '0' : '-1');
    element.setAttribute('role', 'img');
    element.setAttribute('aria-label', amcpChartMarkWords(spec, item).join(', '));
    element.setAttribute('data-mark', String(index));
  });
  return marks;
}
/** One tooltip for a chart, an SVG group moved by attributes (no style, so the page's content policy holds). */
function amcpChartTip(svg, scene, words, element, native = false) {
  svg.querySelector('.amcp-chart-tip')?.remove();
  const tip = amcpChartSvg('g', {class: 'amcp-chart-tip', 'aria-hidden': 'true'}),
    size = amcpChartFS,
    width = Math.max(...words.map(line => amcpChartTextWidth(line, size))) + 16,
    height = words.length * (size + 4) + 8,
    box = element.getBBox(),
    middle = box.x + box.width / 2,
    left = amcpChartClamp(middle - width / 2, 2, Math.max(2, scene.width - width - 2)),
    above = box.y - height - 6 >= 2,
    top = above ? box.y - height - 6 : Math.min(box.y + box.height + 6, Math.max(2, scene.height - height - 2));
  tip.append(amcpChartSvg('rect', {x: left, y: top, width, height, rx: 4, class: 'amcp-chart-tip-box'}));
  words.forEach((line, index) => {
    // In Arabic every line is set against the right edge of the box: a line that reads right to left starts there, and a name or
    // a number (which reads left to right) ends there. In English every line starts at the left edge.
    const arabic = uiLocale === 'ar',
      rtl = arabic && amcpChartArabic.test(line);
    tip.append(
      amcpChartSvg(
        'text',
        {
          x: arabic ? left + width - 8 : left + 8,
          y: top + (size + 4) * (index + 1),
          'font-size': size,
          class: 'amcp-chart-tip-text',
          direction: rtl ? 'rtl' : undefined,
          'unicode-bidi': rtl ? 'embed' : undefined,
          // `start` is the left edge of a left-to-right line and the right edge of one that reads right to left.
          'text-anchor': arabic && !rtl ? 'end' : 'start',
          // The first line of a bar's tooltip is the name of its entry.
          'data-native': index === 0 && native ? 'true' : undefined,
        },
        line,
      ),
    );
  });
  svg.append(tip);
}
/** The figure of one chart: a heading, its takeaway, the picture, its notes and a table the reader can open. */
function amcpChartFigureOf(chart) {
  const uid = AmcpUI.uid('chart'),
    figure = document.createElement('figure'),
    caption = document.createElement('figcaption'),
    title = document.createElement('h3'),
    frame = document.createElement('div');
  figure.className = 'amcp-chart';
  figure.dataset.chart = chart.id;
  figure.dataset.kind = chart.kind;
  title.className = 'amcp-chart-title';
  title.textContent = amcpChartMessage(chart.title);
  caption.append(title);
  if (chart.takeaway) {
    const takeaway = document.createElement('p');
    takeaway.className = 'amcp-chart-takeaway';
    takeaway.append(...amcpChartMessageNodes(chart.takeaway));
    caption.append(takeaway);
  }
  figure.append(caption);
  let draw = () => {};
  if (chart.drawn) {
    frame.className = 'amcp-chart-frame';
    const svg = amcpChartSvg('svg', {
      class: 'amcp-chart-svg',
      role: 'group',
      'aria-label': amcpChartMessage(chart.title),
    });
    frame.append(svg);
    figure.append(frame);
    let marks = [],
      current = 0,
      scene = null;
    const language = uiLocale === 'ar' ? 'ar' : 'en',
      // The tooltip of a mark: its words, hung from its bar when it has one.
      tooltip = index => {
        const mark = marks[index];
        if (mark)
          amcpChartTip(
            svg,
            scene,
            amcpChartMarkWords(chart, mark.item),
            mark.anchor ?? mark.element,
            mark.item.role === 'bar' && !chart.x?.items[mark.item.i]?.other,
          );
      },
      // The keyboard's place: the one mark in the tab order, and optionally the focus with it.
      show = (index, focus) => {
        const mark = marks[index];
        if (!mark) return;
        marks[current]?.element.setAttribute('tabindex', '-1');
        current = index;
        mark.element.setAttribute('tabindex', '0');
        if (focus) mark.element.focus();
        tooltip(index);
      },
      hide = () => svg.querySelector('.amcp-chart-tip')?.remove();
    draw = width => {
      scene = amcpChartLayout(chart, {width, language, t: uiText});
      if (!scene) return;
      marks = amcpChartDraw(svg, chart, scene, uid);
      // A picture drawn again (the page changed width) keeps the keyboard's place.
      current = Math.min(current, marks.length - 1);
      marks.forEach((mark, index) => mark.element.setAttribute('tabindex', index === current ? '0' : '-1'));
    };
    svg.addEventListener('focusin', event => {
      const index = marks.findIndex(mark => mark.element === event.target);
      if (index >= 0) show(index, false);
    });
    svg.addEventListener('focusout', event => {
      if (!svg.contains(event.relatedTarget)) hide();
    });
    // The pointer shows a tooltip and leaves the keyboard's place alone. A pointer at rest while the page scrolls under it (a
    // focused mark brought into view) is not the pointer moving, and must not take the tooltip from the mark in focus.
    svg.addEventListener('mousemove', event => {
      if (typeof event.movementX === 'number' && !event.movementX && !event.movementY) return;
      const index = marks.findIndex(mark => mark.element === event.target);
      if (index >= 0) tooltip(index);
    });
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('keydown', event => {
      // A shortcut of the browser's (Alt+Left is Back) is not ours.
      if (!marks.length || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'Escape') {
        hide();
        return;
      }
      const rtlBars = scene.rtl && chart.type !== 'line',
        forward = ['ArrowDown', rtlBars ? 'ArrowLeft' : 'ArrowRight'],
        backward = ['ArrowUp', rtlBars ? 'ArrowRight' : 'ArrowLeft'];
      const target = forward.includes(event.key)
        ? Math.min(marks.length - 1, current + 1)
        : backward.includes(event.key)
          ? Math.max(0, current - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? marks.length - 1
              : -1;
      if (target < 0) return;
      event.preventDefault();
      show(target, true);
    });
    // The picture takes the width of the page it is on, and again when that changes.
    const place = () => draw(Math.max(240, Math.floor(frame.clientWidth || 640)));
    if (typeof ResizeObserver === 'function') {
      let last = 0;
      new ResizeObserver(() => {
        const width = Math.floor(frame.clientWidth);
        if (width && width !== last) {
          last = width;
          place();
        }
      }).observe(frame);
    }
    place();
  }
  if (chart.notes.length) {
    const notes = document.createElement('ul');
    notes.className = 'amcp-chart-notes';
    for (const note of chart.notes) {
      const item = document.createElement('li');
      item.append(...(note.kind === 'coverage' ? [amcpChartNote(note)] : amcpChartMessageNodes(note)));
      notes.append(item);
    }
    figure.append(notes);
  }
  if (chart.table?.rows.length) {
    const table = amcpChartTable(chart),
      panel = document.createElement('div'),
      host = document.createElement('div');
    host.className = 'amcp-chart-tools';
    setHtml(
      host,
      AmcpUI.button({
        label: uiText('Show table'),
        variant: 'secondary',
        size: 'sm',
        expanded: false,
        controls: uid + '-table',
        id: uid + '-toggle',
      }),
    );
    panel.id = uid + '-table';
    panel.className = 'amcp-chart-table';
    panel.hidden = true;
    setHtml(
      panel,
      AmcpUI.table({
        id: uid + '-data',
        caption: amcpChartMessage(chart.title),
        columns: table.columns.map((column, index) => ({
          id: 'c' + index,
          label: column.label,
          numeric: column.align === 'end',
          // A name from a provider keeps its own direction.
          native: chart.table.columns[index].cell_kind === 'entity',
        })),
        rows: table.rows.map((row, index) => ({
          id: 'r' + index,
          cells: Object.fromEntries(row.map((cell, column) => ['c' + column, cell])),
        })),
        chooser: false,
        densityToggle: false,
      }),
    );
    const toggle = host.querySelector('button');
    toggle.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.querySelector('.amcp-button-label').textContent = uiText(open ? 'Hide table' : 'Show table');
    });
    figure.append(host, panel);
  }
  return figure;
}
/** Fills `root` (an empty section) with the charts a report carries: a heading and a figure for each. */
function mountReportCharts(root, charts) {
  root.replaceChildren();
  if (!Array.isArray(charts) || !charts.length) return;
  const heading = document.createElement('h2');
  heading.className = 'amcp-chart-heading';
  heading.textContent = uiText('Charts');
  root.append(heading);
  for (const chart of charts) root.append(amcpChartFigureOf(chart));
}
/**
 * The report builder's setting for the charts: a box for each kind the server draws (its bootstrap lists them), checked when
 * the chart is on, in the pills the builder uses for its metrics. A chart that is switched off is not computed; the saved
 * report records only the ones that are off (`overviewConfig`).
 */
function mountReportChartOptions(host, config, bootstrap) {
  const off = new Set(config?.charts?.disabled ?? []),
    kinds = bootstrap?.chart_kinds ?? [];
  if (!host || !kinds.length) return;
  setHtml(
    host,
    html`<details class="report-options" id="report-chart-options"><summary><h2 class="report-section-label"><span>04</span><strong>${uiText('Charts')}</strong><small>${uiText('Choose which charts this report draws.')}</small></h2></summary><div class="report-options-grid"><p class="muted">${uiText('A chart that is switched off is not drawn or stored for a report you pull from now on.')}</p><div class="metric-pills" role="group" aria-label="${uiText('Charts')}">${kinds.map(kind => html`<label><input type="checkbox" data-report-chart="${kind.id}"${off.has(kind.id) ? '' : ' checked'}><span>${uiText(kind.label)}</span></label>`)}</div></div></details>`,
  );
}
/** Whether the charts of a report stand in for the small spend line on each summary card (they draw the same periods). */
function reportChartsReplaceSparklines(report) {
  return Array.isArray(report?.charts) && report.charts.some(chart => chart.kind === 'trend' && chart.drawn);
}
