import test from 'node:test';
import assert from 'node:assert/strict';
import {wooVariationsFixture, wooVariationInput, wooVariation} from './fixtures/woocommerce-variations-data.mjs';

test('selected children and parent membership preserve large native integer IDs and tolerate collection reordering', async () => {
  const f = wooVariationsFixture();
  try {
    f.data.parent.variations = [102, '9007199254740993'];
    f.data.items.push(wooVariation({id: '9007199254740993', sku: 'LARGE-VARIATION'}));
    f.respond((url, _options, n) => {
      if (url.pathname.includes('/settings/')) return f.response(url);
      const value = url.pathname.endsWith('/variations')
        ? n === 4
          ? [...f.data.items].reverse()
          : f.data.items
        : {...f.data.parent, variations: n === 5 ? [...f.data.parent.variations].reverse() : f.data.parent.variations};
      return new Response(JSON.stringify(value).replaceAll('"9007199254740993"', '9007199254740993'), {
        headers: {
          'content-type': 'application/json',
          ...(Array.isArray(value) ? {'x-wp-total': '2', 'x-wp-totalpages': '1'} : {}),
        },
      });
    });
    const out = await f.service.call(
      'amcp_workspace',
      wooVariationInput({variation_ids: ['9007199254740993', '102']}),
      f.actor,
    );
    assert.equal(out.success, true, JSON.stringify(out));
    assert.deepEqual(out.data.product_ids, ['102', '9007199254740993']);
    assert.deepEqual(out.data.parent.variation_ids, ['102', '9007199254740993']);
    assert.equal(out.data.items[1].product_id, '9007199254740993');
    for (const c of f.calls.filter(c => c.url.pathname.endsWith('/variations'))) {
      assert.equal(c.url.searchParams.get('include'), '102,9007199254740993');
      assert.equal(c.url.searchParams.get('status'), 'publish');
      assert.equal(c.url.searchParams.get('context'), 'view');
      assert.equal(c.url.searchParams.get('per_page'), '100');
      assert.doesNotMatch(c.url.searchParams.get('_fields'), /parent_id|name,type|meta_data|description|downloads/);
    }
  } finally {
    f.close();
  }
});

test('foreign incomplete children and malformed parent hierarchies withhold the whole source', async () => {
  for (const reason of [
    'missing',
    'foreign',
    'duplicate',
    'private',
    'total',
    'pages',
    'parent-id',
    'parent-type',
    'parent-private',
    'parent-nested',
    'membership-missing',
    'membership-duplicate',
    'membership-self',
    'membership-malformed',
    'membership-limit',
    'attributes',
    'attribute-identity',
    'attribute-control',
  ]) {
    const f = wooVariationsFixture();
    try {
      if (reason === 'missing') f.data.items = [];
      if (reason === 'foreign') f.data.items[0].id = 103;
      if (reason === 'duplicate') f.data.items.push({...f.data.items[0]});
      if (reason === 'private') f.data.items[0].status = 'private';
      if (reason === 'parent-id') f.data.parent.id = 999;
      if (reason === 'parent-type') f.data.parent.type = 'simple';
      if (reason === 'parent-private') f.data.parent.status = 'private';
      if (reason === 'parent-nested') f.data.parent.parent_id = 999;
      if (reason === 'membership-missing') f.data.parent.variations = [103];
      if (reason === 'membership-duplicate') f.data.parent.variations = [102, 102];
      if (reason === 'membership-self') f.data.parent.variations = [101, 102];
      if (reason === 'membership-malformed') f.data.parent.variations = [102, true];
      if (reason === 'membership-limit') f.data.parent.variations = Array.from({length: 1001}, (_, i) => 102 + i);
      if (reason === 'attributes') f.data.items[0].attributes = null;
      if (reason === 'attribute-identity') f.data.items[0].attributes.push({...f.data.items[0].attributes[0]});
      if (reason === 'attribute-control') f.data.items[0].attributes[0].option = 'Red\nprivate';
      f.respond(url =>
        url.pathname.endsWith('/variations') && ['total', 'pages'].includes(reason)
          ? Response.json(f.data.items, {
              headers: {
                'x-wp-total': reason === 'total' ? '2' : '1',
                'x-wp-totalpages': reason === 'pages' ? '2' : '1',
              },
            })
          : f.response(url),
      );
      const out = await f.service.call('amcp_workspace', wooVariationInput(), f.actor);
      assert.equal(out.success, false, reason);
      assert.equal(out.data, undefined, 'No partial source is returned: ' + reason);
      assert.doesNotMatch(JSON.stringify(out), /UNUSED-PRIVATE-WOO|synthetickey|syntheticsecret/);
      assert.ok(f.calls.length <= 3, reason);
    } finally {
      f.close();
    }
  }
});

test('selected parent child or currency changes across six reads withhold the source without retry', async () => {
  for (const reason of [
    'parent-sku',
    'parent-name',
    'parent-members',
    'parent-date',
    'child-sku',
    'child-price',
    'child-image',
    'child-attributes',
    'child-stock',
    'child-tax',
    'currency',
  ]) {
    const f = wooVariationsFixture();
    try {
      f.respond((url, _options, n) => {
        if (n === 6 && reason === 'currency') return Response.json({id: 'woocommerce_currency', value: 'USD'});
        if (n === 5 && reason.startsWith('parent-')) {
          const parent = structuredClone(f.data.parent);
          if (reason === 'parent-sku') parent.sku = 'GROUP-CHANGED';
          if (reason === 'parent-name') parent.name = 'Changed';
          if (reason === 'parent-members') parent.variations = [102, 104];
          if (reason === 'parent-date') parent.date_modified_gmt = '2026-10-04T10:01:00';
          return Response.json(parent);
        }
        if (n === 4 && reason.startsWith('child-')) {
          const child = structuredClone(f.data.items[0]);
          if (reason === 'child-sku') child.sku = 'CHANGED';
          if (reason === 'child-price') child.price = '12.35';
          if (reason === 'child-image') child.image.src = 'https://shop.example.test/changed.jpg';
          if (reason === 'child-attributes') child.attributes[0].option = 'Blue';
          if (reason === 'child-stock') child.stock_status = 'outofstock';
          if (reason === 'child-tax') child.tax_status = 'none';
          return Response.json([child], {headers: {'x-wp-total': '1', 'x-wp-totalpages': '1'}});
        }
        return f.response(url);
      });
      const out = await f.service.call('amcp_workspace', wooVariationInput(), f.actor);
      assert.equal(out.success, false, reason);
      assert.equal(f.calls.length, 6, reason);
      assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
      assert.equal(f.store.documents(f.actor.tenantId, 'campaign').length, 0);
    } finally {
      f.close();
    }
  }
});

test('unsupported original fields stay visible without invented names groups prices or parent image substitution', async () => {
  const f = wooVariationsFixture();
  try {
    f.data.parent.sku = ' GROUP ';
    f.data.parent.name = ' Parent ';
    f.data.items[0].sku = ' SKU ';
    f.data.items[0].price = '12.345';
    f.data.items[0].image = null;
    f.data.items[0].virtual = true;
    const out = await f.service.call('amcp_workspace', wooVariationInput(), f.actor);
    assert.equal(out.success, true, JSON.stringify(out));
    const item = out.data.items[0];
    assert.equal(item.sku, ' SKU ');
    assert.equal(item.parent_sku, ' GROUP ');
    assert.equal(item.parent_name, ' Parent ');
    assert.equal(item.name, null);
    assert.equal(item.selected_price, '12.345');
    assert.equal(item.first_image_url, null);
    assert.match(item.blockers.join(' '), /whitespace.*parent.*name.*Digital.*decimal.*image/s);
    assert.equal(f.calls.length, 6);
  } finally {
    f.close();
  }
});

test('invalid or mixed variation selectors stop before egress and fifty children keep exact six-read bounds', async () => {
  for (const requirements of [
    {product_ids: ['102']},
    {source_kind: 'unknown'},
    {parent_product_id: '102'},
    {parent_product_id: '0101'},
    {parent_product_id: 101},
    {variation_ids: []},
    {variation_ids: [102]},
    {variation_ids: ['102', '102']},
    {variation_ids: ['9007199254740993.0']},
    {variation_ids: Array.from({length: 51}, (_, i) => String(i + 102))},
    {price_field: 'price_html'},
  ]) {
    const f = wooVariationsFixture();
    try {
      const out = await f.service.call('amcp_workspace', wooVariationInput(requirements), f.actor);
      assert.equal(out.success, false, JSON.stringify(requirements));
      assert.equal(f.calls.length, 0);
    } finally {
      f.close();
    }
  }
  const f = wooVariationsFixture();
  try {
    f.data.items = Array.from({length: 50}, (_, i) => wooVariation({id: 102 + i, sku: 'VAR-' + i}));
    f.data.parent.variations = f.data.items.map(row => row.id);
    const out = await f.service.call(
      'amcp_workspace',
      wooVariationInput({variation_ids: f.data.items.map(row => String(row.id))}),
      f.actor,
    );
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.items.length, 50);
    assert.equal(out.data.collected_rows, 102);
    assert.equal(out.data.native_requests, 6);
  } finally {
    f.close();
  }
});
