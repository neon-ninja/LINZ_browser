import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressSearchFilter, asciiFold, bboxCondition, buildCondition, buildFilter, fieldKind, operatorArity, operatorsFor,
  pointCondition, quoteIdent, quoteString,
} from '../js/cql.js';

test('fieldKind maps LDS field types', () => {
  assert.equal(fieldKind('string'), 'string');
  for (const t of ['integer', 'bigint', 'numeric', 'double']) assert.equal(fieldKind(t), 'number');
  assert.equal(fieldKind('date'), 'date');
  assert.equal(fieldKind('datetime'), 'date');
  assert.equal(fieldKind('boolean'), 'boolean');
  assert.equal(fieldKind('geometry'), 'geometry');
  assert.equal(fieldKind('something-new'), 'string');
});

test('every offered operator builds for its kind', () => {
  const sample = { string: 'x', number: '1', date: '2024-01-01', boolean: '' };
  const types = { string: 'string', number: 'integer', date: 'date', boolean: 'boolean' };
  for (const kind of Object.keys(types)) {
    for (const { value: op } of operatorsFor(kind)) {
      const value = op === 'in' && kind === 'number' ? '1, 2' : sample[kind];
      const result = buildCondition({ field: 'f', type: types[kind], op, value, value2: sample[kind] });
      assert.ok(result.cql, `${kind} ${op} → ${result.error}`);
    }
  }
});

test('operatorArity', () => {
  assert.equal(operatorArity('null'), 0);
  assert.equal(operatorArity('true'), 0);
  assert.equal(operatorArity('eq'), 1);
  assert.equal(operatorArity('in'), 1);
  assert.equal(operatorArity('between'), 2);
});

test('identifiers are quoted only when needed', () => {
  assert.equal(quoteIdent('title_no'), 'title_no');
  assert.equal(quoteIdent('type'), 'type');
  assert.equal(quoteIdent('id'), '"id"');
  assert.equal(quoteIdent('during'), '"during"');
  assert.equal(quoteIdent('has space'), '"has space"');
  assert.equal(quoteIdent('9lives'), '"9lives"');
  assert.equal(quoteIdent('a"b'), '"a""b"');
});

test('strings are single-quoted with quotes doubled', () => {
  assert.equal(quoteString("O'Neill St"), "'O''Neill St'");
});

test('string conditions', () => {
  const c = (op, value) => buildCondition({ field: 'name', type: 'string', op, value }).cql;
  assert.equal(c('eq', 'Taupō'), "name = 'Taupō'");
  assert.equal(c('ne', 'x'), "name <> 'x'");
  assert.equal(c('contains', 'road'), "name ILIKE '%road%'");
  assert.equal(c('starts', 'Ka'), "name ILIKE 'Ka%'");
  assert.equal(c('ends', 'St'), "name ILIKE '%St'");
  assert.equal(c('in', 'Otago, Canterbury ,, '), "name IN ('Otago', 'Canterbury')");
  assert.equal(c('null'), 'name IS NULL');
  assert.equal(c('notnull'), 'name IS NOT NULL');
  assert.match(buildCondition({ field: 'name', type: 'string', op: 'eq', value: '' }).error, /value/);
});

test('number conditions validate input', () => {
  const c = (op, value, value2) => buildCondition({ field: 'n', type: 'bigint', op, value, value2 });
  assert.equal(c('ge', ' 12 ').cql, 'n >= 12');
  assert.equal(c('lt', '-1.5').cql, 'n < -1.5');
  assert.equal(c('between', '1', '10').cql, 'n BETWEEN 1 AND 10');
  assert.equal(c('in', '1, 2,3').cql, 'n IN (1, 2, 3)');
  assert.ok(c('eq', 'abc').error);
  assert.ok(c('eq', '').error);
  assert.ok(c('between', '1', '').error);
  assert.ok(c('in', '1, x').error);
});

test('date conditions work at day granularity', () => {
  const c = (op, value, value2) => buildCondition({ field: 'issue_date', type: 'datetime', op, value, value2 });
  assert.equal(c('eq', '2024-02-28').cql, "issue_date >= '2024-02-28' AND issue_date < '2024-02-29'");
  assert.equal(c('eq', '2024-12-31').cql, "issue_date >= '2024-12-31' AND issue_date < '2025-01-01'");
  assert.equal(c('lt', '2024-01-01').cql, "issue_date < '2024-01-01'");
  assert.equal(c('le', '2024-01-01').cql, "issue_date < '2024-01-02'");
  assert.equal(c('gt', '2024-01-01').cql, "issue_date >= '2024-01-02'");
  assert.equal(c('ge', '2024-01-01').cql, "issue_date >= '2024-01-01'");
  assert.equal(c('between', '2024-03-01', '2024-01-01').cql,
    "issue_date >= '2024-01-01' AND issue_date < '2024-03-02'");
  assert.ok(c('eq', 'yesterday').error);
  assert.ok(c('between', '2024-01-01', '').error);
});

test('boolean conditions', () => {
  assert.equal(buildCondition({ field: 'b', type: 'boolean', op: 'true' }).cql, 'b = true');
  assert.equal(buildCondition({ field: 'b', type: 'boolean', op: 'false' }).cql, 'b = false');
});

test('buildFilter joins conditions and reports incomplete ones', () => {
  const conditions = [
    { field: 'a', type: 'string', op: 'eq', value: 'x' },
    { field: 'b', type: 'integer', op: 'gt', value: '' },
    { field: 'c', type: 'date', op: 'eq', value: '2024-01-01' },
  ];
  const all = buildFilter({ match: 'all', conditions });
  assert.equal(all.cql, "(a = 'x') AND (c >= '2024-01-01' AND c < '2024-01-02')");
  assert.deepEqual([...all.errors.keys()], [1]);

  const any = buildFilter({ match: 'any', conditions: [conditions[0], conditions[2]] });
  assert.equal(any.cql, "(a = 'x') OR (c >= '2024-01-01' AND c < '2024-01-02')");

  assert.equal(buildFilter({ conditions: [conditions[0]] }).cql, "a = 'x'");
  assert.equal(buildFilter({ conditions: [] }).cql, '');
});

test('map extent becomes a WGS84 BBOX', () => {
  const box = { field: 'shape', west: 174.7612345678, south: -36.9, east: 174.8, north: -36.8 };
  assert.equal(bboxCondition('shape', box), "BBOX(shape,174.761235,-36.9,174.8,-36.8,'EPSG:4326')");
  assert.equal(
    buildFilter({ match: 'any', conditions: [{ field: 'a', type: 'string', op: 'eq', value: 'x' }, { field: 'a', type: 'string', op: 'eq', value: 'y' }], bbox: box }).cql,
    "((a = 'x') OR (a = 'y')) AND BBOX(shape,174.761235,-36.9,174.8,-36.8,'EPSG:4326')",
  );
  assert.equal(buildFilter({ bbox: box }).cql, "BBOX(shape,174.761235,-36.9,174.8,-36.8,'EPSG:4326')");
});

test('pointCondition uses an SRID-tagged WGS84 point', () => {
  assert.equal(pointCondition('shape', { lon: 174.76642, lat: -36.84339 }),
    'INTERSECTS(shape, SRID=4326;POINT(174.76642 -36.84339))');
  assert.equal(pointCondition('shape', { lon: 174.7664212345, lat: -36.84339, radius: 50 }),
    'DWITHIN(shape, SRID=4326;POINT(174.766421 -36.84339), 50, meters)');
  assert.equal(
    buildFilter({ conditions: [{ field: 'a', type: 'string', op: 'eq', value: 'x' }], near: { field: 'shape', lon: 1, lat: 2 } }).cql,
    "(a = 'x') AND INTERSECTS(shape, SRID=4326;POINT(1 2))",
  );
});

test('asciiFold strips macrons', () => {
  assert.equal(asciiFold('Taupō, Ōtaki, Whanganui-a-Tara'), 'Taupo, Otaki, Whanganui-a-Tara');
});

test('addressSearchFilter', () => {
  const f = 'full_address_ascii';
  assert.equal(addressSearchFilter('12 Queen St, Auckland'),
    `(${f} ILIKE '12 %' OR ${f} ILIKE '%/12 %') AND ${f} ILIKE '%queen%' AND ${f} ILIKE '%st%' AND ${f} ILIKE '%auckland%'`);
  assert.equal(addressSearchFilter('Lake Tce Taupō'),
    `${f} ILIKE '%lake%' AND (${f} ILIKE '%tce%' OR ${f} ILIKE '%terrace%') AND ${f} ILIKE '%taupo%'`);
  assert.equal(addressSearchFilter('2/12a'), `(${f} ILIKE '2/12a %' OR ${f} ILIKE '%/2/12a %')`);
  assert.equal(addressSearchFilter("O'Neill"), `${f} ILIKE '%o''neill%'`);
  assert.equal(addressSearchFilter(' , a '), '');
});
