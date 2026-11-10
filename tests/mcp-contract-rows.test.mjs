// V2-MCP-02: the rows of src/first-party-contracts.ts that package mcp did not audit, checked against their handlers. The rows
// generate each action's argument schema in `action:"help"` and the argument findings of a call (ARGUMENT_NOT_USED_BY_ACTION,
// which a later release refuses), so a row that lists an argument as optional that the handler requires, omits one it reads, or
// requires one it does not ask for sends a client away from a call that works. The audit traced every property each handler
// reads and removed every required argument in turn (196 rows, 285 required arguments; see the package report); these are the
// rows it found wrong, each pinned against the handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import {surfaceFixture} from '../tools/measure-tool-list.mjs';
import {actionArgumentFindings, firstPartyContract} from '../dist/src/first-party-contracts.js';
import {assertRefused} from './helpers/assert-refused.mjs';

function served(t) {
  const f = surfaceFixture({allowWrites: true}),
    admin = {...f.actor, role: 'admin'},
    tools = new Map(f.service.listTools().map(tool => [tool.name, tool]));
  t.after(() => f.close?.());
  return {
    tools,
    call: (tool, input) => f.service.call(tool, input, admin),
    contract: (tool, action) => firstPartyContract(tools.get(tool), action),
  };
}

test('enable_personal_data asks for the connection and not for the gateway, as its handler does', async t => {
  const f = served(t),
    contract = f.contract('amcp_workspace', 'enable_personal_data');
  assert.deepEqual(contract.argumentsSchema.required, ['action', 'connection_id', 'account_id', 'confirmed']);
  // The gateway is still accepted, for the clients that were told to send it, and not asked for.
  assert.ok(Object.hasOwn(contract.argumentsSchema.properties, 'gateway'));
  assert.equal(contract.argumentsSchema.required.includes('gateway'), false);
  const withGateway = await f.call('amcp_workspace', {
    action: 'enable_personal_data',
    gateway: 'meta_native_action',
    account_id: '123',
    confirmed: true,
  });
  assertRefused(withGateway, 'INVALID_ARGUMENT');
  assert.match(withGateway.error.message, /connection_id/, 'the handler asks for the connection');
  // With the connection named and no gateway, the handler gets past its argument check to the connection itself.
  assertRefused(
    await f.call('amcp_workspace', {
      action: 'enable_personal_data',
      connection_id: 'no-such-connection',
      account_id: '123',
      confirmed: true,
    }),
    'CONNECTION_NOT_FOUND',
  );
  assert.deepEqual(
    actionArgumentFindings(f.tools.get('amcp_workspace'), {
      action: 'enable_personal_data',
      connection_id: 'c',
      account_id: '1',
      confirmed: true,
    }),
    [],
  );
});

test('resolve_delivery may read the Google Sheets tab and write it through the export it queues, and names its resolutions as the handler does', t => {
  const f = served(t),
    contract = f.contract('amcp_reporting_overview', 'resolve_delivery');
  // check rereads the tab's delivery marker (tests/sheets-delivery-recovery.test.mjs counts that read), so the row no longer
  // says "no provider request"; resend requeues the export that writes the tab.
  assert.equal(contract.effects.provider_requests, 'read_only');
  assert.equal(contract.effects.remote_writes, true);
  assert.deepEqual(contract.effects.saves, ['sheets_delivery']);
  // The handler's resolutions are check, resend and abandon (not "release").
  for (const word of ['Checks', 'resends', 'abandons'])
    assert.match(contract.summary, new RegExp('\\b' + word + '\\b'));
  assert.doesNotMatch(contract.summary, /releases/);
});

test('capture_presets takes the connection and the account that name a capture target, as its handler does', async t => {
  const f = served(t),
    contract = f.contract('amcp_reporting', 'capture_presets');
  assert.deepEqual(contract.argumentsSchema.required, ['action']);
  assert.ok(Object.hasOwn(contract.argumentsSchema.properties, 'connection_id'));
  assert.ok(Object.hasOwn(contract.argumentsSchema.properties, 'account_id'));
  // The handler reads them: given together it looks for the connection and refuses one that is not there.
  assertRefused(
    await f.call('amcp_reporting', {action: 'capture_presets', connection_id: 'no-such-connection', account_id: '123'}),
    'CONNECTION_REQUIRED',
  );
  // Without them it answers the presets, as before.
  const presets = await f.call('amcp_reporting', {action: 'capture_presets'});
  assert.equal(presets.success, true, JSON.stringify(presets.error));
  assert.ok(presets.data.presets.length > 0);
  assert.equal(presets.data.target, undefined);
  // A call that carries them is not drawn a finding that the action does not use them.
  assert.deepEqual(
    actionArgumentFindings(f.tools.get('amcp_reporting'), {
      action: 'capture_presets',
      connection_id: 'c',
      account_id: '1',
    }),
    [],
  );
});
