import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {MirrorError} from './errors.js';
import {fingerprint, optional, validate, writer} from './workspace-core.js';
import {catalogDestination, catalogSourceFields, type CatalogDestination} from './catalog-destinations.js';
import {catalogRequirement} from './catalog-requirements.js';

/**
 * Catalog mapping profiles (COM-03 Phase 2): which column of a merchant's product export supplies each destination
 * field, saved once per workspace and destination catalog and versioned. The profile fixes the column that supplies
 * retailer_id, so a product's identity cannot drift between imports: choosing another identity column needs an
 * explicit `replace_identity_column: true`. A CSV source projected with a profile (src/catalog-sources.ts) records the
 * profile and its version in the lineage of the plans it produces. Saving a profile changes nothing at a provider.
 *
 * Actions: `catalog_mapping` reads the current profile of {gateway, catalog_id} (reader); `save_catalog_mapping` saves
 * requirements {columns, fixed_currency, image_mode, replace_identity_column?} as the next version (operator), with the
 * optional `revision` the caller read (0 before the first save) so a concurrent change is refused instead of
 * overwritten. An unchanged mapping keeps its version.
 */
export const catalogMappingKind = 'catalog_mapping_profile';
/** Previous versions kept with a profile, so the version a plan's lineage names stays readable. */
const historyLimit = 20;
export type CatalogMappingSettings = {
  /** Destination field → the source CSV column that supplies it. */
  columns: Record<string, string>;
  /** One currency for every row when no currency column is selected, otherwise ''. */
  fixed_currency: string;
  /** single: the image column holds one URL; first_list: the first URL of a comma-separated list. */
  image_mode: 'single' | 'first_list';
};
export type CatalogMappingRef = {profile_id: string; version: number; profile_hash: string};
function refuse(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
/** The destination and catalog a profile belongs to; the caller's access to the account is checked by its action. */
function mappingDestination(input: JsonObject): CatalogDestination {
  const d = catalogDestination(input.gateway);
  if (!d || typeof input.catalog_id !== 'string' || !d.catalogId.test(input.catalog_id))
    refuse('INVALID_CATALOG_MAPPING', 'Choose a catalog destination account and its exact native catalog ID.');
  return d;
}
export function catalogMappingId(gateway: string, catalog: string): string {
  return fingerprint({kind: catalogMappingKind, gateway, catalog_id: catalog});
}
/** The destination fields a mapping must name a column for; currency may instead be one fixed code. */
export function catalogMappingRequired(d: CatalogDestination): string[] {
  return d.sourceFields.required.filter(k => k !== 'currency');
}
/** A validated, order-independent mapping for one destination. */
export function catalogMappingSettings(d: CatalogDestination, r: JsonObject): CatalogMappingSettings {
  const fields = catalogSourceFields(d),
    columns = r.columns;
  if (!columns || typeof columns !== 'object' || Array.isArray(columns))
    refuse('INVALID_CATALOG_MAPPING', 'Choose the source column of each mapped product field.');
  const unknown = Object.keys(columns).filter(k => !fields.includes(k));
  if (unknown.length)
    refuse('INVALID_CATALOG_MAPPING', 'This destination does not take these product fields.', {
      fields: unknown,
      accepted: fields,
    });
  for (const [field, column] of Object.entries(columns))
    if (
      typeof column !== 'string' ||
      !column ||
      column !== column.trim() ||
      column.length > 200 ||
      /[\x00-\x1f\x7f]/.test(column)
    )
      refuse(
        'INVALID_CATALOG_MAPPING',
        'Name each source column as its CSV header writes it, in at most 200 characters.',
        {
          field,
        },
      );
  const missing = catalogMappingRequired(d).filter(k => columns[k] === undefined);
  if (missing.length)
    refuse('INVALID_CATALOG_MAPPING', 'Select a source column for every required product field.', {fields: missing});
  const fixed = r.fixed_currency ?? '';
  if (typeof fixed !== 'string' || (columns.currency !== undefined ? fixed !== '' : !/^[A-Z]{3}$/.test(fixed)))
    refuse(
      'INVALID_CATALOG_MAPPING',
      'Choose either a currency column or one explicit three-letter uppercase currency for every row.',
    );
  const image = r.image_mode ?? 'single';
  if (image !== 'single' && image !== 'first_list')
    refuse('INVALID_CATALOG_MAPPING', 'Choose how to read the image column.');
  // Sorted fields keep the profile hash independent of the order the columns were named in.
  return {
    columns: Object.fromEntries(
      Object.keys(columns)
        .sort()
        .map(k => [k, columns[k] as string]),
    ),
    fixed_currency: fixed,
    image_mode: image,
  };
}
const settingsOf = (doc: JsonObject): CatalogMappingSettings => ({
  columns: doc.columns,
  fixed_currency: doc.fixed_currency,
  image_mode: doc.image_mode,
});
/** The saved profile of a catalog, or undefined. */
export function currentCatalogMapping(store: Store, tenant: string, gateway: string, catalog: string) {
  return optional(store, tenant, catalogMappingKind, catalogMappingId(gateway, catalog));
}
export function catalogMappingRef(doc: JsonObject): CatalogMappingRef {
  return {profile_id: doc.profile_id, version: doc.version, profile_hash: doc.profile_hash};
}
function view(doc: JsonObject | undefined, d: CatalogDestination, catalog: string): JsonObject {
  return {
    record_kind: 'catalog_mapping',
    scope: {gateway: d.gateway, catalog_id: catalog},
    profile: doc
      ? {
          profile_id: doc.profile_id,
          version: doc.version,
          ...settingsOf(doc),
          profile_hash: doc.profile_hash,
          saved_at: doc.saved_at,
          versions: (doc.versions as JsonObject[]).map(v => ({
            version: v.version,
            profile_hash: v.profile_hash,
            retailer_id_column: v.columns.retailer_id,
            saved_at: v.saved_at,
          })),
        }
      : null,
    // What a mapping must name for this destination, so a caller can build one before the first save.
    required_fields: catalogMappingRequired(d),
    accepted_fields: catalogSourceFields(d),
    provider_mutations: 0,
  };
}
/** catalog_mapping: the current mapping profile of one destination catalog (none before the first save). */
export function catalogMapping(store: Store, actor: Actor, input: JsonObject) {
  validate(input, ['action', 'gateway', 'account_id', 'connection_id', 'catalog_id']);
  const d = mappingDestination(input);
  store.resolveConnection(actor, d.gateway, input.account_id, input.connection_id);
  return view(currentCatalogMapping(store, actor.tenantId, d.gateway, input.catalog_id), d, input.catalog_id);
}
/** save_catalog_mapping: the next version of a catalog's mapping profile; an unchanged mapping keeps its version. */
export function saveCatalogMapping(store: Store, actor: Actor, input: JsonObject) {
  validate(input, ['action', 'gateway', 'account_id', 'connection_id', 'catalog_id', 'revision', 'requirements']);
  writer(store, actor);
  const d = mappingDestination(input);
  store.resolveConnection(actor, d.gateway, input.account_id, input.connection_id);
  const settings = catalogMappingSettings(d, input.requirements ?? {}),
    replace = catalogRequirement(input, 'replace_identity_column');
  if (replace !== undefined && typeof replace !== 'boolean')
    refuse('INVALID_CATALOG_MAPPING', 'Choose true or false for replacing the retailer ID column.');
  if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 0))
    refuse('INVALID_CATALOG_MAPPING', 'Send the mapping version you read: 0 before the first save.');
  const id = catalogMappingId(d.gateway, input.catalog_id),
    profile_hash = fingerprint(settings);
  const saved = store.transaction(() => {
    const current = optional(store, actor.tenantId, catalogMappingKind, id),
      version: number = current?.version ?? 0;
    if (input.revision !== undefined && input.revision !== version)
      refuse(
        'CATALOG_MAPPING_CHANGED',
        'The saved column mapping changed since it was read. Read it again before saving.',
        {version},
        409,
      );
    if (current?.profile_hash === profile_hash) return {doc: current, changed: false, replaced: null};
    // The identity column decides which product each row is: it changes only by explicit intent.
    const replaced =
      current && current.columns.retailer_id !== settings.columns.retailer_id ? current.columns.retailer_id : null;
    if (replaced !== null && replace !== true)
      refuse(
        'CATALOG_MAPPING_IDENTITY',
        'This catalog’s products are identified by another retailer ID column. Keep that column, or replace it explicitly with replace_identity_column: true.',
        {saved_column: replaced, column: settings.columns.retailer_id},
        409,
      );
    const saved_at = Date.now(),
      next = version + 1,
      entry = {version: next, ...settings, profile_hash, saved_at, saved_by: actor.userId};
    const doc = {
      profile_id: id,
      gateway: d.gateway,
      catalog_id: input.catalog_id,
      ...entry,
      versions: [...((current?.versions as JsonObject[]) ?? []), entry].slice(-historyLimit),
    };
    store.putDocument(actor.tenantId, catalogMappingKind, id, doc);
    return {doc, changed: true, replaced};
  });
  if (saved.changed)
    store.appendAudit(actor.tenantId, 'catalog-mapping/' + id, {
      event: 'catalog_mapping_saved',
      profile_id: id,
      version: saved.doc.version,
      gateway: d.gateway,
      catalog_id: input.catalog_id,
      account_id: input.account_id,
      identity_column_replaced: saved.replaced !== null,
    });
  return {...view(saved.doc, d, input.catalog_id), changed: saved.changed};
}
/** The settings of one saved version, for a projection that names it. */
export function catalogMappingVersion(doc: JsonObject, version: number): CatalogMappingSettings | undefined {
  const v = (doc.versions as JsonObject[]).find(entry => entry.version === version);
  return v ? settingsOf(v) : undefined;
}
