---
status: record
tier: engineering
---

# TikTok custom identities — 2026-09-26

Base revision: `8b97bdb` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes"
in the [2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). A TikTok non-Spark ad needs an
identity; an advertiser without a linked TikTok account needs a `CUSTOMIZED_USER` identity
before its first ad. `tiktok_identity_create` was a blocked write, and
`tests/creative-chain-audit.test.ts` pinned identity provisioning as a contract gap.

Contract source: TikTok API for Business v1.3 reference, read in the rendered portal on
2026-09-26:

- [Create an identity](https://business-api.tiktok.com/portal/docs/create-an-identity/v1.3): `display_name` ≤100 characters; optional 1:1 `image_uri` from `/file/image/ad/upload/`; the response returns `data.identity_id`.
- [Get info about an identity](https://business-api.tiktok.com/portal/docs/get-info-about-an-identity/v1.3): `identity_info` with `display_name`, `identity_type` and a derived `profile_image_url`.
- [Get the identity list](https://business-api.tiktok.com/portal/docs/get-the-identity-list/v1.3).
- [Get info about images](https://business-api.tiktok.com/portal/docs/get-info-about-images/v1.3): width, height and signature; `image_url` is valid for an hour.

## Contract

`tiktok_identity_create` (`POST /v1.3/identity/create/`) is the new reviewed family
`tiktok_identities` (`src/tiktok-identities.ts`).

| Stage | Behaviour |
|---|---|
| Validation | Before any read: only `advertiser_id` (the selected advertiser), `display_name` (1–100 characters) and `image_uri` (the media workflow's image ID shape). Anything else, such as `identity_type` or `identity_name`, is `INVALID_TIKTOK_IDENTITY` |
| Reads | Advertiser info, and `GET /v1.3/file/image/ad/info/` for the avatar, before review and again before execution |
| Avatar rules | The image must be returned for the selected advertiser (`STATE_TARGET_MISMATCH`) and be square (`INVALID_TIKTOK_IDENTITY`, with the reported size) |
| Review evidence | The image's `image_id`, `width`, `height` and `signature` only; the re-signed `image_url` is not a state change |
| Impact | `creative_impact` names the identity type, display name and avatar size. No delivery or spend |
| Receipt | Existing TikTok rule: `code: 0` and a `data.identity_id` |
| Verification | `GET /v1.3/identity/info/` with `identity_type=CUSTOMIZED_USER`. The read must succeed with `identity_info` for the exact new ID, and `identity_id`, `identity_type` and `display_name` are compared. The avatar is reported only as a derived URL, so a sent `image_uri` is listed under `unobservable_fields` with an explanation instead of being compared. This is a new verification output field; it does not affect status |

Not qualified, and still blocked: `tiktok_identity_delete`, because ads may reference the
identity and no dependency read exists. TikTok-account identities (`AUTH_CODE`, `TT_USER`,
`BC_AUTH_TT`) are authorized rather than created.

Other code: `src/reviewed-routes.ts`; `src/write-review.ts` (shape, reads, image and
identity-info state validation); `src/write-impact.ts`; `src/review-state.ts` (TikTok image
projection); `src/write-verification.ts` (identity-info read, entity and
`unobservable_fields`); `src/provider-contracts.ts` (TikTok contract version 3, reviewed
2026-09-26); `src/action-contracts.ts`. Guidance: "TikTok custom identities" in
`Skills/amcp-campaign-builder/references/tiktok-snapchat.md` and an executable inspect
example. Generated: `docs/CONTRACTS.md`, `ACTION-CONTRACT-COVERAGE.{csv,json}`,
`REMAINING-ACTIONS-2026-09-26.csv` (971 rows).

## Tests

`tests/tiktok-identities.test.mjs`, nine tests:

1. Create inspects as reviewed with no network; delete stays blocked.
2. Eight invalid payloads are refused before any request; exactly 100 characters is accepted.
3. Without an avatar: only advertiser info is read; one POST; verified on three fields; replay makes no second POST.
4. With an avatar: the image is read twice despite a re-signed URL; the impact shows 200×200; verified with `unobservable_fields: ["image_uri"]`.
5. An image missing from the library, and a 750×422 image, are refused before any write.
6. A different display name reads back as inconclusive.
7. Identity info without `identity_info` is `unverified` (`STATE_READ_FAILED`). Info naming another identity is retried as read-after-write lag and stays `inconclusive`.
8. A TikTok-declared error (`PLATFORM_ERROR`, then `WRITE_OUTCOME_UNCERTAIN`), an empty receipt (`WRITE_PARTIAL_OR_FAILED`) and a lost response (`WRITE_OUTCOME_UNCERTAIN`) each POST only once.
9. Concurrent execution submits once; a fresh service replays and verifies; a lost receipt stays uncertain.

`tests/creative-chain-audit.test.ts`: the pinned gap assertion now expects the undocumented
`identity_name` payload to be refused as `INVALID_TIKTOK_IDENTITY` before any provider
request.

Red/green: against a build of `8b97bdb`, all nine new tests and the updated pinned
assertion fail (`WRITE_CONTRACT_UNAVAILABLE`); the four other tests in that file pass. All
pass with this change. Local log: `.runtime/tiktok-identities-20260926/red-check.log`.

## Verification

- Targeted: 467/467 across 45 related suites, including media upload, the creative chain
  and every TikTok suite.
- Guidance coverage: 230 write-path refusals across 108 modules accounted for.
- Full qualification: see
  [TIKTOK-IDENTITIES-VERIFICATION-2026-09-26.json](TIKTOK-IDENTITIES-VERIFICATION-2026-09-26.json).

Live acceptance is unverified. It needs the updated deployment and a test advertiser,
which this batch does not authorize. Whether TikTok's `profile_image_url` can be tied to
the sent image ID is also unverified; until then the avatar stays unobservable.
