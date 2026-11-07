// The test DOM behind the component tests (tests/helpers/web-ui-dom.mjs) has to behave like the parts of a browser the
// components rely on, or every keyboard test built on it proves nothing. These tests pin those parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDom, loadUI} from './helpers/web-ui-dom.mjs';

test('markup becomes elements with attributes, text, entities, void and self-closing tags', () => {
  const dom = createDom(),
    root = dom.mount(
      '<ul id="list" class="a b" data-amcp="tabs" hidden><li role="tab" aria-selected="true">One &amp; &lt;two&gt;</li><li><input type="checkbox" checked><svg><path d="M0 0"/></svg></li></ul>',
    );
  const list = root.querySelector('#list');
  assert.equal(list.getAttribute('data-amcp'), 'tabs');
  assert.equal(list.dataset.amcp, 'tabs');
  assert.equal(list.hidden, true);
  assert.deepEqual(list.classes(), ['a', 'b']);
  assert.equal(root.querySelector('[role=tab]').textContent, 'One & <two>');
  assert.equal(root.querySelector('input').checked, true);
  assert.equal(root.querySelectorAll('li').length, 2);
  assert.equal(root.querySelector('path').parentElement.localName, 'svg');
  assert.equal(root.querySelector('li > input').closest('ul'), list);
  assert.equal(root.querySelectorAll('li:not([role]) *').length, 3);
  assert.equal(root.querySelector('.a.b[data-amcp^="ta"]'), list);
});

test('events bubble through ancestors and the document, stop when asked, and focus moves with focus events', () => {
  const dom = createDom(),
    root = dom.mount(
      '<div id="outer"><button id="a">A</button><button id="b" disabled>B</button><span id="c" tabindex="-1">C</span></div>',
    ),
    seen = [];
  root.addEventListener('keydown', event => seen.push(['root', event.key, event.target.id]));
  dom.document.addEventListener('keydown', event => seen.push(['document', event.key]));
  root.querySelector('#a').focus();
  assert.equal(dom.document.activeElement.id, 'a');
  const event = dom.key(root.querySelector('#a'), 'ArrowDown');
  assert.deepEqual(seen, [
    ['root', 'ArrowDown', 'a'],
    ['document', 'ArrowDown'],
  ]);
  assert.equal(event.defaultPrevented, false);
  root.querySelector('#b').focus();
  assert.equal(dom.document.activeElement.id, 'a', 'a disabled button cannot take focus');
  root.querySelector('#c').focus();
  assert.equal(dom.document.activeElement.id, 'c', 'tabindex -1 can be focused by a script');
  const focusout = [];
  root.addEventListener('focusout', e => focusout.push(e.target.id));
  root.querySelector('#a').focus();
  assert.deepEqual(focusout, ['c']);
});

test('a checkbox click toggles it and fires input and change; a radio click clears its group', () => {
  const dom = createDom(),
    root = dom.mount(
      '<form><input id="x" type="checkbox"><input id="r1" type="radio" name="g" checked><input id="r2" type="radio" name="g"></form>',
    ),
    fired = [];
  for (const type of ['click', 'input', 'change']) root.addEventListener(type, () => fired.push(type));
  root.querySelector('#x').click();
  assert.equal(root.querySelector('#x').checked, true);
  assert.deepEqual(fired, ['click', 'input', 'change']);
  root.querySelector('#r2').click();
  assert.equal(root.querySelector('#r1').checked, false);
  assert.equal(root.querySelector('#r2').checked, true);
});

test('the shipped scripts run over it: html``, setHtml and uiText write elements', () => {
  const ui = loadUI([]),
    host = ui.mount('<div id="host"></div>').querySelector('#host');
  ui.context.host = host;
  ui.run("setHtml(host, html`<p class=\"${'x y'}\" title=\"${'a\"b'}\">${uiText('Hello')}</p>`)");
  assert.equal(host.querySelector('p').getAttribute('title'), 'a"b');
  assert.equal(host.querySelector('p.x.y').textContent, 'Hello');
  assert.throws(() => ui.run("setHtml(host, '<p>')"), /takes html/);
});
