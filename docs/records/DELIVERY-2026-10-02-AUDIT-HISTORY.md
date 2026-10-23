# Scoped audit history and Activity navigation — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `c7a086c`. Batch 82 fixes F-152 and expands B13/B15/B24.

**F-152 (high):** the baseline MCP `history` action returned complete retained audit events to any active
workspace actor without account-scope checks. The website Activity route used the same unrestricted tenant feed.
A synthetic reader granted account 100 received account 200's retained request body and receipt. The ignored
baseline probe records all three exposure flags as true with zero provider requests. Five new red tests additionally
reproduce unscoped colleague data, arbitrary nested fields, absent continuation and ignored filters. This is local
reproduction, not evidence of a deployed disclosure.

Both interfaces now use one metadata-only history projection. Ordinary members see currently accessible account
events and their own unscoped local events. The workspace owner retains workspace-wide metadata visibility, including
disconnected-login diagnostics. Conflicting or malformed declared scope is withheld for every role. Generic admin
membership is not treated as ownership. Current actor and account grants are checked on every page. Diagnostic
items are independently scoped for non-owners, so a multi-account sync event cannot expose another account's error.

The output allowlist retains sequence/time, event/action, exact scope where present, request reference, error code,
native sync completeness/write count and bounded diagnostic fields. No role receives raw request bodies, outcomes,
receipts, arbitrary audit properties, actor identity values or original error details. SQLite projects metadata
before JavaScript; only an already authorized row's bounded error/diagnostic fragments are loaded for normalization.
Existing Google access-denial, project-routing and reauthorization diagnostics remain available to the owner.
The stored append-only events and hash chain remain unchanged; this endpoint does not verify that global chain.

`amcp_workspace {action:"history",limit?,search?,gateway?,account_id?,connection_id?,cursor?}` returns
`record_kind:audit_history`, `events`, `next_cursor`, `has_more` and a website handoff to `/activity`.
Search matches the event, native action or request reference. Canonical cursors bind tenant/user/session/role/owner,
exact filters and page size, retain the first page's maximum sequence and move strictly toward older events. Fresh
events appear after explicit refresh. Each call scans at most 500 candidates and returns up to 100 events within
256 KiB of event JSON. Even an empty filtered page can have continuation. Diagnostic fragments are limited to
16 KiB of error and 64 KiB of diagnostic input, at most 20 projected items and 32 KiB per event. Oversized or
unqualified diagnostic details remain omitted. This is AMCP history, not complete external vendor history.

Website Activity offers search, an exact account filter, previous/next pages, refresh and request references in
English/Arabic. A failed page keeps its cursor for retry; response order, route/identity lifetime and detached
nodes are checked. No new request starts from departed controls. The MCP event shape remains flat and the website
keeps its existing nested `event` envelope, but consumers that depended on arbitrary raw payload fields must move
to the original currently authorized operation endpoint. Withholding those fields is an intentional access fix.

Nine new tests: five backend cases observed red, one additional authenticated HTTP/current-membership case,
two UI cases observed red and one real-SDK journey. Focused **56/56** passed, including existing provider-diagnostic
and navigation regressions. The new SDK journey uses **3 calls / 3,922 structured bytes / zero provider requests**.
It verifies the advertised schema, older-event continuation, original request references, website handoff and grant
withdrawal. Static checks cover **32 browser scripts / 2,508 selected Arabic messages**. Full and sanitized
qualification follows below. Logs: `.runtime/audit-history-20261002/`.

No dependency/schema migration, audit rewriting, provider mutation, external message, OAuth expansion or production
deployment occurred. Actual browser, assistive-technology and deployed acceptance remain separate from these HTTP/VM
fixtures. Native ledgers stay **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked
writes**. B13 gains safe paginated audit history, while broader telemetry instrumentation and opaque historical-job
scope adapters remain. The blueprint stays **13 implemented / 14 partial / 1 open**. Private root samples were not read.

Batch 81 follow-through: exact HEAD `c7a086cd135e9cd1283ce5f7c9968f519359f408` passed every check/Railway stage
in `.release/linkedin-portfolio-work-here-head-20261002`: **3,396 passed, zero failed, five local FFmpeg skips;
80.03 seconds**, four capture tests and byte parity for **1,488 public source files** plus one generated empty sample.
Hash: `56ebef202dc94ffad3b86ae3543e92799cd5ed9a0bfdd793cfdadd413d6f60ef`.
The sole push started [CI136](https://github.com/magdyezy1/CAMCP/actions/runs/36938607034), pending at this record's
latest check, as is [CI135](https://github.com/magdyezy1/CAMCP/actions/runs/36936557694).
[CI134](https://github.com/magdyezy1/CAMCP/actions/runs/36935041343) passed on `61a5a36`: host and Docker each
passed **3,383 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container smokes.
Job `110613197237` uploaded release-evidence artifact `11199140249`.

Root suite: **3,410 tests; 3,405 passed, zero failed, five local FFmpeg skips; 76.95 seconds**.
The strengthened HTTP owner-versus-administrator regression subsequently passed in the six-test access group.
Sanitized and exact committed-source checks follow before push.

Sanitized preflight `.release/audit-history-preflight-20261002` passed every check/Railway stage:
**3,405 passed, zero failed, five local FFmpeg skips; 82.01 seconds**, four capture tests, 32 browser scripts
and 248 documents. Its **1,492 public source files** plus one generated empty sample have hash
`2e01baa7eee225c7d200595b139e89fc512e5f6768e4835cbb890dc67c4bfdd1`. Exact committed-source checks follow before push.
