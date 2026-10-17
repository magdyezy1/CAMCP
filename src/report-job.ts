import type {Store} from './store.js';
import type {TransportResult} from './transport.js';
import type {Actor, CompiledRequest, Connection, Credentials, JsonObject} from './types.js';

/**
 * The asynchronous report job contract (ARC-04 stage F): what one provider's report jobs add to the native read path.
 * A job is created by a reviewed write (amcp_write prepare and execute) and then polled or retrieved with native reads;
 * src/report-jobs.ts registers one job per gateway, and the compiler and MirrorService.runPlan consult the job of a
 * request's gateway instead of importing each provider's job module. The read path keeps control: account binding,
 * ScopeGuard, the native authority check, single send and the audit stay where they are, and reach a job as the hooks
 * of ReportJobPage. A leaf: it imports only types.
 */

/** One page a report job's read received, and the read path's own checks a job uses for the requests it adds. */
export interface ReportJobPage {
  readonly store: Store;
  readonly actor: Actor;
  /** The connection the page was read through, as resolved again after the read. */
  readonly connection: Connection;
  /** The login the read started with. */
  readonly credentials: Credentials;
  /** The page's transport result. */
  readonly result: TransportResult;
  /** ScopeGuard's authorization of a request on a connection, with a guard of its own for each call. */
  authorize(plan: CompiledRequest, connection: Connection): unknown;
  /**
   * The native authority check of the read path (src/native-authority.ts): before each attempt it runs `before`, then
   * resolves and authorizes the connection again and refuses a changed login or lost permission.
   */
  authority(plan: CompiledRequest, connection: Connection, before: () => unknown): () => Connection;
  /** Sends one request through the transport, with the authority check before the request and each attempt. */
  request(plan: CompiledRequest, authority: () => Connection): Promise<TransportResult>;
  /** The fetcher a report file download uses, or undefined for the platform's own. */
  readonly fetcher?: typeof fetch;
}

/** Reads one page of a job's read through the read path (its fetchPage). */
export type ReportJobFetch = (plan: CompiledRequest) => Promise<unknown>;
/** What a job's read returns to the read path. */
export interface ReportJobRead {
  data: any;
  pages: number;
  truncated: boolean;
}

export interface NativeReportJob {
  /** The gateway whose requests the job's hooks answer: the read path consults only the job of a request's gateway. */
  readonly gateway: string;
  /** Compiler.compile: the compiled request with the job's request controls (normalized fields, a download). */
  plan?(request: CompiledRequest, input: JsonObject): CompiledRequest;
  /** MirrorService.runPlan, before anything is sent: refuses arguments a job read does not take; the plan to run. */
  admit?(plan: CompiledRequest, input: JsonObject): CompiledRequest;
  /** Whether the read keeps its login from the first request to the last (checked around every page). */
  sameLogin?(plan: CompiledRequest): boolean;
  /** One page of a job read, before the scope observes it: its data, or a falsy value for any other read. */
  page?(plan: CompiledRequest, page: ReportJobPage): unknown;
  /** One page after the scope observed it: a downloaded report, or a falsy value for any other read. */
  observed?(plan: CompiledRequest, data: unknown, page: ReportJobPage): unknown;
  /** Runs a job read through the read path's fetchPage, or returns undefined when `plan` is not one. */
  read?(plan: CompiledRequest, fetch: ReportJobFetch, input: JsonObject): Promise<ReportJobRead> | undefined;
}
