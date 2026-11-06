import fs from 'node:fs';
import {Script, createContext} from 'node:vm';

const plain = value => JSON.parse(JSON.stringify(value));
const unescape = text =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');

/**
 * The controls the editor rendered for one account, read back from its own markup: each `data-report-*` control with
 * the state the server-declared defaults gave it (a selected option, a checked box, a value).
 */
function renderedControls(markup) {
  const controls = new Map(),
    tag = /<(select|input|textarea)\b([^>]*)>/g;
  let match;
  while ((match = tag.exec(markup))) {
    const [, name, attributes] = match,
      key = /\bdata-report-([a-z-]+)="([^"]*)"/.exec(attributes);
    if (!key) continue;
    const selector = '[data-report-' + key[1] + '="' + key[2] + '"]';
    if (name === 'select') {
      const options = [
          ...markup
            .slice(tag.lastIndex, markup.indexOf('</select>', tag.lastIndex))
            .matchAll(/<option value="([^"]*)"([^>]*)>/g),
        ].map(option => ({value: unescape(option[1]), selected: /\bselected\b/.test(option[2])})),
        picked = options.filter(option => option.selected),
        selectedOptions = /\bmultiple\b/.test(attributes) ? picked : picked.length ? picked : options.slice(0, 1);
      controls.set(selector, {
        value: selectedOptions[0]?.value ?? '',
        selectedOptions: selectedOptions.map(option => ({value: option.value})),
        dataset: {},
      });
    } else if (name === 'textarea') {
      const end = markup.indexOf('</textarea>', tag.lastIndex);
      controls.set(selector, {value: unescape(markup.slice(tag.lastIndex, end)), checked: false, dataset: {}});
    } else {
      const original = /\bdata-original-complete="([^"]*)"/.exec(attributes)?.[1];
      controls.set(selector, {
        checked: /\bchecked\b/.test(attributes),
        value: unescape(/\bvalue="([^"]*)"/.exec(attributes)?.[1] ?? ''),
        dataset: original === undefined ? {} : {originalComplete: original},
      });
    }
  }
  return controls;
}

/**
 * The body the website's report editor sends for a NEW report that selects one account of each platform in
 * `platforms`, with every control left at the default the editor rendered for it. It runs the real scripts of `web/`
 * (report-source-settings.js and reporting-overview.js) over the server's own bootstrap platform declarations, so it
 * is what a person gets by choosing accounts and pressing Run or Save without touching a setting.
 */
export function editorDefaultConfig(bootstrapPlatforms, accounts) {
  const roots = new Map(),
    globals = new Map(),
    node = (value = '') => ({value, checked: false, dataset: {}}),
    key = ({platform, connection_id, account_id}) => JSON.stringify([platform, connection_id, account_id]);
  const context = createContext({
    Intl,
    Date,
    URLSearchParams,
    structuredClone,
    pollTimer: null,
    deliveryTimer: null,
    clearTimeout() {},
    CSS: {escape: String},
    pretty: String,
    reportRangeLabel: () => 'September 2026',
    reportQualityDetails: () => '',
    uiSourceWarning: value => value,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    FormData: class {
      get(name) {
        return (
          {name: 'Default new report', rangeMode: 'custom', since: '2026-09-01', until: '2026-09-02'}[name] ?? null
        );
      }
    },
    $: selector => roots.get(selector) ?? globals.get(selector) ?? null,
    document: {
      addEventListener() {},
      querySelectorAll: selector =>
        selector === '[data-report-account]:checked'
          ? accounts.map(account => ({value: key(account)}))
          : selector === '[data-report-metric]:checked'
            ? [{value: 'spend'}, {value: 'impressions'}, {value: 'clicks'}]
            : [],
    },
  });
  const run = code => new Script(code).runInContext(context);
  for (const name of ['localization', 'report-library', 'report-source-settings', 'reporting-overview'])
    run(fs.readFileSync('web/' + name + '.js', 'utf8'));
  context.platforms = plain(bootstrapPlatforms);
  run('overviewState.bootstrap={platforms,metrics:{}};overviewState.config=overviewDefault()');
  for (const platform of bootstrapPlatforms) {
    globals.set('[data-native-for="' + platform.id + '"]', node(''));
    globals.set('[data-objective-for="' + platform.id + '"]', node('provider'));
  }
  for (const account of accounts) {
    context.declaration = plain(bootstrapPlatforms.find(platform => platform.id === account.platform));
    // The markup a new account gets: no saved source and no template defaults, so the server defaults decide.
    const markup = String(
      run('overviewAccountFields(declaration, {}, ' + JSON.stringify(key(account)) + ', true, {})'),
    );
    const controls = renderedControls(markup);
    roots.set('[data-report-source="' + key(account) + '"]', {
      querySelector: selector => controls.get(selector) ?? null,
    });
  }
  return plain(run('overviewConfig()'));
}
