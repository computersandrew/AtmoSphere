import {
  BufferGeometry,
  Float32BufferAttribute,
  Uint16BufferAttribute,
  Frustum,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Sphere,
  TextureLoader,
  Vector3,
  Color,
} from 'three';
import { EARTH_RADIUS, DEG, MAX_MERCATOR_LAT, lonLatToVec3, tileXToLon, tileYToLat } from './geo.js';

const MIN_LEVEL = 2; // always split below this so the sphere stays round
const ROOT_PRELOAD = 2; // levels 0..2 are always kept as a fallback
const MAX_LEAVES = 700;
const MAX_CACHED = 600;

const key = (z, x, y) => `${z}/${x}/${y}`;

// Shared across layers/sources: geometry and bounds depend only on z/x/y.
const geometryCache = new Map();
const boundsCache = new Map();

function segmentsFor(z) {
  if (z < 4) return 32;
  if (z < 8) return 16;
  return 8;
}

/** Bounding sphere of a tile on the globe (sampled 3×3). */
function tileBounds(z, x, y) {
  const k = key(z, x, y);
  let b = boundsCache.get(k);
  if (b) return b;
  const pts = [];
  for (let j = 0; j <= 2; j++) {
    for (let i = 0; i <= 2; i++) {
      pts.push(lonLatToVec3(tileXToLon(x + i / 2, z), tileYToLat(y + j / 2, z)));
    }
  }
  const center = pts[4];
  let radius = 0;
  for (const p of pts) radius = Math.max(radius, p.distanceTo(center));
  // Pad for curvature between samples (matters only for big tiles).
  radius *= z < 3 ? 1.5 : 1.08;
  b = { center, radius, span: radius * Math.SQRT2 };
  if (boundsCache.size > 50000) boundsCache.clear();
  boundsCache.set(k, b);
  return b;
}

/** Curved patch for a Mercator tile. Vertices are evenly spaced in Mercator Y,
 *  so plain linear UVs map the tile image exactly. Positions are stored relative
 *  to the tile centre (mesh.position) to avoid float32 jitter when zoomed in. */
function tileGeometry(z, x, y) {
  const k = key(z, x, y);
  let g = geometryCache.get(k);
  if (g) return g;
  const segs = segmentsFor(z);
  const center = tileBounds(z, x, y).center;
  const n = segs + 1;
  const pos = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  const tmp = new Vector3();
  for (let j = 0; j < n; j++) {
    const lat = tileYToLat(y + j / segs, z);
    for (let i = 0; i < n; i++) {
      const lon = tileXToLon(x + i / segs, z);
      lonLatToVec3(lon, lat, EARTH_RADIUS, tmp).sub(center);
      const idx = j * n + i;
      pos.set([tmp.x, tmp.y, tmp.z], idx * 3);
      uv.set([i / segs, 1 - j / segs], idx * 2);
    }
  }
  const index = new Uint16Array(segs * segs * 6);
  let o = 0;
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      index.set([a, c, b, b, c, d], o); // counter-clockwise seen from outside
      o += 6;
    }
  }
  g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(new Uint16BufferAttribute(index, 1));
  g.boundingSphere = new Sphere(new Vector3(), tileBounds(z, x, y).radius);
  if (geometryCache.size > 3000) {
    // Drop the oldest entries (Map preserves insertion order).
    let drop = 1000;
    for (const [gk, geo] of geometryCache) {
      if (drop-- <= 0) break;
      if (geo.userData.refs > 0) continue;
      geo.dispose();
      geometryCache.delete(gk);
    }
  }
  g.userData.refs = 0;
  geometryCache.set(k, g);
  return g;
}

/**
 * Quadtree-LOD globe that streams XYZ imagery tiles.
 * Each frame: walk the quadtree from z=0, cull by horizon + frustum, refine tiles
 * whose projected size exceeds `pixelThreshold`, then draw each selected tile —
 * or its nearest loaded ancestor/children while it is still loading.
 */
export class TileGlobe extends Group {
  constructor(renderer, { overlay = false, maxConcurrent = 10 } = {}) {
    super();
    this.overlay = overlay;
    this.maxConcurrent = maxConcurrent;
    this.pixelThreshold = 384; // refine when a 256px tile would cover more than this many CSS px
    this.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    this.loader = new TextureLoader().setCrossOrigin('anonymous');
    this.tiles = new Map();
    this.active = 0;
    this.generation = 0;
    this.source = null;
    this.date = null;
    this.frame = 0;
    this.stats = { leaves: 0, drawn: 0, cached: 0, loading: 0, maxLevel: 0 };
    this._frustum = new Frustum();
    this._m = new Matrix4();
    this._sphere = new Sphere();

    if (!overlay) {
      // Dark under-sphere (shows only through hairline cracks before tiles load)
      // plus polar caps for the regions Web Mercator can't represent.
      this.base = new Mesh(
        new SphereGeometry(EARTH_RADIUS * 0.9995, 64, 32),
        new MeshBasicMaterial({ color: 0x0b1622 }),
      );
      this.base.renderOrder = -10;
      this.add(this.base);
      const capTheta = (90 - MAX_MERCATOR_LAT) * DEG;
      const mkCap = (thetaStart) =>
        new Mesh(
          new SphereGeometry(EARTH_RADIUS * 0.99995, 96, 6, 0, Math.PI * 2, thetaStart, capTheta + 0.002),
          new MeshBasicMaterial({ color: 0xffffff }),
        );
      this.northCap = mkCap(0);
      this.southCap = mkCap(Math.PI - capTheta - 0.002);
      this.add(this.northCap, this.southCap);
    }
  }

  setSource(source, date = this.date) {
    this.clear_();
    this.source = source;
    this.date = date;
    this.generation++;
    if (this.northCap && source?.caps) {
      this.northCap.material.color = new Color(source.caps.north);
      this.southCap.material.color = new Color(source.caps.south);
    }
    if (!source) return;
    for (let z = 0; z <= ROOT_PRELOAD; z++) {
      for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) this.request(z, x, y);
    }
  }

  setDate(date) {
    if (this.source?.dated && date !== this.date) this.setSource(this.source, date);
    else this.date = date;
  }

  clear_() {
    for (const t of this.tiles.values()) this.disposeTile(t);
    this.tiles.clear();
  }

  disposeTile(t) {
    if (t.mesh) {
      this.remove(t.mesh);
      t.mesh.material.map?.dispose();
      t.mesh.material.dispose();
      t.mesh.geometry.userData.refs--;
    }
    t.state = 'disposed';
  }

  request(z, x, y) {
    const k = key(z, x, y);
    let t = this.tiles.get(k);
    if (t) return t;
    t = { k, z, x, y, state: 'queued', mesh: null, lastUsed: this.frame };
    this.tiles.set(k, t);
    return t;
  }

  startLoad(t) {
    t.state = 'loading';
    this.active++;
    const gen = this.generation;
    const url = this.source.url(t.z, t.x, t.y, this.date);
    const done = () => {
      this.active--;
    };
    this.loader.load(
      url,
      (tex) => {
        done();
        if (gen !== this.generation || t.state === 'disposed') {
          tex.dispose();
          return;
        }
        tex.colorSpace = SRGBColorSpace;
        tex.anisotropy = this.maxAnisotropy;
        const geometry = tileGeometry(t.z, t.x, t.y);
        geometry.userData.refs++;
        // Finer levels win depth ties against coarser fallbacks drawn underneath.
        const lift = this.overlay ? t.z + 24 : t.z;
        const material = new MeshBasicMaterial({
          map: tex,
          transparent: this.overlay,
          depthWrite: !this.overlay,
          polygonOffset: true,
          polygonOffsetFactor: -lift,
          polygonOffsetUnits: -lift * 4,
        });
        const mesh = new Mesh(geometry, material);
        mesh.position.copy(tileBounds(t.z, t.x, t.y).center);
        mesh.renderOrder = this.overlay ? 100 + t.z : t.z;
        mesh.visible = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        t.mesh = mesh;
        t.state = 'ready';
        this.add(mesh);
      },
      undefined,
      () => {
        done();
        if (gen === this.generation) t.state = 'failed';
      },
    );
  }

  /** Best drawable stand-in for a tile: itself, its 4 loaded children, or an ancestor. */
  collectDrawable(z, x, y, out) {
    const t = this.tiles.get(key(z, x, y));
    if (t?.state === 'ready') return out.add(t);
    if (z < this.source.maxZoom) {
      const kids = [];
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) {
          const c = this.tiles.get(key(z + 1, 2 * x + i, 2 * y + j));
          if (c?.state === 'ready') kids.push(c);
        }
      if (kids.length === 4) return kids.forEach((c) => out.add(c));
    }
    for (let pz = z - 1, px = x >> 1, py = y >> 1; pz >= 0; pz--, px >>= 1, py >>= 1) {
      const p = this.tiles.get(key(pz, px, py));
      if (p?.state === 'ready') return out.add(p);
    }
  }

  update(camera, viewportHeight) {
    if (!this.source) return;
    this.frame++;
    const cam = camera.position;
    const camR = cam.length();
    const R2 = EARTH_RADIUS * EARTH_RADIUS;
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    const K = viewportHeight / (2 * Math.tan((camera.fov * DEG) / 2));
    const maxZ = this.source.maxZoom;
    const leaves = [];

    const visit = (z, x, y) => {
      const b = tileBounds(z, x, y);
      // Horizon cull: every point of the tile is behind the horizon plane.
      if (z >= 2 && b.center.dot(cam) + b.radius * camR < R2) return;
      this._sphere.set(b.center, b.radius);
      if (!this._frustum.intersectsSphere(this._sphere)) return;
      const dist = Math.max(cam.distanceTo(b.center) - b.radius * 0.5, 1e-3);
      const refine =
        z < MIN_LEVEL || (z < maxZ && leaves.length < MAX_LEAVES && (b.span / dist) * K > this.pixelThreshold);
      if (refine) {
        const nz = z + 1;
        visit(nz, 2 * x, 2 * y);
        visit(nz, 2 * x + 1, 2 * y);
        visit(nz, 2 * x, 2 * y + 1);
        visit(nz, 2 * x + 1, 2 * y + 1);
      } else {
        leaves.push({ z, x, y, dist });
      }
    };
    visit(0, 0, 0);

    // Queue loads: coarse levels first, then nearest.
    const want = [];
    let maxLevel = 0;
    for (const l of leaves) {
      maxLevel = Math.max(maxLevel, l.z);
      const t = this.request(l.z, l.x, l.y);
      t.lastUsed = this.frame;
      if (t.state === 'queued') want.push({ t, z: l.z, dist: l.dist });
    }
    // Also keep queued root tiles moving.
    for (const t of this.tiles.values()) if (t.state === 'queued' && t.z <= ROOT_PRELOAD) want.push({ t, z: t.z, dist: 0 });
    want.sort((a, b) => a.z - b.z || a.dist - b.dist);
    for (const w of want) {
      if (this.active >= this.maxConcurrent) break;
      if (w.t.state === 'queued') this.startLoad(w.t);
    }

    // Decide what to draw.
    const draw = new Set();
    for (const l of leaves) this.collectDrawable(l.z, l.x, l.y, draw);
    for (const t of this.tiles.values()) if (t.mesh) t.mesh.visible = false;
    for (const t of draw) {
      t.mesh.visible = true;
      t.lastUsed = this.frame;
    }

    this.evict();
    let loading = 0;
    for (const t of this.tiles.values()) if (t.state === 'loading' || t.state === 'queued') loading++;
    this.stats = { leaves: leaves.length, drawn: draw.size, cached: this.tiles.size, loading, maxLevel };
  }

  evict() {
    // Forget queued tiles nobody asked for this frame (camera moved on).
    for (const [k, t] of this.tiles) {
      if (t.state === 'queued' && t.z > ROOT_PRELOAD && t.lastUsed < this.frame) this.tiles.delete(k);
    }
    if (this.tiles.size <= MAX_CACHED) return;
    const old = [...this.tiles.values()]
      .filter((t) => t.z > ROOT_PRELOAD && t.lastUsed < this.frame - 2 && t.state !== 'loading')
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (let i = 0; i < old.length && this.tiles.size > MAX_CACHED * 0.8; i++) {
      this.disposeTile(old[i]);
      this.tiles.delete(old[i].k);
    }
  }
}

