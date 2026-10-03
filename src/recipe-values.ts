import {MirrorError} from './errors.js';

/** Exact native units shared by guided recipes; no floating-point rounding. */
export function recipeMoney(v: unknown, scale: number, name: string) {
  if ((typeof v !== 'string' && typeof v !== 'number') || !/^\d+(\.\d{1,6})?$/.test(String(v)) || Number(v) <= 0)
    throw new MirrorError('INVALID_RECIPE_MONEY', 'Use a positive decimal ' + name + ' in account currency.');
  const [whole, fraction = ''] = String(v).split('.'),
    digits = String(scale).length - 1;
  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits)))
    throw new MirrorError('INVALID_RECIPE_MONEY', 'This currency/API cannot represent that budget precision.');
  const n = BigInt(whole!) * BigInt(scale) + BigInt(fraction.slice(0, digits).padEnd(digits, '0') || '0');
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new MirrorError('INVALID_RECIPE_MONEY', 'Budget is too large.');
  return n.toString();
}
