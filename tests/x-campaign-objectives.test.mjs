// RPT-07: X Overview campaigns take their objective from their line items (X campaigns carry none). Synthetic answers
// behind a recording runPlan; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {MirrorError} from '../dist/src/errors.js';
import {NativeCampaignReports} from '../dist/src/report-native.js';
import {
  xCampaignObjectives,
  xObjectivesMixedWarning,
  xObjectivesUnavailableWarning,
} from '../dist/src/x-campaign-report.js';

const actor = {tenantId: 'x-objectives', userId: 'owner', role: 'admin'};
const range = {since: '2026-06-01', until: '2026-06-01'};
function fixture(lineItems) {
  const store = new Store(':memory:', Buffer.alloc(32, 78).toString('base64'));
  store.putConnection(
    actor,
    {id: 'x', tenantId: actor.tenantId, gateway: 'x_ads_native_action', accounts: ['abc'], enabled: true, label: 'X', scopes: []},
    {accessToken: 'synthetic'},
  );
  const requests = [],
    saved = [];
  const service = {
    store,
    runPlan: async p => {
      requests.push(p);
      if (p.path.endsWith('/campaigns'))
        return {success: true, data: {data: ['c1', 'c2', 'c3'].map(id => ({id, name: 'Campaign ' + id}))}};
      if (p.path.endsWith('/line_items')) {
        if (lineItems instanceof MirrorError) throw lineItems;
        return {success: true, data: {data: lineItems}};
      }
      if (p.path.endsWith('/active_entities')) return {success: true, data: {data: []}};
      if (p.path.startsWith('/12/stats/accounts/')) {
        const ids = String(p.query.entity_ids).split(','),
          hours = (Date.parse(p.query.end_time) - Date.parse(p.query.start_time)) / 3600000;
        return {
          success: true,
          data: {
            data: ids.map(id => ({
              id,
              id_data: [{segment: null, metrics: {impressions: Array(hours).fill(1), clicks: Array(hours).fill(0)}}],
            })),
          },
        };
      }
      return {success: true, data: {data: {id: 'abc', currency: 'USD', timezone: 'UTC', name: 'X'}}};
    },
  };
  const native = new NativeCampaignReports(service);
  return {
    requests,
    saved,
    collect: (checkpoint = {}) =>
      native.collect({platform: 'x', account_id: 'abc', connection_id: 'x'}, range, actor, checkpoint, v =>
        saved.push(structuredClone(v)),
      ),
    close: () => store.close(),
  };
}
const item = (campaign_id, objective, extra = {}) => ({id: 'li-' + campaign_id + objective, campaign_id, objective, ...extra});

test('a campaign whose line items share one objective takes it; mixed objectives stay unknown with a warning', async () => {
  process.env.AMCP_X_ACTIVE_ENTITIES = 'off';
  const f = fixture([
    item('c1', 'WEBSITE_CONVERSIONS'),
    item('c1', 'WEBSITE_CONVERSIONS', {id: 'li-c1-b'}),
    item('c2', 'APP_INSTALLS'),
    item('c2', 'WEBSITE_CLICKS'),
    item('other', 'REACH'),
  ]);
  try {
    const result = await f.collect();
    const byId = Object.fromEntries(result.rows.map(r => [r.campaign_id, r]));
    assert.equal(byId.c1.objective, 'WEBSITE_CONVERSIONS');
    assert.equal(byId.c1.objective_group, 'sales');
    assert.equal(byId.c2.objective, 'unknown', 'mixed line item objectives are never guessed');
    assert.equal(byId.c3.objective, 'unknown', 'a campaign without line items stays unknown');
    assert.ok(result.warnings.includes(xObjectivesMixedWarning));
    const read = f.requests.find(p => p.path === '/12/accounts/abc/line_items');
    assert.deepEqual(read.query, {count: 1000, with_deleted: true});
    // The answer is kept with the checkpoint, so a resumed run reads the line items only once.
    const state = f.saved.find(v => v.x_objectives);
    assert.deepEqual(state.x_objectives.campaigns, {c1: 'WEBSITE_CONVERSIONS', c2: null});
    const before = f.requests.filter(p => p.path.endsWith('/line_items')).length;
    await f.collect(f.saved.at(-1));
    assert.equal(f.requests.filter(p => p.path.endsWith('/line_items')).length, before);
  } finally {
    f.close();
    delete process.env.AMCP_X_ACTIVE_ENTITIES;
  }
});

test('a refused line item read keeps objectives unknown; a malformed line item refuses the source', async () => {
  process.env.AMCP_X_ACTIVE_ENTITIES = 'off';
  const denied = fixture(new MirrorError('PROVIDER_ERROR', 'Forbidden', {}, 403));
  try {
    const result = await denied.collect();
    assert.ok(result.rows.every(r => r.objective === 'unknown'));
    assert.ok(result.warnings.includes(xObjectivesUnavailableWarning));
  } finally {
    denied.close();
  }
  const malformed = fixture([item('c1', 'website conversions')]);
  try {
    await assert.rejects(malformed.collect(), e => e.code === 'REPORT_SHAPE_CHANGED');
  } finally {
    malformed.close();
    delete process.env.AMCP_X_ACTIVE_ENTITIES;
  }
  assert.deepEqual(xCampaignObjectives([{id: 'c1'}], [item('c1', null), item('c1', 'ENGAGEMENTS')]).campaigns, {
    c1: 'ENGAGEMENTS',
  });
});
