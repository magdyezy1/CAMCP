import {sumReportValuesV4} from './report-math-v4.js';
import {assignChartColors, percentText, zeroBasedScale} from './report-chart-scale.js';
import {
  chartId,
  chartMessage,
  chartNote,
  type ChartMessageKey,
  type ChartSpec,
  type ChartTable,
} from './report-chart-spec.js';
import {
  aggregationOf,
  amountOrNumber,
  amountText,
  barChart,
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
  levelTitles,
  omitted,
  pricedGroups,
  ranked,
  sourceOf,
  type Context,
} from './report-chart-kit.js';
import type {JsonObject} from './types.js';

/**
 * The breakdowns of spend and results (V2-EXP-01): spend by platform and by campaign (or ad set or ad), spend by objective,
 * and the ads with the most results.
 */
export function spendByEntity(context: Context): ChartSpec[] {
  const {groups, unpriced} = pricedGroups(context.top),
    specs: ChartSpec[] = [];
  if (!groups.length)
    return unpriced
      ? [
          omitted(
            'spend_by_entity',
            'Spend by campaign',
            chartNote('Amounts without a known currency are not charted.'),
          ),
        ]
      : [];
  for (const group of groups) {
    const currency = String(group[0]!.currency),
      platforms = groupRows(group, row => String(row.platform));
    if (platforms.length > 1)
      specs.push(
        barChart({
          id: chartId('spend_by_entity', 'platform', currency, aggregationOf(group[0]!)),
          kind: 'spend_by_entity',
          title: 'Spend by platform',
          context: {currency},
          entries: platforms.map(([platform, rows]) => ({
            key: platform,
            label: context.names[platform] ?? platform,
            value: sumReportValuesV4(rows.map(row => decimalOf(row.metrics?.spend))).value,
          })),
          entityColumn: 'Platform',
          measure: 'spend',
          seriesName: 'Spend',
          unit: 'currency',
          currency,
          notes: [...coverageNotes(group, ['spend']), ...groupNotes(context, group)],
        }),
      );
    for (const [level, rows] of groupRows(group, levelOf)) {
      const severalSources = new Set(rows.map(sourceOf)).size > 1;
      specs.push(
        barChart({
          id: chartId('spend_by_entity', level, currency, aggregationOf(rows[0]!)),
          kind: 'spend_by_entity',
          title: levelTitles[level] ?? 'Spend by campaign',
          context: {currency, level},
          entries: groupRows(rows, entityKeyOf).map(([key, members]) => ({
            key,
            label: entityNameOf(members[0]!),
            ...(severalSources
              ? {
                  detail:
                    (context.names[String(members[0]!.platform)] ?? String(members[0]!.platform)) +
                    ' · ' +
                    String(members[0]!.account_id),
                }
              : {}),
            value: sumReportValuesV4(members.map(row => decimalOf(row.metrics?.spend))).value,
          })),
          entityColumn: levelColumns[level] ?? 'Campaign',
          measure: 'spend',
          seriesName: 'Spend',
          unit: 'currency',
          currency,
          notes: [...coverageNotes(rows, ['spend']), ...groupNotes(context, rows)],
        }),
      );
    }
  }
  return finishKind(specs, unpriced);
}

const objectiveLabels: Record<string, ChartMessageKey> = {
  awareness: 'Awareness',
  traffic: 'Traffic',
  engagement: 'Engagement',
  video_views: 'Video views',
  leads: 'Leads',
  sales: 'Sales',
  app_installs: 'App installs',
  unknown: 'Unknown',
};

/**
 * Spend by objective as a stacked bar per platform: the three largest objectives, each with its own hue, and the rest as
 * Other (the neutral). A hue follows the objective, so a filter that removes one does not repaint the others, and two
 * objectives on one chart never share one. One objective is nothing to compare.
 */
export function objectiveCharts(context: Context): ChartSpec[] {
  const {groups, unpriced} = pricedGroups(context.top),
    specs: ChartSpec[] = [];
  if (!groups.length)
    return unpriced
      ? [
          omitted(
            'spend_by_objective',
            'Spend by objective',
            chartNote('Amounts without a known currency are not charted.'),
          ),
        ]
      : [];
  for (const group of groups) {
    const currency = String(group[0]!.currency),
      id = chartId('spend_by_objective', currency, aggregationOf(group[0]!)),
      objectives = ranked(
        groupRows(group, row => String(row.objective_group ?? 'unknown')).map(([key, rows]) => ({
          key,
          label: key,
          value: sumReportValuesV4(rows.map(row => decimalOf(row.metrics?.spend))).value,
        })),
      ),
      notes = [...coverageNotes(group, ['spend']), ...groupNotes(context, group)],
      title = chartMessage('Spend by objective');
    const none: ChartSpec = {
      id,
      kind: 'spend_by_objective',
      type: 'stacked_bar',
      title,
      takeaway: null,
      context: {currency},
      x: null,
      series: [],
      scale: null,
      notes,
      table: null,
      drawn: false,
    };
    if (objectives.length < 2) {
      notes.unshift(
        chartNote(
          objectives.length
            ? 'All spend is on one objective, so there is nothing to compare.'
            : 'No value is known, so there is nothing to draw.',
        ),
      );
      specs.push(none);
      continue;
    }
    const top = objectives.slice(0, 3),
      rest = objectives.slice(3),
      hues = assignChartColors(top.map(objective => objective.key)),
      platforms = groupRows(group, row => String(row.platform))
        .map(([platform, rows]) => ({
          platform,
          rows,
          total: sumReportValuesV4(rows.map(row => decimalOf(row.metrics?.spend))).value,
        }))
        .sort(
          (a, b) =>
            (a.total === null ? 1 : 0) - (b.total === null ? 1 : 0) ||
            (a.total !== null && b.total !== null ? compareText(b.total, a.total) : 0) ||
            (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0),
        ),
      cell = (rows: JsonObject[], keys: string[]): string | null => {
        const members = rows.filter(row => keys.includes(String(row.objective_group ?? 'unknown')));
        return members.length ? sumReportValuesV4(members.map(row => decimalOf(row.metrics?.spend))).value : null;
      },
      series = [
        ...top.map((objective, index) => ({
          key: objective.key,
          name: objectiveLabels[objective.key] ?? objectiveLabels.unknown!,
          color_index: hues[index]!,
          values: platforms.map(platform => cell(platform.rows, [objective.key])),
        })),
        ...(rest.length
          ? [
              {
                key: 'other',
                name: 'Other' as ChartMessageKey,
                color_index: null,
                values: platforms.map(platform =>
                  cell(
                    platform.rows,
                    rest.map(objective => objective.key),
                  ),
                ),
              },
            ]
          : []),
      ],
      totals = platforms.map(platform => platform.total),
      negative = [...series.flatMap(item => item.values), ...totals].some(
        value => value !== null && decimalIn(value).units < 0n,
      ),
      all = sumReportValuesV4(objectives.map(objective => objective.value)).value,
      table: ChartTable = {
        columns: [
          {label: 'Platform', label_kind: 'label', type: 'text', cell_kind: 'entity'},
          ...series.map(item => ({
            label: item.name,
            label_kind: 'label' as const,
            type: 'currency' as const,
            currency,
          })),
          {label: 'Total', label_kind: 'label', type: 'currency', currency},
        ],
        rows: platforms.map((platform, row) => [
          context.names[platform.platform] ?? platform.platform,
          ...series.map(item => item.values[row]!),
          totals[row]!,
        ]),
      };
    if (negative) {
      notes.unshift(chartNote('Values below zero cannot be drawn from a zero baseline. The table has them.'));
      specs.push({...none, table});
      continue;
    }
    if (rest.length)
      notes.unshift(chartNote('The smaller entries are combined as Other: {count}.', {count: String(rest.length)}));
    const share = all === null ? null : percentText(decimalIn(top[0]!.value!), decimalIn(all), 1);
    specs.push({
      ...none,
      takeaway:
        share !== null && all !== null
          ? chartMessage(
              'The largest share of spend is {name}: {share} of {total}.',
              {
                name: objectiveLabels[top[0]!.key] ?? objectiveLabels.unknown!,
                share: share + '%',
                total: amountText(all, currency),
              },
              ['name'],
            )
          : null,
      x: {
        kind: 'category',
        items: platforms.map(platform => ({
          key: platform.platform,
          label: context.names[platform.platform] ?? platform.platform,
        })),
      },
      series: series.map(item => ({
        key: item.key,
        name: item.name,
        name_kind: 'label' as const,
        unit: 'currency' as const,
        currency,
        values: item.values,
        color_index: item.color_index,
        label_at: [],
      })),
      scale: zeroBasedScale(
        decimalIn(
          totals.reduce<string>((max, value) => (value !== null && compareText(value, max) > 0 ? value : max), '0'),
        ),
      ),
      table,
      drawn: true,
    });
  }
  return finishKind(specs, unpriced);
}

/**
 * The ads with the most results, a bar each from zero. A result is not spend: ads are ranked within one result definition,
 * one chart for each (a result counted in money in its currency), and never added to another's. Previews will supply each
 * ad's picture in round 3; until then an entry has none.
 */
export function topAdsCharts(context: Context): ChartSpec[] {
  const ads = context.rows.filter(row => levelOf(row) === 'ad');
  if (!ads.length) return [omitted('top_ads', 'Top ads by result', chartNote('This report has no ad-level rows.'))];
  const resolved = ads.filter(row => row.result?.definition_id && row.result_context?.definition),
    specs: ChartSpec[] = [];
  let unpriced = 0;
  for (const [, group] of groupRows(resolved, row => {
    const definition = row.result_context.definition;
    return `${definition.id}|${definition.unit === 'currency' ? (row.currency ?? '') : ''}|${aggregationOf(row)}`;
  })) {
    const definition = group[0]!.result_context.definition,
      currency = definition.unit === 'currency' ? (group[0]!.currency ? String(group[0]!.currency) : null) : null,
      unit = definition.unit === 'currency' ? ('currency' as const) : ('number' as const);
    if (unit === 'currency' && !currency) {
      unpriced += group.length;
      continue;
    }
    const severalSources = new Set(group.map(sourceOf)).size > 1;
    specs.push(
      barChart({
        id: chartId('top_ads', String(definition.id), currency, aggregationOf(group[0]!)),
        kind: 'top_ads',
        title: 'Top ads by result',
        context: {...(currency ? {currency} : {}), result: String(definition.label), level: 'ad'},
        entries: groupRows(group, entityKeyOf).map(([key, rows]) => ({
          key,
          label: entityNameOf(rows[0]!),
          ...(severalSources
            ? {
                detail:
                  (context.names[String(rows[0]!.platform)] ?? String(rows[0]!.platform)) +
                  ' · ' +
                  String(rows[0]!.account_id),
              }
            : {}),
          value: sumReportValuesV4(rows.map(row => decimalOf(row.metrics?.primary_result))).value,
        })),
        entityColumn: 'Ad',
        measure: 'primary_result',
        seriesName: 'Results',
        unit,
        currency,
        fold: false,
        takeaway: top =>
          chartMessage('The ad with the most results is {name}: {value}.', {
            name: top.label,
            value: amountOrNumber(top.value!, {unit, currency}),
          }),
        notes: [...coverageNotes(group, ['primary_result']), ...groupNotes(context, group)],
      }),
    );
  }
  definitionNotes(specs);
  return finishKind(specs, unpriced);
}
