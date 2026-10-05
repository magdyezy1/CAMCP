import ExcelJS from 'exceljs';
import {Writable} from 'node:stream';
import {setImmediate} from 'node:timers/promises';
import {MirrorError} from './errors.js';
import {withReportArtifactBudget} from './report-artifacts.js';
import {artifactLocale} from './report-localization.js';
import type {JsonObject} from './types.js';

const fields = [
  'entity_id',
  'entity_name',
  'date',
  'search_term',
  'spend',
  'impressions',
  'clicks',
  'conversions',
  'conversion_value',
  'reach',
  'frequency',
];
const metrics = fields.slice(4);
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const limit = (message: string): never => {
  throw new MirrorError('REPORT_ARTIFACT_LIMIT', message + ' exceeds the evidence download limit.', {}, 413);
};
function scalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    !['string', 'boolean', 'number'].includes(typeof value) ||
    (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER))
  )
    throw new MirrorError('EXPORT_INVALID_VALUE', 'Evidence cells require safe scalar text values.');
  const text = String(value);
  if (text.length > 32767) limit('Excel cell text');
  return text;
}
function timestamp(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime()))
    throw new MirrorError('EXPORT_INVALID_VALUE', 'Evidence capture time is invalid.');
  return new Date(value).toISOString();
}
/** Exact retained cells: no numeric coercion, formulas, hyperlinks, provider reads or retained binary. */
export async function evidenceWorkbook(report: JsonObject, language = 'en') {
  if (!['en', 'ar'].includes(language))
    throw new MirrorError('INVALID_ARGUMENT', 'Choose an evidence workbook language: en or ar.');
  if (!Array.isArray(report.rows) || report.rows.length > 10000) limit('Evidence rows');
  if (
    !object(report.semantics) ||
    !object(report.mapping) ||
    !object(report.totals) ||
    report.rows.some((r: unknown) => !object(r))
  )
    throw new MirrorError(
      'EXPORT_INVALID_VALUE',
      'Retained evidence requires mapped scalar rows and measurement settings.',
    );
  const fieldKeys = [
      ...fields,
      ...(Object.hasOwn(report.mapping, 'keyword_match_type') ? ['keyword_match_type'] : []),
      ...(Object.hasOwn(report.mapping, 'native_device') ? ['native_device'] : []),
      ...(Object.hasOwn(report.mapping, 'native_hour') ? ['native_hour'] : []),
    ],
    locale = artifactLocale({artifact_language: language}),
    t = locale.text;
  const cover: unknown[][] = [
    [t('REPORT'), t('DETAIL')],
    [t('Title'), report.semantics.source_name],
    [t('Evidence ID'), report.id],
    [t('Platform'), report.gateway],
    [t('Account ID'), report.account_id],
    [t('Connection ID'), report.connection_id],
    [t('Preset'), report.preset ?? null],
    [t('Native grain'), report.grain ?? null],
    [t('Source rows'), report.rows.length],
    [t('Collected at'), timestamp(report.captured_at)],
    [t('Source hash'), report.source_hash],
    [t('Currency'), report.semantics.currency],
    [t('Timezone'), report.semantics.timezone],
    [t('Date from'), report.semantics.date_from],
    [t('Date through'), report.semantics.date_to],
    [t('Attribution'), report.semantics.attribution],
    [t('Conversion definition'), report.semantics.conversion_definition],
    [t('Declared complete'), report.semantics.complete],
    [t('Measurement provenance'), report.semantics_source],
    [
      t('Values'),
      t('Numeric metrics are stored as text to preserve precision; use retained totals before converting cells.'),
    ],
    [
      t('Interpretation'),
      t(
        'Blank cells are unknown or unmapped. See Field mappings for coverage. Attribution and completeness are retained settings, not independent verification.',
      ),
    ],
    [t('Evidence'), t('Source references link this workbook to the retained report and selected account/page checks.')],
  ];
  for (const key of [
    'overview_id',
    'group_id',
    'snapshot_revision',
    'snapshot_created_at',
    'snapshot_captured_at',
    'definition_fingerprint',
  ])
    if (report.source_lineage?.[key] !== undefined) cover.push([key, report.source_lineage[key]]);
  const totals: unknown[][] = [
    ['metric', 'value', 'coverage'],
    ...metrics.map(key => [key, report.totals[key] ?? null, report.coverage?.[key] ?? 'unknown']),
  ];
  const mappings: unknown[][] = [
    ['field', 'path', 'divisor', 'action_type', 'format', 'coverage'],
    ...fieldKeys.map(key => {
      const spec = report.mapping[key];
      return [
        key,
        typeof spec === 'string' ? spec : (spec?.path ?? null),
        typeof spec === 'object' ? (spec?.divisor ?? null) : null,
        typeof spec === 'object' ? (spec?.action_type ?? null) : null,
        typeof spec === 'object' ? (spec?.format ?? null) : null,
        report.coverage?.[key] ?? (spec === undefined ? 'unmapped' : 'mapped'),
      ];
    }),
  ];
  const refs: unknown[][] = [
    ['kind', 'page', 'rows', 'source_hash', 'captured_at'],
    [
      report.source_collection ?? report.source,
      null,
      report.rows.length,
      report.source_hash,
      timestamp(report.captured_at),
    ],
  ];
  const account = report.native_account_evidence;
  const checks = account?.checks ?? (account?.source_hash ? [account] : []),
    pages = report.source_pages ?? [],
    parent = account?.parent_campaign,
    parentChecks = parent === undefined ? [] : parent?.checks;
  if (
    !Array.isArray(checks) ||
    checks.length > 100 ||
    !Array.isArray(pages) ||
    pages.length > 100 ||
    !Array.isArray(parentChecks) ||
    parentChecks.length > 102
  )
    limit('Source reference count');
  if (parent !== undefined) {
    if (!object(parent) || typeof parent.id !== 'string' || !parent.id)
      throw new MirrorError('EXPORT_INVALID_VALUE', 'Parent campaign evidence requires its exact retained ID.');
    cover.push([t('Parent campaign ID'), parent.id]);
  }
  for (const [kind, items] of [
    ['account', checks],
    ['parent_campaign', parentChecks],
    ['page', pages],
  ] as const)
    for (const ref of items) {
      if (!object(ref)) throw new MirrorError('EXPORT_INVALID_VALUE', 'Source references require scalar metadata.');
      refs.push([kind, ref.page ?? null, ref.row_count ?? null, ref.source_hash, timestamp(ref.captured_at)]);
    }
  const sheets = [
    {name: 'Report', rows: cover, widths: [30, 100]},
    {
      name: 'Native rows',
      rows: [fieldKeys, ...report.rows.map((r: JsonObject) => fieldKeys.map(key => r[key] ?? null))],
      widths: [30, 48, 18, 48, 32, 24, 24, 24, 32, 24, 24, ...(fieldKeys.length > fields.length ? [28] : [])],
    },
    {name: 'Metric totals', rows: totals, widths: [28, 36, 24]},
    {name: 'Field mappings', rows: mappings, widths: [28, 60, 18, 45, 25, 20]},
    {name: 'Source references', rows: refs, widths: [28, 12, 14, 72, 30]},
  ];
  let cells = 0,
    textBytes = 0;
  for (const sheet of sheets)
    for (const row of sheet.rows)
      for (const cell of row) {
        cells++;
        const value = scalar(cell);
        if (value !== null) textBytes += Buffer.byteLength(value);
        if (cells > 125000 || textBytes > 8 * 1024 * 1024) limit('Evidence cells or text');
      }
  let bytes = 0;
  const chunks: Buffer[] = [],
    stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes <= 20 * 1024 * 1024) chunks.push(chunk);
        done();
      },
    }),
    book = new ExcelJS.stream.xlsx.WorkbookWriter({stream, useStyles: true, useSharedStrings: false});
  book.creator = 'AMCP';
  book.title = String(report.semantics.source_name ?? report.id);
  book.created = new Date(report.captured_at ?? 0);
  book.modified = book.created;
  for (const sheet of sheets) {
    const page = book.addWorksheet(t(sheet.name), {
      views: [{state: 'frozen', ySplit: 1, ...(locale.rtl ? {rightToLeft: true} : {})}],
      pageSetup: {
        orientation: 'landscape',
        paperSize: 9,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        printTitlesRow: '1:1',
      },
    });
    page.columns = sheet.widths.map(width => ({
      width,
      style: {numFmt: '@', alignment: {vertical: 'top', wrapText: true}},
    }));
    if (sheet.rows.length > 1)
      page.autoFilter = {from: {row: 1, column: 1}, to: {row: sheet.rows.length, column: sheet.rows[0]!.length}};
    for (let i = 0; i < sheet.rows.length; i++) {
      const values: (string | null)[] = sheet.rows[i]!.map(scalar),
        row = page.addRow(values);
      const lines = Math.max(
        1,
        ...values.map((value, index) =>
          (value ?? '')
            .split(/\r?\n/)
            .reduce(
              (count, line) => count + Math.max(1, Math.ceil(line.length / Math.max(1, sheet.widths[index]! * 0.85))),
              0,
            ),
        ),
      );
      row.height = i === 0 ? 30 : Math.min(150, Math.max(28, lines * 16 + 8));
      row.eachCell(cell => {
        cell.font = {
          name: locale.rtl ? 'Arial' : 'Calibri',
          size: 11,
          ...(i === 0 ? {bold: true, color: {argb: 'FFFFFFFF'}} : {}),
        };
        cell.alignment = {
          ...cell.alignment,
          readingOrder: /[\p{Script=Arabic}]/u.test(String(cell.value ?? '')) ? 'rtl' : 'ltr',
        };
        if (i === 0) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FF354B67'}};
        else if (i % 2 === 1) cell.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF1F4F8'}};
      });
      row.commit();
      if (i % 250 === 249) await setImmediate();
    }
    page.commit();
  }
  await book.commit();
  if (bytes > 20 * 1024 * 1024) limit('Workbook bytes');
  return Buffer.concat(chunks, bytes);
}
export function evidenceArtifact(tenant: string, report: JsonObject, language = 'en') {
  return withReportArtifactBudget(tenant, () => evidenceWorkbook(report, language));
}
