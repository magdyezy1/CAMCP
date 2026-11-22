import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {restoreClockAfter} from './helpers/tiktok-cutoff-clock.mjs';
import {
  assertDeprecationRegistry,
  deprecationStatus,
  providerDeprecation,
  setDeprecationClock,
} from '../dist/src/provider-deprecations.js';
import {pushFixture, ad, post, video, texts, endCards} from './fixtures/tiktok-smart-plus-push.mjs';
// The module of the review's end card sentences and of the scenario TikTok documents them for, as a namespace: a name it does not export yet
// fails only the test that calls it.
import * as endCardModule from '../dist/src/tiktok-smart-plus-end-cards.js';
import {tiktokSmartPlusAdImpact} from '../dist/src/tiktok-smart-plus-ads.js';

/**
 * End cards in an Upgraded Smart+ ad (package r25-m4b-endcards; matrix A10). API for Business v1.3, read 2026-11-22: "Create an
 * Upgraded Smart+ Ad" and "Update an Upgraded Smart+ Ad" take `end_card_list`, a top-level list of 1 to 10 `{end_card_id}` (the
 * `creative_portfolio_id` of a portfolio of type END_CARD, which "Get portfolios or end cards within an ad account" lists); "Using end
 * cards in your ads is currently an allowlist-only feature", "Duplicate end cards are not allowed", and "Starting February 22, 2027, if
 * you are an allowlisted advertiser, end cards are required for eligible ad scenarios"; the update page adds "You can only use this field
 * to update existing end cards in your ads". `ad_configuration.end_card_cta` is another field, the call to action of an Automotive
 * catalog ad's end card image (package smartcatalog's), and stays refused here. The synthetic advertiser is
 * tests/fixtures/tiktok-smart-plus-push.mjs: end cards 8801 to 8812, 8890 (a Display Card, no end card) and 8899 (another advertiser's).
 * Every test that depends on the date pins the deprecation clock for itself and gives it back (tests/helpers/tiktok-cutoff-clock.mjs).
 */
async function withFixture(body) {
  const f = pushFixture();
  try {
    return await body(f);
  } finally {
    f.store.close();
  }
}
const paths = p => p.data.state_reads.map(r => r.path);
const listReads = f => f.queries.filter(q => q.path === '/v1.3/creative/portfolio/list/');
const filteringOf = q => JSON.parse(new URLSearchParams(q.search).get('filtering'));
/** A create of a Spark Ad from post 9001 (or the creatives given) with the end cards given; `extra` replaces top-level keys. */
const withCards = (ids, extra = {}, creatives = [post('9001')]) =>
  ad(creatives, {end_card_list: endCards(...ids), ...extra});

// ---------------------------------------------------------------------------------------------------------------------------
// The create: an end card is read, reviewed, sent as it was reviewed and read back.
// ---------------------------------------------------------------------------------------------------------------------------
test('a Spark Ad from a post with an end card is reviewed with the end card read, created once with end_card_list as sent, and verified', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    const payload = withCards(['8801']);
    const p = await f.prepared(payload);
    // The end card is read where "Create an Upgraded Smart+ Ad" says to look for it: the portfolio list, by ID, of the selected advertiser.
    assert.ok(paths(p).includes('/v1.3/creative/portfolio/list/'), paths(p).join(' '));
    const reads = listReads(f);
    assert.equal(reads.length, 1);
    assert.deepEqual(filteringOf(reads[0]).creative_portfolio_ids, ['8801']);
    assert.equal(new URLSearchParams(reads[0].search).get('advertiser_id'), '123');
    const {allowlist, scenario_note: scenarioNote, ...cards} = p.data.creative_impact.end_cards;
    assert.deepEqual(cards, {count: 1, end_card_ids: ['8801']});
    // The review says, before anything is sent, what TikTok decides.
    assert.match(allowlist, /End cards are an allowlist-only feature/);
    assert.match(allowlist, /40118/);
    // And that a Spark Ad is outside the scenario TikTok documents end cards for (S3-1 of the lead's review): TikTok decides.
    assert.match(scenarioNote, /custom identity/);
    assert.match(scenarioNote, /Spark Ad/);
    assert.match(scenarioNote, /TikTok decides/);
    assert.ok(!p.data.execute_requirements.spend_change_confirmed, 'a paused create needs no spend flag (Q14)');
    const x = await f.execute(p.data.review_id);
    assert.equal(x.success, true, JSON.stringify(x.error ?? x).slice(0, 600));
    assert.deepEqual(f.writes, [payload]);
    assert.deepEqual(f.ads[5601].end_card_list, endCards('8801'));
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
    // A replay answers with the recorded outcome and sends nothing.
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  }));

test('a Spark Ad Push with two end cards, which TikTok reads back in the other order, is created and verified as the set that was sent', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    // TikTok lists the end cards in the other order: the page states no order, so the ads are the same.
    f.behaviour.reverseEndCards = true;
    const payload = ad([video('v-1', 'img-1')], {
      ad_text_list: texts('Spring sale'),
      end_card_list: endCards('8802', '8801'),
    });
    const p = await f.prepared(payload);
    assert.equal(p.data.creative_impact.end_cards.count, 2);
    assert.deepEqual(p.data.creative_impact.end_cards.end_card_ids, ['8802', '8801']);
    assert.deepEqual(filteringOf(listReads(f)[0]).creative_portfolio_ids.sort(), ['8801', '8802']);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.deepEqual(f.writes[0].end_card_list, endCards('8802', '8801'));
    assert.deepEqual(f.ads[5601].end_card_list, endCards('8801', '8802'));
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
  }));

test('ten end cards are accepted: the limit of the page is 1 to 10', async () =>
  withFixture(async f => {
    const ids = Array.from({length: 10}, (_, i) => String(8801 + i));
    const p = await f.prepared(withCards(ids));
    assert.equal(p.data.creative_impact.end_cards.count, 10);
    assert.deepEqual(filteringOf(listReads(f)[0]).creative_portfolio_ids, ids);
  }));

// ---------------------------------------------------------------------------------------------------------------------------
// The shape of end_card_list: every rule of the pages is a refusal with its own field, before any request.
// ---------------------------------------------------------------------------------------------------------------------------
test('the shape of end_card_list: a list of 1 to 10 distinct {end_card_id}, each a numeric ID, is refused with its own field before any request', async () =>
  withFixture(async f => {
    const eleven = Array.from({length: 11}, (_, i) => String(8801 + i));
    const cases = {
      'no list': [{end_card_list: '8801'}, 'end_card_list'],
      'an empty list': [{end_card_list: []}, 'end_card_list'],
      'null': [{end_card_list: null}, 'end_card_list'],
      'eleven end cards (the page says "Size range: 1–10")': [{end_card_list: endCards(...eleven)}, 'end_card_list'],
      'an end card that is a string': [{end_card_list: ['8801']}, 'end_card_list[0]'],
      'an end card with another key': [
        {end_card_list: [{end_card_id: '8801', creative_portfolio_type: 'END_CARD'}]},
        'end_card_list[0]',
      ],
      'an end card with no ID': [{end_card_list: [{}]}, 'end_card_list[0].end_card_id'],
      'an ID that is no number': [{end_card_list: endCards('card')}, 'end_card_list[0].end_card_id'],
      'an ID that is a number and no string': [{end_card_list: [{end_card_id: 8801}]}, 'end_card_list[0].end_card_id'],
      'an ID of zero': [{end_card_list: endCards('0')}, 'end_card_list[0].end_card_id'],
      'the same end card twice (the page: "Duplicate end cards are not allowed")': [
        {end_card_list: endCards('8801', '8802', '8801')},
        'end_card_list[2].end_card_id',
      ],
    };
    for (const [name, [extra, field]] of Object.entries(cases)) {
      const r = await f.prepare(ad([post('9001')], extra));
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, field, name + ': ' + r.error.message);
    }
    assert.equal(f.requests.length, 0);
  }));

test('a request that breaks the end card rules and others is told all of them at once, as every rule of the contract is', async () =>
  withFixture(async f => {
    const r = await f.prepare(
      ad([post('9001')], {end_card_list: endCards('8801', '8801'), interactive_add_on_list: [{card_id: '8890'}]}),
    );
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    const fields = r.error.details.violations.map(v => v.field).sort();
    assert.deepEqual(fields, ['end_card_list[1].end_card_id', 'interactive_add_on_list']);
    assert.equal(f.requests.length, 0);
  }));

// ---------------------------------------------------------------------------------------------------------------------------
// What the review reads: the end card is the advertiser's, and an end card.
// ---------------------------------------------------------------------------------------------------------------------------
test('an end card the advertiser’s library does not return is refused, before and again at execute, with nothing written', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    // 8899 is another advertiser's end card: the list of this advertiser does not return it.
    const stray = await f.prepare(withCards(['8801', '8899']));
    assertRefused(stray, 'STATE_TARGET_MISMATCH', {writes: () => f.writes.length});
    assert.match(stray.error.message, /8899/);
    assert.deepEqual(
      stray.error.details.end_card_ids,
      ['8899'],
      'the refusal names the end cards TikTok did not return',
    );
    // One that is gone between the review and its execution is refused at execute, as a library video would be.
    const p = await f.prepared(withCards(['8801', '8802']));
    delete f.endCardRows['8802'];
    assertRefused(await f.execute(p.data.review_id), 'STATE_TARGET_MISMATCH', {writes: () => f.writes.length});
    assert.equal(f.writes.length, 0);
    assert.equal(Object.keys(f.ads).filter(id => f.ads[id].ad_name === 'Push sale').length, 0);
  }));

test('a list that also returns other end cards (its filter ignored) is no reason to refuse, and another end card changing is no change of the review', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    f.behaviour.ignoreListFilter = true;
    const p = await f.prepared(withCards(['8801']));
    assert.deepEqual(p.data.creative_impact.end_cards.end_card_ids, ['8801']);
    // The review keeps the end card it was asked for and none of the others the list returned: one of them going away is nothing to it.
    delete f.endCardRows['8805'];
    f.endCardRows['8806'].type = 'CARD';
    const x = await f.execute(p.data.review_id);
    assert.equal(x.success, true, JSON.stringify(x.error ?? x).slice(0, 600));
    assert.equal(f.writes.length, 1);
  }));

test('an answer of TikTok that has no list of portfolios is a failed read, not a statement that the end card is missing', async () =>
  withFixture(async f => {
    f.behaviour.noPortfolioList = true;
    const r = await f.prepare(withCards(['8801']));
    assertRefused(r, 'STATE_READ_FAILED', {writes: () => f.writes.length});
    assert.match(r.error.message, /list the end cards asked for/);
  }));

test('a portfolio that is no end card is refused, naming end_card_list: a Display Card is not an end card', async () =>
  withFixture(async f => {
    const r = await f.prepare(withCards(['8801', '8890']));
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(r.error.details.field, 'end_card_list[1].end_card_id');
    assert.match(r.error.message, /8890/);
    assert.match(r.error.message, /END_CARD/);
  }));

test('the review keeps the IDs and types of end cards, never the link TikTok signs anew at every read', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    const p = await f.prepared(withCards(['8801', '8802']));
    assert.doesNotMatch(JSON.stringify(p.data), /8801\.png|8802\.png|x-signature/);
    // Execute reads the end cards again, and their preview links are other links: the review is still the one that was approved.
    const x = await f.execute(p.data.review_id);
    assert.equal(x.success, true, JSON.stringify(x.error ?? x).slice(0, 600));
    assert.equal(listReads(f).length, 2, 'read at prepare and again at execute');
  }));

test('where the ad group does not deliver to the TikTok Ad Network the review says that TikTok documents end cards there, every Spark Ad with end cards hears that it is outside the scenario, and neither refuses', async () =>
  withFixture(async f => {
    const impactOf = async adgroup =>
      (await f.prepared(withCards(['8801'], {adgroup_id: adgroup}))).data.creative_impact.end_cards;
    // 303 delivers on TikTok alone; 300 has automatic placements (TikTok, the Global App Bundle and Pangle); 304 chose TikTok and Pangle.
    const alone = await impactOf('303');
    assert.match(alone.placement_note, /TikTok Ad Network/);
    assert.match(alone.placement_note, /TikTok decides/);
    assert.equal((await impactOf('300')).placement_note, undefined);
    assert.equal((await impactOf('304')).placement_note, undefined);
    // The scenario of the page is a custom identity on Pangle placements: a Spark Ad is in none of these groups' scenario (S3-1).
    for (const adgroup of ['300', '303', '304'])
      assert.match((await impactOf(adgroup)).scenario_note, /outside that scenario/, adgroup);
  }));

// ---------------------------------------------------------------------------------------------------------------------------
// The allowlist: built and gated, never refused locally; TikTok's 40118 is definitive and the answer says what to ask for.
// ---------------------------------------------------------------------------------------------------------------------------
test('an advertiser that is not on the allowlist is refused by TikTok with 40118: nothing is created, the review is never sent again, and the answer says what to ask TikTok', async () =>
  withFixture(async f => {
    const p = await f.prepared(withCards(['8801']));
    assert.match(p.data.creative_impact.end_cards.allowlist, /40118/);
    const x = await f.execute(p.data.review_id);
    assertRefused(x, 'PROVIDER_ACCESS_DENIED');
    assert.equal(x.error.details.provider_code, 40118);
    assert.match(x.error.details.allowlist, /end_card_list/);
    assert.match(x.error.details.allowlist, /ask TikTok to allowlist this advertiser for end cards/);
    assert.equal(f.writes.length, 1);
    assert.equal(Object.keys(f.ads).filter(id => f.ads[id].ad_name === 'Push sale').length, 0, 'nothing was created');
    const again = await f.execute(p.data.review_id);
    assert.equal(again.error?.code, 'WRITE_REJECTED');
    assert.equal(f.writes.length, 1);
    // Another refusal of TikTok's (code 40002, from an advertiser that is on the allowlist) names no allowlist.
    f.behaviour.endCardsAllowlisted = true;
    f.behaviour.mode = 'error';
    const other = await f.prepared(withCards(['8801'], {ad_name: 'Another'}));
    const refused = await f.execute(other.data.review_id);
    assertRefused(refused, 'PLATFORM_ERROR');
    assert.equal(refused.error.details.provider_code, 40002);
    assert.equal(refused.error.details.allowlist, undefined);
  }));

test('a create that uses no end card and is refused with 40118 is answered as it was before this package: no allowlist sentence, which would name a feature the request does not use', async () =>
  withFixture(async f => {
    // Some other allowlist-gated feature of the request (the world does not say which): TikTok's code is the same.
    f.behaviour.denyCreates = true;
    const p = await f.prepared(ad([post('9001')]));
    assert.equal(p.data.creative_impact.end_cards, undefined);
    const x = await f.execute(p.data.review_id);
    assertRefused(x, 'PROVIDER_ACCESS_DENIED');
    assert.equal(x.error.details.provider_code, 40118);
    assert.equal(
      x.error.details.allowlist,
      undefined,
      'a create has no ad_material_id and no end card here: neither sentence applies',
    );
    // Still definitive: nothing was created, and the review is never sent again.
    assert.equal(f.writes.length, 1);
    assert.equal((await f.execute(p.data.review_id)).error?.code, 'WRITE_REJECTED');
    assert.equal(f.writes.length, 1);
    // With an end card the same refusal names end cards, as the test above shows: the sentence follows the request, not the code alone.
    f.behaviour.denyCreates = false;
    const withCard = await f.prepared(withCards(['8801']));
    const refused = await f.execute(withCard.data.review_id);
    assertRefused(refused, 'PROVIDER_ACCESS_DENIED');
    assert.match(refused.error.details.allowlist, /ask TikTok to allowlist this advertiser for end cards/);
  }));

// ---------------------------------------------------------------------------------------------------------------------------
// The read-back compares the end cards.
// ---------------------------------------------------------------------------------------------------------------------------
test('the read-back compares the end cards: an ad TikTok created without them is not a verified ad', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    f.behaviour.dropEndCards = true;
    const p = await f.prepared(withCards(['8801']));
    assert.equal((await f.execute(p.data.review_id)).success, true);
    const v = await f.verify(p.data.review_id);
    // The read-back is stable and differs in one field, the end cards: that is what "not verified" says.
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v.data));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/end_card_list']);
  }));

// ---------------------------------------------------------------------------------------------------------------------------
// The gates the package leaves as they were, each refused as before.
// ---------------------------------------------------------------------------------------------------------------------------
test('what the contract refused around end cards stays refused: interactive add-ons, the automotive end card call to action, custom identities', async () =>
  withFixture(async f => {
    const cases = {
      // "You cannot use this field together with interactive_add_on_list": add-ons stay outside the contract, so the two never meet.
      'interactive add-ons': [
        ad([post('9001')], {interactive_add_on_list: [{card_id: '8890'}]}),
        'interactive_add_on_list',
      ],
      'the end card call to action of an Automotive catalog ad (end_card_cta is another field, package smartcatalog’s)':
        [ad([post('9001')], {}, {end_card_cta: 'LEARN_MORE'}), 'ad_configuration.end_card_cta'],
      'a custom identity with an end card': [
        withCards(['8801'], {}, [post('9001', 'SINGLE_VIDEO', {identity_type: 'CUSTOMIZED_USER'})]),
        'creative_list[0].creative_info.identity_type',
      ],
      'an end card for a Pangle-only ad group (the contract delivers on TikTok)': [
        withCards(['8801'], {adgroup_id: '302'}),
        'adgroup_id',
      ],
    };
    for (const [name, [payload, field]] of Object.entries(cases)) {
      const r = await f.prepare(payload);
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, field, name + ': ' + r.error.message);
    }
    assert.equal(f.writes.length, 0);
  }));

test('an enabled ad with end cards needs the spend flag under parents that serve, and none under a paused parent, as an ad without them does (Q1, Q14)', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    const enabled = withCards(['8801'], {operation_status: 'ENABLE'});
    const paused = await f.prepared(enabled);
    assert.ok(!paused.data.execute_requirements.spend_change_confirmed);
    f.groups[300].operation_status = 'ENABLE';
    f.campaigns[80].operation_status = 'ENABLE';
    const serving = await f.prepared(enabled);
    assert.equal(serving.data.execute_requirements.spend_change_confirmed, true);
    assertRefused(await f.execute(serving.data.review_id), 'SPEND_CONFIRMATION_REQUIRED', {
      writes: () => f.writes.length,
    });
    assert.equal(f.writes.length, 0);
    // With the flag the same review is sent once, end cards and all.
    const done = await f.execute(serving.data.review_id, {spend_change_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 600));
    assert.deepEqual(f.writes, [enabled]);
  }));

test('a create with end cards whose answer was lost is not created twice: the guard against creating twice holds the same request back', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    f.behaviour.mode = 'lost';
    const body = withCards(['8801', '8802']);
    const p = await f.prepared(body);
    assertRefused(await f.execute(p.data.review_id), 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(f.writes.length, 1);
    f.behaviour.mode = '';
    const again = await f.prepare(body);
    assertRefused(again, 'DUPLICATE_OF_UNCERTAIN_WRITE', {writes: () => f.writes.length - 1});
    assert.equal(again.error.details.earlier_review_id, p.data.review_id);
    assert.equal(f.writes.length, 1);
  }));

test('a create without end cards reads no end card, sends none and is reviewed exactly as it was', async () =>
  withFixture(async f => {
    const p = await f.prepared(ad([post('9001')]));
    assert.deepEqual(paths(p), [
      '/v1.3/smart_plus/adgroup/get/',
      '/v1.3/smart_plus/ad/get/',
      '/v1.3/identity/info/',
      '/v1.3/identity/video/info/',
      '/v1.3/creative/portfolio/get/',
    ]);
    assert.equal(p.data.creative_impact.end_cards, undefined);
    assert.equal(listReads(f).length, 0);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal(f.writes[0].end_card_list, undefined);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  }));

// ---------------------------------------------------------------------------------------------------------------------------
// The edit: the end cards an ad holds are replaced, never added ("You can only use this field to update existing end cards in your ads").
// ---------------------------------------------------------------------------------------------------------------------------
const update = 'tiktok_smart_plus_ad_update';
const edit = (f, payload, extra) => f.prepare(payload, update, extra);
const edited = (f, payload, extra) => f.prepared(payload, update, extra);

test('the end cards of an ad that holds some are replaced: reviewed with the old and the new, sent alone, and verified', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    const payload = {smart_plus_ad_id: '5140', end_card_list: endCards('8802', '8803')};
    const p = await edited(f, payload);
    assert.ok(paths(p).includes('/v1.3/creative/portfolio/list/'), paths(p).join(' '));
    assert.deepEqual(filteringOf(listReads(f)[0]).creative_portfolio_ids, ['8802', '8803']);
    const impact = p.data.creative_impact;
    assert.deepEqual(impact.changes.end_card_list, {before: ['8801'], after: ['8802', '8803']});
    assert.deepEqual(impact.end_cards.end_card_ids, ['8802', '8803']);
    assert.match(impact.end_cards.allowlist, /End cards are an allowlist-only feature/);
    // Every ad this contract edits is a Spark Ad (the others are only renamed), so the edit's review says what a create's does (S3-1).
    assert.match(impact.end_cards.scenario_note, /Spark Ad/);
    assert.equal(impact.may_affect_serving, false, 'a paused ad delivers nothing until it is enabled');
    const x = await f.execute(p.data.review_id);
    assert.equal(x.success, true, JSON.stringify(x.error ?? x).slice(0, 600));
    assert.deepEqual(f.writes, [{advertiser_id: '123', ...payload}]);
    assert.deepEqual(f.ads[5140].end_card_list, endCards('8802', '8803'));
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
  }));

test('the end cards of a Spark Ad Push and of an enabled ad are edited the same way, with the name beside them, and TikTok’s other order is the same set', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    f.behaviour.reverseEndCards = true;
    const push = await edited(f, {
      smart_plus_ad_id: '5141',
      ad_name: 'Renamed',
      end_card_list: endCards('8803', '8801'),
    });
    // Before and after are sets: the page states no order for the list.
    assert.deepEqual(push.data.creative_impact.changes.end_card_list, {
      before: ['8801', '8802'],
      after: ['8801', '8803'],
    });
    assert.equal((await f.execute(push.data.review_id)).success, true);
    assert.equal(f.ads[5141].ad_name, 'Renamed');
    assert.equal((await f.verify(push.data.review_id)).data.status, 'verified');
    // An enabled ad: its end cards change while it serves, which TikTok re-reviews; nothing of its creatives is removed.
    const live = await edited(f, {smart_plus_ad_id: '5142', end_card_list: endCards('8804')});
    assert.equal(live.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(live.data.review_id)).success, true);
    assert.equal((await f.verify(live.data.review_id)).data.status, 'verified');
  }));

test('an ad that holds no end card is not given one by an edit: TikTok’s page says the field only updates existing end cards, and nothing is sent', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    for (const [name, payload] of Object.entries({
      'an ad of posts': {smart_plus_ad_id: '5100', end_card_list: endCards('8801')},
      'an ad of uploads': {smart_plus_ad_id: '5110', end_card_list: endCards('8801')},
      'with a rename that would otherwise be sent': {
        smart_plus_ad_id: '5100',
        ad_name: 'New',
        end_card_list: endCards('8801'),
      },
    })) {
      const r = await edit(f, payload);
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, 'end_card_list', name);
      assert.match(r.error.message, /can only update the end cards an ad already holds/, name);
    }
    assert.equal(f.writes.length, 0);
  }));

test('the shape of end_card_list is judged for an edit as for a create, before any request', async () =>
  withFixture(async f => {
    const eleven = Array.from({length: 11}, (_, i) => String(8801 + i));
    const cases = {
      'an empty list': [{end_card_list: []}, 'end_card_list'],
      'eleven end cards': [{end_card_list: endCards(...eleven)}, 'end_card_list'],
      'an end card with no ID': [{end_card_list: [{}]}, 'end_card_list[0].end_card_id'],
      'an ID that is no number': [{end_card_list: endCards('card')}, 'end_card_list[0].end_card_id'],
      'another key': [{end_card_list: [{end_card_id: '8801', x: 1}]}, 'end_card_list[0]'],
      'the same end card twice': [{end_card_list: endCards('8801', '8801')}, 'end_card_list[1].end_card_id'],
      'interactive add-ons, which cannot go beside end cards': [
        {end_card_list: endCards('8801'), interactive_add_on_list: [{card_id: '8890'}]},
        'interactive_add_on_list',
      ],
    };
    for (const [name, [extra, field]] of Object.entries(cases)) {
      const r = await edit(f, {smart_plus_ad_id: '5140', ...extra});
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, field, name + ': ' + r.error.message);
    }
    assert.equal(f.requests.length, 0);
  }));

test('an edit’s end cards are the advertiser’s and are end cards: one the list does not return, one of another type, one gone by execute', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    const stray = await edit(f, {smart_plus_ad_id: '5140', end_card_list: endCards('8899')});
    assertRefused(stray, 'STATE_TARGET_MISMATCH', {writes: () => f.writes.length});
    assert.deepEqual(stray.error.details.end_card_ids, ['8899']);
    const card = await edit(f, {smart_plus_ad_id: '5140', end_card_list: endCards('8890')});
    assertRefused(card, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(card.error.details.field, 'end_card_list[0].end_card_id');
    const p = await edited(f, {smart_plus_ad_id: '5140', end_card_list: endCards('8802')});
    delete f.endCardRows['8802'];
    assertRefused(await f.execute(p.data.review_id), 'STATE_TARGET_MISMATCH', {writes: () => f.writes.length});
  }));

test('an edit that does not name end cards neither reads nor sends them, whatever else it changes', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    // A rename: the end cards are a list of their own, and TikTok's update is incremental, so the ad keeps them.
    const rename = await edited(f, {smart_plus_ad_id: '5140', ad_name: 'Renamed only'});
    assert.equal(rename.data.creative_impact.end_cards, undefined);
    assert.equal((await f.execute(rename.data.review_id)).success, true);
    assert.equal(listReads(f).length, 0);
    assert.deepEqual(f.writes, [{advertiser_id: '123', smart_plus_ad_id: '5140', ad_name: 'Renamed only'}]);
    assert.deepEqual(f.ads[5140].end_card_list, endCards('8801'));
    assert.equal((await f.verify(rename.data.review_id)).data.status, 'verified');
  }));

test('an ad under a custom identity is still only renamed: end cards on it are no content edit this contract takes', async () =>
  withFixture(async f => {
    const r = await edit(f, {smart_plus_ad_id: '5120', end_card_list: endCards('8801')});
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.match(r.error.message, /only its name can be edited/);
  }));

test('an advertiser that is not on the allowlist is refused by TikTok on an edit too: nothing changes, the review is retired, and the answer names end cards', async () =>
  withFixture(async f => {
    const p = await edited(f, {smart_plus_ad_id: '5140', end_card_list: endCards('8802')});
    const x = await f.execute(p.data.review_id);
    assertRefused(x, 'PROVIDER_ACCESS_DENIED');
    assert.equal(x.error.details.provider_code, 40118);
    assert.match(x.error.details.allowlist, /end cards are allowlist-only/);
    assert.doesNotMatch(x.error.details.allowlist, /ad_material_id/);
    assert.deepEqual(f.ads[5140].end_card_list, endCards('8801'));
    assert.equal((await f.execute(p.data.review_id)).error?.code, 'WRITE_REJECTED');
    // An edit that only keeps a creative by its ad_material_id names that feature and none of end cards.
    const kept = await edited(f, {smart_plus_ad_id: '5141', creative_list: [{ad_material_id: 'm0'}]});
    const keptRefusal = await f.execute(kept.data.review_id);
    assertRefused(keptRefusal, 'PROVIDER_ACCESS_DENIED');
    assert.match(
      keptRefusal.error.details.allowlist,
      /keeps a creative by its ad_material_id, that feature is allowlist-only/,
    );
    assert.doesNotMatch(keptRefusal.error.details.allowlist, /end_card_list/);
    // An edit that keeps a creative by its ad_material_id and replaces end cards uses two allowlist-only features: the answer names both.
    f.behaviour.allowlisted = true;
    const both = await edited(f, {
      smart_plus_ad_id: '5141',
      creative_list: [{ad_material_id: 'm0'}],
      end_card_list: endCards('8803'),
    });
    assert.match(both.data.creative_impact.allowlist, /ad_material_id/);
    assert.match(both.data.creative_impact.end_cards.allowlist, /End cards are an allowlist-only feature/);
    const refused = await f.execute(both.data.review_id);
    assertRefused(refused, 'PROVIDER_ACCESS_DENIED');
    assert.match(refused.error.details.allowlist, /ad_material_id or uses end_card_list/);
  }));

test('the read-back of an edit compares the end cards: an ad TikTok kept as it was is not a verified edit', async () =>
  withFixture(async f => {
    f.behaviour.endCardsAllowlisted = true;
    f.behaviour.dropEndCards = true;
    const p = await edited(f, {smart_plus_ad_id: '5140', end_card_list: endCards('8802')});
    assert.equal((await f.execute(p.data.review_id)).success, true);
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v.data));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/end_card_list']);
  }));

// ---------------------------------------------------------------------------------------------------------------------------
// The dated requirement: "Starting February 22, 2027, if you are an allowlisted advertiser, end cards are required for eligible ad
// scenarios." A registry entry gives the alarm and the date; the review says what the page says, and AMCP never refuses on its own:
// no read tells whether an advertiser is allowlisted, and the page defines no eligible scenario beyond the one its guide documents: a
// custom identity on Pangle placements. A Spark Ad, which is all this contract creates, is outside it (S3-1 of the lead's review): a note
// that told an agent to add end cards there would send it to TikTok's 40118, so only the scenario itself carries the note.
// ---------------------------------------------------------------------------------------------------------------------------
const day = text => Date.parse(text + 'T00:00:00Z');
const entryId = 'tiktok_smart_plus_end_cards';

test('the requirement is a dated entry of the provider deprecations: cited to the page, an alarm 90 days ahead, in effect from its day', () => {
  assertDeprecationRegistry();
  const entry = providerDeprecation(entryId);
  assert.equal(entry.provider, 'tiktok');
  assert.equal(entry.scope, 'field');
  assert.equal(entry.effective_date, '2027-02-22');
  assert.equal(
    entry.source_url,
    'https://business-api.tiktok.com/portal/docs/use-end-cards-in-tiktok-ad-network-ads/v1.3',
  );
  assert.match(entry.target, /end_card_list/);
  assert.match(entry.enforcement, /src\/tiktok-smart-plus-end-cards\.ts/);
  // What the entry tells the lead is what the code does: the note is for the scenario the guide documents (a custom identity), which this
  // contract does not create yet, and a Spark Ad with end cards has a caveat instead.
  assert.match(entry.enforcement, /custom identity/);
  assert.match(entry.note, /custom identity/);
  // The sentence of the page, word for word, is in the entry's note.
  assert.match(
    entry.note,
    /Starting February 22, 2027, if you are an allowlisted advertiser, end cards are required for eligible ad scenarios\./,
  );
  const at = text => Object.fromEntries(deprecationStatus(day(text)).map(d => [d.id, d]))[entryId];
  assert.deepEqual([at('2026-11-23').days_until_effective, at('2026-11-23').alarm], [91, false]);
  assert.deepEqual([at('2026-11-24').days_until_effective, at('2026-11-24').alarm], [90, true]);
  assert.deepEqual([at('2027-02-22').effective, at('2027-02-22').alarm], [true, false]);
});

// The scenario of the page as a group row and an identity type: a website ad group on Pangle placements, an ad under a custom identity.
const pangle = {promotion_type: 'WEBSITE', placement_type: 'PLACEMENT_TYPE_NORMAL', placements: ['PLACEMENT_PANGLE']};

test('the scenario TikTok documents end cards for is a custom identity on a website ad group of Pangle placements, and each condition is needed', () => {
  const {endCardScenario} = endCardModule;
  assert.equal(endCardScenario(pangle, 'CUSTOMIZED_USER'), true);
  // Pangle beside the Global App Bundle is still Pangle placements.
  assert.equal(
    endCardScenario({...pangle, placements: ['PLACEMENT_PANGLE', 'PLACEMENT_GLOBAL_APP_BUNDLE']}, 'CUSTOMIZED_USER'),
    true,
  );
  const cases = {
    'a TikTok account identity (a Spark Ad)': [pangle, 'TT_USER'],
    'a Business Center identity (a Spark Ad)': [pangle, 'BC_AUTH_TT'],
    'a creator’s authorization code (a Spark Ad)': [pangle, 'AUTH_CODE'],
    'an identity that is not stated': [pangle, undefined],
    'TikTok placement alone': [{...pangle, placements: ['PLACEMENT_TIKTOK']}, 'CUSTOMIZED_USER'],
    'a TikTok account identity on TikTok and Pangle placements': [
      {...pangle, placements: ['PLACEMENT_TIKTOK', 'PLACEMENT_PANGLE']},
      'TT_USER',
    ],
    'automatic placement': [{promotion_type: 'WEBSITE', placement_type: 'PLACEMENT_TYPE_AUTOMATIC'}, 'CUSTOMIZED_USER'],
    'automatic placement that lists Pangle among its placements': [
      {promotion_type: 'WEBSITE', placement_type: 'PLACEMENT_TYPE_AUTOMATIC', placements: ['PLACEMENT_PANGLE']},
      'CUSTOMIZED_USER',
    ],
    'no placements listed': [{promotion_type: 'WEBSITE', placement_type: 'PLACEMENT_TYPE_NORMAL'}, 'CUSTOMIZED_USER'],
    'an Instant Form ad group': [{...pangle, promotion_type: 'LEAD_GENERATION'}, 'CUSTOMIZED_USER'],
    'an ad group that was not read': [undefined, 'CUSTOMIZED_USER'],
  };
  for (const [name, [group, identity]] of Object.entries(cases))
    assert.equal(endCardScenario(group, identity), false, name);
});

test('the requirement note is for that scenario only and from its day only: before the day none, from the day one for a custom identity on Pangle, and never one for a Spark Ad', t => {
  restoreClockAfter(t);
  const {endCardRequirement, tiktokEndCardRequirementNote} = endCardModule;
  setDeprecationClock(() => Date.parse('2027-02-21T23:59:59Z'));
  assert.deepEqual(endCardRequirement(pangle, 'CUSTOMIZED_USER'), {}, 'the day before');
  setDeprecationClock(() => day('2027-02-22'));
  const note = endCardRequirement(pangle, 'CUSTOMIZED_USER').end_card_requirement;
  assert.equal(note, tiktokEndCardRequirementNote);
  assert.match(note, /From 2027-02-22 TikTok requires end cards/);
  assert.match(note, /if TikTok has allowlisted this advertiser/);
  assert.match(note, /custom identity/);
  assert.ok(note.includes(providerDeprecation(entryId).effective_date), 'the note carries the entry’s day');
  // From the day, a Spark Ad has none whatever its ad group, and neither has a custom identity outside Pangle placements.
  setDeprecationClock(() => day('2027-03-01'));
  for (const [name, group, identity] of [
    [
      'a post of a TikTok account on automatic placement',
      {promotion_type: 'WEBSITE', placement_type: 'PLACEMENT_TYPE_AUTOMATIC'},
      'TT_USER',
    ],
    [
      'a post of a Business Center on TikTok and Pangle',
      {...pangle, placements: ['PLACEMENT_TIKTOK', 'PLACEMENT_PANGLE']},
      'BC_AUTH_TT',
    ],
    ['a creator’s post on Pangle alone', pangle, 'AUTH_CODE'],
    ['a custom identity on TikTok placement alone', {...pangle, placements: ['PLACEMENT_TIKTOK']}, 'CUSTOMIZED_USER'],
  ])
    assert.deepEqual(endCardRequirement(group, identity), {}, name);
  // The review of a request without end cards has the note for the scenario, and nothing for anything else.
  assert.deepEqual(endCardModule.endCardImpact(undefined, pangle, 'CUSTOMIZED_USER'), {end_card_requirement: note});
  assert.deepEqual(endCardModule.endCardImpact(undefined, pangle, 'TT_USER'), {});
});

test('a request with end cards says what TikTok documents: nothing more in the scenario, and a caveat for anything else, and it is never a refusal', t => {
  restoreClockAfter(t);
  setDeprecationClock(() => day('2027-03-01'));
  const {endCardImpact, tiktokEndCardAllowlistNotice, tiktokEndCardScenarioNote, tiktokEndCardPlacementNote} =
    endCardModule;
  const inScenario = endCardImpact(endCards('8801'), pangle, 'CUSTOMIZED_USER').end_cards;
  assert.deepEqual(inScenario, {count: 1, end_card_ids: ['8801'], allowlist: tiktokEndCardAllowlistNotice});
  const spark = endCardImpact(endCards('8801'), {...pangle, placements: ['PLACEMENT_TIKTOK']}, 'TT_USER').end_cards;
  assert.deepEqual(spark, {
    count: 1,
    end_card_ids: ['8801'],
    allowlist: tiktokEndCardAllowlistNotice,
    scenario_note: tiktokEndCardScenarioNote,
    placement_note: tiktokEndCardPlacementNote,
  });
  // An edit has no ad group and no identity at hand, and every ad it edits is a Spark Ad: it gets the caveat and no placement note.
  const edit = endCardImpact(endCards('8801')).end_cards;
  assert.equal(edit.scenario_note, tiktokEndCardScenarioNote);
  assert.equal(edit.placement_note, undefined);
});

test('the create’s review gives the identity of its creatives to the end card sentences: an ad of the documented scenario, which no create of this contract is yet, would carry the note and no caveat', t => {
  restoreClockAfter(t);
  setDeprecationClock(() => day('2027-03-01'));
  const group = {...pangle, adgroup_id: '300', operation_status: 'DISABLE'};
  // The review of a plan that the contract itself refuses (a custom identity): the impact is judged on the plan and the ad group row it is given.
  const impactOf = (identity, extra = {}) =>
    tiktokSmartPlusAdImpact(
      {
        gateway: 'tiktok_native_action',
        method: 'POST',
        path: '/v1.3/smart_plus/ad/create/',
        accountId: '123',
        body: ad([post('9001', 'SINGLE_VIDEO', {identity_type: identity})], extra),
      },
      [{data: {list: [group]}}],
    );
  assert.equal(impactOf('CUSTOMIZED_USER').end_card_requirement, endCardModule.tiktokEndCardRequirementNote);
  assert.deepEqual(impactOf('CUSTOMIZED_USER', {end_card_list: endCards('8801')}).end_cards, {
    count: 1,
    end_card_ids: ['8801'],
    allowlist: endCardModule.tiktokEndCardAllowlistNotice,
  });
  // The same ad under a TikTok account identity, a Spark Ad: no note, and the caveat when it names end cards.
  assert.equal(impactOf('TT_USER').end_card_requirement, undefined);
  assert.equal(
    impactOf('TT_USER', {end_card_list: endCards('8801')}).end_cards.scenario_note,
    endCardModule.tiktokEndCardScenarioNote,
  );
});

test('from the day a Spark Ad create without end cards still carries no requirement note, in any ad group: a note would send an agent to end cards that TikTok refuses with 40118', async t =>
  withFixture(async f => {
    restoreClockAfter(t);
    setDeprecationClock(() => day('2027-03-01'));
    // 300 has automatic placements (TikTok, the Global App Bundle and Pangle), 303 TikTok alone and 304 TikTok and Pangle: a post of a TikTok
    // account is in none of their scenarios, and the ad group's placement alone made the first version of the note fire for 300 and 304.
    for (const adgroup of ['300', '303', '304']) {
      const p = await f.prepared(ad([post('9001')], {adgroup_id: adgroup}));
      assert.equal(p.data.creative_impact.end_card_requirement, undefined, adgroup);
      assert.equal(p.data.creative_impact.end_cards, undefined, adgroup);
    }
    // An Instant Form lead group, and an edit, carry none either.
    const lead = ad(
      [post('9001')],
      {adgroup_id: '301', page_list: [{page_id: '7700149'}], landing_page_url_list: undefined},
      {utm_params: undefined},
    );
    assert.equal((await f.prepared(lead)).data.creative_impact.end_card_requirement, undefined);
    const rename = await f.prepared({smart_plus_ad_id: '5100', ad_name: 'Renamed'}, 'tiktok_smart_plus_ad_update');
    assert.equal(rename.data.creative_impact.end_card_requirement, undefined);
    // Nothing is refused: the ad is created and verified, and TikTok decides.
    const p = await f.prepared(ad([post('9001')]));
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  }));

test('TikTok’s own refusal after the day is definitive: recorded as rejected, nothing created, the review never sent again, and with an end card the same ad is created', async t =>
  withFixture(async f => {
    restoreClockAfter(t);
    setDeprecationClock(() => day('2027-02-22'));
    f.behaviour.requireEndCards = true;
    const p = await f.prepared(ad([post('9001')]));
    assert.equal(
      p.data.creative_impact.end_card_requirement,
      undefined,
      'AMCP says nothing here: a Spark Ad is outside the scenario',
    );
    const x = await f.execute(p.data.review_id);
    assertRefused(x, 'PLATFORM_ERROR');
    assert.equal(x.error.details.provider_code, 40002);
    assert.equal(f.writes.length, 1);
    assert.equal(Object.keys(f.ads).filter(id => f.ads[id].ad_name === 'Push sale').length, 0, 'nothing was created');
    assert.equal((await f.execute(p.data.review_id)).error?.code, 'WRITE_REJECTED');
    // With an end card, for an advertiser on the allowlist, the same ad is created and verified.
    f.behaviour.endCardsAllowlisted = true;
    const again = await f.prepared(ad([post('9001')], {end_card_list: endCards('8801')}));
    assert.equal((await f.execute(again.data.review_id)).success, true);
    assert.equal((await f.verify(again.data.review_id)).data.status, 'verified');
  }));
