'use strict';
// WEB-07: the Commerce page (/commerce): the reviewed product import from a CSV or supplier file, destination
// comparisons, listed inventory and removals. Its parked store sources are modules of their own behind the same
// loader (web/commerce-woocommerce.js); web/account-workflows.js holds what it shares with the other account pages.
function parseProductCSV(text, gateway = 'meta_native_action') {
  const table = parseProductCSVTable(text);
  if (table.headers.some(header => !catalogSourceFields(gateway).includes(header)))
    throw Error(
      uiText('AMCP column mode accepts only product fields. Choose supplier mapping to select other source columns.'),
    );
  return table.rows;
}
// A product CSV holds at most 500 products in 192 KiB, the bounds of AMCP's CSV source (src/catalog-sources.ts): more
// than 50 are saved as one plan group (COM-03), and AMCP checks the exact byte size again.
const catalogCsvMaxRows = 500,
  catalogCsvMaxBytes = 196608;
function parseProductCSVTable(text) {
  if (text.length > catalogCsvMaxBytes) throw Error(uiText('Use a CSV source of at most 192 KiB and 500 products.'));
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [],
    field = '',
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === '"') {
      if (field || closed) throw Error(uiText('Invalid CSV quoting.'));
      quoted = true;
      continue;
    }
    if (closed && !['\r', '\n', ','].includes(c)) throw Error(uiText('Unexpected text after a quoted CSV value.'));
    if (c === ',') {
      row.push(field);
      field = '';
      closed = false;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
      field = '';
      closed = false;
      continue;
    }
    field += c;
  }
  if (quoted) throw Error(uiText('A quoted CSV value is not closed.'));
  row.push(field);
  if (row.some(v => v !== '')) rows.push(row);
  const headers = rows.shift()?.map(h => h.replace(/^\uFEFF/, '').trim());
  if (
    !headers?.length ||
    headers.length > 100 ||
    headers.some(h => !h || h.length > 200 || /[\x00-\x1f\x7f]/.test(h)) ||
    new Set(headers).size !== headers.length
  )
    throw Error(uiText('Use 1–100 unique named CSV columns, each up to 200 characters.'));
  if (rows.length > catalogCsvMaxRows) throw Error(uiText('Use a CSV source of at most 192 KiB and 500 products.'));
  return {
    headers,
    rows: rows.map(r => {
      if (r.length !== headers.length) throw Error(uiText('Every CSV row must match the header columns.'));
      return Object.fromEntries(headers.map((h, i) => [h, r[i]]).filter(([, v]) => v !== ''));
    }),
  };
}
const catalogMapFields = [
  'retailer_id',
  'name',
  'price',
  'currency',
  'image_url',
  'url',
  'availability',
  'condition',
  'brand',
  'description',
];
// An optional sale for every destination (COM-02 A): a decimal sale price and its literal start and end.
const catalogSaleFields = ['sale_price', 'sale_price_start_date', 'sale_price_end_date'];
function catalogSourceFields(gateway = 'meta_native_action') {
  if (!['meta_native_action', 'x_ads_native_action', 'snapchat_native_action'].includes(gateway))
    throw Error(uiText('Choose the exact account.'));
  // COM-02 D: a Snapchat comparison compares a sale price only; the read format of Snapchat sale dates is unqualified.
  return gateway === 'meta_native_action'
    ? [...catalogMapFields, 'retailer_product_group_id', ...catalogSaleFields]
    : gateway === 'snapchat_native_action'
      ? [...catalogMapFields, 'sale_price']
      : [...catalogMapFields, ...catalogSaleFields];
}
function catalogFieldLabel(field) {
  switch (field) {
    case 'retailer_id':
      return uiText('Retailer ID');
    case 'retailer_product_group_id':
      return uiText('Meta product group ID');
    case 'name':
      return uiText('Product name');
    case 'price':
      return uiText('Decimal price');
    case 'currency':
      return uiText('Currency');
    case 'image_url':
      return uiText('Product image URL');
    case 'url':
      return uiText('Product page URL');
    case 'availability':
      return uiText('Availability');
    case 'condition':
      return uiText('Condition');
    case 'brand':
      return uiText('Brand');
    case 'description':
      return uiText('Description');
    case 'sale_price':
      return uiText('Sale price');
    case 'sale_price_start_date':
      return uiText('Sale start (ISO 8601 with offset)');
    case 'sale_price_end_date':
      return uiText('Sale end (ISO 8601 with offset)');
    case 'sale_price_effective_date':
      return uiText('Sale period');
    default:
      return field;
  }
}
/**
 * A supplier export reduced to the columns a mapping selects (COM-03): AMCP projects it on the server with the saved
 * mapping profile, so only selected columns leave the browser (and, for an image list read by its first URL, only that
 * URL). Incomplete selections and rows without a required value are refused here, before anything is sent.
 */
function selectedCatalogSource(table, settings) {
  const {columns, fixed_currency, image_mode} = settings,
    fields = catalogSourceFields(settings.gateway);
  if (
    !columns ||
    Object.keys(columns).some(k => !fields.includes(k)) ||
    Object.values(columns).some(v => typeof v !== 'string' || (v && !table.headers.includes(v)))
  )
    throw Error(uiText('Choose only columns from the loaded CSV.'));
  if (!['single', 'first_list'].includes(image_mode)) throw Error(uiText('Choose how to read the image column.'));
  if (
    typeof fixed_currency !== 'string' ||
    (columns.currency ? fixed_currency !== '' : !/^[A-Z]{3}$/.test(fixed_currency))
  )
    throw Error(
      uiText('Choose either a currency column or one explicit three-letter uppercase currency for every row.'),
    );
  const required =
    settings.gateway === 'x_ads_native_action'
      ? catalogMapFields.filter(key => key !== 'currency')
      : ['retailer_id', 'name', 'price', 'image_url'];
  for (const key of required)
    if (!columns[key]) throw Error(uiText('Select a source column for {field}.', {field: catalogFieldLabel(key)}));
  if (!table.rows.length) throw Error(uiText('The CSV has no product rows.'));
  const chosen = Object.fromEntries(Object.entries(columns).filter(([, header]) => header)),
    headers = [...new Set(Object.values(chosen))],
    // Only the image column read by its first URL is shortened, and only when no other field reads that column.
    image =
      image_mode === 'first_list' && Object.values(chosen).filter(header => header === chosen.image_url).length === 1
        ? chosen.image_url
        : undefined,
    encode = value => (/[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value);
  table.rows.forEach((row, index) => {
    for (const key of [...required, ...(columns.currency ? ['currency'] : [])])
      if (!row[chosen[key]]?.trim())
        throw Error(uiText('CSV row {row} has no value for {field}.', {row: index + 1, field: catalogFieldLabel(key)}));
  });
  const lines = [
    headers.map(encode).join(','),
    ...table.rows.map(row =>
      headers
        .map(header => {
          const value = row[header] ?? '';
          return encode(header === image && value ? value.split(',')[0].trim() : value);
        })
        .join(','),
    ),
  ];
  return {columns: chosen, text: lines.join('\n')};
}
function catalogMappingMarkup() {
  return `<fieldset id="catalog-csv-mapping"><legend>${esc(uiText('CSV column mapping'))}</legend><label>${esc(uiText('CSV layout'))}<select name="column_mode"><option value="canonical">${esc(uiText('AMCP product columns'))}</option><option value="mapped">${esc(uiText('Map supplier or WooCommerce export columns'))}</option></select></label><div id="catalog-mapping-controls" hidden><button type="button" class="button" id="catalog-load-columns">${esc(uiText('Load columns from the selected file'))}</button><p class="form-note">${esc(uiText('Choose the exact price column and stable retailer ID. Sale dates, tax, stock and product variants are not inferred. Every source row is included.'))}</p><p class="form-note">${esc(uiText('A sale price and its start and end are optional columns; select them only when your source supplies them.'))}</p><div id="catalog-mapping"></div><label>${esc(uiText('Fixed currency when no currency column is selected'))}<input type="text" name="fixed_currency" maxlength="3" placeholder="SAR"></label><label>${esc(uiText('Image column handling'))}<select name="image_mode"><option value="single">${esc(uiText('One literal image URL per row'))}</option><option value="first_list">${esc(uiText('Use the first URL in a comma-separated image list'))}</option></select></label><p class="form-note">${esc(uiText('Only the selected columns are sent. AMCP maps them with this catalog’s saved, versioned column mapping, and blank optional values stay out of the products.'))}</p></div></fieldset>`;
}
function catalogComparisonState(state) {
  switch (state) {
    case 'new':
      return uiText('New product');
    case 'changed':
      return uiText('Changes found');
    case 'matching':
      return uiText('Submitted fields match');
    case 'unknown':
      return uiText('Some fields are unknown');
    default:
      return uiText('Unknown');
  }
}
function catalogImportPreviewMarkup(out, request) {
  const x = request.gateway === 'x_ads_native_action',
    // COM-02 D: a Snapchat preview keeps the exact decimal "amount CUR" of each product, like X.
    snapchat = request.gateway === 'snapchat_native_action',
    exact = x || snapchat,
    grouped = !exact && request.products.some(product => product.retailer_product_group_id !== undefined),
    // COM-02 A: the supplied sale, its native form and its literal period, only when a product has one.
    sale = request.products.some(product => product.sale_price !== undefined),
    saleCell = (product, index) => {
      if (product.sale_price === undefined) return `<td>${esc(uiText('Not supplied'))}</td>`;
      const item = out.items?.[index],
        native = exact
          ? (item?.native_sale_price ?? uiText('Unknown'))
          : Number.isSafeInteger(item?.sale_price_minor_units)
            ? item.sale_price_minor_units
            : uiText('Unknown'),
        period = ['sale_price_start_date', 'sale_price_end_date']
          .filter(k => product[k] !== undefined)
          .map(k => `<br>${esc(catalogFieldLabel(k))}: <bdi dir="ltr">${esc(product[k])}</bdi>`)
          .join('');
      return `<td><bdi>${esc(catalogSaleText(product))}</bdi><br><bdi>${esc(native)}</bdi>${period}</td>`;
    };
  const titles = [
      uiText('Product'),
      uiText('Source price'),
      uiText(x ? 'Native X price' : snapchat ? 'Native Snapchat price' : 'Native hundredths'),
      ...(sale ? [uiText('Sale price')] : []),
      ...(grouped ? [uiText('Meta product group ID')] : []),
      uiText('Existing retailer IDs'),
    ],
    policy = uiText(
      snapchat
        ? 'Compared read-only; fix differences in the product feed'
        : request.allow_upsert
          ? 'Explicitly update existing IDs after native review'
          : 'Create only — refuse existing IDs',
    );
  return `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Products and exact native price units'))}"><table class="review-table"><caption>${esc(uiText('Products and exact native price units'))}</caption><thead><tr>${titles.map(title => `<th scope="col">${esc(title)}</th>`).join('')}</tr></thead><tbody>${request.products.map((product, index) => `<tr><th scope="row"><strong>${esc(product.name)}</strong><br><code>${esc(product.retailer_id)}</code></th><td><bdi>${esc(product.price + ' ' + product.currency)}</bdi></td><td><bdi>${esc(exact ? (out.items?.[index]?.native_price ?? uiText('Unknown')) : Number.isSafeInteger(out.items?.[index]?.price_minor_units) ? out.items[index].price_minor_units : uiText('Unknown'))}</bdi></td>${sale ? saleCell(product, index) : ''}${grouped ? `<td><code dir="ltr">${esc(product.retailer_product_group_id ?? uiText('Not supplied'))}</code></td>` : ''}<td>${esc(policy)}</td></tr>`).join('')}</tbody></table></div>`;
}
/**
 * A plan group of 51–500 source products (COM-03): AMCP's part-by-part validation of the CSV the website sent, checked
 * against that source (its row count, column mode and mapping version) before it can be saved. Nothing is saved yet;
 * the products of each part are listed by the plan it becomes.
 */
function catalogPlanGroupMarkup(out, expected) {
  const plans = Array.isArray(out?.plans) ? out.plans : [],
    text = value => typeof value === 'string' && value.length > 0 && value.length <= 100;
  if (
    out?.record_kind !== 'catalog_plan_group_preview' ||
    out.item_count !== expected.rows ||
    out.parts !== Math.ceil(expected.rows / 50) ||
    plans.length !== out.parts ||
    plans.some(
      (plan, i) =>
        plan?.part !== i + 1 ||
        !Number.isSafeInteger(plan.item_count) ||
        plan.item_count < 1 ||
        plan.item_count > 50 ||
        !text(plan.first_retailer_id) ||
        !text(plan.last_retailer_id),
    ) ||
    plans.reduce((sum, plan) => sum + plan.item_count, 0) !== out.item_count ||
    out.source?.source_kind !== 'csv' ||
    out.source.columns !== expected.columns ||
    (expected.version !== undefined && out.source.mapping_profile?.version !== expected.version) ||
    typeof out.lineage_group_id !== 'string' ||
    out.provider_mutations !== 0 ||
    out.destructive_deletions !== 0
  )
    throw Error(uiText('The plan group could not be confirmed. Validate the source again.'));
  const counts = {count: uiNumber(out.item_count), parts: uiNumber(out.parts)};
  return `<h3 id="catalog-plan-group-heading" tabindex="-1">${esc(uiText('{count} products in {parts} plans of at most 50', counts))}</h3><p>${esc(uiAccountExplanation(out.meaning))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Plan group parts'))}"><table class="review-table"><caption>${esc(uiText('Plan group parts'))}</caption><thead><tr><th scope="col">${esc(uiText('Part'))}</th><th scope="col">${esc(uiText('Products'))}</th><th scope="col">${esc(uiText('First retailer ID'))}</th><th scope="col">${esc(uiText('Last retailer ID'))}</th></tr></thead><tbody>${plans.map(plan => `<tr><th scope="row">${esc(uiNumber(plan.part))}</th><td>${esc(uiNumber(plan.item_count))}</td><td><code dir="ltr">${esc(plan.first_retailer_id)}</code></td><td><code dir="ltr">${esc(plan.last_retailer_id)}</code></td></tr>`).join('')}</tbody></table></div>${Array.isArray(out.destination_limitations) && out.destination_limitations.length ? `<ul>${out.destination_limitations.map(value => `<li>${esc(uiAccountExplanation(value))}</li>`).join('')}</ul>` : ''}<p class="form-note" id="create-catalog-plan-group-note">${esc(uiText('A plan group is saved from its whole source. Compare at most 50 products at a time; each part is its own unapproved plan that you approve and run separately.'))}</p>${recordDetails({lineage_group_id: out.lineage_group_id, group_source_hash: out.group_source_hash, source: out.source, plans}, uiText('Plan group source and hashes'))}<button type="button" class="button primary" id="create-catalog-plan-group" aria-describedby="create-catalog-plan-group-note">${esc(uiText('Save {count} products as {parts} plans', counts))}</button>`;
}
/** The saved plan group: one link per part's unapproved plan, which must be exactly the previewed parts. */
function catalogPlanGroupSavedMarkup(saved, preview) {
  const plans = Array.isArray(saved?.plans) ? saved.plans : [];
  if (
    saved?.record_kind !== 'catalog_plan_group' ||
    saved.lineage_group_id !== preview.lineage_group_id ||
    saved.parts !== preview.parts ||
    saved.item_count !== preview.item_count ||
    plans.length !== preview.parts ||
    plans.some(
      (plan, i) =>
        plan?.part !== i + 1 ||
        typeof plan.id !== 'string' ||
        !plan.id ||
        plan.item_count !== preview.plans[i].item_count,
    )
  )
    throw Error(uiText('The saved plan group could not be confirmed. Open Campaigns to review the saved plans.'));
  return `<h3 id="catalog-plan-group-saved-heading" tabindex="-1">${esc(uiText('{parts} unapproved plans saved', {parts: uiNumber(saved.parts)}))}</h3><p>${esc(uiAccountExplanation(saved.meaning))}</p><ol>${plans.map(plan => `<li><a href="/campaigns?id=${encodeURIComponent(plan.id)}">${esc(uiText('Part {part} of {parts}: {count} products', {part: uiNumber(plan.part), parts: uiNumber(saved.parts), count: uiNumber(plan.item_count)}))}</a></li>`).join('')}</ol>`;
}
// The Meta product attributes a comparison may name as held but not sent (src/meta-catalog-products.ts, COM-01).
const metaCatalogUnsentFieldNames = [
  'retailer_id',
  'name',
  'description',
  'short_description',
  'brand',
  'category',
  'fb_product_category',
  'product_type',
  'color',
  'size',
  'material',
  'pattern',
  'gtin',
  'manufacturer_part_number',
  'retailer_product_group_id',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
  'availability',
  'condition',
  'age_group',
  'gender',
  'visibility',
  'url',
  'image_url',
  'mobile_link',
  'sale_price_start_date',
  'sale_price_end_date',
  'additional_image_urls',
  'inventory',
  'currency',
  'sale_price',
];
// The X optional attributes a comparison may name as held but not sent (src/x-catalogs.ts, COM-01).
const xCatalogUnsentFieldNames = [
  'gtin',
  'mpn',
  'mobile_link',
  'additional_image_link',
  'google_product_category',
  'product_type',
  'inventory',
  'sale_price',
  'sale_price_effective_date',
  'gender',
  'color',
  'size',
  'age_group',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
];
// The Snapchat optional attributes a comparison may name as held but not sent (src/snapchat-catalog-comparison.ts).
const snapCatalogUnsentFieldNames = [
  'sale_price',
  'item_group_id',
  'google_product_category',
  'product_type',
  'additional_image_link',
  'mobile_link',
  'color',
  'size',
  'gender',
  'age_group',
  'material',
  'pattern',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
];
// Serving notes of the shared comparison item v2 (src/catalog-destinations.ts, COM-03).
const catalogServingNoteCodes = ['availability_limits_serving', 'staging_visibility'];
/**
 * The commerce destinations this page compares (COM-03): one description each, read by the single comparison validator
 * and table below. Meta proves price equality with its own native filter, so its prices are checked for consistency;
 * X and Snapchat return exact decimal prices, which are compared again here. Snapchat changes products only through
 * product feeds (feedOnly): its comparison names what to fix there and nothing is saved.
 */
function catalogWebDestination(gateway) {
  const fields = ['name', 'image_url', 'url', 'availability', 'condition', 'brand', 'description'];
  if (gateway === 'x_ads_native_action')
    return {
      gateway,
      fields,
      exactPrice: true,
      upsertRequired: true,
      unsent: xCatalogUnsentFieldNames,
      blocked: ['hidden_variant', 'grouped_product', 'group_status_unknown', 'retire_absent'],
      productId: /^[1-9][0-9]{0,24}$/,
      destinationOnly: 'note',
      removal: true,
      retire: true,
      feedOnly: false,
    };
  if (gateway === 'meta_native_action')
    return {
      gateway,
      fields: null,
      exactPrice: false,
      upsertRequired: false,
      unsent: metaCatalogUnsentFieldNames,
      blocked: ['existing_product_create_only', 'retire_absent'],
      productId: /^[1-9][0-9]{0,31}$/,
      // Owner decision P9: a populated attribute the source does not send makes an otherwise matching product unknown,
      // so it enters the review set (src/catalog-destinations.ts); before P9 it was only a note.
      destinationOnly: 'review',
      removal: false,
      retire: true,
      feedOnly: false,
    };
  if (gateway === 'snapchat_native_action')
    return {
      gateway,
      fields,
      exactPrice: true,
      upsertRequired: false,
      unsent: snapCatalogUnsentFieldNames,
      blocked: [],
      productId: /^[^\u0000-\u001f\u007f]{1,100}$/,
      destinationOnly: 'note',
      removal: false,
      retire: false,
      feedOnly: true,
    };
  throw Error(uiText('Catalog comparison scope or evidence changed. Validate and read the import again.'));
}
/** A supplied sale price as the destination receives it (COM-02 A): the decimal amount and the product currency. */
function catalogSaleText(product) {
  return String(product.sale_price).split(' ')[0] + ' ' + product.currency;
}
/** An exact X price in one canonical text: no leading zeros in the whole part, no trailing zeros in the fraction. */
function catalogExactMoney(value) {
  const m = typeof value === 'string' ? /^(\d{1,12})(?:\.(\d{1,6}))? ([A-Z]{3})$/.exec(value) : null;
  return m ? m[1].replace(/^0+(?=\d)/, '') + '.' + (m[2] ?? '').replace(/0+$/, '') + ' ' + m[3] : null;
}
const catalogIdentityBlocks = ['hidden_variant', 'grouped_product', 'group_status_unknown'];
/**
 * Checks a comparison against the request and preview it answers, for every destination (COM-03): its scope and
 * source, each item's identity, state, blocker, changes and unknown fields recomputed from its own evidence, and the
 * summary and review set. Any difference refuses the whole comparison.
 */
function validCatalogComparison(out, request, preview) {
  const d = catalogWebDestination(request.gateway),
    invalid = () => {
      throw Error(uiText('Catalog comparison scope or evidence changed. Validate and read the import again.'));
    };
  if (
    !out ||
    out.record_kind !== 'catalog_comparison' ||
    out.complete !== true ||
    out.source_hash !== preview.source_hash ||
    !out.scope ||
    ['gateway', 'account_id', 'connection_id', 'catalog_id'].some(k => out.scope[k] !== request[k]) ||
    (d.upsertRequired && request.allow_upsert !== true) ||
    // A feed-only destination says so, and names the feed as the remedy (COM-02 D).
    (d.feedOnly && (out.writes !== 'feed_only' || out.remedy !== 'fix_in_feed')) ||
    (!d.feedOnly && (out.writes !== undefined || out.remedy !== undefined)) ||
    !Number.isSafeInteger(out.captured_at) ||
    out.captured_at <= 0 ||
    !Array.isArray(out.items) ||
    out.items.length !== request.products.length ||
    out.item_count !== out.items.length ||
    !Array.isArray(out.review_retailer_ids)
  )
    invalid();
  // COM-02 E: the grouped records that keep a supplied SKU's absence unestablished (X only), named for the person. A
  // possible hidden variant always comes with them, and a fully read set of groups leaves none.
  const groups = out.variant_groups;
  if (
    (groups !== undefined &&
      (d.gateway !== 'x_ads_native_action' ||
        !groups ||
        typeof groups !== 'object' ||
        !['not_qualified', 'complete', 'incomplete'].includes(groups.expansion) ||
        !Number.isSafeInteger(groups.grouped_record_count) ||
        !Array.isArray(groups.grouped_records) ||
        groups.grouped_records.length > 10 ||
        groups.grouped_record_count < Math.max(1, groups.grouped_records.length) ||
        groups.grouped_records.some(
          r => !r || typeof r.retailer_id !== 'string' || !/^[1-9][0-9]{0,24}$/.test(r.product_id ?? ''),
        ) ||
        groups.remedy !== (groups.expansion === 'complete' ? null : 'scheduled_feed'))) ||
    (out.items.some(item => item?.blocked_reason === 'hidden_variant') &&
      groups !== undefined &&
      groups.remedy !== 'scheduled_feed')
  )
    invalid();
  const counts = {new: 0, changed: 0, matching: 0, unknown: 0, blocked: 0, needs_review: 0},
    review = [],
    // COM-02 B: a retirement sends the supplied row with the retirement availability.
    retiring = new Set(request.requirements?.retire_retailer_ids ?? []);
  let withUnsent = 0;
  out.items.forEach((item, index) => {
    const retire = retiring.has(request.products[index].retailer_id),
      s = retire
        ? {...request.products[index], availability: request.requirements.retire_availability}
        : request.products[index],
      // COM-01: attributes the destination holds that the source does not send. An older Meta server sends none.
      unsent = d.gateway === 'meta_native_action' ? (item?.unsent_fields ?? []) : item?.unsent_fields;
    if (
      !item ||
      item.retailer_id !== s.retailer_id ||
      !['new', 'changed', 'matching', 'unknown'].includes(item.state) ||
      typeof item.blocked !== 'boolean' ||
      ![true, false, null].includes(item.price_matches) ||
      !Array.isArray(item.changes) ||
      !Array.isArray(item.unknown_fields) ||
      !Array.isArray(unsent) ||
      unsent.some(k => !d.unsent.includes(k) || Object.hasOwn(s, k)) ||
      new Set(unsent).size !== unsent.length ||
      (item.serving_notes !== undefined &&
        (!Array.isArray(item.serving_notes) || item.serving_notes.some(k => !catalogServingNoteCodes.includes(k)))) ||
      // The shared blocker (item v2): named exactly when the product is blocked. An older Meta server names none.
      (item.blocked_reason !== undefined &&
        (item.blocked_reason === null ? item.blocked : !item.blocked || !d.blocked.includes(item.blocked_reason))) ||
      (item.blocked_reason === undefined && d.gateway !== 'meta_native_action') ||
      !item.before ||
      typeof item.before !== 'object' ||
      (d.exactPrice
        ? item.before.price !== null && !catalogExactMoney(item.before.price)
        : item.before.price !== undefined && item.before.price !== null && typeof item.before.price !== 'string')
    )
      invalid();
    const present = item.before.present;
    if (present === true) {
      if (
        typeof item.product_id !== 'string' ||
        !d.productId.test(item.product_id) ||
        item.before.id !== item.product_id ||
        (d.exactPrice && item.before.retailer_id !== s.retailer_id) ||
        (d.fields && d.fields.some(k => item.before[k] !== null && typeof item.before[k] !== 'string'))
      )
        invalid();
    } else if (
      item.product_id !== null ||
      ![false, null].includes(present) ||
      (present === null && item.blocked_reason !== 'hidden_variant') ||
      (d.exactPrice && item.before.price !== null)
    )
      invalid();
    if (item.blocked && catalogIdentityBlocks.includes(item.blocked_reason)) {
      // The product's identity is unknown (a grouped or possibly hidden variant): nothing else is compared.
      if (
        item.state !== 'unknown' ||
        item.price_matches !== null ||
        item.changes.length ||
        item.unknown_fields.length !== 1 ||
        item.unknown_fields[0] !== 'retailer_id' ||
        (present === null ? item.blocked_reason !== 'hidden_variant' : item.blocked_reason === 'hidden_variant')
      )
        invalid();
    } else {
      // Meta blocks an existing product under a create-only import, and a retirement blocks a missing product (it
      // would be created); X otherwise blocks only unknown identities.
      const createOnly = d.gateway === 'meta_native_action' && present === true && !request.allow_upsert,
        absent = retire && present !== true;
      if (
        item.blocked !== (createOnly || absent) ||
        (item.blocked_reason !== undefined &&
          item.blocked_reason !== (absent ? 'retire_absent' : createOnly ? 'existing_product_create_only' : null))
      )
        invalid();
      if (present !== true) {
        if (
          item.state !== 'new' ||
          item.price_matches !== null ||
          item.changes.length ||
          item.unknown_fields.length ||
          unsent.length
        )
          invalid();
      } else {
        let changes, unknown;
        if (d.exactPrice) {
          // X and Snapchat return every compared value and an exact price: changes and unknown fields are recomputed
          // here over the fields the source supplied (X requires them all; Snapchat's are partly optional).
          const supplied = d.fields.filter(k => s[k] !== undefined);
          unknown = supplied.filter(k => item.before[k] === null);
          changes = supplied.filter(k => item.before[k] !== null && item.before[k] !== s[k]);
          const price =
            item.before.price === null
              ? null
              : catalogExactMoney(item.before.price) === catalogExactMoney(s.price + ' ' + s.currency);
          if (price === null) unknown.push('price', 'currency');
          else if (!price) changes.push('price');
          // A supplied sale (COM-02 A): the amount compares exactly, the effective period literally; a product without
          // a current sale shows it as a change.
          let sale;
          const native = {
            sale_price: s.sale_price === undefined ? undefined : catalogSaleText(s),
            sale_price_effective_date:
              s.sale_price_start_date === undefined ? undefined : s.sale_price_start_date + '/' + s.sale_price_end_date,
          };
          if (native.sale_price !== undefined) {
            if (item.before.sale_price !== null && !catalogExactMoney(item.before.sale_price)) {
              sale = null;
              unknown.push('sale_price');
            } else {
              sale =
                item.before.sale_price !== null &&
                catalogExactMoney(item.before.sale_price) === catalogExactMoney(native.sale_price);
              if (!sale) changes.push('sale_price');
            }
          }
          if (
            native.sale_price_effective_date !== undefined &&
            item.before.sale_price_effective_date !== native.sale_price_effective_date
          )
            changes.push('sale_price_effective_date');
          if (
            item.price_matches !== price ||
            item.sale_price_matches !== sale ||
            item.unknown_fields.length !== unknown.length ||
            item.unknown_fields.some((k, i) => k !== unknown[i]) ||
            item.changes.length !== changes.length ||
            item.changes.some(
              (c, i) =>
                !c ||
                c.field !== changes[i] ||
                c.before !== item.before[c.field] ||
                (c.field === 'price'
                  ? c.after_native_price !== s.price + ' ' + s.currency
                  : c.field === 'sale_price'
                    ? c.after_native_price !== native.sale_price
                    : c.field === 'sale_price_effective_date'
                      ? c.after !== native.sale_price_effective_date
                      : c.after !== s[c.field]),
            )
          )
            invalid();
        } else {
          // Meta proves price equality with its own filter: every change and unknown field names a supplied field, and a
          // price change carries the preview's exact hundredths.
          changes = item.changes.map(c => c?.field);
          unknown = item.unknown_fields;
          if (
            typeof item.price_matches !== 'boolean' ||
            unknown.some(k => typeof k !== 'string' || !Object.hasOwn(s, k)) ||
            new Set(unknown).size !== unknown.length ||
            item.changes.some(
              c =>
                !c ||
                typeof c.field !== 'string' ||
                !Object.hasOwn(s, c.field) ||
                (c.before !== null && typeof c.before !== 'string') ||
                (['price', 'sale_price'].includes(c.field)
                  ? !Number.isSafeInteger(c.after_minor_units) ||
                    c.after_minor_units !==
                      preview.items[index]?.[c.field === 'price' ? 'price_minor_units' : 'sale_price_minor_units'] ||
                    c.currency !== s.currency
                  : c.after !== s[c.field]),
            ) ||
            new Set(changes).size !== changes.length ||
            changes.includes('price') === item.price_matches ||
            // A supplied sale price is compared with Meta's own sale_price_amount filter (COM-02 A).
            (s.sale_price === undefined
              ? item.sale_price_matches !== undefined || changes.includes('sale_price')
              : typeof item.sale_price_matches !== 'boolean' ||
                changes.includes('sale_price') === item.sale_price_matches)
          )
            invalid();
        }
        if (
          item.state !==
          (changes.length
            ? 'changed'
            : unknown.length || (d.destinationOnly === 'review' && unsent.length)
              ? 'unknown'
              : 'matching')
        )
          invalid();
      }
    }
    // A feed-only destination names the feed as the fix for every product that differs (COM-02 D).
    if (d.feedOnly ? item.fix_in !== (item.state === 'matching' ? null : 'feed') : item.fix_in !== undefined) invalid();
    counts[item.state]++;
    if (unsent.length) withUnsent++;
    if (item.blocked) counts.blocked++;
    else if (item.state !== 'matching') review.push(item.retailer_id);
  });
  counts.needs_review = review.length;
  if (
    !out.summary ||
    Object.keys(counts).some(k => out.summary[k] !== counts[k]) ||
    (out.summary.with_destination_only_values !== undefined &&
      out.summary.with_destination_only_values !== withUnsent) ||
    review.length !== out.review_retailer_ids.length ||
    review.some((id, i) => out.review_retailer_ids[i] !== id)
  )
    invalid();
  return {destination: d, counts, review};
}
function catalogServingNote(code) {
  return code === 'staging_visibility'
    ? uiText('The current product is in staging, so ads do not show it; the source does not change its visibility.')
    : uiText('Ads may not show this product with this availability.');
}
function catalogComparisonMarkup(out, request, preview) {
  const {destination: d, counts, review} = validCatalogComparison(out, request, preview),
    x = d.gateway === 'x_ads_native_action',
    // COM-02 D: Snapchat shows exact native values like X, but changes products only through feeds.
    exact = d.exactPrice,
    inventoryHtml = x ? catalogListedInventoryMarkup(out, request) : '',
    // COM-02 E: why a supplied product may be a hidden variant, naming the grouped records that can hide it.
    groups = out.variant_groups,
    variantHtml =
      x && groups?.remedy === 'scheduled_feed' && out.items.some(item => item.blocked_reason === 'hidden_variant')
        ? `<p class="notice">${esc(
            uiText(
              'X lists only the first product of each group, so grouped records can hide the supplied products marked as possible hidden variants ({count} in this catalog: {records}). Add or change product variants through the catalog’s scheduled feed.',
              {
                count: groups.grouped_record_count,
                records:
                  groups.grouped_records.map(r => r.retailer_id).join(', ') +
                  (groups.grouped_record_count > groups.grouped_records.length ? ', …' : ''),
              },
            ),
          )}</p>`
        : '',
    // COM-02 B: an existing product can be retired (kept, with an availability that keeps it out of ads) instead of
    // deleted; offered after an upsert comparison that is not already a retirement.
    retirable = d.retire && request.allow_upsert === true && request.requirements?.retire_retailer_ids === undefined,
    eligible = item => !item.blocked && item.before.present === true;
  const reason = key =>
    key === 'grouped_product'
      ? uiText('Grouped product; native variant updates are outside this import')
      : key === 'hidden_variant'
        ? uiText('Product may be a hidden variant; absence is not established')
        : key === 'group_status_unknown'
          ? uiText('Product-group status is unknown; a native update is withheld')
          : key === 'retire_absent'
            ? uiText('Not in the catalog; retiring would create it')
            : uiText('Existing product; updates are disabled');
  const rows = out.items
    .map((item, index) => {
      const s = request.products[index],
        unsent = item.unsent_fields ?? [],
        details =
          item.changes
            .map(c =>
              exact
                ? `<li>${esc(catalogFieldLabel(c.field))}: <bdi>${esc(c.before ?? uiText('Not set'))}</bdi> → <bdi>${esc(c.after_native_price ?? c.after)}</bdi></li>`
                : `<li>${esc(catalogFieldLabel(c.field))}: ${esc(c.before ?? uiText('Unknown'))} → ${esc(c.field === 'price' ? s.price + ' ' + s.currency : c.field === 'sale_price' ? catalogSaleText(s) : c.after)}</li>`,
            )
            .join('') +
          item.unknown_fields
            .map(k => `<li>${esc(catalogFieldLabel(k))}: ${esc(uiText('Current value is unknown'))}</li>`)
            .join(''),
        current = exact
          ? `<bdi>${esc(item.before.price ?? uiText('Unknown'))}</bdi>`
          : esc(item.before.price ?? uiText('Unknown')),
        notes =
          (unsent.length
            ? `<p class="form-note">${esc(d.feedOnly ? uiText('Other native attributes have values: {fields}. Your feed keeps or changes them; this comparison does not.', {fields: unsent.join(', ')}) : x ? uiText('Other native attributes have values: {fields}. X does not establish whether an update preserves omitted attributes.', {fields: unsent.join(', ')}) : uiText('Other native attributes have values: {fields}. Meta does not establish whether an update preserves omitted attributes.', {fields: unsent.join(', ')}))}</p>`
            : '') +
          (item.serving_notes ?? []).map(code => `<p class="form-note">${esc(catalogServingNote(code))}</p>`).join('') +
          (item.fix_in === 'feed'
            ? `<p class="form-note">${esc(uiText('Fix this product in the product feed.'))}</p>`
            : ''),
        removal = x
          ? `<td>${!item.blocked && item.before.present === true ? `<label><input type="checkbox" id="catalog-remove-${index}"> ${esc(uiText('Select {retailer_id} for removal', {retailer_id: item.retailer_id}))}</label>` : esc(uiText('Unavailable'))}</td>`
          : '',
        retire = retirable
          ? `<td>${eligible(item) ? `<label><input type="checkbox" id="catalog-retire-${index}"> ${esc(uiText('Retire {retailer_id}', {retailer_id: item.retailer_id}))}</label>` : esc(uiText('Unavailable'))}</td>`
          : '';
      // Owner decision P9: a product unknown only because the catalog holds values the source does not send says why.
      const destinationOnlyReview =
        d.destinationOnly === 'review' && item.state === 'unknown' && unsent.length > 0 && !details;
      return `<tr><th scope="row"><strong>${esc(s.name)}</strong><br><code>${esc(item.retailer_id)}</code>${item.product_id ? `<br>${esc(uiText('Product ID'))}: <code class="catalog-product-id" dir="ltr">${esc(item.product_id)}</code>` : ''}</th><td>${esc(catalogComparisonState(item.state))}${item.blocked ? `<p class="form-note">${esc(reason(item.blocked_reason))}</p>` : ''}</td><td>${esc(uiText('Current'))}: ${current}<br>${esc(uiText('Proposed'))}: <bdi>${esc(s.price + ' ' + s.currency)}</bdi></td><td>${details ? `<ul>${details}</ul>` : esc(item.state === 'new' ? uiText('No current product was returned') : destinationOnlyReview ? uiText('Every supplied field matches; it needs review because the catalog holds values this import does not send.') : uiText('All supplied fields have matching evidence'))}${notes}</td>${removal}${retire}</tr>`;
    })
    .join('');
  const headers = [
    uiText('Product'),
    uiText('Comparison'),
    uiText('Price'),
    uiText('Field differences'),
    ...(x ? [uiText('Select for removal')] : []),
    ...(retirable ? [uiText('Retire')] : []),
  ];
  const removable = x && out.items.some(eligible),
    retirement =
      retirable && out.items.some(eligible)
        ? `<p>${esc(uiText('Retiring keeps a product and its history but sets its availability so ads stop showing it; nothing is deleted. Each product still gets its own native review.'))}</p><label for="catalog-retire-availability">${esc(uiText('Retire as'))}<select id="catalog-retire-availability"><option value="discontinued">discontinued</option><option value="out of stock">out of stock</option></select></label><button type="button" class="button" id="save-catalog-retirement">${esc(uiText('Save retirement draft for selected products'))}</button>`
        : '';
  // A feed-only destination saves nothing: it names how many products to fix in the feed (COM-02 D).
  const next = d.feedOnly
    ? `<p class="notice">${esc(review.length ? uiText('Snapchat changes products only through product feeds. Fix the {count} products that differ in your feed; AMCP saves no draft for Snapchat.', {count: review.length}) : uiText('Every supplied product matches its Snapchat product. Nothing needs a fix in the feed.'))}</p>`
    : `<p>${esc(uiText('{count} products need a fresh native review before execution. Saving a plan does not submit product changes.', {count: review.length}))}</p>${review.length ? `<button type="button" class="button primary" id="save-catalog-changes">${esc(uiText('Save only products needing review'))}</button>` : `<p>${esc(uiText('No eligible product changes need a draft.'))}</p>`}`;
  return `<h3 id="catalog-comparison-heading" tabindex="-1">${esc(uiText('Compare current catalog products'))}</h3><p>${esc(uiText('Read {date} · {new} new · {changed} changed · {matching} matching · {unknown} unknown · {blocked} blocked', {date: date(out.captured_at), ...counts}))}</p><p class="notice">${esc(x ? uiText('Only supplied X product IDs are returned. Supported decimal prices compare exactly. Grouped or hidden variants are blocked; missing fields remain unknown. Repeated reads are sequential evidence, not a point-in-time inventory snapshot. A saved draft still needs fresh native review. Missing source products are not deleted.') : d.feedOnly ? uiText('Only supplied Snapchat product IDs are read, twice. Supported decimal prices compare exactly; missing fields remain unknown. Feed processing can take time, so this is current evidence, not a point-in-time inventory snapshot. Missing source products are not read or deleted.') : uiText('Only supplied retailer IDs are compared. Formatted native prices are display text; equality uses the native price filter. Unknown fields need review. This is current sequential evidence, not a point-in-time inventory snapshot. Missing source products are not deleted.'))}</p>${variantHtml}${inventoryHtml}<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Catalog comparison, scroll for all fields'))}"><table class="review-table"><caption>${esc(x ? uiText('Supplied X product comparison') : d.feedOnly ? uiText('Supplied Snapchat product comparison') : uiText('Compare current catalog products'))}</caption><thead><tr>${headers.map(k => `<th scope="col">${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>${next}${removable ? `<p>${esc(uiText('Select only the observed products you intend to remove. Products outside this selection are retained.'))}</p><button type="button" class="button" id="preview-catalog-removal">${esc(uiText('Preview selected removals'))}</button><div id="catalog-removal-preview" aria-live="polite"></div>` : ''}${retirement}`;
}
function catalogListedInventoryMarkup(out, request) {
  const invalid = () => {
    throw Error(uiText('Listed catalog evidence changed. Read the original source selection again.'));
  };
  if (request.inspect_other_listed_products !== true) {
    if (out.listed_inventory !== undefined) invalid();
    return '';
  }
  const inventory = out.listed_inventory,
    object = v => v && typeof v === 'object' && !Array.isArray(v),
    count = v => Number.isSafeInteger(v) && v >= 0 && v <= 1000,
    text = (v, max) =>
      typeof v === 'string' &&
      v === v.trim() &&
      v.length > 0 &&
      Array.from(v).length <= max &&
      !/[\u0000-\u001f\u007f]/.test(v),
    hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),
    source = new Set(request.products.map(p => p.retailer_id)),
    ids = new Set(),
    keys = new Set(),
    counts = {individual: 0, grouped: 0, unknown: 0},
    fields = [
      'retailer_id',
      'product_id',
      'name',
      'price',
      'currency',
      'group_status',
      'item_group_id',
      'item_group_key',
    ];
  if (
    request.gateway !== 'x_ads_native_action' ||
    request.absent_source_policy !== 'retain' ||
    !object(inventory) ||
    inventory.record_kind !== 'x_catalog_selection_inventory' ||
    inventory.coverage !== 'bounded_listed_products' ||
    inventory.listed_scan_complete !== true ||
    inventory.variant_inventory_complete !== false ||
    inventory.source_coverage !== 'supplied_products_only' ||
    inventory.source_absence_established !== false ||
    inventory.absent_source_policy !== 'retain' ||
    inventory.provider_mutations !== 0 ||
    inventory.destructive_deletions !== 0 ||
    !object(inventory.scope) ||
    Object.keys(inventory.scope).length !== 4 ||
    ['gateway', 'account_id', 'connection_id', 'catalog_id'].some(k => inventory.scope[k] !== request[k]) ||
    inventory.source_hash !== out.source_hash ||
    !hash(inventory.material_hash) ||
    !hash(inventory.observations_hash) ||
    inventory.requested_at !== out.requested_at ||
    inventory.captured_at !== out.captured_at ||
    !Number.isSafeInteger(inventory.requested_at) ||
    inventory.requested_at <= 0 ||
    inventory.requested_at > inventory.captured_at ||
    inventory.source_selection_count !== request.products.length ||
    !['listed_product_count', 'supplied_listed_count', 'outside_selection_count'].every(k => count(inventory[k])) ||
    !Array.isArray(inventory.items) ||
    inventory.items.length !== inventory.outside_selection_count ||
    inventory.supplied_listed_count !== out.items.filter(p => p.before.present === true).length ||
    inventory.listed_product_count !== inventory.supplied_listed_count + inventory.items.length ||
    !object(inventory.outside_selection_group_counts) ||
    Object.keys(inventory.outside_selection_group_counts).length !== 3
  )
    invalid();
  for (const item of inventory.items) {
    if (
      !object(item) ||
      Object.keys(item).length !== fields.length ||
      fields.some(k => !Object.hasOwn(item, k)) ||
      !text(item.retailer_id, 100) ||
      source.has(item.retailer_id) ||
      ids.has(item.retailer_id) ||
      typeof item.product_id !== 'string' ||
      !/^[1-9][0-9]{0,24}$/.test(item.product_id) ||
      keys.has(item.product_id) ||
      (item.name !== null && !text(item.name, 150)) ||
      !['individual', 'grouped', 'unknown'].includes(item.group_status) ||
      ['item_group_id', 'item_group_key'].some(k => item[k] !== null && !text(item[k], 100)) ||
      (item.group_status === 'individual' && (item.item_group_id !== null || item.item_group_key !== null)) ||
      (item.group_status === 'grouped' && item.item_group_id === null && item.item_group_key === null)
    )
      invalid();
    if (item.price === null) {
      if (item.currency !== null) invalid();
    } else {
      const price = typeof item.price === 'string' && /^(\d{1,12}(?:\.\d{1,6})?) ([A-Z]{3})$/.exec(item.price);
      if (!price || item.currency !== price[2]) invalid();
    }
    ids.add(item.retailer_id);
    keys.add(item.product_id);
    counts[item.group_status]++;
  }
  if (Object.keys(counts).some(k => inventory.outside_selection_group_counts[k] !== counts[k])) invalid();
  const evidence = Object.fromEntries(
    [
      'record_kind',
      'coverage',
      'listed_scan_complete',
      'variant_inventory_complete',
      'source_coverage',
      'source_absence_established',
      'absent_source_policy',
      'source_selection_count',
      'listed_product_count',
      'supplied_listed_count',
      'outside_selection_count',
      'outside_selection_group_counts',
      'material_hash',
      'items',
      'provider_mutations',
      'destructive_deletions',
      'scope',
      'source_hash',
      'requested_at',
      'captured_at',
      'observations_hash',
    ].map(k => [k, inventory[k]]),
  );
  return `<section aria-labelledby="catalog-inventory-heading"><h4 id="catalog-inventory-heading" tabindex="-1">${esc(uiText('Other listed X products'))}</h4><p>${esc(uiText('{listed} listed products · {selected} supplied products observed · {other} outside this source selection', {listed: inventory.listed_product_count, selected: inventory.supplied_listed_count, other: inventory.outside_selection_count}))}</p><p class="notice">${esc(uiText('Products outside this supplied selection are retained. Their store absence is unverified. X listing can hide other variants, so this is not a complete variant inventory or a point-in-time snapshot.'))}</p><div id="catalog-inventory-view" aria-live="polite">${catalogListedInventoryView(inventory)}</div><p>${esc(uiText('Select only listed products you intend to remove; none is selected for you. A product is never removed because your source lacks it.'))}</p><button type="button" class="button" id="preview-listed-removal">${esc(uiText('Preview removal of selected listed products'))}</button><div id="catalog-listed-removal-preview" aria-live="polite"></div>${recordDetails(evidence, uiText('Listed inventory evidence'))}</section>`;
}

function catalogListedInventoryView(inventory, query = '', page = 0, selected = null) {
  const groupLabel = status =>
      status === 'individual'
        ? uiText('Individual product')
        : status === 'grouped'
          ? uiText('Grouped product')
          : uiText('Product-group status is unknown'),
    term = query.trim().toLowerCase(),
    filtered = inventory.items.filter(p =>
      [
        p.retailer_id,
        p.product_id,
        p.name,
        p.price,
        p.currency,
        p.group_status,
        p.item_group_id,
        p.item_group_key,
        groupLabel(p.group_status),
      ]
        .filter(v => v !== null)
        .join(' ')
        .toLowerCase()
        .includes(term),
    ),
    size = 50,
    pages = Math.max(1, Math.ceil(filtered.length / size)),
    current = Math.max(0, Math.min(page, pages - 1)),
    from = current * size,
    rows = filtered
      .slice(from, from + size)
      .map(p => {
        const group = groupLabel(p.group_status),
          details = ['item_group_id', 'item_group_key']
            .filter(k => p[k] !== null)
            .map(
              k =>
                `<br>${esc(k === 'item_group_id' ? uiText('Native group ID') : uiText('Native group key'))}: <bdi>${esc(p[k])}</bdi>`,
            )
            .join(''),
          // COM-02 B: only an individual listed product can be selected, and none is selected for you.
          select = !selected
            ? ''
            : `<td>${p.group_status === 'individual' ? `<label><input type="checkbox" id="catalog-listed-remove-${esc(p.product_id)}"${selected.has(p.product_id) ? ' checked' : ''}> ${esc(uiText('Select {retailer_id} for removal', {retailer_id: p.retailer_id}))}</label>` : esc(uiText('Unavailable'))}</td>`;
        return `<tr><th scope="row"><strong><bdi>${esc(p.name ?? uiText('Unknown'))}</bdi></strong><br>${esc(uiText('Retailer ID'))}: <code dir="ltr">${esc(p.retailer_id)}</code><br>${esc(uiText('Product ID'))}: <code dir="ltr">${esc(p.product_id)}</code></th><td><bdi dir="ltr">${esc(p.price ?? uiText('Unknown'))}</bdi></td><td>${esc(group)}${details}</td>${select}</tr>`;
      })
      .join(''),
    headers = [
      uiText('Product'),
      uiText('Price'),
      uiText('Product grouping'),
      ...(selected ? [uiText('Select for removal')] : []),
    ];
  return `<div class="split"><label for="catalog-inventory-search">${esc(uiText('Find a listed product, native key, group or price'))}<input type="search" id="catalog-inventory-search" value="${esc(query)}"></label><div><button type="button" class="button" id="catalog-inventory-find">${esc(uiText('Search listed products'))}</button><button type="button" class="button" id="catalog-inventory-clear">${esc(uiText('Clear search'))}</button></div></div><p role="status">${esc(uiText('Showing {from}–{through} of {count} other listed products', {from: filtered.length ? from + 1 : 0, through: Math.min(from + size, filtered.length), count: filtered.length}))}</p>${filtered.length ? `<div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Other listed products, scroll for all fields'))}"><table class="review-table"><caption>${esc(uiText('Other listed X products'))}</caption><thead><tr>${headers.map(k => `<th scope="col">${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p>${esc(uiText('No other listed products match this view. This does not establish whole-store absence.'))}</p>`}<div class="pagination"><button type="button" class="button" id="catalog-inventory-previous" ${current === 0 ? 'disabled' : ''}>${esc(uiText('Previous'))}</button><span>${esc(uiText('Page {page} of {pages}', {page: current + 1, pages}))}</span><button type="button" class="button" id="catalog-inventory-next" ${current >= pages - 1 ? 'disabled' : ''}>${esc(uiText('Next'))}</button></div>`;
}

/**
 * The listed products of an inspection, searchable and paged, with an explicit removal selection by native key
 * (COM-02 B): nothing is preselected, a selection survives searching and paging, and changing it clears its preview.
 */
function bindCatalogListedInventory(inventory, active, request) {
  let query = '',
    page = 0,
    removalSequence = 0;
  const selected = new Set(),
    order = inventory.items.map(p => p.product_id),
    invalidate = () => {
      removalSequence++;
      const output = $('#catalog-listed-removal-preview');
      if (output) output.innerHTML = '';
    };
  const render = focus => {
    if (!active()) return;
    $('#catalog-inventory-view').innerHTML = catalogListedInventoryView(
      inventory,
      query,
      page,
      request ? selected : null,
    );
    const find = () => {
      if (!active()) return;
      query = $('#catalog-inventory-search').value;
      page = 0;
      render('#catalog-inventory-search');
    };
    workspaceBind('#catalog-inventory-find', find);
    workspaceBind('#catalog-inventory-clear', () => {
      if (!active()) return;
      query = '';
      page = 0;
      render('#catalog-inventory-search');
    });
    workspaceBind('#catalog-inventory-previous', () => {
      if (!active()) return;
      page = Math.max(0, page - 1);
      render('#catalog-inventory-heading');
    });
    workspaceBind('#catalog-inventory-next', () => {
      if (!active()) return;
      page++;
      render('#catalog-inventory-heading');
    });
    $('#catalog-inventory-search').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        find();
      }
    });
    if (request)
      for (const p of inventory.items)
        if (p.group_status === 'individual') {
          const box = $('#catalog-listed-remove-' + p.product_id);
          box?.addEventListener('change', () => {
            if (!active()) return;
            if (box.checked) selected.add(p.product_id);
            else selected.delete(p.product_id);
            invalidate();
          });
        }
    if (focus) $(focus).focus();
  };
  render();
  if (!request) return;
  workspaceBind('#preview-listed-removal', async () => {
    if (!active()) return;
    const product_keys = order.filter(key => selected.has(key));
    if (!product_keys.length) throw Error(uiText('Select at least one listed individual product to preview removal.'));
    const sequence = ++removalSequence,
      output = $('#catalog-listed-removal-preview'),
      removalActive = () =>
        active() &&
        sequence === removalSequence &&
        JSON.stringify(order.filter(key => selected.has(key))) === JSON.stringify(product_keys);
    output.innerHTML = `<p role="status">${esc(uiText('Reading selected products for a removal preview. No products are deleted.'))}</p>`;
    try {
      const proposed = await workspaceCall('workspace', {
        action: 'preview_catalog_removal',
        gateway: request.gateway,
        account_id: request.account_id,
        connection_id: request.connection_id,
        catalog_id: request.catalog_id,
        requirements: {
          selection_source: 'listed_inventory',
          product_keys,
          listed_inventory_hash: inventory.material_hash,
        },
      });
      if (!removalActive()) return;
      output.innerHTML = catalogListedRemovalMarkup(proposed, request, inventory, product_keys);
      $('#catalog-listed-removal-heading').focus();
      workspaceBind('#save-listed-removal', async () => {
        if (!removalActive()) return;
        const typed = $('#catalog-listed-removal-count').value.trim();
        if (!/^[1-9][0-9]?$/.test(typed) || Number(typed) !== proposed.targets.length)
          throw Error(uiText('Type the number of selected products to confirm their removal.'));
        try {
          const saved = await workspaceCall('workspace', {
            action: 'create_catalog_removal',
            preview_id: proposed.preview_id,
            preview_hash: proposed.preview_hash,
            confirmed: true,
            confirmed_count: Number(typed),
          });
          if (removalActive()) await navigate('/campaigns?id=' + encodeURIComponent(saved.id));
        } catch (error) {
          if (removalActive()) throw error;
        }
      });
    } catch (error) {
      if (removalActive()) {
        output.innerHTML = '';
        throw error;
      }
    }
  });
}

/** The removal preview of selected listed products, checked against the inspection the person selected from. */
function catalogListedRemovalMarkup(out, request, inventory, keys) {
  const listed = new Map(inventory.items.map(p => [p.product_id, p]));
  if (
    !out ||
    out.record_kind !== 'x_catalog_removal_preview' ||
    out.selection_source !== 'listed_inventory' ||
    out.confirmation !== 'confirmed_count' ||
    request.gateway !== 'x_ads_native_action' ||
    !out.scope ||
    ['gateway', 'account_id', 'connection_id', 'catalog_id'].some(k => out.scope[k] !== request[k]) ||
    out.listed_inventory_hash !== inventory.material_hash ||
    out.source_hash !== null ||
    !/^[a-f0-9]{64}$/.test(out.preview_hash ?? '') ||
    typeof out.preview_id !== 'string' ||
    !out.preview_id ||
    !Number.isSafeInteger(out.expires_at) ||
    out.expires_at <= Date.now() ||
    out.provider_mutations !== 0 ||
    out.destructive_deletions !== 0 ||
    !Array.isArray(out.targets) ||
    !keys.length ||
    out.targets.length !== keys.length ||
    out.item_count !== keys.length ||
    out.targets.some((target, i) => {
      const p = listed.get(keys[i]);
      return (
        !p ||
        p.group_status !== 'individual' ||
        !target?.before ||
        target.product_id !== keys[i] ||
        target.retailer_id !== p.retailer_id ||
        target.before.present !== true ||
        target.before.id !== keys[i] ||
        (target.before.name ?? null) !== p.name ||
        (target.before.price ?? null) !== p.price
      );
    })
  )
    throw Error(uiText('The selected removal preview changed. Inspect the listed products again.'));
  const rows = out.targets
    .map(
      target =>
        `<tr><th scope="row">${esc(target.before.name ?? target.retailer_id)}<br><code>${esc(target.retailer_id)}</code></th><td><code dir="ltr">${esc(target.product_id)}</code></td><td><bdi>${esc(target.before.price ?? uiText('Unknown'))}</bdi></td></tr>`,
    )
    .join('');
  return `<h4 id="catalog-listed-removal-heading" tabindex="-1">${esc(uiText('Selected listed product removals'))}</h4><p class="notice">${esc(uiText('These listed products are proposed for permanent deletion because you selected them, not because your source lacks them. Saving creates an unapproved draft and deletes no products. Each product requires native review, execution confirmation and read-back. A scheduled feed may restore products it still contains.'))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Selected listed product removals'))}"><table class="review-table"><caption>${esc(uiText('{count} explicitly selected products', {count: out.item_count}))}</caption><thead><tr>${[uiText('Product'), uiText('Product ID'), uiText('Current price')].map(k => `<th scope="col">${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><label for="catalog-listed-removal-count">${esc(uiText('Type the number of products to remove ({count})', {count: out.item_count}))}<input type="text" inputmode="numeric" id="catalog-listed-removal-count" autocomplete="off" maxlength="2"></label><button type="button" class="button" id="save-listed-removal">${esc(uiText('Save unapproved removal draft'))}</button>`;
}

function catalogRemovalMarkup(out, request, comparison, ids, preview) {
  const selected = comparison.items.filter(item => ids.includes(item.retailer_id));
  if (
    !out ||
    out.record_kind !== 'x_catalog_removal_preview' ||
    request.gateway !== 'x_ads_native_action' ||
    !out.scope ||
    ['gateway', 'account_id', 'connection_id', 'catalog_id'].some(k => out.scope[k] !== request[k]) ||
    out.source_hash !== preview.source_hash ||
    !/^[a-f0-9]{64}$/.test(out.preview_hash ?? '') ||
    typeof out.preview_id !== 'string' ||
    !out.preview_id ||
    !Number.isSafeInteger(out.expires_at) ||
    out.expires_at <= Date.now() ||
    out.provider_mutations !== 0 ||
    out.destructive_deletions !== 0 ||
    !Array.isArray(out.targets) ||
    selected.length !== ids.length ||
    !selected.length ||
    out.targets.length !== selected.length ||
    out.item_count !== selected.length ||
    out.targets.some(
      (target, i) =>
        target.retailer_id !== selected[i].retailer_id ||
        target.product_id !== selected[i].product_id ||
        selected[i].blocked ||
        selected[i].before.present !== true ||
        JSON.stringify(target.before) !== JSON.stringify(selected[i].before),
    )
  )
    throw Error(uiText('The selected removal preview changed. Compare the source products again.'));
  const rows = out.targets
    .map(
      target =>
        `<tr><th scope="row">${esc(target.before.name ?? target.retailer_id)}<br><code>${esc(target.retailer_id)}</code></th><td><code dir="ltr">${esc(target.product_id)}</code></td><td><bdi>${esc(target.before.price ?? uiText('Unknown'))}</bdi></td></tr>`,
    )
    .join('');
  return `<h3 id="catalog-removal-heading" tabindex="-1">${esc(uiText('Selected product removals'))}</h3><p class="notice">${esc(uiText('These selected products are proposed for permanent deletion. Saving creates an unapproved draft and deletes no products. Each product requires native review, execution confirmation and read-back. A scheduled feed may restore products it still contains.'))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Selected product removals'))}"><table class="review-table"><caption>${esc(uiText('{count} explicitly selected products', {count: out.item_count}))}</caption><thead><tr>${[uiText('Product'), uiText('Product ID'), uiText('Current price')].map(k => `<th scope="col">${esc(k)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><button type="button" class="button" id="save-catalog-removal">${esc(uiText('Save unapproved removal draft'))}</button>`;
}
async function renderCommerce() {
  // COM-01: the reviewed import comes first; it is the active journey. Store sources follow, collapsed into one
  // administrator disclosure until a source is configured, so the page no longer opens with forms that cannot run.
  // COM-02 D: Snapchat accounts are offered for a read-only comparison; their products change only through feeds.
  // ARC-01, P9: while WooCommerce is parked the store panels and the WooCommerce product source are not shown.
  const targets = accountChoices(['meta', 'x', 'snapchat']),
    storesOffered = commerceStoresOffered(),
    storeSources = typeof commerceSources === 'undefined' ? [] : commerceSources,
    storePanels = storesOffered
      ? wooCommerceConnectionsMarkup() + wooCommerceSourcePanelMarkup() + wooCommerceInventoryPanelMarkup()
      : '';
  content.innerHTML += `<section class="panel workspace-form"><h2>${esc(uiText('Reviewed catalog product import'))}</h2><p>${esc(uiText('Import up to 500 supplied products for the selected account and catalog; more than 50 are saved as one group of plans of at most 50 products each. Ownership is checked during native review. Every item keeps a separate review, receipt and read-back in its saved plan. Missing items are retained.'))}</p><p class="form-note">${esc(uiText('Product imports support Meta and X. Snapchat catalogs change only through feeds; AMCP compares their products read-only.'))}</p>${targets.length ? '' : `<p class="notice" id="catalog-no-destination">${accountChoicesEmptyNotice(targets, uiText('Connect a Meta or X ad account to import products.'), uiText('Manage connections'))}</p>`}<form id="catalog-import"><label>${esc(uiText('Meta, X or Snapchat ad account'))}<select name="target" required><option value="">${esc(uiText('Choose an account'))}</option>${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>${controls(uiText('Native product catalog ID'), 'text', '', 'catalog_id')}${controls(uiText('Import plan name'), 'text', 'Product catalog import', 'name')}<label>${esc(uiText('Product source'))}<select name="source_mode"><option value="csv">${esc(uiText('Product CSV'))}</option>${storesOffered ? `<option value="woocommerce">${esc(uiText('Selected WooCommerce products'))}</option>` : ''}</select></label><div id="catalog-csv-controls"><label>${esc(uiText('Product CSV'))}<input type="file" name="file" accept=".csv,text/csv" required></label></div><div id="catalog-woo-selection" class="form-note" aria-live="polite"></div><div id="catalog-destination-help" class="form-note" aria-live="polite"></div>${catalogMappingMarkup()}<label>${esc(uiText('Existing retailer IDs'))}<select name="allow_upsert"><option value="false">${esc(uiText('Create only — refuse existing IDs'))}</option><option value="true">${esc(uiText('Explicitly update existing IDs after native review'))}</option></select></label><button class="button primary" type="submit">${esc(uiText('Validate and preview products'))}</button></form><div id="catalog-preview"></div></section><p class="notice">${esc(uiText('Mapped supplier and WooCommerce exports use the selected Meta or X reviewed product contract. Choose the intended price, currency, image and destination fields. Live store synchronization and additional destinations require separate qualification.'))}</p>`;
  // One write for the store area: the store panels where WooCommerce is offered, otherwise only the removal of a stored
  // connection, for an administrator (or nothing).
  const parked = storesOffered ? '' : wooCommerceParkedMarkup();
  content.innerHTML += storesOffered
    ? storeSources.length
      ? storePanels
      : `<details class="panel" id="commerce-store-sources"><summary>${esc(uiText('Connect a store source (administrators)'))}</summary>${storePanels}</details>`
    : parked;
  if (storesOffered) {
    bindWooCommerceInventory();
    bindWooCommerceConnections();
  } else if (parked) bindWooCommerceConnections(true);
  const form = $('#catalog-import'),
    result = $('#catalog-preview'),
    begin = accountWorkflowContext(form, result);
  let selectedWoo = null;
  const updateSourceMode = () => {
    const woo = form.elements.source_mode.value === 'woocommerce';
    form.elements.file.required = !woo;
    $('#catalog-csv-controls').hidden = woo;
    $('#catalog-csv-mapping').hidden = woo;
    $('#catalog-mapping-controls').hidden = woo || form.elements.column_mode.value !== 'mapped';
  };
  form.elements.source_mode.addEventListener('change', () => {
    begin();
    updateSourceMode();
  });
  updateSourceMode();
  if (storesOffered)
    bindWooCommerceSource(
      (products, source, current) => {
        selectedWoo = {products: structuredClone(products), source, current};
        begin();
        form.elements.source_mode.value = 'woocommerce';
        updateSourceMode();
        $('#catalog-woo-selection').innerHTML =
          `<p>${esc(uiText('{count} original products selected from {store}. Validate the exact destination fields before saving a draft.', {count: products.length, store: source.scope.store_origin}))}</p>`;
        form.elements.target.focus();
      },
      () => {
        selectedWoo = null;
        begin();
        $('#catalog-woo-selection').innerHTML = '';
      },
    );
  const destinationHelp = () => {
    const target = form.elements.target.value === '' ? undefined : targets[Number(form.elements.target.value)];
    const snapchat = target?.gateway === 'snapchat_native_action';
    $('#catalog-destination-help').innerHTML =
      `<p>${esc(uiText(target?.gateway === 'x_ads_native_action' ? 'This X import requires every mapped product field, including product page, availability, condition, brand and plain text description. It accepts names up to 150 characters and source prices with up to six decimal places. Use exact native availability and condition values. Explicit upsert approval is required.' : target?.gateway === 'meta_native_action' ? 'Required columns: retailer_id, name, price, currency, image_url. Optional: url, availability, condition, brand, description, retailer_product_group_id. Select an exact Meta group column only when your source supplies it; no group is inferred. Price is a decimal amount in the product currency; Meta counts hundredths, so digits beyond two decimal places must be zeros (12.500 KWD is 12.50). Use HTTPS links.' : snapchat ? 'Snapchat changes catalog products only through product feeds, so AMCP compares them read-only and saves no draft. Required columns: retailer_id, name, price, currency, image_url. Optional: url, availability, condition, brand, description, sale_price. Prices are exact decimals.' : 'Choose an account to see the required destination fields.'))}</p>${target?.gateway === 'x_ads_native_action' ? `<p>${esc(uiText('X catalog access requires early-access entitlement. Previewing or saving a draft does not establish eligibility or publish a product.'))}</p>` : ''}${target && !snapchat ? `<p>${esc(uiText('Optional sale columns: sale_price (a decimal lower than the price, in the product currency), sale_price_start_date and sale_price_end_date (ISO 8601 with an explicit offset; X needs both or neither). Without them the destination keeps its current sale, which the comparison names.'))}</p>` : ''}`;
  };
  form.elements.target.addEventListener('change', () => {
    resetMapping();
    destinationHelp();
  });
  destinationHelp();
  const handoff = new URLSearchParams(location.search);
  if (handoff.has('catalog_comparison')) {
    // The comparison's gateway selects Meta or X (COM-01); an older link without one is a Meta comparison. A gateway
    // that does not match the account's own platform selects nothing.
    const keys = ['catalog_comparison', 'connection_id', 'account_id', 'catalog_id'],
      gateway = handoff.has('gateway') ? handoff.get('gateway') : 'meta_native_action',
      catalogPattern =
        gateway === 'x_ads_native_action'
          ? /^[1-9][0-9]{0,24}$/
          : gateway === 'meta_native_action'
            ? /^[1-9][0-9]{0,31}$/
            : gateway === 'snapchat_native_action'
              ? /^[A-Za-z0-9-]{1,64}$/
              : null,
      valid =
        keys.every(k => handoff.getAll(k).length === 1) &&
        handoff.getAll('gateway').length <= 1 &&
        handoff.get('catalog_comparison') === '1' &&
        catalogPattern !== null &&
        catalogPattern.test(handoff.get('catalog_id') ?? ''),
      selected = valid
        ? targets.findIndex(
            t =>
              t.gateway === gateway &&
              t.account_id === handoff.get('account_id') &&
              t.connection_id === handoff.get('connection_id'),
          )
        : -1;
    form.elements.target.value = selected < 0 ? '' : String(selected);
    if (selected >= 0) form.elements.catalog_id.value = handoff.get('catalog_id');
    destinationHelp();
    result.innerHTML = `<p class="notice">${esc(uiText(selected >= 0 ? 'The original account and catalog are selected. Choose the original CSV to validate and compare it again.' : 'The original catalog scope is no longer available. Choose a currently accessible account and catalog.'))}</p>`;
  }
  let loaded = null;
  const resetMapping = () => {
    const current = begin();
    if (!current()) return;
    loaded = null;
    $('#catalog-mapping').innerHTML = '';
    updateSourceMode();
  };
  form.elements.column_mode.addEventListener('change', resetMapping);
  form.elements.file.addEventListener('change', resetMapping);
  updateSourceMode();
  workspaceBind('#catalog-load-columns', async () => {
    const current = begin();
    if (!current()) return;
    loaded = null;
    $('#catalog-mapping').innerHTML = '';
    const file = form.elements.file.files[0];
    const target = form.elements.target.value === '' ? undefined : targets[Number(form.elements.target.value)];
    if (!target) throw Error(uiText('Choose the exact account.'));
    const fields = catalogSourceFields(target.gateway);
    if (!file || file.size > catalogCsvMaxBytes) throw Error(uiText('Choose a CSV of at most 192 KiB.'));
    let table;
    try {
      const text = await file.text();
      if (!current()) return;
      table = parseProductCSVTable(text);
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    if (!table.rows.length) throw Error(uiText('The CSV has no product rows.'));
    // COM-03: the catalog's saved mapping fills the columns it names; only the mapping is read, never the file's rows.
    const catalog = form.elements.catalog_id.value.trim();
    let saved = null;
    if (/^[A-Za-z0-9-]{1,64}$/.test(catalog)) {
      try {
        const read = await workspaceCall('workspace', {
          action: 'catalog_mapping',
          gateway: target.gateway,
          account_id: target.account_id,
          connection_id: target.connection_id,
          catalog_id: catalog,
        });
        if (!current()) return;
        saved =
          read?.record_kind === 'catalog_mapping' && read.profile === null
            ? {version: 0}
            : read?.record_kind === 'catalog_mapping' &&
                Number.isSafeInteger(read.profile?.version) &&
                read.profile.columns &&
                typeof read.profile.columns === 'object'
              ? read.profile
              : null;
      } catch (error) {
        if (current()) throw error;
        return;
      }
    }
    loaded = {
      file,
      table,
      target_key: JSON.stringify([target.gateway, target.account_id, target.connection_id]),
      mapping: saved
        ? {catalog_id: catalog, version: saved.version, identity: saved.columns?.retailer_id ?? null}
        : null,
    };
    const profile = saved?.version ? saved : null,
      identity = profile?.columns.retailer_id;
    $('#catalog-mapping').innerHTML =
      `<p>${esc(uiText('{rows} product rows loaded. Review each selected source column.', {rows: table.rows.length}))}</p>${profile ? `<p class="form-note">${esc(uiText('Saved mapping version {version} of this catalog filled the columns it names. Products are identified by the column {column}.', {version: profile.version, column: identity}))}</p>` : ''}<div class="work-filter">${fields.map(field => `<label>${esc(catalogFieldLabel(field))}<select id="catalog-map-${field}"><option value="">${esc(uiText('No column selected'))}</option>${table.headers.map(header => `<option value="${esc(header)}">${esc(header)}</option>`).join('')}</select></label>`).join('')}</div>${profile ? `<label><input type="checkbox" id="catalog-replace-identity"> ${esc(uiText('Identify products by another retailer ID column from now on'))}</label>` : ''}`;
    for (const key of fields)
      $('#catalog-map-' + key).value =
        profile && table.headers.includes(profile.columns[key])
          ? profile.columns[key]
          : !profile && table.headers.includes(key)
            ? key
            : '';
    if (profile) {
      form.elements.fixed_currency.value = profile.fixed_currency;
      form.elements.image_mode.value = profile.image_mode;
    }
  });
  workspaceBind('#catalog-import', async form => {
    const current = begin();
    if (!current()) return;
    const target = targets[Number(form.elements.target.value)];
    if (form.elements.target.value === '' || !target) throw Error(uiText('Choose the exact account.'));
    const file = form.elements.file.files[0],
      useWoo = form.elements.source_mode.value === 'woocommerce';
    if (!useWoo && (!file || file.size > catalogCsvMaxBytes)) throw Error(uiText('Choose a CSV of at most 192 KiB.'));
    const {label, ...binding} = target;
    const settings = {
      ...binding,
      catalog_id: form.elements.catalog_id.value.trim(),
      name: form.elements.name.value.trim(),
      allow_upsert: form.elements.allow_upsert.value === 'true',
    };
    // COM-03: a CSV of 51–500 products is validated and saved as one plan group of plans of at most 50 (`group`: the
    // source the preview must confirm). A Snapchat comparison reads at most 50 products, and saves nothing.
    let request, out, source, group;
    const grouped = rows => {
      if (rows <= 50) return false;
      if (binding.gateway === 'snapchat_native_action')
        throw Error(uiText('Compare at most 50 Snapchat products at a time.'));
      return true;
    };
    try {
      let products;
      if (useWoo) {
        if (binding.gateway !== 'meta_native_action')
          throw Error(
            uiText('WooCommerce source selection maps to Meta. X still requires all ten explicit CSV fields.'),
          );
        if (!selectedWoo || !selectedWoo.current())
          throw Error(uiText('Read and select current WooCommerce source products before previewing them.'));
        products = structuredClone(selectedWoo.products);
      } else if (form.elements.column_mode.value === 'mapped') {
        if (
          !loaded ||
          loaded.file !== file ||
          loaded.target_key !== JSON.stringify([binding.gateway, binding.account_id, binding.connection_id])
        )
          throw Error(uiText('Load the selected CSV columns before previewing mapped products.'));
        const selected = selectedCatalogSource(loaded.table, {
          gateway: binding.gateway,
          columns: Object.fromEntries(catalogSourceFields(binding.gateway).map(k => [k, $('#catalog-map-' + k).value])),
          fixed_currency: form.elements.fixed_currency.value.trim(),
          image_mode: form.elements.image_mode.value,
        });
        const many = grouped(loaded.table.rows.length);
        // The catalog's products keep the retailer ID column its saved mapping names unless the person explicitly
        // chooses another one; AMCP refuses an implicit change too.
        if (
          loaded.mapping?.catalog_id === settings.catalog_id &&
          loaded.mapping.identity &&
          selected.columns.retailer_id !== loaded.mapping.identity &&
          !$('#catalog-replace-identity')?.checked
        )
          throw Error(
            uiText(
              'This catalog’s products are identified by the column {column}. Keep it, or choose to identify products by another retailer ID column from now on.',
              {column: loaded.mapping.identity},
            ),
          );
        // COM-03: the mapping is saved as the catalog's versioned profile and AMCP projects the selected columns with
        // it, so the preview, comparison and saved plan all name the same source and mapping version.
        const mapping = await workspaceCall('workspace', {
          action: 'save_catalog_mapping',
          gateway: binding.gateway,
          account_id: binding.account_id,
          connection_id: binding.connection_id,
          catalog_id: settings.catalog_id,
          ...(loaded.mapping?.catalog_id === settings.catalog_id ? {revision: loaded.mapping.version} : {}),
          requirements: {
            columns: selected.columns,
            fixed_currency: form.elements.fixed_currency.value.trim(),
            image_mode: form.elements.image_mode.value,
            ...($('#catalog-replace-identity')?.checked ? {replace_identity_column: true} : {}),
          },
        });
        if (!current()) return;
        if (mapping?.record_kind !== 'catalog_mapping' || !Number.isSafeInteger(mapping.profile?.version))
          throw Error(uiText('The column mapping could not be confirmed. Load the CSV columns again.'));
        loaded.mapping = {
          catalog_id: settings.catalog_id,
          version: mapping.profile.version,
          identity: mapping.profile.columns?.retailer_id ?? null,
        };
        source = {kind: 'csv', text: selected.text, columns: 'profile', profile_version: mapping.profile.version};
        if (many) group = {rows: loaded.table.rows.length, columns: 'profile', version: mapping.profile.version};
        out = await workspaceCall('workspace', {
          action: 'catalog_preview',
          ...settings,
          requirements: {source, ...(group ? {chunked: true} : {})},
        });
        if (!current()) return;
        products = out?.supplied_products;
        if (
          !group &&
          (!Array.isArray(products) ||
            !products.length ||
            products.some(p => !p || typeof p !== 'object' || typeof p.retailer_id !== 'string') ||
            out.source?.columns !== 'profile' ||
            out.source?.mapping_profile?.version !== mapping.profile.version)
        )
          throw Error(uiText('The column mapping could not be confirmed. Load the CSV columns again.'));
      } else {
        const text = await file.text();
        if (!current()) return;
        products = parseProductCSV(text, binding.gateway);
        // More than 50 products: the whole CSV (its columns are AMCP product fields) is the plan group's source.
        if (grouped(products.length)) {
          group = {rows: products.length, columns: 'canonical'};
          source = {kind: 'csv', text, columns: 'canonical'};
          out = await workspaceCall('workspace', {
            action: 'catalog_preview',
            ...settings,
            requirements: {source, chunked: true},
          });
          if (!current()) return;
        }
      }
      if (group) result.innerHTML = catalogPlanGroupMarkup(out, group);
      else {
        request = {...settings, products};
        if (!source) out = await workspaceCall('workspace', {action: 'catalog_preview', ...request});
      }
    } catch (error) {
      if (current()) throw error;
      return;
    }
    if (!current()) return;
    if (group) {
      // Each part becomes its own unapproved plan; the saved group must be the previewed one.
      $('#catalog-plan-group-heading').focus();
      workspaceBind('#create-catalog-plan-group', async () => {
        if (!current()) return;
        try {
          const saved = await workspaceCall('workspace', {
            action: 'catalog_plan',
            ...settings,
            requirements: {source, chunked: true},
          });
          if (!current()) return;
          result.innerHTML = catalogPlanGroupSavedMarkup(saved, out);
          $('#catalog-plan-group-saved-heading').focus();
        } catch (error) {
          if (current()) throw error;
        }
      });
      return;
    }
    // A mapped CSV reaches AMCP as its source; the server projects it again for every comparison and plan (COM-03).
    const sourced = (extra = {}, requirements = {}) =>
      source
        ? {
            ...Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'products')),
            ...extra,
            requirements: {source, ...requirements},
          }
        : {...request, ...extra, ...(Object.keys(requirements).length ? {requirements} : {})};
    // COM-02 D: Snapchat products change only through feeds, so a Snapchat preview leads to a comparison and nothing else.
    const feedOnly = request.gateway === 'snapchat_native_action';
    result.innerHTML =
      `<button type="button" class="button primary" id="compare-catalog-products">${esc(uiText('Compare current catalog products'))}</button>` +
      (request.gateway === 'x_ads_native_action'
        ? `<button type="button" class="button" id="inspect-catalog-inventory" aria-describedby="catalog-inspection-limits catalog-inspection-feedback">${esc(uiText('Inspect other listed X products'))}</button><p id="catalog-inspection-limits" class="form-note">${esc(uiText('Inspect listed products in this X catalog. Products outside your source selection stay retained; full store and variant absence are unverified.'))}</p><div id="catalog-inspection-feedback" class="workspace-form-feedback" role="alert" aria-atomic="true" hidden></div>`
        : '') +
      catalogImportPreviewMarkup(out, request) +
      recordDetails(request.products, uiText('Exact product fields sent for review')) +
      (request.gateway === 'x_ads_native_action'
        ? recordDetails(
            out.plan?.steps?.map(step => step.arguments.payload),
            uiText('Exact X product fields sent for native review'),
          )
        : '') +
      `<p>${esc(uiAccountExplanation(out.meaning))}</p>` +
      (out.destination_limitations?.length
        ? `<ul>${out.destination_limitations.map(value => `<li>${esc(uiAccountExplanation(value))}</li>`).join('')}</ul>`
        : '') +
      recordDetails({source_hash: out.source_hash}, uiText('Source hash')) +
      `<div id="catalog-comparison" aria-live="polite"></div>` +
      (feedOnly
        ? ''
        : `<button class="button" id="create-catalog-plan" aria-describedby="create-catalog-plan-note">${esc(uiText('Save all supplied products for native review'))}</button><p class="form-note" id="create-catalog-plan-note"></p>`);
    let comparisonSequence = 0,
      // The latest validated comparison of these products and when it was read: "Save all" names it in the plan's
      // lineage while AMCP still accepts its reference (15 minutes), and saves without it afterwards (COM-03).
      compared = null;
    const compareCatalogProducts = async (inspectOther = false) => {
      if (!current()) return;
      const comparisonRequest = inspectOther
          ? {...request, inspect_other_listed_products: true, absent_source_policy: 'retain'}
          : request,
        sequence = ++comparisonSequence,
        comparison = $('#catalog-comparison'),
        active = () => current() && sequence === comparisonSequence;
      compared = null;
      if (request.gateway === 'x_ads_native_action') {
        $('#catalog-inspection-feedback').hidden = true;
        $('#catalog-inspection-feedback').innerHTML = '';
      }
      comparison.innerHTML = `<p role="status">${esc(inspectOther ? uiText('Reading other listed X products. No product changes are submitted.') : uiText('Reading supplied retailer IDs. No product changes are submitted.'))}</p>`;
      try {
        const evidence = await workspaceCall(
          'workspace',
          sourced({
            action: 'catalog_compare',
            ...(inspectOther ? {inspect_other_listed_products: true, absent_source_policy: 'retain'} : {}),
          }),
        );
        if (!active()) return;
        // The comparison a plan saved from it names in its lineage (COM-03); a stale reference is refused by AMCP.
        const lineage =
          typeof evidence?.lineage_token === 'string' &&
          evidence.lineage_token.startsWith('v1.') &&
          evidence.lineage_token.length <= 32768
            ? {comparison_token: evidence.lineage_token}
            : {};
        const html = catalogComparisonMarkup(evidence, comparisonRequest, out);
        if (!active()) return;
        comparison.innerHTML = html;
        compared = lineage.comparison_token ? {lineage, at: Date.now()} : null;
        $('#catalog-comparison-heading').focus();
        // After a comparison, "Save all" says how many supplied products already match (COM-01). An X plan records
        // those as unchanged when it reaches them and sends nothing; a Meta plan reviews and sends them again.
        const unchanged = evidence.items.filter(item => item.state === 'matching').length;
        if (!feedOnly) {
          $('#create-catalog-plan').textContent = unchanged
            ? uiText('Save all {count} supplied products ({unchanged} already match)', {
                count: request.products.length,
                unchanged,
              })
            : uiText('Save all supplied products for native review');
          $('#create-catalog-plan-note').textContent = !unchanged
            ? ''
            : request.gateway === 'x_ads_native_action'
              ? uiText(
                  'Products that still match when the plan reaches them are recorded as unchanged; nothing is sent for them.',
                )
              : uiText(
                  'Meta products that already match are reviewed and sent again; save only products needing review to leave them out.',
                );
        }
        if (inspectOther) bindCatalogListedInventory(evidence.listed_inventory, active, comparisonRequest);
        if (request.gateway === 'x_ads_native_action') {
          let removalSequence = 0;
          const selection = () =>
            evidence.items
              .filter((item, i) => !item.blocked && item.before.present === true && $('#catalog-remove-' + i).checked)
              .map(item => item.retailer_id);
          const invalidate = () => {
            if (!active()) return;
            removalSequence++;
            $('#catalog-removal-preview').innerHTML = '';
          };
          evidence.items.forEach((item, i) => {
            if (!item.blocked && item.before.present === true)
              $('#catalog-remove-' + i).addEventListener('change', invalidate);
          });
          if (evidence.items.some(item => !item.blocked && item.before.present === true))
            workspaceBind('#preview-catalog-removal', async () => {
              if (!active()) return;
              const retailer_ids = selection();
              if (!retailer_ids.length)
                throw Error(uiText('Select at least one observed individual product to preview removal.'));
              const sequence = ++removalSequence,
                output = $('#catalog-removal-preview');
              const removalActive = () =>
                active() &&
                sequence === removalSequence &&
                JSON.stringify(selection()) === JSON.stringify(retailer_ids);
              output.innerHTML = `<p role="status">${esc(uiText('Reading selected products for a removal preview. No products are deleted.'))}</p>`;
              try {
                const proposed = await workspaceCall('workspace', {
                  action: 'preview_catalog_removal',
                  ...request,
                  retailer_ids,
                });
                if (!removalActive()) return;
                output.innerHTML = catalogRemovalMarkup(proposed, request, evidence, retailer_ids, out);
                $('#catalog-removal-heading').focus();
                workspaceBind('#save-catalog-removal', async () => {
                  if (!removalActive()) return;
                  try {
                    const saved = await workspaceCall('workspace', {
                      action: 'create_catalog_removal',
                      preview_id: proposed.preview_id,
                      preview_hash: proposed.preview_hash,
                      confirmed: true,
                    });
                    if (removalActive()) await navigate('/campaigns?id=' + encodeURIComponent(saved.id));
                  } catch (error) {
                    if (removalActive()) throw error;
                  }
                });
              } catch (error) {
                if (removalActive()) {
                  output.innerHTML = '';
                  throw error;
                }
              }
            });
        }
        // COM-02 B: retire the selected existing products through the reviewed upsert; nothing is deleted.
        const retirable = item => !item.blocked && item.before.present === true;
        if (!feedOnly && comparisonRequest.allow_upsert === true && evidence.items.some(retirable))
          workspaceBind('#save-catalog-retirement', async () => {
            if (!active()) return;
            const retire_retailer_ids = evidence.items
              .filter((item, i) => retirable(item) && $('#catalog-retire-' + i).checked)
              .map(item => item.retailer_id);
            if (!retire_retailer_ids.length) throw Error(uiText('Select at least one existing product to retire.'));
            const retire_availability = $('#catalog-retire-availability').value,
              products = request.products.filter(p => retire_retailer_ids.includes(p.retailer_id)),
              retirement = {retire_retailer_ids, retire_availability, ...lineage};
            try {
              const plan = await workspaceCall(
                'workspace',
                source
                  ? sourced(
                      {action: 'catalog_plan'},
                      {select_retailer_ids: products.map(p => p.retailer_id), ...retirement},
                    )
                  : {action: 'catalog_plan', ...request, products, requirements: retirement},
              );
              if (active()) await navigate('/campaigns?id=' + encodeURIComponent(plan.id));
            } catch (error) {
              if (active()) throw error;
            }
          });
        if (!feedOnly && evidence.review_retailer_ids.length)
          workspaceBind('#save-catalog-changes', async () => {
            if (!active()) return;
            const selected = new Set(evidence.review_retailer_ids),
              products = request.products.filter(p => selected.has(p.retailer_id));
            if (!products.length) return;
            try {
              const plan = await workspaceCall(
                'workspace',
                source
                  ? sourced(
                      {action: 'catalog_plan'},
                      {select_retailer_ids: products.map(p => p.retailer_id), ...lineage},
                    )
                  : {
                      action: 'catalog_plan',
                      ...request,
                      products,
                      ...(lineage.comparison_token ? {requirements: lineage} : {}),
                    },
              );
              if (active()) await navigate('/campaigns?id=' + encodeURIComponent(plan.id));
            } catch (error) {
              if (active()) throw error;
            }
          });
      } catch (error) {
        if (active()) {
          comparison.innerHTML = '';
          if (inspectOther) {
            const feedback = $('#catalog-inspection-feedback');
            feedback.innerHTML = `<p>${esc(errorMessage(error))}</p>`;
            feedback.hidden = false;
          } else throw error;
        }
      }
    };
    workspaceBind('#compare-catalog-products', () => compareCatalogProducts(false));
    if (request.gateway === 'x_ads_native_action')
      workspaceBind('#inspect-catalog-inventory', () => compareCatalogProducts(true));
    if (!feedOnly)
      workspaceBind('#create-catalog-plan', async () => {
        if (!current()) return;
        try {
          const plan = await workspaceCall(
            'workspace',
            sourced({action: 'catalog_plan'}, compared && Date.now() - compared.at < 840000 ? compared.lineage : {}),
          );
          if (current()) await navigate('/campaigns?id=' + encodeURIComponent(plan.id));
        } catch (error) {
          if (current()) throw error;
        }
      });
  });
}
// The page body this module provides (web/routes.js).
AMCP.routes.register('/commerce', {render: renderCommerce});
