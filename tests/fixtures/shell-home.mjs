// The Home page's scripts (localization, routes, workspace, work-center, and the V2 components) in a page whose attention
// panel is a slot a test can watch. The fake DOM keeps `content` as a plain string, as tests/home-attention-ui.test.mjs does.
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';

const read = file => fs.readFileSync('web/' + file, 'utf8'),
  catalog = JSON.parse(read('locales/ar.json'));

export const tick = () => new Promise(resolve => setTimeout(resolve, 0)),
  deferred = () => {
    let resolve, reject;
    const promise = new Promise((done, fail) => ((resolve = done), (reject = fail)));
    return {promise, resolve, reject};
  };

/** Home's scripts in a page whose attention panel is a slot we can watch (the fake DOM keeps `content` as a string). */
export function homePage({components = true, locale = 'en'} = {}) {
  const content = {innerHTML: ''},
    slot = {
      isConnected: true,
      innerHTML: '',
      busy: true,
      removeAttribute(name) {
        if (name === 'aria-busy') this.busy = false;
      },
    },
    context = createContext({
      URL,
      URLSearchParams,
      Intl,
      Map,
      Set,
      content,
      catalog,
      document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
      $: selector => (selector === '#home-attention' ? slot : null),
      esc: value =>
        String(value ?? '').replace(
          /[&<>"']/g,
          c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
        ),
      date: value => 'at ' + value,
      header: (title, description, action) => `<h1>${title}</h1><p>${description}</p>${action}`,
      glyph: () => '',
      session: {name: 'Synthetic Person'},
      workspaceBind() {},
      navigationGeneration: 1,
      identityGeneration: 1,
    }),
    run = source => new Script(source).runInContext(context);
  for (const file of ['localization.js', 'routes.js', 'workspace.js', 'work-center.js']) run(read(file));
  if (components) run(read('components.js'));
  if (locale === 'ar') run('uiLocale = "ar"; uiMessages = new Map(Object.entries(catalog));');
  run(
    'globalThis.draw = value => html`<p>${value}</p>`; globalThis.failed = error => html`<p class="error">${error.message}</p>`;',
  );
  return {run, context, content, slot};
}
export const dashboard = {
    connections: [],
    campaigns: [],
    writes_paused: null,
    capabilities: {meaning: 'Meaning', features: [], evidence: []},
  },
  feed = {
    operations: [
      {kind: 'campaign', name: 'Launch', state: 'attention', website_path: '/campaigns?id=plan', updated_at: 5},
    ],
    has_more: false,
  };
