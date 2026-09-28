import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

// The two-step setup QR code: the vendored encoder (web/vendor, CSP same-origin) and AMCP's SVG drawing of it.
const vendored = 'web/vendor/qrcode-generator-2.0.4.js';
const load = () => {
  const context = createContext({});
  new Script(readFileSync(vendored, 'utf8')).runInContext(context);
  new Script(readFileSync('web/mfa-qr.js', 'utf8')).runInContext(context);
  return context;
};

test('the vendored QR encoder is the recorded release', () => {
  const recorded = /`qrcode-generator-2\.0\.4\.js`[^\n]*file SHA-256 `([0-9a-f]{64})`/.exec(
    readFileSync('web/vendor/README.md', 'utf8'),
  );
  assert.ok(recorded, 'web/vendor/README.md records the file digest');
  assert.equal(createHash('sha256').update(readFileSync(vendored)).digest('hex'), recorded[1]);
});

test('the setup QR draws exactly the encoder modules of the otpauth URI, with a quiet zone', () => {
  const context = load(),
    uri =
      'otpauth://totp/AMCP%3Amember%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=AMCP&algorithm=SHA1&digits=6&period=30';
  context.uri = uri;
  const svg = new Script('mfaQr(uri)').runInContext(context);
  const q = new Script("(()=>{const q=qrcode(0,'M');q.addData(uri,'Byte');q.make();return q;})()").runInContext(
    context,
  );
  const n = q.getModuleCount(),
    size = n + 8;
  assert.match(svg, new RegExp('viewBox="0 0 ' + size + ' ' + size + '"'));
  assert.match(svg, /role="img" aria-label="QR code for your authenticator app"/);
  const drawn = new Set([...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(m => m[1] + ',' + m[2]));
  let dark = 0;
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      assert.equal(drawn.has(c + 4 + ',' + (r + 4)), q.isDark(r, c), 'module ' + r + ',' + c);
      if (q.isDark(r, c)) dark++;
    }
  assert.equal(drawn.size, dark, 'nothing drawn outside the symbol');
  // No inline style: the CSP allows none; colours are SVG presentation attributes.
  assert.doesNotMatch(svg, /style=/);
});

test('without the encoder the setup falls back to the link and the key', () => {
  const context = createContext({});
  new Script(readFileSync('web/mfa-qr.js', 'utf8')).runInContext(context);
  assert.equal(new Script("mfaQr('otpauth://totp/x?secret=A')").runInContext(context), '');
});
