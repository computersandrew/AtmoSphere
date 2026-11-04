import '@fontsource-variable/dm-sans';
import './style.css';
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { TileGlobe } from './globe/TileGlobe.js';
import { GlobeControls } from './globe/GlobeControls.js';
import { createAtmosphere, createStars, ATMOSPHERE_RADIUS } from './globe/sky.js';
import { SOURCES, LABEL_OVERLAY, defaultImageryDate } from './globe/sources.js';
import { EARTH_RADIUS, formatLatLon } from './globe/geo.js';
import { CloudLayer } from './clouds/CloudLayer.js';
import { loadCloudGrid, sampleGrid } from './clouds/cloudData.js';
import { loadModel, loadStations } from './clouds/modelData.js';
import { StationLayer, COVER_NAME } from './clouds/StationLayer.js';
import { formatDistance, formatHeight, formatTemp, getUnits, setUnits } from './units.js';

// ---------- renderer & scenes ----------
const canvas = document.getElementById('globe');
const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.autoClear = false;
renderer.setClearColor(0x000000, 1);

const scene = new Scene(); // Earth + (later) weather layers, units = km
const camera = new PerspectiveCamera(45, 1, 1, 1e5);

const starScene = new Scene(); // drawn first, only follows camera rotation
const starCamera = new PerspectiveCamera(45, 1, 1, 5000);
starScene.add(createStars());

const globe = new TileGlobe(renderer);
const labels = new TileGlobe(renderer, { overlay: true, maxConcurrent: 6 });
const clouds = new CloudLayer();
const stations = new StationLayer();
const atmosphere = createAtmosphere();
scene.add(globe, labels, clouds, stations, atmosphere);

const controls = new GlobeControls(camera, canvas);

// ---------- state (persisted in the URL hash so views are shareable) ----------
const state = { source: 'bluemarble', date: defaultImageryDate(), labels: false, clouds: false, exag: 20, dens: 90, units: getUnits(), fh: 0, metar: true, trim: true };

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has('src') && SOURCES[p.get('src')]) state.source = p.get('src');
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.get('date') || '')) state.date = p.get('date');
  state.labels = p.get('labels') === '1';
  state.clouds = p.get('clouds') === '1';
  if (Number(p.get('exag')) >= 1) state.exag = Math.min(80, Number(p.get('exag')));
  if (p.get('units') === 'metric' || p.get('units') === 'imperial') state.units = p.get('units');
  const v = (p.get('v') || '').split(',').map(Number);
  if (v.length === 5 && v.every(Number.isFinite)) {
    [controls.lat, controls.lon, controls.dist, controls.heading] = v;
    controls.tilt = (v[4] * Math.PI) / 180;
  }
}

let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const c = controls;
    const p = new URLSearchParams({
      src: state.source,
      v: [c.lat.toFixed(4), c.lon.toFixed(4), Math.round(c.dist * 1000) / 1000, c.heading.toFixed(1), ((c.tilt * 180) / Math.PI).toFixed(1)].join(','),
    });
    if (SOURCES[state.source].dated) p.set('date', state.date);
    if (state.labels) p.set('labels', '1');
    if (state.clouds) p.set('clouds', '1');
    if (state.clouds && state.exag !== 20) p.set('exag', state.exag);
    p.set('units', state.units);
    history.replaceState(null, '', `#${p}`);
  }, 250);
}

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const sourcesEl = $('sources');
const dateField = $('date-field');
const dateInput = $('date');
const labelsField = $('labels-field');
const labelsInput = $('labels');

function buildSourceButtons() {
  let group = null;
  for (const s of Object.values(SOURCES)) {
    if (s.group !== group) {
      group = s.group;
      const g = document.createElement('div');
      g.className = 'group-label';
      g.textContent = group;
      sourcesEl.append(g);
    }
    const b = document.createElement('button');
    b.className = 'source';
    b.type = 'button';
    b.role = 'radio';
    b.dataset.id = s.id;
    b.innerHTML = `<span class="dot"></span><span class="name">${s.label}</span><span class="note">${s.note}</span>`;
    b.addEventListener('click', () => setSource(s.id));
    sourcesEl.append(b);
  }
}

function setSource(id) {
  state.source = id;
  const src = SOURCES[id];
  globe.setSource(src, state.date);
  for (const b of sourcesEl.querySelectorAll('.source')) b.setAttribute('aria-checked', String(b.dataset.id === id));
  dateField.hidden = !src.dated;
  // OSM already has labels; the overlay is for satellite imagery.
  labelsField.hidden = src.group !== 'Satellite';
  syncLabels();
  updateAttribution();
  writeHash();
}

function syncLabels() {
  const on = state.labels && SOURCES[state.source].group === 'Satellite';
  if (on && !labels.source) labels.setSource(LABEL_OVERLAY);
  if (!on && labels.source) labels.setSource(null);
  labels.visible = on;
  updateAttribution();
}

function updateAttribution() {
  const src = SOURCES[state.source];
  const parts = [src.attributionUrl ? `<a href="${src.attributionUrl}" target="_blank" rel="noopener">${src.attribution}</a>` : src.attribution];
  if (labels.visible) parts.push(LABEL_OVERLAY.attribution);
  if (clouds.visible) parts.push('Clouds: NASA GIBS (GOES, Himawari) · © EUMETSAT · NOAA HRRR · METAR via aviationweather.gov');
  $('attribution').innerHTML = parts.join(' · ');
}

dateInput.max = defaultImageryDate();
dateInput.min = '2018-01-05';
dateInput.addEventListener('change', () => {
  if (!dateInput.value) return;
  state.date = dateInput.value;
  globe.setDate(state.date);
  writeHash();
});
labelsInput.addEventListener('change', () => {
  state.labels = labelsInput.checked;
  syncLabels();
  writeHash();
});
$('collapse').addEventListener('click', () => {
  const p = $('panel');
  p.classList.toggle('collapsed');
  $('collapse').textContent = p.classList.contains('collapsed') ? '+' : '–';
});
$('compass').addEventListener('click', () => controls.flyTo({ heading: 0, tilt: 0 }, 700));
$('home').addEventListener('click', () => controls.flyTo({ dist: 22000, heading: 0, tilt: 0 }, 1400));
// ---------- clouds ----------
const cloudsInput = $('clouds');
const cloudStatus = $('cloud-status');
let cloudAbort = null;
let cloudTimer = 0;

async function refreshClouds() {
  cloudAbort?.abort();
  cloudAbort = new AbortController();
  clearTimeout(cloudTimer);
  cloudStatus.textContent = 'Loading satellite infrared…';
  try {
    const grid = await loadCloudGrid({
      signal: cloudAbort.signal,
      onProgress: (d, t) => (cloudStatus.textContent = `Loading satellite infrared… ${Math.round((100 * d) / t)}%`),
    });
    clouds.setGrid(grid);
    cloudStatus.textContent = describeClouds(grid);
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    cloudStatus.textContent = 'Could not load cloud imagery. Retrying in 2 min.';
    cloudTimer = setTimeout(refreshClouds, 120e3);
    return;
  }
  // Geostationary imagery updates every 10 minutes.
  cloudTimer = setTimeout(refreshClouds, 10 * 60e3);
}

function describeClouds(grid) {
  const geo = grid.sources.filter((s) => s.name !== 'EUMETSAT ring' && s.time);
  const latest = geo.map((s) => s.time).sort().pop();
  const fmt = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const ring = grid.sources.find((s) => s.name === 'EUMETSAT ring');
  let text = `Infrared from ${geo.map((s) => s.name).join(', ')}`;
  if (latest) text += ` at ${fmt(latest)}`;
  if (ring) text += `; Europe, Africa & Indian Ocean from EUMETSAT (${ring.time ? fmt(ring.time) : '3-hourly'})`;
  return `${text}. Heights are estimated from cloud-top temperature.`;
}

// ---------- HRRR model volume + METAR stations (US) ----------
let model = null;
let modelTimer = 0;
const modelStatus = $('model-status');
const fmtTime = (iso) =>
  new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

async function refreshModel() {
  clearTimeout(modelTimer);
  try {
    const m = await loadModel();
    if (!model || m.manifest.cycle !== model.manifest.cycle) {
      model = m;
      clouds.setModel(model);
      const fc = $('fc');
      fc.max = model.manifest.forecast.length - 1;
      state.fh = Math.min(state.fh, Number(fc.max));
      fc.value = state.fh;
      $('fc-field').hidden = false;
      await applyForecastHour(state.fh);
    }
    const st = await loadStations().catch(() => null);
    if (st) stations.setStations(st.stations);
  } catch (e) {
    console.warn(e.message);
    model = null;
    clouds.setModel(null);
    $('fc-field').hidden = true;
    modelStatus.textContent =
      'No HRRR data found. It is produced hourly by the GitHub workflow (or run pipeline/build_clouds.py locally). Satellite clouds are shown instead.';
  }
  // The pipeline publishes a new run about every hour.
  modelTimer = setTimeout(refreshModel, 15 * 60e3);
}

async function applyForecastHour(fh) {
  state.fh = fh;
  if (!model) return;
  const entry = model.manifest.forecast.find((f) => f.fh === fh) || model.manifest.forecast[0];
  $('fc-val').textContent = fh === 0 ? 'Now' : `+${fh} h`;
  clouds.setModelTexture(await model.forecast(entry.fh));
  // The satellite only describes the present, so only use it to check the analysis.
  clouds.setTrim(state.trim && fh === 0);
  const m = model.manifest;
  modelStatus.textContent =
    `HRRR run ${fmtTime(m.cycle)}, showing ${fmtTime(entry.valid)}. ` +
    (fh === 0 && m.metar?.stations ? `Cloud bases corrected with ${m.metar.stations.toLocaleString()} METAR reports. ` : '') +
    (fh > 0 ? 'Outside the US the satellite clouds stay at the current time.' : '');
}

$('fc').addEventListener('input', (e) => applyForecastHour(Number(e.target.value)));
$('metar').addEventListener('change', (e) => (state.metar = e.target.checked));
$('trim').addEventListener('change', (e) => {
  state.trim = e.target.checked;
  clouds.setTrim(state.trim && state.fh === 0);
});

function setClouds(on) {
  state.clouds = on;
  cloudsInput.checked = on;
  clouds.visible = on;
  $('cloud-opts').hidden = !on;
  if (on && !clouds.grid) refreshClouds();
  if (on && !model) refreshModel();
  if (!on) {
    cloudAbort?.abort();
    clearTimeout(cloudTimer);
    clearTimeout(modelTimer);
    model = null;
    clouds.grid = null; // reload fresh next time it's switched on
  }
  updateAttribution();
  writeHash();
}

cloudsInput.addEventListener('change', () => setClouds(cloudsInput.checked));
$('exag').addEventListener('input', (e) => {
  state.exag = Number(e.target.value);
  clouds.setExaggeration(state.exag);
  stations.setExaggeration(state.exag);
  $('exag-val').textContent = `${state.exag}×`;
  writeHash();
});
$('dens').addEventListener('input', (e) => {
  state.dens = Number(e.target.value);
  clouds.setDensity(state.dens / 100);
  $('dens-val').textContent = `${state.dens}%`;
});

// ---------- units ----------
function applyUnits(u) {
  state.units = u;
  setUnits(u);
  for (const b of $('units').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.units === u));
  if (lastPointer) updateCursor(lastPointer);
  writeHash();
}
$('units').addEventListener('click', (e) => {
  const u = e.target.closest('button')?.dataset.units;
  if (u) applyUnits(u);
});

const debugInput = $('debug');
debugInput.addEventListener('change', () => ($('stats').hidden = !debugInput.checked));

let lastPointer = null;
function updateCursor({ x, y }) {
  const p = controls.pick(x, y);
  if (!p && !stations.visible) {
    $('cursor').textContent = '—';
    return;
  }
  const st = stations.pick(camera, canvas, x, y);
  if (st) {
    const layers = st.layers.length
      ? st.layers.map(([c, agl]) => `${COVER_NAME[c]} ${formatHeight(agl / 1000)}`).join(', ')
      : 'clear below 12,000 ft';
    const mb = st.model_base_m != null ? ` · HRRR base ${formatHeight(st.model_base_m / 1000)}` : '';
    $('cursor').textContent = `${st.id}: ${layers}${mb} · ${st.raw.replace(/^(METAR|SPECI) /, '')}`;
    return;
  }
  if (!p) {
    $('cursor').textContent = '—';
    return;
  }
  let text = formatLatLon(p.lat, p.lon);
  if (clouds.visible && clouds.grid) {
    const c = sampleGrid(clouds.grid, p.lat, p.lon);
    if (c && c.cover > 0.15) text += ` · cloud top ${formatHeight(c.topKm)}, ${formatTemp(c.tempC)}`;
    else if (c) text += ` · clear (${formatTemp(c.tempC)})`;
  }
  $('cursor').textContent = text;
}
canvas.addEventListener('pointermove', (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
  updateCursor(lastPointer);
});

controls.onChange = writeHash;

// ---------- boot ----------
readHash();
buildSourceButtons();
dateInput.value = state.date;
labelsInput.checked = state.labels;
setSource(state.source);
applyUnits(state.units);
$('exag').value = state.exag;
$('exag-val').textContent = `${state.exag}×`;
clouds.setExaggeration(state.exag);
setClouds(state.clouds);
controls.apply();

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = starCamera.aspect = w / h;
  camera.updateProjectionMatrix();
  starCamera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function updateClipPlanes() {
  const r = camera.position.length();
  const alt = Math.max(r - EARTH_RADIUS, 0.001);
  // Farthest thing we can see is the atmosphere shell grazing past the horizon.
  const horizon = Math.sqrt(Math.max(r * r - EARTH_RADIUS * EARTH_RADIUS, 0));
  // Far enough for the atmosphere and the (exaggerated) cloud shells beyond the horizon.
  const top = Math.max(ATMOSPHERE_RADIUS, EARTH_RADIUS + (clouds.visible ? 16 * clouds.exaggeration : 0));
  const shell = Math.sqrt(top * top - EARTH_RADIUS * EARTH_RADIUS);
  camera.near = Math.max(0.005, alt * 0.25);
  camera.far = horizon + shell + 10;
  camera.updateProjectionMatrix();
  // Limb glow only makes sense from outside the atmosphere.
  atmosphere.material.uniforms.uFade.value = Math.min(1, Math.max(0, (alt - 120) / 600));
}

let statsTick = 0;
function frame() {
  controls.update();
  updateClipPlanes();
  camera.updateMatrixWorld();

  const vh = renderer.domElement.clientHeight;
  globe.update(camera, vh);
  if (labels.visible) labels.update(camera, vh);
  clouds.update(camera);
  stations.update(camera, clouds.visible && state.metar);

  starCamera.quaternion.copy(camera.quaternion);
  renderer.clear();
  renderer.render(starScene, starCamera);
  renderer.clearDepth();
  renderer.render(scene, camera);

  $('alt').textContent = `alt ${formatDistance(controls.altitude)} · z${globe.stats.maxLevel}`;
  $('compass').firstElementChild.style.transform = `rotate(${-controls.heading}deg)`;
  if (debugInput.checked && ++statsTick % 10 === 0) {
    const s = globe.stats;
    $('stats').textContent =
      `selected ${s.leaves}  drawn ${s.drawn}\ncached ${s.cached}  loading ${s.loading}\n` +
      `draw calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy in the dev console.
Object.assign(window, { globe, clouds, stations, controls, camera, renderer });
