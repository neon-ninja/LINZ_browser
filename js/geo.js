// Small GeoJSON geometry helpers (WGS84 lon/lat). Pure functions.

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
  if (geometry?.type === 'GeometryCollection') geometry.geometries.forEach((g) => visit(g.coordinates));
  else visit(geometry?.coordinates);
  return Number.isFinite(west) ? [[south, west], [north, east]] : null;
}

function polygonsOf(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

// Even-odd rule across all rings, so holes are excluded.
function inRings([x, y], rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Whether a [lon, lat] point lies inside a Polygon or MultiPolygon. */
export function pointInPolygon(point, geometry) {
  return polygonsOf(geometry).some((rings) => inRings(point, rings));
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return area / 2;
}

function ringCentroid(ring) {
  const area = ringArea(ring);
  if (!area) return ring[0];
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    x += (ring[j][0] + ring[i][0]) * cross;
    y += (ring[j][1] + ring[i][1]) * cross;
  }
  return [x / (6 * area), y / (6 * area)];
}

// A point inside a polygon: its centroid when that's inside, otherwise the
// middle of the widest inside stretch of a horizontal line through it.
function polygonInteriorPoint(rings) {
  const centroid = ringCentroid(rings[0]);
  if (inRings(centroid, rings)) return centroid;
  const y = centroid[1];
  const xs = [];
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y)) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
  }
  xs.sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
  }
  return best ? [(best[0] + best[1]) / 2, y] : rings[0][0];
}

/** A representative [lon, lat] that lies on the geometry (inside it, for polygons). */
export function pointOnSurface(geometry) {
  if (!geometry) return null;
  const c = geometry.coordinates;
  switch (geometry.type) {
    case 'Point': return c;
    case 'MultiPoint': return c[0];
    case 'LineString': return c[Math.floor(c.length / 2)];
    case 'MultiLineString': return c[0][Math.floor(c[0].length / 2)];
    case 'Polygon':
    case 'MultiPolygon': {
      const largest = polygonsOf(geometry)
        .reduce((a, b) => (Math.abs(ringArea(b[0])) > Math.abs(ringArea(a[0])) ? b : a));
      return polygonInteriorPoint(largest);
    }
    case 'GeometryCollection': return pointOnSurface(geometry.geometries[0]);
    default: return null;
  }
}
