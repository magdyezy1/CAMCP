import {MirrorError} from './errors.js';
import {applyExecutionRisk} from './execution-risk.js';
import type {MirrorService} from './service.js';
import type {Actor, JsonObject} from './types.js';

export function createReportExecutor(service: MirrorService) {
  return async (tenantId: string, config: JsonObject, actor?: Actor): Promise<unknown> => {
    if (!actor || actor.tenantId !== tenantId)
      throw new MirrorError('JOB_REAUTHORIZATION_REQUIRED', 'A report must run as its authorized creator.', {}, 403);
    service.store.assertActorActive(actor);
    if (config.gateway) {
      const input = {...config.arguments};
      service.registry.validate(config.gateway, input, service.options);
      const delegated = service.registry.tools.get(config.gateway)?.mode === 'delegated';
      const plan = delegated
        ? service.delegatedCompiler.compile(config.gateway, input)
        : service.compiler.compile(config.gateway, input, service.options);
      if (!applyExecutionRisk(plan).readOnly)
        throw new MirrorError(
          'REPORT_WRITE_FORBIDDEN',
          'Reporting jobs may execute independently classified read operations only.',
        );
      const result = (await service.runPlan(
        plan,
        {...(delegated ? input.arguments : input), dry_run: false, aggregate_pages: true},
        actor,
      )) as JsonObject;
      service.store.assertActorActive(actor);
      if (result.truncated)
        throw new MirrorError(
          'REPORT_TRUNCATED',
          'Report exceeded the pagination limit. Split the query into smaller windows.',
        );
      return result;
    }
    const result = await service.call(
      'amcp_native_action',
      {operation: 'get_performance_report', arguments: config},
      actor,
    );
    service.store.assertActorActive(actor);
    if (result.success === false) throw new MirrorError(result.error.code, result.error.message, result.error.details);
    return result.data;
  };
}
