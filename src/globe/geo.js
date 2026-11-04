import { Vector3 } from 'three';

/** Scene units are kilometres. Earth is centred at the origin, +Y is the north pole,
 *  +X is (0°N, 0°E) and -Z is (0°N, 90°E). Weather layers can use the same helpers. */
export const EARTH_RADIUS = 6371;
export const DEG = Math.PI / 180;
export const MAX_MERCATOR_LAT = 85.0511287798;

export function lonLatToVec3(lonDeg, latDeg, radius = EARTH_RADIUS, out = new Vector3()) {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const c = Math.cos(lat);
  return out.set(radius * c * Math.cos(lon), radius * Math.sin(lat), -radius * c * Math.sin(lon));
}

export function vec3ToLonLat(v) {
  const r = v.length();
  return { lon: Math.atan2(-v.z, v.x) / DEG, lat: Math.asin(v.y / r) / DEG };
}

/** Local east / north / up unit vectors at a lon/lat. */
export function enu(lonDeg, latDeg) {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
  return {
    east: new Vector3(-so, 0, -co),
    north: new Vector3(-sl * co, cl, sl * so),
    up: new Vector3(cl * co, sl, -cl * so),
  };
}

// --- Web Mercator (slippy map) tile maths ---
export function tileXToLon(x, z) {
  return (x / 2 ** z) * 360 - 180;
}
export function tileYToLat(y, z) {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / DEG;
}

export function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Ray / sphere intersection; returns the nearest hit point or null. */
export function raySphere(origin, dir, radius = EARTH_RADIUS) {
  const b = origin.dot(dir);
  const c = origin.lengthSq() - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0) return null;
  return origin.clone().addScaledVector(dir, t);
}

export function formatLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}`;
}

export function formatDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}
