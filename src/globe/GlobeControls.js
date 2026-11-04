import { Vector2, Raycaster } from 'three';
import { EARTH_RADIUS, DEG, enu, lonLatToVec3, raySphere, vec3ToLonLat, wrapLon } from './geo.js';

const MIN_DIST = 0.15; // km from target
const MAX_DIST = 60000;
const MIN_CAM_ALT = 0.05; // km above the surface

/**
 * Map-style globe camera. State is a ground target (lat/lon), distance to it,
 * heading (0 = north up) and tilt (0 = looking straight down).
 *   left-drag  : grab & pan       wheel / pinch : zoom to cursor
 *   right-drag : rotate & tilt    double-click  : fly in
 */
export class GlobeControls {
  constructor(camera, dom) {
    // heading is in degrees, tilt in radians
    this.camera = camera;
    this.dom = dom;
    this.lat = 25;
    this.lon = -60;
    this.dist = 22000;
    this.heading = 0;
    this.tilt = 0;
    this.vel = { lat: 0, lon: 0 };
    this.anim = null;
    this.onChange = null;
    this._ray = new Raycaster();
    this._pointers = new Map();
    this._bind();
    this.apply();
  }

  // ---------- camera placement ----------
  maxTiltFor(dist) {
    // Allow tilting when close; flatten out as we pull back to a whole-globe view.
    const t = Math.min(1, Math.max(0, (dist - 800) / 7000));
    return (80 - 80 * t) * DEG;
  }

  apply() {
    this.lat = Math.max(-89, Math.min(89, this.lat));
    this.lon = wrapLon(this.lon);
    this.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, this.dist));
    this.tilt = Math.max(0, Math.min(this.maxTiltFor(this.dist), this.tilt));

    const { east, north, up } = enu(this.lon, this.lat);
    const target = lonLatToVec3(this.lon, this.lat);
    const h = this.heading * DEG;
    const fwdH = north.clone().multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h));

    let tilt = this.tilt;
    let pos;
    for (let i = 0; i < 20; i++) {
      const offset = up.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(fwdH, -Math.sin(tilt));
      pos = target.clone().addScaledVector(offset, this.dist);
      if (pos.length() - EARTH_RADIUS >= MIN_CAM_ALT || tilt <= 0) break;
      tilt = Math.max(0, tilt - 2 * DEG);
    }
    this.tilt = tilt;
    this.camera.position.copy(pos);
    this.camera.up.copy(up.clone().multiplyScalar(Math.sin(tilt)).addScaledVector(fwdH, Math.cos(tilt)));
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
    this.onChange?.();
  }

  /** Altitude of the camera above the ellipsoid-free sphere, km. */
  get altitude() {
    return this.camera.position.length() - EARTH_RADIUS;
  }

  // ---------- picking ----------
  pick(clientX, clientY) {
    const r = this.dom.getBoundingClientRect();
    const ndc = new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this._ray.setFromCamera(ndc, this.camera);
    const hit = raySphere(this._ray.ray.origin, this._ray.ray.direction);
    return hit ? vec3ToLonLat(hit) : null;
  }

  // ---------- animation ----------
  flyTo({ lat = this.lat, lon = this.lon, dist = this.dist, heading = this.heading, tilt = this.tilt }, ms = 1200) {
    const from = { lat: this.lat, lon: this.lon, dist: this.dist, heading: this.heading, tilt: this.tilt };
    const dLon = wrapLon(lon - from.lon);
    const dHead = ((((heading - from.heading) % 360) + 540) % 360) - 180;
    this.vel.lat = this.vel.lon = 0;
    this.anim = { from, to: { lat, lon: from.lon + dLon, dist, heading: from.heading + dHead, tilt }, t0: performance.now(), ms };
  }

  update() {
    if (this.anim) {
      const { from, to, t0, ms } = this.anim;
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.lat = from.lat + (to.lat - from.lat) * e;
      this.lon = from.lon + (to.lon - from.lon) * e;
      // Zoom in log space so it feels even.
      this.dist = Math.exp(Math.log(from.dist) + (Math.log(to.dist) - Math.log(from.dist)) * e);
      this.heading = from.heading + (to.heading - from.heading) * e;
      this.tilt = from.tilt + (to.tilt - from.tilt) * e;
      if (k >= 1) this.anim = null;
      this.apply();
      return;
    }
    if (this._pointers.size === 0 && (Math.abs(this.vel.lat) > 1e-7 || Math.abs(this.vel.lon) > 1e-7)) {
      this.lat += this.vel.lat;
      this.lon += this.vel.lon;
      this.vel.lat *= 0.92;
      this.vel.lon *= 0.92;
      this.apply();
    }
  }

  // ---------- input ----------
  _bind() {
    const el = this.dom;
    el.style.touchAction = 'none';
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', (e) => this._up(e));
    el.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    el.addEventListener('dblclick', (e) => {
      const p = this.pick(e.clientX, e.clientY);
      if (p) this.flyTo({ lat: p.lat, lon: p.lon, dist: this.dist * 0.3 }, 900);
    });
  }

  _down(e) {
    this.dom.setPointerCapture(e.pointerId);
    this.anim = null;
    this.vel.lat = this.vel.lon = 0;
    const rotate = e.button === 2 || e.button === 1 || e.ctrlKey || e.shiftKey;
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, rotate });
    if (this._pointers.size === 2) this._pinch = this._pinchDist();
  }

  _pinchDist() {
    const [a, b] = [...this._pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _move(e) {
    const p = this._pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;

    if (this._pointers.size === 2) {
      p.x = e.clientX;
      p.y = e.clientY;
      const d = this._pinchDist();
      if (this._pinch && d > 0) this._zoomAt(e.clientX, e.clientY, this._pinch / d);
      this._pinch = d;
      return;
    }

    if (p.rotate) {
      this.heading -= dx * 0.25;
      this.tilt -= dy * 0.25 * DEG; // drag up = tilt toward the horizon
      p.x = e.clientX;
      p.y = e.clientY;
      this.apply();
      return;
    }

    // Grab-pan: keep the ground point under the cursor fixed.
    const a = this.pick(p.x, p.y);
    const b = this.pick(e.clientX, e.clientY);
    let dLat, dLon;
    if (a && b) {
      dLat = a.lat - b.lat;
      dLon = wrapLon(a.lon - b.lon);
    } else {
      // Cursor is off the globe: fall back to screen-space panning.
      const kmPerPx = (this.dist * 2 * Math.tan((this.camera.fov * DEG) / 2)) / this.dom.clientHeight;
      const rad = Math.min(kmPerPx / EARTH_RADIUS, 0.01);
      dLat = (dy * rad) / DEG;
      dLon = (-dx * rad) / DEG / Math.max(0.2, Math.cos(this.lat * DEG));
    }
    this.lat += dLat;
    this.lon += dLon;
    const now = performance.now();
    const dt = Math.max(1, now - (p.t || now - 16));
    this.vel = { lat: (dLat * 16) / dt, lon: (dLon * 16) / dt };
    p.t = now;
    p.x = e.clientX;
    p.y = e.clientY;
    this.apply();
  }

  _up(e) {
    const p = this._pointers.get(e.pointerId);
    this._pointers.delete(e.pointerId);
    this._pinch = null;
    // Only keep inertia if the pointer was still moving at release.
    if (p && performance.now() - (p.t || 0) > 80) this.vel.lat = this.vel.lon = 0;
  }

  _wheel(e) {
    e.preventDefault();
    this.anim = null;
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    this._zoomAt(e.clientX, e.clientY, Math.exp(delta * 0.0015));
  }

  _zoomAt(x, y, factor) {
    const before = this.pick(x, y);
    this.dist *= factor;
    this.apply();
    const after = this.pick(x, y);
    if (before && after) {
      this.lat += before.lat - after.lat;
      this.lon += wrapLon(before.lon - after.lon);
      this.apply();
    }
  }
}

