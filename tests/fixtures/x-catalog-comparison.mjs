import {setup, product} from '../x-catalog-fixture.mjs';
import {MirrorService} from '../../dist/src/service.js';
import {xImportInput, xImportProduct} from './x-catalog-import-data.mjs';

export const xProductSource = (native, extra = {}) => {
  const [price, currency] = String(native.price).split(' ');
  return xImportProduct({
    retailer_id: native.id,
    name: native.title,
    price,
    currency,
    image_url: native.image_link,
    url: native.link,
    availability: native.availability,
    condition: native.condition,
    brand: native.brand,
    description: native.description,
    ...extra,
  });
};
export function xCatalogComparisonFixture(options = {}) {
  const f = setup({tenant: options.tenant ?? 'synthetic-x-comparison', products: options.products ?? 3});
  const original = f.service.transport.request.bind(f.service.transport);
  f.service.transport.request = async (...args) => {
    const result = await original(...args);
    await options.read?.({request: args[0], result, f});
    return result;
  };
  const service = new MirrorService(f.service.registry, f.store, f.service.transport, undefined, {
    allowWrites: options.writable === true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const input = xImportInput({
    action: 'catalog_compare',
    products: [
      xProductSource(product(4)),
      xProductSource(product(1), {name: 'Changed title'}),
      xProductSource(product(2)),
      xProductSource(product(3)),
    ],
  });
  return {...f, service, input, call: (args = input, actor = f.actor) => service.call('amcp_workspace', args, actor)};
}
