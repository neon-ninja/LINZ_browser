import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  featureKey, parseRoute, rowLink, rowText,
} from '../js/share.js';

const titles = {
  type: 'layer',
  id: 50804,
  primaryKeys: ['id'],
  fields: [{ name: 'id' }, { name: 'title_no' }, { name: 'shape' }],
};

test('featureKey uses the primary key, then an id field, then the WFS feature id', () => {
  assert.deepEqual(featureKey(titles, { id: 'layer-50804.961395', properties: { id: 961395, title_no: 'CB22A/485' } }),
    { field: 'id', value: '961395' });
  // Columns chosen without the key: fall back to the WFS feature id.
  assert.deepEqual(featureKey(titles, { id: 'layer-50804.961395', properties: { title_no: 'CB22A/485' } }),
    { field: 'id', value: '961395' });
  const noPk = { ...titles, primaryKeys: [] };
  assert.deepEqual(featureKey(noPk, { properties: { id: 7 } }), { field: 'id', value: '7' });
  const stringPk = { type: 'table', id: 1, primaryKeys: ['code'], fields: [{ name: 'code' }] };
  assert.deepEqual(featureKey(stringPk, { properties: { code: 'AB-1' } }), { field: 'code', value: 'AB-1' });
  assert.equal(featureKey(stringPk, { id: 'table-1.x', properties: {} }), null);
  assert.equal(featureKey({ type: 'table', id: 2, fields: [{ name: 'name' }] }, { properties: { name: 'x' } }), null);
});

test('rowLink and parseRoute round-trip', () => {
  const link = rowLink('https://example.org/app/', titles, { field: 'title_no', value: 'CB22A/485' });
  assert.equal(link, 'https://example.org/app/#/layer/50804?title_no=CB22A%2F485');
  assert.deepEqual(parseRoute(link.slice(link.indexOf('#'))),
    { type: 'layer', id: 50804, filters: [{ field: 'title_no', value: 'CB22A/485' }] });
  assert.deepEqual(parseRoute('#/table/51564'), { type: 'table', id: 51564, filters: [] });
  assert.equal(parseRoute('#'), null);
  assert.equal(parseRoute('#/raster/1'), null);
});

test('rowText', () => {
  assert.equal(rowText({
    title: 'NZ Property Titles · id 961395',
    fields: [['title_no', 'CB22A/485'], ['land_district', 'Canterbury']],
    address: '86 Wills Street, Ashburton',
    location: '-43.899560, 171.747130',
    link: 'https://example.org/#/layer/50804?id=961395',
  }), [
    'NZ Property Titles · id 961395',
    'title_no: CB22A/485',
    'land_district: Canterbury',
    'address (looked up): 86 Wills Street, Ashburton',
    'location: -43.899560, 171.747130',
    'https://example.org/#/layer/50804?id=961395',
  ].join('\n'));
  assert.equal(rowText({ title: 'T', fields: [] }), 'T');
});
