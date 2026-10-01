import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {webcrypto, createHash} from 'node:crypto';

function fixture() {
  const c = createContext({TextDecoder, Uint8Array, crypto: webcrypto, uiText: x => x});
  new Script(readFileSync('web/report-reference.js', 'utf8')).runInContext(c);
  return {
    read: (file, delimiter = ',') => c.readReferenceCSV(file, delimiter),
    values: (...args) => c.referenceCSVValues(...args),
  };
}
const file = bytes => ({
  size: bytes.length,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

test('reference CSV reads UTF-8 and BOM-marked UTF-16 exactly and hashes original bytes', async () => {
  const f = fixture();
  const csv = '"Cost, currency",Clicks,Unmapped\r\n9007199254740993.13,10,"private, note"\r\n';
  const be = Buffer.from(csv, 'utf16le').swap16();
  for (const [bytes, encoding] of [
    [Buffer.from(csv), 'utf-8'],
    [Buffer.concat([Buffer.from([255, 254]), Buffer.from(csv, 'utf16le')]), 'utf-16le'],
    [Buffer.concat([Buffer.from([254, 255]), be]), 'utf-16be'],
  ]) {
    const parsed = await f.read(file(bytes));
    assert.equal(parsed.encoding, encoding);
    assert.equal(parsed.sha256, createHash('sha256').update(bytes).digest('hex'));
    const out = f.values(parsed, {spend: 0, clicks: 1}, {spend: 0}, 'decimal_dot');
    assert.deepEqual(JSON.parse(JSON.stringify(out.totals)), {spend: '9007199254740993.13', clicks: '10'});
    assert.equal(out.file.columns.spend, 'Cost, currency');
    assert.doesNotMatch(JSON.stringify(out), /private|Unmapped/);
  }
});

test('CSV reference money scales and decimal separators are explicit and preserve unknowns and exact precision', async () => {
  const f = fixture();
  const parsed = await f.read(file(Buffer.from('Spend;Value;Conversions\n9007199254740993130000;12,34;\n')), ';');
  const out = f.values(
    parsed,
    {spend: 0, conversion_value: 1, conversions: 2},
    {spend: 6, conversion_value: 2},
    'decimal_comma',
  );
  assert.deepEqual(JSON.parse(JSON.stringify(out.totals)), {
    spend: '9007199254740993.13',
    conversion_value: '0.1234',
    conversions: null,
  });
  assert.throws(() => f.values(parsed, {spend: 0, clicks: 0}, {spend: 0}, 'decimal_dot'));
  assert.throws(() => f.values(parsed, {reach: 0}, {}, 'decimal_dot'));
  for (const value of ['1,234.56', '1.234,56', '1e3', 'NaN', '-1', '=SUM(A1:A2)', '12%', '1 000', '١٢']) {
    const p = await f.read(file(Buffer.from('Value\n"' + value + '"\n')));
    assert.throws(() => f.values(p, {spend: 0}, {spend: 0}, 'decimal_dot'), value);
  }
  const precision = await f.read(file(Buffer.from('Value\n0.0001\n')));
  assert.throws(() => f.values(precision, {spend: 0}, {spend: 6}, 'decimal_dot'));
});

test('CSV importer rejects ambiguous totals, malformed quoting, duplicate headers, invalid encodings and oversized files before reading', async () => {
  const f = fixture();
  for (const text of [
    'Cost\n1\n2\n',
    'Cost,Cost\n1,2\n',
    ',Cost\n1,2\n',
    'Cost,Clicks\n1\n',
    'Cost\n"unclosed',
    'Cost\n"1"text\n',
    'Cost\n1"2\n',
    'Cost\n\0\n',
  ])
    await assert.rejects(f.read(file(Buffer.from(text))), undefined, text);
  await assert.rejects(f.read(file(Buffer.from([0x43, 0x0a, 0xc3, 0x28]))));
  let touched = false;
  await assert.rejects(
    f.read({
      size: 65537,
      arrayBuffer: async () => {
        touched = true;
        return new ArrayBuffer(65537);
      },
    }),
  );
  assert.equal(touched, false);
  await assert.rejects(f.read(file(Buffer.from('Cost|Clicks\n1|2\n')), '|'));
});
