import test from 'node:test';
import assert from 'node:assert/strict';
import {metaAssetUsageFixture} from './fixtures/meta-asset-usage-data.mjs';
test('read-only deployments advertise only media metadata and native-reference read actions', async t => {
  const f = metaAssetUsageFixture(t, {allowWrites: false}),
    tools = f.service.listTools(),
    media = tools.find(t => t.name === 'amcp_media');
  assert.ok(media, 'Account-scoped read workflows must be discoverable while native writes are disabled');
  assert.deepEqual(media.inputSchema.properties.action.enum, [
    'list',
    'library',
    'asset',
    'asset_performance',
    'asset_usage',
  ]);
  assert.equal(
    tools.some(t => t.name === 'amcp_write'),
    false,
  );
  assert.equal((await f.call()).success, true);
  assert.ok(f.requests.every(r => r.method === 'GET'));
});
