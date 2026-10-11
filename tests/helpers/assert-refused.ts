import assert from 'node:assert/strict';

/**
 * The TypeScript form of tests/helpers/assert-refused.mjs (QA-02): `result` must be a refusal with exactly `code` (or
 * one of the listed codes), never INTERNAL_ERROR, and with no provider write sent when `writes` is given. Returns true
 * for assert.throws.
 */
export function assertRefused(
  result: unknown,
  code: string | readonly string[],
  options: {writes?: number | (() => number); status?: number; message?: RegExp} = {},
): true {
  const expected: readonly string[] = typeof code === 'string' ? [code] : code;
  assert.ok(
    expected.length > 0 && expected.every(c => typeof c === 'string' && c),
    'assertRefused needs the expected refusal code',
  );
  assert.ok(!expected.includes('INTERNAL_ERROR'), 'a crash is not a refusal: name the code the refusal must carry');
  const r = result as {
    code?: string;
    message?: string;
    status?: number;
    success?: boolean;
    error?: {code?: string; message?: string; status?: number};
  };
  let actual: string | undefined, detail: string | undefined;
  if (result instanceof Error || (r && typeof r === 'object' && 'code' in r && !('success' in r))) {
    actual = r.code;
    detail = r.message;
    if (options.status !== undefined) assert.equal(r.status, options.status, 'refusal status');
  } else {
    assert.ok(r && typeof r === 'object', 'expected a refusal, got ' + String(result));
    assert.equal(r.success, false, 'expected a refusal, got success: ' + JSON.stringify(result).slice(0, 500));
    actual = r.error?.code;
    detail = r.error?.message;
    // A service result carries an HTTP status only when its envelope names one; never ignore a requested status.
    if (options.status !== undefined) {
      assert.ok(
        typeof r.error?.status === 'number',
        'refusal status ' + options.status + ' was requested, but this service result carries no HTTP status',
      );
      assert.equal(r.error?.status, options.status, 'refusal status');
    }
  }
  assert.notEqual(actual, 'INTERNAL_ERROR', 'refused by a crash (INTERNAL_ERROR): ' + detail);
  if (expected.length === 1) assert.equal(actual, expected[0], 'refusal code (' + detail + ')');
  else
    assert.ok(
      actual !== undefined && expected.includes(actual),
      'refusal code ' + actual + ' is not one of ' + expected.join(', ') + ' (' + detail + ')',
    );
  if (options.message) assert.match(String(detail), options.message);
  if (options.writes !== undefined)
    assert.equal(typeof options.writes === 'function' ? options.writes() : options.writes, 0, 'provider writes sent');
  return true;
}
