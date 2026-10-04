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

/** A declared ROAS ratio, never currency/micros or an inferred percentage. Native Google transport uses a double. */
export function recipeRoas(v: unknown): {text: string; native: number} {
  if (typeof v !== 'string' || !/^\d{1,8}(?:\.\d{1,6})?$/.test(v))
    throw new MirrorError(
      'INVALID_RECIPE_ROAS',
      'Provide a ROAS ratio as decimal text with at most six decimal places.',
    );
  const [whole, fraction = ''] = v.split('.'),
    units = BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0') || '0');
  if (units < 10000n || units > 1000000000n)
    throw new MirrorError('INVALID_RECIPE_ROAS', 'Use a ROAS ratio from 0.01 to 1000 inclusive; 3.5 means 350%.');
  const tail = (units % 1000000n).toString().padStart(6, '0').replace(/0+$/, ''),
    text = (units / 1000000n).toString() + (tail ? '.' + tail : '');
  return {text, native: Number(text)};
}
