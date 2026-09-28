import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {googleVersion} from './google-protos.mjs';

// Rebuilds the protobuf descriptors the Google Ads legacy adapter validates against (src/google-legacy-mapping.json,
// googleProto) from public googleapis protos in --source-dir (the googleapis tree layout: google/ads/googleads/vNN/…).
// Offline: it never uses the network or credentials. --check fails when the pinned descriptors differ.
const argument = (name, fallback) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const directory = argument('--source-dir'),
  version = argument('--version', googleVersion),
  output = 'src/google-legacy-mapping.json';
if (!directory) throw Error('Supply --source-dir containing the public googleapis Google Ads ' + version + ' protos.');

/** Identifiers (a type may continue on the next line with a leading dot), strings and punctuation, without comments.
 * One left-to-right pass, so a comment marker inside a string ("customers/*…") stays part of the string. */
function tokenize(text) {
  const tokens = [];
  for (const m of text.matchAll(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_.][\w.]*|-?\d[\w.]*|[{}[\]()=;,<>:]/g,
  )) {
    const t = m[0];
    if (t.startsWith('//') || t.startsWith('/*')) continue;
    if (t.startsWith('.') && /^[A-Za-z_][\w.]*$/.test(tokens.at(-1) ?? '')) tokens[tokens.length - 1] += t;
    else tokens.push(t);
  }
  return tokens;
}
const unquote = s => s.slice(1, -1);

/** Messages and enums (fully qualified), imports and service methods of one proto file. */
function parse(file, text) {
  const t = tokenize(text),
    descriptors = new Map(),
    imports = [],
    methods = new Map();
  let i = 0,
    pkg = '';
  const expect = token => {
    if (t[i] !== token) throw Error(file + ': expected ' + token + ' at ' + t.slice(i, i + 8).join(' '));
    i++;
  };
  /** Skips one statement or block, balanced over {} and []. */
  const skip = () => {
    let depth = 0;
    while (i < t.length) {
      const token = t[i++];
      if (token === '{' || token === '[') depth++;
      else if (token === '}' || token === ']') {
        if (--depth === 0 && t[i] !== ';' && token === '}') return;
      } else if (token === ';' && depth === 0) return;
    }
  };
  function enumeration(prefix) {
    const name = prefix + '.' + t[i++],
      values = [];
    expect('{');
    while (t[i] !== '}') {
      if (t[i] === 'option' || t[i] === 'reserved') skip();
      else if (t[i] === ';') i++;
      else {
        values.push(t[i]);
        skip();
      }
    }
    i++;
    descriptors.set(name, {kind: 'enum', values, source: file});
  }
  function field(fields) {
    const label = ['optional', 'repeated', 'required'].includes(t[i]) ? t[i++] : '';
    let type = t[i++];
    if (type === 'map') {
      type = 'map<' + t[i + 1] + ', ' + t[i + 3] + '>';
      i += 5;
    }
    const name = t[i++];
    expect('=');
    i++;
    const behaviors = [];
    if (t[i] === '[') {
      let depth = 0;
      do {
        if (t[i] === '[' || t[i] === '{') depth++;
        if (t[i] === ']' || t[i] === '}') depth--;
        if (t[i] === '(' && t[i + 1] === 'google.api.field_behavior') behaviors.push(t[i + 4]);
        i++;
      } while (depth > 0);
    }
    expect(';');
    fields[name] = {
      type,
      ...(label === 'repeated' ? {repeated: true} : {}),
      ...(behaviors.includes('REQUIRED') ? {required: true} : {}),
      ...(behaviors.includes('OUTPUT_ONLY') ? {outputOnly: true} : {}),
      ...(behaviors.includes('IMMUTABLE') ? {immutable: true} : {}),
    };
    return name;
  }
  function message(prefix) {
    const name = prefix + '.' + t[i++],
      fields = {},
      oneofs = [];
    let resourcePattern;
    // Nested messages and enums follow their parent, in declaration order.
    descriptors.set(name, undefined);
    expect('{');
    while (t[i] !== '}') {
      if (t[i] === 'option') {
        const start = i;
        if (t[i + 1] === '(' && t[i + 2] === 'google.api.resource' && t[i + 3] === ')') {
          skip();
          for (let j = start; j < i; j++)
            if (t[j] === 'pattern' && t[j + 1] === ':' && resourcePattern === undefined)
              resourcePattern = unquote(t[j + 2]);
        } else skip();
      } else if (t[i] === 'message') {
        i++;
        message(name);
      } else if (t[i] === 'enum') {
        i++;
        enumeration(name);
      } else if (t[i] === 'oneof') {
        i += 2;
        expect('{');
        const members = [];
        while (t[i] !== '}') {
          if (t[i] === 'option') skip();
          else members.push(field(fields));
        }
        i++;
        oneofs.push(members);
      } else if (['reserved', 'extensions'].includes(t[i])) skip();
      else if (t[i] === ';') i++;
      else field(fields);
    }
    i++;
    descriptors.set(name, {
      kind: 'message',
      fields,
      ...(oneofs.length ? {oneofs} : {}),
      ...(resourcePattern !== undefined ? {resourcePattern} : {}),
      source: file,
    });
  }
  function service() {
    const name = t[i++];
    expect('{');
    while (t[i] !== '}') {
      if (t[i] === 'rpc') {
        const rpc = t[i + 1];
        let request = t[i + 3];
        if (request === 'stream') request = t[i + 4];
        methods.set(name + '.' + rpc, request.includes('.') ? request : pkg + '.' + request);
        i += 2;
        skip();
      } else skip();
    }
    i++;
  }
  while (i < t.length) {
    const token = t[i++];
    if (token === 'package') {
      pkg = t[i++];
      expect(';');
    } else if (token === 'import') {
      if (t[i] === 'public' || t[i] === 'weak') i++;
      imports.push(unquote(t[i++]));
      expect(';');
    } else if (token === 'message') message(pkg);
    else if (token === 'enum') enumeration(pkg);
    else if (token === 'service') service();
    else if (token === ';') continue;
    else {
      i--;
      skip();
    }
  }
  return {descriptors, imports, methods};
}

const mapping = JSON.parse(fs.readFileSync(output, 'utf8')),
  catalog = JSON.parse(fs.readFileSync('.mirror/CATALOG/google_ads_native_action.json', 'utf8')),
  root = 'google/ads/googleads/' + version + '/',
  parsed = new Map();
const read = file => {
  if (!parsed.has(file)) {
    const bytes = fs.readFileSync(path.join(directory, file));
    parsed.set(file, {
      ...parse(file, bytes.toString('utf8')),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return parsed.get(file);
};
const snake = s => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
// The adapter's RPC actions: each names its service and method; the service proto defines the request message.
const wanted = Object.keys(mapping.googleProto.rpcRequests),
  rpcRequests = {},
  services = new Set();
for (const action of wanted) {
  const raw = catalog.actions.find(a => a.name === action)?.raw;
  if (!raw?.service || !raw?.rpc) throw Error('The catalog names no service method for ' + action);
  const file = root + 'services/' + snake(raw.service).replace('you_tube', 'youtube') + '.proto';
  if (!fs.existsSync(path.join(directory, file))) {
    // A method the version removed has no request message to validate; the adapter refuses it by name.
    console.log('No ' + version + ' service proto for ' + action + ' (' + file + ').');
    continue;
  }
  const request = read(file).methods.get(raw.service + '.' + raw.rpc);
  if (!request) {
    console.log('No ' + version + ' method ' + raw.service + '.' + raw.rpc + ' for ' + action + '.');
    continue;
  }
  rpcRequests[action] = request;
  services.add(file);
}
// Every Google Ads proto those services import, transitively.
const files = [],
  queue = [...services].sort();
while (queue.length) {
  const file = queue.shift();
  if (files.includes(file)) continue;
  files.push(file);
  for (const imported of read(file).imports) if (imported.startsWith('google/ads/googleads/')) queue.push(imported);
}
files.sort();
const descriptors = {},
  sources = {};
for (const file of files) {
  sources[file] = {
    url: 'https://raw.githubusercontent.com/googleapis/googleapis/master/' + file,
    sha256: read(file).sha256,
  };
  for (const [name, descriptor] of read(file).descriptors) descriptors[name] = descriptor;
}
const googleProto = {license: mapping.googleProto.license, version, sources, descriptors, rpcRequests},
  text = JSON.stringify({...mapping, googleProto}, null, 2) + '\n';
console.log(
  JSON.stringify({
    version,
    sources: files.length,
    descriptors: Object.keys(descriptors).length,
    rpcRequests: Object.keys(rpcRequests).length,
  }),
);
if (process.argv.includes('--check')) {
  if (fs.readFileSync(output, 'utf8') !== text) throw Error('The pinned Google protobuf descriptors differ.');
} else if (process.argv.includes('--write')) fs.writeFileSync(output, text);
else if (argument('--out')) fs.writeFileSync(argument('--out'), JSON.stringify(googleProto, null, 2) + '\n');
