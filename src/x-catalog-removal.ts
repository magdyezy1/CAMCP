import {randomUUID} from 'node:crypto';
import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {bad, fingerprint, optional, writer, type ToolCall} from './workspace-core.js';
import {catalogIngestion} from './catalog-ingestion.js';
import {storedLogin} from './connection-authority.js';
import type {XCatalogRemovalExpectation} from './x-catalog-products.js';

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
function selection(input: JsonObject) {
  if (
    input.gateway !== gateway ||
    typeof input.account_id !== 'string' ||
    !input.account_id ||
    typeof input.connection_id !== 'string' ||
    !input.connection_id
  )
    bad('Choose the exact X account, login and catalog.', 'INVALID_CATALOG_REMOVAL');
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
    scope: {gateway, account_id: input.account_id, connection_id: input.connection_id, catalog_id: input.catalog_id},
    products: input.products.filter((p: JsonObject) => selected.has(p.retailer_id)),
    source_hash: source.source_hash,
  };
}
async function collect(store: Store, call: ToolCall, actor: Actor, scope: JsonObject, products: JsonObject[]) {
  const signature = authorization(store, actor, scope);
  const result = await call(
    'amcp_workspace',
    {action: 'catalog_compare', ...scope, products, allow_upsert: true},
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
  };
}
function sourceHash(catalog: JsonObject, targets: JsonObject[]) {
  return fingerprint({catalog, targets});
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
      ' selected individual products from X catalog ' +
      binding.scope.catalog_id +
      '. Source hash ' +
      binding.source_hash +
      '. Each permanent deletion requires independent native review, execution confirmation and read-back. A scheduled feed can restore a product that it still contains.',
    idempotency_key: 'x-catalog-remove-' + previewId,
    catalog_removal_preview_id: previewId,
    catalog_removal_preview_hash: previewHash,
    catalog_removal_save_nonce: nonce,
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
export async function previewCatalogRemoval(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  writer(store, actor);
  const selected = selection(input),
    observed = await collect(store, call, actor, selected.scope, selected.products);
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
    store.db
      .prepare(
        "DELETE FROM documents WHERE tenant_id=? AND kind='x_catalog_removal_preview' AND json_extract(data,'$.expires_at')<=? AND json_extract(data,'$.plan_id') IS NULL",
      )
      .run(actor.tenantId, Date.now());
    const count = store.db
      .prepare(
        "SELECT count(*) AS n FROM documents WHERE tenant_id=? AND kind='x_catalog_removal_preview' AND json_extract(data,'$.expires_at')>?",
      )
      .get(actor.tenantId, Date.now()) as {n: number};
    if (count.n >= 100) bad('At most 100 current removal previews may be retained.', 'CATALOG_REMOVAL_LIMIT');
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
/** Only the current guarded save can bind this exact local campaign creation. */
export function catalogRemovalCreationBinding(store: Store, actor: Actor, input: JsonObject, steps: JsonObject[]) {
  if (
    input.catalog_removal_preview_id === undefined &&
    input.catalog_removal_preview_hash === undefined &&
    input.catalog_removal_save_nonce === undefined
  )
    return undefined;
  const p = store.document(actor.tenantId, 'x_catalog_removal_preview', String(input.catalog_removal_preview_id));
  current(store, actor, p, {preview_hash: input.catalog_removal_preview_hash});
  if (
    input.confirmed !== true ||
    p.expires_at <= Date.now() ||
    typeof p.save_nonce !== 'string' ||
    p.save_nonce !== input.catalog_removal_save_nonce ||
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
export async function createCatalogRemoval(store: Store, call: ToolCall, actor: Actor, input: JsonObject) {
  writer(store, actor);
  if (input.confirmed !== true)
    bad('Confirm the displayed selected removals before saving their unapproved draft.', 'CONFIRMATION_REQUIRED');
  const p = store.document(actor.tenantId, 'x_catalog_removal_preview', String(input.preview_id));
  current(store, actor, p, input);
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
    const observed = await collect(store, call, actor, p.binding.scope, p.binding.products);
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
