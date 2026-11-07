// F-L5-29: a property-style test that a summary never adds across currency or result definition, whatever the order of
// its rows. Rows are generated from a fixed seed (no dependency, the same rows every run), grouped by an oracle of the
// grouping rule written out here, and shuffled: reportSummary and reportWindowSummary must give the same groups, and
// every group must hold the sums its members add up to. Two result definitions share one label (TikTok labels every
// definition alike, so only the id tells a purchase from an add-to-cart); a summary that told them apart by label would
// merge them. Without this test the window summary could drop the definition (M2b) or the currency (M24) from its key
// and the repository's tests stayed green.
import test from 'node:test';
import assert from 'node:assert/strict';
import {reportSummary, reportWindowSummary} from '../dist/src/report-summary.js';

let seed = 20261105;
const rnd = n => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  },
  pick = list => list[rnd(list.length)],
  shuffle = list => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = rnd(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
const scale = 1000000000n,
  scaled = text => {
    const [whole, fraction = ''] = text.split('.');
    return BigInt(whole) * scale + BigInt((fraction + '000000000').slice(0, 9));
  },
  asText = value => {
    const fraction = (value % scale).toString().padStart(9, '0').replace(/0+$/, '');
    return (value / scale).toString() + (fraction ? '.' + fraction : '');
  };
const definitions = {
  leads: {id: 'p:leads', metric: 'leads', label: 'Leads', native_metric: 'leads', aggregation: 'sum', unit: 'number'},
  clicks: {
    id: 'p:clicks',
    metric: 'clicks',
    label: 'Link clicks',
    native_metric: 'link',
    aggregation: 'sum',
    unit: 'number',
  },
  reach: {
    id: 'p:reach',
    metric: 'reach',
    label: 'Reach',
    native_metric: 'reach',
    aggregation: 'non_additive',
    unit: 'number',
    cost_multiplier: 1000,
  },
  purchase: {
    id: 'tiktok:CONVERT:PURCHASE',
    metric: 'result',
    label: 'TikTok result',
    native_metric: 'metrics.result',
    aggregation: 'sum',
    unit: 'number',
  },
  cart: {
    id: 'tiktok:CONVERT:ADD_TO_CART',
    metric: 'result',
    label: 'TikTok result',
    native_metric: 'metrics.result',
    aggregation: 'sum',
    unit: 'number',
  },
};
function makeRow() {
  const definition = pick(['leads', 'clicks', 'reach', 'purchase', 'cart', null]),
    d = definition ? definitions[definition] : null,
    day = pick(['2026-09-01', '2026-09-02', '2026-09-03']),
    spend = pick([null, '0', '0.1', '10.123456789', '9007199254740993.1', String(rnd(100000) / 100)]),
    value = pick([null, '0', '1', '2.5', String(rnd(1000))]);
  return {
    platform: pick(['meta', 'tiktok']),
    account_id: pick(['a1', 'a2']),
    connection_id: 'c',
    currency: pick(['USD', 'EUR', 'SAR', null]),
    timezone: pick(['UTC', 'Asia/Riyadh']),
    objective_group: pick(['sales', 'leads', 'traffic']),
    result_definition: d?.label ?? 'unknown',
    attribution: pick(['7d_click', '1d_view']),
    date_from: day,
    date_to: day,
    ...pick([
      {entity_level: 'campaign', native_entity_type: 'campaign'},
      {entity_level: 'adset', native_entity_type: 'adgroup'},
      {entity_level: 'ad', native_entity_type: 'ad'},
    ]),
    entity_id: 'e' + rnd(30),
    complete: true,
    metrics: {
      spend,
      impressions: pick([null, '100']),
      clicks: pick([null, '0', '3']),
      conversions: pick([null, '2']),
      reach: pick([null, '50']),
      frequency: pick([null, '1.5']),
      primary_result: value,
      cost_per_result: null,
    },
    result: {
      metric: d?.metric ?? null,
      label: d?.label ?? null,
      value: d ? value : null,
      cost_per_result: null,
      definition_id: d?.id ?? null,
    },
    result_context: {
      definition: d,
      source: d ? 'mapped' : 'unknown',
      cost_source: 'unknown',
      unavailable_reason: d ? null : 'unsupported_goal',
      rounding: {},
    },
    recommendation: {decision: 'observe'},
  };
}
const canon = value =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
const sorted = list => list.map(canon).sort();
/** The grouping rule, written out: what two rows must share to be summed together. */
const groupKey = (row, dated) =>
  JSON.stringify([
    row.platform,
    row.account_id,
    row.currency,
    row.timezone,
    row.objective_group,
    row.result_definition,
    row.attribution,
    ...(dated ? [row.date_from, row.date_to] : []),
    row.entity_level,
    row.native_entity_type,
    row.result?.definition_id ?? null,
  ]);
const sameGroup = (member, group, dated) =>
  member.platform === group.platform &&
  member.entity_level === group.entity_level &&
  member.account_id === group.account_id &&
  member.currency === group.currency &&
  member.timezone === group.timezone &&
  member.objective_group === group.objective_group &&
  member.result_definition === group.result_definition &&
  member.attribution === group.attribution &&
  (member.result?.definition_id ?? null) === (group.result_groups?.[0]?.result?.definition_id ?? null) &&
  (!dated || member.date_from === group.date_from);

test('summaries are the same whatever the order of the rows, and never add across currency or result definition', () => {
  const failures = [];
  let checks = 0;
  const fail = (message, detail) => failures.length < 10 && failures.push({message, detail});
  for (let round = 0; round < 400; round++) {
    const rows = Array.from({length: 1 + rnd(40)}, makeRow).map(row => ({...row, entity_key: 'k' + row.entity_id})),
      summary = reportSummary(rows, [], true),
      window = reportWindowSummary(rows, [], true);
    if (sorted(summary).join('|') !== sorted(reportSummary(shuffle(rows), [], true)).join('|'))
      fail('the summary depends on the order of the rows', {round});
    if (sorted(window).join('|') !== sorted(reportWindowSummary(shuffle(rows), [], true)).join('|'))
      fail('the window summary depends on the order of the rows', {round});
    for (const [list, dated] of [
      [summary, true],
      [window, false],
    ]) {
      const oracle = new Map();
      for (const row of rows) {
        const key = groupKey(row, dated);
        oracle.set(key, [...(oracle.get(key) ?? []), row]);
      }
      if (oracle.size !== list.length) fail('group count', {round, dated, oracle: oracle.size, got: list.length});
      for (const group of list) {
        checks++;
        const members = [...oracle.values()].find(candidate => sameGroup(candidate[0], group, dated));
        if (!members) {
          fail('a group no row set explains', {round, dated, platform: group.platform});
          continue;
        }
        if (new Set(members.map(member => member.currency)).size !== 1) fail('currency mixed', {round});
        if (new Set(members.map(member => member.entity_level)).size !== 1) fail('level mixed', {round});
        if (new Set(members.map(member => member.result?.definition_id)).size !== 1)
          fail('result definition mixed', {round});
        // Only the window summary counts distinct entities; a period summary counts rows.
        if (!dated && group.entity_count !== new Set(members.map(member => member.entity_key)).size)
          fail('entity count', {round, got: group.entity_count});
        const known = members.filter(member => member.metrics.spend !== null),
          expected = known.length
            ? asText(known.reduce((sum, member) => sum + scaled(member.metrics.spend), 0n))
            : null,
          // Money of several rows in an unknown currency has no total.
          expectedSpend = members.length > 1 && group.currency === null ? null : expected;
        if (group.metrics.spend !== expectedSpend)
          fail('spend', {round, got: group.metrics.spend, expected: expectedSpend, n: members.length});
        const coverage = group.metrics_coverage.spend;
        if (coverage.known_rows !== known.length || coverage.total_rows !== members.length)
          fail('spend coverage', {round, coverage, known: known.length, total: members.length});
        if (group.metrics.reach !== null) fail('reach was summed', {round});
        if (group.metrics.frequency !== null) fail('frequency was summed', {round});
        if (
          members[0].result_context.definition?.aggregation === 'non_additive' &&
          members.length > 1 &&
          group.metrics.primary_result !== null
        )
          fail('a non-additive result was added', {round, value: group.metrics.primary_result});
        for (const point of group.series ?? []) {
          const day = members.filter(member => member.date_from === point.date_from && member.metrics.spend !== null),
            daySpend = day.length ? asText(day.reduce((sum, member) => sum + scaled(member.metrics.spend), 0n)) : null;
          if ((point.spend === null) !== (daySpend === null) || (daySpend !== null && point.spend !== daySpend))
            fail('series point', {round, point: point.spend, daySpend});
        }
      }
    }
  }
  assert.ok(checks > 1000, 'the generator produced ' + checks + ' groups');
  assert.deepEqual(failures, []);
});

test('two result definitions with one label are never one group, in a period summary or a window summary', () => {
  const row = (definition, currency) => {
    const base = makeRow();
    return {
      ...base,
      platform: 'tiktok',
      account_id: 'a1',
      currency,
      timezone: 'UTC',
      objective_group: 'sales',
      attribution: '7d_click',
      entity_level: 'campaign',
      native_entity_type: 'campaign',
      entity_id: 'e1',
      entity_key: 'k1',
      date_from: '2026-09-01',
      date_to: '2026-09-01',
      result_definition: definitions[definition].label,
      metrics: {...base.metrics, spend: '10', primary_result: '4'},
      result: {
        ...base.result,
        metric: 'result',
        label: 'TikTok result',
        value: '4',
        definition_id: definitions[definition].id,
      },
      result_context: {definition: definitions[definition], source: 'mapped', cost_source: 'unknown', rounding: {}},
    };
  };
  const rows = [row('purchase', 'USD'), row('cart', 'USD'), row('purchase', 'EUR')];
  for (const summarize of [reportSummary, reportWindowSummary]) {
    const groups = summarize(rows, [], true);
    assert.equal(groups.length, 3, 'two definitions and two currencies are three groups');
    assert.deepEqual(groups.map(group => [group.currency, group.metrics.primary_result, group.metrics.spend]).sort(), [
      ['EUR', '4', '10'],
      ['USD', '4', '10'],
      ['USD', '4', '10'],
    ]);
  }
});
