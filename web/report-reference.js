async function readReferenceCSV(file, delimiter) {
  if (!file || !Number.isInteger(file.size) || file.size < 1 || file.size > 65536)
    throw Error(uiText('Choose a reference CSV or TSV no larger than 64 KiB.'));
  if (![',', ';', '\t'].includes(delimiter)) throw Error(uiText('Choose the file delimiter explicitly.'));
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) throw Error(uiText('The reference file changed while reading. Choose it again.'));
  const encoding =
    bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  let text;
  try {
    text = new TextDecoder(encoding, {fatal: true}).decode(bytes);
  } catch {
    throw Error(uiText('Use valid UTF-8 or UTF-16 with a byte-order mark.'));
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
    throw Error(uiText('The reference file contains unsupported control characters.'));
  const rows = [];
  let row = [],
    value = '',
    quoted = false,
    closed = false;
  const cell = () => {
    row.push(value);
    value = '';
    closed = false;
    if (row.length > 64) throw Error(uiText('Use at most 64 reference columns.'));
  };
  const line = () => {
    cell();
    if (row.some(v => v !== '')) rows.push(row);
    row = [];
    if (rows.length > 2)
      throw Error(
        uiText(
          'Use one header row and one aggregate totals row. Detail rows and repeated totals cannot be combined here.',
        ),
      );
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += c;
      continue;
    }
    if (c === '"') {
      if (value || closed) throw Error(uiText('Invalid CSV quoting.'));
      quoted = true;
      continue;
    }
    if (closed && !['\r', '\n', delimiter].includes(c))
      throw Error(uiText('Unexpected text after a quoted CSV value.'));
    if (c === delimiter) {
      cell();
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      line();
      continue;
    }
    value += c;
  }
  if (quoted) throw Error(uiText('A quoted CSV value is not closed.'));
  line();
  if (rows.length !== 2 || rows[0].length !== rows[1].length)
    throw Error(uiText('Use one header row and one aggregate totals row with the same columns.'));
  const headers = rows[0].map(v => v.trim());
  if (headers.some(v => !v || v.length > 200 || /[\r\n\t]/.test(v)) || new Set(headers).size !== headers.length)
    throw Error(uiText('Use unique named CSV columns.'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return {
    headers,
    values: rows[1],
    encoding,
    delimiter,
    bytes: bytes.byteLength,
    sha256: [...digest].map(v => v.toString(16).padStart(2, '0')).join(''),
  };
}

function referenceCSVValues(parsed, mapping, moneyScales, numberFormat) {
  if (!['decimal_dot', 'decimal_comma'].includes(numberFormat))
    throw Error(uiText('Choose the decimal separator. Grouping separators are not accepted.'));
  const keys = Object.keys(mapping),
    allowed = ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value'];
  if (
    !keys.length ||
    keys.some(k => !allowed.includes(k)) ||
    new Set(Object.values(mapping)).size !== keys.length ||
    Object.values(mapping).some(i => !Number.isInteger(i) || i < 0 || i >= parsed.headers.length)
  )
    throw Error(uiText('Map at least one additive metric to a distinct CSV column.'));
  const totals = {},
    columns = {},
    scales = {};
  for (const metric of keys) {
    const monetary = ['spend', 'conversion_value'].includes(metric),
      scale = monetary ? moneyScales[metric] : 0;
    if (![0, 2, 6].includes(scale))
      throw Error(uiText('Choose currency units, hundredths or micros for each money column.'));
    if (monetary) scales[metric] = scale;
    columns[metric] = parsed.headers[mapping[metric]];
    const raw = parsed.values[mapping[metric]].trim();
    if (raw === '') {
      totals[metric] = null;
      continue;
    }
    const pattern = numberFormat === 'decimal_dot' ? /^\d{1,80}(?:\.\d{1,9})?$/ : /^\d{1,80}(?:,\d{1,9})?$/;
    if (!pattern.test(raw))
      throw Error(
        uiText(
          'Mapped values must be nonnegative decimals without grouping, percent signs or formulas. Blank values remain unknown.',
        ),
      );
    const [whole, fraction = ''] = raw.replace(',', '.').split('.');
    let n = BigInt(whole + fraction),
      places = fraction.length + scale;
    while (places && n % 10n === 0n) {
      n /= 10n;
      places--;
    }
    if (places > 9) throw Error(uiText('The selected units exceed nine decimal places. No rounding was applied.'));
    const digits = n.toString().padStart(places + 1, '0');
    totals[metric] = places ? digits.slice(0, -places) + '.' + digits.slice(-places) : digits;
  }
  return {
    totals,
    file: {
      sha256: parsed.sha256,
      bytes: parsed.bytes,
      encoding: parsed.encoding,
      delimiter: parsed.delimiter,
      rows: 1,
      number_format: numberFormat,
      columns,
      money_scales: scales,
    },
  };
}

function mountReferenceImport(report, compare, isCurrent, invalidateResult) {
  const root = $('#reference-import');
  const current = () => isCurrent() && root.isConnected;
  root.innerHTML = `<h3>${esc(uiText('Import reference totals'))}</h3><p class="form-note">${esc(uiText('Use one header row and one aggregate totals row, up to 64 KiB. Map columns explicitly. The file stays in your browser; only selected totals, column names, declared settings and its hash are sent.'))}</p><form id="reference-csv-load"><label>${esc(uiText('Reference CSV or TSV'))}<input name="file" type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" required></label><label>${esc(uiText('Delimiter'))}<select name="delimiter"><option value=",">${esc(uiText('Comma'))}</option><option value=";">${esc(uiText('Semicolon'))}</option><option value="&#9;">${esc(uiText('Tab'))}</option></select></label><button class="button" type="submit">${esc(uiText('Read CSV columns'))}</button></form><div id="reference-csv-fields"></div>`;
  const fields = $('#reference-csv-fields'),
    load = $('#reference-csv-load');
  let sequence = 0,
    prepared;
  const resetFile = () => {
    sequence++;
    prepared = undefined;
    fields.innerHTML = '';
    invalidateResult();
  };
  load.addEventListener('input', resetFile);
  load.addEventListener('change', resetFile);
  workspaceBind('#reference-csv-load', async form => {
    if (!current()) return;
    resetFile();
    const attempt = sequence,
      {file, delimiter} = Object.fromEntries(new FormData(form));
    let parsed;
    try {
      parsed = await readReferenceCSV(file, delimiter);
    } catch (error) {
      if (current() && attempt === sequence) throw error;
      return;
    }
    if (!current() || attempt !== sequence) return;
    const labels = {
      spend: uiText('Spend'),
      impressions: uiText('Impressions'),
      clicks: uiText('Clicks'),
      conversions: uiText('Conversions'),
      conversion_value: uiText('Conversion value'),
    };
    const target = report.grain ?? report.source_request?.grain ?? '';
    const input = (name, label, type = 'text') =>
      `<label>${esc(label)}<input name="${name}" type="${type}" maxlength="200" required></label>`;
    fields.innerHTML = `<form id="reference-csv-compare"><h3>${esc(uiText('Map reference metrics'))}</h3><p class="form-note">${esc(uiText('Each chosen column is one aggregate metric. Leave unavailable metrics unmapped. Blank selected cells remain unknown.'))}</p><div class="target-fields">${Object.entries(
      labels,
    )
      .map(
        ([key, label]) =>
          `<label>${esc(label)}<select name="map_${key}"><option value="">${esc(uiText('Not supplied'))}</option>${parsed.headers.map((header, i) => `<option value="${i}">${esc(header)}</option>`).join('')}</select></label>${['spend', 'conversion_value'].includes(key) ? `<label>${esc(label)} · ${esc(uiText('Units'))}<select name="unit_${key}"><option value="">${esc(uiText('Choose units'))}</option><option value="0">${esc(uiText('Currency units'))}</option><option value="2">${esc(uiText('Hundredths of currency'))}</option><option value="6">${esc(uiText('Micros of currency'))}</option></select></label>` : ''}`,
      )
      .join(
        '',
      )}</div><label>${esc(uiText('Decimal separator'))}<select name="number_format"><option value="decimal_dot">${esc(uiText('Decimal point, no grouping'))}</option><option value="decimal_comma">${esc(uiText('Decimal comma, no grouping'))}</option></select></label><h3>${esc(uiText('Declare the reference report settings'))}</h3><p class="form-note">${esc(uiText('Read these settings from the source export. AMCP compares your declarations; it cannot verify the original export or its attribution rules.'))}</p>${recordDetails({gateway: report.gateway, account_id: report.account_id, ...report.semantics, grain: target}, uiText('Current report settings'))}<div class="target-fields">${input('label', uiText('Reference name'))}${input('account_id', uiText('Reference account ID'))}${input('currency', uiText('Reference currency'))}${input('timezone', uiText('Reference timezone'))}${input('date_from', uiText('Reference start date'), 'date')}${input('date_to', uiText('Reference end date'), 'date')}${input('attribution', uiText('Reference attribution'))}${input('conversion_definition', uiText('Reference conversion definition'))}<label>${esc(uiText('Reference reporting grain'))}<select name="grain" required><option value="">${esc(uiText('Choose the matching source grain'))}</option><option value="${esc(target)}">${esc(target)}</option></select></label></div><button class="button" type="button" id="reference-csv-preview">${esc(uiText('Preview mapped totals'))}</button><div id="reference-csv-values"></div><label class="check-label"><input type="checkbox" name="complete">${esc(uiText('The reference covers the complete declared period.'))}</label><label class="check-label"><input type="checkbox" name="same_entities_and_filters">${esc(uiText('I checked that the reference uses the same entities, filters and reporting grain as this report.'))}</label><button class="button primary" type="submit">${esc(uiText('Compare imported totals'))}</button></form>`;
    const compareForm = $('#reference-csv-compare'),
      preview = $('#reference-csv-values');
    const formCurrent = () => current() && attempt === sequence && compareForm.isConnected;
    const read = () => {
      const v = Object.fromEntries(new FormData(compareForm));
      delete v.complete;
      delete v.same_entities_and_filters;
      return v;
    };
    const edit = event => {
      if (!formCurrent()) return;
      invalidateResult();
      if (['complete', 'same_entities_and_filters'].includes(event.target?.name)) return;
      prepared = undefined;
      preview.innerHTML = '';
      compareForm.elements.namedItem('complete').checked = false;
      compareForm.elements.namedItem('same_entities_and_filters').checked = false;
    };
    compareForm.addEventListener('input', edit);
    compareForm.addEventListener('change', edit);
    workspaceBind('#reference-csv-preview', () => {
      if (!formCurrent()) return;
      prepared = undefined;
      preview.innerHTML = '';
      invalidateResult();
      const values = read(),
        mapping = {},
        scales = {};
      for (const key of Object.keys(labels))
        if (values['map_' + key] !== undefined && values['map_' + key] !== '') {
          mapping[key] = Number(values['map_' + key]);
          if (['spend', 'conversion_value'].includes(key))
            scales[key] =
              values['unit_' + key] === '' || values['unit_' + key] === undefined ? NaN : Number(values['unit_' + key]);
        }
      const parsedValues = referenceCSVValues(parsed, mapping, scales, values.number_format);
      prepared = {values: JSON.stringify(values), ...parsedValues};
      preview.innerHTML = `<div class="data-scroll"><table class="review-table"><caption>${esc(uiText('Selected totals in report units'))}</caption><thead><tr><th scope="col">${esc(uiText('Metric'))}</th><th scope="col">${esc(uiText('Reference'))}</th></tr></thead><tbody>${Object.entries(
        prepared.totals,
      )
        .map(
          ([key, value]) =>
            `<tr><th scope="row">${esc(labels[key])}</th><td>${value === null ? esc(uiText('Unknown')) : `<bdi dir="ltr">${esc(value)}</bdi>`}</td></tr>`,
        )
        .join(
          '',
        )}</tbody></table></div><p class="form-note">${esc(uiText('No rounding or currency conversion was applied. The hash identifies the local file bytes; AMCP has not independently fetched that file.'))}</p>`;
      preview.setAttribute('tabindex', '-1');
      preview.focus();
    });
    workspaceBind('#reference-csv-compare', async () => {
      if (!formCurrent()) return;
      const values = read();
      if (!prepared || prepared.values !== JSON.stringify(values))
        throw Error(uiText('Preview the current mapped totals before comparing.'));
      if (
        !compareForm.elements.namedItem('complete').checked ||
        !compareForm.elements.namedItem('same_entities_and_filters').checked
      )
        throw Error(uiText('Confirm the complete period and matching entities, filters and grain.'));
      const context = {gateway: report.gateway, complete: true, same_entities_and_filters: true};
      for (const key of [
        'account_id',
        'currency',
        'timezone',
        'date_from',
        'date_to',
        'attribution',
        'conversion_definition',
        'grain',
      ]) {
        if (typeof values[key] !== 'string' || !values[key].trim())
          throw Error(uiText('Declare every reference setting before comparison.'));
        context[key] = values[key].trim();
      }
      if (typeof values.label !== 'string' || !values.label.trim()) throw Error(uiText('Provide a reference name.'));
      await compare({
        label: values.label.trim(),
        captured_at: Date.now(),
        totals: prepared.totals,
        context,
        file: prepared.file,
      });
    });
  });
}
