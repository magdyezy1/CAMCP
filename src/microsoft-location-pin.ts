import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {pinnedJson} from './pinned-json.js';
import {templateFields} from './microsoft-evidence.js';
import {microsoftGeoLocationsContract as contract, microsoftOrigin} from './microsoft-native.js';

/**
 * The pinned request of the Microsoft location lookup (CMP-03), the leaf of src/microsoft-locations.ts (ARC-01 phase B,
 * wave 4c): the Microsoft Search recipe's context reports from it whether the lookup is available, from the committed
 * pin alone, without importing the lookup's transport and authority modules (that would close an import cycle through
 * the provider hooks); src/microsoft-locations.ts re-exports all three where they were.
 */
const pin = '.mirror/VENDOR/microsoft-rest-v13.json';
const obj = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/** The refusal when the deployment cannot send the file URL request as Microsoft Learn documents it. */
export function microsoftLocationsUnpinned(): MirrorError {
  return new MirrorError(
    'MICROSOFT_LOCATIONS_UNPINNED',
    'Microsoft location search is not available in this deployment yet: AMCP sends a Microsoft request only as Microsoft Learn documents it, and the request for the geographical locations file is not pinned. Enter the location IDs instead; activation preflight lists each location with the name Microsoft gives it.',
    {operation: contract.name, page: contract.page},
    409,
  );
}

/**
 * The REST request Microsoft Learn documents for GetGeoLocationsFileUrl, from the optional pin. Without it, or when the
 * page documents another method, URL or fields, the lookup refuses before anything is sent.
 */
export function geoLocationsRest(envelope: JsonObject = pinnedJson(pin)): JsonObject {
  const op = envelope?.document?.optional_operations?.[contract.name];
  if (!obj(op)) throw microsoftLocationsUnpinned();
  let request: string[] = [],
    response: string[] = [];
  try {
    request = templateFields(op.request_json);
    response = templateFields(op.response_json);
  } catch {
    // An unreadable template documents nothing AMCP can send.
  }
  if (
    op.page !== contract.page ||
    op.method !== contract.method ||
    op.url !== microsoftOrigin + contract.path ||
    contract.fields.some(f => !request.includes(f)) ||
    ['FileUrl', 'FileUrlExpiryTimeUtc', 'LastModifiedTimeUtc'].some(f => !response.includes(f))
  )
    throw new MirrorError(
      'VENDOR_SCHEMA_UNAVAILABLE',
      'AMCP Microsoft request differs from the REST request Microsoft Learn documents for this operation.',
      {
        action: contract.name,
        method: contract.method,
        url: microsoftOrigin + contract.path,
        documented: {method: op.method ?? null, url: op.url ?? null, page: op.page ?? null},
      },
    );
  return {method: op.method, url: op.url, page: op.page, source_sha256: envelope.document_sha256};
}

/**
 * Whether this deployment can send the lookup's request (recipe_context tells the website, which then offers the search
 * or says why not). It reads the committed pin only; nothing is sent.
 */
export function microsoftLocationLookupStatus(envelope?: JsonObject): JsonObject {
  try {
    geoLocationsRest(envelope);
    return {available: true};
  } catch (error) {
    if (error instanceof MirrorError) return {available: false, code: error.code};
    throw error;
  }
}
