import type {Actor, JsonObject} from './types.js';
import type {Store} from './store.js';
import {MirrorError} from './errors.js';
import {sha256} from './security.js';
import {catalogDestination, catalogSourceFields, type CatalogDestination} from './catalog-destinations.js';
import {catalogRequirement} from './catalog-requirements.js';
import {
  catalogKey,
  catalogMappingRef,
  catalogMappingRequired,
  currentCatalogMapping,
  type CatalogMappingRef,
  type CatalogMappingSettings,
} from './catalog-mapping.js';

/**
 * Catalog product sources (COM-03 Phase 2): what supplies the products a destination compares or imports. A source
 * adapter turns its input into supplied product rows and their lineage; the destination contract
 * (src/catalog-destinations.ts) then treats the rows the same whatever produced them.
 *
 * - `supplied_products`: the `products` the caller sent (the website's AMCP-column CSV of at most 50 products and
 *   WooCommerce selections).
 * - `csv`: `requirements.source = {kind: "csv", text, columns: "canonical" | "profile", profile_version?}`, a CSV of at
 *   most 500 products the server projects, with AMCP's own product columns or with the account catalog's saved mapping
 *   profile (src/catalog-mapping.ts). The website sends only the columns a profile selects, so unselected columns of a
 *   supplier export never leave the browser; MCP clients send their own export.
 *
 * Parked store sources (WooCommerce, Shopify, Salla) plug in as further adapters (`sourceAdapters`) with their own read
 * and `catalog_source_hash`. A source never establishes absence: products it lacks are retained, never deleted.
 */
export const catalogCsvLimits = {bytes: 196608, rows: 500, columns: 100, header: 200} as const;
export type CatalogSourceKind = 'supplied_products' | 'csv';
export type CatalogSource = {
  source_kind: CatalogSourceKind;
  /** The SHA-256 of the CSV text as AMCP received it; null for supplied rows. */
  catalog_source_hash: string | null;
  /** Rows the source held before any selection. */
  source_rows: number;
  /** canonical: AMCP product columns; profile: the saved mapping profile named in mapping_profile. */
  columns: 'canonical' | 'profile' | null;
  mapping_profile: CatalogMappingRef | null;
  /** How many rows a requirements.select_retailer_ids selection kept, or null for every row. */
  selected_rows: number | null;
};
export type ResolvedCatalogSource = {products: JsonObject[]; source: CatalogSource};
function refuse(code: string, message: string, details: JsonObject = {}, status = 400): never {
  throw new MirrorError(code, message, details, status);
}
/** A CSV table: unique named headers and one object per non-blank row; blank cells are left out. */
export function parseCatalogCsv(text: string): {headers: string[]; rows: Record<string, string>[]} {
  if (typeof text !== 'string' || Buffer.byteLength(text) > catalogCsvLimits.bytes)
    refuse('CATALOG_SOURCE_LIMIT', 'Use a CSV source of at most 192 KiB and 500 products.', {
      limit_bytes: catalogCsvLimits.bytes,
      limit_rows: catalogCsvLimits.rows,
    });
  text = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === '"') {
      if (field || closed) refuse('INVALID_CATALOG_SOURCE', 'Invalid CSV quoting.');
      quoted = true;
      continue;
    }
    if (closed && !['\r', '\n', ','].includes(c))
      refuse('INVALID_CATALOG_SOURCE', 'Unexpected text after a quoted CSV value.');
    if (c === ',') {
      row.push(field);
      field = '';
      closed = false;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
      field = '';
      closed = false;
      continue;
    }
    field += c;
  }
  if (quoted) refuse('INVALID_CATALOG_SOURCE', 'A quoted CSV value is not closed.');
  row.push(field);
  if (row.some(v => v !== '')) rows.push(row);
  const headers = rows.shift()?.map(h => h.replace(/^﻿/, '').trim());
  if (
    !headers?.length ||
    headers.length > catalogCsvLimits.columns ||
    headers.some(h => !h || h.length > catalogCsvLimits.header || /[\x00-\x1f\x7f]/.test(h)) ||
    new Set(headers).size !== headers.length
  )
    refuse('INVALID_CATALOG_SOURCE', 'Use 1–100 unique named CSV columns, each up to 200 characters.');
  if (rows.length > catalogCsvLimits.rows)
    refuse('CATALOG_SOURCE_LIMIT', 'Use a CSV source of at most 192 KiB and 500 products.', {
      limit_bytes: catalogCsvLimits.bytes,
      limit_rows: catalogCsvLimits.rows,
    });
  return {
    headers,
    rows: rows.map((r, index) => {
      if (r.length !== headers.length)
        refuse('INVALID_CATALOG_SOURCE', 'Every CSV row must match the header columns.', {row: index + 1});
      return Object.fromEntries(headers.map((h, i) => [h, r[i]!] as [string, string]).filter(([, v]) => v !== ''));
    }),
  };
}
/** Rows written in AMCP's own product columns. */
function canonicalRows(table: ReturnType<typeof parseCatalogCsv>, d: CatalogDestination): JsonObject[] {
  const fields = catalogSourceFields(d),
    other = table.headers.filter(h => !fields.includes(h));
  if (other.length)
    refuse(
      'INVALID_CATALOG_SOURCE',
      'AMCP columns accept only product fields; save a column mapping to read other columns.',
      {columns: other.slice(0, 20), accepted: fields},
    );
  return table.rows;
}
/**
 * Rows through a mapping profile: each field from its selected column, the fixed currency when no currency column is
 * selected, the first URL of an image list when asked. Nothing is guessed: an empty optional value stays out, and a row
 * without a required value is refused, naming the row.
 */
export function mappedCatalogRows(
  table: ReturnType<typeof parseCatalogCsv>,
  d: CatalogDestination,
  m: CatalogMappingSettings,
): JsonObject[] {
  const missing = Object.values(m.columns).filter(column => !table.headers.includes(column));
  if (missing.length) refuse('INVALID_CATALOG_SOURCE', 'Choose only columns from the loaded CSV.', {columns: missing});
  const required = [...catalogMappingRequired(d), 'currency'];
  return table.rows.map((row, index) => {
    const product: JsonObject = {};
    for (const [field, column] of Object.entries(m.columns))
      if (row[column] !== undefined) product[field] = row[column];
    if (m.columns.currency === undefined) product.currency = m.fixed_currency;
    if (m.image_mode === 'first_list' && typeof product.image_url === 'string')
      product.image_url = product.image_url.split(',')[0]!.trim();
    for (const field of required)
      if (typeof product[field] !== 'string' || !product[field].trim())
        refuse('INVALID_CATALOG_SOURCE', 'A CSV row has no value for a required product field.', {
          row: index + 1,
          field,
        });
    return product;
  });
}
/** What a source adapter read: the rows it holds for one destination, and how it read them. */
type SourceRead = {
  rows: JsonObject[];
  catalog_source_hash: string;
  columns: CatalogSource['columns'];
  mapping_profile: CatalogMappingRef | null;
};
/**
 * A product source adapter: it turns its `requirements.source` input into the rows a destination compares or imports.
 * `accepts` refuses a malformed input before anything is read; `read` returns every row the source holds. An adapter
 * never returns a removal: a product the source lacks is retained by every destination.
 */
type CatalogSourceAdapter = {
  accepts(source: JsonObject): boolean;
  read(store: Store, actor: Actor, source: JsonObject, d: CatalogDestination, input: JsonObject): SourceRead;
};
/** A CSV the server projects, with AMCP's own product columns or the account catalog's saved mapping profile. */
const csvSource: CatalogSourceAdapter = {
  accepts: s =>
    Object.keys(s).every(k => ['kind', 'text', 'columns', 'profile_version'].includes(k)) &&
    typeof s.text === 'string' &&
    ['canonical', 'profile'].includes(s.columns) &&
    (s.profile_version === undefined || (s.columns === 'profile' && Number.isSafeInteger(s.profile_version))),
  read(store, actor, s, d, input) {
    const table = parseCatalogCsv(s.text);
    let mapping: CatalogMappingRef | null = null,
      rows: JsonObject[];
    if (s.columns === 'profile') {
      const profile = currentCatalogMapping(store, actor.tenantId, d.gateway, input.account_id, input.catalog_id);
      if (!profile) refuse('CATALOG_MAPPING_MISSING', 'Save a column mapping for this catalog first.', {}, 409);
      // The version the caller saw: a mapping changed in between would project other columns.
      if (s.profile_version !== undefined && s.profile_version !== profile.version)
        refuse(
          'CATALOG_MAPPING_CHANGED',
          'The saved column mapping changed since it was read. Read it again before saving.',
          {version: profile.version},
          409,
        );
      mapping = catalogMappingRef(profile);
      rows = mappedCatalogRows(table, d, {
        columns: profile.columns,
        fixed_currency: profile.fixed_currency,
        image_mode: profile.image_mode,
      });
    } else rows = canonicalRows(table, d);
    return {rows, catalog_source_hash: sha256(s.text), columns: s.columns, mapping_profile: mapping};
  },
};
/**
 * The registered product source adapters, by `requirements.source.kind`. The parked store sources (WooCommerce,
 * Shopify, Salla; PRK-01) register here when the owner activates them, each with its own bounded read and its own
 * `catalog_source_hash`; the destination contract (src/catalog-destinations.ts) and the plan lineage stay as they are.
 */
const sourceAdapters: Readonly<Record<string, CatalogSourceAdapter>> = {csv: csvSource};
/**
 * The products of a catalog action's `requirements.source`, or undefined when the caller supplied `products`.
 * catalog_plan may also keep a subset of the source rows with `requirements.select_retailer_ids`.
 */
export function resolveCatalogSource(store: Store, actor: Actor, input: JsonObject): ResolvedCatalogSource | undefined {
  const s = catalogRequirement(input, 'source'),
    select = catalogRequirement(input, 'select_retailer_ids');
  if (s === undefined) {
    if (select !== undefined)
      refuse('INVALID_CATALOG_SOURCE', 'Select retailer IDs of a CSV source; send supplied products directly instead.');
    return undefined;
  }
  if (input.products !== undefined) refuse('INVALID_CATALOG_SOURCE', 'Send products or a CSV source, not both.');
  const adapter =
    s &&
    typeof s === 'object' &&
    !Array.isArray(s) &&
    typeof s.kind === 'string' &&
    Object.hasOwn(sourceAdapters, s.kind)
      ? sourceAdapters[s.kind]
      : undefined;
  if (!adapter || !adapter.accepts(s))
    refuse(
      'INVALID_CATALOG_SOURCE',
      'A CSV source names kind "csv", its text, columns "canonical" or "profile" and an optional profile_version.',
    );
  const d = catalogDestination(input.gateway);
  if (!d || typeof input.catalog_id !== 'string' || !catalogKey.test(input.catalog_id))
    refuse('INVALID_CATALOG_SOURCE', 'Choose a catalog destination account and its exact native catalog ID.');
  // The caller's access to the account comes first: its mapping profiles are read only for that account.
  store.resolveConnection(actor, d.gateway, input.account_id, input.connection_id);
  const read = adapter.read(store, actor, s, d, input),
    rows = read.rows;
  if (!rows.length) refuse('INVALID_CATALOG_SOURCE', 'The CSV has no product rows.');
  let products = rows;
  if (select !== undefined) {
    if (input.action !== 'catalog_plan')
      refuse('INVALID_CATALOG_SOURCE', 'Only catalog_plan keeps a selection of source rows.');
    if (
      !Array.isArray(select) ||
      !select.length ||
      select.length > 50 ||
      select.some((v: unknown) => typeof v !== 'string') ||
      new Set(select).size !== select.length
    )
      refuse('INVALID_CATALOG_SOURCE', 'Choose 1–50 distinct retailer IDs of the CSV source.');
    const ids = rows.map(r => r.retailer_id);
    if (new Set(ids).size !== ids.length)
      refuse('INVALID_CATALOG_SOURCE', 'The CSV source names a retailer ID more than once.');
    if (select.some((v: string) => !ids.includes(v)))
      refuse('INVALID_CATALOG_SOURCE', 'Choose 1–50 distinct retailer IDs of the CSV source.');
    const kept = new Set(select);
    products = rows.filter(r => kept.has(r.retailer_id));
  }
  return {
    products,
    source: {
      source_kind: s.kind as CatalogSourceKind,
      catalog_source_hash: read.catalog_source_hash,
      source_rows: rows.length,
      columns: read.columns,
      mapping_profile: read.mapping_profile,
      selected_rows: select === undefined ? null : products.length,
    },
  };
}
/** The lineage of supplied rows the caller sent as `products`. */
export function suppliedCatalogSource(products: JsonObject[]): CatalogSource {
  return {
    source_kind: 'supplied_products',
    catalog_source_hash: null,
    source_rows: products.length,
    columns: null,
    mapping_profile: null,
    selected_rows: null,
  };
}
