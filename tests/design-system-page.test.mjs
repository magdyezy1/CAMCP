// V2-WEB-02: the component state page (/design-system, web/design-system.js). It is members only and out of the navigation, it
// loads exactly the V2 files, and it shows every component of the layer in every state it has, so the owner's review
// surface cannot drift from what the components do. A component added to AmcpUI without an example on the page, or
// without a place in docs/DESIGN-SYSTEM.md, fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {loadUI} from './helpers/web-ui-dom.mjs';

const files = [
  'routes.js',
  'components.js',
  'components-controls.js',
  'components-table.js',
  'components-overlays.js',
  'design-system.js',
];
function page({authenticated = true} = {}) {
  const ui = loadUI(files);
  ui.run(
    'var session = {authenticated: ' +
      authenticated +
      '}; var shown = 0; function showLogin() { shown++; } var content = document.createElement("div"); document.body.append(content);',
  );
  const content = ui.run('content');
  const render = () => ui.run("AMCP.routes.renderer('/design-system')()");
  return {...ui, content, render, shown: () => ui.run('shown')};
}
const helpers = new Set(['uid', 'define', 'behave', 'bind', 'emit', 'classes', 'attrs', 'visuallyHidden', 'spinner']);
// What each component looks like on the page: one selector that only that component draws.
const examples = {
  badge: '.amcp-badge',
  button: '.amcp-button',
  checkbox: '.amcp-checkbox',
  chips: '[data-amcp=chips]',
  combobox: '[data-amcp=combobox]',
  creativeCard: '.amcp-creative',
  decimal: '#ds-number',
  dialog: '[data-ds-action=dialog-confirm]',
  emptyState: '.amcp-state[data-kind=empty]',
  errorState: '.amcp-state[data-kind=error]',
  icon: '.amcp-icon',
  iconButton: '.amcp-icon-button',
  input: '.amcp-input',
  kpi: '.amcp-kpi',
  platformCard: '.amcp-platform',
  progress: 'progress.amcp-progress',
  segmented: '.amcp-segmented',
  select: '.amcp-select',
  sheet: '[data-ds-action=sheet-modal]',
  skeleton: '.amcp-skeleton',
  stepper: '.amcp-stepper',
  table: '[data-amcp=table]',
  tabs: '[data-amcp=tabs]',
  toasts: '.amcp-toasts',
  tree: '[data-amcp=tree]',
};

test('the state page is members only and not in the navigation or the palette, and a test account cannot open it', () => {
  const ui = loadUI(['routes.js']),
    entry = JSON.parse(ui.run("JSON.stringify(routeEntry('/design-system'))"));
  assert.equal(entry.label, 'Design system');
  for (const flag of ['nav', 'palette', 'public', 'testAccount', 'group', 'parent'])
    assert.equal(Object.hasOwn(entry, flag), false, flag);
  assert.deepEqual(entry.assets, ['design-system.js']);
  assert.equal(ui.run("routeAvailable('/design-system', {authenticated: true})"), true, 'a member opens it');
  assert.equal(
    ui.run("routeAvailable('/design-system', {authenticated: true, testAccount: true})"),
    false,
    'a test account does not',
  );
  assert.equal(
    ui.run("routeMatches('design').some(entry => entry.path === '/design-system')"),
    false,
    'the palette does not list it',
  );
  const index = fs.readFileSync('web/index.html', 'utf8');
  assert.ok(!index.includes('design-system'), 'the shell links neither the page nor its files');
  assert.ok(!fs.readFileSync('web/about.html', 'utf8').includes('tokens-v2.css'));
});

test('the page loads the V2 sheets and scripts, in an order that works, and no other route loads them', () => {
  const ui = loadUI(['routes.js']);
  ui.run(fs.readFileSync('web/route-assets.js', 'utf8'));
  assert.deepEqual(Array.from(ui.run("pageAssetsFor('/design-system')")), [
    'tokens-v2.css',
    'components.css',
    'components-controls.css',
    'components-data.css',
    'components-overlays.css',
    'design-system.css',
    'components.js',
    'components-controls.js',
    'components-table.js',
    'components-overlays.js',
    'design-system.js',
  ]);
  const others = Array.from(
    ui.run(
      "routeRegistry.filter(entry => ![ '/design-system', '/reporting-overview' ].includes(entry.path)).flatMap(entry => pageAssetsFor(entry.path))",
    ),
  );
  assert.deepEqual(
    others.filter(file => /^(?:tokens-v2|components|design-system)/.test(file)),
    [],
    'no other page pays for them',
  );
  // V2-EXP-01 (package charts): the report builder is the one other page that uses the layer, for the colours of its charts
  // and the table behind each (a button and a table: not the controls, the overlays or the state page's own files). It loads
  // them as the charts' dependencies, so a page that draws no chart pays nothing.
  assert.deepEqual(
    Array.from(ui.run("pageAssetsFor('/reporting-overview')")).filter(file =>
      /^(?:tokens-v2|components|design-system|charts)/.test(file),
    ),
    [
      'tokens-v2.css',
      'components.css',
      'components-data.css',
      'charts.css',
      'components.js',
      'components-table.js',
      'charts.js',
    ],
  );
  assert.deepEqual(
    Array.from(ui.run("pageAssetsFor('/report-library')")).filter(file =>
      /^(?:tokens-v2|components|design-system|charts)/.test(file),
    ),
    [],
    'the report library draws no chart and loads none of it',
  );
  assert.deepEqual(Array.from(ui.run("pageLocaleChunks('/design-system')")), [
    'workspace',
    'providers',
    'components',
    'components-controls',
    'components-table',
    'components-overlays',
    'design-system',
  ]);
});

test('a visitor who is not signed in is sent to sign in and gets no page', () => {
  const {render, content, shown} = page({authenticated: false});
  render();
  assert.equal(shown(), 1);
  assert.equal(content.innerHTML, '');
});

test('the page has a section for each component group, a heading for each, and an index that links them', () => {
  const {render, content} = page();
  render();
  const ids = [
    'buttons',
    'badges',
    'chips',
    'fields',
    'choosing',
    'combobox',
    'tree',
    'table',
    'feedback',
    'cards',
    'overlays',
  ];
  assert.equal(content.querySelector('h1').textContent, 'Design system');
  for (const id of ids) {
    const section = content.querySelector('#section-' + id);
    assert.ok(section, id);
    assert.equal(section.getAttribute('aria-labelledby'), 'section-' + id + '-title');
    assert.equal(section.querySelectorAll('h2').length, 1);
    assert.ok(content.querySelector('.amcp-ds-index a[href="#section-' + id + '"]'), 'the index links ' + id);
  }
  const duplicates = content
    .querySelectorAll('[id]')
    .map(el => el.id)
    .filter((id, at, all) => all.indexOf(id) !== at);
  assert.deepEqual(duplicates, [], 'no id appears twice on the page');
});

test('every component of the layer is on the page, and every example is a component', () => {
  const {render, content, run} = page(),
    components = Array.from(run('Object.keys(AmcpUI)')).filter(name => !helpers.has(name));
  render();
  assert.deepEqual(
    components.sort(),
    Object.keys(examples).sort(),
    'a component without an example, or an example without a component',
  );
  for (const [name, selector] of Object.entries(examples))
    assert.ok(content.querySelector(selector), name + ' is shown on the page (' + selector + ')');
});

test('the page shows the states: each button variant at rest, hover, active, focus, disabled and busy, and the fields’ states', () => {
  const {render, content} = page();
  render();
  for (const variant of ['primary', 'secondary', 'quiet', 'danger']) {
    const buttons = content.querySelectorAll('#section-buttons .amcp-button[data-variant=' + variant + ']');
    assert.deepEqual(
      [
        buttons.some(
          button => !button.hasAttribute('data-state') && !button.disabled && !button.hasAttribute('data-loading'),
        ),
        ...['hover', 'active', 'focus'].map(state =>
          buttons.some(button => button.getAttribute('data-state') === state),
        ),
        buttons.some(button => button.disabled),
        buttons.some(button => button.hasAttribute('data-loading') && button.getAttribute('aria-busy') === 'true'),
      ],
      [true, true, true, true, true, true],
      variant,
    );
  }
  assert.deepEqual(
    ['sm', 'md', 'lg'].map(
      size => content.querySelectorAll('#section-buttons .amcp-button[data-size=' + size + ']').length > 0,
    ),
    [true, true, true],
  );
  const fields = content.querySelector('#section-fields');
  assert.ok(fields.querySelector('input[aria-invalid=true]'), 'error');
  assert.ok(fields.querySelector('input:disabled'), 'disabled');
  assert.ok(fields.querySelector('input[readonly]'), 'read only');
  assert.ok(fields.querySelector('.amcp-control[aria-busy=true]'), 'loading');
  assert.ok(
    fields.querySelector('.amcp-control[data-state=hover]') && fields.querySelector('.amcp-control[data-state=focus]'),
    'hover and focus',
  );
  assert.ok(
    fields.querySelector('input[data-amcp-kind=number]') &&
      fields.querySelector('input[type=date]') &&
      fields.querySelector('select'),
  );
  const chips = content.querySelector('#section-chips');
  assert.ok(
    chips.querySelector('.amcp-chip[aria-pressed=true]') &&
      chips.querySelector('.amcp-chip:disabled') &&
      chips.querySelector('[data-chip-remove]'),
  );
  for (const tone of ['neutral', 'success', 'warning', 'danger', 'info', 'marker'])
    assert.ok(content.querySelector('#section-badges .amcp-badge[data-tone=' + tone + ']'), tone);
  assert.equal(
    content.querySelectorAll('#section-badges .amcp-ds-legacy-row').length,
    8,
    'the eight old classes, each beside its badge',
  );
  const tabs = content.querySelector('#section-choosing');
  assert.ok(
    tabs.querySelector('[role=tab]:disabled') &&
      tabs.querySelector('[data-activation=manual]') &&
      tabs.querySelector('[data-orientation=vertical]'),
  );
  const tree = content.querySelector('#section-tree');
  assert.ok(
    ['true', 'false', 'mixed'].every(state => tree.querySelector('[role=treeitem][aria-checked=' + state + ']')),
    'checked, unchecked and mixed',
  );
  assert.ok(
    tree.querySelector('[role=treeitem][aria-disabled=true]'),
    'a disabled item is on show without opening anything',
  );
  const table = content.querySelector('#section-table');
  assert.ok(
    table.querySelector('[aria-busy=true]') &&
      table.querySelector('.amcp-table-state .amcp-state[data-kind=empty]') &&
      table.querySelector('.amcp-table-state .amcp-state[data-kind=error]'),
  );
  assert.equal(table.querySelectorAll('[data-amcp=table]').length, 5, 'wide, narrow, loading, empty and failed');
  const cards = content.querySelector('#section-cards');
  assert.ok(
    cards.querySelector('.amcp-kpi[data-state=missing]') && cards.querySelector('.amcp-creative[data-selected=true]'),
  );
  const feedback = content.querySelector('#section-feedback');
  assert.ok(
    feedback.querySelector('progress[value]') && feedback.querySelector('progress:not([value])'),
    'known and unknown progress',
  );
  assert.equal(feedback.querySelectorAll('.amcp-step').length, 4);
  for (const shape of ['text', 'card', 'row'])
    assert.ok(feedback.querySelector('.amcp-skeleton[data-shape=' + shape + ']'), shape);
  const lists = content.querySelector('#section-combobox');
  assert.equal(
    lists.querySelectorAll('[data-amcp=combobox]').length,
    6,
    'accounts, campaigns, loading, failed, error and disabled',
  );
  assert.ok(lists.querySelector('[aria-busy=true]'), 'the loading list is busy');
});

test('the page’s buttons drive the components: a toast appears, a dialog opens, and a second draw adds no second handler', () => {
  const {render, content, document, run} = page();
  render();
  render();
  const toast = content.querySelector('[data-ds-action=toast-success]');
  toast.click();
  assert.equal(content.querySelectorAll('#ds-toasts .amcp-toast').length, 1, 'one click, one toast, after two draws');
  content.querySelector('[data-ds-action=toast-danger]').click();
  assert.equal(content.querySelectorAll('#ds-toasts .amcp-toast').length, 2);
  content.querySelector('[data-ds-action=dialog-confirm]').click();
  const dialog = document.querySelector('dialog.amcp-dialog');
  assert.ok(dialog?.open, 'the confirmation opened');
  assert.equal(dialog.getAttribute('role'), 'alertdialog');
  assert.equal(run('document.activeElement.getAttribute("data-dialog-action")'), 'cancel');
  const tree = content.querySelector('#ds-tree-summary');
  assert.match(tree.textContent, /1 campaign selected/);
});

test('every component is documented: the doc names each AmcpUI component and the old badge classes', () => {
  const doc = fs.readFileSync('docs/DESIGN-SYSTEM.md', 'utf8'),
    {run} = loadUI(['components.js', 'components-controls.js', 'components-table.js', 'components-overlays.js']);
  const components = Array.from(run('Object.keys(AmcpUI)')).filter(name => !helpers.has(name));
  assert.deepEqual(
    components.filter(name => !doc.includes('AmcpUI.' + name)),
    [],
    'components without a place in docs/DESIGN-SYSTEM.md',
  );
  for (const old of Object.keys(JSON.parse(JSON.stringify(run('AmcpUI.badge.legacy')))))
    assert.ok(
      doc.includes('`.' + old.replace(' ', '.') + '`') || doc.includes('`.' + old + '`'),
      old + ' is in the badge map of the doc',
    );
  assert.match(doc, /## V2 components/);
});
