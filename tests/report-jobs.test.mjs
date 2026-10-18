import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Registry} from '../dist/src/catalog.js';
import {reportJob, reportJobList, reportJobPlan} from '../dist/src/report-jobs.js';
import {metaReportJob, metaReportPlan} from '../dist/src/meta-insights-jobs.js';
import {xReportPlan} from '../dist/src/x-report-jobs.js';
import {xReportJob} from '../dist/src/x-report-download.js';
import {tiktokReportJob} from '../dist/src/tiktok-report-jobs.js';
import {criteoReportJob} from '../dist/src/criteo-report-jobs.js';
import {microsoftReportJob} from '../dist/src/microsoft-report-download.js';
import {metaPrefix} from '../dist/src/meta-version.js';

// ARC-04 stage F: MirrorService.runPlan and Compiler.compile imported the asynchronous report job modules of Meta, X,
// TikTok and Criteo and Microsoft's report download, and branched on each job's plan fields. The jobs are now entries
// of src/report-jobs.ts, consulted by a request's gateway. These tests hold that the registry answers exactly what the
// branches decided; the provider suites (x-report-jobs, tiktok-report-jobs, criteo-report-jobs, meta-insights-jobs,
// microsoft-report-download) run the reads end to end through MirrorService. Loading the catalog first evaluates the
// family registry, as entry points do.
new Registry();
const request = fields => ({query: {}, headers: {}, readOnly: true, ...fields});
const metaCreate = request({
  gateway: 'meta_native_action',
  action: 'meta_ad_account_id_insights_report_create',
  method: 'POST',
  path: metaPrefix + 'act_123/insights',
  body: {fields: 'impressions,clicks', level: 'campaign'},
  readOnly: false,
});
const xStatus = request({
  gateway: 'x_ads_native_action',
  action: 'x_stats_jobs_accounts_account_id_get',
  method: 'GET',
  path: '/12/stats/jobs/accounts/abc1',
  query: {job_ids: '1500000000000000000'},
});
const xCreate = request({
  gateway: 'x_ads_native_action',
  action: 'x_stats_jobs_accounts_account_id_post',
  method: 'POST',
  path: '/12/stats/jobs/accounts/abc1',
  body: {entity: 'CAMPAIGN', start_time: '2026-09-01T00:00:00.000Z'},
  readOnly: false,
});
const tiktokCheck = request({
  gateway: 'tiktok_native_action',
  action: 'tiktok_report_task_check',
  method: 'GET',
  path: '/v1.3/report/task/check/',
  query: {advertiser_id: '7000', task_id: 't1'},
});
const google = request({gateway: 'google_ads_native_action', action: 'search', method: 'POST', path: '/v25/x'});

test('one report job per gateway, consulted only by a request’s own gateway', () => {
  assert.deepEqual(
    reportJobList.map(job => job.gateway),
    [
      'x_ads_native_action',
      'tiktok_native_action',
      'criteo_native_action',
      'meta_native_action',
      'microsoft_ads_native_action',
    ],
  );
  for (const job of [xReportJob, tiktokReportJob, criteoReportJob, metaReportJob, microsoftReportJob])
    assert.equal(reportJob(job.gateway), job, job.gateway);
  for (const gateway of ['google_ads_native_action', 'amcp_write', 'constructor', 'toString', '__proto__', 1, null])
    assert.equal(reportJob(gateway), undefined, String(gateway));
  assert.ok(Object.isFrozen(reportJobList));
});

test('the compiled request controls equal the Meta-then-X composition the compiler applied before', () => {
  const cases = [
    [metaCreate, {}],
    [xStatus, {}],
    [xStatus, {download_report: true, offset: 10, limit: 20}],
    [xCreate, {}],
    [tiktokCheck, {}],
    [google, {download_report: true}],
  ];
  for (const [plan, input] of cases)
    assert.deepEqual(
      reportJobPlan(structuredClone(plan), input),
      xReportPlan(metaReportPlan(structuredClone(plan)), input),
      plan.action,
    );
  // Meta's fields become the native list; an X download is attached as a bounded page.
  assert.deepEqual(reportJobPlan(structuredClone(metaCreate), {}).body.fields, ['impressions', 'clicks']);
  assert.deepEqual(reportJobPlan(structuredClone(xStatus), {download_report: true}).reportDownload, {
    offset: 0,
    limit: 100,
  });
  // A refusal is the one the composition gave, for the same request.
  for (const input of [
    {download_report: 'yes'},
    {download_report: true, offset: -1},
    {download_report: true, fields: 'a'},
  ])
    assert.throws(
      () => reportJobPlan(structuredClone(xStatus), input),
      error => {
        let expected;
        try {
          xReportPlan(metaReportPlan(structuredClone(xStatus)), input);
        } catch (e) {
          expected = e;
        }
        return expected && error.code === expected.code && error.message === expected.message;
      },
    );
  assert.throws(() => reportJobPlan(structuredClone(xCreate), {download_report: true}), {
    message: 'download_report applies only to x_stats_jobs_accounts_account_id_get.',
  });
});

test('a job read keeps its login exactly where runPlan required it: Criteo, TikTok and X job reads', () => {
  const plans = [
    {...google},
    {...metaCreate, metaReportRead: {kind: 'status'}},
    {...xStatus},
    {...xStatus, xReportRead: [{job_id: '1'}]},
    {...tiktokCheck},
    {...tiktokCheck, tiktokReportRead: {kind: 'check'}},
    request({gateway: 'criteo_native_action', path: '/2025-10/reports/1/status'}),
    request({gateway: 'criteo_native_action', path: '/2025-10/reports/1/status', criteoReportRead: {kind: 'status'}}),
    request({gateway: 'microsoft_ads_native_action', path: '/', reportDownload: {offset: 0, limit: 1}}),
  ];
  for (const p of plans)
    assert.equal(
      !!reportJob(p.gateway)?.sameLogin?.(p),
      !!(p.criteoReportRead || p.tiktokReportRead || p.xReportRead),
      p.gateway,
    );
});

test('X and TikTok job reads refuse aggregation with the reasons runPlan gave; an X status read gets its deadline', () => {
  for (const flag of ['aggregate_pages', 'paginate', 'allPages']) {
    assert.throws(() => xReportJob.admit(xStatus, {[flag]: true}), {
      code: 'INVALID_ARGUMENT',
      message: 'Poll explicit job_ids. Download one original job with offset/limit; do not aggregate job discovery.',
    });
    assert.throws(() => tiktokReportJob.admit(tiktokCheck, {[flag]: true}), {
      code: 'INVALID_ARGUMENT',
      message: 'TikTok asynchronous tasks are not paginated. Resume the same task using status/download.',
    });
  }
  const before = performance.now(),
    admitted = xReportJob.admit(xStatus, {});
  assert.ok(admitted.xReportDeadline >= before + 60000 && admitted.xReportDeadline <= performance.now() + 60000);
  assert.equal(xReportJob.admit(xCreate, {}).xReportDeadline, undefined);
  assert.equal(tiktokReportJob.admit(tiktokCheck, {}), tiktokCheck);
  // Meta, Criteo and Microsoft job reads take every read argument they took before: no admission step.
  for (const job of [metaReportJob, criteoReportJob, microsoftReportJob]) assert.equal(job.admit, undefined);
});

test('a page or a read of another kind is not the job’s: the read path continues as before', async () => {
  const page = {result: {status: 200, data: {}, headers: {}}};
  for (const [job, plan] of [
    [xReportJob, xStatus],
    [tiktokReportJob, tiktokCheck],
    [metaReportJob, metaCreate],
  ])
    assert.ok(!job.page(plan, page), job.gateway);
  assert.equal(microsoftReportJob.observed(request({gateway: 'microsoft_ads_native_action'}), {}, page), undefined);
  for (const [job, plan] of [
    [tiktokReportJob, tiktokCheck],
    [criteoReportJob, request({gateway: 'criteo_native_action'})],
    [metaReportJob, metaCreate],
  ])
    assert.equal(
      job.read(plan, async () => assert.fail('no read'), {}),
      undefined,
    );
});

test('MirrorService and the compiler import no report job module; they consult the registry', () => {
  const jobModules = [
    'meta-insights-jobs',
    'x-report-jobs',
    'x-report-download',
    'tiktok-report-jobs',
    'criteo-report-jobs',
    'microsoft-report-download',
  ];
  for (const file of ['dist/src/service.js', 'dist/src/compiler.js']) {
    const imports = [...fs.readFileSync(file, 'utf8').matchAll(/from '\.\/([a-z0-9-]+)\.js'/g)].map(m => m[1]);
    assert.ok(imports.includes('report-jobs'), file);
    assert.deepEqual(
      imports.filter(name => jobModules.includes(name)),
      [],
      file,
    );
  }
});
