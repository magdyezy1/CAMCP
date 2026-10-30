import {providerFactDetails} from './errors.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {bad, validate, type ToolCall} from './workspace-core.js';

const gateway = 'gtm_native_action';

/**
 * The workspace tool's measurement_audit (ARC-01 phase B: a branch of src/workspace.ts until wave 4c; the provider
 * workflows registry, src/provider-workflows.ts, registers it): Tag Manager's scoped configuration audit of one
 * container workspace, read through the delegated tool's gtm_audit_ops with its versions and without its resources,
 * under the same connection before and after the read. It is configuration evidence only and changes nothing.
 */
export async function gtmMeasurementAudit(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  const requirements = input.requirements ?? {};
  validate(requirements, ['container_id', 'workspace_id']);
  const connection = store.resolveConnection(actor, gateway, input.account_id, input.connection_id);
  const result = await call(
    gateway,
    {
      operation: 'gtm_audit_ops',
      arguments: {
        connection_id: connection.id,
        account_id: input.account_id,
        ...requirements,
        include_versions: true,
        include_resources: false,
      },
    },
    actor,
  );
  // A provider refusal keeps its allow-listed facts (status, request ID, code, layer; never its body), so the
  // website can name them (WEB-03, owner decision D21).
  if (!result.success)
    bad(
      result.error?.message ?? 'Measurement audit failed.',
      result.error?.code ?? 'MEASUREMENT_AUDIT_FAILED',
      providerFactDetails(result.error),
    );
  store.resolveConnection(actor, gateway, input.account_id, connection.id);
  return {
    record_kind: 'measurement_audit',
    scope: {connection_id: connection.id, account_id: input.account_id ?? null, ...requirements},
    configuration: result.data,
    event_delivery: 'not_measured',
    meaning:
      'Configuration evidence only. This audit does not establish that real events fire, deduplicate, satisfy consent or attribute correctly.',
    advertising_writes: 0,
  };
}
