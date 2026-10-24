---
status: record
tier: engineering
---

# Readable saved allocation proposals and report metrics

**3 October 2026 · batch 109 · `magdyezy1/CAMCP` · `Work-here` · baseline `2709173`.**

## Delivered behavior

Campaigns presents recognized saved Google/Snapchat allocation bindings as a retained budget proposal, with provider,
exact account/currency/timezone, reference duration, Snapchat parent campaign and a source report link. The table
compares budgets at preview with proposed budgets, exact native micros and reference-period allocations. It does
not claim those stored preview settings are current. Google's average daily budget and Snapchat's daily budget
retain their distinct meanings; neither proposal creates an end date or a period spending cap.

English and Arabic use the same stored amounts and native requests. Exact IDs, currency codes and decimal strings
use bidirectional isolation. Custom names remain escaped user/source content. A source that only supplies an ID
shows that ID once rather than fabricating a name. The original brief, original step description and complete plan
provenance remain inspectable. Generic and older unrecognized plans keep their original brief and descriptions.

A localized step description requires the exact saved gateway, account, connection (where present), currency,
native target/resource, single budget update and micros. Extra/changed native fields, a different update mask,
partial-failure mode or a mismatched decimal conversion fall back to the original description. This is a readable
projection, not execution validation or approval. Existing frozen review, spending acknowledgement, authority,
idempotency and read-back contracts are unchanged.

Report metric cards translate the selected Spend, Impressions, Clicks and Conversions labels. Missing and null
values display Unknown; exact zero and decimal strings remain distinct. Both newly opened and initially listed
campaigns use a translated step-count message. Dynamic label maps are included in the existing strict catalog check.

## Confirmed findings and browser evidence

- **F-168, low:** the Arabic synthetic report displayed raw metric keys and a newly opened plan displayed English
  step-count copy. A sparse card also rendered a missing metric as a blank. The bilingual red assertion reproduces
  labels/null/zero behavior; actual browser observations reproduce the English copy in the Arabic journey.
- **F-169, low:** at 390 × 844, expanding the retained original brief widened the Arabic page from its 375 px
  client width to 534 px because of a long model fingerprint. Scoped paragraph/title wrapping restores 375/375 px
  with the original brief expanded. The fingerprint is preserved without truncation.

The existing in-memory `snapchat-allocation` browser fixture uses real report capture against fake native GETs and
rejects advertising mutations. Actual desktop 1280 × 900 and mobile 390 × 844 interactions verify the saved proposal,
keyboard-accessible named table, original brief, localized count, and original report link in English and Arabic.
Retained report totals remain **200 USD / 4,000 impressions / 120 clicks / 30 conversions**. The two proposed daily
budgets remain **37.5 / 62.5 USD**, **37,500,000 / 62,500,000 micros**, against **75 / 125 USD** period allocations.
Neither the saved draft nor the source snapshot is modified by presentation or language changes.

Screenshots, DOM measurements and logs are local under `.runtime/allocation-review-20261003/`. These checks are
synthetic browser qualification; independent assistive technology, full Arabic editorial review, deployed behavior
and live provider acceptance remain separate. No native mutation or production configuration change was made.

## Regression and release evidence

The corrected initial red fixture observed **three failures / seven passes** for the missing readable presentation
and metric behavior. Its first attempt lacked a document mock and is not used as feature evidence. The completed
tests add mismatched/extra native requests, Google average-daily binding, escaping, untouched source objects and
legacy fallback. An initial full run exposed a function-extraction fixture scope problem with an external metric
map; placing that map with its sole renderer fixes the scope without changing the assertions or native behavior.

Completed focused suite: **98 passed / zero failed**. Full local regression: **3,711 tests / 3,706 passed / zero failed /
five local FFmpeg skips; 86.87 seconds**. All **33 browser scripts**, **2,853 selected Arabic messages** and **2,986 catalog
entries** pass checks. The native ledger stays **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes /
502 blocked writes**. Sanitized release qualification is recorded below when complete.

Batch 108's exact committed `27091739ccbbe074d63cdaf0254cfea45c87cc7b` candidate passed all five stages and Railway:
**3,701 passed / zero failed / five local FFmpeg skips; 90.35 seconds**, four capture checks, **1,570 public files +
one generated empty sample**, source hash `ef4ba96f1cfd262a7c51a214ba604f85a8ea37dd5c359345cffe9c6c73311f2f`.
It was pushed solely to `Work-here`. CI163 on that revision was running at the last read.

The matrix remains **13 implemented / 14 partial / one open**. B16/B24 gain further actual bilingual browser evidence;
other provider bindings, forecasting calibration, external acceptance and the remaining packages are still tracked.


Sanitized preflight `.release/allocation-review-preflight-20261003` passed install/build/report/check/Railway: **3,706 passed / zero failed / five local FFmpeg skips; 93.93 seconds**, four capture checks, 33 scripts, 2,853 selected Arabic messages and 275 documents. **1,572 public sources + one generated empty sample** have hash `66d20643810138ffae63b5d056fdcf887d4c042e04722f0b9a022cd1daf4ffbb`. Exact committed-source qualification follows before the sole Work-here push.
