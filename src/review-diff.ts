import type {CompiledRequest} from './types.js';
// The provider's own account path (`writes.accountPath`): the one provider fact this module asks, through the registry.
import {providerHooks} from './provider-hooks.js';

/**
 * Which of the fields a STATE_CHANGED names matter (Round 2.5, M1, package r25-m1-diff, L5-04; lead review S1-1), and never
 * fewer than do.
 *
 * A review reads several things before a write, and execute reads them again and refuses a review whose state differs from
 * the one it was prepared on. A read has one of four roles. The ACCOUNT container the write sits in (the advertiser, ad
 * account or customer); a PARENT it goes into (the campaign a new ad group is created in); the TARGET, the objects the write
 * changes; and a REFERENCE, a pixel, identity or catalog the write names.
 *
 * `material` lists the target first, then the parent, then the references, then the account. Every changed field of a target,
 * a parent or a reference matters and is listed. Only the ACCOUNT container is thinned, and by a deny-list: a field of the
 * account that is known noise (a balance, a contact record, a signed link, a timestamp) is left out, so a field nobody listed
 * is material, never hidden. (An allow-list of identity words hid an account's `deleted` and `test` flags, and a Snapchat
 * ad squad's budget and end time.) It orders and names; it never narrows the check: the refusal and `changed_fields` stay as
 * they are, and every changed path of every read still refuses the write. A read whose role is not known is a target.
 *
 * Roles are read off the list of reads only where the state has one entry per read; the caller says whether it has
 * (src/write-review.ts). A family that keeps its own state puts the account, the parent and the targets in one entry, where
 * the position of a path says nothing about which read it came from: there every path is a target.
 */
export type ReadRole = 'account' | 'parent' | 'target' | 'reference';

/**
 * The names a read may give its role. The pair label of an older review ("account or parent") is ambiguous, so it takes the
 * stricter of the two, the parent, whose every field is material.
 */
const roleNames: ReadonlyMap<string, ReadRole> = new Map<string, ReadRole>([
  ['account', 'account'],
  ['parent', 'parent'],
  ['account_parent', 'parent'],
  ['account_or_parent', 'parent'],
  ['target', 'target'],
  ['reference', 'reference'],
]);

/**
 * The role a read declares on itself, the one place this module takes a role from a read's own tag: `stateRole`, the name the
 * hash package (r25-m1-hash) gives it on a `CompiledRequest`, or `role`, the name this package first read. `stateRole` wins;
 * a value that is no role is no tag. The case and separators of the name are free. A merge wires the roles of the hash
 * package here and nowhere else: replace this function's body, or make it return that package's role for the read.
 */
export function declaredRole(read: unknown): ReadRole | undefined {
  const tags = read as Record<string, unknown> | null | undefined;
  for (const key of ['stateRole', 'role']) {
    const tag = tags?.[key];
    const role =
      typeof tag === 'string'
        ? roleNames.get(
            tag
              .trim()
              .toLowerCase()
              .replace(/[\s/-]+/g, '_'),
          )
        : undefined;
    if (role) return role;
  }
  return undefined;
}

/** Whether `path` is exactly the account path its provider declares, where a path longer than it only starts like it. */
function isAccountPath(gateway: unknown, path: unknown): boolean {
  if (typeof path !== 'string') return false;
  const account = providerHooks(gateway)?.writes?.accountPath?.exec(path)?.[0];
  return account !== undefined && account.length === path.length;
}

/**
 * The role of one state read of a review (the contract the hash package's roles are wired to): 'account' | 'parent' |
 * 'target' | 'reference', total (it never throws) and failing safe (an unknown read is a target, whose every field is
 * material). A role the read declares on itself wins (`declaredRole`). Otherwise a read of exactly the provider's account
 * path is the account of a write under it, and the target of a write to the account itself (the account is what that
 * write changes). Everything else, and every read this cannot place, is a target.
 */
export function readRoleOf(read: unknown, write?: CompiledRequest): ReadRole {
  const declared = declaredRole(read);
  if (declared) return declared;
  const r = read as Partial<CompiledRequest> | null | undefined;
  if (!r || !isAccountPath(r.gateway, r.path)) return 'target';
  return write && isAccountPath(write.gateway, write.path) ? 'target' : 'account';
}

/** A subscript of a path as `changedStateFields` writes it: a position, or a JSON-encoded key. */
const subscript = /\[(\d+|"(?:[^"\\]|\\.)*")\]/g;
/** The state of a review is a list with one entry per read, so the first subscript of a path is its read. */
const readOfPath = (path: string): number | undefined => {
  const m = /^\$\[(\d+)\]/.exec(path);
  return m ? Number(m[1]) : undefined;
};

const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
/**
 * What an account container carries that is no configuration of it, by name, in every spelling a provider uses: balances and
 * totals spent, contact records, signed links, and its own timestamps. A key that is none of these is material, so a field
 * nobody listed (`deleted`, `test`, `spend_cap`, a field a provider adds next year) is never hidden.
 */
const accountNoise = new RegExp(
  '^(?:' +
    [
      'balance',
      'amount_spent',
      'total_spent',
      'total_spend',
      'spent',
      'spend',
      'email|e_mail|phone|telephone|phone_number|telephone_number|contacter|contact|contacts|address',
      'url|uri|link|signature',
      'create_time|created_time|created_at|update_time|updated_time|updated_at|modified_time|modified_at',
      'last_modified|last_updated|timestamp',
    ].join('|') +
    ')$|_(?:balance|email|phone|phone_number|telephone_number|url|uri|link|signature)$',
);

/**
 * Whether a changed path of an account read is noise: a value under a key that names noise (a nested `billing.balance` is
 * one). A row that came or went, and a path with no key, are never noise.
 */
function noisePath(path: string): boolean {
  const keys = [...path.matchAll(subscript)].slice(1).map(m => m[1]!);
  if (!keys.length || !keys.at(-1)!.startsWith('"')) return false;
  return keys.some(key => {
    if (!key.startsWith('"')) return false;
    try {
      return accountNoise.test(snake(JSON.parse(key) as string));
    } catch {
      return false;
    }
  });
}

/** What the write changes and what it names come before the container it sits in. */
const rank: Record<ReadRole, number> = {target: 0, parent: 1, reference: 2, account: 3};

/**
 * The changed paths that matter, from `changedStateFields` (a path begins with the position of its read in `reads`): the
 * paths of target reads first, then parent reads, then reference reads, then the account's changes that are not known
 * noise, each group in the order the diff found them. `reads` is the list of reads of a review whose state has one entry per
 * read; without it (a family that keeps its own state) every path is a target. `write` is the reviewed request, which decides
 * whether an account read is the account of the write or the account the write changes.
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
      return role === 'account' && noisePath(path) ? [] : [{path, order, rank: rank[role]}];
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
