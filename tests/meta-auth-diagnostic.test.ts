import test from 'node:test';
import assert from 'node:assert/strict';
import {readMetaPermissions} from '../src/meta-auth-diagnostic.js';
import {NativeTransport} from '../src/transport.js';
import type {Connection} from '../src/types.js';

const connection: Connection = {
  id: 'test',
  tenantId: 'test',
  gateway: 'meta_native_action',
  accounts: ['111'],
  label: 'synthetic',
  enabled: true,
  scopes: [],
};
test('Meta credential diagnostic distinguishes absent, declined and granted scopes without account access claims', async () => {
  const run = (data: unknown) =>
    readMetaPermissions(
      new NativeTransport((async (url, init) => {
        const target = new URL(String(url));
        assert.equal(target.origin, 'https://graph.facebook.com');
        assert.equal(target.pathname, '/v26.0/me/permissions');
        assert.equal(init?.method, 'GET');
        assert.equal(init?.body, undefined);
        assert.equal(target.searchParams.get('access_token'), null);
        return new Response(JSON.stringify(data));
      }) as typeof fetch),
      connection,
      {accessToken: 'synthetic'},
    );
  const missing = await run({
    data: [
      {permission: 'public_profile', status: 'granted'},
      {permission: 'ads_read', status: 'declined'},
    ],
  });
  assert.equal(missing.ads_read_granted, false);
  assert.equal(missing.account_access_verified, false);
  const granted = await run({data: [{permission: 'ads_read', status: 'granted'}]});
  assert.equal(granted.ads_read_granted, true);
  assert.equal(granted.ads_management_granted, false);
  const partial = await run({data: [], paging: {next: 'https://graph.facebook.com/next'}});
  assert.equal(partial.ads_read_granted, null);
  assert.equal(partial.complete, false);
  for (const malformed of [{}, {data: [{permission: 'ads_read'}]}, {data: [], paging: []}])
    await assert.rejects(run(malformed), (e: any) => e.code === 'UPSTREAM_RESPONSE_INVALID');
});
