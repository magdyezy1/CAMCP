'use strict';
// WEB-07: the WooCommerce store source of the Commerce page (parked, PRK-01): store connections, the selected product
// source and the published inventory. One module per store source, loaded with web/commerce.js, which renders its
// panels; it was moved here unchanged.
function wooCommerceVariationControlsMarkup() {
  return `<label>${esc(uiText('WooCommerce source selection'))}<select name="source_kind"><option value="products">${esc(uiText('Standalone products'))}</option><option value="variations">${esc(uiText('Selected variations of one parent'))}</option></select></label><label id="woo-parent-control" hidden>${esc(uiText('Exact published variable parent product ID'))}<input type="text" name="parent_product_id" inputmode="numeric" maxlength="20" pattern="[1-9][0-9]{0,19}" disabled></label><p class="form-note">${esc(uiText('Variation mode reads only the IDs you enter under the selected parent. Review the native parent group and a destination title for each selected child; no variation name is inferred as a native value.'))}</p>`;
}
function wooCommerceVariationRow(item, currency) {
  const review = item.blockers.length
    ? item.blockers.map(message => `<p>${esc(uiAccountExplanation(message))}</p>`).join('')
    : `<label>${esc(uiText('Review destination title'))}<input type="text" id="woo-title-${esc(item.product_id)}" maxlength="500" value="${esc(item.suggested_destination_name ?? '')}"></label><label><input type="checkbox" id="woo-product-${esc(item.product_id)}">${esc(uiText('Select this variation with the reviewed title and shown parent SKU as its Meta group'))}</label>`;
  return `<tr><th scope="row">${esc(item.parent_name ?? uiText('Unknown'))}<br><code dir="ltr">${esc(item.product_id)}</code><p>${esc(uiText('Native parent SKU'))}: <code dir="ltr">${esc(item.parent_sku ?? uiText('Unknown'))}</code></p>${item.attributes.map(attribute => `<p>${esc(attribute.name)}: ${esc(attribute.option)}</p>`).join('')}</th><td><code dir="ltr">${esc(item.sku ?? uiText('Unknown'))}</code></td><td><bdi dir="ltr">${esc(item.selected_price ?? uiText('Unknown'))} ${esc(currency)}</bdi></td><td><code dir="ltr">${esc(item.stock_status ?? uiText('Unknown'))}</code><br><code dir="ltr">${esc(item.tax_status ?? uiText('Unknown'))}</code></td><td>${item.first_image_url ? `<code dir="ltr">${esc(item.first_image_url)}</code>` : esc(uiText('Unknown'))}<p>${esc(uiText('Provider-reported variation image; custom-child image origin is unverified.'))}</p></td><td>${review}</td></tr>`;
}
function commerceAdministrator() {
  return (
    typeof session !== 'undefined' &&
    session.authenticated === true &&
    !session.testAccount &&
    (session.administrator === true || ['owner', 'admin'].includes(session.workspaceRole))
  );
}
/** WooCommerce store sources are parked (ARC-01, P9): offered only where the deployment's AMCP_PROVIDERS names them. */
function commerceStoresOffered() {
  return !(typeof providersNotOffered !== 'undefined' && providersNotOffered.includes('woocommerce'));
}
/**
 * While WooCommerce is parked, an administrator sees only the stored store connections, to remove one: no store is
 * connected or read, and nothing else of the store panels is shown.
 */
function wooCommerceParkedMarkup() {
  const sources = typeof commerceSources === 'undefined' ? [] : commerceSources;
  if (!commerceAdministrator() || !sources.length) return '';
  return `<section class="panel workspace-form" id="woo-connections"><div class="panel-header"><h2>${esc(uiText('WooCommerce store connections'))}</h2><button class="button" type="button" id="woo-stores-refresh">${esc(uiText('Refresh store list'))}</button></div><p class="notice" id="woo-parked">${esc(uiText('This deployment does not offer WooCommerce store sources: their work is parked. No store is connected or read. You can still remove a stored connection.'))}</p>${wooCommerceRemovalMarkup(sources, true)}</section>`;
}
function wooCommerceRemovalMarkup(sources, open) {
  return `<details${open ? ' open' : ''}><summary>${esc(uiText('Remove a local store connection'))}</summary><p id="woo-remove-help">${esc(uiText('Removal deletes this AMCP connection, its encrypted key, discovery metadata and related finished report data. Reviews, receipts and audit history remain. The WooCommerce key, products and provider access are unchanged.'))}</p><form id="woo-remove" aria-describedby="woo-remove-help"><label>${esc(uiText('Configured WooCommerce store'))}<select name="target" required><option value="">${esc(uiText('Choose a store'))}</option>${sources.map((item, i) => `<option value="${i}">${esc(item.label)} · ${esc(item.store_origin)}</option>`).join('')}</select></label><label class="form-note"><input type="checkbox" name="confirmed" required>${esc(uiText('I confirm removal of the selected local AMCP connection and its related stored report data.'))}</label><button class="button danger" type="submit">${esc(uiText('Remove local connection'))}</button></form><div id="woo-remove-result" aria-live="polite"></div></details>`;
}
function wooCommerceConnectionsMarkup() {
  if (!commerceAdministrator()) return '';
  const sources = typeof commerceSources === 'undefined' ? [] : commerceSources;
  return `<section class="panel workspace-form" id="woo-connections"><div class="panel-header"><h2>${esc(uiText('WooCommerce store connections'))}</h2><button class="button" type="button" id="woo-stores-refresh">${esc(uiText('Refresh store list'))}</button></div><p>${esc(uiText('Connect an existing Read REST API key to inspect products. This grants AMCP read access only.'))}</p><details ${sources.length ? '' : 'open'}><summary>${esc(uiText('Connect a WooCommerce source'))}</summary><p id="woo-connect-help">${esc(uiText('Use WooCommerce → Settings → Advanced → REST API to inspect an existing key and its user. Choose a key with Read permission. AMCP verifies product and currency reads, stores the key encrypted and never changes the store.'))} <a href="https://woocommerce.com/document/woocommerce-rest-api/" target="_blank" rel="noreferrer">${esc(uiText('Official WooCommerce key guide ↗'))}</a></p><p class="form-note">${esc(uiText('Use the exact HTTPS origin on port 443 without a path. Setup is limited to 3 requests, 256 KiB and 20 seconds. Read success cannot independently establish the key’s native write permission.'))}</p><form id="woo-connect" aria-describedby="woo-connect-help"><label>${esc(uiText('Store label'))}<input name="label" type="text" required maxlength="200" autocomplete="off"></label><label>${esc(uiText('HTTPS store origin'))}<input name="store_origin" type="url" required maxlength="2048" dir="ltr" autocomplete="off" spellcheck="false" placeholder="https://shop.example.com"></label><label>${esc(uiText('Consumer Key'))}<input name="consumer_key" type="password" required minlength="4" maxlength="203" autocomplete="off" spellcheck="false" dir="ltr" pattern="ck_[A-Za-z0-9]+"></label><label>${esc(uiText('Consumer Secret'))}<input name="consumer_secret" type="password" required minlength="4" maxlength="203" autocomplete="off" spellcheck="false" dir="ltr" pattern="cs_[A-Za-z0-9]+"></label><label class="form-note"><input type="checkbox" name="confirmed" required>${esc(uiText('I confirm this existing key has Read permission and authorize encrypted storage and read verification in this workspace.'))}</label><p class="form-note">${esc(uiText('Credential fields are cleared when submitted and are never included in the result. If a reply is interrupted, refresh the store list before adding another connection.'))}</p><button class="button primary" type="submit">${esc(uiText('Verify reads and connect'))}</button></form><div id="woo-connect-result" aria-live="polite"></div></details>${sources.length ? wooCommerceRemovalMarkup(sources, false) : ''}</section>`;
}
function wooConnectionResult(out, request) {
  const origin = new URL(request.store_origin).origin;
  if (
    out?.record_kind !== 'woocommerce_connection' ||
    out.connection_id !== request.connection_id ||
    out.store_origin !== origin ||
    out.label !== request.label ||
    !/^wc_[a-f0-9]{64}$/.test(out.account_id ?? '') ||
    out.account_id_kind !== 'amcp_origin_binding' ||
    out.key_permission !== 'read' ||
    out.key_permission_evidence !== 'operator_recorded' ||
    out.read_access_verified !== true ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(out.verified_at ?? '') ||
    !Number.isFinite(Date.parse(out.verified_at)) ||
    !/^[A-Z]{3}$/.test(out.native_currency ?? '') ||
    !Number.isSafeInteger(out.reported_published_products) ||
    out.reported_published_products < 0 ||
    out.full_inventory !== false ||
    out.writes_enabled !== false ||
    out.credentials_disclosed !== false ||
    out.provider_mutations !== 0 ||
    typeof out.replayed !== 'boolean' ||
    out.network_requests !== (out.replayed ? 0 : 3) ||
    !Number.isSafeInteger(out.collected_bytes) ||
    out.collected_bytes < (out.replayed ? 0 : 1) ||
    out.collected_bytes > 256 * 1024
  )
    throw Error(
      uiText('The WooCommerce setup result does not match this request. Refresh the store list before trying again.'),
    );
  return `<h3 tabindex="-1" id="woo-connect-heading">${esc(uiText(out.replayed ? 'Existing store connection recovered' : 'Store read access verified'))}</h3><p><strong>${esc(out.label)}</strong> · <bdi dir="ltr">${esc(out.store_origin)}</bdi></p><p>${esc(uiText('Verified {date} · Reported published products: {count}', {date: date(out.verified_at), count: uiNumber(out.reported_published_products)}))} · <bdi dir="ltr">${esc(out.native_currency)}</bdi></p><p>${esc(uiText('AMCP store binding'))}: <code dir="ltr">${esc(out.account_id)}</code></p><p class="form-note">${esc(uiText('This binding identifies the origin inside AMCP; it is not a native WooCommerce store ID.'))}</p><p class="notice">${esc(uiText('Product and currency access were verified during setup. Read permission is your recorded selection; full inventory, future access and destination eligibility still need inspection. Store writes remain disabled.'))}</p>${out.replayed ? `<p>${esc(uiText('This is the original setup result. No new store reads were made by this retry.'))}</p>` : ''}<button class="button" type="button" id="woo-connect-refresh">${esc(uiText('Refresh store list'))}</button>`;
}
function bindWooCommerceConnections(parked = false) {
  if (!commerceAdministrator()) return;
  const identity = session,
    identityValue = identityKey(session),
    navigation = navigationGeneration,
    identityVersion = identityGeneration,
    sources = [...commerceSources],
    authorized = () => commerceAdministrator() && session === identity && identityKey(session) === identityValue;
  const bindRefresh = (selector, current) =>
    workspaceBind(selector, async () => {
      if (!current() || !authorized()) return;
      if (
        !(await confirmAction({
          title: uiText('Refresh the Commerce page?'),
          consequence: uiText('The store list will refresh. Unsaved Commerce entries on this page will be cleared.'),
          confirmLabel: uiText('Refresh store list'),
        })) ||
        !current() ||
        !authorized()
      )
        return;
      const data = await api('/api/platforms');
      if (!current() || !authorized()) return;
      if (
        !Array.isArray(data.commerce_sources) ||
        data.commerce_sources.some(
          item =>
            !item ||
            typeof item !== 'object' ||
            !/^[A-Za-z0-9_-]{1,160}$/.test(item.connection_id ?? '') ||
            !/^[A-Za-z0-9_-]{1,160}$/.test(item.account_id ?? '') ||
            typeof item.label !== 'string' ||
            item.label.length > 200 ||
            typeof item.store_origin !== 'string' ||
            item.store_origin.length > 2048,
        )
      )
        throw Error(uiText('The store list could not be refreshed. Reload Commerce before starting another setup.'));
      commerceSources = data.commerce_sources.map(item => ({
        connection_id: item.connection_id,
        account_id: item.account_id,
        label: item.label,
        store_origin: item.store_origin,
      }));
      await navigate('/commerce');
    });
  bindRefresh(
    '#woo-stores-refresh',
    () =>
      authorized() &&
      navigation === navigationGeneration &&
      identityVersion === identityGeneration &&
      $('#woo-connections').isConnected,
  );
  // A parked WooCommerce (ARC-01, P9) shows no connect form: only stored connections can be removed.
  if (!parked) bindWooCommerceConnect(authorized, bindRefresh);
  if (!sources.length) return;
  const remove = $('#woo-remove'),
    removeResult = $('#woo-remove-result'),
    removeBegin = accountWorkflowContext(remove, removeResult);
  let removing = false,
    removed = false;
  workspaceBind(
    '#woo-remove',
    async () => {
      if (removing || removed || !authorized()) return;
      const attempt = removeBegin(),
        current = () => attempt() && authorized(),
        value = remove.elements.target.value,
        source = /^\d+$/.test(value) ? sources[Number(value)] : undefined;
      if (!current() || !source || remove.elements.confirmed.checked !== true)
        throw Error(uiText('Choose a store and explicitly confirm removal of its local AMCP connection.'));
      if (
        !(await confirmAction({
          title: uiText('Remove this local WooCommerce connection?'),
          consequence: uiText(
            'This deletes the selected AMCP connection, encrypted key and related stored report data. The WooCommerce store and native key remain unchanged.',
          ),
          confirmLabel: uiText('Remove local connection'),
        })) ||
        !current()
      )
        return;
      removing = true;
      try {
        const out = await api('/api/commerce/stores/' + encodeURIComponent(source.connection_id), {
          method: 'DELETE',
          body: JSON.stringify({confirmed: true}),
        });
        if (!current()) return;
        if (
          out.success !== true ||
          out.disconnected !== true ||
          out.connection_id !== source.connection_id ||
          out.gateway !== 'commerce_native_action' ||
          out.network_requests !== 0 ||
          out.provider_changes !== 0
        )
          throw Error(uiText('The WooCommerce removal result does not match this connection. Refresh the store list.'));
        removed = true;
        removeResult.innerHTML = `<h3 tabindex="-1" id="woo-remove-heading">${esc(uiText('Local store connection removed'))}</h3><p>${esc(uiText('The WooCommerce store and native key are unchanged. Refresh the store list before another source read.'))}</p><button class="button" type="button" id="woo-remove-refresh">${esc(uiText('Refresh store list'))}</button>`;
        $('#woo-remove-heading').focus({preventScroll: true});
        bindRefresh('#woo-remove-refresh', current);
      } catch (error) {
        if (current()) throw error;
      } finally {
        removing = false;
      }
    },
    {disabled: () => removed},
  );
}
function bindWooCommerceConnect(authorized, bindRefresh) {
  const form = $('#woo-connect'),
    result = $('#woo-connect-result'),
    begin = accountWorkflowContext(form, result),
    requestId = crypto.randomUUID();
  let submitting = false,
    completed = false;
  workspaceBind(
    '#woo-connect',
    async () => {
      if (submitting || completed || !authorized()) return;
      const attempt = begin(),
        current = () => attempt() && authorized(),
        request = {
          connection_id: requestId,
          store_origin: form.elements.store_origin.value,
          label: form.elements.label.value,
          consumer_key: form.elements.consumer_key.value,
          consumer_secret: form.elements.consumer_secret.value,
          key_permission: 'read',
          confirmed: form.elements.confirmed.checked === true,
        };
      if (!current()) return;
      submitting = true;
      form.elements.consumer_key.value = '';
      form.elements.consumer_secret.value = '';
      const fields = ['label', 'store_origin', 'consumer_key', 'consumer_secret', 'confirmed'];
      for (const field of fields) form.elements[field].disabled = true;
      try {
        const out = await api('/api/commerce/stores', {method: 'POST', body: JSON.stringify(request)});
        if (!current()) return;
        result.innerHTML = wooConnectionResult(out, request);
        completed = true;
        $('#woo-connect-heading').focus({preventScroll: true});
        bindRefresh('#woo-connect-refresh', current);
      } catch (error) {
        if (current()) throw error;
      } finally {
        // Retain no secret in a retry cache. The stable request ID lets an explicitly re-entered identical key recover the original result.
        request.consumer_key = request.consumer_secret = '';
        submitting = false;
        if (current()) for (const field of fields) form.elements[field].disabled = false;
      }
    },
    {disabled: () => completed},
  );
}
function wooCommerceSourcePanelMarkup() {
  const sources = typeof commerceSources === 'undefined' ? [] : commerceSources;
  return `<section class="panel workspace-form"><h2>${esc(uiText('WooCommerce product source'))}</h2><p>${esc(uiText('Read 1–50 explicitly selected published products from a configured store. Choose the intended price field. The first native image is shown; tax, sale activation and variants are not inferred.'))}</p>${sources.length ? '' : `<p class="notice">${esc(uiText('No qualified WooCommerce source is configured. Ask a workspace administrator to connect an existing Read key in the store connections section of Commerce.'))}</p>`}<form id="woo-source">${wooCommerceVariationControlsMarkup()}<label>${esc(uiText('Configured WooCommerce store'))}<select name="target" required><option value="">${esc(uiText('Choose a store'))}</option>${sources.map((item, i) => `<option value="${i}">${esc(item.label)} · ${esc(item.store_origin)}</option>`).join('')}</select></label><label>${esc(uiText('Exact WooCommerce product or variation IDs'))}<textarea name="product_ids" required maxlength="1050" placeholder="101, 102"></textarea></label><label>${esc(uiText('Native source price field'))}<select name="price_field" required><option value="">${esc(uiText('Choose a price field'))}</option><option value="price">${esc(uiText('Current native price'))}</option><option value="regular_price">${esc(uiText('Regular native price'))}</option><option value="sale_price">${esc(uiText('Native sale price field'))}</option></select></label><button class="button" type="submit">${esc(uiText('Read selected source products'))}</button></form><div id="woo-source-result" aria-live="polite"></div></section>`;
}
function wooCommerceSourceSelection(out, request) {
  const scope = out?.scope,
    variations = request.requirements.source_kind === 'variations',
    requestedIds = variations ? request.requirements.variation_ids : request.requirements.product_ids;
  if (
    out?.record_kind !== 'catalog_source' ||
    out.complete_selected_evidence !== true ||
    out.full_inventory !== false ||
    out.source_saved !== false ||
    out.provider_mutations !== 0 ||
    out.destructive_deletions !== 0 ||
    scope?.gateway !== request.gateway ||
    scope.account_id !== request.account_id ||
    scope.connection_id !== request.connection_id ||
    scope.price_field !== request.requirements.price_field ||
    scope.source_kind !== (variations ? 'variations' : undefined) ||
    (variations &&
      (scope.parent_product_id !== request.requirements.parent_product_id ||
        out.parent?.product_id !== scope.parent_product_id ||
        out.parent.product_type !== 'variable' ||
        out.parent.status !== 'publish')) ||
    !/^[A-Z]{3}$/.test(out.native_currency ?? '') ||
    !/^[a-f0-9]{64}$/.test(out.source_hash ?? '') ||
    !Array.isArray(out.items) ||
    out.items.length !== requestedIds.length ||
    out.selected_product_count !== out.items.length ||
    out.native_requests !== (variations ? 6 : 4) ||
    out.collected_rows !== out.items.length * 2 + (variations ? 2 : 0) ||
    !Array.isArray(out.product_ids) ||
    out.product_ids.length !== out.items.length ||
    new Set(out.product_ids).size !== out.items.length ||
    out.items.some(
      item =>
        !requestedIds.includes(item.product_id) ||
        !out.product_ids.includes(item.product_id) ||
        item.status !== 'publish' ||
        !Array.isArray(item.blockers) ||
        (variations &&
          (item.name !== null ||
            item.requires_title_review !== true ||
            item.parent_product_id !== scope.parent_product_id ||
            item.parent_name !== out.parent.name ||
            item.parent_sku !== out.parent.sku ||
            !Array.isArray(item.attributes) ||
            item.attributes.length > 25)),
    ) ||
    new Set(out.items.map(item => item.product_id)).size !== out.items.length
  )
    throw Error(uiText('The WooCommerce source selection or scope changed. Read its products again.'));
  return out.items;
}
function wooCommerceSourceMarkup(out, request) {
  const items = wooCommerceSourceSelection(out, request);
  const rows = items
    .map(item =>
      request.requirements.source_kind === 'variations'
        ? wooCommerceVariationRow(item, out.native_currency)
        : `<tr><th scope="row">${esc(item.name ?? uiText('Unknown'))}<br><code dir="ltr">${esc(item.product_id)}</code></th><td><code dir="ltr">${esc(item.sku ?? uiText('Unknown'))}</code></td><td><bdi dir="ltr">${esc(item.selected_price ?? uiText('Unknown'))} ${esc(out.native_currency)}</bdi></td><td><code dir="ltr">${esc(item.stock_status ?? uiText('Unknown'))}</code><br><code dir="ltr">${esc(item.tax_status ?? uiText('Unknown'))}</code></td><td>${item.first_image_url ? `<code dir="ltr">${esc(item.first_image_url)}</code>` : esc(uiText('Unknown'))}</td><td>${item.blockers.length ? item.blockers.map(message => `<p>${esc(uiAccountExplanation(message))}</p>`).join('') : `<label><input type="checkbox" id="woo-product-${esc(item.product_id)}">${esc(uiText('Select for Meta preview'))}</label>`}</td></tr>`,
    )
    .join('');
  return `<h3 id="woo-source-heading" tabindex="-1">${esc(uiText('Selected store products'))}</h3><p>${esc(uiText('Read {date} · {count} selected products · {currency}', {date: date(out.captured_at), count: out.selected_product_count, currency: out.native_currency}))}</p><p class="notice">${esc(uiAccountExplanation(out.meaning))}</p><p>${esc(uiText(request.requirements.source_kind === 'variations' ? 'Price field: {field}. Native child SKU, price, currency, image and parent SKU are preserved. Each destination title is an operator-reviewed suggestion, not a native child name. Backorders and unknown stock stay omitted.' : 'Price field: {field}. Mapping uses the shown SKU, name, exact price, currency and first image. Instock and outofstock map to their literal availability; backorders and unknown stock stay omitted.', {field: scopePriceLabel(request.requirements.price_field)}))}</p><div class="data-scroll" role="region" tabindex="0" aria-label="${esc(uiText('WooCommerce source products, scroll for all fields'))}"><table class="review-table"><caption>${esc(uiText('Explicit WooCommerce product selection'))}</caption><thead><tr>${[uiText('Product'), uiText('Retailer ID'), uiText('Price'), uiText('Native stock and tax settings'), uiText('First native image URL'), uiText('Selection or blockers')].map(label => `<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><button type="button" class="button" id="use-woo-products">${esc(uiText('Use selected products for Meta preview'))}</button>`;
}
function scopePriceLabel(field) {
  return field === 'price'
    ? uiText('Current native price')
    : field === 'regular_price'
      ? uiText('Regular native price')
      : uiText('Native sale price field');
}
function bindWooCommerceSource(useProducts, clearProducts) {
  const sources = typeof commerceSources === 'undefined' ? [] : commerceSources,
    form = $('#woo-source'),
    result = $('#woo-source-result'),
    begin = accountWorkflowContext(form, result);
  const invalidate = () => {
    begin();
    clearProducts();
  };
  form.addEventListener('input', invalidate);
  form.addEventListener('change', invalidate);
  const adjustSourceKind = () => {
    const variations = form.elements.source_kind.value === 'variations';
    $('#woo-parent-control').hidden = !variations;
    form.elements.parent_product_id.disabled = !variations;
    form.elements.parent_product_id.required = variations;
  };
  form.elements.source_kind.addEventListener('change', () => {
    adjustSourceKind();
    invalidate();
  });
  adjustSourceKind();
  const handoff = new URLSearchParams(location.search),
    keys = ['woo_source', 'connection_id', 'account_id', 'product_ids', 'price_field'];
  if (handoff.get('woo_source') === '1' && keys.every(key => handoff.getAll(key).length === 1)) {
    const selected = sources.findIndex(
        item => item.connection_id === handoff.get('connection_id') && item.account_id === handoff.get('account_id'),
      ),
      ids = (handoff.get('product_ids') ?? '').split(','),
      field = handoff.get('price_field'),
      variations = handoff.get('source_kind') === 'variations',
      parentId = handoff.get('parent_product_id');
    if (
      selected >= 0 &&
      ids.length >= 1 &&
      ids.length <= 50 &&
      new Set(ids).size === ids.length &&
      ids.every(id => /^[1-9][0-9]{0,19}$/.test(id)) &&
      (!handoff.has('source_kind') ||
        (variations &&
          handoff.getAll('source_kind').length === 1 &&
          handoff.getAll('parent_product_id').length === 1 &&
          /^[1-9][0-9]{0,19}$/.test(parentId ?? ''))) &&
      (variations || !handoff.has('parent_product_id')) &&
      ['price', 'regular_price', 'sale_price'].includes(field)
    ) {
      form.elements.target.value = String(selected);
      form.elements.product_ids.value = ids.join(', ');
      form.elements.price_field.value = field;
      form.elements.source_kind.value = variations ? 'variations' : 'products';
      form.elements.parent_product_id.value = variations ? parentId : '';
      adjustSourceKind();
    }
  }
  workspaceBind('#woo-source', async () => {
    const current = begin();
    clearProducts();
    if (!current()) return;
    const source = form.elements.target.value === '' ? undefined : sources[Number(form.elements.target.value)],
      ids = form.elements.product_ids.value.trim().split(/[,\s]+/),
      price = form.elements.price_field.value,
      variations = form.elements.source_kind.value === 'variations',
      parentId = form.elements.parent_product_id.value.trim();
    if (
      !source ||
      !['products', 'variations'].includes(form.elements.source_kind.value) ||
      (variations && !/^[1-9][0-9]{0,19}$/.test(parentId)) ||
      ids.length < 1 ||
      ids.length > 50 ||
      new Set(ids).size !== ids.length ||
      ids.some(id => !/^[1-9][0-9]{0,19}$/.test(id)) ||
      !['price', 'regular_price', 'sale_price'].includes(price)
    )
      throw Error(uiText('Choose a store, 1–50 distinct published product IDs and an explicit price field.'));
    const request = {
      action: 'catalog_source',
      gateway: 'commerce_native_action',
      connection_id: source.connection_id,
      account_id: source.account_id,
      requirements: variations
        ? {source_kind: 'variations', parent_product_id: parentId, variation_ids: ids, price_field: price}
        : {product_ids: ids, price_field: price},
    };
    try {
      const out = await workspaceCall('workspace', request);
      if (!current()) return;
      result.innerHTML = wooCommerceSourceMarkup(out, request);
      $('#woo-source-heading').focus();
      for (const item of out.items.filter(item => !item.blockers.length)) {
        $('#woo-product-' + item.product_id).addEventListener('change', clearProducts);
        if (variations)
          $('#woo-title-' + item.product_id).addEventListener('input', () => {
            $('#woo-product-' + item.product_id).checked = false;
            clearProducts();
          });
      }
      workspaceBind('#use-woo-products', () => {
        if (!current()) return;
        const items = wooCommerceSourceSelection(out, request).filter(
          item => !item.blockers.length && $('#woo-product-' + item.product_id).checked,
        );
        if (!items.length) throw Error(uiText('Select at least one eligible source product for the Meta preview.'));
        const products = items.map(item => {
          const name = variations ? $('#woo-title-' + item.product_id).value : item.name;
          if (
            variations &&
            (typeof name !== 'string' ||
              !name ||
              name !== name.trim() ||
              name.length > 500 ||
              /[\x00-\x1f\x7f]/.test(name))
          )
            throw Error(
              uiText(
                'Review an exact plain destination title without surrounding whitespace for every selected variation.',
              ),
            );
          return {
            retailer_id: item.sku,
            name,
            ...(variations ? {retailer_product_group_id: item.parent_sku} : {}),
            price: item.selected_price,
            currency: out.native_currency,
            image_url: item.first_image_url,
            ...(item.product_url ? {url: item.product_url} : {}),
            ...(item.stock_status === 'instock'
              ? {availability: 'in stock'}
              : item.stock_status === 'outofstock'
                ? {availability: 'out of stock'}
                : {}),
          };
        });
        useProducts(products, out, current);
      });
    } catch (error) {
      if (current()) {
        result.innerHTML = '';
        throw error;
      }
    }
  });
}
function wooCommerceInventoryPanelMarkup() {
  const sources = typeof commerceSources === 'undefined' ? [] : commerceSources;
  return `<section class="panel workspace-form"><h2>${esc(uiText('Inspect published store inventory'))}</h2><p>${esc(uiText('Read the published product collection and every reported variable-parent variation. Native statuses and selected prices remain exact. This inspection creates no import, draft or deletion.'))}</p><p id="woo-inventory-limits" class="form-note">${esc(uiText('Two complete scans must agree within 1,000 products and variations per scan, 64 requests, 8 MiB and 60 seconds. Unpublished parents and independently verified grouped-product membership are outside this inspection.'))}</p><form id="woo-inventory" aria-describedby="woo-inventory-limits"><label>${esc(uiText('Configured WooCommerce store'))}<select name="target" required><option value="">${esc(uiText('Choose a store'))}</option>${sources.map((item, i) => `<option value="${i}">${esc(item.label)} · ${esc(item.store_origin)}</option>`).join('')}</select></label><label>${esc(uiText('Native source price field'))}<select name="price_field" required><option value="">${esc(uiText('Choose a price field'))}</option><option value="price">${esc(uiText('Current native price'))}</option><option value="regular_price">${esc(uiText('Regular native price'))}</option><option value="sale_price">${esc(uiText('Native sale price field'))}</option></select></label><button class="button" type="submit" ${sources.length ? '' : 'disabled'}>${esc(uiText('Inspect inventory without changes'))}</button></form><div id="woo-inventory-result" aria-live="polite"></div></section>`;
}
function wooCommerceInventorySelection(out, request, source) {
  const invalid = () => {
      throw Error(uiText('The WooCommerce inventory scope or completeness changed. Read it again.'));
    },
    scope = out?.scope,
    count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000,
    hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value),
    ids = new Set(),
    parents = new Map();
  if (
    out?.record_kind !== 'catalog_source_inventory' ||
    out.state !== 'complete' ||
    out.complete_collected_inventory !== true ||
    scope?.gateway !== request.gateway ||
    scope.account_id !== request.account_id ||
    scope.connection_id !== request.connection_id ||
    scope.store_origin !== source.store_origin ||
    scope.api_version !== 'wc/v3' ||
    scope.source_kind !== 'inventory' ||
    scope.absent_source_policy !== 'retain' ||
    scope.price_field !== request.requirements.price_field ||
    scope.product_status !== 'publish' ||
    scope.variation_status !== 'any' ||
    out.point_in_time !== false ||
    out.unpublished_parents_collected !== false ||
    out.grouped_membership !== 'not_independently_verified' ||
    out.destination_eligibility !== 'unverified' ||
    out.provider_mutations !== 0 ||
    out.destructive_deletions !== 0 ||
    out.saved_drafts !== 0 ||
    out.source_saved !== false ||
    !/^[A-Z]{3}$/.test(out.native_currency ?? '') ||
    !hash(out.source_hash) ||
    !count(out.item_count) ||
    !count(out.product_count) ||
    !count(out.variation_count) ||
    out.item_count !== out.product_count + out.variation_count ||
    !Array.isArray(out.items) ||
    out.items.length !== out.item_count ||
    !Number.isSafeInteger(out.captured_at) ||
    out.captured_at <= 0 ||
    !Number.isSafeInteger(out.native_requests) ||
    out.native_requests < 5 ||
    out.native_requests > 64 ||
    out.collected_rows !== out.item_count * 2 ||
    !Number.isSafeInteger(out.collected_bytes) ||
    out.collected_bytes < 1 ||
    out.collected_bytes > 8388608 ||
    !out.limits ||
    out.limits.items_per_scan !== 1000 ||
    out.limits.page_size !== 100 ||
    out.limits.requests !== 64 ||
    out.limits.bytes !== 8388608 ||
    out.limits.elapsed_ms !== 60000 ||
    !Array.isArray(out.scans) ||
    out.scans.length !== 2 ||
    !out.scans[0] ||
    !out.scans[1] ||
    out.scans[0].source_hash !== out.scans[1].source_hash ||
    out.scans.some(
      (scan, i) =>
        scan.scan !== i + 1 ||
        scan.item_count !== out.item_count ||
        !hash(scan.source_hash) ||
        !Array.isArray(scan.pages) ||
        !scan.pages.length,
    ) ||
    !Array.isArray(out.currency_evidence) ||
    out.currency_evidence.length !== 3 ||
    out.currency_evidence.some(
      value =>
        !value ||
        value.value !== out.native_currency ||
        !hash(value.source_hash) ||
        !Number.isSafeInteger(value.observed_at) ||
        value.observed_at <= 0,
    ) ||
    out.meaning !==
      'All published parent products and every reported variable-parent variation were collected twice within the stated bounds. Native IDs, selected price strings, statuses and reported memberships are preserved. The supported observations and store currency agreed across the sequential scans. This is not a point-in-time snapshot, unpublished-parent inventory, verified grouped-product membership, destination eligibility or write approval. Missing source products are retained; no product, draft or snapshot was changed or saved.'
  )
    invalid();
  const fields = [
    'product_id',
    'sku',
    'status',
    'selected_price',
    'stock_status',
    'tax_status',
    'virtual',
    'downloadable',
    'date_modified_gmt',
    'entity_kind',
    'product_type',
    'name',
    'parent_product_id',
  ];
  const items = out.items.map(item => {
    if (
      !item ||
      typeof item !== 'object' ||
      !id(item.product_id) ||
      ids.has(item.product_id) ||
      !['product', 'variation'].includes(item.entity_kind) ||
      ['sku', 'status', 'selected_price', 'stock_status', 'tax_status', 'date_modified_gmt', 'name'].some(
        key =>
          item[key] !== null &&
          (typeof item[key] !== 'string' || item[key].length > 500 || /[\x00-\x1f\x7f]/.test(item[key])),
      ) ||
      ['virtual', 'downloadable'].some(key => item[key] !== null && typeof item[key] !== 'boolean')
    )
      invalid();
    ids.add(item.product_id);
    if (item.entity_kind === 'product') {
      if (
        item.status !== 'publish' ||
        item.parent_product_id !== '0' ||
        !['simple', 'variable', 'grouped', 'external'].includes(item.product_type) ||
        !Array.isArray(item.variation_ids) ||
        !Array.isArray(item.reported_grouped_product_ids) ||
        [item.variation_ids, item.reported_grouped_product_ids].some(
          values =>
            values.length > 1000 ||
            new Set(values).size !== values.length ||
            values.some(value => !id(value) || value === item.product_id),
        ) ||
        (item.product_type !== 'variable' && item.variation_ids.length) ||
        (item.product_type !== 'grouped' && item.reported_grouped_product_ids.length)
      )
        invalid();
      parents.set(item.product_id, item);
      return {
        ...Object.fromEntries(fields.map(key => [key, item[key]])),
        variation_ids: [...item.variation_ids],
        reported_grouped_product_ids: [...item.reported_grouped_product_ids],
      };
    }
    if (
      item.product_type !== 'variation' ||
      !['publish', 'draft', 'pending', 'private', 'future'].includes(item.status) ||
      item.name !== null ||
      item.requires_title_review !== true ||
      !id(item.parent_product_id) ||
      !Array.isArray(item.attributes) ||
      item.attributes.length > 25 ||
      ['parent_name', 'parent_sku'].some(
        key =>
          item[key] !== null &&
          (typeof item[key] !== 'string' || item[key].length > 500 || /[\x00-\x1f\x7f]/.test(item[key])),
      ) ||
      item.attributes.some(
        a =>
          !a ||
          typeof a.id !== 'string' ||
          !/^(0|[1-9][0-9]{0,19})$/.test(a.id) ||
          ['name', 'option'].some(k => typeof a[k] !== 'string' || a[k].length > 200 || /[\x00-\x1f\x7f]/.test(a[k])),
      ) ||
      new Set(item.attributes.map(a => (a.id === '0' ? 'custom:' + a.name : a.id))).size !== item.attributes.length
    )
      invalid();
    return {
      ...Object.fromEntries(fields.map(key => [key, item[key]])),
      parent_name: item.parent_name,
      parent_sku: item.parent_sku,
      requires_title_review: true,
      attributes: item.attributes.map(a => ({id: a.id, name: a.name, option: a.option})),
    };
  });
  if (parents.size !== out.product_count) invalid();
  for (const parent of parents.values()) {
    const children = items.filter(
        item => item.entity_kind === 'variation' && item.parent_product_id === parent.product_id,
      ),
      memberIds = new Set(parent.variation_ids);
    if (
      children.length !== memberIds.size ||
      children.some(
        child =>
          !memberIds.has(child.product_id) || child.parent_name !== parent.name || child.parent_sku !== parent.sku,
      )
    )
      invalid();
  }
  if (
    items.some(
      item =>
        item.entity_kind === 'variation' &&
        (!parents.has(item.parent_product_id) || parents.get(item.parent_product_id).product_type !== 'variable'),
    )
  )
    invalid();
  const variables = [...parents.values()].filter(parent => parent.product_type === 'variable');
  const scans = out.scans.map(scan => {
    const collections = new Map(),
      pages = scan.pages.map(page => {
        if (
          !page ||
          !['product', 'variation'].includes(page.entity_kind) ||
          !Number.isSafeInteger(page.page) ||
          page.page < 1 ||
          page.page > 10 ||
          !Number.isSafeInteger(page.count) ||
          page.count < 0 ||
          page.count > 100 ||
          !count(page.total) ||
          !Number.isSafeInteger(page.total_pages) ||
          page.total_pages < 0 ||
          page.total_pages > 10 ||
          !hash(page.source_hash) ||
          !Number.isSafeInteger(page.observed_at) ||
          page.observed_at <= 0
        )
          invalid();
        const parent = page.entity_kind === 'variation' ? parents.get(page.parent_product_id) : null;
        if (
          page.entity_kind === 'product'
            ? page.parent_product_id !== null
            : !parent || parent.product_type !== 'variable'
        )
          invalid();
        const expected = parent ? parent.variation_ids.length : out.product_count,
          key = parent ? parent.product_id : 'products',
          previous = collections.get(key) ?? {pages: 0, rows: 0, total_pages: page.total_pages};
        if (
          page.total !== expected ||
          page.page !== previous.pages + 1 ||
          page.total_pages !== previous.total_pages ||
          (expected ? page.total_pages !== Math.ceil(expected / 100) : page.total_pages > 1) ||
          page.count !== Math.min(100, expected - previous.rows)
        )
          invalid();
        collections.set(key, {pages: page.page, rows: previous.rows + page.count, total_pages: page.total_pages});
        return Object.fromEntries(
          [
            'entity_kind',
            'parent_product_id',
            'page',
            'count',
            'total',
            'total_pages',
            'source_hash',
            'observed_at',
          ].map(key => [key, page[key]]),
        );
      });
    if (
      collections.size !== variables.length + 1 ||
      !collections.has('products') ||
      variables.some(parent => !collections.has(parent.product_id)) ||
      [...collections.values()].some(value => value.pages !== Math.max(1, value.total_pages)) ||
      pages.reduce((sum, page) => sum + page.count, 0) !== out.item_count
    )
      invalid();
    return {scan: scan.scan, item_count: scan.item_count, source_hash: scan.source_hash, pages};
  });
  if (out.native_requests !== 3 + scans.reduce((sum, scan) => sum + scan.pages.length, 0)) invalid();
  return {
    ...Object.fromEntries(
      [
        'record_kind',
        'state',
        'complete_collected_inventory',
        'native_currency',
        'item_count',
        'product_count',
        'variation_count',
        'source_hash',
        'captured_at',
        'native_requests',
        'collected_rows',
        'collected_bytes',
        'point_in_time',
        'unpublished_parents_collected',
        'grouped_membership',
        'destination_eligibility',
        'provider_mutations',
        'destructive_deletions',
        'saved_drafts',
        'source_saved',
        'meaning',
      ].map(key => [key, out[key]]),
    ),
    scope: Object.fromEntries(
      [
        'gateway',
        'account_id',
        'connection_id',
        'store_origin',
        'api_version',
        'source_kind',
        'price_field',
        'product_status',
        'variation_status',
        'absent_source_policy',
      ].map(key => [key, scope[key]]),
    ),
    limits: Object.fromEntries(
      ['items_per_scan', 'page_size', 'requests', 'bytes', 'elapsed_ms'].map(key => [key, out.limits[key]]),
    ),
    items,
    scans,
    currency_evidence: out.currency_evidence.map(value => ({
      value: value.value,
      source_hash: value.source_hash,
      observed_at: value.observed_at,
    })),
  };
}
function wooCommerceInventoryView(out, query = '', page = 0) {
  const kind = item => (item.entity_kind === 'variation' ? uiText('Native variation') : uiText('Published product')),
    term = query.trim().toLowerCase(),
    filtered = out.items.filter(item =>
      [
        item.product_id,
        item.parent_product_id,
        item.name,
        item.parent_name,
        item.sku,
        item.parent_sku,
        item.status,
        item.selected_price,
        item.product_type,
        kind(item),
        ...(item.attributes ?? []).flatMap(a => [a.name, a.option]),
      ]
        .filter(value => value !== null && value !== undefined)
        .join(' ')
        .toLowerCase()
        .includes(term),
    ),
    pages = Math.max(1, Math.ceil(filtered.length / 50)),
    current = Math.max(0, Math.min(page, pages - 1)),
    from = current * 50,
    native = value => (value === null ? uiText('Unknown') : value === '' ? uiText('Empty native value') : value),
    rows = filtered
      .slice(from, from + 50)
      .map(
        item =>
          `<tr><th scope="row"><strong><bdi>${esc(native(item.name ?? item.parent_name ?? null))}</bdi></strong><br><code dir="ltr">${esc(item.product_id)}</code><p>${esc(kind(item))}</p>${item.entity_kind === 'variation' ? `<p>${esc(uiText('Native parent ID'))}: <code dir="ltr">${esc(item.parent_product_id)}</code></p>${item.attributes.map(a => `<p><bdi>${esc(a.name)}: ${esc(a.option)}</bdi></p>`).join('')}` : ''}</th><td><code dir="ltr">${esc(native(item.sku))}</code>${item.entity_kind === 'variation' ? `<p>${esc(uiText('Native parent SKU'))}: <code dir="ltr">${esc(native(item.parent_sku))}</code></p>` : ''}</td><td><bdi dir="ltr">${esc(native(item.selected_price))} ${esc(out.native_currency)}</bdi></td><td><code dir="ltr">${esc(item.status)}</code><br><code dir="ltr">${esc(native(item.stock_status))}</code><br><code dir="ltr">${esc(native(item.tax_status))}</code></td><td><code dir="ltr">${esc(item.product_type)}</code>${item.entity_kind === 'product' ? `<p>${esc(uiText('{count} reported variation IDs', {count: item.variation_ids.length}))}</p>${item.product_type === 'grouped' ? `<p>${esc(uiText('{count} reported grouped-product IDs', {count: item.reported_grouped_product_ids.length}))}</p>` : ''}` : `<p>${esc(uiText('Destination title and eligibility need a separate selected-product review.'))}</p>`}</td></tr>`,
      )
      .join('');
  return `<div class="split"><label for="woo-inventory-search">${esc(uiText('Find a native product, variation, SKU, status or price'))}<input type="search" id="woo-inventory-search" value="${esc(query)}" maxlength="500"></label><div><button type="button" class="button" id="woo-inventory-find">${esc(uiText('Search inventory'))}</button><button type="button" class="button" id="woo-inventory-clear">${esc(uiText('Clear search'))}</button></div></div><p role="status">${esc(uiText('Showing {from}–{through} of {count} collected products and variations', {from: filtered.length ? from + 1 : 0, through: Math.min(from + 50, filtered.length), count: filtered.length}))}</p>${filtered.length ? `<div class="data-scroll native-inventory-scroll" role="region" tabindex="0" aria-label="${esc(uiText('Store inventory, scroll for all native fields'))}"><table class="review-table"><caption>${esc(uiText('Published products and their reported variations'))}</caption><thead><tr>${[uiText('Product'), uiText('Native SKU'), uiText('Price'), uiText('Native status, stock and tax'), uiText('Native type and membership')].map(label => `<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p>${esc(uiText('No collected rows match this local view. Unpublished products and whole-store absence are not established.'))}</p>`}<div class="pagination"><button type="button" class="button" id="woo-inventory-previous" ${current === 0 ? 'disabled' : ''}>${esc(uiText('Previous'))}</button><span>${esc(uiText('Page {page} of {pages}', {page: current + 1, pages}))}</span><button type="button" class="button" id="woo-inventory-next" ${current >= pages - 1 ? 'disabled' : ''}>${esc(uiText('Next'))}</button></div>`;
}
function bindWooCommerceInventory() {
  const sources = typeof commerceSources === 'undefined' ? [] : commerceSources,
    form = $('#woo-inventory'),
    result = $('#woo-inventory-result'),
    begin = accountWorkflowContext(form, result);
  const handoff = new URLSearchParams(location.search),
    keys = ['woo_inventory', 'connection_id', 'account_id', 'price_field'];
  if (
    handoff.get('woo_inventory') === '1' &&
    keys.every(key => handoff.getAll(key).length === 1) &&
    !handoff.has('product_ids') &&
    !handoff.has('parent_product_id') &&
    !handoff.has('source_kind')
  ) {
    const index = sources.findIndex(
      source =>
        source.connection_id === handoff.get('connection_id') && source.account_id === handoff.get('account_id'),
    );
    if (index >= 0 && ['price', 'regular_price', 'sale_price'].includes(handoff.get('price_field'))) {
      form.elements.target.value = String(index);
      form.elements.price_field.value = handoff.get('price_field');
    }
  }
  workspaceBind(
    '#woo-inventory',
    async () => {
      const active = begin();
      if (!active()) return;
      const source = form.elements.target.value === '' ? undefined : sources[Number(form.elements.target.value)],
        price = form.elements.price_field.value;
      if (!source || !['price', 'regular_price', 'sale_price'].includes(price))
        throw Error(uiText('Choose a configured store and an exact native price field for inventory inspection.'));
      const request = {
        action: 'catalog_source',
        gateway: 'commerce_native_action',
        connection_id: source.connection_id,
        account_id: source.account_id,
        requirements: {source_kind: 'inventory', price_field: price, absent_source_policy: 'retain'},
      };
      try {
        const response = await workspaceCall('workspace', request);
        if (!active()) return;
        const out = wooCommerceInventorySelection(response, request, source);
        const evidence = Object.fromEntries(
          [
            'record_kind',
            'scope',
            'complete_collected_inventory',
            'native_currency',
            'item_count',
            'product_count',
            'variation_count',
            'items',
            'source_hash',
            'scans',
            'currency_evidence',
            'captured_at',
            'native_requests',
            'collected_rows',
            'collected_bytes',
            'limits',
            'point_in_time',
            'unpublished_parents_collected',
            'grouped_membership',
            'destination_eligibility',
            'provider_mutations',
            'destructive_deletions',
            'saved_drafts',
            'source_saved',
          ].map(key => [key, out[key]]),
        );
        result.innerHTML = `<h3 id="woo-inventory-heading" tabindex="-1">${esc(uiText('Observed store inventory'))}</h3><p>${esc(uiText('Read {date} · {products} published products · {variations} reported variations · {currency}', {date: date(out.captured_at), products: out.product_count, variations: out.variation_count, currency: out.native_currency}))}</p><p class="notice">${esc(uiAccountExplanation(out.meaning))}</p><div id="woo-inventory-view" aria-live="polite"></div>${recordDetails(evidence, uiText('Complete collected inventory evidence'))}`;
        let query = '',
          page = 0;
        const render = focus => {
          if (!active()) return;
          $('#woo-inventory-view').innerHTML = wooCommerceInventoryView(out, query, page);
          const find = () => {
            if (!active()) return;
            query = $('#woo-inventory-search').value;
            page = 0;
            render('#woo-inventory-search');
          };
          workspaceBind('#woo-inventory-find', find);
          workspaceBind('#woo-inventory-clear', () => {
            if (!active()) return;
            query = '';
            page = 0;
            render('#woo-inventory-search');
          });
          workspaceBind('#woo-inventory-previous', () => {
            if (!active()) return;
            page = Math.max(0, page - 1);
            render('#woo-inventory-heading');
          });
          workspaceBind('#woo-inventory-next', () => {
            if (!active()) return;
            page++;
            render('#woo-inventory-heading');
          });
          $('#woo-inventory-search').addEventListener('keydown', event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              find();
            }
          });
          if (focus) $(focus).focus();
        };
        render('#woo-inventory-heading');
      } catch (error) {
        if (active()) {
          result.innerHTML = '';
          throw error;
        }
      }
    },
    {disabled: () => sources.length === 0},
  );
}
