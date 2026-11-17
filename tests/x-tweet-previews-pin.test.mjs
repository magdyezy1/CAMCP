// Package r12-xpreview, item 1: the route of X's Tweet preview read is pinned. X's `tweet_previews` read was classified a native
// read whose method and path rested on the frozen captured catalog alone (`route_anchor: captured_only`, so help and the
// contracts page carried the advisory `read_unanchored`), and no document of AMCP's stated its parameters. The route is now
// anchored to X's public Ads API page, read on 2026-11-16, and docs/records/X-TWEET-PREVIEWS-PIN-2026-11-16.md states the
// documented parameters, the shape of the live answer and the date. The anchor is evidence only: it never enables, blocks or
// reclassifies a route (tests/route-anchors.test.mjs holds that), so the neighbouring X reads keep their advisory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {anchoredStatuses, readUnanchored, routeAnchorKey} from '../dist/src/route-anchors.js';
import {documentedRoutes, routeAnchorDocumentsFile} from '../dist/tools/route-anchors.js';

const gateway = 'x_ads_native_action',
  action = 'x_accounts_account_id_tweet_previews_get',
  record = 'docs/records/X-TWEET-PREVIEWS-PIN-2026-11-16.md',
  page = 'https://docs.x.com/x-ads-api/creatives/reference.md',
  registry = new Registry(),
  rows = actionContracts(registry),
  row = rows.find(r => r.gateway === gateway && r.action === action),
  lf = file => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');

function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64')),
    requests = [],
    service = new MirrorService(
      registry,
      store,
      new NativeTransport(async raw => {
        requests.push(String(raw));
        throw new Error('no provider request is expected');
      }),
    ),
    actor = {tenantId: 'x-tweet-previews-pin', userId: 'owner', role: 'admin'};
  t.after(() => store.close());
  return {requests, call: (tool, input) => service.call(tool, input, actor)};
}

test('the dated record states the documented parameters, the live answer’s shape and the date, with front matter and no live value', () => {
  assert.ok(fs.existsSync(record), record + ' exists');
  const text = lf(record);
  assert.match(text, /^---\nstatus: record\ntier: engineering\n---\n\n# [^\n]*Tweet preview/);
  assert.match(text, /2026-11-16/);
  // The route, as the public page documents it, and the page it was read from.
  assert.match(text, /GET \/12\/accounts\/:account_id\/tweet_previews/);
  assert.ok(text.includes(page), 'names the page it was read from');
  // tweet_ids: required, comma separated, up to 200; tweet_type: required, DRAFT, PUBLISHED or SCHEDULED.
  assert.match(text, /`tweet_ids`[^\n]*required[^\n]*comma[^\n]*\b200\b/i);
  assert.match(text, /`tweet_type`[^\n]*required[^\n]*`DRAFT`[^\n]*`PUBLISHED`[^\n]*`SCHEDULED`/i);
  // The shape of the answer: a data array of {tweet_id, preview}, the preview one iframe whose src is on ton.twimg.com.
  assert.match(text, /`data`[^\n]*`tweet_id`[^\n]*`preview`/);
  assert.match(text, /ton\.twimg\.com/);
  assert.match(text, /\/ads-manager\/tweet-preview\/index\.html/);
  // X states no expiry: the record says so, as the tool does not invent one.
  assert.match(text, /no expiry/i);
  // Synthetic shapes only: no Tweet ID, no link payload, no account of the live check (the lead's rule for fixtures).
  assert.doesNotMatch(text, /\b[0-9]{15,}\b/, 'no Tweet ID');
  assert.doesNotMatch(text, /data=[A-Za-z0-9%+/=_-]{12,}/, 'no preview payload');
  assert.doesNotMatch(text, /H4sI/, 'no encoded payload');
});

test('the route is anchored to the dated page, with the date it was read, and is no longer a read without vendor evidence', () => {
  assert.ok(row, action + ' is a routed ledger row');
  assert.equal(row.status, 'native_read', 'anchors never reclassify a route');
  assert.equal(row.anchor_status, 'documented_url');
  assert.ok(anchoredStatuses.has(row.anchor_status));
  assert.deepEqual(row.anchor, {source: page, checked_at: '2026-11-16'});
  assert.equal(readUnanchored(row), false);
  // The entry of the documented routes table is exactly this route, and its note names the record that states the facts.
  const entry = documentedRoutes(lf(routeAnchorDocumentsFile)).find(d => routeAnchorKey(d) === routeAnchorKey(row));
  assert.deepEqual([entry?.method, entry?.path, entry?.url, entry?.checked_at], ['GET', row.path, page, '2026-11-16']);
  assert.equal(row.path, '/12/accounts/{account_id}/tweet_previews');
  assert.ok(entry.note.includes('X-TWEET-PREVIEWS-PIN-2026-11-16'), 'the note names the record');
});

test('help and amcp_workspace contracts show the route anchored, and anchoring one route anchors no other X read', async t => {
  const f = fixture(t);
  const help = await f.call('amcp_tool_help', {gateway, operation: action});
  assert.equal(help.success, true, JSON.stringify(help.error));
  assert.equal(help.data.amcp_execution.status, 'native_read');
  assert.equal(help.data.amcp_execution.route_anchor, 'documented_url');
  assert.equal(help.data.amcp_execution.advisory, undefined, 'the read_unanchored advisory is gone');
  const contracts = await f.call('amcp_workspace', {action: 'contracts', gateway, search: 'tweet_previews', limit: 10});
  assert.equal(contracts.success, true, JSON.stringify(contracts.error));
  const listed = contracts.data.actions.find(a => a.action === action);
  assert.equal(listed?.anchor_status, 'documented_url');
  assert.deepEqual(listed.anchor, {source: page, checked_at: '2026-11-16'});
  assert.deepEqual(contracts.data.anchor_sources[page], {kind: 'documented_url', url: page});
  // The reads the preview resolver sends beside it were not part of this pin: they stay advisory, as they were.
  for (const neighbour of [
    'x_accounts_account_id_promoted_tweets_get',
    'x_accounts_account_id_tweets_get',
    'x_accounts_account_id_line_items_get',
  ]) {
    const other = rows.find(r => r.gateway === gateway && r.action === neighbour);
    assert.equal(other.anchor_status, 'captured_only', neighbour);
    assert.equal(readUnanchored(other), true, neighbour);
  }
  assert.deepEqual(f.requests, [], 'nothing reached a provider');
});
