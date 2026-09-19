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
| GA4, GTM, Business Profile and Search Console gaps | Pending | Granular administrative authority and documented local/OAuth routing. |
| Adjust, Commerce, Amazon and other unmapped actions | Pending | Establish actual provider product and executable contracts; do not invent missing specifications. |
| Full regression, fresh sanitized release and branch push | Local check passed; push pending | Fresh release: 700 tests passed, one FFmpeg test skipped, four capture tests passed; generation, guidance, web, provider integrity and Railway compatibility checks passed. Container smoke checks require Docker. |

Live advertising mutations, permission changes, production deployment and real
customer-data uploads are outside this implementation authorization. They are
qualification dependencies, not a reason to omit locally implementable code.

## Current checkpoint (2026-09-19)

The working tree now inventories **3,241 actions**, including **301 reviewed-family
rows**. **1,016 mapped writes, 107 unmapped actions, 50 unqualified reads and eight
input-dependent adapters remain incomplete**. This batch adds 68 reviewed action
rows: 50 previously blocked mapped actions and 18 newly mapped Apple actions.
The separate vendor denominator grows to **1,208 methods, 454 without a mapped
action** because all 99 official Apple SDK methods are now included. This is an
expanded denominator, not a regression hidden by removing unsupported methods.

Focused verification: 70 tests passed (new provider lifecycles, coverage artifacts
and guidance). Full sanitized release check passed; branch push is next.
See `CONTRACT-COMPLETION-2026-09-19.md` for commands, first failures and scope limits.
