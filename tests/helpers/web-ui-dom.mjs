// A small DOM for the component tests (V2-WEB-02): enough of document, elements, selectors, events and focus to run the
// delegated behaviours of web/components*.js without a browser. Markup written by html`…` is parsed into elements; the
// scripts under test run in a vm context whose document is this one (loadUI). The rendered browser cases remain the proof
// of layout and of what a real browser does; this proves state, keyboard handling and ARIA, quickly and deterministically.
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';

const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr']);
const entities = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' '};
const decode = text => text.replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, match => entities[match]);
const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const kebab = name => name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
const focusableTags = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);

/** The markup of a node, as a browser's innerHTML would write it (enough for assertions on structure). */
function serialize(node) {
  if (node.nodeType === 3) return node.data.replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'})[c]);
  const attributes = [...node.attrs].map(([name, value]) => ' ' + name + '="' + value.replace(/"/g, '&quot;') + '"');
  return (
    '<' +
    node.localName +
    attributes.join('') +
    '>' +
    (voidTags.has(node.localName) ? '' : node.childNodes.map(serialize).join('') + '</' + node.localName + '>')
  );
}

/** One simple selector: tag, #id, .class, [attr], [attr=value], [attr^=|$=|*=|~=value], :not(simple), :first-child. */
function simple(text) {
  const parts = [];
  let rest = text;
  const take = (pattern, build) => {
    const match = pattern.exec(rest);
    if (match && match.index === 0) {
      parts.push(build(match));
      rest = rest.slice(match[0].length);
      return true;
    }
    return false;
  };
  while (rest) {
    const ok =
      take(/^\*/, () => () => true) ||
      take(/^[a-zA-Z][\w-]*/, m => el => el.localName === m[0].toLowerCase()) ||
      take(/^#([\w-]+)/, m => el => el.id === m[1]) ||
      take(/^\.([\w-]+)/, m => el => el.classList.contains(m[1])) ||
      take(/^\[([\w-]+)(?:([~^$*|]?=)(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\]/, m => el => {
        const value = el.getAttribute(m[1]);
        if (value === null) return false;
        if (!m[2]) return true;
        const wanted = m[3] ?? m[4] ?? m[5] ?? '';
        return {
          '=': value === wanted,
          '^=': value.startsWith(wanted),
          '$=': value.endsWith(wanted),
          '*=': value.includes(wanted),
          '~=': value.split(/\s+/).includes(wanted),
          '|=': value === wanted || value.startsWith(wanted + '-'),
        }[m[2]];
      }) ||
      take(/^:not\(([^)]*)\)/, m => {
        const inner = simple(m[1].trim());
        return el => !inner(el);
      }) ||
      take(/^:first-child/, () => el => el.parentElement?.children[0] === el) ||
      take(/^:last-child/, () => el => el.parentElement?.children.at(-1) === el) ||
      take(/^:checked/, () => el => !!el.checked) ||
      take(/^:disabled/, () => el => el.hasAttribute('disabled'));
    if (!ok) throw Error('The test DOM does not support the selector part "' + rest + '" in "' + text + '"');
  }
  return el => parts.every(test => test(el));
}
/** A complex selector: compound parts joined by " " (descendant) or ">" (child), and comma lists. */
function compile(selector) {
  const alternatives = selector
    .split(/,(?![^(]*\))/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const tokens = part.replace(/\s*>\s*/g, ' > ').split(/\s+(?![^(]*\))/);
      const chain = [];
      let combinator = ' ';
      for (const token of tokens) {
        if (token === '>') combinator = '>';
        else {
          chain.push({test: simple(token), combinator});
          combinator = ' ';
        }
      }
      return element => {
        const matches = (el, index) => {
          if (!chain[index].test(el)) return false;
          if (index === 0) return true;
          if (chain[index].combinator === '>') return !!el.parentElement && matches(el.parentElement, index - 1);
          for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement)
            if (matches(ancestor, index - 1)) return true;
          return false;
        };
        return matches(element, chain.length - 1);
      };
    });
  return element => alternatives.some(test => test(element));
}

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(
      this,
      {bubbles: true, cancelable: true, key: '', shiftKey: false, ctrlKey: false, altKey: false},
      init,
    );
    this.type = type;
    this.defaultPrevented = false;
    this.stopped = false;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
}

class FakeText {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    this.parentNode = null;
  }
  get textContent() {
    return this.data;
  }
}

class FakeElement {
  constructor(document, localName) {
    this.ownerDocument = document;
    this.nodeType = 1;
    this.localName = localName;
    this.tagName = localName.toUpperCase();
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.classList = {
      add: (...names) => this.setAttribute('class', [...new Set([...this.classes(), ...names])].join(' ')),
      remove: (...names) =>
        this.setAttribute(
          'class',
          this.classes()
            .filter(name => !names.includes(name))
            .join(' '),
        ),
      contains: name => this.classes().includes(name),
      toggle: (name, force) => {
        const on = force ?? !this.classes().includes(name);
        this.classList[on ? 'add' : 'remove'](name);
        return on;
      },
    };
    this.dataset = new Proxy(
      {},
      {
        get: (_, name) => this.getAttribute('data-' + kebab(String(name))) ?? undefined,
        set: (_, name, value) => (this.setAttribute('data-' + kebab(String(name)), String(value)), true),
        has: (_, name) => this.hasAttribute('data-' + kebab(String(name))),
        deleteProperty: (_, name) => (this.removeAttribute('data-' + kebab(String(name))), true),
      },
    );
    this.checkedState = null;
    this.valueState = null;
    this.returnValue = '';
  }
  classes() {
    return (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  }
  get className() {
    return this.getAttribute('class') ?? '';
  }
  set className(value) {
    this.setAttribute('class', value);
  }
  get id() {
    return this.getAttribute('id') ?? '';
  }
  set id(value) {
    this.setAttribute('id', value);
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name === 'value' && this.valueState === null) this.valueState = null;
  }
  removeAttribute(name) {
    this.attrs.delete(name);
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
  toggleAttribute(name, force) {
    const on = force ?? !this.hasAttribute(name);
    if (on) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return on;
  }
  get hidden() {
    return this.hasAttribute('hidden');
  }
  set hidden(value) {
    this.toggleAttribute('hidden', !!value);
  }
  get inert() {
    return this.hasAttribute('inert');
  }
  set inert(value) {
    this.toggleAttribute('inert', !!value);
  }
  get disabled() {
    return this.hasAttribute('disabled');
  }
  set disabled(value) {
    this.toggleAttribute('disabled', !!value);
  }
  get open() {
    return this.hasAttribute('open');
  }
  set open(value) {
    this.toggleAttribute('open', !!value);
  }
  get checked() {
    return this.checkedState ?? this.hasAttribute('checked');
  }
  set checked(value) {
    this.checkedState = !!value;
  }
  get indeterminate() {
    return !!this.indeterminateState;
  }
  set indeterminate(value) {
    this.indeterminateState = !!value;
  }
  get value() {
    if (this.valueState !== null) return this.valueState;
    if (this.localName === 'select') {
      const options = this.querySelectorAll('option'),
        chosen = options.find(option => option.hasAttribute('selected')) ?? options[0];
      return chosen ? (chosen.getAttribute('value') ?? chosen.textContent) : '';
    }
    return this.getAttribute('value') ?? (this.localName === 'textarea' ? this.textContent : '');
  }
  set value(value) {
    this.valueState = String(value);
  }
  get type() {
    return this.getAttribute('type') ?? (this.localName === 'button' ? 'submit' : 'text');
  }
  get name() {
    return this.getAttribute('name') ?? '';
  }
  get tabIndex() {
    const explicit = this.getAttribute('tabindex');
    if (explicit !== null) return Number(explicit);
    return focusableTags.has(this.localName) ? 0 : -1;
  }
  set tabIndex(value) {
    this.setAttribute('tabindex', value);
  }
  get children() {
    return this.childNodes.filter(node => node.nodeType === 1);
  }
  get parentElement() {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }
  get nextElementSibling() {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get previousElementSibling() {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  get isConnected() {
    for (let node = this; node; node = node.parentNode) if (node === this.ownerDocument.documentElement) return true;
    return false;
  }
  get textContent() {
    return this.childNodes.map(node => node.textContent).join('');
  }
  set textContent(value) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = String(value) ? [Object.assign(new FakeText(String(value)), {parentNode: this})] : [];
  }
  get innerText() {
    return this.textContent;
  }
  get innerHTML() {
    return this.childNodes.map(serialize).join('');
  }
  set innerHTML(markup) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    for (const node of this.ownerDocument.parseNodes(String(markup))) this.appendChild(node);
  }
  get outerHTML() {
    return serialize(this);
  }
  appendChild(node) {
    node.parentNode?.removeChild?.(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? new FakeText(node) : node);
  }
  prepend(node) {
    this.insertBefore(node, this.childNodes[0] ?? null);
  }
  insertBefore(node, before) {
    node.parentNode?.removeChild?.(node);
    node.parentNode = this;
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index < 0) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    return node;
  }
  removeChild(node) {
    this.childNodes = this.childNodes.filter(child => child !== node);
    node.parentNode = null;
    return node;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  walk() {
    const out = [];
    const visit = node => {
      for (const child of node.children) {
        out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  matches(selector) {
    return compile(selector)(this);
  }
  closest(selector) {
    const test = compile(selector);
    for (let node = this; node?.nodeType === 1; node = node.parentNode) if (test(node)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const test = compile(selector);
    return this.walk().filter(test);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getElementById(id) {
    return this.walk().find(el => el.id === id) ?? null;
  }
  addEventListener(type, listener, options) {
    const list = this.listeners.get(type) ?? [];
    list.push({listener, capture: options === true || options?.capture === true, once: options?.once === true});
    this.listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(entry => entry.listener !== listener),
    );
  }
  dispatchEvent(event) {
    event.target ??= this;
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    if (this.ownerDocument.windowObject) path.push(this.ownerDocument.windowObject);
    for (const node of event.bubbles ? path : [this]) {
      if (event.stopped) break;
      event.currentTarget = node;
      for (const entry of [...(node.listeners?.get(event.type) ?? [])]) {
        if (entry.once) node.removeEventListener(event.type, entry.listener);
        entry.listener.call(node, event);
      }
    }
    return !event.defaultPrevented;
  }
  focus() {
    const document = this.ownerDocument;
    if (!this.isConnected || this.hasAttribute('disabled') || this.closest('[inert]')) return;
    if (this.tabIndex < 0 && !this.hasAttribute('tabindex') && !focusableTags.has(this.localName)) return;
    const previous = document.activeElement;
    if (previous === this) return;
    if (previous) previous.blur(this);
    document.activeElement = this;
    this.dispatchEvent(new FakeEvent('focus', {bubbles: false}));
    this.dispatchEvent(new FakeEvent('focusin'));
  }
  blur(next = null) {
    const document = this.ownerDocument;
    if (document.activeElement !== this) return;
    document.activeElement = document.body;
    this.dispatchEvent(new FakeEvent('blur', {bubbles: false, relatedTarget: next}));
    this.dispatchEvent(new FakeEvent('focusout', {relatedTarget: next}));
  }
  click() {
    if (this.hasAttribute('disabled')) return;
    if (this.localName === 'input' && this.type === 'checkbox') this.checked = !this.checked;
    if (this.localName === 'input' && this.type === 'radio') {
      const scope = this.closest('form') ?? this.ownerDocument.documentElement;
      for (const radio of scope.querySelectorAll('input[type=radio]'))
        if (radio.name === this.name) radio.checked = false;
      this.checked = true;
    }
    const notPrevented = this.dispatchEvent(new FakeEvent('click', {detail: 1}));
    if (this.localName === 'input' && ['checkbox', 'radio'].includes(this.type) && notPrevented) {
      this.dispatchEvent(new FakeEvent('input'));
      this.dispatchEvent(new FakeEvent('change'));
    }
  }
  showModal() {
    this.open = true;
    this.modal = true;
  }
  show() {
    this.open = true;
    this.modal = false;
  }
  close(value) {
    if (!this.open) return;
    if (value !== undefined) this.returnValue = value;
    this.open = false;
    this.dispatchEvent(new FakeEvent('close', {bubbles: false}));
  }
  scrollIntoView() {
    this.scrolledIntoView = (this.scrolledIntoView ?? 0) + 1;
  }
  getBoundingClientRect() {
    return {x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0};
  }
  getClientRects() {
    return [];
  }
}

/** A document with html`…` parsing, focus and a window; `mount(markup)` puts markup in the body and returns it. */
export function createDom() {
  const document = {
    nodeType: 9,
    activeElement: null,
    listeners: new Map(),
    createElement: tag => new FakeElement(document, String(tag).toLowerCase()),
    createTextNode: text => new FakeText(String(text)),
    parseNodes(markup) {
      const root = new FakeElement(document, 'template');
      const stack = [root];
      const tag =
        /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
      let last = 0,
        match;
      const text = end => {
        const data = markup.slice(last, end);
        if (data) stack.at(-1).appendChild(new FakeText(decode(data)));
      };
      while ((match = tag.exec(markup))) {
        text(match.index);
        last = match.index + match[0].length;
        if (match[0].startsWith('<!--')) continue;
        if (match[1]) {
          const name = match[1].toLowerCase(),
            at = stack.map(el => el.localName).lastIndexOf(name);
          if (at > 0) stack.length = at;
          continue;
        }
        const element = document.createElement(match[2]);
        for (const attribute of match[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
          element.setAttribute(attribute[1], decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''));
        stack.at(-1).appendChild(element);
        if (!match[4] && !voidTags.has(element.localName)) stack.push(element);
      }
      text(markup.length);
      const nodes = [...root.childNodes];
      for (const node of nodes) node.parentNode = null;
      return nodes;
    },
    addEventListener(type, listener) {
      document.documentElement.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      document.documentElement.removeEventListener(type, listener);
    },
    getElementById: id => document.documentElement.getElementById(id),
    querySelector: selector => document.documentElement.querySelector(selector),
    querySelectorAll: selector => document.documentElement.querySelectorAll(selector),
    dispatchEvent: event => document.documentElement.dispatchEvent(event),
  };
  document.documentElement = document.createElement('html');
  document.head = document.createElement('head');
  document.body = document.createElement('body');
  document.documentElement.append(document.head, document.body);
  document.activeElement = document.body;
  const window = {
    listeners: new Map(),
    addEventListener(type, listener) {
      const list = window.listeners.get(type) ?? [];
      list.push({listener});
      window.listeners.set(type, list);
    },
    removeEventListener() {},
    getComputedStyle: element => ({direction: element.closest?.('[dir=rtl]') ? 'rtl' : 'ltr'}),
  };
  document.windowObject = window;
  const mount = markup => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = String(markup);
    return container;
  };
  const key = (element, name, init = {}) => {
    const event = new FakeEvent('keydown', {key: name, ...init});
    element.dispatchEvent(event);
    return event;
  };
  return {document, window, FakeEvent, mount, key};
}

const web = file => fs.readFileSync('web/' + file, 'utf8');
/**
 * The component scripts in a vm context over a test DOM, loaded the way the browser loads them (classic scripts, one
 * global scope): localization.js first (html, setHtml, uiText), then the files named.
 */
export function loadUI(files, extra = {}) {
  const dom = createDom(),
    timers = new Map();
  let timerId = 0;
  const context = createContext({
    document: dom.document,
    window: dom.window,
    addEventListener: dom.window.addEventListener,
    getComputedStyle: dom.window.getComputedStyle,
    CustomEvent: dom.FakeEvent,
    Event: dom.FakeEvent,
    Intl,
    Promise,
    Map,
    Set,
    WeakMap,
    WeakSet,
    URL,
    queueMicrotask,
    setTimeout: (callback, delay) => {
      timers.set(++timerId, {callback, delay});
      return timerId;
    },
    clearTimeout: id => timers.delete(id),
    ...extra,
  });
  const run = text => new Script(text).runInContext(context);
  run(web('localization.js'));
  for (const file of files) run(web(file));
  return {
    ...dom,
    context,
    run,
    timers,
    /** Runs the scheduled callbacks (all of them, or those at or under `delay`), in order. */
    tick(delay = Infinity) {
      for (const [id, timer] of [...timers])
        if (timer.delay <= delay) {
          timers.delete(id);
          timer.callback();
        }
    },
  };
}
