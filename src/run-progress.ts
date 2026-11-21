import {AsyncLocalStorage} from 'node:async_hooks';

/**
 * Where a plan run reports its progress while it runs (R2.5 field3, AMCP-12). A `run` of an approved plan is one request that can last
 * up to 25 seconds and a step more, so a client that sent a progress token is told, as each step settles, how far the plan has come
 * ("step 3 of 10 verified"), as a `notifications/progress` on that request's own stream (server/mcp-progress.ts `runProgressSink`,
 * which the MCP server runs the call in). A call made without a token runs in no scope: nothing here is called for it, and a run
 * is what it always was.
 *
 * The runner only says what happened; what a sink does with it (send it, drop it, stop for a client that went away) is the sink's.
 * A sink can never change a run: it is called, its answer is not read, and what it throws is not seen. A leaf: it imports nothing
 * of the service, so the runner and the MCP server can both import it.
 */
export interface RunProgressPoint {
  /** The steps settled so far: the progress value, which only grows over a run. */
  progress: number;
  /** The steps of the plan. */
  total: number;
  /** A few words: "step 3 of 10 verified". */
  message: string;
}
export type RunProgressSink = (point: RunProgressPoint) => void;
const sinks = new AsyncLocalStorage<RunProgressSink>();

/** Runs `run`, and everything it awaits, with `sink` to hear of each step of a plan run that it makes. */
export const withRunProgress = <T>(sink: RunProgressSink, run: () => T): T => sinks.run(sink, run);
/** Whether a client is listening for this run's progress: a run reads its plan to word a point only when one is. */
export const runProgressWanted = (): boolean => sinks.getStore() !== undefined;
/** Tells the client of the call in flight, if it asked, that a step settled. Never throws and never waits. */
export function reportRunProgress(point: RunProgressPoint): void {
  try {
    sinks.getStore()?.(point);
  } catch {
    // A notification is a courtesy to the client: whatever happens to it never reaches the plan.
  }
}
