---
status: record
tier: engineering
---

# Meta creative source ownership — 2026-09-24

Continuation baseline: reporting commit `0d8204dfce2fc20e434a8f4ebd2a9a0c4f209d6e`
on Codex-branch. That commit was pushed and the remote matched. Main remained
`067871481d79fc59a6cb976d8a13b62d409e283a`. The GitHub Actions connector returned
404 for this repository, so remote CI was not observable through that connection.

## Confirmed local defect and correction

R1 from the September 20 handoff is reproduced. A direct Meta creative prepare
accepted a foreign Facebook Page post or Instagram user/media reference after only
reading the advertiser. Campaign preflight checked Page/Instagram membership, but
direct reviewed writes did not. Two isolated expected-denial tests failed. This is
a P1 local authorization/prerequisite gap: an AMCP-selected advertiser alone must
not establish ownership of other identities. No live cross-account exploit or
successful provider mutation was attempted or established.

`src/meta-creative-state.ts` now completes bounded advertiser Page and Instagram
identity collections and checks the selected Page linkage. Existing Instagram
media resolves its Page from native advertiser metadata; no caller field or
Facebook story is invented. Existing content reuses `fetchMetaExistingPosts` for
the exact Page token and native owner check. The private reader accepts an internal
authorization callback so write grants and credential changes are checked around
every dependency request, including Page-token reads. Generic Graph scope rules
and persistent resource grants are unchanged.

`src/write-review.ts` invokes these checks both at prepare and execute and includes
the projected identity/content in review state. Captions/messages and ownership
changes remain meaningful; counters, tokens and unrelated identities cannot cause
false conflicts. Inspect lists entry identity reads; Page-token/content reads are
resolved dynamically from those verified identities. Source fields cannot combine
conflicting Page-story/existing-post or Instagram identities. Error remedies,
Meta contract version 7, generated contracts and the AI-facing Meta guide describe
the prerequisites and limitations.

The top-level create contract explicitly admits name, one of the three supported
source forms, the consistent Instagram user and URL tags. Official SDK research
also exposed alternate source/actor and advanced creative parameters; those cannot
be assumed equivalent to the verified source and are now refused before egress.
The supported fields are shared with tool contract metadata. This is a deliberate
compatibility boundary: an advanced payload previously passed through without
these proofs must receive its own ownership/eligibility contract before enabling it.

Existing post reviews require the documented recorded read scopes in addition to
ads_management. Current tokens/permissions are not modified. New Page-story creates
retain their advertiser Page check and ads_management requirement. Partnership or
third-party creator content is not qualified by this owner-only workflow. Native
ad eligibility, actual token acceptance and placement restrictions remain separate.

Identity traversal: at most 25 pages/1000 identities per collection, 50 requests,
2 MiB/response, 8 MiB total, 60-second monotonic deadline. Exact existing-content
proof separately reuses the prior reader's 80-request/8-MiB/60-second bound. Native
next URLs are never fetched; only bounded cursors are replayed on fixed edges.
All reads are synthetic in verification. No live advertising or permission changes.

## Evidence

Official Meta SDK 25.0.3 inspected again on 2026-09-24:

- [IGMedia fields and GET](https://github.com/facebook/facebook-python-business-sdk/blob/25.0.3/facebook_business/adobjects/igmedia.py)
- [AdAccount identity edges](https://github.com/facebook/facebook-python-business-sdk/blob/25.0.3/facebook_business/adobjects/adaccount.py)
- [Page linkage and token fields](https://github.com/facebook/facebook-python-business-sdk/blob/25.0.3/facebook_business/adobjects/page.py)

The existing source-hashed Meta fixture remains the schema provenance check. A
fresh public AdAccount source fetch matched its pinned SHA256 exactly:
`7349d7ec8da801a33d37f7a02c67e163cfa7ebcc23eb2a5969adcc093d0a2b7e`.
Direct Meta documentation returned 429/unavailable. The Postman documentation
request returned a shell, not usable permission evidence. SDK field presence is
not proof of live app approval or access.

Root evidence logs are in `.runtime/reporting-20260924/`:

- `meta-owner-gap-2.log`: two negative direct-prepare reproductions failed before
  implementation. The initial harness incorrectly placed connection_id inside the
  native action and got a schema refusal; that was not counted as owner protection.
- `meta-build-1.log`: three TypeScript unknown-value narrowing errors, corrected
  without changing the runtime assertions. Subsequent builds passed.
- `meta-ownership-1.log`: 35 passed, one failed because the new fixture expected a
  different disabled-connection error code. Asserted the actual established
  `CONNECTION_REQUIRED` signal explicitly; rejection/no-egress assertions retained.
- `meta-ownership-2.log` and `meta-ownership-3.log`: 76 passed, zero failed/skipped,
  covering owner checks, existing-post readers, image/creative/ad chains, campaign
  recovery, recommendation preflight and executable guidance.
- `meta-ownership-4.log`: seven ownership/recovery tests passed, including parallel
  execute calls and a lost response with no repeat mutation. Cases also exercise
  private token exclusion, telemetry changes, meaningful content conflicts,
  incomplete pagination, revocation and login changes during private reads.
- `meta-ownership-5.log`: 23 passed, zero failed/skipped, including the eighth
  ownership test for alternate native source/actor overrides. Existing Meta creative
  and media chains and executable examples still pass with the explicit field gate.
- `npm.cmd run contracts:generate`, build and action-contract check passed. Native
  inventory remains 3241 actions / 423 reviewed-family / 894 blocked writes.

Both sanitized Meta candidates completed the entire check with exit 0:

- `.release/meta-identity-20260924-a`: 550 files; tree hash
  `fdb71c5498460b3635865508e3705479be354120f033b9a05488eddadeeb6874`;
  1412 main tests passed, zero failed, one optional FFmpeg skip; four capture
  tests passed. This predates the final alternate-source field gate.
- `.release/meta-identity-20260924-b`: 550 files; tree hash
  `e121d6671889e4f228b5d16a69c20db05681cbc16da69c76f7f32eba4b0b9804`;
  **1413 main tests passed, zero failed, one optional FFmpeg skip; four capture
  tests passed.** Check log SHA256:
  `25a01f18a4c7bc83e6d9b3c7443caa0825f4d8d920e99e991c47931ab48d092b`.
  Offline install log SHA256:
  `b6ebe3f0a3188e0db53898395a619cadcfee9b101220e0c450b99732d97df902`.

Commands in each candidate: `npm.cmd ci --offline --ignore-scripts --cache
<implementation>/.runtime/npm-cache`, then `npm.cmd run check` with
`AMCP_SCHEMA_PYTHON` set to the bundled Python executable. Node 24.19.0,
npm 11.17.0, Windows/PowerShell. The final candidate's executable files matched
the implementation at verification. Documentation updates do not change this
result. FFmpeg-required mode, Docker, live Meta, and remote Actions remain unrun.

The user supplied a deployment/DNS issue before the follow-on push. That HTTP
startup change receives a fresh combined candidate; see
[startup and DNS evidence](STARTUP-DNS-2026-09-24.md). The Meta correction was not
silently altered in response to those operational screenshots.

## Rollout and remaining scope

No database or runtime dependency migration. Existing saved reviews may now fail
comparison because they lack the source proof; prepare a new review only if the
original mutation was never submitted. Completed/uncertain receipts retain their
original idempotency claim. Rollback must preserve these receipts; reverting this
guard reopens the demonstrated prerequisite gap.

The remaining native-action inventory and R2–R12 roadmap are unchanged. R1's direct
source identity and owner-check mismatch is addressed locally by this batch.
Full new-story media ownership/eligibility, editable post attachments beyond the
reader's projected fields, partnership creatives and live provider qualification
are not established by this correction. Continue bounded contracts with separate
evidence; do not mark unrelated blocked catalog writes implemented.
