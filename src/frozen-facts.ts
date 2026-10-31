/**
 * `value` with every object and array it holds frozen, for the rows a provider declares in its adapter (ARC-01, wave 4c
 * round 6): the shared module that lists them copies them into the plain table it exports. A pattern must not be
 * global or sticky, so a frozen one keeps no position between matches.
 */
export function deepFrozen<T>(value: T, seen = new WeakSet<object>()): T {
  if (value instanceof RegExp && (value.global || value.sticky))
    throw new Error('A frozen fact pattern must not be global or sticky: ' + String(value) + '.');
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    Object.freeze(value);
    for (const item of Object.values(value)) deepFrozen(item, seen);
  }
  return value;
}
