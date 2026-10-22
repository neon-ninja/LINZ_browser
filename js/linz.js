// Thin client for the two LINZ Data Service APIs the browser uses:
//  - the Koordinates catalogue API (public, no key) for searching datasets and
//    reading their field definitions, and
//  - the WFS service (needs the user's API key) for querying features.
// Both send `Access-Control-Allow-Origin: *`, so they are called directly
// from the browser. The key goes in an `Authorization: key …` header rather
// than LINZ's `services;key=…/wfs` URL form, which keeps it out of request
// URLs and avoids proxies that reject `;` in paths.

import { fieldKind, quoteIdent, quoteString } from './cql.js';

export const LDS_ORIGIN = 'https://data.linz.govt.nz';
const API = `${LDS_ORIGIN}/services/api/v1.x`;

export const API_KEY_HELP_URL = `${LDS_ORIGIN}/my/api/`;

export class LdsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'LdsError';
    this.status = status;
  }
}

/** Parses the catalogue API's `X-Resource-Range: 0-30/1736` header. */
export function parseResourceRange(header) {
  const m = /^(\d+)-(\d+)\/(\d+)$/.exec(String(header || '').trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
}

/** Pulls a readable message out of a WFS/OWS exception report or error page. */
export function parseServiceError(text) {
  const body = String(text || '');
  const exception = /<(?:\w+:)?ExceptionText>([\s\S]*?)<\/(?:\w+:)?ExceptionText>/i.exec(body);
  const raw = exception ? exception[1]
    : (/<title>([\s\S]*?)<\/title>/i.exec(body) || [])[1]
    || (/"detail"\s*:\s*"([^"]+)"/.exec(body) || [])[1]
    || '';
  return raw
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}


async function fetchJson(url, { signal } = {}) {
  const res = await fetch(url, { signal, credentials: 'omit' });
  if (!res.ok) {
    const message = parseServiceError(await res.text()) || res.statusText;
    throw new LdsError(`LINZ returned ${res.status}${message ? `: ${message}` : ''}`, res.status);
  }
  return res;
}

function summarise(item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    thumbnail: item.thumbnail_url || null,
    publishedAt: item.published_at || null,
  };
}

/**
 * Searches the catalogue for queryable datasets (vector layers and tables).
 * @returns {Promise<{items: object[], total: number, hasMore: boolean}>}
 */
export async function searchDatasets({ q = '', kinds = ['vector', 'table'], sort = '', page = 1, pageSize = 30, signal } = {}) {
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  for (const kind of kinds) params.append('kind', kind);
  if (sort) params.set('sort', sort);
  params.set('page', String(page));
  params.set('page_size', String(pageSize));

  const res = await fetchJson(`${API}/data/?${params}`, { signal });
  const items = (await res.json()).map(summarise);
  const range = parseResourceRange(res.headers.get('x-resource-range'));
  return {
    items,
    total: range ? range.total : items.length,
    hasMore: range ? range.end < range.total : false,
  };
}

/** [[south, west], [north, east]] of a GeoJSON geometry's coordinates, or null. */
export function geometryBounds(geometry) {
  let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
  const visit = (coords) => {
    if (typeof coords?.[0] === 'number') {
      west = Math.min(west, coords[0]); east = Math.max(east, coords[0]);
      south = Math.min(south, coords[1]); north = Math.max(north, coords[1]);
    } else if (Array.isArray(coords)) {
      coords.forEach(visit);
    }
  };
  visit(geometry?.coordinates);
  return Number.isFinite(west) ? [[south, west], [north, east]] : null;
}

/** Normalises a catalogue layer/table record into what the UI needs. */
export function normaliseDataset(d) {
  const data = d.data || {};
  const fields = (data.fields || []).map((f) => ({ name: f.name, type: f.type, kind: fieldKind(f.type) }));
  return {
    id: d.id,
    type: d.type,
    kind: d.kind || d.type,
    title: d.title,
    descriptionHtml: d.description_html || '',
    url: d.url_html || `${LDS_ORIGIN}/${d.type}/${d.id}/`,
    group: d.group?.name || null,
    license: d.license ? { title: d.license.title, url: d.license.url_html || d.license.url || null } : null,
    publishedAt: d.published_at || null,
    fields,
    geometryField: data.geometry_field || null,
    geometryType: data.geometry_type || null,
    featureCount: Number.isFinite(data.feature_count) ? data.feature_count : null,
    crs: data.crs?.id || null,
    extent: geometryBounds(data.extent),
  };
}

const datasetCache = new Map();

/** Fetches (and caches) the full record for a layer or table, including its fields. */
export async function getDataset(type, id, { signal } = {}) {
  const cacheKey = `${type}-${id}`;
  if (!datasetCache.has(cacheKey)) {
    const path = type === 'table' ? 'tables' : 'layers';
    const promise = fetchJson(`${API}/${path}/${encodeURIComponent(id)}/`, { signal })
      .then((res) => res.json())
      .then(normaliseDataset);
    datasetCache.set(cacheKey, promise);
    promise.catch(() => datasetCache.delete(cacheKey));
  }
  return datasetCache.get(cacheKey);
}

/** WFS type name for a dataset, e.g. `layer-50804` or `table-114085`. */
export function typeName(dataset) {
  return `${dataset.type}-${dataset.id}`;
}

const WFS_PATH = '/services/wfs';

export function wfsUrl(params) {
  const search = new URLSearchParams({ service: 'WFS', version: '2.0.0', ...params });
  return `${LDS_ORIGIN}${WFS_PATH}?${search}`;
}

/** A WFS URL that works on its own (QGIS, curl, a browser tab): LINZ's key-in-path form. */
export function standaloneWfsUrl(url, apiKey) {
  return String(url).replace(`${LDS_ORIGIN}${WFS_PATH}`, `${LDS_ORIGIN}/services;key=${encodeURIComponent(apiKey)}/wfs`);
}

function wfsFetch(url, apiKey, { signal } = {}) {
  return fetch(url, { signal, credentials: 'omit', headers: { Authorization: `key ${apiKey}` } });
}

/**
 * WFS GetFeature parameters for a query.
 * @param {object} q
 * @param {string} q.typeName
 * @param {string} [q.cql]
 * @param {string[]} [q.properties]  Attribute names to return (all when empty).
 * @param {string} [q.sortField]
 * @param {'ASC'|'DESC'} [q.sortDir]
 * @param {number} [q.count]
 * @param {number} [q.startIndex]
 * @param {boolean} [q.hits]  Ask for the match count only.
 * @param {boolean} [q.geographic]  Return geometry as WGS84 lon/lat.
 */
export function featureParams({ typeName: name, cql, properties, sortField, sortDir = 'ASC', count, startIndex, hits = false, geographic = false }) {
  const params = { request: 'GetFeature', typeNames: name };
  if (hits) {
    params.resultType = 'hits';
  } else {
    params.outputFormat = 'application/json';
    if (count) params.count = String(count);
    if (startIndex) params.startIndex = String(startIndex);
    if (geographic) params.srsName = 'EPSG:4326';
    if (properties?.length) params.propertyName = properties.join(',');
    if (sortField) params.sortBy = `${sortField} ${sortDir === 'DESC' ? 'DESC' : 'ASC'}`;
  }
  if (cql) params.cql_filter = cql;
  return params;
}

// Returns parsed GeoJSON, or for a hits request the raw XML text. WFS errors
// arrive as XML exception reports (sometimes with a 200 status).
async function wfsRequest(url, apiKey, { signal, hits = false } = {}) {
  let res;
  let text;
  try {
    res = await wfsFetch(url, apiKey, { signal });
    text = await res.text();
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new LdsError(`Could not reach LINZ (${err.message})`, 0);
  }
  if (res.ok) {
    if (hits && /numberMatched=/.test(text)) return text;
    if (!hits && /json/i.test(res.headers.get('content-type') || '')) return JSON.parse(text);
  }

  const detail = parseServiceError(text);
  if (res.status === 401 || res.status === 403) {
    throw new LdsError('LINZ rejected your API key. Check it in the API key settings.', res.status);
  }
  if (/Feature type .* unknown/i.test(detail)) {
    throw new LdsError(
      `${detail}. Check your API key is valid and has access to this dataset.`,
      res.status,
    );
  }
  throw new LdsError(detail || `LINZ returned ${res.status} ${res.statusText}`, res.status);
}

/** Runs a GetFeature query and returns the GeoJSON FeatureCollection. */
export async function getFeatures(apiKey, query, { signal } = {}) {
  const url = wfsUrl(featureParams(query));
  const collection = await wfsRequest(url, apiKey, { signal });
  return { url, collection };
}

export function parseNumberMatched(xml) {
  const m = /numberMatched="(\d+)"/.exec(String(xml || ''));
  return m ? Number(m[1]) : null;
}

/** Counts the features matching a query (WFS resultType=hits). */
export async function countFeatures(apiKey, query, { signal } = {}) {
  const url = wfsUrl(featureParams({ ...query, hits: true }));
  return parseNumberMatched(await wfsRequest(url, apiKey, { signal, hits: true }));
}

const valueCache = new Map();

/**
 * Distinct values of a text field for autocomplete, optionally only those
 * containing `contains` (case-insensitive). WFS has no DISTINCT, so this reads
 * a few batches, each excluding the values already found so that common
 * values don't crowd out rarer ones. A batch that comes back short has seen
 * every remaining match, so `complete` means the list is exhaustive.
 * `onProgress` receives the sorted values after each batch.
 * @returns {Promise<{values: string[], complete: boolean}>}
 */
export async function sampleValues(apiKey, dataset, field, { contains = '', signal, onProgress } = {}) {
  const cacheKey = `${typeName(dataset)}|${field}|${contains.toLowerCase()}`;
  if (valueCache.has(cacheKey)) return valueCache.get(cacheKey);

  const BATCH = 200;
  const f = quoteIdent(field);
  const base = contains ? `${f} ILIKE ${quoteString(`%${contains}%`)}` : `${f} IS NOT NULL`;
  const found = new Set();
  const sorted = () => [...found].sort((a, b) => a.localeCompare(b, 'en-NZ', { numeric: true }));
  let complete = false;

  // Stop early for high-cardinality fields: one batch is plenty of suggestions.
  for (let round = 0; round < 4 && !complete && found.size <= 100; round++) {
    const exclude = found.size ? ` AND NOT (${f} IN (${[...found].map(quoteString).join(', ')}))` : '';
    const { collection } = await getFeatures(apiKey, {
      typeName: typeName(dataset), cql: base + exclude, properties: [field], count: BATCH,
    }, { signal });
    const features = collection.features || [];
    for (const feature of features) {
      const v = feature.properties?.[field];
      if (v !== null && v !== undefined && v !== '') found.add(String(v));
    }
    complete = features.length < BATCH;
    onProgress?.(sorted());
  }

  const result = { values: sorted(), complete };
  valueCache.set(cacheKey, result);
  return result;
}

/**
 * Checks an API key against the WFS service. GetCapabilities answers 401 for
 * a bad key; for a good key the (multi-megabyte) body is abandoned as soon as
 * the headers arrive.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function testApiKey(apiKey) {
  const controller = new AbortController();
  try {
    const res = await wfsFetch(wfsUrl({ request: 'GetCapabilities' }), apiKey, { signal: controller.signal });
    controller.abort();
    if (res.ok) return { ok: true, message: 'Key accepted by LINZ.' };
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'LINZ did not recognise this key.' };
    return { ok: false, message: `LINZ returned ${res.status} ${res.statusText}.` };
  } catch (err) {
    return { ok: false, message: `Could not reach LINZ (${err.message}).` };
  }
}
