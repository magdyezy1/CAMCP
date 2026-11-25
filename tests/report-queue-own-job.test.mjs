import test from 'node:test';
import assert from 'node:assert/strict';
import {rollbackFixture, rollingWindow} from './helpers/rollback-fixture.mjs';
import {normalizeNativeRow} from '../dist/src/report-native.js';
import {assertRefused} from './helpers/assert-refused.mjs';

// r25-mf-jobs F5: a snapshot job that delivers to a file destination queues the file job from inside its own run, so the
// workspace's count of active reporting jobs holds the job that is asking. With 99 other jobs waiting, the 100th (this one,
// about to finish) was refused its file job as if it were the 101st, and it was refused again on every retry. The count a
// job meets leaves out itself; a person's export, which is no job, still meets all of them.
const raw = {
  CampaignId: '4001',
  CampaignName: 'Synthetic campaign',
  CurrencyCode: 'USD',
  Spend: '10',
  Impressions: '100',
};
async function fixture(t) {
  const f = rollbackFixture(t, {
      platforms: ['microsoft'],
      rows: {microsoft: [normalizeNativeRow('microsoft', {...raw, Clicks: '5', Conversions: '1', Revenue: '20'})]},
    }),
    tenant = f.actor.tenantId,
    destinations = [];
  for (const n of [1, 2])
    destinations.push(
      await f.handle({
        action: 'bind_file_destination',
        confirmed: true,
        idempotency_key: 'own-files-000' + n,
        file_destination: {name: 'Own files ' + n, formats: ['xlsx']},
      }),
    );
  const created = await f.handle({
    action: 'schedule',
    confirmed: true,
    idempotency_key: 'own-sched-0001',
    config: f.body([f.source('microsoft')], {date_range: rollingWindow}),
    schedule: {schedule_kind: 'daily', timezone: 'UTC', schedule_config: {hour: 8}, destination_id: destinations[0].id},
  });
  const {id: _id, revision: _revision, ...data} = f.document('overview_schedule', created.id);
  f.store.putDocument(tenant, 'overview_schedule', created.id, {...data, next_run_at: Date.now() - 1000});
  // Ninety-nine other jobs wait (a day from now, so the worker leaves them be): with the scheduled run, a hundred are active.
  for (let i = 0; i < 99; i++) f.store.enqueue(tenant, 'report_overview', {report_id: 'filler-' + i});
  f.store
    .sql()
    .prepare("UPDATE jobs SET available_at=? WHERE json_extract(input,'$.report_id') LIKE 'filler-%'")
    .run(Date.now() + 86400000);
  return {f, tenant, destinations, created};
}

test('a snapshot job delivers its file when it is the hundredth active job, and a person’s export still meets the bound', async t => {
  const x = await fixture(t);
  x.f.overview.tick();
  const [report] = x.f.documents('overview_report').filter(r => r.schedule_id === x.created.id);
  assert.equal(
    x.f.store.sql().prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('queued','running')").get().n,
    100,
    'the scheduled run and ninety-nine others',
  );
  await x.f.worker.once();
  const done = x.f.document('overview_report', report.id);
  assert.equal(done.state, 'complete');
  const exports = x.f.documents('overview_export').filter(e => e.report_id === report.id);
  assert.equal(
    exports.length,
    1,
    'the job queued its file job: ' +
      JSON.stringify([
        x.f.store.job(x.tenant, report.job_id).state,
        x.f.store.job(x.tenant, report.job_id).error?.code,
      ]),
  );
  assert.equal(exports[0].destination_id, x.destinations[0].id);
  assert.equal(x.f.document('overview_schedule', x.created.id).last_delivery.state, 'queued');
  // The run is done: ninety-nine others and the new file job are a hundred active jobs, and a person asking for another
  // file now is the hundred and first.
  await assert.rejects(
    x.f.handle({action: 'export', report_id: report.id, destination_id: x.destinations[1].id, confirmed: true}),
    error => {
      assertRefused(error, 'REPORT_QUEUE_FULL');
      assert.equal(error.retryable, true);
      return true;
    },
  );
});
