import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Google Ads account settings, API v23 (pinned Discovery document: CustomerService.MutateCustomer, Customer and
 * CallReportingSetting; checked 2026-09-27): auto-tagging, tracking template, final URL suffix, descriptive name, call
 * reporting and video brand safety suitability.
 */
const gateway = 'google_ads_native_action',
  registry = new Registry(),
  action = 'google_ads_v23_customer_mutate_customer';
const actor = {tenantId: 'google-customer-settings', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 96).toString('base64')),
    calls = [];
  let writes = 0;
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Google Ads',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const customer = {
    autoTaggingEnabled: true,
    trackingUrlTemplate: '',
    finalUrlSuffix: '',
    descriptiveName: 'Store',
    videoBrandSafetySuitability: 'STANDARD_INVENTORY',
    callReportingSetting: {callReportingEnabled: true, callConversionReportingEnabled: false},
  };
  const actions = {
    'customers/123/conversionActions/55': {name: 'Calls', type: 'AD_CALL', status: 'ENABLED'},
    'customers/123/conversionActions/56': {name: 'Old calls', type: 'AD_CALL', status: 'REMOVED'},
  };
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = decodeURIComponent(u.pathname),
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, body});
      if (path === '/v25/customers/123/googleAds:search') {
        const q = body.query + ' ';
        if (/FROM customer /.test(q))
          return Response.json({
            results: [
              {customer: {resourceName: 'customers/123', id: '123', manager: false, ...structuredClone(customer)}},
            ],
          });
        const m = /conversion_action.resource_name = '([^']+)'/.exec(q);
        if (m)
          return Response.json({
            results: actions[m[1]] ? [{conversionAction: {resourceName: m[1], ...actions[m[1]]}}] : [],
          });
        throw new Error('Unexpected query ' + q);
      }
      if (path === '/v25/customers/123:mutate') {
        writes++;
        const up = body.operation.update;
        if (mode !== 'ignore')
          for (const f of body.operation.updateMask.split(',')) {
            const [top, leaf] = f.split('.');
            if (leaf) customer[top][leaf] = up[top][leaf];
            else customer[top] = structuredClone(up[top]);
          }
        return Response.json({result: {resourceName: mode === 'other' ? 'customers/999' : 'customers/123'}});
      }
      throw new Error('Unexpected ' + path);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const update = (fields, updateMask, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action,
          account_id: '123',
          payload: {operation: {update: {resourceName: 'customers/123', ...fields}, updateMask}, ...extra},
        },
      },
      actor,
    );
  const execute = (p, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, customer, update, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};
const template = 'https://track.example.com/?url={lpurl}&c={campaignid}';

test('tracking settings, the name and call reporting are updated once and verify; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const p = ok(
      await f.update(
        {
          trackingUrlTemplate: template,
          finalUrlSuffix: 'utm_source=google&utm_medium=cpc',
          descriptiveName: 'Store EU',
        },
        'trackingUrlTemplate,finalUrlSuffix,descriptiveName',
      ),
    );
    assert.equal(p.data.creative_impact.scope, 'customer_settings');
    assert.deepEqual(p.data.creative_impact.changes.trackingUrlTemplate, {from: '', to: template});
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const calls = ok(
      await f.update(
        {
          callReportingSetting: {
            callConversionReportingEnabled: true,
            callConversionAction: 'customers/123/conversionActions/55',
          },
        },
        'callReportingSetting.callConversionReportingEnabled,callReportingSetting.callConversionAction',
      ),
    );
    ok(await f.execute(calls));
    assert.equal(ok(await f.verify(calls)).data.status, 'verified');
    assert.equal(f.customer.callReportingSetting.callConversionAction, 'customers/123/conversionActions/55');
    const tagging = ok(await f.update({auto_tagging_enabled: false}, 'auto_tagging_enabled'));
    assert.match(tagging.data.creative_impact.effect, /lose the gclid/);
    ok(await f.execute(tagging));
    assert.equal(ok(await f.verify(tagging)).data.status, 'verified');
    assert.equal(f.customer.autoTaggingEnabled, false);
  } finally {
    f.store.close();
  }
});

test('a video suitability change needs spending confirmation; a broader one counts as activation, a narrower one does not', async () => {
  const f = fixture();
  try {
    const wider = ok(
      await f.update({videoBrandSafetySuitability: 'EXPANDED_INVENTORY'}, 'videoBrandSafetySuitability'),
    );
    assert.equal(wider.data.creative_impact.may_affect_serving, true);
    assert.equal((await f.execute(wider)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(wider, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(wider)).data.status, 'verified');
    const narrower = ok(
      await f.update({videoBrandSafetySuitability: 'LIMITED_INVENTORY'}, 'videoBrandSafetySuitability'),
    );
    assert.equal((await f.execute(narrower)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(narrower, {spend_change_confirmed: true}));
    assert.equal(ok(await f.verify(narrower)).data.status, 'verified');
    saveSpendPolicy(f.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_activation: false}});
    assert.equal(
      (await f.update({videoBrandSafetySuitability: 'STANDARD_INVENTORY'}, 'videoBrandSafetySuitability')).error?.code,
      'POLICY_ACTIVATION_FORBIDDEN',
    );
    ok(await f.update({descriptiveName: 'Allowed'}, 'descriptiveName'));
  } finally {
    f.store.close();
  }
});

test('malformed settings are refused before any request', async () => {
  const cases = [
    ['time zone', {timeZone: 'Europe/Paris'}, 'timeZone'],
    ['unmasked field', {descriptiveName: 'A', finalUrlSuffix: 'a=b'}, 'descriptiveName'],
    ['masked field missing', {}, 'descriptiveName'],
    [
      'template without landing page',
      {trackingUrlTemplate: 'https://track.example.com/?c={campaignid}'},
      'trackingUrlTemplate',
    ],
    ['template with spaces', {trackingUrlTemplate: 'https://t.example.com/?u={lpurl} x'}, 'trackingUrlTemplate'],
    ['suffix with question mark', {finalUrlSuffix: '?utm_source=google'}, 'finalUrlSuffix'],
    ['blank name', {descriptiveName: ' '}, 'descriptiveName'],
    ['unknown suitability', {videoBrandSafetySuitability: 'ALL'}, 'videoBrandSafetySuitability'],
    [
      'foreign call action',
      {callReportingSetting: {callConversionAction: 'customers/999/conversionActions/1'}},
      'callReportingSetting.callConversionAction',
    ],
    [
      'call conversions without calls',
      {
        callReportingSetting: {
          callReportingEnabled: false,
          callConversionReportingEnabled: true,
          callConversionAction: 'customers/123/conversionActions/55',
        },
      },
      'callReportingSetting',
    ],
    [
      'whole and part',
      {callReportingSetting: {callReportingEnabled: true}},
      'callReportingSetting,callReportingSetting.callReportingEnabled',
    ],
    ['other customer', {resourceName: 'customers/124', descriptiveName: 'A'}, 'descriptiveName'],
  ];
  for (const [label, fields, mask] of cases) {
    const f = fixture();
    try {
      const r = await f.update(fields, mask);
      assert.equal(r.success, false, label);
      assert.ok(
        ['INVALID_GOOGLE_CUSTOMER_SETTING', 'ACCOUNT_SCOPE_MISMATCH', 'INVALID_VENDOR_BODY'].includes(r.error?.code),
        label + ': ' + JSON.stringify(r).slice(0, 300),
      );
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
});

test('unchanged settings and unusable conversion actions are refused without writes; a receipt for another customer is a failure never resubmitted; the ledger lists the write', async () => {
  const f = fixture();
  try {
    assert.match(
      (await f.update({descriptiveName: 'Store'}, 'descriptiveName')).error?.message ?? '',
      /already has these settings/,
    );
    assert.equal(
      (
        await f.update(
          {callReportingSetting: {callConversionAction: 'customers/123/conversionActions/56'}},
          'callReportingSetting.callConversionAction',
        )
      ).error?.code,
      'INVALID_GOOGLE_CUSTOMER_SETTING',
    );
    assert.equal(
      (
        await f.update(
          {callReportingSetting: {callConversionAction: 'customers/123/conversionActions/57'}},
          'callReportingSetting.callConversionAction',
        )
      ).error?.code,
      'STATE_TARGET_MISMATCH',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const other = fixture('other');
  try {
    const p = ok(await other.update({descriptiveName: 'X'}, 'descriptiveName'));
    assert.equal((await other.execute(p)).success, false);
    assert.equal((await other.execute(p)).success, false);
    assert.equal(other.writes(), 1);
  } finally {
    other.store.close();
  }
  const ignored = fixture('ignore');
  try {
    const p = ok(await ignored.update({descriptiveName: 'X'}, 'descriptiveName'));
    ok(await ignored.execute(p));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
  const d = JSON.parse(readFileSync('.mirror/VENDOR/google-ads-v25.json', 'utf8')),
    C = (d.document ?? d).schemas.GoogleAdsGoogleadsV25Resources__Customer.properties;
  assert.deepEqual(C.videoBrandSafetySuitability.enum.slice(2), [
    'EXPANDED_INVENTORY',
    'STANDARD_INVENTORY',
    'LIMITED_INVENTORY',
  ]);
  assert.equal(C.timeZone.description.startsWith('Immutable'), true);
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'reviewed_write_family');
  assert.equal(rows[0].family, 'google_customer_settings');
});
