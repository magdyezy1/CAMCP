// Synthetic subprocess used only by linkedin-media-resume.test.mjs. No network.
import path from 'node:path';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
const [database, reviewId] = process.argv.slice(2);
if (!/^amcp-linkedin-resume-/.test(path.basename(path.dirname(database ?? ''))) || !reviewId)
  throw Error('Explicit isolated synthetic database and review required.');
const store = new Store(database, Buffer.alloc(32, 68).toString('base64')),
  save = store.saveUploadSession.bind(store);
store.saveUploadSession = (tenant, id, value, expiry) => {
  save(tenant, id, value, expiry);
  if (value.uploaded_part_ids?.length === 1) process.exit(73);
};
const transport = new NativeTransport(async (raw, init) => {
  const u = new URL(String(raw));
  if (u.pathname === '/rest/adAccounts/123') return Response.json({id: 123, name: 'Synthetic account'});
  if (u.searchParams.get('action') === 'initializeUpload')
    return Response.json({
      value: {
        video: 'urn:li:video:456',
        uploadToken: 'private-upload-token',
        uploadUrlsExpireAt: Date.now() + 120000,
        uploadInstructions: [
          {firstByte: 0, lastByte: 4194303, uploadUrl: 'https://www.linkedin.com/dms-uploads/456/1'},
          {firstByte: 4194304, lastByte: 5242879, uploadUrl: 'https://www.linkedin.com/dms-uploads/456/2'},
        ],
      },
    });
  if (u.hostname === 'www.linkedin.com' && u.pathname.endsWith('/1') && init.method === 'PUT')
    return new Response(null, {status: 201, headers: {etag: '"private-part-1"'}});
  throw Error('Unexpected route in isolated crash fixture');
});
const service = new MirrorService(
  new Registry(),
  store,
  transport,
  undefined,
  {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  async () => {
    throw Error('Crash fixture cannot download sources');
  },
);
const result = await service.call(
  'amcp_media',
  {action: 'execute', review_id: reviewId, idempotency_key: reviewId, confirmed: true},
  {tenantId: 't', userId: 'u', role: 'admin'},
);
throw Error('Expected durable-checkpoint exit, got ' + JSON.stringify(result));
