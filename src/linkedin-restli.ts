import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';

// Protocol 2.0 encodes scalar values, not List/record punctuation. URLSearchParams
// encodes that punctuation too, turning a finder structure into a scalar string.
// https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/protocol-version
const encode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const invalid = (): never => {
  throw new MirrorError(
    'INVALID_RESTLI_QUERY',
    'Use native JSON arrays/objects or a well-formed REST.li List/record. Encode reserved punctuation inside scalar values.',
  );
};
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

function parse(value: string): unknown {
  let at = 0,
    nodes = 0;
  const scalar = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return invalid();
    }
  };
  const read = (depth: number): unknown => {
    if (depth > 20 || ++nodes > 4096) invalid();
    if (value.startsWith('List(', at)) {
      at += 5;
      const list: unknown[] = [];
      if (value[at] === ')') {
        at++;
        return list;
      }
      while (at < value.length) {
        list.push(read(depth + 1));
        if (value[at] === ')') {
          at++;
          return list;
        }
        if (value[at++] !== ',') invalid();
      }
      return invalid();
    }
    if (value[at] === '(') {
      at++;
      const record: JsonObject = Object.create(null);
      if (value[at] === ')') {
        at++;
        return record;
      }
      while (at < value.length) {
        const start = at;
        while (at < value.length && !':,()'.includes(value[at]!)) at++;
        if (value[at++] !== ':') invalid();
        const key = scalar(value.slice(start, at - 1));
        if (!key || forbidden.has(key) || Object.hasOwn(record, key)) invalid();
        record[key] = read(depth + 1);
        if (value[at] === ')') {
          at++;
          return record;
        }
        if (value[at++] !== ',') invalid();
      }
      return invalid();
    }
    const start = at;
    while (at < value.length && value[at] !== ',' && value[at] !== ')') {
      if (value[at] === '(') invalid();
      at++;
    }
    if (start === at) invalid();
    return scalar(value.slice(start, at));
  };
  const result = read(0);
  if (at !== value.length) invalid();
  return result;
}

export function parseLinkedInValue(value: string): unknown {
  if (value.length > 65536) invalid();
  if (/^(?:List%28|%28)/i.test(value)) {
    try {
      value = decodeURIComponent(value);
    } catch {
      invalid();
    }
  }
  return parse(value);
}

export function linkedinQuery(query: JsonObject): string {
  let nodes = 0;
  const serialize = (v: unknown, depth = 0): string => {
    if (depth > 20 || ++nodes > 4096) invalid();
    if (Array.isArray(v)) return 'List(' + v.map(x => serialize(x, depth + 1)).join(',') + ')';
    if (v && typeof v === 'object')
      return (
        '(' +
        Object.entries(v)
          .map(([key, x]) => {
            if (!key || forbidden.has(key) || x === undefined || x === null) invalid();
            return encode(key) + ':' + serialize(x, depth + 1);
          })
          .join(',') +
        ')'
      );
    if (typeof v === 'number' && (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v)))) invalid();
    if (!['string', 'number', 'boolean'].includes(typeof v)) invalid();
    return encode(String(v));
  };
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, input]) => {
      let value = input;
      if (typeof value === 'string') {
        if (value.length > 65536) invalid();
        // Preserve the old string interface, including one layer of whole-expression encoding.
        if (/^(?:List%28|%28)/i.test(value)) {
          try {
            value = decodeURIComponent(value);
          } catch {
            invalid();
          }
        }
        if (value.startsWith('List(') || value.startsWith('(')) value = parse(value);
      }
      // Field selectors use projection grammar, rather than one scalar field name.
      // Keep its documented delimiters; query separators and percent-encoded leaves stay escaped.
      // https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/projections
      if (key === 'fields' && typeof value === 'string') {
        if (++nodes > 4096) invalid();
        const projection = encode(value)
          .replace(/%(?:2C|3A|28|29|2A)/g, token => decodeURIComponent(token))
          .replace(/%24(?=\*)/g, '$');
        return encode(key) + '=' + projection;
      }
      return encode(key) + '=' + serialize(value);
    });
  const result = parts.join('&');
  if (result.length > 65536) invalid();
  return result;
}
