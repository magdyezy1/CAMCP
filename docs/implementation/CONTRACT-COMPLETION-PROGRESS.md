# Provider action implementation progress

Started 2026-09-19 from `d7f3fad8f4fc499123e6be71f4d0d11408befcd4` on
`Codex-branch`. The development checkout and `.release/AMCP` are separate and
remain untouched. Implementation and pushes are restricted to `Codex-branch`.

The starting ledger contains 3,223 actions: 1,066 mapped writes without reviewed
contracts, 107 unmapped actions, 50 unqualified reads, and eight input-dependent
legacy adapters. The existing 233 write-family rows do not prove every payload
variant or a live provider workflow. The 1,109 pinned vendor methods separately
include 396 without mapped actions. No denominator is silently discarded.

## Acceptance for each operation

- Current official request, response and resource identity evidence.
- Exact selected connection/account and referenced-resource scope before egress.
- Qualified shape, immutable fields, prerequisites and business effects.
- Complete configuration snapshots with telemetry excluded after envelope checks.
- Frozen review, current grants, spending/deletion/activation controls and durable claim.
- Success/partial-failure receipts, exact configuration read-back, and recovery that
  cannot repeat an uncertain mutation.
- Positive lifecycle fixtures plus malformed, cross-account, revoked, concurrent,
  partial and lost-response cases as applicable; examples remain executable.
- Generated action and vendor inventories updated without enabling writes through
  catalog metadata. Synthetic and live evidence remain separate.

## Work ledger

| Work | Status | Evidence / next step |
|---|---|---|
| Recheck checkout, remote and initial action denominator | Complete | Clean branch at the base revision; remote main remains `067871481d79fc59a6cb976d8a13b62d409e283a`. Baseline artifact saved locally under `.runtime/contract-completion-20260919/`. |
| Google configuration and association resources | Implemented; local lifecycle tests pass | 16 explicitly declared resources, 32 additional reviewed action rows. Exact references, meaningful state comparisons, mutation receipts and read-back. Historical immutable UPDATE aliases remain blocked. |
| Remaining Google jobs, recommendations, billing, customer data and permissions | Pending | Separate effects, authorization, batch/async receipts and recovery contracts; no universal mutate exemption. |
| Microsoft library/media and remaining service methods | Pending | Exact JSON contracts and polymorphic schemas; WSDL method matches alone are insufficient. |
| Apple child resources and shared budgets | Implemented; local lifecycle tests pass | 18 new native actions. SDK type facts, parent scoping, org/account union authorization, per-account spending policies and read-back. 99 SDK methods are now independently inventoried; 58 remain unmapped. |
| Meta, TikTok, Snapchat, LinkedIn and X remaining operation families | Pending | Exact account/identity binding and lifecycle contracts per family. |
| DV360 advertiser-owned channels, negative-keyword lists and location lists | Implemented; local lifecycle tests pass | 18 additional reviewed actions. Complete bounded membership pagination, scoped receipts, replacement/deletion policy, set verification and uncertain-outcome retention. Partner-owned variants remain blocked. |
| Reddit, remaining DV360 and Criteo families | Pending | Resource identity, targeting, asynchronous/bulk and budget safeguards. |
| GTM reverts, variables, folders, versions, gallery and administrative workflows | Implemented; focused tests pass | 20 additional reviewed actions; administrator role/scopes, complete permission membership, last-admin checks, hashed environment codes and exact read-back. Four officially withdrawn routes retained separately. |
| GTM bulk update, synchronization, quick preview and conflict resolution | Implemented; focused tests pass | All ten Entity kinds, bounded complete workspace/base-version snapshots, unordered bulk receipts, entity fingerprints, explicit clearing, partial sync conflicts and temporary preview verification. Four additional reviewed rows. |
| GTM configuration audit and verification job status | Implemented; full release checks pass | Two formerly unmapped local operations. Read-only scoped discovery and diagnostics; job polling checks tenant, actor, provider and current connection/account access. |
| GA4, Business Profile and Search Console gaps | Pending | Granular administrative authority and documented local/OAuth routing. |
| Adjust, Commerce, Amazon and other unmapped actions | Pending | Establish actual provider product and executable contracts; do not invent missing specifications. |
| First full regression and branch push | Complete locally; pushed | `95b85ff` pushed to `Codex-branch`. Fresh release: 700 tests passed, one FFmpeg test skipped, four capture tests passed; generation, guidance, web, provider integrity and Railway compatibility checks passed. Container smoke checks require Docker. |

Live advertising mutations, permission changes, production deployment and real
customer-data uploads are outside this implementation authorization. They are
qualification dependencies, not a reason to omit locally implementable code.

## Current checkpoint (2026-09-19)

The working tree now inventories **3,241 actions**, including **325 reviewed-family
rows**. **989 mapped writes, 105 unmapped actions, 50 unqualified reads and eight
input-dependent adapters remain incomplete**. Four routes are now explicitly
**provider_unsupported**, including three previously blocked writes and one read;
these are not counted as implemented. The first batch added 68 reviewed action
rows (50 previously blocked mapped actions and 18 newly mapped Apple actions);
the current GTM batch adds 24 more. Tag Manager has 64 reviewed-family rows,
38 native reads, four withdrawn methods and two implemented local diagnostics.
No GTM catalog row remains unmapped or blocked solely by absence of a family;
exact payload restrictions, external permissions and live qualification still apply.
The separate vendor denominator grows to **1,208 methods, 454 without a mapped
action** because all 99 official Apple SDK methods are now included. This is an
expanded denominator, not a regression hidden by removing unsupported methods.

First batch: focused 70 passed and full sanitized release check passed, then pushed.
GTM batch: 61 initial focused/new/existing measurement tests passed; then 57 tests
for both new GTM families, withdrawn routes and executable guidance passed. The
first full candidate reported a URL-spelling test failure and retained a listener;
its isolated run and 16 diagnostic reruns passed. A full rerun completed and caught
a missing guide-family example (731 passed, one failed, one FFmpeg skip). Added
both required family examples without weakening coverage. Fresh release validation
and push are pending. Initial failure logs are retained, not replaced by retries.
Candidate C passed 753 tests and four capture tests (one FFmpeg skip), then failed
the documentation-refusal check for VERIFICATION_UNSUPPORTED. Its recovery behavior
is now documented. Candidate D completed the entire check command successfully:
762 tests passed, zero failed, one FFmpeg skip, plus four capture tests passed.
The diagnostic and workspace authorization fixtures exercise actual revocation.
See `CONTRACT-COMPLETION-2026-09-19.md` for commands, first failures and scope limits.
