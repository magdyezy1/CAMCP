---
status: record
tier: engineering
---

# Batch 113 — exact linked-ad performance across four providers

Repository `magdyezy1/CAMCP`, sole branch `Work-here`, checkout `CAMCP-Codes-final-branch`. Baseline:
`79f49a0d3c5d59de3916429d29f3f9d2ae923b31`. This is a local retained-evidence improvement. It introduces no native
write action, authorization scope, automatic report capture or provider query.

## Delivered behavior

Creative receipts now offer **Inspect linked ad performance** for verified references to compatible Google Ads,
Snapchat and standard TikTok ads, alongside the existing Meta workflow. Choosing a retained snapshot displays the
daily rows for those exact ads. The snapshot, asset and verified plan must share the currently accessible provider,
account and login. The website offers the action only when the retained plan contains a qualified ad association.

| Asset platform | Guided snapshot | Required native grain | Qualified retained ad action |
|---|---|---|---|
| Meta | `meta_ad` | `ad × day` | `meta_ad_create`, `meta_ad_account_id_ads_create` |
| Google Ads | `google_ad` | `ad group × ad × day` | `google_ads_v23_ad_group_ad_mutate_ad_group_ads` |
| Snapchat | `snapchat_ad` | `ad × day` | `snapchat_ad_create` |
| Standard TikTok | `tiktok_ad` | `ad × day` | `tiktok_ad_create` |

Google joins preserve the complete `customers/{customer}/adGroupAds/{ad_group}~{ad}` resource name. Ads with the same
numeric ad ID in different ad groups remain different entities. Snapchat UUIDs and Meta/TikTok numeric text remain
exact strings; no lossy numeric conversion, resource suffix extraction or case rewriting occurs. Unsupported actions,
Smart+ aliases, other providers, campaign grains and manually imported sources cannot enter this join.

Only verified steps connected through actual result references establish usage. A dependency alone is insufficient.
The query selects bounded metadata using parameterized tenant/preset/grain/provider/account/login predicates;
report choices do not load report rows. Choice cursors bind the selected asset, exact snapshot scope, identity and
session. Daily rows retain their existing bounds and paging; every page rechecks current asset/plan authority.

The table exposes spend, impressions, clicks, conversions and conversion value, plus reach/frequency when present.
Native decimal and large integer strings remain exact. Missing values stay **Unknown**, and zero stays zero.
Currency, timezone, dates, attribution, conversion definition, completeness, grain and source hash remain those of
the selected snapshot. Original evidence remains one link away. The English/Arabic interface explains that these
are results for linked ad IDs; it does not allocate results to an image or establish its historical serving assignment.
External edits, dynamic creative combinations and missing rows remain unverified.

## Reproduced receipt defect

F-177 (low): SQLite `json_tree` quotes the `verified_resources` path segment. The old literal path-prefix check
missed a retained Meta ad resource supplied through that array, omitting its creative usage association. A red
Meta regression reproduced `CREATIVE_USAGE_REQUIRED`. Path projection now ignores SQLite's path-segment quotes
while preserving all native resource values and existing scope predicates. Array/check/result receipt forms remain
covered; no provider operation is repeated.

F-178 (low): an unsafe numeric retained resource was converted to text after JavaScript precision loss. A synthetic TikTok receipt for `9007199254740993` represented as a number became `9007199254740992`, which could select a different exact report identity. Unsafe numeric resources are now withheld; exact strings and safe integer IDs remain usable. A red regression reproduced the invalid association offer, and the green test refuses the join without egress. No actual provider corruption or live incident is asserted.

## Qualification

- Thirteen new tests cover the three additional platform joins, exact native identity, unrelated dependencies,
  unverified/unknown actions, wrong provider/account/login/grain/source, metadata/daily pagination, changed identity,
  current access revocation, the existing Meta receipt-array defect, unsafe numeric receipt identity, bilingual escaped metric rendering and real SDK
  transport. The SDK test uses an actual HTTP listener/client and revoked key; all provider transports refuse egress.
- Earlier root suite before the final unsafe-ID guard: **3,771 tests / 3,766 passed / zero failed / five expected local FFmpeg skips; 91.51 seconds**.
  Final focused: **39 tests / 39 passed / zero failed or skipped; 4.01 seconds**. Web checks cover **33 scripts / 2,917 selected Arabic messages / 3,058 catalog entries**.
- The disposable browser fixture seeds retained records, not accepted provider launches or live report captures.
  English Google/TikTok and Arabic Google/Snapchat flows were observed. Google mobile was checked in both languages;
  document/client width was **360/360 px** inside the 375-pixel viewport with its scrollbar. The table scrolls within
  its **282-pixel** region. A focused English region responded to arrow keys and advanced **70 px** horizontally.
- Desktop qualification reproduced a collapsed **33.14-pixel** ad column. Scoped table sizing restores a readable
  **288-pixel** identity column and approximately **69.78-pixel** Google daily rows, with contained table scrolling.
  Scoped column/row headers, a named keyboard-focusable region, a visible scroll hint and native LTR IDs were inspected.
  Screenshots and measured DOM evidence are retained under `.runtime/creative-performance-platforms-20261003/`.

These checks prove local storage, access, transport and UI behavior. They do not prove live native ad acceptance,
historical creative assignment, deployed behavior, independent assistive-technology certification or real tenant load.

## Previous delivered revision and remaining scope

Batch 112 exact HEAD `79f49a0d3c5d59de3916429d29f3f9d2ae923b31` passed all five sanitized stages:
**3,759 tests / 3,754 passed / zero failed / five local FFmpeg skips; 95.91 seconds**, four capture checks in
**83.53 ms**, 33 scripts, 2,915 selected Arabic messages and 278 documents. Its **1,583 public sources plus one
generated empty sample** have hash `f6b70defe71c61e661408df471286e06fa910a1315206d0f2e85226d14865ada`.
Committed-source parity was verified before/after qualification, and the sole push targeted `Work-here`.
[CI167](https://github.com/magdyezy1/CAMCP/actions/runs/37102885972), job `111145742832`, completed successfully. Decoded logs show **3,759 tests passed without failures or skips** on both host and Docker, four capture checks in each, Railway and both synthetic read/write container smoke flows. Host/Docker suites took **967.01/969.61 seconds**. No downloaded artifact or live-provider acceptance is claimed.

The matrix remains **13 implemented / 14 partial / one open**. B22 gains these three exact provider joins;
historical assignment, unsupported providers and external usage discovery remain. B18 gains local reuse of its
qualified ad snapshots; additional native dimensions/providers and LinkedIn conversion windows remain. B16/B24
gain the stated SDK/browser/RTL/keyboard evidence. Native classification remains **3,247 actions / 167 families /
1,712 reads / 800 reviewed writes / 502 blocked writes**. Each new revision requires its own CI and acceptance.


Initial sanitized preflight before the final unsafe-ID guard `.release/creative-performance-platforms-preflight-20261003` passed install/build/report/check/Railway: **3,771 tests / 3,766 passed / zero failed / five local FFmpeg skips; 91.84 seconds**, four capture checks in **75.57 ms**, 33 scripts, 2,917 selected Arabic messages and 279 documents. **1587 public sources plus one generated empty sample** have hash `0f9e80a6c50a39bb8f3b80ce1b8217535527dfc981b93a99f9eb3a03078fd760`. Exact committed-source qualification follows before the sole Work-here push.


Sanitized preflight before the fixture-cleanup repair `.release/creative-performance-platforms-preflight-v2-20261003` includes the unsafe-ID guard and passed install/build/report/check/Railway: **3,772 tests / 3,767 passed / zero failed / five expected local FFmpeg skips; 90.99 seconds**, four capture checks in **76.33 ms**, 33 scripts, 2,917 selected Arabic messages and 279 documents. **1,587 public sources plus one generated empty sample** have hash `728f90bae9f34275baf21034ccdc0d528841a0af7b9f5a69e57f119015787659`. Final focused checks passed **39/39 tests without skips in 4.01 seconds**. Exact committed-source qualification follows before the sole Work-here push.


The first committed-source check at `bc5b2f0` failed after all retained-store restart assertions passed: Windows returned `ENOTEMPTY` while removing that fixture directory. F-179 (low, test harness) adds parent/prefix checks for both owned retained-store temporary directories and at most three built-in filesystem retries with a 50 ms delay. All persistence, hash, access and backup assertions remain mandatory; cleanup errors still fail after the retry bound. The initial failed committed revision was not pushed. Fresh qualification is required for the repaired source.


Repaired sanitized preflight `.release/creative-performance-platforms-preflight-v3-20261003` passed install/build/report/check/Railway: **3,772 tests / 3,767 passed / zero failed / five expected local FFmpeg skips; 90.53 seconds**, four capture checks in **74.47 ms**, 33 scripts, 2,917 selected Arabic messages and 279 documents. **1,587 public sources plus one generated empty sample** have hash `51ab40dd333d38f2d01d4b05a37daa59ba84e48d9936ca3e646d4c670553c9c5`. All persistence/backup assertions and bounded fixture cleanup passed. Fresh exact committed-source qualification follows before the sole Work-here push.
