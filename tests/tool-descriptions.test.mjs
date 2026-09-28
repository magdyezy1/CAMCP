import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';

test('every AMCP extension tool says when to use it rather than its neighbour', () => {
  const store = new Store(':memory:');
  try {
    const service = new MirrorService(new Registry(), store, undefined, undefined, {
      allowWrites: true,
      maxBudgetChange: 0,
      requireBeforeState: true,
    });
    const tools = Object.fromEntries(service.listTools().map(t => [t.name, t.description]));
    const neighbours = {
      amcp_write: /amcp_campaign/,
      amcp_campaign: /amcp_write/,
      amcp_reporting: /amcp_reporting_overview/,
      amcp_reporting_overview: /amcp_reporting\b/,
      amcp_workspace: /write contracts/,
      amcp_media: /Google Drive/,
      amcp_ad_previews: /amcp_media/,
    };
    for (const [name, neighbour] of Object.entries(neighbours)) {
      assert.match(tools[name], /^Use this /, name);
      assert.match(tools[name].split('. ')[0] + '. ' + tools[name].split('. ')[1], neighbour, name);
    }
    // The key defaults to the review id (batch 2); the description must not ask for it.
    assert.doesNotMatch(tools.amcp_write, /requires its review_id, idempotency_key/);
    assert.match(tools.amcp_write, /idempotency_key defaults to the review_id/);
    assert.match(tools.amcp_write, /execute_requirements/);
  } finally {
    store.close();
  }
});
