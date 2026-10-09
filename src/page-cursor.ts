import {MirrorError} from './errors.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {sha256, stable} from './security.js';

/**
 * An offset continuation bound to who asked and what they asked for (MCP-01): the tenant, user, role, session and the
 * exact filters. A cursor from another workspace, person, session or filter set does not validate, so a page can never
 * be replayed into a different scope. The same shape as the operations feed and history cursors.
 */
export function cursorBinding(store: Store, actor: Actor, filters: JsonObject): string {
  return sha256(
    stable({
      tenant: actor.tenantId,
      user: actor.userId,
      role: actor.role,
      session: store.sessionIdentity(actor) ?? null,
      filters,
    }),
  );
}
export function encodeOffsetCursor(binding: string, offset: number): string {
  return Buffer.from(JSON.stringify({version: 1, binding, offset})).toString('base64url');
}
/** The offset a cursor continues from; 0 without one. A cursor issued for another binding is refused. */
export function decodeOffsetCursor(cursor: unknown, binding: string, what: string): number {
  if (cursor === undefined) return 0;
  try {
    if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      parsed?.version !== 1 ||
      parsed.binding !== binding ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    )
      throw Error();
    return parsed.offset;
  } catch {
    throw new MirrorError(
      'INVALID_CURSOR',
      'Use the next_cursor returned for this ' + what + ' with the same identity, filters and page size, or start again without a cursor.',
      {field: 'cursor'},
    );
  }
}
