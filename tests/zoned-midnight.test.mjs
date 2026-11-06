import test from 'node:test';
import assert from 'node:assert/strict';
import {zonedMidnight} from '../dist/src/workflows.js';
import {snapchatDailyRange} from '../dist/src/snapchat-evidence.js';
import {assertRefused} from './helpers/assert-refused.mjs';

const at = text => Date.parse(text);
const hour = 3600000;

// Egypt moves its clocks from 00:00 to 01:00 on the last Friday of April, so 2026-04-24 has no 00:00 in Africa/Cairo (the
// change happens at 22:00 UTC on the 23rd). It moves them back at 24:00 on the last Thursday of October, so 2026-10-29
// there lasts 25 hours. Lebanon (last Sunday of March) and Chile (first Sunday from the second of September) also skip
// a local midnight.
test('a day whose local midnight does not exist starts at the first instant after it', () => {
  assert.equal(zonedMidnight('2026-04-23', 'Africa/Cairo'), at('2026-04-22T22:00:00Z'));
  assert.equal(zonedMidnight('2026-04-24', 'Africa/Cairo'), at('2026-04-23T22:00:00Z'));
  assert.equal(zonedMidnight('2026-04-25', 'Africa/Cairo'), at('2026-04-24T21:00:00Z'));
  assert.equal(zonedMidnight('2026-04-25', 'Africa/Cairo') - zonedMidnight('2026-04-24', 'Africa/Cairo'), 23 * hour);
  assert.equal(zonedMidnight('2026-03-29', 'Asia/Beirut'), at('2026-03-28T22:00:00Z'));
  assert.equal(zonedMidnight('2026-09-06', 'America/Santiago'), at('2026-09-06T04:00:00Z'));
});

test('the day around a repeated hour keeps its existing boundaries', () => {
  assert.equal(zonedMidnight('2026-10-29', 'Africa/Cairo'), at('2026-10-28T21:00:00Z'));
  assert.equal(zonedMidnight('2026-10-30', 'Africa/Cairo'), at('2026-10-29T22:00:00Z'));
  assert.equal(zonedMidnight('2026-10-30', 'Africa/Cairo') - zonedMidnight('2026-10-29', 'Africa/Cairo'), 25 * hour);
});

test('ordinary days keep the result every caller already receives', () => {
  for (const [date, zone, expected] of [
    ['2026-09-01', 'UTC', '2026-09-01T00:00:00Z'],
    ['2026-09-01', 'Asia/Riyadh', '2026-08-31T21:00:00Z'],
    ['2026-01-15', 'Africa/Cairo', '2026-01-14T22:00:00Z'],
    ['2026-07-15', 'Africa/Cairo', '2026-07-14T21:00:00Z'],
    ['2026-03-08', 'America/New_York', '2026-03-08T05:00:00Z'],
    ['2026-03-09', 'America/New_York', '2026-03-09T04:00:00Z'],
    ['2026-11-01', 'America/New_York', '2026-11-01T04:00:00Z'],
    ['2026-11-02', 'America/New_York', '2026-11-02T05:00:00Z'],
    ['2026-09-01', 'Pacific/Auckland', '2026-08-31T12:00:00Z'],
    ['2026-12-31', 'America/Los_Angeles', '2026-12-31T08:00:00Z'],
  ])
    for (const allowFractional of [false, true])
      assert.equal(zonedMidnight(date, zone, allowFractional), at(expected), date + ' ' + zone);
  assert.equal(zonedMidnight('2026-09-01', 'Asia/Kolkata', true), at('2026-08-31T18:30:00Z'));
});

test('a zone with a fractional-hour offset is still refused, and the refusal names the zone', () => {
  assert.throws(
    () => zonedMidnight('2026-08-01', 'Asia/Kolkata'),
    error => assertRefused(error, 'UNSUPPORTED_TIMEZONE_OFFSET', {message: /Asia\/Kolkata/}),
  );
  assert.throws(
    () => zonedMidnight('2026-08-01', 'Asia/Kathmandu'),
    error => assertRefused(error, 'UNSUPPORTED_TIMEZONE_OFFSET', {message: /Asia\/Kathmandu/}),
  );
  assert.throws(
    () => zonedMidnight('2026-08-01', 'Not/AZone'),
    error => assertRefused(error, 'INVALID_TIMEZONE'),
  );
});

test('Snapchat daily boundaries over the skipped Cairo midnight tile the window, with one 23-hour day', () => {
  const days = snapchatDailyRange(
    {date_from: '2026-04-22', date_to: '2026-04-26', timezone: 'Africa/Cairo', complete: true},
    false,
  );
  assert.deepEqual(
    days.map(day => [day.date, new Date(day.start).toISOString(), new Date(day.end).toISOString()]),
    [
      ['2026-04-22', '2026-04-21T22:00:00.000Z', '2026-04-22T22:00:00.000Z'],
      ['2026-04-23', '2026-04-22T22:00:00.000Z', '2026-04-23T22:00:00.000Z'],
      ['2026-04-24', '2026-04-23T22:00:00.000Z', '2026-04-24T21:00:00.000Z'],
      ['2026-04-25', '2026-04-24T21:00:00.000Z', '2026-04-25T21:00:00.000Z'],
      ['2026-04-26', '2026-04-25T21:00:00.000Z', '2026-04-26T21:00:00.000Z'],
    ],
  );
  assert.deepEqual(
    days.slice(1).map((day, index) => day.start - days[index].end),
    [0, 0, 0, 0],
  );
});

test('Snapchat refuses a zone whose day boundary has a fractional-hour offset and names the zone', () => {
  assert.throws(
    () =>
      snapchatDailyRange({date_from: '2026-04-22', date_to: '2026-04-22', timezone: 'Asia/Kolkata', complete: true}),
    error => assertRefused(error, 'UNSUPPORTED_TIMEZONE_OFFSET', {message: /Asia\/Kolkata/}),
  );
});
