import type {JsonObject} from './types.js';

/**
 * The typed result of the two reporting tools (V2-MCP-02, decision 4). Every AMCP tool answers one envelope,
 * {success, data, error, meta}, and declares it as its outputSchema (server/mcp.ts); the 2026-07-28 revision requires
 * structured content to conform to the schema a tool declares, and the SDK's clients check it. The envelope is the same
 * for every tool; what these two add is the `data` object of the actions that hand a client its next step: the record's
 * `id`, the job and its `state`, the next call and the interval to poll at, and the paging fields. They are the fields
 * the actions share and a client follows; every action's own result keeps its other fields, which the schema leaves open
 * (a `get` result is open to the charts package's property, and to any field a later package adds).
 *
 * A property is typed only where every action that returns it agrees on its type, checked against the real responses of
 * every action (tests/mcp-typed-output.test.mjs), so a client that validates cannot be refused a result the server
 * sends. `rows` is not typed: a Sheets write answers `rows` as a count, and a snapshot as a list.
 */
const text = {type: 'string'},
  count = {type: 'integer'},
  nullable = (type: string) => ({type: [type, 'null']});

/** The result fields the Overview's actions share, by name. */
const overviewData: JsonObject = {
  id: text,
  state: text,
  job_id: text,
  next_call: {type: 'object'},
  poll_after_ms: count,
  has_more: {type: 'boolean'},
  next_offset: nullable('integer'),
  next_cursor: nullable('string'),
};
/** The result fields the captured-report actions share, by name. */
const reportingData: JsonObject = {
  id: text,
  has_more: {type: 'boolean'},
  next_offset: nullable('integer'),
  next_cursor: nullable('string'),
};
/** The `data` schema of a tool that types its result, by tool name; any other tool leaves `data` open. */
export const typedToolData: Readonly<Record<string, JsonObject>> = Object.freeze({
  amcp_reporting_overview: {type: 'object', properties: overviewData},
  amcp_reporting: {type: 'object', properties: reportingData},
});
