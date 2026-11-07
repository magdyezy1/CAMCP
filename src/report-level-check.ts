import type {JsonObject} from './types.js';

/**
 * The cross-level check of one source in words (V2-RPT-06, D4; F-L5-05): for each pair of levels, why metrics cannot be
 * compared, how far one level covers the other, which metrics are only partly known and which agree. The facts are
 * `sources[].cross_level` (src/report-level-reconciliation.ts); this module only words them for the PDF and the Excel
 * workbook, in the report's language, and reads the same facts the website's report page does (web/report-quality.js
 * `reportLevelCheckLines`), with the same sentences, so a reader sees one account of the levels wherever they look.
 */
export type LevelCheckLanguage = 'en' | 'ar';
export interface LevelCheckLine {
  text: string;
  /** The server's exact percentage, when the text shows it cut. */
  exact?: string;
}

const sentences = {
  agree: {
    en: 'Levels agree on {metrics} ({baseline} and {comparison}).',
    ar: 'تتطابق المستويات في {metrics} ({baseline} و{comparison}).',
  },
  covers: {
    en: '{comparison} rows cover {percent} of {baseline} {metric}.',
    ar: 'تغطي صفوف {comparison} نسبة {percent} من {metric} على مستوى {baseline}.',
  },
  exceeds: {
    en: '{comparison} rows add up to {percent} of {baseline} {metric}.',
    ar: 'يبلغ مجموع صفوف {comparison} نسبة {percent} من {metric} على مستوى {baseline}.',
  },
  differs: {
    en: '{comparison} rows and {baseline} rows differ on {metric}.',
    ar: 'تختلف صفوف {comparison} عن صفوف {baseline} في {metric}.',
  },
  partial: {
    en: '{metrics} could not be fully compared between {baseline} and {comparison} rows: some values are unknown, or a level was not fully collected.',
    ar: 'تعذّرت المقارنة الكاملة في {metrics} بين صفوف {baseline} و{comparison}: بعض القيم غير معروفة، أو لم يُجمع أحد المستويات بالكامل.',
  },
  unavailable: {
    en: '{metrics} cannot be compared between {baseline} and {comparison} rows: {reason}.',
    ar: 'لا يمكن مقارنة {metrics} بين صفوف {baseline} و{comparison}: {reason}.',
  },
} as const;
/** Why a pair cannot be compared: the closed set of `unavailable_reason` (src/report-level-reconciliation.ts). */
const reasons: Record<string, {en: string; ar: string}> = {
  derived_parent_population: {
    en: 'the parent rows are rolled up from the selected child rows',
    ar: 'صفوف المستوى الأعلى مجمّعة من الصفوف الفرعية المحددة',
  },
  different_or_unavailable_windows: {
    en: 'the levels cover different or unavailable date windows',
    ar: 'تغطي المستويات فترات زمنية مختلفة أو غير متاحة',
  },
  different_status_populations: {
    en: 'the levels include different statuses',
    ar: 'تتضمن المستويات حالات مختلفة',
  },
  different_objective_populations: {
    en: 'an objective filter hides rows at one of the levels',
    ar: 'يُخفي مرشّح الهدف صفوفًا في أحد المستويين',
  },
  unknown_currency: {en: 'the currency is unknown', ar: 'العملة غير معروفة'},
  missing_metric: {en: 'a level has no value for it', ar: 'لا توجد قيمة لها في أحد المستويين'},
  level_failed: {en: 'a level could not be collected', ar: 'تعذّر جمع بيانات أحد المستويين'},
};
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
/** The page's own list format (web/localization.js `uiList`), so the lines read alike. */
const list = (items: string[], language: LevelCheckLanguage) =>
  new Intl.ListFormat(language, {style: 'long', type: 'conjunction'}).format(items);
/**
 * A percentage from the server's exact decimal text, cut and never rounded: whole percent, with more digits only where the
 * cut would read as 0 or as exactly 100 although the figure is not. A figure that differs from 100 never reads as 100.
 * Null for anything that is not a non-negative decimal. No floating point is used.
 */
export function levelCheckPercent(value: unknown): string | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const whole = match[1]!.replace(/^0+(?=\d)/, ''),
    fraction = (match[2] ?? '').replace(/0+$/, ''),
    hides = (digits: number) =>
      !/[1-9]/.test(fraction.slice(0, digits)) && fraction !== '' && (whole === '0' || whole === '100');
  let digits = 0;
  while (digits < fraction.length && hides(digits)) digits++;
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (digits ? '.' + fraction.slice(0, digits) : '') + '%';
}

/**
 * The lines of one source's cross-level check. `levelName` names a platform's level in the report's language (the
 * platform's own word: ad squad, line item, creative) and `metricName` a metric.
 */
export function reportLevelCheckLines(
  source: JsonObject,
  language: LevelCheckLanguage,
  levelName: (platform: string, level: string) => string,
  metricName: (metric: string) => string,
): LevelCheckLine[] {
  const platform = source.source?.platform as string,
    groups = new Map<string, JsonObject[]>(),
    lower = (text: string) => (language === 'en' ? text.toLowerCase() : text);
  for (const item of Array.isArray(source.cross_level) ? source.cross_level : []) {
    const key = JSON.stringify([
      item.currency ?? null,
      item.timezone ?? null,
      item.baseline?.level,
      item.comparison?.level,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const lines: LevelCheckLine[] = [];
  for (const group of groups.values()) {
    const baseline = levelName(platform, group[0]!.baseline?.level),
      comparison = levelName(platform, group[0]!.comparison?.level),
      state = (name: string) => group.filter(item => item.state === name),
      unavailable = new Map<string, JsonObject[]>();
    for (const item of state('unavailable'))
      unavailable.set(item.unavailable_reason, [...(unavailable.get(item.unavailable_reason) ?? []), item]);
    for (const [reason, items] of unavailable)
      lines.push({
        text: fill(sentences.unavailable[language], {
          metrics: list(
            items.map(item => metricName(item.metric)),
            language,
          ),
          baseline,
          comparison,
          reason: reasons[reason]?.[language] ?? String(reason ?? '').replaceAll('_', ' '),
        }),
      });
    for (const item of state('gap')) {
      const exactHundred = /^100(?:\.0+)?$/.test(String(item.coverage_percent ?? '')),
        percent = exactHundred ? null : levelCheckPercent(item.coverage_percent),
        values = {
          comparison,
          baseline: lower(baseline),
          metric: lower(metricName(item.metric)),
          percent: percent ?? '',
        };
      lines.push(
        percent === null
          ? {text: fill(sentences.differs[language], values)}
          : {
              text: fill(
                String(item.delta).startsWith('-') ? sentences.covers[language] : sentences.exceeds[language],
                values,
              ),
              exact: item.coverage_percent + '%',
            },
      );
    }
    if (state('partial').length)
      lines.push({
        text: fill(sentences.partial[language], {
          metrics: list(
            state('partial').map(item => metricName(item.metric)),
            language,
          ),
          baseline,
          comparison,
        }),
      });
    if (state('agree').length)
      lines.push({
        text: fill(sentences.agree[language], {
          metrics: list(
            state('agree').map(item => lower(metricName(item.metric))),
            language,
          ),
          baseline,
          comparison,
        }),
      });
  }
  return lines;
}
