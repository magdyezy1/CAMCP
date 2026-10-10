import {
  syntheticWriteJourneyFixture,
  spendPolicyEditFixture,
  exportOutcomesFixture,
} from './fixtures/synthetic-writes-data.mjs';

const web = tenant => ({tenantId: tenant, userId: 'fixture', role: 'admin'});
{
  const f = syntheticWriteJourneyFixture(),
    a = web(f.actor.tenantId);
  for (const outcome of ['accepted', 'uncertain', 'refused']) {
    const id = await f.seed(a, outcome);
    const p = await f.service.call('amcp_campaign', {action: 'prepare_next', id, detail: 'full'}, a);
    if (outcome === 'refused') f.changeAccountState();
    const r = p.data.review;
    const out = await f.service.call(
      'amcp_campaign',
      {action: 'execute_next', id, review_id: r.review_id, idempotency_key: r.idempotency_key, confirmed: true},
      a,
    );
    console.log(outcome, out.success, out.data?.steps?.[0]?.status, out.data?.state, f.syntheticWrites(), f.writes());
  }
  f.close();
}
{
  const f = spendPolicyEditFixture(),
    a = web(f.actor.tenantId);
  const p = await f.reset(a);
  console.log('policy', JSON.stringify(p));
  const q = await f.reset(a);
  console.log('policy2', q.revision);
  f.close();
}
{
  const f = exportOutcomesFixture(),
    a = web(f.actor.tenantId);
  const s = f.seed(a);
  const call = input => f.service.call('amcp_reporting_overview', {confirmed: true, ...input}, a);
  const b = await call({action: 'bootstrap'});
  console.log('destinations', JSON.stringify(b.data?.destinations ?? b.error).slice(0, 400));
  const e1 = await call({action: 'export', report_id: s.newer, destination_id: s.destination});
  console.log('e1', JSON.stringify(e1).slice(0, 300));
  console.log('work', await f.workOnce());
  const st1 = await call({action: 'export_status', id: e1.data.id});
  console.log('st1', st1.data.state, st1.data.outcome, st1.data.url);
  const e2 = await call({action: 'export', report_id: s.older, destination_id: s.destination});
  console.log('work', await f.workOnce());
  const st2 = await call({action: 'export_status', id: e2.data.id});
  console.log('st2', st2.data.state, st2.data.outcome, f.syntheticWrites(), f.writes(), f.tab.report);
  const s2 = f.seed(a);
  const e3 = await call({action: 'export', report_id: s2.newer, destination_id: s2.destination});
  await f.workOnce();
  const st3 = await call({action: 'export_status', id: e3.data.id});
  console.log('st3', st3.data.state, st3.data.outcome, f.syntheticWrites(), f.tab.report);
  f.close();
}
