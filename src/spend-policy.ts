import {
  policyDecimal,
  decimalZero,
  decimalText,
  compareDecimal,
  addDecimal,
  positiveDecimalIncrease,
  multiplyDecimal,
  type PolicyDecimal,
} from './policy-decimal.js';
// The policy's provider parts are its adapters' writes hooks (ARC-01 phase B, wave 4c): Business Profile's and Google
// Ads' access switches, Apple's shared budget, LinkedIn's creative activation field, Google Ads' money fields and Meta's
// currency-cap refusal.
import {providerHooks} from './provider-hooks.js';
import {Store} from './store.js';
import {applyExecutionRisk, bodyDeletion} from './execution-risk.js';
import {MirrorError} from './errors.js';
import {sha256} from './security.js';
import {normalizeAccount} from './scope.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {familyOf} from './reviewed-families.js';
import {lifetimeAmount, nativeAmount, pathNames, policyNativeUnit} from './budget-units.js';
import {stateCurrency} from './review-summary.js';
export const spendPolicyKey = (gateway: string, account: string) =>
  sha256(gateway + ':' + normalizeAccount(gateway, account));
/**
 * Reviewer test sessions are minted `role:'admin'` inside a disposable tenant and carry no
 * ownerUserId, so the membership clause below — which is conditional on ownerUserId — used to
 * short-circuit and let them through. They are rejected explicitly rather than by role, so the
 * guard survives any future change to the role the test door issues.
 */
/** What each owner-only action does, for a refusal that names it (Snapchat S7). */
const ownerActs: Record<string, string> = {
  health: 'read the whole workspace health (policies, e-mail, storage and backups)',
  support_bundle: 'export the support bundle',
  save_spend_policy: 'change spending policies',
  save_retention: 'change how long reports are kept',
  save_plan_policy: 'change who may approve campaign plans',
  save_export_policy: 'change who may download report files',
  retain_media: 'retain a selected encrypted original until an owner removes it',
  remove_retained_media: 'permanently remove a retained original',
  pause_writes: 'pause every write',
  resume_writes: 'resume writes',
  enable_personal_data: 'turn personal-data writes on for an ad account',
  disable_personal_data: 'turn personal-data writes off for an ad account',
  save_ga4_test_property: 'mark or unmark a GA4 test property',
};
/** Whether this actor is the workspace owner: an administrator who owns the workspace, or the local administrator. */
export function workspaceOwner(store: Store, actor: Actor): boolean {
  if (actor.testAccount === true || actor.role !== 'admin') return false;
  if (!actor.ownerUserId) return true;
  return !!store.db
    .prepare("SELECT 1 FROM workspace_memberships WHERE tenant_id=? AND user_id=? AND role='owner' AND active=1")
    .get(actor.tenantId, actor.ownerUserId);
}
/**
 * While a workspace's own two-step policy covers a website member (SEC-06), owner authority over spending,
 * personal data, retention, downloads and retained originals needs a session opened with two-step verification.
 * Reads and emergency stops (health, pausing writes, turning personal data off) never wait for it. MCP keys and local
 * tools carry no website session flags and are unaffected.
 */
const twoStepFree = new Set(['health', 'support_bundle', 'pause_writes', 'disable_personal_data']);
export function assertTwoStepSession(actor: Actor, action?: string) {
  if (actor.mfaPolicy === true && actor.mfaVerified !== true && !twoStepFree.has(action ?? ''))
    throw new MirrorError(
      'MFA_STEP_REQUIRED',
      'This workspace requires two-step verification for this change. Sign in again with your authenticator, then retry.',
      {action: action ?? null},
      403,
    );
}
export function ownerAccess(store: Store, actor: Actor, action?: string) {
  store.assertActorActive(actor);
  assertTwoStepSession(actor, action);
  const act = (action && ownerActs[action]) || 'change safety, spending or retention policies';
  if (actor.testAccount === true)
    throw new MirrorError(
      'OWNER_REQUIRED',
      'Reviewer test accounts cannot ' + act + '.',
      {action: action ?? null},
      403,
    );
  // LEAD-03 (Round 2.5, owner 2026-11-15): health is read by the owner (the whole view) or an administrator (connection
  // status and job queues): ownerOperations answers an administrator before it gets here, so what is refused here is a
  // member below administrator, and every AI client connection that does not carry owner access: operator or reader (owner
  // decision D16, server/mcp-oauth.ts) unless an owner of the deployment's workspace gave it owner access (owner decision of
  // 2026-11-21, which reads the whole view). Its refusal says so, where the owner reads the view, and what a session can read instead;
  // it once told such a session to "ask one of them or the owner", and said "only the owner" beside a required_role of
  // "owner or administrator".
  if (!workspaceOwner(store, actor) && action === 'health')
    throw new MirrorError(
      'OWNER_REQUIRED',
      'Only the workspace owner can read the whole workspace health (policies, e-mail, storage and backups), and an administrator its connection status and job queues. An AI client connection without owner access can read neither; the owner reads the whole view on the website at /settings, under Review friction and the workspace health.',
      {
        action,
        required_role: 'owner or administrator',
        website_path: '/settings',
        next_call: {tool: 'amcp_workspace', arguments: {action: 'capabilities'}},
      },
      403,
    );
  if (!workspaceOwner(store, actor))
    throw new MirrorError(
      'OWNER_REQUIRED',
      'Only the workspace owner can ' + act + '.',
      {action: action ?? null, required_role: 'owner'},
      403,
    );
}
/**
 * The account-specific policy is the precise control, but it only protects accounts somebody
 * remembered to configure — so an unconfigured account had no financial ceiling at all. A
 * workspace default closes that gap: it applies to every (gateway, account) pair with no policy
 * of its own, which makes the safeguard the standing case rather than an opt-in one.
 */
export const workspaceDefaultPolicyId = 'workspace_default';
/** The approval modes a spending policy may set (WRT-09; enforced in src/write-approval.ts). */
export const approvalModes = ['assistant_ack', 'website_approval', 'distinct_approver'] as const;
/**
 * Native money limits. Each platform counts them in its own unit, so a workspace default states them per platform.
 * max_total_budget_native caps lifetime and custom-period total amounts (owner decision D7, budget-units.ts
 * lifetimeAmounts); without it they are held to max_budget_native.
 */
const nativeMoneyKeys = ['max_budget_native', 'max_daily_increase_native', 'max_bid_native', 'max_total_budget_native'];
/** The same limits stated in account currency; budget-units.ts converts them where the platform's unit is documented. */
const currencyMoneyKeys: Record<string, string> = {
  max_budget_currency: 'max_budget_native',
  max_daily_increase_currency: 'max_daily_increase_native',
  max_bid_currency: 'max_bid_native',
  max_total_budget_currency: 'max_total_budget_native',
};
/** The limits under which every budget amount of a request must be measurable (a numeric budget policy). */
const budgetLimitKeys = [
  'max_budget_native',
  'max_budget_increase_percent',
  'max_daily_increase_native',
  'max_total_budget_native',
];
const moneyUnits =
  'native API budget units for this account; daily cap is cumulative requested positive budget increases, not billed spend; the daily window is the UTC calendar day, so it resets at 00:00 UTC rather than in the account timezone; lifetime and total amounts are held to max_total_budget_native when set (otherwise max_budget_native) and may always decrease';
const invalidPolicy = (
  message = 'Use explicit activation/deletion permissions and non-negative numeric limits.',
  details: JsonObject = {},
) => new MirrorError('INVALID_POLICY', message, details);
const validLimit = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const currencyCode = (v: unknown): v is string | null => v === null || (typeof v === 'string' && /^[A-Z]{3}$/.test(v));
/**
 * Money limits of one platform: native ones as given, currency ones converted to native and kept for display. A
 * `currency` (WRT-07 Stage C) binds the limits to the currency they were stated in: an account spending in another one
 * is not compared with them unconverted. Caps stated in currency without one take `observedCurrency`, the account's
 * currency from its last live read; when that is unknown too they stay unbound, as caps saved before currencies were,
 * and owner health lists them (policyWarnings).
 */
function moneyLimits(input: JsonObject, gateway: string, observedCurrency?: string): JsonObject {
  const out: JsonObject = {};
  if (Object.hasOwn(input, 'currency') && !currencyCode(input.currency))
    throw invalidPolicy('currency is the ISO 4217 code the caps are stated in, such as USD or KWD, or null.');
  const stated = Object.keys(input).some(k => currencyMoneyKeys[k]),
    currency: string | null | undefined = Object.hasOwn(input, 'currency')
      ? (input.currency as string | null)
      : stated
        ? observedCurrency
        : undefined;
  for (const [key, value] of Object.entries(input)) {
    if (key === 'currency') continue;
    if (!validLimit(value)) throw invalidPolicy();
    if (nativeMoneyKeys.includes(key)) out[key] = value;
    else if (currencyMoneyKeys[key]) {
      const native = nativeAmount(gateway, value as number, currency);
      // A provider whose unit converts only some currencies refuses the others itself (its adapter's
      // `writes.currencyCapRefusal`: Meta's currency offsets); any other platform has no documented unit.
      if (native === undefined)
        throw (
          providerHooks(gateway)?.writes?.currencyCapRefusal?.(key, currencyMoneyKeys[key]!, currency) ??
          invalidPolicy(
            'This platform has no documented budget unit in AMCP, so state this cap (field) in native API units instead (native_field).',
            {gateway, field: key, native_field: currencyMoneyKeys[key]},
          )
        );
      out[currencyMoneyKeys[key]] = native;
      out[key] = value;
    } else throw invalidPolicy();
  }
  if (currency !== undefined) out.currency = currency;
  return out;
}
/**
 * Checks and normalises a policy. `enforcement` is `confirm` (the default: a request over a cap asks the user, owner
 * decision of 2026-09-28) or `block` (the cap refuses it). A workspace default can state money limits per platform
 * under `per_gateway`, because one number means micros on one platform and currency units on another (F-04); a native
 * amount at its top level still applies to every platform without its own entry, with a warning.
 */
function validatePolicy(
  p: JsonObject,
  scope: {workspace: true} | {workspace: false; gateway: string; observedCurrency?: string},
): JsonObject {
  const out: JsonObject = {};
  const money: JsonObject = {};
  for (const [key, value] of Object.entries(p)) {
    if (key === 'currency') {
      if (scope.workspace)
        throw invalidPolicy(
          'A workspace default states the currency of its caps per platform under per_gateway, because accounts spend in different currencies.',
        );
      money[key] = value;
    } else if (
      key === 'allow_activation' ||
      key === 'allow_deletion' ||
      // WRT-09 (owner decision P5): the opt-in destructive_confirmed tier.
      key === 'require_destructive_confirmation'
    ) {
      if (typeof value !== 'boolean') throw invalidPolicy();
      out[key] = value;
    } else if (key === 'cap_override_owner_only') {
      // Owner decision P5 (2026-10-11): only the workspace owner executes a change beyond a cap under `confirm`, always
      // (src/write-approval.ts). The former opt-in is no setting: `true` restates the rule and is not stored, and `false`
      // cannot turn it off.
      if (typeof value !== 'boolean') throw invalidPolicy();
      if (!value)
        throw invalidPolicy(
          'Only the workspace owner executes a change beyond a spending cap (owner decision P5), and no policy turns that off. Leave cap_override_owner_only out.',
          {field: 'cap_override_owner_only'},
        );
    } else if (key === 'approval_mode') {
      // WRT-09 (opt-in, owner decisions P1 and P5): who approves spend, cap and deletion executions (src/write-approval.ts).
      if (!approvalModes.includes(value))
        throw invalidPolicy(
          'approval_mode is assistant_ack (the user approves in the AI client, the default), website_approval (a member approves on the AMCP website) or distinct_approver (another member than the preparer, or the owner).',
        );
      out[key] = value;
    } else if (key === 'enforcement') {
      if (value !== 'confirm' && value !== 'block')
        throw invalidPolicy('enforcement is confirm (ask the user before exceeding a cap) or block (refuse).');
      out[key] = value;
    } else if (key === 'max_budget_increase_percent') {
      if (!validLimit(value)) throw invalidPolicy();
      out[key] = value;
    } else if (nativeMoneyKeys.includes(key) || currencyMoneyKeys[key]) money[key] = value;
    else if (key === 'per_gateway' && scope.workspace) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPolicy();
      const perGateway: JsonObject = {};
      for (const [gateway, limits] of Object.entries(value as JsonObject)) {
        if (!Object.hasOwn(activationFields, gateway) || !limits || typeof limits !== 'object' || Array.isArray(limits))
          throw invalidPolicy('per_gateway maps an advertising gateway to its money limits.');
        perGateway[gateway] = moneyLimits(limits as JsonObject, gateway);
      }
      out.per_gateway = perGateway;
    } else throw invalidPolicy();
  }
  if (Object.keys(money).length) {
    if (!scope.workspace) Object.assign(out, moneyLimits(money, scope.gateway, scope.observedCurrency));
    else if (Object.keys(money).some(k => currencyMoneyKeys[k]))
      throw invalidPolicy(
        'A workspace default states caps in account currency per platform under per_gateway, because each platform counts money in its own unit.',
      );
    // One native amount for every platform is kept for existing configurations; policyWarnings explains its units.
    else
      for (const [key, value] of Object.entries(money))
        if (validLimit(value)) out[key] = value;
        else throw invalidPolicy();
  }
  return out;
}
/** The limits that apply to one gateway: a workspace default's per-platform money limits over its shared settings. */
function effectivePolicy(policy: JsonObject, gateway: string): JsonObject {
  const {per_gateway: perGateway, ...shared} = policy;
  return {...shared, ...((perGateway as JsonObject | undefined)?.[gateway] ?? {})};
}
/**
 * Optimistic concurrency of a policy save (WRT-03, owner decision D9). `expected_revision` is the revision of the
 * stored policy the caller read, 0 when there was none; a stale one is refused with REVISION_CONFLICT (409) and
 * nothing is saved. The website always sends it. An MCP caller may leave it out, and is then told when its save
 * replaced a stored policy without that check.
 */
function expectedPolicyRevision(input: JsonObject): number | undefined {
  const v = input.expected_revision;
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw invalidPolicy('expected_revision is the revision of the stored policy you read, or 0 when there was none.');
  return v;
}
function putPolicy(store: Store, actor: Actor, id: string, data: JsonObject, expected: number | undefined) {
  const previous = (
    store.db
      .prepare("SELECT revision FROM documents WHERE tenant_id=? AND kind='spend_policy' AND id=?")
      .get(actor.tenantId, id) as {revision: number} | undefined
  )?.revision;
  const {revision} = store.putDocument(actor.tenantId, 'spend_policy', id, data, expected);
  store.appendAudit(actor.tenantId, 'policy/' + id, {
    event: 'spend_policy_saved',
    policy: data,
    revision,
    revision_checked: expected !== undefined,
  });
  const warnings: JsonObject[] =
    expected === undefined && previous !== undefined
      ? [
          {
            code: 'REVISION_NOT_CHECKED',
            policy_id: id,
            replaced_revision: previous,
            message:
              'Saved without expected_revision, so this replaced the stored policy whatever changed since it was read. Send the revision you read as expected_revision to refuse a stale save.',
          },
        ]
      : [];
  return {revision, warnings};
}
export function saveSpendPolicy(store: Store, actor: Actor, input: JsonObject) {
  ownerAccess(store, actor, 'save_spend_policy');
  const expected = expectedPolicyRevision(input);
  if (input.scope === 'workspace') {
    if (input.confirmed !== true || !input.policy || typeof input.policy !== 'object')
      throw new MirrorError('INVALID_POLICY', 'Confirm a workspace default spending policy.');
    if (input.gateway !== undefined || input.account_id !== undefined)
      throw new MirrorError(
        'INVALID_POLICY',
        'A workspace default applies to every account; omit gateway and account_id.',
      );
    const p = validatePolicy(input.policy as JsonObject, {workspace: true});
    const data = {
      ...p,
      scope: 'workspace',
      updated_at: Date.now(),
      updated_by: actor.userId,
      money_units: moneyUnits,
      applies_to: 'Every gateway and account in this workspace that has no policy of its own.',
    };
    const saved = putPolicy(store, actor, workspaceDefaultPolicyId, data, expected);
    const warnings = [
      ...policyWarnings(store, actor.tenantId).filter(w => w.policy_id === workspaceDefaultPolicyId),
      ...saved.warnings,
    ];
    return {
      id: workspaceDefaultPolicyId,
      revision: saved.revision,
      ...data,
      ...(warnings.length ? {warnings} : {}),
    };
  }
  if (
    input.confirmed !== true ||
    typeof input.gateway !== 'string' ||
    typeof input.account_id !== 'string' ||
    !input.policy ||
    typeof input.policy !== 'object'
  )
    throw new MirrorError('INVALID_POLICY', 'Confirm an account-specific spending policy.');
  const p = validatePolicy(input.policy as JsonObject, {
    workspace: false,
    gateway: input.gateway,
    observedCurrency: observedAccountCurrency(store, actor.tenantId, input.gateway, input.account_id),
  });
  store.resolveConnection(actor, input.gateway, input.account_id, input.connection_id);
  // Meta's unit depends on the currency of the caps, and names the pinned offset that converted them (WRT-07).
  const id = spendPolicyKey(input.gateway, input.account_id),
    nativeUnit = policyNativeUnit(input.gateway, p.currency),
    data = {
      ...p,
      gateway: input.gateway,
      account_id: normalizeAccount(input.gateway, input.account_id),
      updated_at: Date.now(),
      updated_by: actor.userId,
      money_units: moneyUnits,
      ...(nativeUnit ? {native_unit: nativeUnit} : {}),
    };
  const saved = putPolicy(store, actor, id, data, expected),
    // Caps in account currency saved without one (P5): the owner is told at once that they refuse money changes.
    warnings = [...currencyWarnings(id, data), ...saved.warnings];
  return {id, revision: saved.revision, ...data, ...(warnings.length ? {warnings} : {})};
}
/**
 * The account's currency as its last live read recorded it (amcp_workspace check live:true), through any of this
 * gateway's connections that read it; undefined when none did or they disagree.
 */
export function observedAccountCurrency(
  store: Store,
  tenant: string,
  gateway: string,
  account: string,
): string | undefined {
  const connections = new Set(
      store
        .listConnections(tenant)
        .filter(c => c.gateway === gateway)
        .map(c => c.id),
    ),
    wanted = new Set([account, normalizeAccount(gateway, account)]);
  const currencies = new Set(
    (
      store.db.prepare("SELECT data FROM documents WHERE tenant_id=? AND kind='account_metadata'").all(tenant) as {
        data: string;
      }[]
    )
      .map(r => JSON.parse(r.data) as JsonObject)
      .filter(
        m =>
          connections.has(m.connection_id) &&
          (wanted.has(m.account_id) ||
            normalizeAccount(gateway, String(m.account_id)) === normalizeAccount(gateway, account)),
      )
      .map(m => m.currency)
      .filter((c): c is string => typeof c === 'string' && /^[A-Z]{3}$/.test(c)),
  );
  return currencies.size === 1 ? [...currencies][0] : undefined;
}
/** The account currency for a reviewed request: the one its state read names, else the last live account read. */
function accountCurrency(store: Store, tenant: string, plan: CompiledRequest, before: unknown): string | undefined {
  return stateCurrency(before) ?? observedAccountCurrency(store, tenant, plan.gateway, String(plan.accountId ?? ''));
}
/** The caps of `limits` stated in account currency while no currency is recorded for them (WRT-07 Stage C). */
const unboundCurrencyCaps = (limits: JsonObject | undefined): string[] =>
  limits && limits.currency == null ? Object.keys(limits).filter(k => currencyMoneyKeys[k]) : [];
/**
 * Caps stated in account currency with no currency recorded (saved before policies recorded one, or while the
 * account's currency was unknown). AMCP cannot tell which currency they were meant in, so every account they govern
 * may spend in another currency: under owner decision P5 (2026-10-11) they refuse every change of a budget or bid until
 * the owner saves them again with their currency (POLICY_CURRENCY_UNSET in checkAccountSpendPolicy), and the owner is
 * told here. AMCP_LEGACY_CURRENCY_CAPS=warn is the rollback: they are compared as before, with the warning.
 */
export const legacyCurrencyCapsBlock = () => process.env.AMCP_LEGACY_CURRENCY_CAPS !== 'warn';
function currencyWarnings(id: string, policy: JsonObject): JsonObject[] {
  const gateways = Object.entries((policy.per_gateway ?? {}) as JsonObject)
    .filter(([, limits]) => unboundCurrencyCaps(limits as JsonObject).length)
    .map(([g]) => g);
  if (!unboundCurrencyCaps(policy).length && !gateways.length) return [];
  return [
    {
      code: 'POLICY_CURRENCY_UNSET',
      policy_id: id,
      ...(gateways.length ? {gateways} : {}),
      blocks: legacyCurrencyCapsBlock(),
      message: legacyCurrencyCapsBlock()
        ? 'These caps are stated in account currency without naming it, so AMCP cannot tell which currency they mean, and every budget or bid change on an account they govern, other than lowering a budget from its current amount, is refused until they name it. Save them again with their currency (for example currency: "USD"), or read the account live first so AMCP records it.'
        : 'These caps are stated in account currency without naming it, so an account spending in another currency is compared with the same number. Save them again with their currency (for example currency: "USD"), or read the account live first so AMCP records it.',
    },
  ];
}
/**
 * Stored policies that need the owner's attention: a workspace default saved before per-platform limits, whose single
 * native amount means different money on each platform (F-04). It still applies until it is saved again.
 */
export function policyWarnings(store: Store, tenant: string): JsonObject[] {
  const policies = store.documents(tenant, 'spend_policy'),
    row = policies.find(p => p.id === workspaceDefaultPolicyId);
  const legacy = nativeMoneyKeys.filter(k => row?.[k] !== undefined && row[k] !== 0);
  return [
    ...(legacy.length
      ? [
          {
            policy_id: workspaceDefaultPolicyId,
            fields: legacy,
            message:
              'The workspace default applies one native amount to every platform without its own per_gateway entry, although Google counts micros and LinkedIn currency units. State caps per platform under per_gateway.',
          },
        ]
      : []),
    // Caps stated in currency before policies recorded one (WRT-07 Stage C): they still apply, unbound to a currency.
    ...policies.flatMap(p => currencyWarnings(String(p.id), p)),
  ];
}
/**
 * Accounts with no policy of their own and no workspace default are financially unprotected.
 * Read the policy ids once and test membership in memory: a query per account turned an owner's
 * health check into hundreds of round trips for a workspace with many accounts, which is the
 * same per-row shape this module removed from the reservation lookup.
 */
export function unprotectedAccounts(store: Store, actor: Actor) {
  const ids = new Set(
    (
      store.db.prepare("SELECT id FROM documents WHERE tenant_id=? AND kind='spend_policy'").all(actor.tenantId) as {
        id: string;
      }[]
    ).map(r => r.id),
  );
  if (ids.has(workspaceDefaultPolicyId)) return [];
  const rows: JsonObject[] = [];
  for (const c of store.connectionsFor(actor))
    for (const account of c.accounts)
      if (!ids.has(spendPolicyKey(c.gateway, account)))
        rows.push({gateway: c.gateway, account_id: account, connection_id: c.id});
  return rows;
}
/**
 * `resource`: the identity of the record the amount belongs to, where the gateway names one (WRT-07 Stage B). `unlimited`: a budget the
 * provider states as unlimited, which has no amount and is above every cap (`amount` is then only a placeholder); `lifts`: it lifts a
 * limit that must have been set before, which is only a change when the reviewed state holds one (r25-mf-caps).
 */
type Amount = {
  path: string;
  key: string;
  amount: number;
  decimal?: string;
  lifetime?: boolean;
  resource?: string;
  unlimited?: boolean;
  lifts?: boolean;
};
/**
 * The fields that name the record a budget belongs to, per gateway, in the request and in the reviewed state alike:
 * Google resourceName, a Snapchat or Microsoft row id, a TikTok ad group (or else campaign) id. The innermost record
 * that carries one owns the amounts below it. A gateway not listed pairs amounts by field name only, as before.
 */
const resourceIdentity: Record<string, readonly string[]> = {
  google_ads_native_action: ['resource_name'],
  snapchat_native_action: ['id'],
  microsoft_ads_native_action: ['id'],
  tiktok_native_action: ['adgroup_id', 'campaign_id'],
};
/**
 * AMCP_SPEND_POLICY_RESOURCE_BASELINES=false restores pairing a budget with every prior value of the same field (WRT-07
 * rollback): with several distinct priors the baseline was lost and the whole amount counted as an increase.
 */
export const resourceBaselines = () => process.env.AMCP_SPEND_POLICY_RESOURCE_BASELINES !== 'false';
function resourceOf(record: JsonObject, identity: readonly string[]): string | undefined {
  for (const name of identity)
    for (const [k, v] of Object.entries(record))
      if (
        policyField(k) === name &&
        ((typeof v === 'string' && v.length > 0 && v.length <= 300) ||
          (typeof v === 'number' && Number.isSafeInteger(v)))
      )
        return String(v);
  return undefined;
}
/** A money field the policy cannot measure, kept beside the measured amounts as one finding (WRT-01 stage A). */
type Unsupported = {field: string; message: string};
const clearedMessage =
    'Removing or clearing a budget cap needs a qualified finite replacement under the owner monetary policy. Preserve the cap and use an explicit amount; do not discard the policy or reservation.',
  unmappedMessage =
    'This budget field needs an explicit native unit mapping before it can be used under the owner policy.';
/**
 * AMCP_SPEND_POLICY_UNSUPPORTED=abort restores, during the WRT-01 rollout only, the evaluator in which the first money
 * field the policy could not measure discarded the request's other amounts. Unset or any other value keeps them (the
 * default). Read per check, so a redeploy with the variable changed takes effect without a code change.
 */
export const unsupportedAborts = () => process.env.AMCP_SPEND_POLICY_UNSUPPORTED === 'abort';
/**
 * Both walks below recurse over a caller-supplied body. Without a cap, a deeply nested payload
 * inside the request size limit exhausts the stack and surfaces as an internal error rather than
 * a policy decision. report-native.ts already caps its own walk; these now match it. Exceeding
 * the cap is a refusal, not a skip: quietly stopping the descent would let a budget or an
 * activation hide below it.
 */
const maxPayloadDepth = 64;
/**
 * Snapchat mutates through JSON Patch, so a budget or a status can arrive as an operation
 * rather than as a field. An operation is recognised by carrying a string `path` and a `value`,
 * in either key order. Activation uses this value-bearing shape; the budget walk
 * additionally inspects the operation name to distinguish tests and removals.
 */
const patchOperation = (v: JsonObject) =>
  typeof v.path === 'string' && Object.hasOwn(v, 'value') ? {path: v.path, value: v.value} : undefined;
// Snapchat documents an ad squad's lifetime_budget_micro as "Lifetime budget (micro-currency)", the unit of its
// daily_budget_micro (developers.snap.com/marketing-api/Ads-API/ad-squads, read 2026-09-29). spend_cap (Meta and Reddit
// campaign lifetime caps) and total_amount_micros (a Google custom-period budget) are lifetime amounts (owner decision
// D7, budget-units.ts lifetimeAmounts), measured in the platform's native budget unit. DV360's line item budget.maxAmount (a total) and
// pacing.dailyMaxMicros (a daily limit, named by no word of a budget) are measured too (r25-mf-caps).
const nativeAmountField =
  /^(daily_budget|daily_budget_micro|daily_budget_micros|daily_budget_amount_local_micro|total_budget_amount_local_micro|lifetime_budget|lifetime_budget_micro|lifetime_spend_cap_micro|budget|amount|amount_micros|budget_amount_micros|budget_amount|amount_micro|daily_cap|total_cap|total_budget|spend_cap|total_amount_micros|max_amount|daily_max_micros)$/;
const policyField = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
const financialPath = (path: string) => /budget|spend_cap|daily_max_micros/.test(policyField(path));
// Meta's boolean choice of whether ad sets share budget (required from Graph API v24.0, CMP-01) names a budget but is
// not an amount or a cap, so its boolean value is not read as a cleared budget.
// TikTok's boolean choice of whether a campaign shares its budget among its ad groups (campaign budget optimization, `budget_optimize_on`; a Smart+
// Search campaign must send it false, R2.5 M4 S2-1) is the same kind of field: without it, any numeric owner cap refuses a TikTok campaign create that
// names it, as a cap being cleared (POLICY_AMOUNT_UNSUPPORTED).
const budgetChoices = new Set(['is_adset_budget_sharing_enabled', 'budget_optimize_on']);
const moneyLocation = (path: string, key: string) =>
  financialPath(path) &&
  !budgetChoices.has(key) &&
  (nativeAmountField.test(key) || (/budget|spend_cap/.test(key) && !/(?:_id|_ids|_name|_label)$/.test(key)));
/**
 * The budget amounts of a request. In `strict` mode (a numeric budget policy) a money field the policy cannot measure —
 * a cleared or removed cap, or a numeric field with no unit mapping — is added to `unsupported` and the walk goes on, so
 * the amounts it can measure are still compared with every cap (WRT-01 stage A); throwing here used to discard them.
 */
function budgets(
  v: unknown,
  path = '',
  out: Amount[] = [],
  strict = false,
  depth = 0,
  unsupported: Unsupported[] = [],
  identity: readonly string[] = [],
  owner?: string,
): Amount[] {
  if (depth > maxPayloadDepth)
    throw new MirrorError(
      'POLICY_PAYLOAD_TOO_DEEP',
      'This request nests more deeply than the spending policy can inspect, so its budgets cannot be verified.',
      {limit: maxPayloadDepth},
      400,
    );
  const unquantified = (field: string) => unsupported.push({field, message: clearedMessage});
  if (Array.isArray(v)) {
    v.forEach((x, i) => budgets(x, path + '/' + i, out, strict, depth + 1, unsupported, identity, owner));
    return out;
  }
  if (!v || typeof v !== 'object') return out;
  const record = v as JsonObject;
  if (typeof record.op === 'string' && typeof record.path === 'string') {
    const next = path + policyField(record.path),
      name = policyField(record.path.split('/').at(-1)!);
    if (record.op === 'test') return out; // JSON Patch precondition: no budget is changed.
    if (record.op === 'remove') {
      if (strict && moneyLocation(next, name)) unquantified(next);
      return out;
    }
    if (Object.hasOwn(record, 'value'))
      return budgets({[name]: record.value}, next, out, strict, depth + 1, unsupported, identity, owner);
  }
  const resource = (identity.length ? resourceOf(record, identity) : undefined) ?? owner;
  if (strict && Object.hasOwn(record, '$delete')) {
    // REST.li deletes are field names, not numeric values, including nested patches.
    if (!Array.isArray(record.$delete) || record.$delete.some((key: unknown) => typeof key !== 'string'))
      unquantified(path + '/$delete');
    else
      for (const key of record.$delete) {
        const name = policyField(key),
          next = path + '/' + name;
        if (moneyLocation(next, name)) unquantified(next);
      }
  }
  for (const [k, x] of Object.entries(record)) {
    const name = policyField(k),
      next = path + '/' + name;
    if (
      strict &&
      moneyLocation(next, name) &&
      (x === null ||
        x === '' ||
        typeof x === 'boolean' ||
        (typeof x === 'object' && x !== null && !Object.keys(x).length))
    ) {
      unquantified(next);
      continue;
    }
    // A budget the provider states as unlimited is above every cap (DV360 LINE_ITEM_BUDGET_ALLOCATION_TYPE_UNLIMITED), and one it states as
    // infinite (TikTok BUDGET_MODE_INFINITE, the norm of a new campaign) lifts the budget it replaces, a change only where one was held; so
    // does a pacing moved from a daily limit to the whole flight (PACING_PERIOD_FLIGHT) (r25-mf-caps).
    if (moneyLocation(next, name) && typeof x === 'string' && /_(?:UNLIMITED|INFINITE)$/.test(x)) {
      const infinite = x.endsWith('_INFINITE');
      out.push({
        path: next,
        key: infinite ? 'budget' : name,
        amount: Number.MAX_SAFE_INTEGER,
        unlimited: true,
        ...(infinite ? {lifts: true} : {lifetime: true}),
        ...(resource ? {resource} : {}),
      });
      continue;
    }
    if (name === 'pacing_period' && x === 'PACING_PERIOD_FLIGHT') {
      out.push({
        path: next,
        key: 'daily_max_micros',
        amount: Number.MAX_SAFE_INTEGER,
        unlimited: true,
        lifts: true,
        ...(resource ? {resource} : {}),
      });
      continue;
    }
    if (
      financialPath(next) &&
      nativeAmountField.test(name) &&
      x !== null &&
      x !== '' &&
      ['string', 'number'].includes(typeof x)
    ) {
      const exact = policyDecimal(x);
      if (compareDecimal(exact, policyDecimal(Number.MAX_SAFE_INTEGER)) > 0)
        throw new MirrorError('POLICY_AMOUNT_INVALID', 'Budget is outside the policy’s supported numeric range.');
      // A spend cap of zero removes the cap on Meta ad accounts ("A value of 0 means no spending-cap"), so under a
      // numeric policy it is a clearing, never a decrease that is always allowed.
      if (strict && name === 'spend_cap' && exact.units === 0n) {
        unquantified(next);
        continue;
      }
      const decimal = decimalText(exact);
      out.push({path: next, key: name, amount: Number(decimal), decimal, ...(resource ? {resource} : {})});
    } else {
      if (
        strict &&
        financialPath(next) &&
        // An identifier, or a date part (the year, month and day of a DV360 budget segment's range), is no amount.
        !/(?:_id|_ids)$|^(?:year|month|day)$/.test(name) &&
        (typeof x === 'number' || (typeof x === 'string' && /^\d+(\.\d+)?$/.test(x)))
      ) {
        unsupported.push({field: next, message: unmappedMessage});
        continue;
      }
      budgets(x, next, out, strict, depth + 1, unsupported, identity, resource);
    }
  }
  return out;
}
/**
 * A field an update mask names and the update leaves out is cleared by the field-mask rule (Google Ads: `updateMask` beside the
 * `update` of an operation; DV360: `updateMask` in the query beside the body), so the money scans read it as the null it amounts to and
 * judge it as one (r25-mf-caps; the audit saw these three skipped). Mask paths meet the record's keys in snake_case, so
 * `maximize_conversions.target_cpa_micros` finds `maximizeConversions.targetCpaMicros`. The scans read a copy made only when a mask exists.
 */
function nullMasked(record: JsonObject, mask: unknown): void {
  if (typeof mask !== 'string') return;
  for (const path of mask.split(',')) {
    const names = path.trim().split('.').filter(Boolean);
    let at = record;
    for (const [i, name] of names.entries()) {
      const key = Object.keys(at).find(k => policyField(k) === policyField(name)),
        child = key === undefined ? undefined : at[key];
      if (i === names.length - 1) {
        if (key === undefined) at[name] = null;
      } else if (key === undefined) at = at[name] = {};
      else if (child && typeof child === 'object' && !Array.isArray(child)) at = child as JsonObject;
      else break;
    }
  }
}
function maskedScan(plan: CompiledRequest): {body: unknown; query: unknown} {
  const record = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v),
    operations = record(plan.body) && Array.isArray(plan.body.operations) ? (plan.body.operations as unknown[]) : [],
    masked = (op: unknown) => record(op) && record(op.update) && (op.updateMask ?? op.update_mask) !== undefined,
    queryMask = plan.query?.updateMask ?? plan.query?.update_mask;
  if (!operations.some(masked) && !(record(plan.body) && typeof queryMask === 'string'))
    return {body: plan.body, query: plan.query};
  const body = structuredClone(plan.body) as JsonObject;
  for (const op of Array.isArray(body.operations) ? body.operations : [])
    if (masked(op)) nullMasked(op.update, op.updateMask ?? op.update_mask);
  if (typeof queryMask === 'string') nullMasked(body, queryMask);
  return {body, query: plan.query};
}
/** Each update mask of the request, split into its paths, with the path of the record it applies to (Google Ads operations, DV360's query). */
function maskedRecords(plan: CompiledRequest): {root: string; masks: string[][]}[] {
  const record = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v),
    split = (mask: unknown) =>
      typeof mask === 'string'
        ? mask
            .split(',')
            .map(p => p.trim().split('.').filter(Boolean).map(policyField))
            .filter(p => p.length)
        : [],
    operations = record(plan.body) && Array.isArray(plan.body.operations) ? (plan.body.operations as unknown[]) : [],
    found = operations.flatMap((op, i) =>
      record(op) && record(op.update)
        ? [{root: '/body/operations/' + i + '/update', masks: split(op.updateMask ?? op.update_mask)}]
        : [],
    );
  if (record(plan.body)) found.push({root: '/body', masks: split(plan.query?.updateMask ?? plan.query?.update_mask)});
  return found.filter(r => r.masks.length);
}
/**
 * An update mask replaces the message it names whole, so money the reviewed state holds under a masked message and the update does not
 * carry is cleared with it, as a field a leaf mask names and leaves out is (r25-mf-caps): `maximize_conversions` masked with an update that
 * leaves out its target CPA, `pacing` with one that names no daily limit. Compared by name below the record, array positions left out. A
 * mask already judged as cleared is not reported twice, and a daily limit lifted by the flight pacing is reported by that.
 */
function omittedUnderMask(
  plan: CompiledRequest,
  unsupported: Unsupported[],
  requested: Amount[],
  current: Amount[],
): string[] {
  const names = (path: string) => path.split('/').filter(s => s && !/^\d+$/.test(s)),
    found = new Set<string>();
  for (const {root, masks} of maskedRecords(plan)) {
    const carried = requested.flatMap(a => {
      const at = a.path.indexOf(root + '/');
      return at < 0 ? [] : [names(a.path.slice(at + root.length)).join('/')];
    });
    for (const mask of masks) {
      const message = mask.join('/');
      if (unsupported.some(u => u.message === clearedMessage && names(u.field).join('/').includes(message))) continue;
      for (const o of current) {
        if (o.unlimited || requested.some(r => r.lifts && pairing(r) === pairing(o))) continue;
        const held = names(o.path),
          at = held.findIndex((_, k) => mask.every((m, j) => held[k + j] === m));
        if (at < 0 || at + mask.length >= held.length) continue;
        const below = message + '/' + held.slice(at + mask.length).join('/');
        if (!carried.includes(below)) found.add(root + '/' + below);
      }
    }
  }
  return [...found];
}
/** The fields named in `names` that carry a number, or a null that clears one, anywhere in `v`, for money the policy refuses to guess. */
function namedMoney(v: unknown, names: readonly string[], path = '', out: string[] = [], depth = 0): string[] {
  if (depth > maxPayloadDepth)
    throw new MirrorError(
      'POLICY_PAYLOAD_TOO_DEEP',
      'This request nests more deeply than the spending policy can inspect, so its amounts cannot be verified.',
      {limit: maxPayloadDepth},
      400,
    );
  if (Array.isArray(v)) v.forEach((x, i) => namedMoney(x, names, path + '/' + i, out, depth + 1));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v as JsonObject)) {
      const name = policyField(k),
        next = path + '/' + name;
      if (names.includes(name) && (numeric(x) || x === null)) out.push(next);
      else namedMoney(x, names, next, out, depth + 1);
    }
  return out;
}
/**
 * Bid amounts the owner's bid cap compares, in native units: fields named as a bid amount (Google cpcBidMicros and
 * targetCpaMicros, Meta and X bid amounts, TikTok bid_price, Snapchat bid_micro, Reddit bid_value, DV360
 * bidAmountMicros) and the `amount` of a money object under a bid (LinkedIn unitCost, Microsoft CpcBid and Bid, Apple
 * bidAmount, and Apple's CPA cost cap cpaCap.value). Ratios such as a ROAS target are not money and are left out.
 */
const bidField =
  /^(?:bid|bid_amount|bid_price|bid_value|bid_micro|bid_micros|bid_amount_micros|bid_amount_local_micro|cpc_bid_micros|cpm_bid_micros|cpv_bid_micros|percent_cpc_bid_micros|target_cpa_micros|target_cpm_micros|conversion_bid_price|deep_cpa_bid|max_average_cpm_bid_amount_micros)$/;
const bidMoneyParent = /(?:^|_)(?:unit_cost|cpc_bid|cpm_bid|bid_amount|bid|cpa_cap)$/;
const numeric = (x: unknown) => typeof x === 'number' || (typeof x === 'string' && /^\d+(\.\d+)?$/.test(x));
// Google Ads' money fields classified from the pinned Discovery document (tools/google-bid-fields.mjs, WRT-01 stage B)
// are its adapter's (`writes.moneyFields`, src/google-ads-adapter.ts googleMoneyFields; ARC-01 phase B, wave 4c).
/**
 * `cleared` collects the bids a request removes: set to null, named by a JSON Patch `remove` or a REST.li `$delete` (r25-mf-caps; only
 * budgets were read for those). A bid is an amount the cap can compare and so also a cap that can be lifted.
 */
function bidAmounts(
  v: unknown,
  path = '',
  out: Amount[] = [],
  depth = 0,
  extra: readonly string[] = [],
  cleared: string[] = [],
): Amount[] {
  if (depth > maxPayloadDepth)
    throw new MirrorError(
      'POLICY_PAYLOAD_TOO_DEEP',
      'This request nests more deeply than the spending policy can inspect, so its bids cannot be verified.',
      {limit: maxPayloadDepth},
      400,
    );
  if (Array.isArray(v)) {
    v.forEach((x, i) => bidAmounts(x, path + '/' + i, out, depth + 1, extra, cleared));
    return out;
  }
  if (!v || typeof v !== 'object') return out;
  const record = v as JsonObject,
    op = patchOperation(record);
  // The `amount` of a money object, or the `value` of a DV360 bidding strategy (demandGenBid, youtubeAndPartnersBid), is a bid when
  // the object is one, or sits in one (Apple's cpaCap.value), whatever REST.li operator ($set) or array index lies between: the two
  // nearest names of its path say so.
  const bid = (name: string, at: string) =>
    bidField.test(name) ||
    extra.includes(name) ||
    ((name === 'amount' || name === 'value') &&
      pathNames(at)
        .slice(0, 2)
        .some(n => bidMoneyParent.test(n)));
  // A bid object removed whole (unitCost) is named by the object's own name.
  const removed = (name: string, at: string) => bid(name, at) || bidMoneyParent.test(name);
  if (record.op === 'remove' && typeof record.path === 'string') {
    const name = policyField(record.path.split('/').at(-1)!);
    if (removed(name, path + policyField(record.path))) cleared.push(path + policyField(record.path));
    return out;
  }
  if (op && record.op !== 'test')
    return bidAmounts(
      {[policyField(op.path.split('/').at(-1)!)]: op.value},
      path + policyField(op.path),
      out,
      depth + 1,
      extra,
      cleared,
    );
  for (const [k, x] of Object.entries(record)) {
    const name = policyField(k),
      next = path + '/' + name;
    if (name === '$delete' && Array.isArray(x)) {
      for (const field of x)
        if (typeof field === 'string' && removed(policyField(field), path + '/' + policyField(field)))
          cleared.push(path + '/' + policyField(field));
    } else if (removed(name, next) && (x === null || x === '' || (typeof x === 'object' && !Object.keys(x).length)))
      cleared.push(next);
    else if (bid(name, next) && numeric(x)) {
      const exact = policyDecimal(x as string | number);
      out.push({path: next, key: name, amount: Number(decimalText(exact)), decimal: decimalText(exact)});
    } else bidAmounts(x, next, out, depth + 1, extra, cleared);
  }
  return out;
}
/**
 * Activation is a per-provider fact, so it is declared per gateway and matched against the
 * payload structure. Matching a serialized string cannot see a field name the pattern was not
 * written for (Reddit names it configured_status) and depends on JSON key order (a Snapchat
 * JSON Patch operation written {op,value,path} serializes value first); both cases passed the
 * previous text match while the owner policy forbade activation.
 *
 * `null` marks a gateway with no serving-activation surface: measurement writes configure
 * tracking and never start ad delivery, so the activation control does not apply to them.
 *
 * A gateway absent from this table is refused while activation is forbidden. Adding a provider
 * without declaring how it spells activation therefore fails closed instead of passing silently.
 */
type Activation = {field: string; active: string[]};
export const activationFields: Record<string, Activation | null> = {
  // Place links have no paused state; the exact family below treats create/edit
  // as public activation even though no advertising budget is changed.
  google_business_native_action: {field: 'public_link', active: []},
  meta_native_action: {field: 'status', active: ['ACTIVE']},
  google_ads_native_action: {field: 'status', active: ['ENABLED']},
  tiktok_native_action: {field: 'operation_status', active: ['ENABLE']},
  snapchat_native_action: {field: 'status', active: ['ACTIVE']},
  linkedin_native_action: {field: 'status', active: ['ACTIVE']},
  x_ads_native_action: {field: 'entity_status', active: ['ACTIVE']},
  dv360_native_action: {field: 'entityStatus', active: ['ENTITY_STATUS_ACTIVE']},
  reddit_native_action: {field: 'configured_status', active: ['ACTIVE']},
  microsoft_ads_native_action: {field: 'Status', active: ['Active']},
  apple_ads_native_action: {field: 'status', active: ['ENABLED']},
  criteo_native_action: {field: 'status', active: ['active', 'scheduled']},
  ga4_native_action: null,
  gtm_native_action: null,
  google_search_console_native_action: null,
};
/** Field names are compared without underscores or case so entity_status and entityStatus agree. */
const activationKey = (name: string) => name.replace(/_/g, '').toLowerCase();
export function activatesEntity(payload: unknown, rule: Activation): boolean {
  const field = activationKey(rule.field),
    active = rule.active.map(v => v.toUpperCase());
  /**
   * A provider sends the status as a bare string, but a value that arrives wrapped — padded with
   * whitespace, as a one-element array, or under a `value` key — still says ACTIVE. None of these
   * is a documented provider shape, so this is hardening rather than a fix; the cost of reading
   * them is two comparisons and the cost of missing one would be an unenforced policy.
   */
  const matches = (value: unknown): boolean => {
    if (typeof value === 'string') return active.includes(value.trim().toUpperCase());
    // ProtoJSON enum numbers (Google Ads CampaignStatus 2 is ENABLED) name no status, so they cannot be shown to pause.
    if (typeof value === 'number') return true;
    if (Array.isArray(value)) return value.length === 1 && matches(value[0]);
    if (value && typeof value === 'object' && Object.hasOwn(value, 'value'))
      return matches((value as JsonObject).value);
    return false;
  };
  const walk = (v: unknown, depth = 0): boolean => {
    if (depth > maxPayloadDepth)
      throw new MirrorError(
        'POLICY_PAYLOAD_TOO_DEEP',
        'This request nests more deeply than the spending policy can inspect, so it cannot be shown to leave entities paused.',
        {limit: maxPayloadDepth},
        400,
      );
    if (Array.isArray(v)) return v.some(x => walk(x, depth + 1));
    if (!v || typeof v !== 'object') return false;
    const o = v as JsonObject;
    // A JSON Patch operation addresses its target by path, and the keys may appear in any order.
    const op = patchOperation(o);
    if (op) {
      if (activationKey(op.path.split('/').at(-1) ?? '') === field && matches(op.value)) return true;
      return walk(op.value, depth + 1);
    }
    return Object.entries(o).some(([k, x]) => (activationKey(k) === field && matches(x)) || walk(x, depth + 1));
  };
  return walk(payload);
}
/**
 * A create has no prior budget, so percentage and baseline rules cannot apply to it. REST.li POSTs
 * create only against a collection: a resource-scoped POST (…_{id}_post, the PARTIAL_UPDATE contract)
 * changes an existing budget and must stay under the percentage and baseline rules.
 */
export function checkSpendPolicy(
  store: Store,
  actor: Actor,
  plan: CompiledRequest,
  before: unknown,
  reserveId?: string,
  capOverrideConfirmed = false,
  pendingIncrease?: string,
): JsonObject {
  // The other accounts the write changes are its provider's (`writes.sharedAccounts`: Apple's shared budget).
  const accounts = providerHooks(plan.gateway)?.writes?.sharedAccounts?.(plan) ?? [];
  if (accounts.length)
    return store.transaction(() => ({
      scope: 'shared_budget',
      affected_accounts: accounts.map(account => ({
        account_id: account,
        ...checkAccountSpendPolicy(
          store,
          actor,
          {...plan, accountId: account},
          before,
          reserveId ? reserveId + ':' + account : undefined,
          capOverrideConfirmed,
        ),
      })),
      allocation: 'Each account reserves the complete positive increase; no allocation among campaigns is inferred.',
    }));
  return checkAccountSpendPolicy(store, actor, plan, before, reserveId, capOverrideConfirmed, pendingIncrease);
}
/**
 * The parts of one group review checked in order as one change (WRT-04): each part counts the earlier parts' increases
 * as already reserved today, through the same decimal path execute uses, so a daily cap a later part would cross is
 * known at prepare and again before part 1 is sent. Nothing is reserved; under `block` a breach refuses.
 */
export function checkGroupSpendPolicy(
  store: Store,
  actor: Actor,
  parts: {plan: CompiledRequest; state: unknown}[],
  // The place of each given part in its group, when they are not all of it: a resume checks the parts not sent only, and each is named by its own place.
  numbers: number[] = parts.map((_, i) => i + 1),
): {parts: JsonObject[]; exceeded: JsonObject[]; increase_decimal: string} {
  let pending = decimalZero;
  const results = parts.map(({plan, state}, i) => {
    let result: JsonObject;
    try {
      result = checkSpendPolicy(store, actor, plan, state, undefined, false, decimalText(pending));
    } catch (e) {
      // Under `block`, the part that crosses a cap names itself; the earlier parts are counted in already_reserved.
      if (!(e instanceof MirrorError)) throw e;
      throw new MirrorError(
        e.code,
        'Together, the parts of this review exceed the owner’s spending policy at part ' +
          numbers[i]! +
          ': ' +
          e.message,
        {...e.details, group: true, part: numbers[i]!, parts: parts.length},
        e.status,
        e.retryable,
      );
    }
    if (typeof result.requested_increase_decimal === 'string')
      pending = addDecimal(pending, policyDecimal(result.requested_increase_decimal));
    return result;
  });
  return {
    parts: results,
    exceeded: results.flatMap((r, i) => exceededCaps(r).map(x => ({...x, part: numbers[i]!}))),
    increase_decimal: decimalText(pending),
  };
}
/** True when the request activates or widens delivery under `rule`, the gateway's activation field (owner policy). */
export function policyActivates(plan: CompiledRequest, before: unknown, rule: Activation | null | undefined): boolean {
  if (!rule) return false;
  if (familyOf(plan)?.activates?.(plan, before) === true) return true;
  return requestActivates(plan, rule);
}
/**
 * Whether the request itself names an active status under `rule`: policyActivates without a family's `activates` hook, which may need the reviewed state
 * (the generic scan of the body, unless the family exempts itself from it).
 */
function requestActivates(plan: CompiledRequest, rule: Activation | null | undefined): boolean {
  if (!rule) return false;
  const exempt = familyOf(plan)?.exemptFromActivationScan;
  return (
    !(typeof exempt === 'function' ? exempt(plan) : exempt) &&
    activatesEntity({query: plan.query, body: plan.body}, rule)
  );
}
/** Owner-policy amounts a family computes itself; undefined lets the generic budget scan find them. */
export function familyPolicyAmounts(plan: CompiledRequest, before: unknown, policy: JsonObject) {
  return familyOf(plan)?.policyAmounts?.(plan, before, policy);
}
/** Owner limits on amounts. Under `enforcement: 'confirm'` a request beyond one asks the user; under `block` it is refused. */
const capRules = new Set([
  'POLICY_BUDGET_LIMIT',
  'POLICY_INCREASE_LIMIT',
  'POLICY_DAILY_INCREASE_LIMIT',
  'POLICY_BID_LIMIT',
  'POLICY_BASELINE_REQUIRED',
  'POLICY_AMOUNT_UNSUPPORTED',
  // Caps bound to another or an unknown account currency (WRT-07 Stage C).
  'POLICY_CURRENCY_MISMATCH',
  'POLICY_CURRENCY_UNKNOWN',
]);
/** One sentence per exceeded cap, for the confirmation the user sees. */
export function describeExceeded(exceeded: JsonObject[]): string {
  return exceeded
    .map(x =>
      x.rule === 'POLICY_BUDGET_LIMIT'
        ? (x.amount_kind === 'lifetime_or_total' ? 'the lifetime or total amount ' : 'the budget ') +
          (x.requested_decimal ?? x.requested) +
          (x.limit_key === 'max_total_budget_native' ? ' is above the total cap of ' : ' is above the cap of ') +
          x.limit +
          ' (native units' +
          (x.field ? ', ' + x.field : '') +
          ')'
        : x.rule === 'POLICY_AMOUNT_UNSUPPORTED'
          ? String(x.message) + (x.field ? ' (' + x.field + ')' : '')
          : x.rule === 'POLICY_BID_LIMIT'
            ? 'the bid ' +
              (x.requested_decimal ?? x.requested) +
              ' is above the bid cap of ' +
              x.limit +
              ' (native units' +
              (x.field ? ', ' + x.field : '') +
              ')'
            : x.rule === 'POLICY_CURRENCY_MISMATCH'
              ? 'the caps are in ' +
                x.policy_currency +
                ', but this account spends in ' +
                x.account_currency +
                ' (never converted)'
              : x.rule === 'POLICY_CURRENCY_UNKNOWN'
                ? 'the caps are in ' + x.policy_currency + ' and this account’s currency is unknown'
                : x.rule === 'POLICY_INCREASE_LIMIT'
                  ? 'raising ' +
                    (x.before_decimal ?? x.before ?? 'the current budget') +
                    ' to ' +
                    (x.after_decimal ?? x.after) +
                    ' is more than the ' +
                    x.maximum_percent +
                    '% increase cap'
                  : x.rule === 'POLICY_DAILY_INCREASE_LIMIT'
                    ? "today's budget increases would reach " +
                      (x.total_decimal ?? x.requested_increase_decimal) +
                      ', above the daily cap of ' +
                      x.limit +
                      ' (native units, UTC day)'
                    : String(x.message),
    )
    .join('; ');
}
/** A money amount's exact decimal: its source text where the request carried one, else its number. */
const exact = (amount: Amount) => policyDecimal(amount.decimal ?? amount.amount);
/**
 * One account's spending check as its stages share it (ARC-04: checkAccountSpendPolicy was one 430-line function; its
 * stages are the functions below, run in the same order inside one transaction, with the same refusals and findings).
 */
interface SpendCheck {
  readonly store: Store;
  readonly actor: Actor;
  readonly plan: CompiledRequest;
  /** The request as the money scans read it: its body and query, with every masked-out field present as a null (maskedScan). */
  readonly scan: {body: unknown; query: unknown};
  readonly before: unknown;
  /** The governing policy's ID: the account's own, or the workspace default. */
  readonly id: string;
  readonly policy: JsonObject;
  /** Refuses under `block`; under `confirm` records the exceeded cap for the user to acknowledge. */
  readonly breach: (e: MirrorError) => void;
}
/** The stored policy that governs the account, after its access-policy checks; a family may require one. */
function policyRow(store: Store, actor: Actor, plan: CompiledRequest) {
  const read = (key: string) =>
    store.db
      .prepare("SELECT data,revision FROM documents WHERE tenant_id=? AND kind='spend_policy' AND id=?")
      .get(actor.tenantId, key) as JsonObject | undefined;
  // An account-specific policy wins; otherwise the workspace default applies, so an account
  // nobody configured is still covered.
  const accountKey = spendPolicyKey(plan.gateway, plan.accountId!),
    accountRow = read(accountKey);
  const id = accountRow ? accountKey : workspaceDefaultPolicyId,
    row = accountRow ?? read(workspaceDefaultPolicyId);
  return {accountKey, accountRow, id, row};
}
function governingPolicy(store: Store, actor: Actor, plan: CompiledRequest, before: unknown) {
  const {accountKey, accountRow, id, row} = policyRow(store, actor, plan);
  // The switches applied to the access a write grants are its provider's (`writes.accessPolicy`: Business Profile's
  // administrators, Google Ads' users); the stored policy is parsed here whichever provider, as it always was.
  if (row) {
    const stored = JSON.parse(row.data);
    providerHooks(plan.gateway)?.writes?.accessPolicy?.(plan, before, stored);
  }
  const needsPolicy = familyOf(plan)?.requiresSpendPolicy;
  if (!row && (typeof needsPolicy === 'function' ? needsPolicy(plan) : !!needsPolicy))
    throw new MirrorError(
      'POLICY_REQUIRED',
      'This change raises spending and needs a spending policy on the account first. An owner sets one for this account, or a workspace default that covers every account, with amcp_workspace save_spend_policy.',
      {gateway: plan.gateway, account_id: plan.accountId},
      403,
    );
  return {accountKey, accountRow, id, row};
}
/** The owner's deletion and activation switches. */
function assertPolicyAllows({plan, before, policy, id}: SpendCheck): void {
  // The reviewed state goes with the plan: a family may delete through what is already there (a feed whose
  // deletion rule is on), and a body value can delete on a route the catalog calls an update (WRT-02).
  if (policy.allow_deletion === false && applyExecutionRisk(plan, before).destructive) {
    const field = bodyDeletion(plan);
    throw new MirrorError(
      'POLICY_DELETION_FORBIDDEN',
      'The owner policy forbids resource deletion.',
      {policy_id: id, ...(field ? {field} : {})},
      403,
    );
  }
  const refusal = activationRefusal(plan, before, policy, id);
  if (refusal) throw refusal;
}
/**
 * The owner's activation switch applied to a request: the refusal it earns, or undefined. `stateless` judges the request alone (no reviewed state), for the
 * campaign preflight, where a gateway with no declared activation contract is left to the step's review, as it always was.
 */
function activationRefusal(
  plan: CompiledRequest,
  before: unknown,
  policy: JsonObject,
  id: string,
  stateless = false,
): MirrorError | undefined {
  if (policy.allow_activation !== false) return undefined;
  if (!Object.hasOwn(activationFields, plan.gateway))
    return stateless
      ? undefined
      : new MirrorError(
          'POLICY_ACTIVATION_FORBIDDEN',
          'The owner policy forbids activation and this platform has no declared activation contract, so the request cannot be shown to leave entities paused.',
          {policy_id: id, gateway: plan.gateway},
          403,
        );
  // A route that spells activation its own way is its provider's (`writes.activationRule`: LinkedIn's creatives).
  const rule = providerHooks(plan.gateway)?.writes?.activationRule?.(plan) ?? activationFields[plan.gateway];
  if (!(stateless ? requestActivates(plan, rule) : policyActivates(plan, before, rule))) return undefined;
  return new MirrorError(
    'POLICY_ACTIVATION_FORBIDDEN',
    // The owner's "nothing goes live" switch (decision 3, 2026-09-29): it holds under a paused parent too.
    'The owner policy forbids activation. Keep ' +
      rule!.field +
      ' paused (a new entity too, even under a paused parent), or ask the workspace owner to allow activation.',
    {policy_id: id, field: rule!.field},
    403,
  );
}
/**
 * The owner's "nothing goes live" switch judged on a request alone, for the campaign preflight (R2.5 M4, S3-3, the lead's review of eb0c133f): throws the
 * refusal a step's review would make when the policy that governs the account (its own, else the workspace default) forbids activation and the compiled
 * request itself names an active status, so a plan that would stop at its first ENABLE child is blocked before it creates a parent. What only the reviewed
 * state shows (a family's `activates` hook) stays the review's. Reads the policy and writes nothing.
 */
export function assertActivationAllowedByRequest(store: Store, actor: Actor, plan: CompiledRequest): void {
  if (typeof plan.accountId !== 'string') return;
  const {id, row} = policyRow(store, actor, plan);
  if (!row) return;
  const refusal = activationRefusal(plan, undefined, JSON.parse(row.data), id, true);
  if (refusal) throw refusal;
}
/** The reviewed state whose amounts are current: the provider's where it narrows it (Apple's shared budget), else all. */
function policyState(plan: CompiledRequest, before: unknown): unknown {
  const state = providerHooks(plan.gateway)?.writes?.policyState;
  return state ? state(plan, before) : before;
}
/** The request's budget amounts and the reviewed state's, as the family or the generic scan measures them. */
function policyAmounts({plan, scan, before, policy, breach}: SpendCheck) {
  let campaignAmounts: ReturnType<typeof familyAmounts>, amounts: Amount[], old: Amount[];
  const unsupported: Unsupported[] = [],
    strict = budgetLimitKeys.some(k => policy[k] !== undefined);
  const familyAmounts = () => familyPolicyAmounts(plan, before, policy),
    identity = resourceBaselines() ? (resourceIdentity[plan.gateway] ?? []) : [];
  try {
    campaignAmounts = familyAmounts();
    amounts =
      campaignAmounts?.amounts ??
      budgets(scan, /budget/i.test(plan.path) ? '/budget' : '', [], strict, 0, unsupported, identity);
    for (const u of campaignAmounts?.unsupported ?? [])
      unsupported.push({field: u.field, message: u.reason === 'cleared' ? clearedMessage : unmappedMessage});
    old = campaignAmounts?.old ?? budgets(policyState(plan, before), '', [], false, 0, [], identity);
  } catch (e) {
    // A family that still refuses an amount it cannot measure: nothing of that request can be shown to fit the caps.
    if (!(e instanceof MirrorError) || !capRules.has(e.code)) throw e;
    breach(e);
    campaignAmounts = undefined;
    amounts = [];
    old = [];
  }
  // A cap the write clears by leaving it out (a Snapchat PUT replaces the whole record: its adapter's `writes.omittedMoney`, read from the
  // reviewed state) is a cleared cap, as one named null is (r25-mf-caps).
  if (strict)
    for (const field of providerHooks(plan.gateway)?.writes?.omittedMoney?.(plan, before) ?? [])
      unsupported.push({field, message: clearedMessage});
  // Rollback switch of WRT-01 stage A: the evaluator before it, where the first unmeasurable field replaced every
  // other finding of the request. Under block both refuse; under confirm this one hides the measured amounts.
  if (unsupportedAborts() && unsupported.length) {
    const [first] = unsupported.splice(0);
    breach(new MirrorError('POLICY_AMOUNT_UNSUPPORTED', first!.message, {field: first!.field}));
    campaignAmounts = undefined;
    amounts = [];
    old = [];
  }
  return {campaignAmounts, amounts, old, unsupported, strict};
}
/** The request's bid amounts under a bid cap; Google money that is neither a bid nor a budget is unsupported. */
function policyBids({plan, policy, scan}: SpendCheck, unsupported: Unsupported[], strict: boolean): Amount[] {
  // Money the provider's pinned contract classifies (`writes.moneyFields`: Google Ads' Discovery fields) that is neither
  // a bid nor a measured budget (a deprecated spend target) is never guessed.
  const money = providerHooks(plan.gateway)?.writes?.moneyFields;
  if (money && (strict || policy.max_bid_native !== undefined))
    for (const field of namedMoney(scan, money().unsupported)) unsupported.push({field, message: unmappedMessage});
  if (policy.max_bid_native === undefined) return [];
  // A bid the request removes (a mask, a patch remove, a $delete, a null) lifts the cap it was under: judged as a cleared one.
  const cleared: string[] = [],
    bids = bidAmounts(scan, '', [], 0, money ? money().bid : [], cleared);
  for (const field of cleared) unsupported.push({field, message: clearedMessage});
  return bids;
}
/**
 * What pairs an amount with its prior value: the field it is named for, or, for the `amount` of a money object
 * ({amount, currencyCode}: LinkedIn, Apple), the object it belongs to. The leaf `amount` says nothing: a campaign's
 * dailyBudget, totalBudget and unitCost all end in it, and a daily budget used to be measured against the total
 * (r25-mf-caps, the audit of f6f5490d).
 */
const pairing = (a: {key: string; path: string}) =>
  a.key === 'amount' ? (pathNames(a.path)[0] ?? '') + '/amount' : a.key;
/**
 * Whether an amount creates its record, the distinct current values of its field that are its baseline, whether the field
 * was already unlimited (an unlimited prior is no amount: it is never a baseline), and whether those values are the amount's own:
 * the record's identity paired it, or the state shows a value for every amount of the field that `requested` carries. A record that
 * holds none of its own (a bid it never set, a record the state does not show) must not take another's to be called a decrease.
 */
function amountBaseline(
  plan: CompiledRequest,
  campaignAmounts: ReturnType<typeof familyPolicyAmounts>,
  old: Amount[],
  requested: Amount[],
): (b: Amount) => {creating: boolean; candidates: string[]; wasUnlimited: boolean; own: boolean} {
  const restli = (plan.headers['X-RestLi-Method'] ?? '').toUpperCase();
  const updatesExisting =
    ['UPDATE', 'BATCH_UPDATE', 'PARTIAL_UPDATE', 'BATCH_PARTIAL_UPDATE'].includes(restli) ||
    /_(?:id|urn)_post$/.test(plan.action);
  const baseline = (b: Amount) => {
    // A DV360 action is spelled in capitals (DV360_ADVERTISERS_LINE_ITEMS_CREATE): every create was read as an edit and refused for
    // a missing baseline under a percentage or daily cap (r25-mf-caps).
    const creating =
      campaignAmounts?.creating ??
      (!updatesExisting &&
        (/\/create\//.test(b.path) || /create/i.test(plan.action) || /_post$|^Add/.test(plan.action)));
    // Per-resource baselines (WRT-07 Stage B): when the amount and every prior value of its field name the record
    // they belong to, only that record's prior is its baseline, so cutting two budgets is two decreases. An identity
    // with no matching prior has no baseline (never another record's); without identities the field name pairs them.
    const sameField = old.filter(o => pairing(o) === pairing(b)),
      identified = b.resource !== undefined && sameField.length > 0 && sameField.every(o => o.resource !== undefined),
      priors = identified ? sameField.filter(o => o.resource === b.resource) : sameField,
      candidates = [...new Set(priors.filter(o => !o.unlimited).map(o => decimalText(exact(o))))],
      own =
        identified ||
        requested.filter(r => pairing(r) === pairing(b)).length <= sameField.filter(o => !o.unlimited).length;
    return {creating, candidates, wasUnlimited: priors.some(o => o.unlimited), own};
  };
  return baseline;
}
type Baseline = ReturnType<typeof amountBaseline>;
/** A decrease (owner decision D7): an amount on an existing record, not above that record's one current value of the field. */
const lowers = (b: Amount, {creating, candidates, own}: ReturnType<Baseline>) =>
  !creating && own && candidates.length === 1 && compareDecimal(exact(b), policyDecimal(candidates[0]!)) <= 0;
/** Caps stated in account currency without one refuse every money change but a decrease (owner decision P5). */
function assertCurrencyBound(
  {store, actor, plan, before, id, policy}: SpendCheck,
  amounts: Amount[],
  bids: Amount[],
  unsupported: Unsupported[],
  baseline: Baseline,
): void {
  // Owner decision P5 (2026-10-11): caps stated in account currency that name no currency (saved before policies
  // recorded one) cannot be shown to be in the account's currency, so a request with money amounts is refused until
  // the owner saves them again with it, under confirm and block alike, before any cap is compared or anything is
  // reserved; no acknowledgement overrides it. AMCP_LEGACY_CURRENCY_CAPS=warn is the rollback (compared as before).
  // A request that only lowers budgets, each from its record's one current amount, is not refused (owner decision D7:
  // decreases are always allowed): lowering a budget cannot raise spend in any currency, so an owner or operator can
  // still cut spend in an incident. Its amounts are then compared with the caps as before. A bid, a new record, an
  // amount without one current value or an amount AMCP cannot measure is still refused.
  const unbound = unboundCurrencyCaps(policy),
    lowersOnly =
      amounts.length > 0 && !bids.length && !unsupported.length && amounts.every(b => lowers(b, baseline(b)));
  if (
    unbound.length &&
    legacyCurrencyCapsBlock() &&
    !lowersOnly &&
    (amounts.length || bids.length || unsupported.length)
  )
    throw new MirrorError(
      'POLICY_CURRENCY_UNSET',
      'The owner stated these spending caps in account currency without naming the currency, so AMCP cannot tell whether this account spends in it. Nothing was sent: budget and bid changes on this account are refused until the workspace owner saves the policy again with its currency.',
      {
        policy_id: id,
        gateway: plan.gateway,
        fields: unbound,
        account_currency: accountCurrency(store, actor.tenantId, plan, before) ?? null,
      },
      409,
    );
}
/** Compares each budget amount with the caps and returns the request's positive increase. */
function budgetIncrease({plan, policy, breach}: SpendCheck, amounts: Amount[], baseline: Baseline): PolicyDecimal {
  let increase = decimalZero;
  for (const b of amounts) {
    const requested = exact(b);
    const current = baseline(b),
      {creating, candidates} = current;
    // Lifetime and total amounts (owner decision D7) answer to max_total_budget_native when the owner set it. Any amount
    // that is lowered, or restated, from its record's single current value is a decrease and is always allowed, even
    // above a cap (D7, "decreases are always allowed"): it can only reduce what may be spent, and a cap that refused it
    // would stop an owner or operator cutting spend in an incident. It used to hold for totals alone (r25-mf-caps).
    const lifetime = b.lifetime ?? lifetimeAmount(plan.gateway, b.path, b.key),
      totalCap = lifetime && policy.max_total_budget_native !== undefined,
      limit = totalCap ? policy.max_total_budget_native : policy.max_budget_native,
      decrease = lowers(b, current);
    if (b.unlimited) {
      // An unlimited budget has no amount and is above every cap the owner set: each one that is set is exceeded (a create has no
      // current budget to rise from), and nothing finite is reserved (r25-mf-caps). One that changes nothing is not in this list.
      if (limit !== undefined)
        breach(
          new MirrorError(
            'POLICY_BUDGET_LIMIT',
            lifetime
              ? 'The requested lifetime or total amount exceeds the account policy.'
              : 'Requested budget exceeds the account policy.',
            {
              field: b.path,
              requested: 'unlimited',
              requested_decimal: 'unlimited',
              limit,
              units: 'native',
              ...(lifetime ? {amount_kind: 'lifetime_or_total'} : {}),
              ...(totalCap ? {limit_key: 'max_total_budget_native'} : {}),
            },
            403,
          ),
        );
      if (!creating && policy.max_budget_increase_percent !== undefined)
        breach(
          new MirrorError(
            'POLICY_INCREASE_LIMIT',
            'The budget increase exceeds the owner’s percentage limit.',
            {
              field: b.path,
              ...(candidates.length === 1 ? {before: Number(candidates[0]), before_decimal: candidates[0]} : {}),
              after: 'unlimited',
              after_decimal: 'unlimited',
              maximum_percent: policy.max_budget_increase_percent,
            },
            403,
          ),
        );
      if (policy.max_daily_increase_native !== undefined)
        breach(
          new MirrorError(
            'POLICY_DAILY_INCREASE_LIMIT',
            'Cumulative budget increases would exceed the owner’s daily policy.',
            {
              requested_increase: 'unlimited',
              requested_increase_decimal: 'unlimited',
              limit: policy.max_daily_increase_native,
              units: 'native',
            },
            403,
          ),
        );
      continue;
    }
    if (limit !== undefined && !decrease && compareDecimal(requested, policyDecimal(limit)) > 0)
      breach(
        new MirrorError(
          'POLICY_BUDGET_LIMIT',
          lifetime
            ? 'The requested lifetime or total amount exceeds the account policy.'
            : 'Requested budget exceeds the account policy.',
          {
            field: b.path,
            requested: b.amount,
            requested_decimal: decimalText(requested),
            limit,
            units: 'native',
            ...(lifetime ? {amount_kind: 'lifetime_or_total'} : {}),
            ...(totalCap ? {limit_key: 'max_total_budget_native'} : {}),
          },
          403,
        ),
      );
    const baselineMissing =
      !creating &&
      candidates.length !== 1 &&
      (policy.max_budget_increase_percent !== undefined || policy.max_daily_increase_native !== undefined);
    if (baselineMissing)
      breach(
        new MirrorError(
          'POLICY_BASELINE_REQUIRED',
          'This budget policy requires one unambiguous current budget. Narrow the mutation to one resource.',
          {field: b.path},
          409,
        ),
      );
    // Without one current budget, a request confirmed over the caps reserves its whole amount against the daily cap.
    const prior =
      creating || baselineMissing ? decimalZero : candidates.length ? policyDecimal(candidates[0]) : requested;
    const delta = positiveDecimalIncrease(requested, prior);
    // Cross multiplication avoids both rounded division and an epsilon that could
    // authorize an amount genuinely above the owner's exact percentage ceiling.
    if (
      !creating &&
      !baselineMissing &&
      delta.units > 0n &&
      policy.max_budget_increase_percent !== undefined &&
      (prior.units === 0n ||
        compareDecimal(
          multiplyDecimal(delta, policyDecimal(100)),
          multiplyDecimal(prior, policyDecimal(policy.max_budget_increase_percent)),
        ) > 0)
    )
      breach(
        new MirrorError(
          'POLICY_INCREASE_LIMIT',
          'The budget increase exceeds the owner’s percentage limit.',
          {
            field: b.path,
            before: Number(decimalText(prior)),
            before_decimal: decimalText(prior),
            after: b.amount,
            after_decimal: decimalText(requested),
            maximum_percent: policy.max_budget_increase_percent,
          },
          403,
        ),
      );
    increase = addDecimal(increase, delta);
  }
  return increase;
}
/** The account's currency against the caps' (WRT-07 Stage C). */
function currencyFindings(
  {store, actor, plan, before, policy, breach}: SpendCheck,
  amounts: Amount[],
  bids: Amount[],
  unsupported: Unsupported[],
): void {
  // Caps bound to a currency (WRT-07 Stage C) compare only an account that spends in it. AMCP never converts
  // between currencies: another or an unknown account currency is a finding like an exceeded cap.
  if (typeof policy.currency === 'string' && (amounts.length || bids.length || unsupported.length)) {
    const observed = accountCurrency(store, actor.tenantId, plan, before);
    if (!observed) {
      // The live account check records the currency (account-metadata.ts); it reads through a connection.
      const account = normalizeAccount(plan.gateway, String(plan.accountId ?? '')),
        connection = store
          .connectionsFor(actor)
          .find(c => c.gateway === plan.gateway && c.accounts.some(a => normalizeAccount(c.gateway, a) === account));
      breach(
        new MirrorError(
          'POLICY_CURRENCY_UNKNOWN',
          'The owner stated these caps in a currency (policy_currency), and this account’s currency is unknown, so they cannot be compared. Read the account live first (next_call).',
          {
            policy_currency: policy.currency,
            ...(connection
              ? {
                  next_call: {
                    tool: 'amcp_workspace',
                    arguments: {
                      action: 'check',
                      connection_id: connection.id,
                      account_id: plan.accountId,
                      live: true,
                    },
                  },
                }
              : {}),
          },
          409,
        ),
      );
    } else if (observed !== policy.currency)
      breach(
        new MirrorError(
          'POLICY_CURRENCY_MISMATCH',
          'The owner stated these caps in one currency (policy_currency), but this account spends in another (account_currency). AMCP never converts between currencies; the owner states caps for this account in its own currency.',
          {policy_currency: policy.currency, account_currency: observed},
          403,
        ),
      );
  }
}
/** The reviewed state's bids, which a bid of the request is measured against: it is a decrease when it is not above them (r25-mf-caps). */
function priorBids({plan, before, policy}: SpendCheck): Amount[] {
  const money = providerHooks(plan.gateway)?.writes?.moneyFields;
  return policy.max_bid_native === undefined
    ? []
    : bidAmounts(policyState(plan, before), '', [], 0, money ? money().bid : []);
}
/**
 * Each bid against the owner's bid cap. A bid lowered, or restated, from the reviewed state's single current value is a decrease and is never
 * refused by the cap it is still above, as a budget's is (D7); a rise, a bid with no current value and a create are held to the cap (r25-mf-caps).
 */
function bidFindings({policy, breach}: SpendCheck, bids: Amount[], baseline: Baseline): void {
  for (const b of bids) {
    if (lowers(b, baseline(b))) continue;
    if (compareDecimal(exact(b), policyDecimal(policy.max_bid_native)) > 0)
      breach(
        new MirrorError(
          'POLICY_BID_LIMIT',
          'The requested bid exceeds the owner’s bid cap.',
          {
            field: b.path,
            requested: b.amount,
            requested_decimal: b.decimal,
            limit: policy.max_bid_native,
            units: 'native',
          },
          403,
        ),
      );
  }
}
/** Today's reserved increases on the account (UTC day), the earlier parts of a group review included. */
function reservedToday(
  {store, actor}: SpendCheck,
  accountKey: string,
  reserveId: string | undefined,
  pendingIncrease: string | undefined,
) {
  // Keep tenant/account/day filtering in SQLite and stream only matching amounts.
  // SQL SUM on REAL values rounds just like JS addition; lifetime history must not
  // be loaded into JS to fix it. The surrounding IMMEDIATE transaction is unchanged.
  const day = new Date().toISOString().slice(0, 10);
  // Read the filtered JSON text: extracting a large integral aggregate through
  // SQLite's INTEGER binding can throw above MAX_SAFE_INTEGER. Casting REAL to
  // TEXT instead would lose significant digits in legacy numeric reservations.
  const rows = store.db
    .prepare(
      "SELECT id,data FROM documents WHERE tenant_id=? AND kind='spend_reservation' AND json_extract(data,'$.policy_id')=? AND json_extract(data,'$.day')=? AND id<>coalesce(?,'')",
    )
    .iterate(actor.tenantId, accountKey, day, reserveId ?? null) as Iterable<JsonObject>;
  let used = decimalZero;
  for (const row of rows) {
    const reservation = JSON.parse(row.data) as JsonObject;
    // Legacy rows have only the numeric field. Preserve their recorded value;
    // guessing away historical rounding could incorrectly release reserved money.
    const legacy = policyDecimal(reservation.increase_native);
    const amount = reservation.increase_decimal == null ? legacy : policyDecimal(reservation.increase_decimal);
    if (Number(decimalText(amount)) !== Number(decimalText(legacy)))
      throw new MirrorError(
        'POLICY_AMOUNT_INVALID',
        'The retained daily spending reservation has inconsistent amounts.',
        {reservation_id: row.id},
        409,
      );
    used = addDecimal(used, amount);
  }
  // Earlier parts of the same group review count as reserved (WRT-04): the group is one change for the daily cap.
  if (pendingIncrease !== undefined) used = addDecimal(used, policyDecimal(pendingIncrease));
  return {day, used};
}
/** The daily cap, the unmeasurable amounts, the cap confirmation and audit, the reservation and the result. */
function settledCheck(
  {store, actor, plan, id, policy, breach}: SpendCheck,
  {
    accountKey,
    accountRow,
    row,
    enforcement,
    exceeded,
    unsupported,
    increase,
    day,
    used,
    reserveId,
    capOverrideConfirmed,
  }: {
    accountKey: string;
    accountRow: JsonObject | undefined;
    row: JsonObject;
    enforcement: string;
    exceeded: JsonObject[];
    unsupported: Unsupported[];
    increase: PolicyDecimal;
    day: string;
    used: PolicyDecimal;
    reserveId: string | undefined;
    capOverrideConfirmed: boolean;
  },
): JsonObject {
  const requestedDecimal = decimalText(increase),
    usedDecimal = decimalText(used);
  const requestedNumber = Number(requestedDecimal),
    usedNumber = Number(usedDecimal);
  if (
    policy.max_daily_increase_native !== undefined &&
    compareDecimal(addDecimal(used, increase), policyDecimal(policy.max_daily_increase_native)) > 0
  )
    breach(
      new MirrorError(
        'POLICY_DAILY_INCREASE_LIMIT',
        'Cumulative budget increases would exceed the owner’s daily policy.',
        {
          day,
          already_reserved: usedNumber,
          already_reserved_decimal: usedDecimal,
          requested_increase: requestedNumber,
          requested_increase_decimal: requestedDecimal,
          total_decimal: decimalText(addDecimal(used, increase)),
          limit: policy.max_daily_increase_native,
          units: 'native',
        },
        403,
      ),
    );
  // Each money field the policy cannot measure is one finding beside those of the measured amounts, never instead of
  // them: a protective spend cap no longer hides an over-cap budget, and the increase is still reserved below.
  for (const u of unsupported) breach(new MirrorError('POLICY_AMOUNT_UNSUPPORTED', u.message, {field: u.field}));
  // Execute (reserveId set) goes ahead over a cap only with the user's acknowledgement, which the audit records.
  if (exceeded.length && reserveId && !capOverrideConfirmed)
    throw new MirrorError(
      'CAP_CONFIRMATION_REQUIRED',
      'This change goes beyond a spending cap the owner set: ' +
        describeExceeded(exceeded) +
        '. Show the user and, once they approve, execute again with cap_override_confirmed=true.',
      {policy_id: id, exceeded},
    );
  if (exceeded.length && reserveId)
    // Read back for the owner (owner health cap_overrides, WRT-05): who went over which cap, on which account.
    store.appendAudit(actor.tenantId, reserveId, {
      event: 'spend_cap_exceeded_with_confirmation',
      policy_id: id,
      exceeded,
      actor: actor.userId,
      actor_role: actor.role,
      gateway: plan.gateway,
      account_id: plan.accountId,
    });
  if (reserveId)
    store.putDocument(actor.tenantId, 'spend_reservation', reserveId, {
      policy_id: accountKey,
      day,
      increase_native: requestedNumber,
      increase_decimal: requestedDecimal,
      created_at: Date.now(),
    });
  return {
    configured: true,
    policy_id: id,
    scope: accountRow ? 'account' : 'workspace_default',
    policy_revision: row.revision,
    requested_increase_native: requestedNumber,
    requested_increase_decimal: requestedDecimal,
    reserved_today_native: usedNumber,
    reserved_today_decimal: usedDecimal,
    units: 'native',
    enforcement,
    ...(exceeded.length ? {exceeded, cap_override_required: true, exceeded_summary: describeExceeded(exceeded)} : {}),
  };
}
function checkAccountSpendPolicy(
  store: Store,
  actor: Actor,
  plan: CompiledRequest,
  before: unknown,
  reserveId?: string,
  capOverrideConfirmed = false,
  pendingIncrease?: string,
): JsonObject {
  return store.transaction(() => {
    store.assertActorActive(actor);
    const {accountKey, accountRow, id, row} = governingPolicy(store, actor, plan, before);
    if (!row)
      return {
        configured: false,
        unprotected: true,
        advice:
          'No spending policy protects this account. An owner can set one for this account, or a workspace default that covers every account, with amcp_workspace save_spend_policy.',
      };
    const policy = effectivePolicy(JSON.parse(row.data), plan.gateway),
      enforcement = policy.enforcement === 'block' ? 'block' : 'confirm',
      exceeded: JsonObject[] = [];
    /** Refuses under `block`; under `confirm` records the exceeded cap for the user to acknowledge. */
    const breach = (e: MirrorError) => {
      if (enforcement === 'block' || !capRules.has(e.code)) throw e;
      exceeded.push({rule: e.code, message: e.message, ...e.details});
    };
    const check: SpendCheck = {store, actor, plan, scan: maskedScan(plan), before, id, policy, breach};
    assertPolicyAllows(check);
    const {campaignAmounts, amounts: measured, old, unsupported, strict} = policyAmounts(check),
      bids = policyBids(check, unsupported, strict),
      baseline = amountBaseline(plan, campaignAmounts, old, measured),
      // An unlimited budget that changes nothing (restated, already unlimited, a limit lifted that was never set, a create in the infinite
      // mode that is the norm) is no amount at all (r25-mf-caps).
      amounts = measured.filter(b => {
        if (!b.unlimited) return true;
        const {creating, candidates, wasUnlimited} = baseline(b);
        return !wasUnlimited && !(b.lifts && (creating || !candidates.length));
      }),
      priorBid = priorBids(check);
    for (const field of omittedUnderMask(
      plan,
      unsupported,
      [...amounts, ...bids],
      [...(strict ? old : []), ...priorBid],
    ))
      unsupported.push({field, message: clearedMessage});
    assertCurrencyBound(check, amounts, bids, unsupported, baseline);
    const increase = budgetIncrease(check, amounts, baseline);
    currencyFindings(check, amounts, bids, unsupported);
    bidFindings(check, bids, amountBaseline(plan, campaignAmounts, priorBid, bids));
    const {day, used} = reservedToday(check, accountKey, reserveId, pendingIncrease);
    return settledCheck(check, {
      accountKey,
      accountRow,
      row,
      enforcement,
      exceeded,
      unsupported,
      increase,
      day,
      used,
      reserveId,
      capOverrideConfirmed,
    });
  });
}
/** Every cap the checked request exceeds, across the accounts of an Apple shared budget as well. */
export function exceededCaps(result: JsonObject): JsonObject[] {
  return Array.isArray(result.affected_accounts)
    ? result.affected_accounts.flatMap((a: JsonObject) => exceededCaps(a))
    : Array.isArray(result.exceeded)
      ? result.exceeded
      : [];
}
