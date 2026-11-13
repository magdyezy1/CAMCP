// V2-EXP-01: the charts section of the report page (web/charts.js) in the test DOM: what the script decides. Every chart of a
// report is a figure with a title, a takeaway and notes in the page's language; a picture that is named, whose marks can all be
// reached from the keyboard with one tab stop (a roving tabindex), whose tooltip says what the mark's name says; a table behind
// a button that says whether it is open; and a provider's name that is markup is text, marked as the provider's own words.
// The layout itself is proved equal to the server's in tests/report-chart-parity.test.mjs; what a real browser draws (colours
// in both themes, focus rings, 320 px, axe) is the rendered case of the `granular-reporting` kind (tests/fixtures/report-charts-browser.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {loadUI} from './helpers/web-ui-dom.mjs';
import {chartMessageText} from '../dist/src/report-chart-theme.js';
import {artifactLocale} from '../dist/src/report-localization.js';
import {campaigns, charts, hostile, of, specimens} from './helpers/chart-specimens.mjs';
import {chartRow} from './helpers/chart-rows.mjs';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character],
  );
const isolates = new RegExp(`[${String.fromCodePoint(0x2068)}${String.fromCodePoint(0x2069)}]`, 'g');
const files = ['components.js', 'components-table.js', 'report-quality.js', 'charts.js'];

/** The page's scripts in the test DOM, in one language. The DOM has no SVG parts of its own: they are plain elements here. */
function setup(language = 'en') {
  const dom = loadUI(files, {esc, catalog});
  dom.run(
    `uiLocale=${JSON.stringify(language)};uiMessages=new Map(${language === 'ar' ? 'Object.entries(catalog)' : '[]'})`,
  );
  const prototype = Object.getPrototypeOf(dom.document.createElement('div'));
  prototype.replaceChildren ??= function (...nodes) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  };
  prototype.getBBox ??= () => ({x: 40, y: 60, width: 80, height: 14});
  dom.document.createElementNS = (namespace, name) => dom.document.createElement(name);
  const mount = list => {
    const root = dom.mount('<section id="report-charts"></section>').querySelector('#report-charts');
    dom.run('mountReportCharts').call(null, root, list);
    return root;
  };
  return {...dom, mount, text: key => (language === 'ar' ? catalog[key] : key)};
}
/** The figure of the first chart of a kind. */
const figureOf = (root, kind) => root.querySelector(`figure[data-kind=${kind}]`);
const marksOf = figure => figure.querySelectorAll('svg [data-mark]');
const tabStops = figure => marksOf(figure).filter(mark => mark.getAttribute('tabindex') === '0');
const tip = figure => figure.querySelector('.amcp-chart-tip');
const tipWords = figure =>
  tip(figure)
    ?.querySelectorAll('text')
    .map(line => line.textContent) ?? null;
const shapes = specimens();

test('a report with charts has a heading and a figure for each chart: a title, its takeaway and a picture that is named', () => {
  const {mount, text} = setup(),
    root = mount([shapes.tiles, shapes.line, shapes.bars, shapes.cost, shapes['folded-stack']]);
  assert.equal(root.querySelector('h2').textContent, 'Charts');
  const figures = root.querySelectorAll('figure');
  assert.deepEqual(
    figures.map(figure => figure.dataset.kind),
    ['kpi', 'trend', 'spend_by_entity', 'cost_vs_target', 'spend_by_objective'],
  );
  for (const figure of figures) {
    const caption = figure.querySelector('figcaption'),
      svg = figure.querySelector('svg');
    assert.ok(caption.querySelector('h3').textContent, 'a title');
    assert.equal(svg.getAttribute('role'), 'group');
    assert.equal(
      svg.getAttribute('aria-label'),
      caption.querySelector('h3').textContent,
      'the picture is named by its title',
    );
    assert.ok(svg.getAttribute('viewBox').startsWith('0 0 '), 'a viewBox of its own scene');
  }
  assert.equal(
    figureOf(root, 'spend_by_entity').querySelector('.amcp-chart-takeaway').textContent,
    shapes.bars.takeaway.text,
  );
  assert.equal(text('Charts'), 'Charts');
});

test('a chart that is not drawn keeps its notes and its table, and has no picture', () => {
  const {mount} = setup(),
    [one] = of(charts(campaigns([5])), 'spend_by_entity');
  assert.equal(one.drawn, false);
  const figure = figureOf(mount([one]), 'spend_by_entity');
  assert.equal(figure.querySelector('svg'), null);
  assert.deepEqual(
    figure.querySelectorAll('.amcp-chart-notes li').map(item => item.textContent),
    one.notes.map(note => note.text),
  );
  assert.ok(figure.querySelector('table'), 'the table is there, behind its button');
  assert.equal(figure.querySelector('.amcp-chart-table').hidden, true);
});

test('every mark is reachable by keyboard with one tab stop: arrow keys move between marks, Home and End jump, Escape dismisses', () => {
  const {mount, key, document} = setup(),
    figure = figureOf(mount([shapes.bars]), 'spend_by_entity'),
    marks = marksOf(figure);
  assert.equal(marks.length, shapes.bars.x.items.length, 'a mark for each bar');
  assert.equal(tabStops(figure).length, 1, 'one tab stop in the picture');
  assert.equal(tabStops(figure)[0], marks[0]);
  assert.equal(tip(figure), null, 'no tooltip until a mark is in focus');
  marks[0].focus();
  assert.equal(document.activeElement, marks[0]);
  assert.deepEqual(
    tipWords(figure),
    [shapes.bars.x.items[0].label, shapes.bars.series[0].value_labels[0]],
    'focus shows the tooltip of the mark',
  );
  for (const [pressed, expected] of [
    ['ArrowDown', 1],
    ['ArrowRight', 2],
    ['ArrowUp', 1],
    ['ArrowLeft', 0],
    ['ArrowLeft', 0],
    ['End', marks.length - 1],
    ['ArrowDown', marks.length - 1],
    ['Home', 0],
  ]) {
    const event = key(document.activeElement, pressed);
    assert.equal(event.defaultPrevented, true, pressed + ' is handled, so the page does not scroll');
    assert.equal(document.activeElement, marks[expected], pressed + ' moves focus to mark ' + expected);
    assert.deepEqual(tabStops(figure), [marks[expected]], 'the tab stop moves with the focus');
  }
  assert.ok(tip(figure), 'the tooltip follows the focus');
  key(document.activeElement, 'Escape');
  assert.equal(tip(figure), null, 'Escape dismisses the tooltip');
  assert.equal(document.activeElement, marks[0], 'and leaves focus where it was');
  assert.equal(key(document.activeElement, 'a').defaultPrevented, false, 'other keys are left alone');
  // A shortcut of the browser's is not the picture's: Alt+Left is Back, Ctrl+Home scrolls the page.
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey'])
    for (const pressed of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      const before = document.activeElement,
        event = key(before, pressed, {[modifier]: true});
      assert.equal(event.defaultPrevented, false, modifier + ' ' + pressed);
      assert.equal(document.activeElement, before);
    }
});

test('the tooltip says what the mark says: its entry, its value and where it comes from', () => {
  const {mount} = setup(),
    spec = shapes.bars,
    figure = figureOf(mount([spec]), 'spend_by_entity'),
    marks = marksOf(figure);
  marks.forEach((mark, index) => {
    mark.focus();
    const words = tipWords(figure),
      entry = spec.x.items[index];
    assert.equal(words[0], entry.label);
    assert.equal(words[1], spec.series[0].value_labels[index]);
    assert.equal(mark.getAttribute('aria-label'), words.join(', '), 'the accessible name is the tooltip');
    assert.equal(mark.getAttribute('role'), 'img');
  });
});

test('an entry with no bar to see is reached like the others, and a cost says its target in its tooltip', () => {
  for (const language of ['en', 'ar']) {
    const {mount, text} = setup(language),
      zero = of(charts(campaigns([40, 0])), 'spend_by_entity')[0],
      figure = figureOf(mount([zero]), 'spend_by_entity'),
      rows = marksOf(figure);
    assert.equal(zero.series[0].values[1], '0', 'a campaign that spent nothing is a value of zero');
    assert.equal(rows.length, 2, 'a mark for the zero as well');
    rows[1].focus();
    assert.deepEqual(tipWords(figure), [zero.x.items[1].label, zero.series[0].value_labels[1]]);
    const cost = figureOf(mount([shapes.cost]), 'cost_vs_target'),
      withTarget = marksOf(cost)[0];
    withTarget.focus();
    const target = shapes.cost.series[0].target_labels.find(Boolean);
    assert.ok(target, 'the specimen has a target');
    assert.ok(
      tipWords(cost).includes(text('Target') + ': ' + target),
      'the tooltip names the target: ' + tipWords(cost),
    );
    assert.ok(withTarget.getAttribute('aria-label').includes(target));
  }
});

test('hovering a mark shows its tooltip and leaving the picture hides it', () => {
  const {mount, FakeEvent} = setup(),
    figure = figureOf(mount([shapes.bars]), 'spend_by_entity'),
    marks = marksOf(figure);
  marks[2].dispatchEvent(new FakeEvent('mousemove', {movementX: 4, movementY: 1}));
  assert.ok(tip(figure));
  assert.deepEqual(tipWords(figure), [shapes.bars.x.items[2].label, shapes.bars.series[0].value_labels[2]]);
  assert.deepEqual(tabStops(figure), [marks[0]], 'the pointer does not move the keyboard’s place');
  figure.querySelector('svg').dispatchEvent(new FakeEvent('mouseleave', {bubbles: false}));
  assert.equal(tip(figure), null);
});

test('a pointer at rest does not take the tooltip from the mark in focus when the page scrolls under it', () => {
  const {mount, key, document, FakeEvent} = setup(),
    figure = figureOf(mount([shapes.bars]), 'spend_by_entity'),
    marks = marksOf(figure);
  marks[0].focus();
  key(document.activeElement, 'ArrowDown');
  assert.deepEqual(tipWords(figure), [shapes.bars.x.items[1].label, shapes.bars.series[0].value_labels[1]]);
  // The browser reports the mark that now lies under a pointer that did not move: no movement, so not the pointer's doing.
  marks[0].dispatchEvent(new FakeEvent('mousemove', {movementX: 0, movementY: 0}));
  assert.deepEqual(tipWords(figure), [shapes.bars.x.items[1].label, shapes.bars.series[0].value_labels[1]]);
  // A browser that reports no movement at all still has the hover.
  marks[3].dispatchEvent(new FakeEvent('mousemove'));
  assert.deepEqual(tipWords(figure), [shapes.bars.x.items[3].label, shapes.bars.series[0].value_labels[3]]);
});

test('in Arabic every line of a tooltip is set against the right edge of its box, in English against the left', () => {
  for (const language of ['en', 'ar']) {
    const {mount} = setup(language),
      figure = figureOf(mount([shapes.cost]), 'cost_vs_target'),
      mark = marksOf(figure)[0];
    mark.focus();
    const box = tip(figure).querySelector('rect'),
      left = Number(box.getAttribute('x')),
      right = left + Number(box.getAttribute('width')),
      lines = tip(figure).querySelectorAll('text');
    assert.ok(lines.length >= 3, 'a name, a cost and a target');
    for (const line of lines) {
      const x = Number(line.getAttribute('x')),
        anchor = line.getAttribute('text-anchor'),
        rtl = line.getAttribute('direction') === 'rtl';
      if (language === 'en') assert.deepEqual([x, anchor], [left + 8, 'start'], line.textContent);
      // `start` is the right edge of a line that reads right to left, and `end` the right edge of one that reads left to right.
      else assert.deepEqual([x, anchor], [right - 8, rtl ? 'start' : 'end'], line.textContent);
    }
    if (language === 'ar')
      assert.ok(
        lines.some(line => line.getAttribute('direction') === 'rtl'),
        'the target line reads right to left',
      );
  }
});

test('in Arabic the bars read right to left, so the arrow keys follow the picture; a line keeps time left to right', () => {
  const {mount, key, document} = setup('ar'),
    bars = figureOf(mount([shapes.bars]), 'spend_by_entity'),
    marks = marksOf(bars);
  marks[0].focus();
  key(document.activeElement, 'ArrowLeft');
  assert.equal(document.activeElement, marks[1], 'Left is forward where the bars grow from the right');
  key(document.activeElement, 'ArrowRight');
  assert.equal(document.activeElement, marks[0]);
  const line = setup('ar'),
    points = marksOf(figureOf(line.mount([shapes.line]), 'trend'));
  assert.ok(points.length >= 2, 'the line is drawn in Arabic too, a mark for each period');
  points[0].focus();
  line.key(line.document.activeElement, 'ArrowRight');
  assert.equal(
    line.document.activeElement,
    points[1],
    'time runs left to right in Arabic, so Right is the next period',
  );
});

test('a week with one unknown campaign is a hollow mark off the line, not a dip: the page keeps it out of the line and says how many rows it has', () => {
  for (const language of ['en', 'ar']) {
    const {mount, run} = setup(language),
      spec = shapes['short-line'],
      figure = figureOf(mount([spec]), 'trend'),
      svg = figure.querySelector('svg'),
      short = spec.series[0].short.findIndex(Boolean);
    assert.ok(short >= 0, 'the specimen has a period calculated from some of its rows');
    const hollow = svg.querySelectorAll('circle[data-role=hollow]');
    assert.equal(hollow.length, 1, 'one hollow mark');
    // The line is drawn through whole periods only: its points are the known ones that are not short, and none is the short one's.
    const whole = spec.series[0].values.filter((value, index) => value !== null && !spec.series[0].short[index]).length,
      drawn = svg.querySelectorAll('polyline').flatMap(line => line.getAttribute('points').split(' '));
    assert.equal(svg.querySelectorAll('circle[data-role=point]').length, whole, 'a solid mark for each whole period');
    assert.ok(drawn.length <= whole, 'the line has no vertex at the short period');
    const marks = marksOf(figure),
      at = marks.findIndex(mark => mark.getAttribute('data-role') === 'hollow');
    assert.ok(at >= 0, 'the hollow mark can be reached by keyboard');
    marks[at].focus();
    const counts = run('reportCoverageLabel')({
      known_rows: spec.series[0].short[short].known,
      total_rows: spec.series[0].short[short].total,
      basis: 'report_rows',
    });
    assert.ok(counts, 'the page words the coverage');
    assert.ok(tipWords(figure).includes(counts), 'the tooltip says how many rows the period has: ' + tipWords(figure));
  }
});

test('the table is behind a button that says whether it is open, and its words are the page language’s', () => {
  for (const language of ['en', 'ar']) {
    const {mount, text} = setup(language),
      figure = figureOf(mount([shapes.bars]), 'spend_by_entity'),
      toggle = figure.querySelector('button'),
      panel = figure.querySelector('.amcp-chart-table');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(toggle.getAttribute('aria-controls'), panel.id);
    assert.equal(toggle.textContent.trim(), text('Show table'));
    assert.equal(panel.hidden, true);
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.textContent.trim(), text('Hide table'));
    assert.equal(panel.hidden, false);
    const table = panel.querySelector('table');
    assert.ok(
      table.querySelectorAll('tbody tr').length >= shapes.bars.table.rows.length,
      'a real table, a row for each entry',
    );
    assert.ok(table.querySelectorAll('thead th').length >= 2);
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(panel.hidden, true);
  }
});

test('a name from a provider that is markup is text everywhere on the page: the picture, the tooltip, the table', () => {
  const {mount, document} = setup(),
    hostileName = hostile[4],
    figure = figureOf(mount([shapes.bars]), 'spend_by_entity'),
    svg = figure.querySelector('svg');
  assert.equal(figure.querySelectorAll('script').length, 0);
  assert.equal(document.querySelectorAll('script').length, 0, 'no script element anywhere in the page');
  const names = svg.querySelectorAll('text[data-role=label]').map(item => item.textContent);
  assert.ok(names.includes(hostileName), 'the name is a text of the picture, whole');
  assert.equal(figure.querySelectorAll('svg').length, 1, 'a closing tag in a name closes nothing');
  assert.ok(figure.outerHTML.includes('&lt;/svg&gt;&lt;script&gt;'), 'the markup is written as text');
  marksOf(figure)[4].focus();
  assert.equal(tipWords(figure)[0], hostileName);
  assert.equal(
    figure
      .querySelectorAll('.amcp-chart-table td, .amcp-chart-table th')
      .some(cell => cell.textContent === hostileName),
    true,
    'and a cell of the table',
  );
});

test('a provider’s name is marked as the provider’s own words, an Other that AMCP wrote is not', () => {
  const {mount} = setup('ar'),
    figure = figureOf(mount([shapes['folded-bars']]), 'spend_by_entity'),
    labels = figure.querySelectorAll('svg text[data-role=label]');
  assert.equal(labels.length, shapes['folded-bars'].x.items.length);
  shapes['folded-bars'].x.items.forEach((item, index) =>
    assert.equal(labels[index].hasAttribute('data-native'), !item.other, item.label),
  );
  const first = marksOf(figure)[0];
  first.focus();
  assert.equal(
    figure.querySelector('.amcp-chart-tip text').hasAttribute('data-native'),
    true,
    'the tooltip names the entry',
  );
  assert.equal(
    figure.querySelectorAll('.amcp-chart-table th bdi').length > 0,
    true,
    'a name in the table keeps its own direction',
  );
  // A stacked bar's series are names AMCP wrote (objectives): they are not marked.
  const stack = figureOf(setup('ar').mount([shapes.stack]), 'spend_by_objective');
  assert.equal(stack.querySelectorAll('svg text[data-role=legend-text][data-native]').length, 0);
});

test('a takeaway that names an entity puts the name in a bdi of its own, marked as data; the sentence around it is AMCP’s', () => {
  for (const language of ['en', 'ar']) {
    const {mount, run} = setup(language),
      root = mount([shapes.bars]),
      takeaway = figureOf(root, 'spend_by_entity').querySelector('.amcp-chart-takeaway'),
      names = takeaway.querySelectorAll('bdi[data-native]');
    assert.equal(names.length, 1);
    assert.equal(names[0].textContent, shapes.bars.takeaway.params.name);
    assert.ok(takeaway.querySelectorAll('bdi').length >= 3, 'every value of the sentence is isolated');
    // The words are the artifacts' words: the same sentence, the values isolated by elements instead of control characters.
    const locale = artifactLocale({artifact_language: language});
    assert.equal(takeaway.textContent, chartMessageText(shapes.bars.takeaway, locale).replace(isolates, ''));
    assert.equal(run('uiLocale'), language);
  }
});

test('notes are said in the page language, with their values isolated; a coverage note is re-worded with the page’s own words', () => {
  for (const language of ['en', 'ar']) {
    const {mount} = setup(language),
      spec = of(charts(campaigns([100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 5, 4])), 'spend_by_entity')[0],
      figure = figureOf(mount([spec]), 'spend_by_entity'),
      locale = artifactLocale({artifact_language: language}),
      notes = figure.querySelectorAll('.amcp-chart-notes li');
    assert.equal(notes.length, spec.notes.length);
    spec.notes.forEach((note, index) => {
      if (note.kind === 'message')
        assert.equal(notes[index].textContent, chartMessageText(note, locale).replace(isolates, ''));
      else assert.ok(notes[index].textContent.length > 0);
    });
  }
});

test('the table of a chart holds every entry in the page language, numbers right-aligned as numbers', () => {
  const {mount, text} = setup('ar'),
    figure = figureOf(mount([shapes.cost]), 'cost_vs_target'),
    table = figure.querySelector('table'),
    headings = table.querySelectorAll('thead th').map(heading => heading.textContent);
  assert.equal(headings[0], text('Campaign'));
  assert.ok(
    headings.includes(text('Cost per result') + ' (USD)') ||
      headings.some(heading => heading.includes(text('Cost per result'))),
  );
  assert.equal(table.querySelectorAll('tbody tr').length, shapes.cost.table.rows.length);
  assert.ok(
    table.querySelectorAll('tbody td').some(cell => cell.getAttribute('data-numeric') !== null),
    'numeric cells are marked as numbers',
  );
});

test('the report builder lists a box for each chart kind the server draws; a switched-off chart is unchecked and saved as such', () => {
  const dom = loadUI([...files], {esc, catalog});
  const host = dom.mount('<div id="report-chart-settings"></div>').querySelector('#report-chart-settings'),
    kinds = [
      {id: 'kpi', label: 'Key figures'},
      {id: 'trend', label: 'Spend and results over time'},
      {id: 'top_ads', label: 'Top ads by result'},
    ];
  dom.run('mountReportChartOptions')(host, {charts: {disabled: ['trend']}}, {chart_kinds: kinds});
  const boxes = host.querySelectorAll('input[data-report-chart]');
  assert.deepEqual(
    boxes.map(box => [box.getAttribute('data-report-chart'), box.hasAttribute('checked')]),
    [
      ['kpi', true],
      ['trend', false],
      ['top_ads', true],
    ],
  );
  assert.equal(host.querySelectorAll('label').length, 3, 'each box is labelled by its own words');
  assert.equal(host.querySelector('details').getAttribute('id'), 'report-chart-options');
  // A bootstrap with no chart kinds (an older server) leaves the form as it was.
  const empty = dom.mount('<div id="other"></div>').querySelector('#other');
  dom.run('mountReportChartOptions')(empty, {}, {});
  assert.equal(empty.childNodes.length, 0);
});

test('the charts take the place of the small spend line on each summary only when a trend chart is drawn', () => {
  const {run} = setup(),
    replace = report => run('reportChartsReplaceSparklines')(report);
  assert.equal(replace({charts: [shapes.line]}), true);
  assert.equal(replace({charts: [shapes.bars]}), false);
  assert.equal(replace({charts: [{...shapes.line, drawn: false}]}), false);
  assert.equal(replace({}), false);
  assert.equal(replace(null), false);
});

test('a snapshot without charts has no section to fill: nothing is mounted and nothing fails', () => {
  const {mount} = setup();
  assert.equal(mount([]).childNodes.length, 0);
  assert.equal(mount(undefined).childNodes.length, 0);
});

test('every chart of a report with several currencies keeps its own picture: no figure draws two units', () => {
  const rows = [
      ...campaigns([100, 50]),
      chartRow('e1', '30', '1', {currency: 'EUR', account_id: '200'}),
      chartRow('e2', '20', '1', {currency: 'EUR', account_id: '200'}),
    ],
    specs = of(charts(rows), 'spend_by_entity');
  assert.ok(specs.length >= 2, 'a chart for each currency');
  const {mount} = setup(),
    figures = mount(specs).querySelectorAll('figure');
  assert.equal(figures.length, specs.length);
  figures.forEach((figure, index) => {
    // The table names the currency of its amounts in its heading ("Spend (EUR)"): one currency in a chart, its own.
    const currencies = figure
      .querySelectorAll('.amcp-chart-table thead th')
      .map(heading => heading.textContent.match(/\(([A-Z]{3})\)/)?.[1])
      .filter(Boolean);
    assert.deepEqual([...new Set(currencies)], [specs[index].context.currency], 'one currency, the chart’s own');
  });
});
