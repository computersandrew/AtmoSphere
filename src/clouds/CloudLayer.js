import {
  ClampToEdgeWrapping,
  DataTexture,
  DoubleSide,
  FrontSide,
  Group,
  LinearFilter,
  Mesh,
  RGBAFormat,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector4,
} from 'three';
import { EARTH_RADIUS } from '../globe/geo.js';
import { GRID_H, GRID_W, MAX_TOP_KM } from './cloudData.js';
import { LEVELS_KM, SLABS } from './levels.js';

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position; // unit sphere
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const fragmentShader = /* glsl */ `
  #define PI 3.141592653589793
  uniform sampler2D uMap;       // satellite IR grid: R cover, G top height, B has-data
  uniform float uAlt;           // this shell's height, km
  uniform vec2 uSlab;           // km range this shell represents
  uniform float uMaxTop;
  uniform float uDensity;

  uniform float uHasModel;      // HRRR volume loaded?
  uniform sampler2D uModel;     // HRRR atlas (one tile per level)
  uniform sampler2D uModelMask; // 1 inside the HRRR domain
  uniform vec4 uBounds;         // lon0, lat0, lon1, lat1
  uniform vec2 uAtlas;          // cols, rows
  uniform vec2 uTile;           // this level's col, row
  uniform vec2 uGridSize;       // nx, ny
  uniform float uTrim;          // use satellite to remove high model clouds it can't see
  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    float lon = atan(-d.z, d.x);
    float latD = degrees(lat), lonD = degrees(lon);

    // ---- satellite infrared estimate (column from estimated base to IR top) ----
    vec4 c = texture2D(uMap, vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI));
    float cover = c.r * step(0.5, c.b);
    float top = c.g * uMaxTop;
    float base = max(top * 0.35 - 0.6, 0.0);
    float overlap = max(0.0, min(uSlab.y, top) - max(uSlab.x, base));
    float colThick = max(top - base, 0.3);
    float aIR = cover < 0.03 ? 0.0 : 1.0 - pow(1.0 - min(cover * uDensity, 0.97), overlap / colThick);

    // ---- HRRR model volume (real layers, tops and bases) ----
    float w = 0.0;
    float aModel = 0.0;
    if (uHasModel > 0.5) {
      vec2 uv = vec2((lonD - uBounds.x) / (uBounds.z - uBounds.x), (uBounds.w - latD) / (uBounds.w - uBounds.y));
      if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
        w = texture2D(uModelMask, uv).r;
        vec2 inTile = clamp(uv, 0.5 / uGridSize, 1.0 - 0.5 / uGridSize);
        float f = texture2D(uModel, (uTile + inTile) / uAtlas).r;
        // The satellite sees the highest cloud top. Where it reports warm, clear-looking
        // sky, high model cloud is probably wrong (thin cirrus can be missed, so only damp it).
        if (uTrim > 0.5 && c.b > 0.5 && c.r < 0.05 && uAlt > 5.0) f *= 0.35;
        float thick = uSlab.y - uSlab.x;
        aModel = 1.0 - pow(1.0 - min(f * uDensity, 0.97), thick); // optical depth ∝ thickness (per km)
      }
    }

    float a = mix(aIR, aModel, w);
    if (a < 0.004) discard;

    float hIR = clamp((uAlt - base) / max(top - base, 0.5), 0.0, 1.0);
    vec3 colIR = mix(vec3(0.62, 0.66, 0.72), vec3(1.0), hIR);
    vec3 colModel = mix(vec3(0.66, 0.70, 0.76), vec3(1.0), smoothstep(0.0, 7.0, uAlt));
    gl_FragColor = vec4(mix(colIR, colModel, w), a);
    #include <colorspace_fragment>
  }`;

const blank = () => {
  const t = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
  t.needsUpdate = true;
  return t;
};

/**
 * Clouds as transparent spherical shells at fixed heights (see levels.js).
 * Over the US each shell shows the HRRR cloud field at its height (METAR-corrected
 * by the pipeline); elsewhere it shows a column estimated from satellite infrared.
 */
export class CloudLayer extends Group {
  constructor() {
    super();
    this.exaggeration = 20;
    this.density = 0.9;
    this.grid = null;

    const data = new Uint8Array(GRID_W * GRID_H * 4);
    this.texture = new DataTexture(data, GRID_W, GRID_H, RGBAFormat);
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false; // avoids a seam at the antimeridian
    this.texture.wrapS = RepeatWrapping;
    this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.needsUpdate = true;

    this.shared = {
      uMap: { value: this.texture },
      uMaxTop: { value: MAX_TOP_KM },
      uDensity: { value: this.density },
      uHasModel: { value: 0 },
      uModel: { value: blank() },
      uModelMask: { value: blank() },
      uBounds: { value: new Vector4() },
      uAtlas: { value: new Vector2(1, 1) },
      uGridSize: { value: new Vector2(1, 1) },
      uTrim: { value: 1 },
    };

    const geometry = new SphereGeometry(1, 192, 96);
    this.shells = LEVELS_KM.map((alt, i) => {
      const material = new ShaderMaterial({
        uniforms: {
          ...this.shared,
          uAlt: { value: alt },
          uSlab: { value: new Vector2(...SLABS[i]) },
          uTile: { value: new Vector2() },
        },
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        side: FrontSide,
      });
      const mesh = new Mesh(geometry, material);
      mesh.frustumCulled = false;
      this.add(mesh);
      return mesh;
    });
    this.visible = false;
  }

  setGrid(grid) {
    this.grid = grid;
    this.texture.image.data.set(grid.rgba);
    this.texture.needsUpdate = true;
  }

  /** @param model {{manifest, texture, mask}} | null */
  setModel(model) {
    const u = this.shared;
    if (!model) {
      u.uHasModel.value = 0;
      return;
    }
    const { grid, atlas, levelsKm } = model.manifest;
    u.uModel.value = model.texture;
    u.uModelMask.value = model.mask;
    u.uBounds.value.set(grid.lon0, grid.lat0, grid.lon1, grid.lat1);
    u.uAtlas.value.set(atlas.cols, atlas.rows);
    u.uGridSize.value.set(grid.nx, grid.ny);
    // Map each shell to the nearest level in the file.
    this.shells.forEach((s, i) => {
      let k = 0;
      levelsKm.forEach((h, j) => {
        if (Math.abs(h - LEVELS_KM[i]) < Math.abs(levelsKm[k] - LEVELS_KM[i])) k = j;
      });
      s.material.uniforms.uTile.value.set(k % atlas.cols, Math.floor(k / atlas.cols));
    });
    u.uHasModel.value = 1;
  }

  setModelTexture(texture) {
    this.shared.uModel.value = texture;
  }

  setTrim(on) {
    this.shared.uTrim.value = on ? 1 : 0;
  }

  setExaggeration(x) {
    this.exaggeration = x;
  }

  setDensity(d) {
    this.density = d;
    this.shared.uDensity.value = d;
  }

  update(camera) {
    if (!this.visible) return;
    const camAlt = camera.position.length() - EARTH_RADIUS;
    for (const s of this.shells) {
      const h = s.material.uniforms.uAlt.value;
      const alt = h * this.exaggeration;
      s.scale.setScalar(EARTH_RADIUS + alt);
      // When the camera is between shells, draw the ones above it last.
      const above = alt > camAlt;
      s.renderOrder = above ? 400 - h : 200 + h;
      // From outside a shell only its near face can be seen; skipping back faces halves the fill cost.
      s.material.side = above ? DoubleSide : FrontSide;
    }
  }
}
