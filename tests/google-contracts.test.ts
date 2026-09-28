import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {validateGoogleRequest, googleContractEvidence, googleJson} from '../src/google-contracts.js';
import {NativeTransport} from '../src/transport.js';
import {campaignRecipe} from '../src/campaign-recipes.js';
import type {CompiledRequest, Connection, JsonObject} from '../src/types.js';
const plan = (body: JsonObject, path = '/v23/customers/123/campaigns:mutate'): CompiledRequest => ({
  gateway: 'google_ads_native_action',
  accountId: '123',
  action: 'test',
  method: 'POST',
  path,
  body,
  query: {},
  headers: {},
  readOnly: false,
  destructive: false,
  requiresConfirmation: true,
  evidence: 'SYNTHETIC',
  warnings: [],
});
test('Google native routes map to all 171 original RPCs with first-party request schemas and pinned integrity', () => {
  const artifact = JSON.parse(fs.readFileSync('generated/vendor-routes.json', 'utf8')),
    envelope = JSON.parse(fs.readFileSync('.mirror/VENDOR/google-ads-v23.json', 'utf8')),
    registry = JSON.parse(fs.readFileSync('generated/registry.json', 'utf8'));
  const source = new Map<string, JsonObject>();
  function visit(d: JsonObject) {
    for (const m of Object.values(d.methods ?? {}) as JsonObject[]) source.set(m.id, m);
    for (const r of Object.values(d.resources ?? {}) as JsonObject[]) visit(r);
  }
  visit(envelope.document);
  assert.equal(source.size, 176);
  assert.equal(Object.keys(envelope.document.schemas).length, 1443);
  const routes = artifact.routes.filter((r: JsonObject) => r.gateway === 'google_ads_native_action');
  assert.equal(routes.length, 171);
  assert.deepEqual(
    new Set(routes.map((r: JsonObject) => r.action)),
    new Set(
      registry.catalogs
        .find((r: JsonObject) => r.gateway === 'google_ads_native_action')
        .actions.filter((a: JsonObject) => a.raw.surface === 'rpc')
        .map((a: JsonObject) => a.name),
    ),
  );
  for (const r of routes) {
    const official = source.get(r.vendorMethod)!;
    assert.ok(official);
    assert.equal(r.method, official.httpMethod);
    assert.equal(r.flatPath, '/' + (official.flatPath ?? official.path));
    assert.deepEqual(r.requestSchema, official.request ? envelope.document.schemas[official.request.$ref] : undefined);
  }
  assert.equal(
    artifact.sourceIntegrity['google-ads-v23'].document_sha256,
    createHash('sha256').update(JSON.stringify(envelope.document)).digest('hex'),
  );
  assert.equal(
    googleContractEvidence(plan({})).contractEvidence?.vendor_method,
    'googleads.customers.campaigns.mutate',
  );
});
test('Discovery validation rejects obsolete dates, unknown nested fields, bad enums and inexact money before egress', async () => {
  const valid = {
    operations: [
      {
        create: {
          name: 'Synthetic',
          status: 'PAUSED',
          start_date_time: '2026-10-01 00:00:00',
          end_date_time: '2026-10-31 23:59:59',
        },
      },
    ],
  };
  validateGoogleRequest(plan(valid));
  for (const create of [
    {name: 'Synthetic', start_date: '20261001'},
    {name: 'Synthetic', end_date: '20261031'},
    {status: 'MAYBE_PAUSED'},
    {network_settings: {invented_flag: true}},
  ])
    assert.throws(() => validateGoogleRequest(plan({operations: [{create}]})), {code: 'INVALID_VENDOR_BODY'});
  for (const amount_micros of ['9223372036854775808', 9007199254740992, '12.5'])
    assert.throws(
      () =>
        validateGoogleRequest(
          plan({operations: [{create: {amount_micros}}]}, '/v23/customers/123/campaignBudgets:mutate'),
        ),
      {code: 'INVALID_VENDOR_BODY'},
    );
  validateGoogleRequest(
    plan({operations: [{create: {amount_micros: '9007199254740993'}}]}, '/v23/customers/123/campaignBudgets:mutate'),
  );
  assert.throws(() => googleJson({amount_micros: '1', amountMicros: '2'}), {code: 'CONFLICTING_PARAMETER'});
  let requests = 0;
  const t = new NativeTransport(async () => {
    requests++;
    return Response.json({});
  });
  await assert.rejects(() => t.request(plan({invented: true}), {} as Connection, {accessToken: 'synthetic'}), {
    code: 'INVALID_VENDOR_BODY',
  });
  assert.equal(requests, 0);
});

test('date-only Google recipe boundaries use v23 account-local datetime fields', () => {
  const fixture = JSON.parse(
    fs.readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).recipe_business;
  const built = campaignRecipe('google_search', {...fixture, start_date: '2026-10-01', end_date: '2026-10-31'}),
    body = built.steps.find((s: JsonObject) => s.id === 'campaign').arguments.payload;
  const campaign = body.operations[0].create;
  assert.equal(campaign.start_date_time, '2026-10-01 00:00:00');
  assert.equal(campaign.end_date_time, '2026-10-31 23:59:59');
  assert.equal('start_date' in campaign, false);
  assert.equal('end_date' in campaign, false);
  // A dependency reference is resolved by the runner before validation/transport.
  validateGoogleRequest(
    plan({...body, operations: [{create: {...campaign, campaign_budget: 'customers/123/campaignBudgets/1'}}]}),
  );
});
