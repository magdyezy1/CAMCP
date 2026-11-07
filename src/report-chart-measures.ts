import {reportCoverageLine, reportCoverageNotes} from './report-coverage-notes.js';
import {evaluateReportFormulaV4, sumReportValuesV4} from './report-math-v4.js';
import {zeroBasedScale} from './report-chart-scale.js';
import {
  chartId,
  chartMessage,
  chartNote,
  type ChartMessageKey,
  type ChartNote,
  type ChartSpec,
  type ChartTable,
} from './report-chart-spec.js';
import {
  aggregationOf,
  compareText,
  coverageNotes,
  decimalIn,
  decimalOf,
  definitionNotes,
  entityKeyOf,
  entityNameOf,
  finishKind,
  groupNotes,
  groupRows,
  levelColumns,
  levelOf,
  lineChart,
  metricLabels,
  omitted,
  periodValues,
  pricedGroups,
  sourceOf,
  topLimit,
  valueLabel,
  type Context,
} from './report-chart-kit.js';
import type {JsonObject} from './types.js';

/** The charts of a measure over time and against a target, and the key figures (V2-EXP-01). */
export function trendCharts(context: Context): ChartSpec[] {
  if ((context.config.grain ?? 'total') === 'total') return [];
  const periods = [...new Set(context.top.map(row => String(row.date_from)))].sort();
  if (periods.length < 2)
    return [
      omitted(
        'trend',
        'Spend over time',
        chartNote('A trend needs at least two periods; this report has {count}.', {count: String(periods.length)}),
      ),
    ];
  const specs: ChartSpec[] = [],
    {groups, unpriced: unpricedSpend} = pricedGroups(context.top);
  // Nothing priced at all: the spend chart is the one that says why it is missing.
  if (!groups.length && unpricedSpend)
    specs.push(omitted('trend', 'Spend over time', chartNote('Amounts without a known currency are not charted.')));
  for (const group of groups) {
    const currency = String(group[0]!.currency),
      series = periodValues(group, periods, 'spend');
    specs.push(
      lineChart({
        id: chartId('trend', 'spend', currency, aggregationOf(group[0]!)),
        title: 'Spend over time',
        context: {currency},
        periods,
        values: series.map(point => point.value),
        short: series.map(point => point.short),
        measure: 'spend',
        unit: 'currency',
        currency,
        highest: 'Spend was highest in the period starting {date}: {value}.',
        notes: [...coverageNotes(group, ['spend']), ...groupNotes(context, group)],
      }),
    );
  }
  const resolved = context.top.filter(row => row.result?.definition_id && row.result_context?.definition),
    unresolved = context.top.length - resolved.length;
  let unpricedResults = 0;
  const resultSpecs: ChartSpec[] = [];
  for (const [, group] of groupRows(resolved, row => {
    const definition = row.result_context.definition;
    return `${definition.id}|${definition.unit === 'currency' ? (row.currency ?? '') : ''}|${aggregationOf(row)}`;
  })) {
    const definition = group[0]!.result_context.definition,
      currency = definition.unit === 'currency' ? (group[0]!.currency ? String(group[0]!.currency) : null) : null;
    if (definition.unit === 'currency' && !currency) {
      unpricedResults += group.length;
      continue;
    }
    const series = periodValues(group, periods, 'primary_result');
    resultSpecs.push(
      lineChart({
        id: chartId('trend', 'results', String(definition.id), currency, aggregationOf(group[0]!)),
        title: 'Results over time',
        context: {...(currency ? {currency} : {}), result: String(definition.label)},
        periods,
        values: series.map(point => point.value),
        short: series.map(point => point.short),
        measure: 'primary_result',
        unit: definition.unit === 'currency' ? 'currency' : 'number',
        currency,
        highest: 'Results were highest in the period starting {date}: {value}.',
        notes: [
          ...(unresolved
            ? [
                chartNote('Rows with no single result definition are left out of this chart: {count}.', {
                  count: String(unresolved),
                }),
              ]
            : []),
          ...coverageNotes(group, ['primary_result']),
          ...groupNotes(context, group),
        ],
      }),
    );
  }
  definitionNotes(resultSpecs);
  return finishKind([...specs, ...resultSpecs], (groups.length ? unpricedSpend : 0) + unpricedResults);
}

/**
 * The target a row's cost per result is compared with, as the recommendation holds it (src/report-advice-v4.ts): the
 * campaign's own target, else the currency's for its objective, else the objective's. A target is usable only in the row's
 * currency and for the cost per result, and an objective's target does not compare unlike results: where the objective
 * holds more than one result definition only a target set for the campaign itself counts.
 */
function targetOf(row: JsonObject, policy: JsonObject, definitionsOf: Map<string, Set<string>>): string | null {
  const own = policy[row.campaign_key],
    objective = `${row.objective_group}:${row.currency}`,
    chosen = own ?? policy[objective] ?? policy[row.objective_group];
  if (!chosen || typeof chosen !== 'object' || chosen.currency !== row.currency) return null;
  if (chosen.kpi !== undefined && chosen.kpi !== 'cost_per_result') return null;
  if (!own && (definitionsOf.get(objective)?.size ?? 0) > 1) return null;
  const value = decimalOf(chosen.target);
  return value !== null && decimalIn(value).units > 0n ? value : null;
}
/**
 * An entity's cost per result: the platform's own (or derived) cost when it has one row, otherwise its spend over its
 * results, counting only the rows that have both, with the definition's price unit (some results are priced per 1,000).
 */
function entityCost(rows: JsonObject[]): string | null {
  if (rows.length === 1) return decimalOf(rows[0]!.result?.cost_per_result);
  const paired = rows.filter(row => decimalOf(row.metrics?.spend) !== null && decimalOf(row.result?.value) !== null),
    result = sumReportValuesV4(paired.map(row => decimalOf(row.result.value))).value,
    spend = sumReportValuesV4(paired.map(row => decimalOf(row.metrics.spend))).value;
  if (result === null || spend === null) return null;
  const factor = String(rows[0]!.result_context?.definition?.cost_multiplier ?? 1);
  return evaluateReportFormulaV4('spend * factor / result', {spend, factor, result}).value;
}
/** The coverage of a ratio in the shared helper's words: the rows that have every value it needs, of all of them. */
function ratioCoverageNotes(rows: JsonObject[], metric: 'cost_per_result'): ChartNote[] {
  const pairs = rows.filter(
      row => decimalOf(row.metrics?.spend) !== null && decimalOf(row.result?.value) !== null,
    ).length,
    source = {
      metrics_coverage: {
        [metric]: {
          known_rows: pairs,
          total_rows: rows.length,
          basis: 'report_rows',
          report_rows: rows.length,
          known_pairs: pairs,
        },
      },
    };
  return reportCoverageNotes(source, [metric]).map(note => ({
    kind: 'coverage' as const,
    ...note,
    text: reportCoverageLine(note, metricLabels[note.metric] ?? note.metric, 'en'),
  }));
}
export function costCharts(context: Context): ChartSpec[] {
  const policy: JsonObject = context.config.targets ?? {},
    eligible = context.top.filter(
      row =>
        row.currency &&
        row.result?.definition_id &&
        row.result_context?.definition &&
        row.result_context.definition.unit !== 'currency',
    );
  if (!eligible.length) return [];
  // The result definitions each objective and currency holds, over every row, as the recommendation counts them.
  const definitionsOf = new Map<string, Set<string>>();
  for (const row of context.rows) {
    const key = `${row.objective_group}:${row.currency}`,
      ids = definitionsOf.get(key) ?? new Set<string>();
    for (const id of row.result_groups?.length
      ? row.result_groups.map((group: JsonObject) => group.result?.definition_id)
      : [row.result?.definition_id])
      if (id) ids.add(String(id));
    definitionsOf.set(key, ids);
  }
  const specs: ChartSpec[] = [];
  for (const [, group] of groupRows(
    eligible,
    row => `${row.result_context.definition.id}|${row.currency}|${aggregationOf(row)}`,
  )) {
    const definition = group[0]!.result_context.definition,
      currency = String(group[0]!.currency),
      level = levelOf(group[0]!),
      entities = groupRows(group, entityKeyOf)
        .map(([key, rows]) => ({
          key,
          rows,
          target: targetOf(rows[0]!, policy, definitionsOf),
          spend: sumReportValuesV4(rows.map(row => decimalOf(row.metrics?.spend))).value,
        }))
        .filter(entity => entity.target !== null);
    if (!entities.length) continue;
    // The ten with the most spend; the cost of the rest is in the report's table.
    const byspend = [...entities].sort(
        (a, b) =>
          (a.spend === null ? 1 : 0) - (b.spend === null ? 1 : 0) ||
          (a.spend !== null && b.spend !== null ? compareText(b.spend, a.spend) : 0) ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      ),
      shown = byspend.slice(0, topLimit).map(entity => ({...entity, cost: entityCost(entity.rows)})),
      withCost = shown.filter(entity => entity.cost !== null).sort((a, b) => compareText(b.cost!, a.cost!)),
      listed = [...withCost, ...shown.filter(entity => entity.cost === null)],
      severalSources = new Set(group.map(sourceOf)).size > 1,
      atOrUnder = withCost.filter(entity => compareText(entity.cost!, entity.target!) <= 0).length,
      values = listed.map(entity => entity.cost),
      targets = listed.map(entity => entity.target),
      notes: ChartNote[] = [
        ...(byspend.length > shown.length
          ? [
              chartNote('Only the {count} entries with the most spend are shown. The report table has the rest.', {
                count: String(shown.length),
              }),
            ]
          : []),
        ...ratioCoverageNotes(
          shown.flatMap(entity => entity.rows),
          'cost_per_result',
        ),
        ...groupNotes(context, group),
      ];
    const table: ChartTable = {
      columns: [
        {label: levelColumns[level] ?? 'Campaign', label_kind: 'label', type: 'text', cell_kind: 'entity'},
        {label: 'Cost per result', label_kind: 'label', type: 'currency', currency},
        {label: 'Target', label_kind: 'label', type: 'currency', currency},
        {label: 'Against target', label_kind: 'label', type: 'text', cell_kind: 'label'},
      ],
      rows: listed.map(entity => [
        entityNameOf(entity.rows[0]!),
        entity.cost,
        entity.target,
        entity.cost === null
          ? null
          : compareText(entity.cost, entity.target!) <= 0
            ? 'At or under target'
            : 'Over target',
      ]),
    };
    const base: ChartSpec = {
      id: chartId('cost_vs_target', String(definition.id), currency, aggregationOf(group[0]!)),
      kind: 'cost_vs_target',
      type: 'bar',
      title: chartMessage('Cost per result against target'),
      takeaway: null,
      context: {currency, result: String(definition.label), level},
      x: null,
      series: [],
      scale: null,
      notes,
      table,
      drawn: false,
    };
    if (!withCost.length) {
      notes.unshift(chartNote('No value is known, so there is nothing to draw.'));
      specs.push(base);
      continue;
    }
    specs.push({
      ...base,
      takeaway: chartMessage('Campaigns at or under their target cost per result: {count} of {total}.', {
        count: String(atOrUnder),
        total: String(withCost.length),
      }),
      x: {
        kind: 'category',
        items: listed.map(entity => ({
          key: entity.key,
          label: entityNameOf(entity.rows[0]!),
          ...(severalSources
            ? {
                detail:
                  (context.names[String(entity.rows[0]!.platform)] ?? String(entity.rows[0]!.platform)) +
                  ' · ' +
                  String(entity.rows[0]!.account_id),
              }
            : {}),
        })),
      },
      series: [
        {
          key: 'cost_per_result',
          name: 'Cost per result',
          name_kind: 'label',
          unit: 'currency',
          currency,
          values,
          value_labels: values.map(value => valueLabel(value, 'currency', currency)),
          targets,
          target_labels: targets.map(value => valueLabel(value, 'currency', currency)),
          color_index: 2,
          label_at: values.flatMap((value, index) => (value === null ? [] : [index])),
        },
      ],
      scale: zeroBasedScale(
        decimalIn(
          [...values, ...targets].reduce<string>(
            (max, value) => (value !== null && compareText(value, max) > 0 ? value : max),
            '0',
          ),
        ),
      ),
      drawn: true,
    });
  }
  if (!specs.length)
    return [
      omitted(
        'cost_vs_target',
        'Cost per result against target',
        chartNote('No campaign has a cost per result target, so there is nothing to compare costs with.'),
      ),
    ];
  definitionNotes(specs);
  return finishKind(specs, 0);
}

/**
 * The key figures of each summary of a source's top level: spend, impressions, clicks, the result and its cost, exactly as
 * the summary holds them, each with the rows that stand behind it when that is fewer than all of them. The change since
 * the previous period is not stored: it needs the linked baseline, which may finish later, so it is added when the report
 * is read (chartsWithChange).
 */
export function kpiCharts(context: Context): ChartSpec[] {
  const fields = ['spend', 'impressions', 'clicks', 'primary_result', 'cost_per_result'],
    specs = context.summaries.map((summary, index): ChartSpec => {
      const currency = summary.currency ? String(summary.currency) : null,
        single = summary.result_groups?.length === 1 ? summary.result_groups[0] : null,
        resultUnit = single?.definition?.unit === 'currency' ? ('currency' as const) : ('number' as const),
        series = [
          ['spend', 'Spend', 'currency'],
          ['impressions', 'Impressions', 'number'],
          ['clicks', 'Clicks', 'number'],
          ['primary_result', 'Results', resultUnit],
          ['cost_per_result', 'Cost per result', 'currency'],
        ].map(([key, name, unit]) => ({
          key: key!,
          name: name as ChartMessageKey,
          name_kind: 'label' as const,
          unit: unit as 'currency' | 'number',
          currency: unit === 'currency' ? currency : null,
          values: [decimalOf(summary.metrics?.[key!])],
          value_labels: [
            valueLabel(
              decimalOf(summary.metrics?.[key!]),
              unit as 'currency' | 'number',
              unit === 'currency' ? currency : null,
            ),
          ],
          color_index: null,
          label_at: [0],
        })),
        notes: ChartNote[] = [
          ...reportCoverageNotes(summary, fields).map(note => ({
            kind: 'coverage' as const,
            ...note,
            text: reportCoverageLine(note, metricLabels[note.metric] ?? note.metric, 'en'),
          })),
          ...groupNotes(context, [summary]),
        ];
      return {
        id: chartId('kpi', String(summary.platform), String(summary.account_id), String(index)),
        kind: 'kpi',
        type: 'kpi',
        title: chartMessage('Key figures'),
        takeaway: null,
        context: {
          platform: context.names[String(summary.platform)] ?? String(summary.platform),
          account_id: String(summary.account_id),
          currency,
          level: levelOf(summary),
          objective: String(summary.objective_group ?? 'unknown'),
          ...(single?.definition?.label || summary.result_definition
            ? {result: String(single?.definition?.label ?? summary.result_definition)}
            : {}),
          date_from: String(summary.date_from),
          date_to: String(summary.date_to),
          compare: {
            platform: String(summary.platform),
            account_id: String(summary.account_id),
            currency,
            timezone: summary.timezone ?? null,
            result_definition: summary.result_definition ?? null,
            attribution: summary.attribution ?? null,
            entity_level: levelOf(summary),
          },
        },
        x: null,
        series,
        scale: null,
        notes,
        table: {
          columns: [
            {label: 'Metric', label_kind: 'label', type: 'text', cell_kind: 'label'},
            {label: 'Value', label_kind: 'label', type: 'decimal'},
            {label: 'Currency', label_kind: 'label', type: 'text', cell_kind: 'entity'},
          ],
          rows: series.map(item => [item.name, item.values[0]!, item.unit === 'currency' ? item.currency : null]),
        },
        drawn: true,
      };
    });
  return finishKind(specs, 0);
}
