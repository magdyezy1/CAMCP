import {setTimeout as delay} from 'node:timers/promises';
import {sqliteDiagnostic, type SqliteDiagnostic} from './sqlite-diagnostics.js';
export type WorkerStage = 'schedule' | 'email_delivery' | 'job';
export type WorkerStageFailure = {
  event: 'worker_stage_failed';
  stage: WorkerStage;
  code: string;
  consecutive_failures: number;
  at: string;
  database?: SqliteDiagnostic;
};
type WorkerLoop = {
  schedule: () => void;
  deliverEmails: () => Promise<unknown>;
  work: () => Promise<boolean>;
  shouldStop: () => boolean;
  onFailure: (failure: WorkerStageFailure) => void;
  onceOnly?: boolean;
  pause?: (milliseconds: number) => Promise<unknown>;
};
export async function runWorkerLoop(options: WorkerLoop): Promise<void> {
  let consecutiveFailures = 0;
  while (!options.shouldStop()) {
    let stage: WorkerStage = 'schedule',
      worked = false;
    try {
      options.schedule();
      if (options.shouldStop()) return;
      stage = 'email_delivery';
      await options.deliverEmails();
      if (options.shouldStop()) return;
      stage = 'job';
      worked = await options.work();
      consecutiveFailures = 0;
    } catch (error) {
      const database = sqliteDiagnostic(error);
      const code =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        /^[A-Z_0-9]{1,80}$/.test(error.code)
          ? error.code
          : 'WORKER_STAGE_FAILED';
      // Keep the diagnostic metadata-only; exception messages can contain native arguments or credentials.
      options.onFailure({
        event: 'worker_stage_failed',
        stage,
        code,
        consecutive_failures: ++consecutiveFailures,
        at: new Date().toISOString(),
        ...(database ? {database} : {}),
      });
      if (options.onceOnly) throw error;
    }
    if (options.onceOnly || options.shouldStop()) return;
    if (!worked) await (options.pause ?? delay)(1000);
  }
}
