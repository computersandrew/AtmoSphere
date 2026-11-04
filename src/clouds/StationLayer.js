import {
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  Vector3,
} from 'three';
import { EARTH_RADIUS, enu, lonLatToVec3 } from '../globe/geo.js';

const COVER_COLOR = {
  CLR: '#7dd87d',
  FEW: '#9fd6ff',
  SCT: '#4ea3ff',
  BKN: '#ffb020',
  OVC: '#ff5a3c',
  OVX: '#d94cff',
};
export const COVER_NAME = { CLR: 'clear', FEW: 'few', SCT: 'scattered', BKN: 'broken', OVC: 'overcast', OVX: 'sky obscured' };

const MAX_VISIBLE_ALT = 4000; // km: hide markers when zoomed further out

/**
 * METAR stations as 3D markers: a stem from the ground to the highest reported layer
 * and a coloured disc at each reported cloud base (same height exaggeration as clouds).
 */
export class StationLayer extends Group {
  constructor() {
    super();
    this.stations = [];
    this.exaggeration = 20;
    this.discRadius = 0;
    this.visible = false;
    this._m = new Matrix4();
    this._v = new Vector3();
  }

  setStations(stations) {
    this.clear();
    this.stations = stations.filter((s) => s.layers.length || s.clear);
    const discs = [];
    for (const s of this.stations) {
      if (s.clear) discs.push({ s, cover: 'CLR', agl: 0 });
      for (const [cover, agl] of s.layers) discs.push({ s, cover, agl });
    }
    this.discs = discs;
    const mesh = new InstancedMesh(
      new CircleGeometry(1, 20),
      new MeshBasicMaterial({ side: DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }),
      Math.max(1, discs.length),
    );
    const color = new Color();
    discs.forEach((d, i) => mesh.setColorAt(i, color.set(COVER_COLOR[d.cover] || '#ffffff')));
    mesh.count = discs.length;
    mesh.frustumCulled = false;
    mesh.renderOrder = 600; // after the cloud shells, so markers stay readable inside cloud
    this.mesh = mesh;

    this.stems = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.stems.frustumCulled = false;
    this.stems.renderOrder = 600;
    this.add(this.stems, mesh);
    this.discRadius = 0;
    this.layout();
  }

  setExaggeration(x) {
    if (x === this.exaggeration) return;
    this.exaggeration = x;
    this.layout();
  }

  heightKm(s, agl) {
    return ((s.elev + agl) / 1000) * this.exaggeration;
  }

  layout() {
    if (!this.mesh) return;
    const r = this.discRadius || 4;
    const m = this._m;
    this.discs.forEach((d, i) => {
      const { east, north, up } = enu(d.s.lon, d.s.lat);
      const p = lonLatToVec3(d.s.lon, d.s.lat, EARTH_RADIUS + this.heightKm(d.s, d.agl) + 0.02);
      m.makeBasis(east.multiplyScalar(r), north.multiplyScalar(r), up);
      m.setPosition(p);
      this.mesh.setMatrixAt(i, m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    const pos = [];
    for (const s of this.stations) {
      if (!s.layers.length) continue;
      const top = s.layers[s.layers.length - 1][1];
      const a = lonLatToVec3(s.lon, s.lat, EARTH_RADIUS + this.heightKm(s, 0));
      const b = lonLatToVec3(s.lon, s.lat, EARTH_RADIUS + this.heightKm(s, top));
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    this.stems.geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  }

  update(camera, enabled) {
    const alt = camera.position.length() - EARTH_RADIUS;
    this.visible = enabled && !!this.mesh && alt < MAX_VISIBLE_ALT;
    if (!this.visible) return;
    // Keep discs a readable size on screen as you zoom.
    const r = Math.min(60, Math.max(1.5, alt * 0.03));
    if (Math.abs(r - this.discRadius) / Math.max(r, 1e-3) > 0.15) {
      this.discRadius = r;
      this.layout();
    }
  }

  /** Nearest station to a screen point (px), or null. */
  pick(camera, dom, x, y, maxPx = 14) {
    if (!this.visible) return null;
    const rect = dom.getBoundingClientRect();
    const cam = camera.position;
    let best = null;
    let bestD = maxPx * maxPx;
    for (const s of this.stations) {
      const top = s.layers.length ? s.layers[0][1] : 0;
      const p = lonLatToVec3(s.lon, s.lat, EARTH_RADIUS + this.heightKm(s, top), this._v);
      // Skip stations on the far side of the globe.
      if (p.dot(cam) < EARTH_RADIUS * EARTH_RADIUS * 0.98) continue;
      p.project(camera);
      if (p.z > 1) continue;
      const sx = rect.left + ((p.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - p.y) / 2) * rect.height;
      const d = (sx - x) ** 2 + (sy - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }
}
