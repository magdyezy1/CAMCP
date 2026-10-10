import type {JsonObject} from './types.js';
export type OperationPhase =
  | 'claimed'
  | 'allocated'
  | 'transferring'
  | 'responded'
  | 'uncertain'
  | 'not_sent'
  | 'rejected'
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
