import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  Points,
  PointsMaterial,
  ShaderMaterial,
  SphereGeometry,
  Color,
} from 'three';
import { EARTH_RADIUS } from './geo.js';

export const ATMOSPHERE_RADIUS = EARTH_RADIUS * 1.025;

/** Thin limb glow: a back-faced shell, brightest where the line of sight grazes Earth. */
export function createAtmosphere() {
  const material = new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(0x5aa9ff) },
      uFade: { value: 1 },
      uEdge: { value: Math.sqrt(1 - (EARTH_RADIUS / ATMOSPHERE_RADIUS) ** 2) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uFade;
      uniform float uEdge;
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec3 dir = normalize(vWorld - cameraPosition);
        float d = clamp(dot(normalize(vNormal), dir) / uEdge, 0.0, 1.0);
        float glow = pow(d, 2.2);
        gl_FragColor = vec4(uColor * glow * 1.35 * uFade, 1.0);
      }`,
    side: BackSide,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new Mesh(new SphereGeometry(ATMOSPHERE_RADIUS, 96, 48), material);
  mesh.renderOrder = 1000;
  return mesh;
}

/** Deterministic star field, rendered in its own scene at a fixed distance. */
export function createStars(count = 6000) {
  let seed = 1337;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    pos.set([s * Math.cos(t) * 1000, u * 1000, s * Math.sin(t) * 1000], i * 3);
    const b = 0.25 + Math.pow(rand(), 6) * 0.9;
    const warm = rand();
    col.set([b * (0.9 + warm * 0.1), b * 0.95, b * (1.05 - warm * 0.15)], i * 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  return new Points(g, new PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
}
