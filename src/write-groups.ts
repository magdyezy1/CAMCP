import {randomUUID} from 'node:crypto';
import {MirrorError} from './errors.js';
import type {Store} from './store.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {fingerprint} from './workspace-core.js';
import {observedHash} from './write-verification.js';
import {checkGroupSpendPolicy, describeExceeded} from './spend-policy.js';
import {assertWritesNotPaused} from './owner-operations.js';
import {groupPartSeconds} from './write-common.js';
import {approvalNotice, assertCapOverrideOwner, assertGroupApproval} from './write-approval.js';
// The record list a provider's request is split along (ARC-01 phase B, wave 4c: its adapter's `writes.batch`).
import {providerHooks} from './provider-hooks.js';

/**
 * One approval for a request longer than one native call allows (the owner's item 4, 2026-09-29): Google Ads
 * mutations and Snapchat entity batches take at most 25 records per reviewed call, so 84 negative keywords took four
 * reviews. A longer list is now split into parts of 25. Each part is an ordinary review, with its own state reads,
 * state hash, idempotency key, spending check and read-back; the group adds only the single approval. Execution runs
 * the parts in order and stops at the first that does not succeed: a part whose outcome is uncertain is never sent
 * again, and the parts after it are not sent. The group has its own idempotency record, so a completed group replays
 * its receipt and an interrupted one is never re-sent.
 */
export const groupPartSize = 25;
export const groupMaxParts = 40;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * The list a request would be split along, or undefined when it is not one AMCP splits: its provider's record list
 * (Google Ads' operations, Snapchat's one record list; moved verbatim to their adapters).
 */
export function splittableBatch(gateway: unknown, args: unknown): {key: string; items: unknown[]} | undefined {
  if (!object(args) || !object(args.payload)) return undefined;
  return providerHooks(gateway)?.writes?.batch?.(args.payload);
}
export const needsGroup = (gateway: unknown, args: unknown) =>
  (splittableBatch(gateway, args)?.items.length ?? 0) > groupPartSize;
/** A refusal of the 25-record limit itself ("Reviewed Google mutations require 1–25 …", "Provide 1–25 native ads
 * records"), not of a family whose own limit differs (100 recommendations, 500 listing groups) or of a text length. */
export const groupLimitRefusal = (e: unknown) =>
  e instanceof MirrorError && /\b1[–-]25\b(?!\s*(?:characters|UTF))/.test(e.message);
/**
 * A refusal of one part names its operation by the part's own index, and the group's caller counted the whole list: the 28th
 * record is the third of its part (R2.5 M3, L5-10). The index, and the one a field path carries (`operations[2].create.x`),
 * become the place in the whole list. Anything else of the refusal, and any refusal that names no operation, is as it was.
 */
function withGroupIndex(error: unknown, offset: number): unknown {
  if (!(error instanceof MirrorError) || offset === 0 || !Number.isInteger(error.details.operation)) return error;
  const {operation, field} = error.details as {operation: number; field?: unknown};
  error.details = {
    ...error.details,
    operation: operation + offset,
    ...(typeof field === 'string'
      ? {field: field.replace(/^operations\[(\d+)\]/, (_, n: string) => 'operations[' + (Number(n) + offset) + ']')}
      : {}),
  };
  return error;
}
/** The arguments of each part, in order; the arguments themselves when they are not split. */
export function groupParts(gateway: unknown, args: JsonObject): JsonObject[] {
  const batch = needsGroup(gateway, args) ? splittableBatch(gateway, args)! : undefined;
  if (!batch) return [args];
  return Array.from({length: Math.ceil(batch.items.length / groupPartSize)}, (_, i) => {
    const part = structuredClone(args);
    part.payload[batch.key] = batch.items.slice(i * groupPartSize, (i + 1) * groupPartSize);
    return part;
  });
}
type Reviewed = (input: JsonObject, actor: Actor) => Promise<any>;
/** What execute would check of one part before claiming it (WriteReviewService.admit); sends and claims nothing. */
type Admit = (
  actor: Actor,
  reviewId: string,
  flags: JsonObject,
) => {plan: CompiledRequest; state: unknown; expiresAt: number};
/**
 * The latest time execute can start so that part i (0-based) still has (i+1) part durations of its own window left
 * (WRT-04): a group that starts later would run out of time part-way and stop half applied.
 */
const executeBy = (expiries: number[], seconds: number) =>
  Math.min(...expiries.map((expires, i) => expires - (i + 1) * seconds * 1000));
export class WriteGroups {
  constructor(
    private store: Store,
    private reviewed: Reviewed,
    private admit?: Admit,
  ) {}
  /** The parts' frozen requests and reviewed state, in order. */
  private reviews(actor: Actor, parts: string[]): {plan: CompiledRequest; state: unknown; expiresAt: number}[] {
    return parts.map(id => {
      const review = this.store.document(actor.tenantId, 'write_review', id);
      return {plan: review.plan, state: review.state, expiresAt: review.expires_at};
    });
  }
  /** How to send one part that a stopped group did not send: execute it while its review lasts, else prepare it again. */
  private partCall(actor: Actor, part: string, approved: JsonObject): JsonObject {
    const review = this.store.document(actor.tenantId, 'write_review', part);
    if (review.expires_at <= Date.now() && review.prepare_input)
      return {tool: 'amcp_write', arguments: {action: 'prepare', ...review.prepare_input}};
    return {
      tool: 'amcp_write',
      arguments: {action: 'execute', review_id: part, idempotency_key: part, confirmed: true},
      ...(Object.keys(approved).length ? {add_after_user_approval: approved} : {}),
    };
  }
  group(actor: Actor, id: unknown): JsonObject | undefined {
    if (typeof id !== 'string') return undefined;
    const row = this.store.db
      .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='write_review_group' AND id=?")
      .get(actor.tenantId, id) as {data: string} | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  /** `origin`: who prepares the group; a standalone group is retained work in Operations, like a review (WRT-08). */
  async prepare(input: JsonObject, actor: Actor, origin = 'standalone'): Promise<JsonObject> {
    const batch = splittableBatch(input.gateway, input.arguments)!,
      count = Math.ceil(batch.items.length / groupPartSize);
    if (count > groupMaxParts)
      throw new MirrorError(
        'INVALID_ARGUMENT',
        'A reviewed request takes at most ' +
          groupMaxParts * groupPartSize +
          ' records (' +
          groupMaxParts +
          ' parts of ' +
          groupPartSize +
          '); this one has ' +
          batch.items.length +
          '.',
        {field: 'arguments.payload.' + batch.key, limit: groupMaxParts * groupPartSize},
      );
    const parts: JsonObject[] = [];
    let slowest = 0;
    for (let i = 0; i < count; i++) {
      const args = structuredClone(input.arguments) as JsonObject;
      args.payload[batch.key] = batch.items.slice(i * groupPartSize, (i + 1) * groupPartSize);
      // Each part is an ordinary review. If one cannot be prepared, the group is refused: unexecuted part reviews
      // simply expire.
      const started = performance.now();
      try {
        parts.push(await this.reviewed({...input, arguments: args}, actor));
      } catch (e) {
        throw withGroupIndex(e, i * groupPartSize);
      }
      slowest = Math.max(slowest, performance.now() - started);
    }
    // The parts together are one change for the owner's spending caps (WRT-04): each part counts the earlier parts'
    // increases, so a daily cap only the whole group crosses is named now, and refused now under `block`.
    const together = checkGroupSpendPolicy(
      this.store,
      actor,
      this.reviews(
        actor,
        parts.map(p => p.review_id),
      ),
    );
    // Each part needs time of its own window left when its turn comes; the group lasts until the last moment at which
    // every part still has it (WRT-04), measured from how long the parts took to prepare.
    const seconds = groupPartSeconds(slowest),
      windows = parts.map(p => Date.parse(p.expires_at)),
      expires = seconds ? Math.min(...windows, executeBy(windows, seconds)) : Math.min(...windows);
    if (expires <= Date.now() + 5000)
      throw new MirrorError(
        'WRITE_GROUP_TOO_LONG',
        'This request has ' +
          count +
          ' parts and each needs about ' +
          seconds +
          ' seconds, which is more than one review window holds. Nothing was submitted; send fewer records per request.',
        {
          parts: count,
          seconds_per_part: seconds,
          review_window_seconds: 300,
          // R2.5 M3 round 2, S4-3: a part validated by default (L2-12) spent a request of its own, and its time is part of what each part
          // is given, so the opt-out is named beside fewer records, but only where it would change something (details only).
          shorten_by: [
            'Send fewer records per request.',
            ...(parts.some(p => p.provider_check?.default === true)
              ? ['Send provider_check: false, which skips the default validate-only request of each part.']
              : []),
          ],
        },
      );
    const id = randomUUID(),
      union = (key: string) => parts.some(p => p.execute_requirements?.[key] === true),
      cap = union('cap_override_confirmed') || together.exceeded.length > 0;
    const reasons = [
      ...new Map(
        parts
          .flatMap(p => (p.execute_requirements?.reasons ?? []) as JsonObject[])
          .filter(r => r.flag !== 'cap_override_confirmed')
          // An effect reason (WRT-05) names the first part's target; one per effect is kept.
          .map(r => [r.flag ?? 'effect:' + r.effect, r]),
      ).values(),
      ...(cap
        ? [
            {
              flag: 'cap_override_confirmed',
              reason:
                'Together, the parts of this change go beyond a spending cap the owner set: ' +
                describeExceeded(together.exceeded) +
                '. It is not refused; the user decides.',
              exceeded: together.exceeded,
            },
          ]
        : []),
    ];
    const partEffects = parts.map(p => p.execute_requirements?.effects).filter(Boolean) as JsonObject[],
      effects = partEffects.length
        ? Object.fromEntries(
            ['destructive', 'irreversible', 'publishes_live', 'stops_delivery'].map(k => [
              k,
              partEffects.some(e => e[k] === true),
            ]),
          )
        : undefined;
    const requirements: JsonObject = {
      confirmed: true,
      ...(union('spend_change_confirmed') ? {spend_change_confirmed: true} : {}),
      ...(cap ? {cap_override_confirmed: true} : {}),
      ...(union('creative_edit_confirmed') ? {creative_edit_confirmed: true} : {}),
      ...(union('destructive_confirmed') ? {destructive_confirmed: true} : {}),
      ...(reasons.length ? {reasons} : {}),
      ...(effects ? {effects} : {}),
    };
    const last = together.parts.at(-1)!;
    const spendPolicy: JsonObject =
      last.configured === true
        ? {
            configured: true,
            policy_id: last.policy_id,
            scope: last.scope,
            enforcement: last.enforcement,
            requested_increase_decimal: together.increase_decimal,
            reserved_today_decimal: together.parts[0]!.reserved_today_decimal,
            units: 'native',
            counted: 'Every part together, in order, as one change.',
            ...(together.exceeded.length
              ? {
                  exceeded: together.exceeded,
                  cap_override_required: true,
                  exceeded_summary: describeExceeded(together.exceeded),
                }
              : {}),
          }
        : last;
    const first = this.store.document(actor.tenantId, 'write_review', parts[0]!.review_id);
    // WRT-09: one website approval covers every part, as one acknowledgement does.
    const acknowledgements = Object.keys(requirements).filter(k => requirements[k] === true && k !== 'confirmed'),
      approval = approvalNotice(this.store, actor, first.plan, id, acknowledgements, effects?.destructive === true);
    this.store.putDocument(actor.tenantId, 'write_review_group', id, {
      user_id: actor.userId,
      principal: first.principal,
      origin,
      account_id: first.plan.accountId,
      connection_id: first.connection_id,
      gateway: input.gateway,
      parts: parts.map(p => p.review_id),
      records: parts.map((_, i) => Math.min(groupPartSize, batch.items.length - i * groupPartSize)),
      expires_at: expires,
      slowest_prepare_ms: Math.round(slowest),
      created_at: Date.now(),
      // What a person approving the group on the website is shown (WRT-09): the reasons and effects of every part, and
      // the acknowledgements of the whole group (a cap only the parts together cross included).
      approval_context: {reasons, effects: effects ?? null},
      required_acknowledgements: acknowledgements,
      prepare_input: {
        gateway: input.gateway,
        arguments: input.arguments,
        ...(input.connection_id !== undefined ? {connection_id: input.connection_id} : {}),
        // What the caller said of the provider's check, so that preparing the group again keeps an opt-out (R2.5 M3, L2-12).
        ...(typeof input.provider_check === 'boolean' ? {provider_check: input.provider_check} : {}),
      },
    });
    this.store.appendAudit(actor.tenantId, id, {
      event: 'write_group_prepared',
      actor: actor.userId,
      parts: parts.map(p => p.review_id),
      records: batch.items.length,
    });
    return {
      success: true,
      executed: false,
      group: true,
      review_id: id,
      idempotency_key: id,
      expires_at: new Date(expires).toISOString(),
      expires_in_seconds: Math.max(0, Math.floor((expires - Date.now()) / 1000)),
      records: batch.items.length,
      parts: parts.map((p, i) => ({
        part: i + 1,
        review_id: p.review_id,
        records: Math.min(groupPartSize, batch.items.length - i * groupPartSize),
        request: p.request,
        state_hash: p.state_hash,
        state_reads: p.state_reads,
        spend_policy: p.spend_policy,
      })),
      spend_policy: spendPolicy,
      time_budget: {
        seconds_per_part: seconds,
        execute_by: new Date(expires).toISOString(),
        meaning:
          'Each part needs this much of its own review window when its turn comes. Execute before execute_by, or the group is refused before its first part is sent.',
      },
      contract_evidence: parts[0]!.contract_evidence,
      confirmation_required: true,
      execute_requirements: requirements,
      ...(approval ? {approval} : {}),
      ...(effects ? {effects} : {}),
      meaning:
        'One approval covers every part. Before the first part is sent, execute checks every part (access, acknowledgements, the owner’s spending caps for the parts together, and the time each part needs); then it sends the parts in order, each checked against the state it was reviewed on, and stops at the first that does not succeed; nothing after it is sent.',
    };
  }
  async execute(input: JsonObject, actor: Actor): Promise<JsonObject> {
    const id = input.review_id as string,
      group = this.group(actor, id)!;
    if (group.user_id !== actor.userId)
      throw new MirrorError('FORBIDDEN', 'The review belongs to a different actor.', {}, 403);
    if (input.arguments !== undefined || input.gateway !== undefined || input.connection_id !== undefined)
      throw new MirrorError(
        'INVALID_ARGUMENT',
        'Remove arguments, gateway and connection_id: a group executes its frozen parts with review_id, idempotency_key, confirmed and the flags execute_requirements lists.',
        {field: 'arguments'},
      );
    if ((input.idempotency_key ?? id) !== id)
      throw new MirrorError('IDEMPOTENCY_REQUIRED', 'Use the exact idempotency_key returned by prepare.', {
        field: 'idempotency_key',
      });
    if (input.confirmed !== true)
      throw new MirrorError('CONFIRMATION_REQUIRED', 'Set confirmed: true to execute every part of this review.', {
        field: 'confirmed',
      });
    const flags = {
      ...(input.spend_change_confirmed !== undefined ? {spend_change_confirmed: input.spend_change_confirmed} : {}),
      ...(input.cap_override_confirmed !== undefined ? {cap_override_confirmed: input.cap_override_confirmed} : {}),
      ...(input.creative_edit_confirmed !== undefined ? {creative_edit_confirmed: input.creative_edit_confirmed} : {}),
      ...(input.destructive_confirmed !== undefined ? {destructive_confirmed: input.destructive_confirmed} : {}),
    };
    // A group that already ran replays its receipt; one that stopped is never run again. Each part's own claim is
    // what prevents a duplicate send; the group's record is written once its parts have run.
    const earlier = this.store.db
      .prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?')
      .get(actor.tenantId, id) as {state: string; result: string} | undefined;
    if (earlier?.state === 'complete') return {...JSON.parse(earlier.result), replayed: true};
    if (earlier)
      throw new MirrorError(
        'WRITE_OUTCOME_UNCERTAIN',
        'This review stopped part-way or has an uncertain outcome. Read its parts back before resolving it.',
        {},
        409,
      );
    const prepareAgain = group.prepare_input
      ? {next_call: {tool: 'amcp_write', arguments: {action: 'prepare', ...group.prepare_input}}}
      : {};
    // Every part must still be inside its review window before the first is sent: never half a group by expiry.
    if (group.expires_at <= Date.now() + 5000) {
      throw new MirrorError(
        'REVIEW_EXPIRED',
        'This review expired before execution; nothing was submitted. Prepare the same request again.',
        prepareAgain,
        409,
      );
    }
    // Before the first part is sent, every part is checked the way its own execute will check it (WRT-04): the owner's
    // pause, access and grants, the acknowledgements, the spending caps for all the parts together, and the time each
    // part needs. A refusal here sends nothing and claims nothing.
    if (this.admit) {
      assertWritesNotPaused(this.store, actor.tenantId);
      const admitted = (group.parts as string[]).map(part => this.admit!(actor, part, flags));
      const together = checkGroupSpendPolicy(this.store, actor, admitted);
      if (together.exceeded.length && flags.cap_override_confirmed !== true)
        throw new MirrorError(
          'CAP_CONFIRMATION_REQUIRED',
          'Together, the parts of this change go beyond a spending cap the owner set: ' +
            describeExceeded(together.exceeded) +
            '. Nothing was sent. Show the user and, once they approve, execute again with cap_override_confirmed=true.',
          {exceeded: together.exceeded, group: true},
        );
      // WRT-09 (owner decision P5, always on): beyond a cap, only the workspace owner executes, or
      // approves the group on the website. A group kept before groups recorded their acknowledgements counts as having
      // named the cap. The first part's account is the group's, as for its approval (write-approval.ts).
      assertCapOverrideOwner(
        this.store,
        actor,
        admitted[0]!.plan,
        together.exceeded,
        id,
        !Array.isArray(group.required_acknowledgements) ||
          group.required_acknowledgements.includes('cap_override_confirmed'),
      );
      // WRT-09: under an approval mode, a person's website approval of the whole group, a cap only the parts together
      // cross included (each part's own check sees only its own acknowledgements).
      const approved = assertGroupApproval(this.store, actor, id, together.exceeded.length > 0);
      if (approved)
        this.store.appendAudit(actor.tenantId, id, {
          event: 'write_approval_presented',
          approver: approved.approver,
          approver_is_owner: approved.approver_is_owner === true,
          approved_at: approved.approved_at,
          actor: actor.userId,
        });
      const seconds = groupPartSeconds(group.slowest_prepare_ms),
        now = Date.now(),
        late = seconds ? admitted.findIndex((a, i) => a.expiresAt - now < (i + 1) * seconds * 1000) : -1;
      if (late >= 0)
        throw new MirrorError(
          'REVIEW_EXPIRED',
          'Too little of the review window is left: part ' +
            (late + 1) +
            ' of ' +
            admitted.length +
            ' needs about ' +
            (late + 1) * seconds +
            ' seconds from now and has ' +
            Math.max(0, Math.floor((admitted[late]!.expiresAt - now) / 1000)) +
            '. Nothing was submitted; prepare the same request again and execute it promptly.',
          {
            ...prepareAgain,
            part: late + 1,
            seconds_per_part: seconds,
            needed_seconds: (late + 1) * seconds,
            remaining_seconds: Math.max(0, Math.floor((admitted[late]!.expiresAt - now) / 1000)),
          },
          409,
        );
    }
    const results: JsonObject[] = [];
    let failure: {part: number; error: MirrorError} | undefined;
    for (const [i, part] of (group.parts as string[]).entries()) {
      try {
        const out = await this.reviewed(
          {action: 'execute', review_id: part, idempotency_key: part, confirmed: true, ...flags},
          actor,
        );
        results.push({part: i + 1, review_id: part, outcome: out.outcome ?? 'succeeded', data: out.data});
        if (out.success === false) {
          failure = {
            part: i,
            error: new MirrorError('WRITE_PARTIAL_OR_FAILED', 'Part ' + (i + 1) + ' did not succeed.'),
          };
          break;
        }
      } catch (e) {
        failure = {
          part: i,
          error:
            e instanceof MirrorError ? e : new MirrorError('WRITE_OUTCOME_UNCERTAIN', 'Part ' + (i + 1) + ' failed.'),
        };
        break;
      }
    }
    if (failure) {
      const sent = failure.part,
        notSent = (group.parts as string[]).slice(failure.part + 1);
      this.store.appendAudit(actor.tenantId, id, {
        event: 'write_group_stopped',
        part: failure.part + 1,
        code: failure.error.code,
      });
      // A part without an idempotency claim was refused before it was sent. When that is the first part, nothing of
      // the group reached the provider; otherwise the group stopped part-way and is never run again.
      const claimed = !!this.store.db
        .prepare('SELECT 1 FROM idempotency WHERE tenant_id=? AND key=?')
        .get(actor.tenantId, group.parts[failure.part]);
      // Nothing of the group was sent: the group's own refusal, under the group's review id.
      if (sent === 0 && !claimed) {
        const details: JsonObject = {
          ...failure.error.details,
          ...(failure.error.details.review_id !== undefined ? {review_id: id, part_review_id: group.parts[0]} : {}),
        };
        // R25 M1 (L5-04): a part refused for a changed state names the call that prepares that part, 25 records of the
        // request. The group is prepared again whole, with the call it was prepared by (none for a group kept before
        // groups recorded theirs, which then names no call rather than a part's).
        if (failure.error.code === 'STATE_CHANGED') {
          delete details.next_call;
          Object.assign(details, prepareAgain);
        }
        throw new MirrorError(
          failure.error.code,
          failure.error.message,
          details,
          failure.error.status,
          failure.error.retryable,
        );
      }
      this.store.claim(actor.tenantId, id, fingerprint({group: id, parts: group.parts}));
      this.store.uncertain(actor.tenantId, id);
      // The parts never sent, the stopped one included when it was refused before sending. Each is an ordinary review:
      // once the cause is resolved it is sent on its own (WRT-04). After an uncertain part nothing is offered.
      const unsent = (group.parts as string[]).slice(claimed ? failure.part + 1 : failure.part),
        approved = Object.fromEntries(Object.entries(flags).filter(([, v]) => v === true)),
        calls = claimed ? [] : unsent.map(part => this.partCall(actor, part, approved));
      throw new MirrorError(
        claimed ? 'WRITE_OUTCOME_UNCERTAIN' : 'WRITE_PARTIAL_OR_FAILED',
        'Part ' +
          (failure.part + 1) +
          ' of ' +
          group.parts.length +
          ' did not succeed (' +
          failure.error.code +
          '): ' +
          (sent ? 'parts 1–' + sent + ' were applied; ' : '') +
          (claimed
            ? notSent.length
              ? notSent.length + ' later part' + (notSent.length > 1 ? 's were' : ' was') + ' not sent. '
              : ''
            : 'it ' +
              (notSent.length
                ? 'and ' + notSent.length + ' later part' + (notSent.length > 1 ? 's were' : ' was')
                : 'was') +
              ' not sent. ') +
          (claimed
            ? 'Nothing is sent again automatically; read the parts back before any correction.'
            : 'Applied parts are never sent again; once the cause is resolved, send the parts not sent with details.next_call, one review at a time.'),
        {
          parts: results,
          failed_part: group.parts[failure.part],
          not_sent: notSent,
          part_error: failure.error.code,
          part_submitted: claimed,
          ...(calls.length
            ? {
                next_call: calls[0],
                not_sent_parts: unsent.map((part, i) => ({
                  part: group.parts.indexOf(part) + 1,
                  review_id: part,
                  call: calls[i],
                })),
              }
            : {}),
        },
        409,
      );
    }
    const outcome = {
      success: true,
      executed: true,
      group: true,
      outcome: 'succeeded',
      review_id: id,
      records: (group.records as number[]).reduce((a, b) => a + b, 0),
      parts: results,
      verification: {
        status: 'queued',
        next_call: {tool: 'amcp_campaign', arguments: {action: 'verify', review_id: id}},
      },
    };
    this.store.claim(actor.tenantId, id, fingerprint({group: id, parts: group.parts}));
    this.store.complete(actor.tenantId, id, outcome);
    this.store.appendAudit(actor.tenantId, id, {event: 'write_group_completed', parts: group.parts.length});
    return outcome;
  }
  /** Every part read back; the group is verified when every part is. */
  async verify(actor: Actor, id: string, verifyPart: (part: string) => Promise<JsonObject>): Promise<JsonObject> {
    const group = this.group(actor, id)!;
    if (group.user_id !== actor.userId)
      throw new MirrorError('FORBIDDEN', 'The review belongs to a different actor.', {}, 403);
    const parts: JsonObject[] = [];
    for (const part of group.parts as string[]) parts.push(await verifyPart(part));
    const statuses = parts.map(p => p.status),
      status = statuses.includes('failed')
        ? 'failed'
        : statuses.every(s => s === 'verified')
          ? 'verified'
          : statuses.includes('pending')
            ? 'pending'
            : statuses.includes('mismatch')
              ? 'mismatch'
              : statuses.includes('unsupported')
                ? 'unsupported'
                : 'inconclusive';
    const checks = parts.flatMap((p, i) => (p.checks ?? []).map((c: JsonObject) => ({...c, part: i + 1})));
    return {
      review_id: id,
      group: true,
      status,
      ...(status === 'mismatch'
        ? {code: 'VERIFICATION_MISMATCH'}
        : status === 'inconclusive'
          ? {code: 'VERIFICATION_INCONCLUSIVE'}
          : {}),
      checks,
      ...(['mismatch', 'inconclusive'].includes(status) && checks.every(c => typeof c.actual_hash === 'string')
        ? {actual_hash: observedHash(checks)}
        : {}),
      parts: parts.map((p, i) => ({part: i + 1, review_id: p.review_id, status: p.status})),
      checked_at: Date.now(),
      ...(parts.some(p => p.verified_resources)
        ? {verified_resources: parts.flatMap(p => p.verified_resources ?? [])}
        : {}),
      ...(parts.some(p => p.next_call)
        ? {
            retry_read_after_ms: Math.max(...parts.map(p => p.retry_read_after_ms ?? 0)),
            next_call: {tool: 'amcp_campaign', arguments: {action: 'verify', review_id: id}},
          }
        : {}),
    };
  }
}
