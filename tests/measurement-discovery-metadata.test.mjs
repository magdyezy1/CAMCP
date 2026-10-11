import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../dist/src/store.js';
import {platform} from '../dist/server/platform-oauth.js';
import {AssetDiscovery} from '../dist/server/asset-discovery.js';

// MSR-03 slice B: website discovery keeps a GA4 data stream's native type and web measurement ID, and a Tag Manager
// container's public ID and Google tag IDs, so Measurement can check trace streams and relate Google tags to streams
// from stored inventory. Before this, discovery kept only {id, name, parentId} and these questions needed a new read.
const owner = {tenantId: 'local', userId: 'test', role: 'admin'};
const json = value => new Response(JSON.stringify(value), {status: 200, headers: {'Content-Type': 'application/json'}});
const connection = (gateway, accounts) => ({
  id: randomUUID(),
  tenantId: 'local',
  gateway,
  accounts,
  label: 'Synthetic provider',
  enabled: true,
  scopes: [],
});

test('MSR-03 discovery retains GA4 stream type and measurement ID, and container tag IDs, when well formed', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 85).toString('base64'));
  try {
    const discovery = new AssetDiscovery(store, async input => {
      const url = new URL(String(input));
      if (url.pathname === '/v1beta/properties/123/dataStreams')
        return json({
          dataStreams: [
            {
              name: 'properties/123/dataStreams/9',
              type: 'WEB_DATA_STREAM',
              displayName: 'Web',
              webStreamData: {measurementId: 'G-ABC123', defaultUri: 'https://example.test'},
            },
            {
              name: 'properties/123/dataStreams/10',
              type: 'ANDROID_APP_DATA_STREAM',
              displayName: 'Android',
              androidAppStreamData: {packageName: 'test.example'},
            },
            // A malformed measurement ID or an unknown type is left out rather than guessed.
            {name: 'properties/123/dataStreams/11', type: 'WEB_DATA_STREAM', webStreamData: {measurementId: 'UA-1'}},
            {name: 'properties/123/dataStreams/12', type: 'FUTURE_STREAM'},
          ],
        });
      if (url.pathname === '/tagmanager/v2/accounts/44/containers')
        return json({
          container: [
            {
              accountId: '44',
              containerId: '5',
              name: 'Google tag',
              publicId: 'GT-ABCD12',
              tagIds: ['G-ABC123', 'AW-123456', 'G-ABC123', 'bad id'],
            },
            {accountId: '44', containerId: '6', name: 'Web', publicId: 'GTM-XYZ9'},
          ],
        });
      throw Error('Unexpected discovery URL ' + url.pathname);
    });
    const ga4 = connection(platform('ga4').gateway, ['123']);
    store.putConnection(owner, ga4, {accessToken: 'synthetic'});
    const streams = (await discovery.sync(ga4, ['data_streams'])).groups[0];
    assert.equal(streams.complete, true, streams.error);
    assert.deepEqual(
      streams.assets.map(a => [a.id, a.streamType ?? null, a.measurementId ?? null]),
      [
        ['properties/123/dataStreams/9', 'WEB_DATA_STREAM', 'G-ABC123'],
        ['properties/123/dataStreams/10', 'ANDROID_APP_DATA_STREAM', null],
        ['properties/123/dataStreams/11', 'WEB_DATA_STREAM', null],
        ['properties/123/dataStreams/12', null, null],
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(streams),
      /example\.test|test\.example/,
      'stream URLs and packages are not kept',
    );
    const gtm = connection(platform('gtm').gateway, ['44']);
    store.putConnection(owner, gtm, {accessToken: 'synthetic'});
    const containers = (await discovery.sync(gtm, ['containers'])).groups[0];
    assert.equal(containers.complete, true, containers.error);
    assert.deepEqual(
      containers.assets.map(a => [a.id, a.publicId ?? null, a.tagIds ?? null]),
      [
        ['accounts/44/containers/5', 'GT-ABCD12', ['G-ABC123', 'AW-123456']],
        ['accounts/44/containers/6', 'GTM-XYZ9', null],
      ],
    );
  } finally {
    store.close();
  }
});
