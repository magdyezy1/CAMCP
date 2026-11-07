// F-L5-15, the website half: the report editor kept the platforms' attribution windows, their defaults and which platform
// has which control in its own script, restating what the server's source tables already own. The windows, defaults and
// choices now come from the bootstrap (reporting_v4.option_choices), and the box that declares a reporting window complete
// is shown only where declaring it changes the report. All data are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {providerById} from '../dist/src/provider-adapters.js';
import {reportSource} from '../dist/src/report-sources.js';
import {reportEngine} from './helpers/report-engine.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
/** The editor's scripts in a VM with the given platforms as the bootstrap. */
function editor(platforms) {
  const context = createContext({
    Intl,
    Date,
    URLSearchParams,
    structuredClone,
    CSS: {escape: String},
    pretty: String,
    esc: value => String(value ?? ''),
    $: () => null,
    document: {addEventListener() {}, querySelectorAll: () => []},
  });
  const run = code => new Script(code).runInContext(context);
  for (const name of ['localization', 'report-library', 'report-source-settings', 'reporting-overview'])
    run(fs.readFileSync('web/' + name + '.js', 'utf8'));
  context.platforms = platforms;
  run(
    "overviewState.bootstrap={platforms,metrics:{}};overviewState.config={contract_version:'overview-config-v4',sources:[],source_defaults:{},targets:{}}",
  );
  return {
    context,
    run,
    fields: (id, saved = {}) => {
      context.platform = platforms.find(item => item.id === id);
      context.saved = saved;
      return String(run('overviewGranularityFields(platform, saved, true)'));
    },
  };
}
const bootstrapPlatforms = async t => {
  const e = reportEngine(t, {rowsFor: () => []});
  return plain((await e.overview.handle({action: 'bootstrap'}, e.actor)).platforms);
};

test('the bootstrap carries each platform’s fixed option choices from its own declaration', async t => {
  const platforms = await bootstrapPlatforms(t),
    choices = id => platforms.find(platform => platform.id === id).reporting_v4.option_choices;
  const meta = providerById('meta').reportWindows;
  assert.deepEqual(choices('meta'), {
    attribution_windows: {
      label: 'Click attribution window',
      values: [...meta.windows],
      exclusive: [...meta.clickWindows],
      notes: {'1d_ev': 'engaged view'},
    },
  });
  assert.deepEqual(choices('snapchat'), {
    swipe_up_attribution_window: {label: 'Swipe attribution window', values: ['1_DAY', '7_DAY', '28_DAY']},
    view_attribution_window: {
      label: 'View attribution window',
      values: ['none', '1_HOUR', '3_HOUR', '6_HOUR', '1_DAY', '7_DAY'],
    },
  });
  for (const platform of platforms)
    assert.deepEqual(
      platform.reporting_v4.option_choices,
      plain(reportSource(platform.id)?.overview?.option_choices ?? {}),
      platform.id,
    );
  // A choice is declared for an option the platform really takes, and its default is one of its values.
  for (const platform of platforms)
    for (const [name, choice] of Object.entries(platform.reporting_v4.option_choices)) {
      assert.ok(platform.reporting_v4.option_names.includes(name), platform.id + ' ' + name);
      const fallback = [platform.reporting_v4.defaults[name]].flat();
      assert.ok(
        fallback.every(value => choice.values.includes(value)),
        platform.id + ' default of ' + name,
      );
    }
});

test('the editor offers the windows the platform declares, so a changed declaration changes the page and no list is kept', async t => {
  const platforms = await bootstrapPlatforms(t),
    f = editor(platforms);
  const meta = f.fields('meta');
  assert.match(meta, /<option value="7d_click" selected>7d_click<\/option>/);
  assert.match(meta, /data-report-window-flag="1d_view" checked/);
  assert.doesNotMatch(meta, /data-report-window-flag="1d_ev" checked/);
  assert.match(f.fields('snapchat'), /<option value="28_DAY" selected>28_DAY<\/option>/);
  assert.match(f.fields('snapchat'), /<option value="1_DAY" selected>1_DAY<\/option>/);
  // Declare other windows: the page offers those and only those.
  const changed = plain(platforms);
  changed.find(platform => platform.id === 'snapchat').reporting_v4.option_choices.swipe_up_attribution_window.values =
    ['3_DAY', '28_DAY'];
  changed.find(platform => platform.id === 'meta').reporting_v4.option_choices.attribution_windows = {
    label: 'Click attribution window',
    values: ['14d_click', '30d_click', '2d_view'],
    exclusive: ['14d_click', '30d_click'],
  };
  changed.find(platform => platform.id === 'meta').reporting_v4.defaults.attribution_windows = ['30d_click', '2d_view'];
  const other = editor(changed),
    snapchat = other.fields('snapchat'),
    changedMeta = other.fields('meta');
  const swipe = /data-report-option="swipe_up_attribution_window">(.*?)<\/select>/.exec(snapchat)[1];
  assert.deepEqual(
    [...swipe.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]),
    ['3_DAY', '28_DAY'],
    'no value the declaration lacks',
  );
  assert.match(changedMeta, /<option value="30d_click" selected>30d_click<\/option>/);
  assert.match(changedMeta, /data-report-window-flag="2d_view" checked/);
  assert.doesNotMatch(changedMeta, /7d_click|28d_click|1d_ev/);
  // A platform that declares none has none.
  assert.doesNotMatch(f.fields('tiktok'), /data-report-click-window|data-report-option/);
  // The script itself keeps none of the lists the server owns.
  const source = fs.readFileSync('web/report-source-settings.js', 'utf8');
  for (const literal of [
    '7d_click',
    '1d_click',
    '28d_click',
    '1d_view',
    '1d_ev',
    '28_DAY',
    '1_HOUR',
    '3_HOUR',
    '6_HOUR',
    '7_DAY',
    "'none'",
  ])
    assert.equal(source.includes(literal), false, literal);
  assert.doesNotMatch(source, /platform\.id === '(meta|snapchat)'|\['meta', 'snapchat'\]/);
});

test('a saved selection of windows is offered back, and the profile is read from the controls and the declared defaults', async t => {
  const platforms = await bootstrapPlatforms(t),
    f = editor(platforms);
  // View windows alone: no click window.
  const viewOnly = f.fields('meta', {levels: ['ad'], report_options: {attribution_windows: ['1d_view', '1d_ev']}});
  assert.match(viewOnly, /<option value="" selected>No click window<\/option>/);
  assert.match(viewOnly, /data-report-window-flag="1d_ev" checked> 1d_ev \(engaged view\)/);
  // The profile: the select, then each box that is checked, in the platform's order; a missing control falls back to the default.
  const meta = platforms.find(platform => platform.id === 'meta').reporting_v4,
    snapchat = platforms.find(platform => platform.id === 'snapchat').reporting_v4;
  const controls = values => selector => values[selector];
  f.context.meta = meta;
  f.context.snapchat = snapchat;
  f.context.query = controls({
    '[data-report-click-window="meta"]': {value: '28d_click'},
    '[data-report-window-flag="1d_view"]': {checked: false},
    '[data-report-window-flag="1d_ev"]': {checked: true},
    '[data-report-option="swipe_up_attribution_window"]': {value: '7_DAY'},
  });
  assert.deepEqual(plain(f.run("overviewAttributionProfile('meta', meta, query)")), {
    attribution_windows: ['28d_click', '1d_ev'],
  });
  assert.deepEqual(plain(f.run("overviewAttributionProfile('snapchat', snapchat, query)")), {
    swipe_up_attribution_window: '7_DAY',
    view_attribution_window: '1_DAY',
  });
  f.context.empty = () => null;
  assert.deepEqual(plain(f.run("overviewAttributionProfile('meta', meta, empty)")), {
    attribution_windows: ['7d_click'],
  });
});

test('the declaration box and its note appear only where declaring the window complete changes the report', async t => {
  const platforms = await bootstrapPlatforms(t),
    f = editor(platforms);
  const declaration = markup => /<div data-report-declaration="([a-z0-9]+)" (hidden)?>/.exec(markup);
  for (const id of ['tiktok', 'snapchat', 'meta', 'linkedin', 'x']) {
    const campaign = f.fields(id, {levels: ['campaign']}),
      detailed = f.fields(id, {levels: ['campaign', 'ad']}),
      saved = f.fields(id, {levels: ['campaign'], report_options: {complete_window: false}});
    assert.equal(declaration(campaign)?.[2], 'hidden', id + ' at campaign level');
    assert.equal(declaration(detailed)?.[2], undefined, id + ' at a detailed level');
    assert.equal(declaration(saved)?.[2], undefined, id + ': a saved "incomplete" can be lifted');
    assert.match(detailed, new RegExp('data-report-complete-window="' + id + '"'));
  }
  // At campaign level TikTok and Snapchat have nothing to ask: the whole group is hidden. Meta keeps its result action.
  assert.match(f.fields('snapchat', {levels: ['campaign']}), /data-report-detail="snapchat" hidden disabled/);
  assert.match(f.fields('tiktok', {levels: ['campaign']}), /data-report-detail="tiktok" hidden disabled/);
  assert.doesNotMatch(f.fields('meta', {levels: ['campaign']}), /data-report-detail="meta" hidden/);
  assert.match(f.fields('meta', {levels: ['campaign']}), /data-report-measurement="meta" >/);
  assert.match(f.fields('snapchat', {levels: ['campaign', 'adset']}), /data-report-detail="snapchat" >/);
  // A single-level platform has no such group at all.
  assert.doesNotMatch(f.fields('ga4', {levels: ['campaign']}), /data-report-complete-window/);
});

test('choosing a level shows or hides the group of a platform as it changes', async t => {
  const platforms = await bootstrapPlatforms(t),
    f = editor(platforms);
  const element = (more = {}) => ({hidden: false, disabled: false, dataset: {}, ...more});
  const make = (id, levels, original = 'null') => {
    const measurement = element(),
      declaration = element(),
      box = element({dataset: {originalComplete: original}}),
      select = {selectedOptions: levels.map(value => ({value}))},
      root = {
        querySelector: selector =>
          selector === '[data-report-level="' + id + '"]'
            ? select
            : selector === '[data-report-complete-window="' + id + '"]'
              ? box
              : null,
      },
      fieldset = element({
        dataset: {reportDetail: id},
        closest: () => root,
        querySelector: selector =>
          selector === '[data-report-measurement]'
            ? measurement
            : selector === '[data-report-declaration]'
              ? declaration
              : null,
      });
    return {fieldset, measurement, declaration, select, box};
  };
  const run = (...parts) => {
    f.context.document.querySelectorAll = selector =>
      selector === '[data-report-detail]' ? parts.map(part => part.fieldset) : [];
    f.run('updateOverviewGranularity()');
  };
  const tiktok = make('tiktok', ['campaign']),
    snapchat = make('snapchat', ['campaign'], 'false'),
    meta = make('meta', ['campaign']);
  run(tiktok, snapchat, meta);
  assert.deepEqual(
    [tiktok.fieldset.hidden, tiktok.declaration.hidden],
    [true, true],
    'nothing to ask at campaign level',
  );
  assert.deepEqual(
    [snapchat.fieldset.hidden, snapchat.declaration.hidden],
    [false, false],
    'a saved incomplete can be lifted',
  );
  assert.deepEqual([meta.fieldset.hidden, meta.measurement.hidden, meta.declaration.hidden], [false, false, true]);
  tiktok.select.selectedOptions = [{value: 'campaign'}, {value: 'ad'}];
  run(tiktok, snapchat, meta);
  assert.deepEqual([tiktok.fieldset.hidden, tiktok.declaration.hidden], [false, false]);
});
