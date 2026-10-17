# Adding a reviewed write family

A reviewed write family is the unit AMCP uses to let an agent change something at a provider safely: it knows which
requests it owns, reads the current state before and after, explains the effect, and confirms the result. Every
provider write that is not a plain entity edit belongs to one.

A family is one module (`src/<provider>-<thing>.ts`) with its tests, plus one declaration in that module and one line
in `src/reviewed-families.ts`. The lifecycle modules consult the registry; they never name a registered family.

## The lifecycle, and the hook each stage calls

`amcp_write inspect` → `prepare` → (user review) → `execute` → `amcp_campaign verify`.

| Stage | Hook | Called from | Must |
|---|---|---|---|
| Membership | `kind(plan)` | everywhere, through `familyOf` | Be truthy only for this family's mutations. It sees every request. |
| Validation | `assert(plan, gateway, shape)` | `assertWriteShape` (`write-shape.ts`) | Refuse anything outside the qualified contract before any network call. Call `gateway()` (before or after the family's own checks) when the gateway's generic write checks also apply: query parameters, method tunnelling, paused creation, Google operation structure. `shape(request)` runs the whole write-shape stage on a request derived from the plan (one operation of a batch, as its own service would receive it). |
| Availability | `available(plan)` | inspect, prepare, execute | Optional: refuse a request the provider no longer accepts (a withdrawn feature). |
| Actor | `actor(plan, actor, verifying)` | `access()` first; verification | Optional: refuse an actor the writes need more authority from (an administrator). |
| Scope | `scope(connection, write, plan)` | `access()` at prepare/execute with `write=true`; verification with `write=false` | Throw when the OAuth grant lacks what the call needs (`INSUFFICIENT_SCOPE`; DV360 writes use `assertDV360WriteScope`). |
| Authorization | `authorize(plan, connection, account, store)` | `ScopeGuard.authorize` (`scope.ts`), for the mutation and every read | Return true when it proved the request stays inside `account`; false for requests that are not its own. A read-scope check of the family's marked reads belongs here too. |
| Ownership | `observe(read, connection, account, data, store)`, `created(plan, response)` | `ScopeGuard.observe`, `observeCreated` | Optional: record what a native list read or the write's response proves the account owns. |
| Snapshot plan | `snapshots(plan, stateRead, classify)` | `snapshotPlans` (`write-snapshots.ts`) | Return the reads whose results decide whether the write is allowed and what it changes; `stateRead(path, query)` builds one like the lifecycle's own, and `classify(read)` classifies a read the family builds itself (`applyExecutionRisk`). Mark each read with a family field (e.g. `businessLodgingRead`). |
| Whole state | `state(plan, readers)` | `WriteReviewer.state` | Optional, instead of `snapshots`: read everything the write depends on through `readers.guarded(...)`. |
| Snapshot read | `reader(read, next)` | `readThroughFamilies` (prepare, execute, verification) | Handle only reads carrying its marker; pass every other read to `next` unchanged. Project the provider response to a small, stable shape. |
| Read recognition | `isRead(read)` | `familyOfRead` | Be true only for reads it marked (check the gateway and the marker). |
| State check | `validateState(read, result, gateway)` | `validateState` (`write-state.ts`) | Refuse incomplete, paginated or foreign results (`STATE_…` codes). `gateway(identity)` runs the gateway's checks, with `identity` replacing its target check. |
| Snapshot state | `snapshotState(read, data, gateway)`, `snapshotValue(plan, read, data)` | `normalizeSnapshot`, `WriteReviewer.state` | Optional: the part of a marked read kept as state (`gateway()` gives the gateway's), or a projection that depends on the plan. |
| Follow-up reads | `followUps(plan, read, data)` | `WriteReviewer.state` | Optional: more reads once a read names what the write also depends on. |
| Prerequisites | `prerequisites(plan, state, reads)`, `stateChecks(plan, state, preparing)` | `WriteReviewer.state`; prepare, and execute once the state is unchanged | Refuse a request the current state does not allow. |
| Impact | `impact(plan, state, review)` | `writeImpact` | Return the summary a person reviews: what changes, what it affects. Undefined leaves it to the gateway's summary. |
| Submission | `credentials`, `beforeSubmit`, `admit`, `retain`, `deliver`, `safeError` | `WriteReviewer` execute | Optional: bind the login a job was made with, claim a provider quota, keep a job's receipt, attach it to the delivered outcome, redact errors. |
| Spending | `spendConfirmation`, `exemptFromSpendTextMatch` | `authorizeExecution` (`preflight.ts`) | See [Spending](#spending). |
| Owner policy | `activates`, `destructive`, `policyAmounts` | `checkSpendPolicy` (`spend-policy.ts`), `applyExecutionRisk` | See [Spending](#spending). |
| Outcome | `outcome(plan, result, before)`, `receipt`, `safeOutcome` | `writeOutcome` (`write-outcome.ts`) | Return true only when the response confirms every mutation of the request; add the provider's receipt; remove what must not be stored or shown. |
| Refusal | `rejectionIsNonApplied(plan, status, body)` | `WriteReviewer` execute (`write-rejection.ts`) | Optional (CMP-04): true only when a primary document or authorized live observation proves that this definitive refusal (HTTP 4xx with the provider's parsed error body) applied nothing. The claim becomes `rejected`, its spend reservation is released and a plan step can be amended under a new key. Without it the outcome stays uncertain. |
| Verification | `verification(plan, result, before, verificationRead, classify)`, `observed(read, data, gateway)` | `WriteVerifier` | Name the reads and expected fields that show the result, and project each read to the shape of its `expected`; `classify` as for snapshots. |
| Own verification | `verify(plan, verification)` | `WriteVerifier` | Optional, instead of the read-back: verify with the family's own reads (report jobs, previews, account access). |
| Created resources | `verifiedResources(plan, actual)`, `afterReadBack(plan, check, verification)` | `WriteVerifier` | Optional: IDs a consistent read-back proves the write created; they become readable for the account after `scope` with `write`. |
| Ledger | `name`, `files` | `action-contracts.ts` | Name the family as the ledger does and list its implementation and tests. |

Snapshots of a family's marked reads are normalized as its reader projected them (`normalizeSnapshot`); a stable
projection is what makes `STATE_CHANGED` between prepare and execute meaningful.

## What a family module imports

A family module imports no lifecycle module (ARC-04): the registry imports every family, so a family that imports
`scope.ts`, `review-state.ts`, `execution-risk.ts`, `write-shape.ts` or another module that reaches the registry joins
a runtime import cycle with it. Pure helpers come from leaves instead: `normalizeAccount` from `src/account-id.ts`,
`normalizeReviewState`, `reviewStateHash` and `changedStateFields` from `src/review-state-core.ts` (the old modules
re-export them); the lifecycle stages a family applies to requests it builds arrive as hook arguments (`shape`,
`classify`, the read builders). A value read while a module is evaluated (a top-level constant taken from another
module) belongs in a leaf as well, such as `src/tiktok-paths.ts`. `npm run architecture:check` refuses a module that
joins a cycle, and `tests/import-order.test.mjs` imports every module first and fails on a load-time `ReferenceError`.

## Spending

Every write passes three independent checks; none of them may be weakened to make a family work.

1. **Structural** (`src/spend-effects.ts`) applies to every family: numeric statuses and edits to delivery fields of
   campaigns, ad groups and line items need `spend_change_confirmed=true`.
2. **Family**: when the family can change what runs or what it costs, declare
   `spendConfirmation: {needed, message}`. `message` (a string, or a function of the request) says what changes and
   ends with the flag.
3. **Generic text match** (`preflight.ts`): a request whose body mentions a budget, bid, spend or an active status
   needs the flag. Set `exemptFromSpendTextMatch: true` only when the family decides its spending effect itself (2),
   or provably has none (a keyword or form field containing "budget" is not a budget edit).

Owner policies: `activates(plan, before)` must return true when the request starts or widens delivery
(`allow_activation=false` then refuses it); `destructive(plan, before?)` must return true when it deletes or removes
something the catalog method does not show (`allow_deletion=false`), and receives the reviewed state at prepare and
execute for a deletion that depends on it (a Meta feed whose deletion rule is already on); `policyAmounts` returns the
native amounts when the generic budget scan cannot find them, so budget limits apply. A provider value that deletes
in a body (`status: DELETED`, `operation_status: DELETE`) belongs in `bodyDeletionValues` (`src/execution-risk.ts`);
`tests/deletion-policy-coverage.test.mjs` fails until a value of a pinned document is classified there or exempted.

## Steps

1. Write the module. Keep each hook a named, exported function so tests can call it directly.
2. Declare the family at the end of the module:

   ```ts
   /** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
   export const businessLodgingFamily:ReviewedFamily={
    name:'google_business_lodging',
    files:['src/google-business-lodging.ts',['tests/google-business-lodging.test.mjs']],
    kind:businessLodgingKind,
    assert:assertBusinessLodging,
    authorize:authorizeBusinessLodging,
    snapshots:businessLodgingSnapshots,
    isRead:isBusinessLodgingRead,
    reader:readBusinessLodgings,
    validateState:validateBusinessLodgingState,
    prerequisites:businessLodgingPrerequisites,
    impact:businessLodgingImpact,
    outcome:businessLodgingOutcome,
    verification:businessLodgingVerification,
    observed:businessLodgingObserved,
    exemptFromSpendTextMatch:true,
   };
   ```

3. Add it to the list in `src/reviewed-families.ts`, in name order.
4. Test the family end to end with a mock transport (see `tests/google-business-lodging.test.mjs`): the refusal of
   every unqualified shape, prepare with the impact, `STATE_CHANGED` naming the changed field when a snapshot changes,
   execute, outcome and verification. Write the failing test first. Name every refusal you assert:
   `assertRefused(result, 'CODE', {writes})` from `tests/helpers/assert-refused.mjs` (`.ts` for TypeScript tests), never
   a bare `success, false` or an `assert.throws` without a matcher; `npm run check:oracles` refuses new ones.
5. Ship a conformance descriptor, `tests/family-descriptors/<family>.mjs` (see `tiktok-budgets.mjs`): one valid
   request, a synthetic provider holding the target's state, and the decisive field, chosen from the provider's
   documented resource (the field the write overwrites or depends on), not from the family's projection.
   `tests/reviewed-family-conformance.test.mjs` drives it through the real review lifecycle: the change of the decisive
   field between review and execute is `STATE_CHANGED` naming it, a paginated state read is refused, and a partial or
   failed answer is never success and never sent again. Shared synthetic answers of a provider live in
   `tests/family-descriptors/_<provider>.mjs` (`_tiktok`, `_snapchat`, `_dv360`). A family whose state reads are single
   resources states why in `unpaginated`; a reader that follows cursors is shown another page whose cursor repeats,
   which it refuses at once instead of walking its page bound. The family's prerequisites run again at execute before
   the comparison, so prefer a decisive change they accept, which the comparison reports as `STATE_CHANGED`. Only
   when every meaningful change of the decisive field is refused by the family's own prerequisite (a status
   transition, a resource a live entity now uses, a duplicate) does the descriptor name that typed refusal instead
   (`decisive.refusal`, as `meta-ad-videos.mjs`; such a refusal is, for example, `AUDIENCE_IN_USE` or
   `CONFIGURATION_EXISTS`). An upload about people passes them with `prepareFields` and `execute`
   (`meta-offline-conversions.mjs`). A second request shape the family also serves is a variant in
   `tests/family-descriptors/variants/` (as `snapchat-nested-updates-targeting.mjs` for the ad squad targeting PATCH):
   it runs the same checks and never stands in for the family's own descriptor. A family whose partial case is a
   definite refusal may also describe an uncertain answer (`mode.uncertain`, a 5xx, with `uncertainCodes`): it must
   never be success or safe to retry, and its replay must be `WRITE_OUTCOME_UNCERTAIN` without a second request (as
   `linkedin-lead-form-states.mjs`). A family is never added to
   `tests/fixtures/family-conformance-pending.json`; a backfilled one is removed from it with the ceiling lowered.
   Backfill order: activation and spend-affecting families of active providers first (Google Ads, Meta, Snapchat,
   LinkedIn and Microsoft Advertising budgets, bids and statuses), then their other entity writes. A family of a
   parked provider (`parkedProviders` in `tools/provider-lifecycle.ts`, today Criteo under PRK-02) may hold a
   lifecycle-parked exemption in the same file's `parked` list instead; the test fails once the provider is unparked,
   and then each such family ships its descriptor.
6. `tests/reviewed-families.test.mjs` then checks, without changes, that the family owns ledger routes, that no
   ledger route is claimed by two families, that its reader passes foreign reads on, and that no lifecycle module
   names it directly. A new refusal that leaves something paused, busy, uncertain or expired needs its exit test in
   `tests/fixtures/refusal-exits.json` (`node tools/refusal-exits.mjs` lists the missing ones).
7. Regenerate the ledger, contracts and status report: `npm run contracts:actions`,
   `npm run contracts:generate -- --reviewed-at=YYYY-MM-DD` with the date the changed contract was reviewed (it moves
   the provider's `contract_version`, `reviewed_at` and `contract_digest` in `src/provider-contract-manifest.json` when
   its contract content changed, and refuses without that date; commit that file too),
   `npm run report`, and after adding the family's record to `docs/implementation/`, the documentation map:
   `npm run docs:index` (`npm run check` fails while any of them is stale). Name any
   new refusal code in a guide (`Skills/amcp-campaign-builder/references/`, listed in `src/guidance.ts`), or
   declare it in `tools/guidance-coverage.ts` with a reason.
8. `npm run format`, `npm run test:related`, then the full qualification in a release candidate (`docs/review/PROGRESS.md` shows the
   commands).

## What the registry guarantees

- **One owner.** `familyOf` evaluates every registered `kind`; two families claiming one request is refused with
  `REVIEWED_FAMILY_CONFLICT` before anything is sent. The same holds for reads (`familyOfRead`).
- **Order does not matter.** Registered hooks are consulted at one point in each stage, so a new family cannot be
  shadowed by, or shadow, a family listed before it.
- **Readers compose.** Every registered reader sees every read and passes on what it did not mark, so sub-reads a
  reader issues reach the transport through the same scope checks as any other read.

## Outside the registry

All 143 reviewed families are registered (batch 33). What stays in the lifecycle modules is gateway logic, which
serves every request of a gateway rather than one family:

- the entity writes of seven platforms (`google_entities`, `meta_entities`, `snapchat_entities`, `tiktok_entities`,
  `x_entities`, `linkedin_entities`, `dv360_entities`: `src/reviewed-routes.ts`), which use each gateway's generic
  reads, checks and projections;
- gateway checks shared by several families: Reddit and Microsoft request validation, the measurement gateways'
  checks, TikTok's path-keyed projections and state checks, Google's configuration fallback, the Business Profile
  URL redaction (`placeActionSafe`) and paused-parent checks;
- Apple shared budgets, which change a budget several ad accounts share: the lifecycle checks each account's write
  grant itself (`appleSharedBudget`);
- compile-time path rewriting (`linkedinTrackingPlan`, `linkedinDomainPlan`) in `src/compiler.ts`.

`tests/reviewed-families.test.mjs` fails when a lifecycle module names a registered family's hook function.
