import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
test('owner timing summaries translate bounds, distinguish unknown from zero and expose scoped keyboard tables', () => {
  const controller = readFileSync('web/owner-operations.js', 'utf8');
  const helper = controller.slice(
    controller.indexOf('function ownerServiceTimings('),
    controller.indexOf('const ownerCall ='),
  );
  for (const locale of ['en', 'ar']) {
    const context = createContext({
      Intl,
      document: {addEventListener() {}},
      renderSettings: () => {},
      date: value => String(value),
      esc: value =>
        String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;'),
      catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    });
    const run = source => new Script(source).runInContext(context);
    run(readFileSync('web/localization.js', 'utf8'));
    run(
      `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`,
    );
    run(helper);
    context.value = {
      window_start_ms: 1800000,
      unavailable_counters: 0,
      persistence_failures_in_this_process: 0,
      items: [
        {
          category: 'workspace',
          attempts: 2,
          successes: 1,
          errors: 1,
          mean_ms: 0,
          p50_bucket: {lower_ms: 0, upper_ms: 25},
          p95_bucket: {lower_ms: 60000, upper_ms: null},
          omitted_count: 0,
        },
        {
          category: 'media',
          attempts: 0,
          successes: 0,
          errors: 0,
          mean_ms: null,
          p50_bucket: null,
          p95_bucket: null,
          omitted_count: 1,
        },
      ],
    };
    const html = run('ownerServiceTimings(value)');
    assert.match(html, /role="region" tabindex="0"/);
    assert.match(html, /scope="row"/);
    assert.match(html, /scope="col"/);
    assert.match(html, locale === 'ar' ? /غير معروف/ : /Unknown/);
    assert.match(html, locale === 'ar' ? /حتى .* مللي ثانية/ : /Up to 25 ms/);
    assert.match(html, locale === 'ar' ? /أكثر من .* مللي ثانية/ : /Over 60,000 ms/);
    assert.match(html, locale === 'ar' ? /المحاولات المقاسة/ : /Measured attempts/);
    assert.match(html, locale === 'ar' ? /المحاولات المقاسة فقط/ : /measured attempts only/);
    assert.doesNotMatch(html, /<td><\/td>/);
    assert.match(
      run('ownerServiceTimings(undefined)'),
      locale === 'ar' ? /لا تتوفر قياسات توقيت/ : /No usable timing observations/,
    );
  }
});
