---
status: record
tier: engineering
---

# X custom audiences — 2026-09-27

Base revision: `63ad83a` on `Codex-branch`, working copy `Downloads/CLaude workspace`.
Push target: `magdyezy1/CAMCP` only. No live provider calls, credentials, permissions,
deployment or DNS changes were made. All evidence below is synthetic.

Why: targeting can already name an X custom audience, but the audience itself could not be created,
renamed or deleted. Three rows (create, update, delete) were blocked writes. Adding users (customer
data) and sharing audiences stay outside this batch.

Contract source: the X Ads API v12 Audiences reference, "Custom Audiences", read on 2026-09-27. Key
facts:

- `POST accounts/:account_id/custom_audiences` "Creates a new placeholder Custom Audience" from
  `name` ("Unique name value must be used") and an optional `description`; `PUT` changes either;
  `DELETE` deletes the audience. No length limits are stated.
- The list takes `q` (case-insensitive prefix match, 1–255 characters) and `permission_scope`
  (`OWNER` by default); reads by ID take `with_deleted`; audiences report `is_owner`,
  `owner_account_id` and `permission_level`.
- `GET .../custom_audiences/:id/targeted` retrieves "active or all line items and campaigns that
  target" the audience (`with_active=false` for all).

## Change

New reviewed family `x_custom_audiences` (`src/x-custom-audiences.ts`):

| Part | Behaviour |
|---|---|
| Request | Create (name, description), change the name and/or description, or delete; users, types and sharing fields are refused |
| Limits | AMCP's own: names of 1–255 characters (what name search accepts) without surrounding spaces or control characters, descriptions of up to 1000 |
| State | The account, the audience with deleted rows, the owned audiences whose names match in any case, and for deletions every line item that targets the audience, active or not |
| Checks | Only audiences the account owns change (`ACCOUNT_SCOPE_MISMATCH`); names are unique in any case (`CONFIGURATION_EXISTS`); unchanged values and deleted audiences are refused; a targeted audience is not deleted (`AUDIENCE_IN_USE`) |
| Safety | Nothing needs spending confirmation; deletions count as deletions under owner policies |
| Receipt | The returned audience must be the one named, with the values sent, owned, or deleted for a deletion; anything else is a failure never resubmitted |
| Verification | The audience read again with deleted rows: name and description, or deleted or gone |

Other code: `src/preflight.ts`, `src/write-review.ts`, `src/write-verification.ts`,
`src/write-impact.ts`, `src/review-state.ts`, `src/reviewed-routes.ts`, `src/action-contracts.ts`
and `src/provider-contracts.ts` (X contract version 13). Guidance: "X custom audiences" in
`Skills/amcp-campaign-builder/references/linkedin-x.md` and an executable inspect example.

## Tests

`tests/x-custom-audiences.test.mjs`, five tests:

1. A placeholder audience is created and verifies, and a replay sends nothing; an audience is renamed and then redescribed, each verified.
2. An untargeted audience is deleted and verifies; a targeted audience is refused with `AUDIENCE_IN_USE`, a shared one with `ACCOUNT_SCOPE_MISMATCH`; an owner deletion rule refuses deletions but not creation.
3. Ten malformed requests fail before any request.
4. A name taken in another case, a rename to another audience's name, unchanged values, a deleted and an unknown audience are refused after reading, without writes.
5. A receipt with another name is a failure never resubmitted; ignored changes are not verified; the ledger lists the three writes in the family.

Red/green against a build of `63ad83a`: all five tests fail (no reviewed family: WRITE_CONTRACT_UNAVAILABLE). Local log:
`.runtime/x-custom-audiences-20260927/red-check.log`.

## Verification

- Targeted: 177 related suite files, including every Google, Criteo, DV360, LinkedIn, Snapchat, X, media,
  scope and security suite, with FFmpeg configured: 1,908/1,908.
- Guidance coverage: 306 write-path refusals across 174 modules accounted for.
- Full qualification: see
  [X-CUSTOM-AUDIENCES-VERIFICATION-2026-09-27.json](X-CUSTOM-AUDIENCES-VERIFICATION-2026-09-27.json).

Remaining rows: 786 (three X rows reviewed; X blocked writes 46 → 43). Live acceptance is
unverified; it needs the updated deployment and an X Ads account.
