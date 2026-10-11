import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {MirrorError} from './errors.js';
import {pinnedJson} from './pinned-json.js';
import {dataManagerOrigin} from './google-data-manager-routes.js';
import type {CompiledRequest, JsonObject} from './types.js';

/**
 * Wire-contract enforcement (PRV-05): every request whose route has a pinned, machine-readable vendor request schema is
 * checked against it, field by field and at every depth, before it is sent.
 *
 * - Google Ads keeps its own always-enforced check (validateGoogleRequest), which now shares `discoveryIssues`.
 * - Tag Manager, GA4, Search Console and Business Profile: the request schema of the route in
 *   generated/vendor-routes.json, resolved against its pinned Discovery document (.mirror/VENDOR/<source>.json).
 * - Display & Video 360: the request schema of the pinned v4 Discovery method with the plan's verb and path.
 * - Microsoft Advertising: the operation's request element of the pinned WSDL type model (generated/
 *   microsoft-contracts.json); JSON arrays and the REST `Type` discriminator follow Microsoft Learn's REST templates.
 * - Data Manager: the pinned v1 Discovery document (.mirror/VENDOR/datamanager-v1.json), on top of AMCP's own exact-body
 *   check (src/google-data-manager.ts); its routes report `unpinned` only if that file is removed.
 *
 * Each pinned document is used only while its seal holds (the SHA-256 of the document matches the digest recorded
 * when it was fetched). Validation never grants anything: routes, scopes, reviews and owner policies still decide.
 *
 * AMCP_WIRE_CONTRACTS selects what a violation does: `shadow` (the default) records it in the review's contract
 * evidence, the write_prepared audit entry and a provider metric of the gateway (`wire_contract_violations` for writes,
 * `wire_contract_read_violations` for reads, which are never enforced); `enforce` also refuses a reviewed write with
 * INVALID_VENDOR_BODY before anything is sent (reads are never refused); `off` skips the check. Enforcement is switched
 * on only after the fixtures show no false positive and 14 days of deployed shadow mode record no write violation and
 * no failed check (docs/WRITE-OPERATIONS.md).
 *
 * The check itself never breaks a request outside enforcement: an unexpected exception of the validator (a pinned
 * document of a shape it does not expect) is reported as `check_failed` and counted as
 * `wire_contract_check_failures`; only an enforced write fails closed on it (VENDOR_SCHEMA_UNAVAILABLE).
 */
export type WireContractMode = 'off' | 'shadow' | 'enforce';
const modes: readonly WireContractMode[] = ['off', 'shadow', 'enforce'];
/** The configured mode; startup refuses any other value (server/runtime.ts), and a later one fails closed. */
export function wireContractMode(value = process.env.AMCP_WIRE_CONTRACTS): WireContractMode {
  if (value === undefined || value === '') return 'shadow';
  return modes.includes(value as WireContractMode) ? (value as WireContractMode) : 'enforce';
}
/** Throws when AMCP_WIRE_CONTRACTS is set to anything but off, shadow or enforce. */
export function assertWireContractMode(value = process.env.AMCP_WIRE_CONTRACTS): void {
  if (value !== undefined && value !== '' && !modes.includes(value as WireContractMode))
    throw new Error('AMCP_WIRE_CONTRACTS must be off, shadow or enforce.');
}

export interface WireIssue {
  field: string;
  reason: string;
}
export interface DiscoveryOptions {
  /** A read keeps ProtoJSON's numeric enum allowance; a reviewed write must name the enum value. */
  readOnly?: boolean;
  /** At most this many issues are kept (the check still visits the whole body). */
  maxIssues?: number;
  /** Names the provider in the bounds and unresolved-schema refusals. */
  label?: string;
}
const record = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * Structural issues of `value` against a Discovery schema (PRV-05 step 1, shared by Google Ads and every other pinned
 * Discovery document). Discovery is not JSON Schema: ProtoJSON int64 accepts decimal strings or safe integers, null
 * means unset, and nothing is coerced. Unknown fields, wrong types, values outside the declared 64-bit range and enum
 * values absent from the document are issues; so is a numeric enum in a write, which no review could check.
 */
export function discoveryIssues(
  schemas: Record<string, JsonObject>,
  root: JsonObject,
  value: unknown,
  options: DiscoveryOptions = {},
): WireIssue[] {
  const issues: WireIssue[] = [],
    max = options.maxIssues ?? 20,
    label = options.label ?? 'vendor';
  let nodes = 0;
  const issue = (field: string, reason: string) => {
    if (issues.length < max) issues.push({field, reason});
  };
  const visit = (raw: JsonObject, v: any, path: string, depth: number) => {
    if (++nodes > 50000 || depth > 64)
      throw new MirrorError('INVALID_VENDOR_BODY', label + ' request exceeds validation bounds.');
    const schema = raw.$ref ? schemas[raw.$ref] : raw;
    if (!schema)
      throw new MirrorError(
        'VENDOR_SCHEMA_UNAVAILABLE',
        'An ingested ' + label + ' schema reference cannot be resolved.',
        {
          schema: raw.$ref,
        },
      );
    // Discovery's `any` (a protobuf Value, such as a Business Profile attribute value) takes every JSON value.
    if (v === null || v === undefined || schema.type === 'any') return;
    if (schema.type === 'object') {
      if (typeof v !== 'object' || Array.isArray(v)) {
        issue(path, 'Expected an object');
        return;
      }
      for (const [key, item] of Object.entries(v)) {
        const child = schema.properties?.[key] ?? schema.additionalProperties;
        if (child && typeof child === 'object') visit(child, item, path + '/' + key, depth + 1);
        else if (
          child !== true &&
          !(key === '@type' && (schema.id?.endsWith('__Any') || schema.id === 'GoogleProtobufAny'))
        )
          issue(path + '/' + key, 'Field absent from the pinned vendor request schema');
      }
    } else if (schema.type === 'array') {
      if (!Array.isArray(v)) issue(path, 'Expected an array');
      else v.forEach((item, i) => visit(schema.items, item, path + '/' + i, depth + 1));
    } else if (['int64', 'uint64'].includes(schema.format)) {
      const decimal =
        (typeof v === 'string' && /^-?\d+$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v));
      if (!decimal) issue(path, 'Expected a decimal string or safe integer');
      else {
        const n = BigInt(v),
          unsigned = schema.format === 'uint64';
        if (n < (unsigned ? 0n : -(1n << 63n)) || n > (unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n))
          issue(path, 'Integer outside the declared 64-bit range');
      }
    } else if (schema.enum && typeof v === 'number' && Number.isSafeInteger(v)) {
      // ProtoJSON permits enum numbers, but Discovery has no reliable numeric mapping: a reviewed mutation could not be
      // checked against owner policies or read back (CampaignStatus 2 is ENABLED). Reads keep the ProtoJSON allowance.
      if (!options.readOnly) issue(path, 'Use the enum name; a numeric enum value cannot be reviewed');
    } else if (schema.type === 'integer') {
      if (!Number.isSafeInteger(v)) issue(path, 'Expected a safe integer');
    } else if (schema.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) issue(path, 'Expected a finite number');
    } else if (schema.type && typeof v !== schema.type) issue(path, 'Expected ' + schema.type);
    else if (schema.enum && !schema.enum.includes(v)) issue(path, 'Value absent from the pinned vendor enum');
  };
  visit(root, value, '', 0);
  return issues;
}

/** A pinned vendor document, read once, with whether its recorded seal still holds. */
interface Sealed {
  envelope: JsonObject;
  sealed: boolean;
}
const sealedCache = new Map<string, Sealed | null>();
const vendorPath = (name: string) => '.mirror/VENDOR/' + name + '.json';
function exists(path: string): boolean {
  return fs.existsSync(fileURLToPath(new URL('../../' + path, import.meta.url)));
}
/** `name`'s pinned envelope, or null when it was never fetched. The seal is checked once per process. */
export function sealedVendorDocument(name: string): Sealed | null {
  if (!sealedCache.has(name)) {
    const path = vendorPath(name);
    if (!exists(path)) sealedCache.set(name, null);
    else {
      const envelope = pinnedJson<JsonObject>(path);
      sealedCache.set(name, {
        envelope,
        sealed:
          typeof envelope.document_sha256 === 'string' &&
          createHash('sha256').update(JSON.stringify(envelope.document)).digest('hex') === envelope.document_sha256,
      });
    }
  }
  return sealedCache.get(name)!;
}

/** What one request's wire-contract check found. */
export interface WireContractCheck {
  /**
   * `conforms`, `violations`; `unpinned` when the route's contract is not fetched, `unsealed` when its seal broke,
   * `check_failed` when the validator itself failed (its issue names the error class, never a value).
   */
  status: 'conforms' | 'violations' | 'unpinned' | 'unsealed' | 'check_failed';
  /** The pinned document (or model) the request was checked against. */
  contract: string;
  vendor_method: string;
  document_sha256?: string;
  issues: WireIssue[];
}
export interface Resolved {
  contract: string;
  vendor_method: string;
  /** Null when the pinned document is absent; otherwise the check of a body. */
  check?: (body: unknown, readOnly: boolean) => WireIssue[];
  sealed?: boolean;
  document_sha256?: string;
}

// Delegated Google routes (Tag Manager, GA4, Search Console, Business Profile): the route's request schema in
// generated/vendor-routes.json, whose $refs resolve in the pinned Discovery document it was generated from.
const delegatedGateways = new Set([
  'gtm_native_action',
  'ga4_native_action',
  'google_search_console_native_action',
  'google_business_native_action',
]);
let delegatedIndex: Map<string, JsonObject> | undefined;
function delegatedRoute(plan: CompiledRequest): JsonObject | undefined {
  if (!delegatedIndex) {
    delegatedIndex = new Map();
    for (const r of pinnedJson<JsonObject>('generated/vendor-routes.json').routes as JsonObject[])
      if (delegatedGateways.has(r.gateway) && r.requestSchema)
        delegatedIndex.set(r.gateway + '/' + r.operation + '/' + r.action, r);
  }
  const action = plan.action.includes('/') ? plan.action : plan.action + '/';
  const r = delegatedIndex.get(plan.gateway + '/' + action);
  return r && r.method === plan.method ? r : undefined;
}
function discoveryContract(name: string, vendorMethod: string, root: JsonObject | undefined, label: string): Resolved {
  const pinned = sealedVendorDocument(name);
  if (!pinned) return {contract: name, vendor_method: vendorMethod};
  const schemas = pinned.envelope.document.schemas ?? {};
  return {
    contract: name,
    vendor_method: vendorMethod,
    sealed: pinned.sealed,
    document_sha256: pinned.envelope.document_sha256,
    check: (body, readOnly) =>
      root
        ? discoveryIssues(schemas, root, body, {readOnly, label})
        : record(body) && Object.keys(body).length
          ? [{field: '', reason: 'The vendor method takes no request body'}]
          : [],
  };
}
/** Every method of a Discovery document, with a matcher of its flat path. */
const methodCache = new Map<string, {method: JsonObject; verb: string; pattern: RegExp}[]>();
function discoveryMethods(name: string): {method: JsonObject; verb: string; pattern: RegExp}[] {
  if (!methodCache.has(name)) {
    const document = sealedVendorDocument(name)?.envelope.document,
      found: {method: JsonObject; verb: string; pattern: RegExp}[] = [];
    const visit = (r: JsonObject) => {
      for (const m of Object.values((r.methods ?? {}) as Record<string, JsonObject>)) {
        const path = '/' + (document.servicePath ?? '') + (m.flatPath ?? m.path);
        found.push({
          method: m,
          verb: m.httpMethod,
          pattern: new RegExp(
            '^' +
              path
                .split(/(\{[^}]+\})/)
                .map(p => (p.startsWith('{') ? '[^/:]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
                .join('') +
              '$',
          ),
        });
      }
      for (const nested of Object.values((r.resources ?? {}) as Record<string, JsonObject>)) visit(nested);
    };
    if (document) visit(document);
    methodCache.set(name, found);
  }
  return methodCache.get(name)!;
}
function dv360Contract(plan: CompiledRequest): Resolved | undefined {
  // Media and asset uploads are multipart transports with their own contracts (src/transport.ts).
  if (plan.path.startsWith('/upload/')) return undefined;
  const matches = discoveryMethods('dv360-v4').filter(m => m.verb === plan.method && m.pattern.test(plan.path));
  if (matches.length !== 1) return undefined;
  const m = matches[0]!.method;
  return discoveryContract('dv360-v4', m.id, m.request, 'Display & Video 360');
}

// Data Manager v1 (src/google-data-manager-routes.ts): its methods in the pinned Discovery document.
const dataManagerMethods: Record<string, string> = {
  DATA_MANAGER_INGEST_AUDIENCE_MEMBERS: 'datamanager.audienceMembers.ingest',
  DATA_MANAGER_REMOVE_AUDIENCE_MEMBERS: 'datamanager.audienceMembers.remove',
  DATA_MANAGER_INGEST_EVENTS: 'datamanager.events.ingest',
  DATA_MANAGER_RETRIEVE_REQUEST_STATUS: 'datamanager.requestStatus.retrieve',
};
export const dataManagerContractName = 'datamanager-v1';
/** The Data Manager contract of `plan`, from `envelope` (tests) or the pinned document. */
export function dataManagerContract(plan: CompiledRequest, envelope?: JsonObject): Resolved | undefined {
  const vendorMethod = dataManagerMethods[plan.action];
  if (plan.gateway !== 'google_ads_native_action' || plan.origin !== dataManagerOrigin || !vendorMethod)
    return undefined;
  const pinned: Sealed | null = envelope
    ? {
        envelope,
        sealed:
          createHash('sha256').update(JSON.stringify(envelope.document)).digest('hex') === envelope.document_sha256,
      }
    : sealedVendorDocument(dataManagerContractName);
  if (!pinned) return {contract: dataManagerContractName, vendor_method: vendorMethod};
  const document = pinned.envelope.document,
    found: JsonObject[] = [];
  const visit = (r: JsonObject) => {
    for (const m of Object.values((r.methods ?? {}) as Record<string, JsonObject>)) found.push(m);
    for (const nested of Object.values((r.resources ?? {}) as Record<string, JsonObject>)) visit(nested);
  };
  visit(document);
  const method = found.find(m => m.id === vendorMethod);
  const schemas = document.schemas ?? {};
  return {
    contract: dataManagerContractName,
    vendor_method: vendorMethod,
    sealed: pinned.sealed,
    document_sha256: pinned.envelope.document_sha256,
    check: (body, readOnly) =>
      method
        ? method.request
          ? discoveryIssues(schemas, method.request, body, {readOnly, label: 'Data Manager'})
          : []
        : [{field: '', reason: 'The pinned Data Manager document has no method ' + vendorMethod}],
  };
}

// Microsoft Advertising: the pinned WSDL type model. JSON objects carry an element's fields by their XML names, a
// sequence of one unbounded element is a JSON array, and `Type` names the derived type of a polymorphic value
// (`ResponsiveSearch` for ResponsiveSearchAd, `TextAsset`), as Microsoft Learn's REST templates show.
const xs = '{http://www.w3.org/2001/XMLSchema}';
type Node = {attributes: Record<string, string>; children: Node[]; kind: string};
const local = (q: string) => q.replace(/^\{[^}]*\}/, '');
function microsoftContract(plan: CompiledRequest): Resolved | undefined {
  if (plan.gateway !== 'microsoft_ads_native_action') return undefined;
  const model = pinnedJson<JsonObject>('generated/microsoft-contracts.json');
  const services = Object.entries(model.services as Record<string, JsonObject>).filter(
    ([, s]) => s.operations[plan.action],
  );
  if (services.length !== 1) return undefined;
  const [name, service] = services[0]!,
    schemas = service.schemas as Record<string, Node>,
    element = schemas['element:{' + service.namespace + '}' + plan.action + 'Request'];
  if (!element) return undefined;
  return {
    contract: 'microsoft-' + name + '-v13',
    vendor_method: plan.action,
    sealed: true,
    document_sha256: service.document_sha256,
    check: body => microsoftIssues(schemas, element, body),
  };
}
/** Derived complex types of each base type, built once per schema set. */
const derivedCache = new WeakMap<object, Map<string, string[]>>();
function derived(schemas: Record<string, Node>): Map<string, string[]> {
  let map = derivedCache.get(schemas);
  if (!map) {
    map = new Map();
    for (const [key, node] of Object.entries(schemas)) {
      if (!key.startsWith('complexType:')) continue;
      const base = extensionOf(node)?.attributes.base;
      if (base) map.set(base, [...(map.get(base) ?? []), key.slice('complexType:'.length)]);
    }
    derivedCache.set(schemas, map);
  }
  return map;
}
function extensionOf(node: Node): Node | undefined {
  const content = node.children.find(c => local(c.kind) === 'complexContent');
  return content?.children.find(c => local(c.kind) === 'extension');
}
/** The element children of a complex type, its bases' first. */
function elementsOf(schemas: Record<string, Node>, type: string, depth = 0): Node[] {
  const node = schemas['complexType:' + type];
  if (!node || depth > 16) return [];
  const extension = extensionOf(node),
    own: Node[] = [];
  const collect = (n: Node) => {
    for (const c of n.children)
      if (local(c.kind) === 'element') own.push(c);
      else if (['sequence', 'choice', 'all', 'complexContent', 'extension'].includes(local(c.kind))) collect(c);
  };
  collect(node);
  return [...(extension ? elementsOf(schemas, extension.attributes.base!, depth + 1) : []), ...own];
}
function microsoftIssues(schemas: Record<string, Node>, element: Node, body: unknown): WireIssue[] {
  const issues: WireIssue[] = [];
  let nodes = 0;
  const issue = (field: string, reason: string) => {
    if (issues.length < 20) issues.push({field, reason});
  };
  const scalar = (type: string, v: unknown, path: string) => {
    const name = local(type);
    if (type.startsWith(xs) || type.startsWith('{http://schemas.microsoft.com/2003/10/Serialization/}')) {
      if (
        ['long', 'int', 'short', 'byte', 'unsignedInt', 'unsignedLong', 'unsignedShort', 'unsignedByte'].includes(name)
      ) {
        if (!((typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && /^-?\d+$/.test(v))))
          issue(path, 'Expected an integer');
      } else if (['double', 'decimal', 'float'].includes(name)) {
        if (!((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v))))
          issue(path, 'Expected a number');
      } else if (name === 'boolean') {
        if (typeof v !== 'boolean') issue(path, 'Expected a boolean');
      } else if (typeof v !== 'string') issue(path, 'Expected a string');
      return;
    }
    const simple = schemas['simpleType:' + type];
    if (!simple) return;
    if (typeof v !== 'string') {
      issue(path, 'Expected a string');
      return;
    }
    const restriction = simple.children.find(c => local(c.kind) === 'restriction');
    const values = restriction?.children.filter(c => local(c.kind) === 'enumeration').map(c => c.attributes.value);
    // A list type (space-separated flags) is checked only as text.
    if (values?.length && !values.includes(v)) issue(path, 'Value absent from the pinned vendor enum');
  };
  const visit = (type: string, v: unknown, path: string, depth: number) => {
    if (++nodes > 50000 || depth > 48)
      throw new MirrorError('INVALID_VENDOR_BODY', 'Microsoft request exceeds validation bounds.');
    if (v === null || v === undefined) return;
    if (!schemas['complexType:' + type]) {
      scalar(type, v, path);
      return;
    }
    const fields = elementsOf(schemas, type);
    // A sequence of one unbounded element is an array in JSON (ArrayOfAd, ArrayOfstring).
    if (
      fields.length === 1 &&
      fields[0]!.attributes.maxOccurs === 'unbounded' &&
      !extensionOf(schemas['complexType:' + type]!)
    ) {
      if (!Array.isArray(v)) issue(path, 'Expected an array');
      else v.forEach((item, i) => visit(fields[0]!.attributes.type!, item, path + '/' + i, depth + 1));
      return;
    }
    if (!record(v)) {
      issue(path, 'Expected an object');
      return;
    }
    let actual = type;
    const subtypes = derived(schemas).get(type);
    if (subtypes && typeof v.Type === 'string') {
      const named = subtypes.filter(s => [v.Type, v.Type + local(type)].includes(local(s)));
      // Deeper derivations (an ad whose type derives from a derived type) are searched once more.
      const deeper = named.length
        ? named
        : subtypes.flatMap(s =>
            (derived(schemas).get(s) ?? []).filter(d => [v.Type, v.Type + local(type)].includes(local(d))),
          );
      if (deeper.length === 1) actual = deeper[0]!;
      else if (!elementsOf(schemas, type).some(e => e.attributes.name === 'Type'))
        issue(path + '/Type', 'Type names no derived type of ' + local(type));
    }
    const known = new Map(elementsOf(schemas, actual).map(e => [e.attributes.name!, e]));
    for (const [key, item] of Object.entries(v)) {
      const e = known.get(key);
      if (key === 'Type' && actual !== type) continue;
      if (!e) issue(path + '/' + key, 'Field absent from the pinned vendor request schema');
      else if (e.attributes.type) visit(e.attributes.type, item, path + '/' + key, depth + 1);
    }
  };
  // The request element is an anonymous complex type: its sequence lists the request's fields.
  const inline = element.children.find(c => local(c.kind) === 'complexType');
  if (!record(body)) return [{field: '', reason: 'Expected an object'}];
  const fields = new Map<string, Node>();
  const collect = (n: Node) => {
    for (const c of n.children)
      if (local(c.kind) === 'element') fields.set(c.attributes.name!, c);
      else if (['sequence', 'choice', 'all'].includes(local(c.kind))) collect(c);
  };
  if (inline) collect(inline);
  for (const [key, item] of Object.entries(body)) {
    const e = fields.get(key);
    if (!e) issue('/' + key, 'Field absent from the pinned vendor request schema');
    else if (e.attributes.type) visit(e.attributes.type, item, '/' + key, 1);
  }
  return issues;
}

/** The contract of `plan`'s route, or undefined when no pinned request schema covers it. */
function resolveContract(plan: CompiledRequest): Resolved | undefined {
  if (delegatedGateways.has(plan.gateway)) {
    const r = delegatedRoute(plan);
    return r ? discoveryContract(r.sourceFile, r.vendorMethod, r.requestSchema, 'Google') : undefined;
  }
  if (plan.gateway === 'dv360_native_action') return dv360Contract(plan);
  if (plan.gateway === 'microsoft_ads_native_action') return microsoftContract(plan);
  return dataManagerContract(plan);
}
function checkResolved(resolved: Resolved, plan: CompiledRequest): WireContractCheck {
  const base = {
    contract: resolved.contract,
    vendor_method: resolved.vendor_method,
    ...(resolved.document_sha256 ? {document_sha256: resolved.document_sha256} : {}),
  };
  if (!resolved.check) return {...base, status: 'unpinned', issues: []};
  if (!resolved.sealed) return {...base, status: 'unsealed', issues: []};
  let issues: WireIssue[];
  try {
    issues = plan.body === undefined ? [] : resolved.check(plan.body, plan.readOnly);
  } catch (e) {
    // A body beyond the validation bounds, or a schema reference the pinned document cannot resolve, is a violation
    // like any other: shadow mode records it and never fails the request; enforcement refuses the write.
    if (!(e instanceof MirrorError)) return checkFailed(base, e);
    issues = [{field: '', reason: e.message}];
  }
  return {...base, status: issues.length ? 'violations' : 'conforms', issues};
}
/** A validator defect (not a finding about the body): its error class only, never its message or a value. */
function checkFailed(base: Omit<WireContractCheck, 'status' | 'issues'>, error: unknown): WireContractCheck {
  const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
  return {...base, status: 'check_failed', issues: [{field: '', reason: 'Wire-contract check failed: ' + name}]};
}
/**
 * The resolver of a route's contract. Tests replace it to prove that a failing validator never breaks a request outside
 * enforcement; production never changes it.
 */
export const wireContractResolver: {resolve: (plan: CompiledRequest) => Resolved | undefined} = {
  resolve: resolveContract,
};
/**
 * The wire-contract check of `plan`, or undefined when its route has no pinned request schema (Google Ads is checked
 * by validateGoogleRequest; Reddit and the two Criteo routes by their compile-time OpenAPI validation).
 */
export function wireContractCheck(
  plan: CompiledRequest,
  mode: WireContractMode = wireContractMode(),
): WireContractCheck | undefined {
  if (mode === 'off') return undefined;
  // Outside enforced writes the check only reports, so nothing it throws may stop a request: every exception becomes
  // `check_failed` (enforceWireContract refuses an enforced write on it).
  try {
    const resolved = wireContractResolver.resolve(plan);
    return resolved ? checkResolved(resolved, plan) : undefined;
  } catch (e) {
    return checkFailed({contract: 'unresolved', vendor_method: plan.action}, e);
  }
}
/** The check as contract evidence shows it, with the mode that decides what a violation does. */
export function wireContractEvidence(
  plan: CompiledRequest,
  mode: WireContractMode = wireContractMode(),
): JsonObject | undefined {
  const check = wireContractCheck(plan, mode);
  if (!check) return undefined;
  return {
    ...check,
    mode,
    enforced: mode === 'enforce' && !plan.readOnly,
    validation:
      'Field names, nesting, scalar types and enums of the request body against the pinned vendor contract; required fields, oneofs and business rules remain family and provider checks.',
  };
}
function violation(plan: CompiledRequest, check: WireContractCheck): MirrorError {
  return new MirrorError('INVALID_VENDOR_BODY', 'Request differs from the pinned vendor contract.', {
    contract: check.contract,
    vendor_method: check.vendor_method,
    errors: check.issues,
    next_action:
      'Correct the listed request fields. Refresh and review the pinned specification before relying on a newly introduced vendor field.',
  });
}
/**
 * Enforcement for reviewed writes (AMCP_WIRE_CONTRACTS=enforce): a write whose body differs from its pinned contract,
 * or whose contract's seal broke, is refused before anything is sent. Shadow mode and reads only report.
 */
export function assertWireContract(
  plan: CompiledRequest,
  mode: WireContractMode = wireContractMode(),
): WireContractCheck | undefined {
  const check = wireContractCheck(plan, mode);
  enforceWireContract(plan, check, mode);
  return check;
}
/** Applies the mode to a check already made (the transport records a violation before refusing it). */
export function enforceWireContract(
  plan: CompiledRequest,
  check: WireContractCheck | undefined,
  mode: WireContractMode = wireContractMode(),
): void {
  if (mode !== 'enforce' || plan.readOnly || !check) return;
  if (check.status === 'violations') throw violation(plan, check);
  if (check.status === 'unsealed')
    throw new MirrorError(
      'VENDOR_SCHEMA_UNAVAILABLE',
      'The pinned vendor contract no longer matches its recorded digest.',
      {
        contract: check.contract,
        next_action: 'Refresh the pinned specification with tools/fetch-vendor-specs.mjs and review the change.',
      },
    );
  // An enforced write is never sent unchecked: a failed check fails closed.
  if (check.status === 'check_failed')
    throw new MirrorError('VENDOR_SCHEMA_UNAVAILABLE', 'The pinned vendor contract could not be checked.', {
      contract: check.contract,
      errors: check.issues,
      next_action: 'Report this to the deployment owner; the request was not sent.',
    });
}
/**
 * The local fixture sweep (tools/wire-contract-sweep.mjs) sets AMCP_WIRE_CONTRACT_LOG to a file: each violation the
 * transport sees is appended to it as one JSON line of route and field paths, never a value. Unset, nothing is written.
 */
export function recordWireViolation(
  plan: CompiledRequest,
  check: WireContractCheck,
  path = process.env.AMCP_WIRE_CONTRACT_LOG,
) {
  if (!path) return;
  fs.appendFileSync(
    path,
    JSON.stringify({
      gateway: plan.gateway,
      action: plan.action,
      method: plan.method,
      read_only: plan.readOnly,
      contract: check.contract,
      vendor_method: check.vendor_method,
      issues: check.issues,
    }) + '\n',
  );
}
/**
 * Data Manager bodies are built by AMCP from reviewed people (src/google-data-manager.ts), so a difference from the
 * pinned contract means AMCP's builder and Google's contract diverged: refused in every mode but off, before any
 * personal data is sent. The committed pin (.mirror/VENDOR/datamanager-v1.json) decides; tests may pass `envelope`.
 */
export function assertDataManagerContract(
  plan: CompiledRequest,
  envelope?: JsonObject,
  mode: WireContractMode = wireContractMode(),
): void {
  if (mode === 'off') return;
  const resolved = dataManagerContract(plan, envelope);
  if (!resolved) return;
  const check = checkResolved(resolved, plan);
  if (check.status === 'violations') throw violation(plan, check);
  if (check.status === 'check_failed')
    throw new MirrorError('VENDOR_SCHEMA_UNAVAILABLE', 'The pinned Data Manager contract could not be checked.', {
      contract: check.contract,
      errors: check.issues,
    });
  if (check.status === 'unsealed')
    throw new MirrorError(
      'VENDOR_SCHEMA_UNAVAILABLE',
      'The pinned Data Manager contract no longer matches its recorded digest.',
      {
        contract: check.contract,
      },
    );
}
