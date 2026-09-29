import test from 'node:test';
import assert from 'node:assert/strict';
import {SNAP, fixture} from './snapchat-plan-fixture.js';

/**
 * Snapchat S11, S7 and S12 from the owner's live tests: refusals that did not say which field was wrong, or answered
 * a question nobody asked. Each now names the field and, where the fix is mechanical, how to make it.
 */
test('a readiness check names the requirement it does not know, and says where the currency comes from', async () => {
  const f = fixture();
  try {
    const check = (requirements: object) =>
      f.call('amcp_workspace', {action: 'check', connection_id: SNAP, account_id: 'acct1', requirements});
    const currency = await check({currency: 'USD'});
    assert.equal(currency.error.code, 'INVALID_ARGUMENT');
    assert.match(currency.error.message, /requirements\.currency.*live: true.*expected_currency/);
    const unknown = await check({colour: 'blue'});
    assert.match(
      unknown.error.message,
      /Unsupported requirements key: colour\. Accepted: write, assets, destination_url, native_request\./,
    );
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});
