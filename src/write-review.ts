import {unsupportedProviderAlias} from './retired-provider-actions.js';
import {checkSpendPolicy, describeExceeded, exceededCaps, workspaceOwner} from './spend-policy.js';
import {randomUUID} from 'node:crypto';
import {
  MirrorError,
  connectorReadOnly,
  errorRemedy,
  preciseMessage,
  readOnlyDeployment,
  refusedBeforeSending,
} from './errors.js';
import {writeImpact} from './write-impact.js';
import {evidenceForm, executionEvidence, type EvidenceForm} from './contract-evidence.js';
import {Registry} from './catalog.js';
import {Compiler} from './compiler.js';
import {Store} from './store.js';
import {CredentialProvider} from './auth.js';
import {NativeTransport, type TransportResult} from './transport.js';
import {ScopeGuard, normalizeAccount} from './scope.js';
import {applyExecutionRisk} from './execution-risk.js';
import {authorizeExecution, switchedProviderJob, type ExecutionPolicy} from './preflight.js';
import {effectClass, reviewedProviderJob} from './effect-class.js';
import {admitProviderJob, assertProviderJobAccount, beginProviderJob, settleProviderJob} from './provider-jobs.js';
import {
  approvalNotice,
  assertCapOverrideOwner,
  assertExecutionApproval,
  destructiveRequest,
  reviewApprovalPolicy,
} from './write-approval.js';
import {guardInput, redactCredentialShapesWithPaths, sha256, stable} from './security.js';
import type {Actor, CallOptions, CompiledRequest, Connection, Credentials, JsonObject} from './types.js';
import {nativeAuthority} from './native-authority.js';
import {DelegatedNativeCompiler} from './delegated-native.js';
import {normalizeSnapshot, reviewStateHash, changedStateFields, reviewVolatile} from './review-state.js';
import {materialFields, surfacedMaterial} from './review-diff.js';
import {recurringStatePaths} from './review-friction.js';
import {accountWriteGranted, assertAccountWrite} from './write-access.js';
import {pausedParentFollowUp, validatePausedParents} from './paused-parents.js';
import {familyOf, readThroughFamilies} from './reviewed-families.js';
import {assertWritesNotPaused} from './owner-operations.js';
import {planPolicy} from './campaign-inventory.js';
import {approvalSpends, approvalSummary} from './plan-approval.js';
import {
  object,
  fail,
  notSent,
  optionalMissingState,
  releaseUnsentClaims,
  serializeTargets,
  targetWaitMs,
  uncertainNext,
} from './write-common.js';
import {endedSeal, liftSupersede, retainedReview, writeStatus, type WriteOrigin} from './write-records.js';
import {actionHandler, type ActionTable, type ToolContext} from './tool-actions.js';
import {WriteReconciler, findCreated} from './write-reconciliation.js';
import {queueReconcile, unwatchWrite, watchWrite} from './write-reconcile-job.js';
import {
  assertCreateNotRepeated,
  createsObjects,
  earlierCreates,
  refuseRepeatedCreate,
  repeatedCreateWarning,
  requestIdentity,
} from './write-duplicates.js';
import {principalOf} from './actor-identity.js';
import {setTimeout as pause} from 'node:timers/promises';
import {writeOutcome} from './write-outcome.js';
import {nonAppliedRejection, rejectedError} from './write-rejection.js';
import {validateState} from './write-state.js';
import {assertWriteShape} from './write-shape.js';
import {wireContractCheck} from './wire-contracts.js';
import {snapshotPlans, stateRead} from './write-snapshots.js';
import {
  confirmations,
  hashPeople,
  scrubError,
  scrubPeople,
  sentIdentifiers,
  type PersonalDataRecord,
} from './personal-data.js';
import {assertPersonalDataAllowed} from './personal-data-access.js';
import {offlineUploadRehearsal} from './offline-upload-rehearsal.js';
import {loginStamp} from './connection-authority.js';
import {
  checkRefusedForAccess,
  defaultCheckUnavailable,
  providerCheckUnavailable,
  providerValidatesByDefault,
  providerValidationRequest,
  providerValidationScope,
  runProviderValidation,
  type ProviderCheck,
} from './provider-validation.js';
import {effectNames, effectReasons, writeEffects} from './write-effects.js';
import {reviewSummary} from './review-summary.js';
// Each provider's parts of the review (ARC-01 phase B, wave 4c): its adapter's `writes` hooks, asked where the review
// named the provider before; the review imports no provider module.
import {providerHooks} from './provider-hooks.js';
import {providerById} from './provider-adapters.js';
import type {WriteReviewHooks} from './provider-adapter.js';

/** The review hooks of a gateway's provider. */
const reviewHooks = (gateway: unknown): WriteReviewHooks | undefined => providerHooks(gateway)?.writes;
/** The request as a review shows and returns it: its provider's view (place-action links made safe), or itself. */
const shownRequest = (plan: CompiledRequest): unknown => {
  const shown = reviewHooks(plan.gateway)?.shownRequest;
  return shown ? shown(plan) : plan;
};
/** The most records the locator checks one by one (R2.5 M3, L5-10): one shape check each. */
const locatorMaxRecords = 100;
/**
 * A refusal's message with the numbers of its paths left out (`operations[11]`, `/operations/11/create`): a record refused alone
 * reads its own place in the one-record list (`operations[0]`) where the whole list read its own, and nothing else differs.
 */
const withoutPlaces = (message: string): string => message.replace(/\[\d+\]|(?<=\/)\d+(?!\d)/g, '[#]');
/**
 * The generic locator (R2.5 M3, L5-10): a refusal of a request that lists several records and names none of them (no
 * `details.operation`) is for one of them, and 19 records cost the agent a guess. When the provider's record list
 * (`writes.batch`: Google Ads' operations, a Snapchat record list) holds 2 to 100 records, the shape check is run on each
 * record alone, in order, and the first that is refused with the same code and the same message (round 2, S4-4: not the code
 * alone, which would blame a record refused for another reason; the message is compared with the numbers of its paths left
 * out, `withoutPlaces`) gives the refusal its `details.operation`. Nothing
 * else of the refusal changes: not its code, its message or its status. Only the list is kept in a record's request, so a
 * refusal of the request itself (a body field, the length of the list) is reproduced by no record and names none, as does a
 * refusal that needs several records at once (a target named twice). A request that temporary names link, and a build, have
 * no record list. Inspect and prepare only: an execute checks the stored request as a whole and never slices it. `check` is the
 * shape check (a parameter so that a test can give a record a refusal of its own).
 */
export function locateRefusedRecord(
  plan: CompiledRequest,
  refusal: unknown,
  check: (plan: CompiledRequest) => void = assertWriteShape,
): void {
  if (!(refusal instanceof MirrorError) || refusal.details.operation !== undefined) return;
  const body =
      plan.body && typeof plan.body === 'object' && !Array.isArray(plan.body) ? (plan.body as JsonObject) : undefined,
    batch = body ? reviewHooks(plan.gateway)?.batch?.(body) : undefined;
  if (!batch || batch.items.length < 2 || batch.items.length > locatorMaxRecords) return;
  for (const [index, record] of batch.items.entries()) {
    try {
      check({...plan, body: {[batch.key]: [record]}});
    } catch (e) {
      if (
        e instanceof MirrorError &&
        e.code === refusal.code &&
        withoutPlaces(e.message) === withoutPlaces(refusal.message)
      ) {
        refusal.details = {...refusal.details, operation: index};
        return;
      }
    }
  }
}
/** The shape check of inspect and prepare, which also names the record a refusal of a record list is for. */
function assertLocatedShape(plan: CompiledRequest): void {
  try {
    assertWriteShape(plan);
  } catch (e) {
    locateRefusedRecord(plan, e);
    throw e;
  }
}
/**
 * The `request` of an inspect or prepare answer, for the AI client to show the person who approves it (P2A-02). The text
 * of an ad is whatever its preparer wrote, and the frozen plan sends all of it, so it is shown through the credential
 * view of Ruling 10, not through redact(): `Cookie: visit https://evil.example/landing now` is read whole, and only a
 * credential-shaped value is hidden. When one is, `redacted` lists its path and nothing else of it (Ruling 13: no hash
 * either, which would let a reader reverse a short secret offline), so the reader knows that something was hidden and where.
 * The audit row and the job records are written from the plan by redact().
 */
const reviewedRequest = (plan: CompiledRequest) => {
  const {value, redacted} = redactCredentialShapesWithPaths(shownRequest(plan));
  return {request: value, ...(redacted.length ? {redacted} : {})};
};
/**
 * The `request` and the `before_state` of a prepare answer, shown the same way (P2B-05): the before-state is the provider's
 * current state, and an ad whose current text begins `Cookie:` or `password:` was shown hidden beside a request shown whole,
 * with nothing to say that a value was hidden. `redacted` lists the hidden values of both: the request's paths as they were
 * (from the root of the request) and the before-state's under a `before_state` root, so the reader can tell them apart.
 */
const reviewedPrepare = (plan: CompiledRequest, state: unknown) => {
  const request = redactCredentialShapesWithPaths(shownRequest(plan)),
    before = redactCredentialShapesWithPaths({before_state: state}),
    redacted = [...request.redacted, ...before.redacted];
  return {request: request.value, before_state: before.value.before_state, ...(redacted.length ? {redacted} : {})};
};

export const writeTool = {
  name: 'amcp_write',
  description:
    'Use this for any single advertising or measurement change; use amcp_campaign when later steps need IDs that earlier steps create. Inspect, prepare and execute a reviewed native mutation. inspect checks local write-contract support without credentials or network calls; for an offline conversion upload it also returns a local rehearsal (provider time limits, request hashes, the provider no-execution flag) that is never sent or executed. Preparation reads account/resource state and returns a five-minute, actor-bound frozen request, with execute_requirements naming every acknowledgement execute will need. Execution requires its review_id and confirmed=true; idempotency_key defaults to the review_id. Operator role and administrator account write grants are required. A Google Ads mutation or Snapchat batch of more than 25 records is prepared as one review of parts of 25 (group: true) and approved and executed once; execution stops at the first part that does not succeed. status {review_id} reads a retained review back without a provider request: its claim, receipt, read-back and next call. reconcile {review_id} checks an uncertain write with read-only provider lookups and never sends it again; with accept_applied=true and its reconciliation_id it records the observed result as the receipt. This is an AMCP extension, not a captured AMCP tool.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {type: 'string', enum: ['help', 'inspect', 'prepare', 'execute', 'status', 'reconcile']},
      topic: {type: 'string', maxLength: 300},
      gateway: {type: 'string'},
      arguments: {type: 'object'},
      connection_id: {type: 'string'},
      review_id: {type: 'string'},
      idempotency_key: {
        type: 'string',
      },
      confirmed: {type: 'boolean'},
      // The flags below record a person's explicit approval; tools/list keeps one line on each (wave 2 review), and
      // each says the client never sets it on its own: only when execute_requirements lists it (wave 3a review).
      spend_change_confirmed: {
        type: 'boolean',
        description: 'Only if execute_requirements lists it: user approved this spend change.',
      },
      cap_override_confirmed: {
        type: 'boolean',
        description: 'Only if execute_requirements lists it: user approved exceeding an owner cap.',
      },
      creative_edit_confirmed: {
        type: 'boolean',
        description: 'User accepted that this X card or Tweet change may disrupt promoted ads; prepare and execute.',
      },
      // WRT-09 (P5): the owner's opt-in tier.
      destructive_confirmed: {
        type: 'boolean',
        description: 'Only if execute_requirements lists it: user approved this deletion.',
      },
      people: {
        type: 'object',
      },
      // prepare only, when adding people: its note is in src/first-party-contracts.ts (amcp_tool_help), not in tools/list.
      personal_data: {
        type: 'object',
      },
      provider_check: {
        type: 'boolean',
      },
      evidence: {
        type: 'string',
        enum: ['full', 'ref'],
      },
      accept_applied: {type: 'boolean'},
      reconciliation_id: {type: 'string'},
      supersedes_review_id: {type: 'string'},
    },
    additionalProperties: false,
  },
};
/**
 * What a read-only deployment lists (owner decision D15, MCP-09): amcp_write with inspect only, which is truthful and
 * changes nothing. prepare and execute are still refused by the server, first, with LIVE_WRITES_DISABLED.
 */
export const readOnlyWriteTool = {
  name: 'amcp_write',
  description:
    'Use this to check whether a single advertising or measurement change has a reviewed write contract. inspect checks local write-contract support for the exact native arguments, without credentials or network calls, and saves nothing. This deployment is read-only: prepare and execute are refused, and its operator can enable reviewed writes. This is an AMCP extension, not a captured AMCP tool.',
  inputSchema: {
    type: 'object',
    // No root combinator: the Claude API refuses one. The handler enforces "help, or gateway and arguments".
    required: ['action'],
    properties: {
      action: {type: 'string', enum: ['help', 'inspect']},
      topic: writeTool.inputSchema.properties.topic,
      gateway: {...writeTool.inputSchema.properties.gateway, description: 'Required unless action is help.'},
      arguments: {...writeTool.inputSchema.properties.arguments, description: 'Required unless action is help.'},
      connection_id: writeTool.inputSchema.properties.connection_id,
      evidence: writeTool.inputSchema.properties.evidence,
    },
    additionalProperties: false,
  },
};
/**
 * What a read-only deployment lists when its owner turned provider jobs on (AMCP_PROVIDER_JOBS=true, RPT-06, owner
 * decision D18): inspect for every change, and prepare, execute and status for provider report and export jobs only.
 * Every other prepare and execute is still refused with LIVE_WRITES_DISABLED, exactly as without the switch.
 */
export const providerJobWriteTool = {
  name: 'amcp_write',
  description:
    'Use this to check whether a single advertising or measurement change has a reviewed write contract, and to create a provider report or export job. inspect checks local write-contract support for the exact native arguments, without credentials or network calls, and saves nothing. This deployment is read-only for advertising changes; its owner allows provider report and export jobs (X, TikTok and Meta report jobs, Criteo reports, DV360 SDF exports, TikTok change logs and GA4 report tasks). For a job, prepare reads state and freezes a five-minute review, execute submits it once after confirmed=true and never resubmits it, and status reads a retained review back. A job needs the account’s report-job grant (AMCP Connections). This is an AMCP extension, not a captured AMCP tool.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: {type: 'string', enum: ['help', 'inspect', 'prepare', 'execute', 'status']},
      topic: writeTool.inputSchema.properties.topic,
      gateway: writeTool.inputSchema.properties.gateway,
      arguments: writeTool.inputSchema.properties.arguments,
      connection_id: writeTool.inputSchema.properties.connection_id,
      review_id: writeTool.inputSchema.properties.review_id,
      idempotency_key: writeTool.inputSchema.properties.idempotency_key,
      confirmed: writeTool.inputSchema.properties.confirmed,
      evidence: writeTool.inputSchema.properties.evidence,
    },
    additionalProperties: false,
  },
};
/** What an execution is for the owner's write pause (RPT-06): a provider job, or an advertising write. */
const pauseEffect = (plan: CompiledRequest) => (reviewedProviderJob(plan) ? 'provider_jobs' : 'advertising');
/** A guarded-reader binding: the connection's login (its revision, not token bytes) must stay the one the first read used. */
/** What execute accepts; anything else was frozen at prepare (Snapchat S12). */
const executeFields = [
  'action',
  'review_id',
  'idempotency_key',
  'confirmed',
  'spend_change_confirmed',
  'cap_override_confirmed',
  'creative_edit_confirmed',
  'destructive_confirmed',
  'people (the same people, for a review that sends data about people)',
  'gateway (the review’s own)',
  'connection_id (the review’s own)',
];
/** Same-target serialization (WRT-04): a hold outlasts state reads plus one transport timeout and is renewed at
 * dispatch; a crashed holder's lock lapses on its own. A second execution waits briefly, then is refused unsent. */
const targetLockMs = 120000,
  targetBusy =
    'Another reviewed write to the same target is being executed. Nothing was submitted; execute this review again in a moment. Its state is read again first.';
const sameLogin = (message: string) => ({
  value: (credentials: Credentials) => loginStamp(credentials),
  changed: (): never => fail('CONNECTION_AUTHORITY_CHANGED', message),
});
/**
 * The call that prepares a review's original request again (reviews prepared before this field existed have none): for an
 * expired review, and for one whose state changed since it was prepared (STATE_CHANGED, R25 M1, L5-04).
 */
const expiredNext = (review: JsonObject, stateChanged = false): JsonObject => {
  if (!review.prepare_input) return {};
  // The creative-edit acknowledgement was given for the impact the first review showed. After a state change the impact may
  // have changed, so the call that prepares again does not pre-fill it (lead review S4-2): execute still demands it.
  const {creative_edit_confirmed: _acknowledged, ...fresh} = review.prepare_input;
  return {
    next_call: {tool: 'amcp_write', arguments: {action: 'prepare', ...(stateChanged ? fresh : review.prepare_input)}},
    ...(review.plan?.personalData
      ? {people: 'Add people to the call: the same people as before. AMCP kept only their count and digest.'}
      : {}),
  };
};
/** A review the provider rejected when it validated it at prepare (provider_check) is never executed (WRT-06). */
function rejectedByProvider(review: JsonObject): void {
  if (review.provider_check?.status === 'provider_rejected')
    fail(
      'PROVIDER_VALIDATION_FAILED',
      'The provider rejected this request when it validated it at prepare, so this review cannot be executed. Nothing was submitted; correct what details.field_paths names and prepare it again.',
      {field_paths: review.provider_check.field_paths ?? []},
    );
}
/** What execute will ask for, decided at prepare by the same authorizeExecution rules, so a client can ask the user
 * once instead of discovering a missing flag from a refused execute. Advisory: execute re-checks everything. `state` is the state the
 * review read: with it a create under a parent the review reads PAUSED asks for no spend flag (R2.5 field fix r25-field-pausedspend). */
export function executeRequirements(
  actor: Actor,
  plan: CompiledRequest,
  policy: ExecutionPolicy,
  reviewId: string,
  creativeEdit: boolean,
  exceeded: JsonObject[] = [],
  destructiveTier = false,
  state?: readonly unknown[],
): JsonObject {
  const reasons: JsonObject[] = [];
  let spend = false;
  try {
    authorizeExecution(actor, plan, {dry_run: false, confirmed: true, idempotency_key: reviewId}, policy, true, state);
  } catch (e) {
    if (!(e instanceof MirrorError) || e.code !== 'SPEND_CONFIRMATION_REQUIRED') throw e;
    spend = true;
    reasons.push({
      flag: 'spend_change_confirmed',
      reason: e.message,
      ...(e.details.fields ? {fields: e.details.fields} : {}),
    });
  }
  if (exceeded.length)
    reasons.push({
      flag: 'cap_override_confirmed',
      reason:
        'This change goes beyond a spending cap the owner set: ' +
        describeExceeded(exceeded) +
        '. It is not refused; the user decides.',
      exceeded,
    });
  if (creativeEdit)
    reasons.push({
      flag: 'creative_edit_confirmed',
      reason:
        'This review acknowledges a potentially disruptive creative edit; repeat creative_edit_confirmed=true at execute.',
    });
  // WRT-09 (P5): the owner's opt-in tier for deletions on this account.
  if (destructiveTier)
    reasons.push({
      flag: 'destructive_confirmed',
      reason:
        'The owner requires an explicit acknowledgement before anything is deleted on this account. Show the user what this review deletes, and set destructive_confirmed=true only after they approve.',
    });
  return {
    confirmed: true,
    idempotency_key: reviewId,
    spend_change_confirmed: spend,
    cap_override_confirmed: exceeded.length > 0,
    creative_edit_confirmed: creativeEdit,
    ...(destructiveTier ? {destructive_confirmed: true} : {}),
    reasons,
    user_approval:
      spend || creativeEdit || exceeded.length || destructiveTier
        ? 'Show the user before_state, the impact and the reasons, and set these flags only after they approve.'
        : 'Execute after the user approves this review.',
  };
}
/** A prepare or inspect call of amcp_write (ARC-04 stage D), with its evidence form and who prepares it. */
interface ReviewPreparation extends ToolContext {
  readonly evidence: EvidenceForm;
  readonly origin: WriteOrigin;
}
/** An execute call, and who executes the review: the person, a plan's step or a group's part. */
interface ReviewExecution extends ToolContext {
  readonly origin: WriteOrigin;
}
export class WriteReviewService {
  constructor(
    private registry: Registry,
    private compiler: Compiler,
    private store: Store,
    private transport: NativeTransport,
    private credentials: CredentialProvider,
    private options: CallOptions,
    private policy: ExecutionPolicy,
    private delegated = new DelegatedNativeCompiler(),
  ) {}
  private authority(
    actor: Actor,
    reviewPlan: CompiledRequest,
    request: CompiledRequest,
    connection: Connection,
    auth: Credentials,
  ) {
    return nativeAuthority(this.store, this.registry, actor, request, connection, auth, () => {
      this.access(actor, reviewPlan, connection.id);
      familyOf(reviewPlan)?.credentials?.(this.store.credentials(actor.tenantId, connection.id), auth);
    });
  }
  private async request(
    actor: Actor,
    reviewPlan: CompiledRequest,
    request: CompiledRequest,
    connection: Connection,
    auth: Credentials,
    beforeDispatch?: () => void,
    onDispatch?: () => void,
  ) {
    const access = this.authority(actor, reviewPlan, request, connection, auth);
    const response = await this.transport.request(request, access(), auth, undefined, {
      beforeAttempt: () => {
        access();
        beforeDispatch?.();
      },
      onDispatch,
    });
    // A received mutation outcome must be retained before any post-response permission check.
    if (request.readOnly) access();
    return response;
  }
  private access(actor: Actor, plan: CompiledRequest, connectionId?: string): Connection {
    this.store.assertActorActive(actor);
    familyOf(plan)?.actor?.(plan, actor, false);
    // RPT-06 policy matrix: a provider report or export job under the deployment owner's switch is allowed while live
    // writes are off and for a reader, on an account with a report-job grant (or an operator's write grant while writes
    // are on). Every other request, advertising writes included, keeps both refusals and the account write grant.
    const job = switchedProviderJob(plan, this.policy);
    if (!this.policy.allowWrites && !job) throw readOnlyDeployment();
    if (actor.role === 'reader' && !job) throw connectorReadOnly(actor);
    const c = this.store.resolveConnection(actor, plan.gateway, plan.accountId, connectionId),
      id = normalizeAccount(plan.gateway, plan.accountId ?? (c.accounts.length === 1 ? c.accounts[0] : ''));
    if (job) assertProviderJobAccount(this.store, actor, c, id, this.policy.allowWrites);
    else assertAccountWrite(this.store, c, id);
    // The provider's checks, where the review named it (src/<provider>-adapter.ts `writes`): the other accounts a
    // write changes (Apple's shared budget), its write scopes before the family's scope check (Reddit's), its write
    // grant after it (Microsoft's msads.manage), and the write permission it requires after ScopeGuard (the
    // measurement providers').
    const writes = reviewHooks(plan.gateway);
    for (const account of writes?.sharedAccounts?.(plan) ?? []) {
      this.store.resolveConnection(actor, plan.gateway, account, c.id);
      assertAccountWrite(this.store, c, account);
    }
    writes?.writeScopes?.(c);
    familyOf(plan)?.scope?.(c, true, plan);
    writes?.writeGrant?.(c);
    plan.accountId = id;
    new ScopeGuard(this.registry, this.store).authorize(plan, c);
    writes?.writePermission?.(plan, c);
    return c;
  }
  /**
   * The reader a family's state checks use. Each read must be read-only; the review's connection is checked (actor,
   * grants, scopes) and the read authorized by the scope guard before the credentials are fetched, after, and after the
   * response. With a binding, the login must also stay the one the first read used: the binding reduces credentials to
   * a value (undefined when they are unusable), which the stored login must keep matching.
   */
  private guardedReader(
    actor: Actor,
    plan: CompiledRequest,
    connectionId: string,
    unsafe: string,
    binding?: {value: (credentials: Credentials) => string | undefined; changed: () => never},
  ) {
    let bound: string | undefined;
    const read = async (request: CompiledRequest): Promise<TransportResult> => {
      if (!applyExecutionRisk(request).readOnly) fail('STATE_READ_UNSAFE', unsafe);
      const access = () => {
        const current = this.access(actor, plan, connectionId);
        new ScopeGuard(this.registry, this.store).authorize(request, current);
        if (binding) {
          const value = binding.value(this.store.credentials(actor.tenantId, current.id));
          if (value === undefined || (bound !== undefined && value !== bound)) binding.changed();
        }
        return current;
      };
      const c = access(),
        auth = await this.credentials.get(c);
      if (binding) {
        const value = binding.value(auth);
        if (value === undefined) binding.changed();
        bound ??= value;
      }
      access();
      const response = await this.request(actor, plan, request, c, auth);
      access();
      return response;
    };
    return {read, bound: () => bound!};
  }
  /**
   * A write that sends data about people (src/personal-data.ts): the people are hashed in memory and the
   * confirmations checked; the plan keeps only their counts, digest and confirmations, with a body that carries no
   * rows. Other writes take neither people nor personal_data.
   */
  private people(plan: CompiledRequest, input: JsonObject, inspecting = false): void {
    const spec = familyOf(plan)?.personalData,
      direction = spec?.direction(plan);
    if (!spec || !direction) {
      if (input.people !== undefined || input.personal_data !== undefined)
        fail(
          'INVALID_ARGUMENT',
          'people and personal_data are only for a write that sends data about people, such as a customer list.',
        );
      return;
    }
    const body = plan.body;
    // A POST without payload compiles to an empty body. A family with settings takes them from it, checked; no other
    // payload is accepted, so people cannot reach a request any other way.
    const settings = spec.settings?.(plan, direction);
    if (
      !spec.settings &&
      body !== undefined &&
      !(body && typeof body === 'object' && !Array.isArray(body) && !Object.keys(body).length)
    )
      fail(
        'INVALID_ARGUMENT',
        'Send the people in people, beside arguments: AMCP builds the request body from them. Remove payload.',
      );
    const batch = hashPeople(input.people, spec, direction, inspecting ? null : Date.now()),
      terms = confirmations(input.personal_data, direction, spec.platform);
    plan.personalData = {...batch.record, ...(settings ? {settings} : {}), ...(terms ? {confirmations: terms} : {})};
    plan.body = spec.body(plan, []);
  }
  /** The outcome as the caller receives it; a family may attach what it retained, such as a preview's receipt. */
  private delivered(plan: CompiledRequest, outcome: JsonObject, tenantId: string, reviewId: string): JsonObject {
    const deliver = familyOf(plan)?.deliver;
    return deliver ? deliver(plan, outcome, {store: this.store, tenantId, reviewId}) : outcome;
  }
  private async state(
    actor: Actor,
    plan: CompiledRequest,
    connectionId: string,
    reads: CompiledRequest[],
  ): Promise<unknown[]> {
    const family = familyOf(plan);
    if (family?.state)
      return family.state(plan, {
        guarded: (unsafe, binding) => this.guardedReader(actor, plan, connectionId, unsafe, binding),
        sameLogin,
      });
    // The provider's parts of the state, where the review named it (src/<provider>-adapter.ts `writes`).
    const writes = reviewHooks(plan.gateway),
      ownState = writes?.ownState;
    // A write whose state is its first read and what its provider reads itself (a Meta creative's identity).
    if (ownState?.claims(plan)) {
      const read = reads[0]!,
        access = () => this.access(actor, plan, connectionId),
        c = access();
      new ScopeGuard(this.registry, this.store).authorize(read, c);
      const auth = await this.credentials.get(c);
      access();
      const result = await this.request(actor, plan, read, c, auth);
      access();
      validateState(read, result);
      return [
        normalizeSnapshot(read, result.data),
        await ownState.state(plan, {
          store: this.store,
          transport: this.transport,
          credentials: this.credentials,
          actor,
          access,
        }),
      ];
    }
    const values: unknown[] = [];
    for (const read of reads) {
      if (!applyExecutionRisk(read).readOnly)
        fail('STATE_READ_UNSAFE', 'The state check must be independently read-only.');
      const c = this.access(actor, plan, connectionId);
      new ScopeGuard(this.registry, this.store).authorize(read, c);
      const auth = await this.credentials.get(c);
      this.access(actor, plan, connectionId);
      let result: TransportResult;
      try {
        result = await readThroughFamilies(read, async page => {
          const current = this.access(actor, plan, connectionId);
          new ScopeGuard(this.registry, this.store).authorize(page, current);
          const response = await this.request(actor, plan, page, current, auth);
          this.access(actor, plan, connectionId);
          return response;
        });
      } catch (e) {
        const absent = optionalMissingState(read, e);
        if (!absent) throw e;
        result = absent;
      }
      const reader = this.access(actor, plan, connectionId);
      validateState(read, result);
      // A provider that learns ownership from each of its state reads (Snapchat).
      if (reviewHooks(read.gateway)?.observeState)
        new ScopeGuard(this.registry, this.store).observe(read, reader, result.data);
      // A family may read more once a read names what it depends on (a Smart+ bid edit: the campaign's ad groups).
      for (const more of familyOf(plan)?.followUps?.(plan, read, result.data) ?? [])
        if (!reads.some(r => r.path === more.path && stable(r.query) === stable(more.query))) reads.push(more);
      // So may the write's provider (an ad's Snapchat lead form, after its creative).
      for (const more of writes?.dependentReads?.(plan, read, result.data) ?? [])
        if (!reads.some(r => r.path === more.path && stable(r.query) === stable(more.query))) reads.push(more);
      // An active ad under a serving ad squad, ad set or ad group also reads the campaign its parent names.
      const campaign = pausedParentFollowUp(plan, read, result.data);
      if (campaign && !reads.some(r => r.path === campaign.path && stable(r.query) === stable(campaign.query)))
        reads.push(campaign);
      // A read whose first page names how many more to read (TikTok's Instant Forms, which cannot be read by ID).
      for (const more of reviewHooks(read.gateway)?.morePages?.(read, result.data) ?? [])
        if (!reads.some(r => r.path === more.path && stable(r.query) === stable(more.query))) reads.push(more);
      // A write that changes other accounts binds each one its read shows, and reads them (Apple's shared budget).
      writes?.sharedState?.(plan, read, result.data, {
        bind: account => {
          const current = this.store.resolveConnection(actor, plan.gateway, account, connectionId);
          assertAccountWrite(this.store, current, account);
        },
        reads,
      });
      const own = familyOf(plan)?.snapshotValue?.(plan, read, object(result.data));
      values.push(own !== undefined ? own : normalizeSnapshot(read, result.data));
    }
    familyOf(plan)?.prerequisites?.(plan, values, reads);
    // The provider's prerequisites (Snapchat's creatives; TikTok's conversions, CTA portfolios and identities; Apple's
    // shared organization; Google's targeting and paused parents), then the paused-parent check, then the provider's
    // checks after it (Meta's ad set audience choice, X's paused line item).
    writes?.prerequisites?.(plan, values, reads);
    validatePausedParents(plan, values);
    writes?.parentChecks?.(plan, values);
    return values;
  }
  /**
   * What already exists of what a create would make (R2.5 M2, lead re-review N3). A provider whose objects carry no creation time and
   * refuses a duplicate name (Google Ads) has its lookup read, at prepare, the live objects of the frozen names under the frozen
   * parents, one search per kind, and the review keeps their IDs: only an object that is not among them can be this write's, because an
   * older object of the name is exactly why such a create fails. A read that fails is raised as for any state read (lead re-review 2, F2):
   * the prepare is refused with that read's own code, retryable when it is, and nothing is prepared or stored, because a review prepared
   * without the list could never tell its own object from an older one of the name. A list that was read but is not whole (a page
   * limit) is kept as such, and the lookup then calls none of its matches this write's. Undefined for any other write.
   */
  private async freezeExisting(
    actor: Actor,
    plan: CompiledRequest,
    connectionId: string,
  ): Promise<{ids: string[]; whole: boolean} | undefined> {
    const lookup = findCreated(plan);
    if (!lookup?.existing) return undefined;
    const {read} = this.guardedReader(actor, plan, connectionId, 'The read of what already exists must be read-only.');
    const responses: TransportResult[] = [];
    for (const request of lookup.reads) responses.push(await read(request));
    return lookup.existing(responses);
  }
  /**
   * The provider validates the reviewed request without applying it (provider_check, WRT-06): through the review's own
   * connection, its authority checks and same-login binding, audited before it is sent. Never claims or reserves.
   *
   * `byDefault` (R2.5 M3, L2-12): nobody asked for it, the deployment's policy did. Then a check that cannot run (the provider
   * did not answer, or answered that it could not be asked now: `defaultCheckUnavailable`) does not refuse the prepare: it comes
   * to `not_run` with the error's code, and the review is prepared without the check. A rejection of the request is still
   * returned as it always was, and an AMCP authority refusal is still raised. An explicit check raises every failure.
   */
  private async providerCheck(
    actor: Actor,
    plan: CompiledRequest,
    connectionId: string,
    reviewId: string,
    byDefault = false,
  ): Promise<ProviderCheck> {
    const request = providerValidationRequest(plan)!,
      c = this.access(actor, plan, connectionId),
      auth = await this.credentials.get(c);
    this.access(actor, plan, connectionId);
    const subject = {
      gateway: plan.gateway,
      account_id: plan.accountId ?? null,
      connection_id: c.id,
      action: plan.action,
    };
    this.store.appendAudit(actor.tenantId, reviewId, {event: 'provider_validation_started', ...subject});
    let check: ProviderCheck;
    try {
      check = await runProviderValidation(plan, request, () => this.request(actor, plan, request, c, auth));
    } catch (e) {
      if (!byDefault || !defaultCheckUnavailable(e)) throw e;
      check = {
        status: 'not_run',
        checked_at: Date.now(),
        reason: e.code,
        ...(typeof e.details.http_status === 'number' ? {http_status: e.details.http_status} : {}),
      };
    }
    this.access(actor, plan, connectionId);
    this.store.appendAudit(actor.tenantId, reviewId, {
      event:
        check.status === 'provider_validated'
          ? 'provider_validated'
          : check.status === 'not_run'
            ? 'provider_validation_not_run'
            : 'provider_validation_failed',
      ...subject,
      ...(check.status === 'provider_rejected' ? {field_paths: check.field_paths} : {}),
      ...(check.status === 'not_run' ? {reason: check.reason} : {}),
    });
    return byDefault ? {...check, default: true} : check;
  }
  /**
   * The ads a creative edit changes, read by its provider (Snapchat's `writes.affectedAds`) through the review's guarded
   * reader. A provider failure of this disclosure read leaves the list unknown (null, incomplete) instead of refusing
   * the review; an authority failure (access, grants, login) is raised as for any state read.
   */
  private async affectedAds(
    actor: Actor,
    plan: CompiledRequest,
    connectionId: string,
    creativeIds: unknown[],
    affected: NonNullable<WriteReviewHooks['affectedAds']>,
  ): Promise<JsonObject> {
    const {read} = this.guardedReader(
      actor,
      plan,
      connectionId,
      'The affected-ads read of a creative review must be read-only.',
    );
    return affected(plan, creativeIds, read, stateRead);
  }
  /**
   * What a group checks for every part before its first part is sent (WRT-04): the review's owner, request shape,
   * access and grants, and the acknowledgements its execute will ask for. Sends nothing and claims nothing.
   */
  admit(actor: Actor, reviewId: string, flags: JsonObject): {plan: CompiledRequest; state: unknown; expiresAt: number} {
    const review = this.store.document(actor.tenantId, 'write_review', reviewId);
    if (review.user_id !== actor.userId)
      throw new MirrorError('FORBIDDEN', 'The review belongs to a different actor.', {}, 403);
    const plan = review.plan as CompiledRequest;
    assertWriteShape(plan);
    rejectedByProvider(review);
    this.access(actor, plan, review.connection_id);
    // The state the part froze, as its own execute reads it first: a part of children under a parent that read PAUSED asks for nothing here
    // that it will not ask for itself (R2.5 field fix r25-field-pausedspend); the part's execute still reads the state again.
    authorizeExecution(
      actor,
      plan,
      {...flags, confirmed: true, idempotency_key: reviewId, dry_run: false},
      this.policy,
      true,
      review.state,
    );
    if (review.creative_edit_confirmed === true && flags.creative_edit_confirmed !== true)
      fail(
        'CREATIVE_EDIT_CONFIRMATION_REQUIRED',
        'This review permits a potentially destructive creative edit. Also provide creative_edit_confirmed=true to execute.',
      );
    // WRT-09: a part needs the destructive tier's acknowledgement and its group's website approval like a review.
    assertExecutionApproval(this.store, actor, review, reviewId, flags);
    return {plan, state: review.state, expiresAt: review.expires_at};
  }
  /** A retained review's read-only reconciliation (WRT-08 Stage B), through this service's own guarded reads. */
  private reconciler() {
    return new WriteReconciler(this.store, this.registry, this.transport, this.credentials, this.policy);
  }
  /**
   * `evidenceDefault` is the evidence form of a caller that sent none: see ContractMemory. `origin` is who prepares:
   * the person directly (a retained standalone record, WRT-08), a campaign plan's step, or a group's part.
   */
  async call(
    input: JsonObject,
    actor: Actor,
    evidenceDefault?: EvidenceForm,
    origin: WriteOrigin = 'standalone',
  ): Promise<unknown> {
    guardInput(input);
    for (const key of Object.keys(input))
      if (!Object.hasOwn(writeTool.inputSchema.properties, key))
        fail('INVALID_ARGUMENT', 'Unknown write-tool parameter.', {parameter: key});
    // ARC-04 stage D: each action is an entry of an action table (src/tool-actions.ts), consulted in the order of the
    // checks the if-chain ran between them: a retained review read back or reconciled, which takes only its own
    // arguments; after the argument checks and the evidence form, prepare and inspect; then execute, the one action
    // left, which names its review. An action in no table is refused with the chain's sentence.
    const retained = actionHandler(this.retainedActions, input.action);
    if (retained) return retained({input, actor});
    for (const key of ['accept_applied', 'reconciliation_id'])
      if (input[key] !== undefined) fail('INVALID_ARGUMENT', key + ' is for reconcile.', {field: key});
    if (input.supersedes_review_id !== undefined && input.action !== 'prepare')
      fail('INVALID_ARGUMENT', 'supersedes_review_id is for prepare.', {field: 'supersedes_review_id'});
    if (input.creative_edit_confirmed !== undefined && typeof input.creative_edit_confirmed !== 'boolean')
      fail('INVALID_ARGUMENT', 'creative_edit_confirmed must be a boolean.');
    if (input.provider_check !== undefined && (typeof input.provider_check !== 'boolean' || input.action !== 'prepare'))
      fail(
        'INVALID_ARGUMENT',
        // T2 (R25 M1): at execute it is not a flag to pass. It asks the provider to validate, and never skips AMCP's check.
        // Every other refusal of it keeps the sentence it always had (inspect and the rest are no place to meet a state check).
        input.action === 'execute'
          ? 'provider_check is an argument of prepare only: it asks the provider to validate a request without applying it. It does not skip AMCP’s state check, which no flag skips.'
          : 'provider_check is a boolean that prepare takes.',
        {field: 'provider_check'},
      );
    if (
      input.destructive_confirmed !== undefined &&
      (typeof input.destructive_confirmed !== 'boolean' || input.action !== 'execute')
    )
      fail('INVALID_ARGUMENT', 'destructive_confirmed is a boolean that execute takes.', {
        field: 'destructive_confirmed',
      });
    const evidence = input.evidence === undefined ? (evidenceDefault ?? 'full') : evidenceForm(input.evidence);
    const reviewing = actionHandler(this.reviewActions, input.action);
    if (reviewing) return reviewing({input, actor, evidence, origin});
    if (input.action !== 'execute' || typeof input.review_id !== 'string')
      fail('INVALID_ARGUMENT', 'Use prepare or execute with a review_id.');
    return this.executeReview({input, actor, origin});
  }
  /** A retained review read back or reconciled (WRT-08), and the review a person prepares or inspects. */
  private readonly retainedActions: ActionTable<ToolContext> = {
    status: call => this.retainedReview(call),
    reconcile: call => this.retainedReview(call),
  };
  private readonly reviewActions: ActionTable<ReviewPreparation> = {
    prepare: call => this.prepareReview(call),
    inspect: call => this.prepareReview(call),
  };
  /** status and reconcile: a retained review read back by AMCP alone, or reconciled with read-only provider lookups. */
  private async retainedReview({input, actor}: ToolContext): Promise<unknown> {
    const accepted =
      input.action === 'status'
        ? ['action', 'review_id']
        : ['action', 'review_id', 'accept_applied', 'reconciliation_id'];
    for (const key of Object.keys(input))
      if (!accepted.includes(key))
        fail('INVALID_ARGUMENT', input.action + ' takes ' + accepted.join(', ') + '.', {field: key, accepted});
    if (input.action === 'status') {
      this.liftEndedSeal(actor, input.review_id);
      return writeStatus(this.store, actor, input.review_id);
    }
    return this.reconciler().call(input, actor);
  }
  /**
   * The old review's automatic check is queued again once a supersede of it was lifted (R2.5 M2, lead re-review N4), as the person
   * who lifts it (bindJobActor is sealed to the review the job is for). A reader cannot run a check, and a check that cannot be queued
   * never changes what the caller is told: the audit row of the lift says whether one was.
   */
  private requeueCheck(actor: Actor, oldId: string): boolean {
    if (actor.role === 'reader') return false;
    try {
      queueReconcile(this.store, actor.tenantId, oldId, this.store.bindJobActor(actor, oldId));
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Lifts the seal a replacement review put on an uncertain write, in the transaction that rejects that replacement (lead re-review N4):
   * the old review is reconcilable and acceptable again, and its check is queued again. A release of the replacement's claim lifts nothing.
   */
  private liftRejectedSeal(actor: Actor, review: JsonObject, replacementId: string) {
    const old = review.supersedes_uncertain;
    if (typeof old === 'string' && old)
      liftSupersede(this.store, actor.tenantId, old, replacementId, 'rejected', () => this.requeueCheck(actor, old));
  }
  /**
   * A status finds a seal whose replacement expired without a claim (lead re-review N4) and lifts it, before the record is read: the
   * review is uncertain again, and its check is queued again. Only a reader of that review lifts it (the access check is the status').
   */
  private liftEndedSeal(actor: Actor, reviewId: unknown) {
    const {review, group} = retainedReview(this.store, actor, reviewId);
    if (group) return;
    const id = review.id as string,
      ended = endedSeal(this.store, actor.tenantId, id);
    if (ended)
      liftSupersede(this.store, actor.tenantId, id, ended.replacement, ended.why, () => this.requeueCheck(actor, id));
  }
  /** prepare and inspect: the reviewed request, its current state and what executing it needs, frozen as a review. */
  private async prepareReview({input, actor, evidence, origin}: ReviewPreparation): Promise<unknown> {
    if (
      typeof input.gateway !== 'string' ||
      !input.arguments ||
      typeof input.arguments !== 'object' ||
      Array.isArray(input.arguments)
    )
      fail('INVALID_ARGUMENT', 'prepare requires gateway and arguments.');
    const isDelegated = this.registry.tools.get(input.gateway)?.mode === 'delegated',
      // A near-miss action name (T7, src/action-aliases.ts) is prepared as the canonical action it stands for, before
      // anything reads the name: the review, the stored prepare input and the calls that re-send it name the canonical
      // action, and every gate that decides on the action decides on the one its canonical name reaches. The caller is
      // told of the alias in the response (MirrorService.actionAliasWarnings).
      alias =
        !isDelegated && typeof input.arguments.action === 'string'
          ? this.registry.resolveAction(input.gateway, input.arguments.action).alias
          : undefined,
      given: JsonObject = alias ? {...input.arguments, action: alias.canonical} : input.arguments,
      nativeArgs = isDelegated ? object(given.arguments) : given;
    if (['aggregate_pages', 'paginate', 'allPages'].some(k => given[k] || nativeArgs[k]))
      fail('MUTATION_PAGINATION_FORBIDDEN', 'A reviewed mutation executes exactly one request.');
    // Enhanced-mode native_request lets the caller choose the action and the path independently, and several families
    // classify by action; a reviewed mutation must come from a catalog action whose route the compiler derived.
    if (given.native_request !== undefined || nativeArgs.native_request !== undefined)
      fail(
        'WRITE_CONTRACT_UNAVAILABLE',
        'Reviewed writes use catalog actions. native_request is a read-only extension; name the catalog action and its params instead.',
      );
    const args = isDelegated ? {...given} : {...given, dry_run: true};
    this.registry.validate(input.gateway, args, this.options);
    const unavailable = unsupportedProviderAlias(input.gateway, nativeArgs.action);
    if (input.action === 'inspect' && unavailable) {
      const e = new MirrorError('PROVIDER_ACTION_UNSUPPORTED', unavailable.reason, unavailable),
        remedy = errorRemedy(e);
      return {
        executed: false,
        network_requests: 0,
        review_contract_supported: false,
        request: null,
        error: {code: e.code, message: preciseMessage(e), details: e.details, category: remedy.category, remedy},
        live_permissions_verified: false,
        next_step: unavailable.replacement,
      };
    }
    const plan = applyExecutionRisk(
      isDelegated
        ? this.delegated.compile(input.gateway, args)
        : this.compiler.compile(input.gateway, args, this.options),
    );
    if (input.connection_id && nativeArgs.connection_id && input.connection_id !== nativeArgs.connection_id)
      fail('CONFLICTING_PARAMETER', 'Connection IDs must agree.');
    if (input.action === 'inspect') {
      let accountCapability: JsonObject;
      try {
        const c = this.store.resolveConnection(
          actor,
          plan.gateway,
          plan.accountId,
          input.connection_id ?? nativeArgs.connection_id,
        );
        // The grant is compared as enforcement compares it, normalized (Google dashes, Meta act_), MCP-09.
        accountCapability = {
          connection_id: c.id,
          account_id: plan.accountId ? normalizeAccount(plan.gateway, plan.accountId) : plan.accountId,
          selected: true,
          write_granted: plan.accountId ? accountWriteGranted(c, plan.accountId) : false,
          granted_scopes: c.scopes,
          provider_access: 'requires live preparation',
        };
      } catch (e) {
        accountCapability = {
          selected: false,
          error: e instanceof MirrorError ? {code: e.code, message: e.message} : undefined,
        };
      }
      try {
        this.people(plan, input, true);
        assertLocatedShape(plan);
        familyOf(plan)?.available?.(plan);
        const reads = snapshotPlans(plan, this.registry),
          // MSR-03: an offline conversion upload also gets its local rehearsal; nothing is sent or reviewed. A plan whose
          // family has no personal-data spec has no rehearsal, so this contract check never throws for it.
          personalSpec = familyOf(plan)?.personalData,
          rehearsal =
            plan.personalData && personalSpec ? offlineUploadRehearsal(plan, personalSpec, input.people) : undefined;
        return {
          executed: false,
          network_requests: 0,
          review_contract_supported: true,
          ...reviewedRequest(plan),
          contract_evidence: executionEvidence(plan, evidence),
          state_reads: reads.map(r => ({method: r.method, path: r.path})),
          live_permissions_verified: false,
          account_capability: accountCapability,
          provider_check_available: providerValidationRequest(plan) !== undefined,
          // T2 (R25 M1): a request with no provider check says why, and that this is not AMCP's own state check.
          ...(providerValidationRequest(plan) === undefined ? {provider_check_reason: providerCheckUnavailable} : {}),
          // The request's effect class (src/effect-class.ts, RPT-06).
          effect: effectClass(plan),
          requirements: {
            deployment_writes_enabled: this.policy.allowWrites,
            operator_role: actor.role !== 'reader',
            account_write_grant_required: !switchedProviderJob(plan, this.policy),
            ...(reviewedProviderJob(plan)
              ? {
                  provider_jobs_switch: this.policy.providerJobs === true ? 'on' : 'off',
                  provider_job_authority:
                    this.policy.providerJobs === true
                      ? 'The account’s report-job grant, or while live writes are on an operator’s account write grant.'
                      : 'A reviewed write: live writes on, an operator role and the account’s write grant.',
                }
              : {}),
            ...(familyOf(plan)?.administratorRequired
              ? {
                  administrator_role_required: true,
                  administrator_role: actor.role === 'admin' && actor.testAccount !== true,
                }
              : {}),
            ...(plan.personalData
              ? {
                  personal_data_switch: 'The workspace owner turns personal-data writes on for the ad account.',
                  ...(plan.personalData.direction === 'add'
                    ? {owner_executes: 'Only the workspace owner executes an upload of people.'}
                    : {}),
                }
              : {}),
          },
          ...(rehearsal ? {offline_upload_rehearsal: rehearsal} : {}),
          next_step: 'Use prepare to verify live state and account access.',
        };
      } catch (e) {
        if (!(e instanceof MirrorError)) throw e;
        const remedy = errorRemedy(e);
        return {
          executed: false,
          network_requests: 0,
          review_contract_supported: false,
          ...reviewedRequest(plan),
          contract_evidence: executionEvidence(plan, evidence),
          error: {code: e.code, message: preciseMessage(e), details: e.details, category: remedy.category, remedy},
          live_permissions_verified: false,
        };
      }
    }
    // The caller's request, as sent, before anything could change its body (a provider's deduplication key, the `dedupeBody` below):
    // the guard against creating twice compares the identity stored with each review, never the body of a stored plan
    // (R2.5 M2, lead re-review 2, merge join 4). It is computed here, before `dedupeBody` sets `plan.body`, and stored as
    // `request_identity` further down.
    const identity = requestIdentity(plan);
    // R2.5 M2 (L1-09, Q16): a provider that declares `dedupeBody` takes the deduplication key of its own now, from the review's ID,
    // which exists before anything is read. No provider declares it (the lead's review S1-1: TikTok's was removed, because a key
    // per review switches off TikTok's own same-name refusal), so every body is still the caller's. A key would go into a body of its
    // own, so the caller's arguments (which prepare_input keeps, and a later prepare starts from) stay as sent; the shape and state
    // stages and the summary see the request that will be sent, and the fingerprint below covers it.
    const reviewId = randomUUID(),
      deduped = reviewHooks(plan.gateway)?.dedupeBody?.(plan, reviewId);
    if (deduped) plan.body = deduped;
    this.people(plan, input);
    assertLocatedShape(plan);
    familyOf(plan)?.available?.(plan);
    const c = this.access(actor, plan, input.connection_id ?? nativeArgs.connection_id);
    // A review named here that was never sent holds no claim and needs no replacement: the prepare goes on and says it ignored it
    // (r25-field-tiktok, #13). Any other is a replacement of an uncertain review that a reconciliation found not applied (WRT-08 Stage B).
    const ignored =
        input.supersedes_review_id !== undefined
          ? this.reconciler().neverSent(actor, input.supersedes_review_id, plan, c.id)
          : undefined,
      supersedes =
        input.supersedes_review_id !== undefined && !ignored
          ? this.reconciler().replaceable(actor, input.supersedes_review_id, plan, c.id)
          : undefined;
    // A create identical to one that is uncertain or still being sent is not prepared again: it could make a second object.
    // The review it replaces is the one exception, and one that completed in the last ten minutes only warns (R2.5 M2, L5-06).
    const earlier = createsObjects(plan) ? earlierCreates(this.store, actor, plan, identity, [supersedes]) : undefined;
    if (earlier?.unresolved.length) refuseRepeatedCreate(earlier.unresolved);
    if (input.provider_check === true && !providerValidationRequest(plan))
      fail('INVALID_ARGUMENT', 'provider_check is available for ' + providerValidationScope + '.', {
        field: 'provider_check',
      });
    if (plan.personalData)
      assertPersonalDataAllowed(this.store, actor, plan, (plan.personalData as PersonalDataRecord).direction, false);
    const reads = snapshotPlans(plan, this.registry),
      state = await this.state(actor, plan, c.id, reads);
    familyOf(plan)?.stateChecks?.(plan, state, true);
    // The concurrency token a route takes from the state, unless the family owns it (Tag Manager's fingerprint).
    if (!familyOf(plan)?.ownsConcurrency)
      reviewHooks(plan.gateway)?.concurrency?.(plan, state, this.delegated.data.routes);
    if (input.creative_edit_confirmed !== undefined && !familyOf(plan)?.creativeEditConfirmation?.(plan))
      fail(
        'INVALID_ARGUMENT',
        'creative_edit_confirmed is only for an X creative edit or deletion, or a TikTok Smart+ ad edit.',
      );
    const creativeImpact = writeImpact(plan, state, input.creative_edit_confirmed === true, c.id);
    // A creative edit changes every ad that uses the creative: its provider names them, from a bounded read (WRT-05;
    // Snapchat's, whose impact lists the creatives and leaves the ads to this read).
    const affected =
      typeof creativeImpact?.provider === 'string'
        ? reviewHooks(providerById(creativeImpact.provider)?.gateway)?.affectedAds
        : undefined;
    if (
      affected &&
      creativeImpact &&
      creativeImpact.affected_ad_ids === null &&
      Array.isArray(creativeImpact.affected_creative_ids)
    )
      Object.assign(
        creativeImpact,
        await this.affectedAds(actor, plan, c.id, creativeImpact.affected_creative_ids, affected),
      );
    // The provider's resources the state names must be the account's (Snapchat's creative references).
    reviewHooks(plan.gateway)?.ownedReferences?.(plan, state, resource =>
      this.store.ownsResource(c, normalizeAccount(plan.gateway, plan.accountId!), resource),
    );
    const override = input.creative_edit_confirmed === true ? {creative_edit_confirmed: true} : {};
    // What already exists of what a create would make, frozen with the review (R2.5 M2, lead re-review N3).
    const existing = await this.freezeExisting(actor, plan, c.id);
    const fingerprint = sha256(
        stable({tenant: actor.tenantId, user: actor.userId, connection: c.id, plan, ...override}),
      ),
      expiresAt = Date.now() + 300000;
    // WRT-09 (P5's opt-in tier): a deletion on an account whose owner turned the destructive_confirmed tier on.
    const destructive = destructiveRequest(plan, state),
      destructiveTier =
        destructive &&
        reviewApprovalPolicy(this.store, actor.tenantId, plan.gateway, plan.accountId ?? '')
          .require_destructive_confirmation;
    const stateHash = reviewStateHash(state, reviewVolatile(plan.gateway)),
      spendPolicy = checkSpendPolicy(this.store, actor, plan, state),
      requirements = executeRequirements(
        actor,
        plan,
        this.policy,
        reviewId,
        input.creative_edit_confirmed === true,
        exceededCaps(spendPolicy),
        destructiveTier,
        state,
      );
    if (plan.personalData)
      Object.assign(requirements, {
        people: 'Send the same people again in people: the review kept only their count and digest.',
        ...(plan.personalData.direction === 'add'
          ? {
              owner_executes:
                'Only the workspace owner executes an upload of people: an operator prepares it, and the owner approves it by executing.',
            }
          : {}),
      });
    // Deletions, live publishes and stopped delivery are named, with the target's current status (WRT-05).
    const effects = writeEffects(plan, state);
    if (effects) {
      const flagged = requirements.reasons.length > 0;
      requirements.effects = effects;
      requirements.reasons = [...requirements.reasons, ...effectReasons(plan, state, effects)];
      requirements.user_approval =
        'This change ' +
        effectNames(effects).join(', ') +
        '. Show the user the target, its current status and the reasons' +
        (flagged ? ', set the flags only after they approve,' : '') +
        ' and execute only after they approve.';
    }
    // R2.5 M3, L2-12 (the lead's decision on Q2, 2026-11-17): the provider's validate-only check also runs when the call says nothing
    // about it, the deployment's policy turns the default on and the provider declares it (Google Ads), and not when the call sends
    // `provider_check: false`. This module names no provider: the declaration is the provider's (`validation.byDefault`).
    const checkByDefault =
        input.provider_check === undefined &&
        this.policy.providerCheckByDefault === true &&
        providerValidatesByDefault(plan),
      providerCheck =
        input.provider_check === true || checkByDefault
          ? await this.providerCheck(actor, plan, c.id, reviewId, checkByDefault)
          : undefined;
    const acknowledgements = Object.keys(requirements).filter(k => requirements[k] === true && k !== 'confirmed'),
      // WRT-09: the owner's approval mode or the owner-only cap override (P5) names the website approval it needs.
      approval = approvalNotice(this.store, actor, plan, reviewId, acknowledgements, destructive);
    this.store.putDocument(actor.tenantId, 'write_review', reviewId, {
      user_id: actor.userId,
      // The person (MCP-02) and who prepared it: a standalone review is retained work in Operations (WRT-08).
      principal: principalOf(actor),
      origin,
      created_at: Date.now(),
      connection_id: c.id,
      plan,
      // The identity of the caller's request, taken before anything could change the plan's body: what the guard against creating
      // twice compares, for this review and for the later ones (src/write-duplicates.ts `identityOf`; lead re-review 2, merge join 4).
      request_identity: identity,
      reads,
      state,
      state_hash: stateHash,
      fingerprint,
      expires_at: expiresAt,
      required_acknowledgements: acknowledgements,
      // What a person approving on the website is shown (WRT-09): the reasons and effects, never the request body.
      approval_context: {reasons: requirements.reasons, effects: effects ?? null},
      ...(supersedes ? {supersedes_uncertain: supersedes} : {}),
      ...(existing ? {existing} : {}),
      // What the person was shown at prepare: execute refuses once, with this review's own code, an identical create that
      // completed after it was prepared (src/write-duplicates.ts assertCreateNotRepeated). The warning covers the identical creates it
      // named: `duplicate_twins` keeps their review IDs (never shown: a colleague's review is not named), so that execute refuses one
      // that completed since (lead re-review N9).
      ...(earlier?.completed.length
        ? {
            duplicate_warning: repeatedCreateWarning(earlier.completed),
            duplicate_twins: earlier.completed.map(twin => twin.id).sort(),
          }
        : {}),
      ...override,
      ...(providerCheck ? {provider_check: providerCheck} : {}),
      prepare_input: {
        gateway: input.gateway,
        arguments: given,
        ...(input.connection_id !== undefined ? {connection_id: input.connection_id} : {}),
        ...(input.creative_edit_confirmed === true ? {creative_edit_confirmed: true} : {}),
        ...(input.evidence !== undefined ? {evidence: input.evidence} : {}),
        ...(input.personal_data !== undefined ? {personal_data: input.personal_data} : {}),
        // What the caller said of the check, either way: a re-prepare of an expired review keeps an opt-out (R2.5 M3, L2-12), and a
        // caller who said nothing is asked for nothing, so the default applies to the re-prepare as it did to the first.
        ...(typeof input.provider_check === 'boolean' ? {provider_check: input.provider_check} : {}),
      },
    });
    // PRV-05 shadow mode: a body that differs from its pinned vendor contract is recorded with the review.
    const wire = wireContractCheck(plan);
    this.store.appendAudit(actor.tenantId, reviewId, {
      event: 'write_prepared',
      request: plan,
      fingerprint,
      expires_at: expiresAt,
      ...(wire?.status === 'violations' || wire?.status === 'check_failed' ? {wire_contract: wire} : {}),
    });
    if (supersedes) this.reconciler().supersede(actor, supersedes, reviewId);
    return {
      success: true,
      executed: false,
      review_id: reviewId,
      idempotency_key: reviewId,
      expires_at: new Date(expiresAt).toISOString(),
      ...reviewedPrepare(plan, state),
      contract_evidence: executionEvidence(plan, evidence),
      spend_policy: spendPolicy,
      state_hash: stateHash,
      state_reads: reads.map(r => ({method: r.method, path: r.path})),
      fingerprint,
      confirmation_required: true,
      expires_in_seconds: 300,
      execute_requirements: requirements,
      ...(approval ? {approval} : {}),
      ...(supersedes ? {supersedes_uncertain: supersedes} : {}),
      ...(ignored ? {supersedes_ignored: ignored} : {}),
      ...(earlier?.completed.length ? {duplicate_warning: repeatedCreateWarning(earlier.completed)} : {}),
      summary: reviewSummary(plan, state),
      effect: effectClass(plan, state),
      ...(effects ? {effects} : {}),
      ...(creativeImpact ? {creative_impact: creativeImpact} : {}),
      ...(providerCheck
        ? {
            provider_check: {
              ...providerCheck,
              meaning:
                providerCheck.status === 'provider_validated'
                  ? 'The provider checked this request without applying it and found no error. It does not prove execute will succeed; execute still reads the state again.'
                  : providerCheck.status === 'not_run'
                    ? // R2.5 M3 round 2, S4-1: a refusal of the login or the route is not what a later prepare gets past.
                      checkRefusedForAccess(providerCheck)
                      ? 'The provider refused the validation request for this login or route (reason is the error code), so the review is prepared without that check. Nothing was rejected and nothing was applied. Preparing again will not help: execute will be refused the same way unless the access changes (the login’s permission for this account, or the route).'
                      : 'The provider could not be asked to validate this request just now (reason is the error code), so the review is prepared without that check. Nothing was rejected and nothing was applied. Prepare again to try the check again; execute still reads the state again, and the provider may still refuse the write.'
                    : 'The provider rejected this request without applying it. This review cannot be executed: correct what field_paths and the response name, and prepare it again.',
            },
          }
        : {}),
    };
  }
  /** execute: the frozen review, after its owner, binding, integrity, approvals and window are checked, sent once. */
  private async executeReview({input, actor, origin}: ReviewExecution): Promise<unknown> {
    // The idempotency key is the review id; asking the client to repeat it protected nothing. A supplied key must still match.
    if (input.idempotency_key === undefined) input = {...input, idempotency_key: input.review_id};
    if (input.arguments !== undefined)
      fail(
        'INVALID_ARGUMENT',
        'Remove arguments: execute takes review_id, idempotency_key, confirmed and, when execute_requirements lists them, spend_change_confirmed, cap_override_confirmed, creative_edit_confirmed or destructive_confirmed. The request was frozen at prepare; prepare a new review to change it.',
        {field: 'arguments', accepted: executeFields},
      );
    if (input.personal_data !== undefined)
      fail(
        'INVALID_ARGUMENT',
        'Remove personal_data: the confirmations were frozen at prepare. Execute takes the same people again in people.',
        {field: 'personal_data', accepted: executeFields},
      );
    const review = this.store.document(actor.tenantId, 'write_review', input.review_id);
    // An upload of people is prepared by an operator and approved by the owner executing it (personal-data policy,
    // rule 3): the workspace owner may execute a personal-data review another member prepared. Likewise a review beyond
    // a spending cap, which only the owner executes (WRT-09, owner decision P5). No other review moves.
    if (
      review.user_id !== actor.userId &&
      !(
        (review.plan?.personalData || review.required_acknowledgements?.includes?.('cap_override_confirmed')) &&
        workspaceOwner(this.store, actor)
      )
    )
      throw new MirrorError('FORBIDDEN', 'The review belongs to a different actor.', {}, 403);
    const plan = review.plan as CompiledRequest;
    assertWriteShape(plan);
    rejectedByProvider(review);
    // Repeating the review's own gateway/connection is harmless; a different one would silently change the request.
    if (
      (input.gateway !== undefined && input.gateway !== plan.gateway) ||
      (input.connection_id !== undefined && input.connection_id !== review.connection_id)
    )
      fail(
        'INVALID_ARGUMENT',
        'This review is bound to gateway ' +
          plan.gateway +
          ' and connection ' +
          review.connection_id +
          '; the ' +
          (input.gateway !== undefined && input.gateway !== plan.gateway ? 'gateway' : 'connection_id') +
          ' sent differs. Omit gateway and connection_id (repeating the same ones is accepted), or prepare a new review to use another.',
        {
          field: input.gateway !== undefined && input.gateway !== plan.gateway ? 'gateway' : 'connection_id',
          gateway: plan.gateway,
          connection_id: review.connection_id,
          accepted: executeFields,
        },
      );
    this.access(actor, plan, review.connection_id);
    if (input.idempotency_key !== input.review_id)
      fail('IDEMPOTENCY_REQUIRED', 'Use the exact idempotency_key returned by prepare.');
    // The state the review froze (R2.5 field fix r25-field-pausedspend): the first look, before anything is read again. A parent that read
    // PAUSED then and reads otherwise now is stopped at the state check in `submit` (STATE_CHANGED), before anything is claimed or sent.
    authorizeExecution(actor, plan, {...input, dry_run: false}, this.policy, true, review.state);
    assertWritesNotPaused(this.store, actor.tenantId, pauseEffect(plan));
    if (review.creative_edit_confirmed === true && input.creative_edit_confirmed !== true)
      fail(
        'CREATIVE_EDIT_CONFIRMATION_REQUIRED',
        'This review permits a potentially destructive creative edit. Also provide creative_edit_confirmed=true to execute.',
      );
    if (input.creative_edit_confirmed === true && review.creative_edit_confirmed !== true)
      fail('REVIEW_CHANGED', 'Prepare a new review to acknowledge creative-edit risk. Execute cannot add an override.');
    const fingerprint = sha256(
      stable({
        tenant: actor.tenantId,
        user: review.user_id,
        connection: review.connection_id,
        plan,
        ...(review.creative_edit_confirmed === true ? {creative_edit_confirmed: true} : {}),
      }),
    );
    if (fingerprint !== review.fingerprint)
      fail('REVIEW_CHANGED', 'The stored reviewed request failed its integrity check.');
    const replayed = this.previousOutcome(actor, input, plan, fingerprint);
    if (replayed) return replayed;
    // Maker-checker (CMP-05): while the owner requires a distinct approver, a step of a plan that changes spending or
    // activates a launch executes only through its plan (execute_next or run), which checks another person's current
    // approval; a direct execute would skip it. Checked before anything is claimed or sent; the review stays valid.
    if (origin !== 'plan' && planPolicy(this.store, actor.tenantId).require_distinct_approver === true) {
      const held = this.store.db
        .prepare(
          "SELECT c.id,c.data FROM documents c, json_each(c.data,'$.steps') s WHERE c.tenant_id=? AND c.kind='campaign_run' AND json_extract(s.value,'$.review_id')=? LIMIT 1",
        )
        .get(actor.tenantId, input.review_id) as {id: string; data: string} | undefined;
      const run = held ? (JSON.parse(held.data) as JsonObject) : undefined;
      if (run && (run.activation_of || approvalSpends(approvalSummary(run))))
        fail(
          'DISTINCT_APPROVER_REQUIRED',
          'This review is a step of a campaign plan that changes spending or activates a launch, and this workspace requires another person’s approval of such a plan. Execute it through its plan (execute_next or run), which checks that approval.',
          {
            policy: 'require_distinct_approver',
            plan_id: held!.id,
            next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id: held!.id}},
          },
        );
    }
    familyOf(plan)?.available?.(plan);
    if (review.expires_at <= Date.now())
      fail(
        'REVIEW_EXPIRED',
        'Nothing was submitted. Prepare the same request again and review it.',
        expiredNext(review),
      );
    // WRT-09 (owner decisions P1 and P5; both settings opt-in): the destructive tier's acknowledgement and, under an
    // approval mode, a person's website approval of this exact review. Checked after expiry (an expired review is prepared again, not
    // approved) and before anything is claimed or sent; the review stays valid.
    const approved = assertExecutionApproval(this.store, actor, review, input.review_id, input);
    if (approved)
      this.store.appendAudit(actor.tenantId, input.review_id, {
        event: 'write_approval_presented',
        approver: approved.approver,
        approver_is_owner: approved.approver_is_owner === true,
        approved_at: approved.approved_at,
        actor: actor.userId,
      });
    // A personal-data review kept only counts and a digest: the people come again, hashed again in memory, and must be
    // the reviewed ones. The switch is read again: turning an account off stops reviews already prepared.
    const record = plan.personalData as PersonalDataRecord | undefined;
    let sent = plan,
      echoes: ReadonlySet<string> = new Set();
    if (record) {
      const spec = familyOf(plan)?.personalData;
      if (!spec)
        fail(
          'WRITE_CONTRACT_UNAVAILABLE',
          'This review sends data about people, and no reviewed family takes it now. Nothing was submitted.',
        );
      assertPersonalDataAllowed(this.store, actor, plan, record.direction, true);
      if (input.people === undefined)
        fail(
          'PERSONAL_DATA_REQUIRED',
          'Send the same people again in people: the review kept only their count and digest.',
          {reviewed: record.counts},
        );
      const batch = hashPeople(input.people, spec, record.direction);
      if (batch.record.digest !== record.digest)
        fail(
          'PERSONAL_DATA_CHANGED',
          'These people are not the reviewed ones: their hashed batch gives another digest. Nothing was submitted; send the same people, or prepare a new review.',
          {reviewed: record.counts, sent: batch.record.counts},
        );
      sent = {...plan, body: spec.body(plan, batch.rows)};
      // Click, transaction and event IDs are sent as they are; a reply or an error that echoes them is scrubbed.
      echoes = sentIdentifiers(spec, batch);
    } else if (input.people !== undefined)
      fail('INVALID_ARGUMENT', 'people is only for a review that sends data about people.', {
        field: 'people',
        accepted: executeFields,
      });
    // Reviews of one target execute one at a time (WRT-04): the later one reads the state again after the earlier one
    // was sent, so it is refused as STATE_CHANGED instead of being sent against state that already changed.
    const locks = this.targetLocks(actor, review, plan),
      lockOwner = randomUUID();
    await this.lockTargets(locks, lockOwner, input.review_id);
    try {
      // A second execute of this same review that waited for the lock replays what the first one recorded.
      const settled = locks.length ? this.previousOutcome(actor, input, plan, fingerprint) : undefined;
      if (settled) return settled;
      return await this.submit(actor, input, review, plan, sent, record, echoes, fingerprint, () => {
        if (locks.length && !this.store.renewLocks(locks, lockOwner, targetLockMs))
          fail('STATE_BUSY', targetBusy, {review_id: input.review_id, retry_after_ms: 2000});
      });
    } finally {
      this.store.releaseLocks(locks, lockOwner);
    }
  }
  /** A completed claim of this review replays its receipt; a pending or uncertain one is never sent again. */
  private previousOutcome(
    actor: Actor,
    input: JsonObject,
    plan: CompiledRequest,
    fingerprint: string,
  ): JsonObject | undefined {
    const previous = this.store.db
      .prepare('SELECT state,result,fingerprint FROM idempotency WHERE tenant_id=? AND key=?')
      .get(actor.tenantId, input.idempotency_key) as JsonObject | undefined;
    if (!previous) return undefined;
    if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'The key is bound to another request.');
    if (previous.state === 'complete') {
      const saved = {...JSON.parse(previous.result), replayed: true};
      return this.delivered(plan, saved, actor.tenantId, input.review_id);
    }
    if (previous.state === 'rejected')
      fail(
        'WRITE_REJECTED',
        'The provider refused this review without applying it, so it is never sent again. Correct the request and prepare a new review.',
        {submission: 'rejected', review_id: input.review_id, key_retired: true},
      );
    fail(
      'WRITE_OUTCOME_UNCERTAIN',
      'This review was already submitted. Inspect provider state; do not retry with a new key.',
    );
  }
  /**
   * What a review's execution must not share with another execution at the same time: each state read it compares
   * on its connection and account, or its own request target when it reads nothing generic. A read is identified by
   * what it selects, not by which fields it projects (a `fields` list, a Google query's SELECT list), so two reviews
   * that read the same record never send concurrently, whichever fields each one changes.
   */
  private targetLocks(actor: Actor, review: JsonObject, plan: CompiledRequest): string[] {
    if (!serializeTargets()) return [];
    const scope = {
        tenant: actor.tenantId,
        connection: review.connection_id,
        account: normalizeAccount(plan.gateway, plan.accountId ?? ''),
      },
      reads: CompiledRequest[] = Array.isArray(review.reads) ? review.reads : [];
    const selects = (body: unknown) => {
      const query = object(body).query;
      return typeof query === 'string'
        ? {...object(body), query: query.replace(/^\s*SELECT\s.+?\sFROM\s/is, 'FROM ')}
        : body;
    };
    const targets = reads.length
      ? reads.map(r => {
          const {fields: _projection, ...query} = object(r.query);
          return {method: r.method, path: r.path, query, body: selects(r.body) ?? null};
        })
      : [{method: plan.method, path: plan.path}];
    return [...new Set(targets.map(t => 'write-target:' + sha256(stable({...scope, ...t}))))].sort();
  }
  /** Waits a bounded time for every target lock at once, or refuses with STATE_BUSY before anything is claimed. */
  private async lockTargets(locks: string[], owner: string, reviewId: string): Promise<void> {
    const deadline = Date.now() + targetWaitMs();
    while (!this.store.acquireLocks(locks, owner, targetLockMs)) {
      if (Date.now() >= deadline) fail('STATE_BUSY', targetBusy, {review_id: reviewId, retry_after_ms: 2000});
      await pause(100);
    }
  }
  /**
   * The state of an execute, read again before anything is claimed. A read refused for a cooldown, an exhausted request budget or an
   * open circuit (the transport refuses before it sends) sent no write and claimed nothing, so the refusal says so: the review
   * stays valid, and the same one executes when the cause clears (S3-2 of the lead's review). A plan step waits on this mark instead
   * of failing; under AMCP_PROVIDER_PACING_MODE=enforce it is the usual refusal, since a block announced after a review was prepared
   * refuses the read of its execute. Any other refusal of the read keeps what it was.
   */
  private async currentState(
    actor: Actor,
    plan: CompiledRequest,
    review: JsonObject,
    reviewId: string,
  ): Promise<unknown[]> {
    try {
      return await this.state(actor, plan, review.connection_id, review.reads);
    } catch (e) {
      throw e instanceof MirrorError && refusedBeforeSending.includes(e.code) ? notSent(e, reviewId) : e;
    }
  }
  private async submit(
    actor: Actor,
    input: JsonObject,
    review: JsonObject,
    plan: CompiledRequest,
    sent: CompiledRequest,
    record: PersonalDataRecord | undefined,
    // Identifying values this request sends as they are, scrubbed from a reply or an error that echoes them (DOC-02).
    echoes: ReadonlySet<string>,
    fingerprint: string,
    keepTargets: () => void,
  ): Promise<unknown> {
    // Reproject saved envelopes as well: a still-valid review prepared before an
    // upgrade must not conflict solely because its stored envelope was wider.
    // X creative discovery already returns its own validated resource projection.
    const expectedState = familyOf(plan)?.stateAsRead
      ? review.state
      : review.state.map((value: unknown, i: number) => normalizeSnapshot(review.reads[i], value));
    // The roles of the reads name which changed path belongs to which read only where the state has one entry per read
    // (the generic state). A family that keeps its own state, a state kept as it was read, or an owned state read first and
    // the provider's own second, puts several reads in one entry: the first subscript of a path then says nothing about its
    // read, and every path is a target (lead review S1-1). Decided before the state is read again, which may add reads.
    const readsOfState: unknown[] | undefined =
      !familyOf(plan)?.state &&
      !familyOf(plan)?.stateAsRead &&
      !reviewHooks(plan.gateway)?.ownState?.claims(plan) &&
      Array.isArray(review.reads) &&
      review.state.length === review.reads.length
        ? [...review.reads]
        : undefined;
    // Both sides are hashed with the table of the provider whose reviewed state this is (R2.5 M1, review.volatile).
    const volatile = reviewVolatile(plan.gateway),
      current = await this.currentState(actor, plan, review, input.review_id as string),
      expectedHash = reviewStateHash(expectedState, volatile),
      actualHash = reviewStateHash(current, volatile);
    const creativeImpact = writeImpact(plan, current, review.creative_edit_confirmed === true, review.connection_id);
    if (actualHash !== expectedHash) {
      // The provider's table drops from the diff what it drops from the hash (R2.5 M1), so `changed_fields` names exactly
      // what made the hashes differ. It is computed once: `material` and `recurring_paths` are built from it.
      const changed = changedStateFields(expectedState, current, volatile),
        // The paths that changed in this provider's recent refusals too: left out when the audit cannot be read.
        recurring = recurringStatePaths(this.store, actor.tenantId, plan.gateway, changed, {review: input.review_id});
      // R25 M1 (L5-04, T2): the refusal says which of the changed fields matter (`material`), which of them changed in
      // the provider's recent refusals too (`recurring_paths`), and hands back the call that prepares the same request
      // again. The check is as strict as it was: every changed path still refuses, nothing is claimed or sent, and no
      // flag or retry exists. Preparing again is a call for the agent and the user to make.
      fail(
        'STATE_CHANGED',
        'The provider configuration changed after preparation. Prepare and review a fresh request.',
        {
          expected_state_hash: expectedHash,
          actual_state_hash: actualHash,
          changed_fields: changed,
          // Raised before anything is claimed or sent: the mark the remedy and the plan engine test (lead review S2-2).
          submission: 'not_sent',
          // The provider, so that the audit of refusals can tell its refusals from another provider's.
          gateway: plan.gateway,
          ...surfacedMaterial(materialFields(changed, readsOfState)),
          ...(recurring ? {recurring_paths: recurring} : {}),
          ...expiredNext(review, true),
        },
      );
    }
    familyOf(plan)?.stateChecks?.(plan, current, false);
    const c = this.access(actor, plan, review.connection_id),
      auth = await this.credentials.get(c);
    this.access(actor, plan, review.connection_id);
    reviewHooks(plan.gateway)?.ownedReferences?.(plan, current, resource =>
      this.store.ownsResource(c, normalizeAccount(plan.gateway, plan.accountId!), resource),
    );
    if (review.expires_at <= Date.now())
      fail(
        'REVIEW_EXPIRED',
        'The review expired during state verification. Nothing was submitted; prepare it again.',
        expiredNext(review),
      );
    familyOf(plan)?.available?.(plan);
    familyOf(plan)?.beforeSubmit?.(plan, current, auth);
    if (record) assertPersonalDataAllowed(this.store, actor, plan, record.direction, true);
    const submittedAt = Date.now(),
      actorBinding = this.store.bindJobActor(actor, input.review_id),
      family = familyOf(plan),
      submission = {
        store: this.store,
        tenantId: actor.tenantId,
        reviewId: input.review_id as string,
        connection: c,
        auth,
        state: current,
        submittedAt,
      };
    // WRT-09 (owner decision P5, always on): beyond a cap under `confirm`, only the workspace owner executes, or the owner
    // approved this exact review on the website. Checked with the caps exceeded now; nothing is reserved, claimed or
    // sent. The acknowledgement is still needed as well.
    if (input.cap_override_confirmed === true)
      assertCapOverrideOwner(
        this.store,
        actor,
        plan,
        exceededCaps(checkSpendPolicy(this.store, actor, plan, current)),
        input.review_id,
        Array.isArray(review.required_acknowledgements) &&
          review.required_acknowledgements.includes('cap_override_confirmed'),
      );
    // RPT-06: a provider job is counted and retained with a receipt keyed by its review, recorded with the claim, before
    // anything is sent; a job family without its own provider quota check is admitted against the deployment-wide
    // hourly bound first (PROVIDER_JOB_QUOTA claims and sends nothing).
    const job = reviewedProviderJob(plan);
    const claim = this.store.transaction(() => {
      checkSpendPolicy(this.store, actor, plan, current, input.review_id, input.cap_override_confirmed === true);
      const claim = this.store.claim(actor.tenantId, input.idempotency_key, fingerprint);
      if (claim.fresh) {
        // R2.5 M2 (lead review S2-1): an identical create that is unresolved, or completed since this review was prepared, is
        // refused here, in the transaction that took the claim: a refusal rolls the claim back, so nothing is claimed or sent,
        // and two executes cannot both pass (the store's transactions begin immediate, so other processes wait too).
        assertCreateNotRepeated(this.store, actor, plan, review, input.review_id, expiredNext(review, true));
        // R2.5 M2 (lead review S3-4): the write is watched from its claim, so that a crash or a deploy that leaves the claim
        // pending still gets its automatic check (due at claim + 10 minutes). It is dropped when the write settles.
        watchWrite(this.store, actor.tenantId, input.review_id, actorBinding);
        family?.admit?.(plan, submission);
        if (job) {
          if (!family?.admit) admitProviderJob(this.store, plan.gateway, plan.accountId ?? '');
          beginProviderJob(this.store, actor.tenantId, {
            id: input.review_id,
            gateway: plan.gateway,
            account_id: plan.accountId ?? '',
            connection_id: c.id,
            actor: actor.userId,
            source: 'reviewed',
            family: family?.name,
            review_id: input.review_id,
          });
        }
      }
      return claim;
    });
    if (!claim.fresh) {
      const saved = {...object(claim.result), replayed: true};
      return this.delivered(plan, saved, actor.tenantId, input.review_id);
    }
    let completed = false,
      dispatched = false;
    try {
      this.store.appendAudit(actor.tenantId, input.review_id, {
        event: 'write_started',
        request: plan,
        fingerprint,
        before_state: current,
      });
      const response = await this.request(
        actor,
        plan,
        sent,
        c,
        auth,
        () => {
          // Admission may wait. Authority is checked again after that wait, immediately before the unsent write.
          keepTargets();
          assertWritesNotPaused(this.store, actor.tenantId, pauseEffect(plan));
          // The state read again, which the state check above has shown to be the reviewed one (R2.5 field fix r25-field-pausedspend).
          authorizeExecution(actor, plan, {...input, dry_run: false}, this.policy, true, current);
          if (record) assertPersonalDataAllowed(this.store, actor, plan, record.direction, true);
          if (review.expires_at <= Date.now())
            fail('REVIEW_EXPIRED', 'The review expired before dispatch. Nothing was submitted.', expiredNext(review));
          this.store.transaction(() => {
            checkSpendPolicy(this.store, actor, plan, current, input.review_id, input.cap_override_confirmed === true);
          });
        },
        () => {
          dispatched = true;
        },
      );
      this.delegated.validateResponse(plan, response.data, response.status);
      const result = writeOutcome(response, plan, current);
      // A platform may echo a person's value back; nothing of it is kept or returned.
      if (record) result.data = scrubPeople(result.data, echoes);
      const outcome: JsonObject = {
        ...result,
        review_id: input.review_id,
        action: plan.action,
        fingerprint,
        ...(creativeImpact ? {creative_impact: creativeImpact} : {}),
      };
      this.store.transaction(() => {
        if (result.success === true) new ScopeGuard(this.registry, this.store).observeCreated(plan, c, response.data);
        // A family keeps what the response gives it, such as a report job's receipt (kept even for a failed job, which
        // must still never be resubmitted).
        family?.retain?.(plan, response, result, submission);
        // A job the provider did not clearly accept stays uncertain: the family's own record refuses a resubmission.
        if (job)
          settleProviderJob(this.store, actor.tenantId, input.review_id, result.success ? 'accepted' : 'uncertain');
        if (result.success === true) {
          const job = this.store.enqueue(actor.tenantId, 'write_verification', {
            review_id: input.review_id,
            actor_binding: actorBinding,
          });
          outcome.verification = {
            status: 'queued',
            job_id: job,
            next_call: {tool: 'amcp_campaign', arguments: {action: 'verify', review_id: input.review_id}},
          };
        }
        this.store.complete(actor.tenantId, input.idempotency_key, outcome);
        unwatchWrite(this.store, actor.tenantId, input.review_id);
        this.store.appendAudit(actor.tenantId, input.review_id, {event: 'write_completed', outcome});
      });
      completed = true;
      // Retain accepted outcomes first, then withhold delivery if this caller lost access.
      this.authority(actor, plan, plan, c, auth)();
      if (family?.deliver) {
        this.access(actor, plan, review.connection_id);
        return this.delivered(plan, outcome, actor.tenantId, input.review_id);
      }
      return outcome;
    } catch (e) {
      const code = e instanceof MirrorError ? e.code : 'INTERNAL_ERROR';
      // A refusal raised before the request left AMCP sent nothing (owner decision D12): the claim and the day's spend
      // reservation are released and the same review may be executed again inside its window. Once the request was
      // dispatched the outcome stays uncertain, and the reservation stays taken: a write that failed in transport may
      // still have reached the provider, and releasing it would let repeated failures walk past the daily cap.
      const unsent =
        !completed &&
        !dispatched &&
        releaseUnsentClaims() &&
        this.store.transaction(() => {
          const released = this.store.release(actor.tenantId, input.idempotency_key, fingerprint, {
            code,
            // Names the review, so an over-cap confirmation recorded before this refusal is not read as an execution.
            review_id: input.review_id,
            gateway: plan.gateway,
            account_id: plan.accountId ?? null,
            connection_id: c.id,
          });
          // The claim is gone, and so is the watch it queued (R2.5 M2, lead review S3-4). The seal a replacement put on the review it
          // replaces is NOT lifted by this release (lead re-review N4, decided 2026-11-17): a pause or a rate limit refused the write before
          // it was sent, the replacement is still alive, and the same review executes again after the cooldown without the old write
          // being settled again. The seal ends when the replacement is rejected, or when it expires with no claim (found by a status or
          // by the next check that reads the old review).
          if (released) unwatchWrite(this.store, actor.tenantId, input.review_id);
          return released;
        });
      // A definitive refusal the family proves applied nothing (CMP-04) is rejected, not uncertain: the key is retired
      // and the reservation released (D12). A lost response, timeout, rate limit or 5xx never qualifies.
      const rejected =
        !completed &&
        !unsent &&
        dispatched &&
        nonAppliedRejection(plan, e, family) &&
        this.store.transaction(() => {
          const retired = this.store.rejected(actor.tenantId, input.idempotency_key, fingerprint, {
            code,
            review_id: input.review_id,
            gateway: plan.gateway,
            account_id: plan.accountId ?? null,
            connection_id: c.id,
            http_status: Number((e as MirrorError).details.http_status),
          });
          if (retired) {
            unwatchWrite(this.store, actor.tenantId, input.review_id);
            this.liftRejectedSeal(actor, review, input.review_id);
          }
          return retired;
        });
      if (!completed && !unsent && !rejected) {
        this.store.uncertain(actor.tenantId, input.idempotency_key);
        // R2.5 M2 (L5-05, L3-13; owner 2026-11-15: "reconcile them automatically"): the worker reads the provider for this
        // write at its claim time plus 60 s (src/write-reconcile-job.ts): the watch its claim queued is moved up. It reads
        // only and never decides the outcome. The claim is already uncertain, so a failure to queue the check never changes
        // what the caller is told: the person's own `reconcile` stays available, and the audit says the check was not queued.
        try {
          this.store.transaction(() => queueReconcile(this.store, actor.tenantId, input.review_id, actorBinding));
        } catch (queueError) {
          try {
            this.store.appendAudit(actor.tenantId, input.review_id, {
              event: 'write_reconcile_not_queued',
              code: queueError instanceof MirrorError ? queueError.code : 'INTERNAL_ERROR',
              gateway: plan.gateway,
              account_id: plan.accountId ?? null,
              connection_id: c.id,
            });
          } catch {
            // The audit is the best the caller's answer can carry: it never changes what the caller is told.
          }
        }
      }
      // RPT-06: an unsent job leaves no receipt (the same review may run again); a sent one is rejected or uncertain.
      if (job && !completed) {
        if (unsent) this.store.deleteDocument(actor.tenantId, 'provider_job', input.review_id);
        else
          settleProviderJob(this.store, actor.tenantId, input.review_id, rejected ? 'rejected' : 'uncertain', {code});
      }
      // Scoped like write_not_sent, so a member with access to the account sees it in Activity (WRT-08). A rejected
      // write has its own write_rejected audit (Store.rejected) and is never uncertain.
      if (!unsent && !rejected)
        this.store.appendAudit(actor.tenantId, input.review_id, {
          event: completed ? 'write_result_withheld' : 'write_uncertain',
          code,
          gateway: plan.gateway,
          account_id: plan.accountId ?? null,
          connection_id: c.id,
        });
      const raised = family?.safeError ? family.safeError(e) : e,
        // Uncertain writes name their read-only status call (WRT-08); a rejected one is settled and names its retired key.
        safe = unsent
          ? notSent(raised, input.review_id)
          : rejected
            ? rejectedError(raised, input.review_id)
            : completed
              ? raised
              : uncertainNext(raised, input.review_id);
      throw record ? scrubError(safe, echoes) : safe;
    }
  }
}
