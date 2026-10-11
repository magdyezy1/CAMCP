import type {IncomingHttpHeaders} from 'node:http';
import type {Server} from '@modelcontextprotocol/sdk/server/index.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {SUPPORTED_PROTOCOL_VERSIONS, type JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
import {MirrorError} from '../src/errors.js';
import {serverInstructions} from '../src/tool-annotations.js';
import type {JsonObject} from '../src/types.js';
import {mcpServerCapabilities, mcpServerInfo} from './mcp.js';

/**
 * MCP revision 2026-07-28 next to the legacy revisions (MCP-03 phase 3). The bundled SDK (1.32.1, the v1 line) speaks
 * only the initialize-based revisions up to 2025-11-25; its v2 line adds 2026-07-28 but is a dependency change the
 * owner has not approved. This module serves the modern revision on top of the same per-request MCP server, so both
 * eras share every handler, check and envelope; only the framing differs:
 * - every request carries its version in `params._meta` and the `MCP-Protocol-Version` header, with `Mcp-Method` and,
 *   for tools/call, resources/read and prompts/get, `Mcp-Name` mirroring the body; a mismatch is 400 with -32020;
 * - an unsupported version is 400 with -32022 and the supported versions; an unknown method is 404 with -32601;
 * - `server/discover` reports the versions, capabilities, server identity and instructions;
 * - results carry `resultType` and the server identity, and list and read results carry caching hints (`private`,
 *   since what is listed depends on the caller's role).
 * A request is modern when its header or `_meta` names a version that is not a legacy one; `initialize` and every
 * other request stay with the SDK's legacy transport. The handler runs at /mcp/next, and at /mcp too once the owner
 * sets AMCP_MCP_MODERN_PROTOCOL=on after the client checks of ACC-02.
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
  clientInfoKey = 'io.modelcontextprotocol/clientInfo',
  serverInfoKey = 'io.modelcontextprotocol/serverInfo';
/** Per-request protocol fields of `_meta` that the shared handlers do not read. */
const requestFields = new Set([versionKey, capabilitiesKey, clientInfoKey, 'io.modelcontextprotocol/logLevel']);
/** Caching hints: lists and guides change only with a release, but what a caller sees depends on their role. */
const privateList = {ttlMs: 300000, cacheScope: 'private'} as const;
/** The methods served in the modern era, the body field `Mcp-Name` mirrors, and the caching hints of the result. */
const modernMethods: Record<
  string,
  {name?: 'name' | 'uri'; cache?: {ttlMs: number; cacheScope: 'public' | 'private'}}
> = {
  'server/discover': {cache: {ttlMs: 3600000, cacheScope: 'public'}},
  'tools/list': {cache: privateList},
  'tools/call': {name: 'name'},
  'resources/list': {cache: privateList},
  'resources/templates/list': {cache: privateList},
  'resources/read': {name: 'uri', cache: privateList},
  'prompts/list': {cache: privateList},
  'prompts/get': {name: 'name'},
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
 * One request handed to the shared MCP server and its one response taken back. Request-scoped notifications (progress
 * and log messages) are not forwarded: a modern request is answered with a single JSON object. When the connection
 * closes first (the client went away), the SDK aborts the handler and sends nothing, so the exchange ends with the
 * SDK's connection-closed error instead of waiting for good.
 */
class SingleExchange implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private reply?: (message: JsonObject) => void;
  private id?: unknown;
  async start() {}
  async close() {
    this.onclose?.();
    this.reply?.({jsonrpc: '2.0', id: this.id as string, error: {code: -32000, message: 'Connection closed'}});
  }
  async send(message: JSONRPCMessage) {
    if ('id' in message && ('result' in message || 'error' in message)) this.reply?.(message as JsonObject);
  }
  exchange(request: JsonObject): Promise<JsonObject> {
    return new Promise(resolve => {
      // The first answer wins: a response, or the closed connection.
      this.reply = message => {
        this.reply = undefined;
        resolve(message);
      };
      this.id = request.id;
      this.onmessage?.(request as JSONRPCMessage);
    });
  }
}

/** The `server/discover` result: the same capabilities and instructions as the legacy `initialize` answer. */
export function discoverResult(): JsonObject {
  return {
    supportedVersions: [...dualEraProtocolVersions],
    capabilities: mcpServerCapabilities(),
    instructions: serverInstructions,
  };
}

/**
 * Validates a modern request against its headers and returns the method's entry, or throws the protocol error the
 * revision requires. Order: the version header, then the version in `_meta`, then the required `_meta` fields, then
 * `Mcp-Method`, the method itself and `Mcp-Name`.
 */
function validate(headers: IncomingHttpHeaders, message: JsonObject) {
  const header = headers['mcp-protocol-version'];
  if (typeof header !== 'string') throw headerMismatch('MCP-Protocol-Version');
  if (!dualEraProtocolVersions.includes(header))
    throw new MirrorError(
      'MCP_PROTOCOL_UNSUPPORTED',
      'This MCP protocol version is not supported. Retry with a version from the supported list.',
      {supported: [...dualEraProtocolVersions], requested: header.slice(0, 64)},
      400,
    );
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
  return {method, params, meta};
}

/**
 * Serves one modern request with the per-request MCP server `server` (already holding the caller's actor and the
 * in-flight tracking). Protocol refusals are thrown as MirrorError for the /mcp error handler, which writes them as
 * JSON-RPC errors with their status; handler errors are answered like the legacy transport does, with HTTP 200.
 */
export async function serveModernRequest(
  server: Server,
  headers: IncomingHttpHeaders,
  message: unknown,
): Promise<{status: number; body?: JsonObject}> {
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw invalidRequest();
  // A notification is accepted without a response; this revision defines none on Streamable HTTP, and AMCP needs none.
  if (!('id' in message)) return {status: 202};
  if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id))) throw invalidRequest();
  const {method, params, meta} = validate(headers, message),
    identity = {[serverInfoKey]: mcpServerInfo()};
  let response: JsonObject;
  if (message.method === 'server/discover') response = {jsonrpc: '2.0', id: message.id, result: discoverResult()};
  else if (message.method === 'resources/templates/list')
    response = {jsonrpc: '2.0', id: message.id, result: {resourceTemplates: []}};
  else {
    const rest = Object.fromEntries(Object.entries(params).filter(([key]) => key !== '_meta')),
      forwarded = Object.fromEntries(Object.entries(meta).filter(([key]) => !requestFields.has(key))),
      transport = new SingleExchange();
    await server.connect(transport);
    response = await transport.exchange({
      jsonrpc: '2.0',
      id: message.id,
      method: message.method,
      params: Object.keys(forwarded).length ? {...rest, _meta: forwarded} : rest,
    });
  }
  if (isObject(response.error)) {
    // 2026-07-28 reports an unknown resource with -32602; -32002 belongs to the earlier revisions.
    const error = response.error.code === -32002 ? {...response.error, code: -32602} : response.error;
    return {status: 200, body: {jsonrpc: '2.0', id: message.id, error}};
  }
  const result = isObject(response.result) ? response.result : {};
  return {
    status: 200,
    body: {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        ...result,
        resultType: 'complete',
        ...(method.cache ?? {}),
        _meta: {...(isObject(result._meta) ? result._meta : {}), ...identity},
      },
    },
  };
}
