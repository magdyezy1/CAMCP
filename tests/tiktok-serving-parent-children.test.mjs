import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {spendConfirmationError} from '../dist/src/preflight.js';
import {effectClass} from '../dist/src/effect-class.js';
import {validatePausedParents} from '../dist/src/paused-parents.js';
import {providerOf} from '../dist/src/provider-adapters.js';
import {providerHooks} from '../dist/src/provider-hooks.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {advertiserWorld} from './helpers/tiktok-advertiser-noise.mjs';
import {standardBodies, standardCreates} from './helpers/tiktok-standard-creates.mjs';

/**
 * R2.5 M4, package r25-m4-smartops, item 2: Q1 (owner 2026-11-15) for TikTok's children, the lead's design (b) of QUESTIONS L5. A TikTok
 * ad group or ad, standard or Upgraded Smart+, may be created ENABLE under parents the review reads as serving, with spend_change_confirmed
 * at execute and the owner's allow_activation not forbidding it. Until now it was refused (PARENT_SERVING) with or without the flag.
 *
 * What holds, and is proven below: a parent the review could not read still refuses (`parent_unread`); under a paused parent ENABLE still
 * needs no flag (Q14); the stateless Q14 exemption is unchanged, so the spend flag comes from the review's state, at prepare (where
 * `execute_requirements` names it and the effect class is `spend_affecting`) and at execute (refused without it, sent once with it); a
 * parent that starts serving between prepare and execute sends nothing without the flag; campaigns are created paused only; allow_activation
 * false refuses; Snapchat and Meta children under serving parents are still PARENT_SERVING (their levels have no option: M9, M13). Nothing
 * can serve on the test account, so live check M4 LV-26 cannot run: these fixtures and the property test (SPLIT join J-5) are the proof.
 */
const gateway = 'tiktok_native_action';
const status = value => p => ({...p, operation_status: value});
const creativeStatus = value => p => ({...p, creatives: [{...p.creatives[0], operation_status: value}]});

/** A synthetic Smart+ world: campaign 80, its CLICK ad group 300 (with an ENABLE ad already in it), the identity, post and CTA portfolio. */
function smartPlusWorld(tenant) {
  const actor = {tenantId: tenant, userId: 'operator', role: 'operator'},
    owner = {...actor, userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 86).toString('base64')),
    account = '123',
    connection = 'login';
  store.putConnection(
    owner,
    {
      id: connection,
      tenantId: tenant,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const world = {
    campaign: {
      campaign_id: '80',
      campaign_name: 'Web',
      objective_type: 'WEB_CONVERSIONS',
      sales_destination: 'WEBSITE',
      budget_optimize_on: true,
      budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
      budget: 500,
      operation_status: 'DISABLE',
      catalog_enabled: false,
      is_search_campaign: false,
    },
    group: {
      adgroup_id: '300',
      campaign_id: '80',
      adgroup_name: 'Existing group',
      promotion_type: 'WEBSITE',
      optimization_goal: 'CLICK',
      billing_event: 'CPC',
      placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
      operation_status: 'DISABLE',
    },
  };
  const sent = [];
  let n = 0;
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const list = rows => ok({list: rows, page_info: {page: 1, page_size: 100, total_number: rows.length, total_page: 1}});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET',
      q = k => url.searchParams.get(k);
    if (method === 'GET' && path === '/v1.3/advertiser/info/')
      return ok({list: [{advertiser_id: account, name: 'Synthetic', currency: 'USD', timezone: 'Etc/GMT'}]});
    if (method === 'GET' && path === '/v1.3/smart_plus/campaign/get/')
      return list(JSON.parse(q('filtering')).campaign_ids.includes('80') ? [structuredClone(world.campaign)] : []);
    if (method === 'GET' && path === '/v1.3/smart_plus/adgroup/get/')
      return list(JSON.parse(q('filtering')).adgroup_ids?.includes('300') ? [structuredClone(world.group)] : []);
    if (method === 'GET' && path === '/v1.3/smart_plus/ad/get/')
      return list([{smart_plus_ad_id: '4000', adgroup_id: '300', campaign_id: '80', operation_status: 'ENABLE'}]);
    if (method === 'GET' && path === '/v1.3/identity/info/')
      return ok({
        identity_info: {
          identity_id: q('identity_id'),
          identity_type: q('identity_type'),
          available_status: 'AVAILABLE',
          can_pull_video: true,
          is_gpppa: false,
        },
      });
    if (method === 'GET' && path === '/v1.3/identity/video/info/')
      return ok({video_details: JSON.parse(q('item_ids')).map(id => ({item_id: id, item_type: 'VIDEO'}))});
    if (method === 'GET' && path === '/v1.3/creative/portfolio/get/')
      return ok({portfolio_content: [{asset_ids: ['201781'], asset_content: 'learn_more'}]});
    if (method === 'POST' && path === '/v1.3/smart_plus/adgroup/create/') {
      sent.push({path, body: JSON.parse(init.body)});
      return ok({adgroup_id: '9100000000000201'});
    }
    if (method === 'POST' && path === '/v1.3/smart_plus/ad/create/') {
      sent.push({path, body: JSON.parse(init.body)});
      return ok({smart_plus_ad_id: '5001'});
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const call = (tool, input) => service.call(tool, input, actor);
  return {store, owner, world, sent, call, account, connection};
}
const smartPlusAdgroup = child => ({
  request_id: '810200300402',
  campaign_id: '80',
  operation_status: child,
  adgroup_name: 'Smart+ visits',
  promotion_type: 'WEBSITE',
  optimization_goal: 'CLICK',
  bid_type: 'BID_TYPE_NO_BID',
  billing_event: 'CPC',
  targeting_optimization_mode: 'AUTOMATIC',
  targeting_spec: {location_ids: ['102358'], spc_audience_age: 'OVER_EIGHTEEN', languages: ['ar']},
  schedule_type: 'SCHEDULE_FROM_NOW',
  schedule_start_time: '2026-12-01 00:00:00',
});
const smartPlusAd = child => ({
  adgroup_id: '300',
  ad_name: 'Spark visit',
  operation_status: child,
  creative_list: [
    {creative_info: {ad_format: 'SINGLE_VIDEO', tiktok_item_id: '9001', identity_type: 'TT_USER', identity_id: 'tt-1'}},
  ],
  landing_page_url_list: [{landing_page_url: 'https://shop.example.test/visit'}],
  ad_configuration: {
    call_to_action_id: '700',
    creative_auto_add_toggle: false,
    creative_auto_enhancement_strategy_list: [],
  },
});
/** A status as a test names it: DISABLE, ENABLE, or `unread` for a row whose status the review cannot read (left out of the row). */
const value = s => (s === 'unread' ? undefined : s);
const setStatus = (row, s) => {
  if (value(s) === undefined) delete row.operation_status;
  else row.operation_status = s;
};

/**
 * The four TikTok child kinds, each over a fresh synthetic advertiser. `kinds[kind](parent, campaign)` sets the parent's status and, for an
 * ad, the status of the campaign above its ad group (ENABLE unless given, so that it does not cover the ad); `prepare(child)` prepares the
 * create with that status.
 */
const kinds = {
  'standard ad group': parent => {
    const f = standardCreates(advertiserWorld({rotating: false, honourFields: false}), {tenant: 'serving-standard'});
    f.parents.campaign = value(parent);
    return {
      parent: 'campaign',
      prepare: child => f.prepare('adgroup', status(child)),
      execute: (review, flags) => f.execute(review, flags),
      writes: () => f.sent.length,
      policy: rules => saveSpendPolicy(f.store, f.owner, {scope: 'workspace', confirmed: true, policy: rules}),
      close: () => f.close(),
      f,
    };
  },
  'standard ad': (parent, campaign = 'ENABLE') => {
    const f = standardCreates(advertiserWorld({rotating: false, honourFields: false}), {tenant: 'serving-standard'});
    f.parents.adgroup = value(parent);
    f.parents.campaign = value(campaign);
    return {
      parent: 'ad group',
      prepare: child => f.prepare('ad', creativeStatus(child)),
      execute: (review, flags) => f.execute(review, flags),
      writes: () => f.sent.length,
      policy: rules => saveSpendPolicy(f.store, f.owner, {scope: 'workspace', confirmed: true, policy: rules}),
      close: () => f.close(),
      f,
    };
  },
  'Smart+ ad group': parent => smartPlusKind(parent, undefined, 'tiktok_smart_plus_adgroup_create', smartPlusAdgroup),
  'Smart+ ad': (parent, campaign = 'ENABLE') =>
    smartPlusKind(parent, campaign, 'tiktok_smart_plus_ad_create', smartPlusAd),
};
function smartPlusKind(parent, campaign, action, body) {
  const w = smartPlusWorld('serving-smart-plus');
  const group = action === 'tiktok_smart_plus_ad_create';
  setStatus(group ? w.world.group : w.world.campaign, parent);
  if (group) setStatus(w.world.campaign, campaign);
  return {
    parent: group ? 'Smart+ ad group' : 'Smart+ campaign',
    prepare: child =>
      w.call('amcp_write', {
        action: 'prepare',
        gateway,
        connection_id: w.connection,
        arguments: {action, account_id: w.account, payload: body(child)},
      }),
    execute: (review, flags) =>
      w.call('amcp_write', {
        action: 'execute',
        review_id: review.review_id,
        idempotency_key: review.idempotency_key,
        confirmed: true,
        ...flags,
      }),
    writes: () => w.sent.length,
    policy: rules => saveSpendPolicy(w.store, w.owner, {scope: 'workspace', confirmed: true, policy: rules}),
    close: () => w.store.close(),
    w,
  };
}

/**
 * One case of the rule (SPLIT join J-5), observed through the real review lifecycle: what the prepare and execute of the create do. A
 * refused prepare is `refused_unread` (PARENT_SERVING naming an unread parent), `refused_serving` (PARENT_SERVING under parents read
 * serving: what Q1 removes) or `refused_policy` (the owner's allow_activation). A prepared review asks for the flag (`flag`: refused at
 * execute without it, sent once with it) or does not (`no_flag`: sent once without it). Nothing is sent by any refusal.
 */
async function checkCase(kind, parent, child, forbid, campaign) {
  const what =
    kind +
    ' ' +
    child +
    ' under ' +
    parent +
    (campaign ? ' (campaign ' + campaign + ')' : '') +
    (forbid ? ', allow_activation false' : '');
  const k = kinds[kind](parent, campaign);
  try {
    if (forbid) k.policy({allow_activation: false});
    const prepared = await k.prepare(child);
    if (!prepared.success) {
      if (prepared.error?.code === 'PARENT_SERVING') {
        assertRefused(prepared, 'PARENT_SERVING', {writes: k.writes});
        assert.equal(prepared.error.details.parent, k.parent, what);
        return prepared.error.details.parent_unread === true ? 'refused_unread' : 'refused_serving';
      }
      assertRefused(prepared, 'POLICY_ACTIVATION_FORBIDDEN', {writes: k.writes});
      return 'refused_policy';
    }
    const review = prepared.data,
      serving = review.execute_requirements.spend_change_confirmed === true;
    assert.equal(review.effect, serving ? 'spend_affecting' : 'config_write', what);
    if (serving) {
      assert.ok(
        review.execute_requirements.reasons.some(
          r => r.flag === 'spend_change_confirmed' && /under a parent the review reads as serving/.test(r.reason),
        ),
        what + ': ' + JSON.stringify(review.execute_requirements.reasons),
      );
      // The review discloses it: the child may affect serving at once.
      assert.equal(review.creative_impact?.may_affect_serving, true, what);
      assert.match(review.creative_impact.effect, /starts serving at once/, what);
      const refused = await k.execute(review, {});
      assertRefused(refused, 'SPEND_CONFIRMATION_REQUIRED', {writes: k.writes});
      assert.equal(refused.error.details.parent, k.parent, what);
      assert.equal(refused.error.details.parent_status, 'ENABLE', what);
      const done = await k.execute(review, {spend_change_confirmed: true});
      assert.equal(done.success, true, what + ': ' + JSON.stringify(done.error ?? done).slice(0, 600));
      assert.equal(k.writes(), 1, what);
      return 'flag';
    }
    if (review.creative_impact) assert.equal(review.creative_impact.may_affect_serving, false, what);
    const done = await k.execute(review, {});
    assert.equal(done.success, true, what + ': ' + JSON.stringify(done.error ?? done).slice(0, 600));
    assert.equal(k.writes(), 1, what);
    return 'no_flag';
  } finally {
    k.close();
  }
}

/**
 * The rule (SPLIT join J-5): a DISABLE child never asks; an ENABLE child is refused under a parent the review could not read, refused by
 * allow_activation false, asks for nothing under a parent read DISABLE (Q14), and asks for the flag under parents read ENABLE (Q1).
 */
const rule = (parent, child, forbid) =>
  child === 'DISABLE'
    ? 'no_flag'
    : parent === 'unread'
      ? 'refused_unread'
      : forbid
        ? 'refused_policy'
        : parent === 'DISABLE'
          ? 'no_flag'
          : 'flag';

test('property (J-5): over parent × child × flag × allow_activation, for the four TikTok child kinds, the flag is asked iff the child starts ENABLE under serving parents, and refused iff unread or forbidden', async () => {
  const seen = {};
  for (const kind of Object.keys(kinds))
    for (const parent of ['DISABLE', 'ENABLE', 'unread'])
      for (const child of ['DISABLE', 'ENABLE'])
        for (const forbid of [false, true]) {
          const outcome = await checkCase(kind, parent, child, forbid);
          assert.equal(
            outcome,
            rule(parent, child, forbid),
            kind + ' ' + child + ' under ' + parent + (forbid ? ' forbidden' : ''),
          );
          seen[outcome] = (seen[outcome] ?? 0) + 1;
        }
  // Each outcome occurs, for each of the four kinds: 7 without the flag, 2 unread, 2 forbidden and 1 that asks.
  assert.deepEqual(seen, {no_flag: 28, refused_unread: 8, refused_policy: 8, flag: 4});
});

test('property (J-5): an ENABLE ad under a serving ad group is covered by a paused campaign, asks for the flag under a serving one, and is refused under an unread one', async () => {
  for (const kind of ['standard ad', 'Smart+ ad'])
    for (const campaign of ['DISABLE', 'ENABLE', 'unread'])
      for (const forbid of [false, true]) {
        const outcome = await checkCase(kind, 'ENABLE', 'ENABLE', forbid, campaign);
        assert.equal(
          outcome,
          rule(campaign, 'ENABLE', forbid),
          kind + ' under campaign ' + campaign + (forbid ? ' forbidden' : ''),
        );
      }
});

test('giving spend_change_confirmed to a create that does not need it changes nothing: it is sent once', async () => {
  for (const kind of Object.keys(kinds)) {
    const k = kinds[kind]('DISABLE');
    try {
      const prepared = await k.prepare('ENABLE');
      assert.equal(prepared.success, true, kind + ': ' + JSON.stringify(prepared.error ?? prepared).slice(0, 400));
      assert.equal(prepared.data.execute_requirements.spend_change_confirmed, false, kind);
      const done = await k.execute(prepared.data, {spend_change_confirmed: true});
      assert.equal(done.success, true, kind + ': ' + JSON.stringify(done.error ?? done).slice(0, 400));
      assert.equal(k.writes(), 1, kind);
    } finally {
      k.close();
    }
  }
});

test('a child prepared under a paused parent is not sent once the parent serves, flag or none; prepared again, it asks for the flag', async () => {
  for (const kind of Object.keys(kinds))
    for (const flags of [{}, {spend_change_confirmed: true}]) {
      const k = kinds[kind]('DISABLE');
      try {
        const prepared = await k.prepare('ENABLE');
        assert.equal(prepared.success, true, kind + ': ' + JSON.stringify(prepared.error ?? prepared).slice(0, 400));
        assert.equal(prepared.data.execute_requirements.spend_change_confirmed, false);
        if (k.f) {
          if (kind === 'standard ad') k.f.parents.adgroup = 'ENABLE';
          else k.f.parents.campaign = 'ENABLE';
        } else setStatus(kind === 'Smart+ ad' ? k.w.world.group : k.w.world.campaign, 'ENABLE');
        assertRefused(await k.execute(prepared.data, flags), ['STATE_CHANGED', 'SPEND_CONFIRMATION_REQUIRED'], {
          writes: k.writes,
        });
        const again = await k.prepare('ENABLE');
        assert.equal(again.success, true, kind + ': ' + JSON.stringify(again.error ?? again).slice(0, 400));
        assert.equal(again.data.execute_requirements.spend_change_confirmed, true, kind);
        assert.equal(k.writes(), 0, kind);
      } finally {
        k.close();
      }
    }
});

test('campaigns are still created paused only (Q1): an ENABLE standard or Smart+ campaign is refused before any request', async () => {
  const f = standardCreates(advertiserWorld({rotating: false}), {tenant: 'serving-campaigns'});
  try {
    assertRefused(await f.prepare('campaign', status('ENABLE')), 'PAUSED_CREATION_REQUIRED', {
      writes: () => f.sent.length,
    });
  } finally {
    f.close();
  }
  const w = smartPlusWorld('serving-campaigns');
  try {
    const r = await w.call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: w.connection,
      arguments: {
        action: 'tiktok_smart_plus_campaign_create',
        account_id: w.account,
        payload: {
          request_id: '810200300403',
          operation_status: 'ENABLE',
          objective_type: 'WEB_CONVERSIONS',
          sales_destination: 'WEBSITE',
          campaign_name: 'Smart+ visits',
          budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
          budget: 100,
        },
      },
    });
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN', {writes: () => w.sent.length});
    assert.equal(r.error.details.field, 'operation_status');
  } finally {
    w.store.close();
  }
});

const compiler = new Compiler(new Registry());
const compile = (gw, action, payload, extra = {}) =>
  applyExecutionRisk(
    compiler.compile(gw, {action, account_id: '123', payload, dry_run: true, ...extra}, {mode: 'strict', flags: {}}),
  );
const tiktokState = rows => [{data: {list: rows, page_info: {page: 1, total_page: 1, total_number: rows.length}}}];

test('the flag comes from the review’s state alone: a bare plan keeps the stateless Q14 exemption, a serving state asks, a paused one does not', () => {
  const {action, payload} = standardBodies('123').adgroup;
  const plan = compile(gateway, action, {...payload, operation_status: 'ENABLE'});
  // No state (inspect, a plan's approval): unchanged, as design (b) keeps the exemption.
  assert.equal(spendConfirmationError(plan), undefined);
  assert.equal(effectClass(plan), 'config_write');
  const serving = tiktokState([{campaign_id: '300', operation_status: 'ENABLE'}]),
    paused = tiktokState([{campaign_id: '300', operation_status: 'DISABLE'}]),
    unread = tiktokState([{campaign_id: '300'}]);
  const asked = spendConfirmationError(plan, serving);
  assertRefused(asked, 'SPEND_CONFIRMATION_REQUIRED');
  assert.deepEqual(asked.details, {parent: 'campaign', parent_status: 'ENABLE'});
  assert.equal(effectClass(plan, serving), 'spend_affecting');
  assert.equal(spendConfirmationError(plan, paused), undefined);
  assert.equal(effectClass(plan, paused), 'config_write');
  // An unread parent asks for nothing here: the paused-parent check refuses it first, and says why.
  assert.equal(spendConfirmationError(plan, unread), undefined);
  assert.throws(
    () => validatePausedParents(plan, unread),
    e => assertRefused(e, 'PARENT_SERVING') && e.details.parent_unread === true && e.details.parent_status === null,
  );
  assert.doesNotThrow(() => validatePausedParents(plan, serving));
  // A DISABLE child never asks, whatever the parent.
  const off = compile(gateway, action, payload);
  assert.equal(spendConfirmationError(off, serving), undefined);
  // A campaign status of its own spelling is no serving parent: it fails closed, refused as unread.
  assert.throws(
    () => validatePausedParents(plan, tiktokState([{campaign_id: '300', operation_status: 'DELETE'}])),
    e => assertRefused(e, 'PARENT_SERVING') && e.details.parent_unread === true,
  );
});

test('only TikTok’s levels confirm a serving parent, and TikTok declares the hook that asks for the flag; Snapchat and Meta still refuse', () => {
  const tiktokLevels = [
    compile(gateway, 'tiktok_adgroup_create', {...standardBodies('123').adgroup.payload, operation_status: 'ENABLE'}),
    compile(gateway, 'tiktok_ad_create', creativeStatus('ENABLE')(standardBodies('123').ad.payload)),
    compile(gateway, 'tiktok_smart_plus_adgroup_create', smartPlusAdgroup('ENABLE')),
    compile(gateway, 'tiktok_smart_plus_ad_create', smartPlusAd('ENABLE')),
  ];
  for (const plan of tiktokLevels) assert.equal(providerOf(gateway).pausedParents(plan)?.serving, 'confirm', plan.path);
  assert.equal(typeof providerHooks(gateway).writes.activatesUnderServingParent, 'function');
  // Meta's ad set and Snapchat's ad squad under a serving campaign: PARENT_SERVING as before, with no parent_unread and no option.
  const request = (gw, path, body) => ({
    gateway: gw,
    accountId: '1',
    action: 'reviewed_write',
    method: 'POST',
    path,
    query: {},
    body,
  });
  const adset = request('meta_native_action', '/v24.0/act_1/adsets', {status: 'ACTIVE', campaign_id: '7'});
  assert.equal(providerOf('meta_native_action').pausedParents(adset)?.serving, undefined);
  assert.throws(
    () => validatePausedParents(adset, [{id: '7', status: 'ACTIVE'}]),
    e =>
      assertRefused(e, 'PARENT_SERVING') &&
      e.details.parent_unread === undefined &&
      e.details.parent_status === 'ACTIVE',
  );
  // Neither declares the hook: nothing of Q1 reaches their spend rule either.
  for (const gw of ['meta_native_action', 'snapchat_native_action'])
    assert.equal(providerHooks(gw)?.writes?.activatesUnderServingParent, undefined, gw);
  const squad = request('snapchat_native_action', '/v1/campaigns/300/adsquads', {
    adsquads: [{campaign_id: '300', status: 'ACTIVE'}],
  });
  const level = providerOf('snapchat_native_action').pausedParents(squad);
  assert.ok(level, 'Snapchat’s ad squad is a level');
  assert.equal(level.serving, undefined);
  assert.throws(
    () =>
      validatePausedParents(squad, [
        {campaigns: [{sub_request_status: 'SUCCESS', campaign: {id: '300', status: 'ACTIVE'}}]},
      ]),
    e => assertRefused(e, 'PARENT_SERVING') && e.details.parent_unread === undefined,
  );
});

test('a plan step that creates an ENABLE ad group under a serving campaign stops its run once for the flag, and is sent once with it (Plan Q1)', async () => {
  const f = standardCreates(advertiserWorld({rotating: false, honourFields: false}), {tenant: 'serving-plan'});
  try {
    f.parents.campaign = 'ENABLE';
    const {action, payload} = standardBodies(f.world.id).adgroup;
    const created = await f.plan({
      action: 'create',
      name: 'Synthetic live ad group',
      brief: 'One ENABLE ad group under a serving campaign.',
      steps: [
        {
          id: 'group',
          kind: 'write',
          gateway,
          connection_id: 'login',
          account_id: f.world.id,
          description: 'Create the ad group enabled',
          arguments: {action, payload: {...payload, operation_status: 'ENABLE'}},
        },
      ],
    });
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 1200));
    const id = created.data.id,
      preview = await f.plan({action: 'approve', id});
    // The approval reads no state, so it lists no spend for the step (design (b): recipe approvals stay as clean as today).
    const approved = await f.plan({
      action: 'approve',
      id,
      confirmed: true,
      plan_hash: preview.data.plan_hash,
      summary_hash: preview.data.summary_hash,
    });
    assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 1200));
    const stopped = await f.plan({action: 'run', id});
    assert.equal(stopped.data?.run?.stopped, 'needs_spend_change_confirmed', JSON.stringify(stopped).slice(0, 1200));
    assert.equal(f.sent.length, 0, 'nothing is sent without the flag');
    const review = stopped.data.review;
    assert.equal(review.execute_requirements.spend_change_confirmed, true);
    const done = await f.plan({
      action: 'execute_next',
      id,
      review_id: review.review_id,
      idempotency_key: review.idempotency_key,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].body.operation_status, 'ENABLE');
  } finally {
    f.close();
  }
});
