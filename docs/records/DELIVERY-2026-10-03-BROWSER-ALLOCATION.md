# Browser allocation flow, native unit labels and keyboard focus

**3 October 2026 · batch 108 · `magdyezy1/CAMCP` · `Work-here` · baseline `a462f0f`.**

## Delivered behavior

Source-linked reports now name the report, account and reporting dates in each Open report button's accessible
label, escaping untrusted source names. Allocation results consistently distinguish campaigns from Snapchat ad
squads in their summary, column heading, scroll-region name, selected bounds and selected diagnostics. Candidate
and model responses add `entity_kind`; qualified Snapchat responses also identify `parent_campaign_id`. Model
assumptions and saved native draft descriptions name the actual budget unit. The numeric allocation, source
fingerprint, original parent ownership and separate native approval remain unchanged.

Snapchat previews say **daily budget**. Google's existing **average daily budget** wording is preserved. The explicit
conversion label is associated with its select independently of the options. English and Arabic controls retain
the same native IDs, exact decimals, micros and local draft arguments.

Allocation candidates have compact Add/Added buttons with full accessible names. A selected candidate stays
disabled after the async click handler finishes; removing it restores Add. The shared binder's optional disabled
state callback preserves this explicit selection state while other controls retain their existing re-enable behavior.
Scoped zero-minimum grid tracks and wrapping controls keep long native IDs inside the allocation form in either
text direction. Wide evidence/conversion tables retain named keyboard-accessible horizontal scroll regions.

The shared two-control confirmation dialog wraps Tab from Confirm to Cancel and Shift+Tab from Cancel to Confirm.
Cancel retains initial focus, Escape remains cancellation, and closing removes the keyboard listener before reuse.

## Confirmed findings and evidence

- **F-165, low:** the actual synthetic browser displayed ad-squad results as campaigns. Native draft/preview copy
  still used Google's average-daily terminology, and generic Arabic bounds/efficiency messages inserted campaigns.
  Observed UI, native-preview and Arabic red assertions now pass with the actual unit and parent identity.
- **F-166, low:** forward Tab from the final confirmation control left focus on `BODY` while the dialog stayed open.
  The browser observation and two red keyboard/listener regressions identify this concrete focus loss. Both
  directions now remain in the dialog; separate cancellation and focus return are retained.
- **F-167, low:** Arabic at a **390 × 844** viewport with full native UUIDs expanded document width to **435 px**,
  moving the page sideways. Long candidate/action text and intrinsic label-grid tracks were responsible. The
  corrected form fits its **375 px** client width, including the scrollbar, with zero horizontal page scroll.

The browser fixture now uses the actual reporting service to capture complete account/parent-bound Snapchat
evidence from fake native GETs. It stores only an in-memory database and public synthetic credentials. It refuses
every Snapchat mutation and unexpected native origin. This avoids treating the previous manually seeded row
fixture's missing row metadata as a product failure. The transport retains its real bounded admission sleeper.

Browser verification covers synthetic sign-in, current report discovery, four retained rows, keyboard row search
and clearing without changing totals, allocation selection/bounds, explicit conversion, exact **62.5 / 37.5 USD**
daily amounts and **62,500,000 / 37,500,000 micros**, confirmation cancellation/focus, and the unapproved original
draft handoff. English and Arabic, desktop **1280 × 900**, narrow **390 × 844**, and mobile navigation Enter/Escape
are exercised. Screenshots and DOM measurements are retained in `.runtime/reporting-browser-20261003/`.

These are actual browser interactions with synthetic native data. They are not independent assistive-technology
certification, a full Arabic editorial review, a deployed browser acceptance test or live advertising execution.
No credentials, provider grants, rate limits, production deployment, DNS or advertising state were changed.

## Regression and release qualification

Observed red logs cover unit/result labels, accessible report naming, native daily wording, Arabic copy, selection
state and confirmation focus/listener cleanup. The extended fixtures now distinguish candidate-button selectors
from selected-bound selectors instead of returning the same mock rows for every DOM query. The analytical
explanation inventory continues to contain analytical explanations; diagnostic error translations remain separate.
No check or refusal was weakened to accommodate the new surface.

Completed local regression and sanitized release counts are recorded below after qualification. The unchanged
native ledger remains **3,247 actions / 167 reviewed families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The documentation index gains this delivery record. The Arabic catalog has **2,836 explicitly selected messages**;
the remaining diagnostic and editorial scope stays tracked.

## Previous committed release and CI

Batch 107's exact `a462f0f` candidate passed all five stages and Railway: **3,694 passed / zero failed / five local
FFmpeg skips; 94.02 seconds**, four capture checks, **1,567 public source files + one generated empty sample**,
source hash `653f5661a0de29cf8b10fc3b991fb99f00b1ccc086d61389cb62680944734d70`. It was pushed only to `Work-here`.

[CI161](https://github.com/magdyezy1/CAMCP/actions/runs/37086469324), batch 106 `0cda06f`, passed. Job `111097718182`
logs show **3,688 passed / zero failed / zero skipped** on host and Docker, four capture checks, Railway checks and
successful synthetic read/write container smoke. CI162 on batch 107 was running at the last read.

Blueprint scope remains **13 implemented / 14 partial / one open**. B16/B24 gain this real synthetic browser and
keyboard evidence; broad assistive-technology, deployed/provider, editorial and workload acceptance remain separate.
The other partial/open packages continue in the implementation matrix.

[CI162](https://github.com/magdyezy1/CAMCP/actions/runs/37088666662) on batch 107 `a462f0f` also passed. Job `111104092602` logs show **3,699 passed / zero failed / zero skipped** on host and Docker, four capture checks, Railway and successful synthetic read/write container smoke. No downloaded CI artifact inspection is claimed.

Completed focused regression: **105 passed / zero failed**. Full local regression: **3,706 tests / 3,701 passed / zero failed / five FFmpeg skips; 88.86 seconds**. All 33 browser scripts and 2,836 selected Arabic messages passed their checks; the documentation index has 274 documents. Full native authority/receipt and Google/Snapchat allocation regressions remain passing.

Sanitized preflight `.release/reporting-browser-preflight-20261003` passed install/build/report/check/Railway: **3,701 passed / zero failed / five local FFmpeg skips; 94.09 seconds**, four capture checks, 33 scripts, 2,836 selected Arabic messages and 274 documents. **1,570 public sources + one generated empty sample** have hash `ab6104d5c932f23bc31445f9806cc91ff1d0f760769971e91f2f4d686dea712b`. Exact committed-source qualification follows before the sole Work-here push.
