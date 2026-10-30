---
status: record
tier: engineering
---

# Delivery — selected browser WCAG rules — 5 October 2026

Repository magdyezy1/CAMCP; sole branch Work-here; workspace CAMCP-Codes-final-branch.
Baseline 90953318c522f7091e559d1f72a7d1dae782d79d. This delivery expands the existing local
qualification and corrects reproduced website behavior. It preserves the 28-package matrix
of 13 implemented / 14 partial / one open and the owner-directed hosted Actions waiver.

## Reproduced behavior and corrections

- Four dark sidebar disclosure labels measured 2.94:1 at 12 CSS pixels. Their scoped foreground
  now uses the existing identity-compatible light shade #c0b9d2.
- Landing-page captions measured 2.42:1, 2.61:1, 4.11:1, 2.86:1 and 3.72:1. Only the selected
  stage caption, floating-chip subtitle, stage footer, mini-plan label and mini-plan value use
  the existing muted/iris tokens or the scoped light shade, with a 12-pixel caption floor.
- Workspace search previously exposed Search workspace pages while visible English said Search
  workspace plus Ctrl K; Arabic also used a different phrase. The translated visible label and
  actual shortcut now name the control through two explicit IDs and a real intervening space.
  aria-keyshortcuts describes the existing Control/Meta handler. Keyboard behavior is unchanged.
- The standalone owner settings link in Operations measured 21 pixels high with insufficient
  spacing in the narrow English case. It now uses the existing button appearance and a scoped
  44-pixel minimum, bounded width and wrapping. The original route and ownership condition remain.

## Maintained optional inspection

The runner accepts AMCP_QA_AXE_PATH only as an explicit absolute path to a local axe.min.js.
The engine is axe-core 4.14.0, 652,140 bytes, SHA-256
20c09fe157a8a34a30e241aaa1fcdade657734f08ab379ecfbeb7d45cc46e878.
The observed package integrity is
sha512-9WTZxEjsZ7b13TH8JPmbV2z8CHbl80/2hm3XPEG4JgNdQLK81IBRXmSxHfMAOkSqQeRxT/0dwNDz2GOm3zzpcQ==.
A missing, wrong, oversized, relative or nonregular test asset refuses fixed diagnostics.
An unset path leaves this additional inspection unselected; ordinary npm run check and the
preceding browser semantics remain independent of an optional locally installed engine.
No root package/lockfile, application runtime dependency or provider transport is changed.

Both phases inject the qualified source into the owned synthetic page and inspect selected tags
wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22a and wcag22aa under a bounded local deadline.
Actual violation and incomplete rule/node/check details are retained. Unexpected engine, missing
groups or malformed rule evidence cannot become a passing result. Automated pass means zero
selected violations; manual_review_required remains true for incomplete checks.
All 408 earlier journeys, 816 semantic snapshots and exact native/read/write/recovery assertions
are retained. An axe pass alone does not certify WCAG, Arabic editorial quality or physical AT.

## Prototype and integrated qualification

Ignored owned-page prototypes retain their earlier failed variants. The initial 100-view matrix
covers 25 routes in English/Arabic at 320/1280 pixels and reaches zero selected automated
violations after the scoped corrections; 133 incomplete rule rows remain explicit manual work.
The separate four landing-page views fit without horizontal overflow. Desktop English and
narrow Arabic screenshots were inspected. These observations are scoped visual evidence.
The integrated helper tests pass 6/6 with zero failures/skips. The first website gate correctly
refused duplicated literal token colors; replacing them with their exact existing variables
passes every shipped-script/HTML/CSP/asset/style/token/confirmation check. Arabic coverage remains
7,891 selected messages with no gaps; all 8,057 entries / 1,253,491 UTF-8 bytes remain exact.
Every actual integrated working and final clean-head browser result must qualify its source.
No earlier result is relabelled. Sanitized candidates receive only literal empty live samples;
build, report, report freshness, default full checks with required FFmpeg, Railway configuration
and exact committed-source parity gate the sole push. Working-source full/report and focused changed-state checks pass; exact clean committed full/browser checks remain the sole push gate.

## Primary references and remaining scope

[axe-core engine](https://github.com/dequelabs/axe-core) and
[axe API](https://github.com/dequelabs/axe-core/blob/develop/doc/API.md) describe automated
violations and checks requiring human assessment. The selected corrections apply
[W3C text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html),
[label in name](https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html),
[target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) and
[accessible-name computation](https://www.w3.org/TR/accname-1.2/#mapping_additional_nd_name).
The 44-pixel Operations minimum is this product action policy; WCAG 2.2 minimum targets use
24 pixels with defined exceptions. All sources were checked on 5 October 2026.
Incomplete icon/avatar/text-contrast checks remain visible for manual review; their presence
is not silently converted to success. Other engines/devices, physical assistive tools, full
editorial acceptance, deployed Linux image and live provider/program acceptance remain separate.

## Populated-state audit and additional shared corrections

The first integrated full 408-case selected-rule audit passes 320 and refuses 88 cases.
It is retained as an audit, not a release qualification. Its refusals are confined to
shared pagination contrast in populated initial/final report/conversion states and keyboard
access to expanded original-record details. Earlier native/recovery checks were not waived.
Pagination text measured 3.41:1 against white. The shared component now uses the existing
muted identity token and a 12-pixel caption floor; dates, counts, paging and source values
remain unchanged. Original-record JSON now receives a named region and tabindex zero using
its existing translated disclosure title. No new Arabic phrase, JSON transformation, fetch,
write or auto-retry is introduced. The existing focus indicator applies to the code region.
The maintained runner adds balanced Shift+Tab/Tab checks around the original summary, actual
vertical/horizontal arrows when content overflows, and restoration of original focus/scroll.
It also checks unchanged provider counters around that inspection. An ignored focused runner
reuses every original assertion for all 88 reproduced cases; it cannot replace the required
fresh 408-case browser run at exact clean committed source. New sanitized full/report checks
qualify these changed source bytes before the sole guarded push.

[W3C keyboard operation](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html) and
[visible focus](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html) inform these
scoped corrections. Both primary references were checked on 5 October 2026. Broader physical
assistive/editorial/full-WCAG/live/deployed acceptance remains separate.

## Complete integrated working-source qualification

All six fresh sanitized install/build/report/freshness/default-full/Railway stages pass.
Main 4,665/4,665/0/0 in 169160.2728 ms; capture 4/4/0/0 in 85.7264 ms.
Required FFmpeg uses unchanged default concurrency with zero skips. The candidate has 1,864
public source files and one literal empty generated sample; digest 9ba284268dfa3c90efd6637c5a93dca23243d170ba10d5b110b6f6a55f19cd91.
All three tracked reports regenerate identically. The independent selected working/sanitized
application payloads match both build records: 1332 files / 52027419 bytes,
SHA-256 e33364a4dddf117cf2f49e8b969c7cbf1802c18653c7d1e48c275daa69aa4dcf.
This is Windows selected-file evidence; Docker/image/source authenticity stays separate.

The retained first complete audit has 320 passes and 88 reproduced selected-rule failures.
A first focused pass retained 86/88 passes, one original form locator deadline failure and
one original recovery assertion failure while the default full suite ran. Eight bounded
instrumented original measurement repetitions pass, but do not establish the first cause.
The failed artifacts remain; no deadline, assertion, timeout or concurrency is relaxed.
The unchanged sequential integrated repeat passes all 88 original affected journeys, 176 semantic
snapshots and 176 selected A/AA inspections with zero violations/provider egress/writes. It retains
176 phases with 330 incomplete rule rows / 8696 nodes requiring manual review.
No incomplete result is dropped or called full WCAG acceptance. All preceding native, layout,
keyboard, stale/current/manual recovery and original report assertions remain.
Preservation checks 1846 previous public files, including all 427 backend TypeScript
files, 49 unchanged web files, 670 prior test files and all 8,057 Arabic values.
Removing only the optional inspection and record-detail keyboard additions reproduces
every preceding runner assertion byte-exactly. The 8 inspected original-record regions
include 8 actual vertical arrow-key scrolls; focus and original scroll positions restore.
Fresh exact clean committed-source full/parity/browser qualification gates the sole Work-here
push; no earlier result is relabelled. Hosted Actions remain neither started nor polled.
B16/B24 remain partial and the whole matrix remains 13/14/1.

## Exact-head qualification and delivery

Code 7fba7e1 and documentation 6dda50c4 pass all six clean-head stages. Main 4,665/4,665/0/0
in 144604.2514 ms; capture 4/4/0/0 in 131.1172 ms, with required FFmpeg/default concurrency
and three byte-identical regenerated reports. Source parity covers 1,864 public Git files plus
one literal empty sample, digest 0182f774ccca358a0a4ca9191bc20e40151f668fa8f11da7c4675f43bcbf3dfe.
The final browser run passes 408/408/0 with 816 semantic snapshots, 27,030 named controls,
816 pinned selected-rule inspections and eight original-record regions/eight real vertical
keyboard scrolls. Zero automated violations coexist with 770 manual-review phases, 1,337
incomplete rule rows and 11,062 nodes; none is discarded or certified. Selected application
identity matches both build records at 1332 files / 52027419 bytes / e33364a4dddf117cf2f49e8b969c7cbf1802c18653c7d1e48c275daa69aa4dcf.
The sole guarded push advances 9095331 to 6dda50c, independently confirmed over normal TLS
at 2026-10-05T21:04:21.388Z. All failed earlier artifacts remain. Hosted Actions stays unused,
and scoped local evidence does not establish full manual, live-provider or deployed acceptance.
