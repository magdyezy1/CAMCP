# Batch 130 — current LinkedIn budget context

Baseline: `5bff289`. Sole repository `magdyezy1/CAMCP`, branch `Work-here`, checkout
`CAMCP-Codes-final-branch`. This advances B08/B15/B24/B27 of the original roadmap.

## Result and evidence

F-201 identifies an inventory projection omission: campaign-group reads retained `totalBudget` but silently
omitted `dailyBudget`, including malformed or foreign-currency daily values. The current native API supports a
group daily budget for `DYNAMIC` optimization. The original synthetic response therefore could display an
incomplete group budget without refusing its invalid money. This is local contract evidence, not an observed
production incident or a new write authorization.

The group inventory now validates and preserves both native decimal amounts in the exact account currency.
Campaign rows describe current parent controls, shared optimization and native pacing. Ordinary daily, lifetime,
mixed and ambiguous modes remain distinct; unfamiliar optimization/pacing fields remain unknown. Native amounts
stay decimal strings, including inventory precision beyond the narrower six-place guided allocation contract.
The view never calculates effective spend, asserts budget-edit eligibility or treats a daily amount as a hard
calendar-day cap. Group total caps and child daily settings stay separate.

Existing account and parent reads supply this context, with no added request or native action. Creative intended
status and observed serving evidence stay separate. Bounded interpreted fields exclude unrelated private policy,
person and content data. Cursor/session/connection/current-parent protections remain in force. No source sample,
live account, submitted lead, provider mutation or deployment was used.

The English and Arabic portfolio shows shared group controls, exact parent IDs, money and pacing beside the
campaign's own settings. Unknown modes request native review. Text and native values are escaped, with eleven new
authored Arabic labels and an updated selected inventory explanation. The generic USD `daily_budget` shortcut
still refuses LinkedIn group optimization, but its explanation now recognizes the native dynamic option.
Explicit native group parameters retain the existing compiler path and `DRAFT` creation; this batch does not
qualify dynamic-group writes or add a recipe. Independent allocation drafts continue to reject shared/lifetime
and ambiguous budget modes under their own current native checks.

Primary contract references checked 2026-10-04:
[LinkedIn campaign groups](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaign-groups?view=li-lms-2026-08),
[LinkedIn campaigns](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns?view=li-lms-2026-08).
Their native Money representation is a decimal string and account currency. Dynamic group budget support does
not make that mode eligible for the separate guided independent-campaign allocation flow.

## Local qualification

Three new backend regressions cover dynamic group/child context, daily/total/mixed/pacing/future modes, malformed
and foreign-currency money. Two deterministic bilingual UI checks cover exact large IDs/amounts, actual
group-to-campaign selection, context labels and escaped native values. A compiler regression verifies the generic
shortcut refusal and preservation of explicit native SAR optimization fields. The shared synthetic fixture keeps
the backend and SDK hierarchy and transport identical.

The real MCP client validates advertised input schemas and structured/text/error parity, reads both group pages
and current child campaign/creative resources, and refuses tampered cursors, changed credentials and disabled
connections without another provider request. It made **7 tool calls / 12,477 structured bytes / 11 synthetic
GETs / zero mutations**. No additional read was needed for the new budget context.

Focused checks: **31 passed / zero failures / zero skips in 3.215 seconds**. Root build and website checks pass;
the shipped browser script count is 34, and the explicitly selected Arabic message set is 3,231. The initial
focused UI run had 28 passes and two missing-translation failures; these were repaired before qualification.
The code change fixes the separately reproduced inventory omission; this intermediate UI failure is not a
production incident claim.

Sanitized report regeneration, full release gates and exact-commit qualification are recorded below after they
complete. The private root live-read sample remains excluded. Native action/family totals and roadmap totals
remain unchanged: **3,247 actions / 167 families / 800 reviewed writes; 13 implemented / 14 partial / one open**.

## Remaining acceptance

New visual/keyboard/assistive acceptance is separate from these deterministic DOM checks. The browser tool's
existing Windows kernel-path failure prevented new actual browser observations; earlier About/playbook browser
evidence does not qualify this view. Current-revision CI, live native account acceptance, deployed behavior,
additional provider dimensions and point-in-time inventory reconciliation remain separate. Work continues
through the original roadmap rather than treating this budget-context delivery as full-plan completion.

## Sanitized release preflight

A newly assembled release contains 1662 public source files and one generated empty sample,
source-tree hash `1874dcf9137675832db57d91b7a1fa0deb79ae50beb503d411ca6f023e4041e9`. Offline installation, build, early tracked-report freshness,
full `npm run check` and Railway configuration checks all passed. Main suite: **4,045 tests / 4,040 passes /
zero failures / five expected local FFmpeg skips, 96.629 seconds**. Catalog capture: **four passes / no failures
or skips, 80.908 ms**. Document index: 296. All three tracked public report artifacts regenerated unchanged from
the assembler's empty sample and remained byte-identical after qualification. The private root sample was not read.
This preflight precedes these final qualification paragraphs; committed-source parity and full release gates are
required separately before push. No local Docker/FFmpeg result is claimed.

## Verified preceding revision CI184

[CI184](https://github.com/magdyezy1/CAMCP/actions/runs/37170853784) passed for exact commit
`5bff289dec7bf5ebc8ef3cfb0ea0edb1eaf54040`, source hash
`3fd25c1c403f5ecf45e3e57b048f0a91dd3d62d17c8515dc33bccc6e194e508a`, 1,659 public sources plus
one generated empty sample. Both two-worker Linux host and Docker suites passed **4,038/4,038/0/0**, in
667.159 and 661.798 seconds. Both capture suites passed **4/4/0/0**, in 75.177 and 73.324 ms. Required FFmpeg,
early report freshness, remaining release gates, Railway/image inspection and both synthetic read/write smoke
checks passed. This confirms the preceding source revision, not a live advertising account or a deployed Railway
service. Current batch 130 requires its own exact-source CI after push.
