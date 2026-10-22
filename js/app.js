import { buildFilter, operatorArity, operatorsFor } from './cql.js';
import { $, el, svgIcon } from './dom.js';
import { pointOnSurface } from './geo.js';
import {
  ADDRESS_LAYER, API_KEY_HELP_URL, LDS_ORIGIN, addressesForFeature, countFeatures, findLicensed, getCategories,
  getDataset, getFeatures, sampleValues, searchDatasets, standaloneWfsUrl, testApiKey, typeName,
} from './linz.js';
import { createLookup } from './lookup.js';
import { load, loadQuery, save, saveQuery } from './storage.js';

const numberFormat = new Intl.NumberFormat('en-NZ');
const dateFormat = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });

function formatDate(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? dateFormat.format(d) : '';
}

// Octicons "lock" (MIT licence).
const LOCK_ICON = 'M4 4a4 4 0 0 1 8 0v2h.25c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-5.5C2 6.784 2.784 6 3.75 6H4Zm8.25 3.5h-8.5a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25ZM10.5 6V4a2.5 2.5 0 1 0-5 0v2Z';
const LICENSED_NOTE = 'Licensed dataset: only available to API keys that LINZ has granted access to';

function licensedBadge() {
  return el('span', { class: 'licensed', title: LICENSED_NOTE },
    svgIcon(LOCK_ICON), el('span', { class: 'visually-hidden' }, 'Licensed: '));
}

const KIND_LABELS = { vector: 'Vector layer', table: 'Table', raster: 'Raster layer', grid: 'Grid layer' };

const state = {
  apiKey: load('apiKey', ''),
  favourites: load('favourites', []),
  search: {
    q: '', kinds: 'vector,table', category: '', sort: '', page: 1, items: [], total: 0, hasMore: false, loaded: false,
  },
  categories: [],
  dataset: null,
  query: null,
  results: null,
  showHints: false,
  // Location marked on the map by address search or "What's here?".
  marker: load('marker', null),
};

let searchController = null;
let queryController = null;
let datasetToken = 0;
// A query to apply when a dataset opens (e.g. "Open" in a What's here? popup).
let pendingQuery = null;

// ---------------------------------------------------------------------------
// API key

function renderKeyState() {
  const pill = $('key-button');
  pill.title = 'API key settings';
  if (state.apiKey) {
    // The label is hidden on narrow screens, leaving just the masked key.
    pill.replaceChildren(el('span', { class: 'key-label' }, 'API key '), `••••${state.apiKey.slice(-4)}`);
    pill.classList.add('has-key');
  } else {
    pill.textContent = 'Add API key';
    pill.classList.remove('has-key');
  }
  $('key-needed').hidden = Boolean(state.apiKey);
}

function openKeyDialog() {
  const input = $('key-input');
  input.value = state.apiKey;
  input.type = 'password';
  $('key-toggle').textContent = 'Show';
  $('key-toggle').setAttribute('aria-pressed', 'false');
  setKeyStatus('', '');
  $('key-remove').hidden = !state.apiKey;
  $('key-dialog').showModal();
  input.focus();
}

function setKeyStatus(text, kind) {
  const status = $('key-status');
  status.textContent = text;
  status.className = `small ${kind}`;
}

function setApiKey(key) {
  const previous = state.apiKey;
  state.apiKey = key;
  save('apiKey', key || null);
  renderKeyState();
  if (key === previous) return;
  runSearch();
  if (!state.dataset) route();
  else if (key && !state.results) runQuery();
}

function initKeyDialog() {
  $('key-help').href = API_KEY_HELP_URL;
  $('key-button').addEventListener('click', openKeyDialog);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-key]')) openKeyDialog();
  });
  $('key-toggle').addEventListener('click', () => {
    const input = $('key-input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('key-toggle').textContent = show ? 'Hide' : 'Show';
    $('key-toggle').setAttribute('aria-pressed', String(show));
  });
  $('key-test').addEventListener('click', async () => {
    const key = $('key-input').value.trim();
    if (!key) return setKeyStatus('Enter a key first.', 'bad');
    setKeyStatus('Checking with LINZ…', '');
    const { ok, message } = await testApiKey(key);
    setKeyStatus(message, ok ? 'ok' : 'bad');
  });
  $('key-cancel').addEventListener('click', () => $('key-dialog').close());
  $('key-remove').addEventListener('click', () => {
    setApiKey('');
    $('key-dialog').close();
  });
  $('key-form').addEventListener('submit', () => setApiKey($('key-input').value.trim()));
}

// ---------------------------------------------------------------------------
// Favourites

const datasetKey = (d) => `${d.type}-${d.id}`;

function isFavourite(d) {
  return state.favourites.some((f) => f.type === d.type && f.id === d.id);
}

function toggleFavourite(d) {
  if (isFavourite(d)) {
    state.favourites = state.favourites.filter((f) => !(f.type === d.type && f.id === d.id));
  } else {
    state.favourites = [...state.favourites, {
      id: d.id, type: d.type, title: d.title, licensed: d.licensed, addedAt: Date.now(),
    }];
  }
  save('favourites', state.favourites);
  renderFavourites();
  renderSearchResults();
  renderFavouriteButton();
  if (state.favourites.some((f) => f.licensed === undefined)) refreshFavouriteLicences();
}

/** Works out which favourites are licensed (older favourites didn't record it). */
async function refreshFavouriteLicences() {
  if (!state.favourites.length) return;
  try {
    const licensed = await findLicensed(state.favourites.map((f) => f.id));
    state.favourites = state.favourites.map((f) => ({ ...f, licensed: licensed.has(f.id) }));
    save('favourites', state.favourites);
    renderFavourites();
  } catch {
    // The lock icons are a nicety; favourites work without them.
  }
}

function starButton(d) {
  const on = isFavourite(d);
  return el('button', {
    type: 'button',
    class: 'icon-button star',
    'aria-pressed': String(on),
    'aria-label': on ? `Remove ${d.title} from favourites` : `Add ${d.title} to favourites`,
    title: on ? 'Remove from favourites' : 'Add to favourites',
    onclick: () => toggleFavourite(d),
  }, on ? '★' : '☆');
}

function datasetItem(d, sub) {
  const active = state.dataset && state.dataset.type === d.type && state.dataset.id === d.id;
  return el('li', { class: active ? 'active' : null },
    el('button', {
      type: 'button',
      class: 'open',
      onclick: () => {
        const hash = `#/${d.type}/${d.id}`;
        if (location.hash === hash) route();
        else location.hash = hash;
      },
    },
    el('span', { class: 'title' }, d.licensed && licensedBadge(), d.title),
    el('span', { class: 'sub' }, sub)),
    starButton(d));
}

function renderFavourites() {
  const list = $('favourites-list');
  list.replaceChildren(...state.favourites.map((f) =>
    datasetItem(f, `${f.type === 'table' ? 'Table' : 'Layer'} ${f.id}`)));
  $('favourites-empty').hidden = state.favourites.length > 0;
  $('favourites-count').textContent = state.favourites.length ? `(${state.favourites.length})` : '';
}

function renderFavouriteButton() {
  const d = state.dataset;
  if (!d) return;
  const on = isFavourite(d);
  const button = $('ds-favourite');
  button.textContent = on ? '★ Favourite' : '☆ Add to favourites';
  button.setAttribute('aria-pressed', String(on));
}

// ---------------------------------------------------------------------------
// Sidebar tabs and search

function selectTab(name) {
  const search = name === 'search';
  $('tab-search').setAttribute('aria-selected', String(search));
  $('tab-favourites').setAttribute('aria-selected', String(!search));
  $('search-panel').hidden = !search;
  $('favourites-panel').hidden = search;
  save('tab', name);
}

async function runSearch({ append = false } = {}) {
  searchController?.abort();
  searchController = new AbortController();
  const s = state.search;
  const page = append ? s.page + 1 : 1;
  $('search-status').textContent = 'Searching…';
  $('load-more').disabled = true;
  try {
    const result = await searchDatasets({
      q: s.q,
      kinds: s.kinds.split(','),
      category: s.category,
      sort: s.sort || (s.q.trim() ? '' : 'popularity'),
      page,
      apiKey: state.apiKey,
      signal: searchController.signal,
    });
    s.page = page;
    s.items = append ? [...s.items, ...result.items] : result.items;
    s.total = result.total;
    s.hasMore = result.hasMore;
    s.loaded = true;
    renderSearchResults();
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('search-status').textContent = `Search failed: ${err.message}`;
  } finally {
    $('load-more').disabled = false;
  }
}

function renderSearchResults() {
  const s = state.search;
  if (!s.loaded) return;
  const label = s.total === 1 ? 'dataset' : 'datasets';
  const category = state.categories.find((c) => c.key === s.category);
  $('search-status').textContent = !s.total
    ? 'No datasets match. Try other words or another category.'
    : `${numberFormat.format(s.total)} ${label}${s.q.trim() ? ` matching “${s.q.trim()}”` : ''}${category ? ` in ${category.name}` : ''}`;
  $('search-results').replaceChildren(...s.items.map((d) => datasetItem(d,
    [d.type === 'table' ? `Table ${d.id}` : `Layer ${d.id}`, d.publishedAt && `updated ${formatDate(d.publishedAt)}`]
      .filter(Boolean).join(' · '))));
  $('load-more').hidden = !s.hasMore;
}

async function loadCategories() {
  try {
    state.categories = await getCategories();
  } catch {
    return; // Searching still works without the category filter.
  }
  $('search-category').append(...state.categories.map((c) =>
    el('option', { value: c.key }, `${'\u2003'.repeat(c.depth)}${c.name}`)));
}

function initSearch() {
  let timer;
  const input = $('search-q');
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.search.q = input.value;
      runSearch();
    }, 300);
  });
  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(timer);
    state.search.q = input.value;
    runSearch();
  });
  $('search-kind').addEventListener('change', (e) => { state.search.kinds = e.target.value; runSearch(); });
  $('search-category').addEventListener('change', (e) => { state.search.category = e.target.value; runSearch(); });
  $('search-sort').addEventListener('change', (e) => { state.search.sort = e.target.value; runSearch(); });
  $('load-more').addEventListener('click', () => runSearch({ append: true }));
  $('tab-search').addEventListener('click', () => selectTab('search'));
  $('tab-favourites').addEventListener('click', () => selectTab('favourites'));
}

// ---------------------------------------------------------------------------
// Dataset view

const ALLOWED_TAGS = new Set([
  'P', 'A', 'STRONG', 'B', 'EM', 'I', 'UL', 'OL', 'LI', 'BR', 'HR', 'CODE', 'PRE', 'BLOCKQUOTE',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
]);
const DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'FORM']);

/** Copies catalogue description HTML into a fragment, keeping only basic formatting and safe links. */
function sanitiseHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = document.createDocumentFragment();
  const walk = (from, to) => {
    for (const node of from.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.append(node.textContent);
      } else if (node.nodeType === Node.ELEMENT_NODE && !DROPPED_TAGS.has(node.tagName)) {
        const heading = /^H[1-6]$/.test(node.tagName);
        if (!heading && !ALLOWED_TAGS.has(node.tagName)) {
          walk(node, to);
          continue;
        }
        const copy = document.createElement(heading ? 'h4' : node.tagName.toLowerCase());
        if (node.tagName === 'A') {
          try {
            const href = new URL(node.getAttribute('href') || '', LDS_ORIGIN);
            if (['http:', 'https:', 'mailto:'].includes(href.protocol)) {
              copy.href = href.href;
              copy.target = '_blank';
              copy.rel = 'noopener';
            }
          } catch { /* drop unparseable links */ }
        }
        walk(node, copy);
        to.append(copy);
      }
    }
  };
  walk(doc.body, out);
  return out;
}

function queryableFields() {
  return state.dataset.fields.filter((f) => f.kind !== 'geometry');
}

function fieldByName(name) {
  return state.dataset.fields.find((f) => f.name === name);
}

function emptyQuery() {
  return {
    match: 'all', conditions: [], location: 'any', radius: 50, columns: null,
    sortField: '', sortDir: 'ASC', limit: 100, manualCql: null,
  };
}

/** Fills in defaults and drops anything in a saved query that no longer fits the dataset. */
function sanitiseQuery(dataset, saved) {
  const query = { ...emptyQuery(), ...(saved || {}) };
  if (query.useBbox) query.location = 'view'; // saved before the location filter existed
  delete query.useBbox;
  const names = new Set(dataset.fields.filter((f) => f.kind !== 'geometry').map((f) => f.name));
  query.conditions = (query.conditions || []).filter((c) => names.has(c.field));
  if (query.columns) query.columns = query.columns.filter((n) => names.has(n));
  if (!names.has(query.sortField)) query.sortField = '';
  if (!dataset.geometryField || (['point', 'near'].includes(query.location) && !state.marker)) query.location = 'any';
  return query;
}

/** Opens a dataset with the given conditions instead of its last query. */
function openWithConditions(type, id, conditions) {
  const query = { ...emptyQuery(), conditions: conditions.map((c) => ({ op: 'eq', value2: '', ...c })) };
  if (state.dataset && state.dataset.type === type && state.dataset.id === id) {
    state.query = sanitiseQuery(state.dataset, query);
    state.showHints = false;
    renderQueryBuilder();
    runQuery();
    return;
  }
  pendingQuery = { key: `${type}-${id}`, query };
  location.hash = `#/${type}/${id}`;
}

async function openDataset(type, id) {
  const token = ++datasetToken;
  queryController?.abort();
  $('welcome').hidden = true;
  $('dataset-view').hidden = false;
  $('dataset-loading').hidden = false;
  $('dataset-error').hidden = true;
  $('dataset-body').hidden = true;
  try {
    const dataset = await getDataset(type, id, { apiKey: state.apiKey });
    if (token !== datasetToken) return;
    if (!['vector', 'table'].includes(dataset.kind)) {
      throw new Error(`“${dataset.title}” is a ${KIND_LABELS[dataset.kind]?.toLowerCase() || dataset.kind}. Only vector layers and tables can be queried here.`);
    }
    state.dataset = dataset;
    const pending = pendingQuery?.key === datasetKey(dataset) ? pendingQuery.query : null;
    pendingQuery = null;
    state.query = sanitiseQuery(dataset, pending || loadQuery(datasetKey(dataset)));
    state.results = null;
    state.showHints = false;
    renderDataset();
    if (state.apiKey) runQuery();
  } catch (err) {
    if (token !== datasetToken) return;
    state.dataset = null;
    const hint = err.status === 404 && !state.apiKey
      ? ' If it is a licensed dataset, add an API key that has access to it.'
      : '';
    $('dataset-error').textContent = `Couldn't open this dataset. ${err.message}${hint}`;
    $('dataset-error').hidden = false;
  } finally {
    if (token === datasetToken) $('dataset-loading').hidden = true;
  }
  renderSearchResults();
  renderFavourites();
}

function showWelcome() {
  datasetToken++;
  queryController?.abort();
  state.dataset = null;
  document.title = 'LINZ Data Browser';
  $('welcome').hidden = false;
  $('dataset-view').hidden = true;
  resultsLayer?.remove();
  resultsLayer = null;
  map?.closePopup();
  placeMap('welcome-map-slot');
  renderSearchResults();
  renderFavourites();
}

function renderDataset() {
  const d = state.dataset;
  document.title = `${d.title} · LINZ Data Browser`;
  $('ds-title').textContent = d.title;
  const isTable = d.kind === 'table';
  const chips = [
    isTable ? 'Table' : `Vector layer${d.geometryType ? ` · ${d.geometryType}` : ''}`,
    d.featureCount !== null && `${numberFormat.format(d.featureCount)} ${isTable ? 'rows' : 'features'}`,
    typeName(d),
    d.crs,
    d.group,
    d.publishedAt && `Updated ${formatDate(d.publishedAt)}`,
    d.license?.title,
  ].filter(Boolean);
  $('ds-meta').replaceChildren(
    ...(d.licensed ? [el('span', { class: 'chip licensed-chip', title: LICENSED_NOTE }, svgIcon(LOCK_ICON), 'Licensed')] : []),
    ...chips.map((c) => el('span', { class: 'chip' }, c)),
  );
  $('ds-link').href = d.url;
  renderFavouriteButton();

  let description;
  if (d.detailsHidden) {
    description = el('p', { class: 'muted' },
      'LINZ doesn’t share this dataset’s catalogue details with your API key, so its fields were read from the WFS service instead. ',
      'Give your key the “layers:read” scope for the full description, or ',
      el('a', { href: d.url, target: '_blank', rel: 'noopener' }, 'see it on LINZ'), '.');
  } else {
    description = d.descriptionHtml ? sanitiseHtml(d.descriptionHtml) : el('p', { class: 'muted' }, 'No description.');
  }
  $('ds-description').replaceChildren(description);

  $('ds-field-count').textContent = `(${d.fields.length})`;
  $('ds-fields').replaceChildren(...d.fields.map((f) => el('tr', {},
    el('td', {}, f.name),
    el('td', {}, el('span', { class: 'type-badge' }, f.type)),
    el('td', {}, f.kind === 'geometry' ? '' : el('button', {
      type: 'button',
      class: 'link',
      onclick: () => addCondition(f.name, { focus: true }),
    }, 'Filter')))));

  renderQueryBuilder();
  resetResults();

  // Layers show results on the map; tables keep it in a collapsible lookup panel.
  const hasGeometry = Boolean(d.geometryField);
  $('lookup-card').hidden = hasGeometry || !map;
  $('find-addresses').hidden = !hasGeometry || (d.type === ADDRESS_LAYER.type && d.id === ADDRESS_LAYER.id);
  $('dataset-body').hidden = false;
  map?.closePopup(); // its actions may refer to the previous dataset
  placeMap(hasGeometry ? 'results-map-slot' : 'lookup-map-slot');
  if (hasGeometry && map && d.extent) map.fitBounds(d.extent, { padding: [10, 10], animate: false });
}

// ---------------------------------------------------------------------------
// Query builder

function typeLabel(field) {
  return { string: 'text', number: 'number', date: 'date', boolean: 'yes/no' }[field.kind] || field.type;
}

function addCondition(fieldName, { focus = false } = {}) {
  const field = fieldName ? fieldByName(fieldName) : queryableFields()[0];
  if (!field) return;
  state.query.conditions.push({ field: field.name, op: operatorsFor(field.kind)[0].value, value: '', value2: '' });
  if (state.query.manualCql !== null) setManualCql(false);
  renderConditions();
  if (focus) {
    const rows = $('conditions').querySelectorAll('.condition');
    const row = rows[rows.length - 1];
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    (row.querySelector('.values input') || row.querySelector('select')).focus({ preventScroll: true });
  }
}

function renderQueryBuilder() {
  const q = state.query;
  const fields = queryableFields();
  $('match').value = q.match;
  $('location-row').hidden = !state.dataset.geometryField || !map;
  $('location').value = q.location;
  $('radius').value = String(q.radius);
  renderLocationOptions();

  $('sort-field').replaceChildren(
    el('option', { value: '' }, '(default)'),
    ...fields.map((f) => el('option', { value: f.name }, f.name)),
  );
  $('sort-field').value = q.sortField;
  $('sort-dir').value = q.sortDir;
  $('limit').value = String(q.limit);

  $('columns-list').replaceChildren(...fields.map((f) => el('label', {},
    el('input', {
      type: 'checkbox',
      value: f.name,
      checked: !q.columns || q.columns.includes(f.name),
      onchange: onColumnsChange,
    }),
    f.name)));
  renderColumnsSummary();

  $('cql-manual').checked = q.manualCql !== null;
  $('cql').readOnly = q.manualCql === null;
  if (q.manualCql !== null) {
    $('cql').value = q.manualCql;
    $('cql-details').open = true;
  }
  renderConditions();
}

function renderConditions() {
  const q = state.query;
  $('conditions').replaceChildren(...q.conditions.map(conditionRow));
  if (!q.conditions.length) {
    $('conditions').append(el('p', { class: 'muted small' },
      'No conditions: every feature matches. Add a condition to filter.'));
  }
  $('builder').inert = q.manualCql !== null;
  updateCql();
}

function conditionRow(c, index) {
  const field = fieldByName(c.field);
  const kind = field ? field.kind : 'string';

  const fieldSelect = el('select', {
    'aria-label': 'Field',
    onchange: (e) => {
      const next = fieldByName(e.target.value);
      c.field = next.name;
      if (!operatorsFor(next.kind).some((o) => o.value === c.op)) c.op = operatorsFor(next.kind)[0].value;
      if (next.kind !== kind) { c.value = ''; c.value2 = ''; }
      renderConditions();
    },
  }, queryableFields().map((f) => el('option', { value: f.name }, `${f.name} (${typeLabel(f)})`)));
  fieldSelect.value = c.field;

  const opSelect = el('select', {
    'aria-label': 'Comparison',
    onchange: (e) => { c.op = e.target.value; renderConditions(); },
  }, operatorsFor(kind).map((o) => el('option', { value: o.value }, o.label)));
  opSelect.value = c.op;

  return el('div', { class: 'condition' },
    fieldSelect,
    opSelect,
    el('div', { class: 'values' }, valueInputs(c, kind, index)),
    el('button', {
      type: 'button',
      class: 'icon-button',
      'aria-label': 'Remove condition',
      title: 'Remove condition',
      onclick: () => { state.query.conditions.splice(index, 1); renderConditions(); },
    }, '×'),
    el('div', { class: 'hint', 'data-hint': index }));
}

function valueInputs(c, kind, index) {
  const arity = operatorArity(c.op);
  if (arity === 0) return [];

  const bind = (prop) => (e) => { c[prop] = e.target.value; updateCql(); };
  const input = (prop, attrs) => el('input', { value: c[prop] ?? '', oninput: bind(prop), 'aria-label': 'Value', ...attrs });

  if (kind === 'date') {
    const first = input('value', { type: 'date' });
    return arity === 2 ? [first, el('span', {}, 'and'), input('value2', { type: 'date', 'aria-label': 'End date' })] : [first];
  }
  if (kind === 'number') {
    if (c.op === 'in') return [input('value', { type: 'text', inputmode: 'decimal', placeholder: 'e.g. 1, 2, 3' })];
    const first = input('value', { type: 'number', step: 'any' });
    return arity === 2 ? [first, el('span', {}, 'and'), input('value2', { type: 'number', step: 'any', 'aria-label': 'Upper value' })] : [first];
  }

  // Text: suggest values that exist in the data.
  const listId = `suggest-${index}`;
  const datalist = el('datalist', { id: listId });
  const text = input('value', {
    type: 'text',
    list: listId,
    autocomplete: 'off',
    placeholder: c.op === 'in' ? 'value 1, value 2, …' : 'Type to see values',
  });
  text.addEventListener('focus', () => suggestValues(c, text, datalist));
  text.addEventListener('input', () => suggestValues(c, text, datalist));
  return [text, datalist];
}

/** Fills a condition's datalist with matching values from the dataset (best effort). */
function suggestValues(c, input, datalist) {
  if (!state.apiKey) return;
  clearTimeout(input.suggestTimer);
  input.suggestTimer = setTimeout(async () => {
    const dataset = state.dataset;
    const raw = input.value;
    // For "is one of", suggest completions of the last comma-separated item.
    const cut = c.op === 'in' ? raw.lastIndexOf(',') + 1 : 0;
    const prefix = cut ? `${raw.slice(0, cut).trimEnd()} ` : '';
    const term = raw.slice(cut).trim();
    input.suggestController?.abort();
    input.suggestController = new AbortController();
    const show = (values) => {
      if (state.dataset !== dataset || !input.isConnected) return;
      datalist.replaceChildren(...values.slice(0, 300).map((v) => el('option', { value: prefix + v })));
    };
    try {
      const { values } = await sampleValues(state.apiKey, dataset, c.field, {
        contains: term,
        signal: input.suggestController.signal,
        onProgress: show,
      });
      show(values);
    } catch {
      // Suggestions are optional; the query itself reports real errors.
    }
  }, 300);
}

function onColumnsChange() {
  const boxes = [...$('columns-list').querySelectorAll('input')];
  const chosen = boxes.filter((b) => b.checked).map((b) => b.value);
  state.query.columns = chosen.length === boxes.length ? null : chosen;
  renderColumnsSummary();
}

function renderColumnsSummary() {
  const total = queryableFields().length;
  const cols = state.query.columns;
  $('columns-summary').textContent = !cols ? 'All columns'
    : cols.length ? `${cols.length} of ${total} columns` : 'No columns';
}

function setAllColumns(on) {
  for (const box of $('columns-list').querySelectorAll('input')) box.checked = on;
  onColumnsChange();
}

function renderLocationOptions() {
  const q = state.query;
  const marker = state.marker;
  for (const value of ['point', 'near']) {
    $('location').querySelector(`option[value="${value}"]`).disabled = !marker;
  }
  if (!marker && ['point', 'near'].includes(q.location)) {
    q.location = 'any';
    $('location').value = 'any';
  }
  $('radius-wrap').hidden = q.location !== 'near';
  $('marker-label').textContent = marker
    ? `Marked: ${marker.label}`
    : 'Mark a location by searching for an address on the map, or with What’s here?';
}

/** The map extent and marked-location restrictions for the current query. */
function currentSpatial() {
  const d = state.dataset;
  const q = state.query;
  if (!d.geometryField || !map) return {};
  if (q.location === 'view') {
    const b = map.getBounds();
    return { bbox: { field: d.geometryField, west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() } };
  }
  if (['point', 'near'].includes(q.location) && state.marker) {
    const radius = q.location === 'near' ? Math.max(Number(q.radius) || 0, 0) : 0;
    return { near: { field: d.geometryField, lon: state.marker.lon, lat: state.marker.lat, radius } };
  }
  return {};
}

function currentFilter() {
  const q = state.query;
  if (q.manualCql !== null) return { cql: q.manualCql.trim(), errors: new Map() };
  const conditions = q.conditions.map((c) => ({ ...c, type: fieldByName(c.field)?.type }));
  return buildFilter({ match: q.match, conditions, ...currentSpatial() });
}

function updateCql() {
  const { cql, errors } = currentFilter();
  if (state.query.manualCql === null) $('cql').value = cql;
  for (const hint of $('conditions').querySelectorAll('[data-hint]')) {
    hint.textContent = state.showHints ? errors.get(Number(hint.dataset.hint)) || '' : '';
  }
  return { cql, errors };
}

function setManualCql(on) {
  const q = state.query;
  q.manualCql = on ? $('cql').value : null;
  $('cql-manual').checked = on;
  $('cql').readOnly = !on;
  if (on) {
    $('cql-details').open = true;
    $('cql').focus();
  }
  renderConditions();
}

function initQueryBuilder() {
  $('match').addEventListener('change', (e) => { state.query.match = e.target.value; updateCql(); });
  $('location').addEventListener('change', (e) => {
    state.query.location = e.target.value;
    renderLocationOptions();
    updateCql();
  });
  $('radius').addEventListener('input', (e) => {
    state.query.radius = Number(e.target.value) || 0;
    updateCql();
  });
  $('sort-field').addEventListener('change', (e) => { state.query.sortField = e.target.value; });
  $('sort-dir').addEventListener('change', (e) => { state.query.sortDir = e.target.value; });
  $('limit').addEventListener('change', (e) => { state.query.limit = Number(e.target.value); });
  $('add-condition').addEventListener('click', () => addCondition(null, { focus: true }));
  $('columns-all').addEventListener('click', () => setAllColumns(true));
  $('columns-none').addEventListener('click', () => setAllColumns(false));
  $('cql-manual').addEventListener('change', (e) => setManualCql(e.target.checked));
  $('cql').addEventListener('input', (e) => {
    if (state.query.manualCql !== null) state.query.manualCql = e.target.value;
  });
  $('run-query').addEventListener('click', () => runQuery());
  $('reset-query').addEventListener('click', () => {
    state.query = emptyQuery();
    state.showHints = false;
    saveQuery(datasetKey(state.dataset), state.query);
    renderQueryBuilder();
  });
  $('conditions').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) {
      e.preventDefault();
      runQuery();
    }
  });
  document.addEventListener('click', (e) => {
    const picker = $('columns-picker');
    if (picker.open && !picker.contains(e.target)) picker.open = false;
  });
}

// ---------------------------------------------------------------------------
// Running queries and showing results

async function runQuery() {
  const d = state.dataset;
  if (!d) return;
  if (!state.apiKey) {
    openKeyDialog();
    return;
  }
  state.showHints = true;
  const { cql, errors } = updateCql();
  if (errors.size) {
    setResultsStatus('Finish or remove the highlighted conditions first.');
    return;
  }

  const q = state.query;
  saveQuery(datasetKey(d), q);
  const columns = q.columns && (q.columns.length || d.geometryField) ? q.columns : null;
  const properties = columns ? [...columns, ...(d.geometryField ? [d.geometryField] : [])] : [];
  await fetchPage({
    typeName: typeName(d),
    cql,
    properties,
    sortField: q.sortField,
    sortDir: q.sortDir,
    count: q.limit,
    startIndex: 0,
    geographic: Boolean(d.geometryField),
  }, columns || queryableFields().map((f) => f.name), { fitMap: q.location !== 'view' });
}

async function fetchPage(query, columns, { fitMap = true } = {}) {
  queryController?.abort();
  const controller = new AbortController();
  queryController = controller;
  const { signal } = controller;
  const dataset = state.dataset;
  const previous = state.results;
  const sameFilter = previous && previous.query.typeName === query.typeName && previous.query.cql === query.cql;

  $('results-error').hidden = true;
  $('run-query').disabled = true;
  setResultsStatus('Loading…');
  setResultButtons(false);

  const countPromise = sameFilter && previous.total !== undefined
    ? Promise.resolve(previous.total)
    : countFeatures(state.apiKey, query, { signal }).catch(() => null);

  try {
    const { url, collection } = await getFeatures(state.apiKey, query, { signal });
    if (signal.aborted || state.dataset !== dataset) return;
    state.results = { query, columns, fitMap, url, features: collection.features || [], total: undefined };
    renderResults({ fitMap });
    const total = await countPromise;
    if (signal.aborted || state.dataset !== dataset) return;
    state.results.total = total;
    renderResultsStatus();
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('results-error').textContent = err.message;
    $('results-error').hidden = false;
    setResultsStatus('The query failed.');
  } finally {
    if (queryController === controller) $('run-query').disabled = false;
  }
}

function changePage(direction) {
  const r = state.results;
  if (!r) return;
  const step = r.query.count;
  const startIndex = Math.max(0, (r.query.startIndex || 0) + direction * step);
  fetchPage({ ...r.query, startIndex }, r.columns, { fitMap: r.fitMap });
}

function sortBy(column) {
  const q = state.query;
  if (q.sortField === column) q.sortDir = q.sortDir === 'ASC' ? 'DESC' : 'ASC';
  else { q.sortField = column; q.sortDir = 'ASC'; }
  $('sort-field').value = q.sortField;
  $('sort-dir').value = q.sortDir;
  runQuery();
}

function setResultsStatus(text) {
  $('results-status').textContent = text;
}

function setResultButtons(enabled) {
  for (const id of ['download-csv', 'download-geojson', 'copy-url', 'find-addresses']) $(id).disabled = !enabled;
  if (!enabled) {
    $('page-prev').disabled = true;
    $('page-next').disabled = true;
  }
}

function renderResultsStatus() {
  const r = state.results;
  const start = r.query.startIndex || 0;
  const n = r.features.length;
  const total = r.total;
  let text;
  if (!n) text = start ? 'No more results.' : 'No matching features.';
  else {
    text = `Showing ${numberFormat.format(start + 1)}–${numberFormat.format(start + n)}`;
    if (total === undefined) text += ' (counting…)';
    else if (total !== null) text += ` of ${numberFormat.format(total)}`;
  }
  setResultsStatus(text);
  $('page-prev').disabled = start === 0;
  $('page-next').disabled = n < r.query.count || (total != null && start + n >= total);
}

function resetResults() {
  state.results = null;
  setResultsStatus(state.apiKey ? 'Run a query to see data.' : 'Add an API key to query data.');
  setResultButtons(false);
  $('results-error').hidden = true;
  $('request-url').hidden = true;
  $('results-table').replaceChildren();
  resultsLayer?.remove();
  resultsLayer = null;
}

function formatCell(value) {
  if (value === null || value === undefined || value === '') return { text: '—', className: 'null' };
  if (typeof value === 'number') return { text: String(value), className: 'num' };
  if (typeof value === 'object') return { text: JSON.stringify(value), className: '' };
  return { text: String(value), className: '' };
}

function renderResults({ fitMap }) {
  const r = state.results;
  const { sortField, sortDir } = r.query;
  renderResultsStatus();
  setResultButtons(true);
  $('request-url').textContent = r.url;
  $('request-url').hidden = false;

  const head = el('thead', {}, el('tr', {}, r.columns.map((name) => {
    const sorted = sortField === name;
    return el('th', { scope: 'col', 'aria-sort': sorted ? (sortDir === 'DESC' ? 'descending' : 'ascending') : null },
      el('button', {
        type: 'button',
        class: 'link',
        title: `Sort by ${name}`,
        onclick: () => sortBy(name),
      }, name, sorted ? (sortDir === 'DESC' ? ' ▼' : ' ▲') : ''));
  })));
  const body = el('tbody', {}, r.features.map((feature, i) => el('tr', {
    'data-index': i,
    onclick: () => selectFeature(i),
  }, r.columns.map((name) => {
    const { text, className } = formatCell(feature.properties?.[name]);
    return el('td', { class: className || null, title: text.length > 40 ? text : null }, text);
  }))));
  $('results-table').replaceChildren(head, body);
  renderMapResults({ fitMap });
}

function selectFeature(index, { fromMap = false, latlng = null } = {}) {
  const r = state.results;
  if (!r) return;
  for (const row of $('results-table').querySelectorAll('tr.selected')) row.classList.remove('selected');
  const row = $('results-table').querySelector(`tr[data-index="${index}"]`);
  row?.classList.add('selected');
  if (fromMap) row?.scrollIntoView({ block: 'nearest' });
  highlightFeature(index, { zoom: !fromMap });
  openFeaturePopup(index, latlng);
}

// ---------------------------------------------------------------------------
// Addresses for result features (reverse geocoding parcels, titles, buildings…)

const ADDRESS_COLUMN = 'address_lookup';

/** Display text for an addressesForFeature() result (undefined while pending). */
function addressText(entry) {
  if (entry === undefined) return '…';
  if (entry.error) return `Lookup failed: ${entry.error}`;
  const [first] = entry.addresses;
  if (!first) return 'No address within 100 m';
  if (entry.inside) return entry.addresses.length > 1 ? `${first} (+${entry.addresses.length - 1} more)` : first;
  return `${first} (${Math.round(entry.distance)} m away)`;
}

/** Full text for downloads: every address inside a polygon, or the nearest one. */
function addressExport(entry) {
  if (!entry || entry.error || !entry.addresses.length) return '';
  return entry.inside ? entry.addresses.join('; ') : `${entry.addresses[0]} (${Math.round(entry.distance)} m away)`;
}

function ensureAddressColumn() {
  const table = $('results-table');
  if (table.querySelector(`th[data-col="${ADDRESS_COLUMN}"]`)) return;
  table.querySelector('thead tr').append(el('th', { scope: 'col', 'data-col': ADDRESS_COLUMN, class: 'lookup-col' }, 'address (looked up)'));
  for (const row of table.querySelectorAll('tbody tr')) {
    row.append(el('td', { class: 'lookup-col', 'data-address': row.dataset.index }));
  }
}

function renderAddressCell(index) {
  const entry = state.results.addresses[index];
  const cell = $('results-table').querySelector(`td[data-address="${index}"]`);
  if (cell) {
    cell.textContent = addressText(entry);
    cell.title = entry?.addresses?.join('\n') || '';
  }
  const popupText = document.querySelector(`.feature-popup[data-index="${index}"] .popup-address`);
  if (popupText) popupText.textContent = addressText(entry);
}

/** Looks up (once) the address for one result feature. */
async function findAddressFor(index, signal) {
  const r = state.results;
  r.addresses ??= [];
  if (r.addresses[index] !== undefined) return;
  ensureAddressColumn();
  renderAddressCell(index);
  try {
    r.addresses[index] = await addressesForFeature(state.apiKey, r.features[index], { signal });
  } catch (err) {
    if (err.name === 'AbortError') return;
    r.addresses[index] = { error: err.message };
  }
  if (state.results === r) renderAddressCell(index);
}

/** Runs `task` over `items` with at most `limit` running at once. */
async function runLimited(items, limit, task) {
  const queue = [...items];
  const worker = async () => {
    while (queue.length) await task(queue.shift());
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

async function findAllAddresses() {
  const r = state.results;
  if (!r || !state.apiKey) return;
  const { signal } = queryController;
  const button = $('find-addresses');
  const todo = r.features.map((f, i) => i).filter((i) => r.features[i].geometry && r.addresses?.[i] === undefined);
  let done = 0;
  button.disabled = true;
  button.textContent = `Finding addresses… 0/${todo.length}`;
  await runLimited(todo, 4, async (i) => {
    if (signal.aborted) return;
    await findAddressFor(i, signal);
    done += 1;
    if (state.results === r) button.textContent = `Finding addresses… ${done}/${todo.length}`;
  });
  if (state.results === r) {
    button.textContent = 'Find addresses';
    button.disabled = false;
  }
}

function download(filename, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function resultFilename(ext) {
  const r = state.results;
  const start = (r.query.startIndex || 0) + 1;
  return `${r.query.typeName}_${start}-${start + r.features.length - 1}.${ext}`;
}

function initResults() {
  $('find-addresses').addEventListener('click', findAllAddresses);
  $('page-prev').addEventListener('click', () => changePage(-1));
  $('page-next').addEventListener('click', () => changePage(1));
  $('download-csv').addEventListener('click', () => {
    const r = state.results;
    const extra = r.addresses ? [ADDRESS_COLUMN] : [];
    const lines = [[...r.columns, ...extra].map(csvCell).join(',')];
    r.features.forEach((f, i) => {
      const values = r.columns.map((c) => f.properties?.[c]);
      if (r.addresses) values.push(addressExport(r.addresses[i]));
      lines.push(values.map(csvCell).join(','));
    });
    // Leading BOM so spreadsheet apps read the file as UTF-8 (macrons in names).
    download(resultFilename('csv'), 'text/csv', `\ufeff${lines.join('\r\n')}\r\n`);
  });
  $('download-geojson').addEventListener('click', () => {
    const r = state.results;
    const features = r.addresses
      ? r.features.map((f, i) => ({ ...f, properties: { ...f.properties, [ADDRESS_COLUMN]: addressExport(r.addresses[i]) } }))
      : r.features;
    download(resultFilename('geojson'), 'application/geo+json', JSON.stringify({ type: 'FeatureCollection', features }));
  });
  $('copy-url').addEventListener('click', async () => {
    const button = $('copy-url');
    try {
      await navigator.clipboard.writeText(standaloneWfsUrl(state.results.url, state.apiKey));
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy request URL'; }, 1500);
    } catch {
      window.prompt('Copy this URL (it includes your API key):', standaloneWfsUrl(state.results.url, state.apiKey));
    }
  });
}

// ---------------------------------------------------------------------------
// Map

let map = null;
let lookup = null;
let resultsLayer = null;
let featureLayers = [];
let highlighted = null;

const STYLE = { color: '#0f6e6e', weight: 2, opacity: 0.9, fillColor: '#1aa39c', fillOpacity: 0.2 };
const HIGHLIGHT = { color: '#e8590c', weight: 3, opacity: 1, fillColor: '#ff922b', fillOpacity: 0.4 };

function initMap() {
  if (!window.L) {
    $('map').hidden = true;
    return;
  }
  map = L.map('map').setView([-41.0, 173.5], 5);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Data &copy; <a href="https://data.linz.govt.nz">LINZ</a>',
  }).addTo(map);
  map.on('moveend', () => {
    if (state.dataset && state.query?.location === 'view') updateCql();
  });
  lookup = createLookup(map, {
    getApiKey: () => state.apiKey,
    onMark: (marker) => {
      state.marker = marker;
      save('marker', marker);
      if (state.dataset && state.query) {
        renderLocationOptions();
        updateCql();
      }
    },
    onOpen: (type, id, condition) => openWithConditions(type, id, [condition]),
    filterHere: () => {
      const d = state.dataset;
      if (!d?.geometryField || !state.query || state.query.manualCql !== null) return null;
      return {
        label: `Filter ${d.title} to here`,
        run: () => {
          // Points rarely sit exactly on the marked spot, so look nearby instead.
          state.query.location = /point/i.test(d.geometryType || '') ? 'near' : 'point';
          renderQueryBuilder();
          map.closePopup();
          runQuery();
        },
      };
    },
  }, state.marker);
}

/** Moves the map into a placeholder: the welcome page, the results card or the table lookup panel. */
function placeMap(slotId) {
  const slot = $(slotId);
  if (!map || $('map').parentElement === slot) return;
  slot.append($('map'));
  map.invalidateSize();
}

function popupContent(feature, index) {
  const r = state.results;
  const rows = Object.entries(feature.properties || {}).map(([k, v]) =>
    el('tr', {}, el('th', {}, k), el('td', {}, formatCell(v).text)));
  const findButton = el('button', {
    type: 'button',
    class: 'button small',
    onclick: async () => {
      findButton.disabled = true;
      await findAddressFor(index, queryController?.signal);
      findButton.remove();
    },
  }, 'Find address');
  const showAddress = Boolean(feature.geometry) && !$('find-addresses').hidden;
  return el('div', { class: 'feature-popup', 'data-index': index },
    el('table', {}, rows),
    showAddress && el('p', { class: 'popup-address' }, r.addresses?.[index] !== undefined ? addressText(r.addresses[index]) : ''),
    el('div', { class: 'here-actions' },
      showAddress && r.addresses?.[index] === undefined && findButton,
      feature.geometry && el('button', {
        type: 'button',
        class: 'button small',
        onclick: () => {
          const [lon, lat] = pointOnSurface(feature.geometry);
          lookup.lookupAt({ lon, lat });
        },
      }, 'What’s here?')));
}

function openFeaturePopup(index, latlng) {
  const feature = state.results?.features[index];
  if (!map || !feature?.geometry) return;
  const at = latlng || (([lon, lat]) => L.latLng(lat, lon))(pointOnSurface(feature.geometry));
  L.popup({ maxWidth: 360 }).setLatLng(at).setContent(popupContent(feature, index)).openOn(map);
}

function renderMapResults({ fitMap }) {
  if (!map) return;
  resultsLayer?.remove();
  highlighted = null;
  const features = state.results.features;
  featureLayers = new Array(features.length);
  resultsLayer = L.featureGroup();
  features.forEach((feature, i) => {
    if (!feature.geometry) return;
    // Clicks are handled here, not by the map, so What's here? mode can take them over.
    const layer = L.geoJSON(feature, {
      style: () => STYLE,
      bubblingMouseEvents: false,
      pointToLayer: (_, latlng) => L.circleMarker(latlng, { ...STYLE, radius: 5, fillOpacity: 0.7, bubblingMouseEvents: false }),
    });
    layer.on('click', (e) => {
      if (lookup.active) lookup.lookupAt({ lon: e.latlng.lng, lat: e.latlng.lat });
      else selectFeature(i, { fromMap: true, latlng: e.latlng });
    });
    layer.on('contextmenu', (e) => lookup.lookupAt({ lon: e.latlng.lng, lat: e.latlng.lat }));
    featureLayers[i] = layer;
    resultsLayer.addLayer(layer);
  });
  resultsLayer.addTo(map);
  const bounds = resultsLayer.getBounds();
  if (fitMap && bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20], maxZoom: 17 });
}

function highlightFeature(index, { zoom }) {
  if (!map) return;
  if (highlighted) highlighted.setStyle(STYLE);
  highlighted = featureLayers[index] || null;
  if (!highlighted) return;
  highlighted.setStyle(HIGHLIGHT);
  highlighted.bringToFront();
  if (zoom) {
    const bounds = highlighted.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
  }
}

// ---------------------------------------------------------------------------
// Routing: #/layer/50804 or #/table/114085

function route() {
  const m = /^#\/(layer|table)\/(\d+)/.exec(location.hash);
  if (!m) {
    showWelcome();
    return;
  }
  const [, type, id] = m;
  if (state.dataset && state.dataset.type === type && String(state.dataset.id) === id) return;
  openDataset(type, Number(id));
}

function init() {
  initKeyDialog();
  initSearch();
  initQueryBuilder();
  initResults();
  initMap();
  $('lookup-card').addEventListener('toggle', () => map?.invalidateSize());
  loadCategories();
  $('ds-favourite').addEventListener('click', () => toggleFavourite(state.dataset));
  renderKeyState();
  renderFavourites();
  refreshFavouriteLicences();
  selectTab(load('tab', 'search') === 'favourites' && state.favourites.length ? 'favourites' : 'search');
  window.addEventListener('hashchange', route);
  route();
  runSearch();
}

init();
