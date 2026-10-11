import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';

/**
 * GA4 test properties (MSR-04, owner direction P4): the realtime identity mode reads a user-scoped amcp_test_id custom
 * dimension, which is allowed only on a property the workspace owner explicitly marked as a test property. Marking
 * changes nothing in GA4: the owner registers the user-scoped dimension in GA4 themselves. Unmarking takes effect at
 * once, including for an inspection already running.
 */
const kind = 'ga4_test_property',
  gateway = 'ga4_native_action';
const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);

/** The owner's marking of this GA4 property as a test property, or undefined. */
export function ga4TestProperty(store: Store, tenant: string, property: string): JsonObject | undefined {
  const row = store.db
    .prepare('SELECT data FROM documents WHERE tenant_id=? AND kind=? AND id=?')
    .get(tenant, kind, property) as {data: string} | undefined;
  return row ? JSON.parse(row.data) : undefined;
}
/** Every property the owner marked, oldest first. */
export function ga4TestProperties(store: Store, tenant: string): JsonObject[] {
  return store
    .documents(tenant, kind)
    .map(d => ({property_id: d.property_id, marked_at: new Date(d.marked_at).toISOString(), marked_by: d.marked_by}))
    .sort((a, b) => String(a.marked_at).localeCompare(String(b.marked_at)));
}
/** Refuses the realtime identity mode on a property the owner has not marked as a test property. */
export function assertGa4TestProperty(store: Store, tenant: string, property: string): JsonObject {
  const marking = ga4TestProperty(store, tenant, property);
  if (!marking)
    throw new MirrorError(
      'MEASUREMENT_TEST_PROPERTY_REQUIRED',
      'Realtime test identity reads only a GA4 property the workspace owner marked as a test property (amcp_workspace save_ga4_test_property).',
      {gateway, property_id: property},
      403,
    );
  return marking;
}
/**
 * The owner marks (enabled: true) or unmarks (enabled: false) one GA4 property of a connection of this workspace.
 * Owner authority is checked by ownerOperations before this runs. Audited; no provider request.
 */
export function saveGa4TestProperty(store: Store, actor: Actor, input: JsonObject): JsonObject {
  if (
    input.confirmed !== true ||
    typeof input.enabled !== 'boolean' ||
    typeof input.connection_id !== 'string' ||
    !numericId(input.account_id)
  )
    throw new MirrorError(
      'INVALID_ARGUMENT',
      'Give connection_id, the numeric GA4 property ID as account_id, enabled and confirmed=true to mark or unmark a test property.',
    );
  const property = input.account_id;
  if (input.enabled) {
    const connection = store.listConnections(actor.tenantId).find(c => c.id === input.connection_id);
    if (!connection || connection.gateway !== gateway)
      throw new MirrorError('CONNECTION_NOT_FOUND', 'No GA4 connection of this workspace has that id.', {}, 404);
    if (!connection.accounts.includes(property))
      throw new MirrorError('ACCOUNT_SCOPE_MISMATCH', 'Select a GA4 property of that connection.', {}, 403);
    const record = {property_id: property, marked_by: actor.userId, marked_at: Date.now()};
    store.transaction(() => {
      store.putDocument(actor.tenantId, kind, property, record);
      store.appendAudit(actor.tenantId, kind + '/' + property, {
        event: 'ga4_test_property_marked',
        property_id: property,
        by: actor.userId,
      });
    });
  } else
    store.transaction(() => {
      store.db
        .prepare('DELETE FROM documents WHERE tenant_id=? AND kind=? AND id=?')
        .run(actor.tenantId, kind, property);
      store.appendAudit(actor.tenantId, kind + '/' + property, {
        event: 'ga4_test_property_unmarked',
        property_id: property,
        by: actor.userId,
      });
    });
  return {
    property_id: property,
    test_property: input.enabled,
    effect: input.enabled
      ? 'The realtime identity mode of measurement_event_identity may read this property. Register a user-scoped amcp_test_id custom dimension in GA4 yourself; AMCP changes nothing in GA4, and the dimension persists on the synthetic test user.'
      : 'Taken at once: realtime identity reads of this property are refused, including one already running.',
    provider_mutations: 0,
    test_properties: ga4TestProperties(store, actor.tenantId),
  };
}
