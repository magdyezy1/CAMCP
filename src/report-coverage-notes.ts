import {coverageCounts} from './report-math-v4.js';
import {metricDefinitions} from './report-metrics.js';
import type {JsonObject} from './types.js';

/**
 * Why a summarized figure is not the whole story (F-L5-01, "every total says what it covers"). A figure is calculated from
 * the units that have the values it needs and leaves the rest out, so a total can be right and still be short:
 * - `missing_values`: a sum; some units have no value for it, and they are never counted as 0;
 * - `missing_inputs`: a ratio or formula; it uses only the units that have every value it needs;
 * - `unknown_currency`, `non_additive_inputs`, `calculation_limit`: the figure is not calculated at all, and says why.
 */
export const coverageReasons = [
  'missing_values',
  'missing_inputs',
  'unknown_currency',
  'non_additive_inputs',
  'calculation_limit',
] as const;
export type CoverageReason = (typeof coverageReasons)[number];
/** One metric of a summary (or of a row) that was calculated from fewer units than it has, or not at all. */
export interface CoverageNote {
  metric: string;
  /** The units that had the values the figure needs. */
  known: number;
  /** The units it could have been calculated from. */
  total: number;
  /** What a unit is: a row of the report, or one of the provider's own measurements (usually a day) a row was built from. */
  unit: 'rows' | 'measurements';
  reason: CoverageReason;
}

/**
 * The facts about the metrics of one summary (or row) that are short, in the order of `fields` (default: the order
 * `metrics_coverage` has them). It is the one computation every surface renders: the window summary card, the CSV, the
 * Excel workbook, the PDF and the Sheets tab. A metric whose coverage is complete is not listed, so an empty list means
 * every figure was calculated from all of its units. Stored coverage is read through `coverageCounts`, whichever build
 * wrote it; an entry whose counts cannot be read is not listed, because there is nothing to say about it.
 */
export function reportCoverageNotes(source: JsonObject, fields?: readonly string[]): CoverageNote[] {
  const coverage: unknown = source?.metrics_coverage;
  if (!coverage || typeof coverage !== 'object') return [];
  const notes: CoverageNote[] = [];
  for (const metric of fields ?? Object.keys(coverage)) {
    if (!Object.hasOwn(coverage, metric)) continue;
    const entry: JsonObject | null = (coverage as JsonObject)[metric];
    if (!entry || typeof entry !== 'object') continue;
    const {known, total} = coverageCounts(entry);
    if (!Number.isInteger(known) || !Number.isInteger(total)) continue;
    const sum = metric === 'primary_result' || metricDefinitions[metric]?.aggregation === 'sum',
      reason: CoverageReason | null = entry.unavailable_reason
        ? entry.unavailable_reason
        : known < total
          ? sum
            ? 'missing_values'
            : 'missing_inputs'
          : null;
    if (reason)
      notes.push({
        metric,
        known,
        total,
        // Earlier builds called every unit a measurement while counting rows, so only a count written with this build's
        // `total_rows` is believed to count measurements.
        unit: entry.total_rows !== undefined && entry.basis === 'native_measurements' ? 'measurements' : 'rows',
        reason,
      });
  }
  return notes;
}

export type CoverageLanguage = 'en' | 'ar';
const unitWords = {
  en: {
    rows: ['row', 'rows'],
    measurements: ['measurement', 'measurements'],
  },
  ar: {
    rows: ['الصفوف', 'الصفوف'],
    measurements: ['القياسات', 'القياسات'],
  },
} as const;
/**
 * One note in words, in the report's language. `name` is how the surface names the metric (its column, or its label), so
 * the line matches the heading it sits beside. The counts come after a colon in Arabic, where a number before a noun
 * would have to agree with it.
 */
export function reportCoverageLine(note: CoverageNote, name: string, language: CoverageLanguage = 'en'): string {
  const [single, many] = unitWords[language][note.unit];
  switch (note.reason) {
    case 'unknown_currency':
      return language === 'ar'
        ? `${name}: لا يُجمع (عملات الصفوف مختلفة أو غير معروفة)`
        : `${name}: not added (the rows are in different or unknown currencies)`;
    case 'non_additive_inputs':
      return language === 'ar'
        ? `${name}: لا يمكن حسابه من عدة صفوف`
        : `${name}: cannot be calculated from several rows`;
    case 'calculation_limit':
      return language === 'ar'
        ? `${name}: لم يُحسب (يتجاوز ما يُسمح بحسابه في تقرير واحد)`
        : `${name}: not calculated (it exceeds what one report may calculate)`;
    default:
      return language === 'ar'
        ? `${name}: ${single} ${note.known} من ${note.total}`
        : `${name}: ${note.known} of ${note.total} ${note.total === 1 ? single : many}`;
  }
}
/** What "n of m" means, said once beside the lines: units without a value are left out, never counted as 0. */
export function reportCoverageHelp(language: CoverageLanguage = 'en'): string {
  return language === 'ar'
    ? 'تُستبعد الصفوف التي لا قيمة لها من الإجمالي ولا تُحتسب صفرًا. وتعتمد النسب على الصفوف التي تتوفر فيها كل القيم اللازمة فقط، لذلك قد تختلف عن قسمة إجمالي على إجمالي آخر.'
    : 'Rows with no value are left out of a total and never counted as 0. A ratio uses only the rows that have every value it needs, so it can differ from one total divided by another.';
}
/** The lines of one summary or row: one per short metric, in the report's language. */
export function reportCoverageLines(
  source: JsonObject,
  fields: readonly string[] | undefined,
  language: CoverageLanguage,
  name: (metric: string) => string,
): string[] {
  return reportCoverageNotes(source, fields).map(note => reportCoverageLine(note, name(note.metric), language));
}
