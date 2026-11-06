// Replay of a recorded exchange (F-L4-05). A fixture holds the requests a real client sent, byte for byte but for the
// values the server issues during the exchange (a registration's client id, a consent request, a code, tokens), which
// are {{placeholders}} that the replay fills from the answers it gets. What the server answered is kept as the shape of
// its JSON, so the replay fails when a client of that era would no longer be understood, not when a sentence changes.

const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
/** Strings longer than this are prose and are kept as `<text>`; shorter ones (codes, names, URLs) are compared whole. */
export const maxExactText = 100;
/** The response headers a client of that era acts on; every other header is the server's own business. */
const comparedHeaders = [
  'content-type',
  'www-authenticate',
  'allow',
  'cache-control',
  'location',
  'access-control-allow-origin',
];

/** `text` with every captured value replaced by its {{name}}, longest first so a value cannot split another. */
export function hide(text, values) {
  let out = text;
  for (const [name, value] of Object.entries(values).sort((a, b) => b[1].length - a[1].length))
    if (value) out = out.replaceAll(value, '{{' + name + '}}');
  return out;
}
/** `text` with every {{name}} replaced by its value; a placeholder without a value is a broken fixture. */
export function fill(text, values) {
  return text.replace(/\{\{([a-z0-9_]+)\}\}/g, (match, name) => {
    if (!Object.hasOwn(values, name)) throw Error('The exchange has no value yet for ' + match);
    return values[name];
  });
}
/** The shape of a JSON value: its keys and types to `depth` levels, short strings whole, prose, ids and times masked. */
export function shapeOf(value, depth = 5, level = 0, key = '') {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return /(?:_at|Ms)$/.test(key) ? '<time>' : value;
  if (typeof value === 'string') {
    const text = value.replace(uuid, '<uuid>').replace(/\+sha256\.[0-9a-f]{12}/g, '+sha256.<build>');
    return text.length > maxExactText ? '<text>' : text;
  }
  if (Array.isArray(value)) {
    if (level >= depth) return '<array>';
    const first = value.length ? [shapeOf(value[0], depth, level + 1)] : [];
    return value.length > 1 ? [...first, '<more>'] : first;
  }
  if (level >= depth) return '<object>';
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, shapeOf(item, depth, level + 1, name)]));
}
/** What a replay compares of one answer: the status, the headers a client acts on, and the body's shape. */
export function answerShape({status, headers, text}, values, depth) {
  const kept = {};
  for (const name of comparedHeaders) {
    const raw = headers.get(name);
    if (raw === null) continue;
    // A media type is compared without its charset: the SDK's transport and Express spell it differently.
    kept[name] = hide(name === 'content-type' ? raw.split(';')[0].trim().toLowerCase() : raw, values);
  }
  const hidden = hide(text, values);
  let body = hidden;
  if (/json/.test(kept['content-type'] ?? '') && hidden) body = shapeOf(JSON.parse(hidden), depth);
  else if (hidden.length > 300) body = '<text>';
  return {status, headers: kept, body};
}
/** One value out of an answer, named by a step's `capture` entry: {from: 'body'|'header', path|name, param?}. */
export function captured(spec, {headers, text}) {
  let value;
  if (spec.from === 'header') value = headers.get(spec.name);
  else {
    value = JSON.parse(text);
    for (const part of spec.path) value = value?.[part];
  }
  if (spec.cookie) value = String(value).split(';')[0];
  if (spec.param) value = new URL(value, 'https://placeholder.invalid').searchParams.get(spec.param);
  if (typeof value !== 'string' || !value) throw Error('Nothing to capture for ' + JSON.stringify(spec));
  return value;
}
