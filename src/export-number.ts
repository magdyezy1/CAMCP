/**
 * The number a spreadsheet cell holds for an exact decimal metric (F-L5-07). A v4 report keeps every metric as exact decimal
 * text, so a workbook that wrote the text would make `SUM` give 0 and leave number formats unapplied. A spreadsheet cell
 * is a double, so the text becomes a number only when the double prints back as the same decimal: then nothing is lost
 * and the cell is the number the text says. A decimal with more digits than a double holds (a 30-digit total, a nine-place
 * fraction of a large amount) stays text, so no digit is ever changed to make it numeric.
 */
const decimal = /^-?\d+(?:\.\d+)?$/;
/** The plain decimal text of a decimal text: no leading zeros, no trailing fraction zeros, no negative zero. */
function canonical(text: string): string {
  const negative = text.startsWith('-'),
    [whole = '', fraction = ''] = (negative ? text.slice(1) : text).split('.'),
    integer = whole.replace(/^0+(?=\d)/, ''),
    tail = fraction.replace(/0+$/, ''),
    digits = integer + (tail ? '.' + tail : '');
  return (negative && digits !== '0' ? '-' : '') + digits;
}
/** The plain decimal text a double prints as, without the exponent notation JavaScript uses past 1e21 and below 1e-6. */
function plain(value: number): string {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(Math.abs(value)));
  if (!match) return '';
  let digits = match[1]! + (match[2] ?? ''),
    point = match[1]!.length + Number(match[3] ?? 0);
  if (point <= 0) {
    digits = '0'.repeat(1 - point) + digits;
    point = 1;
  } else if (point > digits.length) digits += '0'.repeat(point - digits.length);
  return canonical((value < 0 ? '-' : '') + digits.slice(0, point) + '.' + digits.slice(point));
}
/** The double that is exactly this decimal text, or null: not a decimal, or more digits than a double holds. */
export function exactNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !decimal.test(value) || value.length > 40) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || plain(number) !== canonical(value)) return null;
  return Object.is(number, -0) ? 0 : number;
}
/** Whether a cell is an exact decimal text a number could not hold, which is therefore kept as text. */
export const keptAsText = (value: unknown): boolean =>
  typeof value === 'string' && decimal.test(value) && exactNumber(value) === null;
/** What the Excel report sheet says about the metric values kept as text: how many, and why. Counts follow a colon. */
export function keptAsTextNote(count: number, language: 'en' | 'ar' = 'en'): string {
  return language === 'ar'
    ? `قيم المقاييس المحفوظة نصًّا لأن الرقم لا يتسع لكل أرقامها: ${count}. وسائر قيم المقاييس أرقام.`
    : `Metric values kept as text, because a number holds fewer digits than they have: ${count}. All other metric values are numbers.`;
}
/** The sentence a Sheets column note adds when some of the column's values are kept as text. */
export const keptAsTextColumnNote = 'Values with more digits than a number holds exactly are kept as text.';
