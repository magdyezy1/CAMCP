import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {approveReview} from '../dist/src/write-approval.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {familyOf} from '../dist/src/reviewed-families.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * r25-m4-smartdelete (owner O3, 2026-11-20: "add delete function to AMCP"): deleting Upgraded Smart+ campaigns, ad groups
 * and ads through `operation_status: DELETE` on the three Smart+ status routes, the reviewed destructive family
 * tiktok_smart_plus_deletions (QUESTIONS L11-L13). TikTok's answers follow the 2026-09-26 record of its "Update the
 * operation statuses of Upgraded Smart+ Campaigns / Ad Groups / Ads" pages: campaign and ad group calls list per-ID
 * successes (`campaign_list`, `adgroup_list`) and errors (`error_list`); ad calls return `smart_plus_ad_ids` and one
 * `status`. How TikTok shows a deleted Smart+ row is unverified (live check M4 LV-29), so the fixture can hide it, list it
 * with `operation_status: DELETE`, or list it with a `*_DELETE` secondary status. Every ID is synthetic; nothing
 * contacts TikTok.
 */
const TIKTOK = '37373737-3737-4373-8373-373737373737',
  gateway = 'tiktok_native_action',
  account = '123';
const actor = {tenantId: 'tiktok-smart-plus-deletions', userId: 'operator', role: 'operator'},
  colleague = {...actor, userId: 'colleague'},
  owner = {...actor, userId: 'owner', role: 'admin'},
  key = Buffer.alloc(32, 79).toString('base64');
const kinds = {
  campaign: ['campaign_ids', 'campaign_id', 'campaign_name'],
  adgroup: ['adgroup_ids', 'adgroup_id', 'adgroup_name'],
  ad: ['smart_plus_ad_ids', 'smart_plus_ad_id', 'ad_name'],
};
const secondary = {campaign: 'CAMPAIGN_STATUS_DELETE', adgroup: 'ADGROUP_STATUS_DELETE', ad: 'AD_STATUS_DELETE'};
/**
 * A paused campaign 100 with two ad groups (200 enabled, 201 paused) and three ads (300 enabled, 301 paused, 302 frozen);
 * an enabled campaign 101 with one ad group and ad; a paused campaign 102 with nothing under it.
 *
 * `deleted` is how a deleted row reads back: 'hidden' (left out of every read), 'listed' (listed with
 * operation_status DELETE) or 'secondary' (listed with its *_DELETE secondary status, operation_status unchanged).
 * `reply` breaks the receipt: 'missing' leaves the last ID out, 'error_list' reports it in error_list, 'status' answers
 * an ad deletion with another status, 'error' is TikTok's 40002 with no data, 'lost' loses the answer after applying.
 * `mode` breaks the reads: 'paged' gives child reads a second page, 'foreign' adds a row of another campaign to the ad
 * group read, 'ignored' accepts the deletion without applying it, 'adsWithoutCampaign' leaves campaign_id out of ads.
 */
function fixture({deleted = 'hidden', reply = '', mode = ''} = {}) {
  const store = new Store(':memory:', key);
  store.putConnection(
    owner,
    {
      id: TIKTOK,
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const campaign = (id, name, status) => [
    id,
    {campaign_id: id, campaign_name: name, operation_status: status, secondary_status: 'CAMPAIGN_STATUS_' + status},
  ];
  const adgroup = (id, campaignId, name, status) => [
    id,
    {adgroup_id: id, campaign_id: campaignId, adgroup_name: name, operation_status: status},
  ];
  const ad = (id, adgroupId, campaignId, name, status) => [
    id,
    {smart_plus_ad_id: id, adgroup_id: adgroupId, campaign_id: campaignId, ad_name: name, operation_status: status},
  ];
  // TikTok filters by campaign whether or not its ad rows show the campaign: 'adsWithoutCampaign' leaves it out of answers.
  const shown = (k, r) => {
    if (mode !== 'adsWithoutCampaign' || k !== 'ad') return r;
    const {campaign_id: _campaign, ...rest} = r;
    return rest;
  };
  const rows = {
    campaign: new Map([
      campaign('100', 'Smart+ web DNU', 'DISABLE'),
      campaign('101', 'Smart+ live', 'ENABLE'),
      campaign('102', 'Smart+ empty DNU', 'DISABLE'),
    ]),
    adgroup: new Map([
      adgroup('200', '100', 'Group A', 'ENABLE'),
      adgroup('201', '100', 'Group B', 'DISABLE'),
      adgroup('210', '101', 'Group C', 'ENABLE'),
    ]),
    ad: new Map([
      ad('300', '200', '100', 'Ad A', 'ENABLE'),
      ad('301', '200', '100', 'Ad B', 'DISABLE'),
      ad('302', '201', '100', 'Ad C', 'FROZEN'),
      ad('310', '210', '101', 'Ad D', 'ENABLE'),
    ]),
  };
  const gone = new Set(),
    requests = [],
    writes = [];
  let n = 0,
    lose = reply === 'lost';
  const ok = data => Response.json({code: 0, message: 'OK', request_id: 'r' + ++n, data});
  const transport = new NativeTransport(async (raw, init = {}) => {
    const url = new URL(String(raw)),
      path = url.pathname.replace(/^\/open_api/, ''),
      method = init.method ?? 'GET';
    requests.push(method + ' ' + path + (url.search ? ' ' + decodeURIComponent(url.search) : ''));
    const get = /^\/v1\.3\/smart_plus\/(campaign|adgroup|ad)\/get\/$/.exec(path),
      set = /^\/v1\.3\/smart_plus\/(campaign|adgroup|ad)\/status\/update\/$/.exec(path);
    if (method === 'GET' && get) {
      const k = get[1],
        filtering = JSON.parse(url.searchParams.get('filtering') ?? '{}');
      const list = [...rows[k].values()]
        .filter(r =>
          Object.entries(kinds).every(
            ([, [field, id]]) => !filtering[field] || filtering[field].includes(String(r[id] ?? '')),
          ),
        )
        .filter(r => !gone.has(k + r[kinds[k][1]]) || deleted !== 'hidden')
        .map(r =>
          shown(
            k,
            gone.has(k + r[kinds[k][1]])
              ? deleted === 'listed'
                ? {...r, operation_status: 'DELETE'}
                : {...r, secondary_status: secondary[k]}
              : structuredClone(r),
          ),
        );
      if (mode === 'foreign' && k === 'adgroup' && filtering.campaign_ids)
        list.push({adgroup_id: '290', campaign_id: '999', adgroup_name: 'Elsewhere', operation_status: 'ENABLE'});
      const pages = mode === 'paged' && !filtering[kinds[k][0]] ? 2 : 1;
      return ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: pages}});
    }
    if (method === 'POST' && set) {
      const k = set[1],
        b = JSON.parse(init.body),
        list = b[kinds[k][0]];
      writes.push({kind: k, body: b});
      if (mode !== 'ignored' && reply !== 'error')
        for (const id of list)
          if (b.operation_status === 'DELETE') gone.add(k + id);
          else rows[k].set(id, {...rows[k].get(id), operation_status: b.operation_status});
      if (lose) throw new Error('Synthetic accepted response lost');
      if (reply === 'error')
        return Response.json({code: 40002, message: 'Synthetic refusal', request_id: 'r' + ++n, data: {}});
      const failed = ['missing', 'error_list'].includes(reply) ? list.slice(-1) : [];
      if (k === 'ad')
        return ok({
          smart_plus_ad_ids: list.filter(id => !failed.includes(id)),
          status: reply === 'status' ? 'DISABLE' : b.operation_status,
        });
      return ok({
        [k + '_list']: list
          .filter(id => !failed.includes(id))
          .map(id => ({[kinds[k][1]]: id, status: b.operation_status})),
        error_list: reply === 'error_list' ? failed.map(id => ({[kinds[k][1]]: id, error_message: 'Synthetic'})) : [],
      });
    }
    throw new Error('Unexpected TikTok request ' + method + ' ' + path);
  });
  const start = () =>
    new MirrorService(new Registry(), store, transport, undefined, {
      allowWrites: true,
      requireBeforeState: true,
      maxBudgetChange: 0,
    });
  let service = start();
  const call = (tool, input, as = actor) => service.call(tool, input, as);
  const args = (kind, list, payload) => ({
    action: 'tiktok_smart_plus_' + kind + '_status_update',
    account_id: account,
    payload: payload ?? {[kinds[kind][0]]: list, operation_status: 'DELETE'},
  });
  const prepare = (kind, list, payload) =>
    call('amcp_write', {action: 'prepare', gateway, connection_id: TIKTOK, arguments: args(kind, list, payload)});
  const execute = (id, extra = {}) =>
    call('amcp_write', {action: 'execute', review_id: id, idempotency_key: id, confirmed: true, ...extra});
  const verify = id => call('amcp_campaign', {action: 'verify', review_id: id});
  const policy = p =>
    saveSpendPolicy(store, owner, {gateway, account_id: account, connection_id: TIKTOK, confirmed: true, policy: p});
  return {
    store,
    rows,
    gone,
    requests,
    writes,
    call,
    args,
    prepare,
    execute,
    verify,
    policy,
    found: () => {
      lose = false;
    },
    restart: () => {
      service = start();
    },
  };
}
const reads = f => f.requests.filter(r => r.startsWith('GET '));

test('a DELETE on each Smart+ status route inspects as a reviewed destructive write, with no network', async () => {
  const f = fixture();
  try {
    for (const [kind, list] of [
      ['campaign', ['100']],
      ['adgroup', ['201']],
      ['ad', ['301']],
    ]) {
      const r = await f.call('amcp_write', {
        action: 'inspect',
        gateway,
        connection_id: TIKTOK,
        arguments: f.args(kind, list),
      });
      assert.equal(r.success, true, kind + ' ' + JSON.stringify(r).slice(0, 400));
      assert.equal(r.data.review_contract_supported, true, kind);
      assert.equal(r.data.request.destructive, true, kind);
      assert.equal(r.data.network_requests, 0, kind);
    }
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('only 1-20 unique numeric IDs of the route, and no other key, are accepted, before any request', async () => {
  const f = fixture();
  try {
    for (const [name, kind, payload] of [
      ['no IDs', 'campaign', {campaign_ids: [], operation_status: 'DELETE'}],
      [
        '21 IDs',
        'campaign',
        {campaign_ids: Array.from({length: 21}, (_, i) => String(1000 + i)), operation_status: 'DELETE'},
      ],
      ['duplicate', 'adgroup', {adgroup_ids: ['201', '201'], operation_status: 'DELETE'}],
      ['non-numeric', 'ad', {smart_plus_ad_ids: ['ad-1'], operation_status: 'DELETE'}],
      ['wrong ID field', 'campaign', {adgroup_ids: ['201'], operation_status: 'DELETE'}],
      ['unknown key', 'ad', {smart_plus_ad_ids: ['301'], operation_status: 'DELETE', allow_partial_success: false}],
    ]) {
      const r = await f.prepare(kind, [], payload);
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_DELETION', {writes: f.writes.length});
      assert.ok(r.error.details?.field, name + ' names its field');
    }
    // Another advertiser in the body is refused earlier still, by the compiler's account check.
    assertRefused(
      await f.prepare('campaign', [], {advertiser_id: '456', campaign_ids: ['100'], operation_status: 'DELETE'}),
      'ACCOUNT_SCOPE_MISMATCH',
      {writes: f.writes.length},
    );
    const skan = await f.prepare('campaign', [], {
      campaign_ids: ['100'],
      operation_status: 'DELETE',
      postback_window_mode: 'POSTBACK_WINDOW_MODE1',
    });
    assertRefused(skan, 'INVALID_TIKTOK_SMART_PLUS_DELETION', {message: /SKAN 4\.0 postback windows/});
    assert.equal(skan.error.details.field, 'postback_window_mode');
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('a paused campaign deletion reads its ad groups and ads, lists them and the enabled ones, sends one DELETE and verifies it', async () => {
  const f = fixture();
  try {
    const p = await f.prepare('campaign', ['100']);
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 600));
    assert.deepEqual(
      p.data.state_reads.map(r => r.path),
      ['/v1.3/smart_plus/campaign/get/', '/v1.3/smart_plus/adgroup/get/', '/v1.3/smart_plus/ad/get/'],
    );
    assert.ok(
      reads(f).some(r => r.startsWith('GET /v1.3/smart_plus/adgroup/get/') && r.includes('"campaign_ids":["100"]')),
    );
    assert.ok(reads(f).some(r => r.startsWith('GET /v1.3/smart_plus/ad/get/') && r.includes('"campaign_ids":["100"]')));
    assert.equal(p.data.effect, 'destructive');
    const impact = p.data.creative_impact;
    assert.equal(impact.operation, 'delete');
    assert.deepEqual(impact.changes, [
      {campaign_id: '100', name: 'Smart+ web DNU', before: 'DISABLE', after: 'DELETE', unchanged: false},
    ]);
    // Enabled children under a paused campaign cannot deliver: they are listed, not refused (QUESTIONS L12).
    assert.deepEqual(
      impact.children.map(c => [c.kind, c.count, c.all, c.enabled.map(e => e.name)]),
      [
        ['adgroup', 2, ['200', '201'], ['Group A']],
        ['ad', 3, ['300', '301', '302'], ['Ad A']],
      ],
    );
    assert.equal(impact.enabled_children, 2);
    assert.match(impact.effect, /AMCP cannot undo a deletion/);
    // A deletion stops delivery: no spending confirmation is asked (the classic DELETE asks none either).
    const out = await f.execute(p.data.review_id);
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 600));
    assert.deepEqual(f.writes, [
      {kind: 'campaign', body: {advertiser_id: account, campaign_ids: ['100'], operation_status: 'DELETE'}},
    ]);
    const verified = await f.verify(p.data.review_id);
    assert.equal(verified.data.status, 'verified', JSON.stringify(verified).slice(0, 600));
    assert.equal(verified.data.checks.length, 1);
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('an ad group deletion reads its ads; an ad deletion reads no children; each is deleted and verified', async () => {
  const f = fixture();
  try {
    const group = await f.prepare('adgroup', ['201']);
    assert.equal(group.success, true, JSON.stringify(group).slice(0, 600));
    assert.deepEqual(
      group.data.creative_impact.children.map(c => [c.kind, c.all, c.enabled.length]),
      [['ad', ['302'], 0]],
    );
    assert.ok(reads(f).some(r => r.startsWith('GET /v1.3/smart_plus/ad/get/') && r.includes('"adgroup_ids":["201"]')));
    assert.equal((await f.execute(group.data.review_id)).success, true);
    assert.equal((await f.verify(group.data.review_id)).data.status, 'verified');
    const before = reads(f).length,
      single = await f.prepare('ad', ['301']);
    assert.equal(single.success, true, JSON.stringify(single).slice(0, 600));
    assert.deepEqual(single.data.creative_impact.children, []);
    assert.deepEqual(
      reads(f)
        .slice(before)
        .map(r => r.split(' ')[1]),
      ['/v1.3/smart_plus/ad/get/'],
    );
    assert.equal((await f.execute(single.data.review_id)).success, true);
    assert.equal((await f.verify(single.data.review_id)).data.status, 'verified');
    assert.deepEqual(
      f.writes.map(w => [w.kind, w.body.operation_status]),
      [
        ['adgroup', 'DELETE'],
        ['ad', 'DELETE'],
      ],
    );
    // A frozen (terminated) ad may be deleted too.
    const frozen = fixture();
    try {
      const q = await frozen.prepare('ad', ['302']);
      assert.equal(q.success, true, JSON.stringify(q).slice(0, 400));
    } finally {
      frozen.store.close();
    }
  } finally {
    f.store.close();
  }
});

test('an enabled target is refused pause-first with the DISABLE prepare as next_call, at prepare and at execute', async () => {
  const f = fixture();
  try {
    const r = await f.prepare('campaign', ['101', '102']);
    assertRefused(r, 'TIKTOK_SMART_PLUS_DELETE_REQUIRES_PAUSE', {writes: f.writes.length, message: /101 \(ENABLE\)/});
    assert.doesNotMatch(r.error.message, /102/);
    assert.deepEqual(r.error.details.campaign_ids, ['101']);
    assert.deepEqual(r.error.details.next_call, {
      tool: 'amcp_write',
      arguments: {
        action: 'prepare',
        gateway,
        arguments: {
          action: 'tiktok_smart_plus_campaign_status_update',
          account_id: account,
          payload: {campaign_ids: ['101'], operation_status: 'DISABLE'},
        },
      },
      meaning: r.error.details.next_call.meaning,
    });
    // The next call is the status family's pause, which prepares as it stands (with the connection named).
    const pause = await f.call('amcp_write', {...r.error.details.next_call.arguments, connection_id: TIKTOK});
    assert.equal(pause.success, true, JSON.stringify(pause).slice(0, 400));
    assert.equal(pause.data.creative_impact.scope, 'smart_plus_campaign_status');
    // Paused at prepare, enabled before execute: refused at execute, with nothing sent.
    const p = await f.prepare('adgroup', ['201']);
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 400));
    f.rows.adgroup.set('201', {...f.rows.adgroup.get('201'), operation_status: 'ENABLE'});
    assertRefused(await f.execute(p.data.review_id), 'TIKTOK_SMART_PLUS_DELETE_REQUIRES_PAUSE', {
      writes: f.writes.length,
    });
    // A target that is not returned is refused by name (deleted entities cannot change).
    const missing = await f.prepare('ad', ['399']);
    assertRefused(missing, 'STATE_TARGET_MISMATCH', {writes: f.writes.length, message: /399/});
  } finally {
    f.store.close();
  }
});

test('children that do not fit one page, or a child of another campaign, fail the deletion closed', async () => {
  const paged = fixture({mode: 'paged'});
  try {
    assertRefused(await paged.prepare('adgroup', ['201']), 'INCOMPLETE_STATE', {writes: paged.writes.length});
    // An ad has no children to read: its deletion is not affected.
    assert.equal((await paged.prepare('ad', ['301'])).success, true);
  } finally {
    paged.store.close();
  }
  const foreign = fixture({mode: 'foreign'});
  try {
    assertRefused(await foreign.prepare('campaign', ['100']), 'STATE_TARGET_MISMATCH', {writes: foreign.writes.length});
  } finally {
    foreign.store.close();
  }
  // Ads that name only their ad group belong to the campaign through the ad groups the review read under it, and an ad
  // listed under the campaign whose ad group is not one of them is not the campaign's.
  const ads = fixture({mode: 'adsWithoutCampaign'});
  try {
    const p = await ads.prepare('campaign', ['100']);
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 400));
    assert.deepEqual(p.data.creative_impact.children[1].all, ['300', '301', '302']);
    ads.rows.ad.set('306', {
      smart_plus_ad_id: '306',
      adgroup_id: '299',
      campaign_id: '100',
      ad_name: 'Stray',
      operation_status: 'ENABLE',
    });
    assertRefused(await ads.prepare('campaign', ['100']), 'STATE_TARGET_MISMATCH', {writes: ads.writes.length});
  } finally {
    ads.store.close();
  }
});

test('allow_deletion:false refuses a Smart+ deletion at prepare and a saved one at execute; a pause is not affected', async () => {
  const f = fixture();
  try {
    const saved = await f.prepare('ad', ['301']);
    assert.equal(saved.success, true, JSON.stringify(saved).slice(0, 400));
    f.policy({allow_deletion: false});
    for (const [kind, id] of [
      ['campaign', '100'],
      ['adgroup', '201'],
      ['ad', '301'],
    ])
      assertRefused(await f.prepare(kind, [id]), 'POLICY_DELETION_FORBIDDEN', {writes: f.writes.length});
    assertRefused(await f.execute(saved.data.review_id), 'POLICY_DELETION_FORBIDDEN', {writes: f.writes.length});
    const pause = await f.prepare('campaign', [], {campaign_ids: ['101'], operation_status: 'DISABLE'});
    assert.equal(pause.success, true, 'pausing is allowed under the same policy');
  } finally {
    f.store.close();
  }
});

test('the owner’s destructive tier asks destructive_confirmed, and website approval asks a member, before anything is sent', async () => {
  const f = fixture();
  try {
    f.policy({allow_deletion: true, require_destructive_confirmation: true});
    const p = await f.prepare('campaign', ['102']);
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 400));
    assert.equal(p.data.execute_requirements.destructive_confirmed, true);
    assertRefused(await f.execute(p.data.review_id), 'DESTRUCTIVE_CONFIRMATION_REQUIRED', {writes: f.writes.length});
    const done = await f.execute(p.data.review_id, {destructive_confirmed: true});
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 400));
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
  const g = fixture();
  try {
    saveSpendPolicy(g.store, owner, {scope: 'workspace', confirmed: true, policy: {approval_mode: 'website_approval'}});
    const p = await g.prepare('ad', ['301']);
    assert.equal(p.success, true, JSON.stringify(p).slice(0, 400));
    assertRefused(await g.execute(p.data.review_id), 'HUMAN_APPROVAL_REQUIRED', {writes: g.writes.length});
    approveReview(g.store, colleague, p.data.review_id, {fingerprint: p.data.fingerprint, confirmed: true});
    const done = await g.execute(p.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 400));
    assert.equal(g.writes.length, 1);
  } finally {
    g.store.close();
  }
});

test('a receipt missing an ID, a non-empty error_list or an ad receipt with another status is no success and is never resent', async () => {
  for (const [reply, kind, list] of [
    ['missing', 'campaign', ['100', '102']],
    ['error_list', 'campaign', ['100', '102']],
    ['missing', 'ad', ['301']],
    ['status', 'ad', ['301']],
  ]) {
    const f = fixture({reply});
    try {
      const p = await f.prepare(kind, list);
      assert.equal(p.success, true, reply + ' ' + JSON.stringify(p).slice(0, 300));
      const notSuccess = r => r.success !== true || r.data?.success === false;
      const r = await f.execute(p.data.review_id);
      assert.ok(notSuccess(r), reply + ' ' + JSON.stringify(r).slice(0, 300));
      assert.ok(notSuccess(await f.execute(p.data.review_id)), reply);
      assert.equal(f.writes.length, 1, reply);
    } finally {
      f.store.close();
    }
  }
});

test('the read-back: a deleted row listed as DELETE or *_DELETE, or absent, is deleted; one still listed and not deleted is not', async () => {
  for (const deleted of ['hidden', 'listed', 'secondary']) {
    const f = fixture({deleted});
    try {
      const p = await f.prepare('adgroup', ['201']);
      assert.equal((await f.execute(p.data.review_id)).success, true, deleted);
      const v = await f.verify(p.data.review_id);
      assert.equal(v.data.status, 'verified', deleted + ' ' + JSON.stringify(v).slice(0, 400));
      // The read-back asks the default read only: STATUS_ALL is not confirmed for Smart+ reads.
      assert.ok(!f.requests.some(r => r.includes('primary_status')), deleted);
    } finally {
      f.store.close();
    }
  }
  const ignored = fixture({mode: 'ignored'});
  try {
    const p = await ignored.prepare('adgroup', ['201']);
    assert.equal((await ignored.execute(p.data.review_id)).success, true);
    const v = await ignored.verify(p.data.review_id);
    assert.notEqual(v.data?.status, 'verified', JSON.stringify(v).slice(0, 400));
  } finally {
    ignored.store.close();
  }
});

test('a TikTok-declared error and a lost answer are each sent once across a restart; concurrent executions send once', async () => {
  for (const [reply, first, again] of [
    ['error', 'PLATFORM_ERROR', 'WRITE_REJECTED'],
    ['lost', 'WRITE_OUTCOME_UNCERTAIN', 'WRITE_OUTCOME_UNCERTAIN'],
  ]) {
    const f = fixture({reply});
    try {
      const p = await f.prepare('campaign', ['102']);
      assertRefused(await f.execute(p.data.review_id), first);
      f.found();
      f.restart();
      assertRefused(await f.execute(p.data.review_id), again);
      assert.equal(f.writes.length, 1, reply);
    } finally {
      f.store.close();
    }
  }
  const g = fixture();
  try {
    const p = await g.prepare('campaign', ['102']);
    const results = await Promise.all([g.execute(p.data.review_id), g.execute(p.data.review_id)]);
    assert.ok(results.some(r => r.success));
    assert.equal(g.writes.length, 1);
    g.restart();
    assert.equal((await g.execute(p.data.review_id)).data.replayed, true);
  } finally {
    g.store.close();
  }
});

test('every body of the three Smart+ status routes has one family: DELETE the deletion family, the rest the status family', () => {
  const plan = (kind, body) => ({
    gateway,
    accountId: account,
    action: 'tiktok_smart_plus_' + kind + '_status_update',
    method: 'POST',
    path: '/v1.3/smart_plus/' + kind + '/status/update/',
    headers: {},
    query: {},
    body,
    readOnly: false,
    destructive: false,
    requiresConfirmation: true,
    evidence: 'synthetic',
    warnings: [],
  });
  for (const kind of Object.keys(kinds)) {
    const ids = {[kinds[kind][0]]: ['100']};
    for (const [body, name] of [
      [{...ids, operation_status: 'DELETE'}, 'tiktok_smart_plus_deletions'],
      [{...ids, operation_status: 'ENABLE'}, 'tiktok_smart_plus_status'],
      [{...ids, operation_status: 'DISABLE'}, 'tiktok_smart_plus_status'],
      [{...ids, operation_status: 'PAUSE'}, 'tiktok_smart_plus_status'],
      [{...ids}, 'tiktok_smart_plus_status'],
      [{}, 'tiktok_smart_plus_status'],
    ])
      // familyOf refuses a request two families claim (REVIEWED_FAMILY_CONFLICT), so a name proves a single claim.
      assert.equal(familyOf(plan(kind, body))?.name, name, kind + ' ' + JSON.stringify(body));
    const deletion = plan(kind, {...ids, operation_status: 'DELETE'});
    assert.equal(familyOf(deletion).destructive(deletion), true, kind);
    assert.equal(applyExecutionRisk(deletion).destructive, true, kind);
  }
});

test('a lost deletion stays uncertain and is never resent: reconcile only re-reads the review state, with no read contract', async () => {
  // Item 3 of r25-m4-smartdelete: M2's namedTargets answers nothing for a family with its own verification
  // (src/write-reconciliation.ts namedTargets), so a lost Smart+ deletion is settled by reading, as the classic DELETE is:
  // reconcile reports whether the reviewed state still holds, and a new prepare reads the target again.
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
  try {
    for (const [mode, applied] of [
      ['', true],
      ['ignored', false],
    ]) {
      const f = fixture({reply: 'lost', mode});
      try {
        const p = await f.prepare('campaign', ['102']);
        assertRefused(await f.execute(p.data.review_id), 'WRITE_OUTCOME_UNCERTAIN');
        const before = f.requests.length;
        const r = await f.call('amcp_write', {action: 'reconcile', review_id: p.data.review_id});
        assert.equal(r.success, true, JSON.stringify(r).slice(0, 600));
        assert.deepEqual(
          [r.data.contract, r.data.classification, r.data.reason, r.data.mutation_requests],
          ['none', 'indeterminate', 'no_read_contract', 0],
        );
        // Applied, the targets' read no longer matches the reviewed state; not applied, it does.
        assert.equal(r.data.state_unchanged_since_review, !applied, mode);
        const seen = f.requests.slice(before);
        assert.ok(seen.length > 0 && seen.every(request => request.startsWith('GET ')), seen.join(', '));
        // Verification does not settle an uncertain write, and execute never sends it again.
        assertRefused(await f.verify(p.data.review_id), 'WRITE_OUTCOME_UNCERTAIN');
        assertRefused(await f.execute(p.data.review_id), 'WRITE_OUTCOME_UNCERTAIN');
        assert.equal(f.writes.length, 1, 'never resent');
        // A new review reads the target again: a deleted campaign is no longer returned.
        const again = await f.prepare('campaign', ['102']);
        if (applied) assertRefused(again, 'STATE_TARGET_MISMATCH', {message: /102/});
        else assert.equal(again.success, true, JSON.stringify(again).slice(0, 400));
        assert.equal(f.writes.length, 1, 'a prepare sends nothing');
      } finally {
        f.store.close();
      }
    }
  } finally {
    delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
    delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
  }
});
