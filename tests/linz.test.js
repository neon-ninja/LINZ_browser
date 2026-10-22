import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  featureParams, geometryBounds, normaliseDataset, parseNumberMatched, parseResourceRange,
  parseServiceError, standaloneWfsUrl, typeName, wfsUrl,
} from '../js/linz.js';

test('parseResourceRange', () => {
  assert.deepEqual(parseResourceRange('0-30/1736'), { start: 0, end: 30, total: 1736 });
  assert.deepEqual(parseResourceRange('3-6/16'), { start: 3, end: 6, total: 16 });
  assert.equal(parseResourceRange(null), null);
  assert.equal(parseResourceRange('garbage'), null);
});

test('parseServiceError reads OWS exception reports', () => {
  const xml = `<?xml version="1.0"?><ows:ExceptionReport><ows:Exception exceptionCode="InvalidParameterValue">
    <ows:ExceptionText>Illegal property name: nosuchfield for feature type data.linz.govt.nz:layer-50804</ows:ExceptionText>
  </ows:Exception></ows:ExceptionReport>`;
  assert.equal(parseServiceError(xml), 'Illegal property name: nosuchfield for feature type data.linz.govt.nz:layer-50804');
  assert.equal(parseServiceError('<ExceptionText>a &lt; b &amp; c</ExceptionText>'), 'a < b & c');
  assert.equal(parseServiceError('<html><title>Error 401 Unauthorized</title></html>'), 'Error 401 Unauthorized');
  assert.equal(parseServiceError('{"errors":{"detail":"Invalid API key"},"status_code":401}'), 'Invalid API key');
  assert.equal(parseServiceError(''), '');
});

test('wfsUrl keeps the key out of the URL; standaloneWfsUrl puts it in the path', () => {
  const url = wfsUrl({ request: 'GetFeature', typeNames: 'layer-1' });
  assert.equal(url, 'https://data.linz.govt.nz/services/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=layer-1');
  assert.equal(standaloneWfsUrl(url, 'abc123'), 'https://data.linz.govt.nz/services;key=abc123/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=layer-1');
});

test('featureParams for a results request', () => {
  assert.deepEqual(featureParams({
    typeName: 'layer-50804',
    cql: "land_district = 'Otago'",
    properties: ['title_no', 'shape'],
    sortField: 'issue_date',
    sortDir: 'DESC',
    count: 100,
    startIndex: 200,
    geographic: true,
  }), {
    request: 'GetFeature',
    typeNames: 'layer-50804',
    outputFormat: 'application/json',
    count: '100',
    startIndex: '200',
    srsName: 'EPSG:4326',
    propertyName: 'title_no,shape',
    sortBy: 'issue_date DESC',
    cql_filter: "land_district = 'Otago'",
  });
});

test('featureParams for a hits request ignores paging and columns', () => {
  assert.deepEqual(featureParams({ typeName: 'table-1', cql: 'a = 1', count: 100, properties: ['a'], sortField: 'a', hits: true }), {
    request: 'GetFeature', typeNames: 'table-1', resultType: 'hits', cql_filter: 'a = 1',
  });
  assert.deepEqual(featureParams({ typeName: 'table-1' }), {
    request: 'GetFeature', typeNames: 'table-1', outputFormat: 'application/json',
  });
});

test('parseNumberMatched', () => {
  assert.equal(parseNumberMatched('<wfs:FeatureCollection numberMatched="338573" numberReturned="0"/>'), 338573);
  assert.equal(parseNumberMatched('<x/>'), null);
});

test('geometryBounds', () => {
  assert.deepEqual(geometryBounds({ type: 'Polygon', coordinates: [[[166.6, -47.3], [166.6, -34.1], [184.2, -34.1], [166.6, -47.3]]] }),
    [[-47.3, 166.6], [-34.1, 184.2]]);
  assert.deepEqual(geometryBounds({ type: 'Point', coordinates: [174.7, -36.8] }), [[-36.8, 174.7], [-36.8, 174.7]]);
  assert.equal(geometryBounds(null), null);
});

test('normaliseDataset and typeName', () => {
  const d = normaliseDataset({
    id: 50804,
    type: 'layer',
    kind: 'vector',
    title: 'NZ Property Titles',
    url_html: 'https://data.linz.govt.nz/layer/50804-nz-property-titles/',
    data: {
      fields: [{ name: 'id', type: 'integer' }, { name: 'issue_date', type: 'datetime' }, { name: 'shape', type: 'geometry' }],
      geometry_field: 'shape',
      geometry_type: 'multipolygon',
      feature_count: 2456448,
      crs: { id: 'EPSG:4167' },
    },
  });
  assert.equal(typeName(d), 'layer-50804');
  assert.deepEqual(d.fields.map((f) => f.kind), ['number', 'date', 'geometry']);
  assert.equal(d.geometryField, 'shape');
  assert.equal(d.featureCount, 2456448);
  assert.equal(d.extent, null);

  const table = normaliseDataset({ id: 114085, type: 'table', kind: 'table', title: 'T', data: { fields: [] } });
  assert.equal(typeName(table), 'table-114085');
  assert.equal(table.geometryField, null);
  assert.equal(table.url, 'https://data.linz.govt.nz/table/114085/');
});
