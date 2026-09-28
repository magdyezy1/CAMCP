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
| Validation | `assert(plan)` | `assertWriteShape` (`write-review.ts`) | Refuse anything outside the qualified contract before any network call. |
| Scope | `scope(connection, write, plan)` | `access()` at prepare/execute with `write=true`; verification with `write=false` | Throw when the OAuth grant lacks what the call needs (`INSUFFICIENT_SCOPE`; DV360 writes use `assertDV360WriteScope`). |
| Authorization | `authorize(plan, connection, account, store)` | `ScopeGuard.authorize` (`scope.ts`), for the mutation and every read | Return true when it proved the request stays inside `account`; false for requests that are not its own. |
| Snapshot plan | `snapshots(plan)` | `snapshotPlans` | Return the reads whose results decide whether the write is allowed and what it changes. Mark each read with a family field (e.g. `businessLodgingRead`). |
| Snapshot read | `reader(read, next)` | `readThroughFamilies` (prepare, execute, verification) | Handle only reads carrying its marker; pass every other read to `next` unchanged. Project the provider response to a small, stable shape. |
| Read recognition | `isRead(read)` | `familyOfRead` | Be true only for reads it marked (check the gateway and the marker). |
| State check | `validateState(read, result)` | `validateState` | Refuse incomplete, paginated or foreign results (`STATE_…` codes). |
| Snapshot state | `snapshotState(read, data)` | `normalizeSnapshot` | Optional: the part of a marked read kept as state, when not the reader's projection as is. |
| Prerequisites | `prerequisites(plan, state)` | `WriteReviewer.state` | Refuse a request the current state does not allow. |
| Impact | `impact(plan, state)` | `writeImpact` | Return the summary a person reviews: what changes, what it affects. |
| Spending | `spendConfirmation`, `exemptFromSpendTextMatch` | `authorizeExecution` (`preflight.ts`) | See [Spending](#spending). |
| Owner policy | `activates`, `destructive`, `policyAmounts` | `checkSpendPolicy` (`spend-policy.ts`), `applyExecutionRisk` | See [Spending](#spending). |
| Outcome | `outcome(plan, result, before)` | `writeOutcome` | Return true only when the response confirms every mutation of the request. |
| Verification | `verification(plan, result, before)`, `observed(read, data)` | `WriteVerifier` | Name the reads and expected fields that show the result, and project each read to the shape of its `expected`. |
| Created resources | `verifiedResources(plan, actual)` | `WriteVerifier` | Optional: IDs a consistent read-back proves the write created; they become readable for the account after `scope` with `write`. |
| Ledger | `name`, `files` | `action-contracts.ts` | Name the family as the ledger does and list its implementation and tests. |

Snapshots of a family's marked reads are normalized as its reader projected them (`normalizeSnapshot`); a stable
projection is what makes `STATE_CHANGED` between prepare and execute meaningful.

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
(`allow_activation=false` then refuses it); `destructive(plan)` must return true when it deletes or removes
something the catalog method does not show (`allow_deletion=false`); `policyAmounts` returns the native amounts when
the generic budget scan cannot find them, so budget limits apply.

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
   every unqualified shape, prepare with the impact, `STATE_CHANGED` when a snapshot changes, execute, outcome and
   verification. Write the failing test first.
5. `tests/reviewed-families.test.mjs` then checks, without changes, that the family owns ledger routes, that no
   ledger route is claimed by two families, that its reader passes foreign reads on, and that no lifecycle module
   names it directly.
6. Regenerate the ledger, contracts and status report: `npm run contracts:actions`, `npm run contracts:generate`,
   `npm run report` (`npm run check` fails while any of them is stale). Name any
   new refusal code in a guide (`Skills/amcp-campaign-builder/references/`, listed in `src/guidance.ts`), or
   declare it in `tools/guidance-coverage.ts` with a reason.
7. `npm run format`, `npm run test:related`, then the full qualification in a release candidate (`docs/review/PROGRESS.md` shows the
   commands).

## What the registry guarantees

- **One owner.** `familyOf` evaluates every registered `kind`; two families claiming one request is refused with
  `REVIEWED_FAMILY_CONFLICT` before anything is sent. The same holds for reads (`familyOfRead`).
- **Order does not matter.** Registered hooks are consulted at one point in each stage, so a new family cannot be
  shadowed by, or shadow, a family listed before it.
- **Readers compose.** Every registered reader sees every read and passes on what it did not mark, so sub-reads a
  reader issues reach the transport through the same scope checks as any other read.

## Not yet in the registry

57 of the 148 families are registered (passes 1 and 2, `docs/review/ROADMAP.md`). The others are still wired into
the lifecycle modules one line per hook, in order-sensitive chains; the registry is consulted at the position of the
first line it replaced, so the relative order of all remaining lines is unchanged. Still outside the registry:

- the Snapchat families, whose assertions run after the shared method-override check;
- Criteo catalog requests and budget overrides and DV360 SDF downloads, whose authorizers must run before the
  generic qualified-read check;
- TikTok negative keywords, whose snapshots are normalized by the generic TikTok branches;
- families without a marked reader (entity edits through the generic Google, Meta, TikTok, LinkedIn, X and DV360
  paths), and compile-time path rewriting (`linkedinTrackingPlan`, `linkedinDomainPlan`) in `src/compiler.ts`.
