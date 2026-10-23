# Explicit PDF/Excel language and Arabic reading order — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `1281bd9`. Batch 76 extends B24/B28 and repairs F-148.

Snapshot presentation, approved client branding and local file destinations now expose an explicit PDF/Excel
language choice. `artifact_language` is optional `en`/`ar`, independent of interface language. Legacy omitted
settings retain their exact shape, English default and destination creation fingerprint. Existing confirmation,
role, source-account and revision requirements remain. Edits revoke approval; queued files freeze their original
presentation. A partial-format retry keeps the first accepted file's bytes and generates only the missing format.

Arabic workbooks translate authored sheet/header labels, use RTL sheet views and retain native metric IDs next to
their translated headings. Numeric cells, native IDs with leading zeroes, custom identifiers, provider values,
formula-looking literal names and unknowns are preserved. Every non-Report data row matches the English workbook.
Source JSON is unchanged. This is presentation only: no recomputation, FX conversion or recollection is introduced.

PDFs now order complete Arabic phrases correctly while retaining logical text for font shaping. Unicode runs
handle punctuation, Latin IDs, dates, decimals, Arabic-Indic digits and combining marks. Logical wrapping stays
within the existing page area and page bounds. Native values beside Arabic labels use explicit direction isolation.
Language metadata, original logical marked text, embedded font and byte-identical source-evidence attachment are
retained. A long compact title/footer render exposed reversed parentheses during implementation; that regression
was corrected and checked visually. Both standard languages and the compact stress fixture have two pages, each
rendered with Poppler and inspected. Browser and PDF/UA/assistive-technology acceptance are not claimed.

Nine new tests cover explicit/default/invalid languages, workbook values, PDF evidence, bidi text, independent UI
language and original-job retry behavior. Five language/UI tests were observed red before implementation; the
direction module initially failed because it did not exist, and its punctuation assertion later failed before the
levels-array fix. The related group passed **37/37**, then the corrected direction/artifact group **6/6**.
Full-suite and sanitized qualification are recorded below and in [PROGRESS.md](PROGRESS.md).
Logs and local renders: `.runtime/artifact-localization-20261001/`.

Dependency decision: pin MIT-licensed `bidi-js@1.0.3` for Unicode bidirectional ordering; Fontkit shapes individual
runs but does not perform paragraph ordering. Its sole dependency, `require-from-string`, was already locked.
The lockfile records SHA-512 integrity
`sha512-RKshQI1R3YQ+n9YJz2QQ147P66ELpa1FQEg20Dk8oW9t2KgLbpDLLp9aGZ7y8WHSshDknG0bknqGw5/tyCs5tw==`.
Production dependency audit returned zero advisories. The narrow local type declaration follows the pinned source:
its mirroring API takes the levels array, despite the README example. References: [bidi-js](https://github.com/lojjic/bidi-js),
[PDFKit text](https://pdfkit.org/docs/text.html) and [marked content](https://pdfkit.org/docs/accessibility.html).
No dependency lifecycle scripts ran. A complete tagged document/accessibility certification is separate work.

Native ledgers remain **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked writes**.
The blueprint matrix remains **13 implemented / 14 partial / 1 open**. Remaining diagnostic translation and Arabic
editorial/browser/keyboard acceptance stay explicit. There is no schema migration, provider write, permission
expansion, external message, production deployment or private-root-sample read.

Batch 75 follow-through: exact HEAD `1281bd9843efe60a8ab5127c46511d37107341d4` passed every check/Railway stage
in `.release/reference-import-work-here-head-20261001`: **3,343 passed, zero failed, five local FFmpeg skips;
76.82 seconds**, four capture tests and byte parity for **1,463 public source files** plus one generated empty sample.
Hash: `316b3b53197af97623ac5eb1354565e630695f72b4b9db504bde02aaa1a89be8`.
[CI130](https://github.com/magdyezy1/CAMCP/actions/runs/36923344150) and
[CI129](https://github.com/magdyezy1/CAMCP/actions/runs/36920411136) remain pending at the latest check.
[CI128](https://github.com/magdyezy1/CAMCP/actions/runs/36917584932) passed on `0f4d615`: host and Docker each
passed **3,325 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container smokes.
Job `110555260851` uploaded artifact `11192412694`.

Batch 76 qualification continued into 2 October (Africa/Cairo). Final root suite: **3,357 tests; 3,352 passed,
zero failed, five local FFmpeg skips; 74.32 seconds**. Production audit: zero advisories.

Sanitized preflight `.release/artifact-localization-preflight-20261001` passed every check/Railway stage:
**3,352 passed, zero failed, five local FFmpeg skips; 77.02 seconds**, four capture tests, 30 browser scripts
and 242 documents. Its **1,469 public source files** plus one generated empty sample have hash
`dfad8d9be9e359eb5a5815d61e518f3c20442e3e3dcd0fc213e3fb5596a16686`. Exact committed-source checks follow before push.
