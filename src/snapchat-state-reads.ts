/**
 * Snapchat's state reads of a reviewed write no family plans (ARC-01 phase B, wave 4c: its adapter's `writes`
 * snapshot hooks, moved verbatim from src/write-snapshots.ts, which asks them where it named Snapchat). An update reads
 * each record it names, a JSON Patch its one target, and both read the creatives an ad change references; a create
 * outside an ad account reads its parent collection; an account create reads the account and what it depends on.
 */
import type {CompiledRequest} from './types.js';
import type {StateReadBuilder} from './provider-adapter.js';
import {object, fail} from './write-common.js';
import {snapLeadDependencyPaths} from './snapchat-lead-forms.js';
import {snapSegmentDependencyPaths} from './snapchat-segments.js';
import {snapAdCreativePaths} from './snapchat-ad-creatives.js';

/** The reads of an update (PUT, by record) or a JSON Patch (PATCH); other Snapchat writes are left to the review. */
export function snapchatStateReads(plan: CompiledRequest, base: StateReadBuilder): CompiledRequest[] | undefined {
  const body = object(plan.body);
  if (plan.method === 'PUT') {
    const kind = plan.path.split('/').at(-1)!,
      rows = body[kind];
    if (!Array.isArray(rows) || !rows.length || rows.length > 25)
      fail('MISSING_PAYLOAD', 'Provide 1–25 native update records.');
    if (new Set(rows.map(row => row?.id)).size !== rows.length)
      fail('INVALID_ARGUMENT', 'Each updated Snapchat resource ID must be unique.');
    return [
      ...rows.map(row => {
        if (typeof row?.id !== 'string' || !/^[-a-zA-Z0-9]+$/.test(row.id))
          fail('MISSING_PARAMETER', 'Each update record requires its exact ID.');
        return base('/v1/' + kind + '/' + row.id);
      }),
      ...snapAdCreativePaths(plan).map(path => base(path)),
    ];
  }
  if (plan.method === 'PATCH') {
    const match = /\/adaccounts\/[^/]+\/(campaigns|adsquads|ads|creatives)\/([^/]+)$/.exec(plan.path)!;
    return [base('/v1/' + match[1] + '/' + match[2]), ...snapAdCreativePaths(plan).map(path => base(path))];
  }
  return undefined;
}
/**
 * The reads of a create, by the ad account its path names (`account`, undefined outside one): outside an account its
 * parent collection and the creatives an ad references; directly on the account, the account and its owned
 * dependencies (a lead form's banner media, a lead creative's form, a lookalike's seed). Others are the review's.
 */
export function snapchatAccountStateReads(
  plan: CompiledRequest,
  base: StateReadBuilder,
  account: string | undefined,
): CompiledRequest[] | undefined {
  if (plan.method === 'POST' && !account)
    return [base(plan.path.slice(0, plan.path.lastIndexOf('/'))), ...snapAdCreativePaths(plan).map(path => base(path))];
  // Account creates also read owned dependencies: a lead form's banner media, a lead creative's form, a lookalike's seed.
  if (plan.method === 'POST' && account && plan.path.slice(account.length).split('/').filter(Boolean).length === 1)
    return [
      base(account),
      ...[...snapLeadDependencyPaths(plan), ...snapSegmentDependencyPaths(plan)].map(path => base(path)),
    ];
  return undefined;
}
