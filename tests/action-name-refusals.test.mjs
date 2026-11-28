import test from 'node:test';
import assert from 'node:assert/strict';
import {Compiler} from '../dist/src/compiler.js';
import {Introspection} from '../dist/src/introspection.js';
import {nameCandidates} from '../dist/src/name-candidates.js';
import {errorResult} from '../dist/src/errors.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {metaService, registry} from './helpers/meta-service.mjs';

// r25-fr-meta-reads, D6 (the owner's friction report of 2026-11-26): asking for an account's activities was refused "Action is absent
// from the captured catalog: action" (the field's name, not the action's), and the names it offered were ad creatives, images and
// videos: any name within a third of its length in edits. A refusal names the action asked for, offers only names that share its
// words (or differ by a typo), and says when nothing is close.
const gateway = 'meta_native_action',
  compiler = new Compiler(registry),
  strict = {mode: 'strict', flags: {}},
  captured = registry.catalogs.get(gateway).actions.map(a => a.name),
  unknown = 'meta_ad_account_id_telepathy_get';
const refusal = input => {
  try {
    compiler.compile(gateway, input, strict);
  } catch (e) {
    return e;
  }
  assert.fail('the action was found: ' + JSON.stringify(input));
};

test('a name that resembles no action gets no suggestions, and the details say so', () => {
  // The report's own guess, against the names the capture holds: five unrelated reads were offered.
  for (const value of ['meta_ad_account_id_activities_get', 'meta_ad_account_activities_get', unknown]) {
    const out = nameCandidates(value, captured);
    assert.deepEqual(out.did_you_mean, [], value);
    assert.equal(out.nothing_similar, true, value);
    assert.equal(out.value, value);
    assert.ok(out.allowed.length <= 20 && out.count >= captured.length);
  }
});

test('a name that shares its words with actions, or differs by a typo, still gets them', () => {
  const offers = (value, ...names) => {
    const out = nameCandidates(value, captured);
    for (const name of names)
      assert.ok(out.did_you_mean.includes(name), value + ' offers ' + name + ': ' + out.did_you_mean);
    assert.equal(out.nothing_similar, undefined, value);
    assert.ok(out.did_you_mean.length <= 5);
  };
  offers('meta_ad_account_id_campaigns_gett', 'meta_ad_account_id_campaigns_get');
  offers('meta_ad_account_id_campaings_get', 'meta_ad_account_id_campaigns_get');
  offers('ad_account_campaigns', 'meta_ad_account_id_campaigns_get');
  offers('meta_ad_account_id_campaigns_get_typo', 'meta_ad_account_id_campaigns_get');
  // The pins the other suites hold: a name that contains a real name, a gateway typo, an operation typo.
  assert.ok(
    nameCandidates('meta_native_actoin', ['meta_native_action', 'tiktok_native_action']).did_you_mean.includes(
      'meta_native_action',
    ),
  );
  assert.ok(nameCandidates('capabilites', ['capabilities', 'dashboard']).did_you_mean.includes('capabilities'));
  assert.ok(
    nameCandidates('DV360_ADVERTISER_GETT', ['DV360_ADVERTISERS_GET', 'DV360_ADVERTISERS_LIST']).did_you_mean.includes(
      'DV360_ADVERTISERS_GET',
    ),
  );
});

test('the compiler names the missing action, offers nothing unrelated, and keeps the list call', () => {
  const e = refusal({action: unknown, account_id: '123'});
  assertRefused(e, 'UNKNOWN_ACTION');
  assert.equal(e.message, 'No action named ' + unknown + ' is in the captured catalog.');
  assert.equal(e.details.field, 'action');
  assert.equal(e.details.action, unknown);
  assert.deepEqual(e.details.did_you_mean, []);
  assert.equal(e.details.nothing_similar, true);
  assert.deepEqual(e.details.list_call, {
    tool: gateway,
    arguments: {action: 'LIST_ACTIONS', search: 'telepathy', limit: 20},
  });
  const shown = errorResult(e, 'request-1', 1).error;
  assert.equal(shown.message, e.message, 'no field name hangs off the end of the sentence');
  assert.match(shown.remedy.action, /^Nothing in the catalog is close to that name\./);
  assert.match(shown.next_action, /details\.list_call/);
  assert.doesNotMatch(shown.next_action, /did_you_mean/);
  assert.ok(JSON.stringify(shown).length < 3000);
});

test('with suggestions the remedy is the one it was, and a name that is no name is not echoed', () => {
  const near = refusal({action: 'meta_ad_account_id_campaigns_gett', account_id: '123'});
  assert.deepEqual(near.details.did_you_mean.slice(0, 1), ['meta_ad_account_id_campaigns_get']);
  assert.equal(near.details.nothing_similar, undefined);
  assert.match(errorResult(near, 'r', 1).error.next_action, /Use a name from details\.did_you_mean/);
  // No action, a name with spaces or markup, and a name longer than an action name keep the sentence they had.
  for (const input of [
    {resource: 'customLists', method: 'get'},
    {action: 'delete all <b>the</b> ads', account_id: '123'},
    {action: 'meta_' + 'x'.repeat(80) + '_get', account_id: '123'},
  ])
    assert.equal(
      refusal(input).message,
      'Action is absent from the captured catalog.',
      JSON.stringify(input).slice(0, 60),
    );
});

test('DESCRIBE_ACTION and a call through the service refuse the same way', async t => {
  const introspection = new Introspection(registry);
  assert.throws(
    () => introspection.describe(gateway, {target_action: unknown}),
    e =>
      assertRefused(e, 'UNKNOWN_ACTION') &&
      e.message.startsWith('No action named ' + unknown + ' is in the captured catalog') &&
      e.details.field === 'target_action' &&
      e.details.nothing_similar === true,
  );
  const f = metaService(t),
    out = await f.call({action: unknown, account_id: '123'});
  assertRefused(out, 'UNKNOWN_ACTION');
  assert.equal(out.error.message, 'No action named ' + unknown + ' is in the captured catalog.');
  assert.deepEqual(out.error.details.did_you_mean, []);
  // DESCRIBE_ACTION says it in the same sentence: the argument that held the name is in details.field, not hung off the end of the message.
  const described = await f.call({action: 'DESCRIBE_ACTION', target_action: unknown});
  assertRefused(described, 'UNKNOWN_ACTION');
  assert.equal(described.error.message, 'No action named ' + unknown + ' is in the captured catalog.');
  assert.equal(described.error.details.field, 'target_action');
  // What is no name is not echoed, so the argument that held it is what the message names.
  const unnamed = await f.call({action: 'DESCRIBE_ACTION', target_action: 'two words here'});
  assert.equal(unnamed.error.message, 'Action is absent from the captured catalog: target_action.');
  assert.equal(f.requests.length, 0);
});
