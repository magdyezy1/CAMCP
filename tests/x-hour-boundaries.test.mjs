// F-L5-29 (M12): X reports whole UTC hours. In an account time zone of a half-hour offset a local day starts in the
// middle of an hour, so each hourly bucket belongs to the day that contains its midpoint: the day owns [start, end), the
// bucket whose midpoint is the boundary between two days belongs to the later one, and no hour is counted twice or lost.
// A mutant that handed the boundary bucket to the earlier day changed both days' totals and every test stayed green.
import test from 'node:test';
import assert from 'node:assert/strict';
import {xCampaignReport} from '../dist/src/x-campaign-report.js';

const hour = 3600000,
  base = Date.parse('2026-09-21T18:00:00Z'),
  // India Standard Time: a local day starts at 18:30 UTC.
  dayOne = Date.parse('2026-09-21T18:30:00Z');

/** The value of a bucket is the number of its hour, so a bucket that changes owner changes the total. */
function provider(requests) {
  return async query => {
    requests.push(query);
    const from = Date.parse(query.start_time),
      count = (Date.parse(query.end_time) - from) / hour,
      values = Array.from({length: count}, (_, i) => (from - base) / hour + i + 1);
    return {
      data: [
        {
          id: 'c1',
          id_data: [{segment: null, metrics: {impressions: values, billed_charge_local_micro: Array(count).fill(0)}}],
        },
      ],
    };
  };
}
const impressions = async (from, to) => {
  const requests = [],
    report = await xCampaignReport([{id: 'c1', name: 'One'}], from, to, [], provider(requests));
  assert.equal(report.complete, true);
  // The report reads the metric once for each group of metrics it asks for; the value is the same in each read.
  return report.rows[0].native_metrics.impressions / requests.length;
};
const sum = (first, last) => ((first + last) * (last - first + 1)) / 2;

test('the hour that straddles the boundary between two half-hour days belongs to the later day', async () => {
  // Day one owns the buckets numbered 1 to 24 (the first starts at 18:00 and its midpoint is the day's start); the bucket
  // numbered 25, whose midpoint is the end of day one, belongs to day two, which owns 25 to 48.
  assert.equal(await impressions(dayOne, dayOne + 24 * hour), sum(1, 24));
  assert.equal(await impressions(dayOne + 24 * hour, dayOne + 48 * hour), sum(25, 48));
});

test('adjacent days, and a day split in two, add up to the whole: no hour is counted twice or lost', async () => {
  const days =
      (await impressions(dayOne, dayOne + 24 * hour)) + (await impressions(dayOne + 24 * hour, dayOne + 48 * hour)),
    span = await impressions(dayOne, dayOne + 48 * hour),
    split =
      (await impressions(dayOne, dayOne + 12 * hour + 1800000)) +
      (await impressions(dayOne + 12 * hour + 1800000, dayOne + 24 * hour));
  assert.equal(span, sum(1, 48));
  assert.equal(days, span);
  assert.equal(split, sum(1, 24), 'a boundary inside the day moves no hour in or out');
});
