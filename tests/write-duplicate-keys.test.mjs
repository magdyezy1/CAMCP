import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {findCreated} from '../dist/src/write-reconciliation.js';
import {standardBodies} from './helpers/tiktok-standard-creates.mjs';
import {gateway as tiktokGateway, tiktokReconcileFixture} from './helpers/tiktok-reconcile-fixture.mjs';
import {
  account as metaAccount,
  creates as metaCreates,
  gateway as metaGateway,
} from './helpers/meta-reconcile-fixture.mjs';

/**
 * R2.5 M2, lead re-review N2 (probe P5): two creates that differ only in a field the provider does not echo (an ad's text, an array
 * in another order, "50" for 50) get past a guard whose identity is the whole body, and when both were lost, the lookup of each finds the
 * one object the first made: both were accepted as it. So an unresolved create also holds back a create whose lookup key equals its own,
 * at prepare and in the transaction that takes the claim of execute, with the same code and call; and accepting an object that another
 * create already holds is refused. The key is the gateway, the account, the kind of object, the parent it is created under and its
 * name as the lookup compares names.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const otherText = p => ({...p, creatives: [{...p.creatives[0], ad_text: 'Other text'}]});
const reconcile = (f, id, extra = {}) => f.call('amcp_write', {action: 'reconcile', review_id: id, ...extra});

test('P5 at prepare: a create of the same ad group and name that differs only in the ad text is refused beside the uncertain one', async () => {
  const f = tiktokReconcileFixture();
  try {
    const a = await f.lose('ad', {applied: true});
    const refused = await f.prepare('ad', otherText);
    assert.equal(refused.error.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(refused).slice(0, 400));
    const {details} = refused.error;
    assert.equal(details.earlier_review_id, a.id);
    assert.equal(details.earlier_state, 'uncertain');
    assert.equal(details.earlier_match, 'same_object');
    assert.equal(details.next_call.arguments.action, 'reconcile', 'the same call as for an identical create');
    assert.equal(f.sent.length, 1);
    // The identical create is refused as before, and says so.
    assert.equal((await f.prepare('ad')).error.details.earlier_match, 'identical');
  } finally {
    f.close();
  }
});

test('P5 at execute: two such creates prepared before either was sent are not both sent', async () => {
  const f = tiktokReconcileFixture();
  try {
    const a = await f.prepare('ad'),
      b = await f.prepare('ad', otherText);
    assert.equal(a.success && b.success, true, 'nothing was claimed yet, so both prepare');
    f.state.applied = true;
    f.state.lose = true;
    const lost = await f.execute(a.data.review_id);
    f.state.lose = false;
    f.state.applied = undefined;
    assert.equal(lost.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost).slice(0, 300));
    const refused = await f.execute(b.data.review_id);
    assert.equal(refused.error.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(refused).slice(0, 400));
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.equal(refused.error.details.earlier_review_id, a.data.review_id);
    assert.equal(f.sent.length, 1, 'the second was never sent');
    assert.equal(f.claim(b.data.review_id), undefined, 'its claim was rolled back');
  } finally {
    f.close();
  }
});

test('what the key holds back and what it does not: another name, another parent, a completed twin and the replacement itself', async () => {
  const f = tiktokReconcileFixture();
  try {
    const a = await f.lose('ad', {applied: false});
    // Another name is another object.
    const renamed = await f.prepare('ad', p => ({...p, creatives: [{...p.creatives[0], ad_name: 'Another ad'}]}));
    assert.equal(renamed.success, true, JSON.stringify(renamed).slice(0, 300));
    // The reconciliation found it not applied: the replacement the guard allows may change the text, and it replaces the old one.
    const r = await reconcile(f, a.id);
    assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
    const replacement = await f.prepare('ad', p => ({...otherText(p)}));
    assert.equal(
      replacement.error.code,
      'DUPLICATE_OF_UNCERTAIN_WRITE',
      'without the call that replaces, the same object is held back',
    );
    const replaced = await f.call('amcp_write', r.data.next_call.arguments);
    assert.equal(replaced.success, true, JSON.stringify(replaced).slice(0, 400));
    const done = await f.execute(replaced.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 300));
    // A create that completed is no longer unresolved: a twin of the same object only warns when it is identical, and passes when it differs.
    const later = await f.prepare('ad', otherText);
    assert.equal(later.success, true, JSON.stringify(later).slice(0, 300));
    assert.equal(
      later.data.duplicate_warning,
      undefined,
      'a twin that differs is no identical create: nothing to warn of',
    );
  } finally {
    f.close();
  }
});

test('P5 at accept: an object that another create already holds is never accepted as a second create’s', async () => {
  const f = tiktokReconcileFixture();
  try {
    const a = await f.prepare('ad'),
      b = await f.prepare('ad', otherText);
    f.state.applied = true;
    f.state.lose = true;
    await f.execute(a.data.review_id);
    f.state.lose = false;
    f.state.applied = undefined;
    // B was claimed by a release that did not hold such creates back: its claim is uncertain too, and it made nothing.
    const fingerprint = f.store.document(f.actor.tenantId, 'write_review', b.data.review_id).fingerprint;
    f.store.claim(f.actor.tenantId, b.data.review_id, fingerprint);
    f.store.uncertain(f.actor.tenantId, b.data.review_id);
    const ra = await reconcile(f, a.data.review_id),
      rb = await reconcile(f, b.data.review_id);
    assert.deepEqual(
      [ra.data.classification, rb.data.classification],
      ['appears_applied', 'appears_applied'],
      'both lookups find the one ad',
    );
    assert.deepEqual(ra.data.observed_ids, rb.data.observed_ids);
    const accept = (id, r) => reconcile(f, id, {accept_applied: true, reconciliation_id: r.data.reconciliation_id});
    assert.equal((await accept(a.data.review_id, ra)).success, true);
    const second = await accept(b.data.review_id, rb);
    assert.equal(second.error.code, 'RECOVERY_NOT_SAFE', JSON.stringify(second).slice(0, 400));
    assert.deepEqual(second.error.details.observed_ids, ra.data.observed_ids);
    assert.equal(f.claim(b.data.review_id).state, 'uncertain', 'nothing was changed');
  } finally {
    f.close();
  }
});

// ----- the keys themselves -----
const compiler = new Compiler(new Registry()),
  options = {mode: 'strict', flags: {}};
const compile = (gateway, action, account, params, payload) =>
  applyExecutionRisk(
    compiler.compile(
      gateway,
      {action, account_id: account, ...(params ? {params} : {}), payload, dry_run: true},
      options,
    ),
  );
const tiktok = (kind, edit = p => p) => {
  const {action, payload} = standardBodies('123')[kind];
  return compile(tiktokGateway, action, '123', undefined, edit(structuredClone(payload)));
};
const keysOf = plan => findCreated(plan)?.keys;

test('a lookup’s key is its kind, parent and name: it ignores what the provider does not echo and tells another parent or name apart', () => {
  const base = keysOf(tiktok('ad'));
  assert.equal(base?.length, 1, 'a TikTok ad create has one key');
  assert.deepEqual(keysOf(tiktok('ad', otherText)), base, 'another ad text: the same object');
  assert.deepEqual(
    keysOf(
      tiktok('ad', p => ({
        ...p,
        creatives: [{...p.creatives[0], image_ids: ['img-2'], landing_page_url: 'https://example.test/2'}],
      })),
    ),
    base,
  );
  assert.notDeepEqual(keysOf(tiktok('ad', p => ({...p, adgroup_id: '201'}))), base, 'another ad group');
  assert.notDeepEqual(
    keysOf(tiktok('ad', p => ({...p, creatives: [{...p.creatives[0], ad_name: 'Another ad'}]}))),
    base,
    'another name',
  );
  assert.notDeepEqual(keysOf(tiktok('campaign')), keysOf(tiktok('adgroup')), 'another kind');
  // Meta: a campaign's, an ad set's and an ad's key hold their parent; a set's holds its catalog and compares the name as the family does.
  const adset = (campaign, name) => {
    const [action, params, payload] = metaCreates.adset ?? [];
    return action
      ? compile(metaGateway, action, metaAccount, params, {...payload, campaign_id: campaign, name})
      : undefined;
  };
  if (metaCreates.adset) {
    assert.notDeepEqual(keysOf(adset('111', 'Broad')), keysOf(adset('222', 'Broad')), 'another campaign');
    assert.deepEqual(keysOf(adset('111', 'Broad')), keysOf(adset('111', 'Broad')));
  }
});
