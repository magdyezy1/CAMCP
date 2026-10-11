import assert from 'node:assert/strict';

/**
 * A typed refusal oracle (QA-02): asserts that `result` is a refusal with exactly `code`, never INTERNAL_ERROR (a crash
 * the service audits as a refusal), and, when `writes` is given, that no provider write was sent.
 *
 * `result` is a service result ({success:false, error:{code}}), a thrown error with `code` (MirrorError), or a
 * rejected promise's reason. `code` is the expected code, or the list of codes a loop over several refusals may give
 * (each still a named refusal, never a crash). `writes` is a number or a function returning the current count of
 * provider writes. Returns true, so it can be the validator of assert.throws or assert.rejects.
 *
 *   assertRefused(await service.call(...), 'STATE_CHANGED', {writes: () => writes});
 *   assert.throws(() => compile(x), e => assertRefused(e, 'INVALID_ARGUMENT'));
 */
export function assertRefused(result, code, {writes, status, message} = {}) {
  const expected = Array.isArray(code) ? code : [code];
  assert.ok(
    expected.length > 0 && expected.every(c => typeof c === 'string' && c),
    'assertRefused needs the expected refusal code',
  );
  assert.ok(!expected.includes('INTERNAL_ERROR'), 'a crash is not a refusal: name the code the refusal must carry');
  let actual, detail;
  if (result instanceof Error || (result && typeof result === 'object' && 'code' in result && !('success' in result))) {
    actual = result.code;
    detail = result.message;
    if (status !== undefined) assert.equal(result.status, status, 'refusal status');
  } else {
    assert.ok(result && typeof result === 'object', 'expected a refusal, got ' + String(result));
    assert.equal(result.success, false, 'expected a refusal, got success: ' + JSON.stringify(result).slice(0, 500));
    actual = result.error?.code;
    detail = result.error?.message;
  }
  assert.notEqual(actual, 'INTERNAL_ERROR', 'refused by a crash (INTERNAL_ERROR): ' + detail);
  if (expected.length === 1) assert.equal(actual, expected[0], 'refusal code (' + detail + ')');
  else
    assert.ok(
      expected.includes(actual),
      'refusal code ' + actual + ' is not one of ' + expected.join(', ') + ' (' + detail + ')',
    );
  if (message !== undefined) assert.match(String(detail), message);
  if (writes !== undefined) assert.equal(typeof writes === 'function' ? writes() : writes, 0, 'provider writes sent');
  return true;
}
