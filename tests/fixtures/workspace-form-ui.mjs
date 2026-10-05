import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

export function workspaceFormUIFixture(
  locale = 'en',
  {buttonId = '', formId = 'settings', noButton = false, binding = 'form'} = {},
) {
  const nodes = new Set(),
    toasts = [],
    focus = [],
    insertions = [];
  let document;
  const node = (tagName, id = '') => {
    const el = {
      tagName,
      id,
      isConnected: true,
      disabled: false,
      hidden: false,
      textContent: '',
      innerHTML: '',
      attributes: new Map(),
      listeners: new Map(),
      parentElement: null,
      value: '',
      getAttribute(name) {
        return this.attributes.get(name) ?? null;
      },
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      },
      removeAttribute(name) {
        this.attributes.delete(name);
      },
      addEventListener(name, handler) {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(handler);
      },
      async dispatch(name) {
        return Promise.all(
          (this.listeners.get(name) ?? []).map(handler =>
            handler({
              target: this,
              preventDefault() {},
              type: name,
            }),
          ),
        );
      },
      querySelector(selector) {
        if (this === form && selector === 'button[type="submit"]') return noButton ? null : button;
        if (this === form && selector.includes('button:not')) return button.disabled ? null : button;
        return null;
      },
      insertAdjacentHTML(position, html) {
        insertions.push({position, html});
        for (const match of html.matchAll(/<([a-z]+)\b([^>]*)>/g)) {
          const id = /\bid="([^"]+)"/.exec(match[2])?.[1];
          if (!id) continue;
          const child = node(match[1].toUpperCase(), id);
          for (const attr of match[2].matchAll(/([a-z-]+)="([^"]*)"/g)) child.setAttribute(attr[1], attr[2]);
          child.hidden = /\bhidden\b/.test(match[2]);
          child.parentElement = form;
        }
      },
      focus() {
        document.activeElement = this;
        focus.push(this.id);
      },
      closest() {
        return null;
      },
    };
    nodes.add(el);
    return el;
  };
  const body = node('BODY'),
    form = node('FORM', formId),
    button = node('BUTTON', buttonId),
    target = node('SELECT', 'target'),
    nativeId = node('INPUT', 'native-id'),
    heading = node('H1', 'heading'),
    other = node('INPUT', 'other');
  form.parentElement = body;
  button.parentElement = form;
  target.parentElement = form;
  nativeId.parentElement = form;
  target.value = '0';
  nativeId.value = '9007199254740993';
  form.elements = {target, native_id: nativeId};
  document = {
    addEventListener() {},
    body,
    activeElement: body,
    getElementById: id => [...nodes].find(el => el.id === id) ?? null,
    querySelector: selector =>
      selector === '#content h1'
        ? heading
        : selector.startsWith('#')
          ? ([...nodes].find(el => el.id === selector.slice(1) && el.isConnected) ?? null)
          : null,
    querySelectorAll: () => [binding === 'form' ? form : button],
  };
  const context = createContext({
    document,
    CSS: {escape: String},
    navigationGeneration: 1,
    identityGeneration: 1,
    crypto: {randomUUID: () => '11111111-1111-4111-8111-111111111111'},
    location: {search: ''},
    URL,
    URLSearchParams,
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    toast: text => {
      if (text) toasts.push(text);
    },
    form,
    button,
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(
    'uiLocale=' +
      JSON.stringify(locale) +
      ';uiMessages=new Map(' +
      (locale === 'ar' ? 'Object.entries(catalog)' : '[]') +
      ');',
  );
  const app = readFileSync('web/app.js', 'utf8'),
    appStart = app.indexOf('function requestError('),
    appEnd = app.indexOf("const content = $('#content')", appStart);
  if (appStart < 0 || appEnd <= appStart) throw Error('Actual error formatter unavailable');
  run(app.slice(appStart, appEnd));
  const identity = readFileSync('web/identity.js', 'utf8'),
    focusStart = identity.indexOf('function focusKey('),
    focusEnd = identity.indexOf('\nfunction authBind(', focusStart);
  if (focusStart < 0 || focusEnd <= focusStart) throw Error('Actual focus handler unavailable');
  run(identity.slice(focusStart, focusEnd));
  const source = readFileSync(process.env.AMCP_WORKSPACE_BIND_UI_SOURCE ?? 'web/workspace.js', 'utf8'),
    start = source.indexOf('const workspaceFormFeedbacks = new WeakMap();'),
    end = source.indexOf('\nasync function ', start);
  if (start < 0) throw Error('Actual shared form feedback unavailable');
  run(source.slice(start, end < 0 ? undefined : end));
  return {
    context,
    run,
    form,
    button,
    target,
    nativeId,
    other,
    heading,
    document,
    nodes,
    toasts,
    focus,
    insertions,
    bind(fn, options = {}) {
      context.handler = fn;
      context.bindOptions = options;
      run("workspaceBind('owned-fixture',handler,bindOptions)");
    },
    submit: () => (binding === 'form' ? form : button).dispatch(binding === 'form' ? 'submit' : 'click'),
    edit: name => form.dispatch(name),
    region: () => [...nodes].find(el => el.getAttribute('role') === 'alert'),
    message: () => [...nodes].find(el => el.id.endsWith('-workspace-feedback-message')),
    error(message = 'Platform returned HTTP 403') {
      return run(
        'requestError(' +
          JSON.stringify({
            success: false,
            error: {
              code: 'PROVIDER_ACCESS_DENIED',
              message,
              retryable: false,
              next_action:
                'The provider denied access. Check its error details and request ID; a 403 alone does not identify a missing OAuth scope.',
            },
            meta: {requestId: 'original-reference-9007199254740993'},
          }) +
          ')',
      );
    },
    superseded: () => run('supersededRequest()'),
  };
}
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
};
