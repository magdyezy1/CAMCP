import {xCatalogComparisonFixture} from './x-catalog-comparison.mjs';

export function xCatalogRemovalFixture(t, options = {}) {
  const f = xCatalogComparisonFixture({writable: true, tenant: 'synthetic-x-removal', ...options});
  t.after(() => f.store.close());
  const input = {...f.input, action: 'preview_catalog_removal', retailer_ids: ['sku-1', 'sku-2']};
  return {
    ...f,
    input,
    preview: (changes = {}, actor = f.actor) => f.service.call('amcp_workspace', {...input, ...changes}, actor),
    save: (preview, changes = {}, actor = f.actor) =>
      f.service.call(
        'amcp_workspace',
        {
          action: 'create_catalog_removal',
          preview_id: preview.preview_id,
          preview_hash: preview.preview_hash,
          confirmed: true,
          ...changes,
        },
        actor,
      ),
    campaign: input => f.service.call('amcp_campaign', input, f.actor),
  };
}
