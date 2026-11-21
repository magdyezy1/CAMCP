---
status: reference
tier: engineering
---

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
| Refusal | `rejectionIsNonApplied(plan, status, body)` | `WriteReviewer` execute (`write-rejection.ts`) | Optional (CMP-04): true only when a primary document or authorized live observation proves that this definitive refusal (HTTP 4xx, or the refusal a provider reports in the body of a 2xx answer, which only its own proof can accept: TikTok's, `src/tiktok-write-rejection.ts`) applied nothing. The claim becomes `rejected`, its spend reservation is released and a plan step can be amended under a new key. Without it the outcome stays uncertain, unless the provider declares a proof for the requests no family proves (its adapter's `writes.rejectionIsNonApplied`: Google Ads' per-service rule, `src/google-write-rejection.ts`). |
| Verification | `verification(plan, result, before, verificationRead, classify)`, `observed(read, data, gateway)` | `WriteVerifier` | Name the reads and expected fields that show the result, and project each read to the shape of its `expected`; `classify` as for snapshots. |
| Own verification | `verify(plan, verification)` | `WriteVerifier` | Optional, instead of the read-back: verify with the family's own reads (report jobs, previews, account access). |
| Created resources | `verifiedResources(plan, actual)`, `afterReadBack(plan, check, verification)` | `WriteVerifier` | Optional: IDs a consistent read-back proves the write created; they become readable for the account after `scope` with `write`. |
| Ledger | `name`, `files` | `action-contracts.ts` | Name the family as the ledger does and list its implementation and tests. |

Snapshots of a family's marked reads are normalized as its reader projected them (`normalizeSnapshot`); a stable
projection is what makes `STATE_CHANGED` between prepare and execute meaningful.

A read that is not the object the write changes declares its role where the family builds it, with `stateRole`:
`'account'` for the account a create is made in (the review keeps the identity fields its provider names, so a balance or
a signed link that changes by itself never refuses a write), `'parent'` for the campaign or ad group a child goes under
(kept whole, as a target is: a change of its budget, bid or schedule refuses), `'reference'` for an object the write only
names (kept to the fields the write uses). A read with no role is the target. `readRole` (`src/review-state-core.ts`) is
the one lookup of the role, asked by the state stage and by the `material` a `STATE_CHANGED` lists; no module reads
`stateRole` itself (`tests/review-read-role.test.mjs`).

## The family kit

`src/family-kit.ts` (ARC-04 stage C) holds what family modules used to copy:

- `fail(code, message, details = {}, status = 400)`, the refusal helper. Import it instead of declaring a local copy;
  `tools/check-locales.mjs` owns the reason of every call to it exactly as it owned a local copy's, so each reason still
  needs its Arabic. A local `invalid(message)` that forwards to it stays recognized too.
- Refusal factories for a family with its own codes. Bind the refusal once at the top of the module, with its type, so
  TypeScript treats each call as the end of its branch:

  | Factory | Binding | A call |
  |---|---|---|
  | `familyErrors(input, statuses = {}, otherwise = 400)` | `const fail: ReasonFirstRefusal = familyErrors('INVALID_X', {X_STATE_UNVERIFIED: 502});` | `fail(reason)` throws `INVALID_X` (400); `fail(reason, code)` throws `code` with its status in `statuses`, `otherwise` for any other code |
  | `familyStateErrors(input, state)` | `const fail: StateFlaggedRefusal = familyStateErrors('INVALID_X', 'X_STATE_UNVERIFIED');` | `fail(reason)` throws the input code (400), `fail(reason, true)` the state code (502) |
  | `familyCodeError(code, status = 400)` | `const fail: OneCodeRefusal = familyCodeError('INVALID_X');` | `fail(reason, details?)` |
  | `failWithStatus(status)` | `const fail: StatusRefusal = failWithStatus(409);` | `fail(code, reason, details?, status?)`, 409 unless the call names a status |

  The localization check owns the reason of a call to a binding built this way, at the argument the factory's refusal
  takes it in (`kitRefusalFactories`), and of a forwarder to it, as for `fail`.
- `defineFamily(declaration)` checks a declaration when its module loads (a ledger family name, `src/` implementation
  modules, at least one test, a `kind` hook, no member outside the stages) and returns it unchanged. Every registered
  family is declared through it (`tests/family-kit.test.mjs`). It takes a `FamilyDeclaration`, the five stages below
  together, so a member that is no hook of any stage (a misspelt hook, which no stage would call) fails to compile
  (`tests/family-declaration.test.ts`), and a hook written in place is typed by its stage; such a member brought in by a
  spread, which that type check does not see, fails when the module loads.
- `readOf(p, read, fields)` builds a state read from the write request `p`: `p`, then `read.before` (a binding the
  read replaces, such as `accountId` or `origin`, what it never carries, such as `personalData`, or state fields a
  family sets first), the read's action, method (`GET` unless it posts a search `body`), path, query, body and headers
  (`{}` unless the provider needs some on a read, such as LinkedIn's version headers), read-only, not destructive, no
  confirmation, then `read.after` (state fields a family resets ahead of the clears), the write-only fields it clears
  (`read.clears`: `responseControls` and `specialTransport` by default; most Google Ads searches clear only the first)
  and `fields` in order (the family's state fields reset, a query encoding). `stateReadOf(p, action, path, query,
  fields)` is its common case, a GET that clears both. Keep a `read` wrapper in the module so its call sites stay the
  same, for example
  `return stateReadOf<Read>(p, 'AMCP_X_MEDIA_READ', '/12/accounts/' + account(p) + path, query, {xMediaState: undefined});`
  or, for a Google Ads search, `return readOf<Read>(p, {action: 'AMCP_GOOGLE_BID_READ', method: 'POST', path, body:
  {query}, query: {}, clears: ['responseControls']}, {googleBidState: undefined});`. Every family builds its reads
  with them, in its own modules and in the provider modules they import (google_configuration's searches in
  `src/google-asset-set-writes.ts` and `src/google-keyword-plan-writes.ts`, the X catalog families' shared read in
  `src/x-catalogs.ts`): `tests/family-reads.test.mjs` holds each layout the families had copied, compares the kit's
  read with it key by key and in order for every combination of the fields a request may carry, and fails when a
  family module or one of those helpers spreads a request into a read of its own.
- `familyStages` lists the hooks of `ReviewedFamily` by the stage that calls them (`core`, `state`, `policy`,
  `delivery`, `verification`), each hook in one stage; `FamilyCore`, `FamilyStateHooks`, `FamilyPolicyHooks`,
  `FamilyDeliveryHooks` and `FamilyVerificationHooks` are their types, and `FamilyDeclaration` is all five. A new hook
  joins the list of its stage or the build fails (`everyFamilyHookHasAStage`); then a declaration may name it.

Every module is on the kit: the byte-identical copies moved in waves 1 to 3 (X, then TikTok, Google Ads, Criteo, DV360,
LinkedIn, Meta and Snapchat), and wave 4 moved the variants with their own codes and statuses onto the factories, each
with the code and status its helper gave (`tests/family-kit.test.mjs`). A module that declares its own `fail` again is
a regression `npm run architecture:check` names (`local_fail_copies`, 0). Nineteen modules whose former helper the
localization inventory never followed (an arrow function, or a forwarder to another module's helper) are listed in
`unlocalizedRefusalModules` (`tools/check-locales.mjs`): their reasons still have no Arabic and stay outside the
inventory until they are translated. The list only shrinks; a new module never joins it.

### Remedies of a family's refusals

A refusal's `remedy` (what to do next, `errorRemedy` in `src/errors.ts`) comes first from the remedy table of the
family's provider, `src/<provider>-remedies.ts`, which `src/provider-remedies.ts` registers by provider ID (ARC-04
stage C). To give a new code its own remedy, add a rule to that table rather than to `errorRemedy`:

```ts
{
  codes: ['X_TARGETING_LIMIT'], // exact codes, or a prefix written as 'X_TARGETING_*'
  remedy: {category: 'state', owner: 'operator', action: 'Narrow the reviewed operation ...', mutation_retry_safe: false},
},
```

- Put an exact code before a prefix that also matches it (the first rule of a table that answers wins); `when:
  details => ...` narrows a rule by the refusal's details.
- A table answers only its provider's own codes: no two providers may answer one code, and no table may answer a code
  that one of `errorRemedy`'s shared rules names (`tests/provider-remedies.test.mjs`). A provider's rule answers even
  a refusal that carries the provider's reply (`details.upstream`).
- The table is a leaf: it imports only the `ProviderRemedy` type, because `src/errors.ts`, which every module imports,
  imports the registry.
- The `action` is a shared recovery hint the website shows: add its Arabic to `web/locales/ar.json`
  (`node tools/check-locales.mjs` lists a missing one). A new provider's table is listed in `src/provider-remedies.ts`
  and in `providerRemedyModules` (`tools/check-locales.mjs`).

## What a family module imports

A family module imports no lifecycle module (ARC-04): the registry imports every family, so a family that imports
`scope.ts`, `review-state.ts`, `execution-risk.ts`, `write-shape.ts` or another module that reaches the registry joins
a runtime import cycle with it. Pure helpers come from leaves instead: `normalizeAccount` from `src/account-id.ts`,
`normalizeReviewState`, `reviewStateHash` and `changedStateFields` from `src/review-state-core.ts` (the old modules
re-export them), each with the provider's `review.volatile` table as its last argument, which a family takes from the
provider's own leaf (`src/snapchat-review-volatile.ts`); a verification compares what a write sent with what is stored
through `changedComparableFields` and `comparableStateHash`, which apply no URL rule; the lifecycle stages a family
applies to requests it builds arrive as hook arguments (`shape`,
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

Three facts of the provider's adapter (`src/provider-adapters.ts`) take part as well, never a family's own: a provider
each of whose writes changes what serves declares `everyWriteConfirmsSpend` (Reddit), and its writes need the flag
after checks 1 and 2, whether or not the family is exempt from the text match; a creation field that names a budget
but moves no money is its `spendNeutralCreation` (a new Meta campaign's top-level
`is_adset_budget_sharing_enabled: false`), which the text match reads without that one field; a creation whose shape
pins everything it creates paused is its `pausedCreation` (TikTok's creates, Q14, owner 2026-11-15; Google's campaign
creates, owner 2026-11-19), which the text match does not read at all; the owner's caps, `allow_activation` and the
paused-parent check still apply to it. A provider whose creates can serve only once a parent is enabled may also declare
`writes.pausedChildCreation(plan, state)` (Google Ads, owner 2026-11-19): the rule asks it right after check 1, and
only when it is given the review's state, and a `true` answer ends the rule before the family's `spendConfirmation`,
`everyWriteConfirmsSpend` and the text match are read, so it must be `true` only for creates that cannot serve. The
opposite hook, `writes.activatesUnderServingParent(plan, state)` (TikTok, Q1, owner 2026-11-15), is asked with the state
just before `pausedChildCreation` and only ever adds the flag: `true` for a child created active under parents the review
reads as serving. A paused-parent level (`pausedParents`) that sets `serving: 'confirm'` lets such a child through the
paused-parent check instead of refusing it, so its provider must declare that hook; an unread parent still refuses.

A provider may also declare `writes.dedupeBody(plan, reviewId)` to freeze a deduplication key of its own into a create at prepare; no provider does (TikTok's was removed: a key per review switches off the provider's same-name refusal), and any key should derive from the identity of the object, never from the review. The guard against creating twice compares the identity of the caller's request that prepare stores with the review, taken before the hook runs, so a key never makes two creates of one request look different. A provider's `usage` profile (`WireProfile.usage`: Meta reads its usage headers and says which bucket a request is counted in; the Google gateways declare `usageNotExposed`) is a fact of its adapter as well.

Owner policies: `activates(plan, before)` must return true when the request starts or widens delivery
(`allow_activation=false` then refuses it); `destructive(plan, before?)` must return true when it deletes or removes
something the catalog method does not show (`allow_deletion=false`), and receives the reviewed state at prepare and
execute for a deletion that depends on it (a Meta feed whose deletion rule is already on); `policyAmounts` returns the
native amounts when the generic budget scan cannot find them, so budget limits apply. A provider value that deletes
in a body (`status: DELETED`, `operation_status: DELETE`) belongs in its provider adapter's `deletions`
(`src/provider-adapters.ts`, read as `bodyDeletionValues` by `src/execution-risk.ts`);
`tests/deletion-policy-coverage.test.mjs` fails until a value of a pinned document is classified there or exempted.

The review's one-line summary (`src/review-summary.ts`) is what the person approving a write reads first, so it must name
what the write does. It reads the path of a write it has no declaration for, which tells a create only on the route
shapes it knows. When your family's writes share a route and differ by method (Microsoft's Add, Update and Delete), or
the path alone does not say what they do, declare `operation(plan)`: `{operation: 'create' | 'update' | 'delete', count?,
entity?, plural?}`, with how many entities the request writes and what one is called (in the singular). Answer from the
method and path that `kind` matched, never from the name the caller gave the action; return undefined for what you leave
to the summary. A family whose every POST creates declares `operation: createsOnPost` (`createsOnPostAs('report job')` when
its route does not name what it creates). A create is never named for a request that carries another method, and a delete
stays whatever the method or the destructive flag says. `tests/review-summary-ledger.test.mjs` sweeps every route the
review accepts against the vendor's own name for it, so a new route that creates must read as a create or the test names it.

## Steps

1. Write the module. Keep each hook a named, exported function so tests can call it directly.
2. Declare the family at the end of the module, through the family kit (below):

   ```ts
   /** Registers this family with the reviewed write lifecycle (src/reviewed-families.ts). */
   export const businessLodgingFamily:ReviewedFamily=defineFamily({
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
   });
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
   declare it in `tools/guidance-coverage.ts` with a reason. The change is documented when the one guide in `docs/`
   that describes the provider's writes and the reference AI clients read for it (served as an MCP resource) both say
   what the family does now. State the number of families only through the `reviewed_families` fact marker
   (`tools/doc-facts.mjs`).
8. `npm run format`, `npm run test:related`, then the full qualification in a release candidate (the progress log,
   [`docs/records/PROGRESS.md`](records/PROGRESS.md), shows the commands).

## What the registry guarantees

- **One owner.** `familyOf` evaluates every registered `kind`; two families claiming one request is refused with
  `REVIEWED_FAMILY_CONFLICT` before anything is sent. The same holds for reads (`familyOfRead`).
- **Order does not matter.** Registered hooks are consulted at one point in each stage, so a new family cannot be
  shadowed by, or shadow, a family listed before it.
- **Readers compose.** Every registered reader sees every read and passes on what it did not mark, so sub-reads a
  reader issues reach the transport through the same scope checks as any other read.

## Outside the registry

Every reviewed family is registered: <!-- fact:reviewed_families -->171<!-- /fact --> today, listed by provider under
[registered families](#registered-families). What stays in the lifecycle modules is gateway logic, which serves every
request of a gateway rather than one family:

- the entity writes of seven platforms (`google_entities`, `meta_entities`, `snapchat_entities`, `tiktok_entities`,
  `x_entities`, `linkedin_entities`, `dv360_entities`), which use each gateway's generic reads, checks and
  projections: each provider adapter declares which writes are its entity writes (`entityWrites`,
  `src/provider-adapters.ts`), and `src/reviewed-routes.ts` gives that route to a write no registered family claims;
- gateway checks and projections shared by several families. The write-shape and state checks of each provider are
  its adapter's (`checks` in `src/<provider>-adapter.ts`, ARC-01 phase B: Microsoft's and Reddit's request
  validation, Meta's first write checks, the measurement gateways' checks, TikTok's and Reddit's state checks, the
  paused-creation rules), which `src/write-shape.ts` and `src/write-state.ts` consult where they named the provider.
  So are the review's projections of its reads (`review`: TikTok's path-keyed projections, Google's configuration
  fallback and the gateway verification reads), which `src/review-state.ts` and `src/verification-reads.ts` consult
  after the families' own, and the provider's parts of the review itself (`writes`, wave 4c: the write scopes, grants
  and permissions a connection needs, a provider's own state reads, follow-up reads and prerequisites, the Business
  Profile URL redaction, Tag Manager's fingerprint and Snapchat's creative references and affected ads), which
  `src/write-review.ts` consults where it named the provider, the state reads of a write no family plans
  (`snapshots`, `accountPath`, `accountSnapshots`), which `src/write-snapshots.ts` consults after the families' own,
  and what a write publishes, deletes or changes beyond its target (`publishesLive`, `recordCount`, `deletes`,
  `impact`), which `src/write-effects.ts` and `src/write-impact.ts` consult after the families' own, and what a write
  does for the one-line summary (`operation`, which `src/review-summary.ts` asks after the family's own `operation` and
  only for a write the review accepts: a provider whose URLs say it, as Graph's edges and nodes or Rest.li's collections
  and entities, or whose every POST creates, declares it once for its families). The
  paused-parent checks stay in the lifecycle modules;
- Apple shared budgets, which change a budget several ad accounts share: the review checks each account's write
  grant itself, for the accounts Apple's `writes` hooks name (`appleSharedBudget`);
- compile-time path rewriting (`linkedinTrackingPlan`, `linkedinDomainPlan`) in `src/compiler.ts`.

`tests/reviewed-families.test.mjs` fails when a lifecycle module names a registered family's hook function.

## Registered families

`npm run docs:index` writes this list, and `npm run docs:index:check` fails when it differs from the registry, so a
new family appears here when its line is added to `src/reviewed-families.ts` and the build and index run again.

<!-- doc-facts:reviewed-families:begin (generated by npm run docs:index; do not edit) -->
Generated from `src/reviewed-families.ts` and the provider adapter registry: each family belongs to the provider
whose family prefix its name starts with. A parked provider keeps its families registered; the listings leave them
out until `AMCP_PROVIDERS` offers it.

| Provider | Status | Families | Names |
|---|---|---:|---|
| Google Ads | active | 28 | `google_asset_links`, `google_atomic_builds`, `google_auto_assets`, `google_bid_modifiers`, `google_bidding_events`, `google_campaign_drafts`, `google_configuration`, `google_conversion_actions`, `google_conversion_goals`, `google_customer_settings`, `google_experiments`, `google_lifecycle_goals`, `google_listing_groups`, `google_place_actions`, `google_pmax_brand_guidelines`, `google_portfolio_strategies`, `google_recommendation_apply`, `google_recommendation_dismissal`, `google_customer_labels`, `google_recommendation_subscriptions`, `google_shareable_previews`, `google_smart_campaign_settings`, `google_targeting`, `google_user_access`, `google_user_list_customer_types`, `google_youtube_uploads`, `google_customer_match`, `google_offline_conversions` |
| Google Business Profile | active | 5 | `google_business_access`, `google_business_location_attributes`, `google_business_location_edits`, `google_business_lodging`, `google_business_notifications` |
| Meta | active | 21 | `meta_account_settings`, `meta_ad_images`, `meta_ad_videos`, `meta_budget_schedules`, `meta_product_sets`, `meta_catalog_products`, `meta_product_feeds`, `meta_ad_rules`, `meta_customer_lists`, `meta_offline_conversions`, `meta_product_catalogs`, `meta_brand_safety`, `meta_copies`, `meta_custom_conversions`, `meta_insights_jobs`, `meta_labels`, `meta_lookalikes`, `meta_object_edits`, `meta_pixels`, `meta_split_tests`, `meta_value_rules` |
| TikTok | active | 30 | `tiktok_ad_comments`, `tiktok_audience_edits`, `tiktok_blocked_words`, `tiktok_brand_safety`, `tiktok_budgets`, `tiktok_change_log_tasks`, `tiktok_cta_portfolios`, `tiktok_custom_conversion_edits`, `tiktok_custom_conversions`, `tiktok_deletions`, `tiktok_entity_status`, `tiktok_identities`, `tiktok_image_edits`, `tiktok_library_assets`, `tiktok_lookalikes`, `tiktok_negative_keywords`, `tiktok_report_jobs`, `tiktok_rule_audiences`, `tiktok_pixels`, `tiktok_saved_audiences`, `tiktok_smart_plus_ad_edits`, `tiktok_smart_plus_adgroup_edits`, `tiktok_smart_plus_adgroups`, `tiktok_smart_plus_ads`, `tiktok_smart_plus_budgets`, `tiktok_smart_plus_campaign_edits`, `tiktok_smart_plus_campaigns`, `tiktok_smart_plus_deletions`, `tiktok_smart_plus_material_status`, `tiktok_smart_plus_status` |
| Snapchat | active | 13 | `snapchat_custom_conversions`, `snapchat_dynamic_templates`, `snapchat_event_details`, `snapchat_media_copy`, `snapchat_claim_media`, `snapchat_targeting_specs`, `snapchat_nested_updates`, `snapchat_offer_disclaimers`, `snapchat_pixel_names`, `snapchat_product_sets`, `snapchat_product_feeds`, `snapchat_catalogs`, `snapchat_segment_deletions` |
| LinkedIn | active | 18 | `linkedin_ab_tests`, `linkedin_lift_tests`, `linkedin_engagement_audiences`, `linkedin_account_settings`, `linkedin_audience_templates`, `linkedin_conversion_links`, `linkedin_conversion_rules`, `linkedin_dsc`, `linkedin_dsc_edits`, `linkedin_entity_deletes`, `linkedin_insight_tag_domains`, `linkedin_insight_tags`, `linkedin_lead_form_states`, `linkedin_lead_forms`, `linkedin_message_ads`, `linkedin_publisher_restrictions`, `linkedin_third_party_tracking`, `linkedin_tracking_parameters` |
| X | active | 17 | `x_catalog_products`, `x_conversation_cards`, `x_creatives`, `x_curated_categories`, `x_custom_audiences`, `x_drafts`, `x_entity_batches`, `x_line_item_associations`, `x_media_library`, `x_preroll_ctas`, `x_product_catalogs`, `x_product_sets`, `x_report_jobs`, `x_scheduled_feeds`, `x_scheduled_tweets`, `x_targeting_batch`, `x_tracking_tags` |
| Microsoft Advertising | active | 3 | `microsoft_asset_links`, `microsoft_location_targets`, `microsoft_search` |
| Apple Ads | active | 2 | `apple_campaigns`, `apple_entities` |
| Reddit | active | 2 | `reddit_classic`, `reddit_creatives` |
| Display & Video 360 | active | 15 | `dv360_ad_assets`, `dv360_ad_group_targeting`, `dv360_advertiser_settings`, `dv360_advertiser_targeting`, `dv360_audience_edits`, `dv360_custom_bidding`, `dv360_custom_bidding_files`, `dv360_demand_gen_ad_groups`, `dv360_demand_gen_ads`, `dv360_inventory_source_groups`, `dv360_line_item_bulk_update`, `dv360_line_item_duplicate`, `dv360_line_item_targeting`, `dv360_lists`, `dv360_sdf_downloads` |
| Google Analytics 4 | active | 1 | `ga4_export_jobs` |
| Google Tag Manager | active | 3 | `gtm_entities`, `gtm_workflows`, `gtm_workspace` |
| Google Search Console | active | 1 | `search_console_sites` |
| Criteo | parked | 12 | `criteo_auction_line_items`, `criteo_audience_segments`, `criteo_bid_multipliers`, `criteo_budget_overrides`, `criteo_campaigns`, `criteo_catalog_requests`, `criteo_creatives`, `criteo_keywords`, `criteo_preferred_line_items`, `criteo_promoted_products`, `criteo_report_jobs`, `criteo_targeting` |
<!-- doc-facts:reviewed-families:end -->
