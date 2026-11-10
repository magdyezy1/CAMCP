import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import {openSync} from 'fontkit';
import {resolve} from 'node:path';
import {Writable} from 'node:stream';
import {setImmediate} from 'node:timers/promises';
import {MirrorError} from './errors.js';
import {reportTable, reportNoticeMessages, reportTableFields} from './report-table.js';
import {reportCoverageHelp, reportCoverageLines} from './report-coverage-notes.js';
import {reportLevelCheckLines} from './report-level-check.js';
import {exactNumber, keptAsText, keptAsTextNote} from './export-number.js';
import {metricDefinitions} from './report-metrics.js';
import {reportSource} from './report-sources.js';
import {overviewConfigV4} from './overview-v4.js';
import {reportEvidence, exportSourceStatus} from './report-quality.js';
import {reportPack, presentationStyle} from './report-packs.js';
import type {JsonObject} from './types.js';
import {artifactLocale} from './report-localization.js';
import {drawPdfText} from './pdf-text.js';
import {drawChartsSection, readableCharts} from './report-chart-pdf.js';
import {reportRollupLabel} from './report-scope-rollups.js';

const limits = {
  rows: 25000,
  cells: 500000,
  evidence_bytes: 2 * 1024 * 1024,
  output_bytes: 20 * 1024 * 1024,
  cell_text_bytes: 32 * 1024 * 1024,
  pdf_groups: 500,
};
const exceeded = (what: string): never => {
  throw new MirrorError(
    'REPORT_ARTIFACT_LIMIT',
    what + ' exceeds the download limit. Narrow this report or use CSV and evidence downloads.',
    {},
    413,
  );
};
function evidence(report: JsonObject) {
  const json = JSON.stringify(reportEvidence(report), null, 2);
  if (Buffer.byteLength(json) > limits.evidence_bytes) exceeded('Source evidence size');
  return json;
}
function scalar(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new MirrorError('EXPORT_INVALID_NUMBER', 'A report value is not a finite number.');
    return value;
  }
  if (typeof value === 'boolean') return value;
  const text = String(value);
  if (text.length > 32767)
    throw new MirrorError(
      'EXPORT_CELL_TOO_LARGE',
      'An Excel cell exceeds 32,767 characters. Download source evidence separately and narrow the report.',
    );
  // Assign a string value, never an ExcelJS formula/hyperlink/rich-text object, even for =, +, - or @ names.
  return text;
}
/**
 * What each summary of a v4 report says about its coverage (F-L5-01), in the artifact's language, one entry per summary in
 * order with the lines of its short metrics (none when it is complete). Other reports have no coverage to state.
 */
function summaryCoverage(
  report: JsonObject,
  summaries: JsonObject[],
  locale: ReturnType<typeof artifactLocale>,
  fields: readonly string[],
  custom: Set<string>,
) {
  return summaries.map(summary => ({
    summary,
    lines:
      report.config?.contract_version === overviewConfigV4
        ? reportCoverageLines(summary, fields, locale.language, metric => locale.metric(metric, custom))
        : [],
  }));
}
/**
 * The cross-level check of each selected source of a v4 report in words, in the artifact's language (F-L5-05): the lines
 * of the source record the snapshot holds for it, empty for a source of one level or one the snapshot has no record of.
 */
function levelChecks(report: JsonObject, locale: ReturnType<typeof artifactLocale>) {
  const levelName = (platform: string, level: string) =>
      locale.text(
        reportSource(platform)?.overview?.levels?.find((item: JsonObject) => item.id === level)?.label ?? level,
      ),
    metricName = (metric: string) =>
      locale.rtl ? locale.metric(metric, new Set()) : (metricDefinitions[metric]?.label ?? metric);
  return (report.config?.sources ?? []).map((selected: JsonObject) => {
    const found = (report.sources ?? []).find((s: JsonObject) =>
      ['platform', 'connection_id', 'account_id'].every(k => s.source?.[k] === selected[k]),
    );
    return found && report.config?.contract_version === overviewConfigV4
      ? reportLevelCheckLines(found, locale.language, levelName, metricName).map(line => line.text)
      : [];
  }) as string[][];
}
/** Which group of rows a line of the report sheet speaks about. */
const summaryIdentity = (s: JsonObject, platformNames: JsonObject) =>
  [
    platformNames[s.platform] ?? s.platform,
    s.account_id,
    s.entity_level ?? 'campaign',
    s.currency,
    s.date_from + ' - ' + s.date_to,
  ]
    .filter(Boolean)
    .join(' | ');
export async function reportWorkbook(report: JsonObject, presentation: JsonObject = {}) {
  const pack = reportPack(report),
    style = presentationStyle(presentation),
    rows = report.rows,
    locale = artifactLocale(style),
    t = locale.text,
    custom = new Set<string>((report.config.custom_metrics ?? []).map((m: JsonObject) => m.id)),
    coverage = summaryCoverage(report, pack.summary, locale, reportTableFields(report), custom),
    covered = coverage.filter(item => item.lines.length),
    // A report of several levels has one summary per level, which are told apart by the level.
    leveled =
      report.config?.contract_version === overviewConfigV4 && pack.summary.some((s: JsonObject) => s.entity_level),
    // A total rolled up from the selected children of a parent says so beside the total (F-L5-11).
    aggregated = pack.summary.some((s: JsonObject) => s.aggregation?.label),
    // A v4 report keeps its metrics as exact decimal text. The workbook writes the number when the text is exactly that
    // number, so SUM and number formats work, and keeps as text, and says so, what a number would round (F-L5-07).
    exact = report.config?.contract_version === overviewConfigV4,
    kept = exact
      ? [...report.rows, ...pack.summary].reduce(
          (count: number, source: JsonObject) =>
            count + reportTableFields(report).filter(field => keptAsText(source.metrics?.[field])).length,
          0,
        )
      : 0;
  const columns =
    (report.config.metrics?.length ?? 6) +
    (report.config.custom_metrics?.length ?? 0) +
    30 +
    (reportNoticeMessages(report).length ? 1 : 0);
  if (rows.length > limits.rows || (rows.length + pack.summary.length + 1) * columns > limits.cells)
    exceeded('Workbook rows or cells');
  const source = evidence(report);
  const accent = style.accent_color.slice(1).toUpperCase();
  const sheets: {name: string; values: unknown[][]; widths: number[]; metricStart: number; metricCount: number}[] = [];
  function sheet(name: string, values: unknown[][], widths: number[] = [], metricStart = 0, metricCount = 0) {
    const resultColumn = values[0]!.indexOf('Primary result');
    if (resultColumn >= 0)
      for (const row of values.slice(1)) row[resultColumn] = locale.result(String(row[resultColumn] ?? ''));
    const aggregationColumn = values[0]!.indexOf('Aggregation');
    if (aggregationColumn >= 0)
      for (const row of values.slice(1)) row[aggregationColumn] = t(String(row[aggregationColumn] ?? ''));
    const noticeColumn = values[0]!.indexOf('Report notices');
    if (noticeColumn >= 0)
      for (const row of values.slice(1))
        row[noticeColumn] = String(row[noticeColumn] ?? '')
          .split('\n')
          .map(t)
          .join('\n');
    values[0] = values[0]!.map((value, index) =>
      index + 1 >= metricStart && index + 1 < metricStart + metricCount
        ? locale.metric(String(value), custom)
        : t(String(value)),
    );
    if (name === 'Report')
      for (const row of values.slice(1)) {
        const label = String(row[0]);
        row[0] = t(label);
        if (['Interpretation', 'Evidence', 'Values', 'Note', 'Limitation'].includes(label)) row[1] = t(String(row[1]));
      }
    sheets.push({name: t(name), values, widths, metricStart, metricCount});
  }
  sheet(
    'Report',
    [
      ['REPORT', 'DETAIL'],
      ['Title', pack.title],
      ['Client', style.brand_name || pack.client_name],
      ['Period', pack.date_range.since + ' - ' + pack.date_range.until],
      ['Snapshot state', pack.state],
      ...covered.map(item => [
        'Coverage',
        summaryIdentity(item.summary, pack.platform_names) + ': ' + item.lines.join('; '),
      ]),
      ...(covered.length ? [['Coverage', reportCoverageHelp(locale.language)]] : []),
      ...(kept ? [['Precision', keptAsTextNote(kept, locale.language)]] : []),
      ['Snapshot ID', pack.snapshot_id],
      ['Collected at', new Date(pack.created_at ?? 0).toISOString()],
      ['Source rows', pack.row_count],
      ['Source hash', pack.source_hash],
      [
        'Interpretation',
        'Each account, currency, timezone, result definition, attribution and period remains separate. Blank metrics are unknown.',
      ],
      [
        'Evidence',
        'Evidence sheet column C contains ordered chunks of the complete source-evidence JSON. Join them without separators.',
      ],
      [
        'Values',
        'These are retained snapshot values, including already-calculated ratios; editing rows does not recalculate the saved summaries.',
      ],
      ['Prepared by', style.footer],
      ...pack.notes.map((message: string) => ['Note', message]),
      ...pack.limitations.map(t => ['Limitation', t]),
    ],
    [24, 100],
  );
  const metrics = [
    ...new Set<string>([
      ...(report.config.metrics ?? ['spend', 'impressions', 'clicks', 'conversions', 'cpa', 'roas']),
      ...(report.config.custom_metrics ?? []).map((m: JsonObject) => m.id),
    ]),
  ];
  sheet(
    'Account summaries',
    [
      [
        'Platform',
        'Account ID',
        'Objective',
        'Currency',
        'Timezone',
        'Date from',
        'Date to',
        'Attribution',
        'Primary result',
        'Complete',
        ...metrics,
        ...(leveled ? ['Entity level'] : []),
        ...(aggregated ? ['Aggregation'] : []),
        ...(covered.length ? ['Coverage'] : []),
      ],
      ...pack.summary.map((s: JsonObject, index: number) => [
        s.platform,
        String(s.account_id),
        s.objective_group,
        s.currency,
        s.timezone,
        s.date_from,
        s.date_to,
        s.attribution,
        s.result_definition,
        s.complete,
        ...metrics.map(k => s.metrics[k]),
        ...(leveled ? [s.entity_level ?? 'campaign'] : []),
        ...(aggregated ? [s.aggregation?.label ?? ''] : []),
        ...(covered.length ? [coverage[index]!.lines.join('\n')] : []),
      ]),
    ],
    [],
    11,
    metrics.length,
  );
  const detailed = rows.some((row: JsonObject) => row.entity_level && row.entity_level !== 'campaign');
  sheet(
    detailed ? 'Entity rows' : 'Campaign rows',
    reportTable(report, Date.now(), 2, style),
    [18, 22, 24, 48, 20, 12, 28, 18, 18],
    detailed ? 16 : 10,
    metrics.length,
  );
  const sources = exportSourceStatus(report).selected_sources,
    checks = levelChecks(report, locale),
    checked = checks.some(lines => lines.length);
  sheet('Source coverage', [
    [
      'Platform',
      'Account ID',
      'Connection',
      'Status',
      'Rows',
      'Error code',
      'Warning count',
      'Query fingerprint',
      ...(checked ? ['Level check'] : []),
    ],
    ...sources.map((s: JsonObject, index: number) => [
      s.platform,
      s.account_id,
      s.connection_id,
      s.status,
      s.row_count,
      s.error?.code,
      s.warning_count,
      s.query_fingerprint,
      ...(checked ? [checks[index]!.join('\n')] : []),
    ]),
  ]);
  const chunks: unknown[][] = [['Document', 'Part', 'JSON text']];
  for (let at = 0; at < source.length; at += 30000)
    chunks.push(['source-evidence.json', chunks.length, source.slice(at, at + 30000)]);
  sheet('Evidence', chunks, [28, 12, 100]);
  // Validate before starting the ZIP stream, so invalid cells cannot strand a partial writer.
  let textBytes = 0;
  for (const {values} of sheets)
    for (const r of values)
      for (const cell of r) {
        const value = scalar(cell);
        if (typeof value === 'string') textBytes += Buffer.byteLength(value);
        if (textBytes > limits.cell_text_bytes) exceeded('Workbook text size');
      }
  const outputChunks: Buffer[] = [];
  let outputBytes = 0;
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      outputBytes += chunk.length;
      // Continue draining the bounded input when over limit; never retain an oversized output.
      if (outputBytes <= limits.output_bytes) outputChunks.push(chunk);
      done();
    },
  });
  const book = new ExcelJS.stream.xlsx.WorkbookWriter({stream, useStyles: true, useSharedStrings: false});
  book.creator = 'AMCP';
  book.title = pack.title;
  book.subject = t('Retained reporting snapshot');
  book.created = new Date(pack.created_at ?? 0);
  book.modified = book.created;
  for (const {name, values, widths, metricStart, metricCount} of sheets) {
    const s = book.addWorksheet(name, {
      views: [{state: 'frozen', ySplit: 1, ...(locale.rtl ? {rightToLeft: true} : {})}],
      properties: {defaultRowHeight: 24},
      pageSetup: {
        orientation: 'landscape',
        paperSize: 9,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        printTitlesRow: '1:1',
      },
    });
    s.columns = values[0]!.map((_, i) => ({
      width: widths[i] ?? 22,
      style: {
        alignment: {vertical: 'top', wrapText: true, ...(locale.rtl ? {readingOrder: 'ltr' as const} : {})},
        ...(i + 1 >= metricStart && i + 1 < metricStart + metricCount ? {numFmt: '#,##0.00;[Red](#,##0.00);0'} : {}),
      },
    }));
    if (values.length > 1)
      s.autoFilter = {from: {row: 1, column: 1}, to: {row: values.length, column: values[0]!.length}};
    for (let i = 0; i < values.length; i++) {
      const r = s.addRow(
        values[i]!.map((cell, column) =>
          scalar(
            exact && i > 0 && column + 1 >= metricStart && column + 1 < metricStart + metricCount
              ? (exactNumber(cell) ?? cell)
              : cell,
          ),
        ),
      );
      if (locale.rtl)
        r.eachCell(c => {
          c.alignment = {
            ...c.alignment,
            readingOrder: /[\p{Script=Arabic}]/u.test(String(c.value ?? '')) ? 'rtl' : 'ltr',
          };
        });
      if (i === 0) {
        r.height = 32;
        r.eachCell(c => {
          c.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FF' + accent}};
          c.font = {name: locale.rtl ? 'Arial' : 'Calibri', size: 11, bold: true, color: {argb: 'FFFFFFFF'}};
        });
      } else {
        let lines = 1;
        r.eachCell((c, column) => {
          lines = Math.max(lines, Math.ceil(String(c.value ?? '').length / ((widths[column - 1] ?? 22) * 0.9)));
        });
        r.height = Math.min(180, Math.max(24, lines * 15));
        r.font = {name: locale.rtl ? 'Arial' : 'Calibri', size: 11};
        if (i % 2 === 1)
          r.eachCell(c => {
            c.fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFF1F4F8'}};
          });
      }
      r.commit();
      if (i % 250 === 249) await setImmediate();
    }
    s.commit();
  }
  await book.commit();
  if (outputBytes > limits.output_bytes) exceeded('Workbook size');
  return Buffer.concat(outputChunks, outputBytes);
}

export async function reportPdf(report: JsonObject, presentation: JsonObject = {}) {
  const pack = reportPack(report),
    style = presentationStyle(presentation),
    locale = artifactLocale(style),
    t = locale.text;
  if (pack.summary.length > limits.pdf_groups) exceeded('PDF measurement groups');
  const checks = levelChecks(report, locale),
    charts = readableCharts(report.charts);
  // The figures the PDF prints for each summary: its fixed six and the custom metrics.
  const printed = [
      'spend',
      'impressions',
      'clicks',
      'conversions',
      'cpa',
      'ctr',
      ...pack.custom_metrics.map((m: JsonObject) => m.id),
    ],
    coverage = summaryCoverage(
      report,
      pack.summary,
      locale,
      printed,
      new Set<string>(pack.custom_metrics.map((m: JsonObject) => m.id)),
    );
  const source = evidence(report),
    fontPath = resolve('web/fonts/NotoSansArabic.ttf'),
    font = openSync(fontPath);
  if (!('hasGlyphForCodePoint' in font)) throw Error('Report font is not a single font.');
  const doc = new PDFDocument({
    size: 'A4',
    margin: 44,
    bufferPages: true,
    lang: locale.language,
    info: {Title: pack.title, Author: style.brand_name || 'AMCP', Subject: t('Retained reporting snapshot')},
  });
  doc.font(fontPath);
  const chunks: Buffer[] = [];
  let bytes = 0;
  const finished = new Promise<Buffer>((accept, reject) => {
    doc.on('data', (b: Buffer) => {
      bytes += b.length;
      if (bytes > limits.output_bytes)
        doc.destroy(new MirrorError('REPORT_ARTIFACT_LIMIT', 'PDF exceeds the download size limit.'));
      else chunks.push(b);
    });
    doc.on('error', reject);
    doc.on('end', () => accept(Buffer.concat(chunks)));
  });
  // Attach the listener before drawing and handle synchronous layout failures as stream failures too.
  const text = (value: unknown, size = 10, color = '#26344A') => {
    const s = String(value ?? t('Unknown'));
    if (
      [...s].some(
        c =>
          !/[\n\r\t\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(c) &&
          !font.hasGlyphForCodePoint(c.codePointAt(0)!),
      )
    )
      throw new MirrorError(
        'PDF_UNSUPPORTED_GLYPH',
        'This report contains a character outside the embedded PDF font. Use Excel or HTML to preserve the complete text.',
      );
    doc.fontSize(size).fillColor(color);
    if (locale.rtl || /[\p{Script=Arabic}]/u.test(s)) drawPdfText(doc, s, locale.rtl);
    else doc.text(s, {width: 507, lineGap: 3});
  };
  const room = (height: number) => {
    if (doc.y + height > doc.page.height - 65) doc.addPage();
  };
  const amount = (v: unknown) =>
    v === null || v === undefined
      ? t('Unknown')
      : typeof v === 'number'
        ? v.toLocaleString('en-US', {maximumFractionDigits: 4})
        : String(v);
  const isolated = (v: unknown) => (locale.rtl ? '\u2068' + String(v) + '\u2069' : String(v));
  const measure = (v: unknown, suffix = '') => isolated(amount(v) + suffix);
  try {
    text(style.brand_name || pack.client_name || t('AMCP REPORT'), 12, style.accent_color);
    doc.moveDown(0.4);
    text(pack.title, 24);
    text(pack.date_range.since + ' - ' + pack.date_range.until, 11);
    doc.moveDown(0.5);
    text(
      t(pack.state.toUpperCase() + ' SNAPSHOT') + '  |  ' + pack.row_count + ' ' + t('source rows'),
      10,
      style.accent_color,
    );
    text(t('Collected') + ' ' + isolated(new Date(pack.created_at ?? 0).toISOString()), 9);
    for (const label of new Set<string>(report.rows.map(reportRollupLabel).filter(Boolean))) text(t(label), 10);
    doc.moveDown(0.5);
    if (pack.state === 'partial') {
      text(
        t('Partial evidence: some sources or periods are incomplete. Review coverage before interpreting results.'),
        11,
        '#9A4A12',
      );
      doc.moveDown(0.5);
    }
    text(t('Account and measurement summaries'), 15);
    text(
      t(
        'Groups retain their own currency, timezone, attribution, conversion definition and reporting period. Missing values remain unknown.',
      ),
      9,
    );
    doc.moveDown(0.7);
    for (const [index, s] of (pack.summary as JsonObject[]).entries()) {
      const lines = coverage[index]!.lines;
      room((style.template === 'compact' ? 160 : 190) + 12 * lines.length);
      const top = doc.y;
      doc.moveTo(44, top).lineTo(551, top).strokeColor(style.accent_color).stroke();
      doc.y += 10;
      text(
        s.platform + ' | ' + s.account_id + ' | ' + s.objective_group + (s.entity_level ? ' | ' + s.entity_level : ''),
        12,
        style.accent_color,
      );
      text(s.date_from + ' - ' + s.date_to + ' | ' + s.currency + ' | ' + s.timezone, 9);
      // A total rolled up from the selected children of a parent is not that parent's own total (F-L5-11).
      if (s.aggregation?.label) text(t(s.aggregation.label), 9);
      text(
        t('Attribution') +
          ': ' +
          isolated(s.attribution) +
          ' | ' +
          t('Result') +
          ': ' +
          isolated(locale.result(s.result_definition)) +
          ' | ' +
          t(s.complete ? 'Complete' : 'Incomplete'),
        9,
      );
      doc.moveDown(0.4);
      text(
        t('Spend') +
          ' ' +
          measure(s.metrics.spend, ' ' + (s.currency ?? '')) +
          '   |   ' +
          t('Impressions') +
          ' ' +
          measure(s.metrics.impressions) +
          '   |   ' +
          t('Clicks') +
          ' ' +
          measure(s.metrics.clicks),
        10,
      );
      text(
        t('Conversions') +
          ' ' +
          measure(s.metrics.conversions) +
          '   |   ' +
          isolated('CPA ' + amount(s.metrics.cpa) + ' ' + (s.currency ?? '')) +
          '   |   ' +
          isolated('CTR ' + amount(s.metrics.ctr) + (s.metrics.ctr === null || s.metrics.ctr === undefined ? '' : '%')),
        10,
      );
      for (const m of pack.custom_metrics) text(isolated(m.label) + ': ' + measure(s.metrics[m.id]), 9);
      // A figure calculated from some of its rows says so beside the figures it qualifies (F-L5-01).
      for (const line of lines) text(isolated(line), 9, '#9A4A12');
      doc.moveDown(style.template === 'compact' ? 0.6 : 1.1);
    }
    // The charts the snapshot stored when it finished (V2-EXP-01): none for a report from before they existed.
    if (charts.length)
      drawChartsSection(charts, {
        doc,
        locale,
        text,
        room,
        accent: style.accent_color,
        hasGlyph: code => font.hasGlyphForCodePoint(code),
      });
    room(160);
    text(t('Source coverage'), 15);
    doc.moveDown(0.3);
    for (const [index, s] of (exportSourceStatus(report).selected_sources as JsonObject[]).entries()) {
      const check = checks[index] ?? [];
      room(75 + 12 * check.length);
      text(s.platform + ' | ' + s.account_id + ' | ' + s.status + ' | ' + amount(s.row_count) + ' ' + t('rows'), 11);
      if (s.error) text(t('Source error') + ': ' + isolated(s.error.code), 9, '#9A4A12');
      // Whether the levels of this source agree, and where they do not, by how much (F-L5-05).
      for (const line of check) text(isolated(line), 9);
      doc.moveDown(0.4);
    }
    room(160);
    text(t('Reading this report'), 15);
    if (pack.notes.length) {
      text(t('Notes'), 12);
      for (const note of pack.notes) text('- ' + t(note), 9);
    }
    for (const limitation of pack.limitations) text('- ' + t(limitation), 9);
    if (coverage.some(item => item.lines.length)) text('- ' + reportCoverageHelp(locale.language), 9);
    text(
      t(
        'Full source evidence is embedded as source-evidence.json. Campaign rows are available in the Excel and CSV downloads.',
      ),
      9,
    );
    doc.moveDown(0.5);
    text(t('Snapshot') + ': ' + isolated(pack.snapshot_id), 8);
    text(t('Source hash') + ': ' + isolated(pack.source_hash), 8);
    if (style.footer) {
      doc.moveDown(0.5);
      text(style.footer, 9);
    }
    doc.file(Buffer.from(source), {
      name: 'source-evidence.json',
      type: 'application/json',
      description: t('Complete source evidence for this retained snapshot'),
    });
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .fontSize(8)
        .fillColor('#5B677B')
        .text('AMCP | ' + (i + 1) + ' / ' + pages.count, 44, doc.page.height - 35, {
          lineBreak: false,
          width: 507,
          align: locale.rtl ? 'right' : 'left',
        });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  } catch (error) {
    doc.destroy(error instanceof Error ? error : Error('Report rendering failed.'));
  }
  return finished;
}

const activeTenants = new Set<string>();
let active = 0;
/** One generation per tenant and two per process. No queue, temporary public files or background delivery. */
export async function withReportArtifactBudget<T>(tenant: string, generate: () => Promise<T>): Promise<T> {
  if (active >= 2 || activeTenants.has(tenant))
    throw new MirrorError(
      'REPORT_DOWNLOAD_BUSY',
      'A report download is being generated. Wait for it to finish before requesting another.',
      {},
      429,
    );
  active++;
  activeTenants.add(tenant);
  try {
    return await generate();
  } finally {
    active--;
    activeTenants.delete(tenant);
  }
}
export async function reportArtifact(
  tenant: string,
  report: JsonObject,
  format: 'pdf' | 'xlsx',
  presentation: JsonObject,
) {
  return withReportArtifactBudget(tenant, () =>
    format === 'pdf' ? reportPdf(report, presentation) : reportWorkbook(report, presentation),
  );
}
