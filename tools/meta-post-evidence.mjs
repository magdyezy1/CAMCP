import {argumentDirectory, dictionary, metaSdkTag, metaVersion, pin, readSdk, sdkMethod} from './meta-sdk.mjs';
// Offline extraction only; callers obtain these PUBLIC pinned SDK files first.
const {sources, text} = readSdk(argumentDirectory('--source-dir', 'the five pinned public SDK files'), [
  'page',
  'pagepost',
  'iguser',
  'igmedia',
  'adaccount',
]);
const routes = {};
for (const [name, method, edge] of [
  ['page', 'get_posts', '/posts'],
  ['iguser', 'get_media', '/media'],
  ['adaccount', 'get_promote_pages', '/promote_pages'],
  ['adaccount', 'get_instagram_accounts', '/instagram_accounts'],
]) {
  const block = sdkMethod(text[name], method);
  if (!block?.includes("method='GET'") || !block.includes("endpoint='" + edge + "'"))
    throw Error('Pinned SDK route changed: ' + name + '.' + method);
  routes[name + '.' + method] = {method: 'GET', edge};
}
const fields = {};
for (const name of ['pagepost', 'igmedia']) {
  fields[name] = dictionary(text[name], '_field_types');
  if (!fields[name].id) throw Error('Empty response field model.');
}
pin(
  'tests/fixtures/meta-post-sdk-' + metaVersion.replace('.0', '') + '.json',
  {
    api_version: metaVersion,
    sdk_tag: metaSdkTag,
    checked_at: '2026-09-28',
    meaning:
      'Official SDK schemas and read edges only; permissions, content eligibility and live responses require provider qualification.',
    sources,
    routes,
    fields,
  },
  'Meta post SDK evidence',
);
console.log('Verified 4 fixed read edges, 2 content field models and 5 pinned source hashes.');
