---
status: record
tier: engineering
---

# LinkedIn Insight Tag domains — 2026-09-27

Base revision: `38b5f00` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: Insight Tags could be created and switched to first-party tracking, but the domains LinkedIn
lists for a tag could not be blocked or allowed. The single partial update and the batch partial
update (two rows) were blocked writes.

Contract source: the LinkedIn Marketing API "Conversion Tracking" page, section Insight Tag Domains
(li-lms-2025-10 to li-lms-2026-09), read on 2026-09-27. Key facts:

- LinkedIn fills the domains from tag traffic; each record has `insightTag`, `domainName` (without
  protocol), `created`, `lastCallbackAt` and `blocked`. Blocked domains "won't send a signal to
  downstream services".
- `POST /rest/insightTagDomains/(account:{sponsoredAccount URN},domainName:{host})` with
  `{patch: {$set: {blocked}}}` answers 204; a batch partial update of
  `/rest/insightTagDomains?ids=List(...)` with `{entities: {key: {patch}}}` answers 200 with
  `results` and `errors`.
- The finder `q=account&account={URN}` takes an optional `domainName`. Only FULL access to the tag
  may update its domains.

## Change

New reviewed family `linkedin_insight_tag_domains` (`src/linkedin-insight-domains.ts`):

| Part | Behaviour |
|---|---|
| Request | One key in the path, or 1–20 ids with one entity each under `BATCH_PARTIAL_UPDATE`; every key names the selected sponsored account and a host without protocol; the patch sets only `blocked` |
| Encoding | A compile step writes the path key and entity keys in the reference's REST.li form; raw and encoded input forms are both accepted |
| Scope | Server-built reads only: the ad account, its Insight Tag finder, its permission finder and the domain finder for each named host |
| Checks | The account has a tag, holds FULL access to it and LinkedIn lists each domain for it; domains already in the requested state are refused |
| Safety | No spending confirmation; blocking is shown as affecting serving (website audiences); the review lists the accounts that share the tag |
| Receipt | 204 (or 200) for one domain; for a batch, 200 with a 204 result for every id and no errors, otherwise a failure never resubmitted |
| Verification | Each domain found again with the requested `blocked` value; `lastCallbackAt` is left out of the state so a review does not go stale with traffic |

Other code: `src/compiler.ts` (the key encoding step), `src/scope.ts`, `src/preflight.ts`,
`src/write-review.ts` (the family is checked before the generic REST.li method refusal),
`src/write-verification.ts`, `src/write-impact.ts`, `src/review-state.ts`,
`src/reviewed-routes.ts`, `src/action-contracts.ts` and `src/provider-contracts.ts` (LinkedIn
contract version 13). Guidance: "Reviewed LinkedIn Insight Tag domains" in
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/linkedin-insight-domains.test.mjs`, three tests:

1. The tag owner blocks one domain (sent with the reference's encoded key), then allows one and blocks another in a batch, and allows the first again from the encoded input form; each verifies while `lastCallbackAt` moves; a replay sends nothing.
2. Twelve malformed requests (another account in a key, keys without a domain, hosts with a protocol, non-boolean or extra fields, removals, queries on single updates, batches without the batch method, entities without ids and ids without entities, repeated ids, 21 domains) are refused before any request; an account without a tag, an account with USE_ONLY access, an unknown domain and an unchanged value are refused after reading, without writes.
3. A batch reply with errors is never resubmitted; ignored single and batch updates are not verified; the ledger lists both writes in the family.

Red/green against a build of `38b5f00`: all three tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/linkedin-insight-domains-20260927/red-check.log`.

## Verification

- Targeted: 190 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,954/1,954.
- Guidance coverage: 320 write-path refusals across 187 modules accounted for.
- Full qualification: see
  [LINKEDIN-INSIGHT-DOMAINS-VERIFICATION-2026-09-27.json](LINKEDIN-INSIGHT-DOMAINS-VERIFICATION-2026-09-27.json).

Remaining rows: 754 (two LinkedIn rows reviewed; LinkedIn blocked writes 98 → 96). Live acceptance
is unverified; it needs the updated deployment and a LinkedIn ad account whose tag has traffic.
