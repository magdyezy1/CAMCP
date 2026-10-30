import type {CompiledRequest, JsonObject} from './types.js';
import type {CreatedLookup, StateReadBuilder} from './provider-adapter.js';
import {object} from './write-common.js';

// Writes and campaigns (ARC-01 phase B, wave 4c): Meta's parts of the read-only reconciliation of an uncertain write,
// moved verbatim from src/write-reconciliation.ts, which asks them as the adapter's `writes.createdLookup` and
// `writes.namedTargets`; its state read is built with the stage's read builder.
/** Meta campaign, ad set and ad creates: the account's edge filtered by the frozen name, created after the claim. */
export function metaCreated(plan: CompiledRequest, read: StateReadBuilder): CreatedLookup | undefined {
  const match = /^\/(v\d+\.\d+)\/(act_\d+)\/(campaigns|adsets|ads)$/.exec(plan.path),
    name = object(plan.body).name;
  if (!match || plan.method !== 'POST' || typeof name !== 'string' || !name || name.length > 400) return undefined;
  const edge = read('/' + match[1] + '/' + match[2] + '/' + match[3], {
    fields: 'id,name,created_time',
    filtering: JSON.stringify([{field: 'name', operator: 'EQUAL', value: name}]),
    limit: 25,
  });
  return {
    reads: [edge],
    match(responses, submittedAt) {
      const data = object(responses[0]?.data),
        rows = (Array.isArray(data.data) ? data.data : []).map(object),
        // A clock skew allowance: the provider stamps creation after AMCP claimed the key.
        recent = rows.filter(r => r.name === name && Date.parse(String(r.created_time)) >= submittedAt - 120000);
      return {
        expected: 1,
        complete: !object(data.paging).next,
        found: recent.map((r, index) => ({index, id: String(r.id), name: r.name, created_time: r.created_time})),
      };
    },
    receipt: found => ({id: found[0]!.id}),
  };
}
/** A Meta node edit (a POST to the node's ID): the receipt names the node. */
export function metaNamedTargets(plan: CompiledRequest): JsonObject | undefined {
  if (plan.method === 'POST' && /\/\d+$/.test(plan.path))
    return {success: true, data: {id: plan.path.split('/').at(-1)}};
  return undefined;
}
