// Dependency-free metadata vocabulary: schema construction must not depend on a service import cycle.
export const operationKinds = [
  'campaign',
  'upload',
  'report',
  'export',
  'schedule',
  'incident',
  'workbook_report',
  'workbook_schedule',
  // Standalone reviewed writes (WRT-08).
  'write',
  // Monitor email notices that failed or ran out of time, for their subscriber (OPS-06, owner decision D22).
  'notice',
  // Logins that need reauthorization or keep failing to renew, or are turned off, for administrators (OPS-06).
  'connection',
];
export const operationStates = ['all', 'attention', 'active', 'complete', 'deferred'];
/**
 * The states that put an operation in the attention category, whatever its kind (OPS-06): the one vocabulary the
 * Operations feed and Home share. A state outside it is active, complete or deferred by operationCategory.
 */
export const attentionStates = [
  'uncertain',
  'failed',
  'partial',
  'blocked',
  'attention',
  'mismatch',
  'inconclusive',
  'awaiting_review',
  'review_ready',
  'unsubmitted',
  'expired',
  'unknown',
  'prepared',
  'not_sent',
  'reauthorization_required',
  'refresh_failed',
];
/** Every state the campaign runner gives a plan (src/campaign-runner.ts); a test keeps the two in step. */
export const campaignPlanStates = ['draft', 'awaiting_review', 'in_progress', 'attention', 'complete', 'cancelled'];
/** The attention category of one operation: attention, active, complete or deferred. */
export function operationCategory(kind: string, state: string): 'attention' | 'active' | 'complete' | 'deferred' {
  if (attentionStates.includes(state)) return 'attention';
  if (kind === 'write') return ['executing', 'verifying'].includes(state) ? 'active' : 'complete';
  if (kind === 'incident')
    return state === 'resolved'
      ? 'complete'
      : state === 'snoozed' || state === 'acknowledged' || state === 'superseded'
        ? 'deferred'
        : 'attention';
  // A notice past its 24 hours can no longer be recovered; it stays listed as undelivered.
  if (kind === 'notice') return 'complete';
  // A connection an administrator turned off is a standing choice, not a failure.
  if (kind === 'connection') return state === 'disabled' ? 'deferred' : 'active';
  if (['complete', 'cancelled', 'verified', 'delivered'].includes(state)) return 'complete';
  // A finished export that wrote nothing (a newer snapshot holds the tab, or policy skipped it) needs no action.
  if (kind === 'export' && ['superseded', 'skipped'].includes(state)) return 'complete';
  if (['paused', 'snoozed'].includes(state)) return 'deferred';
  return 'active';
}
