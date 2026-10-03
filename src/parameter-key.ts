/** One native alias comparison, shared by compilation and bounded reporting metadata. */
export const nativeParameterKey = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/[^a-z0-9]/gi, '').toLowerCase() : '';
