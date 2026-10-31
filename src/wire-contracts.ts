import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {MirrorError} from './errors.js';
import {pinnedJson} from './pinned-json.js';
import type {CompiledRequest, JsonObject} from './types.js';
// Wave 4c round 6 (w4c-arc6-tables): each provider's contract facts, and the Discovery check, now a leaf.
import type {WireContractFacts} from './provider-adapter.js';
import {providerHooks, registeredProviderHooks} from './provider-hooks.js';
import {discoveryIssues, type WireIssue} from './discovery-issues.js';
export {discoveryIssues, type DiscoveryOptions, type WireIssue} from './discovery-issues.js';

/**
 * Wire-contract enforcement (PRV-05): every request whose route has a pinned, machine-readable vendor request schema is
 * checked against it, field by field and at every depth, before it is sent.
 *
 * - Google Ads keeps its own always-enforced check (validateGoogleRequest), which now shares `discoveryIssues`
 *   (src/discovery-issues.ts).
 * - Tag Manager, GA4, Search Console and Business Profile: the request schema of the route in
 *   generated/vendor-routes.json, resolved against its pinned Discovery document (.mirror/VENDOR/<source>.json).
 * - Display & Video 360: the request schema of the pinned v4 Discovery method with the plan's verb and path.
 * - Microsoft Advertising: the operation's request element of the pinned WSDL type model (generated/
 *   microsoft-contracts.json); JSON arrays and the REST `Type` discriminator follow Microsoft Learn's REST templates.
 * - Data Manager: the pinned v1 Discovery document (.mirror/VENDOR/datamanager-v1.json), on top of AMCP's own exact-body
 *   check (src/google-data-manager.ts); its routes report `unpinned` only if that file is removed.
 *
 * Each provider declares which of these is its contract (hooks `wireContract`, ARC-01 wave 4c round 6: the routes'
 * label, the Discovery document, Microsoft's model in src/microsoft-wire-contract.ts, the Data Manager methods); this
 * module keeps the modes, the seals, the checks and every refusal.
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

const record = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

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

// Delegated Google routes (Tag Manager, GA4, Search Console, Business Profile, whose hooks declare `routes`): the
// route's request schema in generated/vendor-routes.json, whose $refs resolve in the pinned Discovery document it was
// generated from.
let delegatedIndex: Map<string, JsonObject> | undefined;
function delegatedRoute(plan: CompiledRequest): JsonObject | undefined {
  if (!delegatedIndex) {
    delegatedIndex = new Map();
    for (const r of pinnedJson<JsonObject>('generated/vendor-routes.json').routes as JsonObject[])
      if (providerHooks(r.gateway)?.wireContract?.routes && r.requestSchema)
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
/** The request schema of the pinned Discovery method with the plan's verb and path (Display & Video 360's). */
function discoveryMethodContract(
  plan: CompiledRequest,
  {document, label, uploads}: NonNullable<WireContractFacts['discovery']>,
): Resolved | undefined {
  // Media and asset uploads are multipart transports with their own contracts (src/transport.ts).
  if (plan.path.startsWith(uploads)) return undefined;
  const matches = discoveryMethods(document).filter(m => m.verb === plan.method && m.pattern.test(plan.path));
  if (matches.length !== 1) return undefined;
  const m = matches[0]!.method;
  return discoveryContract(document, m.id, m.request, label);
}

// Data Manager v1 (src/google-data-manager-routes.ts): its methods in the pinned Discovery document, which Google Ads'
// hooks declare with the routes' origin (one provider, checked at load).
const dataManagerProviders = registeredProviderHooks.filter(hooks => hooks.wireContract?.dataManager);
if (dataManagerProviders.length !== 1) throw new Error('One provider declares the Data Manager contract.');
export const dataManagerContractName = dataManagerProviders[0]!.wireContract!.dataManager!.document;
/** The Data Manager contract of `plan`, from `envelope` (tests) or the pinned document. */
export function dataManagerContract(plan: CompiledRequest, envelope?: JsonObject): Resolved | undefined {
  const dataManager = providerHooks(plan.gateway)?.wireContract?.dataManager,
    vendorMethod = dataManager?.methods[plan.action];
  if (!dataManager || plan.origin !== dataManager.origin || !vendorMethod) return undefined;
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
          ? discoveryIssues(schemas, method.request, body, {readOnly, label: dataManager.label})
          : []
        : [{field: '', reason: 'The pinned Data Manager document has no method ' + vendorMethod}],
  };
}

// A load-time check: a provider's contract is one of the kinds below.
for (const hooks of registeredProviderHooks) {
  const facts = hooks.wireContract;
  if (facts && [facts.routes, facts.discovery, facts.model, facts.dataManager].filter(Boolean).length !== 1)
    throw new Error('The wire contract of ' + hooks.gateway + ' must be one kind.');
}
/** The contract of `plan`'s route, or undefined when no pinned request schema covers it. */
function resolveContract(plan: CompiledRequest): Resolved | undefined {
  const facts = providerHooks(plan.gateway)?.wireContract;
  if (facts?.routes) {
    const r = delegatedRoute(plan);
    return r ? discoveryContract(r.sourceFile, r.vendorMethod, r.requestSchema, facts.routes.label) : undefined;
  }
  if (facts?.discovery) return discoveryMethodContract(plan, facts.discovery);
  if (facts?.model) return facts.model(plan);
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
