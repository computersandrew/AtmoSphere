/**
 * Imagery providers. Every source is a Web Mercator (EPSG:3857) XYZ tile set.
 * `url(z, x, y, date)` returns the tile URL. `caps` colours the polar regions
 * beyond Mercator's ±85.05° limit so they blend with the imagery.
 *
 * Check each provider's terms before deploying publicly — in particular the
 * OpenStreetMap tile usage policy (https://operations.osmfoundation.org/policies/tiles/)
 * forbids heavy traffic; switch to a commercial OSM tile host if the site gets popular.
 */

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

/** Daily satellite layers are published with a lag; default to yesterday (UTC). */
export function defaultImageryDate() {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export const SOURCES = {
  bluemarble: {
    id: 'bluemarble',
    label: 'NASA Blue Marble',
    group: 'Satellite',
    note: 'Cloud-free composite',
    maxZoom: 8,
    url: (z, x, y) => `${GIBS}/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg`,
    attribution: 'Imagery: NASA Earth Observatory Blue Marble via NASA GIBS',
    caps: { north: '#dfe7ec', south: '#eef3f6' },
  },
  viirs: {
    id: 'viirs',
    label: 'NASA VIIRS True Color',
    group: 'Satellite',
    note: 'Daily pass, real clouds',
    maxZoom: 9,
    dated: true,
    url: (z, x, y, date) =>
      `${GIBS}/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/${z}/${y}/${x}.jpg`,
    attribution: 'Imagery: NASA GIBS, NOAA-20 / VIIRS Corrected Reflectance',
    caps: { north: '#1b1f24', south: '#e9eef2' },
  },
  esri: {
    id: 'esri',
    label: 'Esri World Imagery',
    group: 'Satellite',
    note: 'High-res, zoom to street level',
    maxZoom: 18,
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    caps: { north: '#d9e2e8', south: '#eef2f5' },
  },
  osm: {
    id: 'osm',
    label: 'OpenStreetMap',
    group: 'Map',
    note: 'Streets & places',
    maxZoom: 19,
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    attribution: '© OpenStreetMap contributors',
    attributionUrl: 'https://www.openstreetmap.org/copyright',
    caps: { north: '#aad3df', south: '#f2efe9' },
  },
};

/** Transparent overlay drawn on top of the satellite sources. */
export const LABEL_OVERLAY = {
  id: 'labels',
  label: 'Borders & places',
  maxZoom: 18,
  url: (z, x, y) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`,
  attribution: 'Labels © Esri',
};
