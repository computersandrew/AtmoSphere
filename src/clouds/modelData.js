import { LinearFilter, TextureLoader } from 'three';

/**
 * Loads the HRRR cloud volume written by pipeline/build_clouds.py:
 *   <base>/hrrr/manifest.json, mask.png, fNN.png   and   <base>/metar/stations.json
 *
 * <base> defaults to ./data/ (deployed next to the site by the GitHub workflow).
 * For local development against the live site, open the app with
 *   ?data=https://<user>.github.io/<repo>/data/
 * or set VITE_DATA_URL.
 */
export const DATA_BASE = (() => {
  const q = new URLSearchParams(location.search).get('data');
  const base = q || import.meta.env.VITE_DATA_URL || './data/';
  return base.endsWith('/') ? base : `${base}/`;
})();

const loader = new TextureLoader().setCrossOrigin('anonymous');

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (t) => {
        t.flipY = false; // row 0 = north
        t.generateMipmaps = false; // atlas tiles must not bleed into each other
        t.minFilter = LinearFilter;
        t.magFilter = LinearFilter;
        t.needsUpdate = true;
        resolve(t);
      },
      undefined,
      () => reject(new Error(`failed to load ${url}`)),
    );
  });
}

export async function loadModel() {
  const res = await fetch(`${DATA_BASE}hrrr/manifest.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`no HRRR data (${res.status})`);
  const manifest = await res.json();
  const stamp = encodeURIComponent(manifest.cycle); // new URL per run, so caches never mix runs
  const url = (f) => `${DATA_BASE}hrrr/${f}?run=${stamp}`;
  const [mask, texture] = await Promise.all([loadTexture(url('mask.png')), loadTexture(url(manifest.forecast[0].file))]);
  const cache = new Map([[0, texture]]);
  return {
    manifest,
    mask,
    texture,
    /** Texture for a forecast hour (loaded on demand, cached). */
    async forecast(fh) {
      if (!cache.has(fh)) {
        const entry = manifest.forecast.find((f) => f.fh === fh);
        if (!entry) throw new Error(`no forecast hour ${fh}`);
        cache.set(fh, loadTexture(url(entry.file)));
      }
      return cache.get(fh);
    },
  };
}

export async function loadStations() {
  const res = await fetch(`${DATA_BASE}metar/stations.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`no METAR data (${res.status})`);
  return res.json();
}
