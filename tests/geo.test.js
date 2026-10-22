import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geometryBounds, pointInPolygon, pointOnSurface } from '../js/geo.js';

const square = { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]] };
const withHole = {
  type: 'Polygon',
  coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]],
};
// A U shape whose centroid falls in the gap between the arms.
const uShape = {
  type: 'Polygon',
  coordinates: [[[0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6], [0, 0]]],
};

test('geometryBounds', () => {
  assert.deepEqual(geometryBounds({ type: 'Polygon', coordinates: [[[166.6, -47.3], [166.6, -34.1], [184.2, -34.1], [166.6, -47.3]]] }),
    [[-47.3, 166.6], [-34.1, 184.2]]);
  assert.deepEqual(geometryBounds({ type: 'Point', coordinates: [174.7, -36.8] }), [[-36.8, 174.7], [-36.8, 174.7]]);
  assert.equal(geometryBounds(null), null);
});

test('pointInPolygon handles holes and multipolygons', () => {
  assert.equal(pointInPolygon([2, 2], square), true);
  assert.equal(pointInPolygon([5, 2], square), false);
  assert.equal(pointInPolygon([2, 2], withHole), false);
  assert.equal(pointInPolygon([0.5, 2], withHole), true);
  const multi = { type: 'MultiPolygon', coordinates: [square.coordinates, [[[10, 10], [12, 10], [12, 12], [10, 10]]]] };
  assert.equal(pointInPolygon([11.5, 10.5], multi), true);
  assert.equal(pointInPolygon([2, 2], { type: 'Point', coordinates: [2, 2] }), false);
});

test('pointOnSurface returns a point on the geometry', () => {
  assert.deepEqual(pointOnSurface({ type: 'Point', coordinates: [1, 2] }), [1, 2]);
  assert.deepEqual(pointOnSurface({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] }), [1, 1]);
  assert.deepEqual(pointOnSurface(square), [2, 2]);
  for (const polygon of [withHole, uShape]) {
    assert.equal(pointInPolygon(pointOnSurface(polygon), polygon), true, JSON.stringify(polygon));
  }
  const multi = { type: 'MultiPolygon', coordinates: [[[[10, 10], [10.1, 10], [10.1, 10.1], [10, 10]]], uShape.coordinates] };
  assert.equal(pointInPolygon(pointOnSurface(multi), uShape), true);
  assert.equal(pointOnSurface(null), null);
});
