# Bounded worker liveness and concurrent client qualification

Batch 183 improves owner health/support observations and settings against
f14305d8b10d956b8d72458152e2a909eba70d50. Only magdyezy1/CAMCP Work-here is authorized.
Hosted Actions remain unused, and no real provider account, store or delivery destination changes.

## Health projection and owner workflow

The original health reader loaded complete heartbeat documents into Node and returned every
observation. One SQLite statement now validates bounded metadata and returns at most 100 recent
observations. Aggregate counts cover all stored process heartbeat records in that statement's
snapshot. Each eligible body is at most 512 UTF-8 bytes, with exactly one integer timestamp
and one known idle/working state. Malformed, oversized, duplicate-key, negative, fractional,
unknown-state and future observations cannot establish liveness. Process IDs, tenant IDs,
credentials and additional bodies stay out of the result.

The ninety-second age boundary is explicit. `active` means at least one recently observed valid
process; `stale` means all valid observations are older; `uncertain` means only old valid records
plus unavailable records; `unavailable` means records exist without a valid observation; and
`not_observed` means no stored heartbeat. These describe shared process liveness, separately from
workspace queue progression, delivery, capacity and provider acceptance. Counts and `has_more`
identify omitted valid rows. The SQL work still depends on stored heartbeat count; this is a
response/field projection bound, not a constant-time database or production capacity guarantee.

Owner Settings now shows this meaning, observation time, exact counters and a named, capped,
keyboard-scrollable table in English or Arabic. Unsupported/legacy/inconsistent values receive
an authored unavailable state. Arbitrary native fields are never echoed. Refresh stays explicit.
Request order, current session/identity, current permission and navigation generation prevent
late health from replacing a newer refresh or appearing in another workspace. Owner-access,
support-bundle, queue, lease, worker and policy boundaries remain unchanged.

Eighteen new authored Arabic messages preserve all 8,126 preceding pairs. The combined catalog
contains 8,144 entries and the current narrow locale gate covers 7,973 messages. Complete editorial,
physical assistive-technology and live owner acceptance remain separate.

## Measured benchmark and tradeoff

`npm run benchmark:worker-health` builds and launches six independent owned processes. Each uses
an in-memory synthetic database and takes 25 readings: legacy/bounded projections with four
compact records, 1,000 compact records, and 1,000 records containing 4,096 extra body bytes.
Process output is bounded and each child has a thirty-second deadline. Observations include
result bytes, median/maximum latency and process memory; no real tenant data or provider call is used.

In the final local measurement, 1,000 compact records return 5,061 bytes/100 observations rather
than 45,426 bytes/1,000 observations. The bounded median is approximately 2.30 ms versus 0.99 ms
for legacy, because it performs additional integrity checks. Oversized records correctly return
zero valid observations and 1,000 unavailable records, with a 625-byte result. Earlier SQL
materialization tuning reduced the bounded compact-case median from approximately 7.29 ms to
2.44 ms in that separate measurement. This is not a universal latency or memory improvement.

The [SQLite WITH documentation](https://www.sqlite.org/lang_with.html), checked 6 October,
describes the materialization fence used to avoid repeated projection evaluation. No schema,
index, dependency, provider budget, cache, execution concurrency or database migration is added.

## Actual concurrent client tasks

Two actual MCP SDK clients share one owned real loopback HTTP server. Each discovers and
validates the advertised schema, then concurrently completes its own five-GET synthetic
inventory. The tenants deliberately share native store/login/product IDs but have different
encrypted credentials, exact prices, names and currencies. A barrier establishes two reads
simultaneously in flight. Results, hashes and safe handoffs remain correctly tenant-bound.
Each task uses two tool calls; structured responses total 4,201/4,209 bytes in the recorded run.

A separate same-workspace task holds one caller's current native response while a second caller
completes all five reads. Revoking the first key cancels its body exactly once, yields the
original UNAUTHORIZED result with no inventory and prevents further reads. The second caller
continues discovery. Seven total reads are observed: two withdrawn and five successful.
Both tasks create zero drafts/reviews/snapshots, perform zero provider mutations and make zero
external requests. Local SDK fixtures do not establish acceptance by external client products.

## Qualification and retained failures

Forty-six focused worker, owner, recovery, timing and concurrent-client checks pass with zero
failures/skips; five final owner-interface checks additionally qualify in-place identity and
navigation-generation changes. Eight final prototype browser cases pass across English/Arabic
and 320/375/768/1280 CSS pixels. Each walks active/stale/uncertain/unavailable/not-observed states,
validates actual HTTP no-store responses, retains policies and confirms zero provider effects.
Named-control, landmark, ARIA and selected pinned A/AA inspections pass. Manual/incomplete rule
evidence remains explicit; these are not full accessibility or live-deployment certifications.

Earlier fixture failures remain recorded: an assumed document column, an omitted GET method
interpreted incorrectly by a test, an Arabic number-format assumption and an undefined fixture
date. They were corrected without weakening production authority, raw-value or worker assertions.
Fresh exact committed-source full/report/browser checks still gate the push. B13/B15/B16/B23/B24
remain partial; real tenant load, external clients, deployed image and broader qualification are
distinct. The whole-plan matrix remains 13 implemented / 14 partial / one open.
