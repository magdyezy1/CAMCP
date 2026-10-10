import {
  policyDecimal,
  decimalZero,
  decimalText,
  compareDecimal,
  addDecimal,
  positiveDecimalIncrease,
  multiplyDecimal,
} from './policy-decimal.js';
import {assertBusinessAccessPolicy} from './google-business-access.js';
import {assertGoogleAccessPolicy} from './google-user-access.js';
import {appleSharedAccounts, appleBudgetState} from './apple-entity-writes.js';
import {Store} from './store.js';
import {applyExecutionRisk, bodyDeletion} from './execution-risk.js';
import {MirrorError} from './errors.js';
import {sha256} from './security.js';
import {normalizeAccount} from './scope.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {familyOf} from './reviewed-families.js';
import {budgetUnits, lifetimeAmount, nativeAmount} from './budget-units.js';
import {pinnedJson} from './pinned-json.js';
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
};
/** Whether this actor is the workspace owner: an administrator who owns the workspace, or the local administrator. */
export function workspaceOwner(store: Store, actor: Actor): boolean {
  if (actor.testAccount === true || actor.role !== 'admin') return false;
  if (!actor.ownerUserId) return true;
  return !!store.db
    .prepare("SELECT 1 FROM workspace_memberships WHERE tenant_id=? AND user_id=? AND role='owner' AND active=1")
    .get(actor.tenantId, actor.ownerUserId);
}
export function ownerAccess(store: Store, actor: Actor, action?: string) {
  store.assertActorActive(actor);
  const act = (action && ownerActs[action]) || 'change safety, spending or retention policies';
  if (actor.testAccount === true)
    throw new MirrorError(
      'OWNER_REQUIRED',
      'Reviewer test accounts cannot ' + act + '.',
      {action: action ?? null},
      403,
    );
  if (!workspaceOwner(store, actor))
    throw new MirrorError(
      'OWNER_REQUIRED',
      'Only the workspace owner can ' +
        act +
        '.' +
        (action === 'health'
          ? ' Administrators see connection status and job queues; ask one of them or the owner.'
          : ''),
      {action: action ?? null, required_role: action === 'health' ? 'owner or administrator' : 'owner'},
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
const invalidPolicy = (message = 'Use explicit activation/deletion permissions and non-negative numeric limits.') =>
  new MirrorError('INVALID_POLICY', message);
const validLimit = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
/** Money limits of one platform: native ones as given, currency ones converted to native and kept for display. */
function moneyLimits(input: JsonObject, gateway: string): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (!validLimit(value)) throw invalidPolicy();
    if (nativeMoneyKeys.includes(key)) out[key] = value;
    else if (currencyMoneyKeys[key]) {
      const native = nativeAmount(gateway, value as number);
      if (native === undefined)
        throw invalidPolicy(
          gateway +
            ' has no documented budget unit in AMCP, so state ' +
            key +
            ' in native API units as ' +
            currencyMoneyKeys[key] +
            '.',
        );
      out[currencyMoneyKeys[key]] = native;
      out[key] = value;
    } else throw invalidPolicy();
  }
  return out;
}
/**
 * Checks and normalises a policy. `enforcement` is `confirm` (the default: a request over a cap asks the user, owner
 * decision of 2026-09-28) or `block` (the cap refuses it). A workspace default can state money limits per platform
 * under `per_gateway`, because one number means micros on one platform and currency units on another (F-04); a native
 * amount at its top level still applies to every platform without its own entry, with a warning.
 */
function validatePolicy(p: JsonObject, scope: {workspace: true} | {workspace: false; gateway: string}): JsonObject {
  const out: JsonObject = {};
  const money: JsonObject = {};
  for (const [key, value] of Object.entries(p)) {
    if (key === 'allow_activation' || key === 'allow_deletion') {
      if (typeof value !== 'boolean') throw invalidPolicy();
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
    if (!scope.workspace) Object.assign(out, moneyLimits(money, scope.gateway));
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
    const warnings = [...policyWarnings(store, actor.tenantId), ...saved.warnings];
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
  const p = validatePolicy(input.policy as JsonObject, {workspace: false, gateway: input.gateway});
  store.resolveConnection(actor, input.gateway, input.account_id, input.connection_id);
  const id = spendPolicyKey(input.gateway, input.account_id),
    data = {
      ...p,
      gateway: input.gateway,
      account_id: normalizeAccount(input.gateway, input.account_id),
      updated_at: Date.now(),
      updated_by: actor.userId,
      money_units: moneyUnits,
      ...(budgetUnits[input.gateway] ? {native_unit: budgetUnits[input.gateway]} : {}),
    };
  const saved = putPolicy(store, actor, id, data, expected);
  return {id, revision: saved.revision, ...data, ...(saved.warnings.length ? {warnings: saved.warnings} : {})};
}
/**
 * Stored policies that need the owner's attention: a workspace default saved before per-platform limits, whose single
 * native amount means different money on each platform (F-04). It still applies until it is saved again.
 */
export function policyWarnings(store: Store, tenant: string): JsonObject[] {
  const row = store.documents(tenant, 'spend_policy').find(p => p.id === workspaceDefaultPolicyId);
  const legacy = nativeMoneyKeys.filter(k => row?.[k] !== undefined && row[k] !== 0);
  return legacy.length
    ? [
        {
          policy_id: workspaceDefaultPolicyId,
          fields: legacy,
          message:
            'The workspace default applies one native amount to every platform without its own per_gateway entry, although Google counts micros and LinkedIn currency units. State caps per platform under per_gateway.',
        },
      ]
    : [];
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
  for (const c of store.listConnections(actor.tenantId))
    for (const account of c.accounts)
      if (!ids.has(spendPolicyKey(c.gateway, account)))
        rows.push({gateway: c.gateway, account_id: account, connection_id: c.id});
  return rows;
}
type Amount = {path: string; key: string; amount: number; decimal?: string; lifetime?: boolean};
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
// D7, budget-units.ts lifetimeAmounts), measured in the platform's native budget unit.
const nativeAmountField =
  /^(daily_budget|daily_budget_micro|daily_budget_micros|daily_budget_amount_local_micro|total_budget_amount_local_micro|lifetime_budget|lifetime_budget_micro|lifetime_spend_cap_micro|budget|amount|amount_micros|budget_amount_micros|budget_amount|amount_micro|daily_cap|total_cap|total_budget|spend_cap|total_amount_micros)$/;
const policyField = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
const financialPath = (path: string) => /budget|spend_cap/.test(policyField(path));
// Meta's boolean choice of whether ad sets share budget (required from Graph API v24.0, CMP-01) names a budget but is
// not an amount or a cap, so its boolean value is not read as a cleared budget.
const budgetChoices = new Set(['is_adset_budget_sharing_enabled']);
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
    v.forEach((x, i) => budgets(x, path + '/' + i, out, strict, depth + 1, unsupported));
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
      return budgets({[name]: record.value}, next, out, strict, depth + 1, unsupported);
  }
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
      out.push({path: next, key: name, amount: Number(decimal), decimal});
    } else {
      if (
        strict &&
        financialPath(next) &&
        !/(?:_id|_ids)$/.test(name) &&
        (typeof x === 'number' || (typeof x === 'string' && /^\d+(\.\d+)?$/.test(x)))
      ) {
        unsupported.push({field: next, message: unmappedMessage});
        continue;
      }
      budgets(x, next, out, strict, depth + 1, unsupported);
    }
  }
  return out;
}
/** The fields named in `names` that carry a number anywhere in `v`, for money the policy refuses to guess. */
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
      if (names.includes(name) && numeric(x)) out.push(next);
      else namedMoney(x, names, next, out, depth + 1);
    }
  return out;
}
/**
 * Bid amounts the owner's bid cap compares, in native units: fields named as a bid amount (Google cpcBidMicros and
 * targetCpaMicros, Meta and X bid amounts, TikTok bid_price, Snapchat bid_micro, Reddit bid_value, DV360
 * bidAmountMicros) and the `amount` of a money object under a bid (LinkedIn unitCost, Microsoft CpcBid and Bid, Apple
 * bidAmount). Ratios such as a ROAS target are not money and are left out.
 */
const bidField =
  /^(?:bid|bid_amount|bid_price|bid_value|bid_micro|bid_micros|bid_amount_micros|bid_amount_local_micro|cpc_bid_micros|cpm_bid_micros|cpv_bid_micros|percent_cpc_bid_micros|target_cpa_micros|target_cpm_micros|conversion_bid_price|deep_cpa_bid|max_average_cpm_bid_amount_micros)$/;
const bidMoneyParent = /(?:^|_)(?:unit_cost|cpc_bid|cpm_bid|bid_amount|bid)$/;
const numeric = (x: unknown) => typeof x === 'number' || (typeof x === 'string' && /^\d+(\.\d+)?$/.test(x));
/**
 * Google Ads money fields classified from the pinned Discovery document (tools/google-bid-fields.mjs, WRT-01 stage B):
 * bid ceilings, floors and targets join the bid cap, and money that is neither a bid nor a measured budget is refused
 * as unsupported under a numeric policy. Ratios such as location_fraction_micros stay out.
 */
type GoogleMoneyFields = {bid: string[]; unsupported: string[]};
let googleMoney: GoogleMoneyFields | undefined;
export function googleMoneyFields(): GoogleMoneyFields {
  return (googleMoney ??= (() => {
    const fields = pinnedJson<{fields: GoogleMoneyFields}>('generated/google-bid-fields.json').fields;
    return {bid: [...fields.bid], unsupported: [...fields.unsupported]};
  })());
}
const googleGateway = 'google_ads_native_action';
function bidAmounts(
  v: unknown,
  path = '',
  parent = '',
  out: Amount[] = [],
  depth = 0,
  extra: readonly string[] = [],
): Amount[] {
  if (depth > maxPayloadDepth)
    throw new MirrorError(
      'POLICY_PAYLOAD_TOO_DEEP',
      'This request nests more deeply than the spending policy can inspect, so its bids cannot be verified.',
      {limit: maxPayloadDepth},
      400,
    );
  if (Array.isArray(v)) {
    v.forEach((x, i) => bidAmounts(x, path + '/' + i, parent, out, depth + 1, extra));
    return out;
  }
  if (!v || typeof v !== 'object') return out;
  const op = patchOperation(v as JsonObject);
  if (op && (v as JsonObject).op !== 'test' && (v as JsonObject).op !== 'remove')
    return bidAmounts(
      {[policyField(op.path.split('/').at(-1)!)]: op.value},
      path + policyField(op.path),
      parent,
      out,
      depth + 1,
      extra,
    );
  for (const [k, x] of Object.entries(v as JsonObject)) {
    const name = policyField(k),
      next = path + '/' + name;
    if (
      (bidField.test(name) || extra.includes(name) || (name === 'amount' && bidMoneyParent.test(parent))) &&
      numeric(x)
    ) {
      const exact = policyDecimal(x as string | number);
      out.push({path: next, key: name, amount: Number(decimalText(exact)), decimal: decimalText(exact)});
    } else bidAmounts(x, next, name, out, depth + 1, extra);
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
  const accounts = appleSharedAccounts(plan);
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
        'Together, the parts of this review exceed the owner’s spending policy at part ' + (i + 1) + ': ' + e.message,
        {...e.details, group: true, part: i + 1, parts: parts.length},
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
    exceeded: results.flatMap((r, i) => exceededCaps(r).map(x => ({...x, part: i + 1}))),
    increase_decimal: decimalText(pending),
  };
}
/** True when the request activates or widens delivery under `rule`, the gateway's activation field (owner policy). */
export function policyActivates(plan: CompiledRequest, before: unknown, rule: Activation | null | undefined): boolean {
  if (!rule) return false;
  const family = familyOf(plan);
  if (family?.activates?.(plan, before) === true) return true;
  const exempt = family?.exemptFromActivationScan;
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
            : x.rule === 'POLICY_INCREASE_LIMIT'
              ? 'raising ' +
                (x.before_decimal ?? x.before) +
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
    if (row) assertBusinessAccessPolicy(plan, before, JSON.parse(row.data));
    if (row) assertGoogleAccessPolicy(plan, before, JSON.parse(row.data));
    const needsPolicy = familyOf(plan)?.requiresSpendPolicy;
    if (!row && (typeof needsPolicy === 'function' ? needsPolicy(plan) : !!needsPolicy))
      throw new MirrorError(
        'POLICY_REQUIRED',
        'This change raises spending and needs a spending policy on the account first. An owner sets one for this account, or a workspace default that covers every account, with amcp_workspace save_spend_policy.',
        {gateway: plan.gateway, account_id: plan.accountId},
        403,
      );
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
    if (policy.allow_activation === false) {
      if (!Object.hasOwn(activationFields, plan.gateway))
        throw new MirrorError(
          'POLICY_ACTIVATION_FORBIDDEN',
          'The owner policy forbids activation and this platform has no declared activation contract, so the request cannot be shown to leave entities paused.',
          {policy_id: id, gateway: plan.gateway},
          403,
        );
      const rule =
        plan.gateway === 'linkedin_native_action' &&
        /^\/rest\/adAccounts\/[^/]+\/creatives(?:\/[^/]+)?$/.test(plan.path)
          ? {field: 'intendedStatus', active: ['ACTIVE']}
          : activationFields[plan.gateway];
      if (policyActivates(plan, before, rule))
        throw new MirrorError(
          'POLICY_ACTIVATION_FORBIDDEN',
          // The owner's "nothing goes live" switch (decision 3, 2026-09-29): it holds under a paused parent too.
          'The owner policy forbids activation. Keep ' +
            rule!.field +
            ' paused (a new entity too, even under a paused parent), or ask the workspace owner to allow activation.',
          {policy_id: id, field: rule!.field},
          403,
        );
    }
    let campaignAmounts: ReturnType<typeof familyAmounts>, amounts: Amount[], old: Amount[];
    const unsupported: Unsupported[] = [],
      strict = budgetLimitKeys.some(k => policy[k] !== undefined);
    const familyAmounts = () => familyPolicyAmounts(plan, before, policy);
    try {
      campaignAmounts = familyAmounts();
      amounts =
        campaignAmounts?.amounts ??
        budgets(
          {body: plan.body, query: plan.query},
          /budget/i.test(plan.path) ? '/budget' : '',
          [],
          strict,
          0,
          unsupported,
        );
      for (const u of campaignAmounts?.unsupported ?? [])
        unsupported.push({field: u.field, message: u.reason === 'cleared' ? clearedMessage : unmappedMessage});
      old = campaignAmounts?.old ?? budgets(appleBudgetState(plan, before));
    } catch (e) {
      // A family that still refuses an amount it cannot measure: nothing of that request can be shown to fit the caps.
      if (!(e instanceof MirrorError) || !capRules.has(e.code)) throw e;
      breach(e);
      campaignAmounts = undefined;
      amounts = [];
      old = [];
    }
    // Rollback switch of WRT-01 stage A: the evaluator before it, where the first unmeasurable field replaced every
    // other finding of the request. Under block both refuse; under confirm this one hides the measured amounts.
    if (unsupportedAborts() && unsupported.length) {
      const [first] = unsupported.splice(0);
      breach(new MirrorError('POLICY_AMOUNT_UNSUPPORTED', first!.message, {field: first!.field}));
      campaignAmounts = undefined;
      amounts = [];
      old = [];
    }
    // Google money that is neither a bid nor a measured budget (a deprecated spend target) is never guessed.
    if (plan.gateway === googleGateway && (strict || policy.max_bid_native !== undefined))
      for (const field of namedMoney({body: plan.body, query: plan.query}, googleMoneyFields().unsupported))
        unsupported.push({field, message: unmappedMessage});
    const exact = (amount: Amount) => policyDecimal(amount.decimal ?? amount.amount);
    let increase = decimalZero;
    const restli = (plan.headers['X-RestLi-Method'] ?? '').toUpperCase();
    const updatesExisting =
      ['UPDATE', 'BATCH_UPDATE', 'PARTIAL_UPDATE', 'BATCH_PARTIAL_UPDATE'].includes(restli) ||
      /_(?:id|urn)_post$/.test(plan.action);
    for (const b of amounts) {
      const requested = exact(b);
      const creating =
        campaignAmounts?.creating ??
        (!updatesExisting && (/\/create\//.test(b.path) || /create|_post$|^Add/.test(plan.action)));
      const candidates = [...new Set(old.filter(o => o.key === b.key).map(o => decimalText(exact(o))))];
      // Lifetime and total amounts (owner decision D7) answer to max_total_budget_native when the owner set it, and
      // lowering one from its single current value is always allowed: it can only reduce what may be spent.
      const lifetime = b.lifetime ?? lifetimeAmount(plan.gateway, b.path, b.key),
        totalCap = lifetime && policy.max_total_budget_native !== undefined,
        limit = totalCap ? policy.max_total_budget_native : policy.max_budget_native,
        decrease =
          lifetime &&
          !creating &&
          candidates.length === 1 &&
          compareDecimal(requested, policyDecimal(candidates[0]!)) <= 0;
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
    if (policy.max_bid_native !== undefined)
      for (const b of bidAmounts(
        {body: plan.body, query: plan.query},
        '',
        '',
        [],
        0,
        plan.gateway === googleGateway ? googleMoneyFields().bid : [],
      ))
        if (compareDecimal(policyDecimal(b.decimal ?? b.amount), policyDecimal(policy.max_bid_native)) > 0)
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
