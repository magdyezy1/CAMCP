// Package r25-m0-live (Round 2.5, item 4: error 11 of the live checks of 2026-11-15). A Microsoft Advertising call carried
// the account twice: account_id "<digits>" and, in its payload, AccountId as the number of those digits. It was refused as
// ACCOUNT_SCOPE_MISMATCH "AccountId must match account_id.", with the remedy "Check the selected workspace, connection,
// account and per-account write grant", although the two named the same account and no grant was involved. A number whose
// decimal digits are the call's account_id is the same account: it is accepted and sent as the documented decimal string.
// An ID that is really different, and a value that is no ID, are still refused, now with a message that names both roles
// and a remedy that is about the request, not about grants. The comparison is `sameNativeAccount` (src/account-id.ts),
// beside the normalization every provider's account IDs share. All IDs below are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {MirrorError, errorRemedy, errorResult} from '../dist/src/errors.js';
import {compileMicrosoft, microsoftGateway, microsoftScope} from '../dist/src/microsoft-native.js';
import {sameNativeAccount} from '../dist/src/account-id.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  arabic = /\p{Script=Arabic}/u;
const account = '4120987654',
  payload = more => ({CampaignType: 'Search', ...more});
const call = more => ({action: 'GetCampaignsByAccountId', account_id: account, payload: payload(more)});
const roles = /^AccountId in the payload is not the account_id of the call\. /;

// ---- The comparison ----

test('sameNativeAccount: the documented string, or the number of its digits, is the account; nothing else is', () => {
  const same = (field, id = account, gateway = microsoftGateway) => sameNativeAccount(gateway, field, id);
  assert.equal(same(account), true);
  assert.equal(same(Number(account)), true, 'the number of the same digits');
  assert.equal(same(4120987655), false, 'another number');
  assert.equal(same('4120987655'), false, 'another string');
  assert.equal(same('0' + account), false, 'digits with a leading zero are another string');
  assert.equal(same(account + '.0'), false);
  // A value that is no ID at all.
  for (const value of [
    true,
    false,
    null,
    undefined,
    {},
    [],
    [account],
    [Number(account)],
    1.5,
    -4120987654,
    NaN,
    Infinity,
  ])
    assert.equal(same(value), false, String(value));
  // A number past the safe integers has already lost digits, so it names no ID, even where its digits read the same.
  assert.equal(same(9007199254740992, '9007199254740992'), false);
  assert.equal(same(Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)), true);
  // The form each provider binds is the one compared (Meta without its act_ prefix, Google Ads without dashes).
  assert.equal(sameNativeAccount('meta_native_action', 'act_123', '123'), true);
  assert.equal(sameNativeAccount('meta_native_action', 123, 'act_123'), true);
  assert.equal(sameNativeAccount('google_ads_native_action', 1234567890, '123-456-7890'), true);
  assert.equal(sameNativeAccount('google_ads_native_action', '123-456-7891', '123-456-7890'), false);
});

// ---- Microsoft ----

test('a payload AccountId written as the number of account_id is the same account, and is sent as the documented string', () => {
  const plan = compileMicrosoft(call({AccountId: Number(account)}));
  assert.equal(plan.body.AccountId, account);
  assert.equal(typeof plan.body.AccountId, 'string');
  assert.equal(plan.accountId, account);
  // As before: the string, and no AccountId at all (AMCP fills it from account_id).
  assert.equal(compileMicrosoft(call({AccountId: account})).body.AccountId, account);
  assert.equal(compileMicrosoft(call({})).body.AccountId, account);
});

test('a payload AccountId that is another ID, or no ID, is still refused as ACCOUNT_SCOPE_MISMATCH naming both roles', () => {
  for (const value of [
    '4120987655',
    4120987655,
    'abc',
    '',
    true,
    {},
    [],
    [Number(account)],
    -4120987654,
    'act_4120987654',
    ' ' + account,
  ])
    assert.throws(
      () => compileMicrosoft(call({AccountId: value})),
      error => {
        assertRefused(error, 'ACCOUNT_SCOPE_MISMATCH', {status: 403, message: roles});
        assert.deepEqual(error.details, {field: 'AccountId', account_conflict: true}, JSON.stringify(value));
        return true;
      },
      JSON.stringify(value),
    );
  // A number that is not a safe integer is refused earlier still, by the guard every call passes (UNSAFE_NUMERIC_ID):
  // it has lost digits, so it names no ID, and a payload with one never reaches this comparison.
  for (const value of [1.5, 9007199254740993, Number.MAX_SAFE_INTEGER + 2])
    assert.throws(
      () => compileMicrosoft(call({AccountId: value})),
      error => assertRefused(error, 'UNSAFE_NUMERIC_ID'),
      String(value),
    );
});

test('the refusal says what to change, and its remedy is about the request: not a grant, not a role, not the connection', () => {
  const error = (() => {
    try {
      compileMicrosoft(call({AccountId: '4120987655'}));
    } catch (e) {
      return e;
    }
  })();
  assert.match(error.message, /AccountId in the payload/);
  assert.match(error.message, /account_id of the call/);
  assert.match(
    error.message,
    /Send the same ID as a string in both, or leave AccountId out of the payload: AMCP fills it from account_id\.$/,
  );
  assert.doesNotMatch(error.message, /grant|permission|connection|workspace/i);
  const sent = errorResult(error, 'request-1', 1).error;
  assert.equal(sent.category, 'request');
  assert.deepEqual([sent.remedy.owner, sent.remedy.mutation_retry_safe], ['operator', false]);
  assert.match(sent.remedy.action, /^Nothing was sent, and no permission needs to change\./);
  assert.match(sent.remedy.action, /leave it out of the request: AMCP fills it from account_id\.$/);
  assert.doesNotMatch(sent.remedy.action, /per-account write grant|workspace, connection/);
  assert.equal(sent.next_action, sent.remedy.action);
});

test('the remedy still points at the grant for a scope refusal that is about a grant', () => {
  for (const [code, details] of [
    ['ACCOUNT_SCOPE_MISMATCH', {}],
    ['ACCOUNT_SCOPE_MISMATCH', {resource: 'creatives/1'}],
    ['ACCOUNT_REQUIRED', {}],
    ['WRITE_ACCOUNT_FORBIDDEN', {}],
  ]) {
    const remedy = errorRemedy(new MirrorError(code, 'Synthetic.', details, 403));
    assert.equal(remedy.category, 'grant', code);
    assert.match(remedy.action, /per-account write grant/, code);
  }
});

// ---- The real call path ----

function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 57).toString('base64')),
    actor = {tenantId: 'synthetic-account-field', userId: 'reader', role: 'admin'},
    sent = [];
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: 'ms',
      tenantId: actor.tenantId,
      label: 'Synthetic Microsoft',
      gateway: microsoftGateway,
      accounts: [account],
      accountCustomers: {[account]: '456'},
      scopes: [microsoftScope],
      enabled: true,
    },
    {accessToken: 'synthetic', developerToken: 'synthetic-developer'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      sent.push({path: new URL(String(url)).pathname, body: init?.body === undefined ? undefined : String(init.body)});
      return Response.json({Campaigns: [], TrackingId: 'synthetic'});
    }),
  );
  return {sent, call: input => service.call(microsoftGateway, input, actor)};
}

test('the call path sends the account as a string whichever way the payload wrote it, and sends nothing when it is another ID', async t => {
  const f = fixture(t);
  for (const value of [Number(account), account]) {
    f.sent.length = 0;
    const result = await f.call(call({AccountId: value}));
    assert.equal(result.success, true, JSON.stringify(result));
    const read = f.sent.find(request => request.path.endsWith('/Campaigns/QueryByAccountId'));
    assert.ok(read, 'the campaign read was sent');
    assert.equal(JSON.parse(read.body).AccountId, account);
    assert.match(read.body, new RegExp('"AccountId":"' + account + '"'), 'a JSON string on the wire');
  }
  f.sent.length = 0;
  const refused = await f.call(call({AccountId: Number(account) + 1}));
  assertRefused(refused, 'ACCOUNT_SCOPE_MISMATCH', {message: roles});
  assert.equal(refused.error.category, 'request');
  assert.equal(f.sent.length, 0, 'a refused call reaches no provider');
});

// ---- The same fault through the shared compile path ----

test('every provider that compiles through the shared path gets the same remedy for two account IDs that disagree', async t => {
  // TikTok compiles through the shared path: its advertiser_id in the query names another account than account_id.
  const store = new Store(':memory:', Buffer.alloc(32, 58).toString('base64')),
    actor = {tenantId: 'synthetic-account-field-shared', userId: 'reader', role: 'admin'};
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: 'tt',
      tenantId: actor.tenantId,
      label: 'Synthetic',
      gateway: 'tiktok_native_action',
      accounts: ['100'],
      scopes: [],
      enabled: true,
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw new Error('a refused call reaches no provider');
      }),
    ),
    result = await service.call(
      'tiktok_native_action',
      {action: 'tiktok_campaign_get', account_id: '100', query: {advertiser_id: '999'}},
      actor,
    );
  assertRefused(result, 'ACCOUNT_SCOPE_MISMATCH', {message: /^Conflicting account identifiers are not allowed/});
  // The refusal still names the field it always named, and now says that the request is at fault.
  assert.equal(typeof result.error.details.field, 'string');
  assert.equal(result.error.details.account_conflict, true);
  assert.equal(result.error.category, 'request');
  assert.doesNotMatch(result.error.remedy.action, /per-account write grant/);
});

// ---- Arabic ----

test('the message and the remedy have Arabic that keeps the native names', () => {
  const message =
      'AccountId in the payload is not the account_id of the call. Send the same ID as a string in both, or leave AccountId out of the payload: AMCP fills it from account_id.',
    remedy =
      'Nothing was sent, and no permission needs to change. The request names an account ID that is not the account_id of the call. Send the same ID in both, or leave it out of the request: AMCP fills it from account_id.';
  assert.equal(compileMicrosoftMessage(), message);
  assert.equal(errorRemedy(new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'm', {account_conflict: true})).action, remedy);
  for (const [text, tokens] of [
    [message, ['AccountId', 'account_id', 'AMCP']],
    [remedy, ['account_id', 'AMCP']],
  ]) {
    assert.ok(Object.hasOwn(catalog, text), 'Arabic for: ' + text.slice(0, 60));
    assert.match(catalog[text], arabic);
    for (const token of tokens) assert.ok(catalog[text].includes(token), token);
  }
});
function compileMicrosoftMessage() {
  try {
    compileMicrosoft(call({AccountId: '1'}));
  } catch (error) {
    return error.message;
  }
}
