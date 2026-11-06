// F-L8-01: a form submitted from script has no submitter. `form.requestSubmit()` with no argument fires `submit` with
// `event.submitter === null`, and authBind (which wraps every form handler of the website) read `e.submitter` and set
// `disabled` on it before its `try`, so the handler never ran: the failed-source card's Retry did nothing and the
// console said "Cannot set properties of null (setting 'disabled')". These tests run the website's own authBind.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script, createContext} from 'node:vm';

const identity = readFileSync('web/identity.js', 'utf8'),
  // focusKey, focusScopes, restoreFocus and authBind: the binding and what it needs to keep focus.
  source = identity.slice(
    identity.indexOf('function focusKey('),
    identity.indexOf('async function renderAccountPage()'),
  );

/** An element with the few members authBind reads and writes. */
function element(tagName, {id = '', parent = null} = {}) {
  const attributes = new Map();
  return {
    tagName,
    id,
    isConnected: true,
    disabled: false,
    parentElement: parent,
    attributes: [],
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name) ?? null,
    removeAttribute: name => attributes.delete(name),
    focus() {},
  };
}
/** A form with the given submit buttons; querySelector finds the first of them for the selector authBind asks with. */
function form(buttonIds = ['pull']) {
  const node = element('FORM', {id: 'overview-config'});
  node.buttons = buttonIds.map(id => element('BUTTON', {id, parent: node}));
  node.querySelector = selector =>
    /button\[type="?submit"?\]|button:not\(\[type\]\)/.test(selector) ? (node.buttons[0] ?? null) : null;
  return node;
}
/** authBind on a page whose only form is `node`; `run(event)` fires its submit listener and reports what happened. */
function bind(node, {fail} = {}) {
  const seen = [],
    toasts = [];
  let listener;
  node.addEventListener = (type, fn) => {
    assert.equal(type, 'submit', 'a form is bound to submit');
    listener = fn;
  };
  const context = createContext({
    CSS: {escape: String},
    navigationGeneration: 1,
    errorMessage: error => String(error?.message ?? error),
    toast: message => toasts.push(message),
    $: () => null,
    document: {
      body: {},
      activeElement: null,
      querySelector: () => null,
      querySelectorAll: selector => (selector === '#overview-config' ? [node] : []),
    },
    // The form's handler: records which buttons are busy while it runs.
    handler: async () => {
      seen.push(node.buttons.filter(button => button.getAttribute('aria-busy') === 'true').map(button => button.id));
      if (fail) throw Error(fail);
    },
  });
  new Script(source).runInContext(context);
  new Script("authBind('#overview-config', handler)").runInContext(context);
  return {
    seen,
    toasts,
    async run(submitter) {
      const event = {
        submitter,
        prevented: false,
        preventDefault() {
          this.prevented = true;
        },
      };
      await listener(event);
      return event;
    },
  };
}

test('a form submitted with no submitter still runs its handler, with its own submit button busy meanwhile', async () => {
  const node = form(),
    page = bind(node),
    event = await page.run(null);
  assert.equal(event.prevented, true);
  assert.deepEqual(page.seen, [['pull']], 'the handler ran once while the form’s submit button was busy');
  assert.equal(node.buttons[0].disabled, false, 'the button is free again afterwards');
  assert.equal(node.buttons[0].getAttribute('aria-busy'), null);
  assert.deepEqual(page.toasts, []);
});

test('a submitted form keeps using the button that submitted it', async () => {
  const node = form(['pull', 'save']),
    page = bind(node);
  await page.run(node.buttons[1]);
  assert.deepEqual(page.seen, [['save']], 'the submitter was busy, the form’s first button was left alone');
  assert.equal(node.buttons[1].disabled, false);
  assert.equal(node.buttons[1].getAttribute('aria-busy'), null);
});

test('a form with no submit button and no submitter still runs its handler without an error', async () => {
  const node = form([]),
    page = bind(node);
  await page.run(null);
  assert.deepEqual(page.seen, [[]]);
  assert.deepEqual(page.toasts, [], 'nothing is reported as an error');
});

test('a handler that fails frees the button and reports its error', async () => {
  const node = form(),
    page = bind(node, {fail: 'The report request failed.'});
  await page.run(null);
  assert.deepEqual(page.toasts, ['The report request failed.']);
  assert.equal(node.buttons[0].disabled, false);
  assert.equal(node.buttons[0].getAttribute('aria-busy'), null);
});
