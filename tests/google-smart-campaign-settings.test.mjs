import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Smart campaign settings, Google Ads API v23 (pinned Discovery document: SmartCampaignSettingService.
 * MutateSmartCampaignSettings and SmartCampaignSetting; checked 2026-09-27).
 */
const gateway = 'google_ads_native_action',
  registry = new Registry(),
  C = 'customers/123/',
  action = 'google_ads_v23_smart_campaign_setting_mutate_smart_campaign_settings';
const actor = {tenantId: 'google-smart-settings', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const setting = id => C + 'smartCampaignSettings/' + id;
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64')),
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
  const settings = new Map([
    [
      '31',
      {
        campaign: {status: 'ENABLED', advertisingChannelType: 'SMART'},
        value: {
          phoneNumber: {phoneNumber: '(650) 555-0100', countryCode: 'US'},
          finalUrl: 'https://shop.example.com',
          advertisingLanguageCode: 'en',
          businessName: 'Example Shop',
        },
      },
    ],
    ['32', {campaign: {status: 'ENABLED', advertisingChannelType: 'SEARCH'}, value: {finalUrl: 'https://example.com'}}],
    [
      '33',
      {campaign: {status: 'REMOVED', advertisingChannelType: 'SMART'}, value: {finalUrl: 'https://old.example.com'}},
    ],
  ]);
  const inList = (query, field) =>
    [...(new RegExp(field + ' IN \\(([^)]*)\\)').exec(query)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        path = decodeURIComponent(u.pathname),
        body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({path, body});
      if (path === '/v23/customers/123/googleAds:search') {
        const names = inList(body.query, 'smart_campaign_setting.resource_name');
        return Response.json({
          results: [...settings]
            .filter(([k]) => names.includes(setting(k)))
            .map(([k, s]) => ({
              smartCampaignSetting: {
                resourceName: setting(k),
                campaign: C + 'campaigns/' + k,
                ...structuredClone(s.value),
              },
              campaign: {resourceName: C + 'campaigns/' + k, ...s.campaign},
            })),
        });
      }
      if (path === '/v23/customers/123/smartCampaignSettings:mutate') {
        writes++;
        return Response.json({
          results: body.operations.map(op => {
            const k = op.update.resourceName.split('/').at(-1),
              v = settings.get(k).value;
            if (mode !== 'ignore')
              for (const f of op.updateMask.split(',')) {
                const [a, b] = f.split('.');
                if (b) {
                  v[a] ??= {};
                  v[a][b] = op.update[a][b];
                } else {
                  v[a] = structuredClone(op.update[a]);
                }
                if (a === 'finalUrl') delete v.adOptimizedBusinessProfileSetting;
                if (a === 'adOptimizedBusinessProfileSetting') delete v.finalUrl;
                if (a === 'businessName') delete v.businessProfileLocation;
                if (a === 'businessProfileLocation') delete v.businessName;
              }
            return {resourceName: mode === 'other' ? setting(99) : op.update.resourceName};
          }),
        });
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
  const update = (id, fields, updateMask) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {
          action,
          account_id: '123',
          payload: {operations: [{update: {resourceName: setting(id), ...fields}, updateMask}]},
        },
      },
      actor,
    );
  const raw = operations =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: '123', payload: {operations}}},
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
  return {store, calls, settings, update, raw, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('the landing page and phone change and verify; the business moves to a Business Profile location and verifies; a replay sends nothing', async () => {
  const f = fixture();
  try {
    const p = ok(
      await f.update(
        '31',
        {finalUrl: 'https://shop.example.com/sale', phoneNumber: {phoneNumber: '(650) 555-0199'}},
        'finalUrl,phoneNumber.phoneNumber',
      ),
    );
    assert.equal(p.data.creative_impact.scope, 'smart_campaign_setting');
    assert.deepEqual(p.data.creative_impact.changes[0].fields.finalUrl, {
      from: 'https://shop.example.com',
      to: 'https://shop.example.com/sale',
    });
    ok(await f.execute(p));
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    const location = ok(
      await f.update('31', {business_profile_location: 'locations/12345'}, 'business_profile_location'),
    );
    ok(await f.execute(location));
    assert.equal(ok(await f.verify(location)).data.status, 'verified');
    assert.equal(f.settings.get('31').value.businessProfileLocation, 'locations/12345');
    assert.equal(f.writes(), 2);
  } finally {
    f.store.close();
  }
});

test('malformed setting updates are refused before any request', async () => {
  const cases = [
    [
      'two landing pages',
      f =>
        f.update(
          '31',
          {finalUrl: 'https://a.example.com', adOptimizedBusinessProfileSetting: {includeLeadForm: true}},
          'finalUrl,adOptimizedBusinessProfileSetting',
        ),
    ],
    [
      'two businesses',
      f =>
        f.update(
          '31',
          {businessName: 'A', businessProfileLocation: 'locations/1'},
          'businessName,businessProfileLocation',
        ),
    ],
    ['relative URL', f => f.update('31', {finalUrl: '/sale'}, 'finalUrl')],
    ['phone letters', f => f.update('31', {phoneNumber: {phoneNumber: 'call us'}}, 'phoneNumber.phoneNumber')],
    ['country name', f => f.update('31', {phoneNumber: {countryCode: 'USA'}}, 'phoneNumber.countryCode')],
    ['language name', f => f.update('31', {advertisingLanguageCode: 'English'}, 'advertisingLanguageCode')],
    ['unmasked field', f => f.update('31', {finalUrl: 'https://a.example.com', businessName: 'A'}, 'finalUrl')],
    ['campaign in a mask', f => f.update('31', {campaign: C + 'campaigns/31'}, 'campaign')],
    ['creation', f => f.raw([{create: {resourceName: setting(31), finalUrl: 'https://a.example.com'}}])],
    [
      'foreign setting',
      f =>
        f.raw([
          {
            update: {resourceName: 'customers/999/smartCampaignSettings/31', finalUrl: 'https://a.example.com'},
            updateMask: 'finalUrl',
          },
        ]),
    ],
  ];
  for (const [label, run] of cases) {
    const f = fixture();
    try {
      const r = await run(f);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label + ': ' + JSON.stringify(r).slice(0, 300));
    } finally {
      f.store.close();
    }
  }
});

test('non-Smart and removed campaigns, unknown settings and unchanged values are refused without writes; a receipt for another setting is never resubmitted; an ignored update is not verified; the ledger lists the write', async () => {
  const f = fixture();
  try {
    assert.equal(
      (await f.update('32', {finalUrl: 'https://b.example.com'}, 'finalUrl')).error?.code,
      'INVALID_GOOGLE_SMART_CAMPAIGN_SETTING',
    );
    assert.equal(
      (await f.update('33', {finalUrl: 'https://b.example.com'}, 'finalUrl')).error?.code,
      'INVALID_GOOGLE_SMART_CAMPAIGN_SETTING',
    );
    assert.equal(
      (await f.update('34', {finalUrl: 'https://b.example.com'}, 'finalUrl')).error?.code,
      'STATE_TARGET_MISMATCH',
    );
    assert.equal(
      (await f.update('31', {advertisingLanguageCode: 'en'}, 'advertisingLanguageCode')).error?.code,
      'INVALID_GOOGLE_SMART_CAMPAIGN_SETTING',
    );
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
  const other = fixture('other');
  try {
    const p = ok(await other.update('31', {businessName: 'New name'}, 'businessName'));
    assert.equal((await other.execute(p)).success, false);
    assert.equal((await other.execute(p)).success, false);
    assert.equal(other.writes(), 1);
  } finally {
    other.store.close();
  }
  const ignored = fixture('ignore');
  try {
    const p = ok(await ignored.update('31', {businessName: 'New name'}, 'businessName'));
    ok(await ignored.execute(p));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
  const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'reviewed_write_family');
  assert.equal(rows[0].family, 'google_smart_campaign_settings');
});
