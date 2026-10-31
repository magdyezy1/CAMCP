import {randomUUID} from 'node:crypto';
import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {bad, fingerprint, optional, writer, type ToolCall} from './workspace-core.js';
import {catalogIngestion} from './catalog-ingestion.js';
import {listedSelectionRequested} from './x-catalog-selection-inventory.js';
import {catalogRequirement} from './catalog-requirements.js';
// The saved preview's authority, draft and plan binding (ARC-01: the X adapter registers the binding from there).
import {
  currentRemovalPreview as current,
  removalAuthorization as authorization,
  removalChanged as changed,
  removalDraft as draft,
  xCatalogRemovalGateway as gateway,
} from './x-catalog-removal-binding.js';
export {
  assertCatalogRemovalStep,
  catalogRemovalChanged,
  catalogRemovalCreationBinding,
} from './x-catalog-removal-binding.js';

function selection(input: JsonObject) {
  if (
    input.gateway !== gateway ||
    typeof input.account_id !== 'string' ||
    !input.account_id ||
    typeof input.connection_id !== 'string' ||
    !input.connection_id
  )
    bad('Choose the exact X account, login and catalog.', 'INVALID_CATALOG_REMOVAL');
  const scope = {
    gateway,
    account_id: input.account_id,
    connection_id: input.connection_id,
    catalog_id: input.catalog_id,
  };
  // COM-02 B: listed products chosen by native key from an inspection, bound to the listing the person saw.
  const keys = listedSelectionRequested(input),
    listing = catalogRequirement(input, 'listed_inventory_hash');
  if (keys) {
    if (typeof listing !== 'string' || !/^[a-f0-9]{64}$/.test(listing))
      bad('Inspect the other listed X products first, then select from that listing.', 'INVALID_CATALOG_REMOVAL');
    return {
      scope,
      selection_source: 'listed_inventory',
      product_keys: keys,
      listed_inventory_hash: listing,
      source_hash: null,
    };
  }
  const source = catalogIngestion(input),
    ids = input.retailer_ids;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 50 ||
    ids.some((v: unknown) => typeof v !== 'string') ||
    new Set(ids).size !== ids.length ||
    ids.some((v: string) => !input.products.some((p: JsonObject) => p.retailer_id === v))
  )
    bad('Choose 1–50 distinct retailer IDs from the validated supplied products.', 'INVALID_CATALOG_REMOVAL');
  const selected = new Set(ids);
  return {
    scope,
    products: input.products.filter((p: JsonObject) => selected.has(p.retailer_id)),
    source_hash: source.source_hash,
  };
}
/** The current evidence of a selection: supplied products through the comparison, listed ones by native key. */
async function collect(store: Store, call: ToolCall, actor: Actor, selected: JsonObject) {
  const scope = selected.scope,
    signature = authorization(store, actor, scope),
    listed = selected.selection_source === 'listed_inventory';
  const result = await call(
    'amcp_workspace',
    listed
      ? {
          action: 'catalog_compare',
          ...scope,
          requirements: {selection_source: 'listed_inventory', product_keys: selected.product_keys},
        }
      : {action: 'catalog_compare', ...scope, products: selected.products, allow_upsert: true},
    actor,
  );
  if (!result.success)
    bad(
      result.error?.message ?? 'Selected catalog evidence could not be read.',
      result.error?.code ?? 'CATALOG_REMOVAL_UNVERIFIED',
    );
  if (authorization(store, actor, scope) !== signature)
    changed('The selected login or read access changed. Read a new removal preview.');
  const observed = result.data;
  const targets = observed.items.map((item: JsonObject) => {
    if (item.blocked || item.before?.present !== true || typeof item.product_id !== 'string')
      bad(
        'Removal needs an observed individual product for every selected retailer ID. Missing, grouped or unknown products require another workflow.',
        'CATALOG_REMOVAL_UNVERIFIED',
      );
    return {
      retailer_id: item.retailer_id,
      product_id: item.product_id,
      before: item.before,
      unsent_fields: item.unsent_fields,
    };
  });
  return {
    targets,
    catalog: observed.catalog,
    authorization_signature: signature,
    network_requests: observed.network_requests,
    captured_at: observed.captured_at,
    ...(listed ? {listed_inventory_hash: observed.listed_inventory_hash} : {}),
  };
}
function sourceHash(catalog: JsonObject, targets: JsonObject[]) {
  return fingerprint({catalog, targets});
}
export async function previewCatalogRemoval(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  writer(store, actor);
  const selected = selection(input),
    observed = await collect(store, call, actor, selected);
  // A listed selection is bound to the listing the person inspected: any change there needs a new inspection.
  if (
    selected.selection_source === 'listed_inventory' &&
    observed.listed_inventory_hash !== selected.listed_inventory_hash
  )
    changed('The listed X products changed since you inspected them. Inspect them again; no products were deleted.');
  const binding = {
    ...selected,
    targets: observed.targets,
    catalog: observed.catalog,
    observed_hash: sourceHash(observed.catalog, observed.targets),
    authorization_signature: observed.authorization_signature,
  };
  if (Buffer.byteLength(JSON.stringify(binding)) > 262144)
    bad('Choose fewer or smaller source products for a removal preview.', 'CATALOG_REMOVAL_LIMIT');
  return store.transaction(() => {
    if (authorization(store, actor, binding.scope) !== binding.authorization_signature)
      changed('Read access changed. Read a new removal preview.');
    // Expired previews not bound to a plan go first (their declared expiry, src/document-kinds.ts).
    const previews = store.repo('x_catalog_removal_preview', actor.tenantId);
    previews.purgeExpired(Date.now());
    if (previews.countUnexpired(Date.now()) >= 100)
      bad('At most 100 current removal previews may be retained.', 'CATALOG_REMOVAL_LIMIT');
    const preview_id = randomUUID(),
      preview_hash = fingerprint(binding),
      expires_at = Date.now() + 600000;
    store.putDocument(actor.tenantId, 'x_catalog_removal_preview', preview_id, {
      binding,
      preview_hash,
      expires_at,
      user_id: actor.userId,
      actor_role: actor.role,
      session_id: store.sessionIdentity(actor) ?? null,
    });
    return {
      record_kind: 'x_catalog_removal_preview',
      preview_id,
      preview_hash,
      expires_at,
      scope: binding.scope,
      source_hash: binding.source_hash,
      ...(binding.selection_source === 'listed_inventory'
        ? {
            selection_source: 'listed_inventory',
            listed_inventory_hash: binding.listed_inventory_hash,
            confirmation: 'confirmed_count',
          }
        : {}),
      targets: binding.targets,
      item_count: binding.targets.length,
      captured_at: observed.captured_at,
      network_requests: observed.network_requests,
      provider_mutations: 0,
      destructive_deletions: 0,
      meaning:
        'Only explicitly selected observed individual products are proposed for permanent removal. Saving retains an unapproved draft and deletes no products. Every unsent step rechecks selected supported evidence before native review and execution; each accepted deletion keeps its original receipt and independent read-back. Scheduled feeds may restore products they still contain. This does not reconcile products absent from your supplied source or establish X early-access entitlement.',
    };
  });
}
export async function createCatalogRemoval(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  writer(store, actor);
  if (input.confirmed !== true)
    bad('Confirm the displayed selected removals before saving their unapproved draft.', 'CONFIRMATION_REQUIRED');
  const p = store.document(actor.tenantId, 'x_catalog_removal_preview', String(input.preview_id));
  current(store, actor, p, input);
  // A listed selection saves only with the number of its products typed back (COM-02 B); a supplied one may add it.
  if (
    (p.binding.selection_source === 'listed_inventory' || input.confirmed_count !== undefined) &&
    input.confirmed_count !== p.binding.targets.length
  )
    bad('Type the number of selected products to confirm their removal.', 'CONFIRMATION_REQUIRED');
  const key = 'x-catalog-removal:' + actor.tenantId + ':' + p.id,
    owner = randomUUID();
  if (!store.acquireLock(key, owner, 90000))
    bad('This removal draft is already being saved. Inspect or retry its original preview.', 'CATALOG_REMOVAL_BUSY');
  try {
    const planId = fingerprint({
      kind: 'campaign-create',
      tenant: actor.tenantId,
      user: actor.userId,
      key: 'x-catalog-remove-' + p.id,
    });
    const original = optional(store, actor.tenantId, 'campaign_run', p.plan_id ?? planId);
    const result = (run: JsonObject) => {
      if (
        run.catalog_removal?.preview_id !== p.id ||
        run.catalog_removal?.preview_hash !== p.preview_hash ||
        run.user_id !== actor.userId
      )
        changed('The original plan does not match this removal preview.');
      store.resolveConnection(actor, gateway, p.binding.scope.account_id, p.binding.scope.connection_id);
      return {
        record_kind: 'x_catalog_removal_plan',
        id: run.id,
        state: run.state,
        website_path: '/campaigns?id=' + encodeURIComponent(run.id),
        next_call: {tool: 'amcp_campaign', arguments: {action: 'get', id: run.id}},
        provider_mutations: 0,
        destructive_deletions: 0,
        approval_required: true,
      };
    };
    if (original) {
      const value = result(original);
      store.putDocument(actor.tenantId, 'x_catalog_removal_preview', p.id, {...p, plan_id: original.id});
      return value;
    }
    if (p.plan_id) changed('The original saved removal plan is unavailable.');
    if (p.expires_at <= Date.now()) bad('The removal preview expired. Read a new preview.', 'CATALOG_REMOVAL_EXPIRED');
    const observed = await collect(store, call, actor, p.binding);
    current(store, actor, p, input);
    if (sourceHash(observed.catalog, observed.targets) !== p.binding.observed_hash)
      changed('Selected catalog evidence changed since preview. Read a new removal preview; no products were deleted.');
    if (p.expires_at <= Date.now() || !store.renewLock(key, owner, 90000))
      bad('Draft creation lost its current preview.', 'CATALOG_REMOVAL_EXPIRED');
    store.putDocument(actor.tenantId, 'x_catalog_removal_preview', p.id, {
      ...p,
      save_nonce: owner,
      save_until: Date.now() + 90000,
    });
    const created = await call('amcp_campaign', draft(p.binding, p.id, p.preview_hash, owner), actor);
    if (!created.success)
      bad(
        created.error?.message ?? 'Removal draft could not be saved.',
        created.error?.code ?? 'CATALOG_REMOVAL_FAILED',
      );
    const run = store.document(actor.tenantId, 'campaign_run', created.data.id),
      value = result(run);
    store.putDocument(actor.tenantId, 'x_catalog_removal_preview', p.id, {...p, plan_id: run.id});
    store.appendAudit(actor.tenantId, 'x-catalog-removal/' + p.id, {
      event: 'x_catalog_removal_draft_created',
      plan_id: run.id,
      preview_id: p.id,
      item_count: run.steps.length,
      account_id: p.binding.scope.account_id,
      connection_id: p.binding.scope.connection_id,
    });
    return value;
  } finally {
    const latest = optional(store, actor.tenantId, 'x_catalog_removal_preview', p.id);
    if (latest?.save_nonce === owner) {
      const {save_nonce, save_until, ...rest} = latest;
      store.putDocument(actor.tenantId, 'x_catalog_removal_preview', p.id, rest);
    }
    store.releaseLock(key, owner);
  }
}
