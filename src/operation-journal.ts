import type {JsonObject} from './types.js';
export type OperationPhase =
  | 'claimed'
  | 'allocated'
  | 'transferring'
  | 'responded'
  | 'uncertain'
  | 'not_sent'
  | 'rejected'
  // r25-field3-errors (AMCP-03): a key nothing ever claimed, and a review the provider rejected when it validated it at prepare. Neither is
  // written by a claim: Store.operationJournal answers them for a key with no journal document and no claim.
  | 'not_claimed'
  | 'validation_rejected'
  // A write group whose own key has no claim yet while a part of it was claimed under that part's own key (src/store.ts `unjournaled`).
  | 'parts_claimed'
  | 'collecting'
  | 'delivering'
  | 'delivered'
  | 'failed';
/** Diagnostic projection only: the idempotency claim/job lease remains the authority for execution. */
export function operationRecovery(phase: string): JsonObject {
  const next: Record<string, string> = {
    claimed: 'Read the existing claim and reconcile provider state; never submit a new mutation key.',
    allocated: 'Read processing status for the retained remote identifier; do not allocate again.',
    transferring:
      'Inspect the retained session and confirmed byte offset. Resume only through a qualified provider offset protocol.',
    responded: 'Replay the stored receipt and perform scoped read-back.',
    uncertain:
      'Reconcile the retained request and remote references. Unknown mutations cannot be retried automatically.',
    not_sent:
      'Nothing reached the provider and the claim was released. Execute the same review again within its window, or prepare it again.',
    rejected:
      'The provider refused the request without applying it (CMP-04). This key is never sent again: correct the request and prepare a new review.',
    // Neither was ever claimed (r25-field3-errors, AMCP-03): the journal said "Legacy phase unknown" for both, as if they were records from
    // before the journal. The sentence names the two read-only reads that say why, for a reviewed write and for an upload.
    not_claimed:
      'Nothing was sent under this key and it was never claimed. Read the review’s status for why it was not executed (amcp_write status for a reviewed change, amcp_media recovery for an upload), then execute it before it expires or prepare it again.',
    validation_rejected:
      'The provider rejected this request when it validated it at prepare, so it was never claimed or sent. provider_errors names what it rejected: correct the request and prepare it again.',
    // A write group is claimed only after its parts ran, and each part under its own key (r25-field3-errors, lead review S2-1): the group's key can
    // have no claim while a part of it was sent. The sentence sends the reader to each part and says never to prepare the change again.
    parts_claimed:
      'A part of this write group was claimed under its own key, so part of the change may have reached the provider. Read amcp_write status of each part (parts lists their review ids and journal phases) before any action, and never prepare the same change again.',
    collecting: 'Resume collection with the same job and source checkpoints after current authority validation.',
    delivering: 'Reconcile the owned destination tab and retry the same frozen replacement only.',
    delivered: 'Read the stored delivery receipt.',
    failed: 'Inspect the terminal error. Reauthorize or correct unsubmitted inputs explicitly.',
  };
  return {
    next_safe_action: next[phase] ?? 'Legacy phase unknown. Inspect existing claims and receipts before any action.',
    automatic_new_mutation: false,
  };
}
