import {MirrorError} from './errors.js';
import {currencyMinorDigits, minimumUnitMicros} from './budget-units.js';
import type {JsonObject} from './types.js';
import type {RecipeInputSpec} from './provider-adapter.js';

/** An input that takes one of `values` as text, frozen; the letters of a value match whatever their case (the default of every recipe input). */
export const recipeChoices = (values: readonly string[], more: Partial<RecipeInputSpec> = {}): RecipeInputSpec =>
  Object.freeze({type: 'enum', values: Object.freeze([...values]), case_insensitive: true, ...more});
/** An input that takes one of a few whole numbers, frozen (given as the number or its decimal text). */
export const recipeNumbers = (values: readonly number[]): RecipeInputSpec =>
  Object.freeze({type: 'integer', values: Object.freeze([...values])});
/** The JSON type of a brief value as a refusal names it: a list and `null` are told apart from an object. */
export const recipeValueType = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
/**
 * The capital letters A to Z to their small forms, and nothing else. A full Unicode fold would take the Kelvin sign for K and the dotless i
 * for I, which are other letters and not the same value, so a value would gain synonyms (AMCP-08, "no trimming and no synonyms").
 */
const foldLetters = (text: string) => text.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));
/** The value a brief gives for one input of fixed values, as the recipe sends it, or undefined when it names none of them. */
function matchedValue(given: unknown, spec: RecipeInputSpec): string | number | undefined {
  const values = spec.values ?? [];
  if (spec.type === 'integer')
    return values.find(
      v => (typeof given === 'number' && v === given) || (typeof given === 'string' && String(v) === given),
    );
  // Only a yes/no declaration takes a boolean, and each boolean is the one value it means (AMCP-08): never a default.
  if (typeof given === 'boolean') return spec.accepts_boolean?.[given ? 'true' : 'false'];
  if (typeof given !== 'string') return undefined;
  const exact = values.find(v => v === given);
  if (exact !== undefined || !spec.case_insensitive) return exact;
  return values.find(v => typeof v === 'string' && foldLetters(v) === foldLetters(given));
}
/**
 * The one reader of an input that takes one of a fixed set of values (AMCP-08 F8-2, R2.5 field3), for every recipe of every platform: the
 * set is the input's own declaration (`inputs` of the recipe's definition), so a builder keeps no second list of what it compares against.
 * Left out or blank is `RECIPE_INPUT_REQUIRED` (naming the input and the values it takes), and an `optional` input left out is no input
 * (undefined). A value of the wrong type, or outside the set, is `RECIPE_INPUT_INVALID` with the input, the type received and the values
 * accepted, never "missing". A match after folding the letters of the exact value (where the input folds) gives the listed value; nothing
 * else is folded: no trimming, no synonyms.
 */
export function recipeEnum(
  b: JsonObject,
  key: string,
  spec: RecipeInputSpec,
  optional = false,
): string | number | undefined {
  const given = b[key];
  if (given === undefined || given === '') {
    if (optional) return undefined;
    throw new MirrorError('RECIPE_INPUT_REQUIRED', 'Complete the brief before creating the campaign plan.', {
      missing_fields: [key],
      allowed: [...(spec.values ?? [])],
    });
  }
  const found = matchedValue(given, spec);
  if (found !== undefined) return found;
  throw new MirrorError(
    'RECIPE_INPUT_INVALID',
    'Choose one of the values this recipe input accepts; the details list them.',
    {field: key, received_type: recipeValueType(given), allowed: [...(spec.values ?? [])]},
  );
}

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

/**
 * Exact micros of a Google amount in the account currency (WRT-07 Stage A): no more decimal places than the currency
 * has (JPY none, USD two, KWD three), because Google refuses a budget that is not a multiple of the currency's smallest
 * unit (NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT) and a bid with too many fractional digits. Refused at prepare, before any
 * provider request.
 */
export function recipeCurrencyMicros(v: unknown, currency: unknown, name: string): string {
  const micros = recipeMoney(v, 1000000, name),
    unit = minimumUnitMicros(currency),
    digits = currencyMinorDigits(currency);
  if (unit === undefined || digits === undefined)
    throw new MirrorError('INVALID_RECIPE_MONEY', 'Unknown account currency.');
  // One fixed sentence (translated on the website); the details name the field, the value and the currency's places.
  if (BigInt(micros) % unit !== 0n)
    throw new MirrorError(
      'INVALID_RECIPE_MONEY',
      'This amount has more decimal places than the account currency, so Google cannot charge it. Round it to the currency’s smallest unit: JPY and CLP take whole amounts, USD two decimal places, KWD three.',
      {field: name, value: String(v), currency, decimal_places: digits, minimum_unit_micros: String(unit)},
    );
  return micros;
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
