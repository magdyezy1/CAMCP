// DR2-03 (differential review, wave 5 round 2): a link a component draws takes a safe address only. AmcpUI.button and the
// action of the empty, error and platform components put any `href` in an anchor, so a page that passed a provider's or an
// export's address would hand a one-click script (`javascript:`) to the browser. The decision is made on the address as a
// browser reads it (web/components.js amcpHref), so every spelling of a script address fails closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadUI} from './helpers/web-ui-dom.mjs';

function setup() {
  const dom = loadUI(['components.js', 'components-overlays.js']),
    UI = dom.run('AmcpUI');
  dom.run('AmcpUI.bind(document.body)');
  return {...dom, UI, render: markup => dom.mount(String(markup))};
}
// The scripts run in a vm context, so a TypeError they throw is not an instance of this realm's TypeError: the name is.
const refusal = component => error =>
  error.name === 'TypeError' &&
  error.message.startsWith('AMCP_UI_HREF: ' + component + ' ') &&
  !/alert|evil|example\.test|reports/.test(error.message);

// Spellings a browser reads as a script, a data document, another site, or as no address at all.
const refused = {
  'javascript:': 'javascript:alert(1)',
  'JAVASCRIPT:': 'JAVASCRIPT:alert(1)',
  'JaVaScRiPt:': 'JaVaScRiPt:alert(1)',
  'a tab inside the scheme': 'java\tscript:alert(1)',
  'a line break inside the scheme': 'java\nscript:alert(1)',
  'a carriage return inside the scheme': 'java\rscript:alert(1)',
  'a leading space': ' javascript:alert(1)',
  'a leading tab': '\tjavascript:alert(1)',
  'a leading control character': '\u0001javascript:alert(1)',
  'a leading NUL': '\u0000javascript:alert(1)',
  'a leading form feed': '\fjavascript:alert(1)',
  'a trailing space': 'javascript:alert(1) ',
  'data:': 'data:text/html,<script>alert(1)</script>',
  'DATA: base64': 'DATA:text/html;base64,PHNjcmlwdD4=',
  'vbscript:': 'vbscript:msgbox(1)',
  'blob:': 'blob:https://example.test/0000',
  'file:': 'file:///etc/hosts',
  'ftp:': 'ftp://example.test/x',
  'tel:': 'tel:+15550100',
  'about:': 'about:blank',
  'a protocol-relative address': '//evil.example/x',
  'a protocol-relative address after a space': ' //evil.example/x',
  'a backslash after the slash': '/\\evil.example',
  'two backslashes': '\\\\evil.example',
  'a backslash then a slash': '\\/evil.example',
  'a tab between the slashes': '/\t/evil.example',
  'a line break between the slashes': '/\n/evil.example',
  'a path with no leading slash': 'reports',
  'a dot path': './reports',
  'a parent path': '../reports',
  'a query alone': '?q=1',
  'an empty address': '',
  'white space only': '   ',
  'a scheme with no host': 'https://',
};
// Only a string can be an address: a number, an object or `true` is refused, not printed.
const notStrings = {number: 7, object: {toString: () => '/reports'}, array: ['/reports'], true: true};

test('a button with a script, data, protocol-relative or relative address is refused, whatever its spelling', () => {
  const {UI} = setup();
  for (const [label, href] of Object.entries({...refused, ...notStrings}))
    assert.throws(() => UI.button({label: 'Open', href}), refusal('button'), label);
  // A disabled link draws no href, but the address is still checked: a bad one fails in development, not when enabled.
  assert.throws(() => UI.button({label: 'Open', href: refused['javascript:'], disabled: true}), refusal('button'));
  assert.throws(() => UI.button({label: 'Open', href: refused['javascript:'], loading: true}), refusal('button'));
  // An icon button is a button, and the refusal says so.
  assert.throws(() => UI.iconButton({icon: 'next', label: 'Next', href: refused['javascript:']}), refusal('button'));
});

test('the empty, error and platform components refuse the address of their actions and name themselves', () => {
  const {UI} = setup();
  for (const [label, href] of Object.entries(refused)) {
    assert.throws(
      () => UI.emptyState({title: 'None', body: 'x', action: {label: 'Go', href}}),
      refusal('emptyState'),
      'emptyState ' + label,
    );
    assert.throws(
      () => UI.errorState({title: 'Failed', body: 'x', retry: {label: 'Retry', href}}),
      refusal('errorState'),
      'errorState retry ' + label,
    );
    assert.throws(
      () =>
        UI.errorState({
          title: 'Failed',
          body: 'x',
          retry: {label: 'Retry', href: '/reports'},
          secondary: {label: 'Help', href},
        }),
      refusal('errorState'),
      'errorState secondary ' + label,
    );
    assert.throws(
      () => UI.platformCard({name: 'Meta', action: {label: 'Manage', href}}),
      refusal('platformCard'),
      'platformCard ' + label,
    );
  }
});

test('the actions of a dialog and a toast take the same addresses', () => {
  const {UI, mount} = setup(),
    host = mount('<div id="toast-host"></div>').querySelector('#toast-host'),
    toasts = UI.toasts.mount(host);
  for (const [label, href] of Object.entries(refused)) {
    assert.throws(
      () => UI.dialog.open({title: 'T', body: 'B', actions: [{label: 'Go', href}]}),
      refusal('button'),
      'dialog ' + label,
    );
    assert.throws(
      () => toasts.show({message: 'Saved', action: {label: 'Open', href}}),
      refusal('button'),
      'toast ' + label,
    );
  }
  assert.equal(host.querySelectorAll('li.amcp-toast').length, 0, 'a refused action shows no toast');
});

// What an accepted address renders is exactly what these components rendered before the check existed.
const anchor = href =>
  `<a class="amcp-button" data-variant="secondary" data-size="md" href="${href}"><span class="amcp-button-label">Open</span></a>`;
const accepted = {
  'a same-site path': ['/reports', anchor('/reports')],
  'the site root': ['/', anchor('/')],
  'a path with a query and a fragment': ['/reports?a=1#top', anchor('/reports?a=1#top')],
  'a fragment': ['#section-a', anchor('#section-a')],
  'an https address': ['https://example.test/a?b=1&c=2', anchor('https://example.test/a?b=1&amp;c=2')],
  'an http address': ['http://example.test', anchor('http://example.test')],
  'a mailto address': ['mailto:a@example.test', anchor('mailto:a@example.test')],
  'an upper-case scheme': ['HTTPS://EXAMPLE.TEST/A', anchor('HTTPS://EXAMPLE.TEST/A')],
};

test('a same-site path, a fragment and an absolute https, http or mailto address render exactly as before', () => {
  const {UI, render} = setup();
  for (const [label, [href, markup]] of Object.entries(accepted)) {
    assert.equal(String(UI.button({label: 'Open', href})), markup, label);
    assert.equal(
      render(UI.button({label: 'Open', href}))
        .querySelector('a')
        .getAttribute('href'),
      href,
      label,
    );
  }
  // The other forms of the same markup: a disabled link has no href, a link with none draws none, and no href is a button.
  assert.equal(
    String(UI.button({label: 'Open', href: '/reports', disabled: true})),
    '<a class="amcp-button" data-variant="secondary" data-size="md" aria-disabled="true" tabindex="-1"><span class="amcp-button-label">Open</span></a>',
  );
  assert.equal(
    String(UI.button({label: 'Open', href: null})),
    '<a class="amcp-button" data-variant="secondary" data-size="md"><span class="amcp-button-label">Open</span></a>',
  );
  assert.match(String(UI.button({label: 'Open'})), /^<button /);
  assert.equal(
    String(UI.iconButton({icon: 'next', label: 'Next', href: '/reports'})),
    '<a class="amcp-button amcp-icon-button" data-variant="quiet" data-size="md" aria-label="Next" href="/reports"><svg class="amcp-icon " viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-mirror=""><path d="M9 6l6 6-6 6"/></svg></a>',
  );
  // The actions of the empty, error and platform components, and of a dialog and a toast.
  const empty = render(
    UI.emptyState({title: 'No reports', body: 'None yet.', action: {label: 'New report', href: '/reporting-overview'}}),
  );
  assert.equal(
    empty.querySelector('a').outerHTML,
    '<a class="amcp-button" data-variant="primary" data-size="md" href="/reporting-overview"><span class="amcp-button-label">New report</span></a>',
  );
  const error = render(
    UI.errorState({
      title: 'Failed',
      body: 'x',
      retry: {label: 'Retry', href: '/reports'},
      secondary: {label: 'Help', href: 'https://example.test/help'},
    }),
  );
  assert.deepEqual(
    error.querySelectorAll('a').map(a => a.getAttribute('href')),
    ['/reports', 'https://example.test/help'],
  );
  const card = render(UI.platformCard({name: 'Meta', action: {label: 'Manage', href: '/connections'}}));
  assert.equal(
    card.querySelector('a').outerHTML,
    '<a class="amcp-button" data-variant="secondary" data-size="md" href="/connections"><span class="amcp-button-label">Manage</span></a>',
  );
  const dialog = UI.dialog.open({
    title: 'Leave?',
    body: 'B',
    actions: [
      {label: 'Open reports', href: '/reports', value: 'go'},
      {label: 'Stay', value: 'stay'},
    ],
  });
  assert.equal(dialog.element.querySelector('footer a').getAttribute('href'), '/reports');
  assert.equal(dialog.element.querySelectorAll('footer button').length, 1);
});

test('a path, not another site: what the parser resolves must stay on the page’s own site', () => {
  const {UI} = setup();
  // Forms that begin with `/` and are accepted resolve to the same origin under the URL parser; the refused ones above
  // are exactly the spellings that do not (`//host`, `/\host`, tab or line break between the slashes).
  for (const href of ['/a', '/a/b?c=d#e', '/%2F/evil.example', '/a\\b', '/.//x'])
    assert.doesNotThrow(() => UI.button({label: 'Open', href}), href);
  for (const href of ['//a', '/\\a', '/\t/a', '\\/a', '/\r\n/a'])
    assert.throws(() => UI.button({label: 'Open', href}), refusal('button'), JSON.stringify(href));
});

// P2A-06 (differential review, wave 5 round 2 part 2a): (a) the clean-up of an address was quadratic on a long run of spaces
// inside it, so an address is judged on its length before anything reads it; (b) the attributes that take an address are
// refused in `attrs` as event handlers and style are, since an `attrs` map lands in the markup beside the checked `href`.
test('an address over 2,048 characters is refused before it is read, so a long run of spaces cannot stall a tab', () => {
  const {UI} = setup(),
    longest = '/' + 'a'.repeat(2047),
    longestAbsolute = 'https://example.test/' + 'a'.repeat(2027);
  assert.equal(longest.length, 2048);
  assert.equal(longestAbsolute.length, 2048);
  assert.equal(String(UI.button({label: 'Open', href: longest})), anchor(longest), '2,048 characters are taken');
  assert.equal(String(UI.button({label: 'Open', href: longestAbsolute})), anchor(longestAbsolute));
  for (const [label, href] of Object.entries({
    'a path of 2,049 characters': '/' + 'a'.repeat(2048),
    'an https address of 2,049 characters': 'https://example.test/' + 'a'.repeat(2028),
    'a long run of spaces inside a path': '/' + ' '.repeat(60000) + 'x',
    'a long run of tabs and spaces': ' \t'.repeat(40000) + '/x',
    'a long run of control characters': '\u0001'.repeat(100000) + '/x',
  })) {
    const started = performance.now();
    assert.throws(() => UI.button({label: 'Open', href}), refusal('button'), label);
    assert.ok(performance.now() - started < 250, label + ' took ' + (performance.now() - started) + ' ms');
  }
});

test('AmcpUI.attrs refuses the attributes that take an address, as it refuses event handlers and style', () => {
  const {UI} = setup();
  for (const name of ['formaction', 'src', 'srcdoc', 'action', 'data', 'xlink:href', 'onclick', 'onerror', 'style'])
    assert.throws(
      () => UI.attrs({[name]: 'javascript:alert(1)'}),
      error => error.message === 'AMCP_UI_ATTRIBUTE_NAME: ' + name,
      name,
    );
  // Where an attrs map lands in markup: a button (which a form may hold) and an input.
  for (const name of ['formaction', 'srcdoc', 'src', 'action', 'data', 'xlink:href'])
    assert.throws(
      () => UI.button({label: 'Go', attrs: {[name]: 'javascript:alert(1)'}}),
      /AMCP_UI_ATTRIBUTE_NAME/,
      'button ' + name,
    );
  // The names the components use stay: data-* and aria-* attributes, and the plain ones.
  for (const name of [
    'data-mirror',
    'data-source',
    'aria-label',
    'type',
    'title',
    'name',
    'value',
    'class',
    'id',
    'href',
  ])
    assert.doesNotThrow(() => UI.attrs({[name]: 'x'}), name);
});
