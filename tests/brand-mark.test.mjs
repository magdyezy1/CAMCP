// V2-WEB-01: the approved mark is an immutable input to the new palette.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

test('web/mark.svg is byte-identical to the approved brand mark', () => {
  const mark = fs.readFileSync('web/mark.svg');
  assert.equal(mark.length, 283);
  assert.equal(
    createHash('sha256').update(mark).digest('hex'),
    '8eb1af93f49f222633c80c9eabc208c0a309c0decd7b954a5b3048711cc2ec21',
  );
});
