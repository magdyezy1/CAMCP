import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';

/**
 * The ingress request ID (OPS-08): created by the HTTP server for every request, returned as `X-AMCP-Request-Id` and
 * carried through the asynchronous work that request starts, so a failure log line written deep inside a tool call can
 * name the HTTP request it belongs to. It is always generated here, never taken from a client header, and carries no
 * request content.
 */
const context = new AsyncLocalStorage<{requestId: string}>();
export const REQUEST_ID_HEADER = 'X-AMCP-Request-Id';
const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function newRequestId(): string {
  return randomUUID();
}
/** Runs `fn` with `requestId` as the current ingress request ID; an ID not in the generated shape is refused. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  if (typeof requestId !== 'string' || !shape.test(requestId)) throw TypeError('Invalid ingress request ID');
  return context.run({requestId}, fn);
}
/** The ingress request ID of the HTTP request this code runs for; undefined outside one (stdio, worker, tests). */
export function currentRequestId(): string | undefined {
  return context.getStore()?.requestId;
}
