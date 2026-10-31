import {MirrorError} from './errors.js';
import {pinnedJson} from './pinned-json.js';
import type {CompiledRequest, JsonObject} from './types.js';
import type {Resolved} from './wire-contracts.js';
import type {WireIssue} from './discovery-issues.js';
import {microsoftGateway} from './microsoft-native.js';

/**
 * Microsoft Advertising's wire contract (PRV-05), moved unchanged from src/wire-contracts.ts (ARC-01, wave 4c round 6),
 * its gateway check included: the operation's request element of the pinned WSDL type model
 * (generated/microsoft-contracts.json). Its adapter declares it (hooks `wireContract`), and the wire contracts keep the
 * modes, the seal and every refusal.
 */
const record = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

// Microsoft Advertising: the pinned WSDL type model. JSON objects carry an element's fields by their XML names, a
// sequence of one unbounded element is a JSON array, and `Type` names the derived type of a polymorphic value
// (`ResponsiveSearch` for ResponsiveSearchAd, `TextAsset`), as Microsoft Learn's REST templates show.
const xs = '{http://www.w3.org/2001/XMLSchema}';
type Node = {attributes: Record<string, string>; children: Node[]; kind: string};
const local = (q: string) => q.replace(/^\{[^}]*\}/, '');
/**
 * The contract of a Microsoft Advertising request: its operation's request element, or undefined. Another gateway's
 * plan has none, whatever operation its action names.
 */
export function microsoftWireContract(plan: CompiledRequest): Resolved | undefined {
  if (plan.gateway !== microsoftGateway) return undefined;
  const model = pinnedJson<JsonObject>('generated/microsoft-contracts.json');
  const services = Object.entries(model.services as Record<string, JsonObject>).filter(
    ([, s]) => s.operations[plan.action],
  );
  if (services.length !== 1) return undefined;
  const [name, service] = services[0]!,
    schemas = service.schemas as Record<string, Node>,
    element = schemas['element:{' + service.namespace + '}' + plan.action + 'Request'];
  if (!element) return undefined;
  return {
    contract: 'microsoft-' + name + '-v13',
    vendor_method: plan.action,
    sealed: true,
    document_sha256: service.document_sha256,
    check: body => microsoftIssues(schemas, element, body),
  };
}
/** Derived complex types of each base type, built once per schema set. */
const derivedCache = new WeakMap<object, Map<string, string[]>>();
function derived(schemas: Record<string, Node>): Map<string, string[]> {
  let map = derivedCache.get(schemas);
  if (!map) {
    map = new Map();
    for (const [key, node] of Object.entries(schemas)) {
      if (!key.startsWith('complexType:')) continue;
      const base = extensionOf(node)?.attributes.base;
      if (base) map.set(base, [...(map.get(base) ?? []), key.slice('complexType:'.length)]);
    }
    derivedCache.set(schemas, map);
  }
  return map;
}
function extensionOf(node: Node): Node | undefined {
  const content = node.children.find(c => local(c.kind) === 'complexContent');
  return content?.children.find(c => local(c.kind) === 'extension');
}
/** The element children of a complex type, its bases' first. */
function elementsOf(schemas: Record<string, Node>, type: string, depth = 0): Node[] {
  const node = schemas['complexType:' + type];
  if (!node || depth > 16) return [];
  const extension = extensionOf(node),
    own: Node[] = [];
  const collect = (n: Node) => {
    for (const c of n.children)
      if (local(c.kind) === 'element') own.push(c);
      else if (['sequence', 'choice', 'all', 'complexContent', 'extension'].includes(local(c.kind))) collect(c);
  };
  collect(node);
  return [...(extension ? elementsOf(schemas, extension.attributes.base!, depth + 1) : []), ...own];
}
function microsoftIssues(schemas: Record<string, Node>, element: Node, body: unknown): WireIssue[] {
  const issues: WireIssue[] = [];
  let nodes = 0;
  const issue = (field: string, reason: string) => {
    if (issues.length < 20) issues.push({field, reason});
  };
  const scalar = (type: string, v: unknown, path: string) => {
    const name = local(type);
    if (type.startsWith(xs) || type.startsWith('{http://schemas.microsoft.com/2003/10/Serialization/}')) {
      if (
        ['long', 'int', 'short', 'byte', 'unsignedInt', 'unsignedLong', 'unsignedShort', 'unsignedByte'].includes(name)
      ) {
        if (!((typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && /^-?\d+$/.test(v))))
          issue(path, 'Expected an integer');
      } else if (['double', 'decimal', 'float'].includes(name)) {
        if (!((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v))))
          issue(path, 'Expected a number');
      } else if (name === 'boolean') {
        if (typeof v !== 'boolean') issue(path, 'Expected a boolean');
      } else if (typeof v !== 'string') issue(path, 'Expected a string');
      return;
    }
    const simple = schemas['simpleType:' + type];
    if (!simple) return;
    if (typeof v !== 'string') {
      issue(path, 'Expected a string');
      return;
    }
    const restriction = simple.children.find(c => local(c.kind) === 'restriction');
    const values = restriction?.children.filter(c => local(c.kind) === 'enumeration').map(c => c.attributes.value);
    // A list type (space-separated flags) is checked only as text.
    if (values?.length && !values.includes(v)) issue(path, 'Value absent from the pinned vendor enum');
  };
  const visit = (type: string, v: unknown, path: string, depth: number) => {
    if (++nodes > 50000 || depth > 48)
      throw new MirrorError('INVALID_VENDOR_BODY', 'Microsoft request exceeds validation bounds.');
    if (v === null || v === undefined) return;
    if (!schemas['complexType:' + type]) {
      scalar(type, v, path);
      return;
    }
    const fields = elementsOf(schemas, type);
    // A sequence of one unbounded element is an array in JSON (ArrayOfAd, ArrayOfstring).
    if (
      fields.length === 1 &&
      fields[0]!.attributes.maxOccurs === 'unbounded' &&
      !extensionOf(schemas['complexType:' + type]!)
    ) {
      if (!Array.isArray(v)) issue(path, 'Expected an array');
      else v.forEach((item, i) => visit(fields[0]!.attributes.type!, item, path + '/' + i, depth + 1));
      return;
    }
    if (!record(v)) {
      issue(path, 'Expected an object');
      return;
    }
    let actual = type;
    const subtypes = derived(schemas).get(type);
    if (subtypes && typeof v.Type === 'string') {
      const named = subtypes.filter(s => [v.Type, v.Type + local(type)].includes(local(s)));
      // Deeper derivations (an ad whose type derives from a derived type) are searched once more.
      const deeper = named.length
        ? named
        : subtypes.flatMap(s =>
            (derived(schemas).get(s) ?? []).filter(d => [v.Type, v.Type + local(type)].includes(local(d))),
          );
      if (deeper.length === 1) actual = deeper[0]!;
      else if (!elementsOf(schemas, type).some(e => e.attributes.name === 'Type'))
        issue(path + '/Type', 'Type names no derived type of ' + local(type));
    }
    const known = new Map(elementsOf(schemas, actual).map(e => [e.attributes.name!, e]));
    for (const [key, item] of Object.entries(v)) {
      const e = known.get(key);
      if (key === 'Type' && actual !== type) continue;
      if (!e) issue(path + '/' + key, 'Field absent from the pinned vendor request schema');
      else if (e.attributes.type) visit(e.attributes.type, item, path + '/' + key, depth + 1);
    }
  };
  // The request element is an anonymous complex type: its sequence lists the request's fields.
  const inline = element.children.find(c => local(c.kind) === 'complexType');
  if (!record(body)) return [{field: '', reason: 'Expected an object'}];
  const fields = new Map<string, Node>();
  const collect = (n: Node) => {
    for (const c of n.children)
      if (local(c.kind) === 'element') fields.set(c.attributes.name!, c);
      else if (['sequence', 'choice', 'all'].includes(local(c.kind))) collect(c);
  };
  if (inline) collect(inline);
  for (const [key, item] of Object.entries(body)) {
    const e = fields.get(key);
    if (!e) issue('/' + key, 'Field absent from the pinned vendor request schema');
    else if (e.attributes.type) visit(e.attributes.type, item, '/' + key, 1);
  }
  return issues;
}
