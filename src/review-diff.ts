import type {CompiledRequest} from './types.js';
// The provider's own account path (`writes.accountPath`): the one provider fact this module asks, through the registry.
import {providerHooks} from './provider-hooks.js';

/**
 * Which of the fields a STATE_CHANGED names matter (Round 2.5, M1, package r25-m1-diff, L5-04).
 *
 * A review reads several things before a write, and execute reads them again and refuses a review whose state differs
 * from the one it was prepared on. The reads play three roles. The ACCOUNT or PARENT container a write sits in (the
 * advertiser, ad account or customer, or the campaign a new ad group goes into) matters through its identity: what it
 * is called, whether it is enabled, its role, currency and time zone. The TARGET, the objects the write changes, and a
 * REFERENCE, a pixel, identity or catalog the write names, are compared whole.
 *
 * `material` lists what the target and reference roles protect first, then the identity changes of the account and
 * parent reads. It orders and names; it never narrows the check. The refusal and `changed_fields` stay as they are, and
 * every changed path of every read still refuses the write. A read whose role is not known is a target, so a change is
 * never left out of `material` for want of a label.
 */
export type ReadRole = 'account_parent' | 'target' | 'reference';

/** The names a read's builder may give its role: the pair of the first role under either name, and the other two. */
const roleNames: ReadonlyMap<string, ReadRole> = new Map<string, ReadRole>([
  ['account', 'account_parent'],
  ['parent', 'account_parent'],
  ['account_parent', 'account_parent'],
  ['account_or_parent', 'account_parent'],
  ['target', 'target'],
  ['reference', 'reference'],
]);

/** The role a read declares on itself (`role`, set where the read is built, with the case and separators of its name free). */
function declaredRole(read: unknown): ReadRole | undefined {
  const role = (read as {role?: unknown} | null | undefined)?.role;
  return typeof role === 'string'
    ? roleNames.get(
        role
          .trim()
          .toLowerCase()
          .replace(/[\s/-]+/g, '_'),
      )
    : undefined;
}

/** Whether `path` is exactly the account path its provider declares, where a path longer than it only starts like it. */
function isAccountPath(gateway: unknown, path: unknown): boolean {
  if (typeof path !== 'string') return false;
  const account = providerHooks(gateway)?.writes?.accountPath?.exec(path)?.[0];
  return account !== undefined && account.length === path.length;
}

/**
 * The role of one state read of a review. A role the read declares on itself wins. Otherwise a read of exactly the
 * provider's account path is the account of a write under it, and the target of a write to the account itself (the
 * account is what that write changes). Everything else, and every read this cannot place, is a target.
 */
export function readRoleOf(read: unknown, write?: CompiledRequest): ReadRole {
  const declared = declaredRole(read);
  if (declared) return declared;
  const r = read as Partial<CompiledRequest> | null | undefined;
  if (!r || !isAccountPath(r.gateway, r.path)) return 'target';
  return write && isAccountPath(write.gateway, write.path) ? 'target' : 'account_parent';
}

/** A subscript of a path as `changedStateFields` writes it: a position, or a JSON-encoded key. */
const subscript = /\[(\d+|"(?:[^"\\]|\\.)*")\]/g;
/** The state of a review is a list with one entry per read, so the first subscript of a path is its read. */
const readOfPath = (path: string): number | undefined => {
  const m = /^\$\[(\d+)\]/.exec(path);
  return m ? Number(m[1]) : undefined;
};

const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const identityWords =
  'id|ids|urn|name|status|role|type|currency|currency_code|timezone|time_zone|country|country_code|organi[sz]ation';
/** The identity of an account, however its provider spells it: its own word, or a field named for it (`ad_account_id`, `currencyCode`). */
const identityKey = new RegExp('^(?:' + identityWords + ')$|_(?:' + identityWords + ')$');

/**
 * Whether a changed path of an account or parent read is an identity change: a row that came or went, or a value under a
 * key that names an identity (a nested `status.code` is one). A balance, a signed link or a contact record is not.
 */
function identityPath(path: string): boolean {
  const keys = [...path.matchAll(subscript)].slice(1).map(m => m[1]!);
  if (!keys.length || !keys.at(-1)!.startsWith('"')) return true;
  return keys.some(key => {
    if (!key.startsWith('"')) return false;
    try {
      return identityKey.test(snake(JSON.parse(key) as string));
    } catch {
      return false;
    }
  });
}

const rank: Record<ReadRole, number> = {target: 0, reference: 1, account_parent: 2};

/**
 * The changed paths that matter, from `changedStateFields` (a path begins with the position of its read in `reads`): the
 * paths of target reads first, then reference reads, then the identity changes of account and parent reads, each group in
 * the order the diff found them. `write` is the reviewed request, which decides whether an account read is the account of
 * the write or the account the write changes.
 */
export function materialFields(
  changed: readonly string[],
  reads: readonly unknown[] | undefined,
  write?: CompiledRequest,
): string[] {
  const roles = new Map<number, ReadRole>(),
    roleOf = (index: number | undefined): ReadRole => {
      if (index === undefined || !Array.isArray(reads) || index >= reads.length) return 'target';
      if (!roles.has(index)) roles.set(index, readRoleOf(reads[index], write));
      return roles.get(index)!;
    };
  return changed
    .flatMap((path, order) => {
      const role = roleOf(readOfPath(path));
      return role === 'account_parent' && !identityPath(path) ? [] : [{path, order, rank: rank[role]}];
    })
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(m => m.path);
}

/** How many material paths a refusal lists: a handful to look at first, while `changed_fields` keeps the whole diff. */
export const materialLimit = 20;
/** The material paths as the refusal carries them: at most `materialLimit`, and the full count when it cut some. */
export function surfacedMaterial(material: readonly string[]): {material: string[]; material_total?: number} {
  return material.length > materialLimit
    ? {material: material.slice(0, materialLimit), material_total: material.length}
    : {material: [...material]};
}
