import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
let summary: JsonObject | undefined;
export function microsoftEvidence(action: string, fields: string[] = []): JsonObject {
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
    validation:
      'SOAP operation and top-level field correspondence only; AMCP JSON URLs, arrays and polymorphism require independent adapter tests',
    live_qualification: 'unverified',
  };
}
