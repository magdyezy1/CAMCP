---
status: record
tier: engineering
---

# Search-term evidence to reviewed exclusion drafts — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `145e032`. Batch 100 extends B15/B18/B24 and source-bound campaign workflows.

Google search-term reports now offer an English/Arabic path from retained evidence to an unapproved exact-negative-
keyword plan. Choose minimum clicks and maximum evidence age, inspect eligible rows, explicitly select up to 20
original search terms, read their current native context, then confirm saving a local draft. Candidate browsing
uses retained evidence and makes no provider request. Selection survives pagination in both directions. Changing
thresholds clears the selection and preview. Original text, exact metric strings, account, campaign and ad-group
IDs remain visible; the draft targets each term's original ad group. There is no automatic exclusion decision.

Candidates require complete guided Google search-term evidence, verified account currency/timezone, native
metrics.conversions and a known attribution declaration. Both capture time and the last closed reporting day
must fit the requested 1–90-day age (default seven). Clicks are exact integers at or above the chosen threshold
(default 30), conversions must be the exact known string zero and cost must be a valid nonnegative decimal.
Missing or malformed values are not treated as zero. Every native search-term resource must encode its exact
account, campaign, group and original UTF-8 term; duplicate or foreign grain refuses the collection. Up to 10,000
retained rows are checked. Candidate pages contain at most 100 rows; the website displays 50 at a time.

The guided literal subset keeps the original trimmed text unchanged: at most 80 UTF-16 characters and ten words,
using Unicode letters/marks/numbers, spaces and straight/curly apostrophes. Other punctuation and operators are
excluded from this guided proposal rather than rewritten. Case/whitespace-equivalent selected terms in one group
are refused as duplicate proposals. Zero observed conversions does not establish irrelevance: conversion lag,
business value and broader keyword coverage still require the operator's judgment.

Preview reads current selected parents, all current exact keywords under those groups, then parents again. Each
read is a bounded Google Search POST, not an advertising mutation. Account identity/currency/timezone, resource
relationships, SEARCH / SEARCH_STANDARD eligibility and enabled/paused state must match. Existing positive or
negative exact keywords with equivalent case/whitespace block conflicting proposals. Collection allows at most
1,000 exact keywords, six requests, 1,040 rows, 2 MiB and 60 seconds; incomplete totals or continuation tokens are
refused. Broader/phrase keywords and campaign/shared/account-level exclusions are not assessed. Every awaited
read checks current actor, session, selected account/login, credentials and scopes before and after.

The ten-minute preview binds the selected rows, report revision/hash, native context, exact arguments, creator
and session. Confirming it rechecks source and native context and creates one local campaign step per term with
negative:true and EXACT match. Its binding is saved atomically with the new plan. Retrying the original preview
reuses that plan through a stable idempotency key; changing scope, evidence or arguments requires a fresh preview.
No reviewed-write family is broadened. Approval, spending acknowledgement, native review, execution receipts and
read-back verification remain separate mandatory controls. Unsent steps recheck evidence and native context;
accepted/unknown execution recovery retains the original receipt flow rather than issuing another mutation.

MCP actions are `search_exclusion_candidates`, `preview_search_exclusions` and `create_search_exclusion_plan`
under `amcp_decision_report`. The preview uses the report `id`, selected native `ids` and
`options:{minimum_clicks,maximum_age_days}`. Creation requires the same report, exact `preview_id`/
`preview_hash` and `confirmed:true`. The outcome provides the scoped Campaigns link without approving or
executing it. Readers can inspect eligible candidates; only operators/admins may preview and save plans.

Website callbacks and results are fenced by current route, identity, report selection, options and source
revision. Old confirmations cannot save after the selection changes. Duplicate pending requests are blocked.
An uncertain save keeps a visible retry using the original preview; it does not invent another plan. Terms and
native IDs are escaped, code values remain LTR in Arabic, table captions/headers are present and result/page
status receives keyboard focus. Synthetic DOM checks do not establish actual-browser or assistive-technology acceptance.

F-158 (medium): the campaign engine retained an earlier refusal on a successfully retried and verified step.
An observed red regression reproduced a missing-spending-acknowledgement error still displayed after successful
execution. The current step error is now cleared when native execution is accepted; original attempt receipts
and audit history remain intact. Review also caught and repaired lost selections when returning to page one and
a failed-save UI that removed its own original-preview retry button.

Nineteen new tests comprise 12 backend, six website and one real-SDK journey. Initial red checks observed five
backend failures and five UI failures before implementation; the three later review regressions were observed
before their fixes. Tests cover the 1,000/1,001 keyword boundary, current authorization/session changes, partial
or conflicting native state, exact large metrics, source drift before/after review and immutable unsent steps.
A synthetic full campaign journey verifies two exact-negative writes, including an acknowledged retry, while
replay performs no extra mutation. Focused tests passed **71/71**. The SDK journey passed **seven schema-validated
calls / 19,857 structured response bytes / nine synthetic Search POST reads / zero advertising mutations**.

Root regression: **3,594 tests / 3,589 passed / zero failed / five local FFmpeg skips; 90.63 seconds**.
Static checks cover 32 browser scripts and 2,761 selected Arabic messages. Evidence lives under
`.runtime/search-exclusion-plan-20261002/`. No live advertising write or provider acceptance is claimed.

The native shape and text bounds were checked against official [AdGroupCriterion](https://developers.google.com/google-ads/api/reference/rpc/v23/AdGroupCriterion),
[KeywordInfo](https://developers.google.com/google-ads/api/reference/rpc/v23/KeywordInfo) and
[negative-keyword guidance](https://support.google.com/google-ads/answer/2453972?hl=en). Existing reviewed native
contracts decide the actual mutation; this workflow does not claim full exclusion coverage or close-variant reach.

Batch 99 exact committed-source checks and Railway passed on `145e032`: **3,570 passed / zero failed / five local
FFmpeg skips; 89.66 seconds**, four capture tests, **1,541 public files + one generated empty sample**, source hash
`827a1a6a22b3973af3d25dacf65738653bd513baf65370ffc19b2e559ce97a6c`.
It was pushed only to Work-here; [CI154](https://github.com/magdyezy1/CAMCP/actions/runs/36967109393) is still running.

Retained-row controls [CI152](https://github.com/magdyezy1/CAMCP/actions/runs/36963993287) succeeded on `a256bf1`:
host and Docker each **3,551 passed / zero failed/skipped**, plus four capture tests and Railway; job
`110703625584`, artifact `11210405573`. LinkedIn integrity
[CI153](https://github.com/magdyezy1/CAMCP/actions/runs/36965119798) succeeded on `a636898`: host and Docker each
**3,560 passed / zero failed/skipped**, plus four capture tests and Railway; job `110707075257`, artifact
`11209409991`. Job logs were inspected separately from the successful workflow status.

Native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
Blueprint remains **13 implemented / 14 partial / 1 open**; external acceptance and the remaining product packages
are still tracked explicitly.

Sanitized preflight `.release/search-exclusion-plan-preflight-20261002` passed all stages and Railway:
**3,589 passed / zero failed / five local FFmpeg skips; 88.32 seconds**, four capture tests,
32 browser scripts, 2,761 selected Arabic messages and 266 documents. Its **1,545 public source files**
plus one generated empty sample have hash `8327ff309578e0609e69547cd3190018b43c1d011cbb20f6509f321bd2b30f96`.
Exact committed-source qualification follows before the sole Work-here push.
