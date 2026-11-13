// Package website-get (W2): a compact row's "Source details" load when they are first opened. One `get` narrowed to the row's
// platform, level and entity, with the provider's own rows, answers it, and the row is found in the answer by its key; a
// grouped entity has a row for each period, so the read can continue by its cursor. Loading says so, a failure says so with
// Retry, and what was loaded is kept for the report. The server is the real one (run, worker, row assembly, `get` and its
// filters and cursor), the page's scripts run in a VM, and the elements the page binds are small stand-ins that keep what the
// page does to them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog, esc, granular, page} from './helpers/report-lazy-page.mjs';

test('a compact row’s source details are a closed disclosure with a row key and an empty body; a full row keeps them whole', async t => {
  const s = await granular(t),
    view = page('en', s.bootstrap, s.reply),
    {rows: html, details} = view.bind(s.compact);
  assert.equal(details.length, s.compact.rows.length);
  assert.deepEqual(
    details.map(d => d.dataset.reportDetails),
    s.compact.rows.map(r => r.row_key),
  );
  assert.equal(
    (
      html.match(
        /<details data-report-details="[^"]*"><summary>Source details<\/summary><div data-report-details-body><\/div><\/details>/g,
      ) ?? []
    ).length,
    s.compact.rows.length,
  );
  assert.equal(
    html.includes('Quality and source evidence'),
    false,
    'nothing of the details is drawn before they are opened',
  );
  assert.equal(view.requests.length, 0, 'and nothing is asked for');
  // A full row carries its details inline, as it always did.
  const whole = view.table(s.full);
  assert.equal(whole.includes('data-report-details'), false);
  assert.match(whole, /<details><summary>Source details<\/summary><p>[^<]*<br>[^<]*<br>[^<]*<\/p>/);
});

test('opening a row’s source details asks for that row’s platform, level and entity, with the provider’s rows, and draws what a full row draws', async t => {
  const s = await granular(t),
    view = page('en', s.bootstrap, s.reply),
    {details} = view.bind(s.compact);
  // The first campaign row, then an ad row: each names its own level and its own entity.
  const campaign = s.compact.rows.findIndex(r => r.level === 'campaign'),
    ad = s.compact.rows.findIndex(r => r.level === 'ad');
  await details[campaign].toggle(true);
  await details[ad].toggle(true);
  assert.equal(view.requests.length, 2);
  for (const [request, index] of [
    [view.requests[0], campaign],
    [view.requests[1], ad],
  ]) {
    const source = s.compact.sources.find(x => x.source_ref === s.compact.rows[index].source_ref);
    assert.deepEqual(request, {
      action: 'get',
      id: s.compact.id,
      limit: 100,
      include: {native: true},
      platform: source.source.platform,
      level: s.compact.rows[index].level,
      entity: s.compact.rows[index].entity_id,
    });
  }
  // The body is the markup of a full row's details, for that very row.
  for (const index of [campaign, ad]) {
    const wholeRow = s.full.rows.find(r => r.row_key === s.compact.rows[index].row_key),
      expected = String(view.raw('reportRowDetails(row)', {row: wholeRow}));
    assert.equal(details[index].body.innerHTML, expected);
    assert.equal(details[index].body.attributes['aria-busy'], undefined, 'loading is over');
    assert.match(expected, /Quality and source evidence/);
    assert.ok(wholeRow.native && Object.keys(wholeRow.native).length > 0);
    assert.ok(
      expected.includes('<pre>' + esc(JSON.stringify(wholeRow.native, null, 2)) + '</pre>'),
      'the provider’s own row',
    );
  }
});

test('the row is found by its key among the rows of its entity: a daily entity has a row for each day', async t => {
  const s = await granular(t),
    view = page('en', s.bootstrap, s.reply),
    {details} = view.bind(s.compact),
    ad = s.compact.rows.map((r, index) => [r, index]).filter(([r]) => r.level === 'ad');
  assert.ok(ad.length >= 2, 'the entity has a row for each of its days');
  const [second, index] = ad[1];
  await details[index].toggle(true);
  assert.equal(view.requests.length, 1);
  const wholeRow = s.full.rows.find(r => r.row_key === second.row_key);
  assert.equal(details[index].body.innerHTML, String(view.raw('reportRowDetails(row)', {row: wholeRow})));
  assert.ok(second.row_key.includes(second.date_from));
});

test('an entity with more rows than a page continues by its cursor until the row is found', async t => {
  const s = await granular(t),
    // The server answers the entity's first read a row at a time, as it would past a page of 100 rows.
    narrow = input => s.reply(input.cursor ? input : {...input, limit: 1}),
    view = page('en', s.bootstrap, narrow),
    {details} = view.bind(s.compact),
    ad = s.compact.rows.map((r, index) => [r, index]).filter(([r]) => r.level === 'ad'),
    [second, index] = ad[1];
  await details[index].toggle(true);
  assert.equal(view.requests.length, 2, 'the first page of the entity’s rows, then its cursor');
  assert.equal(view.requests[0].cursor, undefined);
  assert.equal(typeof view.requests[1].cursor, 'string');
  const same = request => ({...request, cursor: undefined, limit: undefined});
  assert.deepEqual(same(view.requests[1]), same(view.requests[0]), 'the continuation is the same read');
  const wholeRow = s.full.rows.find(r => r.row_key === second.row_key);
  assert.equal(details[index].body.innerHTML, String(view.raw('reportRowDetails(row)', {row: wholeRow})));
  // A row that is not in the entity's rows at all ends in the failure state after the last page, not in a loop.
  const gone = page('en', s.bootstrap, input =>
    narrow(input).then(answer => ({...answer, rows: answer.rows.map(r => ({...r, row_key: 'other:' + r.row_key}))})),
  ).bind(s.compact);
  await gone.details[index].toggle(true);
  assert.match(gone.details[index].body.innerHTML, /role="alert"/);
});
test('while the details load the body says so and is busy; opening again, or drawing the table again, asks for nothing', async t => {
  const s = await granular(t);
  let release;
  const gate = new Promise(resolve => (release = resolve)),
    view = page('en', s.bootstrap, async input => {
      await gate;
      return s.reply(input);
    }),
    {details} = view.bind(s.compact),
    pending = details[0].toggle(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(details[0].body.attributes['aria-busy'], 'true');
  assert.match(details[0].body.innerHTML, /<p role="status">Loading source details…<\/p>/);
  release();
  await pending;
  assert.equal(details[0].body.attributes['aria-busy'], undefined);
  assert.equal(view.requests.length, 1);
  // Closed and opened again: nothing new is asked for.
  await details[0].toggle(false);
  await details[0].toggle(true);
  assert.equal(view.requests.length, 1);
  // The table is drawn again (a poll or a page change redraws it): the report’s loaded rows are kept.
  const again = view.bind(s.compact);
  await again.details[0].toggle(true);
  assert.equal(view.requests.length, 1, 'what was loaded stays for this report');
  assert.match(again.details[0].body.innerHTML, /Quality and source evidence/);
});

test('a failure says so with Retry; Retry asks again and a second failure keeps it; the table is never changed by it', async t => {
  const s = await granular(t);
  let fail = 2;
  const view = page('en', s.bootstrap, async input => {
      if (input.include?.native && fail-- > 0) throw new Error('The report request failed.');
      return s.reply(input);
    }),
    {rows: html, details} = view.bind(s.compact),
    d = details[0];
  await d.toggle(true);
  assert.match(d.body.innerHTML, /role="alert"/);
  assert.match(d.body.innerHTML, /The source details could not be loaded\./);
  assert.match(
    d.body.innerHTML,
    /<button type="button" class="button small" data-report-details-retry>Retry<\/button>/,
  );
  assert.equal(d.body.attributes['aria-busy'], undefined);
  // Closing and opening it again does not ask again on its own.
  await d.toggle(false);
  await d.toggle(true);
  assert.equal(view.requests.length, 1);
  // Retry fails once more, then works.
  await d.retryNow();
  assert.equal(view.requests.length, 2);
  assert.match(d.body.innerHTML, /role="alert"/);
  await d.retryNow();
  assert.equal(view.requests.length, 3);
  assert.match(d.body.innerHTML, /Quality and source evidence/);
  assert.equal(d.body.attributes['aria-busy'], undefined);
  assert.equal(view.table(s.compact), html, 'the rows table itself is as it was');
});

for (const locale of ['en', 'ar'])
  test(locale + ': the loading and failure sentences are in the interface language', async t => {
    const s = await granular(t),
      want = text => (locale === 'ar' ? catalog[text] : text);
    assert.ok(want('Loading source details…'), 'Arabic for the loading sentence');
    assert.ok(want('The source details could not be loaded.'), 'Arabic for the failure sentence');
    let release;
    const gate = new Promise(resolve => (release = resolve)),
      view = page(locale, s.bootstrap, async input => {
        await gate;
        throw new Error('x');
      }),
      {details} = view.bind(s.compact),
      pending = details[0].toggle(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(details[0].body.innerHTML.includes(want('Loading source details…')));
    release();
    await pending;
    assert.ok(details[0].body.innerHTML.includes(want('The source details could not be loaded.')));
    assert.ok(details[0].body.innerHTML.includes('>' + want('Retry') + '<'));
  });
