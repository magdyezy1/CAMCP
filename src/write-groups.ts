import {randomUUID} from 'node:crypto';
import {MirrorError} from './errors.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {fingerprint} from './workspace-core.js';
import {observedHash} from './write-verification.js';

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
/** The list a request would be split along, or undefined when it is not one AMCP splits. */
export function splittableBatch(gateway: unknown, args: unknown): {key: string; items: unknown[]} | undefined {
  if (!object(args) || !object(args.payload)) return undefined;
  const payload = args.payload;
  if (gateway === 'google_ads_native_action' && Array.isArray(payload.operations)) {
    // Temporary resource IDs (customers/1/campaigns/-1) link operations inside one request; they cannot be split.
    if (/"[^"]*customers\/[^"/]+\/[A-Za-z]+\/-\d/.test(JSON.stringify(payload.operations))) return undefined;
    return {key: 'operations', items: payload.operations};
  }
  if (gateway === 'snapchat_native_action') {
    const keys = ['campaigns', 'adsquads', 'ads', 'creatives', 'media', 'segments'].filter(k =>
      Array.isArray(payload[k]),
    );
    if (keys.length === 1) return {key: keys[0]!, items: payload[keys[0]!]};
  }
  return undefined;
}
export const needsGroup = (gateway: unknown, args: unknown) =>
  (splittableBatch(gateway, args)?.items.length ?? 0) > groupPartSize;
/** A refusal of the 25-record limit itself ("Reviewed Google mutations require 1–25 …", "Provide 1–25 native ads
 * records"), not of a family whose own limit differs (100 recommendations, 500 listing groups) or of a text length. */
export const groupLimitRefusal = (e: unknown) =>
  e instanceof MirrorError && /\b1[–-]25\b(?!\s*(?:characters|UTF))/.test(e.message);
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
export class WriteGroups {
  constructor(
    private store: Store,
    private reviewed: Reviewed,
  ) {}
  group(actor: Actor, id: unknown): JsonObject | undefined {
    if (typeof id !== 'string') return undefined;
    const row = this.store.db
      .prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='write_review_group' AND id=?")
      .get(actor.tenantId, id) as {data: string} | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  async prepare(input: JsonObject, actor: Actor): Promise<JsonObject> {
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
    for (let i = 0; i < count; i++) {
      const args = structuredClone(input.arguments) as JsonObject;
      args.payload[batch.key] = batch.items.slice(i * groupPartSize, (i + 1) * groupPartSize);
      // Each part is an ordinary review. If one cannot be prepared, the group is refused: unexecuted part reviews
      // simply expire.
      parts.push(await this.reviewed({...input, arguments: args}, actor));
    }
    const id = randomUUID(),
      expires = Math.min(...parts.map(p => Date.parse(p.expires_at))),
      union = (key: string) => parts.some(p => p.execute_requirements?.[key] === true);
    const requirements: JsonObject = {
      confirmed: true,
      ...(union('spend_change_confirmed') ? {spend_change_confirmed: true} : {}),
      ...(union('cap_override_confirmed') ? {cap_override_confirmed: true} : {}),
      ...(union('creative_edit_confirmed') ? {creative_edit_confirmed: true} : {}),
    };
    this.store.putDocument(actor.tenantId, 'write_review_group', id, {
      user_id: actor.userId,
      gateway: input.gateway,
      parts: parts.map(p => p.review_id),
      records: parts.map((_, i) => Math.min(groupPartSize, batch.items.length - i * groupPartSize)),
      expires_at: expires,
      created_at: Date.now(),
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
      contract_evidence: parts[0]!.contract_evidence,
      confirmation_required: true,
      execute_requirements: requirements,
      meaning:
        'One approval covers every part. Execute sends the parts in order, each checked against the state it was reviewed on, and stops at the first that does not succeed; nothing after it is sent.',
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
    // Every part must still be inside its review window before the first is sent: never half a group by expiry.
    if (group.expires_at <= Date.now() + 5000) {
      throw new MirrorError(
        'REVIEW_EXPIRED',
        'This review expired before execution; nothing was submitted. Prepare the same request again.',
        {},
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
      if (sent === 0 && !claimed) throw failure.error;
      this.store.claim(actor.tenantId, id, fingerprint({group: id, parts: group.parts}));
      this.store.uncertain(actor.tenantId, id);
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
          (notSent.length
            ? notSent.length + ' later part' + (notSent.length > 1 ? 's were' : ' was') + ' not sent. '
            : '') +
          'Nothing is sent again automatically; read the parts back before any correction.',
        {parts: results, failed_part: group.parts[failure.part], not_sent: notSent, part_error: failure.error.code},
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
