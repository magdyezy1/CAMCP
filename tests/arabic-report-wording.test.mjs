// F-L8-12: editorial points of the Arabic the report builder shows, found by the round 2 audit. They are catalog
// choices, so each is pinned where a regression would be silent: one word for "parents", no first-person voice in a
// label the user reads about their own choice, no count template that is wrong for 3 to 10 (a number before an
// accusative singular noun), one grammatical gender across the status choices, and singular count messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {reportSource} from '../dist/src/report-sources.js';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const english = {
    parents: [
      'LinkedIn metadata could not be read, so some names, parents or objectives remain unknown.',
      'This LinkedIn source reports more than 2000 entities, so names, parents and objectives beyond that bound stay unknown.',
      'X detailed entities did not retain exact owned native parents.',
    ],
  },
  arabicLetters = /[؀-ۿ]/;

test('"parents" is one word in the report sentences: the established “العناصر الأم”', () => {
  for (const key of english.parents) {
    assert.ok(catalog[key].includes('العناصر الأم'), key);
    assert.doesNotMatch(catalog[key], /العناصر الأصلية (?:أو|الرئيسية)|تسلسلها/, 'a variant the audit named: ' + key);
  }
  // The word the rest of the catalog already uses for the same notion.
  assert.ok(catalog['Native parents were not returned completely.'].includes('العناصر الأم'));
});

test('a label about the user’s own choice is not spoken in the first person', () => {
  const value = catalog['Chosen for this campaign in the report.'];
  assert.doesNotMatch(value, /^اخترت|\sاخترت\s/);
  assert.match(value, /^اختير/);
});

test('the row-count messages of a report put no number before an accusative singular noun, wrong for 3 to 10', () => {
  // "{declared} صفًا" reads right for 11 and more, and wrongly for 3 to 10; these templates avoid the agreement.
  const pattern = /\{[a-zA-Z]+\}\s+صفًا/,
    offenders = [
      'TikTok declared {declared} rows and returned {returned}.',
      '{count} rows matched the source filters. Review the objective selections above.',
      '{count} row matched the source filters. Review the objective selections above.',
      '{count} rows were returned before filtering. Review the objective selections above.',
      '{count} row was returned before filtering. Review the objective selections above.',
    ].filter(key => !Object.hasOwn(catalog, key) || pattern.test(catalog[key]));
  assert.deepEqual(offenders, []);
  // The TikTok notice, as the interface shows it for a small and a large count.
  const context = createContext({document: {addEventListener() {}}, Intl, Date, catalog});
  new Script(fs.readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script('uiLocale="ar";uiMessages=new Map(Object.entries(catalog))').runInContext(context);
  new Script(fs.readFileSync('web/report-quality.js', 'utf8')).runInContext(context);
  for (const [declared, returned] of [
    ['3', '2'],
    ['10', '9'],
    ['1,500', '1,300'],
  ]) {
    context.warning = `TikTok declared ${declared} rows and returned ${returned}.`;
    const shown = new Script('uiSourceWarning(warning)').runInContext(context);
    assert.match(shown, arabicLetters);
    assert.ok(shown.includes(declared) && shown.includes(returned), shown);
    assert.doesNotMatch(shown, /صفًا/, shown);
  }
});

test('the status choices of the report editor share one grammatical gender', () => {
  const choices = ['Active', 'Paused', 'Archived', 'All'].map(key => catalog[key]);
  assert.deepEqual(choices, ['نشط', 'متوقف مؤقتًا', 'مؤرشف', 'الكل']);
  for (const choice of choices.slice(0, 3)) assert.doesNotMatch(choice, /ة$/, choice + ' is not feminine');
  // They are the words the editor's status list shows.
  const meta = reportSource('meta').overview;
  assert.ok(meta.supported_statuses.includes('archived') && meta.supported_statuses.includes('active'));
});

// An empty result says how many rows matched; one row is "1 row", not "1 rows", and the Arabic has both forms.
for (const locale of ['en', 'ar'])
  test(locale + ': the empty-result message counts one row in the singular and several in the plural', () => {
    const context = createContext({
      Intl,
      Date,
      URLSearchParams,
      structuredClone,
      catalog,
      $: () => null,
      CSS: {escape: String},
      esc: value =>
        String(value ?? '').replace(
          /[&<>"']/g,
          c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c],
        ),
      document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
    });
    const run = code => new Script(code).runInContext(context);
    run(fs.readFileSync('web/localization.js', 'utf8'));
    for (const file of ['report-library', 'report-source-settings', 'report-quality', 'reporting-overview'])
      run(fs.readFileSync('web/' + file + '.js', 'utf8'));
    run(
      `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`,
    );
    const empty = (count, version) => {
      context.report = {
        state: 'complete',
        config: {contract_version: version, date_range: {}},
        row_count: 0,
        source_row_count: count,
        scoped_row_count: count,
        empty_reason: 'objective_filter',
        sources: [],
      };
      return String(run('renderReportEmpty(report)'));
    };
    const say = (key, count) => (locale === 'ar' ? catalog[key] : key).replace('{count}', String(count));
    for (const [count, matched, returned] of [
      [
        1,
        '{count} row matched the source filters. Review the objective selections above.',
        '{count} row was returned before filtering. Review the objective selections above.',
      ],
      [
        2,
        '{count} rows matched the source filters. Review the objective selections above.',
        '{count} rows were returned before filtering. Review the objective selections above.',
      ],
    ]) {
      assert.ok(empty(count, 'overview-config-v4').includes(say(matched, count)), locale + ' ' + count + ' matched');
      assert.ok(empty(count, 'overview-config-v3').includes(say(returned, count)), locale + ' ' + count + ' returned');
    }
    assert.doesNotMatch(empty(1, 'overview-config-v4'), /1 rows/);
  });
