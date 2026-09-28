import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';
import type {Store} from './store.js';

/** Performs one read. A family reader handles the reads it marked and passes every other read to the next reader. */
export type Reader=(read:CompiledRequest)=>Promise<TransportResult>;

/** A read the verifier performs after execution, and the fields it expects to find. */
export interface VerificationRead {
 read:CompiledRequest;
 expected:JsonObject;
 id:string;
 /** Fields the provider echoed differently from what was sent, keyed by field. */
 acknowledged?:Record<string,{sent:unknown;echoed:unknown}>;
 /** Fields no read can observe. */
 unobservable?:string[];
}

/** Owner-policy amounts of a request, when a family computes them itself (spend-policy.ts). */
export interface PolicyAmounts {
 creating?:boolean;
 amounts:{path:string;key:string;amount:number;decimal?:string}[];
 old?:{path:string;key:string;amount:number;decimal?:string}[];
}

/**
 * One reviewed write family: everything the review lifecycle needs from it, declared next to its implementation and
 * listed in src/reviewed-families.ts. docs/ADDING-A-REVIEWED-FAMILY.md explains each stage.
 *
 * `kind` decides membership. At prepare the lifecycle calls `assert`, `scope(write=true)`, `authorize` (through
 * ScopeGuard, also for every read), `snapshots`, whose reads `reader` performs, `validateState` checks and
 * `snapshotState` keeps, then `prerequisites` and `impact`. At execute it repeats the reads, applies
 * `spendConfirmation`, the owner policy (`activates`, `destructive`, `policyAmounts`) and `outcome`. Verification
 * calls `scope(write=false)`, `verification`, `observed` and `verifiedResources`.
 *
 * Every hook except `name`, `files` and `kind` is optional. `kind`, `isRead`, `authorize` and `reader` see every
 * request and must answer false for, or pass on, requests that are not this family's; every other hook receives only
 * this family's plans and reads.
 */
export interface ReviewedFamily {
 /** Ledger family name, e.g. `google_business_lodging`. */
 readonly name:string;
 /** Implementation and tests recorded for the family in the action ledger. */
 readonly files:readonly [implementation:string,tests:readonly string[]];
 /** Truthy when this family owns the compiled mutation. Must be false for every other family's requests. */
 kind(plan:CompiledRequest):unknown;
 /** Validates the request before any network call; throws the family's refusal. */
 assert?(plan:CompiledRequest):void;
 /** Checks the connection's OAuth scopes: for writing at prepare and execute (`write` true), for reading at verification. */
 scope?(connection:Connection,write?:boolean,plan?:CompiledRequest):void;
 /** True when this family authorizes the request (its mutation or one of its reads); false to leave it to others. */
 authorize?(plan:CompiledRequest,connection:Connection,account:string,store:Store):boolean;
 /** Reads taken at prepare and repeated at execute. */
 snapshots?(plan:CompiledRequest):CompiledRequest[];
 /** True for the reads this family marked in `snapshots` or `verification`. */
 isRead?(read:CompiledRequest):boolean;
 /** Performs and projects this family's marked reads; passes every other read to `next`. */
 reader?(read:CompiledRequest,next:Reader):Promise<TransportResult>;
 /** Refuses a marked read whose result is incomplete or names another target. */
 validateState?(read:CompiledRequest,result:TransportResult):void;
 /** The state kept from a marked read, before normalization; without it, the reader's projection is kept as is. */
 snapshotState?(read:CompiledRequest,data:JsonObject):unknown;
 /** Refuses a request the read state does not allow. `state` holds the normalized snapshots in order. */
 prerequisites?(plan:CompiledRequest,state:unknown[]):void;
 /** The impact summary prepare returns for review. */
 impact?(plan:CompiledRequest,state:unknown[]):JsonObject|undefined;
 /** True when the provider response confirms every mutation of the request. */
 outcome?(plan:CompiledRequest,result:TransportResult,before:unknown[]):boolean;
 /** Reads that show the result after execution; `before` holds the snapshots taken at execute. */
 verification?(plan:CompiledRequest,result:JsonObject,before:unknown[]):VerificationRead[];
 /** Projects a marked verification read to the shape of its `expected`. */
 observed?(read:CompiledRequest,data:JsonObject):JsonObject;
 /** IDs of resources a consistent verification read proves this write created; they become readable for the account. */
 verifiedResources?(plan:CompiledRequest,actual:JsonObject):string[];
 /** When `needed`, execution requires spend_change_confirmed=true and refuses with `message` without it. */
 readonly spendConfirmation?:{needed(plan:CompiledRequest):boolean;readonly message:string|((plan:CompiledRequest)=>string)};
 /**
  * True when preflight.ts must not apply its budget/bid/spend text match to this family, because the family decides
  * its spending effect itself (`spendConfirmation`) or has none.
  */
 readonly exemptFromSpendTextMatch?:boolean;
 /** True when the request activates or widens delivery, which an owner policy with allow_activation=false forbids. */
 activates?(plan:CompiledRequest,before:unknown):boolean;
 /** True when the request deletes or removes something, which an owner policy with allow_deletion=false forbids. */
 destructive?(plan:CompiledRequest):boolean;
 /** Owner-policy amounts, when the generic budget scan cannot find them. */
 policyAmounts?(plan:CompiledRequest,before:unknown,policy:JsonObject):PolicyAmounts|undefined;
}
