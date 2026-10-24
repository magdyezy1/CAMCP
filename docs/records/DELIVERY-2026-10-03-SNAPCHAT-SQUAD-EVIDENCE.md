---
status: record
tier: engineering
---

# Snapchat ad-squad evidence and ownership cache integrity

Batch 106, 2026-10-03. Baseline: `3e87fee`. Sole repository/branch: `magdyezy1/CAMCP`, `Work-here`.

## Delivered behavior

Reports and MCP now discover `snapchat_adsquad`, bringing guided native capture to **16 presets across five
platforms**. The ad-squad preset requires an exact parent campaign UUID. It uses the existing campaign stats
contract with `breakdown:adsquad`, retaining the existing explicit swipe/view windows, conversion-time purchase
definition, account-local whole-day boundaries, exact micros, complete bounded pages and processing watermarks.
Other presets reject the unsupported campaign filter rather than silently ignoring it.

Before a global campaign read, the collector observes the selected campaign in a bounded account-scoped campaign
collection. It verifies the campaign's exact native ID/account before and after all stats pages. Each collection,
parent, stats and account read retains its original request, hash and timestamp. The outer stats envelope must name
the selected campaign; breakdown entities must be native `AD_SQUAD` rows. Current credentials, actor/account access
and whole-job limits are checked around every request. Foreign, malformed, failed, repeated, unfinished or changed
evidence is refused. Positive collection membership establishes only the observed parent's ownership; it does not
claim a complete account inventory, an atomic snapshot or historical creative assignment.

English/Arabic capture controls explain the parent requirement and link to Portfolio. The parent field is required
only for this preset and omitted for the other presets. Retained-reference reconciliation additionally requires the
same exact parent campaign. Existing retained-row search, paging and all-row Excel downloads remain available.

## Confirmed defect and validation

**F-163, high:** Snapchat's ownership observer accepted explicit failed collection/read wrappers, foreign or coerced
account identities and failed single-resource wrappers as ownership evidence. Six synthetic assertions were observed
red, including failed organization ownership and renewal beyond the original five-minute expiry. The observer now
ignores explicit failures and mismatched owner identities. Failed observations cannot extend earlier ownership.
Qualified account-edge observations that legitimately omit the optional owner column remain supported; segments
still require their explicit owning account. No cache TTL, scope, grant, review or write protection was relaxed.

- Initial feature suite: **three failed / ten passed**. Existing guards passed before the new preset existed;
  later green tests exercise its actual collector.
- Ownership initial suite: **four failed / two passed**. Extended renewal suite: **two failed / nine passed**.
- Bilingual parent-field suite: **one failed / 16 passed**.
- Completed focused suite: **78 passed / zero failed**. It includes parent/cursor/authority rejection, 201 ad
  squads across two pages, and three real service/fake-transport cases proving failed or foreign collection data
  cannot enable a later global stats request.
- New real MCP SDK journey: **four tool calls / 16,102 structured-response bytes / 12 synthetic read-only GETs**.
  Advertised schemas, parent lineage, retained comparison and revoked-key refusal before egress are checked.

Evidence logs are in `.runtime/snapchat-squad-evidence-20261003/`. The first feature green run exposed an incorrect
new test's retained-document wrapper assumption; it was corrected to the existing Store API without weakening
the comparison guard. No live provider mutation or independent browser/accessibility certification is asserted.

## Native contract basis

Official [Snap Measurement](https://developers.snap.com/marketing-api/Ads-API/measurement) and
[Snap Campaigns](https://developers.snap.com/marketing-api/Ads-API/campaigns), read **2026-10-03**, document the
campaign-scoped ad-squad breakdown, campaign collection/exact parent reads, account-day boundaries, attribution,
processing finalization and native stats paging. This batch reuses registered contracts and introduces no new
route, family, OAuth scope or provider write. The native ledger remains **3,247 actions / 167 families / 1,712 reads /
800 reviewed writes / 502 blocked writes**.

## Previous delivery and remaining acceptance

Batch 105's exact committed-source candidate on `3e87fee` passed all five stages and Railway:
**3,665 passed / zero failed / five local FFmpeg skips; 98.64 seconds**, four capture tests, **1,561 public files +
one generated empty sample**, source hash
`dbf2800d03441259bc500d77727162963e2b24e80e7babd10a65e61a7803f1db`.

[CI159](https://github.com/magdyezy1/CAMCP/actions/runs/37082107361) on batch 104 `70df5cf` completed successfully.
Job `111084671601` logs show **3,651 passed / zero failed / zero skipped** on both host and Docker, four capture
tests, Railway verification and successful synthetic read/write smoke. CI160 on `3e87fee` was still running when
last checked; that is not a passed-CI claim for this batch.

Blueprint scope remains **13 implemented / 14 partial / one open**. B18/B27 retain further providers/dimensions
and point-in-time/provider reconciliation. B15/B16/B24 retain external-client, independent browser, keyboard,
assistive-technology and deployed/live acceptance. This evidence increment does not close those requirements.

Full local regression: **3,688 tests / 3,683 passed / zero failed / five local FFmpeg skips; 89.34 seconds**.
Selected Arabic validation covers **2,813 messages**. No native ledger classification changed.

Sanitized preflight `.release/snapchat-squad-evidence-preflight-20261003` passed all five stages and Railway:
**3,683 passed / zero failed / five local FFmpeg skips; 94.61 seconds**, four capture tests,
33 browser scripts, 2,813 selected Arabic messages and 272 documents. Its **1,563 public source files**
plus one generated empty sample have hash `0abb722a8e0d317fe362adc7402592bb8cd122546581876c68ced7a947a3e012`.
Exact committed-source qualification follows before the sole Work-here push.
