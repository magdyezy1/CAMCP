import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {redact} from '../dist/src/security.js';
import {withoutSecrets} from '../dist/src/write-review.js';
import {fingerprint} from '../dist/src/workspace-core.js';
import {pushFixture, gateway, TIKTOK, account, owner, codes, ad, post} from './fixtures/tiktok-smart-plus-push.mjs';

/**
 * Spark Ads from an authorized creator's post (package r25-m4b-smartpush, matrix A2): the creator generates an authorization code in
 * the TikTok app (outside the API), and "Apply an authorization code" (POST /v1.3/tt_video/authorize/, read 2026-11-21) binds the post
 * to the ad account; its answer has an empty `data`, so the post is read back from "Get Spark Ad posts" (GET /v1.3/tt_video/list/), whose
 * rows carry every authorized post's code. "Unbind a Spark Ad post" (POST /v1.3/tt_video/unbind/) removes a post whose authorization
 * has expired or been revoked. The code is secret-like: a review keeps only its SHA-256 digest, execute takes the code again, and the
 * code is in no stored row, no audit row and no answer. The synthetic advertiser is tests/fixtures/tiktok-smart-plus-push.mjs.
 */
const authorize = 'tiktok_tt_video_authorize_apply',
  unbind = 'tiktok_tt_video_unbind';
async function withFixture(body) {
  const f = pushFixture();
  try {
    return await body(f);
  } finally {
    f.store.close();
  }
}
const apply = (f, payload, extra) => f.prepare(payload, authorize, extra);
const applied = (f, payload, extra) => f.prepared(payload, authorize, extra);
/** The call that executes a review of an authorization: the review, and the same payload again (the review kept only a digest). */
const again = (f, payload) => ({arguments: f.args(payload, authorize)});
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
/** The page's spelling of a code: "Replace '+' in your authorization code with '%2B'." */
const wire = code => code.replaceAll('+', '%2B');
/** Every row of every table of the store, as text: what is kept (BLOB columns as their bytes), to search for a value. */
function everything(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map(t => t.name);
  return tables
    .map(
      t =>
        t +
        ': ' +
        JSON.stringify(store.db.prepare('SELECT * FROM "' + t + '"').all(), (_, v) =>
          v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v,
        ),
    )
    .join('\n');
}
const paths = p => p.data.state_reads.map(r => r.path);
const listReads = f => f.queries.filter(q => q.path === '/v1.3/tt_video/list/');

test('an authorization code is applied: the review reads the list, execute takes the code again, TikTok gets it once, and the post is read back', async () =>
  withFixture(async f => {
    const payload = {auth_code: codes.fresh};
    const p = await applied(f, payload);
    assert.deepEqual(paths(p), ['/v1.3/tt_video/list/']);
    assert.equal(p.data.creative_impact.scope, 'spark_ads_authorization');
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.match(p.data.creative_impact.effect, /authorization code/);
    assert.ok(!p.data.execute_requirements.spend_change_confirmed, 'no spending to confirm');
    const x = await f.execute(p.data.review_id, again(f, payload));
    assert.equal(x.success, true, JSON.stringify(x.error ?? x).slice(0, 500));
    // TikTok got the code once, as its page spells it ("+" as "%2B"), and nothing else of the review.
    assert.deepEqual(f.writes, [{advertiser_id: account, auth_code: wire(codes.fresh)}]);
    assert.equal(f.authorized.at(-1).item_id, '9511');
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
    // The read-back names the post and the identity an ad needs, and not the code.
    const actual = JSON.stringify(v.data.checks);
    assert.match(actual, /9511/);
    assert.match(actual, /ac-2/);
    assert.match(actual, /AUTHORIZED/);
  }));

test('the authorized post is used by a Spark Ad: the identity is the creator’s authorization-code identity, and the post reads AUTHORIZED', async () =>
  withFixture(async f => {
    const payload = {auth_code: codes.fresh};
    const p = await applied(f, payload);
    assert.equal((await f.execute(p.data.review_id, again(f, payload))).success, true);
    const creative = post('9511', 'SINGLE_VIDEO', {identity_type: 'AUTH_CODE', identity_id: 'ac-2'});
    const made = await f.prepare(ad([creative]), 'tiktok_smart_plus_ad_create');
    assert.equal(made.success, true, JSON.stringify(made.error ?? made.data).slice(0, 500));
    assert.equal((await f.execute(made.data.review_id)).success, true);
    assert.equal(f.writes.at(-1).creative_list[0].creative_info.identity_type, 'AUTH_CODE');
  }));

test('the code is in no stored row, no audit row and no answer: only its digest is kept, and nothing shows the digest', async () =>
  withFixture(async f => {
    const payload = {auth_code: codes.fresh, original_post_auth_code: codes.original};
    const seen = [];
    const inspected = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: f.args(payload, authorize),
    });
    seen.push(inspected);
    // Inspect shows the request as prepare will freeze it: the body has no code, not even a hidden one.
    assert.deepEqual(inspected.data.request.body, {advertiser_id: account});
    const p = await applied(f, payload);
    seen.push(p);
    const x = await f.execute(p.data.review_id, again(f, payload));
    seen.push(x);
    assert.equal(x.success, true, JSON.stringify(x.error ?? x).slice(0, 500));
    seen.push(await f.verify(p.data.review_id));
    seen.push(await f.execute(p.data.review_id));
    seen.push(await f.call('amcp_campaign', {action: 'status', review_id: p.data.review_id}));
    // The review is kept with the digests and with no value.
    const review = f.store.document('tiktok-smart-plus-push', 'write_review', p.data.review_id);
    assert.deepEqual(review.plan.heldSecrets, {
      auth_code: sha256(codes.fresh),
      original_post_auth_code: sha256(codes.original),
    });
    assert.deepEqual(review.plan.body, {advertiser_id: account});
    assert.deepEqual(review.prepare_input.arguments.payload, {});
    const stored = everything(f.store);
    for (const secret of [codes.fresh, wire(codes.fresh), codes.original, wire(codes.original)]) {
      assert.ok(!stored.includes(secret), 'a stored row holds the code');
      assert.ok(!stored.includes(JSON.stringify(secret).slice(1, -1)), 'a stored row holds the code, escaped');
      assert.ok(!JSON.stringify(seen).includes(secret), 'an answer holds the code');
    }
    // The audit trail of the review was written, and it says what happened without the code.
    const audit = f.store.db.prepare('SELECT * FROM audit').all();
    assert.ok(audit.length > 0);
    // The digests are the review's: no answer shows them, or the field that holds them.
    for (const digest of Object.values(review.plan.heldSecrets))
      assert.ok(!JSON.stringify(seen).includes(digest), 'an answer shows a digest');
    assert.ok(!JSON.stringify(seen).includes('heldSecrets'), 'an answer names the field that holds the digests');
    assert.deepEqual(p.data.request.body, {advertiser_id: account});
  }));

test('the code is a secret name: it is hidden wherever a value is redacted, in a body, a query or a JSON text', () => {
  for (const name of ['auth_code', 'original_post_auth_code'])
    assert.deepEqual(redact({[name]: codes.fresh, other: 'kept'}), {[name]: '[REDACTED]', other: 'kept'}, name);
  assert.deepEqual(redact({item_info: {auth_code: codes.bound, item_id: '9501'}}), {
    item_info: {auth_code: '[REDACTED]', item_id: '9501'},
  });
  assert.ok(
    !String(redact('GET /v1.3/tt_video/info/?advertiser_id=123&auth_code=' + codes.fresh)).includes(codes.fresh),
  );
  assert.ok(!String(redact('{"auth_code":"' + codes.fresh + '"}')).includes(codes.fresh));
});

test('execute refuses a review that holds a code when it is not sent again, or when it is another code, before anything is claimed or sent', async () =>
  withFixture(async f => {
    const payload = {auth_code: codes.fresh};
    const p = await applied(f, payload);
    const none = await f.execute(p.data.review_id);
    assertRefused(none, 'INVALID_ARGUMENT', {writes: () => f.writes.length});
    assert.equal(none.error.details.field, 'arguments');
    assert.match(none.error.message, /Send auth_code again/);
    const other = await f.execute(p.data.review_id, again(f, {auth_code: codes.second}));
    assertRefused(other, 'REVIEW_CHANGED', {writes: () => f.writes.length});
    assert.match(other.error.message, /not the reviewed one/);
    assert.ok(!JSON.stringify(other).includes(codes.second));
    // A field the review did not hold is not sent either.
    const extra = await f.execute(
      p.data.review_id,
      again(f, {auth_code: codes.fresh, original_post_auth_code: codes.original}),
    );
    assertRefused(extra, 'REVIEW_CHANGED', {writes: () => f.writes.length});
    assert.match(extra.error.message, /did not hold original_post_auth_code/);
    // The review is still valid: the right code sends it, once, and a second execute replays what was recorded without the code.
    assert.equal((await f.execute(p.data.review_id, again(f, payload))).success, true);
    const replay = await f.execute(p.data.review_id);
    assert.equal(replay.data.replayed, true);
    assert.equal(f.writes.length, 1);
  }));

test('execute takes the code alone, or the arguments that prepared the review, and refuses any other arguments before anything is claimed or sent', async () =>
  withFixture(async f => {
    const payload = {auth_code: codes.fresh};
    const p = await applied(f, payload);
    const refused = {
      // Probe P3 of the lead's review: another action, another advertiser and a parameter, with the right code, were ignored and the reviewed
      // request was sent. A caller that changed its arguments is told that they are not the review's, as for a gateway or a connection.
      'another action, advertiser and parameters': {
        action: unbind,
        account_id: '999',
        payload: {auth_code: codes.fresh, item_id: '1'},
        params: {x: 1},
      },
      'another advertiser beside the reviewed arguments': {...f.args(payload, authorize), account_id: '999'},
      'a field of the payload that the review did not keep': {
        ...f.args({auth_code: codes.fresh, note: 'x'}, authorize),
      },
      'a parameter that the review did not keep': {...f.args(payload, authorize), params: {x: 1}},
      'the code alone with another field of the payload': {payload: {auth_code: codes.fresh, item_id: '1'}},
      'the code alone with the action': {action: authorize, payload},
      'nothing but a parameter': {params: {auth_code: codes.fresh}},
    };
    for (const [name, args] of Object.entries(refused)) {
      const r = await f.execute(p.data.review_id, {arguments: args});
      assertRefused(r, name === 'nothing but a parameter' ? 'INVALID_ARGUMENT' : 'REVIEW_CHANGED', {
        writes: () => f.writes.length,
      });
      assert.equal(r.error.details.field, 'arguments', name);
      assert.ok(!JSON.stringify(r).includes(codes.fresh), name);
    }
    // The review is untouched by those: no claim was made, and the code alone sends it.
    assert.equal(f.writes.length, 0);
    const alone = await f.execute(p.data.review_id, {arguments: {payload}});
    assert.equal(alone.success, true, JSON.stringify(alone.error ?? alone).slice(0, 400));
    assert.deepEqual(f.writes, [{advertiser_id: account, auth_code: wire(codes.fresh)}]);
    // The arguments that prepared the review are the other shape: a second review, sent with them.
    const q = await applied(f, {auth_code: codes.second});
    const full = await f.execute(q.data.review_id, again(f, {auth_code: codes.second}));
    assert.equal(full.success, true, JSON.stringify(full.error ?? full).slice(0, 400));
    assert.equal(f.writes.length, 2);
  }));

test('only a review that holds a value takes arguments at execute: any other review still refuses them', async () =>
  withFixture(async f => {
    const made = await f.prepared(ad([post('9001')]), 'tiktok_smart_plus_ad_create');
    const r = await f.execute(made.data.review_id, {arguments: f.args({anything: 1})});
    assertRefused(r, 'INVALID_ARGUMENT', {writes: () => f.writes.length});
    assert.match(r.error.message, /^Remove arguments/);
    // A review that is not there is refused as it always was.
    const missing = await f.execute('00000000-0000-4000-8000-000000000000', {arguments: f.args({anything: 1})});
    assert.equal(missing.success, false);
    assert.match(missing.error.message, /^Remove arguments/);
  }));

test('a code already applied to the advertiser is refused at review, by the digest of the code the list shows', async () =>
  withFixture(async f => {
    // The world's list shows post 9501 with its code: the review finds this code there.
    const r = await apply(f, {auth_code: codes.bound});
    assertRefused(r, 'INVALID_TIKTOK_TT_VIDEO_AUTHORIZATION', {writes: () => f.writes.length});
    assert.match(r.error.message, /already applied/);
    assert.match(r.error.message, /9501/);
    assert.ok(!JSON.stringify(r).includes(codes.bound));
    const expired = await apply(f, {auth_code: codes.expired});
    assert.match(expired.error.message, /EXPIRED/);
  }));

test('the code is found among the advertiser’s authorized posts page by page, 50 at a time, and an advertiser with more than AMCP reads is refused as incomplete', async () =>
  withFixture(async f => {
    for (let i = 0; i < 120; i++)
      f.authorized.push({
        item_id: String(8000 + i),
        item_type: 'VIDEO',
        identity_id: 'ac-9',
        code: '#bulk-' + i,
        status: 'AUTHORIZED',
        text: 'x',
      });
    const payload = {auth_code: codes.fresh};
    const p = await applied(f, payload);
    // 122 posts are 3 pages, and the code is on none of them.
    assert.deepEqual(
      listReads(f).map(q => ['page', 'page_size'].map(k => new URLSearchParams(q.search).get(k)).join('/')),
      ['1/50', '2/50', '3/50'],
    );
    assert.equal((await f.execute(p.data.review_id, again(f, payload))).success, true);
    // The new post is the last of 123: the read-back finds it on the third page.
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
  }));

/** A post of another creator, for a list of a given length. */
const bulk = i => ({
  item_id: String(8000 + i),
  item_type: 'VIDEO',
  identity_id: 'ac-9',
  code: '#bulk-' + i,
  status: 'AUTHORIZED',
  text: 'x',
});
test('the list is read up to 20 pages of 50: 1,000 posts are read, and 1,001 are more than AMCP reads, so it cannot show that the code is not there', async () => {
  await withFixture(async f => {
    for (let i = 0; i < 998; i++) f.authorized.push(bulk(i));
    assert.equal(f.authorized.length, 1000);
    const p = await applied(f, {auth_code: codes.fresh});
    assert.equal(listReads(f).length, 20);
    assert.equal(p.success, true);
  });
  await withFixture(async f => {
    for (let i = 0; i < 999; i++) f.authorized.push(bulk(i));
    assert.equal(f.authorized.length, 1001);
    const big = await apply(f, {auth_code: codes.fresh});
    assertRefused(big, 'INCOMPLETE_STATE', {writes: () => f.writes.length});
    assert.equal(listReads(f).length, 20);
  });
});

test('a list that answers another page than the one asked for is not read as every page, for the authorized posts and for the ads alike', async () =>
  withFixture(async f => {
    for (let i = 0; i < 120; i++) f.authorized.push(bulk(i));
    // TikTok answers page 1 again whatever page is asked: its rows would be taken for every page.
    f.behaviour.stuckPage = true;
    const r = await apply(f, {auth_code: codes.fresh});
    assertRefused(r, 'INCOMPLETE_STATE', {writes: () => f.writes.length});
    assert.match(r.error.message, /another page/);
    // A post on a later page is the one that needs the page after the first.
    const u = await unbinding(f, '8119');
    assertRefused(u, 'INCOMPLETE_STATE', {writes: () => f.writes.length});
    assert.match(u.error.message, /another page/);
  }));

test('a code TikTok refuses is rejected with nothing applied, the review is never sent again, and TikTok’s answer, which echoes the code, shows none of it', async () =>
  withFixture(async f => {
    // The code has a "+", so the spelling TikTok is sent and the spelling it echoes as read differ.
    const payload = {auth_code: '#ZmFrZS1hdXRoLWNvZGUtdW5r+bm93bg=='};
    const p = await applied(f, payload);
    const x = await f.execute(p.data.review_id, again(f, payload));
    assert.equal(x.success, false);
    assert.equal(x.error.details.provider_code, 40002);
    assert.equal(f.authorized.length, 2);
    const wrong = await f.execute(p.data.review_id, again(f, payload));
    assertRefused(wrong, 'WRITE_REJECTED');
    assert.equal(f.writes.length, 1);
    // The fake TikTok echoed the code in its message: neither the answers nor any stored row has it.
    for (const secret of [payload.auth_code, wire(payload.auth_code)]) {
      assert.ok(!JSON.stringify([x, wrong]).includes(secret), 'an answer shows the code');
      assert.ok(!everything(f.store).includes(secret), 'a stored row holds the code');
    }
    assert.match(JSON.stringify(x), /\[secret\]/);
  }));

test('an answer that echoes the code, even a successful one, is scrubbed of it before it is kept or returned', async () =>
  withFixture(async f => {
    f.behaviour.echoCode = true;
    const payload = {auth_code: codes.fresh};
    const p = await applied(f, payload);
    const x = await f.execute(p.data.review_id, again(f, payload));
    assert.equal(x.success, true, JSON.stringify(x.error ?? x).slice(0, 400));
    for (const secret of [codes.fresh, wire(codes.fresh)]) {
      assert.ok(!JSON.stringify(x).includes(secret), 'the answer shows the code');
      assert.ok(!everything(f.store).includes(secret), 'a stored row holds the code');
    }
    // The echo is there, as the replacement, in what was kept.
    assert.match(JSON.stringify(x), /\[secret\]/);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  }));

test('a code given with "%2B", as TikTok’s page spells it, that TikTok refuses while it echoes the code decoded to "+", is in no answer and no stored row, in either spelling', async () =>
  withFixture(async f => {
    // The page asks for "%2B" in place of "+", and a person who follows it gives the code that way. TikTok reads the "%2B" as the "+" it stands
    // for, so its refusal echoes the code as it was sent and as it read it: two spellings, of which the review was given only the first.
    const decoded = '#ZmFrZS1hdXRoLWNvZGUtdW5r+bm93bg==',
      given = wire(decoded);
    assert.notEqual(given, decoded);
    const payload = {auth_code: given};
    const p = await applied(f, payload);
    const x = await f.execute(p.data.review_id, again(f, payload));
    assert.equal(x.success, false);
    assert.equal(x.error.details.provider_code, 40002);
    assert.deepEqual(
      f.writes,
      [{advertiser_id: account, auth_code: given}],
      'TikTok was sent the code as it was given',
    );
    const replay = await f.execute(p.data.review_id, again(f, payload));
    assertRefused(replay, 'WRITE_REJECTED');
    const stored = everything(f.store);
    for (const secret of [given, decoded]) {
      assert.ok(!JSON.stringify([x, replay]).includes(secret), 'an answer shows the code spelled ' + secret);
      assert.ok(!stored.includes(secret), 'a stored row holds the code spelled ' + secret);
    }
    assert.match(JSON.stringify(x), /\[secret\]/);
  }));

test('the spellings of a secret-like value are one rule: as given, with "+" as "%2B", with "%2B" or "%2b" as "+", and percent-decoded; a text that is no percent-encoding is read as it is', async () => {
  const {secretSpellings} = await import('../dist/src/secret-fields.js');
  assert.equal(typeof secretSpellings, 'function');
  const spellings = value => [...secretSpellings(value)].sort();
  assert.deepEqual(spellings('#ab+cd'), ['#ab%2Bcd', '#ab+cd']);
  assert.deepEqual(spellings('#ab%2Bcd'), ['#ab%2Bcd', '#ab+cd']);
  assert.deepEqual(spellings('#ab%2bcd'), ['#ab%2Bcd', '#ab%2bcd', '#ab+cd']);
  assert.deepEqual(spellings('#ab%2Fcd'), ['#ab%2Fcd', '#ab/cd']);
  assert.deepEqual(spellings('#abcd'), ['#abcd']);
  // A "%" that starts no percent-encoding is part of the value: nothing throws, and the value is its own spelling.
  assert.deepEqual(spellings('#a%zzb'), ['#a%zzb']);
  // A value with a malformed percent-encoding elsewhere is not decoded, but its "%2B" or "%2b" is still the "+" it stands for.
  assert.deepEqual(spellings('#a%zz%2Bb'), ['#a%zz%2Bb', '#a%zz+b']);
  assert.deepEqual(spellings('#a%zz%2bb'), ['#a%zz%2Bb', '#a%zz%2bb', '#a%zz+b']);
});

test('the other spelling of a code, sent beside it as a parameter, is left out of the arguments a review keeps as well', async () =>
  withFixture(async f => {
    const decoded = '#ZmFrZS1hdXRoLWNvZGUtMDAx+Zml4dHVyZQ==',
      given = wire(decoded);
    const r = await f.call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: TIKTOK,
      arguments: {action: authorize, account_id: account, payload: {auth_code: given}, params: {auth_code: decoded}},
    });
    // Whichever way it is answered, neither spelling is in an answer or in a stored row (the review's prepare input is one of them).
    assert.ok(!JSON.stringify(r).includes(decoded) && !JSON.stringify(r).includes(given));
    const stored = everything(f.store);
    assert.ok(!stored.includes(decoded), 'a stored row holds the code spelled with "+"');
    assert.ok(!stored.includes(given), 'a stored row holds the code spelled with "%2B"');
    if (r.success) {
      const review = f.store.document('tiktok-smart-plus-push', 'write_review', r.data.review_id);
      assert.deepEqual(review.plan.body, {advertiser_id: account});
      assert.deepEqual(review.prepare_input.arguments.payload ?? {}, {});
      assert.deepEqual(review.prepare_input.arguments.params ?? {}, {});
    }
  }));

test('the secret values are left out of the arguments a review keeps wherever they sit: in an object, a list, or deeper, and nothing else is', () => {
  const secrets = new Set(['s3cret', '#code+1']);
  assert.deepEqual(
    withoutSecrets(
      {
        action: 'x',
        payload: {
          auth_code: 's3cret',
          note: 'kept',
          nested: {deep: '#code+1', keep: 'kept', list: ['s3cret', 'kept', {again: 's3cret', ok: 1}]},
        },
        params: {auth_code: '#code+1'},
        count: 3,
      },
      secrets,
    ),
    {action: 'x', payload: {note: 'kept', nested: {keep: 'kept', list: ['kept', {ok: 1}]}}, params: {}, count: 3},
  );
  // A text that only contains a secret is no secret value: the arguments' own words stay.
  assert.deepEqual(withoutSecrets({note: 'the code is s3cret'}, secrets), {note: 'the code is s3cret'});
  assert.equal(withoutSecrets(null, secrets), null);
  assert.equal(withoutSecrets('s3cret', secrets), 's3cret');
});

test('a native dry run of the authorization keeps the code out of the audit trail it writes', async () =>
  withFixture(async f => {
    const out = await f.call(gateway, {
      action: authorize,
      account_id: account,
      payload: {auth_code: codes.fresh},
      dry_run: true,
    });
    assert.equal(out.success, true, JSON.stringify(out.error ?? out).slice(0, 300));
    assert.equal(out.data.executed, false);
    const stored = everything(f.store);
    assert.ok(stored.includes('preview'), 'the preview was audited');
    for (const secret of [codes.fresh, wire(codes.fresh)])
      assert.ok(!stored.includes(secret), 'an audit row holds the code');
  }));

test('a duet or stitch names the original post’s code too: both are held, sent and read back, and a post that is the same code twice is refused', async () =>
  withFixture(async f => {
    const payload = {auth_code: codes.fresh, original_post_auth_code: codes.original};
    const p = await applied(f, payload);
    assert.equal((await f.execute(p.data.review_id, again(f, payload))).success, true);
    assert.deepEqual(f.writes, [
      {advertiser_id: account, auth_code: wire(codes.fresh), original_post_auth_code: wire(codes.original)},
    ]);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    const same = await apply(f, {auth_code: codes.second, original_post_auth_code: codes.second});
    assertRefused(same, 'INVALID_TIKTOK_TT_VIDEO_AUTHORIZATION', {writes: () => f.writes.length - 1});
    assert.equal(same.error.details.field, 'original_post_auth_code');
  }));

test('a code that already reads "%2B" is sent as it is, and one with a "+" is sent as TikTok’s page spells it', async () =>
  withFixture(async f => {
    const encoded = wire(codes.fresh);
    const p = await applied(f, {auth_code: encoded});
    assert.equal((await f.execute(p.data.review_id, again(f, {auth_code: encoded}))).success, true);
    assert.equal(f.writes[0].auth_code, encoded);
    assert.ok(!f.writes[0].auth_code.includes('+'));
    // The read-back finds the post by the digest of the code as it was given, whichever spelling TikTok lists.
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  }));

test('the read-back finds the post whichever way TikTok spells "+" in the code it lists, and does not find another creator’s', async () =>
  withFixture(async f => {
    f.behaviour.listEncoded = true;
    const payload = {auth_code: codes.fresh};
    const p = await applied(f, payload);
    assert.equal((await f.execute(p.data.review_id, again(f, payload))).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    // The post is listed with the code's "%2B" spelling: the same code, given with its "+" or with "%2B", is found there by its digest.
    for (const auth_code of [codes.fresh, wire(codes.fresh)]) {
      const again = await apply(f, {auth_code});
      assert.match(again.error?.message ?? '', /already applied/, auth_code);
    }
    // And a code that is not listed is not found.
    assert.equal((await apply(f, {auth_code: codes.second})).success, true);
  }));

test('an answer of success that applied nothing is not a verified authorization: the post is not among the advertiser’s authorized posts', async () =>
  withFixture(async f => {
    f.behaviour.ignoreAuthorize = true;
    const payload = {auth_code: codes.fresh};
    const p = await applied(f, payload);
    assert.equal((await f.execute(p.data.review_id, again(f, payload))).success, true);
    const v = await f.verify(p.data.review_id);
    assert.notEqual(v.data.status, 'verified', JSON.stringify(v.data.checks));
    assert.ok(
      !JSON.stringify(v.data.checks).includes('authorized_post'),
      'no post is shown for a code that is not listed',
    );
  }));

test('the shape of a request is checked before any request: a code, its spaces and length, other fields, and another advertiser', async () =>
  withFixture(async f => {
    const cases = {
      'no code': [{}, 'auth_code'],
      'a number': [{auth_code: 12345678}, 'auth_code'],
      'a blank code': [{auth_code: '   '}, 'auth_code'],
      'a code with a space': [{auth_code: '#abc def12345'}, 'auth_code'],
      'a short code': [{auth_code: '#a'}, 'auth_code'],
      'an original code that is no code': [
        {auth_code: codes.fresh, original_post_auth_code: ''},
        'original_post_auth_code',
      ],
      'the post’s ID, which TikTok does not take here': [{auth_code: codes.fresh, item_id: '9511'}, 'item_id'],
      'another advertiser': [{auth_code: codes.fresh, advertiser_id: '999'}, 'advertiser_id'],
    };
    for (const [name, [payload, field]] of Object.entries(cases)) {
      const r = await apply(f, payload);
      assert.equal(r.success, false, name);
      assert.ok(
        ['INVALID_TIKTOK_TT_VIDEO_AUTHORIZATION', 'INVALID_ARGUMENT', 'ACCOUNT_SCOPE_MISMATCH'].includes(r.error.code),
        name + ': ' + r.error.code,
      );
      if (r.error.code === 'INVALID_TIKTOK_TT_VIDEO_AUTHORIZATION') assert.equal(r.error.details.field, field, name);
    }
    assert.equal(f.writes.length, 0);
  }));

test('a lost answer leaves the review uncertain, and the read of the list settles it by the digest of the code, once the post is there', async () =>
  withFixture(async f => {
    f.behaviour.mode = 'lost';
    const payload = {auth_code: codes.fresh};
    const p = await applied(f, payload);
    const x = await f.execute(p.data.review_id, again(f, payload));
    assertRefused(x, 'WRITE_OUTCOME_UNCERTAIN');
    assert.equal(f.writes.length, 1);
    // TikTok applied it though the answer was lost: the read-back finds the post, so nothing is sent again.
    assert.equal(f.authorized.at(-1).item_id, '9511');
    const v = await f.verify(p.data.review_id);
    assert.notEqual(v.data?.status, 'failed', JSON.stringify(v));
    assert.equal(f.writes.length, 1);
    // The same code is not prepared again while the first is uncertain, or once it is in the list: nothing is sent twice.
    const retry = await apply(f, payload);
    assertRefused(retry, 'INVALID_TIKTOK_TT_VIDEO_AUTHORIZATION', {writes: () => f.writes.length - 1});
    assert.match(retry.error.message, /already applied/);
  }));

test('an expired review says what to send again, and the call it hands back for a new prepare has no code', async () =>
  withFixture(async f => {
    const payload = {auth_code: codes.fresh};
    const p = await applied(f, payload);
    // The five minutes of the review are over.
    const review = f.store.document('tiktok-smart-plus-push', 'write_review', p.data.review_id);
    f.store.putDocument('tiktok-smart-plus-push', 'write_review', p.data.review_id, {...review, expires_at: 1});
    const x = await f.execute(p.data.review_id, again(f, payload));
    assertRefused(x, 'REVIEW_EXPIRED', {writes: () => f.writes.length});
    assert.match(x.error.details.secrets, /Add auth_code to the payload of the call/);
    assert.equal(x.error.details.next_call.arguments.arguments.action, authorize);
    assert.deepEqual(x.error.details.next_call.arguments.arguments.payload, {});
    assert.ok(!JSON.stringify(x).includes(codes.fresh));
  }));

test('a code sent as a parameter, where a native action also reads body fields, is held as well, and an execute whose arguments are no object sends nothing', async () =>
  withFixture(async f => {
    const wrong = await f.call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: TIKTOK,
      arguments: {action: authorize, account_id: account, params: {auth_code: codes.fresh}},
    });
    // Whichever way it is answered, the code is in no answer and in no stored row: not in the review, not in the prepare input kept with it.
    assert.ok(!JSON.stringify(wrong).includes(codes.fresh));
    assert.ok(!everything(f.store).includes(codes.fresh));
    if (wrong.success) {
      const review = f.store.document('tiktok-smart-plus-push', 'write_review', wrong.data.review_id);
      assert.deepEqual(review.plan.body, {advertiser_id: account});
      assert.deepEqual(review.prepare_input.arguments.params ?? {}, {});
    }
    const p = await applied(f, {auth_code: codes.fresh});
    for (const arguments_ of ['#ZmFrZS1hdXRoLWNvZGUtMDAx', ['x'], 5]) {
      const r = await f.execute(p.data.review_id, {arguments: arguments_});
      assertRefused(r, 'INVALID_ARGUMENT', {writes: () => f.writes.length});
    }
  }));

// ---------------------------------------------------------------------------------------------------------------------------
// Unbind: "Unbind a Spark Ad post" is for a post whose authorization has expired or has been revoked, and removes it from the list of
// the advertiser's authorized posts. It is destructive: allow_deletion, the owner's destructive tier and website approval apply.
// ---------------------------------------------------------------------------------------------------------------------------
const unbinding = (f, item_id = '9502', extra) => f.prepare({item_id}, unbind, extra);
const policy = (f, p) =>
  saveSpendPolicy(f.store, owner, {gateway, account_id: account, connection_id: TIKTOK, confirmed: true, policy: p});

test('a post whose authorization has expired is unbound: the review reads its row and the ads that use it, and the read-back shows it gone', async () =>
  withFixture(async f => {
    const p = await f.prepared({item_id: '9502'}, unbind);
    assert.deepEqual(paths(p), ['/v1.3/tt_video/list/', '/v1.3/smart_plus/ad/get/']);
    const impact = p.data.creative_impact;
    assert.equal(impact.scope, 'spark_ads_authorization');
    assert.equal(impact.operation, 'delete');
    assert.equal(impact.post.item_id, '9502');
    assert.equal(impact.post.ad_auth_status, 'EXPIRED');
    assert.deepEqual(impact.ads_using_post, []);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.deepEqual(f.writes, [{advertiser_id: account, item_id: '9502'}]);
    assert.ok(!f.authorized.some(row => row.item_id === '9502'));
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v.data.checks));
  }));

test('an unbind names the Smart+ ads that use the post: they cannot deliver without the authorization, and the review lists them', async () =>
  withFixture(async f => {
    // Ad 5130 is a Spark Ad from post 9501; its authorization has ended.
    f.authorized.find(row => row.item_id === '9501').status = 'CANCEL';
    const p = await f.prepared({item_id: '9501'}, unbind);
    assert.deepEqual(p.data.creative_impact.ads_using_post, [{smart_plus_ad_id: '5130', operation_status: 'DISABLE'}]);
    assert.equal(p.data.creative_impact.ads_complete, true);
    assert.match(p.data.creative_impact.effect, /Ads that use it cannot deliver/);
  }));

test('an authorization that is still in effect, or was never granted, or a post that is not listed, is refused at review', async () =>
  withFixture(async f => {
    const live = await unbinding(f, '9501');
    assertRefused(live, 'INVALID_TIKTOK_TT_VIDEO_UNBIND', {writes: () => f.writes.length});
    assert.match(live.error.message, /still in effect/);
    for (const status of ['APPLYING', 'NORESPONSE', 'REJECTED']) {
      f.authorized.find(row => row.item_id === '9502').status = status;
      const r = await unbinding(f);
      assertRefused(r, 'INVALID_TIKTOK_TT_VIDEO_UNBIND', {writes: () => f.writes.length});
      assert.match(r.error.message, new RegExp(status), status);
    }
    const missing = await unbinding(f, '9999');
    assertRefused(missing, 'STATE_TARGET_MISMATCH', {writes: () => f.writes.length});
    for (const item_id of ['', 'abc', '0123', 9502]) {
      const r = await f.prepare({item_id}, unbind);
      assertRefused(r, 'INVALID_TIKTOK_TT_VIDEO_UNBIND', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, 'item_id', JSON.stringify(item_id));
    }
    assert.equal(f.writes.length, 0);
  }));

test('an unbind is destructive: allow_deletion:false refuses it at review and a saved one at execute, and the owner’s destructive tier asks destructive_confirmed', async () =>
  withFixture(async f => {
    const saved = await f.prepared({item_id: '9502'}, unbind);
    policy(f, {allow_deletion: false});
    assertRefused(await unbinding(f), 'POLICY_DELETION_FORBIDDEN', {writes: () => f.writes.length});
    assertRefused(await f.execute(saved.data.review_id), 'POLICY_DELETION_FORBIDDEN', {writes: () => f.writes.length});
    policy(f, {allow_deletion: true, require_destructive_confirmation: true});
    const p = await f.prepared({item_id: '9502'}, unbind);
    assert.equal(p.data.execute_requirements.destructive_confirmed, true);
    assertRefused(await f.execute(p.data.review_id), 'DESTRUCTIVE_CONFIRMATION_REQUIRED', {
      writes: () => f.writes.length,
    });
    const done = await f.execute(p.data.review_id, {destructive_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 400));
    assert.equal(f.writes.length, 1);
  }));

test('a TikTok refusal of an unbind is rejected with nothing changed, and a post whose authorization came back since the review is refused as a changed state', async () =>
  withFixture(async f => {
    f.behaviour.unbindRefusal = 40002;
    const p = await f.prepared({item_id: '9502'}, unbind);
    const x = await f.execute(p.data.review_id);
    assertRefused(x, 'PLATFORM_ERROR');
    assert.equal(x.error.details.provider_code, 40002);
    assert.ok(f.authorized.some(row => row.item_id === '9502'));
    f.behaviour.unbindRefusal = 0;
    const q = await f.prepared({item_id: '9502'}, unbind);
    // The creator renewed the authorization after the review: the prerequisites are checked again on the state read at execute.
    f.authorized.find(row => row.item_id === '9502').status = 'AUTHORIZED';
    const renewed = await f.execute(q.data.review_id);
    assertRefused(renewed, 'INVALID_TIKTOK_TT_VIDEO_UNBIND', {writes: () => f.writes.length - 1});
    assert.match(renewed.error.message, /still in effect/);
    // An authorization that ended another way (revoked, where it had expired) is still one to unbind, but it is not the reviewed state.
    f.authorized.find(row => row.item_id === '9502').status = 'CANCEL';
    const changed = await f.execute(q.data.review_id);
    assertRefused(changed, 'STATE_CHANGED', {writes: () => f.writes.length - 1});
  }));

test('an unbind that TikTok answers with success and does not apply is not verified: the post is still listed', async () =>
  withFixture(async f => {
    f.behaviour.ignoreUnbind = true;
    const p = await f.prepared({item_id: '9502'}, unbind);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    const v = await f.verify(p.data.review_id);
    assert.notEqual(v.data.status, 'verified', JSON.stringify(v.data.checks));
  }));

test('a revoked authorization (CANCEL) is unbound as an expired one is, and the ads that name another post are not listed', async () =>
  withFixture(async f => {
    f.authorized.find(row => row.item_id === '9502').status = 'CANCEL';
    const p = await f.prepared({item_id: '9502'}, unbind);
    assert.equal(p.data.creative_impact.post.ad_auth_status, 'CANCEL');
    // Ad 5100 names posts 9001 and 9002 (not an authorized post's ID), and 5130 names 9501.
    assert.deepEqual(p.data.creative_impact.ads_using_post, []);
    assert.equal((await f.execute(p.data.review_id)).success, true);
  }));

test('the Smart+ ads are read up to 30 pages of 100: 3,000 are read, and 3,001 are more than AMCP reads, so which of them name the post is unknown', async () => {
  const fill = (f, count) => {
    for (let i = Object.keys(f.ads).length; i < count; i++)
      f.ads[6000 + i] = {...structuredClone(f.ads[5100]), smart_plus_ad_id: String(6000 + i)};
    assert.equal(Object.keys(f.ads).length, count);
  };
  await withFixture(async f => {
    fill(f, 3000);
    const p = await f.prepared({item_id: '9502'}, unbind);
    assert.equal(p.data.creative_impact.ads_complete, true);
    assert.equal(f.queries.filter(q => q.path === '/v1.3/smart_plus/ad/get/').length, 30);
  });
  await withFixture(async f => {
    fill(f, 3001);
    const r = await f.prepare({item_id: '9502'}, unbind);
    assertRefused(r, 'INCOMPLETE_STATE', {writes: () => f.writes.length});
    assert.equal(f.queries.filter(q => q.path === '/v1.3/smart_plus/ad/get/').length, 30);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// A campaign plan is stored as it is written, and the runner never sends the `arguments` an execute takes again, so a plan step that applied
// a code would store the code and could never run (the lead's review S1-2, probe P8). The code is applied with amcp_write.
// ---------------------------------------------------------------------------------------------------------------------------
const tenant = 'tiktok-smart-plus-push';
const planStep = (id, action, payload, depends_on = []) => ({
  id,
  kind: 'write',
  gateway,
  connection_id: TIKTOK,
  account_id: account,
  description: id,
  arguments: {action, payload},
  depends_on,
});
const creatorAd = planStep(
  'ad',
  'tiktok_smart_plus_ad_create',
  ad([post('9501', 'SINGLE_VIDEO', {identity_type: 'AUTH_CODE', identity_id: 'ac-1'})]),
  ['apply'],
);
const createPlan = (f, steps, extra = {}) =>
  f.call('amcp_campaign', {
    action: 'create',
    name: 'Apply a creator code',
    brief: 'Apply the creator’s code, then create the ad from the post.',
    steps,
    ...extra,
  });
const planSentence =
  /^A creator’s authorization code is applied with amcp_write prepare and execute, which keep only its digest; a campaign plan does not keep it\.$/;
/** No stored row of any table, and no answer, holds a code in either of its spellings. */
const holdsNoCode = (f, seen, secrets = [codes.fresh, codes.original]) => {
  const stored = everything(f.store);
  for (const secret of secrets.flatMap(s => [s, wire(s)])) {
    assert.ok(!stored.includes(secret), 'a stored row holds the code');
    assert.ok(!JSON.stringify(seen).includes(secret), 'an answer holds the code');
  }
};

test('a campaign plan cannot apply a creator’s code: create refuses the step with its own sentence, whatever its payload holds, and nothing is stored', async () =>
  withFixture(async f => {
    const seen = [];
    const payloads = {
      'a code': {auth_code: codes.fresh},
      'the codes of a duet': {auth_code: codes.fresh, original_post_auth_code: codes.original},
      'a code spelled with %2B': {auth_code: wire(codes.fresh)},
      'no code at all': {},
    };
    for (const [name, payload] of Object.entries(payloads)) {
      const r = await createPlan(f, [planStep('apply', authorize, payload), creatorAd]);
      seen.push(r);
      assertRefused(r, 'INVALID_ARGUMENT', {writes: () => f.writes.length});
      assert.match(r.error.message, planSentence, name);
      assert.deepEqual(r.error.details.steps, ['apply'], name);
    }
    // The code where a native action also reads body fields: in the parameters of the step.
    const params = await createPlan(f, [
      {...planStep('apply', authorize, {}), arguments: {action: authorize, params: {auth_code: codes.fresh}}},
    ]);
    seen.push(params);
    assertRefused(params, 'INVALID_ARGUMENT');
    assert.match(params.error.message, planSentence);
    // A step the compiler cannot compile (a key the tool does not take) is no way round the rule: its arguments still name the code.
    const uncompilable = await createPlan(f, [
      {
        ...planStep('apply', authorize, {}),
        arguments: {action: authorize, payload: {auth_code: codes.fresh}, nonsense: 1},
      },
    ]);
    seen.push(uncompilable);
    assertRefused(uncompilable, 'INVALID_ARGUMENT');
    assert.match(uncompilable.error.message, planSentence);
    assert.equal(f.store.documents(tenant, 'campaign_run').length, 0, 'no plan was saved');
    holdsNoCode(f, seen);
    // The refusal is a sentence the catalogue has in Arabic, as every sentence a refusal of create says.
    const ar = JSON.parse(readFileSync(new URL('../web/locales/ar.json', import.meta.url), 'utf8'));
    assert.match(ar[params.error.message] ?? '', /[؀-ۿ]/, 'no Arabic for: ' + params.error.message);
  }));

test('a plan step that is amended into the application of a code is refused, and the plan keeps the step it had', async () =>
  withFixture(async f => {
    const made = await createPlan(f, [planStep('ad', 'tiktok_smart_plus_ad_create', ad([post('9001')]))]);
    assert.equal(made.success, true, JSON.stringify(made.error ?? made.data).slice(0, 400));
    const id = made.data.id;
    // The step failed before it reached TikTok, which is what lets a step be amended.
    const run = f.store.document(tenant, 'campaign_run', id);
    run.steps[0].status = 'failed';
    f.store.putDocument(tenant, 'campaign_run', id, run);
    const before = JSON.stringify(f.store.document(tenant, 'campaign_run', id).steps[0].arguments);
    const seen = [];
    for (const amendment of [
      // The step is replaced by the application of a code, and the step only changes its action (the code is no field it has).
      {arguments: {action: authorize, payload: {auth_code: codes.fresh}}},
      {patch: [{path: '/action', value: authorize}]},
    ]) {
      const r = await f.call('amcp_campaign', {
        action: 'recover_step',
        id,
        step_id: 'ad',
        confirmed: true,
        ...amendment,
      });
      seen.push(r);
      assertRefused(r, 'INVALID_ARGUMENT', {writes: () => f.writes.length});
      assert.match(r.error.message, planSentence);
      assert.deepEqual(r.error.details.steps, ['ad']);
    }
    assert.equal(JSON.stringify(f.store.document(tenant, 'campaign_run', id).steps[0].arguments), before);
    holdsNoCode(f, seen);
  }));

test('an amendment is judged by the step it amends: a plan saved before this rule, with a step that applies a code, still has its other steps amended', async () =>
  withFixture(async f => {
    const first = planStep('one', 'tiktok_smart_plus_ad_create', ad([post('9001')]));
    const second = planStep('two', 'tiktok_smart_plus_ad_create', ad([post('9002')]));
    const made = await createPlan(f, [first, second]);
    assert.equal(made.success, true, JSON.stringify(made.error ?? made.data).slice(0, 400));
    const id = made.data.id;
    // A plan of an earlier day: its first step applies a code, and its second step failed before it reached TikTok. The plan's hash is the
    // one of its steps as a plan keeps them (what the runner checks before it acts on a plan).
    const run = f.store.document(tenant, 'campaign_run', id);
    run.steps[0].arguments = {action: authorize, payload: {auth_code: codes.fresh}};
    run.steps[1].status = 'failed';
    const kept = ['id', 'kind', 'gateway', 'connection_id', 'account_id', 'arguments', 'depends_on', 'description'];
    run.plan_hash = fingerprint(
      run.steps.map(s =>
        Object.fromEntries(
          [...kept, 'expected_currency', 'prerequisites'].filter(k => s[k] !== undefined).map(k => [k, s[k]]),
        ),
      ),
    );
    f.store.putDocument(tenant, 'campaign_run', id, run);
    const amended = await f.call('amcp_campaign', {
      action: 'recover_step',
      id,
      step_id: 'two',
      confirmed: true,
      arguments: {action: 'tiktok_smart_plus_ad_create', payload: ad([post('9003')])},
    });
    assert.equal(amended.success, true, JSON.stringify(amended.error ?? amended.data).slice(0, 400));
    assert.deepEqual(f.store.document(tenant, 'campaign_run', id).steps[1].arguments.payload.creative_list, [
      post('9003'),
    ]);
  }));

test('a saved template cannot apply a creator’s code: saving or previewing it is refused, and a template saved before is refused when a plan is made from it', async () =>
  withFixture(async f => {
    const seen = [];
    const templates = {
      'a step with a code': [planStep('apply', authorize, {auth_code: codes.fresh})],
      'a step with a place for the code': [planStep('apply', authorize, {auth_code: '{{auth_code}}'})],
      'the action alone': [planStep('apply', authorize, {})],
    };
    for (const [name, steps] of Object.entries(templates)) {
      const profile = {name: 'Spark from a creator', templates: {spark: steps}};
      for (const request of [
        {action: 'save_profile', confirmed: true, profile},
        {action: 'preview_profile', profile},
      ]) {
        const r = await f.call('amcp_workspace', request);
        seen.push(r);
        assertRefused(r, 'INVALID_ARGUMENT');
        assert.match(r.error.message, planSentence, name + ' / ' + request.action);
      }
    }
    assert.equal(f.store.documents(tenant, 'client_profile').length, 0, 'no profile was saved');
    // A template of an earlier day, saved before this rule, with the code given as a variable: the plan made from it is refused, and the
    // variable is in no stored row.
    f.store.putDocument(tenant, 'client_profile', 'earlier', {
      id: 'earlier',
      name: 'Earlier',
      revision: 1,
      templates: {spark: [planStep('apply', authorize, {auth_code: '{{auth_code}}'}), creatorAd]},
    });
    const made = await createPlan(f, undefined, {
      steps: undefined,
      profile_id: 'earlier',
      template: 'spark',
      variables: {auth_code: codes.fresh},
    });
    seen.push(made);
    assertRefused(made, 'INVALID_ARGUMENT');
    assert.match(made.error.message, planSentence);
    assert.equal(f.store.documents(tenant, 'campaign_run').length, 0, 'no plan was saved');
    holdsNoCode(f, seen);
  }));
