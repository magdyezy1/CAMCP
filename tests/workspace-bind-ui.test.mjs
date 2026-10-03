import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
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
      disabled: false,
      addEventListener(_name, fn) {
        handler = fn;
      },
    };
    const context = createContext({
      navigationGeneration: 1,
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
