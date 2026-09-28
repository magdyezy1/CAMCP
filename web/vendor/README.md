# Vendored browser libraries

The website's Content-Security-Policy allows scripts from its own origin only, so third-party browser code is copied
here unchanged and served from `/assets/vendor/`.

| File | Package | Licence | Source and checks |
|---|---|---|---|
| `qrcode-generator-2.0.4.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 by Kazuhiko Arase (`dist/qrcode.js`) | MIT (header of the file) | npm tarball integrity `sha512-mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g==` (matches the registry); file SHA-256 `79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c`. No eval, DOM or style access; AMCP uses only `qrcode()`, `addData`, `make`, `getModuleCount` and `isDark`, and draws the SVG itself. |

Update by replacing the file with a newer release, recording its integrity here, and running `npm run check:web`.
