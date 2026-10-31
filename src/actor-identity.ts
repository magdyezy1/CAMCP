import type {Actor} from './types.js';

/**
 * The person behind an actor (MCP-02, owner decision D16 (4)). Person-scoped work, meaning uploads, retained originals,
 * media variants and campaign plans, follows the person across the website and that person's own AI clients:
 * - a website account session, and the OAuth keys and connector tokens that account authorized, carry ownerUserId:
 *   that account is the person;
 * - a password door signs in as `workspace-admin` (the administrator's) or `workspace-test` (the reviewers'), each to
 *   its own workspace; the OAuth keys and connector tokens approved from the administrator's door carry no
 *   ownerUserId, and those approved from the reviewers' carry its subject, which credential_owners records so that a
 *   new reviewer password revokes them (assertActorActive checks no account for it): their person is the door's;
 * - any other key (a local or command-line key) is its own person.
 * Write reviews stay bound to the credential that prepared them, `user_id` stays in records and audit, and the
 * administrator exemption at each check is unchanged: this decides who owns a person-scoped record, nothing else.
 */
export const doorPrincipal = 'workspace-admin';
/** The password doors' subjects (server/web-store.ts). A door signs in to one workspace only, so within a workspace
 * every door subject and every key approved from it is the same person. */
const doorSubjects = new Set(['workspace-admin', 'workspace-test']);
export function principalOf(actor: Pick<Actor, 'userId' | 'ownerUserId'>): string {
  if (actor.ownerUserId) return doorSubjects.has(actor.ownerUserId) ? doorPrincipal : actor.ownerUserId;
  if (doorSubjects.has(actor.userId) || /^(?:oauth|connector)\//.test(actor.userId)) return doorPrincipal;
  return actor.userId;
}
/** Whether the actor came through the reviewers' door: its session, or a key or token approved from it. That door signs
 * in to its own test workspace only, so there the door's person is the reviewers'. */
export function viaReviewerDoor(actor: Pick<Actor, 'userId' | 'ownerUserId'>): boolean {
  return actor.userId === 'workspace-test' || actor.ownerUserId === 'workspace-test';
}
/** Whether a test account (amcp_users.test_account) is in a workspace other than its own test workspace, where it is a
 * viewer: a test account is for evaluation and skips the two-step sign-in (owner decision, 2026-10-31). */
export function testAccountElsewhere(user: {test_account?: unknown; tenant_id?: unknown}, tenant: string): boolean {
  return !!user.test_account && user.tenant_id !== tenant;
}
/** What a new person-scoped record keeps of its maker: the credential (`user_id`) and the person (`principal`). */
export function ownership(actor: Pick<Actor, 'userId' | 'ownerUserId'>): {user_id: string; principal: string} {
  return {user_id: actor.userId, principal: principalOf(actor)};
}
/**
 * Whether the actor's person owns a record: by its recorded principal, or, for a record kept before principals, by a
 * `user_id` that is the actor's own credential or the actor's person (a website session's user ID, or a door subject
 * for a door's keys).
 */
export function ownsRecord(
  actor: Pick<Actor, 'userId' | 'ownerUserId'>,
  record: {user_id?: unknown; principal?: unknown} | null | undefined,
): boolean {
  if (!record) return false;
  const principal = principalOf(actor);
  if (typeof record.principal === 'string' && record.principal) return record.principal === principal;
  if (record.user_id === actor.userId || record.user_id === principal) return true;
  return principal === doorPrincipal && typeof record.user_id === 'string' && doorSubjects.has(record.user_id);
}
