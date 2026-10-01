# Meta portfolio browsing — 1 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `d17373c`. Implementation: `cc5ca7d`. Batch 56 extends B27 through the existing native read contracts.

## Delivered behavior

The portfolio now browses Meta campaigns, their ad sets and their ads alongside Google Ads. Each page selects an
exact advertising login/account. Child views need a current scoped parent observation and re-read the native parent
before querying children. Every returned child must retain its exact native ID, account and parents. Only an entire
validated child page can record ownership for subsequent reads. Current actor/grants/scopes and login authorization
are checked around requests; a changed login/account cannot produce a mixed result.

Configured and effective status stay separate. Native budget/bid integers retain their exact value, including values
beyond JavaScript's safe integer range when supplied as strings. Missing fields stay unknown. Only selected fields
are returned; raw paging URLs and unrelated provider fields are withheld. Google optional fields now use null so
structured and JSON-text MCP results agree.
The shared Meta ownership observer also refuses an explicitly foreign or malformed account ID on any covered
account inventory edge. Rows explicitly naming a foreign or malformed account cannot establish ownership through
that lower-level cache.

Each Meta page is bounded to 1–100 rows, eight native requests, 60 seconds and 8 MiB. Signed cursors bind tenant,
actor, exact account/login/authorization, entity/parents, API version and page size. They expire in five minutes and
limit traversal to 100 pages. Continuation uses only the returned opaque token against the same compiled route;
the provider's next URL is never fetched. Duplicate rows, overlap with the preceding page, repeated cursors, missing
continuation metadata and malformed scope or money are refused. Empty pages may carry a valid next token.

This is current inventory in native order and the provider's default status visibility. It does not promise all
historical/archived entities or point-in-time consistency. Nonadjacent inventory changes can still occur between
pages. Native money is not automatically a major-currency amount, daily recommendation or reviewed budget change.
Parent observations expire after five minutes; refresh the parent inventory when needed.

## Website and agent workflow

The account chooser includes Google and Meta with appropriate ad-group/ad-set terms. Parent navigation, next page
and first-page refresh retain exact scope. Selecting another account clears the old result immediately. Request
generations, route/identity checks and detached-view checks suppress obsolete results and errors. Headings receive
keyboard focus. Controls wrap at mobile widths and wide tables scroll inside a keyboard-focusable region. Longer
scope notes are expandable; native status, IDs and money remain visible in the table.

`amcp_workspace portfolio` describes the complete requirements in its advertised tool contract and campaign-builder
guide. A real MCP SDK reader journey follows campaigns → next page → ad sets → ads with four calls and eleven
synthetic GETs (approximately 8.1 KB of structured results), validating advertised schemas and equivalent text/structured envelopes. Separate Google SDK
coverage verifies missing optional fields. These are local protocol journeys, not external-client acceptance.

## Evidence and remaining scope

The official [Meta Python Business SDK 26.0.2](https://github.com/facebook/facebook-python-business-sdk/tree/26.0.2/facebook_business/adobjects)
supports the projected model fields and read edges. `tools/meta-portfolio-evidence.mjs` extracts them from separately
downloaded public SDK modules and records URLs/SHA-256 hashes in `tests/fixtures/meta-portfolio-sdk-v26.json`.
The extractor and tests are offline. Model/edge evidence does not establish eligible-account or live response behavior.

Regressions cover real native dispatch, parent/account mismatches, missing prerequisites, exact large money,
unknown/withheld fields, bounded pages, cursor scope/repeats/expiry/tampering, revoked grants and login changes.
Browser-script tests exercise Meta/Google hierarchy, continuation/refresh, account changes and late response/error
races. Synthetic desktop/mobile acceptance follows pagination and all three inventory levels. It found clipped
mobile navigation and repaired wrapping; final DOM checks keep controls and page content within the viewport.
Logs and screenshots are retained in ignored `.runtime/meta-portfolio-20261001/`. Full release qualification is
recorded in [PROGRESS.md](PROGRESS.md).

The matrix remains **11 implemented / 15 partial / 2 open**. B27 still needs additional providers/dimensions and
point-in-time reconciliation. No dependency, migration, OAuth scope, new native family or ledger reclassification
was introduced. No real credential, live advertising mutation, external message, deployment or DNS change occurred.
