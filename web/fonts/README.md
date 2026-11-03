# Local Arabic fonts

`NotoSansArabic.ttf` is the unmodified Noto Sans Arabic variable font from
[Google Fonts](https://github.com/google/fonts/tree/main/ofl/notosansarabic), downloaded on 2026-10-01.
It covers Arabic and Latin text used by server-generated report PDFs. `OFL.txt` retains the SIL Open Font License.
The TTF stays unchanged for PDF generation (844,676 bytes; SHA-256
`63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e`).
It ships with the application so PDF rendering never requests a font from a third party.
Unsupported characters cause an explicit PDF error; Excel and HTML preserve their full text.

The Arabic website interface uses `NotoSansArabic-subset.woff2` through `localization.css` and `privacy.css`.
It contains the requested U+0020, U+00A0, U+0600–06FF, U+200C–200F and U+2066–2069 code points and their shaping
dependencies. The CSS limits that face to those ranges, so Latin text uses the system font stack. The weight axis
remains 100–900 (default 400); width is pinned to its default 100. Both faces use `font-display: swap`.

The subset is 68,180 bytes, below the 250,000-byte bound. SHA-256:
`b356a7252e33db86dbb577c27001249329f97029ec1036c44386c002dc445395`.
It was made from the original TTF with `subsetFont(ttf, text, {targetFormat: 'woff2', variationAxes: {wdth: 100}})`.
The temporary tool installation used exactly `subset-font@2.9.0`, `harfbuzzjs@1.6.4`, `fontverter@2.0.0`,
`wawoff2@2.0.1`, `woff2sfnt-sfnt2woff@1.0.0` and `p-limit@3.1.0`; these are not application dependencies.
The measured size is below the planning estimate; glyph and axis checks verify its required coverage.
Font checks cover the Arabic catalogs, locale chunks and Arabic HTML pages; `OFL.txt` continues to cover both files.
