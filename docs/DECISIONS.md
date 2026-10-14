# Decisions

The maintained record of owner decisions and of what happened to earlier recommendations (DOC-02). Each row names the
date, the decision, its outcome (accepted, declined or deferred), what would reopen it, and the canonical ID it
governs. A decision changes only the stage it names: it never marks a package complete. Package status is reported on
three axes in [package status](review/PACKAGE-STATUS.md). Settled decisions, such as the declined out-of-band spend
approval, are recorded rather than reopened.

Canonical IDs: `D`, `R` and `P` are the owner questions of the 2026-10-08 engineering review; three-letter IDs
(`OPS-04`) are its register items; `B01`–`B32` are packages.

## 2026-10-09: engineering review decisions D1–D27

The owner chose the recommended option for every decision in section 1 of the review handoff. Where a decision needs
dashboard or provider access (Railway, Cloudflare, backups), it is accepted here and stays an owner action; the code,
configuration and documentation are prepared in the repository. Where a decision offers a choice without a
recommendation, that part is recorded as **pending owner**.

| ID | Decision | Outcome (recommended option) | Applied | Revisit trigger | Governs |
|---|---|---|---|---|---|
| D1 | Railway settings and build evidence | Accepted. Record the healthcheck path and timeout, restart policy and retries, replicas, draining seconds, watch paths, Wait-for-CI and trigger branch; confirm the dashboard does not override `railway.json`; export the build log and image digest for `60ec2cc`; state the build timeout, deploy cadence and downtime window. | Owner action (read-only dashboard), before 2026-11-15 | Railway's Config-as-Code cutoff, 2026-12-01 | OPS-05, ACC-04, OPS-07, QA-01 |
| D2 | Cloudflare analytics beacon | Accepted: disable automatic Web Analytics injection. | Owner action in Cloudflare; the CSP stays unchanged | Analytics wanted: allow the beacon in the CSP and disclose it in both privacy pages first | OPS-05, WEB-04, WEB-02 |
| D3 | Product audience, registration and legal identity | Accepted (a): AMCP is a private agency tool, so registration closes and the calls to action become "Request access / Sign in". The owner supplies the operator legal identity, jurisdiction, effective date, Terms wording and security contact. Pending before the push that publishes them: `web/terms*.html` carries engineering-drafted wording and an effective date of 9 October 2026, and `security.txt` an `Expires` of 2027-04-01 (`AMCP_SECURITY_TXT_EXPIRES`); the owner approves or replaces both and sets `AMCP_SECURITY_CONTACT`. | WEB-02 code; the identity is owner-supplied | Public sign-up wanted: configure a transactional email provider | WEB-02, SEC-05, DOC-03, SEC-06, SEC-08 |
| D4 | Backups and restore | Accepted: enable Railway scheduled volume backups, keep an off-host copy, and run one restore drill with a measured recovery time. | OPS-04: single-step backups, space and volume preflight, `backup-drill`, the restore-drill runbook in [operations](OPERATIONS.md#restore-drill). Enabling backups and the drill are owner actions. | Each storage or release change | OPS-04, SEC-07, OPS-01 |
| D5 | Client-address profile for rate limits | Accepted: after release set `AMCP_CLIENT_IP_SOURCE=railway+cloudflare`; the source ships with the `socket` default. | SEC-01; the variable is an owner deployment change | Railway or Cloudflare topology change | SEC-01, SEC-03 |
| D6 | `/mcp` batches and per-key limits | Accepted: reject JSON-RPC arrays (`AMCP_MCP_BATCH_MAX=1`); start at 60 requests/min, burst 20, 4 in flight per actor, tunable from `RATE_LIMITED` counts. | SEC-02 | `RATE_LIMITED` counts from real clients | SEC-02 |
| D7 | What owner spending caps count | Accepted: count lifetime `spend_cap` (Meta, Reddit) and custom-period totals against an optional `max_total_budget_native`, and always allow decreases. | WRT-01 Stage C | A provider adds another total-budget form | WRT-01, WRT-07 |
| D8 | How far the deletion switch reaches | Accepted: `allow_deletion:false` also governs feed-driven deletion, evaluated against the current feed state; no extra TikTok DELETE confirmation flag. | WRT-02 Stage C | A new deletion path | WRT-02, WRT-05 |
| D9 | Spend-policy saves from AI clients | Accepted: `expected_revision` is optional for MCP callers, with a warning when omitted; the website always sends it. | WRT-03 | MCP clients send it consistently | WRT-03 |
| D10 | Rounding of fractional provider values | Accepted: nine decimal places, round half to even, recorded in evidence. | RPT-01, DEC-01 | A provider documents more precision | RPT-01, DEC-01 |
| D11 | Unconfirmed Google Sheets deliveries | Accepted: resend the identical batch only after a settle window of at least 10 minutes, plus an audited "release tab" action; never publish an older snapshot over a newer one, export to a new tab instead. Whether the resend runs automatically or after operator confirmation has no recommendation: pending owner. Implemented default (wave 1, recorded 2026-10-10): the export job resends the identical batch of the same report automatically after the settle window (audited as `authorized_by: settle_window`); `AMCP_SHEETS_AUTO_RESEND=off` makes it operator-confirmed only. | EXP-01 step 3, EXP-03, ACC-03 | ACC-03 live delivery results | EXP-01, EXP-03, ACC-03 |
| D12 | Release of claims after early refusals | Accepted: refusals provably raised before any provider request release the idempotency claim and the daily spend reservation; for CMP-04, a `rejected` outcome releases the reservation only for families with a declared non-applied proof. | WRT-04, CMP-04 | A family without non-applied proof | WRT-04, CMP-04 |
| D13 | Daylight-saving gaps | Accepted: shift a nonexistent local time forward to the first valid time. | EXP-02 (the codifying test is rewritten there) | — | EXP-02 |
| D14 | Must-pass AI clients and response budget | Accepted: the must-pass clients are the Claude.ai/Desktop connector, Claude Code, ChatGPT, Codex, Cursor and VS Code; default views are designed under the 10k-token warning (15 KB summary capabilities, a 25,000-character dashboard). Who runs the evaluation sessions: pending owner. | MCP-01, ACC-02, QA-04 | A client changes its budget | MCP-01, ACC-02, QA-04, MCP-03 |
| D15 | Listing goals and tool shape | Accepted: decide on a directory listing first (pending owner); keep one write tool until ACC-02 shows which clients honor the prompt; in read-only deployments list `amcp_write` with `inspect` only. | MCP-06, MCP-09 | A listing requirement or ACC-02 results | MCP-06, MCP-09 |
| D16 | AI-client authorization and identity | Accepted: (1) a 30–60 s refresh-token reuse window with family revocation; (2) operators and viewers connect their own AI clients, scope capped by role; (3) keep the recorded write-by-default consent once a read-only choice exists; (4) person-scoped uploads, originals, plans and variants follow the person across the website and their AI clients. | MCP-08, MCP-02, MED-03 | — | MCP-08, MCP-02, MED-03 |
| D17 | Captured-catalog parity | Accepted: keep the captured schema byte-identical, route first-party help through special cases, keep the captured catalog frozen as the compatibility denominator, declare withheld raw captures as withheld, and annotate unmapped captured operations `CAPABILITY_UNAVAILABLE` rather than hiding them. Which Adjust operations become optional stretch: pending owner. | MCP-05, MCP-10, ARC-03 | — | MCP-05, MCP-10, ARC-03 |
| D18 | Effects allowed in read-only mode | Accepted: `validate_provider` runs only through an explicit owner opt-in, audited before send; provider report and export jobs become a quota-bounded `provider_job` effect under an owner switch; no provider-side report jobs under read-only acceptance until RPT-06 lands. | WRT-06, RPT-06, ACC-06 | RPT-06 lands | WRT-06, RPT-06, ACC-06 |
| D19 | Provider login lifecycle | Accepted: (1) a renewal by a different provider identity is refused where the identity is available; (2) every write-grant change needs confirmation and audit; (3) the pre-checked "read + reviewed write" selection on new connections is intended (recorded decision); (4) offer provider-side revocation on disconnect as an option, after checking the effect on other Google logins sharing the OAuth client; (5) request Reddit `adsedit` only when writes are enabled. | CON-02, CON-05 | — | CON-02, CON-05 |
| D20 | Conditional-program observations | Accepted: retain them as timestamped "not a grant" records with a time-to-live, purged on disconnect. | CON-04 | — | CON-04, ACC-05, ACC-08 |
| D21 | Error detail on the website | Accepted: show the sanitized provider status and request ID, never tokens or bodies. | WEB-03, PRV-02 | — | WEB-03, PRV-02 |
| D22 | Operations attention feed | Accepted: include uncertain standalone writes, failed monitor emails and reauthorization-required connections. | OPS-06 | — | OPS-06 |
| D23 | Media timing and capacity | Accepted: (1) release an idle website upload earlier than 30 minutes, never later; (2) saved plans may reference 30-minute uploads only with a visible deadline; (3) a per-tenant share of global media capacity (for example at most 4 of 8 slots) after retry-on-contention; (4) Drive imports are frozen copies and show "Drive access since revoked"; (5) planned push rows may re-bind to an identical re-upload (same SHA-256). | MED-01, MED-02, MED-03, MED-05 | Measured media contention | MED-01, MED-02, MED-03, MED-05 |
| D24 | SQLite secure delete | Accepted: keep `secure_delete=ON` and fix the amplification another way. | OPS-01, OPS-02 | — | OPS-01, OPS-02 |
| D25 | Package closure and release records | Accepted: (1) the three-axis status (source, native/live, manual); (2) open-ended remainders become finite packages B29+ or optional stretch; (3) a disposition for each dropped commitment (below); (4) B16 stays a standing per-release gate, with the hosted-CI waiver recorded as an acceptance amendment; (5) B20 raw tracing moves to the conditional package B32. For QA-01: pruning ad hoc `.release` candidates is approved as owner-run from a dry-run list; `NOTICE.md` and `.gitattributes` ship; qualification records stay local. The license has no recommendation: pending owner (no license file until chosen). | DOC-02: [package status](review/PACKAGE-STATUS.md) from `review/package-status.json`, this record; QA-01 records and prune dry-run | Owner disagrees with a count or disposition | DOC-02, DOC-01, QA-01 |
| D26 | Test tooling | Accepted: the browser fixture may accept its own synthetic mutations; an architecture ratchet that blocks only regressions joins `npm run check`. Dev-only property/mutation dependencies versus hand-rolled equivalents, and the qualification runtime budget: pending owner. Implemented defaults (wave 2, recorded 2026-10-11): hand-rolled equivalents, no new dependency (`tools/mutants.mjs`, the IANA zone and decimal sweeps, QA-02); the browser fixture accepts only its own declared synthetic mutations (QA-03); the qualification runtime budget is a proposed 75 minutes, `AMCP_QA_RUNTIME_BUDGET_MINUTES` sets another (QA-03). The architecture ratchet waits for ARC-04. | QA-02, QA-03, ARC-04 | — | QA-02, QA-03, ARC-04 |
| D27 | Arabic presentation and page names | Accepted: keep Latin digits and one date style per context; keep the partial-Arabic label until B24 acceptance passes; generate the canonical page names from one registry. Whether audit, session and token times show a time zone, which name set is canonical (navigation labels or page titles), and fixing or removing the test-account Clients & templates tab: pending owner. Implemented defaults (wave 2, recorded 2026-10-11): `web/routes.js` makes the navigation labels canonical, with former names as palette aliases in English and Arabic, and Clients & templates is fixed for test accounts (it opens and saves playbooks from the `amcp_workspace profiles` response) (WEB-06). The time-zone question stays open. | WEB-05, WEB-06, DOC-03 | B24 acceptance | WEB-05, WEB-06, DOC-03 |

Also applied on 2026-10-09 (P10, provider lifecycle): the lifecycle alarms run locally inside the qualification
runner (PRV-04), and the Meta v25.0 rollback has its own sunset entry to be dated once Meta publishes the Marketing
API end. The TikTok manual check is recorded with the workspace owner as owner and a 30-day cadence; naming a person
is pending owner.

Also applied on 2026-10-09 (P4, personal data, its recommended part only): reads that return submitted leads (the
TikTok lead reads) are personal data and are refused before any provider request (SEC-04,
[personal-data policy](review/PERSONAL-DATA-POLICY.md)). P4 names no recommendation for viewer report downloads: SEC-05
enforces the documented role matrix with an owner Settings toggle that is off by default, which is never less safe than
before; whether viewers may download stays the owner's choice. P4's other questions (rehearsals that transmit hashed
personal data, a user-scoped `amcp_test_id` GA4 dimension) are not decided.

Also applied on 2026-10-12 (MSR-04, P4's user-scoped dimension question as approved on 2026-10-11): a user-scoped
`amcp_test_id` GA4 custom dimension is used only on a property the workspace owner explicitly marks as a test property
(`amcp_workspace save_ga4_test_property`, owner only, audited, nothing changes in GA4). Only then does
`measurement_event_identity` accept `mode:"realtime_user_scope"`; unmarking refuses it at once. The owner registers the
dimension in GA4 themselves, and the value persists on the synthetic test user. Marking stays MCP-only, like the
personal-data switch.

Also applied on 2026-10-13 (PRV-07, accepted under the owner's instruction to implement every ticket; chosen during
implementation, owner may revise): the optional native reads ship read-only and bounded. Google Ads change history
never requests `user_email` (omitted rather than hashed, so no person is identifiable), and the website shows it on
Live portfolio. Reddit account history drops member IDs, usernames, e-mails and full names before any response
leaves the service and refuses `member_ids` filters. Apple's change history is not added, because the pinned SDK has
no model to project the people out. Apple app lookup and eligibility are planning reads the campaign guide uses
before a campaign is prepared; the reviewed campaign write does not freeze them as state, because the pinned SDK has
no eligibility response model to verify. The organic/paid overlap is MCP-only, labelled approximate and feeds only
the existing reviewed keyword and negative-keyword paths (paid rows name their `search_term_view` ids). The Reddit Conversions API stays a later, separate step under
the personal-data policy; the Apple legacy-origin and `orgId` cleanup stays with PRV-04's dated table.

Also applied on 2026-10-10 (CON-06, the Business Profile and Amazon Ads parts of P9, with the review's proposed
defaults; the owner may still choose otherwise): Business Profile is a website platform for workspace owners, shipped
behind `AMCP_GBP_API_APPROVED=true` (or a dedicated `AMCP_GBP_CLIENT_ID`/`AMCP_GBP_CLIENT_SECRET`) because Google's
approval of the Cloud project for the Business Profile APIs (R4) is not declared. Amazon Ads takes option (b):
`amazon_native_action` is not offered (not in `tools/list`, the Capability Center or the Overview; a call is refused
with `GATEWAY_NOT_OFFERED` before anything is read) until a Login with Amazon onboarding exists; `AMCP_PROVIDERS=amazon`
reverses it for an operator-provisioned connection. Option (a), building that onboarding, stays the owner's choice.

Also applied on 2026-10-11 (OPS-08, chosen during implementation; the owner may revise): owner health's provider
quota view shows, beside a workspace's own counts, the deployment-wide daily request, refusal and 429 counts of each
shared provider app (hashed issuer) that workspace used. Every workspace owner therefore sees aggregate activity of
other workspaces on AMCP-owned apps: counts per day only, never a workspace, account or person. Restricting the
totals to the deployment administrator is the alternative if that aggregate is considered sensitive. Pinning the
`node:24-bookworm-slim` base image by digest (OPS-08 step 1) is a deferred owner step: the digest to pin is the
`base_image.digest` of the first Railway build evidence record (ACC-04, `docs/DEPLOY-RAILWAY.md`).

Also applied on 2026-10-11 (SEC-06 and SEC-07, P2 and P3; P2 follows its recommendation, the P3 values were chosen
during implementation and the owner may revise them): the default two-step baseline (`AMCP_REQUIRE_MFA=admins`)
covers owners and administrators of write-enabled workspaces only (a connection grants write access), with the grace
period counted from when a workspace was first seen write-enabled; `everyone` stays the stricter explicit choice.
Sign-ups never approved are erased after 30 days by default (`AMCP_PENDING_ACCOUNT_DAYS`; `off` keeps them), except a
pending account that holds a membership in another workspace; revoked accounts are kept unless the owner sets
`AMCP_REVOKED_ACCOUNT_DAYS`. The release notes must call out the 30-day default, since the first sweep after deploy
erases older pending sign-ups. Erasure keeps the single global audit chain: an erased account's audit rows become
tombstones that `verifyAudit` accepts only with a matching `account_erased` receipt (SEC-07 S4(b) alternative). The
per-tenant HMAC-keyed audit chains S4(b) proposed were not built: they would need a migration of every existing chain
and a key per workspace, while tombstones keep the existing chain verifiable and erase the personal data it held.

Remaining fallback (CON-05, recorded 2026-10-11): a website Google Ads login saved before manager routes were recorded
has no route map, so its requests still use the login customer copied into it at that earlier connect (the
deployment-wide `AMCP_GOOGLE_LOGIN_CUSTOMER_ID` of that time). The next sync of the login records a route for every
account and ends the fallback; after the release, sync each existing Google Ads login once in Connections. A login with
a route map refuses an unmapped account with `GOOGLE_LOGIN_CUSTOMER_UNMAPPED`, and an operator-provisioned login keeps
its own login customer (it is never replaced from the environment).

MCP-03, recorded 2026-10-11: `AMCP_MCP_MODERN_PROTOCOL` stays `off` by default. `next` serves MCP 2026-07-28 at
`/mcp/next` for the ACC-02 client checks; `on` waits for that ACC-02 evidence (each must-pass client connects through
`/mcp/next`). `server/mcp-modern.ts` frames 2026-07-28 by hand and is interim: it is to be replaced by the SDK's v2
`createMcpHandler` once a v2 dependency is approved ([OAuth hardening](OAUTH-HARDENING.md), "Still open"). Accepted
residual: the per-address registration key is one IPv6 /64, so a sender with many addresses can hold the daily
registration limit for up to a day; metadata-document clients and existing connections are unaffected
([threat model](review/THREAT-MODEL.md), T9). OAuth `error_description` sentences from `/authorize`, `/register`,
`/token` and `/revoke` (including the two registration-limit sentences) are protocol output for OAuth clients and
stay English, as the existing OAuth descriptions are; no AMCP page displays them, and an AI client that shows one shows
it as received.

Also applied in waves 1 and 2 (recorded 2026-10-11 at the wave 2 gate; the parts of P5, P6, P7 and P9 that the code
cites as owner decisions, each the review's recommended or the ticket's proposed option; the owner may revise them):

- **P5.** The 5-minute review window stays until the friction baseline is read (WRT-05). A spending cap may carry an
  ISO currency: a cap in another currency than the account's is `POLICY_CURRENCY_MISMATCH` (asked under `confirm`,
  refused under `block`, never converted), and a cap saved without one is compared as before while the owner is
  warned (`POLICY_CURRENCY_UNSET`) (WRT-07). A negative-only Google targeting create needs no spend acknowledgement, and removing an exclusion
  counts as activation (`AMCP_GOOGLE_NARROWING_EXEMPT=false` restores the prompt; WRT-07). Standalone `amcp_write`
  reviews are retained work with a status read and read-only reconciliation (WRT-08). Disclosure only stays
  implemented: the opt-in `destructive_confirmed` tier, owner-only execution of over-cap reviews under `confirm` and
  the WRT-09 approval mode are not decided.
- **P6.** Proposals (1) to (8): rolling windows can resolve per source in the account time zone (opt-in
  `date_range.source_timezone: "account"`), declared-incomplete detail sources keep a snapshot partial and hold its
  recommendations, and GA4 `(not set)` and Search Console top-row coverage are scope limits (RPT-02); recommendations
  are frozen with an as-of label (DEC-01); a Meta action absent from a delivered row counts as 0 with
  `provider_omitted`, and Microsoft totals use the account time zone (RPT-04); daily collection uses natively segmented
  requests (RPT-03); schedule times show the delivery time zone first, then the viewer's (EXP-04). An open snapshot is
  addressable with `?report_id=` under the same authorization as any load (RPT-05). Still open: whether a Sheets
  destination belongs to a report or a client, whether complete-only gates a manual export, after how many failures a
  schedule pauses, whether workbook schedules stay or move into Overview (EXP-04's second phase waits for it), period
  comparison, the decision-grade metric set, the DEC-02 outcome window and causal experiments.
- **P7.** The Microsoft Search pack is labelled "Draft only: set locations in Microsoft before activation", and
  activation without a positive location criterion is refused with `LOCATION_CRITERIA_REQUIRED` until AMCP can read
  location criteria (CMP-03). UTM parameters versus tracking-suffix fields, mandatory conventions, the next launch
  packs and the PRV-06 order are not decided.
- **P9.** A Meta product's populated destination-only attributes are notes (`unsent_fields`); they never put the item
  in the review set as `unknown` (COM-01). The Business Profile and Amazon Ads parts are recorded above.

P8 stays open: the Meta dataset, Search Console and Adjust are not in Measurement, and the measurement ledger has
Google Ads and GA4 adapters only ([product workflows](PRODUCT-WORKFLOWS.md)).

Not decided in this round: the review's resource and authorization requests R1–R8 (test accounts, named reads, a
disposable Sheets destination, declared provider approvals, LinkedIn programs and DV360, reviewers, a staging
environment, the workload profile), the product-direction questions P1, P8, P11 and P12, and the parts of P2–P7 and
P9 that this record does not name as applied. Each register item that needs one of them stays at the stage the review
names, and live acceptance stays read-only until R1 is answered.

## October 2026: earlier owner decisions

| Date | Decision | Outcome | Revisit trigger | Governs |
|---|---|---|---|---|
| 2026-10 | Hosted GitHub Actions waived after the Actions minutes ran out; local qualification continues | Accepted (recorded as a B16 acceptance amendment under D25) | Actions minutes restored | B16, ACC-04 |
| 2026-10 | Shopify, Salla, WooCommerce and Criteo expansion and live acceptance parked ([completion audit](review/COMPLETION-2026-10-07.md)) | Deferred (parked) | The owner unparks a store platform or Criteo | PRK-01, PRK-02 |
| 2026-10 | Live acceptance is read-only: no changes to real advertising accounts | Accepted | Test accounts are designated (R1) | ACC-01, ACC-06 |

## September 2026 decisions

Answered by the owner on 2026-09-28, and "do what is best" on 2026-09-29 (moved from the
[September summary](review/SUMMARY.md#decisions)).

| Date | Decision | Outcome | Where it stands |
|---|---|---|---|
| 2026-09-28 | Unit-aware spending caps, a bid ceiling, a policy when an account is first connected (F-04, F-57) | Accepted: a cap asks or informs, not fails | Batch 11: `enforcement: confirm` by default, `cap_override_confirmed`, per-platform caps, `max_bid_native` |
| 2026-09-28 | Out-of-band approval for spend and activation | Declined | Not implemented; WRT-09 keeps an optional mode |
| 2026-09-28 | Spend confirmation on field names only | Accepted | Batch 11 |
| 2026-09-28 | Idle timeout and security-change emails (F-25) | Accepted | Batch 11 |
| 2026-09-28 | Encrypted-only backups and purge on disconnect (F-18) | Accepted | Batch 11 |
| 2026-09-28 | Provider upgrades: Google Ads v25, then LinkedIn and Meta, then Criteo (F-49 to F-53) | Accepted | Google Ads v25 (batch 14), Meta v26.0 (batch 15), LinkedIn 202609 and Criteo 2026-07 (batch 32) |
| 2026-09-28 | Invitations while sign-up is closed (F-15) | Accepted: keep them pending | Batch 11 |
| 2026-09-28 | A vendored QR encoder for two-step setup | Accepted | Batch 11 |
| 2026-09-28 | Production settings `MIRROR_FLAGS` and `AMCP_TRUSTED_PROXY_CIDRS` | Accepted | Documented; setting them is a Railway action |
| 2026-09-29 | AMCP runs the ownership read itself when the provider's record states the owning account | Accepted | Batch 30 (F-70) |
| 2026-09-29 | All-or-nothing builds through Google's multi-resource mutate | Accepted | Batch 30 (F-108) |
| 2026-09-29 | Paused parents on Snapchat, Meta and TikTok | Accepted | Batch 30 (F-107) |
| 2026-09-29 | `allow_activation: false` still refuses ENABLED children under a paused parent | Accepted (kept) | The refusal says to keep the entity paused or ask the owner |
| 2026-09-29 | List `https://claude.ai` in `AMCP_MCP_ALLOWED_ORIGINS` (F-88) | Deferred | Added only when the refusal log shows it refused |
| 2026-09-29 | A documented provider validation refusal after submission counts as "not applied" | Accepted where the contract proves it | A refused all-or-nothing Google build is amended under a new key (F-109) |
| 2026-09-29 | Who sees `health`, and the mismatch acceptance design (Snapchat S7, S5) | Accepted as built | — |

## Dispositions of earlier recommendations

Every item of the [October review](review/REVIEW-2026-10-01.md) sections 5 and 6.13 and of the
[UX audit](review/product/UX-2026-10-01.md) section 3, and each commitment D25 lists as dropped, has one row.
Recorded 2026-10-09 under D25.

| Source | Recommendation | Disposition | Governs | Revisit trigger |
|---|---|---|---|---|
| Review §5 | Spending-policy changes during admission | Deferred: investigation not run; it belongs with whole-group preflight and same-target serialization | WRT-04 | WRT-04 lands |
| Review §5 | Conversion identifiers in errors (identifier-error matrix: GCLID, GBRAID, WBRAID, transaction and event IDs, phones) | Accepted and run on 2026-10-10 as `tests/identifier-error-matrix.test.mjs`: a provider error echoing them reached the caller and the audit chain; echoes of sent click, transaction and event IDs and E.164 phones are now scrubbed ([personal-data policy](review/PERSONAL-DATA-POLICY.md)) | B01 | A new family that sends identifiers unhashed |
| Review §5 | Malformed successful report responses | Accepted: pinned response contracts per route | PRV-05 | PRV-05 lands |
| Review §5 | Request budgets across calendar periods | Implemented (B11 whole-job request, time and row budgets) | B11 | — |
| Review §5 | Generic report-job retries | Accepted: replay-safe retries in the job runner | OPS-07 | OPS-07 lands |
| Review §5 | Provenance after resumed native collection | Implemented (B11: "resumed lineage is enforced" is its blueprint property) | B11 | A resumed collection's evidence is questioned |
| Review §5 | Health-check concurrency | Accepted: health and diagnostics fidelity | OPS-02 | OPS-02 lands |
| Review §5 | SQLite contention | Accepted: measured scaling; worker health under contention is already documented | OPS-08 | R8 workload answers |
| Review §5 | Sheets response recovery | Accepted | EXP-01 | ACC-03 |
| Review §5 | Current accessibility on the current branch | Accepted | WEB-01, ACC-07 | Each release (B16 gate) |
| Review §6.13 | Visible change preview | Implemented (B05) | B05 | — |
| Review §6.13 | Account readiness checklist | Partly implemented (capability prerequisites); truthful readiness remains | CON-03 | CON-03 lands |
| Review §6.13 | Plan simulator | Partly implemented (B08 current-brief prerequisites); a multi-problem simulator is optional stretch | B08 | Client demand |
| Review §6.13 | Integrated analysis and persistent monitors | Implemented (B19) | B19 | — |
| Review §6.13 | Creative QA workspace | Partly implemented (per-target eligibility and variants, B10); pipeline fidelity remains | MED-04 | MED-04 lands |
| Review §6.13 | Recovery center | Implemented in B13, with the withheld-record count added under DOC-02 | B13 | The production withheld count is not zero |
| Review §6.13 | Client templates and naming checks | Implemented (B14); applying playbook defaults to recipe plans remains | CMP-06 | CMP-06 lands |
| Review §6.13 | Owner-run acceptance kit | Deferred: replaced by owner-authorized zero-spend live acceptance on designated test accounts | ACC-01 | R1 test accounts designated |
| Review §6.13 | Refusal analytics | Deferred: needs the owner's answer on metadata-only counters (R8 question 4) | QA-04 | R8 answered |
| Review §6.13 | Full Arabic UI and theme support | Theme implemented (batch 191); Arabic partial | WEB-05, B24 | B24 acceptance |
| UX §3 | Account readiness and capability evidence | Implemented (capability center, B08); truthful readiness remains | CON-03 | CON-03 lands |
| UX §3 | Whole-plan review and execution | Implemented (B06) | B06 | — |
| UX §3 | Clone an existing campaign | Implemented (B07) | B07 | — |
| UX §3 | Correct a blocked unsubmitted step | Implemented (B07); the website hides it for preflight-blocked plans | CMP-02 | CMP-02 lands |
| UX §3 | Accept observed read-back state | Implemented (B07) | B07 | — |
| UX §3 | Cap acknowledgement under confirm policy | Implemented (F-135, B05) | B05 | — |
| UX §3 | Media inspection, asynchronous execution and durable job progress | Implemented (B04, B10) | B10 | — |
| UX §3 | Media receipt history | Implemented (B10 cursor-bound library paging) | B10 | — |
| UX §3 | Reports/templates/schedules | Implemented (B11, B12) | B11, B12 | — |
| UX §3 | Client profile deletion | Implemented | B14 | — |
| UX §3 | Per-account personal-data control on the website | Deferred: stays MCP-only (`enable_personal_data`) until the personal-data classification decision | P4 | P4 decided |
| UX §3 | Support bundle | Implemented (Operations) | B13 | — |
| D25 list | Success-measure baselines (blueprint) | Implemented locally: step and call baselines in the journey harness (`tests/journeys/baseline.json`, checked by `tools/mcp-eval.mjs`) | QA-04 | MCP-07 lands (re-baseline) |
| D25 list | B10's integrated cross-provider usage view | Replaced by per-asset provider readers (Meta, Google image, Snapchat); further adapters are optional stretch | B10, MED-04 | Client demand |
| D25 list | B13's "complete audit telemetry" | Replaced by a finite list: withheld workbook records by reason (owner health) and feed and job failure counts by code | B13, OPS-02 | — |
| D25 list | B15's "measured" fewer unnecessary calls | Partly implemented: measured by the journey and MCP evaluation harness; the local baseline exists, external-client sessions (D14) remain | QA-04, ACC-02 | External sessions recorded |
| D25 list | Separate concise entry points for owners, engineers and MCP clients | Accepted: tiered documentation and an owner guide | DOC-03 | DOC-03 lands |
