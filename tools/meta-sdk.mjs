import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Shared by the Meta evidence tools. They read Meta's official Python Business SDK (facebook-python-business-sdk,
// generated from Meta's API specification): the adobjects files of a release, which the operator downloaded into a
// directory. They never use the network or credentials.

/** The Graph API version AMCP sends (src/meta-version.ts) and the SDK release that describes it; a test keeps them equal. */
export const metaVersion = 'v26.0',
  metaSdkTag = '26.0.2';
export const sdkUrl = (tag, name) =>
  'https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/' +
  tag +
  '/facebook_business/adobjects/' +
  name +
  '.py';

/** The directory given after `flag` on the command line. */
export function argumentDirectory(flag, what) {
  const directory = process.argv[process.argv.indexOf(flag) + 1];
  if (!process.argv.includes(flag) || !directory) throw Error('Supply ' + flag + ' with ' + what + '.');
  return directory;
}

/** The named SDK modules' text and their public source URLs and hashes. */
export function readSdk(directory, names, tag = metaSdkTag) {
  const sources = {},
    text = {};
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(directory, name + '.py'));
    text[name] = bytes.toString('utf8');
    sources[name] = {url: sdkUrl(tag, name), sha256: createHash('sha256').update(bytes).digest('hex')};
  }
  return {sources, text};
}

/** The body of one method of an SDK class. */
export const sdkMethod = (text, name) => text.split('    def ' + name + '(')[1]?.split(/\n    (?:def |_[a-z])/)[0];

/** A `name = {'key': 'value', …}` dictionary of an SDK class or method (field types, parameter types). */
export function dictionary(text, name) {
  const body = new RegExp('\\b' + name + ' = \\{([\\s\\S]*?)\\n    +\\}').exec(text)?.[1];
  if (!body) throw Error('Missing SDK dictionary: ' + name);
  const entries = body
    .split('\n')
    .filter(s => s.trim())
    .map(s => {
      const m = /^\s*'([a-z_0-9]+)': '([^']+)',\s*$/.exec(s);
      if (!m) throw Error('Changed SDK dictionary syntax: ' + s);
      return [m[1], m[2]];
    });
  if (!entries.length || new Set(entries.map(e => e[0])).size !== entries.length)
    throw Error('Empty/duplicate SDK dictionary.');
  return Object.fromEntries(entries);
}

/** One SDK class: its readable fields, enums and requests (method, edge, parameter types). */
export function sdkClass(text) {
  const fields = /\n {4}class Field\(AbstractObject\.Field\):\n((?: {8}.*\n|\n)*)/.exec(text)?.[1] ?? '',
    enums = {},
    calls = [];
  for (const m of text.matchAll(/\n {4}class (\w+):\n((?: {8}\w+ = .*\n)+)/g))
    enums[m[1]] = [...m[2].matchAll(/^ {8}\w+ = '([^']*)'/gm)].map(v => v[1]);
  for (const m of text.matchAll(/\n {4}def (\w+)\(self[^)]*\):\n([\s\S]*?)(?=\n {4}def |\n {4}_field_types|$)/g)) {
    const request = /FacebookRequest\(\s*node_id=[^,]+,\s*method='(\w+)',\s*endpoint='([^']*)'/.exec(m[2]);
    if (!request) continue;
    const types = /param_types = \{([\s\S]*?)\n {8}\}/.exec(m[2])?.[1] ?? '';
    calls.push({
      name: m[1],
      method: request[1],
      edge: request[2],
      params: Object.fromEntries([...types.matchAll(/'(\w+)': '([^']*)'/g)].map(p => [p[1], p[2]])),
    });
  }
  return {
    class: /^class (\w+)\(/m.exec(text)?.[1] ?? null,
    fields: [...fields.matchAll(/^ {8}(\w+) = '/gm)].map(f => f[1]),
    enums,
    calls,
  };
}

/** Writes the fixture, or with --check fails when the pinned one differs. */
export function pin(output, fixture, what) {
  const text = JSON.stringify(fixture, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== text)
      throw Error(what + ' differs from the pinned fixture ' + output + '. Review the upstream change.');
  } else fs.writeFileSync(output, text);
}
