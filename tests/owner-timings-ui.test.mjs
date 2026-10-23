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

// Design review 2026-10 (WEB-05): the Arabic timing table named three categories in English ("Reporting Overview", "Ad
// previews", "Reviewed writes"); every category reads in Arabic, and the report builder by its canonical name (WEB-06).
test('every owner timing category has an Arabic name, the report builder under its canonical name', () => {
  const controller = readFileSync('web/owner-operations.js', 'utf8'),
    catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    block = controller.slice(controller.indexOf('function ownerServiceTimings('), controller.indexOf('const number ='));
  const labels = [...block.matchAll(/^\s+[a-z_]+: '([^']+)',$/gm)].map(m => m[1]);
  assert.ok(labels.length >= 8, labels.join());
  for (const label of labels) assert.ok(Object.hasOwn(catalog, label), 'No Arabic for ' + label);
  assert.ok(labels.includes('Report builder'));
  assert.ok(!labels.includes('Reporting Overview'));
});

// Design review 2026-10 (WEB-05): Arabic Settings showed two of AMCP's own sentences in English: the backup card's
// "No verified backup receipt has been recorded ..." and the reviewer sign-in line "Set AMCP_TEST_PASSWORD ...".
test('the owner settings sentences AMCP writes about backups and reviewer sign-in read in Arabic', () => {
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    backup = /'(No verified backup receipt has been recorded\.[^']*)'/.exec(
      readFileSync('src/owner-operations.ts', 'utf8'),
    )[1],
    reviewer = /'(Set AMCP_TEST_PASSWORD[^']*)'/.exec(readFileSync('server/user-accounts.ts', 'utf8'))[1];
  for (const sentence of [backup, reviewer]) assert.ok(Object.hasOwn(catalog, sentence), 'No Arabic for ' + sentence);
  // The variable name stays literal inside the Arabic sentence.
  assert.match(catalog[reviewer], /AMCP_TEST_PASSWORD/);
  // Every other reviewer line the server can return (setupGaps().reviewer is the web store's testPasswordProblem
  // first): a bad hash, a short password, or the administrator's password reused (review fix: these three printed in
  // English on the Arabic page).
  const problems = [
    ...readFileSync('server/web-store.ts', 'utf8').matchAll(/'(AMCP_TEST_PASSWORD\w* [^']*\.)'/g),
    ...readFileSync('server/user-accounts.ts', 'utf8').matchAll(/'([^']*AMCP_TEST_PASSWORD\w* [^']*\.)'/g),
  ].map(m => m[1]);
  assert.ok(problems.length >= 4, problems.join(' | '));
  assert.ok(problems.includes('AMCP_TEST_PASSWORD must differ from the administrator password.'));
  for (const sentence of problems) {
    assert.ok(Object.hasOwn(catalog, sentence), 'No Arabic for ' + sentence);
    assert.match(catalog[sentence], /[؀-ۿ]/u, sentence);
    for (const name of sentence.match(/\bAMCP_[A-Z_]+\b/g)) assert.ok(catalog[sentence].includes(name), name);
  }
  // Both are rendered through the catalog (they were printed as the server wrote them).
  assert.match(readFileSync('web/owner-operations.js', 'utf8'), /uiText\(h\.backup\.message\)/);
  assert.match(readFileSync('web/account-approvals.js', 'utf8'), /approvalText\(uiText\(setup\.reviewer\)\)/);
});
