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
test('LinkedIn search finders page by cursor: every page is followed, and a page without a cursor is the last', async () => {
  const li: CompiledRequest = {
    ...plan,
    gateway: 'linkedin_native_action',
    path: '/rest/adAccounts/123/creatives',
    query: {q: 'criteria', campaigns: ['urn:li:sponsoredCampaign:1'], pageSize: 2},
  };
  const pages: Record<string, unknown> = {
    '': {metadata: {nextPageToken: 'b'}, elements: [{id: 1}, {id: 2}], paging: {start: 0, count: 2, links: []}},
    b: {metadata: {nextPageToken: 'c'}, elements: [{id: 3}, {id: 4}], paging: {start: 0, count: 2, links: []}},
    c: {metadata: {}, elements: [{id: 5}], paging: {start: 0, count: 2, links: []}},
  };
  const asked: unknown[] = [];
  const response = await paginate(
    li,
    async p => {
      asked.push(p.query.pageToken ?? null);
      assert.equal(p.query.start, undefined, 'a cursor read never gains an offset');
      return pages[String(p.query.pageToken ?? '')];
    },
    5,
  );
  assert.deepEqual(
    (response.data as any).elements.map((e: any) => e.id),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(asked, [null, 'b', 'c']);
  assert.equal(response.truncated, false);
  // Offset finders still page by start and total.
  const offset = await paginate(
    {...li, query: {q: 'account', start: 0, count: 1}},
    async p => ({elements: [{id: p.query.start}], paging: {start: p.query.start, count: 1, total: 2}}),
    5,
  );
  assert.deepEqual((offset.data as any).elements, [{id: 0}, {id: 1}]);
  await assert.rejects(
    paginate(li, async () => ({metadata: {nextPageToken: 'same'}, elements: []}), 5),
    /repeated/,
  );
});
