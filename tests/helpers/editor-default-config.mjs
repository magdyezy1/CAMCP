import fs from 'node:fs';
import {Script, createContext} from 'node:vm';

const plain = value => JSON.parse(JSON.stringify(value));
const unescape = text =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');

/**
 * The controls the editor rendered for one account, read back from its own markup: each `data-report-*` control with
 * the state the server-declared defaults (or the saved source) gave it: a selected option, a checked box, a value.
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

/** The form values the editor's range controls hold for a saved date range. */
function rangeFields(range = {}) {
  return range.preset
    ? {
        rangeMode: range.preset === 'last_complete_days' ? 'rolling' : range.preset,
        days: range.days ?? 7,
        offset_days: range.offset_days ?? 0,
        timezone: range.timezone ?? 'UTC',
      }
    : {rangeMode: 'custom', since: range.since ?? '2026-09-01', until: range.until ?? '2026-09-02'};
}

/**
 * The body the website's report editor sends, produced by the real scripts of `web/` (report-source-settings.js,
 * report-library.js and reporting-overview.js) over the server's own bootstrap platform declarations.
 *
 * - Without `saved`: a NEW report that selects `accounts` with every control left at the default the editor rendered
 *   for it, which is what a person gets by choosing accounts and pressing Run or Save without touching a setting.
 * - With `saved` (a stored view record): that report opened in the editor and saved again without a change.
 */
export function editorBody(bootstrapPlatforms, {accounts, saved}) {
  const roots = new Map(),
    globals = new Map(),
    node = (value = '') => ({value, checked: false, dataset: {}}),
    key = ({platform, connection_id, account_id}) => JSON.stringify([platform, connection_id, account_id]),
    fields = {
      name: saved?.config.name ?? 'Default new report',
      client_name: saved?.config.client_name ?? '',
      grain: saved?.config.grain ?? null,
      partial_delivery: saved?.config.partial_delivery ?? null,
      ...rangeFields(saved?.config.date_range ?? {since: '2026-09-01', until: '2026-09-02'}),
    },
    metrics = saved?.config.metrics ?? ['spend', 'impressions', 'clicks'];
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
        return fields[name] ?? null;
      }
    },
    $: selector => roots.get(selector) ?? globals.get(selector) ?? null,
    document: {
      addEventListener() {},
      querySelectorAll: selector =>
        selector === '[data-report-account]:checked'
          ? accounts.map(account => ({value: key(account)}))
          : selector === '[data-report-metric]:checked'
            ? metrics.map(value => ({value}))
            : [],
    },
  });
  const run = code => new Script(code).runInContext(context);
  for (const name of ['localization', 'report-library', 'report-source-settings', 'reporting-overview'])
    run(fs.readFileSync('web/' + name + '.js', 'utf8'));
  context.platforms = plain(bootstrapPlatforms);
  run('overviewState.bootstrap={platforms,metrics:{}};overviewState.config=overviewDefault()');
  if (saved) {
    context.record = plain(saved);
    run('selectOverviewDefinition(record);overviewState.custom=structuredClone(record.config.custom_metrics ?? [])');
  }
  for (const platform of bootstrapPlatforms) {
    // The platform-level controls hold what the first saved source (or the template defaults) of the platform holds.
    context.initial = plain(
      saved?.config.sources.find(source => source.platform === platform.id) ??
        saved?.config.source_defaults?.[platform.id] ??
        {},
    );
    globals.set('[data-native-for="' + platform.id + '"]', node((context.initial.native_metrics ?? []).join(', ')));
    globals.set('[data-objective-for="' + platform.id + '"]', node(run('reportObjectiveValue(initial)')));
  }
  for (const account of accounts) {
    context.declaration = plain(bootstrapPlatforms.find(platform => platform.id === account.platform));
    context.source = plain(
      saved?.config.sources.find(
        source =>
          source.platform === account.platform &&
          source.connection_id === account.connection_id &&
          source.account_id === account.account_id,
      ) ??
        saved?.config.source_defaults?.[account.platform] ??
        {},
    );
    // The markup the editor gives this account: the saved source when there is one, otherwise only the defaults.
    const markup = String(
        run('overviewAccountFields(declaration, source, ' + JSON.stringify(key(account)) + ', true, {})'),
      ),
      controls = renderedControls(markup);
    roots.set('[data-report-source="' + key(account) + '"]', {
      querySelector: selector => controls.get(selector) ?? null,
    });
  }
  return plain(run('overviewConfig()'));
}

/** A NEW report that selects `accounts` and keeps every default (see editorBody). */
export const editorDefaultConfig = (bootstrapPlatforms, accounts) => editorBody(bootstrapPlatforms, {accounts});

/** A stored view record opened in the editor and saved again unchanged (see editorBody). */
export const editorResaveConfig = (bootstrapPlatforms, saved) =>
  editorBody(bootstrapPlatforms, {
    accounts: saved.config.sources.map(({platform, connection_id, account_id}) => ({
      platform,
      connection_id,
      account_id,
    })),
    saved,
  });
