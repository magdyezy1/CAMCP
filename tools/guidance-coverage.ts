import fs from 'node:fs';
import path from 'node:path';
import {guidanceResources,readGuidance} from '../src/guidance.js';

/**
 * Guidance drifts out of date silently: the code gains a contract or a refusal, the guides keep
 * describing the old model, and nothing fails. That is how X targeting came to be documented as
 * a line-item field long after it had become a separate resource with its own preconditions.
 *
 * This is a text-presence check, deliberately. It cannot judge whether prose is correct — only
 * that a reviewed-write gateway and the refusals a caller can hit are either explained somewhere
 * an agent will read, or consciously marked as not needing explanation.
 *
 * The scope is DERIVED, not hand-listed. An earlier version named seven files, which made the
 * printed "n of n" read as complete coverage when thirty further refusals on the same path were
 * never examined. The module set is now computed by following local imports from the entry
 * points of the reviewed-write and reviewed-media paths, so a module added to either path is
 * included automatically.
 */

/** Entry points of the paths a caller reaches through amcp_write and amcp_media. */
export const writePathRoots=['write-review.ts','media-upload.ts'];

/** Gateways that can execute a reviewed write; each must be named in at least one guide. */
export const reviewedWriteGateways=[
 'meta_native_action','google_ads_native_action','tiktok_native_action','snapchat_native_action',
 'linkedin_native_action','x_ads_native_action','dv360_native_action','reddit_native_action',
 'microsoft_ads_native_action','apple_ads_native_action','ga4_native_action','gtm_native_action',
 'google_search_console_native_action','google_business_native_action',
];

/**
 * Families whose members are self-describing in their message and are surfaced with the field or
 * resource at fault. A family entry is a deliberate decision that this whole class needs no
 * separate guide prose — it is not a way of skipping the question.
 */
export const undocumentedFamilies:[RegExp,string][]=[
 [/^MEDIA_/,'Media pipeline refusals; each names the file, limit or provider state at fault and is surfaced by amcp_media.'],
 [/^STATE_/,'Internal state-verification contracts between prepare and execute; not caller-correctable.'],
 [/^OAUTH_/,'Browser OAuth flow; handled by the Connections UI, not by an agent.'],
 [/^SIGNIN_/,'Website sign-in flow; not part of the agent surface.'],
 [/^INVALID_/,'Argument, body or identifier validation; the message names the offending value.'],
 [/^MISSING_/,'A required field was absent; the message names it.'],
 [/^AUTH_/,'Credential lifecycle; resolved by reconnecting the provider, which is the user’s action.'],
 [/^CREDENTIAL/,'Credential handling; never actionable by an agent.'],
 [/^UPSTREAM_/,'Provider-side failure passed through with its own status and body.'],
 [/^PLATFORM_/,'Provider-side limit or rate control passed through.'],
 [/^REPORT_/,'Reporting contracts, covered by the reporting-overview guide.'],
 [/^SHEETS_/,'Google Sheets destination binding, covered by the reporting-overview guide.'],
 [/^DRIVE_/,'Google Drive source selection, covered by the media guide.'],
 [/^UNKNOWN_/,'An unrecognised tool, gateway, action or operation; the message names it.'],
 [/^UNAPPROVED_/,'An egress allowlist refusal; the host or URL is stated and must not be worked around.'],
 [/^UNSUPPORTED_|^UNEXPECTED_/,'A parameter or body shape outside the qualified contract; the message names it.'],
];

/**
 * Individual codes that need no guide prose, each with the reason it does not. Adding to this is
 * a decision that an agent does not need to be taught the code — the default for anything absent
 * from both the guides and this list is a failed check.
 */
const operational:[string,string[]][]=[
 ['Access control; the message states who may act and the user decides.',
  ['OWNER_REQUIRED','OWNER_LOGIN_REQUIRED','MEMBERSHIP_REVOKED','ACCOUNT_ACCESS_REVOKED','UNAUTHORIZED','FORBIDDEN','INSUFFICIENT_SCOPE','PROVIDER_WRITE_SCOPE_REQUIRED','ACCOUNT_SCOPE_MISMATCH','DEVELOPER_TOKEN_REQUIRED','CLIENT_ID_REQUIRED','OAUTH1_CREDENTIALS_REQUIRED','MICROSOFT_CUSTOMER_REQUIRED','APPLE_SIGNING_KEY_INVALID','USER_AGENT_REQUIRED','ENCRYPTION_REQUIRED','CONNECTOR_CONFIGURATION_REQUIRED','SECRET_DECRYPT_FAILED']],
 ['Deployment or server configuration, not an agent-correctable condition.',
  ['CONFIG_ERROR','INTERNAL_ERROR','SCHEMA_VERSION_MISMATCH','API_VERSION_UNAVAILABLE','DELEGATED_ROUTE_UNAVAILABLE','SPECIAL_TRANSPORT_REQUIRED','ASYNC_TRANSACTION_UNSUPPORTED','RESPONSE_TOO_LARGE','MICROSOFT_RESPONSE_FAILED','NOT_FOUND','REVISION_CONFLICT','UNSAFE_NUMERIC_ID','CONFLICTING_PARAMETER']],
 ['Transient server-side control; retried by the server or resolved by waiting, never by reshaping the request.',
  ['CIRCUIT_OPEN','TENANT_RATE_LIMIT','REFRESH_IN_PROGRESS','TOKEN_REFRESH_FAILED','STALE_JOB_LEASE','REAUTHORIZATION_REQUIRED']],
 ['Connection resolution; the agent must ask the user which account or connection is meant.',
  ['AMBIGUOUS_CONNECTION','CONNECTION_REQUIRED','ACCOUNT_REQUIRED']],
 ['Internal policy arithmetic behind the documented budget rules.',
  ['POLICY_AMOUNT_INVALID','INCOMPLETE_STATE','MUTATION_PAGINATION_FORBIDDEN','LIBRARY_REVIEW_EXISTS']],
];
export const undocumentedCodes=new Map<string,string>(operational.flatMap(([reason,codes])=>codes.map(c=>[c,reason] as [string,string])));

/** Modules reachable from the write-path roots by following local imports. */
export function writePathModules(root='src'){
 const seen=new Set<string>();
 const visit=(file:string)=>{
  if(seen.has(file))return;
  const full=path.join(root,file);
  if(!fs.existsSync(full))return;
  seen.add(file);
  for(const m of fs.readFileSync(full,'utf8').matchAll(/from '\.\/([A-Za-z0-9._-]+)\.js'/g))visit(m[1]!+'.ts');
 };
 for(const entry of writePathRoots)visit(entry);
 return [...seen].sort();
}

export function guidanceCoverage(root='src'){
 const guides=guidanceResources.map(r=>readGuidance(r.uri).text).join('\n');
 const modules=writePathModules(root);
 const codes=new Set<string>();
 for(const file of modules)
  for(const m of fs.readFileSync(path.join(root,file),'utf8').matchAll(/(?:new MirrorError\(|fail\()'([A-Z][A-Z0-9_]{3,})'/g))codes.add(m[1]!);
 const family=(c:string)=>undocumentedFamilies.find(([pattern])=>pattern.test(c));
 const documented=[...codes].filter(c=>guides.includes(c));
 const undeclared=[...codes].filter(c=>!guides.includes(c)&&!undocumentedCodes.has(c)&&!family(c)).sort();
 const stale=[...undocumentedCodes.keys()].filter(c=>!codes.has(c)).sort();
 return {
  guides:guidanceResources.length,
  reviewed_write_gateways:reviewedWriteGateways.length,
  modules:modules.length,
  write_path_codes:codes.size,
  documented_codes:documented.length,
  family_codes:[...codes].filter(c=>!guides.includes(c)&&!undocumentedCodes.has(c)&&!!family(c)).length,
  listed_codes:[...codes].filter(c=>!guides.includes(c)&&undocumentedCodes.has(c)).length,
  missing_gateways:reviewedWriteGateways.filter(g=>!guides.includes(g)),
  undeclared_codes:undeclared,
  stale_allowlist:stale,
 };
}

export function assertGuidanceCoverage(root='src'){
 const c=guidanceCoverage(root);
 const problems:string[]=[];
 if(c.missing_gateways.length)problems.push('These gateways accept reviewed writes but are named in no guide: '+c.missing_gateways.join(', ')+'. Document the gateway or remove its write contract.');
 if(c.undeclared_codes.length)problems.push('These refusals on the reviewed-write path appear in no guide and match no entry in tools/guidance-coverage.ts: '+c.undeclared_codes.join(', ')+'. Document what raises each one, or add it to undocumentedCodes/undocumentedFamilies with a reason.');
 if(c.stale_allowlist.length)problems.push('These codes are listed as needing no documentation but are no longer raised anywhere on the write path: '+c.stale_allowlist.join(', ')+'. Remove them.');
 if(problems.length)throw new Error('Guidance is out of step with the code.\n- '+problems.join('\n- '));
 return c;
}
