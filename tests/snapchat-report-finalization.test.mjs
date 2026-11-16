// Package r12-fix, the lead's ruling on item 1 (decision 2, recency, 2026-11-16). The rule that tells an empty Snapchat answer that
// is "no rows" from one that is not yet known: the pure function over what the all-campaign read keeps of each campaign, and the
// sentence that gives the reason. tests/snapchat-unconfirmed-empty.test.mjs runs the whole read; this is the rule itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {snapchatUnconfirmedEmptyWarning, unconfirmedEmptyCampaigns} from '../dist/src/snapchat-report-finalization.js';

const iso = ms => new Date(ms).toISOString();
const end = Date.parse('2023-04-09T07:00:00.000Z'),
  day = 86400000;
/**
 * A source page as the capture keeps it in its lineage (src/snapchat-evidence.ts): `entities` is how many ad squads the answer held,
 * `stated` the finalization times it carried (left out as Snapchat leaves them out of an answer with none), `closes` the end of
 * the window it was read for.
 */
const page = ({entities = 0, finalized, conversion, closes = end, unstated = false} = {}) => ({
  page: 1,
  entity_count: entities,
  row_count: entities * 2,
  source_request: {query: {end_time: iso(closes)}},
  ...(finalized !== undefined ? {finalized_data_end_time: iso(finalized)} : {}),
  ...(conversion !== undefined ? {conversion_data_processed_end_time: iso(conversion)} : {}),
  ...(unstated ? {finalization_stated: false} : {}),
});
/** A campaign's assembled result: its lineage holds its account checks, its pages and the reads of its parents. */
const campaign = (...pages) => ({lineage: [{stage: 'account_lookup'}, ...pages, {stage: 'parents', path: '/v1/x'}]});
const bare = options => page({...options, unstated: true});
const delivering = (finalized, options) => page({entities: 2, finalized, conversion: finalized, ...options});

test('an empty answer without finalization times is unconfirmed when the collection holds no answer with ad squads', () => {
  assert.equal(unconfirmedEmptyCampaigns([campaign(bare())]), 1);
  assert.equal(unconfirmedEmptyCampaigns([campaign(bare()), campaign(bare()), campaign(bare())]), 3);
  assert.equal(unconfirmedEmptyCampaigns([]), 0);
});

test('a finalization time of an answer with ad squads that covers the window confirms it, wherever that answer is in the collection', () => {
  for (const results of [
    [campaign(bare()), campaign(bare()), campaign(delivering(end + day))],
    [campaign(delivering(end + day)), campaign(bare()), campaign(bare())],
    [campaign(bare()), campaign(delivering(end + day)), campaign(bare())],
  ])
    assert.equal(unconfirmedEmptyCampaigns(results), 0);
});

test('a finalization time exactly at the end of the window covers it, and one millisecond earlier does not', () => {
  assert.equal(unconfirmedEmptyCampaigns([campaign(bare()), campaign(delivering(end))]), 0);
  assert.equal(unconfirmedEmptyCampaigns([campaign(bare()), campaign(delivering(end - 1))]), 1);
});

test('the earliest time of the collection is the evidence, and an empty answer is judged against the end of its own window', () => {
  const later = end + 30 * day;
  // Two answers with ad squads: the earliest is short of the later window, so its empty answer is unconfirmed.
  assert.equal(
    unconfirmedEmptyCampaigns([
      campaign(delivering(later + day, {closes: end}), bare({closes: later})),
      campaign(delivering(later - 1, {closes: end})),
    ]),
    1,
  );
  // The same two with the earlier answer covering both windows: nothing is unconfirmed.
  assert.equal(
    unconfirmedEmptyCampaigns([
      campaign(delivering(later + day, {closes: end}), bare({closes: later})),
      campaign(delivering(later, {closes: end})),
    ]),
    0,
  );
  // An empty answer of the first window is covered by evidence that stops short of the second.
  assert.equal(unconfirmedEmptyCampaigns([campaign(bare({closes: end})), campaign(delivering(end + day))]), 0);
});

test('the conversion time of an answer with ad squads is evidence as well, so the earliest of the two is what counts', () => {
  const result = campaign(page({entities: 1, finalized: end + 5 * day, conversion: end - day}));
  assert.equal(unconfirmedEmptyCampaigns([campaign(bare()), result]), 1);
  assert.equal(unconfirmedEmptyCampaigns([campaign(bare()), campaign(page({entities: 1, finalized: end + day}))]), 0);
});

test('an empty answer is not evidence: it is no rows only by its own times, and it confirms no other', () => {
  const stated = page({finalized: end + day, conversion: end + day});
  assert.equal(unconfirmedEmptyCampaigns([campaign(stated)]), 0, 'an answer that states its times is not unconfirmed');
  assert.equal(unconfirmedEmptyCampaigns([campaign(stated), campaign(bare())]), 1);
});

test('a campaign counts once, however many of its answers are unconfirmed, and a page of the others does not count it', () => {
  const two = campaign(bare({closes: end}), bare({closes: end + 31 * day}));
  assert.equal(unconfirmedEmptyCampaigns([two]), 1);
  assert.equal(unconfirmedEmptyCampaigns([two, campaign(delivering(end + day), bare({closes: end + 60 * day}))]), 2);
  assert.equal(unconfirmedEmptyCampaigns([campaign(delivering(end + day)), campaign(delivering(end + day))]), 0);
});

test('what cannot be read is never taken as confirmation', () => {
  const unreadable = page({unstated: true});
  unreadable.source_request.query.end_time = 'not a time';
  assert.equal(unconfirmedEmptyCampaigns([campaign(unreadable), campaign(delivering(end + day))]), 1);
  const noRequest = page({unstated: true});
  delete noRequest.source_request;
  assert.equal(unconfirmedEmptyCampaigns([campaign(noRequest), campaign(delivering(end + day))]), 1);
  // A page with ad squads whose time is not a time is not evidence.
  const odd = delivering(end + day);
  odd.finalized_data_end_time = 'yesterday';
  odd.conversion_data_processed_end_time = 'today';
  assert.equal(unconfirmedEmptyCampaigns([campaign(bare()), campaign(odd)]), 1);
});

test('results that hold no pages, or entries that are not pages, are left out', () => {
  assert.equal(
    unconfirmedEmptyCampaigns([{}, {lineage: []}, {lineage: [{stage: 'account_lookup'}]}, {lineage: null}]),
    0,
  );
  assert.equal(unconfirmedEmptyCampaigns([campaign(), campaign(bare())]), 1);
});

test('the reason is one sentence for people and agents: it says what is not known, that nothing is counted as zero, and what to do', () => {
  assert.equal(typeof snapchatUnconfirmedEmptyWarning, 'string');
  assert.match(
    snapchatUnconfirmedEmptyWarning,
    /^For part of this source, Snapchat returned no rows and did not say that its data is final/,
  );
  assert.match(snapchatUnconfirmedEmptyWarning, /cannot tell no delivery from data Snapchat has not processed yet/);
  assert.match(snapchatUnconfirmedEmptyWarning, /never counted as zero, so this source is partial/);
  assert.match(
    snapchatUnconfirmedEmptyWarning,
    /Run the report again once Snapchat has finalized the window, or choose an earlier window\.$/,
  );
  // WEB-03: no argument, field or tool name, and nothing addressed to an MCP client alone.
  assert.doesNotMatch(
    snapchatUnconfirmedEmptyWarning,
    /\b[a-z][a-z0-9]*_[a-z0-9_]+\b|details\.|\bthe call\b|\bthe user\b|amcp_/,
  );
});

test('the reason has its Arabic string, and the catalogue holds it exactly once', () => {
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  assert.ok(Object.hasOwn(catalog, snapchatUnconfirmedEmptyWarning), 'Arabic for the reason');
  assert.match(catalog[snapchatUnconfirmedEmptyWarning], /\p{Script=Arabic}/u);
  assert.notEqual(catalog[snapchatUnconfirmedEmptyWarning], snapchatUnconfirmedEmptyWarning);
  assert.ok(
    catalog[snapchatUnconfirmedEmptyWarning].includes('Snapchat') &&
      catalog[snapchatUnconfirmedEmptyWarning].includes('AMCP'),
  );
});
