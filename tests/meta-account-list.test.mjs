import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {metaService} from './helpers/meta-service.mjs';

// r25-fr-meta-reads, A6 (the owner's friction report of 2026-11-26): meta_me_adaccounts_get "is meant to list accounts" but was
// refused ACCOUNT_REQUIRED without an account ID, and with one RESOURCE_SCOPE_REQUIRED with no read to name. Meta's own list is the
// login user's accounts, which are not the accounts this workspace grants, so AMCP does not send it: the refusal names the read that
// does answer (amcp_platform_workspace list_accounts, from AMCP's own records and the caller's access set), and sends nothing.
const listAccounts = {
  tool: 'amcp_platform_workspace',
  arguments: {operation: 'list_accounts', arguments: {platform: 'meta'}},
};

test('meta_me_adaccounts_get is refused with the call that lists the granted accounts, with or without an account, and sends nothing', async t => {
  for (const accounts of [['123', '124'], ['123']])
    for (const given of [{}, {account_id: '123'}, {account_id: '123', dry_run: true}]) {
      const f = metaService(t, {accounts}),
        out = await f.call({action: 'meta_me_adaccounts_get', ...given}),
        label = JSON.stringify([accounts, given]);
      assertRefused(out, 'ACCOUNT_REQUIRED');
      assert.deepEqual(out.error.details.next_call, listAccounts, label);
      assert.match(out.error.next_action, /details\.next_call/, label);
      assert.equal(f.requests.length, 0, label);
    }
});

test('the call the refusal names answers: it lists the accounts the login grants, without a provider request', async t => {
  const f = metaService(t),
    refused = await f.call({action: 'meta_me_adaccounts_get'}),
    next = refused.error.details.next_call,
    listed = await f.callTool(next.tool, next.arguments);
  assert.equal(listed.success, true, JSON.stringify(listed.error));
  const text = JSON.stringify(listed.data);
  assert.ok(text.includes('123') && text.includes('124'), text.slice(0, 400));
  assert.equal(f.requests.length, 0);
});

test('any read that names no account is refused the same way when the login has several, and keeps the sentence it had', async t => {
  const f = metaService(t),
    out = await f.call({action: 'meta_search_get', query: {q: 'x', type: 'adinterest'}});
  assertRefused(out, 'ACCOUNT_REQUIRED');
  assert.equal(out.error.message, 'Specify an account_id for this connection.');
  assert.deepEqual(out.error.details.next_call, listAccounts);
  assert.equal(f.requests.length, 0);
});

test('the refusals this does not touch are what they were: a read that needs an account, and the other account-bound reads', async t => {
  const f = metaService(t);
  // A read whose route names the account is not refused for want of one by the list: it fails to compile, as it did.
  const missing = await f.call({action: 'meta_ad_account_id_campaigns_get'});
  assertRefused(missing, 'MISSING_PARAMETER');
  assert.equal(missing.error.details?.next_call, undefined);
  // A refusal that is about a grant carries no list call: nothing was asked of an account.
  const foreign = await f.call({action: 'meta_ad_account_id_campaigns_get', account_id: '999'});
  assertRefused(foreign, 'CONNECTION_REQUIRED');
  assert.equal(foreign.error.details?.next_call?.arguments?.operation, undefined);
  assert.equal(f.requests.length, 0);
});
