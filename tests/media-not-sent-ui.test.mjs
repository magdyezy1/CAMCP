// MED-02 Stage A (review 2026-10-08): a queued media upload whose job failed before any claim sent nothing, so the
// Media library shows "Not sent — try again" and offers to queue the same review again, in English and Arabic. Before
// this the page showed the job as failed and advised "No safe upload retry is available… Do not create another upload".
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function load(locale) {
  const context = createContext({
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    Intl,
    Date,
    WeakMap,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    reviewTable: () => '<table></table>',
    document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
    addEventListener() {},
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(readFileSync('web/workspace.js', 'utf8'));
  return run;
}

test('a job that failed before any claim is shown as not sent, with a way to try again', () => {
  for (const locale of ['en', 'ar']) {
    const run = load(locale),
      unsent = run(
        `mediaJobPanel({state: 'failed', not_submitted: true, error: {code: 'MEDIA_MEMORY_BUSY', message: 'busy'}, progress: {}}, 'review-1')`,
      ),
      sent = run(
        `mediaJobPanel({state: 'failed', not_submitted: false, error: {code: 'WRITE_OUTCOME_UNCERTAIN', message: 'lost'}, progress: {}}, 'review-2')`,
      );
    assert.match(unsent, locale === 'ar' ? /لم يُرسل — حاول مجددًا/ : /Not sent — try again/);
    assert.match(unsent, locale === 'ar' ? />إعادة المحاولة<\/button>/ : />Try again<\/button>/);
    assert.match(unsent, /role="status"/);
    // A job that may have reached the platform keeps the inspection path and never says it was not sent.
    assert.doesNotMatch(sent, /Not sent|لم يُرسل/);
    assert.match(sent, locale === 'ar' ? />فحص الاستعادة<\/button>/ : />Inspect recovery<\/button>/);
    assert.match(run(`mediaNotSentNotice({state: 'not_submitted'})`), /role="status"/);
    assert.equal(run(`mediaNotSentNotice({state: 'uncertain'})`), '');
    assert.equal(run(`mediaNotSentNotice({state: 'queued'})`), '');
  }
});
