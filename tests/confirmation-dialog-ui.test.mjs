import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture() {
  const listeners = new Map(),
    nodes = new Map(),
    document = {activeElement: null};
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        textContent: '',
        returnValue: '',
        open: false,
        focus() {
          document.activeElement = this;
        },
        showModal() {
          this.open = true;
        },
        addEventListener(event, fn) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event).add(fn);
        },
        removeEventListener(event, fn) {
          listeners.get(event)?.delete(fn);
        },
      });
    return nodes.get(id);
  };
  const context = createContext({$: node, document, uiText: String});
  const source = readFileSync('web/app.js', 'utf8');
  new Script(source.slice(source.indexOf('function confirmAction('), source.indexOf('let toastTimer;'))).runInContext(
    context,
  );
  return {
    document,
    node,
    listeners,
    open: () =>
      new Script("confirmAction({title:'Local draft',consequence:'No advertising submission'})").runInContext(context),
    tab(shiftKey = false) {
      let prevented = false;
      for (const fn of listeners.get('keydown') ?? [])
        fn({
          key: 'Tab',
          shiftKey,
          preventDefault() {
            prevented = true;
          },
        });
      return prevented;
    },
    close(value = '') {
      node('#action-dialog').returnValue = value;
      node('#action-dialog').open = false;
      for (const fn of [...(listeners.get('close') ?? [])]) fn();
    },
  };
}
test('confirmation keeps forward and reverse Tab inside its two controls', async () => {
  const f = fixture(),
    pending = f.open();
  assert.equal(f.document.activeElement, f.node('#action-cancel'));
  assert.equal(f.tab(), false);
  f.node('#action-confirm').focus();
  assert.equal(f.tab(), true);
  assert.equal(f.document.activeElement, f.node('#action-cancel'));
  assert.equal(f.tab(true), true);
  assert.equal(f.document.activeElement, f.node('#action-confirm'));
  f.close();
  assert.equal(await pending, false);
});
test('closing a confirmation removes its keyboard handler before the next confirmation', async () => {
  const f = fixture();
  for (const value of ['', 'confirm']) {
    const pending = f.open();
    assert.equal(f.listeners.get('keydown')?.size, 1);
    f.close(value);
    assert.equal(await pending, value === 'confirm');
    assert.equal(f.listeners.get('keydown')?.size, 0);
    assert.equal(f.listeners.get('close')?.size, 0);
    assert.equal(f.tab(), false);
  }
});
