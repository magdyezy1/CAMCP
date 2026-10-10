import {planReference} from './workspace-core.js';
import {metaPrerequisites} from './meta-prerequisites.js';
import {snapAdPrerequisites} from './snapchat-ad-prerequisites.js';
import {assertAccountWrite} from './write-access.js';
import type {MirrorService} from './service.js';
import type {Actor, CompiledRequest, JsonObject} from './types.js';
import {MirrorError} from './errors.js';
import {assertWriteShape} from './write-shape.js';
import {snapshotPlans} from './write-snapshots.js';
import {applyExecutionRisk} from './execution-risk.js';
import {driveDownloadUrl} from './drive-media.js';
import {mediaLinkUrl} from './media-link.js';
import {validateMetaCreative} from './creative-validation.js';
import {normalizeAccount} from './scope.js';
import {accountPlan, accountCurrency, accountMetadata, accountTimezone} from './workspace.js';
import {accountName, rememberAccountMetadata} from './account-metadata.js';
import {unprotectedAccounts} from './spend-policy.js';
import {groupLimitRefusal, groupParts, needsGroup} from './write-groups.js';
import {fingerprint} from './workspace-core.js';
import {googleJson} from './google-contracts.js';
import {validateState} from './write-state.js';

function googleReference(service: MirrorService, parent: JsonObject | undefined, ref: string): string {
  if (!parent) throw new MirrorError('INVALID_REFERENCE', 'The Google resource predecessor is missing.');
  const account = normalizeAccount('google_ads_native_action', parent.account_id);
  if (parent.kind === 'media' && parent.arguments.platform === 'google_ads')
    return 'customers/' + account + '/assets/1';
  if (parent.gateway !== 'google_ads_native_action')
    throw new MirrorError('INVALID_REFERENCE', 'A Google resource name must come from a Google predecessor.');
  const plan = service.compiler.compile(parent.gateway, {...parent.arguments, account_id: account}, service.options);
  const match = plan.path.match(/^\/v\d+\/customers\/(\d+)\/([A-Za-z]+):mutate$/);
  if (!match)
    throw new MirrorError('INVALID_REFERENCE', 'This predecessor has no declared Google resource mutation receipt.');
  const pointer = /^\/data\/results\/(0|[1-9][0-9]*)\/resourceName$/.exec(ref.slice(ref.indexOf('#') + 1));
  const operations = googleJson(plan.body)?.operations,
    index = pointer ? Number(pointer[1]) : -1;
  if (!Number.isSafeInteger(index) || index < 0 || !Array.isArray(operations) || index >= operations.length)
    throw new MirrorError(
      'INVALID_REFERENCE',
      'Select an existing operation result resourceName from this Google predecessor.',
    );
  const operation = operations[index],
    existing = operation.update?.resourceName ?? operation.remove;
  if (typeof existing === 'string') return existing;
  // Symbolic contract checking uses the actual compiled collection and customer,
  // not guesses based on the action name. Verified native IDs replace these at review.
  const composite: Record<string, string> = {adGroupAds: '1~1', adGroupCriteria: '1~1', campaignCriteria: '1~1'};
  let id = composite[match[2]!] ?? '1';
  if (['campaignAssets', 'adGroupAssets', 'customerAssets', 'assetGroupAssets'].includes(match[2]!)) {
    const type = operation.create?.fieldType;
    if (typeof type !== 'string' || !type.match(/^[A-Z_]+$/))
      throw new MirrorError('INVALID_REFERENCE', 'An asset-association predecessor requires its exact field type.');
    id = (match[2] === 'customerAssets' ? '1~' : '1~1~') + type;
  }
  return 'customers/' + match[1] + '/' + match[2] + '/' + id;
}
const snapSymbolicId = '00000000-0000-4000-8000-000000000001';
// Snapchat rejects an ad squad pixel the ad account does not own (E2405) only when the ad squad is
// written. Compare with that account's own pixel list first. null = list unreadable (deferred).
async function snapchatPixelsOwned(
  service: MirrorService,
  actor: Actor,
  plan: CompiledRequest,
  connectionId: string,
  account: string,
  cache: Map<string, Set<string> | null>,
): Promise<boolean | null | undefined> {
  if (!/^\/v1\/campaigns\/[^/]+\/adsquads$/.test(plan.path)) return undefined;
  const rows = (plan.body as JsonObject | undefined)?.adsquads,
    wanted = [
      ...new Set(
        (Array.isArray(rows) ? rows : [])
          .map((r: JsonObject) => r?.pixel_id)
          .filter((id: unknown): id is string => typeof id === 'string' && id !== snapSymbolicId),
      ),
    ];
  if (!wanted.length) return undefined;
  const key = connectionId + ':' + account;
  if (!cache.has(key)) {
    const read: CompiledRequest = {
      gateway: plan.gateway,
      accountId: account,
      action: 'AMCP_PREFLIGHT_PIXELS',
      method: 'GET',
      path: '/v1/adaccounts/' + account + '/pixels',
      query: {},
      headers: {},
      readOnly: true,
      destructive: false,
      requiresConfirmation: false,
      evidence: 'AMCP ad account pixel ownership read',
      warnings: [],
    };
    try {
      const out = (await service.runPlan(
          read,
          {connection_id: connectionId, aggregate_pages: true, max_pages: 25},
          actor,
        )) as JsonObject,
        d = out.data ?? {};
      cache.set(
        key,
        out.truncated || !Array.isArray(d.pixels)
          ? null
          : new Set(
              d.pixels
                .map((w: JsonObject) => w?.pixel?.id)
                .filter((id: unknown): id is string => typeof id === 'string'),
            ),
      );
    } catch (e) {
      if (!(e instanceof MirrorError)) throw e;
      cache.set(key, null);
    }
  }
  const owned = cache.get(key);
  if (!owned) return null;
  const missing = wanted.filter(id => !owned.has(id));
  if (missing.length)
    throw new MirrorError(
      'SNAPCHAT_PIXEL_NOT_OWNED',
      'Snapchat accepts only pixels owned by this ad account. Use an owned pixel, or share this pixel to the ad account in Snapchat Business Manager first.',
      {pixel_ids: missing, owned_pixel_ids: [...owned].sort()},
    );
  return true;
}
export async function campaignPreflight(
  service: MirrorService,
  actor: Actor,
  steps: JsonObject[],
): Promise<JsonObject> {
  const checks: JsonObject[] = [],
    deferred: JsonObject[] = [],
    accounts = new Set<string>(),
    currencies = new Map<string, string | null>(),
    pixels = new Map<string, Set<string> | null>(),
    accountEvidence: JsonObject[] = [];
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
      const symbolic = (v: any, path = ''): any => {
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, '$ref')) {
          const {ref, prefix} = planReference(v);
          if (!ref.includes('#') || !step.depends_on.includes(ref.split('#')[0]))
            throw new MirrorError('INVALID_REFERENCE', 'References must use a declared predecessor.');
          refs.push(path);
          // A LinkedIn URN built from the referenced ID: the placeholder takes the same shape.
          if (prefix !== undefined) return prefix + '1';
          const parent = steps.find(s => s.id === ref.split('#')[0]);
          if (gateway === 'x_ads_native_action') {
            if (path.endsWith('/media_key')) return '13_1';
            if (path.endsWith('/card_uri')) return 'card://1';
          }
          if (gateway === 'google_ads_native_action') return googleReference(service, parent, ref);
          return gateway === 'snapchat_native_action' ? snapSymbolicId : '1';
        }
        if (Array.isArray(v)) return v.map((x, i) => symbolic(x, path + '/' + i));
        if (v && typeof v === 'object')
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, symbolic(x, path + '/' + k)]));
        return v;
      };
      const args = symbolic(step.arguments),
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
        if (gateway === 'meta_native_action' && plan.path.endsWith('/adcreatives'))
          validateMetaCreative(plan.body as JsonObject, plan.path);
        if (
          gateway === 'snapchat_native_action' &&
          (await snapchatPixelsOwned(service, actor, plan, c.id, account, pixels)) === null &&
          !deferred.some(d => d.step === step.id && d.fields?.includes('pixel_id'))
        )
          deferred.push({
            step: step.id,
            fields: ['pixel_id'],
            reason:
              'The ad account pixel list could not be read; Snapchat validates pixel ownership when the ad squad is written.',
          });
        const assets = [
          ...((await metaPrerequisites(service, actor, plan, c.id, refs)) ?? []),
          ...(await snapAdPrerequisites(service, actor, plan, c.id, refs)),
        ];
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
