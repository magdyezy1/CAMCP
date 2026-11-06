// V2-PRV-01 hardening of amcp_ad_previews (audit F-L3-12 and F-L3-13): the platform is checked against the tool's own
// list before anything else, and a link whose separators are spelled as entities is not a platform link.
import test from 'node:test';
import assert from 'node:assert/strict';
import {AdPreviews, previewLinks} from '../dist/src/ad-previews.js';
import {Store} from '../dist/src/store.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const actor = {tenantId: 'synthetic-preview-hardening', userId: 'owner', role: 'admin'};
const fixture = t => {
  const store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64')),
    reads = [];
  t.after(() => store.close());
  const call = async (_tool, input) => {
    reads.push(input);
    return assert.fail('no read');
  };
  return {reads, previews: new AdPreviews(call, store)};
};

test('F-L3-12: a platform outside the schema is refused first, with no read, whatever else the request holds', async t => {
  const {previews, reads} = fixture(t);
  // Names a plain object answers to, a differently spelt platform, a platform of another kind and a missing one.
  const platforms = [
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'Meta',
    'meta ',
    '',
    undefined,
    null,
    7,
    ['meta'],
    {},
  ];
  // Each is refused for the platform even when the request is also wrong elsewhere: the platform is checked first.
  for (const platform of platforms)
    for (const extra of [{}, {account_id: ' '}, {limit: 99}, {ad_ids: []}, {connection_id: 4}, {cursor: 'x'}])
      await assert.rejects(
        previews.handle({...(platform === undefined ? {} : {platform}), account_id: '1', ...extra}, actor),
        error =>
          assertRefused(error, 'INVALID_ARGUMENT', {message: /^Choose a platform from the schema\.$/}) &&
          error.details.field === 'platform',
        JSON.stringify([platform, extra]),
      );
  assert.equal(reads.length, 0);
  // The platforms of the schema still answer.
  for (const platform of ['google_ads', 'x_ads', 'microsoft_ads', 'dv360', 'criteo', 'apple_ads']) {
    const out = await previews.handle({platform, account_id: '1'}, actor);
    assert.equal(out.platform, platform);
    assert.deepEqual(out.previews, []);
  }
});
