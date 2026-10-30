---
status: record
tier: engineering
---

# LinkedIn portfolio navigation — 2 October 2026

Repository: `magdyezy1/CAMCP`. Branch: `Work-here`. Folder: `CAMCP-Codes-final-branch`.
Baseline: `b6edd65`. Batch 81 extends B27 and the B15 SDK workflow evidence.

LinkedIn portfolio now follows campaign groups → campaigns → creatives through the existing native read
contracts. The website starts at campaign groups, retains both parent IDs in navigation, shows exact decimal
amounts with their returned currency and separates intended creative status from observed serving/hold reasons.
Unknown timezone stays unknown. English/Arabic controls retain exact native request values. All portfolio results
include the first-party `record_kind:portfolio` and an MCP website handoff to `/portfolio`.

MCP: `amcp_workspace {action:"portfolio",gateway:"linkedin_native_action",account_id,connection_id,limit,
requirements:{entity:"campaign_group"}}`. Follow a returned group using `entity:"campaign",campaign_group_id`,
then a returned campaign using `entity:"creative",campaign_group_id,campaign_id`. Each child requires a qualified
parent observation from this exact account/login in the preceding five minutes, plus fresh native parent reads.
The campaign's group and every row's account/parent are verified. Current credentials, grants and read scope are
rechecked around every request and before returning or recording observations. No partial failed page records
qualified parents and these read observations grant no write authority.

Cursor search uses `pageSize`, ascending native IDs and only the returned `metadata.nextPageToken`; no next URL
is followed and no offsets are synthesized. Groups explicitly search seven documented statuses: ACTIVE, ARCHIVED,
CANCELED, DRAFT, PAUSED, PENDING_DELETION and REMOVED. Test/non-test entities are included. Campaign searches bind
the native group URN; creative criteria bind the native campaign URN. Missing final metadata/next token means the
documented last page. Legacy paging, malformed metadata, repeated tokens/IDs, wrong parents, unordered IDs,
oversized pages and inexact IDs/money refuse the read. Empty inventory remains valid.

Signed, canonically encoded cursors bind tenant/user, login/current credential fingerprint, API version, account,
entity, exact parents and page size; they expire after five minutes and permit at most 100 pages. Each page permits
1–100 rows, eight requests including transport retries, 8 MiB and 60 seconds. Native decimal strings remain
unconverted and must match account currency when known. The projection omits provider people/content/unknown
fields. This is current paginated inventory, not point-in-time reconciliation or complete historical coverage.

**F-151 (medium)** was reproduced against `b6edd65`: departed portfolio controls could initiate more reads after
a route/identity change or detached view. A pre-request form/view/route/identity guard now stops them; the existing
response sequencing remains. Backend access checks still independently apply. This is controller fixture evidence,
not an observed deployed cross-user incident.

Ten new tests: seven backend cases (five observed red against the unqualified baseline; two negative cases
already passed), two new UI cases observed red, and one real-SDK journey whose initial missing website handoff
failed before implementation. Focused **38/38** passed. The SDK LinkedIn journey used **4 tool calls / 8,003
structured response bytes / 11 synthetic native GETs**. English/Arabic tests cover all three levels, parent/root
navigation, exact decimals, independent serving state, continuation and departed controls. Static checks cover
**32 browser scripts / 2,503 selected Arabic messages**. Full and sanitized qualification follows below.
Logs are in `.runtime/linkedin-portfolio-20261002/`. No live provider, actual browser/assistive-technology or
deployed acceptance is claimed. No new dependency, migration, OAuth scope, advertising mutation or external message.

Native ledgers remain **3,247 actions / 167 families / 1,712 native reads / 800 reviewed writes / 502 blocked writes**.
The blueprint remains **13 implemented / 14 partial / 1 open**; B27 gains LinkedIn but further provider/dimension
and point-in-time reconciliation work remains. Private root samples were not read.

Implementation was checked against official LinkedIn documentation for [campaign groups](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaign-groups?view=li-lms-2026-08),
[campaigns](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns?tabs=http&view=li-lms-2026-02) and
[creatives](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives?view=li-lms-2026-05).
The application freezes its configured LinkedIn API version for the entire cursor context; the current default is 202609.
Documentation and synthetic response qualification do not certify any particular advertiser's entitlement.

Batch 80 follow-through: exact HEAD `b6edd65fc1ab6555690597c99f7f7a08e421bc7c` passed every check/Railway stage
in `.release/workbook-retirement-work-here-head-20261002`: **3,386 passed, zero failed, five local FFmpeg skips;
78.81 seconds**, four capture tests and byte parity for **1,485 public source files** plus one generated empty sample.
Hash: `ffa1200ead8f6a562acfce29ae25bd3e79b4959eaf6f40693f444dda212e3e4c`.
The sole push started [CI135](https://github.com/magdyezy1/CAMCP/actions/runs/36936557694), pending at this record's
latest check, as is [CI134](https://github.com/magdyezy1/CAMCP/actions/runs/36935041343).
[CI133](https://github.com/magdyezy1/CAMCP/actions/runs/36930848046) passed on `b24576c`: host and Docker each
passed **3,372 tests**, zero failures/skips, required FFmpeg, four capture tests, Railway and both container smokes.
Job `110599424497` uploaded release-evidence artifact `11197033718`.

Final root suite: **3,401 tests; 3,396 passed, zero failed, five local FFmpeg skips; 73.18 seconds**.
Sanitized and exact committed-source checks follow before push.

Sanitized preflight `.release/linkedin-portfolio-preflight-20261002` passed every check/Railway stage:
**3,396 passed, zero failed, five local FFmpeg skips; 77.59 seconds**, four capture tests, 32 browser scripts
and 247 documents. Its **1,488 public source files** plus one generated empty sample have hash
`4fff68e5551b355a49b70012d97c2d548195adbeb67a4d0dc9c4ce3d956d7a4c`. Exact committed-source checks follow before push.
