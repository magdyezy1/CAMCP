import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {ScopeGuard} from '../dist/src/scope.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {
  snapchatEvidenceInput as input,
  snapchatEvidenceCampaign as campaign,
  snapchatEvidenceId as id,
} from './fixtures/snapchat-evidence-data.mjs';

test('failed Snapchat account wrapper cannot establish organization pixel-list ownership', () => {
  const actor = {tenantId: 'snapchat-org-evidence', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 120).toString('base64'));
  try {
    const connection = {
      id: input.connection_id,
      tenantId: actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: [input.account_id],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    };
    store.putConnection(actor, connection, {accessToken: 'synthetic'});
    new ScopeGuard(new Registry(), store).observe(
      {
        gateway: 'snapchat_native_action',
        accountId: input.account_id,
        action: 'snapchat_account_get',
        method: 'GET',
        path: '/v1/adaccounts/' + input.account_id,
        query: {},
        headers: {},
        readOnly: true,
        destructive: false,
        requiresConfirmation: false,
        evidence: 'Synthetic',
        warnings: [],
      },
      connection,
      {
        request_status: 'SUCCESS',
        adaccounts: [{sub_request_status: 'ERROR', adaccount: {id: input.account_id, organization_id: id(600)}}],
      },
    );
    assert.equal(store.ownsResource(connection, input.account_id, 'organizations/' + id(600)), false);
  } finally {
    store.close();
  }
});

test('failed Snapchat entity wrapper cannot renew an original ownership observation', t => {
  let at = Date.now();
  const start = at;
  t.mock.method(Date, 'now', () => at);
  const actor = {tenantId: 'snapchat-renew-evidence', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 121).toString('base64'));
  try {
    const connection = {
      id: input.connection_id,
      tenantId: actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: [input.account_id],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    };
    store.putConnection(actor, connection, {accessToken: 'synthetic'});
    store.rememberResource(connection, input.account_id, 'campaigns/' + campaign);
    at = start + 240000;
    new ScopeGuard(new Registry(), store).observe(
      {
        gateway: 'snapchat_native_action',
        accountId: input.account_id,
        action: 'snapchat_campaign_get',
        method: 'GET',
        path: '/v1/campaigns/' + campaign,
        query: {},
        headers: {},
        readOnly: true,
        destructive: false,
        requiresConfirmation: false,
        evidence: 'Synthetic',
        warnings: [],
      },
      connection,
      {
        request_status: 'SUCCESS',
        campaigns: [{sub_request_status: 'ERROR', campaign: {id: campaign, ad_account_id: input.account_id}}],
      },
    );
    at = start + 310000;
    assert.equal(store.ownsResource(connection, input.account_id, 'campaigns/' + campaign), false);
  } finally {
    store.close();
  }
});

for (const kind of [
  'failed_read',
  'failed_item',
  'foreign_account',
  'coerced_account',
  'matching_account',
  'account_edge_without_owner_column',
])
  test('Snapchat account collection ownership evidence: ' + kind, () => {
    const actor = {tenantId: 'snapchat-ownership-evidence', userId: 'owner', role: 'admin'},
      store = new Store(':memory:', Buffer.alloc(32, 118).toString('base64'));
    try {
      const connection = {
        id: input.connection_id,
        tenantId: actor.tenantId,
        gateway: 'snapchat_native_action',
        accounts: [input.account_id],
        enabled: true,
        label: 'Synthetic',
        scopes: [],
      };
      store.putConnection(actor, connection, {accessToken: 'synthetic'});
      const data = {
        request_status: 'SUCCESS',
        campaigns: [{sub_request_status: 'SUCCESS', campaign: {id: campaign, ad_account_id: input.account_id}}],
      };
      if (kind === 'failed_read') data.request_status = 'ERROR';
      if (kind === 'failed_item') data.campaigns[0].sub_request_status = 'ERROR';
      if (kind === 'foreign_account') data.campaigns[0].campaign.ad_account_id = id(999);
      if (kind === 'coerced_account') data.campaigns[0].campaign.ad_account_id = [input.account_id];
      if (kind === 'account_edge_without_owner_column') delete data.campaigns[0].campaign.ad_account_id;
      new ScopeGuard(new Registry(), store).observe(
        {
          gateway: 'snapchat_native_action',
          accountId: input.account_id,
          action: 'snapchat_campaign_list',
          method: 'GET',
          path: '/v1/adaccounts/' + input.account_id + '/campaigns',
          query: {},
          headers: {},
          readOnly: true,
          destructive: false,
          requiresConfirmation: false,
          evidence: 'Synthetic',
          warnings: [],
        },
        connection,
        data,
      );
      assert.equal(
        store.ownsResource(connection, input.account_id, 'campaigns/' + campaign),
        ['matching_account', 'account_edge_without_owner_column'].includes(kind),
      );
    } finally {
      store.close();
    }
  });

for (const kind of ['failed_item', 'foreign_account', 'coerced_account'])
  test('unqualified Snapchat collection cannot enable later global stats egress: ' + kind, async () => {
    const actor = {tenantId: 'snapchat-global-read', userId: 'reader', role: 'reader'},
      store = new Store(':memory:', Buffer.alloc(32, 119).toString('base64')),
      requests = [];
    try {
      store.putConnection(
        {...actor, role: 'admin'},
        {
          id: input.connection_id,
          tenantId: actor.tenantId,
          gateway: 'snapchat_native_action',
          accounts: [input.account_id],
          enabled: true,
          label: 'Synthetic',
          scopes: ['snapchat-marketing-api'],
        },
        {accessToken: 'synthetic'},
      );
      const data = {
        request_status: 'SUCCESS',
        campaigns: [{sub_request_status: 'SUCCESS', campaign: {id: campaign, ad_account_id: input.account_id}}],
      };
      if (kind === 'failed_item') data.campaigns[0].sub_request_status = 'ERROR';
      if (kind === 'foreign_account') data.campaigns[0].campaign.ad_account_id = id(999);
      if (kind === 'coerced_account') data.campaigns[0].campaign.ad_account_id = [input.account_id];
      const service = new MirrorService(
        new Registry(),
        store,
        new NativeTransport(async raw => {
          requests.push(String(raw));
          return Response.json(data);
        }),
      );
      await service.call(
        'snapchat_native_action',
        {
          action: 'snapchat_campaign_list',
          account_id: input.account_id,
          connection_id: input.connection_id,
          path_params: {ad_account_id: input.account_id},
        },
        actor,
      );
      const read = await service.call(
        'snapchat_native_action',
        {
          action: 'snapchat_campaign_stats_get',
          account_id: input.account_id,
          connection_id: input.connection_id,
          path_params: {campaign_id: campaign},
          query: {granularity: 'DAY', breakdown: 'adsquad'},
        },
        actor,
      );
      assert.equal(read.success, false, JSON.stringify(read));
      assert.equal(read.error.code, 'RESOURCE_SCOPE_REQUIRED');
      assert.equal(requests.length, 1);
    } finally {
      store.close();
    }
  });
