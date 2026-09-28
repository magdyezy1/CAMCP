import test from 'node:test';
import assert from 'node:assert/strict';
import {checkProviderSpec} from '../dist/tools/provider-drift.js';
const original = {
  source: 'https://www.googleapis.com/discovery/v1/apis/tagmanager/v2/rest',
  document: {
    version: 'v2',
    resources: {
      tags: {methods: {list: {id: 'tagmanager.tags.list', path: 'accounts/{accountId}/tags', httpMethod: 'GET'}}},
    },
  },
};
test('public provider drift distinguishes removed contracts, metadata noise, fetch failures and untrusted sources', async () => {
  assert.equal((await checkProviderSpec(original)).status, 'local_integrity_only');
  assert.equal(
    (
      await checkProviderSpec(original, async () =>
        Response.json({...original.document, description: 'Metadata-only edit'}),
      )
    ).status,
    'unchanged',
  );
  const changed = structuredClone(original.document);
  changed.resources.tags.methods = {
    get: {id: 'tagmanager.tags.get', path: 'tags/{id}', httpMethod: 'GET', deprecated: true},
  };
  const drift = await checkProviderSpec(original, async () => Response.json(changed));
  assert.equal(drift.status, 'drift');
  assert.deepEqual(drift.removed, ['tagmanager.tags.list']);
  assert.deepEqual(drift.deprecated, ['tagmanager.tags.get']);
  assert.equal(drift.live_verified, false);
  assert.equal(
    (await checkProviderSpec(original, async () => new Response('Unavailable', {status: 503}))).status,
    'fetch_failed',
  );
  assert.equal(
    (
      await checkProviderSpec({...original, source: 'https://evil.invalid/secret'}, async () => {
        throw Error('Must not fetch');
      })
    ).status,
    'manual_documentation_review',
  );
});
