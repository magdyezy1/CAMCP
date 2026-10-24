---
status: record
tier: engineering
---

# Rendered mobile, keyboard and commerce workflow qualification

Batch 149 continues the full improvement plan after the complete catalog field proof. A locally
available isolated headless browser enables actual rendered checks against owned synthetic applications.
The unavailable computer-use bridge is not treated as successful browser evidence. No existing user
browser, live website, real database, provider credentials or external provider mutation is used.

## Reproduced issues and changes

- **F-210:** About Us decorative orbits caused horizontal scrolling at 375 and 768 pixels in both
  directions, measuring 379/375 and 788/768. The artwork now clips inside its own noninteractive panel.
- **F-211:** at Arabic 320 pixels, the language selector overlapped the mobile navigation button and
  intercepted actual clicks. The narrow header uses two bounded grid columns and wraps its actions.
- **F-212:** the English WooCommerce selection button extended the 320-pixel page to 323 pixels.
  Workflow actions wrap their own text within their available width.
- **F-213:** Shift+Tab from the open drawer's first control reached a skip link while its destination
  was inert. Tab now wraps across visible navigation controls. Opening workspace search closes the
  drawer first and retains the navigation button as the return focus target.
- **F-214:** the instance-owner account access table expanded the 320-pixel Settings view to 442 pixels
  in English and 381 in Arabic. It now has a contained named, keyboard-focusable scroll region,
  caption and explicit column scopes, while preserving its original access actions and safeguards.
- **F-215:** the Meta comparison region was named but its table lacked a caption. A selected authored
  bilingual caption now identifies it using the existing catalog text.
- **F-216:** the anonymous landing header and decorative orbits expanded the 320-pixel page to 404
  pixels in English and 366 in Arabic. Header actions wrap; only the decorative orbit layer clips.
- **F-217:** the standalone privacy skip link scrolled but did not transfer keyboard focus to its main
  content. Its original target is now explicitly focusable, with policy text, links and date preserved.

The initial selected About/creative/source check exposed three layout issues. Its corrected 24 cases
passed with exact synthetic read counts and no browser errors. Wider qualification then found the
account table, missing comparison caption, landing reflow and privacy focus issues. Early harness
failures that tried hidden public workspace controls or expected unsupported Arabic privacy copy are
recorded as harness assumptions, not application defects. The corrected maintained runner explicitly
tests the current public-page controls and English privacy scope.

## Maintained qualification

`tools/browser-workflow-qa.mjs`, its synthetic website fixture and `npm run check:browser` provide
132 selected cases across 27 distinct page paths. See [setup and precise scope](../LOCAL-BROWSER-QA.md).
Fresh browser contexts block all external egress; synthetic transports accept only qualified reads.
The runner records script/local-response failures, source hashes, actual browser version, layout,
table captions/keyboard scrolling and explicit source/limit changes with unchecked selection guards.

The browser engine is local Chromium 148.0.7778.96 with Playwright 1.62.1 and an explicit installed
headless test executable. Its actual completed results and the source-specific local release gates
are recorded below once checked. Existing narrow controller/API/plan regressions passed 36/36 with
zero failures or skips in 1.187 seconds after the first fixes; final source checks follow separately.

## Boundaries and remaining work

No selected message or native identifier is translated by inference. Every previous Arabic catalog
value remains unchanged; this batch reuses existing selected authored messages. Privacy remains in
English pending separate source-preserving editorial work. Empty workspace coverage does not cover
every populated state, provider format, long tenant history, screen reader, browser or device.

B16 and B24 remain partial with stronger measured local rendered evidence. Provider/store acceptance,
full variants and inventory reconciliation, further objective packs and remaining package work continue.
Packages remain 13 implemented, 14 partial and one open. Hosted CI stays skipped at the owner's
direction; exact local source/report/full-test gates with required FFmpeg remain mandatory. No later
Linux/Docker, Railway deployment or live provider acceptance is inferred.

## Completed local rendered qualification

The maintained working-tree run passed **132/132 cases with zero failures**, at all selected
widths and language scopes above. Browser script exceptions, failed owned responses, attempted
external page requests and actual provider mutations were all zero. Website source digest
`9d46ab5c8922d1de52f1d83884978d7f4ac7e9e93a2b2747bc93609712f9d858`; headless engine `148.0.7778.96`, executable SHA-256
`2d8f2abad1a0f2998aaf861967c374d4aad6a104916b8794318760ed35db772f`, Playwright `1.62.1`.
The cases began 2026-10-04T17:15:36.047Z and completed 2026-10-04T17:18:01.739Z.
This identifies the actual served working-tree bytes; the Git base alone is not claimed to qualify
those uncommitted changes. Fresh clean-HEAD rendered and full source/report gates follow separately.

## Batch 149 sanitized full release preflight

Fresh offline install/build/early report freshness/full checks/Railway passed with every exit zero.
Main **4,303/4,303/0/0 in 146.564 seconds**, capture **4/4/0/0 in 87.288 ms**;
required FFmpeg ran every media case. Website checks cover 34 scripts, three pages and 3,557 selected
Arabic messages; documentation index 317. All three sanitized public reports regenerated unchanged
and preserved their bytes. The private root sample was not read. Source manifest contains 1,761
public files plus one generated literal empty sample, hash
`eb5682b3b5db8df0ec5992b8566ab4451ca11fa629f58d305e257f3a10b3d492`. Exact committed-source and rendered gates follow before the sole Work-here
push; hosted CI remains owner-paused. The full remaining plan continues.

Screenshot inspection follow-up: F-218 remains open for the next delivery. At 375 pixels, native
product row headers can collapse to 37.422/37.594 pixels in English/Arabic, making names and IDs
unnecessarily tall despite contained table scrolling. A targeted readable product-column layout and
rendered regression are the next step; no product value or provider state is changed.

## Exact committed-source release follow-up

Batch 149 code 653837e14fc3f19d10fd3dc2a87beb5fcd84dac4 and documentation tip
9bb335c4060305380507879b883453593847a181 passed fresh clean-HEAD checks before the sole Work-here push.
Source verification proves 1,761 exact Git blobs, one generated literal empty sample and three tracked
report blobs, source hash c1e15d0587977a9f36ce172708833ca7e3fef06dcd1eaca1102e126d9cbed69b.
Offline install/build/early report freshness/full checks/Railway all passed with required FFmpeg;
main 4,303/4,303/0/0 in 166.462 seconds and capture 4/4/0/0 in 78.193 ms. Exact clean-HEAD rendered
QA passed 132/132/0 (2026-10-04T17:33:58.768Z through 17:37:05.766Z), retaining source metadata and
zero external provider requests/mutations. All report bytes were preserved; the authorized push
succeeded with the owner-directed [skip ci] marker. Hosted CI was not started. F-218 follow-up is
resolved in batch 150; remaining scope stays explicit.
