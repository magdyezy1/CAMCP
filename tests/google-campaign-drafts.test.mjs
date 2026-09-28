import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {actionContracts} from '../dist/src/action-contracts.js';

/**
 * Campaign drafts, Google Ads API v23 (pinned Discovery document: CampaignDraftService and CampaignDraftErrorEnum; the
 * "Campaign drafts" guide; checked 2026-09-27).
 */
const gateway = 'google_ads_native_action',
  registry = new Registry(),
  C = 'customers/123/';
const actions = {
  mutate: 'google_ads_v23_campaign_draft_mutate_campaign_drafts',
  promote: 'google_ads_v23_campaign_draft_promote_campaign_draft',
  create: 'CREATE_CAMPAIGN_DRAFT',
  update: 'UPDATE_CAMPAIGN_DRAFT',
  remove: 'REMOVE_CAMPAIGN_DRAFT',
  promoteLegacy: 'PROMOTE_CAMPAIGN_DRAFT',
};
const actor = {tenantId: 'campaign-drafts', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
const campaign = id => C + 'campaigns/' + id,
  draft = (base, id) => C + 'campaignDrafts/' + base + '~' + id;
function fixture(mode = '') {
  const store = new Store(':memory:', Buffer.alloc(32, 98).toString('base64')),
    calls = [];
  let writes = 0,
    next = 20;
  store.putConnection(
    owner,
    {
      id: 'g',
      tenantId: actor.tenantId,
      gateway,
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Google Ads',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const campaigns = {
    1001: {name: 'Search brand', status: 'ENABLED', advertisingChannelType: 'SEARCH', experimentType: 'BASE'},
    1002: {name: 'Old', status: 'REMOVED', advertisingChannelType: 'SEARCH', experimentType: 'BASE'},
    1003: {name: 'Draft copy', status: 'ENABLED', advertisingChannelType: 'SEARCH', experimentType: 'DRAFT'},
  };
  const drafts = new Map([
    ['1001~11', {name: 'Existing draft', status: 'PROPOSED', hasExperimentRunning: false}],
    ['1001~12', {name: 'Promoted draft', status: 'PROMOTED', hasExperimentRunning: false}],
    ['1001~13', {name: 'Experiment draft', status: 'PROPOSED', hasExperimentRunning: true}],
  ]);
  const inList = (query, field) =>
    [...(new RegExp(field + ' IN \\(([^)]*)\\)').exec(query)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
  const row = (key, d) => ({
    resourceName: C + 'campaignDrafts/' + key,
    draftId: key.split('~')[1],
    baseCampaign: campaign(key.split('~')[0]),
    name: d.name,
    draftCampaign: campaign(5000 + Number(key.split('~')[1])),
    status: d.status,
    hasExperimentRunning: d.hasExperimentRunning,
  });
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      path = decodeURIComponent(u.pathname),
      body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({path, body});
    if (path === '/v23/customers/123/googleAds:search') {
      const q = body.query;
      if (/FROM customer /.test(q + ' '))
        return Response.json({results: [{customer: {resourceName: 'customers/123', id: '123', manager: false}}]});
      if (/FROM campaign_draft /.test(q + ' ')) {
        const bases = inList(q, 'campaign_draft.base_campaign');
        return Response.json({
          results: [...drafts]
            .filter(([k]) => bases.includes(campaign(k.split('~')[0])))
            .map(([k, d]) => ({campaignDraft: row(k, d)})),
        });
      }
      if (/FROM campaign /.test(q + ' ')) {
        const names = inList(q, 'campaign.resource_name');
        return Response.json({
          results: names
            .filter(n => campaigns[n.split('/').at(-1)])
            .map(n => ({campaign: {resourceName: n, id: n.split('/').at(-1), ...campaigns[n.split('/').at(-1)]}})),
        });
      }
      throw new Error('Unexpected query ' + q);
    }
    if (path === '/v23/customers/123/campaignDrafts:mutate') {
      writes++;
      return Response.json({
        results: body.operations.map(op => {
          if (op.create) {
            const key = op.create.baseCampaign.split('/').at(-1) + '~' + next++;
            if (mode !== 'ignore')
              drafts.set(key, {name: op.create.name, status: 'PROPOSED', hasExperimentRunning: false});
            return {resourceName: mode === 'other' ? draft(9999, 1) : C + 'campaignDrafts/' + key};
          }
          const name = op.update?.resourceName ?? op.remove,
            key = name.split('/').at(-1);
          if (mode !== 'ignore') {
            if (op.update) drafts.get(key).name = op.update.name;
            else drafts.get(key).status = 'REMOVED';
          }
          return {resourceName: name};
        }),
      });
    }
    const m = /^\/v23\/customers\/123\/campaignDrafts\/(\d+~\d+):promote$/.exec(path);
    if (m) {
      writes++;
      if (mode !== 'ignore')
        drafts.get(m[1]).status = mode === 'slow' ? 'PROMOTING' : mode === 'failed' ? 'PROMOTE_FAILED' : 'PROMOTED';
      return Response.json({name: 'customers/123/operations/op-' + m[1], done: false});
    }
    throw new Error('Unexpected ' + path);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const mutate = (operations, action = actions.mutate, extra = {}) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: '123', payload: {operations, ...extra}}},
      actor,
    );
  const promote = (name, action = actions.promote) =>
    service.call(
      'amcp_write',
      {
        action: 'prepare',
        gateway,
        arguments: {action, account_id: '123', path_params: {campaign_draft: name}, payload: {}},
      },
      actor,
    );
  const execute = (p, extra = {}) =>
    service.call(
      'amcp_write',
      {
        action: 'execute',
        review_id: p.data.review_id,
        idempotency_key: p.data.idempotency_key,
        confirmed: true,
        ...extra,
      },
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, drafts, mutate, promote, execute, verify, writes: () => writes};
}
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r;
};

test('drafts are created, renamed and removed once without spending confirmation and verify, also through the legacy actions', async () => {
  const f = fixture();
  try {
    const p = ok(
      await f.mutate([
        {create: {baseCampaign: campaign(1001), name: 'Bid test'}},
        {update: {resourceName: draft(1001, 11), name: 'Renamed draft'}, updateMask: 'name'},
      ]),
    );
    assert.equal(p.data.creative_impact.scope, 'campaign_draft');
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.deepEqual(
      p.data.creative_impact.changes.map(c => c.operation),
      ['create', 'rename'],
    );
    ok(await f.execute(p));
    assert.equal(f.writes(), 1);
    assert.equal(f.drafts.get('1001~20').name, 'Bid test');
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
    assert.equal((await f.execute(p)).data.replayed, true);
    assert.equal(f.writes(), 1);
    const c = ok(await f.mutate([{create: {baseCampaign: campaign(1001), name: 'Second test'}}], actions.create));
    ok(await f.execute(c));
    assert.equal(ok(await f.verify(c)).data.status, 'verified');
    const r = ok(await f.mutate([{remove: draft(1001, 11)}], actions.remove));
    ok(await f.execute(r));
    assert.equal(f.drafts.get('1001~11').status, 'REMOVED');
    assert.equal(ok(await f.verify(r)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('promotion needs spending confirmation, verifies once PROMOTED, stays open while PROMOTING and fails on PROMOTE_FAILED; owner policy treats it as activation', async () => {
  const f = fixture();
  try {
    const p = ok(await f.promote(draft(1001, 11)));
    assert.equal(p.data.creative_impact.operation, 'promote');
    assert.match(p.data.creative_impact.effect, /enabled and serving/);
    assert.equal((await f.execute(p)).error?.code, 'SPEND_CONFIRMATION_REQUIRED');
    ok(await f.execute(p, {spend_change_confirmed: true}));
    assert.equal(f.drafts.get('1001~11').status, 'PROMOTED');
    assert.equal(ok(await f.verify(p)).data.status, 'verified');
  } finally {
    f.store.close();
  }
  for (const mode of ['slow', 'failed']) {
    const g = fixture(mode);
    try {
      const p = ok(await g.promote(draft(1001, 11), actions.promoteLegacy));
      ok(await g.execute(p, {spend_change_confirmed: true}));
      assert.notEqual(ok(await g.verify(p)).data.status, 'verified', mode);
    } finally {
      g.store.close();
    }
  }
  const h = fixture();
  try {
    saveSpendPolicy(h.store, owner, {gateway, account_id: '123', confirmed: true, policy: {allow_activation: false}});
    assert.equal((await h.promote(draft(1001, 11))).error?.code, 'POLICY_ACTIVATION_FORBIDDEN');
  } finally {
    h.store.close();
  }
});

test('malformed draft requests are refused before any request', async () => {
  const cases = [
    ['empty name', [{create: {baseCampaign: campaign(1001), name: ''}}]],
    ['line feed in name', [{create: {baseCampaign: campaign(1001), name: 'a\nb'}}]],
    ['campaign of another customer', [{create: {baseCampaign: 'customers/999/campaigns/1001', name: 'x'}}]],
    ['extra create field', [{create: {baseCampaign: campaign(1001), name: 'x', status: 'PROPOSED'}}]],
    ['update without mask', [{update: {resourceName: draft(1001, 11), name: 'x'}}]],
    ['status update', [{update: {resourceName: draft(1001, 11), status: 'REMOVED'}, updateMask: 'status'}]],
    ['malformed removal', [{remove: C + 'campaignDrafts/1001'}]],
    [
      'repeated draft',
      [{remove: draft(1001, 11)}, {update: {resourceName: draft(1001, 11), name: 'x'}, updateMask: 'name'}],
    ],
    [
      'same new name twice',
      [{create: {baseCampaign: campaign(1001), name: 'x'}}, {create: {baseCampaign: campaign(1001), name: 'x'}}],
    ],
    [
      'eleven operations',
      Array.from({length: 11}, (_, i) => ({create: {baseCampaign: campaign(1001), name: 'n' + i}})),
    ],
  ];
  for (const [label, operations] of cases) {
    const f = fixture();
    try {
      const r = await f.mutate(operations);
      assert.equal(r.success, false, label);
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  for (const [label, action, operations] of [
    ['remove through the create action', actions.create, [{remove: draft(1001, 11)}]],
    ['create through the remove action', actions.remove, [{create: {baseCampaign: campaign(1001), name: 'x'}}]],
  ]) {
    const f = fixture();
    try {
      const r = await f.mutate(operations, action);
      assert.equal(r.error?.code, 'INVALID_GOOGLE_CAMPAIGN_DRAFT', label);
      assert.equal(f.calls.length, 0, label);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    assert.equal(
      (await f.mutate([{create: {baseCampaign: campaign(1001), name: 'x'}}], actions.mutate, {partialFailure: true}))
        .success,
      false,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
  {
    const f = fixture();
    try {
      const r = await f.promote(C + 'campaignDrafts/1001');
      assert.equal(r.error?.code, 'INVALID_GOOGLE_CAMPAIGN_DRAFT', JSON.stringify(r).slice(0, 300));
      assert.equal(f.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('removed, draft or unknown campaigns, duplicate names, and drafts that are promoted, removed or under an experiment are refused after reading, without writes', async () => {
  const f = fixture();
  try {
    assert.match(
      (await f.mutate([{create: {baseCampaign: campaign(1002), name: 'x'}}])).error?.message ?? '',
      /removed/,
    );
    assert.match(
      (await f.mutate([{create: {baseCampaign: campaign(1003), name: 'x'}}])).error?.message ?? '',
      /DRAFT campaign/,
    );
    assert.equal(
      (await f.mutate([{create: {baseCampaign: campaign(1004), name: 'x'}}])).error?.code,
      'STATE_TARGET_MISMATCH',
    );
    assert.equal(
      (await f.mutate([{create: {baseCampaign: campaign(1001), name: 'Existing draft'}}])).error?.code,
      'CONFIGURATION_EXISTS',
    );
    assert.match(
      (await f.mutate([{update: {resourceName: draft(1001, 11), name: 'Existing draft'}, updateMask: 'name'}])).error
        ?.message ?? '',
      /already has this name/,
    );
    assert.match((await f.mutate([{remove: draft(1001, 12)}])).error?.message ?? '', /PROMOTED/);
    assert.match((await f.mutate([{remove: draft(1001, 13)}])).error?.message ?? '', /experiment/);
    assert.match((await f.promote(draft(1001, 12))).error?.message ?? '', /only a proposed draft/);
    assert.match((await f.promote(draft(1001, 13))).error?.message ?? '', /experiment/);
    assert.equal((await f.promote(draft(1001, 99))).error?.code, 'STATE_TARGET_MISMATCH');
    assert.equal(f.writes(), 0);
  } finally {
    f.store.close();
  }
});

test('a result naming another draft is a failure that is never resubmitted, an ignored change is not verified, and the ledger lists the six actions', async () => {
  const other = fixture('other');
  try {
    const p = ok(await other.mutate([{create: {baseCampaign: campaign(1001), name: 'x'}}]));
    assert.equal((await other.execute(p)).success, false);
    assert.equal((await other.execute(p)).success, false);
    assert.equal(other.writes(), 1);
  } finally {
    other.store.close();
  }
  const ignored = fixture('ignore');
  try {
    const p = ok(
      await ignored.mutate([{update: {resourceName: draft(1001, 11), name: 'Ignored'}, updateMask: 'name'}]),
    );
    ok(await ignored.execute(p));
    assert.notEqual(ok(await ignored.verify(p)).data.status, 'verified');
  } finally {
    ignored.store.close();
  }
  const doc = JSON.parse(readFileSync('.mirror/VENDOR/google-ads-v23.json', 'utf8')),
    S = (doc.document ?? doc).schemas;
  assert.deepEqual(S.GoogleAdsGoogleadsV23Resources__CampaignDraft.properties.status.enum, [
    'UNSPECIFIED',
    'UNKNOWN',
    'PROPOSED',
    'REMOVED',
    'PROMOTING',
    'PROMOTED',
    'PROMOTE_FAILED',
  ]);
  for (const action of Object.values(actions)) {
    const rows = actionContracts(registry).filter(r => r.gateway === gateway && r.action === action);
    assert.equal(rows.length, 1, action);
    assert.equal(rows[0].status, 'reviewed_write_family', action);
    assert.equal(rows[0].family, 'google_campaign_drafts', action);
  }
});
