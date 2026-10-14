import ledger from './acceptance-ledger.json' with {type: 'json'};
import {effectiveProviderContract, providerContracts} from './provider-contracts.js';
import type {JsonObject} from './types.js';

/**
 * The provider acceptance ledger (ACC-05). Each row records one owner-authorized live acceptance of one action: the
 * provider contract it ran under (contract_digest and api_version), the kind of account (test, sandbox or real), where it
 * ran (native harness or the deployed site), the release, and references to its receipts and read-back. It stores no
 * tokens, payload bodies or account identifiers: an account is named by an owner-chosen label, and the mapping stays in
 * the owner's private evidence store.
 *
 * The ledger never grants access and never replaces review: it only answers "was this exact contract accepted live, for
 * which kind of account, when". A row applies only while the provider contract keeps the same digest and version; any
 * change makes it stale. An action without a matching row stays `unverified` ("unknown stays unknown").
 */
export type AcceptanceStatus = 'unverified' | 'read_accepted' | 'write_accepted' | 'refused' | 'stale';
export type LiveQualification = 'unverified' | 'read_accepted' | 'write_accepted';
export interface AcceptanceRow extends JsonObject {
  id: string;
  ticket: string;
  gateway: string;
  operation?: string;
  action: string;
  family?: string;
  effect: 'read' | 'mutation';
  contract_digest: string;
  api_version: string;
  account_type: 'test' | 'sandbox' | 'real';
  environment: 'native' | 'deployed';
  scope: {account_label: string; accounts: number};
  checked_at: string;
  release: {revision: string; package_sha256: string};
  authorization_ref: string;
  evidence: JsonObject;
  outcome: 'accepted' | 'refused' | 'inconclusive';
  note?: string;
}
const keys = new Set([
    'id',
    'ticket',
    'gateway',
    'operation',
    'action',
    'family',
    'effect',
    'contract_digest',
    'api_version',
    'account_type',
    'environment',
    'scope',
    'checked_at',
    'release',
    'authorization_ref',
    'evidence',
    'outcome',
    'note',
  ]),
  evidenceKeys = new Set([
    'review_id',
    'receipt_refs',
    'readback_sha256',
    'provider_request_ids',
    'provider_codes',
    'status_codes',
    'shape_sha256',
  ]);
const reference = /^[A-Za-z0-9][A-Za-z0-9._:+=/-]{0,127}$/,
  hex64 = /^[0-9a-f]{64}$/,
  plain = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
const references = (v: unknown) =>
  Array.isArray(v) && v.length <= 20 && v.every(x => typeof x === 'string' && reference.test(x));

/** Every problem with ledger data; an empty list means every row is valid. */
export function validateAcceptanceLedger(data: unknown): string[] {
  const problems: string[] = [];
  if (!plain(data) || (data as JsonObject).schema_version !== 1 || !Array.isArray((data as JsonObject).rows))
    return ['the ledger is {schema_version: 1, rows: [...]}'];
  const gateways = new Set(providerContracts.map(c => String(c.gateway))),
    seen = new Set<string>();
  for (const [index, row] of ((data as JsonObject).rows as unknown[]).entries()) {
    const at = (message: string) => problems.push('row ' + index + ': ' + message);
    if (!plain(row)) {
      at('a row is an object');
      continue;
    }
    const r = row as JsonObject;
    for (const key of Object.keys(r))
      if (!keys.has(key)) at('unknown field ' + key + ' (the ledger keeps references only)');
    if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,79}$/.test(r.id)) at('id is 3-80 lowercase characters');
    else if (seen.has(r.id)) at('id ' + r.id + ' is recorded twice');
    else seen.add(r.id);
    if (typeof r.ticket !== 'string' || !/^ACC-0[1-8]$/.test(r.ticket))
      at('ticket names the acceptance (ACC-01 to ACC-08)');
    if (!gateways.has(r.gateway)) at('gateway is a provider gateway with a provider contract');
    if (r.operation !== undefined && (typeof r.operation !== 'string' || !/^[A-Za-z0-9_./-]{1,120}$/.test(r.operation)))
      at('operation is a delegated operation name');
    if (typeof r.action !== 'string' || !/^[A-Za-z0-9_./:{}-]{1,200}$/.test(r.action)) at('action is an action name');
    if (r.family !== undefined && (typeof r.family !== 'string' || !/^[a-z0-9_]{1,80}$/.test(r.family)))
      at('family is a reviewed family name');
    if (!['read', 'mutation'].includes(r.effect)) at('effect is read or mutation');
    if (typeof r.contract_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(r.contract_digest))
      at('contract_digest is the provider contract digest the run used');
    if (typeof r.api_version !== 'string' || !/^[A-Za-z0-9._/ ()-]{1,40}$/.test(r.api_version))
      at('api_version is the provider version the run sent');
    if (!['test', 'sandbox', 'real'].includes(r.account_type)) at('account_type is test, sandbox or real');
    if (!['native', 'deployed'].includes(r.environment)) at('environment is native or deployed');
    // The scope is mandatory so one account is never read as acceptance for every account (ACC-05 failure case).
    if (
      !plain(r.scope) ||
      Object.keys(r.scope).some(k => !['account_label', 'accounts'].includes(k)) ||
      typeof r.scope.account_label !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,39}$/.test(r.scope.account_label) ||
      // A label, never an account ID: it names a letter and no run of six digits.
      !/[a-z]/.test(r.scope.account_label) ||
      /\d{6}/.test(r.scope.account_label) ||
      !Number.isSafeInteger(r.scope.accounts) ||
      r.scope.accounts < 1 ||
      r.scope.accounts > 20
    )
      at('scope is {account_label, accounts}: an owner label (never an account ID) and a count of 1-20');
    if (
      typeof r.checked_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(r.checked_at) ||
      !Number.isFinite(Date.parse(r.checked_at))
    )
      at('checked_at is a UTC timestamp');
    if (
      !plain(r.release) ||
      Object.keys(r.release).some(k => !['revision', 'package_sha256'].includes(k)) ||
      typeof r.release.revision !== 'string' ||
      !/^[0-9a-f]{7,40}$/.test(r.release.revision) ||
      typeof r.release.package_sha256 !== 'string' ||
      !hex64.test(r.release.package_sha256)
    )
      at('release is the /versionz revision and package_sha256 of the run');
    if (typeof r.authorization_ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/.test(r.authorization_ref))
      at("authorization_ref names the owner's written authorization");
    const e = r.evidence;
    if (!plain(e)) at('evidence is an object of references');
    else {
      for (const key of Object.keys(e)) if (!evidenceKeys.has(key)) at('unknown evidence field ' + key);
      if (e.review_id !== undefined && (typeof e.review_id !== 'string' || !reference.test(e.review_id)))
        at('evidence.review_id is a reference');
      for (const key of ['receipt_refs', 'provider_request_ids'])
        if (e[key] !== undefined && !references(e[key])) at('evidence.' + key + ' is a list of at most 20 references');
      for (const key of ['readback_sha256', 'shape_sha256'])
        if (e[key] !== undefined && (typeof e[key] !== 'string' || !hex64.test(e[key])))
          at('evidence.' + key + ' is a SHA-256 hex digest');
      // The provider's own code as a closed-set token (a TikTok envelope code, an X or LinkedIn error code), never its
      // message (ACC-06, ACC-08).
      if (
        e.provider_codes !== undefined &&
        (!Array.isArray(e.provider_codes) ||
          e.provider_codes.length > 20 ||
          !e.provider_codes.every((c: unknown) => typeof c === 'string' && /^[A-Z0-9_]{1,64}$/.test(c)))
      )
        at('evidence.provider_codes is a list of provider code tokens');
      if (
        e.status_codes !== undefined &&
        (!Array.isArray(e.status_codes) ||
          e.status_codes.length > 20 ||
          !e.status_codes.every((s: unknown) => Number.isInteger(s) && (s as number) >= 100 && (s as number) <= 599))
      )
        at('evidence.status_codes is a list of HTTP status codes');
      // An accepted write keeps its receipts and its read-back; an accepted read keeps the shape or status it observed.
      if (r.outcome === 'accepted' && r.effect === 'mutation' && (!e.receipt_refs?.length || !e.readback_sha256))
        at('an accepted mutation cites its receipts and its read-back digest');
      if (r.outcome === 'accepted' && r.effect === 'read' && !e.shape_sha256 && !e.status_codes?.length)
        at('an accepted read cites its response-shape digest or status codes');
    }
    if (!['accepted', 'refused', 'inconclusive'].includes(r.outcome))
      at('outcome is accepted, refused or inconclusive');
    if (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 300 || /[\r\n<>]/.test(r.note)))
      at('note is one line of at most 300 characters');
  }
  return problems;
}
/** The committed rows, or none when the ledger is invalid: an invalid ledger claims no acceptance. */
export const ledgerProblems = validateAcceptanceLedger(ledger);
export const acceptanceRows: AcceptanceRow[] = ledgerProblems.length ? [] : (ledger.rows as unknown as AcceptanceRow[]);

/** The provider contract an action runs under now: its digest and the version AMCP sends. */
function currentContract(gateway: string): {contract_digest: string; api_version: string} | undefined {
  const provider = providerContracts.find(c => c.gateway === gateway),
    effective = provider && effectiveProviderContract(String(provider.id));
  return effective
    ? {contract_digest: String(effective.contract_digest), api_version: String(effective.api_version)}
    : undefined;
}
export interface ContractAcceptance extends JsonObject {
  status: AcceptanceStatus;
}
/**
 * The acceptance of one action row: write_accepted or read_accepted when a row for this exact contract digest and
 * version accepted it (the newest such row's scope and time), refused when the newest matching row was refused, stale
 * when rows exist only for another digest or version, and unverified otherwise. Never a grant.
 */
export function contractAcceptance(
  action: {gateway: string; operation?: string; action: string},
  rows: AcceptanceRow[] = acceptanceRows,
  current = currentContract(action.gateway),
): ContractAcceptance {
  const candidates = rows.filter(
    r => r.gateway === action.gateway && (r.operation ?? '') === (action.operation ?? '') && r.action === action.action,
  );
  if (!candidates.length) return {status: 'unverified'};
  const matching = candidates
      .filter(r => current && r.contract_digest === current.contract_digest && r.api_version === current.api_version)
      .sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at)),
    accepted = matching.filter(r => r.outcome === 'accepted'),
    view = (r: AcceptanceRow, status: AcceptanceStatus): ContractAcceptance => ({
      status,
      scope: {...r.scope, account_type: r.account_type, environment: r.environment},
      checked_at: r.checked_at,
      ticket: r.ticket,
      ledger_row: r.id,
    });
  if (accepted.length) {
    const write = accepted.find(r => r.effect === 'mutation');
    return write ? view(write, 'write_accepted') : view(accepted[0]!, 'read_accepted');
  }
  if (matching[0]?.outcome === 'refused') return view(matching[0], 'refused');
  if (matching.length) return {status: 'unverified', inconclusive_rows: matching.length};
  const newest = [...candidates].sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at))[0]!;
  return {
    status: 'stale',
    checked_at: newest.checked_at,
    ledger_row: newest.id,
    // What changed since the run: the content of the provider contract, or the version AMCP sends.
    invalidated_by: !current
      ? 'provider_contract'
      : newest.api_version !== current.api_version
        ? 'api_version'
        : 'contract_digest',
  };
}
/** The live qualification an action row may state: only an accepted ledger row for its current contract lifts it. */
export function liveQualification(acceptance: ContractAcceptance): LiveQualification {
  return acceptance.status === 'read_accepted' || acceptance.status === 'write_accepted'
    ? acceptance.status
    : 'unverified';
}
/** Statuses an action row maps to without a request mapping (catalog only) or with one (pinned). */
const unmapped = new Set(['unmapped', 'provider_unsupported']),
  qualified = new Set(['native_read', 'reviewed_write_family', 'media_workflow', 'local_workflow']);
/**
 * Counts per evidence layer (ACC-05): catalog (every listed action), pinned (an exact request mapping exists), locally
 * qualified (a read contract, reviewed family or AMCP workflow with tests), then read-accepted, write-accepted, refused
 * and stale from the ledger. Each layer is counted on its own; none implies another.
 */
export function acceptanceLayers(
  rows: {status: string; tests: string[]; acceptance?: ContractAcceptance}[],
): Record<string, number> {
  const count = (test: (r: (typeof rows)[number]) => boolean) => rows.filter(test).length,
    status = (r: (typeof rows)[number]) => r.acceptance?.status ?? 'unverified';
  return {
    catalog: rows.length,
    pinned: count(r => !unmapped.has(r.status)),
    locally_qualified: count(r => qualified.has(r.status) && r.tests.length > 0),
    read_accepted: count(r => status(r) === 'read_accepted'),
    write_accepted: count(r => status(r) === 'write_accepted'),
    refused: count(r => status(r) === 'refused'),
    stale: count(r => status(r) === 'stale'),
  };
}
export const acceptanceMeaning =
  'acceptance comes from the provider acceptance ledger (ACC-05): read_accepted or write_accepted only when an owner-authorized live run accepted this exact provider contract digest and version, for the account kind in scope. stale means the contract changed since. It never grants access; reviews and every other control still apply.';
