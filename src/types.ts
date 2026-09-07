export type JsonObject = Record<string, any>;
export interface Action {
  name:string; canonical_name:string; aliases:string[]; method:string|null; path:string|null;
  read_only:boolean|null; destructive:boolean|null; required:string[]; path_parameters:string[];
  evidence:string; raw:JsonObject; gateway?:string;
}
export interface Catalog {
  gateway:string; mode:'direct'|'delegated'; api_version:string|null; reported_total:number|null;
  captured:number; complete:boolean; denominator_kind:string; actions:Action[]; gaps:string[];
}
export interface ToolDefinition { name:string; description:string; inputSchema:JsonObject; schema_evidence:string; mode:string; operations?:JsonObject[]; help:JsonObject }
export interface RegistryData { surface:string; discovery:JsonObject; tools:ToolDefinition[]; catalogs:Catalog[]; descriptions:Record<string,JsonObject>; supplemental:Action[]; provenance:JsonObject }
export interface Actor { tenantId:string; userId:string; role:'reader'|'operator'|'admin' }
export interface Connection {
  id:string; tenantId:string; gateway:string; accounts:string[]; label:string; enabled:boolean;
  baseUrl?:string; apiVersion?:string; scopes:string[]; userAgent?:string;
  resourceBindings?:{accountId:string;pathPrefix:string;query?:JsonObject}[];
  isDefault?:boolean;
  /** Explicit per-account mutation grants; absent means read-only. */
  writeAccounts?:string[];
}
export interface Credentials {
  accessToken?:string; refreshToken?:string; expiresAt?:number; clientId?:string; clientSecret?:string;
  developerToken?:string; loginCustomerId?:string; consumerKey?:string; consumerSecret?:string;
  tokenSecret?:string; apiKey?:string; username?:string; password?:string; headers?:Record<string,string>;
  redirectUri?:string;
}
export interface CompiledRequest {
  gateway:string; action:string; method:string; path:string; query:JsonObject; body?:unknown; origin?:string;
  headers:Record<string,string>; readOnly:boolean; destructive:boolean; requiresConfirmation:boolean;
  accountId?:string; evidence:string; warnings:string[]; specialTransport?:string;
  queryArrayEncoding?:'json'|'repeat';
  responseControls?:import('./projection.js').ResponseControls;
}
export interface EnhancementFlags {
  catalogEnvelope?:boolean; catalogPagination?:boolean; catalogFields?:boolean;
  dryRunSchemaDefault?:boolean; uniformIdempotency?:boolean; scopeMetadata?:boolean;
  confirmationMetadata?:boolean; nativeRequests?:boolean; largeIdGuard?:boolean; catalogPreflight?:boolean;
}
export interface CallOptions { mode:'strict'|'enhanced'; flags:EnhancementFlags }
