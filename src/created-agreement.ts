import type {JsonObject} from './types.js';
import {stable} from './security.js';

/**
 * Whether a listed object is what a review froze (R2.5 M2, lead review S2-3). A created lookup finds the object by its name and
 * parent, but a name is no identity: another create of the same name, in the same minutes, that differs in a field, is another
 * object. So a match counts as this write's only when the fields the provider echoes agree with those the request names. The
 * provider-neutral part of that rule lives here; each provider's lookup names its pairs.
 */
/** A field of the frozen request and the field of a listed object that echoes it. */
export type Echo = readonly [request: string, listed: string];
const digits = /^-?\d+(?:\.\d+)?$/;
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const snake = (s: string) => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
/** Two values as a provider writes and echoes them: numbers and their digits by value, anything else exactly (case included). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (
    (typeof a === 'number' || typeof a === 'string') &&
    (typeof b === 'number' || typeof b === 'string') &&
    digits.test(String(a)) &&
    digits.test(String(b))
  )
    return Number(a) === Number(b);
  return stable(a) === stable(b);
}
/** A field of a request body, whichever way it is spelled (snake_case or camelCase, as Google takes both). */
export const frozen = (request: JsonObject, field: string): unknown =>
  request[field] ?? request[camel(field)] ?? request[snake(field)];
/**
 * Every field the provider echoes of those the request names holds the same value. A field the object does not echo (absent or
 * null), or the request does not name, is not compared: the lookup asks only what it can be told.
 */
export function agrees(request: JsonObject, listed: JsonObject, echoes: readonly Echo[]): boolean {
  return echoes.every(([asked, echoed]) => {
    const want = frozen(request, asked),
      got = listed[echoed];
    return want === undefined || got === undefined || got === null || sameValue(want, got);
  });
}
