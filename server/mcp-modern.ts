import type {IncomingHttpHeaders, ServerResponse} from 'node:http';
import {
  createMcpHandler,
  SUPPORTED_PROTOCOL_VERSIONS,
  type AuthInfo,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import {MirrorError} from '../src/errors.js';
import type {Actor, JsonObject} from '../src/types.js';
import {
  createMcpServer,
  mcpCacheHints,
  mcpServerCapabilities,
  mcpServerIcons,
  mcpServerInfo,
  type McpIcon,
  type McpServerHooks,
} from './mcp.js';
import type {MirrorService} from '../src/service.js';
import {serverInstructionsFor} from '../src/tool-annotations.js';

/**
 * MCP revision 2026-07-28 next to the legacy revisions (MCP-03 phase 3, V2-MCP-13). The SDK's strict
 * `createMcpHandler` serves the revision: it builds one server per request from AMCP's factory, dispatches the
 * request to the same tool, resource and prompt handlers the legacy transport uses, and frames the result itself
 * (`resultType`, the server identity, and the caching hints of the server's `cacheHints`, which AMCP sets in
 * server/mcp.ts for HTTP and stdio alike). What AMCP keeps in front of it is what the SDK does not do the way AMCP's
 * published contract needs; docs/DECISIONS.md records each with its measurement:
 * - the ingress checks, whose refusals carry AMCP's code and the offending header in the error data:
 *   - every request carries its version in `params._meta` and the `MCP-Protocol-Version` header, with `Mcp-Method` and,
 *     for tools/call, resources/read and prompts/get, `Mcp-Name` mirroring the body; a mismatch is 400 with -32020;
 *   - an unsupported version is 400 with -32022 and the supported versions; an unknown method is 404 with -32601;
 *   - a notification is checked for its version and its `Mcp-Method` and then accepted without a body;
 * - `server/discover`, which names every revision this endpoint serves (the SDK's own answer names only the modern one)
 *   and the deployment's instructions.
 * An SDK answer is returned as it is: AMCP does not parse, re-frame or re-stamp it. A request is modern when its
 * header or `_meta` names a version that is not a legacy one; `initialize` and every other request stay with the SDK's
 * legacy transport. The handler runs at /mcp/next, and at /mcp too once the owner sets AMCP_MCP_MODERN_PROTOCOL=on
 * after the client checks of ACC-02.
 */
export const modernProtocolVersions: readonly string[] = ['2026-07-28'];
/** The legacy revisions the SDK's transport serves (initialize handshake). */
export const legacyProtocolVersions: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;
/** Every revision a dual-era endpoint serves, modern first. */
export const dualEraProtocolVersions: readonly string[] = [...modernProtocolVersions, ...legacyProtocolVersions];
/** AMCP_MCP_MODERN_PROTOCOL: `off` (default), `next` (dual-era at /mcp/next only) or `on` (at /mcp as well). */
export const modernProtocolModes = ['off', 'next', 'on'] as const;
export type ModernProtocolMode = (typeof modernProtocolModes)[number];

const versionKey = 'io.modelcontextprotocol/protocolVersion',
  capabilitiesKey = 'io.modelcontextprotocol/clientCapabilities',
  serverInfoKey = 'io.modelcontextprotocol/serverInfo';
/**
 * The methods served in the modern era, and the body field `Mcp-Name` mirrors. Any other method is 404 with -32601. The
 * tasks extension adds the three methods of a task (server/mcp-tasks.ts), named by their task, and not `tasks/list`, which
 * it does not have.
 */
const modernMethods: Record<string, {name?: 'name' | 'uri' | 'taskId'}> = {
  'server/discover': {},
  'tools/list': {},
  'tools/call': {name: 'name'},
  'resources/list': {},
  'resources/templates/list': {},
  'resources/read': {name: 'uri'},
  'prompts/list': {},
  'prompts/get': {name: 'name'},
  'tasks/get': {name: 'taskId'},
  'tasks/update': {name: 'taskId'},
  'tasks/cancel': {name: 'taskId'},
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether a POST belongs to the modern era: not `initialize` (which selects legacy semantics), and its
 * MCP-Protocol-Version header or `params._meta` names something other than a legacy revision. Everything else, a
 * request without either included, keeps the SDK's legacy behavior.
 */
export function isModernRequest(headers: IncomingHttpHeaders, body: unknown): boolean {
  if (!isObject(body) || body.method === 'initialize') return false;
  const header = headers['mcp-protocol-version'],
    meta = isObject(body.params) && isObject(body.params._meta) ? body.params._meta[versionKey] : undefined;
  return [header, meta].some(v => v !== undefined && !(typeof v === 'string' && legacyProtocolVersions.includes(v)));
}

/** A header value, decoded from the `=?base64?…?=` form when it uses it; undefined when missing or repeated. */
export function mirroredHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return;
  const encoded = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (!encoded) return value;
  const decoded = Buffer.from(encoded[1]!, 'base64');
  // Only canonical base64 of valid UTF-8 is accepted, so two spellings cannot name one value.
  if (decoded.toString('base64') !== encoded[1]) return;
  const text = new TextDecoder('utf-8', {fatal: true});
  try {
    return text.decode(decoded);
  } catch {
    return;
  }
}

// Fixed sentences with the specifics in details, so the Arabic inventory tracks each reason (tools/check-locales.mjs).
const headerMismatch = (header: string) =>
  new MirrorError(
    'MCP_HEADER_MISMATCH',
    'The MCP request headers are missing or do not match the request body. Send MCP-Protocol-Version and Mcp-Method, and Mcp-Name for tools/call, resources/read and prompts/get, equal to the body.',
    {header},
    400,
  );
const invalidRequest = () =>
  new MirrorError(
    'MCP_REQUEST_INVALID',
    'The body must be one JSON-RPC 2.0 request with a string or integer id, or one notification.',
    {},
    400,
  );

/**
 * The `server/discover` result: the same capabilities and instructions as the legacy `initialize` answer, whose
 * instructions follow the deployment's mode (a read-only deployment has its own).
 */
export function discoverResult(instructions: string): JsonObject {
  return {
    supportedVersions: [...dualEraProtocolVersions],
    capabilities: mcpServerCapabilities('modern'),
    instructions,
  };
}

/** The protocol version of a request: the header, which must be present and one this endpoint serves. */
function requestedVersion(headers: IncomingHttpHeaders): string {
  const header = headers['mcp-protocol-version'];
  if (typeof header !== 'string') throw headerMismatch('MCP-Protocol-Version');
  if (!dualEraProtocolVersions.includes(header))
    throw new MirrorError(
      'MCP_PROTOCOL_UNSUPPORTED',
      'This MCP protocol version is not supported. Retry with a version from the supported list.',
      {supported: [...dualEraProtocolVersions], requested: header.slice(0, 64)},
      400,
    );
  return header;
}

/**
 * Validates a modern request against its headers, or throws the protocol error the revision requires. Order: the
 * version header, then the version in `_meta`, then the required `_meta` fields, then `Mcp-Method`, the method itself
 * and `Mcp-Name`. The SDK validates the envelope again and answers in its own terms; these checks stay because their
 * refusals carry AMCP's code and the offending header (`data.code`, `data.header`), which clients and the conformance
 * tests rely on (tests/mcp-client-conformance.test.ts).
 */
function validate(headers: IncomingHttpHeaders, message: JsonObject): void {
  const header = requestedVersion(headers);
  const params = message.params === undefined ? {} : message.params;
  if (!isObject(params)) throw new MirrorError('MCP_PARAMS_INVALID', 'The request params must be an object.', {}, 400);
  const meta = isObject(params._meta) ? params._meta : {};
  if (meta[versionKey] === undefined || !isObject(meta[capabilitiesKey]))
    throw new MirrorError(
      'MCP_PARAMS_INVALID',
      'Requests of protocol 2026-07-28 must carry io.modelcontextprotocol/protocolVersion and io.modelcontextprotocol/clientCapabilities in params._meta.',
      {required: [versionKey, capabilitiesKey]},
      400,
    );
  // A legacy header with a modern `_meta` (or the reverse) is a mismatch; legacy in both never reaches this handler.
  if (meta[versionKey] !== header) throw headerMismatch('MCP-Protocol-Version');
  if (headers['mcp-method'] !== message.method) throw headerMismatch('Mcp-Method');
  const method = modernMethods[message.method as string];
  if (!method)
    throw new MirrorError(
      'MCP_METHOD_NOT_FOUND',
      'This MCP method is not available.',
      {method: String(message.method).slice(0, 100)},
      404,
    );
  if (method.name && mirroredHeader(headers['mcp-name']) !== params[method.name]) throw headerMismatch('Mcp-Name');
}

/** A notification has no answer and no method table: AMCP checks its version and `Mcp-Method`, then accepts it. */
function validateNotification(headers: IncomingHttpHeaders, message: JsonObject): void {
  requestedVersion(headers);
  if (headers['mcp-method'] !== message.method) throw headerMismatch('Mcp-Method');
}

/** What AMCP hands the SDK with each request, through `authInfo.extra`: whose request it is and its in-flight tracker. */
export function modernAuthInfo(actor: Actor, track?: McpServerHooks['track']): AuthInfo {
  // The bearer token stays with AMCP: the SDK is told who the caller is, never the credential.
  return {token: '', clientId: actor.userId, scopes: [], extra: {actor, track}};
}

/**
 * The SDK factory of a deployment: one server per request, made for the caller `authInfo` names. A request without
 * a caller is refused rather than served with a default, so no handler can run without an actor.
 */
export function modernServerFactory(service: MirrorService): McpServerFactory {
  return context => {
    const extra = context.authInfo?.extra;
    if (!isObject(extra) || !isObject(extra.actor))
      throw new Error('A modern MCP request needs the caller AMCP authenticated.');
    return createMcpServer(service, extra.actor as unknown as Actor, {
      era: context.era,
      ...(typeof extra.track === 'function' ? {track: extra.track as McpServerHooks['track']} : {}),
    });
  };
}

/** One modern POST as AMCP receives it: the Web request, the parsed JSON-RPC message, and the caller. */
export interface ModernCall {
  headers: IncomingHttpHeaders;
  message: unknown;
  authInfo: AuthInfo;
}
export interface ModernEndpoint {
  /**
   * Answers one modern request: AMCP's own refusal (thrown as MirrorError, which the /mcp error handler writes as a
   * JSON-RPC error with its status), its `server/discover` answer, a 202 for a notification, or the SDK handler's
   * answer as it is.
   */
  handle(request: Request, call: ModernCall): Promise<Response>;
  /** Aborts the exchanges in flight and closes their servers. */
  close(): Promise<void>;
}
/**
 * The modern endpoint of one deployment: AMCP's ingress checks in front of one strict SDK handler built here, once
 * (`legacy: 'reject'`: the earlier revisions are served by AMCP's own transport, never by this handler). `instructions`
 * is the deployment's orientation, which `server/discover` reports as `initialize` does; there is no default, so an
 * endpoint can never answer with another mode's text, which could send a read-only deployment's client to
 * prepare and execute. `icons` are the deployment's own, which `server/discover` offers in its server information and no other
 * answer carries (V2-MCP-06).
 */
export function createModernEndpoint(options: {
  factory: McpServerFactory;
  instructions: string;
  icons?: McpIcon[];
  onerror?: (error: Error) => void;
}): ModernEndpoint {
  if (typeof options.instructions !== 'string' || !options.instructions)
    throw new Error('A modern MCP endpoint needs the instructions of its deployment.');
  const handler = createMcpHandler(options.factory, {
    legacy: 'reject',
    ...(options.onerror ? {onerror: options.onerror} : {}),
  });
  return {
    async handle(request, {headers, message, authInfo}) {
      if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw invalidRequest();
      // A notification is accepted without a response; this revision defines none on Streamable HTTP, and AMCP needs none.
      if (!('id' in message)) {
        validateNotification(headers, message);
        return new Response(null, {status: 202});
      }
      if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id))) throw invalidRequest();
      validate(headers, message);
      if (message.method === 'server/discover')
        // AMCP's own answer, so AMCP frames it: the same stamps the SDK puts on the results it builds.
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            ...discoverResult(options.instructions),
            resultType: 'complete',
            ...mcpCacheHints['server/discover'],
            _meta: {[serverInfoKey]: mcpServerInfo(options.icons)},
          },
        });
      return handler.fetch(request, {authInfo, parsedBody: message});
    },
    close: () => handler.close(),
  };
}

/**
 * Writes a modern answer (a Web response) to a Node response: the status, the headers the response does not have yet
 * (AMCP's security headers, set by its middleware, stay as set), and the body as it comes, honouring backpressure. The
 * body is one JSON document, or an event stream when a handler sent progress or other messages before its result
 * (the endpoint's handler answers in whichever form the request needs). A client that goes away stops the write.
 */
export async function sendModernResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) if (!res.hasHeader(name)) res.setHeader(name, value);
  if (response.body === null) {
    res.end();
    return;
  }
  // Waits for the socket to take more, or for the client to go away (a closed socket never drains).
  const drained = () =>
    new Promise<void>(resolve => {
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        resolve();
      };
      res.once('drain', done);
      res.once('close', done);
    });
  try {
    for await (const chunk of response.body) {
      if (res.destroyed) break;
      if (res.write(chunk) === false) await drained();
    }
  } catch {
    // The client went away mid-stream: nothing more to send.
  }
  res.end();
}

/**
 * The modern endpoint of a deployment's service: the SDK builds each request's server for its authenticated caller. `origin` is
 * the deployment's public origin, when it has one: its icon is offered at that address, and a deployment without one offers none.
 */
export const createDeploymentEndpoint = (service: MirrorService, onerror?: (error: Error) => void, origin?: string) =>
  createModernEndpoint({
    factory: modernServerFactory(service),
    instructions: serverInstructionsFor(service.policy),
    ...(origin ? {icons: mcpServerIcons(origin)} : {}),
    ...(onerror ? {onerror} : {}),
  });
