// Run from the repository root after building its unchanged HEAD:
// node --test .runtime/review-20261001/reporting-media-reproductions.mjs
// All provider responses and media inspection are synthetic; SQLite is in memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const moduleAt = name => import(pathToFileURL(path.resolve('dist/src/' + name + '.js')).href);
const {xCampaignReport} = await moduleAt('x-campaign-report');
const {Store} = await moduleAt('store');
const {MediaSources} = await moduleAt('media-sources');

test('adjacent X periods must not count a boundary hour twice in a half-hour account timezone', async () => {
  const start = Date.parse('2026-09-21T18:30:00Z'); // Midnight in Asia/Kolkata.
  const day = 86400000;
  const collect = (from, until) =>
    xCampaignReport([{id: 'c1'}], from, until, [], async query => {
      const hours = (Date.parse(query.end_time) - Date.parse(query.start_time)) / 3600000;
      const n = query.placement === 'ALL_ON_TWITTER' ? 1 : 0;
      return {
        data: [
          {
            id: 'c1',
            id_data: [
              {
                segment: null,
                metrics: {
                  impressions: Array(hours).fill(n),
                  billed_charge_local_micro: Array(hours).fill(n * 1000000),
                },
              },
            ],
          },
        ],
      };
    });
  const first = await collect(start, start + day);
  const second = await collect(start + day, start + 2 * day);
  const total = await collect(start, start + 2 * day);
  const observed = {
    daily_impressions: [first.rows[0].metrics.impressions, second.rows[0].metrics.impressions],
    daily_sum: first.rows[0].metrics.impressions + second.rows[0].metrics.impressions,
    total_impressions: total.rows[0].metrics.impressions,
    daily_spend_sum: first.rows[0].metrics.spend + second.rows[0].metrics.spend,
    total_spend: total.rows[0].metrics.spend,
    complete: [first.complete, second.complete, total.complete],
  };
  console.log('X_BOUNDARY_REPRO ' + JSON.stringify(observed));
  assert.equal(observed.daily_sum, observed.total_impressions);
  assert.equal(observed.daily_spend_sum, observed.total_spend);
});

test('removing a media source during inspection must not resurrect a completed source without bytes', async () => {
  const actor = {tenantId: 'synthetic-media-race', userId: 'owner', role: 'admin'};
  const store = new Store(':memory:', Buffer.alloc(32, 43).toString('base64'));
  const media = new MediaSources(store, true);
  const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  let finishInspection;
  media.inspect = async () =>
    new Promise(resolve => {
      finishInspection = resolve;
    });
  try {
    const begun = media.begin(actor, {filename: 'synthetic.png', size: bytes.length, type: 'image/png'});
    media.put(actor, begun.source_id, 0, bytes);
    const completion = media.complete(actor, begun.source_id);
    media.remove(actor, begun.source_id);
    finishInspection({width: 1, height: 1, inspection: 'complete'});
    let result;
    try {
      result = await completion;
    } catch (error) {
      result = {error: error.code};
    }
    let fileError;
    try {
      media.file(actor, begun.source_id);
    } catch (error) {
      fileError = error.code;
    }
    const observed = {
      completion_state: result.state ?? null,
      completion_error: result.error ?? null,
      visible_sources_after_removal: media.list(actor).length,
      file_error: fileError,
    };
    console.log('MEDIA_REMOVAL_REPRO ' + JSON.stringify(observed));
    assert.equal(observed.visible_sources_after_removal, 0);
    assert.notEqual(observed.completion_state, 'complete');
  } finally {
    store.close();
  }
});
