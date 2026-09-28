# Review summary for the owner

Review of AMCP started 2026-09-28 from `03ac8d3`, on branch `Codex-branch`. The detailed records are in this
folder: [FINDINGS.md](FINDINGS.md) (72 findings with severity and status), [THREAT-MODEL.md](THREAT-MODEL.md),
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

**Website and reporting.**
- Every platform's metrics name the native field and rule behind them.
- Report tables are announced by campaign and show their time zone.
- Dates follow the viewer's locale.
- Destructive actions ask first.
- Errors are page-level.
- Keyboard focus survives re-renders.
- Contrast and reflow meet WCAG 2.1 AA except for the items listed in ACCESSIBILITY.md.
- MFA setup is guided.
- Assets are compressed and revalidated.

**MCP workflow.** Each AMCP tool says when to use it rather than its neighbour. An opt-in flag
(`MIRROR_FLAGS={"compactSchemas":true}`) removes the duplicated DV360 action names from every `tools/list`.

**Structure and code quality.**
- 57 reviewed write families are declared next to their code and reached through a typed registry, instead of about
  ten hand edits per family across ten lifecycle files. The move was proven equivalent by replaying 40,624 recorded
  calls from the old build with 0 differences.
- The code is formatted with Prettier, in format-only commits, each proven by syntax-tree equality.
- 32 unused declarations were removed, and the compiler now refuses new ones.
- All 22 pinned vendor documents are sealed with a digest.
- The test suite runs in parallel.
- `npm run test:related` runs only the affected suites.
- `docs/ADDING-A-REVIEWED-FAMILY.md` explains how to add a family.

## Measurements

| Measure | Before (`03ac8d3`) | Now |
|---|---|---|
| Tests (full qualification) | 2,654 | 2,720 |
| Full qualification time, 4 CPUs | 1,478 s (serial) | 511 s |
| Lifecycle wiring for reviewed families | ~14 order-sensitive chains; reader nesting 83 (review) and 80 (verification) levels | 57 families registered; 1,044 wiring lines removed; reader nesting 26 and 23 |
| Refusal sites falling back to a generic "prepare again" | 1,436 of 1,956 | 379 |
| DV360 schema in `tools/list` | 17.5 KB | 10.6 KB with `compactSchemas` |
| Website text assets per full download | 308 KB | 82 KB (Brotli) |
| Low-contrast texts over 50 page/width checks | 271 | 60, and the report table fixed since |
| Pages that overflow at 320–360 px / whole-page live regions | 3 / 47 | 0 / 0 |
| Focus ring contrast | 2.78:1 | 7.06:1 |
| Source lines over 300 characters (`src/`) | 1,640 | 61, all string literals |
| Pinned vendor documents with a digest | 7 of 22 | 22 of 22 |
| Cold start / memory | 1.1 s / 197 MB | unchanged (F-64 is planned) |

## Decisions that are yours

Each of these changes a level of protection, a deployment, a dependency or the product. Nothing here was done without
your yes.

| Decision | Recommendation |
|---|---|
| Unit-aware workspace default spending caps, and a default policy when an account is first connected (F-04) | Yes: caps per gateway in canonical units, refused where no unit mapping exists |
| An optional bid ceiling per account (F-57) | Yes, as an opt-in `max_bid_native` |
| Out-of-band approval for spend and activation | Yes: MCP elicitation where the client supports it, otherwise a website approval bound to the review's state hash |
| Match spend confirmation on field names only (drop the value-text match) | Yes, now that the structural rule covers value-only cases. This removes some confirmations, so it waits for you |
| Let AMCP run the ownership read itself when the provider's record states the owning account | Yes for Meta and Snapchat objects that report their account |
| Invitations while sign-up is closed (F-15) | Invited accounts stay pending unless the instance owner invited them |
| Idle timeout and security-change alert emails (F-25) | A 2-hour sliding idle timeout inside the 8-hour limit; alerts on password, email and two-step changes |
| Encrypted-only backups and purge on disconnect (F-18) | Yes; keep the key in the secret manager and test a restore first |
| Provider upgrades: Google Ads v23 → v25 (v23 sunsets 2027-02), Microsoft REST evidence, Criteo 2026-07, Meta v26, LinkedIn 202609 (F-49 … F-53) | Google Ads first, then LinkedIn and Meta, then Criteo |
| A vendored QR encoder for MFA setup | Yes, a small audited encoder served from `/assets` (the CSP allows only same-origin scripts) |
| Production settings: `AMCP_TRUSTED_PROXY_CIDRS` for Railway's proxy (F-08); `MIRROR_FLAGS={"compactSchemas":true}` | Set both after checking the proxy's address range |

## Still open, not waiting on you

- Registry: the Snapchat families, Criteo catalog and overrides, DV360 SDF and TikTok negative keywords, each needing
  one more registry hook.
- Architecture: one guarded-reader helper (F-61); splitting `write-review.ts` into stages.
- Code: formatting `web/`.
- Auth: legacy administrator password hashing (F-16).
- Contracts and operations: drift digests for every provider and a sunset alarm (F-56); lazy loading of generated
  routes (F-64).
- Website: one token file for the design (F-40); right-to-left layout (F-47); the remaining 60 low-contrast labels.

## Limits

- Every test uses local mocks or frozen evidence. No advertising account, provider application, credential, OAuth
  grant, deployment, Railway setting or DNS record was touched, and no email or message was sent.
- Production acceptance still needs a live OAuth round trip per provider and a restore test of a real backup.

## How to verify

```sh
node tools/prepare-public-release.mjs .release/check
cd .release/check && npm ci && AMCP_REQUIRE_FFMPEG=true npm run check && node deploy/check-railway.mjs
```
