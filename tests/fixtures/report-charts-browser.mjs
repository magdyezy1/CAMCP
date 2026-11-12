import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chartPalette} from '../../dist/src/report-chart-theme.js';
import {campaigns, charts, of, specimens} from '../helpers/chart-specimens.mjs';

const toRgb = hex => `rgb(${[1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;

/** The charts a report can carry, of every drawn shape, and one that cannot honestly be drawn (its notes and table remain). */
export function richCharts() {
  const shapes = specimens(),
    [lone] = of(charts(campaigns([5])), 'spend_by_entity');
  return [
    shapes.tiles,
    shapes.line,
    shapes['short-line'],
    shapes.bars,
    shapes['folded-bars'],
    shapes.cost,
    shapes.stack,
    shapes['folded-stack'],
    lone,
  ];
}

/**
 * V2-EXP-01 in a real browser: the charts section of a finished report. First the charts the finish step stored for the real
 * run (editor -> HTTP -> worker -> get -> page) and the setting that switches a chart off; then a snapshot that carries one
 * chart of every shape (computed by the real chart module and put in the stored snapshot) is read through the real `get`, and
 * `inspectCharts` looks at what the page drew.
 */
export async function exerciseReportCharts({
  page,
  site,
  locale,
  width,
  appearance,
  output,
  id,
  snapshotId,
  result,
  checks,
}) {
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    text = key => (locale === 'ar' ? (catalog[key] ?? key) : key),
    dialogs = [],
    section = page.locator('#report-charts'),
    figures = section.locator('figure.amcp-chart');
  // Probe 16 on the page: nothing a chart draws may open a dialog.
  page.on('dialog', dialog => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  // ---- The charts the finish step stored for the real run.
  await figures.first().waitFor();
  const real = await figures.evaluateAll(list => list.map(figure => figure.dataset.kind));
  assert.ok(real.includes('kpi') && real.includes('trend'), 'the charts of the real snapshot are on the page: ' + real);
  assert.equal((await section.locator('h2.amcp-chart-heading').innerText()).trim(), text('Charts'));
  assert.equal(
    await page.locator('#overview-results .report-sparkline').count(),
    0,
    'a drawn trend takes the place of the small spend line on each summary',
  );
  for (const figure of await figures.all())
    assert.ok((await figure.locator('figcaption h3').innerText()).trim(), 'every chart has its title');

  // ---- The setting that switches a chart off: one box for each kind the server draws, saved as the ones that are off.
  const options = page.locator('#report-chart-options'),
    boxes = options.locator('input[data-report-chart]');
  await options.locator(':scope > summary').click();
  assert.equal(await boxes.count(), 6, 'a box for each chart kind of the bootstrap');
  assert.deepEqual(await boxes.evaluateAll(list => list.map(box => box.checked)), Array(6).fill(true));
  assert.equal(await page.evaluate(() => overviewConfig().charts), undefined, 'every chart on is no setting');
  const trendPill = options.locator('label:has(input[data-report-chart=trend]) span');
  assert.equal((await trendPill.innerText()).trim(), text('Spend and results over time'));
  await trendPill.click();
  assert.deepEqual(await page.evaluate(() => overviewConfig().charts), {disabled: ['trend']});
  await trendPill.click();
  assert.equal(await page.evaluate(() => overviewConfig().charts), undefined);
  await options.locator(':scope > summary').click();

  // ---- A snapshot with a chart of every shape, read through the real get.
  const tenant = site.granular.tenant,
    rich = richCharts(),
    stored = site.granular.store.document(tenant, 'overview_report', snapshotId);
  site.granular.store.putDocument(tenant, 'overview_report', snapshotId, {...stored, charts: rich});
  await page.evaluate(snapshot => loadOverviewReport(snapshot), snapshotId);
  await figures.nth(rich.length - 1).waitFor();
  await inspectCharts({page, locale, width, appearance, output, id, result, checks, dialogs, rich});
}

/**
 * What a reader meets on the page that drew `rich` (richCharts): a figure for each chart, titled in the page's language;
 * every picture inside the page and every label inside its picture at this width; the colours of this theme as the browser
 * painted them; texture on paper; Arabic with time left to right in Latin digits and bars from the right; a name that is
 * markup staying text; the keyboard (one tab stop, the arrows, Home, End, Escape, Tab out and back); the tooltip on hover;
 * the table behind its button; and the accessibility and Arabic leak inspections with a mark in focus and the table open.
 * It needs `#report-charts` and nothing else of the report builder, so it can also look at a page of the charts alone.
 */
export async function inspectCharts({page, locale, width, appearance, output, id, result, checks, dialogs, rich}) {
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    text = key => (locale === 'ar' ? (catalog[key] ?? key) : key),
    palette = chartPalette[appearance],
    section = page.locator('#report-charts'),
    figures = section.locator('figure.amcp-chart');
  assert.equal(await figures.count(), rich.length, 'a figure for each chart');
  assert.deepEqual(
    await figures.evaluateAll(list => list.map(figure => figure.dataset.kind)),
    rich.map(spec => spec.kind),
  );
  assert.deepEqual(
    (await figures.locator('figcaption h3').allInnerTexts()).map(title => title.trim()),
    rich.map(spec => text(spec.title.key)),
    'each chart is titled in the page language',
  );
  assert.equal(
    await figures.locator('svg.amcp-chart-svg').count(),
    rich.length - 1,
    'every chart but the one that cannot be drawn',
  );
  const lone = figures.nth(rich.length - 1);
  assert.equal(await lone.locator('svg').count(), 0);
  assert.ok((await lone.locator('.amcp-chart-notes li').count()) >= 1, 'a chart that is not drawn says why');
  assert.ok((await lone.locator('table').count()) === 1, 'and keeps its table');

  // Every picture is inside the page, and every label inside its picture: no clipped text at this width.
  const pictures = await page.evaluate(() => {
    // The ink of a text, not the box of its font's line: that is taller than the digits it holds, and differs from face to
    // face (the Arabic face of the page has a line box 1.4em tall).
    const canvas = document.createElement('canvas').getContext('2d');
    return [...document.querySelectorAll('#report-charts figure.amcp-chart')].map(figure => {
      const svg = figure.querySelector('svg.amcp-chart-svg');
      if (!svg) return {kind: figure.dataset.kind, drawn: false};
      const view = svg.viewBox.baseVal,
        box = svg.getBoundingClientRect(),
        clipped = [];
      for (const label of svg.querySelectorAll('text:not(.amcp-chart-tip-text)')) {
        const style = getComputedStyle(label),
          size = Number.parseFloat(label.getAttribute('font-size')),
          at = label.getBBox();
        canvas.font = `${style.fontWeight} ${size}px ${style.fontFamily}`;
        const ink = canvas.measureText(label.textContent),
          baseline = Number(label.getAttribute('y')),
          top = baseline - ink.actualBoundingBoxAscent,
          bottom = baseline + ink.actualBoundingBoxDescent;
        if (at.x < -0.5 || at.x + at.width > view.width + 0.5 || top < -0.5 || bottom > view.height + 0.5)
          clipped.push({text: label.textContent, from: Math.round(at.x), to: Math.round(at.x + at.width), top, bottom});
      }
      return {
        kind: figure.dataset.kind,
        drawn: true,
        left: box.left,
        right: box.right,
        view: [view.width, view.height],
        shown: [Math.round(box.width), Math.round(box.height)],
        clipped,
      };
    });
  });
  for (const picture of pictures) {
    if (!picture.drawn) continue;
    assert.deepEqual(picture.clipped, [], `${picture.kind} at ${width}px: a label outside its picture`);
    assert.ok(
      picture.left >= -1 && picture.right <= width + 1,
      `${picture.kind} at ${width}px: ${JSON.stringify(picture)}`,
    );
    assert.ok(picture.shown[0] > 0 && picture.shown[1] > 0, picture.kind + ' has a size');
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 1, 'The charts must fit the viewport: ' + overflow);

  // The colours of this theme, read from what the browser painted, equal the palette the SVG and the PDF draw.
  const painted = await page.evaluate(() => {
    const read = (selector, property) => {
        const element = document.querySelector('#report-charts ' + selector);
        return element ? getComputedStyle(element)[property] : null;
      },
      hue = which => read(`.amcp-chart-fill[data-hue='${which}']`, 'fill');
    return {
      hue0: hue('0'),
      hue1: hue('1'),
      hue2: hue('2'),
      other: hue('other'),
      line: read(".amcp-chart-path[data-hue='0']", 'stroke'),
      surface: read('.amcp-chart-frame', 'backgroundColor'),
      ink: read("text[data-role='label']", 'fill'),
      tick: read("text[data-role='tick']", 'fill'),
      motion: read('.amcp-chart-fill', 'transitionDuration'),
    };
  });
  assert.deepEqual(
    painted,
    {
      hue0: toRgb(palette.hues[0]),
      hue1: toRgb(palette.hues[1]),
      hue2: toRgb(palette.hues[2]),
      other: toRgb(palette.other),
      line: toRgb(palette.hues[0]),
      surface: toRgb(palette.surface),
      ink: toRgb(palette.ink),
      tick: toRgb(palette.ink2),
      motion: '0s',
    },
    `the chart palette in the ${appearance} theme`,
  );
  // Colour is not the only encoding: the texture is hidden on screen and drawn on paper.
  const texture = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('#report-charts .amcp-chart-texture')].map(el => getComputedStyle(el).display),
    );
  assert.ok(
    (await texture()).length > 0 && (await texture()).every(display => display === 'none'),
    'no texture on screen',
  );
  await page.emulateMedia({media: 'print'});
  assert.ok(
    (await texture()).every(display => display !== 'none'),
    'a texture over each fill that is not the first hue, on paper',
  );
  await page.emulateMedia({media: null});

  // Arabic keeps time left to right with Latin digits, and the bars start at the right.
  const direction = await page.evaluate(() => {
    const line = document.querySelector("#report-charts figure[data-kind='trend'] svg.amcp-chart-svg"),
      bar = document.querySelector(
        "#report-charts figure[data-kind='spend_by_entity'] .amcp-chart-fill[data-role='bar']",
      ),
      svg = bar.closest('svg'),
      ticks = [...line.querySelectorAll("text[data-role='tick']")]
        .filter(tick => /\d/.test(tick.textContent) && /[A-Za-z\p{Script=Arabic}]/u.test(tick.textContent))
        .map(tick => ({text: tick.textContent, x: tick.getBBox().x}));
    return {
      lineDirection: getComputedStyle(line).direction,
      ticks,
      barNearRight: svg.getBoundingClientRect().right - bar.getBoundingClientRect().right < 24,
      barNearLeft: bar.getBoundingClientRect().left - svg.getBoundingClientRect().left < 24,
    };
  });
  assert.equal(direction.lineDirection, 'ltr', 'a picture is placed physically, whatever the page direction');
  assert.ok(direction.ticks.length >= 2, 'the time axis is named: ' + JSON.stringify(direction.ticks));
  assert.deepEqual(
    direction.ticks.map(tick => tick.x),
    [...direction.ticks.map(tick => tick.x)].sort((a, b) => a - b),
    'time runs left to right in both languages',
  );
  for (const tick of direction.ticks)
    assert.ok(
      ![...tick.text.matchAll(/\p{Nd}/gu)].some(digit => !/^[0-9]$/.test(digit[0])),
      'Latin digits: ' + tick.text,
    );
  assert.equal(
    locale === 'ar' ? direction.barNearRight : direction.barNearLeft,
    true,
    'bars grow from the reading side',
  );

  // A name that is markup is text, in the picture, in the tooltip and in the table.
  const bars = page.locator("figure.amcp-chart[data-kind='spend_by_entity']").first(),
    markup = '</svg><script>alert(1)</script>';
  assert.equal(await section.locator('script').count(), 0, 'no script element came with a name');
  assert.ok(
    (await bars.locator('svg text[data-role=label]').allTextContents()).includes(markup),
    'the name is text of the picture',
  );
  assert.equal(await bars.locator('svg').count(), 1);
  assert.equal(
    await bars.locator("svg text[data-role='label'][data-native]").count(),
    5,
    'a provider’s names are marked as such',
  );

  // The keyboard: one tab stop in the picture, arrows between marks, Home and End, Escape, Tab out and back.
  const marks = bars.locator('svg [data-mark]'),
    count = await marks.count(),
    active = () =>
      page.evaluate(() => document.activeElement?.getAttribute('data-mark') ?? document.activeElement?.id ?? null),
    tipWords = () => bars.locator('.amcp-chart-tip text').allTextContents(),
    spec = rich.find(item => item.kind === 'spend_by_entity'),
    words = index => [spec.x.items[index].label, spec.series[0].value_labels[index]],
    forward = locale === 'ar' ? 'ArrowLeft' : 'ArrowRight',
    backward = locale === 'ar' ? 'ArrowRight' : 'ArrowLeft';
  assert.equal(count, spec.x.items.length, 'a mark for each entry');
  assert.equal(await bars.locator('svg [data-mark][tabindex="0"]').count(), 1, 'one tab stop');
  assert.equal(await bars.locator('.amcp-chart-tip').count(), 0, 'no tooltip until a mark is reached');
  await marks.first().focus();
  assert.equal(await active(), '0');
  assert.deepEqual(await tipWords(), words(0), 'focus shows the tooltip');
  for (const [key, expected] of [
    ['ArrowDown', 1],
    [forward, 2],
    ['ArrowUp', 1],
    [backward, 0],
    ['End', count - 1],
    ['Home', 0],
  ]) {
    await page.keyboard.press(key);
    assert.equal(await active(), String(expected), key);
    assert.deepEqual(await tipWords(), words(expected), 'the tooltip follows the focus: ' + key);
    assert.equal(await bars.locator('svg [data-mark][tabindex="0"]').count(), 1, 'one tab stop after ' + key);
  }
  assert.equal(
    await marks.nth(0).getAttribute('aria-label'),
    words(0).join(', '),
    'the mark is named by what the tooltip says',
  );
  const scrolled = await page.evaluate(() => scrollY);
  await page.keyboard.press('ArrowDown');
  assert.equal(await active(), '1');
  assert.equal(
    Math.abs((await page.evaluate(() => scrollY)) - scrolled) < 400,
    true,
    'an arrow key does not scroll the page away',
  );
  await page.keyboard.press('Escape');
  assert.equal(await bars.locator('.amcp-chart-tip').count(), 0, 'Escape dismisses the tooltip');
  assert.equal(await active(), '1', 'and leaves focus where it was');
  await page.keyboard.press('Tab');
  assert.ok(
    (await active())?.endsWith('-toggle'),
    'Tab leaves the picture for the button that opens its table: ' + (await active()),
  );
  await page.keyboard.press('Shift+Tab');
  assert.equal(await active(), '1', 'and back to the mark it left');

  // The tooltip on hover, and gone when the pointer leaves. A pointer that rests while the page scrolls under it (the keyboard
  // above brought marks into view) does not take the tooltip from the mark in focus; one that moves does.
  await page.mouse.move(1, 1);
  await marks.nth(2).hover();
  assert.deepEqual(await tipWords(), words(2), 'hover shows the tooltip of the mark');
  await page.mouse.move(1, 1);
  assert.equal(await bars.locator('.amcp-chart-tip').count(), 0, 'and the pointer leaving hides it');

  // The table is behind a button that says whether it is open; the name that is markup is a cell of it.
  const toggle = bars.locator('button[aria-controls]'),
    panel = bars.locator('.amcp-chart-table');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await panel.isVisible(), false);
  assert.equal((await toggle.innerText()).trim(), text('Show table'));
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal((await toggle.innerText()).trim(), text('Hide table'));
  assert.equal(await panel.isVisible(), true);
  assert.ok(
    (await panel.locator('th[scope=row], td').allInnerTexts()).some(cell => cell.includes(markup)),
    'the name is a cell of the table',
  );
  assert.ok(
    await panel.evaluate(
      element =>
        element.querySelector('.amcp-table-scroll').scrollWidth <=
        element.querySelector('.amcp-table-scroll').clientWidth + 1,
    ),
    'the table fits the page at this width',
  );
  assert.deepEqual(dialogs, [], 'a name that is markup opened nothing');

  // The page in this state, as a reader leaves it: a mark in focus with its tooltip, the table open.
  await marks.nth(1).focus();
  const screens = path.join(output, 'screens');
  fs.mkdirSync(screens, {recursive: true});
  if (width === 320 || width === 1280)
    await section.screenshot({path: path.join(screens, `charts-${locale}-${width}-${appearance}.png`)});
  await checks.intermediate('report charts');
  const inspected = result.intermediate_states.at(-1);
  if (locale === 'ar')
    assert.equal(
      inspected.arabic_leaks.count,
      0,
      'no sentence of AMCP’s is left in English: ' + JSON.stringify(inspected.arabic_leaks.leaks),
    );
  await toggle.click();
  result.report_charts = {
    figures: rich.length,
    drawn: pictures.filter(picture => picture.drawn).length,
    clipped_labels: 0,
    palette: appearance,
    tooltip_by_keyboard: true,
    table_by_button: true,
    id,
  };
}
