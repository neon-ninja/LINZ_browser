// Links and text for copying or sharing a result row. Pure functions.

/**
 * The field and value that identify a feature: the dataset's primary key, or
 * an `id` field. Falls back to the WFS feature id ("layer-50804.961395") when
 * the key column wasn't returned.
 * @returns {{field: string, value: string}|null}
 */
export function featureKey(dataset, feature) {
  const names = new Set(dataset.fields.map((f) => f.name));
  const field = (dataset.primaryKeys || []).find((k) => names.has(k)) || (names.has('id') ? 'id' : null);
  if (!field) return null;
  let value = feature.properties?.[field];
  if (value === undefined || value === null || value === '') {
    const suffix = String(feature.id ?? '').split('.').pop();
    value = /^\d+$/.test(suffix) ? suffix : null;
  }
  return value === null ? null : { field, value: String(value) };
}

/** Link that opens the app on a dataset filtered to one value, e.g. …/#/layer/50804?id=961395 */
export function rowLink(baseUrl, dataset, key) {
  return `${baseUrl}#/${dataset.type}/${dataset.id}?${new URLSearchParams({ [key.field]: key.value })}`;
}

/**
 * Parses an app route: "#/layer/50804" or, from a shared link,
 * "#/layer/50804?id=961395" (any `field=value` pairs become filters).
 * @returns {{type: string, id: number, filters: {field: string, value: string}[]}|null}
 */
export function parseRoute(hash) {
  const m = /^#\/(layer|table)\/(\d+)(?:\?(.*))?$/.exec(String(hash || ''));
  if (!m) return null;
  const filters = [...new URLSearchParams(m[3] || '')].map(([field, value]) => ({ field, value }));
  return { type: m[1], id: Number(m[2]), filters };
}

/**
 * Plain-text summary of a row for copying or sharing.
 * @param {object} row
 * @param {string} row.title
 * @param {[string, string][]} row.fields  Name/value pairs (empty values already left out).
 * @param {string} [row.address]  Looked-up address.
 * @param {string} [row.location]  "lat, lon".
 * @param {string} [row.link]
 */
export function rowText({ title, fields, address, location, link }) {
  const lines = [title, ...fields.map(([name, value]) => `${name}: ${value}`)];
  if (address) lines.push(`address (looked up): ${address}`);
  if (location) lines.push(`location: ${location}`);
  if (link) lines.push(link);
  return lines.join('\n');
}
