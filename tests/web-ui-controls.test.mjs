// V2-WEB-02: segmented control, tabs, searchable combobox and the tri-state tree (web/components-controls.js): state,
// keyboard handling and ARIA, read back from markup that html`…` wrote into the test DOM and driven by real key events.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadUI} from './helpers/web-ui-dom.mjs';

function setup() {
  const dom = loadUI(['components.js', 'components-controls.js']),
    UI = dom.run('AmcpUI');
  dom.run('AmcpUI.bind(document.body)');
  const json = value => JSON.parse(JSON.stringify(value));
  return {
    ...dom,
    UI,
    json,
    render: markup => dom.mount(String(markup)),
    active: () => dom.document.activeElement,
    /** Types into a field the way a person does: the value changes, then an input event fires. */
    type(field, text) {
      field.value = text;
      field.dispatchEvent(new dom.FakeEvent('input'));
    },
  };
}
const attr = (element, name) => element.getAttribute(name);

test('a segmented control is a labelled radio group of native radios, one checked, disabled ones inert', () => {
  const {UI, render} = setup(),
    root = render(
      UI.segmented({
        name: 'density',
        label: 'Row density',
        value: 'compact',
        options: [
          {value: 'comfortable', label: 'Comfortable'},
          {value: 'compact', label: 'Compact'},
          {value: 'dense', label: 'Dense', disabled: true},
        ],
      }),
    ),
    group = root.querySelector('[role=radiogroup]');
  assert.equal(attr(group, 'aria-label'), 'Row density');
  const radios = root.querySelectorAll('input[type=radio]');
  assert.deepEqual(
    radios.map(radio => [radio.name, attr(radio, 'value'), radio.checked, radio.disabled]),
    [
      ['density', 'comfortable', false, false],
      ['density', 'compact', true, false],
      ['density', 'dense', false, true],
    ],
  );
  assert.equal(root.querySelectorAll('label.amcp-segment').length, 3, 'each radio is inside its label');
  assert.throws(
    () => UI.segmented({name: 'x', label: 'X', options: [{value: 'a', label: 'A'}], value: 'b'}),
    /AMCP_UI_VALUE/,
  );
});

test('tabs: roving tabindex, a tab for each panel, only the selected panel shown', () => {
  const {UI, render} = setup(),
    root = render(
      UI.tabs({
        id: 'views',
        label: 'Report views',
        selected: 'ads',
        tabs: [
          {id: 'overview', label: 'Overview', panel: 'Overview body'},
          {id: 'ads', label: 'Ads', panel: 'Ads body'},
          {id: 'quality', label: 'Data quality', panel: 'Quality body', disabled: true},
        ],
      }),
    ),
    list = root.querySelector('[role=tablist]'),
    tabs = root.querySelectorAll('[role=tab]'),
    panels = root.querySelectorAll('[role=tabpanel]');
  assert.equal(attr(list, 'aria-label'), 'Report views');
  assert.equal(attr(list, 'aria-orientation'), 'horizontal');
  assert.deepEqual(
    tabs.map(tab => attr(tab, 'aria-selected')),
    ['false', 'true', 'false'],
  );
  assert.deepEqual(
    tabs.map(tab => attr(tab, 'tabindex')),
    ['-1', '0', '-1'],
  );
  assert.equal(tabs[2].disabled, true);
  tabs.forEach((tab, index) => {
    assert.equal(attr(tab, 'aria-controls'), panels[index].id);
    assert.equal(attr(panels[index], 'aria-labelledby'), tab.id);
  });
  assert.deepEqual(
    panels.map(panel => panel.hidden),
    [true, false, true],
  );
  assert.equal(attr(panels[1], 'tabindex'), '0', 'a panel without a focusable control can still be reached');
});

test('tab keys: arrows move and wrap, Home and End jump, disabled tabs are skipped, right-to-left swaps the arrows', () => {
  const {UI, json} = setup(),
    next = (key, index, extra = {}) =>
      json(UI.tabs.next({key, index, count: 4, enabled: [true, true, false, true], ...extra}));
  assert.equal(next('ArrowRight', 0), 1);
  assert.equal(next('ArrowRight', 1), 3, 'the disabled tab is skipped');
  assert.equal(next('ArrowRight', 3), 0, 'wraps to the first');
  assert.equal(next('ArrowLeft', 0), 3, 'wraps to the last');
  assert.equal(next('ArrowLeft', 3), 1);
  assert.equal(next('Home', 3), 0);
  assert.equal(next('End', 0), 3);
  assert.equal(next('ArrowRight', 0, {rtl: true}), 3, 'in right-to-left the right arrow goes to the previous tab');
  assert.equal(next('ArrowLeft', 0, {rtl: true}), 1);
  assert.equal(next('ArrowDown', 0), null, 'a horizontal list ignores the vertical arrows');
  assert.equal(next('ArrowDown', 0, {orientation: 'vertical'}), 1);
  assert.equal(next('ArrowUp', 0, {orientation: 'vertical'}), 3);
  assert.equal(next('a', 0), null);
});

test('tabs in the page: arrow keys move focus and (by default) select, clicks select, manual activation waits for Enter', () => {
  const {UI, render, key, active, document} = setup(),
    root = render(
      UI.tabs({
        id: 't',
        label: 'Views',
        tabs: [
          {id: 'a', label: 'A', panel: 'PA'},
          {id: 'b', label: 'B', panel: 'PB'},
          {id: 'c', label: 'C', panel: 'PC'},
        ],
      }),
    ),
    tabs = root.querySelectorAll('[role=tab]'),
    panels = root.querySelectorAll('[role=tabpanel]'),
    changes = [];
  document.addEventListener('amcp-change', event => changes.push(event.detail.id));
  tabs[0].focus();
  const event = key(tabs[0], 'ArrowRight');
  assert.equal(event.defaultPrevented, true);
  assert.equal(active(), tabs[1]);
  assert.deepEqual(
    tabs.map(tab => attr(tab, 'aria-selected')),
    ['false', 'true', 'false'],
  );
  assert.deepEqual(
    tabs.map(tab => attr(tab, 'tabindex')),
    ['-1', '0', '-1'],
  );
  assert.deepEqual(
    panels.map(panel => panel.hidden),
    [true, false, true],
  );
  key(tabs[1], 'End');
  assert.equal(active(), tabs[2]);
  tabs[0].click();
  assert.deepEqual(
    panels.map(panel => panel.hidden),
    [false, true, true],
  );
  assert.deepEqual(changes, ['b', 'c', 'a']);
  const manual = render(
      UI.tabs({
        id: 'm',
        label: 'Manual',
        activation: 'manual',
        tabs: [
          {id: 'x', label: 'X', panel: 'PX'},
          {id: 'y', label: 'Y', panel: 'PY'},
        ],
      }),
    ),
    mt = manual.querySelectorAll('[role=tab]');
  mt[0].focus();
  key(mt[0], 'ArrowRight');
  assert.equal(active(), mt[1]);
  assert.equal(attr(mt[1], 'aria-selected'), 'false', 'focus moved but nothing is selected until Enter or Space');
  mt[1].click();
  assert.equal(attr(mt[1], 'aria-selected'), 'true');
  assert.throws(() => UI.tabs({id: 'z', label: 'Z', tabs: []}), /AMCP_UI_TABS/);
});

test('tabs in a right-to-left page: the right arrow goes to the previous tab', () => {
  const {UI, mount, key, active} = setup(),
    root = mount('<div dir="rtl" id="rtl"></div>');
  root.querySelector('#rtl').innerHTML = String(
    UI.tabs({
      id: 'r',
      label: 'Views',
      tabs: [
        {id: 'a', label: 'A', panel: 'PA'},
        {id: 'b', label: 'B', panel: 'PB'},
      ],
    }),
  );
  const tabs = root.querySelectorAll('[role=tab]');
  tabs[0].focus();
  key(tabs[0], 'ArrowLeft');
  assert.equal(active(), tabs[1], 'left is forward in right-to-left');
});

const accounts = [
  {value: 'a1', label: 'Atlas Outdoor', description: 'Meta · 1001'},
  {value: 'a2', label: 'Atlas Cafe', description: 'TikTok · 2002'},
  {value: 'a3', label: 'Zahra Studio', description: 'Google Ads · 3003'},
  {value: 'a4', label: 'Café Noor', description: 'Meta · 4004'},
  {value: 'a5', label: 'مطعم الأمل', description: 'Snapchat · 5005'},
];

test('combobox search folds case and accents, ranks prefixes first, limits the list and says how many were left out', () => {
  const {UI, json} = setup(),
    find = (query, limit = 50) => json(UI.combobox.filter(accounts, query, limit));
  assert.deepEqual(
    find('atlas').items.map(item => item.value),
    ['a1', 'a2'],
  );
  assert.deepEqual(
    find('CAFE').items.map(item => item.value),
    ['a4', 'a2'],
    'a label that starts with it ranks before one that only contains it; accents are folded',
  );
  assert.deepEqual(
    find('1001').items.map(item => item.value),
    ['a1'],
    'the description is searched too',
  );
  assert.deepEqual(find('').items.length, 5);
  assert.deepEqual(find('nothing'), {items: [], total: 0});
  assert.deepEqual(find('a', 2), {items: find('a', 5).items.slice(0, 2), total: find('a', 5).total});
  assert.equal(find('a', 2).total, find('a', 5).items.length, 'total counts every match, not the ones shown');
  assert.deepEqual(
    find('الأمل').items.map(item => item.value),
    ['a5'],
  );
  assert.deepEqual(json(UI.combobox.segments('Atlas Cafe', 'cafe')), [
    {text: 'Atlas ', match: false},
    {text: 'Cafe', match: true},
  ]);
  assert.deepEqual(json(UI.combobox.segments('Café Noor', 'cafe')), [
    {text: 'Café', match: true},
    {text: ' Noor', match: false},
  ]);
  assert.deepEqual(json(UI.combobox.segments('Atlas', '')), [{text: 'Atlas', match: false}]);
});

function comboboxPage(options = accounts, extra = {}) {
  const page = setup(),
    root = page.render(page.UI.combobox({id: 'acct', label: 'Account', hint: 'Type to search.', ...extra.markup})),
    host = root.querySelector('[data-amcp=combobox]'),
    chosen = [];
  const controller = page.UI.combobox.mount(host, {
    options,
    onSelect: option => chosen.push(page.json(option)),
    ...extra.mount,
  });
  const input = host.querySelector('input[role=combobox]'),
    list = host.querySelector('[role=listbox]');
  return {...page, host, input, list, controller, chosen, options: () => list.querySelectorAll('[role=option]')};
}

test('combobox markup follows the ARIA combobox pattern with a listbox popup', () => {
  const {host, input, list} = comboboxPage();
  assert.equal(attr(input, 'role'), 'combobox');
  assert.equal(attr(input, 'aria-autocomplete'), 'list');
  assert.equal(attr(input, 'aria-expanded'), 'false');
  assert.equal(attr(input, 'aria-controls'), list.id);
  assert.equal(attr(input, 'aria-haspopup'), 'listbox');
  assert.equal(attr(input, 'autocomplete'), 'off');
  assert.equal(attr(input, 'aria-describedby'), 'acct-hint');
  assert.equal(host.querySelector('label').getAttribute('for'), 'acct');
  assert.equal(attr(list, 'aria-label'), 'Account');
  assert.equal(list.closest('.amcp-popup').hidden, true);
  assert.equal(attr(host.querySelector('[role=status]'), 'aria-live'), 'polite');
});

test('combobox keyboard: typing filters and opens, arrows move the active option, Enter chooses, Escape closes then clears', () => {
  const page = comboboxPage(),
    {input, host, chosen, options, key, active, type} = page;
  input.focus();
  type(input, 'atl');
  assert.equal(attr(input, 'aria-expanded'), 'true');
  assert.deepEqual(
    options().map(option => option.textContent),
    ['Atlas OutdoorMeta · 1001', 'Atlas CafeTikTok · 2002'],
  );
  assert.equal(attr(input, 'aria-activedescendant'), null, 'nothing is active until an arrow key');
  assert.equal(host.querySelector('[role=status]').textContent, '2 results');
  key(input, 'ArrowDown');
  assert.equal(attr(input, 'aria-activedescendant'), options()[0].id);
  assert.deepEqual(
    options().map(option => attr(option, 'aria-selected')),
    ['true', 'false'],
  );
  key(input, 'ArrowDown');
  key(input, 'ArrowDown');
  assert.equal(attr(input, 'aria-activedescendant'), options()[0].id, 'wraps past the end');
  key(input, 'ArrowUp');
  assert.equal(attr(input, 'aria-activedescendant'), options()[1].id, 'wraps before the start');
  assert.equal(active(), input, 'focus stays in the text box; the option is active by reference');
  const enter = key(input, 'Enter');
  assert.equal(enter.defaultPrevented, true, 'Enter chooses; it does not submit a form');
  assert.equal(input.value, 'Atlas Cafe');
  assert.equal(attr(input, 'aria-expanded'), 'false');
  assert.deepEqual(chosen, [{value: 'a2', label: 'Atlas Cafe', description: 'TikTok · 2002'}]);
  assert.equal(host.querySelector('input[type=hidden]').value, 'a2');
  type(input, 'zahra');
  key(input, 'Escape');
  assert.equal(attr(input, 'aria-expanded'), 'false');
  assert.equal(input.value, 'zahra', 'the first Escape closes the list and keeps the text');
  key(input, 'Escape');
  assert.equal(input.value, 'Atlas Cafe', 'the second puts the chosen value back');
  assert.equal(key(input, 'Enter').defaultPrevented, false, 'a closed combobox lets Enter be a form’s');
});

test('combobox mouse and focus: a click chooses, leaving the field puts the chosen label back and closes', () => {
  const page = comboboxPage(),
    {input, host, chosen, options, type, FakeEvent} = page;
  input.focus();
  type(input, 'a');
  const down = new FakeEvent('mousedown');
  options()[2].dispatchEvent(down);
  assert.equal(down.defaultPrevented, true, 'pressing an option must not blur the text box');
  assert.equal(options().length, 5, 'every account matches a');
  options()[2].click();
  assert.equal(chosen.at(-1).value, 'a3', 'prefix matches rank first, then the rest in their order');
  assert.equal(input.value, 'Zahra Studio');
  const label = input.value;
  type(input, 'xyz');
  const outside = page.mount('<button id="elsewhere">Elsewhere</button>').querySelector('#elsewhere');
  outside.focus();
  assert.equal(input.value, label, 'a half-typed query is not a value');
  assert.equal(attr(input, 'aria-expanded'), 'false');
  input.focus();
  host.querySelector('.amcp-combobox-toggle').click();
  assert.equal(attr(input, 'aria-expanded'), 'true', 'the toggle opens the whole list');
  assert.equal(options().length, 5);
  host.querySelector('.amcp-combobox-toggle').click();
  assert.equal(attr(input, 'aria-expanded'), 'false');
});

test('combobox says when nothing matches, offers one way on, and says when the list was cut short', () => {
  const page = comboboxPage(accounts, {mount: {limit: 2}}),
    {input, host, options, type, list} = page;
  input.focus();
  type(input, 'a');
  assert.equal(options().length, 2);
  assert.match(host.querySelector('[role=status]').textContent, /Showing 2 of \d+\. Keep typing to narrow the list\./);
  type(input, 'zzz');
  assert.equal(options().length, 0);
  assert.equal(attr(list, 'aria-hidden'), 'true', 'an empty listbox is not read as a list');
  assert.match(host.querySelector('.amcp-listbox-note').textContent, /No match for “zzz”\./);
  assert.match(host.querySelector('[role=status]').textContent, /No matches/);
  const clear = host.querySelector('button[data-combobox-clear]');
  assert.ok(clear, 'an empty result names one next action');
  clear.click();
  assert.equal(input.value, '');
  assert.equal(page.active(), input);
  assert.equal(options().length, 2, 'the list is back');
});

test('combobox with asynchronous options: busy while searching, the newest answer wins, a failure offers a retry', async () => {
  const calls = [],
    resolvers = [];
  const page = comboboxPage([], {
    mount: {
      search: query =>
        new Promise((resolve, reject) => {
          calls.push(query);
          resolvers.push({resolve, reject});
        }),
    },
  });
  const {input, host, options, type, list} = page;
  input.focus();
  type(input, 'at');
  assert.equal(attr(host, 'aria-busy'), 'true');
  assert.equal(host.querySelectorAll('.amcp-spinner').length, 1);
  assert.match(host.querySelector('.amcp-listbox-note').textContent, /Searching…/);
  type(input, 'atl');
  resolvers[1].resolve([accounts[0]]);
  await new Promise(resolve => setImmediate(resolve));
  resolvers[0].resolve([accounts[1], accounts[2]]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['at', 'atl']);
  assert.deepEqual(
    options().map(option => option.getAttribute('data-value')),
    ['a1'],
    'an older answer never replaces a newer one',
  );
  assert.equal(attr(host, 'aria-busy'), null);
  type(input, 'oops');
  resolvers[2].reject(new Error('down'));
  await new Promise(resolve => setImmediate(resolve));
  const note = host.querySelector('.amcp-listbox-note');
  assert.equal(attr(note, 'role'), 'alert');
  assert.match(note.textContent, /Could not load the options\./);
  const retry = host.querySelector('button[data-combobox-retry]');
  retry.click();
  assert.equal(calls.at(-1), 'oops', 'Try again repeats the same search');
  resolvers[3].resolve([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attr(list, 'aria-hidden'), 'true');
});

const scope = [
  {
    id: 'meta',
    label: 'Meta',
    children: [
      {
        id: 'm1',
        label: 'Atlas Outdoor',
        children: [
          {id: 'c1', label: 'Spring'},
          {id: 'c2', label: 'Summer'},
        ],
      },
      {id: 'm2', label: 'Atlas Cafe'},
    ],
  },
  {id: 'tiktok', label: 'TikTok', children: [{id: 't1', label: 'Zahra Studio', disabled: true}]},
];

test('tree states: a parent is checked when every selectable leaf is, mixed when some are, and toggling sets them all', () => {
  const {UI, json} = setup(),
    states = checked => Object.fromEntries(UI.tree.states(scope, new Set(checked))),
    toggled = (checked, id) => json([...UI.tree.toggle(scope, new Set(checked), id)].sort());
  assert.deepEqual(states([]), {
    meta: 'false',
    m1: 'false',
    c1: 'false',
    c2: 'false',
    m2: 'false',
    tiktok: 'false',
    t1: 'false',
  });
  assert.deepEqual(states(['c1']), {
    meta: 'mixed',
    m1: 'mixed',
    c1: 'true',
    c2: 'false',
    m2: 'false',
    tiktok: 'false',
    t1: 'false',
  });
  assert.deepEqual(states(['c1', 'c2', 'm2']), {
    meta: 'true',
    m1: 'true',
    c1: 'true',
    c2: 'true',
    m2: 'true',
    tiktok: 'false',
    t1: 'false',
  });
  assert.deepEqual(toggled(['c1'], 'meta'), ['c1', 'c2', 'm2'], 'a mixed parent becomes fully checked');
  assert.deepEqual(toggled(['c1', 'c2', 'm2'], 'meta'), [], 'a checked parent clears every leaf under it');
  assert.deepEqual(toggled([], 'm1'), ['c1', 'c2']);
  assert.deepEqual(toggled([], 'tiktok'), [], 'a disabled leaf is never checked');
  assert.deepEqual(toggled(['c1'], 't1'), ['c1']);
});

test('tree order: what is visible, with level, position and set size for the ARIA tree', () => {
  const {UI, json} = setup(),
    visible = expanded => json(UI.tree.visible(scope, new Set(expanded)));
  assert.deepEqual(
    visible([]).map(item => [item.id, item.level, item.posinset, item.setsize]),
    [
      ['meta', 1, 1, 2],
      ['tiktok', 1, 2, 2],
    ],
  );
  assert.deepEqual(
    visible(['meta', 'm1']).map(item => [item.id, item.level, item.posinset, item.setsize]),
    [
      ['meta', 1, 1, 2],
      ['m1', 2, 1, 2],
      ['c1', 3, 1, 2],
      ['c2', 3, 2, 2],
      ['m2', 2, 2, 2],
      ['tiktok', 1, 2, 2],
    ],
  );
});

test('tree keys: arrows walk the visible items, Right opens or enters, Left closes or leaves, Home and End jump', () => {
  const {UI, json} = setup(),
    act = (key, id, expanded = [], extra = {}) =>
      json(UI.tree.keyAction({key, id, nodes: scope, expanded: new Set(expanded), ...extra}));
  assert.deepEqual(act('ArrowDown', 'meta'), {type: 'focus', id: 'tiktok'});
  assert.deepEqual(act('ArrowDown', 'meta', ['meta']), {type: 'focus', id: 'm1'});
  assert.deepEqual(act('ArrowUp', 'tiktok'), {type: 'focus', id: 'meta'});
  assert.equal(act('ArrowUp', 'meta'), null);
  assert.equal(act('ArrowDown', 'tiktok'), null);
  assert.deepEqual(act('ArrowRight', 'meta'), {type: 'expand', id: 'meta'});
  assert.deepEqual(act('ArrowRight', 'meta', ['meta']), {type: 'focus', id: 'm1'});
  assert.equal(act('ArrowRight', 'm2', ['meta']), null, 'a leaf has nothing to open');
  assert.deepEqual(act('ArrowLeft', 'meta', ['meta']), {type: 'collapse', id: 'meta'});
  assert.deepEqual(act('ArrowLeft', 'm2', ['meta']), {type: 'focus', id: 'meta'});
  assert.deepEqual(
    act('ArrowRight', 'meta', ['meta'], {rtl: true}),
    {type: 'collapse', id: 'meta'},
    'right-to-left swaps Right and Left',
  );
  assert.deepEqual(act('ArrowLeft', 'meta', [], {rtl: true}), {type: 'expand', id: 'meta'});
  assert.deepEqual(act('Home', 'tiktok'), {type: 'focus', id: 'meta'});
  assert.deepEqual(act('End', 'meta'), {type: 'focus', id: 'tiktok'});
  assert.deepEqual(act(' ', 'm2', ['meta']), {type: 'toggle', id: 'm2'});
  assert.deepEqual(act('Enter', 'm2', ['meta']), {type: 'toggle', id: 'm2'});
  assert.deepEqual(act('*', 'meta'), {type: 'expandSiblings', id: 'meta'});
  assert.deepEqual(
    act('t', 'meta'),
    {type: 'focus', id: 'tiktok'},
    'a letter jumps to the next item that starts with it',
  );
  assert.equal(act('q', 'meta'), null);
});

function treePage(extra = {}) {
  const page = setup(),
    root = page.render(
      page.UI.tree({id: 'scope', label: 'Choose accounts', nodes: scope, checked: ['c1'], expanded: ['meta']}),
    ),
    host = root.querySelector('[data-amcp=tree]'),
    changes = [];
  page.document.addEventListener('amcp-change', event => changes.push(page.json(event.detail)));
  const controller = page.UI.tree.mount(host, {nodes: scope, checked: ['c1'], expanded: ['meta'], ...extra});
  const item = id => host.querySelector('[data-node="' + id + '"]');
  return {...page, host, controller, changes, item, items: () => host.querySelectorAll('[role=treeitem]')};
}

test('tree markup: a labelled multiselectable tree, one tab stop, levels, expanded and checked states in ARIA', () => {
  const {host, items, item} = treePage();
  const tree = host.querySelector('[role=tree]');
  assert.equal(attr(tree, 'aria-label'), 'Choose accounts');
  assert.equal(attr(tree, 'aria-multiselectable'), 'true');
  assert.deepEqual(
    items().map(node => node.getAttribute('data-node')),
    ['meta', 'm1', 'm2', 'tiktok'],
    'collapsed branches are not in the document',
  );
  assert.deepEqual(
    items().map(node => attr(node, 'tabindex')),
    ['0', '-1', '-1', '-1'],
  );
  assert.deepEqual(
    items().map(node => attr(node, 'aria-level')),
    ['1', '2', '2', '1'],
  );
  assert.deepEqual(
    items().map(node => attr(node, 'aria-expanded')),
    ['true', 'false', null, 'false'],
  );
  assert.deepEqual(
    items().map(node => attr(node, 'aria-checked')),
    ['mixed', 'mixed', 'false', 'false'],
  );
  assert.equal(item('meta').querySelector('[role=group]').children.length, 2);
  assert.match(item('m1').textContent, /Atlas Outdoor/);
});

test('tree in the page: keys move focus, open and close branches, and Space checks every leaf under an item', () => {
  const {item, items, key, active, changes, host} = treePage();
  item('meta').focus();
  key(item('meta'), 'ArrowDown');
  assert.equal(active(), item('m1'));
  assert.deepEqual(
    items().map(node => attr(node, 'tabindex')),
    ['-1', '0', '-1', '-1'],
    'the tab stop follows the focus',
  );
  key(item('m1'), 'ArrowRight');
  assert.deepEqual(
    items().map(node => node.getAttribute('data-node')),
    ['meta', 'm1', 'c1', 'c2', 'm2', 'tiktok'],
  );
  assert.equal(active(), item('m1'), 'opening keeps the focus on the item');
  key(item('m1'), 'ArrowRight');
  assert.equal(active(), item('c1'));
  key(item('c1'), ' ');
  assert.equal(attr(item('c1'), 'aria-checked'), 'false');
  assert.equal(attr(item('m1'), 'aria-checked'), 'false');
  assert.equal(attr(item('meta'), 'aria-checked'), 'false');
  assert.equal(active(), item('c1'), 'a change redraws the tree but the focus stays on the item');
  assert.deepEqual(changes.at(-1), {id: 'c1', checkedIds: []});
  key(item('c1'), 'ArrowLeft');
  assert.equal(active(), item('m1'));
  key(item('m1'), ' ');
  assert.deepEqual(changes.at(-1), {id: 'm1', checkedIds: ['c1', 'c2']});
  assert.equal(attr(item('m1'), 'aria-checked'), 'true');
  assert.equal(attr(item('meta'), 'aria-checked'), 'mixed');
  key(item('m1'), 'ArrowLeft');
  assert.deepEqual(
    items().map(node => node.getAttribute('data-node')),
    ['meta', 'm1', 'm2', 'tiktok'],
    'Left closes an open branch',
  );
  assert.equal(host.querySelector('[role=tree]').getAttribute('aria-label'), 'Choose accounts');
});

test('tree with the pointer: the box checks, the arrow opens, the label also checks, a disabled leaf does nothing', () => {
  const {item, items, changes} = treePage({expanded: ['meta', 'tiktok']});
  item('m2').querySelector('.amcp-tree-box').click();
  assert.deepEqual(changes.at(-1), {id: 'm2', checkedIds: ['c1', 'm2']});
  item('meta').querySelector('.amcp-tree-expander').click();
  assert.deepEqual(
    items().map(node => node.getAttribute('data-node')),
    ['meta', 'tiktok', 't1'],
  );
  const before = changes.length;
  item('tiktok').querySelector('.amcp-tree-label').click();
  assert.equal(changes.length, before, 'tiktok has no selectable leaf, so nothing changed and nothing is reported');
  item('t1').querySelector('.amcp-tree-label').click();
  assert.equal(changes.length, before, 'a disabled item reports nothing');
  assert.equal(attr(item('t1'), 'aria-disabled'), 'true');
});
