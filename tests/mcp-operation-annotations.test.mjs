import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {firstPartyContract, toolActions} from '../dist/src/first-party-contracts.js';
import {
  additiveActions,
  cautiousHints,
  fileFetchingActions,
  firstPartyActionHints,
  localWorkflowKeys,
  notReadOnlyActions,
} from '../dist/src/tool-annotations.js';
import {ledgerRowHints} from '../dist/src/execution-status.js';
import {offerParkedProviders} from './helpers/parked-providers.mjs';
import {bags, fill, readOnlyCall, world} from './helpers/annotation-walk.mjs';

// MCP-06 per operation (wave 4b MCP quality pass, mcp-builder guidance). tools/list gives one set of hints per tool,
// so a gateway that mixes reads with saves, uploads or deletions was presented as not read-only as a whole, and help
// said nothing per action: a client could not tell amcp_workspace dashboard from save_spend_policy, or a GA4 report
// from a GA4 disconnect. Help now gives every action its own hints, derived from its contract (first-party effects,
// the native ledger status). A wrong readOnlyHint:true would let a client run a change unasked, so every action
// presented as read-only is run below with read- and write-shaped arguments: it must save no AMCP state, send only
// reads and create no provider job.
offerParkedProviders('criteo', 'woocommerce');
const registry = new Registry(),
  ledger = actionContracts(registry);
const four = h => [h.readOnlyHint, h.destructiveHint, h.idempotentHint, h.openWorldHint];
const contractOf = (service, tool, action) =>
  firstPartyContract(
    service.firstPartyTools().find(t => t.name === tool),
    action,
  );
const nativeHints = ledgerRowHints;

test('help gives every action of every AMCP tool its own hints, consistent with its contract and its tool', async () => {
  for (const allowWrites of [true, false]) {
    const w = world(registry, allowWrites);
    try {
      const listed = new Map(w.service.listTools().map(t => [t.name, t]));
      for (const tool of w.service.firstPartyTools()) {
        const actions = toolActions(tool),
          own = listed.get(tool.name).annotations;
        for (const action of actions) {
          const help = await w.service.call(
              'amcp_tool_help',
              {gateway: tool.name, ...(action === null ? {} : {operation: action})},
              w.actor,
            ),
            c = firstPartyContract(tool, action),
            h = help.data.contract.annotations,
            label = tool.name + ' ' + action + (allowWrites ? '' : ' (read-only deployment)');
          assert.deepEqual(h, firstPartyActionHints(tool.name, action, c.effects), label);
          for (const value of four(h)) assert.equal(typeof value, 'boolean', label);
          if (h.readOnlyHint) assert.deepEqual([h.destructiveHint, h.idempotentHint], [false, true], label);
          else assert.equal(h.idempotentHint, false, label);
          // The tool's own hints cover every action: never read-only over a change, never less cautious.
          if (own.readOnlyHint) assert.equal(h.readOnlyHint, true, label + ' under a read-only tool');
          if (h.destructiveHint) assert.equal(own.destructiveHint, true, label + ' under a non-destructive tool');
          if (h.openWorldHint) assert.equal(own.openWorldHint, true, label + ' under a closed-world tool');
          // A read-only action changes nothing its effects could show.
          if (h.readOnlyHint)
            assert.ok(
              c.effects.saves.length === 0 && c.effects.provider_requests !== 'reviewed_write',
              label + ' effects',
            );
        }
      }
    } finally {
      w.close();
    }
  }
});

test('the hints of a few actions are pinned, so a change to their derivation is seen', () => {
  const w = world(registry, true);
  try {
    const hint = (tool, action) =>
      four(firstPartyActionHints(tool, action, contractOf(w.service, tool, action).effects));
    // [readOnlyHint, destructiveHint, idempotentHint, openWorldHint]
    assert.deepEqual(hint('amcp_workspace', 'dashboard'), [true, false, true, false]);
    assert.deepEqual(hint('amcp_workspace', 'portfolio'), [true, false, true, true]);
    assert.deepEqual(hint('amcp_workspace', 'check'), [false, false, false, true], 'check saves readiness evidence');
    assert.deepEqual(hint('amcp_workspace', 'save_spend_policy'), [false, true, false, false]);
    assert.deepEqual(hint('amcp_workspace', 'delete_profile'), [false, true, false, false]);
    assert.deepEqual(hint('amcp_campaign', 'create'), [false, false, false, false], 'a new draft plan only adds');
    assert.deepEqual(hint('amcp_campaign', 'execute_next'), [false, true, false, true]);
    assert.deepEqual(hint('amcp_campaign', 'validate_provider'), [false, false, false, true], 'owner opt-in, D18');
    // The review gate records only a person's word, but it decides what is sent next (wave 4b review): approve lets run
    // execute every spending step, confirm_absent lets a refused step be sent again, and accepting an observed or
    // applied outcome settles a write. They were presented as additive, so a client honouring per-action hints could
    // record an approval without asking.
    assert.deepEqual(hint('amcp_campaign', 'approve'), [false, true, false, false], 'the plan-wide approval');
    assert.deepEqual(hint('amcp_campaign', 'confirm_absent'), [false, true, false, true], 'it reads the provider');
    assert.deepEqual(hint('amcp_campaign', 'reconcile_step'), [false, true, false, true]);
    assert.deepEqual(hint('amcp_write', 'reconcile'), [false, true, false, true]);
    assert.deepEqual(hint('amcp_reporting', 'analyze'), [true, false, true, false]);
    assert.deepEqual(hint('amcp_reporting', 'capture_preset'), [false, false, false, true]);
    assert.deepEqual(hint('amcp_reporting_overview', 'export'), [false, true, false, true], 'replaces a Sheets tab');
    assert.deepEqual(hint('amcp_write', 'inspect'), [true, false, true, false]);
    assert.deepEqual(hint('amcp_write', 'prepare'), [false, false, false, true], 'a new review');
    assert.deepEqual(hint('amcp_write', 'execute'), [false, true, false, true]);
    assert.deepEqual(hint('amcp_media', 'prepare'), [false, false, false, true], 'it downloads the linked file');
    assert.deepEqual(hint('amcp_media', 'inspect_eligibility'), [true, false, true, true]);
    assert.deepEqual(hint('amcp_media', 'remove_source'), [false, true, false, false]);
  } finally {
    w.close();
  }
  const row = (gateway, operation, action) =>
    ledger.find(
      r => r.gateway === gateway && (r.operation ?? r.action) === operation && (!action || r.action === action),
    );
  assert.deepEqual(four(nativeHints(row('ga4_native_action', 'ga4_run_report'))), [true, false, true, true]);
  assert.deepEqual(four(nativeHints(row('ga4_native_action', 'ga4_connection_ops', 'status'))), [
    true,
    false,
    true,
    false,
  ]);
  assert.deepEqual(four(nativeHints(row('ga4_native_action', 'ga4_connection_ops', 'disconnect'))), [
    false,
    true,
    false,
    false,
  ]);
  assert.deepEqual(four(nativeHints(row('amcp_native_action', 'create_campaign'))), [true, false, true, false]);
  assert.deepEqual(four(nativeHints(row('amcp_native_action', 'generate_ad_content'))), [true, false, true, false]);
  assert.deepEqual(four(nativeHints(row('amcp_native_action', 'create_reporting_query'))), [false, true, false, true]);
  assert.deepEqual(four(nativeHints(row('microsoft_ads_native_action', 'SubmitGenerateReport'))), [
    false,
    false,
    false,
    true,
  ]);
  const media = ledger.find(r => r.gateway === 'meta_native_action' && r.status === 'media_workflow'),
    write = ledger.find(r => r.gateway === 'meta_native_action' && r.status === 'reviewed_write_family');
  assert.deepEqual(four(nativeHints(media)), [false, false, false, true], media.action);
  assert.deepEqual(four(nativeHints(write)), [true, false, true, false], write.action + ' is previewed here');
});

test('native operation help carries the operation’s hints, the reads of a mixed one, and its tool stays as cautious', async () => {
  const w = world(registry, true);
  try {
    const listed = new Map(w.service.listTools().map(t => [t.name, t])),
      delegated = [...registry.tools.values()].filter(t => t.mode === 'delegated' && listed.has(t.name));
    assert.ok(delegated.length >= 8);
    for (const tool of delegated)
      for (const op of tool.operations) {
        const help = await w.service.call('amcp_tool_help', {gateway: tool.name, operation: op.operation}, w.actor),
          execution = help.data.amcp_execution,
          rows = ledger.filter(r => r.gateway === tool.name && r.operation === op.operation),
          hints = rows.map(nativeHints),
          label = tool.name + ' ' + op.operation;
        assert.equal(help.success, true, label);
        assert.deepEqual(execution.annotations, cautiousHints(hints), label);
        assert.match(execution.annotations_meaning, /amcp_write \(inspect, prepare, execute\) is its change path/);
        const reads = rows.filter((_r, i) => hints[i].readOnlyHint).map(r => r.action);
        if (reads.length && reads.length < rows.length) assert.deepEqual(execution.read_only_actions, reads, label);
        else assert.equal(execution.read_only_actions, undefined, label);
        const own = listed.get(tool.name).annotations;
        for (const h of hints) {
          if (own.readOnlyHint) assert.equal(h.readOnlyHint, true, label + ' under a read-only tool');
          if (h.destructiveHint) assert.equal(own.destructiveHint, true, label);
          if (h.openWorldHint) assert.equal(own.openWorldHint, true, label);
        }
      }
    const mixed = await w.service.call(
      'amcp_tool_help',
      {gateway: 'ga4_native_action', operation: 'ga4_connection_ops'},
      w.actor,
    );
    assert.ok(mixed.data.amcp_execution.read_only_actions.includes('status'));
    assert.ok(!mixed.data.amcp_execution.read_only_actions.includes('disconnect'));
    assert.equal(mixed.data.amcp_execution.annotations.destructiveHint, true);
    // A direct gateway's action, in its operation help and in DESCRIBE_ACTION alike.
    for (const out of [
      await w.service.call(
        'amcp_tool_help',
        {gateway: 'meta_native_action', operation: 'meta_ad_account_id_get'},
        w.actor,
      ),
      await w.service.call(
        'meta_native_action',
        {action: 'DESCRIBE_ACTION', target_action: 'meta_ad_account_id_get'},
        w.actor,
      ),
    ]) {
      assert.equal(out.success, true, JSON.stringify(out.error));
      assert.deepEqual(four(out.data.amcp_execution.annotations), [true, false, true, true]);
    }
    const job = await w.service.call(
      'amcp_tool_help',
      {gateway: 'microsoft_ads_native_action', operation: 'SubmitGenerateReport'},
      w.actor,
    );
    assert.equal(job.data.amcp_execution.annotations.readOnlyHint, false, 'a provider report job');
    assert.equal(w.fetches.length, 0, 'help sends nothing');
  } finally {
    w.close();
  }
});

test('the reviewed hint tables name real actions, and every local workflow of the ledger has its entry', () => {
  const w = world(registry, true);
  try {
    for (const [tool, actions] of Object.entries(additiveActions))
      for (const action of actions) {
        const c = contractOf(w.service, tool, action);
        assert.ok(c, tool + ' ' + action + ' is an action');
        const h = firstPartyActionHints(tool, action, c.effects);
        assert.equal(h.readOnlyHint, false, tool + ' ' + action + ' changes something, or it is no additive change');
        assert.equal(c.effects.advertising_writes || c.effects.remote_writes, false, tool + ' ' + action);
      }
    for (const [tool, actions] of Object.entries(notReadOnlyActions))
      for (const action of actions) {
        const c = contractOf(w.service, tool, action);
        assert.ok(c, tool + ' ' + action);
        assert.equal(c.effects.saves.length, 0, 'the entry is needed: its effects alone would read as read-only');
      }
    for (const [tool, actions] of Object.entries(fileFetchingActions))
      for (const action of actions) {
        const c = contractOf(w.service, tool, action);
        assert.equal(c.effects.provider_requests, 'none', tool + ' ' + action + ': the entry adds what effects lack');
      }
  } finally {
    w.close();
  }
  const local = ledger.filter(r => r.status === 'local_workflow'),
    keys = localWorkflowKeys();
  const keyOf = r =>
    [r.gateway + '/' + r.operation + '/' + r.action, r.gateway + '/' + (r.operation ?? r.action)].find(k =>
      keys.includes(k),
    );
  assert.deepEqual(
    local.filter(r => !keyOf(r)).map(r => r.gateway + '/' + r.operation + '/' + r.action),
    [],
    'a local workflow without an entry falls back to its tool’s hints',
  );
  for (const key of keys)
    assert.ok(
      local.some(r => keyOf(r) === key),
      key + ' names a local workflow of the ledger',
    );
});

test('every action presented as read-only saves nothing, sends only reads and creates no provider job', async () => {
  let calls = 0,
    succeeded = 0,
    reads = 0,
    presented = 0,
    closed = 0;
  // AMCP's own tools, in both deployment modes.
  for (const allowWrites of [true, false]) {
    const w = world(registry, allowWrites);
    try {
      for (const tool of w.service.firstPartyTools())
        for (const action of toolActions(tool)) {
          const c = firstPartyContract(tool, action),
            h = firstPartyActionHints(tool.name, action, c.effects);
          if (!h.readOnlyHint) continue;
          presented++;
          const {read, write} = bags(w, 'meta_native_action'),
            extra = {gateway: 'meta_native_action', asset_id: 'synthetic-asset', ad_ids: ['1001'], platform: 'meta'};
          const inputs =
            tool.name === 'amcp_write'
              ? [
                  {
                    action,
                    gateway: 'meta_native_action',
                    connection_id: w.connections.get('meta_native_action'),
                    arguments: {action: 'meta_campaign_create', account_id: '1001', payload: {name: 'Synthetic'}},
                  },
                ]
              : [read, write].map(bag =>
                  fill({...bag, ...extra, ...(action === null ? {} : {action})}, c.argumentsSchema),
                );
          for (const input of inputs) {
            // A closed-world action (openWorldHint false) must also send nothing at all.
            const outcome = await readOnlyCall(w, tool.name, input, tool.name + ' ' + action, {
              closedWorld: !h.openWorldHint,
            });
            calls++;
            if (!h.openWorldHint) closed++;
            if (outcome.success) succeeded++;
            reads += outcome.reads;
          }
        }
    } finally {
      w.close();
    }
  }
  // Every native action whose operation help presents it as read-only, in a writes deployment.
  const w = world(registry, true);
  try {
    const schemas = new Map(w.service.listTools().map(t => [t.name, t.inputSchema]));
    for (const row of ledger) {
      const tool = registry.tools.get(row.gateway),
        h = nativeHints(row);
      if (!tool || !h.readOnlyHint) continue;
      presented++;
      const {read, write} = bags(w, row.gateway);
      let inputs;
      if (tool.mode === 'delegated') {
        const op = tool.operations.find(o => o.operation === row.operation);
        if (!op) continue;
        const enumerated = op.argumentsSchema?.properties?.action?.enum;
        inputs = [read, write].map(bag => ({
          operation: row.operation,
          arguments: fill({...bag, ...(enumerated ? {action: row.action} : {})}, op.argumentsSchema),
        }));
      } else {
        const route = registry.action(row.gateway, row.action),
          params = Object.fromEntries((route?.path_parameters ?? []).map(p => [p, '1001'])),
          schema = schemas.get(row.gateway) ?? {};
        inputs = [read, write].map(bag => ({...fill({...bag, path_params: params}, schema), action: row.action}));
      }
      for (const input of inputs) {
        const outcome = await readOnlyCall(
          w,
          row.gateway,
          input,
          row.gateway + ' ' + (row.operation ?? '') + ' ' + row.action,
          {closedWorld: !h.openWorldHint},
        );
        calls++;
        if (!h.openWorldHint) closed++;
        if (outcome.success) succeeded++;
        reads += outcome.reads;
      }
    }
  } finally {
    w.close();
  }
  // The walk reached the providers and completed calls, so it exercised more than argument validation (on 2026-10-22:
  // 3,381 actions presented as read-only, 6,759 calls, 1,107 succeeded, 497 provider reads).
  assert.ok(presented > 3000, 'presented ' + presented);
  assert.ok(calls > 6000, 'calls ' + calls);
  assert.ok(succeeded > 900, 'succeeded ' + succeeded);
  assert.ok(reads > 400, 'reads ' + reads);
  // On 2026-10-23: 3,125 calls of actions presented as closed-world, none of which sent a request.
  assert.ok(closed > 3000, 'closed-world calls ' + closed);
});
