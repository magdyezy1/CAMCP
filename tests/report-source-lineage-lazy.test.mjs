// Package website-get (W3): a v4 source's lineage is not in a compact answer, so a source card draws its "Quality and source
// evidence" as a closed disclosure and loads the lineage when it is first opened: one `get` for the report with
// include.lineage, which carries the lineage of every source, so a second card asks for nothing. A source of an earlier
// contract, and a full answer, keep their evidence inline. The server is the real one, the page's scripts run in a VM.
import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {esc, granular, page, wire} from './helpers/report-lazy-page.mjs';

/** The evidence a card shows: its quality, its lineage and its query fingerprint, as the page writes them. */
const evidence = source =>
  '<pre>' +
  esc(
    JSON.stringify(
      {quality: source.quality, lineage: source.lineage, query_fingerprint: source.query_fingerprint},
      null,
      2,
    ),
  ) +
  '</pre>';
const inline = (cards, index) =>
  [...cards.matchAll(/<details[^>]*><summary>Quality and source evidence<\/summary>([\s\S]*?)<\/details>/g)][
    index
  ]?.[1];

test('a compact source card’s evidence is a closed disclosure with the source’s reference and an empty body; a full answer’s card has it whole', async t => {
  const s = await granular(t),
    view = page('en', s.bootstrap, s.reply),
    {cards, lineage} = view.bind(s.compact);
  assert.equal(lineage.length, s.compact.sources.length);
  assert.deepEqual(
    lineage.map(d => d.dataset.reportLineage),
    s.compact.sources.map(source => String(source.source_ref)),
  );
  assert.match(
    cards,
    /<details data-report-lineage="0"><summary>Quality and source evidence<\/summary><div data-report-details-body><\/div><\/details>/,
  );
  assert.equal(cards.includes('"lineage"'), false, 'no lineage is drawn before it is opened');
  assert.equal(view.requests.length, 0, 'and none is asked for');
  // The full answer carries the lineage of its sources, so its card is as it always was.
  const whole = view.cards(s.full);
  assert.equal(whole.includes('data-report-lineage'), false);
  assert.equal(inline(whole, 0), evidence(s.full.sources[0]));
  assert.ok(s.full.sources[0].lineage.length > 0, 'the case is real: this source has lineage');
});

test('opening a source card’s evidence asks for the report’s lineage once, and draws what a full answer’s card draws', async t => {
  const s = await granular(t),
    view = page('en', s.bootstrap, s.reply),
    {lineage} = view.bind(s.compact);
  await lineage[0].toggle(true);
  assert.deepEqual(view.requests, [{action: 'get', id: s.compact.id, limit: 1, include: {lineage: true}}]);
  assert.equal(lineage[0].body.innerHTML, evidence(s.full.sources[0]));
  assert.equal(lineage[0].body.attributes['aria-busy'], undefined);
  // Closed and opened again, or the cards drawn again (a poll redraws them): nothing new is asked for.
  await lineage[0].toggle(false);
  await lineage[0].toggle(true);
  const again = view.bind(s.compact);
  await again.lineage[0].toggle(true);
  assert.equal(view.requests.length, 1);
  assert.equal(again.lineage[0].body.innerHTML, evidence(s.full.sources[0]));
});

test('one request carries the lineage of every source of the report, so the second card asks for nothing', async t => {
  const s = await granular(t, {platforms: ['meta', 'tiktok']}),
    view = page('en', s.bootstrap, s.reply),
    {lineage} = view.bind(s.compact);
  assert.equal(lineage.length, 2);
  await Promise.all(lineage.map(details => details.toggle(true)));
  assert.equal(view.requests.length, 1);
  lineage.forEach((details, index) => assert.equal(details.body.innerHTML, evidence(s.full.sources[index])));
  assert.notEqual(lineage[0].body.innerHTML, lineage[1].body.innerHTML, 'each card has its own source’s lineage');
});

test('the loading state, a failure with Retry and a retry are the row details’ own', async t => {
  const s = await granular(t);
  let release,
    fail = 1;
  const gate = new Promise(resolve => (release = resolve)),
    view = page('en', s.bootstrap, async input => {
      await gate;
      if (fail-- > 0) throw new Error('The report request failed.');
      return s.reply(input);
    }),
    {lineage} = view.bind(s.compact),
    d = lineage[0],
    pending = d.toggle(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(d.body.attributes['aria-busy'], 'true');
  assert.match(d.body.innerHTML, /<p role="status">Loading source details…<\/p>/);
  release();
  await pending;
  assert.match(d.body.innerHTML, /role="alert"[\s\S]*The source details could not be loaded\./);
  assert.equal(d.body.attributes['aria-busy'], undefined);
  await d.retryNow();
  assert.equal(view.requests.length, 2, 'a failed request is not kept: Retry asks again');
  assert.equal(d.body.innerHTML, evidence(s.full.sources[0]));
});

test('a source of an earlier contract keeps its evidence inline, whatever the answer is asked for', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const queued = await f.overview.handle(
    {action: 'run', config: granularConfig(granularSource('meta', 'ad')), confirmed: true},
    f.actor,
  );
  await f.worker.once();
  const plain = wire(await f.overview.handle({action: 'get', id: queued.id}, f.actor)),
    bootstrap = wire(await f.overview.handle({action: 'bootstrap'}, f.actor)),
    view = page('en', bootstrap, input => f.overview.handle(input, f.actor));
  assert.notEqual(plain.config.contract_version, 'overview-config-v4');
  const cards = view.cards(plain);
  assert.equal(cards.includes('data-report-lineage'), false);
  assert.equal(inline(cards, 0), evidence(plain.sources[0]));
});
