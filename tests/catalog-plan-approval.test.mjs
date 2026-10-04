import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './x-catalog-fixture.mjs';
import {catalogIngestion} from '../dist/src/catalog-ingestion.js';

test('saved product plans explain review and serving effects without claiming products are paused', async () => {
  const f = setup();
  try {
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: 'meta',
        tenantId: f.actor.tenantId,
        gateway: 'meta_native_action',
        accounts: ['123'],
        writeAccounts: ['123'],
        scopes: ['ads_management', 'business_management'],
        label: 'Synthetic',
        enabled: true,
      },
      {accessToken: 'synthetic-meta'},
    );
    const input = {
      gateway: 'meta_native_action',
      connection_id: 'meta',
      account_id: '123',
      catalog_id: '555',
      allow_upsert: true,
      products: [
        {
          retailer_id: '001',
          name: 'Existing dynamic catalog product',
          price: '12.34',
          currency: 'SAR',
          image_url: 'https://shop.example.test/i/001.jpg',
        },
      ],
    };
    const saved = await f.service.call('amcp_campaign', catalogIngestion(input).plan, f.actor);
    assert.equal(saved.success, true, JSON.stringify(saved));
    const full = await f.service.call('amcp_campaign', {action: 'get', id: saved.data.id, detail: 'full'}, f.actor);
    assert.equal(full.success, true, JSON.stringify(full));
    assert.doesNotMatch(full.data.approval, /remains paused/);
    assert.match(full.data.approval, /serving|impact/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
