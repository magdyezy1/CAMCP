import {planReference} from './workspace-core.js';
import {assertAccountWrite} from './write-access.js';
import type {MirrorService} from './service.js';
import type {Actor, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {assertWriteShape} from './write-shape.js';
import {snapshotPlans} from './write-snapshots.js';
import {applyExecutionRisk} from './execution-risk.js';
import {driveDownloadUrl} from './drive-media.js';
import {mediaLinkUrl} from './media-link.js';
import {normalizeAccount} from './scope.js';
import {
  accountPlan,
  accountCurrency,
  accountMetadata,
  accountTimezone,
  accountName,
  rememberAccountMetadata,
} from './account-metadata.js';
import {unprotectedAccounts} from './spend-policy.js';
import {groupLimitRefusal, groupParts, needsGroup} from './write-groups.js';
import {fingerprint} from './workspace-core.js';
import {validateState} from './write-state.js';
// A step's provider part (ARC-01 phase B, wave 4c: its adapter's `campaign.preflight`), asked where this stage named it.
import {providerHooks} from './provider-hooks.js';
import {bindRecipeStep, recipeProbePlanId} from './campaign-recipes.js';

/**
 * The whole-plan preflight: every step's account grant and read, currency, media and contract checked before any
 * mutation. A provider's own parts are its adapter's `campaign.preflight` (Google's predecessor resource names, X's
 * media key and card URI, Snapchat's symbolic IDs, ad squad pixels and ad creatives, Meta's creative contract and its
 * Page and media, TikTok's launch packs and LinkedIn's lead form), moved verbatim from here; this stage keeps every
 * check and its order and asks the step's provider where it named it.
 */
export async function campaignPreflight(
  service: MirrorService,
  actor: Actor,
  steps: JsonObject[],
): Promise<JsonObject> {
  const checks: JsonObject[] = [],
    deferred: JsonObject[] = [],
    accounts = new Set<string>(),
    currencies = new Map<string, string | null>(),
    // What each provider keeps for this preflight (Snapchat's pixel lists), by gateway.
    caches = new Map<string, Map<string, unknown>>(),
    accountEvidence: JsonObject[] = [];
  const cache = (gateway: string) => {
    if (!caches.has(gateway)) caches.set(gateway, new Map());
    return caches.get(gateway)!;
  };
  const error = (step: string, e: unknown) =>
    checks.push({
      step,
      status: 'blocked',
      error:
        e instanceof MirrorError
          ? {code: e.code, message: e.message, details: e.details}
          : {code: 'PREFLIGHT_FAILED', message: 'This step could not be qualified.'},
    });
  for (const step of steps) {
    try {
      const gateway = step.kind === 'media' ? step.arguments.platform + '_native_action' : step.gateway,
        c = service.store.resolveConnection(actor, gateway, step.account_id, step.connection_id),
        account = normalizeAccount(gateway, step.account_id);
      if (!service.policy.allowWrites || actor.role === 'reader')
        throw new MirrorError(
          'WRITE_ACCOUNT_FORBIDDEN',
          'This step requires enabled deployment writes, an operator role and the selected account write grant.',
        );
      assertAccountWrite(service.store, c, account);
      const accountKey = c.id + ':' + account;
      if (!accounts.has(accountKey)) {
        try {
          const plan = accountPlan(gateway, account);
          const out = (await service.runPlan(plan, {connection_id: c.id}, actor)) as JsonObject;
          if (out.truncated) throw new MirrorError('INCOMPLETE_STATE', 'The account read is incomplete.');
          validateState(plan, {status: out.status ?? 200, headers: out.headers ?? {}, data: out.data});
          {
            const currency = accountCurrency(gateway, out.data),
              meta = accountMetadata(gateway, out.data);
            const nativeId = meta.id ?? meta.Id ?? meta.advertiser_id ?? meta.advertiserId ?? meta.account_id;
            if (
              (typeof nativeId !== 'string' && !(typeof nativeId === 'number' && Number.isSafeInteger(nativeId))) ||
              normalizeAccount(gateway, String(nativeId)) !== account
            )
              throw new MirrorError(
                'STATE_TARGET_MISMATCH',
                'The account read did not return an exact scalar selected identity.',
              );
            currencies.set(accountKey, currency);
            // A plan's account read is a live read like a check's: list_accounts shows what it found (S8).
            rememberAccountMetadata(service.store, actor.tenantId, c.id, account, {
              name: accountName(meta),
              currency,
              timezone: accountTimezone(gateway, out.data),
              organization_id: meta.organization_id,
            });
            if (step.expected_currency !== undefined && currency !== step.expected_currency)
              throw new MirrorError(
                'RECIPE_CURRENCY_MISMATCH',
                'The recipe currency does not match verified account metadata. Refresh account details and correct the recipe before any mutation.',
                {expected_currency: step.expected_currency, actual_currency: currency ?? null},
              );
            accountEvidence.push({
              gateway,
              connection_id: c.id,
              account_id: account,
              currency,
              timezone: accountTimezone(gateway, out.data),
              source_reference: {
                source_kind: 'native_account_read',
                request: {
                  method: plan.method,
                  path: plan.path,
                  query: plan.query,
                  ...(plan.body ? {body: plan.body} : {}),
                },
                response_hash: fingerprint(out.data),
                captured_at: Date.now(),
              },
            });
          }
        } catch (e) {
          if (!(e instanceof MirrorError && e.code === 'READINESS_CONTRACT_UNAVAILABLE')) throw e;
        }
        accounts.add(accountKey);
      }
      if (step.expected_currency !== undefined && currencies.get(accountKey) !== step.expected_currency)
        throw new MirrorError('RECIPE_CURRENCY_MISMATCH', 'Every step must use the verified account currency.');
      if (step.kind === 'media') {
        if (step.arguments.action === 'prepare_library') {
          deferred.push({
            step: step.id,
            reason: 'Provider processing and library eligibility are checked after upload.',
          });
          checks.push({step: step.id, status: 'dependency_pending'});
          continue;
        }
        if (step.arguments.drive_url) driveDownloadUrl(step.arguments.drive_url);
        else if (step.arguments.source_url) mediaLinkUrl(step.arguments.source_url);
        else if (!step.arguments.variant_id && !step.arguments.source_id)
          throw new MirrorError(
            'MEDIA_SOURCE_REQUIRED',
            'Provide a file: source_id (an upload), source_url (a public link), a Google Drive link or a staged variant.',
          );
        // A planned push step is checked against its original and the fitted copy its plan cached, without being
        // prepared, converted and staged once more only to be discarded (MED-03 C).
        const planned = await service.plannedMedia(actor, {
          ...step.arguments,
          account_id: account,
          connection_id: c.id,
        });
        if (planned) {
          checks.push({
            step: step.id,
            status: 'media_checked',
            sha256: planned.sha256,
            size_bytes: planned.size_bytes,
            meaning:
              'The planned file was checked against its original and cached copy without preparing it; exact bytes are staged for the execution review.',
          });
          continue;
        }
        const result = await service.call(
          'amcp_media',
          {...step.arguments, action: 'prepare', account_id: account, connection_id: c.id},
          actor,
        );
        if (!result.success) throw new MirrorError(result.error.code, result.error.message, result.error.details);
        if (result.data.review_id) service.store.removeStagedMedia(actor.tenantId, result.data.review_id);
        checks.push({
          step: step.id,
          status: 'media_checked',
          sha256: result.data.sha256 ?? result.data.request?.sha256,
          size_bytes: result.data.size_bytes ?? result.data.request?.size,
          meaning: 'Media passed preparation; exact bytes are staged again for the execution review.',
        });
        continue;
      }
      const refs: string[] = [];
      // The step's provider's part of the preflight (its adapter's `campaign.preflight`).
      const preflight = providerHooks(gateway)?.campaign?.preflight,
        context = {service, actor, connectionId: c.id, account, cache: cache(gateway), validateState};
      const symbolic = (v: any, path = ''): any => {
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, '$ref')) {
          const {ref, prefix} = planReference(v);
          if (!ref.includes('#') || !step.depends_on.includes(ref.split('#')[0]))
            throw new MirrorError('INVALID_REFERENCE', 'References must use a declared predecessor.');
          refs.push(path);
          // A LinkedIn URN built from the referenced ID: the placeholder takes the same shape.
          if (prefix !== undefined) return prefix + '1';
          const parent = steps.find(s => s.id === ref.split('#')[0]);
          // The provider's placeholder (X's media key and card URI, Google's resource name, Snapchat's symbolic ID).
          return (
            preflight?.reference?.({
              path,
              ref,
              parent,
              compile: (target: string, args: JsonObject) => service.compiler.compile(target, args, service.options),
            }) ?? '1'
          );
        }
        if (Array.isArray(v)) return v.map((x, i) => symbolic(x, path + '/' + i));
        if (v && typeof v === 'object')
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, symbolic(x, path + '/' + k)]));
        return v;
      };
      // A compiled recipe's step leaves what a provider derives from the plan's own ID at a placeholder no request can carry (TikTok's
      // request_id of an Upgraded Smart+ create; R2.5 M4, the lead's decision L3): its contract is checked with a probe, which this
      // read-only check never sends. A step of a saved plan holds its value already and is checked as it is.
      const args = symbolic(bindRecipeStep(step, recipeProbePlanId).arguments),
        delegated = service.registry.tools.get(gateway)?.mode === 'delegated';
      if (service.registry.acceptsArgument(gateway, 'account_id', delegated ? args.operation : undefined)) {
        if (delegated) args.arguments = {...args.arguments, account_id: account};
        else Object.assign(args, {account_id: account});
      }
      const check = async (part: JsonObject) => {
        service.registry.validate(gateway, part, service.options);
        const plan = applyExecutionRisk(
          delegated
            ? service.delegatedCompiler.compile(gateway, part)
            : service.compiler.compile(gateway, part, service.options),
        );
        assertWriteShape(plan);
        snapshotPlans(plan, service.registry);
        // The provider's contract checks (Meta's creative contract, Snapchat's ad squad pixels); what it can check only
        // at the step's review is deferred, once per step and field.
        const deferral = await preflight?.contract?.(plan, context);
        if (deferral && !deferred.some(d => d.step === step.id && d.fields?.includes(deferral.fields[0])))
          deferred.push({step: step.id, ...deferral});
        // The provider's existing dependencies, read live: Meta's Page and media, Snapchat's creatives and lead forms,
        // TikTok's launch packs (CMP-07: the Spark identity, post and pixel before any predecessor is created) and the
        // LinkedIn lead generation pack (CMP-07: the account's lead form, read through its owner finder).
        const assets = [...((await preflight?.prerequisites?.(plan, context, refs, step.prerequisites ?? [])) ?? [])];
        if (assets?.length) checks.push({step: step.id, status: 'prerequisites_checked', assets});
      };
      // The step as it will be sent: whole, or, when only the 25-record limit refuses it, in the parts of 25 that
      // one review covers (write-groups.ts).
      try {
        await check(args);
      } catch (e) {
        if (!(needsGroup(gateway, args) && groupLimitRefusal(e))) throw e;
        for (const part of groupParts(gateway, args)) await check(part);
      }
      if (refs.length)
        deferred.push({
          step: step.id,
          fields: refs,
          reason:
            'These fields depend on IDs from verified predecessors; exact parent ownership and provider validation occur when the step is prepared.',
        });
      checks.push({step: step.id, status: 'contract_checked', references_deferred: refs.length});
    } catch (e) {
      error(step.id, e);
    }
  }
  // One notice per plan when no spending policy covers an account it writes to (Snapchat S13). It never blocks:
  // each review still shows its spending effect and asks for spend_change_confirmed as before.
  const planned = new Set(
      steps.filter(s => s.kind === 'write').map(s => s.gateway + ':' + normalizeAccount(s.gateway, s.account_id)),
    ),
    unprotected = unprotectedAccounts(service.store, actor).filter(a =>
      planned.has(a.gateway + ':' + normalizeAccount(a.gateway, a.account_id)),
    );
  const warnings = unprotected.length
    ? [
        {
          code: 'SPEND_POLICY_MISSING',
          accounts: unprotected.map(a => ({gateway: a.gateway, account_id: a.account_id})),
          message:
            'No spending policy protects ' +
            (unprotected.length === 1 ? 'the account' : unprotected.length + ' accounts') +
            ' this plan writes to, so no owner limit caps its budgets; each review still asks for spend_change_confirmed. This does not block the plan.',
          next_call: {
            tool: 'amcp_workspace',
            arguments: {action: 'save_spend_policy', scope: 'workspace', confirmed: true},
            owner_only: true,
            add_after_owner_choice: {policy: '<the owner’s limits, for example {"max_budget_native": {...}}>'},
          },
        },
      ]
    : [];
  return {
    status: checks.some(c => c.status === 'blocked') ? 'blocked' : 'ready',
    checked_at: Date.now(),
    ...(warnings.length ? {warnings} : {}),
    plan_hash: fingerprint(
      steps.map(s => ({id: s.id, arguments: s.arguments, account_id: s.account_id, connection_id: s.connection_id})),
    ),
    checks,
    account_evidence: accountEvidence,
    deferred,
    provider_mutations: 0,
    meaning:
      'All local contracts, account grants, accessible account reads and media preparations checked. Dependency-bound IDs and vendor final acceptance are validated at each later review.',
  };
}
