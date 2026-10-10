/**
 * The one spreadsheet formula guard for every CSV AMCP writes (SEC-04). OWASP "CSV Injection" lists the cell prefixes a
 * spreadsheet evaluates: equals, plus, minus, at, tab and carriage return. A string cell is shown as literal text, with a
 * leading apostrophe, when
 * - after optional leading whitespace or control characters it starts with = + - @ or their full-width forms
 *   (U+FF1D, U+FF0B, U+FF0D, U+FF20), which spreadsheets normalize to the ASCII triggers; or
 * - it starts with a tab, carriage return or line feed, even with no trigger after it.
 * Numbers are never strings here, so a negative amount stays a number; a name such as "-20% sale" gains the apostrophe.
 */
const formulaPrefix = /^(?:[\s\u0000-\u001f]*[=+\-@＝＋－＠]|[\t\r\n])/;
export function neutralizeCsvCell(value: string): string {
  return formulaPrefix.test(value) ? "'" + value : value;
}
/** One quoted CSV field: a string is neutralized, then quotes are doubled. */
export function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return '"' + (typeof value === 'string' ? neutralizeCsvCell(text) : text).replaceAll('"', '""') + '"';
}
