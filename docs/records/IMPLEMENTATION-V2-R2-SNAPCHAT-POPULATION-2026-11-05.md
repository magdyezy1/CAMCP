---
status: record
tier: engineering
---

# Snapchat ad squads across account campaigns

V4 Overview ad-squad reports enumerate the account's complete campaign population, including deleted campaigns,
before collecting each selected campaign through the existing qualified daily evidence collector. Campaign inventory
uses at most 100 pages of 100 records; combined detail is limited to 10,000 daily rows and the job's existing shared
request, byte and time budgets. Missing, foreign, repeated or malformed parents and unsafe continuation refuse the
source. An empty population still verifies the current account, currency, timezone and authority.

Completed parent captures and population evidence are checkpointed with the frozen definition and login authority.
A retry retains finished work; changing the definition or authority refuses reuse. Native optimization goals,
configuration/deleted status, exact metrics, parent IDs, completeness declarations and request lineage survive merging.
This uses a provider-owned collection hook; the shared engine gains no Snapchat gateway switch.

The builder accepts optional campaign IDs rather than requiring one campaign. A saved scalar `campaign_id` becomes
the equivalent one-ID scope; conflicting filters refuse instead of widening. The original v3 rollback definition
and public guided single-parent presets retain their existing contracts. Old binaries refuse new all-campaign detail.
The editor retains an escaped, dated native campaign-ID reference from the last readable campaign snapshot. Arabic
copy is authored locally and remains subject to the owner's later native-speaker sign-off.

This record describes implementation, not provider acceptance. Local synthetic queue/worker tests cover pagination,
scope, native results and status, empty populations, bad cursors/parents, page limits, authority changes and retry
recovery. The first integrated focused run passed 83 tests in six files; broader filtered-candidate and browser
qualification remain pending at the time of this implementation record. No live provider request or deployment was
performed. X and Apple additional-level work and the rest of Round 2 remain separate.

Primary references (the date they were read is MISSING: this line first said 2026-11-05, and no fetch of that day is
recorded):

- [Snapchat campaigns](https://developers.snap.com/marketing-api/Ads-API/campaigns): account campaign collection,
  `read_deleted_entities`, bounded `limit`, cursor continuation, and its incompatibility with explicit sorting.
- [Snapchat measurement](https://developers.snap.com/marketing-api/Ads-API/measurement): ad-squad breakdown belongs
  to campaign statistics. No account-level ad-squad statistics query is invented.
