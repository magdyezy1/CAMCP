import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Shared by the Google Ads proto evidence tools. They read public googleapis protos that the operator downloaded into
// --source-dir (a file per proto, named like services_x.proto); they never use the network or credentials.

/** The Google Ads API version AMCP sends (src/google-version.ts); tests/google-version.test.ts keeps the two equal. */
export const googleVersion = 'v25';

/** The named protos' text and their public source URLs and hashes. */
export function readProtos(names, what) {
  const directory = process.argv[process.argv.indexOf('--source-dir') + 1];
  if (!process.argv.includes('--source-dir') || !directory)
    throw Error('Supply --source-dir containing the public Google Ads ' + googleVersion + ' ' + what + '.');
  const sources = {},
    content = {};
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(directory, name.replace('/', '_') + '.proto'));
    content[name] = bytes.toString('utf8');
    sources[name] = {
      url:
        'https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/googleads/' +
        googleVersion +
        '/' +
        name +
        '.proto',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  return {sources, content};
}

/** The body of one proto message, without comments. */
export function message(text, name) {
  const start = text.indexOf('message ' + name + ' {');
  if (start < 0) throw Error('Missing native message ' + name);
  const begin = text.indexOf('{', start);
  let depth = 1,
    end = begin;
  while (depth && ++end < text.length) {
    if (text[end] === '{') depth++;
    if (text[end] === '}') depth--;
  }
  if (depth) throw Error('Unclosed native message ' + name);
  return text.slice(begin + 1, end).replace(/\/\/[^\n]*/g, '');
}

/** The field names a message body declares, sorted. */
export const fieldNames = body =>
  [
    ...new Set(
      [...body.matchAll(/(?:^|\n)\s+(?:optional\s+|repeated\s+)?[\w.]+\s+([a-z_]+)\s*=\s*\d+/g)].map(m => m[1]),
    ),
  ].sort();

/** Writes the fixture, or with --check fails when the pinned one differs. */
export function pin(output, fixture, what) {
  const text = JSON.stringify(fixture, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== text)
      throw Error(what + ' differs from the pinned fixture ' + output + '. Review the upstream change.');
  } else fs.writeFileSync(output, text);
}
