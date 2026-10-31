// ARC-01 (reporting, wave 4c round 6): the guided platforms' native budget drafts of an allocation preview moved from
// src/allocation-plan.ts into each platform's module (src/<platform>-allocation-draft.ts, declared by its guided
// reporting beside its allocation model). These tests compare every draft with the branches src/allocation-plan.ts
// held, copied below as they were, and run the plan's public functions on synthetic reports with fake stores: no
// provider request is sent and no login is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  allocationCreationBinding,
  allocationGateway,
  assertAllocationStep,
  previewAllocationPlan,
} from '../dist/src/allocation-plan.js';
import {guidedReportSources} from '../dist/src/report-sources.js';
import {reportPlatforms} from '../dist/src/report-metrics.js';
import {reportAllocation} from '../dist/src/report-allocation.js';
import {bad, fingerprint} from '../dist/src/workspace-core.js';
import {currencyText, metaCurrencyOffset} from '../dist/src/budget-units.js';
import {linkedinStoredVersion} from '../dist/src/linkedin-version.js';
import {googleAllocationBudgets} from '../dist/src/google-allocation-budgets.js';
import {snapchatAllocationBudgets} from '../dist/src/snapchat-allocation-budgets.js';
import {linkedinAllocationBudgets} from '../dist/src/linkedin-allocation-budgets.js';
import {metaAllocationBudgets} from '../dist/src/meta-allocation-budgets.js';
import {allocationReport} from './fixtures/allocation-data.mjs';
import {snapchatAllocationData, snapchatAllocationIds} from './fixtures/snapchat-allocation-data.mjs';

// ---- The branches of src/allocation-plan.ts before the move, verbatim but for their types. ----
const gateway = 'google_ads_native_action';
const decimal = n => {
  const tail = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return String(n / 1000000n) + (tail ? '.' + tail : '');
};
function legacyBudgets(store, call, actor, source, ids, pricing = true, window) {
  if (source.gateway === 'snapchat_native_action') return snapchatAllocationBudgets(store, call, actor, source, ids);
  if (source.gateway === 'linkedin_native_action')
    return linkedinAllocationBudgets(store, call, actor, source, ids, pricing);
  if (source.gateway === 'meta_native_action') return metaAllocationBudgets(store, call, actor, source, ids);
  return googleAllocationBudgets(store, call, actor, source, ids, window);
}
function legacyDraft(binding, previewId) {
  const snap = binding.gateway === 'snapchat_native_action',
    linkedin = binding.gateway === 'linkedin_native_action',
    meta = binding.gateway === 'meta_native_action',
    targetGateway = binding.gateway ?? gateway;
  return {
    action: 'create',
    name: 'Allocation budget draft',
    idempotency_key: 'allocation-' + previewId,
    allocation_preview_id: previewId,
    allocation_preview_hash: fingerprint(binding),
    confirmed: true,
    brief:
      'Source report ' +
      binding.report_id +
      '; model ' +
      binding.model_fingerprint +
      (binding.options?.factor_source?.kind === 'calibration'
        ? '; efficiency factors from retained calibration ' + binding.options.factor_source.evidence_fingerprint
        : '; efficiency factors declared by the operator') +
      '. Equal daily conversion over a comparable ' +
      binding.period_days +
      (snap || linkedin || meta
        ? '-day period. Daily budgets remain in effect until separately changed; this draft sets no end date. Every step still needs native review, spending acknowledgement and read-back.'
        : '-day period. Average daily budgets remain in effect until separately changed; this draft sets no end date. Every step still needs native review, spending acknowledgement and read-back.'),
    steps: binding.targets.map((t, i) => ({
      id: 'allocation-' + (i + 1),
      kind: 'write',
      gateway: targetGateway,
      connection_id: binding.connection_id,
      account_id: binding.account_id,
      expected_currency: binding.currency,
      depends_on: [],
      description:
        (snap ? 'Ad squad ' : 'Campaign ') +
        (t.entity_id ?? t.campaign_id) +
        (meta && t.budget_owner === 'ad_set' ? ' (ad set ' + t.adset_id + ')' : '') +
        (snap || linkedin || meta ? ': daily budget ' : ': average daily budget ') +
        decimal(BigInt(t.daily_budget_micros)) +
        ' ' +
        binding.currency +
        (meta ? ' (' + t.daily_budget_native + ' in Meta minor units)' : ''),
      arguments: meta
        ? t.budget_owner === 'ad_set'
          ? {
              action: 'meta_ad_set_id_update',
              path_params: {ad_set_id: t.adset_id},
              payload: {daily_budget: t.daily_budget_native},
            }
          : {
              action: 'meta_campaign_id_update',
              path_params: {campaign_id: t.campaign_id},
              payload: {daily_budget: t.daily_budget_native},
            }
        : snap
          ? {
              action: 'snapchat_adsquad_update',
              path_params: {campaign_id: binding.parent_campaign_id, ad_squad_id: t.entity_id},
              payload: [{op: 'replace', path: '/daily_budget_micro', value: Number(t.daily_budget_micros)}],
            }
          : linkedin
            ? {
                action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
                api_version: binding.api_version,
                restli_method: 'PARTIAL_UPDATE',
                path_params: {ad_account_id: binding.account_id, campaign_id: t.campaign_id},
                payload: {patch: {$set: {dailyBudget: {amount: t.daily_budget, currencyCode: binding.currency}}}},
              }
            : {
                action: 'google_ads_v23_campaign_budget_mutate_campaign_budgets',
                payload: {
                  operations: [
                    {
                      update: {resource_name: t.budget_resource, amount_micros: t.daily_budget_micros},
                      update_mask: 'amount_micros',
                    },
                  ],
                  partial_failure: false,
                },
              },
    })),
  };
}
// previewAllocationPlan's platform flags, source fields, Meta offset, per-target checks, name and meaning.
const flags = report => ({
  snap: report.gateway === 'snapchat_native_action' && report.preset === 'snapchat_adsquad',
  linkedin: report.gateway === 'linkedin_native_action' && report.preset === 'linkedin_campaign',
  meta: report.gateway === 'meta_native_action' && report.preset === 'meta_campaign',
});
const legacyQualified = report => {
  const {snap, linkedin, meta} = flags(report);
  return !(!snap && !linkedin && !meta && (report.gateway !== gateway || report.preset !== 'google_campaign'));
};
const legacySource = (report, {snap, linkedin}) => ({
  ...(linkedin ? {api_version: linkedinStoredVersion(report.source_request?.api_version)} : {}),
  ...(snap ? {parent_campaign_id: report.source_request.path_params.campaign_id} : {}),
});
function legacyOffset({meta}, currency) {
  const offset = meta ? metaCurrencyOffset(currency) : undefined;
  if (meta && offset === undefined)
    bad(
      'Meta budgets count in the account currency’s minor unit, and AMCP has no pinned Meta offset for this currency. Pin Meta’s currency table before converting an allocation; nothing was read or saved.',
      'ALLOCATION_PRECISION',
      {currency},
    );
  return offset;
}
function legacyDaily({snap}, daily, r, currency, native) {
  const limits = native.daily_budget_limits;
  if (
    limits?.status === 'checked' &&
    (daily < BigInt(limits.min_micros) || (limits.max_micros !== null && daily > BigInt(limits.max_micros)))
  )
    bad(
      'A converted daily budget is outside the daily budget limits LinkedIn states for this account. Adjust the model bounds.',
      'ALLOCATION_BUDGET_LIMIT',
      {
        entity_id: r.entity_id,
        daily_budget: currencyText(daily, currency),
        minimum: limits.min,
        maximum: limits.max,
        currency,
      },
    );
  if (snap && daily < 5000000n)
    bad(
      'Every Snapchat daily budget must meet the documented minimum of 5000000 native micros.',
      'ALLOCATION_PRECISION',
    );
}
const legacyName = ({linkedin}, n, r) => (linkedin && n.campaign.name ? n.campaign.name : r.name);
const legacyMeaning = ({meta, linkedin}, binding) =>
  meta
    ? 'Preview only. Each Meta daily budget is set on its current owner: the campaign when it has a campaign daily budget, otherwise its one spending ad set. Amounts are whole Meta minor units of the account currency, rounded down; residuals are shown. Meta can spend up to 75% more than a daily budget on a day with better opportunities and at most seven times it over a calendar week. Daily budgets remain in effect until changed; this draft sets no end date and does not approve or execute any change.'
    : linkedin
      ? 'Preview only. LinkedIn native daily budgets use decimal account-currency amounts, rounded down to the smallest unit of the currency and checked against LinkedIn’s daily budget limits for the account when it states them. Rounding residuals are shown. Daily settings remain in effect until changed, and LinkedIn can charge up to 150% of a daily budget on a day with strong auction opportunities. Existing group caps are preserved. This draft sets no end date or automatic period spending cap, and does not approve or execute any change.'
      : binding.gateway === 'snapchat_native_action'
        ? 'Preview only. Daily amounts round down to the smallest unit of the account currency; residuals are shown. These are ongoing daily budgets, not a scheduled period spending cap. Creating a draft does not approve or execute it.'
        : 'Preview only. Daily amounts round down to the smallest unit of the account currency; residuals are shown. These are ongoing average daily budgets, not a scheduled period spending cap. Creating a draft does not approve or execute it.';
const legacySourceChanged = (selectedGateway, report, b) =>
  selectedGateway === 'snapchat_native_action' &&
  report.source_request?.path_params?.campaign_id !== b.parent_campaign_id;

// ---- The registry's drafts. ----
const drafts = Object.fromEntries(
  guidedReportSources
    .filter(source => source.guided?.allocationDraft)
    .map(source => [
      reportPlatforms[source.platform].gateway,
      {preset: source.guided.allocation.preset, draft: source.guided.allocationDraft},
    ]),
);
const draftOf = gw => (drafts[gw] ?? drafts[gateway]).draft;
const outcome = run => {
  try {
    return {value: run()};
  } catch (error) {
    return {code: error.code, message: error.message, details: error.details, status: error.status};
  }
};
const actor = {tenantId: 'allocation-drafts', userId: 'operator', role: 'operator'};
const presets = ['google_campaign', 'meta_campaign', 'linkedin_campaign', 'snapchat_adsquad', 'tiktok_campaign', 'x'];
const gateways = [
  gateway,
  'meta_native_action',
  'linkedin_native_action',
  'snapchat_native_action',
  'tiktok_native_action',
  'google_ads',
  undefined,
];

test('the guided allocation models declare the four native budget drafts, with Google Ads’ the one fallback', () => {
  assert.deepEqual(
    Object.entries(drafts).map(([gw, entry]) => [gw, entry.preset]),
    [
      [gateway, 'google_campaign'],
      ['snapchat_native_action', 'snapchat_adsquad'],
      ['linkedin_native_action', 'linkedin_campaign'],
      ['meta_native_action', 'meta_campaign'],
    ],
  );
  for (const source of guidedReportSources)
    assert.equal(!source.guided?.allocation, !source.guided?.allocationDraft, source.platform);
  assert.deepEqual(
    Object.entries(drafts)
      .filter(([, entry]) => entry.draft.fallback)
      .map(([gw]) => gw),
    [gateway],
  );
  for (const entry of Object.values(drafts)) assert.ok(Object.isFrozen(entry.draft));
  // A binding that names no gateway is Google Ads', as before; any other keeps its own.
  assert.equal(allocationGateway({}), gateway);
  assert.equal(allocationGateway({gateway: null}), gateway);
  for (const gw of gateways.filter(Boolean)) assert.equal(allocationGateway({gateway: gw}), gw);
});

test('a preview qualifies exactly the gateway and preset pairs it did, after the writer check and before conversion', async () => {
  const events = [];
  const store = {assertActorActive: () => events.push('active')};
  for (const gw of gateways)
    for (const preset of presets) {
      const report = {gateway: gw, preset};
      await assert.rejects(
        previewAllocationPlan(store, undefined, actor, report, {conversion: 'period_total'}),
        legacyQualified(report)
          ? {code: 'ALLOCATION_CONVERSION_REQUIRED'}
          : {
              code: 'ALLOCATION_PLAN_UNQUALIFIED',
              message:
                'Native allocation drafts qualify Google dedicated campaign budgets, LinkedIn independent campaign daily budgets, Meta campaign or single-ad-set daily budgets and Snapchat ad-squad daily budgets. Other budget modes need their separate native planning flow.',
            },
        JSON.stringify(report),
      );
    }
  assert.equal(events.length, gateways.length * presets.length);
  await assert.rejects(
    previewAllocationPlan(store, undefined, {...actor, role: 'reader'}, {gateway: 'tiktok_native_action'}, {}),
    {code: 'FORBIDDEN'},
  );
});

test('each draft’s native update, wording, source fields and checks are the branches the plan held', () => {
  const now = Date.now();
  const targets = [
    {
      entity_id: '10',
      campaign_id: '10',
      budget_resource: 'customers/1234567890/campaignBudgets/7',
      budget_owner: 'campaign',
      daily_budget_micros: '50000000',
      daily_budget: '50',
      daily_budget_native: '5000',
    },
    {
      entity_id: '20',
      campaign_id: '20',
      adset_id: '2001',
      budget_resource: 'customers/1234567890/campaignBudgets/8',
      budget_owner: 'ad_set',
      daily_budget_micros: '1500000',
      daily_budget: '1.5',
      daily_budget_native: '150',
    },
    {campaign_id: '30', daily_budget_micros: '1', daily_budget: '0.000001', budget_owner: 'ad_set', adset_id: '3'},
  ];
  for (const gw of gateways)
    for (const preset of [...presets, undefined]) {
      const report = {
        gateway: gw,
        preset,
        source_request: {api_version: '202609', path_params: {campaign_id: 'parent-1'}},
      };
      const f = flags(report),
        qualified = legacyQualified(report);
      const binding = {
        ...(gw === undefined ? {} : {gateway: gw}),
        account_id: '100',
        connection_id: 'connection-1',
        currency: 'USD',
        report_id: 'report-1',
        model_fingerprint: 'model-1',
        period_days: 2,
        parent_campaign_id: 'parent-1',
        api_version: '202609',
        targets,
      };
      // A draft step's arguments, by the binding's gateway (bindings name only qualified gateways, or none).
      const plan = draftOf(binding.gateway),
        legacy = legacyDraft(binding, 'preview-1');
      binding.targets.forEach((t, i) =>
        assert.equal(
          JSON.stringify(plan.step(binding, t)),
          JSON.stringify(legacy.steps[i].arguments),
          String(gw) + ' step ' + i,
        ),
      );
      assert.equal(!plan.averageDaily, legacy.brief.includes('-day period. Daily budgets'), String(gw));
      if (!qualified) continue;
      // The preview's parts, by the qualified draft of the report.
      const preview = drafts[gw].draft;
      assert.equal(preview, plan);
      assert.deepEqual({...preview.source?.(report)}, legacySource(report, f), String(gw));
      assert.equal(preview.meaning, legacyMeaning(f, {gateway: report.gateway}), String(gw));
      for (const currency of ['USD', 'JPY', 'KWD', 'XAF', 'EUR'])
        assert.deepEqual(
          outcome(() => preview.minorUnits?.(currency)),
          outcome(() => legacyOffset(f, currency)),
          gw + ' ' + currency,
        );
      // Only LinkedIn's budget reader states daily budget limits (asserted below), so the limits the plan checked for
      // any reader's budgets are LinkedIn's draft's to check.
      for (const native of f.linkedin
        ? [
            {},
            {daily_budget_limits: {status: 'unavailable'}},
            {
              daily_budget_limits: {
                status: 'checked',
                min_micros: '10000000',
                max_micros: '100000000',
                min: '10',
                max: '100',
              },
            },
            {daily_budget_limits: {status: 'checked', min_micros: '10000000', max_micros: null, min: '10', max: null}},
          ]
        : [{}])
        for (const daily of [4999999n, 5000000n, 10000000n, 100000000n, 100000001n])
          for (const currency of ['USD', 'KWD'])
            assert.deepEqual(
              outcome(() =>
                preview.daily?.(daily, {entity_id: 'entity-1', currency, limits: native.daily_budget_limits}),
              ),
              outcome(() => legacyDaily(f, daily, {entity_id: 'entity-1'}, currency, native)),
              gw + ' ' + daily + ' ' + JSON.stringify(native),
            );
      for (const name of ['Native name', '', undefined])
        assert.equal(
          preview.name?.({campaign: {name}}) || 'Report name',
          legacyName(f, {campaign: {name}}, {name: 'Report name'}),
          gw + ' ' + name,
        );
    }
  for (const platform of ['google', 'meta', 'snapchat', 'linkedin'])
    assert.equal(
      fs
        .readFileSync(new URL('../src/' + platform + '-allocation-budgets.ts', import.meta.url), 'utf8')
        .includes('daily_budget_limits'),
      platform === 'linkedin',
      platform,
    );
  // LinkedIn's stored version: reused while reviewed, else the current one (a version read that moved with the draft).
  const linkedin = drafts.linkedin_native_action.draft;
  for (const api_version of ['202609', '202501', undefined, 7])
    assert.deepEqual(
      linkedin.source({source_request: {api_version}}),
      legacySource({source_request: {api_version}}, {linkedin: true}),
    );
  assert.deepEqual(linkedin.source({}), {api_version: linkedinStoredVersion(undefined, now)});
  // Snapchat's parent campaign: refused source changes, as sourceCurrent compared them.
  for (const gw of gateways)
    for (const report of [
      {source_request: {path_params: {campaign_id: 'parent-1'}}},
      {source_request: {path_params: {campaign_id: 'parent-2'}}},
      {source_request: {}},
      {},
    ])
      for (const parent_campaign_id of ['parent-1', undefined]) {
        const b = {gateway: gw, parent_campaign_id},
          selected = allocationGateway(b);
        assert.equal(
          !!draftOf(selected).sourceChanged?.(report, b),
          legacySourceChanged(selected, report, b),
          gw + JSON.stringify(report) + parent_campaign_id,
        );
      }
  assert.throws(() => drafts.snapchat_native_action.draft.source({}), TypeError);
  assert.throws(() => legacySource({}, {snap: true}), TypeError);
});

// ---- The plan's public functions over synthetic reports, with fake stores. ----
class Sentinel extends Error {}
// A store that answers the plan's own document reads and connection checks, and stops at any other call, recording
// each call (without the actor) in `events`.
const fakeStore = (documents, events) =>
  new Proxy(
    {},
    {
      get(_target, name) {
        if (name === 'then') return undefined;
        return (...args) => {
          events.push([name, ...args.filter(a => a !== actor)]);
          if (name === 'assertActorActive') return undefined;
          if (name === 'sessionIdentity') return undefined;
          if (name === 'document' && documents[args[1] + '/' + args[2]]) return documents[args[1] + '/' + args[2]];
          if (name === 'resolveConnection') return {id: args[3], scopes: []};
          throw new Sentinel(String(name));
        };
      },
    },
  );
const call = (...args) => {
  throw new Sentinel('call ' + JSON.stringify(args));
};
const modelOptions = ids => ({
  budget: '200',
  allocations: ids.map(entity_id => ({entity_id, minimum: '50', maximum: '150'})),
  efficiency_low: 0.8,
  efficiency_high: 1.2,
  minimum_conversions: 10,
  maximum_age_days: 7,
});
const linkedinDate = value => {
  const [year, month, day] = value.split('-').map(Number);
  return '(year:' + year + ',month:' + month + ',day:' + day + ')';
};
function platformReport(platform) {
  if (platform === 'snapchat') {
    const {report, options} = snapchatAllocationData();
    return {report, options, ids: snapchatAllocationIds};
  }
  const report = allocationReport();
  if (platform === 'google') Object.assign(report, {gateway, preset: 'google_campaign', account_id: '1234567890'});
  if (platform === 'linkedin') {
    const check = {
      source_request: {
        action: 'linkedin_rest_ad_accounts_ad_account_id_get',
        account_id: '100',
        connection_id: 'linkedin',
        path_params: {ad_account_id: '100'},
      },
      source_hash: 'a'.repeat(64),
    };
    Object.assign(report, {
      gateway: 'linkedin_native_action',
      preset: 'linkedin_campaign',
      connection_id: 'linkedin',
      source_collection: 'linkedin_analytics',
      source_request: {
        action: 'linkedin_rest_ad_analytics_get',
        account_id: '100',
        connection_id: 'linkedin',
        api_version: '202609',
        query: {
          pivot: 'CAMPAIGN',
          q: 'analytics',
          timeGranularity: 'DAILY',
          accounts: 'List(urn:li:sponsoredAccount:100)',
          dateRange:
            '(start:' +
            linkedinDate(report.semantics.date_from) +
            ',end:' +
            linkedinDate(report.semantics.date_to) +
            ')',
        },
      },
      mapping: {
        entity_id: '/pivotValues/0',
        date: {path: '/dateRange/start', format: 'linkedin_utc_date'},
        spend: '/costInLocalCurrency',
        conversions: '/externalWebsiteConversions',
      },
      native_account_evidence: {account_id: '100', currency: 'USD', checks: [check, structuredClone(check)]},
    });
    report.semantics.conversion_definition = 'externalWebsiteConversions';
    report.rows.forEach(r => (r.entity_id = 'urn:li:sponsoredCampaign:' + r.entity_id));
  }
  const ids = [...new Set(report.rows.map(r => r.entity_id))];
  return {report, options: modelOptions(ids), ids};
}
function bound(platform, {legacyBinding = false} = {}) {
  const {report, options, ids} = platformReport(platform);
  Object.assign(report, {id: 'report-' + platform, revision: 3});
  const modeled = reportAllocation(report, options),
    f = flags(report),
    targets = ids.map((entity_id, i) => ({
      entity_id,
      campaign_id: platform === 'linkedin' ? entity_id.split(':').pop() : entity_id,
      budget_resource: 'customers/1234567890/campaignBudgets/' + (i + 7),
      budget_owner: i === 1 ? 'ad_set' : 'campaign',
      adset_id: '200' + i,
      daily_budget_micros: String(50000000 + i * 1500000),
      daily_budget: String(50 + i * 1.5),
      daily_budget_native: String(5000 + i * 150),
      native_signature: 'signature-' + i,
    }));
  const binding = {
    ...(legacyBinding ? {} : {gateway: report.gateway}),
    account_id: report.account_id,
    connection_id: report.connection_id,
    currency: modeled.currency,
    timezone: modeled.semantics.timezone,
    ...legacySource(report, f),
    report_id: report.id,
    report_revision: report.revision,
    source_hash: report.source_hash,
    model_fingerprint: modeled.model_fingerprint,
    modeled_allocations_hash: fingerprint(modeled.allocations),
    options,
    period_days: modeled.period.days,
    conversion: 'equal_daily',
    targets,
  };
  const preview = {
    id: 'preview-' + platform,
    binding,
    preview_hash: fingerprint(binding),
    expires_at: Date.now() + 600000,
    user_id: actor.userId,
    session_id: null,
  };
  const documents = {
    ['allocation_preview/' + preview.id]: preview,
    ['decision_report/' + report.id]: report,
  };
  return {report, binding, preview, documents};
}
const platforms = [
  ['google', {}],
  ['google', {legacyBinding: true}],
  ['meta', {}],
  ['linkedin', {}],
  ['snapchat', {}],
];

test('a draft bound to its preview is the draft the plan wrote before, step for step', () => {
  for (const [platform, options] of platforms) {
    const label = platform + (options.legacyBinding ? ' (no gateway)' : '');
    const {binding, preview, documents, report} = bound(platform, options);
    const input = legacyDraft(binding, preview.id),
      events = [];
    assert.deepEqual(
      allocationCreationBinding(fakeStore(documents, events), actor, input, input.steps),
      {...binding, preview_id: preview.id},
      label,
    );
    assert.deepEqual(
      events.filter(e => e[0] === 'resolveConnection').map(e => e[1]),
      [binding.gateway ?? gateway],
      label,
    );
    // Any difference from the legacy draft is refused, as before.
    for (const change of [
      d => (d.brief += ' '),
      d => (d.steps[0].description += ' '),
      d => (d.steps[1].arguments = structuredClone(d.steps[0].arguments)),
      d => (d.steps[0].gateway = 'tiktok_native_action'),
      d => (d.steps[1].expected_currency = 'EUR'),
    ]) {
      const changed = structuredClone(input);
      change(changed);
      assert.throws(() => allocationCreationBinding(fakeStore(documents, []), actor, changed, changed.steps), {
        code: 'ALLOCATION_PLAN_CHANGED',
        message: 'The draft differs from the exact allocation preview.',
      });
    }
    // The source fields the binding keeps: a Snapchat report read under another parent campaign is refused.
    const moved = structuredClone(report);
    if (moved.source_request?.path_params) moved.source_request.path_params.campaign_id = snapchatAllocationIds[0];
    const movedDocuments = {...documents, ['decision_report/' + report.id]: moved},
      refused = legacySourceChanged(binding.gateway ?? gateway, moved, binding);
    assert.equal(refused, platform === 'snapchat', label);
    const result = outcome(() => allocationCreationBinding(fakeStore(movedDocuments, []), actor, input, input.steps));
    if (refused)
      assert.deepEqual(
        [result.code, result.message],
        ['ALLOCATION_SOURCE_CHANGED', 'The allocation source changed. Model and preview a new draft.'],
      );
    else assert.deepEqual(result.value, {...binding, preview_id: preview.id}, label);
  }
});

test('a proposal-derived step is checked against its legacy draft and reads its budget with the legacy reader', async () => {
  for (const [platform, options] of platforms) {
    const label = platform + (options.legacyBinding ? ' (no gateway)' : '');
    const {binding, preview, documents} = bound(platform, options);
    const allocation = {...binding, preview_id: preview.id},
      steps = legacyDraft(binding, preview.id).steps.map(s => ({...s, status: 'pending'})),
      run = {id: 'plan-' + platform, revision: 4, allocation, steps};
    for (const [index, step] of steps.entries()) {
      const events = [];
      await assert.rejects(assertAllocationStep(fakeStore(documents, events), call, actor, run, step), Sentinel);
      // The plan's source check, then the reader's own calls, which the legacy reader makes the same way.
      const reader = [];
      const target = binding.targets[index];
      await assert.rejects(
        legacyBudgets(fakeStore(documents, reader), call, actor, allocation, [target.entity_id ?? target.campaign_id]),
        Sentinel,
      );
      assert.deepEqual(events.slice(0, 2), [
        ['document', actor.tenantId, 'decision_report', binding.report_id],
        ['resolveConnection', binding.gateway ?? gateway, binding.account_id, binding.connection_id],
      ]);
      assert.deepEqual(events.slice(2), reader, label + ' step ' + index);
      assert.ok(reader.length > 0, label);
    }
    for (const change of [
      s => (s.arguments = {...s.arguments, extra: true}),
      s => (s.gateway = binding.gateway ? gateway + '_other' : 'meta_native_action'),
      s => (s.account_id = '999'),
      s => (s.connection_id = 'other'),
      s => (s.expected_currency = 'EUR'),
      s => (s.id = 'allocation-9'),
    ]) {
      const step = structuredClone(steps[0]);
      change(step);
      await assert.rejects(assertAllocationStep(fakeStore(documents, []), call, actor, run, step), {
        code: 'ALLOCATION_PLAN_CHANGED',
        message: 'This step no longer matches its allocation proposal. Create a new source-bound draft.',
      });
    }
    // A legacy binding's steps run under Google Ads, as before; an executing step is not checked again.
    assert.equal(
      await assertAllocationStep(fakeStore({}, []), call, actor, run, {...steps[0], status: 'executing'}),
      undefined,
    );
  }
});

test('a preview binds each platform’s source fields and refuses an unpinned Meta currency before any read', async () => {
  for (const [platform] of platforms.filter(([, o]) => !o.legacyBinding)) {
    const {report, documents} = bound(platform);
    const {options} = platformReport(platform),
      f = flags(report),
      events = [];
    await assert.rejects(
      previewAllocationPlan(fakeStore(documents, events), call, actor, report, {conversion: 'equal_daily', options}),
      Sentinel,
    );
    // The writer check, then the legacy reader's calls with the legacy source (the reader sees its fields).
    const modeled = reportAllocation(report, options),
      source = {
        gateway: report.gateway,
        account_id: report.account_id,
        connection_id: report.connection_id,
        currency: modeled.currency,
        timezone: modeled.semantics.timezone,
        ...legacySource(report, f),
      },
      reader = [];
    await assert.rejects(
      legacyBudgets(
        fakeStore(documents, reader),
        call,
        actor,
        source,
        modeled.allocations.map(r => r.entity_id),
        true,
        {since: modeled.semantics.date_from, until: modeled.semantics.date_to},
      ),
      Sentinel,
    );
    assert.deepEqual(events, [['assertActorActive'], ...reader], platform);
  }
  // Meta counts budgets in pinned minor units: a currency without a pinned offset is refused before any read.
  const {report, documents} = bound('meta');
  report.semantics.currency = 'KWD';
  const {options} = platformReport('meta'),
    events = [];
  await assert.rejects(
    previewAllocationPlan(fakeStore(documents, events), call, actor, report, {conversion: 'equal_daily', options}),
    {
      code: 'ALLOCATION_PRECISION',
      message:
        'Meta budgets count in the account currency’s minor unit, and AMCP has no pinned Meta offset for this currency. Pin Meta’s currency table before converting an allocation; nothing was read or saved.',
      details: {currency: 'KWD'},
    },
  );
  assert.deepEqual(events, [['assertActorActive']]);
});
