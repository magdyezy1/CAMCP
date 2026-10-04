import {readFileSync} from 'node:fs';
import {Script, createContext} from 'node:vm';
export function creativeNativeUsageUi(locale = 'en', request = async () => {}) {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        value: '',
        isConnected: true,
        attributes: {},
        status: {textContent: ''},
        setAttribute(k, v) {
          this.attributes[k] = v;
        },
        addEventListener(type, fn) {
          bindings.set(key + ' ' + type, fn);
        },
        querySelector() {
          return this.status;
        },
      });
    return nodes.get(key);
  };
  const esc = v =>
    String(v ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  const context = createContext({
    navigationGeneration: 1,
    identityGeneration: 1,
    location: {search: ''},
    URLSearchParams,
    history: {
      replaceState(_s, _t, url) {
        context.location.search = new URL(url, 'https://synthetic.invalid').search;
      },
    },
    document: {addEventListener() {}},
    $: node,
    esc,
    recordDetails: (v, l) => `<details><summary>${esc(l)}</summary><pre>${esc(JSON.stringify(v))}</pre></details>`,
    errorMessage: e => e.message,
    workspaceBind: (s, fn) => bindings.set(s, fn),
    workspaceCall: async (tool, args) => {
      calls.push({tool, args});
      return request(args);
    },
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(readFileSync('web/operations-center.js', 'utf8'));
  run(readFileSync('web/creative-library.js', 'utf8'));
  return {run, context, node, bindings, calls};
}
