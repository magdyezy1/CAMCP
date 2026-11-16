import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorError, errorRemedy} from '../dist/src/errors.js';
import {localeProblems} from '../tools/check-locales.mjs';
import {googleBudgetFixture} from './fixtures/google-budget-writes.mjs';

/**
 * R2.5 M2, lead review S3-5 (probe H): the duplicate guard refused every identical create, and for a create AMCP cannot look up
 * (Snapchat, X, LinkedIn, Microsoft, Reddit, Smart+) its refusal asked for the impossible: it told the agent to settle the earlier
 * review by reconcile and replace it, which cannot happen for these kinds (reconcile answers no_read_contract, and a replacement
 * needs a reconciliation that found the write not applied). Its remedy was the generic one of a 409, "prepare again", which is
 * refused again. The refusal now says that AMCP cannot check that create by reading the provider, that the person checks the
 * provider, and that a changed request (its name, for example) is a new create. Both guard codes have a remedy, with its Arabic.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const checkable =
  'Nothing was prepared or sent. An identical create is already uncertain or still being sent, so another could make a second object. Settle that review first (details.next_call): read amcp_write status, or run reconcile, which reads the provider. If reconcile finds it was not applied, prepare this request again with supersedes_review_id set to its review_id; if it was applied, the user accepts it (accept_applied). If the earlier review belongs to a colleague (details.readable is false), ask them or the workspace owner to settle it.';
const unchecked =
  'Nothing was prepared or sent. An identical create is unresolved, and AMCP cannot check this kind of create by reading the provider, so it cannot say whether it was applied, and a new review cannot replace it. Check the provider for the object yourself (details.earlier_review_id names the earlier review when you may read it). If the object exists, use it and do not create it again. If it does not, change the request, its name for example: a changed request is a new create and is not held back.';
const completed =
  'Nothing was sent. An identical create completed after this review was prepared, so executing it would make a second object. Prepare the request again (details.next_call): the new review carries the warning, and it is executed only if the user wants two.';

/** A synthetic Snapchat ad account whose create answers are lost: a kind of create AMCP has no lookup for. */
function snapchat() {
  const store = new Store(':memory:', Buffer.alloc(32, 84).toString('base64')),
    actor = {tenantId: 'snapchat-duplicates', userId: 'owner', role: 'admin'};
  store.putConnection(
    actor,
    {
      id: 's',
      tenantId: actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Snapchat',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const sent = [];
  const transport = new NativeTransport(async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'POST') {
      sent.push(new URL(String(url)).pathname);
      throw new TypeError('synthetic lost response');
    }
    return Response.json({
      request_status: 'SUCCESS',
      adaccounts: [
        {
          sub_request_status: 'SUCCESS',
          adaccount: {
            id: '123',
            name: 'Synthetic',
            status: 'ACTIVE',
            currency: 'USD',
            timezone: 'UTC',
            type: 'PARTNER',
          },
        },
      ],
    });
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const call = (tool, input) => service.call(tool, input, actor);
  const prepare = (name = 'Synthetic campaign', extra = {}) =>
    call('amcp_write', {
      action: 'prepare',
      gateway: 'snapchat_native_action',
      connection_id: 's',
      arguments: {
        action: 'snapchat_campaign_create',
        account_id: '123',
        payload: {campaigns: [{name, ad_account_id: '123', status: 'PAUSED', start_time: '2027-01-01T00:00:00.000Z'}]},
      },
      ...extra,
    });
  return {store, sent, call, prepare, close: () => store.close()};
}

test('probe H: an identical Snapchat create beside an uncertain one is refused with what can be done, not what cannot', async () => {
  const f = snapchat();
  try {
    const first = await f.prepare();
    assert.equal(first.success, true, JSON.stringify(first).slice(0, 400));
    const id = first.data.review_id;
    const lost = await f.call('amcp_write', {action: 'execute', review_id: id, confirmed: true});
    assert.equal(lost.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost).slice(0, 300));

    // The premise: AMCP cannot check it by reads, and cannot replace it.
    const checked = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(checked.data.reason, 'no_read_contract', JSON.stringify(checked.data));

    const again = await f.prepare();
    assert.equal(again.error.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(again).slice(0, 300));
    const {message, details} = again.error;
    assert.equal(details.earlier_review_id, id);
    assert.equal(details.earlier_checkable, false, 'AMCP cannot look this create up');
    assert.match(message, /cannot check that kind of create by reading the provider/);
    assert.match(message, /a changed request is a new create/);
    assert.doesNotMatch(message, /supersedes_review_id|reconcile/, 'it does not ask for what cannot happen');
    assert.deepEqual(details.next_call, {tool: 'amcp_write', arguments: {action: 'status', review_id: id}});
    assert.equal(again.error.remedy.action, unchecked, 'its remedy is not the generic one of a 409');
    assert.equal(again.error.remedy.mutation_retry_safe, false);

    // The way out the refusal names: a changed request is a new create, and nothing is held back.
    const renamed = await f.prepare('Synthetic campaign 2');
    assert.equal(renamed.success, true, JSON.stringify(renamed).slice(0, 300));
    assert.equal(f.sent.length, 1, 'nothing was sent again');
  } finally {
    f.close();
  }
});

test('an uncertain create that AMCP can look up keeps the path it had: settle it by reconcile, and replace it if it was not applied', async () => {
  const f = googleBudgetFixture();
  try {
    const first = await f.creates(1, 50000000);
    f.hooks.respond = () => {
      throw new TypeError('synthetic lost response');
    };
    const lost = await f.execute(first.data.review_id);
    f.hooks.respond = undefined;
    assert.equal(lost.error.code, 'WRITE_OUTCOME_UNCERTAIN');
    const again = await f.creates(1, 50000000);
    assert.equal(again.error.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(again).slice(0, 300));
    assert.equal(again.error.details.earlier_checkable, true);
    assert.match(again.error.message, /supersedes_review_id/);
    assert.equal(again.error.details.next_call.arguments.action, 'reconcile');
    assert.equal(again.error.remedy.action, checkable);
  } finally {
    f.close();
  }
});

test('both guard codes have a remedy of their own', () => {
  const remedy = (code, details = {}) => errorRemedy(new MirrorError(code, 'x', details, 409));
  assert.equal(remedy('DUPLICATE_OF_UNCERTAIN_WRITE').action, checkable);
  assert.equal(remedy('DUPLICATE_OF_UNCERTAIN_WRITE', {earlier_checkable: true}).action, checkable);
  assert.equal(remedy('DUPLICATE_OF_UNCERTAIN_WRITE', {earlier_checkable: false}).action, unchecked);
  assert.equal(remedy('DUPLICATE_OF_COMPLETED_WRITE').action, completed);
  for (const code of ['DUPLICATE_OF_UNCERTAIN_WRITE', 'DUPLICATE_OF_COMPLETED_WRITE']) {
    const r = remedy(code);
    assert.equal(r.category, 'state', code);
    assert.equal(r.mutation_retry_safe, false, code);
  }
});

test('the three remedies have their Arabic, keeping every native name', () => {
  assert.deepEqual(localeProblems(catalog, [checkable, unchecked, completed]), []);
  for (const sentence of [checkable, unchecked, completed]) {
    assert.match(catalog[sentence], /[؀-ۿ]/u);
    for (const token of new Set(sentence.match(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g) ?? []))
      assert.ok(catalog[sentence].includes(token), 'keeps ' + token);
  }
});
