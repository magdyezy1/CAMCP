import {objectiveReportFixture} from './objective-report.mjs';
import {range} from './report-packets.mjs';

/**
 * The real definition, queue, worker, row assembly, summary and `get` projection over a fake collector: no provider.
 * `rowsFor(level, source)` supplies the rows of one collected level of a source. `fail(source)` may return an error to
 * throw instead, which is what the collector of that unit would do. `packet` changes every returned packet.
 */
export function reportEngine(t, {platform = 'meta', rowsFor = () => [], fail, packet = {}, accounts} = {}) {
  const f = objectiveReportFixture(t, {platform, accounts});
  f.overview.native.collect = async (source, dates) => {
    const failure = fail?.(source, dates);
    if (failure) throw failure;
    return {
      source,
      rows: structuredClone(rowsFor(source.level, source)),
      currency: 'USD',
      timezone: 'UTC',
      complete: true,
      collection_complete: true,
      source_kind: 'ads',
      date_range: dates,
      warnings: [],
      lineage: [],
      captured_at: Date.now(),
      result_definition: 'Synthetic results',
      attribution: 'Synthetic click window',
      quality: {version: 2, status: 'complete'},
      ...packet,
    };
  };
  const definition = (levels, changes = {}, sourceChanges = {}) => ({
    ...f.config,
    contract_version: 'overview-config-v4',
    metrics: ['spend', 'impressions', 'clicks', 'cpc', 'cpm', 'primary_result', 'cost_per_result'],
    date_range: range,
    sources: [{...f.config.sources[0], levels, report_options: {complete_window: true}, ...sourceChanges}],
    ...changes,
  });
  const queue = (levels, changes, sourceChanges) =>
    f.overview.handle({action: 'run', confirmed: true, config: definition(levels, changes, sourceChanges)}, f.actor);
  return {
    ...f,
    definition,
    queue,
    get: id => f.overview.handle({action: 'get', id, limit: 500, include: {native: false}}, f.actor),
    stored: id => f.store.document(f.actor.tenantId, 'overview_report', id),
    job: id => f.store.db.prepare('SELECT state,attempts,error FROM jobs WHERE id=?').get(id),
    /** Makes a retry that waits for its back-off runnable now. */
    requeue: () => f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE state='queued'").run(),
    /** One run of the definition through the worker, then the snapshot as `get` returns it. */
    async go(levels = ['campaign', 'adset', 'ad'], changes = {}, sourceChanges = {}) {
      const queued = await queue(levels, changes, sourceChanges);
      await f.worker.once();
      return {
        queued,
        report: await f.overview.handle({action: 'get', id: queued.id, limit: 500, include: {native: false}}, f.actor),
        stored: f.store.document(f.actor.tenantId, 'overview_report', queued.id),
        job: f.store.db.prepare('SELECT state,attempts,error FROM jobs WHERE id=?').get(queued.job_id),
      };
    },
  };
}
