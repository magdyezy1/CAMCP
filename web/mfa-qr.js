'use strict';
/** The otpauth:// URI as an SVG QR code (vendored qrcode-generator, error correction M). Empty if the encoder is missing. */
function mfaQr(uri) {
  if (typeof qrcode !== 'function') return '';
  const q = qrcode(0, 'M');
  q.addData(uri, 'Byte');
  q.make();
  const n = q.getModuleCount(),
    quiet = 4,
    size = n + 2 * quiet;
  let d = '';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
  return (
    '<svg class="mfa-qr" viewBox="0 0 ' +
    size +
    ' ' +
    size +
    '" role="img" aria-label="QR code for your authenticator app" shape-rendering="crispEdges"><rect width="' +
    size +
    '" height="' +
    size +
    '" fill="#fff"/><path d="' +
    d +
    '" fill="#000"/></svg>'
  );
}
