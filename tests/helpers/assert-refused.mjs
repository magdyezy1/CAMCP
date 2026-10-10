import assert from 'node:assert/strict';

/**
 * A typed refusal oracle (QA-02): asserts that `result` is a refusal with exactly `code`, never INTERNAL_ERROR (a crash
 * the service audits as a refusal), and, when `writes` is given, that no provider write was sent.
 *
 * `result` is a service result ({success:false, error:{code}}), a thrown error with `code` (MirrorError), or a
 * rejected promise's reason. `writes` is a number or a function returning the current count of provider writes.
 * Returns true, so it can be the validator of assert.throws or assert.rejects.
 *
 *   assertRefused(await service.call(...), 'STATE_CHANGED', {writes: () => writes});
 *   assert.throws(() => compile(x), e => assertRefused(e, 'INVALID_ARGUMENT'));
 */
export function assertRefused(result, code, {writes, status, message} = {}) {
  assert.equal(typeof code, 'string', 'assertRefused needs the expected refusal code');
  assert.notEqual(code, 'INTERNAL_ERROR', 'a crash is not a refusal: name the code the refusal must carry');
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
  assert.equal(actual, code, 'refusal code (' + detail + ')');
  if (message !== undefined) assert.match(String(detail), message);
  if (writes !== undefined) assert.equal(typeof writes === 'function' ? writes() : writes, 0, 'provider writes sent');
  return true;
}
