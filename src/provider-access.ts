import register from './provider-access.json' with {type: 'json'};
import {providerContracts} from './provider-contracts.js';
import {conditionalPrograms} from './conditional-programs.js';
import {discoveryOnlyPrograms} from './discovery-programs.js';
import {acceptanceRows, contractAcceptance, type AcceptanceRow} from './acceptance-ledger.js';
import {gatewayOffered} from './provider-offering.js';
import type {Store} from './store.js';
import type {Actor, JsonObject} from './types.js';

/**
 * The provider access register (ACC-05 phase 1): what each provider has granted this deployment, as the owner declares
 * it, with the date of each declaration. It is maintained in src/provider-access.json and published as
 * docs/PROVIDER-ACCESS.md (`node tools/acceptance/provider-access.mjs`). Beside the declarations it shows the programs
 * that gate each provider (checked live, or listed for discovery only) and what the acceptance ledger recorded.
 *
 * A declaration is the owner's statement, never a grant: AMCP still sends every request and the provider decides. It
 * holds no secrets, tokens, account IDs or e-mail addresses; a declaration goes stale after `stale_after_days`.
 */
export type ApprovalStatus = 'undeclared' | 'approved' | 'applied' | 'denied' | 'not_needed';
export interface ProviderApproval {
  id: string;
  label: string;
  status: ApprovalStatus;
  value: string | null;
  declared_at: string | null;
}
export interface ProviderAccessRegister {
  schema_version: 1;
  stale_after_days: number;
  providers: Record<string, {approvals: ProviderApproval[]}>;
}
const statuses = new Set<ApprovalStatus>(['undeclared', 'approved', 'applied', 'denied', 'not_needed']);
const plain = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const day = /^\d{4}-\d{2}-\d{2}$/;
/** A value the owner may write: one short line, never a token, an account ID or an e-mail address. */
export function unsafeDeclaredValue(value: string): string | undefined {
  if (!value.trim() || value.length > 80 || /[\r\n<>]/.test(value)) return 'one line of at most 80 characters';
  if (/[A-Za-z0-9_-]{24,}/.test(value)) return 'no token or key';
  if (/\d{6,}/.test(value)) return 'no account or customer ID';
  if (/@/.test(value)) return 'no e-mail address';
  return undefined;
}

/** Every problem with register data; an empty list means it is valid. `today` bounds the declaration dates. */
export function validateProviderAccess(data: unknown, today = new Date().toISOString().slice(0, 10)): string[] {
  const problems: string[] = [];
  if (!plain(data) || data.schema_version !== 1 || !plain(data.providers))
    return ['the register is {schema_version: 1, stale_after_days, providers: {...}}'];
  for (const key of Object.keys(data))
    if (!['schema_version', 'stale_after_days', 'providers'].includes(key)) problems.push('unknown field ' + key);
  if (!Number.isSafeInteger(data.stale_after_days) || data.stale_after_days < 1 || data.stale_after_days > 365)
    problems.push('stale_after_days is a whole number of days from 1 to 365');
  const ids = providerContracts.map(c => String(c.id)),
    listed = Object.keys(data.providers);
  for (const id of ids) if (!listed.includes(id)) problems.push(id + ': every provider contract has a register entry');
  for (const id of listed) if (!ids.includes(id)) problems.push(id + ': no provider contract has this ID');
  for (const [id, entry] of Object.entries(data.providers as JsonObject)) {
    const at = (message: string) => problems.push(id + ': ' + message);
    if (!plain(entry) || Object.keys(entry).some(k => k !== 'approvals') || !Array.isArray(entry.approvals)) {
      at('an entry is {approvals: [...]}');
      continue;
    }
    if (!entry.approvals.length || entry.approvals.length > 10) at('an entry lists 1 to 10 approvals');
    const seen = new Set<string>();
    for (const approval of entry.approvals as unknown[]) {
      if (!plain(approval)) {
        at('an approval is an object');
        continue;
      }
      const a = approval;
      for (const key of Object.keys(a))
        if (!['id', 'label', 'status', 'value', 'declared_at'].includes(key)) at('unknown approval field ' + key);
      if (typeof a.id !== 'string' || !/^[a-z0-9_]{2,60}$/.test(a.id))
        at('an approval id is 2-60 lowercase characters');
      else if (seen.has(a.id)) at(a.id + ' is listed twice');
      else seen.add(a.id);
      if (typeof a.label !== 'string' || a.label.length < 10 || a.label.length > 200 || /[\r\n<>]/.test(a.label))
        at(a.id + ': label is one line of 10-200 characters');
      if (!statuses.has(a.status)) at(a.id + ': status is undeclared, approved, applied, denied or not_needed');
      if (a.status === 'undeclared') {
        // An undeclared approval says nothing: no value and no date.
        if (a.value !== null || a.declared_at !== null) at(a.id + ': an undeclared approval has no value or date');
        continue;
      }
      // Stale entries mislead (ACC-05 failure case): every declaration carries the day the owner made it.
      if (
        typeof a.declared_at !== 'string' ||
        !day.test(a.declared_at) ||
        !Number.isFinite(Date.parse(a.declared_at + 'T00:00:00Z')) ||
        a.declared_at > today
      )
        at(a.id + ': declared_at is the day of the declaration (YYYY-MM-DD), not in the future');
      if (a.value !== null) {
        const unsafe = typeof a.value === 'string' ? unsafeDeclaredValue(a.value) : 'a string or null';
        if (unsafe) at(a.id + ': value is ' + unsafe);
      }
    }
  }
  return problems;
}
export const registerProblems = validateProviderAccess(register);
/** The committed register, or none when it is invalid: an invalid register declares nothing. */
export const providerAccessRegister: ProviderAccessRegister | null = registerProblems.length
  ? null
  : (register as unknown as ProviderAccessRegister);

/** The day a declaration should be confirmed again. */
export function reviewBy(declared: string | null, days: number): string | null {
  return declared ? new Date(Date.parse(declared + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10) : null;
}
/** What the acceptance ledger holds for one gateway, by the current status of each accepted action (ACC-05). */
export function ledgerSummary(gateway: string, rows: AcceptanceRow[] = acceptanceRows): JsonObject {
  const own = rows.filter(r => r.gateway === gateway),
    actions = new Map<string, AcceptanceRow>();
  for (const r of own) actions.set([r.operation ?? '', r.action].join('/'), r);
  const counts: Record<string, number> = {read_accepted: 0, write_accepted: 0, refused: 0, stale: 0, unverified: 0};
  for (const r of actions.values()) {
    const status = contractAcceptance(r, rows).status;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const newest = (list: AcceptanceRow[]) =>
      [...list].sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at))[0],
    refusal = newest(own.filter(r => r.outcome === 'refused')),
    accepted = newest(own.filter(r => r.outcome === 'accepted'));
  return {
    rows: own.length,
    actions: actions.size,
    ...counts,
    last_accepted_at: accepted?.checked_at ?? null,
    last_refusal: refusal
      ? {checked_at: refusal.checked_at, ticket: refusal.ticket, status_codes: refusal.evidence.status_codes ?? []}
      : null,
  };
}
/** The programs that gate one gateway: the live_read checks and the discovery-only listings. */
export function providerPrograms(gateway: string): JsonObject[] {
  return [
    ...conditionalPrograms
      .filter(p => p.gateway === gateway)
      .map(p => ({
        id: p.id,
        name: p.name,
        mode: p.mode,
        prerequisites: p.account_setup.prerequisites.map(x => x.text),
        access: p.program.access,
        reference: p.program.reference,
        checked_on: p.program.checked_on,
      })),
    ...discoveryOnlyPrograms
      .filter(p => p.gateway === gateway)
      .map(p => ({
        id: p.id,
        name: p.name,
        mode: p.mode,
        prerequisites: p.prerequisites.map(x => x.text),
        access: p.program.access,
        reference: p.program.reference,
        checked_on: p.program.checked_on,
      })),
  ];
}
/**
 * The register as published (docs/PROVIDER-ACCESS.md): deterministic, so it states each declaration's review date
 * rather than whether it is stale today. Staleness is computed where it is shown live (the owner's health view). For
 * the same reason `offered` is the provider's default, under no AMCP_PROVIDERS: the document and its check never read
 * the environment that runs them (an operator who offers a parked provider would otherwise get another file).
 */
export function providerAccessDocument(data: ProviderAccessRegister | null = providerAccessRegister): JsonObject[] {
  if (!data) return [];
  return providerContracts.map(c => {
    const id = String(c.id),
      gateway = String(c.gateway);
    return {
      id,
      gateway,
      api_version: c.api_version,
      offered: gatewayOffered(gateway, {}),
      approvals: data.providers[id]!.approvals.map(a => ({
        ...a,
        review_by: reviewBy(a.declared_at, data.stale_after_days),
      })),
      programs: providerPrograms(gateway),
      acceptance: ledgerSummary(gateway),
    };
  });
}

const syncCode = (error: unknown) =>
  typeof error === 'string' && error
    ? (/\(([A-Z][A-Z0-9_]{2,63})\)/.exec(error)?.[1] ?? 'ASSET_SYNC_INCOMPLETE')
    : null;
/**
 * The owner's provider access panel (ACC-05 phase 5), for owner health: per provider this workspace has connected, the
 * owner's declarations with their staleness today, the logins' last successful sync and last sync refusal code, the
 * latest unexpired program observation of each live program, the discovery-only programs, and the acceptance ledger's
 * counts. It is computed from stored state only: no provider request, and no token, account ID or label.
 */
export function providerAccessPanel(
  store: Store,
  actor: Actor,
  now = Date.now(),
  data: ProviderAccessRegister | null = providerAccessRegister,
): JsonObject {
  const connections = store.listConnections(actor.tenantId),
    synced = new Map(store.documents(actor.tenantId, 'website_assets').map(d => [d.id, d])),
    staleAfter = data?.stale_after_days ?? null,
    observations = store
      .documents(actor.tenantId, 'conditional_program_observation')
      .filter(o => Number.isSafeInteger(o.expires_at) && o.expires_at > now && o.grant === false);
  const providers = providerContracts
    .filter(c => connections.some(x => x.gateway === c.gateway))
    .map(c => {
      const id = String(c.id),
        gateway = String(c.gateway),
        own = connections.filter(x => x.gateway === gateway),
        assets = own.map(x => synced.get(x.id)),
        syncs = assets.flatMap(a => (Number.isSafeInteger(a?.lastSync) ? [a!.lastSync as number] : [])),
        refusals = assets
          .filter(a => syncCode(a?.error))
          .map(a => ({code: syncCode(a!.error), at: a!.lastAttemptAt ?? a!.lastSync ?? null}))
          .sort((x, y) => (y.at ?? 0) - (x.at ?? 0)),
        approvals = (data?.providers[id]?.approvals ?? []).map(a => {
          const due = reviewBy(a.declared_at, staleAfter ?? 0);
          return {
            id: a.id,
            label: a.label,
            status: a.status,
            value: a.value,
            declared_at: a.declared_at,
            stale: a.status !== 'undeclared' && !!due && Date.parse(due + 'T00:00:00Z') <= now,
          };
        });
      return {
        id,
        gateway,
        approvals: {
          declared: approvals.filter(a => a.status !== 'undeclared').length,
          total: approvals.length,
          stale: approvals.filter(a => a.stale).length,
          items: approvals,
        },
        connections: {count: own.length, enabled: own.filter(x => x.enabled).length},
        last_successful_sync_at: syncs.length ? Math.max(...syncs) : null,
        last_sync_refusal: refusals[0] ?? null,
        programs: providerPrograms(gateway).map(p => {
          const latest = observations
            .filter(o => o.workflow_id === p.id && own.some(x => x.id === o.connection_id))
            .sort((x, y) => y.checked_at - x.checked_at)[0];
          return {
            id: p.id,
            name: p.name,
            mode: p.mode,
            ...(p.mode === 'live_read'
              ? {
                  last_observation: latest
                    ? {
                        state: latest.state,
                        code: latest.code ?? null,
                        provider_code: latest.provider_code ?? null,
                        checked_at: latest.checked_at,
                      }
                    : null,
                }
              : {provider_requests: 0}),
          };
        }),
        acceptance: ledgerSummary(gateway),
      };
    });
  return {
    record_kind: 'provider_access_panel',
    network_requests: 0,
    register: data ? 'valid' : 'invalid',
    stale_after_days: staleAfter,
    providers,
    other_providers: providerContracts.length - providers.length,
    meaning:
      'Declarations are the owner’s statements in the provider access register, each with its date; they grant nothing. Sync and program results come from this workspace’s stored reads; acceptance counts come from the provider acceptance ledger.',
  };
}
