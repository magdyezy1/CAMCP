import {fieldNames, googleVersion, message, pin, readProtos} from './google-protos.mjs';
// Since v25 the preview request and result messages live in actions/generate_shareable_previews.proto.
const {sources, content} = readProtos(
  ['services/shareable_preview_service', 'actions/generate_shareable_previews'],
  'shareable preview protos',
);
const service = content['services/shareable_preview_service'],
  fields = {},
  oneofs = {};
for (const [file, names] of [
  ['services/shareable_preview_service', ['GenerateShareablePreviewsRequest', 'GenerateShareablePreviewsResponse']],
  [
    'actions/generate_shareable_previews',
    [
      'GenerateShareablePreviewsOperation',
      'ShareablePreview',
      'GenerateShareablePreviewsResult',
      'ShareablePreviewResult',
      'UiPreviewResult',
      'YouTubeLivePreviewResult',
    ],
  ],
])
  for (const name of names) {
    const body = message(content[file], name);
    fields[name] = fieldNames(body);
    oneofs[name] = [...body.matchAll(/oneof\s+([a-z_]+)/g)].map(m => m[1]).sort();
  }
const route = '/' + googleVersion + '/customers/{customer_id=*}:generateShareablePreviews',
  scope = 'https://www.googleapis.com/auth/adwords';
if (
  !service.includes('post: "' + route + '"') ||
  !service.includes('option (google.api.oauth_scopes) = "' + scope + '"')
)
  throw Error('Preview route/scope changed.');
pin(
  'tests/fixtures/google-preview-' + googleVersion + '.json',
  {
    version: googleVersion,
    checked_at: '2026-09-28',
    meaning: 'Public native protocol evidence, not live format eligibility or permission.',
    sources,
    route,
    scope,
    fields,
    oneofs,
  },
  'Preview evidence',
);
console.log(
  'Verified Google ' +
    googleVersion +
    ' preview route, scope, eight message field sets, oneofs and public source hashes.',
);
