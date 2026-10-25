/**
 * The leaf of the rejected outcome (CMP-04; ARC-01 phase B, wave 4c): a provider's proof that a refusal applied nothing
 * (src/google-write-rejection.ts, its adapter's `writes.rejectionIsNonApplied`) reads the definitive refusal statuses
 * here, so it imports no lifecycle module; src/write-rejection.ts re-exports them where they were.
 */
/** Statuses a provider sends only after deciding the request; a timeout (408) and a rate limit (429) are not among them. */
export const definitiveRefusalStatuses: readonly number[] = [400, 401, 403, 404, 409, 412, 422];
