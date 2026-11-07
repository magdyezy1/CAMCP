// V2-WEB-02: the component layer's core and its simple components (web/components.js): markup helpers, button, badge,
// filter chips, fields and inputs, progress, skeleton, empty and error states, stepper and cards. Each test renders the
// component through the real html`…` tag into a test DOM and reads state, ARIA and keyboard behaviour back from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadUI} from './helpers/web-ui-dom.mjs';

function setup() {
  const dom = loadUI(['components.js']),
    UI = dom.run('AmcpUI');
  dom.run('AmcpUI.bind(document.body)');
  const render = markup => dom.mount(String(markup));
  return {...dom, UI, render};
}
const attr = (element, name) => element.getAttribute(name);

test('the namespace defines each component once, writes attributes safely and numbers ids', () => {
  const {UI, render, run} = setup();
  assert.throws(() => UI.define('button', {}), /AMCP_UI_ALREADY_DEFINED/);
  assert.ok(Object.isFrozen(UI.button), 'a defined component cannot be reassigned or extended');
  const first = UI.uid('field'),
    second = UI.uid('field');
  assert.notEqual(first, second);
  assert.match(first, /^field-\d+$/);
  const root = render(
    UI.button({label: '<img src=x onerror=bad()>', attrs: {'data-x': '"><script>', hidden: false, 'data-on': true}}),
  );
  assert.equal(root.querySelectorAll('img, script').length, 0, 'labels and attribute values are escaped');
  assert.equal(root.querySelector('button').getAttribute('data-x'), '"><script>');
  assert.equal(root.querySelector('button').hasAttribute('hidden'), false);
  assert.equal(root.querySelector('button').hasAttribute('data-on'), true);
  assert.throws(() => UI.button({label: 'x', attrs: {'onclick="bad()" x': 1}}), /AMCP_UI_ATTRIBUTE_NAME/);
  assert.equal(run('typeof AmcpUI.bind'), 'function');
});

test('buttons: four variants, three sizes, a 44px primary, and disabled, loading and link forms', () => {
  const {UI, render} = setup();
  for (const variant of ['primary', 'secondary', 'quiet', 'danger'])
    for (const size of ['sm', 'md', 'lg']) {
      const button = render(UI.button({label: 'Save', variant, size})).querySelector('button');
      assert.equal(attr(button, 'data-variant'), variant);
      assert.equal(attr(button, 'data-size'), size);
      assert.equal(attr(button, 'type'), 'button', 'never submits by accident');
      assert.ok(button.classList.contains('amcp-button'));
    }
  assert.throws(() => UI.button({label: 'x', variant: 'huge'}), /AMCP_UI_VARIANT/);
  assert.throws(() => UI.button({label: 'x', size: 'xl'}), /AMCP_UI_SIZE/);
  const submit = render(UI.button({label: 'Send', type: 'submit', variant: 'primary'})).querySelector('button');
  assert.equal(attr(submit, 'type'), 'submit');
  const disabled = render(UI.button({label: 'Save', disabled: true})).querySelector('button');
  assert.equal(disabled.disabled, true);
  const loading = render(UI.button({label: 'Save', loadingLabel: 'Saving…', loading: true})).querySelector('button');
  assert.equal(attr(loading, 'aria-busy'), 'true');
  assert.equal(loading.disabled, true, 'a busy button cannot be pressed twice');
  assert.equal(loading.hasAttribute('data-loading'), true);
  assert.match(loading.textContent, /Saving…/);
  assert.equal(loading.querySelector('.amcp-spinner').getAttribute('aria-hidden'), 'true');
  const link = render(UI.button({label: 'Open', href: '/reports'})).querySelector('a');
  assert.equal(attr(link, 'href'), '/reports');
  assert.equal(attr(link, 'role'), null, 'a link stays a link');
  const deadLink = render(UI.button({label: 'Open', href: '/reports', disabled: true})).querySelector('a');
  assert.equal(attr(deadLink, 'aria-disabled'), 'true');
  assert.equal(deadLink.hasAttribute('href'), false);
  assert.equal(attr(deadLink, 'tabindex'), '-1');
  const pressed = render(UI.button({label: 'Bold', pressed: true})).querySelector('button');
  assert.equal(attr(pressed, 'aria-pressed'), 'true');
  const menu = render(UI.button({label: 'More', expanded: false, controls: 'menu-1'})).querySelector('button');
  assert.equal(attr(menu, 'aria-expanded'), 'false');
  assert.equal(attr(menu, 'aria-controls'), 'menu-1');
  const forced = render(UI.button({label: 'Hover', state: 'hover'})).querySelector('button');
  assert.equal(attr(forced, 'data-state'), 'hover', 'the state page can show a state that needs the pointer');
});

test('an icon button needs a name and hides its glyph from assistive technology', () => {
  const {UI, render} = setup();
  assert.throws(() => UI.iconButton({icon: 'close'}), /AMCP_UI_LABEL/);
  const button = render(UI.iconButton({icon: 'close', label: 'Close'})).querySelector('button');
  assert.equal(attr(button, 'aria-label'), 'Close');
  assert.equal(button.querySelector('svg').getAttribute('aria-hidden'), 'true');
  assert.equal(button.querySelector('svg').getAttribute('focusable'), 'false');
  assert.equal(attr(button, 'data-variant'), 'quiet');
  assert.ok(button.classList.contains('amcp-icon-button'));
  assert.throws(() => UI.icon('nope'), /AMCP_UI_ICON/);
});

test('one badge: every status tone has an icon and a label, neutral has neither colour nor icon alone', () => {
  const {UI, render} = setup();
  for (const tone of ['success', 'warning', 'danger', 'info']) {
    const badge = render(UI.badge({label: 'Connected', tone})).querySelector('.amcp-badge');
    assert.equal(attr(badge, 'data-tone'), tone);
    assert.equal(badge.querySelectorAll('svg').length, 1, tone + ' carries an icon');
    assert.equal(badge.querySelector('svg').getAttribute('aria-hidden'), 'true');
    assert.match(badge.textContent, /Connected/, tone + ' carries its word');
  }
  const neutral = render(UI.badge({label: 'Draft'})).querySelector('.amcp-badge');
  assert.equal(attr(neutral, 'data-tone'), 'neutral');
  assert.equal(neutral.querySelectorAll('svg').length, 0);
  const marker = render(UI.badge({label: 'Needs attention', tone: 'marker'})).querySelector('.amcp-badge');
  assert.equal(
    marker.querySelectorAll('.amcp-marker').length,
    1,
    'peach is a marker beside the words, never behind them',
  );
  assert.match(marker.textContent, /Needs attention/);
  assert.throws(() => UI.badge({label: 'x', tone: 'purple'}), /AMCP_UI_TONE/);
  assert.throws(() => UI.badge({tone: 'success'}), /AMCP_UI_LABEL/);
});

test('the four badge classes of the old pages map to the one badge', () => {
  const {UI} = setup();
  assert.deepEqual(JSON.parse(JSON.stringify(UI.badge.legacy)), {
    status: 'neutral',
    'status online': 'success',
    'status attention': 'warning',
    'status offline': 'neutral',
    'status error': 'danger',
    'default-badge': 'info',
    'creative-tag': 'neutral',
    'measurement-ledger-state': 'info',
  });
});

test('filter chips: a labelled group of toggle buttons that say which are pressed, and report changes', () => {
  const {UI, render, document} = setup(),
    root = render(
      UI.chips({
        label: 'Platforms',
        chips: [
          {id: 'meta', label: 'Meta', pressed: true, count: 12},
          {id: 'tiktok', label: 'TikTok'},
          {id: 'x', label: 'X', disabled: true},
        ],
      }),
    ),
    group = root.querySelector('[data-amcp=chips]');
  assert.equal(attr(group, 'role'), 'group');
  assert.equal(attr(group, 'aria-label'), 'Platforms');
  const [meta, tiktok, x] = root.querySelectorAll('button.amcp-chip');
  assert.deepEqual(
    [meta, tiktok, x].map(chip => attr(chip, 'aria-pressed')),
    ['true', 'false', 'false'],
  );
  assert.match(meta.textContent, /12/);
  assert.equal(x.disabled, true);
  const changes = [];
  document.addEventListener('amcp-change', event => changes.push(JSON.parse(JSON.stringify(event.detail))));
  tiktok.click();
  assert.equal(attr(tiktok, 'aria-pressed'), 'true');
  assert.deepEqual(changes.at(-1), {id: 'tiktok', pressed: true, pressedIds: ['meta', 'tiktok']});
  meta.click();
  assert.deepEqual(changes.at(-1), {id: 'meta', pressed: false, pressedIds: ['tiktok']});
  x.click();
  assert.equal(attr(x, 'aria-pressed'), 'false', 'a disabled chip does nothing');
});

test('single-choice chips keep exactly one pressed', () => {
  const {UI, render} = setup(),
    root = render(
      UI.chips({
        label: 'Period',
        mode: 'single',
        chips: [
          {id: 'a', label: '7 days', pressed: true},
          {id: 'b', label: '30 days'},
        ],
      }),
    ),
    [first, second] = root.querySelectorAll('button.amcp-chip');
  second.click();
  assert.deepEqual(
    [first, second].map(chip => attr(chip, 'aria-pressed')),
    ['false', 'true'],
  );
  second.click();
  assert.equal(attr(second, 'aria-pressed'), 'true', 'the one pressed chip cannot be un-pressed');
});

test('removable chips name what they remove, remove themselves, and hand focus to a neighbour', () => {
  const {UI, render, document} = setup(),
    root = render(
      UI.chips({
        label: 'Filters',
        removable: true,
        chips: [
          {id: 'a', label: 'Spend > 100'},
          {id: 'b', label: 'Active'},
          {id: 'c', label: 'Paused'},
        ],
      }),
    ),
    removed = [];
  document.addEventListener('amcp-remove', event => removed.push(event.detail.id));
  const buttons = root.querySelectorAll('button[data-chip-remove]');
  assert.deepEqual(
    buttons.map(button => attr(button, 'aria-label')),
    ['Remove Spend > 100', 'Remove Active', 'Remove Paused'],
  );
  buttons[1].focus();
  buttons[1].click();
  assert.deepEqual(removed, ['b']);
  assert.equal(root.querySelectorAll('.amcp-chip').length, 2);
  assert.equal(
    document.activeElement,
    root.querySelector('button[data-chip-remove="c"]'),
    'focus moves to the next chip',
  );
  root.querySelector('button[data-chip-remove="c"]').click();
  assert.equal(document.activeElement, root.querySelector('button[data-chip-remove="a"]'), 'or the previous one');
  root.querySelector('button[data-chip-remove="a"]').click();
  assert.equal(document.activeElement, root.querySelector('[data-amcp=chips]'), 'or the group when none is left');
});

test('fields name their control, link hint and error to it, and say invalid in words and attributes', () => {
  const {UI, render} = setup(),
    root = render(UI.input({id: 'budget', label: 'Daily budget', hint: 'In the account currency.', required: true})),
    input = root.querySelector('input');
  assert.equal(root.querySelector('label').getAttribute('for'), 'budget');
  assert.equal(attr(input, 'id'), 'budget');
  assert.equal(attr(input, 'aria-describedby'), 'budget-hint');
  assert.equal(attr(input, 'aria-required'), 'true');
  assert.equal(attr(input, 'aria-invalid'), null);
  assert.ok(root.querySelector('.amcp-required'), 'required is shown, not only announced');
  assert.equal(root.querySelector('#budget-hint').textContent, 'In the account currency.');
  const invalid = render(UI.input({id: 'name', label: 'Name', hint: 'Shown to clients.', error: 'Enter a name.'}));
  assert.equal(attr(invalid.querySelector('input'), 'aria-invalid'), 'true');
  assert.equal(attr(invalid.querySelector('input'), 'aria-describedby'), 'name-hint name-error');
  assert.equal(attr(invalid.querySelector('#name-error'), 'role'), 'alert');
  assert.match(invalid.querySelector('#name-error').textContent, /Enter a name\./);
  assert.equal(
    invalid.querySelector('#name-error svg').getAttribute('aria-hidden'),
    'true',
    'an icon beside the words, not colour alone',
  );
  assert.equal(attr(invalid.querySelector('.amcp-control'), 'data-state'), 'error');
  for (const [flag, expected] of [
    ['disabled', 'disabled'],
    ['readonly', 'readonly'],
  ])
    assert.equal(
      render(UI.input({id: 'a' + flag, label: 'L', [flag]: true}))
        .querySelector('input')
        .hasAttribute(expected),
      true,
    );
  const loading = render(UI.input({id: 'l', label: 'L', loading: true}));
  assert.equal(attr(loading.querySelector('.amcp-control'), 'aria-busy'), 'true');
  assert.equal(loading.querySelectorAll('.amcp-spinner').length, 1);
});

test('number fields keep the text exact, left to right, with a decimal keyboard; dates use the native control', () => {
  const {UI, render} = setup(),
    number = render(
      UI.input({id: 'n', label: 'Amount', type: 'number', value: '12345678901234567890.123456789'}),
    ).querySelector('input');
  assert.equal(attr(number, 'type'), 'text');
  assert.equal(attr(number, 'inputmode'), 'decimal');
  assert.equal(attr(number, 'dir'), 'ltr');
  assert.equal(attr(number, 'autocomplete'), 'off');
  assert.equal(attr(number, 'value'), '12345678901234567890.123456789', 'no float conversion');
  assert.equal(attr(number, 'data-amcp-kind'), 'number');
  const check = text => JSON.parse(JSON.stringify(UI.decimal(text)));
  assert.deepEqual(check('12.50'), {valid: true, value: '12.50'});
  assert.deepEqual(check(' -0.5 '), {valid: true, value: '-0.5'});
  assert.deepEqual(check('1,234.5'), {valid: true, value: '1234.5'}, 'thousands separators are dropped');
  assert.deepEqual(check(''), {valid: false, value: ''});
  assert.deepEqual(check('1e5'), {valid: false, value: '1e5'});
  assert.deepEqual(check('12.'), {valid: false, value: '12.'});
  assert.deepEqual(check('٣٫٥'), {valid: false, value: '٣٫٥'}, 'digits are Latin in both languages');
  const date = render(
    UI.input({id: 'd', label: 'Start', type: 'date', min: '2026-01-01', max: '2026-12-31', value: '2026-06-01'}),
  ).querySelector('input');
  assert.equal(attr(date, 'type'), 'date');
  assert.equal(attr(date, 'min'), '2026-01-01');
  assert.equal(attr(date, 'max'), '2026-12-31');
  assert.throws(() => UI.input({id: 'x', label: 'X', type: 'color'}), /AMCP_UI_TYPE/);
});

test('a select keeps the native control and options, with a caret that is not read out', () => {
  const {UI, render} = setup(),
    root = render(
      UI.select({
        id: 'level',
        label: 'Reporting level',
        value: 'ad',
        hint: 'Rows per ad.',
        options: [
          {value: 'campaign', label: 'Campaign'},
          {value: 'ad', label: 'Ad'},
          {value: 'x', label: 'Old', disabled: true},
        ],
      }),
    ),
    select = root.querySelector('select');
  assert.equal(root.querySelector('label').getAttribute('for'), 'level');
  assert.equal(attr(select, 'aria-describedby'), 'level-hint');
  const options = root.querySelectorAll('option');
  assert.deepEqual(
    options.map(option => [attr(option, 'value'), option.hasAttribute('selected'), option.disabled]),
    [
      ['campaign', false, false],
      ['ad', true, false],
      ['x', false, true],
    ],
  );
  assert.equal(root.querySelector('.amcp-caret').getAttribute('aria-hidden'), 'true');
  assert.equal(
    render(UI.select({id: 's', label: 'S', options: [], error: 'Pick one.'}))
      .querySelector('select')
      .getAttribute('aria-invalid'),
    'true',
  );
});

test('a checkbox is a native input in a label, and can show mixed', () => {
  const {UI, render} = setup(),
    root = render(UI.checkbox({id: 'c', label: 'Remember me', checked: true})),
    input = root.querySelector('input');
  assert.equal(attr(input, 'type'), 'checkbox');
  assert.equal(input.checked, true);
  assert.equal(root.querySelector('label').getAttribute('for'), 'c');
  assert.equal(
    attr(render(UI.checkbox({id: 'm', label: 'Some', mixed: true})).querySelector('input'), 'data-mixed'),
    'true',
  );
});

test('progress is determinate only when the value is known, and always says what it measures', () => {
  const {UI, render} = setup(),
    known = render(UI.progress({label: 'Report run', value: 42})),
    bar = known.querySelector('progress');
  assert.equal(attr(bar, 'value'), '42');
  assert.equal(attr(bar, 'max'), '100');
  assert.equal(attr(bar, 'aria-labelledby'), known.querySelector('.amcp-progress-label').id);
  assert.match(known.querySelector('.amcp-progress-value').textContent, /42%/);
  const unknown = render(UI.progress({label: 'Report run'})),
    wait = unknown.querySelector('progress');
  assert.equal(wait.hasAttribute('value'), false, 'no value attribute means indeterminate');
  assert.match(unknown.querySelector('.amcp-progress-value').textContent, /In progress/);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify([
        UI.progress.percent(150, 100),
        UI.progress.percent(-5, 100),
        UI.progress.percent(1, 3),
        UI.progress.percent(null, 100),
        UI.progress.percent(5, 0),
      ]),
    ),
    [100, 0, 33, null, null],
  );
  const steps = render(UI.progress({label: 'Accounts', value: 3, max: 5, text: '3 of 5'}));
  assert.match(steps.querySelector('.amcp-progress-value').textContent, /3 of 5/);
  assert.equal(
    attr(render(UI.progress({label: 'Done', value: 100, tone: 'success'})).querySelector('progress'), 'data-tone'),
    'success',
  );
});

test('a skeleton is one busy status with one spoken word, and its blocks are decoration', () => {
  const {UI, render} = setup(),
    root = render(UI.skeleton({shape: 'text', lines: 3})),
    group = root.querySelector('.amcp-skeleton-group');
  assert.equal(attr(group, 'role'), 'status');
  assert.equal(attr(group, 'aria-busy'), 'true');
  assert.equal(group.querySelector('.amcp-visually-hidden').textContent, 'Loading…');
  const blocks = group.querySelectorAll('.amcp-skeleton');
  assert.equal(blocks.length, 3);
  assert.ok(blocks.every(block => attr(block, 'aria-hidden') === 'true'));
  assert.equal(render(UI.skeleton({shape: 'card'})).querySelectorAll('.amcp-skeleton').length, 1);
  assert.throws(() => UI.skeleton({shape: 'ring'}), /AMCP_UI_SHAPE/);
});

test('an empty state always offers one next action, and an error state offers a way on', () => {
  const {UI, render} = setup();
  assert.throws(() => UI.emptyState({title: 'No reports yet', body: 'x'}), /AMCP_UI_EMPTY_STATE_NEEDS_ACTION/);
  const empty = render(
      UI.emptyState({
        title: 'No reports yet',
        body: 'Create one to see results here.',
        action: {label: 'New report', href: '/reporting-overview'},
      }),
    ),
    section = empty.querySelector('section');
  assert.equal(attr(section, 'aria-labelledby'), empty.querySelector('h3').id);
  assert.equal(empty.querySelectorAll('a.amcp-button, button.amcp-button').length, 1, 'exactly one action');
  assert.equal(attr(empty.querySelector('a.amcp-button'), 'data-variant'), 'primary');
  const error = render(
      UI.errorState({
        title: 'The report could not run',
        body: 'The platform did not answer.',
        retry: {label: 'Try again', attrs: {'data-retry': ''}},
        reference: 'REQ-1234',
        details: 'Timeout after 30 seconds',
      }),
    ),
    alert = error.querySelector('section');
  assert.equal(attr(alert, 'role'), 'alert');
  assert.equal(error.querySelectorAll('button[data-retry]').length, 1);
  assert.equal(error.querySelector('code').getAttribute('dir'), 'ltr');
  assert.equal(error.querySelector('code').textContent, 'REQ-1234');
  assert.match(error.querySelector('details').textContent, /Timeout after 30 seconds/);
  assert.equal(error.querySelector('svg').getAttribute('aria-hidden'), 'true');
  assert.throws(() => UI.errorState({title: 'x', body: 'y'}), /AMCP_UI_ERROR_STATE_NEEDS_RETRY/);
});

test('a stepper marks the current step, and each step says its state in words', () => {
  const {UI, render} = setup(),
    root = render(
      UI.stepper({
        label: 'Report setup',
        steps: [
          {id: 'scope', label: 'Scope', status: 'complete'},
          {id: 'period', label: 'Period', status: 'current', description: 'Last 30 days'},
          {id: 'measures', label: 'Measures', status: 'error'},
          {id: 'review', label: 'Review'},
        ],
      }),
    ),
    items = root.querySelectorAll('li.amcp-step');
  assert.equal(attr(root.querySelector('ol'), 'aria-label'), 'Report setup');
  assert.deepEqual(
    items.map(item => attr(item, 'data-status')),
    ['complete', 'current', 'error', 'upcoming'],
  );
  assert.deepEqual(
    items.map(item => attr(item, 'aria-current')),
    [null, 'step', null, null],
  );
  assert.deepEqual(
    items.map(item => item.querySelector('.amcp-visually-hidden').textContent),
    ['Completed', 'Current step', 'Needs attention', 'Not started'],
  );
  assert.match(items[1].textContent, /Last 30 days/);
  assert.equal(items[0].querySelectorAll('svg').length, 1, 'a finished step shows a check');
  assert.throws(() => UI.stepper({label: 'x', steps: [{id: 'a', label: 'A', status: 'later'}]}), /AMCP_UI_STATUS/);
});

test('cards: a KPI tile tells zero from missing, a platform card has one action, a creative card can be selected', () => {
  const {UI, render} = setup(),
    zero = render(UI.kpi({label: 'Conversions', value: '0', note: 'Last 7 days'})).querySelector('article'),
    missing = render(UI.kpi({label: 'Spend', value: null, note: 'No platform has returned spend yet.'})).querySelector(
      'article',
    );
  assert.equal(zero.querySelector('.amcp-kpi-value').textContent.trim(), '0');
  assert.equal(
    zero.querySelector('dt .amcp-kpi-label').textContent,
    'Conversions',
    'the label and value are a term and its definition',
  );
  assert.equal(zero.querySelector('dd.amcp-kpi-value').closest('dl'), zero.querySelector('dt').closest('dl'));
  assert.equal(missing.querySelector('.amcp-kpi-value bdi').textContent, '—');
  assert.equal(attr(missing, 'data-state'), 'missing');
  assert.match(missing.querySelector('.amcp-visually-hidden').textContent, /No data/);
  assert.equal(attr(zero, 'data-state'), null);
  // A zero that arrives as a number is a figure too: only null, undefined and an empty string are missing.
  const numeric = render(UI.kpi({label: 'Clicks', value: 0})).querySelector('article');
  assert.equal(numeric.querySelector('.amcp-kpi-value bdi').textContent, '0');
  assert.equal(attr(numeric, 'data-state'), null);
  assert.equal(
    render(UI.kpi({label: 'Clicks', value: undefined}))
      .querySelector('article')
      .getAttribute('data-state'),
    'missing',
  );
  const platform = render(
    UI.platformCard({
      name: 'Meta',
      status: {tone: 'success', label: 'Connected'},
      meta: '3 accounts',
      action: {label: 'Manage', href: '/connections'},
    }),
  ).querySelector('article');
  assert.equal(attr(platform, 'aria-labelledby'), platform.querySelector('h3').id);
  assert.equal(platform.querySelectorAll('.amcp-badge').length, 1);
  assert.equal(platform.querySelectorAll('a.amcp-button').length, 1);
  const creative = render(
    UI.creativeCard({
      id: 'c1',
      title: 'Spring hero',
      meta: '1080 × 1080',
      selectable: true,
      selected: true,
      mediaLabel: 'Preview of Spring hero',
      badges: [{label: 'Approved', tone: 'success'}],
    }),
  ).querySelector('article');
  assert.equal(attr(creative, 'data-selected'), 'true');
  assert.equal(creative.querySelector('input[type=checkbox]').checked, true);
  assert.equal(creative.querySelector('label').getAttribute('for'), creative.querySelector('input').id);
  assert.match(creative.querySelector('label').textContent, /Spring hero/);
  assert.equal(attr(creative.querySelector('[role=img]'), 'aria-label'), 'Preview of Spring hero');
  assert.equal(
    render(UI.creativeCard({id: 'c2', title: 'T', meta: 'm', mediaLabel: 'x'})).querySelectorAll('input').length,
    0,
  );
});
