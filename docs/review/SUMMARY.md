# Review summary for the owner

Review of AMCP started 2026-09-28 from `03ac8d3`, on branch `Codex-branch`. The detailed records are in this
folder: [FINDINGS.md](FINDINGS.md) (80 findings with severity and status), [THREAT-MODEL.md](THREAT-MODEL.md),
[MCP-SECURITY-CALIBRATION.md](MCP-SECURITY-CALIBRATION.md) (your question on read and write controls),
[PLATFORMS.md](PLATFORMS.md) (per-platform contracts and workflows), [ACCESSIBILITY.md](ACCESSIBILITY.md),
[ARCHITECTURE.md](ARCHITECTURE.md), [ROADMAP.md](ROADMAP.md) and [PROGRESS.md](PROGRESS.md), which lists every batch
with its red/green evidence and its qualification.

## What changed

**Money safety.** Numeric statuses now count as activation. Reddit `goal_value` budgets count under owner policies.
Delivery edits need `spend_change_confirmed` because of what they change, not because a field name contains
"budget". `amcp_campaign` no longer fills in the spend confirmation itself. `prepare` announces every acknowledgement
execute will need. The owner can pause every reviewed write at runtime with a reason, without a redeploy.

**Read and write controls through MCP.** Your question was whether the controls are too tight or too loose. Where
they were loose, they are tightened: the four points above, `native_request` refused in writes, and bounded Drive
inspection. Where they were stumpers, they now explain themselves:
- an expired review returns the call that prepares it again;
- an ownership refusal names the read that establishes ownership;
- plan steps no longer fail on an `account_id` their schema forbids;
- most refusal codes name their own next step;
- responses say which parts are provider text.

No protection was loosened. The changes that would loosen one are listed below for your decision.

**Sign-in and MCP OAuth.**
- Rate limits count the real client address.
- Two-step codes are limited per person.
- Recent-sign-in checks survive workspace switches.
- Challenge caps are per kind.
- Reset and registration no longer reveal through their timing whether an account exists.
- Reviewers can no longer end each other's sessions.
- A replayed authorization code revokes its tokens.
- Expired grants are pruned.
- HSTS, COOP and CORP are set everywhere.
- Reads are audited by size and hash rather than content.
- The administrator and reviewer passwords set on the server use the account-password hashing, are checked without
  blocking the server, and a new one signs out everything the old one opened, MCP access included.

**Website and reporting.**
- Every platform's metrics name the native field and rule behind them.
- Report tables are announced by campaign and show their time zone.
- Dates follow the viewer's locale.
- Destructive actions ask first.
- Errors are page-level.
- Keyboard focus survives re-renders.
- Contrast and reflow meet WCAG 2.1 AA on every audited page (60 → 0 texts below 4.5:1 in batch 19).
- The design tokens are defined once, in `web/tokens.css`.
- Arabic or Hebrew campaign names and ad copy read right to left in fields and tables.
- MFA setup is guided.
- Assets are compressed and revalidated.

**Media and creative push.** Media no longer needs Google Drive. On the Media library page, *Push a creative* takes a
file (or a public link), shows what each chosen account will receive, and after one confirmation uploads it to each
account in turn, reporting each result. With *fit to each platform* on, anything larger than 1080 × 1920 is scaled
down without cropping (4500 × 4500 → 1080 × 1080, 4500 × 8000 → 1080 × 1920), an image over a platform's size limit
is re-encoded, and MOV becomes MP4 for X and LinkedIn. Phone photos keep their orientation. Every change is listed in
the review. MCP clients get the same through `amcp_media` (`source_id`, `source_url`, `fit_to_platform`, `plan`).
Links are fetched only from public internet addresses. *Preview your ads* (and `amcp_ad_previews`) gathers each
platform's own preview links for existing ads on Meta, TikTok, Snapchat, LinkedIn and Reddit, and names the reviewed
call that creates a Google Ads shareable preview.

**Google Ads v25.** AMCP now sends Google Ads requests at v25, checked against the pinned v25 contract, well before
v23's 2027-02 sunset. Every contract was compared with v25 rather than assumed: seven action names whose operation v25
removed (lifecycle goals, campaign-level video brand safety) are refused and name what to use instead, shareable
previews use the new request shape, and two server paths that had kept `/v23/` (account discovery and
re-authorisation, which would have failed at the sunset) are fixed. Action names keep their `google_ads_v23_…`
spelling. The [migration record](../implementation/GOOGLE-ADS-V25-2026-09-28.md) lists every difference found.

**Meta v26.0.** Meta requests now go to Graph API v26.0. Meta's reference pages are blocked here, so the evidence is
Meta's official SDK (generated from Meta's API specification): compared release to release, v26.0 removes nothing
AMCP sends, and every catalog request that can be compared (419 of 591) still exists. If v26.0 misbehaves in
production, `AMCP_META_API_VERSION=v25.0` moves every Meta request back without a code change
([migration record](../implementation/META-V26-2026-09-28.md)).

**Provider changes and end dates.** A live comparison of every pinned vendor document found four that Google had
changed within their versions. Each difference was reviewed and the documents re-pinned: a DV360 YouTube bid
multiplier became writable and now needs a spend confirmation, and GA4 began saying when it truncated a report, so a
truncated GA4 report is now partial and says why ([the review](../implementation/SCHEMA-DRIFT-2026-09-28.md)). A
registry records when each version AMCP sends stops working. It is checked against the versions AMCP sends, so an
upgrade must update it. The weekly provider workflow fails 90 days before a recorded end date. Criteo 2026-01 reaches
that point in early October 2026 (its 12-month support ends around January 2027); most other dates could not be read
from here and are recorded as unknown.

**MCP workflow.** Each AMCP tool says when to use it rather than its neighbour. An opt-in flag
(`MIRROR_FLAGS={"compactSchemas":true}`) removes the duplicated DV360 action names from every `tools/list`. A client
that has read a platform's contract once can ask `amcp_write` for a reference to it (`evidence: "ref"`) instead of the
whole contract in every inspect and prepare; `amcp_campaign` does so for each step it prepares.

**Structure and code quality.**
- 57 reviewed write families are declared next to their code and reached through a typed registry, instead of about
  ten hand edits per family across ten lifecycle files. The move was proven equivalent by replaying 40,624 recorded
  calls from the old build with 0 differences.
- The code is formatted with Prettier, in format-only commits, each proven by syntax-tree equality.
- The state reads of the families with their own readers go through one guarded reader in the review and one in
  the verification, instead of 31 hand-written copies (one of which skipped a scope check).
- 32 unused declarations were removed, and the compiler now refuses new ones.
- All 22 pinned vendor documents are sealed with a digest.
- The test suite runs in parallel.
- `npm run test:related` runs only the affected suites.
- `docs/ADDING-A-REVIEWED-FAMILY.md` explains how to add a family.
- `docs/README.md` maps every guide, review and implementation record, and `docs/CONTRACTS.md` lists each gateway's
  argument names. Both are generated and checked, so neither can fall behind.

## Measurements

| Measure | Before (`03ac8d3`) | Now |
|---|---|---|
| Tests (full qualification) | 2,654 | 2,779 |
| Full qualification time, 4 CPUs | 1,478 s (serial) | about 530 s; the test suite alone 244 s since batch 22 |
| Lifecycle wiring for reviewed families | ~14 order-sensitive chains; reader nesting 83 (review) and 80 (verification) levels | 57 families registered; 1,044 wiring lines removed; reader nesting 26 and 23 |
| Refusal sites falling back to a generic "prepare again" | 1,436 of 1,956 | 379 |
| DV360 schema in `tools/list` | 17.5 KB | 10.6 KB with `compactSchemas` |
| A Meta campaign `prepare` result / a three-step campaign run once its first step is prepared | 7.2 KB / 9.3 KB | 2.7 KB with `evidence: "ref"` / 4.8 KB, and 4.5 KB less for each further prepared step |
| Website text assets per full download | 308 KB | 82 KB (Brotli) |
| Low-contrast texts over 50 page/width checks | 271 | 0 |
| Pages that overflow at 320–360 px / whole-page live regions | 3 / 47 | 0 / 0 |
| Focus ring contrast | 2.78:1 | 7.06:1 |
| Source lines over 300 characters (`src/`) | 1,640 | 61, all string literals |
| Pinned vendor documents with a digest | 7 of 22 | 22 of 22 |
| Cold start / memory (`createRuntime()`) | 1.1 s / 197 MB | 0.4 s / 146 MB; the HTTP server ready in 0.9 s, the MCP stdio server answering in 0.5 s |
| Ways to bring media into AMCP | Google Drive only | Drive, a website upload or any public HTTPS link; one upload pushed to up to 20 accounts |

## Decisions

Each of these changes a level of protection, a deployment, a dependency or the product. The owner answered them on
2026-09-28.

| Decision | Owner's answer | Where it stands |
|---|---|---|
| Unit-aware spending caps, a bid ceiling, a policy when an account is first connected (F-04, F-57) | Yes, but a cap must ask or inform, not fail | Done in batch 11: `enforcement: confirm` by default (`block` optional), `cap_override_confirmed`, per-platform caps in account currency where the unit is documented, `max_bid_native`; unprotected accounts are shown to the owner, not given invented amounts |
| Out-of-band approval for spend and activation | No | Not implemented |
| Spend confirmation on field names only | Yes | Done in batch 11 |
| Idle timeout and security-change emails (F-25) | Yes | Done in batch 11 |
| Encrypted-only backups and purge on disconnect (F-18) | Yes | Done in batch 11 |
| Provider upgrades: Google Ads v25 first, then LinkedIn and Meta, then Criteo (F-49 … F-53) | Yes | Google Ads v25 done in batch 14 and Meta v26.0 in batch 15 (from Meta's official SDK). LinkedIn and Criteo wait on their documentation, which this environment's network policy blocks. The Criteo work is scoped: the report family must move to the new 2026-07 reports |
| Invitations while sign-up is closed (F-15) | Keep them pending | Done in batch 11 |
| A vendored QR encoder for two-step setup | Yes | Done in batch 11 |
| Production settings `MIRROR_FLAGS` and `AMCP_TRUSTED_PROXY_CIDRS` | Yes | Documented in `docs/DEPLOY-RAILWAY.md`; setting them needs Railway access, which this review does not have |
| Let AMCP run the ownership read itself when the provider's record states the owning account | Not asked yet | Open |

## Still open, not waiting on you

- Registry: the Snapchat families, Criteo catalog and overrides, DV360 SDF and TikTok negative keywords, each needing
  one more registry hook.
- Contracts and operations: the end dates this environment could not read (Google Ads v25, Meta, LinkedIn and the
  others recorded as unknown).
- Website: target sizes of small inline links (a WCAG 2.2 criterion); folding the one-off tints into tokens.

## Limits

- Every test uses local mocks or frozen evidence. No advertising account, provider application, credential, OAuth
  grant, deployment, Railway setting or DNS record was touched, and no email or message was sent.
- Production acceptance still needs a live OAuth round trip per provider and a restore test of a real backup.

## How to verify

```sh
node tools/prepare-public-release.mjs .release/check
cd .release/check && npm ci && AMCP_REQUIRE_FFMPEG=true npm run check && node deploy/check-railway.mjs
```
