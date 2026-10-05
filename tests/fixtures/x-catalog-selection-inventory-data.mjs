import {xCatalogComparisonFixture, xProductSource} from './x-catalog-comparison.mjs';

export const catalogInventoryReason =
  'X listed catalog observations changed during collection. Read them again; no product changes were submitted.';
export function xCatalogInventoryFixture({fault = false, writable = false, products = 123} = {}) {
  let fail = fault,
    pages = 0;
  const f = xCatalogComparisonFixture({
    products,
    writable,
    tenant: 'synthetic-x-selection-inventory',
    read: ({request, result}) => {
      if (request.path.endsWith('/products') && ++pages === 3 && fail) {
        const other = result.data.data.find(p => p.id === 'sku-3');
        if (other) other.title = 'Changed other listed title';
      }
    },
  });
  if (products >= 7) {
    Object.assign(f.items[9001][2], {item_group_id: 'Group <literal>', item_group_key: '900719925474099312346'});
    delete f.items[9001][3].item_group_id;
    Object.assign(f.items[9001][4], {price: '999999999999.000001 SAR', product_key: '900719925474099312345'});
    Object.assign(f.items[9001][5], {
      title: 'Literal <img src=x onerror=window.catalogUnsafe=1> & item',
      price: '000020.000000 SAR',
    });
    Object.assign(f.items[9001][6], {
      private_unknown: 'UNSELECTED-PRIVATE-NATIVE-MARKER',
      image_link: 'https://example.test/private?token=UNSELECTED-PRIVATE-IMAGE-MARKER',
    });
  }
  const productsInSource = f.items[9001].slice(0, 2).map(p => xProductSource(p)),
    input = {
      ...f.input,
      products: productsInSource,
      inspect_other_listed_products: true,
      absent_source_policy: 'retain',
    },
    quote = v => '"' + v.replaceAll('"', '""') + '"',
    csv =
      Object.keys(productsInSource[0]).join(',') +
      '\n' +
      productsInSource.map(p => Object.values(p).map(quote).join(',')).join('\n') +
      '\n';
  return {
    ...f,
    input,
    csv: Buffer.from(csv),
    setFault: enabled => {
      fail = enabled;
      pages = 0;
    },
    call: (args = input, actor = f.actor) => f.service.call('amcp_workspace', args, actor),
  };
}
