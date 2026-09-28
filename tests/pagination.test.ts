import test from 'node:test';
import assert from 'node:assert/strict';
import {paginate} from '../src/pagination.js';
import type {CompiledRequest} from '../src/types.js';
const plan: CompiledRequest = {
  gateway: 'meta_native_action',
  action: 'list',
  method: 'GET',
  path: '/v26.0/act_123/campaigns',
  query: {},
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '123',
  evidence: 'TEST',
  warnings: [],
};
test('pagination merges every returned row and marks page caps explicitly', async () => {
  const response = await paginate(
    plan,
    async p =>
      p.query.after
        ? {data: [{id: '2'}]}
        : {data: [{id: '1'}], paging: {next: 'https://graph.facebook.com/next', cursors: {after: 'a'}}},
    5,
  );
  assert.deepEqual((response.data as any).data, [{id: '1'}, {id: '2'}]);
  assert.equal(response.truncated, false);
  assert.equal(response.pages, 2);
  const capped = await paginate(
    plan,
    async () => ({data: [{id: '1'}], paging: {next: 'https://graph.facebook.com/next', cursors: {after: 'a'}}}),
    1,
  );
  assert.equal(capped.truncated, true);
});
test('repeated cursors fail instead of silently duplicating data', async () => {
  await assert.rejects(
    paginate(
      plan,
      async () => ({data: [], paging: {next: 'https://graph.facebook.com/next', cursors: {after: 'a'}}}),
      5,
    ),
    /repeated/,
  );
});
