// ARC-03 Stage A: generated/apple-platform-v1-models.json came from an external SDK checkout with no check at all, so a
// hand edit of a model field or a regeneration from another revision passed every gate. It now has an offline check
// (its pinned digest, revision and shape) and a re-derivation from the pinned revision, fetched by the owner only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  appleModelProblems,
  appleModelsDigest,
  appleModelsFile,
  appleRederivationProblems,
  appleSdkFiles,
  appleSdkRevision,
  extractAppleModels,
  fetchPinnedAppleSdk,
  serializeAppleModels,
} from '../tools/apple-model-evidence.mjs';
import {removeTestDirectory} from '../dist/tests/temp.js';

const committed = fs.readFileSync(appleModelsFile, 'utf8');
const temporary = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-apple-evidence-'));
  t.after(() => removeTestDirectory(directory, 'amcp-apple-evidence-'));
  return directory;
};
/** A synthetic SDK in the generated client layout the extractor accepts: one enum, one interface and two methods. */
function syntheticSdk(directory) {
  fs.mkdirSync(path.join(directory, 'src/model'), {recursive: true});
  fs.mkdirSync(path.join(directory, 'src/api'), {recursive: true});
  fs.writeFileSync(
    path.join(directory, 'src/model/ad-group-status.ts'),
    "export enum AdGroupStatus {\n    Enabled = 'ENABLED',\n    Paused = 'PAUSED'\n}\n",
  );
  fs.writeFileSync(
    path.join(directory, 'src/model/ad-group-create.ts'),
    "export interface AdGroupCreate {\n    'name': string;\n    'status'?: AdGroupStatus;\n}\n",
  );
  const method = (name, route, verb) =>
    `        ${name}: async (xApContext: string, options: any = {}): Promise<RequestArgs> => {\n` +
    `            const localVarPath = \`${route}\`;\n` +
    `            const localVarRequestOptions = { method: '${verb}', ...options};\n` +
    `        },\n`;
  fs.writeFileSync(
    path.join(directory, 'src/api/apple-ads-api.ts'),
    'export const Api = function () {\n    return {\n' +
      method('adgroupsPost', '/campaigns/{campaignId}/adgroups', 'POST') +
      method('sharedBudgetsPost', '/budgets', 'POST') +
      '    };\n};\n',
  );
  return directory;
}

test('the committed Apple evidence passes the offline check: pinned digest, pinned revision and well-formed models', () => {
  assert.deepEqual(appleModelProblems(committed), []);
  const data = JSON.parse(committed);
  assert.equal(data.revision, appleSdkRevision);
  assert.equal(appleSdkFiles(data).length, Object.keys(data.models).length + 1);
  const cli = spawnSync(process.execPath, ['tools/apple-model-evidence.mjs', '--check'], {encoding: 'utf8'});
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).digest, appleModelsDigest);
});

test('a hand edit of one Apple model field fails the offline check, which before ARC-03 did not exist', () => {
  const data = JSON.parse(committed),
    [name, model] = Object.entries(data.models).find(([, m]) => m.fields),
    [key, field] = Object.entries(model.fields)[0];
  data.models[name].fields[key] = {...field, required: !field.required};
  const problems = appleModelProblems(serializeAppleModels(data));
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /does not have its recorded digest .*edited by hand/);
});

test('an edit that breaks the pinned revision or a type reference is named besides the digest', () => {
  const data = JSON.parse(committed);
  data.revision = '0'.repeat(40);
  const [name] = Object.entries(data.models).find(([, m]) => m.fields);
  data.models[name].fields.extra = {type: 'NoSuchModel', required: false};
  const problems = appleModelProblems(serializeAppleModels(data));
  assert.ok(problems.some(p => p.startsWith('revision must be the pinned ' + appleSdkRevision)));
  assert.ok(problems.some(p => p === name + '.extra: type NoSuchModel is not a model.'));
});

test('the evidence re-derives from an SDK checkout, and a changed SDK source is named', t => {
  const sdk = syntheticSdk(temporary(t)),
    text = serializeAppleModels(
      extractAppleModels(path.join(sdk, 'src/model'), path.join(sdk, 'src/api/apple-ads-api.ts')),
    );
  assert.deepEqual(appleRederivationProblems(sdk, text), []);
  fs.writeFileSync(
    path.join(sdk, 'src/model/ad-group-create.ts'),
    "export interface AdGroupCreate {\n    'name': string;\n    'status': AdGroupStatus;\n}\n",
  );
  assert.deepEqual(appleRederivationProblems(sdk, text), [
    'AdGroupCreate: the SDK source differs from the one of the pinned revision.',
  ]);
  // The committed evidence came from the real pinned revision, not from this synthetic SDK.
  assert.ok(appleRederivationProblems(sdk, committed).some(p => /is not the file of the pinned revision/.test(p)));
});

test('fetching the pinned SDK asks only raw.githubusercontent.com, at the pinned revision, without redirects', async t => {
  const sdk = temporary(t),
    requests = [];
  const fetched = await fetchPinnedAppleSdk(committed, sdk, async (url, options) => {
    requests.push({url, redirect: options.redirect});
    return new Response('// file\n', {status: 200});
  });
  assert.equal(fetched, appleSdkFiles(JSON.parse(committed)).length);
  for (const request of requests) {
    assert.ok(
      request.url.startsWith(
        'https://raw.githubusercontent.com/apple/apple-ads-platform-api-node/' + appleSdkRevision + '/src/',
      ),
      request.url,
    );
    assert.equal(request.redirect, 'error');
  }
  assert.ok(fs.existsSync(path.join(sdk, 'src/api/apple-ads-api.ts')));
  await assert.rejects(
    fetchPinnedAppleSdk(committed, temporary(t), async () => new Response('missing', {status: 404})),
    /answered HTTP 404/,
  );
  await assert.rejects(
    fetchPinnedAppleSdk(committed, temporary(t), async () => new Response('x'.repeat(1024 * 1024 + 1), {status: 200})),
    /exceeds 1 MiB/,
  );
});

test('the fetch is refused without a directory and never runs as part of the check', () => {
  const cli = spawnSync(process.execPath, ['tools/apple-model-evidence.mjs', '--fetch', '--check'], {encoding: 'utf8'});
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /--fetch needs --sdk <directory>/);
  const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
  assert.equal(scripts['generate:apple:check'], 'node tools/apple-model-evidence.mjs --check');
  assert.doesNotMatch(scripts.check, /--fetch/);
});
