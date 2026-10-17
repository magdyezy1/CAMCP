import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MirrorError} from './errors.js';
import {pinnedJson} from './pinned-json.js';
import type {JsonObject} from './types.js';
let summary: JsonObject | undefined;
/** The top-level fields of a Microsoft Learn JSON template (its placeholders, such as IntValueHere, are not JSON). */
export const templateFields = (template: string): string[] =>
  Object.keys(JSON.parse(template.replace(/:\s*[A-Za-z]+ValueHere\b/g, ': null')));
/**
 * The REST request Microsoft Learn documents for an operation (F-50): its method, production URL and JSON request
 * template, pinned by tools/microsoft-rest.mjs. AMCP sends v13's REST requests; the WSDLs below describe SOAP, which
 * Microsoft retires on 2027-01-31. A request whose method, URL or fields differ from the REST page is refused.
 */
function restEvidence(action: string, fields: string[], route: {method: string; url: string}): JsonObject {
  const envelope = pinnedJson('.mirror/VENDOR/microsoft-rest-v13.json'),
    op = envelope.document.operations[action];
  if (
    !op ||
    op.method !== route.method ||
    op.url !== route.url ||
    fields.some(f => !templateFields(op.request_json).includes(f))
  )
    throw new MirrorError(
      'VENDOR_SCHEMA_UNAVAILABLE',
      'AMCP Microsoft request differs from the REST request Microsoft Learn documents for this operation.',
      {
        action,
        method: route.method,
        url: route.url,
        fields,
        documented: op ? {method: op.method, url: op.url, page: op.page} : null,
      },
    );
  return {method: op.method, url: op.url, page: op.page, source_sha256: envelope.document_sha256};
}
export function microsoftEvidence(
  action: string,
  fields: string[] = [],
  route?: {method: string; url: string},
): JsonObject {
  summary ??= JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../../generated/microsoft-summary.json', import.meta.url)), 'utf8'),
  );
  const matches = Object.entries(summary!.services as Record<string, JsonObject>).filter(
    ([, service]) => service.operations[action],
  );
  if (matches.length !== 1)
    throw new MirrorError(
      'VENDOR_SCHEMA_UNAVAILABLE',
      'Microsoft operation must resolve to exactly one official WSDL service.',
      {action},
    );
  const [service, s] = matches[0]!,
    op = s.operations[action];
  if (fields.some(f => !op.request_fields.includes(f)))
    throw new MirrorError(
      'VENDOR_SCHEMA_UNAVAILABLE',
      'AMCP Microsoft request fields differ from the pinned WSDL operation.',
      {action, fields},
    );
  return {
    route_source: summary!.evidence,
    service,
    vendor_method: action,
    source: s.source,
    document_sha256: s.document_sha256,
    soap_actions: op.soap_actions,
    request_fields: op.request_fields,
    ...(route ? {rest: restEvidence(action, fields, route)} : {}),
    validation: route
      ? 'REST (JSON) method, URL and top-level fields match Microsoft Learn; WSDL types and fields correspond. JSON arrays and polymorphism require independent adapter tests'
      : 'SOAP operation and top-level field correspondence only; AMCP JSON URLs, arrays and polymorphism require independent adapter tests',
    live_qualification: 'unverified',
  };
}
