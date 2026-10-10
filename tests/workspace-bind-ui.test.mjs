import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
function focusFixture(open) {
  const closed = {open},
    focused = [],
    cancel = {isConnected: true, closest: () => closed},
    trigger = {disabled: false, focus: () => focused.push('trigger')};
  const context = createContext({
    document: {
      activeElement: cancel,
      body: {},
      querySelector: key => (key === '[data-push-delete="0"]' ? trigger : null),
    },
  });
  const source = readFileSync('web/identity.js', 'utf8'),
    start = source.indexOf('function restoreFocus('),
    end = source.indexOf('\nfunction authBind(', start);
  new Script(source.slice(start, end)).runInContext(context);
  new Script('restoreFocus(\'[data-push-delete="0"]\')').runInContext(context);
  return focused;
}
test('a closed confirmation dialog cannot keep focus away from its restored source control', () => {
  assert.deepEqual(focusFixture(false), ['trigger']);
});
test('an open confirmation dialog keeps its intentional focus', () => {
  assert.deepEqual(focusFixture(true), []);
});
test('global click delegation does not re-enable controls owned by a workspace controller', async () => {
  let handler;
  const button = {tagName: 'BUTTON', dataset: {allocationAdd: 'native-id'}, isConnected: true, disabled: true};
  const context = createContext({
    document: {
      addEventListener(_event, fn) {
        handler = fn;
      },
    },
    clientNavigation: () => false,
    // Same-page fragment links are handled first (WEB-01); this control is not one.
    fragmentLink: () => null,
  });
  const s = readFileSync('web/app.js', 'utf8'),
    start = s.indexOf("document.addEventListener('click', async event =>"),
    end = s.indexOf("document.addEventListener('input'", start);
  new Script(s.slice(start, end)).runInContext(context);
  await handler({target: {closest: () => button}});
  assert.equal(button.disabled, true);
});
test('async workspace binding keeps a selected candidate disabled and otherwise restores its control', async () => {
  for (const retain of [false, true]) {
    let handler,
      selected = false;
    const button = {
      tagName: 'BUTTON',
      isConnected: true,
      disabled: false,
      addEventListener(_name, fn) {
        handler = fn;
      },
    };
    const context = createContext({
      navigationGeneration: 1,
      identityGeneration: 1,
      focusKey: () => null,
      focusScopes: () => [],
      restoreFocus() {},
      document: {querySelectorAll: () => [button]},
      toast() {},
      errorMessage: String,
      choose: async () => {
        assert.equal(button.disabled, true);
        selected = true;
      },
      options: retain ? {disabled: () => selected} : {},
    });
    const s = readFileSync('web/workspace.js', 'utf8'),
      start = s.indexOf('function workspaceBind('),
      end = s.indexOf('\nasync function ', start);
    new Script(s.slice(start, end)).runInContext(context);
    new Script("workspaceBind('[data-add]',choose,options)").runInContext(context);
    await handler({preventDefault() {}});
    assert.equal(selected, true);
    assert.equal(button.disabled, retain);
  }
});
