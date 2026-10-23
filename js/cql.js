// Builds ECQL filter strings (the `cql_filter` parameter understood by the
// LINZ Data Service WFS, which is GeoServer underneath) from the structured
// conditions the query builder produces. Pure functions only, so they can be
// unit tested under Node.

const NUMBER_TYPES = new Set([
  'integer', 'int', 'smallint', 'bigint', 'numeric', 'decimal', 'double', 'float', 'real',
]);
const DATE_TYPES = new Set(['date', 'datetime', 'timestamp']);

// ECQL keywords that cannot be used as bare attribute names.
const RESERVED = new Set([
  'AND', 'OR', 'NOT', 'LIKE', 'ILIKE', 'IS', 'NULL', 'BETWEEN', 'IN', 'EXISTS', 'TRUE', 'FALSE',
  'INCLUDE', 'EXCLUDE', 'BEFORE', 'AFTER', 'DURING', 'BBOX', 'DWITHIN', 'BEYOND', 'CONTAINS',
  'CROSSES', 'DISJOINT', 'EQUALS', 'INTERSECTS', 'OVERLAPS', 'RELATE', 'TOUCHES', 'WITHIN', 'ID',
]);

/** Maps an LDS field type ("string", "bigint", "datetime", ...) to a query kind. */
export function fieldKind(type) {
  const t = String(type || '').toLowerCase();
  if (t.startsWith('geometry')) return 'geometry';
  if (NUMBER_TYPES.has(t)) return 'number';
  if (DATE_TYPES.has(t)) return 'date';
  if (t === 'boolean' || t === 'bool') return 'boolean';
  return 'string';
}

const OPERATORS = {
  string: [
    ['eq', 'is'], ['ne', 'is not'], ['contains', 'contains'], ['starts', 'starts with'],
    ['ends', 'ends with'], ['in', 'is one of'], ['null', 'is empty'], ['notnull', 'is not empty'],
  ],
  number: [
    ['eq', '='], ['ne', '≠'], ['lt', '<'], ['le', '≤'], ['gt', '>'], ['ge', '≥'],
    ['between', 'between'], ['in', 'is one of'], ['null', 'is empty'], ['notnull', 'is not empty'],
  ],
  date: [
    ['eq', 'on'], ['lt', 'before'], ['le', 'on or before'], ['gt', 'after'], ['ge', 'on or after'],
    ['between', 'between'], ['null', 'is empty'], ['notnull', 'is not empty'],
  ],
  boolean: [['true', 'is true'], ['false', 'is false'], ['null', 'is empty'], ['notnull', 'is not empty']],
};

/** Operators offered for a field kind, as [{ value, label }]. */
export function operatorsFor(kind) {
  return (OPERATORS[kind] || OPERATORS.string).map(([value, label]) => ({ value, label }));
}

/** How many value inputs an operator needs: 0, 1 or 2. */
export function operatorArity(op) {
  if (['null', 'notnull', 'true', 'false'].includes(op)) return 0;
  if (op === 'between') return 2;
  return 1;
}

export function quoteIdent(name) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED.has(name.toUpperCase())) return name;
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function quoteString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function numberLiteral(value) {
  const text = String(value ?? '').trim();
  if (text === '' || !Number.isFinite(Number(text))) return null;
  return String(Number(text));
}

function isDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function nextDay(value) {
  const d = new Date(`${value}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function splitList(value) {
  return String(value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

// Dates are compared at day granularity so the same expressions work for both
// `date` and `datetime` fields: "on D" means D <= x < D+1, "after D" means x >= D+1.
function dateCondition(f, op, a, b) {
  if (!isDay(a)) return { error: 'Pick a date' };
  if (op === 'between' && !isDay(b)) return { error: 'Pick an end date' };
  const lit = (d) => quoteString(d);
  switch (op) {
    case 'eq': return { cql: `${f} >= ${lit(a)} AND ${f} < ${lit(nextDay(a))}` };
    case 'lt': return { cql: `${f} < ${lit(a)}` };
    case 'le': return { cql: `${f} < ${lit(nextDay(a))}` };
    case 'gt': return { cql: `${f} >= ${lit(nextDay(a))}` };
    case 'ge': return { cql: `${f} >= ${lit(a)}` };
    case 'between': {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return { cql: `${f} >= ${lit(lo)} AND ${f} < ${lit(nextDay(hi))}` };
    }
    default: return { error: `Unsupported operator "${op}"` };
  }
}

const COMPARISON = { eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>=' };

/**
 * Turns one condition into ECQL.
 * @param {{field: string, type: string, op: string, value?: string, value2?: string}} c
 * @returns {{cql?: string, error?: string}} `cql` when complete, otherwise `error`.
 */
export function buildCondition(c) {
  if (!c || !c.field) return { error: 'Pick a field' };
  const kind = fieldKind(c.type);
  const op = c.op;
  const f = quoteIdent(c.field);

  if (op === 'null') return { cql: `${f} IS NULL` };
  if (op === 'notnull') return { cql: `${f} IS NOT NULL` };
  if (op === 'true') return { cql: `${f} = true` };
  if (op === 'false') return { cql: `${f} = false` };

  if (kind === 'date') return dateCondition(f, op, c.value, c.value2);

  if (kind === 'number') {
    if (op === 'in') {
      const items = splitList(c.value).map(numberLiteral);
      if (!items.length || items.includes(null)) return { error: 'Enter numbers separated by commas' };
      return { cql: `${f} IN (${items.join(', ')})` };
    }
    const a = numberLiteral(c.value);
    if (a === null) return { error: 'Enter a number' };
    if (op === 'between') {
      const b = numberLiteral(c.value2);
      if (b === null) return { error: 'Enter an upper number' };
      return { cql: `${f} BETWEEN ${a} AND ${b}` };
    }
    if (!COMPARISON[op]) return { error: `Unsupported operator "${op}"` };
    return { cql: `${f} ${COMPARISON[op]} ${a}` };
  }

  // Strings. LIKE wildcards (% and _) typed by the user are left as wildcards.
  const value = String(c.value ?? '');
  if (op === 'in') {
    const items = splitList(value);
    if (!items.length) return { error: 'Enter values separated by commas' };
    return { cql: `${f} IN (${items.map(quoteString).join(', ')})` };
  }
  if (value === '') return { error: 'Enter a value' };
  switch (op) {
    case 'eq': return { cql: `${f} = ${quoteString(value)}` };
    case 'ne': return { cql: `${f} <> ${quoteString(value)}` };
    case 'contains': return { cql: `${f} ILIKE ${quoteString(`%${value}%`)}` };
    case 'starts': return { cql: `${f} ILIKE ${quoteString(`${value}%`)}` };
    case 'ends': return { cql: `${f} ILIKE ${quoteString(`%${value}`)}` };
    default: return { error: `Unsupported operator "${op}"` };
  }
}

function round(n) {
  return Number(n.toFixed(6));
}

/**
 * BBOX predicate in WGS84 longitude/latitude order. LINZ evaluates BBOX
 * loosely, comparing each feature's bounding box rather than its shape, so
 * it's only exact for points; use extentCondition() for other geometries.
 */
export function bboxCondition(geometryField, { west, south, east, north }) {
  const coords = [west, south, east, north].map(round).join(',');
  return `BBOX(${quoteIdent(geometryField)},${coords},'EPSG:4326')`;
}

/**
 * Features whose geometry actually overlaps a WGS84 rectangle (such as the
 * map view). Unlike BBOX this tests the real shape, so a multipolygon title
 * spread across a district doesn't match a small box inside its bounds.
 */
export function extentCondition(geometryField, { west, south, east, north }) {
  const [w, s, e, n] = [west, south, east, north].map(round);
  return `INTERSECTS(${quoteIdent(geometryField)}, SRID=4326;POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s})))`;
}

/**
 * Features at a WGS84 point, or within `radius` metres of it. The SRID prefix
 * makes LINZ read the point as lon/lat whatever the layer's own CRS is.
 */
export function pointCondition(geometryField, { lon, lat, radius = 0 }) {
  const point = `SRID=4326;POINT(${round(lon)} ${round(lat)})`;
  const f = quoteIdent(geometryField);
  return radius > 0 ? `DWITHIN(${f}, ${point}, ${Number(radius)}, meters)` : `INTERSECTS(${f}, ${point})`;
}

/** Removes diacritics (macrons) so text can be matched against LINZ's `*_ascii` fields. */
export function asciiFold(text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Abbreviations people type for road types, matched as well as the full word.
const ROAD_ABBREVIATIONS = {
  rd: 'road', ave: 'avenue', av: 'avenue', pl: 'place', cres: 'crescent', cr: 'crescent', tce: 'terrace',
  dr: 'drive', hwy: 'highway', ln: 'lane', pde: 'parade', blvd: 'boulevard', cl: 'close', ct: 'court',
  gr: 'grove', mt: 'mount', sq: 'square', esp: 'esplanade',
};

/**
 * Filter for free-text address search against NZ Addresses' `full_address_ascii`:
 * every word must appear, a leading house number ("12", "2/12", "12a") must
 * start the address or follow a unit, and road-type abbreviations also match
 * the full word. Returns '' when there is nothing to search for.
 */
export function addressSearchFilter(text, field = 'full_address_ascii') {
  const f = quoteIdent(field);
  const like = (pattern) => `${f} ILIKE ${quoteString(pattern)}`;
  const tokens = asciiFold(text).toLowerCase().replace(/[,]/g, ' ').split(/\s+/).filter(Boolean);
  const parts = [];
  tokens.forEach((token, i) => {
    if (i === 0 && /^\d+[a-z]?(\/\d+[a-z]?)?$/.test(token)) {
      parts.push(`(${like(`${token} %`)} OR ${like(`%/${token} %`)})`);
    } else if (token.length > 1 || /\d/.test(token)) {
      const full = ROAD_ABBREVIATIONS[token];
      parts.push(full ? `(${like(`%${token}%`)} OR ${like(`%${full}%`)})` : like(`%${token}%`));
    }
  });
  return parts.join(' AND ');
}

/**
 * Combines conditions and optional spatial restrictions (`bbox`: the map
 * extent; `near`: a point and radius) into a single filter. Incomplete
 * conditions are skipped and reported in `errors` keyed by their position.
 * @returns {{cql: string, errors: Map<number, string>}}
 */
export function buildFilter({ match = 'all', conditions = [], bbox = null, near = null }) {
  const parts = [];
  const errors = new Map();
  conditions.forEach((c, i) => {
    const { cql, error } = buildCondition(c);
    if (cql) parts.push(cql);
    else errors.set(i, error);
  });

  let cql = '';
  if (parts.length === 1) cql = parts[0];
  else if (parts.length > 1) cql = parts.map((p) => `(${p})`).join(match === 'any' ? ' OR ' : ' AND ');

  const spatial = [bbox && extentCondition(bbox.field, bbox), near && pointCondition(near.field, near)].filter(Boolean);
  for (const condition of spatial) cql = cql ? `(${cql}) AND ${condition}` : condition;
  return { cql, errors };
}
