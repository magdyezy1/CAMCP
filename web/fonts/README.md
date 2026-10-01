# Embedded report font

`NotoSansArabic.ttf` is the unmodified Noto Sans Arabic variable font from
[Google Fonts](https://github.com/google/fonts/tree/main/ofl/notosansarabic), downloaded on 2026-10-01.
It covers Arabic and Latin text used by server-generated report PDFs. `OFL.txt` retains the SIL Open Font License.
The Arabic website interface also uses this local font through `localization.css`; English does not request it.
The file is shipped with the application so PDF rendering never requests a font from a third party.
Unsupported characters cause an explicit PDF error; Excel and HTML preserve their full text.
