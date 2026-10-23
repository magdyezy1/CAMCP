# X account portfolio workflow — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `d4a2e14`. Batch 89 expands B27/B15/B24 through existing native read contracts.

Portfolio now follows X campaign → line item → promoted-post association in English and Arabic. It shows exact
native micros, currency and account timezone, separates campaign configured/effective status and servability,
and retains promoted association ID, original post ID and approval status. A servability flag or approval status
does not establish actual delivery. Parent navigation, refresh, signed continuation and departed-view/identity
guards use the existing account workflow. Six provider explanations are now covered by the authored locale gate.

MCP: `amcp_workspace {action:"portfolio",gateway:"x_ads_native_action",account_id,connection_id,limit,
requirements:{entity:"campaign"}}`. Children use `entity:"line_item",campaign_id`, then
`entity:"promoted_tweet",campaign_id,line_item_id`. Limits are 1–100 entities; the website requests 50.
Direct scoped child reads work: the adapter reads the current account and parent campaign, and additionally the
line item before promoted posts. Exact account paths, native request echoes, parent IDs and returned identities
must agree. A deleted/draft parent or conflicting child stops the read before any inventory is displayed.

Six existing Ads API v12 GET routes are used: account, campaign list/detail, line-item list/detail and promoted
Tweet list. Lists explicitly exclude deleted entities, and campaign/line-item lists also exclude drafts. No
post-content, scheduled-post, promoted-account or media-creative inventory is implied. Projected output omits
billing details, purchase-order numbers, tracking configuration, advertiser user IDs and arbitrary provider fields.
Native money is retained as canonical whole-micro strings; safe JSON integers convert exactly, and unsafe numbers
or values outside nonnegative signed int64 are refused. Missing money/currency stays null; promoted associations
use their freshly read parent line item's currency. There is no currency conversion or implicit budget change.

Every page is bounded to eight requests including retries, 103 total rows including parents, 8 MiB and 60 seconds.
Actor, account, login and credential/scope fingerprints are checked before/after each native request and before
returning. Canonical signed cursors bind current authority, hierarchy, page size and native version; they expire
after five minutes and stop at 100 pages. They retain hashes of prior native tokens to reject cycles and previous
page IDs to reject adjacent overlaps. Only an opaque token is reused on the fixed account route; returned URLs
are never followed. Other reordering/omissions across pages remain possible; this is not a point-in-time snapshot.

Eleven new cases were observed failing before their corresponding implementation, including nine backend cases
against the exact batch 88 candidate, one bilingual UI case and one real-SDK case. Focused **61/61** passed.
Checks cover scoped hierarchy, exact money/post IDs, selected-field privacy, malformed/partial native envelopes,
cursor tampering/expiry/identity changes, revocation after every native read, repeated tokens, empty pages and the
100-page bound. The traversal fixture raises only its synthetic transport burst allowance to isolate the page
limit; production tenant limits are unchanged. The measured SDK journey uses **4 calls / 9,176 structured bytes /
11 synthetic native GETs / zero provider mutations**, checking advertised input schemas, response envelopes and
the `/portfolio` handoff. Locale checks cover **32 scripts / 2,641 selected messages**.
Evidence: `.runtime/x-portfolio-20261002/`. Browser/editorial, live-provider and deployed acceptance remain separate.

Primary references checked 2 October 2026:
- [X Campaign Management reference](https://docs.x.com/x-ads-api/campaign-management/reference): exact v12 routes,
  scoped filter parameters, native response examples and monetary units. The web reader rejected its size; a
  bounded HTTPS fetch with normal certificate verification retrieved the official page successfully (6,157,319 bytes).
  Original HTML SHA-256: `e2fb516f29dfc0967152929816d34d8a11e46d749d0d16eb16c6844340474575`.
- X's official Python SDK [campaign models](https://github.com/xdevplatform/twitter-python-ads-sdk/blob/master/twitter_ads/campaign.py),
  [account resources](https://github.com/xdevplatform/twitter-python-ads-sdk/blob/master/twitter_ads/account.py) and
  [cursor handling](https://github.com/xdevplatform/twitter-python-ads-sdk/blob/master/twitter_ads/cursor.py).

Root regression: **3,475 tests / 3,470 passed / zero failed / five local FFmpeg skips; 74.30 seconds**.
The native ledger remains **3,247 actions / 167 families / 1,712 reads / 800 reviewed writes / 502 blocked writes**.
The blueprint stays **13 implemented / 14 partial / 1 open**. No private root samples, live ad mutations, credentials,
OAuth expansion, external messages, dependency or production deployment were used.

Batch 88 exact-source checks/Railway passed on `d4a2e14`: **3,459 passed, zero failed, five local FFmpeg skips;
85.26 seconds**, plus four capture tests. **1,507 public files + one generated empty sample**, source hash
`58e494878816e97d87b896c2b627f0f22f9800d363e5c6965a567a11f893341f`.
[CI143](https://github.com/magdyezy1/CAMCP/actions/runs/36950041623) was running when checked.
[CI141](https://github.com/magdyezy1/CAMCP/actions/runs/36947411085) succeeded on `4ca02fe`: host and Docker each
passed **3,449 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container smokes.
Job `110652546113` uploaded release-evidence artifact `11203283987`.

Sanitized preflight `.release/x-portfolio-preflight-20261002` passed every check and Railway stage:
**3,470 passed, zero failed, five local FFmpeg skips; 78.17 seconds**, four capture tests, 32 browser scripts
and 255 documents. Its **1,511 public source files** plus one generated empty sample have hash
`d6bf7cbd20e6a29813a5a541bd67d566c9499b1020820bb3e9155e3ab8995748`. Exact committed-source checks follow before push.
