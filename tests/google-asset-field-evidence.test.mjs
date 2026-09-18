import test from 'node:test';
import assert from 'node:assert/strict';
import {extractAssetFields} from '../tools/google-asset-field-evidence.mjs';
test('public GAQL field-table extraction preserves selectable/repeated facts and fails on drift',()=>{
 const html='<h2 id="asset.sitelink_asset.link_text">field</h2><tr><td>Selectable</td><td>True</td></tr><tr><td>Repeated</td><td>False</td></tr></table>';
 const result=extractAssetFields(Buffer.from(html),'2026-09-18');assert.deepEqual(result.fields,{'sitelink_asset.link_text':{selectable:true,repeated:false}});assert.match(result.source_sha256,/^[a-f0-9]{64}$/);
 assert.throws(()=>extractAssetFields(Buffer.from(html+html),'2026-09-18'),/duplicated/);
 assert.throws(()=>extractAssetFields(Buffer.from(html.replace('Selectable','Different')),'2026-09-18'),/Unrecognized/);
 assert.throws(()=>extractAssetFields(Buffer.from('<html>Sign in</html>'),'2026-09-18'),/No Google/);
});
