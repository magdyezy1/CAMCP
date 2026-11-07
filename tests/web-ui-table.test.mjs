// V2-WEB-02: the responsive table (web/components-table.js): the caption sits outside the scroll area, the header and first
// column stay put, columns can be hidden and the row density changed, and below a container width each row is a two-line
// card. These tests cover what a script decides (structure, ARIA, the chooser, density, the loading, empty and error
// states); the sticky layout and the card breakpoint are checked in the rendered browser cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadUI} from './helpers/web-ui-dom.mjs';

function setup() {
  const dom = loadUI(['components.js', 'components-controls.js', 'components-table.js']),
    UI = dom.run('AmcpUI');
  dom.run('AmcpUI.bind(document.body)');
  return {...dom, UI, render: markup => dom.mount(String(markup)), active: () => dom.document.activeElement};
}
const attr = (element, name) => element.getAttribute(name);
const columns = [
  {id: 'name', label: 'Campaign', native: true},
  {id: 'status', label: 'Status'},
  {id: 'spend', label: 'Spend', numeric: true},
  {id: 'clicks', label: 'Clicks', numeric: true},
];
const rows = [
  {id: 'r1', cells: {name: 'Spring <b>launch</b>', status: 'Active', spend: '1,250.50', clicks: '3,100'}},
  {id: 'r2', cells: {name: 'Summer offer', status: 'Paused', spend: '0', clicks: '0'}},
];
const draw = (UI, extra = {}) => UI.table({id: 'results', caption: 'Campaign results', columns, rows, ...extra});

test('the caption sits outside the scroll area, and the scroll area and the table are both named by it', () => {
  const {UI, render} = setup(),
    root = render(draw(UI, {description: 'Last 30 days'})),
    scroll = root.querySelector('.amcp-table-scroll'),
    caption = root.querySelector('.amcp-table-caption');
  assert.ok(!scroll.contains(caption), 'the caption does not scroll sideways with the columns');
  assert.equal(scroll.querySelectorAll('caption').length, 0);
  assert.equal(attr(scroll, 'role'), 'region');
  assert.equal(attr(scroll, 'tabindex'), '0', 'the region can be scrolled by keyboard');
  assert.equal(attr(scroll, 'aria-labelledby'), caption.id);
  assert.equal(attr(root.querySelector('table'), 'aria-labelledby'), caption.id);
  assert.equal(caption.textContent, 'Campaign results');
  assert.match(root.querySelector('.amcp-table-description').textContent, /Last 30 days/);
});

test('the table keeps its roles when it becomes cards, with a row header, column headers and labelled cells', () => {
  const {UI, render} = setup(),
    root = render(draw(UI));
  assert.equal(attr(root.querySelector('table'), 'role'), 'table');
  assert.ok(
    root.querySelectorAll('thead th').every(th => attr(th, 'role') === 'columnheader' && attr(th, 'scope') === 'col'),
  );
  const body = root.querySelectorAll('tbody tr');
  assert.equal(body.length, 2);
  assert.ok(body.every(row => attr(row, 'role') === 'row'));
  const first = body[0].children;
  assert.equal(first[0].localName, 'th');
  assert.equal(attr(first[0], 'scope'), 'row');
  assert.equal(attr(first[0], 'role'), 'rowheader');
  assert.deepEqual(
    first.slice(1).map(cell => [cell.localName, attr(cell, 'role'), attr(cell, 'data-label')]),
    [
      ['td', 'cell', 'Status'],
      ['td', 'cell', 'Spend'],
      ['td', 'cell', 'Clicks'],
    ],
  );
  assert.deepEqual(
    first.slice(2).map(cell => attr(cell, 'data-numeric')),
    ['', ''],
  );
  assert.equal(first[0].querySelectorAll('bdi').length, 1, 'a native name keeps its own direction');
  assert.equal(first[0].querySelectorAll('b').length, 0, 'values are text, never markup');
  assert.match(first[0].textContent, /Spring <b>launch<\/b>/);
  assert.equal(body[1].children[2].textContent, '0', 'zero is shown as zero');
});

test('the column chooser hides a column everywhere, keeps one visible, and Escape closes it', () => {
  const {UI, render, document, active, key} = setup(),
    root = render(draw(UI)),
    menu = root.querySelector('details.amcp-menu'),
    boxes = root.querySelectorAll('.amcp-menu-panel input[type=checkbox]'),
    changes = [];
  document.addEventListener(
    'amcp-change',
    event => event.detail.columns && changes.push(JSON.parse(JSON.stringify(event.detail.columns))),
  );
  assert.deepEqual(
    boxes.map(box => [attr(box, 'value'), box.checked]),
    [
      ['name', true],
      ['status', true],
      ['spend', true],
      ['clicks', true],
    ],
  );
  assert.equal(attr(root.querySelector('.amcp-menu-panel'), 'role'), 'group');
  const cellsOf = id => root.querySelectorAll('[data-col="' + id + '"]');
  assert.equal(cellsOf('spend').length, 3, 'a header and two cells');
  boxes[2].click();
  assert.ok(
    cellsOf('spend').every(cell => cell.hidden),
    'the header and every cell of the column are hidden',
  );
  assert.ok(cellsOf('clicks').every(cell => !cell.hidden));
  assert.deepEqual(changes.at(-1), ['name', 'status', 'clicks']);
  boxes[1].click();
  boxes[3].click();
  assert.deepEqual(changes.at(-1), ['name']);
  assert.equal(boxes[0].disabled, true, 'the last visible column cannot be hidden');
  boxes[1].click();
  assert.equal(boxes[0].disabled, false);
  menu.open = true;
  boxes[0].focus();
  const event = key(boxes[0], 'Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(menu.open, false);
  assert.equal(active(), menu.querySelector('summary'), 'focus returns to the Columns button');
});

test('the density toggle changes the rows’ height through one attribute and reports it', () => {
  const {UI, render, document} = setup(),
    root = render(draw(UI)),
    table = root.querySelector('[data-amcp=table]'),
    radios = root.querySelectorAll('input[type=radio]'),
    seen = [];
  document.addEventListener('amcp-change', event => event.detail.density && seen.push(event.detail.density));
  assert.equal(attr(table, 'data-density'), 'comfortable');
  assert.deepEqual(
    radios.map(radio => [attr(radio, 'value'), radio.checked]),
    [
      ['comfortable', true],
      ['compact', false],
    ],
  );
  radios[1].click();
  assert.equal(attr(table, 'data-density'), 'compact');
  radios[0].click();
  assert.equal(attr(table, 'data-density'), 'comfortable');
  assert.deepEqual(seen, ['compact', 'comfortable']);
  const compact = render(draw(UI, {id: 'dense', density: 'compact'}));
  assert.equal(attr(compact.querySelector('[data-amcp=table]'), 'data-density'), 'compact');
  const plain = render(draw(UI, {id: 'plain', chooser: false, densityToggle: false}));
  assert.equal(plain.querySelectorAll('details').length + plain.querySelectorAll('input[type=radio]').length, 0);
});

test('a table says when it is loading, empty or failed, and the header stays', () => {
  const {UI, render} = setup(),
    loading = render(draw(UI, {state: 'loading'})),
    scroll = loading.querySelector('.amcp-table-scroll');
  assert.equal(attr(scroll, 'aria-busy'), 'true');
  assert.equal(loading.querySelectorAll('tbody tr').length, 5, 'five skeleton rows');
  assert.equal(loading.querySelectorAll('thead th').length, 4);
  assert.equal(loading.querySelectorAll('.amcp-visually-hidden').filter(el => el.textContent === 'Loading…').length, 1);
  const empty = render(
      draw(UI, {
        rows: [],
        empty: {
          title: 'No campaigns',
          body: 'None match these filters.',
          action: {label: 'Clear filters', attrs: {'data-clear': ''}},
        },
      }),
    ),
    cell = empty.querySelector('tbody td');
  assert.equal(empty.querySelectorAll('tbody tr').length, 1);
  assert.equal(attr(cell, 'colspan'), '4');
  assert.equal(empty.querySelectorAll('button[data-clear]').length, 1, 'an empty table names one next action');
  assert.throws(() => draw(UI, {rows: []}), /AMCP_UI_TABLE_NEEDS_EMPTY_STATE/);
  const failed = render(
    draw(UI, {
      state: 'error',
      error: {
        title: 'The table could not load',
        body: 'Try again.',
        retry: {label: 'Try again', attrs: {'data-retry': ''}},
      },
    }),
  );
  assert.equal(attr(failed.querySelector('tbody td'), 'colspan'), '4');
  assert.equal(failed.querySelectorAll('[role=alert]').length, 1);
  assert.equal(failed.querySelectorAll('button[data-retry]').length, 1);
  assert.equal(failed.querySelectorAll('thead th').length, 4);
});

test('a table needs an id, a caption and columns', () => {
  const {UI} = setup();
  assert.throws(() => UI.table({caption: 'x', columns, rows}), /AMCP_UI_ID/);
  assert.throws(() => UI.table({id: 'x', columns, rows}), /AMCP_UI_CAPTION/);
  assert.throws(() => UI.table({id: 'x', caption: 'x', columns: [], rows}), /AMCP_UI_COLUMNS/);
  assert.throws(() => draw(setup().UI, {state: 'confused'}), /AMCP_UI_STATE/);
});
