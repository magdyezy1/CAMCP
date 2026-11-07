// V2-WEB-02: dialog, side sheet and toast (web/components-overlays.js). A dialog traps focus, makes the page behind it inert,
// closes on Escape and returns focus to what opened it; a sheet is the same panel at the end edge, modal or not; toasts are
// stacked in a polite live region, never take focus, and wait while the pointer or the keyboard is on them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadUI} from './helpers/web-ui-dom.mjs';

function setup() {
  const dom = loadUI(['components.js', 'components-overlays.js']),
    UI = dom.run('AmcpUI');
  const page = dom.mount('<main id="page"><button id="opener">Open</button><a id="later" href="/x">Later</a></main>');
  const portals = () => dom.document.body.children.filter(el => el !== page && el.hasAttribute('data-amcp-portal'));
  return {
    ...dom,
    UI,
    page,
    opener: page.querySelector('#opener'),
    active: () => dom.document.activeElement,
    portals,
    /** What the browser does for Escape on an open dialog: a cancelable cancel event, then close unless it was prevented. */
    escape(dialog) {
      const event = new dom.FakeEvent('cancel');
      dialog.dispatchEvent(event);
      if (!event.defaultPrevented) dialog.close();
    },
  };
}
const attr = (element, name) => element.getAttribute(name);

test('a dialog is a modal named by its title and described by its body, with the page behind it inert', () => {
  const {UI, page, opener, portals, active} = setup();
  opener.focus();
  const dialog = UI.dialog.open({
      title: 'Delete this report?',
      body: 'The saved copies stay.',
      size: 'sm',
      actions: [
        {label: 'Cancel', value: 'cancel'},
        {label: 'Delete', value: 'delete', variant: 'danger'},
      ],
    }),
    element = dialog.element;
  assert.equal(element.localName, 'dialog');
  assert.equal(element.open, true);
  assert.equal(element.modal, true, 'opened with showModal');
  assert.equal(attr(element, 'aria-labelledby'), element.querySelector('h2').id);
  assert.equal(attr(element, 'aria-describedby'), element.querySelector('.amcp-dialog-body').id);
  assert.equal(element.querySelector('h2').textContent, 'Delete this report?');
  assert.equal(attr(element, 'data-size'), 'sm');
  assert.equal(page.inert, true, 'everything behind the dialog is inert');
  assert.equal(portals()[0].inert, false, 'the dialog itself is not');
  assert.equal(element.querySelector('.amcp-dialog-header button').getAttribute('aria-label'), 'Close');
  assert.deepEqual(
    element
      .querySelectorAll('.amcp-dialog-actions button')
      .map(button => [button.textContent, attr(button, 'data-variant')]),
    [
      ['Cancel', 'secondary'],
      ['Delete', 'danger'],
    ],
  );
  assert.notEqual(active(), opener, 'focus moved into the dialog');
  assert.ok(element.contains(active()));
});

test('Escape and the Close button close it, give the answer, and return focus to what opened it', async () => {
  const {UI, page, opener, active, escape} = setup();
  opener.focus();
  const dialog = UI.dialog.open({title: 'Title', body: 'Body', actions: [{label: 'OK', value: 'ok'}]});
  escape(dialog.element);
  assert.equal(await dialog.closed, 'dismiss');
  assert.equal(active(), opener, 'focus returns to the opener');
  assert.equal(page.inert, false);
  assert.equal(dialog.element.isConnected, false, 'a closed dialog leaves the document');
  const again = UI.dialog.open({title: 'Title', body: 'Body', actions: [{label: 'OK', value: 'ok'}]});
  again.element.querySelector('.amcp-dialog-header button').click();
  assert.equal(await again.closed, 'dismiss');
  assert.equal(active(), opener);
});

test('an action closes it with its own value, and a backdrop click dismisses it only when allowed', async () => {
  const {UI, opener, FakeEvent} = setup();
  opener.focus();
  const first = UI.dialog.open({
    title: 'T',
    body: 'B',
    actions: [
      {label: 'Cancel', value: 'cancel'},
      {label: 'Go', value: 'go', variant: 'primary'},
    ],
  });
  first.element.querySelectorAll('.amcp-dialog-actions button')[1].click();
  assert.equal(await first.closed, 'go');
  const second = UI.dialog.open({title: 'T', body: 'B', actions: [{label: 'OK', value: 'ok'}]});
  second.element.dispatchEvent(new FakeEvent('click'));
  assert.equal(await second.closed, 'dismiss', 'a click on the backdrop (the dialog element itself) dismisses');
  const third = UI.dialog.open({title: 'T', body: 'B', dismissible: false, actions: [{label: 'OK', value: 'ok'}]});
  third.element.dispatchEvent(new FakeEvent('click'));
  const cancel = new FakeEvent('cancel');
  third.element.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true, 'a dialog that must be answered ignores Escape');
  assert.equal(third.element.open, true);
  third.close('ok');
  assert.equal(await third.closed, 'ok');
});

test('Tab stays inside the dialog: from the last control to the first, and back', () => {
  const {UI, opener, key, active} = setup();
  opener.focus();
  const dialog = UI.dialog.open({
      title: 'T',
      body: 'Body',
      actions: [
        {label: 'One', value: 'one'},
        {label: 'Two', value: 'two'},
      ],
    }),
    controls = dialog.element.querySelectorAll('button'),
    last = controls.at(-1),
    first = controls[0];
  last.focus();
  assert.equal(key(last, 'Tab').defaultPrevented, true);
  assert.equal(active(), first);
  assert.equal(key(first, 'Tab', {shiftKey: true}).defaultPrevented, true);
  assert.equal(active(), last);
  const middle = controls[1];
  middle.focus();
  assert.equal(key(middle, 'Tab').defaultPrevented, false, 'inside the dialog Tab is left to the browser');
});

test('a confirmation that destroys something is an alertdialog and starts on the safe choice', () => {
  const {UI, active} = setup(),
    dialog = UI.dialog.open({
      title: 'Delete?',
      body: 'This cannot be undone.',
      role: 'alertdialog',
      actions: [
        {label: 'Cancel', value: 'cancel', initial: true},
        {label: 'Delete', value: 'delete', variant: 'danger'},
      ],
    });
  assert.equal(attr(dialog.element, 'role'), 'alertdialog');
  assert.equal(active().textContent, 'Cancel');
});

test('a dialog can be busy or show an error without closing', async () => {
  const {UI} = setup(),
    dialog = UI.dialog.open({
      title: 'T',
      body: 'B',
      actions: [
        {label: 'Cancel', value: 'cancel'},
        {label: 'Save', value: 'save', variant: 'primary'},
      ],
    }),
    panel = dialog.element.querySelector('[data-amcp=dialog]'),
    buttons = dialog.element.querySelectorAll('.amcp-dialog-actions button');
  dialog.setLoading(true);
  assert.equal(attr(panel, 'aria-busy'), 'true');
  assert.ok(
    buttons.every(button => button.disabled),
    'nothing can be pressed twice while it works',
  );
  dialog.setError('The report could not be saved.');
  const error = dialog.element.querySelector('.amcp-dialog-error');
  assert.equal(attr(error, 'role'), 'alert');
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /could not be saved/);
  dialog.setLoading(false);
  assert.ok(buttons.every(button => !button.disabled));
  assert.equal(attr(panel, 'aria-busy'), null);
  dialog.setError(null);
  assert.equal(error.hidden, true);
  dialog.close('cancel');
  assert.equal(await dialog.closed, 'cancel');
});

test('a side sheet is the same panel at the end edge: modal and inert, or non-modal and not', async () => {
  const {UI, page, opener, escape, key, active} = setup();
  opener.focus();
  const modal = UI.sheet.open({title: 'Details', body: 'Body', actions: [{label: 'Done', value: 'done'}]});
  assert.equal(attr(modal.element, 'data-kind'), 'sheet');
  assert.equal(attr(modal.element, 'data-side'), 'end');
  assert.equal(modal.element.modal, true);
  assert.equal(page.inert, true);
  escape(modal.element);
  assert.equal(await modal.closed, 'dismiss');
  assert.equal(active(), opener);
  const side = UI.sheet.open({title: 'Details', body: 'Body', modal: false, side: 'start'});
  assert.equal(attr(side.element, 'data-side'), 'start');
  assert.equal(side.element.modal, false, 'opened with show');
  assert.equal(page.inert, false, 'the page stays usable beside a non-modal sheet');
  const close = side.element.querySelector('.amcp-dialog-header button');
  close.focus();
  key(close, 'Escape');
  assert.equal(await side.closed, 'dismiss', 'a non-modal sheet closes on Escape itself');
  assert.equal(active(), opener);
});

function toastPage() {
  const page = setup(),
    host = page.mount('<div id="toast-host"></div>').querySelector('#toast-host'),
    toasts = page.UI.toasts.mount(host);
  return {...page, host, toasts, items: () => host.querySelectorAll('li.amcp-toast')};
}

test('toasts are a labelled region with a polite list, a word and an icon for each, and a Dismiss button', () => {
  const {host, toasts, items} = toastPage();
  const region = host.querySelector('.amcp-toasts');
  assert.equal(attr(region, 'role'), 'region');
  assert.equal(attr(region, 'aria-label'), 'Notifications');
  assert.equal(attr(host.querySelector('ol'), 'aria-live'), 'polite');
  toasts.show({tone: 'success', message: 'Report saved.'});
  toasts.show({tone: 'danger', message: 'Export failed.', action: {label: 'Try again', attrs: {'data-retry': ''}}});
  assert.equal(items().length, 2);
  assert.match(items()[0].textContent, /Report saved\./);
  assert.equal(items()[0].querySelectorAll('svg').length >= 1, true);
  assert.equal(items()[1].querySelectorAll('button[data-retry]').length, 1);
  assert.ok(items().every(item => item.querySelector('button[aria-label="Dismiss"]')));
  assert.throws(() => toasts.show({tone: 'loud', message: 'x'}), /AMCP_UI_TONE/);
  assert.throws(() => toasts.show({tone: 'info'}), /AMCP_UI_MESSAGE/);
});

test('toasts never take focus; success and info leave on their own, warnings and errors stay until dismissed', () => {
  const {host, toasts, items, tick, active, opener} = toastPage();
  opener.focus();
  toasts.show({tone: 'info', message: 'Copied.'});
  toasts.show({tone: 'danger', message: 'Failed.'});
  toasts.show({tone: 'warning', message: 'Partial data.'});
  assert.equal(active(), opener, 'a toast does not steal focus');
  tick(6000);
  assert.deepEqual(
    items().map(item => item.getAttribute('data-tone')),
    ['danger', 'warning'],
  );
  items()[0].querySelector('button[aria-label="Dismiss"]').click();
  assert.deepEqual(
    items().map(item => item.getAttribute('data-tone')),
    ['warning'],
  );
  assert.equal(host.querySelectorAll('li').length, 1);
});

test('the pointer or the keyboard on a toast holds its timer; leaving restarts it', () => {
  const {toasts, items, tick, FakeEvent} = toastPage();
  toasts.show({tone: 'success', message: 'Saved.'});
  const item = items()[0];
  item.dispatchEvent(new FakeEvent('mouseover'));
  tick(6000);
  assert.equal(items().length, 1, 'held while the pointer is on it');
  item.dispatchEvent(new FakeEvent('mouseout', {relatedTarget: null}));
  tick(6000);
  assert.equal(items().length, 0, 'gone after a full duration without it');
  toasts.show({tone: 'success', message: 'Again.'});
  const again = items()[0],
    button = again.querySelector('button');
  button.focus();
  tick(6000);
  assert.equal(items().length, 1, 'held while focus is inside it');
});

test('only a few toasts stack, the oldest leaves first, and Escape on a focused toast dismisses it and returns focus', () => {
  const {toasts, items, key, active, opener, host} = toastPage();
  for (const message of ['One', 'Two', 'Three', 'Four']) toasts.show({tone: 'danger', message});
  assert.deepEqual(
    items().map(item => item.textContent.includes('One')),
    [false, false, false],
    'at most three at once',
  );
  assert.match(items()[0].textContent, /Two/);
  opener.focus();
  toasts.show({tone: 'danger', message: 'Five'});
  const dismiss = items().at(-1).querySelector('button[aria-label="Dismiss"]');
  dismiss.focus();
  const event = key(dismiss, 'Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(items().length, 2);
  assert.equal(active(), opener, 'focus goes back to where it was before the toast');
  toasts.clear();
  assert.equal(host.querySelectorAll('li').length, 0);
});
