import { rgbToCelsius } from './irColormap.js';

/**
 * Builds a global "current clouds" grid from geostationary infrared (≈10.8 µm) imagery.
 *
 *  1. NASA GIBS Band 13 tiles from GOES-East, GOES-West and Himawari (10-minute, calibrated
 *     to °C via the GIBS colormap). Each pixel takes the satellite that sees it most head-on.
 *  2. EUMETSAT's multi-satellite IR ring (3-hourly) fills what GIBS lacks — mainly Europe,
 *     Africa and the Indian Ocean (Meteosat). Its greys are uncalibrated, so they are mapped
 *     to °C with a lookup learned from pixels where both sources overlap.
 *  3. Brightness temperature → cloud cover and cloud-top height, using a simple
 *     lapse-rate model against an estimated surface temperature.
 *
 * Output grid is equirectangular, row 0 = 90°N, column 0 = 180°W.
 */

export const GRID_W = 2048;
export const GRID_H = 1024;
export const MAX_TOP_KM = 16;

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const EUMETSAT_RING =
  'https://view.eumetsat.int/geoserver/wms?service=WMS&version=1.3.0&request=GetMap' +
  '&layers=mumi:worldcloudmap_ir108&styles=&crs=EPSG:4326&bbox=-90,-180,90,180&format=image/png';

export const SATELLITES = [
  { id: 'GOES-East_ABI_Band13_Clean_Infrared', name: 'GOES-East', lon: -75.2 },
  { id: 'GOES-West_ABI_Band13_Clean_Infrared', name: 'GOES-West', lon: -137.2 },
  { id: 'Himawari_AHI_Band13_Clean_Infrared', name: 'Himawari', lon: 140.7 },
];

const Z = 3; // GIBS zoom: 8×8 tiles of 256 px ≈ 0.18° per pixel
const DEG = Math.PI / 180;
const MAX_VIEW_ANGLE = 72; // degrees from the sub-satellite point we still trust

const gibsUrl = (sat, time, x, y) =>
  `${GIBS}/${sat.id}/default/${time}/GoogleMapsCompatible_Level6/${Z}/${y}/${x}.png`;

/** Great-circle angle (deg) between a pixel and the sub-satellite point. */
function viewAngle(lat, lon, satLon) {
  const c = Math.cos(lat * DEG) * Math.cos((lon - satLon) * DEG);
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

async function fetchImage(url, signal) {
  const res = await fetch(url, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return { pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, headers: res.headers };
}

async function pool(tasks, limit) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < tasks.length) {
      const k = i++;
      results[k] = await tasks[k]().catch((e) => e);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Rough surface/low-level temperature by latitude (°C) — the "clear sky" reference. */
function surfaceTemp(lat) {
  const a = Math.abs(lat);
  return 29 - 0.012 * a * a - 0.05 * a;
}

export function tempToCloud(tempC, lat) {
  const dT = surfaceTemp(lat) - tempC; // how much colder than the ground we'd expect
  const s = Math.min(1, Math.max(0, (dT - 8) / 28));
  const cover = s * s * (3 - 2 * s);
  const topKm = Math.min(MAX_TOP_KM, Math.max(0, dT / 6.5));
  return { cover, topKm };
}

/**
 * @param {{signal?: AbortSignal, onProgress?: (done:number,total:number)=>void}} opts
 */
export async function loadCloudGrid({ signal, onProgress } = {}) {
  const N = GRID_W * GRID_H;
  const temp = new Float32Array(N).fill(NaN);
  const score = new Float32Array(N).fill(Infinity);
  const sources = [];

  const latOfRow = (j) => 90 - ((j + 0.5) * 180) / GRID_H;
  const lonOfCol = (i) => -180 + ((i + 0.5) * 360) / GRID_W;
  const n = 2 ** Z;
  const tileLon = (x) => (x / n) * 360 - 180;
  const tileLat = (y) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / DEG;

  // ---- 1. GIBS geostationary tiles ----
  // Pin each satellite to one timestamp (from the "default"/latest tile) so its mosaic is consistent.
  const satTimes = await Promise.all(
    SATELLITES.map(async (sat) => {
      const x = Math.floor(((sat.lon + 180) / 360) * n);
      try {
        const res = await fetch(gibsUrl(sat, 'default', x, n / 2 - 1), { signal, cache: 'no-store' });
        return res.headers.get('layer-time-actual') || 'default';
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        return null;
      }
    }),
  );

  const tasks = [];
  SATELLITES.forEach((sat, s) => {
    const time = satTimes[s];
    if (!time) return;
    sources.push({ name: sat.name, time: time === 'default' ? null : time });
    for (let y = 1; y < n - 1; y++) {
      for (let x = 0; x < n; x++) {
        const mid = tileLon(x + 0.5);
        const dLon = Math.abs(((((mid - sat.lon) % 360) + 540) % 360) - 180);
        if (dLon > 90) continue;
        tasks.push({ sat, time, x, y });
      }
    }
  });

  let done = 0;
  const total = tasks.length + 1;
  const report = () => onProgress?.(++done, total);

  await pool(
    tasks.map((t) => async () => {
      const img = await fetchImage(gibsUrl(t.sat, t.time, t.x, t.y), signal);
      report();
      const { pixels, width } = img;
      const lon0 = tileLon(t.x), lon1 = tileLon(t.x + 1);
      const lat0 = tileLat(t.y), lat1 = tileLat(t.y + 1); // lat0 > lat1
      const i0 = Math.max(0, Math.floor(((lon0 + 180) / 360) * GRID_W));
      const i1 = Math.min(GRID_W, Math.ceil(((lon1 + 180) / 360) * GRID_W));
      const j0 = Math.max(0, Math.floor(((90 - lat0) / 180) * GRID_H));
      const j1 = Math.min(GRID_H, Math.ceil(((90 - lat1) / 180) * GRID_H));
      for (let j = j0; j < j1; j++) {
        const lat = latOfRow(j);
        const my = ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2)) / Math.PI) / 2) * n - t.y;
        if (my < 0 || my >= 1) continue;
        const py = Math.min(width - 1, Math.floor(my * width));
        for (let i = i0; i < i1; i++) {
          const lon = lonOfCol(i);
          const mx = ((lon + 180) / 360) * n - t.x;
          if (mx < 0 || mx >= 1) continue;
          const angle = viewAngle(lat, lon, t.sat.lon);
          const k = j * GRID_W + i;
          if (angle > MAX_VIEW_ANGLE || angle >= score[k]) continue;
          const p = (py * width + Math.min(width - 1, Math.floor(mx * width))) * 4;
          if (pixels[p + 3] < 128) continue;
          temp[k] = rgbToCelsius(pixels[p], pixels[p + 1], pixels[p + 2]);
          score[k] = angle;
        }
      }
    }),
    8,
  );

  // ---- 2. EUMETSAT ring to fill the gaps ----
  try {
    // The ring is published every 3 h. Without an explicit TIME the server returns an old
    // frame, so ask for the latest 3-hour slot (nearestValue snaps to what exists).
    const slot = new Date(Math.floor(Date.now() / 10800e3) * 10800e3).toISOString().replace('.000', '');
    const ring = await fetchImage(`${EUMETSAT_RING}&width=${GRID_W}&height=${GRID_H}&time=${slot}`, signal);
    report();
    const g = ring.pixels;
    // Learn grey → °C from overlap (only well-viewed GIBS pixels).
    const sums = new Float64Array(256);
    const counts = new Uint32Array(256);
    for (let k = 0; k < N; k++) {
      if (g[k * 4 + 3] < 128 || !(score[k] < 50)) continue;
      const v = g[k * 4];
      sums[v] += temp[k];
      counts[v]++;
    }
    const lut = new Float32Array(256).fill(NaN);
    for (let v = 0; v < 256; v++) if (counts[v] >= 150) lut[v] = sums[v] / counts[v];
    fillLut(lut);
    if (lut.some(Number.isFinite)) {
      let filled = 0;
      for (let k = 0; k < N; k++) {
        if (Number.isFinite(temp[k]) && score[k] < 68) continue;
        if (g[k * 4 + 3] < 128) continue;
        temp[k] = lut[g[k * 4]];
        filled++;
      }
      if (filled) sources.push({ name: 'EUMETSAT ring', time: slot, filled });
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    report();
    console.warn('EUMETSAT ring unavailable:', e.message);
  }

  // ---- 3. Temperature → cloud cover + top height ----
  const rgba = new Uint8Array(N * 4);
  for (let j = 0; j < GRID_H; j++) {
    const lat = latOfRow(j);
    for (let i = 0; i < GRID_W; i++) {
      const k = j * GRID_W + i;
      const t = temp[k];
      if (!Number.isFinite(t)) continue;
      const { cover, topKm } = tempToCloud(t, lat);
      rgba[k * 4] = Math.round(cover * 255);
      rgba[k * 4 + 1] = Math.round((topKm / MAX_TOP_KM) * 255);
      rgba[k * 4 + 2] = 255; // has data
      rgba[k * 4 + 3] = 255;
    }
  }

  return { width: GRID_W, height: GRID_H, rgba, temp, sources, loadedAt: new Date() };
}

/** Fill NaN gaps by linear interpolation, then make it monotonic (brighter grey = colder). */
function fillLut(lut) {
  const known = [];
  for (let v = 0; v < 256; v++) if (Number.isFinite(lut[v])) known.push(v);
  if (known.length < 2) return;
  for (let v = 0; v < 256; v++) {
    if (Number.isFinite(lut[v])) continue;
    let a = known[0], b = known[known.length - 1];
    for (const k of known) {
      if (k < v) a = k;
      if (k > v) { b = k; break; }
    }
    // Extrapolate the ends along a wide baseline (end bins are noisy).
    const span = Math.min(8, known.length - 1);
    if (v < known[0]) { a = known[0]; b = known[span]; }
    if (v > known[known.length - 1]) { a = known[known.length - 1 - span]; b = known[known.length - 1]; }
    lut[v] = lut[a] + ((lut[b] - lut[a]) * (v - a)) / (b - a);
  }
  // Enforce a monotonic mapping (direction taken from the data) to remove noise wiggles.
  const colderWhenBrighter = lut[255] < lut[0];
  for (let v = 1; v < 256; v++) {
    lut[v] = colderWhenBrighter ? Math.min(lut[v], lut[v - 1]) : Math.max(lut[v], lut[v - 1]);
  }
}

/** Look up the grid at a lat/lon. */
export function sampleGrid(grid, lat, lon) {
  if (!grid) return null;
  const i = Math.min(GRID_W - 1, Math.max(0, Math.floor(((lon + 180) / 360) * GRID_W)));
  const j = Math.min(GRID_H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * GRID_H)));
  const t = grid.temp[j * GRID_W + i];
  if (!Number.isFinite(t)) return null;
  return { tempC: t, ...tempToCloud(t, lat) };
}
