import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {bad, fingerprint} from './workspace-core.js';
import {storedLogin} from './connection-authority.js';
import type {XCatalogRemovalExpectation} from './x-catalog-products.js';

/**
 * A selected X catalog removal's saved preview and its plan binding (COM-02 B and C): the preview's authority, the
 * exact draft it saves and the checks of the plan's creation and of each unsent step. The X adapter registers the
 * binding (src/x-adapter.ts, campaign.planBinding), so this module does not read the supplied products: the preview
 * and the save that read them are src/x-catalog-removal.ts, which re-exports the binding (ARC-01).
 */
const gateway = 'x_ads_native_action',
  workflow = 'x-catalog-selected-removal-v1';
const changed = (message: string): never => bad(message, 'CATALOG_REMOVAL_CHANGED');
const cleanStep = (s: JsonObject) =>
  Object.fromEntries(
    ['id', 'kind', 'gateway', 'account_id', 'connection_id', 'depends_on', 'description', 'arguments'].map(k => [
      k,
      s[k],
    ]),
  );
function authorization(store: Store, actor: Actor, scope: JsonObject) {
  store.assertActorActive(actor);
  const c = store.resolveConnection(actor, gateway, scope.account_id, scope.connection_id);
  return fingerprint({
    login: storedLogin(store, c),
    accounts: [...c.accounts].sort(),
    scopes: [...c.scopes].sort(),
    enabled: c.enabled,
  });
}
function current(store: Store, actor: Actor, p: JsonObject, input: JsonObject) {
  if (
    p.user_id !== actor.userId ||
    p.actor_role !== actor.role ||
    p.session_id !== (store.sessionIdentity(actor) ?? null) ||
    p.preview_hash !== input.preview_hash ||
    p.preview_hash !== fingerprint(p.binding)
  )
    changed("Choose this session's original removal preview and hash.");
  if (
    ['gateway', 'account_id', 'connection_id', 'catalog_id'].some(
      k => input[k] !== undefined && input[k] !== p.binding.scope[k],
    ) ||
    ['products', 'retailer_ids', 'allow_upsert', 'name', 'requirements'].some(k => input[k] !== undefined)
  )
    changed('Save the original removal preview. Changed scope, products or selection require a new preview.');
  if (authorization(store, actor, p.binding.scope) !== p.binding.authorization_signature)
    changed('The selected login or read access changed. Read a new removal preview.');
}
function draft(binding: JsonObject, previewId: string, previewHash: string, nonce: string) {
  return {
    action: 'create',
    name: 'X catalog removal ' + binding.scope.catalog_id,
    brief:
      'Explicitly remove ' +
      binding.targets.length +
      (binding.selection_source === 'listed_inventory'
        ? ' selected listed individual products from X catalog ' +
          binding.scope.catalog_id +
          '. Listed inventory hash ' +
          binding.listed_inventory_hash +
          '; each was chosen by its native key, not because a source lacks it'
        : ' selected individual products from X catalog ' +
          binding.scope.catalog_id +
          '. Source hash ' +
          binding.source_hash) +
      '. Each permanent deletion requires independent native review, execution confirmation and read-back. A scheduled feed can restore a product that it still contains.',
    idempotency_key: 'x-catalog-remove-' + previewId,
    catalog_binding: {kind: 'removal', preview_id: previewId, preview_hash: previewHash, save_nonce: nonce},
    confirmed: true,
    steps: binding.targets.map((target: JsonObject, i: number) => ({
      id: 'remove-' + (i + 1),
      kind: 'write',
      gateway,
      account_id: binding.scope.account_id,
      connection_id: binding.scope.connection_id,
      arguments: {
        action: 'x_product_catalogs_product_catalog_id_products_delete',
        params: {product_catalog_id: binding.scope.catalog_id},
        payload: {product_keys: [target.product_id]},
      },
      depends_on: [],
      description: 'Remove X catalog retailer ID ' + target.retailer_id + ' · product key ' + target.product_id,
    })),
  };
}
/** Only the current guarded save can bind this exact local campaign creation. */
export function catalogRemovalCreationBinding(store: Store, actor: Actor, input: JsonObject, steps: JsonObject[]) {
  const b = input.catalog_binding;
  if (b === undefined || b?.kind === 'lineage') return undefined;
  if (
    !b ||
    typeof b !== 'object' ||
    b.kind !== 'removal' ||
    Object.keys(b).some(k => !['kind', 'preview_id', 'preview_hash', 'save_nonce'].includes(k))
  )
    changed('Save the current exact removal preview through its guarded workflow.');
  const p = store.document(actor.tenantId, 'x_catalog_removal_preview', String(b.preview_id));
  current(store, actor, p, {preview_hash: b.preview_hash});
  if (
    input.confirmed !== true ||
    p.expires_at <= Date.now() ||
    typeof p.save_nonce !== 'string' ||
    p.save_nonce !== b.save_nonce ||
    p.save_until <= Date.now()
  )
    changed('Save the current exact removal preview through its guarded workflow.');
  const expected = draft(p.binding, p.id, p.preview_hash, p.save_nonce);
  if (
    input.name !== expected.name ||
    input.brief !== expected.brief ||
    input.idempotency_key !== expected.idempotency_key ||
    fingerprint(steps.map(cleanStep)) !== fingerprint(expected.steps.map(cleanStep))
  )
    changed('The draft differs from its exact selected removal preview.');
  const {authorization_signature, ...binding} = p.binding;
  return {...binding, workflow, preview_id: p.id, preview_hash: p.preview_hash};
}
/** The refusal of a selected-removal step whose product no longer matches its saved evidence (COM-02 C). */
export function catalogRemovalChanged(): never {
  return changed(
    'The selected product evidence changed after this draft. Read a new removal preview; no products were deleted.',
  );
}
/**
 * Accepted/uncertain requests recover their original native key; only unsent steps check original evidence. The check
 * is local (COM-02 C): the step must still be the exact saved proposal, and the returned expectation makes the step's
 * own native review compare its state read with the bound product at prepare and again at execute
 * (xCatalogRemovalStateCheck). No separate catalog comparison is read per phase.
 */
export function assertCatalogRemovalStep(run: JsonObject, step: JsonObject): XCatalogRemovalExpectation | undefined {
  const b = run.catalog_removal;
  if (!b || step.status === 'executing') return undefined;
  const i = run.steps.findIndex((s: JsonObject) => s.id === step.id),
    target = b.targets[i];
  const expected = draft(b, b.preview_id, b.preview_hash, '').steps[i];
  if (
    b.workflow !== workflow ||
    !target ||
    !expected ||
    fingerprint(cleanStep(step)) !== fingerprint(cleanStep(expected))
  )
    changed('This step no longer matches its original selected removal proposal.');
  if (!b.catalog || typeof target.product_id !== 'string' || !target.before)
    changed('The original selected source product is unavailable.');
  return {catalog: b.catalog, target};
}
// The preview and save of src/x-catalog-removal.ts read and write the same preview with these.
export {
  gateway as xCatalogRemovalGateway,
  changed as removalChanged,
  authorization as removalAuthorization,
  current as currentRemovalPreview,
  draft as removalDraft,
};
