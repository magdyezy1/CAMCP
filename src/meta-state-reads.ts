/**
 * Meta's state reads of a reviewed write no family plans (ARC-01 phase B, wave 4c: its adapter's `writes.snapshots`,
 * moved verbatim from src/write-snapshots.ts, which asks it where it named Meta): a creation on an account edge reads
 * the account, its exact parent and a new creative's identity sources; an edit of a node reads the node with the
 * fields the edit sends. Any other Meta write is left to the review's generic reads (undefined).
 *
 * The edit's read leaves execution_options out of its fields: the edit's own option, not a node field. Named here only
 * to leave it out, tests/meta-version.test.mjs (which reads every string literal of a Meta module as a name AMCP may
 * send) accepts that name in this module because it checks that the read never asks for it.
 */
import type {CompiledRequest, DeclaredOperation} from './types.js';
import type {StateReadBuilder} from './provider-adapter.js';
import {object, fail} from './write-common.js';
import {metaCreativeCreate, metaCreativeIdentityReads} from './meta-creative-state.js';

/**
 * What a Meta write does for the review's summary (R2.5 S2-2), as the Graph API builds its URLs, which the state reads
 * below tell apart the same way: a POST to an edge of a node (/{id}/{edge}, or an account's own /act_{id}/{edge}) creates
 * what the edge holds (a pixel, an audience, a label, a copy, a catalog's product set), and a POST to the node itself
 * (/{id}) edits it. Before this, only the 14 collections the path rules knew read as creates: the rest read "Update 1
 * adspixels". A request that carries another method is no create (the summary applies that guard to every declaration).
 */
export function metaOperation(plan: CompiledRequest): DeclaredOperation | undefined {
  return plan.method === 'POST' && /^\/v[^/]+\/[^/]+\/[^/]+$/.test(plan.path) ? {operation: 'create'} : undefined;
}

export function metaStateReads(plan: CompiledRequest, base: StateReadBuilder): CompiledRequest[] | undefined {
  const body = object(plan.body);
  const create = /^\/v[^/]+\/act_[^/]+\//.test(plan.path) && plan.method === 'POST';
  if (create) {
    const reads = [base(plan.path.match(/^\/v[^/]+\/act_[^/]+/)![0], {fields: 'id,account_status,currency'})];
    const parent = plan.path.endsWith('/adsets')
      ? body.campaign_id
      : plan.path.endsWith('/ads')
        ? body.adset_id
        : undefined;
    if (plan.path.endsWith('/adsets') || plan.path.endsWith('/ads')) {
      if (typeof parent !== 'string' || !/^\d+$/.test(parent))
        fail('MISSING_PARAMETER', 'Child creates require their exact parent ID.');
      // An ad set names its campaign, which covers an active ad under a serving ad set (paused-parents.ts). A new
      // ad set reads its campaign's special ad categories (metaAdSetAudienceChoice).
      reads.push(
        base(plan.path.split('/').slice(0, 2).join('/') + '/' + parent, {
          fields: plan.path.endsWith('/ads') ? 'id,name,status,campaign_id' : 'id,name,status,special_ad_categories',
        }),
      );
    }
    if (metaCreativeCreate(plan)) reads.push(...metaCreativeIdentityReads(plan));
    return reads;
  }
  if (/^\/v[^/]+\/\d+$/.test(plan.path)) {
    const fields = new Set(['id', 'name', 'status']);
    for (const k of Object.keys(body))
      if (/^[a-z_]+$/.test(k) && !['execution_options', 'fields'].includes(k)) fields.add(k);
    return [base(plan.path, {fields: [...fields].join(',')})];
  }
  return undefined;
}
