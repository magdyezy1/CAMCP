import test from 'node:test';
import assert from 'node:assert/strict';
import {checkBrowserTables, regionScrolled} from '../tools/browser-table-qa.mjs';

// QA follow-up (wave 4a integration): the rendered table check waited for the keyboard scroll with
// `document.querySelector(marker)?.scrollLeft !== start`. When a re-render replaced the region the selector found
// nothing, `undefined !== start` was true and the wait passed although nothing scrolled. The wait now holds the element
// itself and fails once it leaves the document; after the wait the same element must still be attached and have moved.
test('the wait passes only for the same element, still attached, once it has moved', () => {
  assert.equal(regionScrolled({element: {isConnected: true, scrollLeft: 0}, startingPosition: 0}), false);
  assert.equal(regionScrolled({element: {isConnected: true, scrollLeft: 40}, startingPosition: 0}), true);
  // RTL tables scroll to negative positions.
  assert.equal(regionScrolled({element: {isConnected: true, scrollLeft: -40}, startingPosition: 0}), true);
  for (const element of [{isConnected: false, scrollLeft: 40}, null, undefined])
    assert.throws(() => regionScrolled({element, startingPosition: 0}), /BROWSER_TABLE_REGION_DETACHED/);
  // The old predicate passed for a region that was gone.
  const old = ({selector, startingPosition}) =>
    ({querySelector: () => null}).querySelector(selector)?.scrollLeft !== startingPosition;
  assert.equal(old({selector: '[data-browser-qa-scroll=selected]', startingPosition: 0}), true);
});

/**
 * A page with one wide table region. `keyPress(element)` decides what the arrow key does; waitForFunction polls the
 * predicate as Playwright does (a thrown error rejects the wait, a timeout rejects after the polls).
 */
function fakePage(keyPress) {
  const element = {
    isConnected: true,
    scrollLeft: 25,
    scrollTop: 0,
    clientWidth: 100,
    scrollWidth: 300,
    tabIndex: 0,
    querySelector: () => ({textContent: ' Campaign rows '}),
    getAttribute: () => 'Campaign table',
  };
  const handle = {
    evaluate: async (fn, arg) => fn(element, arg),
    dispose: async () => {
      handle.disposed = true;
    },
  };
  const region = {
    isVisible: async () => true,
    locator: () => ({count: async () => 1}),
    evaluate: async (fn, arg) => fn(element, arg),
    elementHandle: async () => handle,
    focus: async () => {},
  };
  const page = {
    locator: () => ({all: async () => [region]}),
    keyboard: {press: async key => keyPress(element, key)},
    async waitForFunction(fn, arg) {
      const resolved = {...arg, element: arg.element === handle ? element : arg.element};
      for (let poll = 0; poll < 5; poll++) if (fn(resolved)) return true;
      throw new Error('Timeout waiting for the function');
    },
  };
  return {page, element, handle};
}

test('a table that scrolls by keyboard passes, and its scroll position is restored', async t => {
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({direction: 'ltr'});
  t.after(() => (globalThis.getComputedStyle = original));
  const keys = [],
    f = fakePage((element, key) => {
      keys.push(key);
      element.scrollLeft += 40;
    }),
    result = {};
  await checkBrowserTables(f.page, result);
  assert.deepEqual(keys, ['ArrowRight']);
  assert.equal(result.tables.length, 1);
  assert.equal(f.element.scrollLeft, 25, 'the starting position is restored');
  assert.equal(f.handle.disposed, true);
});

test('a region replaced by a re-render fails the check instead of passing it, and one that never scrolls times out', async t => {
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({direction: 'rtl'});
  t.after(() => (globalThis.getComputedStyle = original));
  const replaced = fakePage((element, key) => {
    assert.equal(key, 'ArrowLeft', 'an RTL table scrolls with ArrowLeft');
    element.isConnected = false;
  });
  await assert.rejects(checkBrowserTables(replaced.page, {}), /BROWSER_TABLE_REGION_DETACHED/);
  assert.equal(replaced.handle.disposed, true);
  const stuck = fakePage(() => {});
  await assert.rejects(checkBrowserTables(stuck.page, {}), /Timeout waiting/);
  // A wait that passes while the element leaves afterwards is caught by the read after it.
  const late = fakePage(element => {
    element.scrollLeft += 40;
  });
  late.page.waitForFunction = async (fn, arg) => {
    fn({...arg, element: late.element});
    late.element.isConnected = false;
    return true;
  };
  await assert.rejects(checkBrowserTables(late.page, {}), /left the document/);
});
