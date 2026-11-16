import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

/**
 * Round 2.5, package r25-m1-diff (L6-11): the owner's Review friction section (/settings) shows the media reviews the
 * friction report now counts apart: how many were prepared and how many uploads were sent, and the refusals for an expired
 * review and a changed state per 100 prepares, with the paths that changed. The page script is run as the browser runs it
 * (web/localization.js and the catalogue), in each language.
 */
const controller = readFileSync('web/owner-operations.js', 'utf8'),
  // The section's function, up to the provider access panel that follows it.
  start = controller.indexOf('function ownerReviewFriction('),
  end = controller.indexOf('/**\n * The provider access panel');
assert.ok(start > 0 && end > start, 'the friction section is in the page script');
const source = controller.slice(start, end),
  // The platform names the page script keeps above its sections: the alarm names the provider by them.
  platformNames = controller.slice(
    controller.indexOf('const platformName ='),
    controller.indexOf('/** What the amounts of an account policy mean'),
  ),
  catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));

function page(locale) {
  const context = createContext({
    Intl,
    document: {addEventListener() {}},
    esc: value =>
      String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    catalog,
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(platformNames);
  run(source);
  return {
    run,
    show(value) {
      context.value = value;
      return run('ownerReviewFriction(value)');
    },
    number: value => run(`uiNumber(${JSON.stringify(value)}, {maximumFractionDigits: 2})`),
    text: english => run(`uiText(${JSON.stringify(english)})`),
    // The summary line of the media block, as the page words it for these counts.
    summary: (days, prepares, executes) =>
      run(
        `uiText('In the last {days} days: {prepares} media reviews prepared, {executes} uploads sent.', {days: uiNumber(${days}), prepares: uiNumber(${prepares}), executes: uiNumber(${executes})})`,
      ),
  };
}

const writes = {
  window_days: 30,
  complete: true,
  prepares: 313,
  executes: 280,
  latency_ms: {count: 280, p50: 4000, p90: 20000, p99: 60000, max: 90000},
  counts: {
    REVIEW_EXPIRED: 3,
    STATE_CHANGED: 7,
    acknowledgement_refusals: 4,
    WRITE_OUTCOME_UNCERTAIN: 1,
    write_not_sent: 2,
  },
  per_100_prepares: {
    review_expired: 0.96,
    state_changed: 2.24,
    acknowledgement_refusals: 1.28,
    write_outcome_uncertain: 0.32,
    write_not_sent: 0.64,
  },
  approvals: {approved: 0, latency_ms: {count: 0}},
  state_changed_paths: [{path: '$[0]["data"]["list"][0]["license_url"]', count: 5}],
};
const media = {
  prepares: 25,
  executes: 20,
  counts: {REVIEW_EXPIRED: 1, STATE_CHANGED: 6},
  per_100_prepares: {review_expired: 4, state_changed: 24},
  state_changed_paths: [{path: '$["data"]["list"][0]["currency"]', count: 6}],
};

for (const locale of ['en', 'ar'])
  test(
    locale + ': the review friction section shows media reviews apart, with their counts, rates and changed paths',
    () => {
      const p = page(locale),
        html = p.show({...writes, media}),
        tables = [...html.matchAll(/<table[ >]/g)].length;
      assert.equal(tables, 2, 'the writes table and the media table');
      // The media block, in the language of the page.
      assert.ok(html.includes(p.text('Media reviews')), 'its heading');
      assert.ok(html.includes(p.text('Media review friction')), 'its table is named');
      assert.ok(html.includes(p.summary(30, 25, 20)), 'what was prepared and what was sent, in words');
      const mediaHtml = html.slice(html.indexOf(p.text('Media reviews')));
      for (const value of [25, 20, 6, 4, 24, 1])
        assert.ok(mediaHtml.includes(p.number(value)), String(value) + ' is shown for media');
      // The rows are the two the report counts, with their own numbers: 1 expired (4 per 100), 6 changed (24 per 100).
      assert.match(
        mediaHtml,
        new RegExp(
          '<th scope="row">' +
            p.text('Expired reviews') +
            '</th><td>' +
            p.number(1) +
            '</td><td>' +
            p.number(4) +
            '</td>',
        ),
      );
      assert.match(
        mediaHtml,
        new RegExp(
          '<th scope="row">' +
            p.text('Changed state') +
            '</th><td>' +
            p.number(6) +
            '</td><td>' +
            p.number(24) +
            '</td>',
        ),
      );
      assert.ok(mediaHtml.includes('$[&quot;data&quot;]'), 'the changed path of the media reviews, as text');
      // The writes are as they were, and their path is not the media one.
      const writesHtml = html.slice(0, html.indexOf(p.text('Media reviews')));
      assert.ok(writesHtml.includes('license_url') && !writesHtml.includes('currency'));
      assert.ok(!mediaHtml.includes('license_url'));
      // No raw code, English or Arabic, stands for a label.
      assert.doesNotMatch(html, /REVIEW_EXPIRED|STATE_CHANGED/);
    },
  );

for (const locale of ['en', 'ar'])
  test(
    locale +
      ': a media rate that is not known is shown as unknown, never zero, and an older answer shows no media block',
    () => {
      const p = page(locale),
        empty = {
          prepares: 0,
          executes: 0,
          counts: {REVIEW_EXPIRED: 0, STATE_CHANGED: 0},
          per_100_prepares: {review_expired: null, state_changed: null},
          state_changed_paths: [],
        },
        html = p.show({...writes, media: empty}),
        mediaHtml = html.slice(html.indexOf(p.text('Media reviews')));
      assert.equal([...html.matchAll(/<table[ >]/g)].length, 2);
      assert.equal(
        [...mediaHtml.matchAll(new RegExp('<td>' + p.text('Unknown') + '</td>', 'g'))].length,
        2,
        'both rates',
      );
      assert.ok(!mediaHtml.includes('<ul>'), 'no changed paths to list');
      // A server that does not report media (an older deployment, a failed read) shows the writes alone.
      for (const answer of [writes, {...writes, media: null}, {...writes, media: {prepares: 'x'}}]) {
        const alone = p.show(answer);
        assert.equal([...alone.matchAll(/<table[ >]/g)].length, 1);
        assert.ok(!alone.includes(p.text('Media reviews')));
      }
    },
  );

// The alarm (R25 M1, design item 4): the fields that change on many prepares of one provider, named for the owner.
const alarm = {
    gateway: 'tiktok_native_action',
    path: '$[0]["data"]["list"][0]["license_url"]',
    refusals: 4,
    prepares: 30,
    per_100_prepares: 13.33,
  },
  rule = {per_100_prepares: 5, minimum_refusals: 3, minimum_prepares: 20};

for (const locale of ['en', 'ar'])
  test(
    locale +
      ': the review friction section names a field that changes on many prepares, with its platform and the rule',
    () => {
      const p = page(locale),
        html = p.show({...writes, media, volatile_path_alarms: [alarm], volatile_path_rule: rule}),
        heading = p.text('Fields that change on many prepares');
      assert.ok(html.includes(heading), 'its heading');
      const section = html.slice(html.indexOf(heading), html.indexOf(p.text('Media reviews')));
      assert.ok(section.includes('TikTok'), 'the platform by its name, not its gateway');
      assert.ok(!section.includes('tiktok_native_action'));
      assert.ok(section.includes('license_url'), 'the path');
      // The rule is stated as a number the owner reads the rate against, and the counts are the alarm's own.
      assert.ok(
        section.includes(
          p.run(
            `uiText('Each of these fields changed in more than {share} of every 100 prepares of its platform. A field that changes by itself should not be compared: tell the AMCP team.', {share: uiNumber(5)})`,
          ),
        ),
      );
      assert.ok(
        section.includes(
          p.run(`uiText('{count} of {prepares} prepares', {count: uiNumber(4), prepares: uiNumber(30)})`),
        ),
      );
      // It is an alert the owner reads at once: a notice, not a row of a table.
      assert.match(section, /class="notice" role="status"/);
      // The writes and the media block are where they were.
      assert.equal([...html.matchAll(/<table[ >]/g)].length, 2);
    },
  );

for (const locale of ['en', 'ar'])
  test(locale + ': with no alarm, or an older answer without the field, the section shows none', () => {
    const p = page(locale),
      heading = p.text('Fields that change on many prepares');
    for (const answer of [
      {...writes, media},
      {...writes, media, volatile_path_alarms: [], volatile_path_rule: rule},
      {...writes, media, volatile_path_alarms: null},
    ])
      assert.ok(!p.show(answer).includes(heading));
  });

test('the media friction wording of the page is in the catalogue, in Arabic', () => {
  for (const english of [
    'Media reviews',
    'Media review friction',
    'In the last {days} days: {prepares} media reviews prepared, {executes} uploads sent.',
    'Fields that change on many prepares',
    'Each of these fields changed in more than {share} of every 100 prepares of its platform. A field that changes by itself should not be compared: tell the AMCP team.',
    '{count} of {prepares} prepares',
  ]) {
    assert.equal(typeof catalog[english], 'string', 'No Arabic for: ' + english);
    assert.match(catalog[english], /[؀-ۿ]/u, english);
    for (const slot of english.match(/\{[a-z]+\}/g) ?? [])
      assert.ok(catalog[english].includes(slot), slot + ' in ' + english);
  }
});
