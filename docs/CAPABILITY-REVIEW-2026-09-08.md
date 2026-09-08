# AMCP capability review — 8 September 2026

This review combines current WhatHead MCP reads and explicit dry-run previews, repository inspection, the five supplied creation manuals and five crosswalk JSON files, official vendor documentation, and synthetic regression tests. It does not certify complete WhatHead parity or every platform's production behavior. No live advertising mutation or Railway operation was performed.

## Fresh WhatHead comparison

WhatHead still reports compact-v1 with 20 tools and 19 native gateways. AMCP preserves those captured contracts and adds an independent Microsoft gateway: 21 runtime tools, or 23 with its write/media extensions enabled. The captured 112 nested schemas remain a separate denominator.

| Gateway | Distinct action records compared | Names present in AMCP | Declared HTTP route differences |
| --- | ---: | ---: | ---: |
| Meta | 5 | 5 | 0 |
| Google Ads | 123 | 123 | 0 |
| TikTok | 41 | 41 | 0 |
| Snapchat | 5 | 5 | 0 |
| LinkedIn | 5 | 5 | 0 |
| X | 5 | 5 | 0 |
| Total | 184 | 184 | 0 |

These are sampled catalog records, not 184 executed API operations. Three fresh campaign-create previews—Meta, TikTok and Snapchat—matched AMCP's compiled **HTTP method, path, query and body**. Sanitized regression fixtures preserve those comparisons. Response envelopes, validation completeness and successful live writes are not implied by matching requests.

Read-only campaign requests through WhatHead succeeded for Meta, TikTok, Snapchat and X. Google Ads returned HTTP 403 / FORBIDDEN for the supplied account. LinkedIn was not connected. A separate live read through AMCP's saved local Meta connection stopped at HTTP 401 / AUTH_EXPIRED; this connection needs OAuth renewal before direct live comparison. The four WhatHead successes are not reported as successes by AMCP against the same live data.

Residual metadata differences remain: searching Google actions for `campaign` returned 123 in WhatHead versus 246 locally; searching TikTok for `creative` returned 41 versus 53, with a different first-page order. The mirror searches broader captured metadata. The source's exact search index is not exposed. No action was missing in the sampled sets, and query-specific counts were not hardcoded to manufacture parity. Use exact action names and DESCRIBE_ACTION when building.

A fresh generic Meta creative compile returned `META_USE_NATIVE_TOOLS` from WhatHead. AMCP likewise uses native Meta requests, with its own error envelope. Historical named tools and generic form examples must not be treated as current callable AMCP contracts.

## Repository review and changes

| Area examined | Result and applied improvement |
| --- | --- |
| Captured catalog, compiler and native dispatch | Kept captured contracts intact; added Microsoft as a separately identified extension. Fresh request-subset fixtures check three providers. |
| Write preparation and execution | Added `amcp_write inspect` to reveal local support and state-read paths without credentials, provider calls or a review. Existing authorization, stale-state checks and durable submission claims remain enforced. |
| State guards and resource ownership | Existing configuration normalization and changed-field diagnostics cover the shared path. New Snapchat creative PATCH regression verifies that delivery-status permutations do not block execution. Real budget changes still fail. |
| Meta creative identity | Added existing Instagram media using `source_instagram_media_id` and `instagram_user_id`; rejects incompatible Facebook story inputs instead of fabricating a Page/post. |
| Snapchat creative management | Qualified native creative PATCH with an exact creative read at both preparation and execution. |
| OAuth, credentials, website account selection | Added Microsoft PKCE, offline access, encrypted refresh rotation, developer-token configuration, paginated advertiser discovery and verified account-to-customer mapping. Selection/revocation preserves account grants. |
| Native transport and scope | Microsoft requests use exact approved origins and native methods, authenticated account/customer headers, strict top-level payload fields and string IDs. Report polling is bound to the original connection and account. Report submission is not automatically retried. |
| Microsoft campaign hierarchy | Added 24 discoverable native actions, including 12 reviewed Search CRUD routes. Exact parent and target reads prevent unqualified campaign types from passing a Search-only guard. Batch partial failures are retained. |
| Media import | Retained the existing server-side public Google Drive transfer path for Meta, TikTok, Snapchat, Google Ads, LinkedIn, X and DV360. Clarified native entry points, byte validation, size limits and asynchronous continuation. Microsoft/Reddit media support is not implied. |
| MCP transports and creation guidance | Added eight resources at `amcp://guides/...` and the `amcp_build_campaign` prompt; both stdio and HTTP clients can load the curated guides. URI resolution is allowlisted and tests reject filesystem traversal. |
| Reporting and jobs | Microsoft report submission/polling is native, account-bound and distinct from normalized saved-report workflows. Existing worker leases and reporting tests remain in the regression suite. |
| Packaging and release | Include only the new curated skill package, not the original supplied manuals/crosswalks. Container smoke checks load a guide from the actual image and check all 11 website providers. |

## What was learned from Skills

The original source files are preserved locally. They are reference material, not authority to spend, bypass a review, expand account access or invent identifiers. The curated `Skills/amcp-campaign-builder` package converts useful material into the actual AMCP surface and is shipped as MCP-readable guidance.

Applied insights include platform-specific hierarchy, budget units, native asset identity, existing-post versus new creative distinctions, progressive action discovery, required business inputs, safe use of returned IDs, asynchronous media completion, partial-outcome handling and read-after-write verification.

Several source claims needed correction or qualification:

- Meta's existing Instagram media inputs are different from Facebook `object_story_id`; the code now validates this distinction. Field support was checked in Meta's [official Business SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py).
- Paused creation is an **AMCP execution requirement**, not a universal assertion that Meta requires all campaigns to be created paused.
- Performance Max does not use positive Search keywords, but campaign-level negative keyword criteria are supported. Guidance follows the [current Google Ads API documentation](https://developers.google.com/google-ads/api/performance-max/create-campaign-criteria).
- A blanket instruction to delete/recreate every Google customizer binding is unsafe. Inspect the specific resource and supported operation; AMCP explicitly rejects its unsupported legacy customizer-attribute update.
- LinkedIn creative/count limits, fixed X objective matrices and uncertain Reddit enums in dated notes are not hardcoded as current provider rules. Current action contracts and provider validation take precedence.
- Historical WhatHead named tool calls are not directly callable through AMCP's compact gateways. Discovery and local write inspection now come before preparation.
- Reddit now has reviewed classic campaign/ad-group/existing-post ad and saved targeting-audience contracts, verified against the official schema and local chain tests. Media/post publication and live acceptance remain separate.

## Verification and remaining work

The new regressions cover request compilation, existing Instagram creative preparation/execution, Snapchat creative PATCH, all 12 Microsoft mutation routes, Search-only parent state, stale budgets, partial failure retention, account/role/scope denial before egress, refresh rotation, website account mapping, account-bound reports, MCP resources and prompt loading. The full suite also retains prior OAuth, media, SSRF, tenant isolation, session revocation, idempotency, reporting and six-platform write regressions. Run `npm run check` for the current test count and generated inventory; container CI additionally checks both write-enabled and read-only modes.

Outstanding acceptance includes Microsoft app/developer-token setup and live account reads, renewal of AMCP's expired local Meta authorization, resolution of the Google account denial, LinkedIn connection, exact filtered-search/response-envelope parity, and provider execution qualification for unimplemented formats. [Microsoft setup and bounded support](MICROSOFT-ADS.md), [write contracts](WRITE-OPERATIONS.md) and [media limits](MEDIA-UPLOADS.md) make these boundaries explicit. Automated success must not be presented as 100% live platform completion.

## Follow-up implementation while credentials are pending

Implemented five Google targeting/exclusion-list mutate families with exact parent/target GAQL guards, paused positive keywords, immutable-identity validation and bid-change regressions. Added Microsoft server-side CSV/TSV ZIP downloading, one-day scoped report records, cached bounded pages, completeness metadata, exact string values, public-DNS pinning and download/decompression limits. Added eight reviewed Reddit campaign/ad-group/existing-post ad/saved targeting-audience routes, including two clearly identified independent catalog extensions. Media processing now validates identity, ends ready-state polling and retains explicit terminal failures.

The new tests cover successful reviewed chains, idempotency, changed configuration, account/grant isolation, native request and response schemas, malformed report archives, cancellation, large IDs and media continuations. No live advertising mutation or new account object was used. Google arbitrary audience creation, Microsoft non-Search formats/normalized reporting, Reddit media/post publication and additional specialist transports remain separate work; local contract tests do not remove their live acceptance requirements.
