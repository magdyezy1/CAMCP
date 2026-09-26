# Meta lookalike audiences — 2026-09-26

Base revision: `978b061` on `Codex-branch`, working copy `Downloads/CLaude workspace`. Push target: `magdyezy1/CAMCP` only. No live provider
calls, credentials, permissions, deployment or DNS changes were made. All evidence below
is synthetic.

Source: the P1 ticket "prioritize real campaign blockers among remaining scoped writes"
in the [2026-09-25 handoff](RESUME-HANDOFF-2026-09-25.md). Prospecting campaigns on Meta
target lookalikes of existing audiences; the custom audience create route was a blocked
write. Lookalikes use an existing seed and upload no customer data.

Contract source: Meta Marketing API
[Lookalike Audiences guide](https://developers.facebook.com/docs/marketing-api/audiences/guides/lookalike-audiences),
checked 2026-09-26:

- The request is `POST /act_{id}/customaudiences` with `name`, `subtype: LOOKALIKE`, `origin_audience_id` (seed at least 100; not flagged 471) and a `lookalike_spec`.
- The spec takes `type` (`similarity`/`reach`) or `ratio` (0.01–0.20 in 0.01 steps, optional lower `starting_ratio`), plus `country` or `location_spec`, and optionally `allow_international_seeds`.
- The response is `{id}`; population takes 1–6 hours.
- Reads return `lookalike_spec` with `type`, `ratio`, `starting_ratio`, `country` and `origin`.

## Contract

`meta_custom_audience_create` and `meta_ad_account_id_customaudiences_create` form the new
reviewed family `meta_lookalikes` (`src/meta-lookalikes.ts`). Only the LOOKALIKE subtype
is accepted on this shared route.

| Stage | Behaviour |
|---|---|
| Validation | Before any read, `INVALID_META_LOOKALIKE` unless the request has the documented keys only: `subtype: LOOKALIKE`, a name, a numeric seed, exactly one of `type`/`ratio` (whole-percent steps, compared in hundredths), a `starting_ratio` below `ratio`, and exactly one of `country` or `location_spec` country lists. Country groups, other subtypes, rules, retention and customer-file fields are refused |
| Ownership | An account audience list records only rows whose `account_id` is the selected account; shared audiences are listed but not owned. A created lookalike is owned from its receipt |
| Reads | The ad account, and the seed (`id,account_id,subtype,operation_status`), before review and again before execution |
| Seed rules | The seed must be in the selected account (`STATE_TARGET_MISMATCH`) and not flagged 471 (`INVALID_META_LOOKALIKE`). Meta enforces the 100-person minimum |
| Impact | `creative_impact` names the seed, size and countries; no delivery or spend |
| Receipt | The existing Meta account-create rule: a numeric `id` |
| Verification | Reads `id,name,subtype,lookalike_spec` and compares name, `LOOKALIKE`, the seed as `origin` IDs, and the sent `type`, `ratio`, `starting_ratio` or `country`. `location_spec` and `allow_international_seeds`, which Meta does not echo, are listed under `unobservable_fields` |

Not qualified: customer-file, website, engagement and other subtypes; campaign, ad set and
Page conversion lookalikes; country groups; audience update and deletion; user uploads.

Other code: `src/reviewed-routes.ts`, `src/write-review.ts`, `src/write-impact.ts`,
`src/write-verification.ts`, `src/scope.ts`, `src/provider-contracts.ts` (Meta contract
version 9), `src/action-contracts.ts`. Guidance: "Lookalike audiences" in
`Skills/amcp-campaign-builder/references/meta.md` and an executable inspect example.
Generated: `docs/CONTRACTS.md`, `ACTION-CONTRACT-COVERAGE.{csv,json}`,
`REMAINING-ACTIONS-2026-09-26.csv` (965 rows).

## Tests

`tests/meta-lookalikes.test.mjs`, eight tests:

1. Both actions inspect as reviewed with no network.
2. 16 invalid requests are refused before any request.
3. An unlisted seed is unowned; after listing, the seed is read twice; the audience is created once; seed, ratio, starting ratio and country verify; replay makes no second POST.
4. A `location_spec` lookalike verifies, with the location listed as unobservable.
5. A seed shared from another account stays unowned after listing, and a flagged seed (471) is refused.
6. A different ratio reads back as inconclusive.
7. A Meta-declared error, an empty receipt and a lost response each POST only once.
8. Concurrent execution submits once; a fresh service replays and verifies.

Red/green: all eight fail against a build of `978b061` (`WRITE_CONTRACT_UNAVAILABLE`) and
pass with this change. Local log: `.runtime/meta-lookalikes-20260926/red-check.log`.

## Verification

- Targeted: 640/640 across 59 related suites, including every Meta, TikTok and Snapchat
  write suite.
- Guidance coverage: 235 write-path refusals across 111 modules accounted for.
- Full qualification: see
  [META-LOOKALIKES-VERIFICATION-2026-09-26.json](META-LOOKALIKES-VERIFICATION-2026-09-26.json).

Live acceptance is unverified. It needs the updated deployment and an owned seed audience,
which this batch does not authorize.
