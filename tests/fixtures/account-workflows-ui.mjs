import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
const plain = value => JSON.parse(JSON.stringify(value));
export const accountWorkflowCSV =
  'retailer_id,name,price,currency,image_url\r\n001,Home,0012.34,SAR,https://example.test/image.png\r\n';
export function accountWorkflowFixture(locale = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [],
    httpCalls = [],
    confirmations = [],
    visits = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        textContent: '',
        id: key.replace(/^#/, ''),
        attributes: new Map(),
        listeners: new Map(),
        insertions: [],
        value: '',
        isConnected: true,
        events: new Map(),
        elements: {},
        dataset: {},
        files: [],
        dispatchEvent(event) {
          this.events.get(event.type)?.(event);
          return true;
        },
        addEventListener(event, fn) {
          // These forms retain both context invalidation and feedback clearing. Other fixture nodes
          // model replacement on re-render, retaining their original single-binding behavior.
          if (!['measurement-events', 'measurement-event-identity', 'woo-inventory'].includes(this.id)) {
            this.events.set(event, fn);
            return;
          }
          if (!this.listeners.has(event)) this.listeners.set(event, []);
          this.listeners.get(event).push(fn);
          this.events.set(event, value => {
            for (const listener of this.listeners.get(event)) listener(value);
          });
        },
        setAttribute(name, value) {
          this.attributes.set(name, String(value));
        },
        getAttribute(name) {
          return this.attributes.get(name) ?? null;
        },
        removeAttribute(name) {
          this.attributes.delete(name);
        },
        querySelector(selector) {
          return selector === 'button[type=submit]' ? node(this.id + ':submit') : null;
        },
        insertAdjacentHTML(position, html) {
          this.insertions.push({position, html});
          for (const tag of html.matchAll(/<([a-z]+)\b([^>]*)>/g)) {
            const id = /\bid="([^"]+)"/.exec(tag[2])?.[1];
            if (!id) continue;
            const child = node('#' + id);
            for (const attribute of tag[2].matchAll(/([a-z-]+)="([^"]*)"/g))
              child.setAttribute(attribute[1], attribute[2]);
            child.hidden = /\bhidden\b/.test(tag[2]);
          }
        },
        focus() {
          this.focused = true;
        },
      });
    return nodes.get(key);
  };
  for (const [name, fields] of Object.entries({
    'measurement-audit': ['target', 'container_id', 'workspace_id'],
    'measurement-events': ['target', 'event_names', 'minutes', 'stream_id'],
    'measurement-event-identity': [
      'target',
      'event_name',
      'test_id',
      'date_from',
      'date_to',
      'stream_id',
      'expected_count',
    ],
    'measurement-conversions': ['target'],
    'measurement-google-goals': ['target'],
    'measurement-scope': ['gtm', 'container', 'workspace', 'ga4', 'stream', 'google', 'linkedin'],
    'measurement-trace': ['target', 'trace'],
    'catalog-import': [
      'target',
      'catalog_id',
      'name',
      'allow_upsert',
      'file',
      'column_mode',
      'fixed_currency',
      'image_mode',
      'source_mode',
    ],
    'portfolio-account': ['target'],
    'woo-source': ['target', 'product_ids', 'price_field', 'source_kind', 'parent_product_id'],
    'woo-inventory': ['target', 'price_field'],
    'woo-connect': ['label', 'store_origin', 'consumer_key', 'consumer_secret', 'confirmed'],
    'woo-remove': ['target', 'confirmed'],
  })) {
    for (const field of fields) node('#' + name).elements[field] = node(name + ':' + field);
    if (node('#' + name).elements.target) node('#' + name).elements.target.value = '0';
  }
  node('measurement-audit:container_id').value = '001';
  node('measurement-audit:workspace_id').value = '002';
  node('measurement-events:event_names').value = 'purchase, generate_lead';
  node('measurement-events:minutes').value = '5';
  node('measurement-events:stream_id').value = '900';
  for (const [field, value] of Object.entries({
    event_name: 'purchase',
    test_id: 'amcp-test-12345678-abcd',
    date_from: '2026-10-01',
    date_to: '2026-10-02',
    stream_id: '900',
    expected_count: '1',
  }))
    node('measurement-event-identity:' + field).value = value;
  node('catalog-import:catalog_id').value = '0001';
  node('catalog-import:name').value = 'Home';
  node('catalog-import:allow_upsert').value = 'false';
  node('catalog-import:column_mode').value = 'canonical';
  node('catalog-import:fixed_currency').value = '';
  node('catalog-import:image_mode').value = 'single';
  node('catalog-import:source_mode').value = 'csv';
  node('woo-source:source_kind').value = 'products';
  node('woo-inventory:price_field').value = 'price';
  node('catalog-import:file').files = [{size: accountWorkflowCSV.length, text: async () => accountWorkflowCSV}];
  let handler = args =>
    args.action === 'measurement_audit'
      ? {meaning: 'Native evidence', configuration: {complete: true, findings: [], versions: {native: '001'}}}
      : {
          items: [{id: '001', name: 'Home', price: '0012.34'}],
          source_hash: 'original-hash',
          meaning: 'Original preview',
        };
  let httpHandler = () => {
      throw Error('Unexpected website fixture request');
    },
    confirmationHandler = () => true;
  const context = createContext({
    location: {search: ''},
    URLSearchParams,
    URL,
    TextEncoder,
    Event,
    structuredClone,
    commerceSources: [],
    session: {authenticated: true, workspaceId: 'synthetic-ui', workspaceRole: 'viewer', csrf: 'synthetic-csrf'},
    crypto: {randomUUID: () => '12345678-1234-4123-8123-123456789abc'},
    navigationGeneration: 1,
    identityGeneration: 1,
    document: {addEventListener() {}},
    content: node('content'),
    $: node,
    platforms: ['gtm', 'meta', 'google', 'ga4', 'linkedin'].map(id => ({
      id,
      gateway: id + '_native_action',
      connections: [
        {id: id + '-login', enabled: true, accounts: [id === 'ga4' ? '123' : id === 'linkedin' ? '100' : '001']},
      ],
    })),
    accountLabel: p => p.id,
    workspaceBind: (s, fn) => bindings.set(s, fn),
    workspaceCall: async (_tool, args) => {
      calls.push(plain(args));
      return handler(args);
    },
    api: async (url, options = {}) => {
      if (options.body !== undefined && typeof options.body !== 'string')
        throw Error('Website API JSON bodies must be serialized before fetch');
      const call = {
        url,
        method: options.method ?? 'GET',
        ...(options.body === undefined ? {} : {body: JSON.parse(options.body)}),
      };
      httpCalls.push(call);
      return httpHandler(call);
    },
    confirmAction: async input => {
      confirmations.push(plain(input));
      return confirmationHandler(input);
    },
    navigate: async path => visits.push(path),
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    controls: (label, type, value, name) =>
      `<label>${label}<input name="${name}" type="${type}" value="${value}"></label>`,
    date: String,
    pretty: v => String(v ?? '').replaceAll('_', ' '),
    badge: String,
    blank: String,
    recordDetails: value => JSON.stringify(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    reviewTable: JSON.stringify,
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  });
  const run = s => new Script(s).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  const appSource = readFileSync('web/app.js', 'utf8'),
    appStart = appSource.indexOf('function requestError('),
    appEnd = appSource.indexOf("const content = $('#content')", appStart);
  if (appStart < 0 || appEnd <= appStart) throw Error('Actual request-error formatter unavailable');
  const identityStart = appSource.indexOf('const identityKey ='),
    identityEnd = appSource.indexOf('function resetPrivateState()', identityStart);
  if (identityStart < 0 || identityEnd <= identityStart) throw Error('Actual website identity key unavailable');
  run(appSource.slice(identityStart, identityEnd));
  run(appSource.slice(appStart, appEnd));
  run(readFileSync(process.env.AMCP_ACCOUNT_UI_SOURCE ?? 'web/account-workflows.js', 'utf8'));
  return {
    context,
    run,
    node,
    bindings,
    calls,
    httpCalls,
    confirmations,
    visits,
    respond: fn => {
      handler = fn;
    },
    apiRespond: fn => {
      httpHandler = fn;
    },
    confirmRespond: fn => {
      confirmationHandler = fn;
    },
  };
}
