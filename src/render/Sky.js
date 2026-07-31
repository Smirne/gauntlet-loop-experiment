// Procedural environment for MICRO GAUNTLET.
//
// The scene is a macro shot of a toy car on a real household surface, so the
// "sky" is really the far side of a room: a soft vertical wash, a window that is
// visibly the light source, a little defocused clutter on the horizon so the eye
// reads depth rather than a flat colour, distance haze, and dust motes catching
// the key.
//
// The direction -> radiance function lives here as a shared GLSL string because
// Lighting renders the exact same function into a cube target for IBL. One source
// of truth means the reflections in the car paint match the backdrop behind it.
//
// Dependency direction is one way: Lighting imports from Sky, never the reverse.
// Sky reads `ctx.lighting` at runtime, guarded, and falls back to DEFAULT_BACKDROP.

import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Backdrop parameters                                                        */
/* -------------------------------------------------------------------------- */

/** Warm indoor morning, used whenever nobody has told us otherwise. */
export const DEFAULT_BACKDROP = {
  zenith: 0x5d7ba8,
  horizon: 0xb9c2cd,
  ground: 0x39332c,
  ceiling: 0x9daabb,
  clutter: 0.55,
  clutterColor: 0x2b2b31,

  windowColor: 0xfff0d6,
  windowIntensity: 7.5,
  windowDir: [-0.62, 0.36, -0.70],
  windowSize: [0.30, 0.24],
  windowRound: 0.05,
  windowSoft: 0.035,
  windowFalloff: 2.6,
  mullion: 1.0,

  sunColor: 0xffe6c0,
  sunDir: [-0.62, 0.36, -0.70],
  sunDisc: 0.0,

  hazeColor: 0xc3ccd8,
  hazeStrength: 0.34,
  indoor: 1.0,
  mottle: 0.055,
  intensity: 1.0,

  fogColor: 0xd7ddea,

  dust: { density: 1.0, color: 0xffe9c8, size: 1.0, opacity: 0.5 },
  shafts: { strength: 0.5, width: 46, length: 620, count: 3, color: 0xffe3bb },
};

/* -------------------------------------------------------------------------- */
/* Shared environment shader                                                  */
/* -------------------------------------------------------------------------- */

/** Uniform block + `mgEnvColor(vec3)`. Included by the backdrop and the IBL scene. */
export const ENV_SHADER_PARS = /* glsl */ `
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uGround;
uniform vec3  uCeiling;
uniform vec3  uClutterColor;
uniform float uClutter;

uniform vec3  uWindowColor;
uniform vec3  uWindowDir;
uniform vec2  uWindowSize;
uniform float uWindowIntensity;
uniform float uWindowRound;
uniform float uWindowSoft;
uniform float uWindowFalloff;
uniform float uMullion;

uniform vec3  uSunColor;
uniform vec3  uSunToward;
uniform float uSunDisc;

uniform vec3  uHazeColor;
uniform float uHazeStrength;
uniform float uIndoor;
uniform float uMottle;
uniform float uIntensity;

// Low-frequency, band-free wall texture. Trig beats a hash here: the backdrop is
// smooth by design and a noise texture would only add sampling cost.
float mgMottle( vec3 d ) {
  float n  = sin( d.x * 6.7 + 1.7 ) * sin( d.y * 5.3 + 0.4 ) * sin( d.z * 7.9 + 2.9 );
  n += 0.55 * sin( d.x * 14.3 + 4.1 ) * sin( d.y * 12.7 + 1.3 ) * sin( d.z * 16.1 + 0.6 );
  n += 0.28 * sin( d.x * 27.1 + 2.2 ) * sin( d.z * 31.3 + 5.1 );
  return n * 0.45;
}

// Signed distance to a rounded box, used for the window pane and its wall wash.
float mgRoundBox( vec2 p, vec2 b, float r ) {
  vec2 q = abs( p ) - b + r;
  return length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - r;
}

float mgBlob( vec2 q, vec2 c, vec2 r, float soft ) {
  vec2 p = ( q - c ) / r;
  return 1.0 - smoothstep( 1.0 - soft, 1.0 + soft, length( p ) );
}

// Heavily defocused silhouettes on the horizon. Without these the backdrop reads
// as a gradient card; with them it reads as the far side of a room.
float mgClutter( vec3 d ) {
  vec2 q = vec2( atan( d.z, d.x ), d.y * 2.2 );
  float m = 0.0;
  m += mgBlob( q, vec2(  2.05,  0.34 ), vec2( 0.42, 0.62 ), 0.85 ) * 0.9;  // tall unit
  m += mgBlob( q, vec2( -1.18, -0.16 ), vec2( 0.85, 0.30 ), 0.95 ) * 0.7;  // counter run
  m += mgBlob( q, vec2(  0.34,  0.02 ), vec2( 0.34, 0.26 ), 1.00 ) * 0.55; // mid object
  m += mgBlob( q, vec2( -2.62,  0.20 ), vec2( 0.30, 0.44 ), 0.95 ) * 0.5;
  return clamp( m, 0.0, 1.0 );
}

vec3 mgEnvColor( vec3 dir ) {
  vec3 d = normalize( dir );
  float h = d.y;

  // Vertical wash: floor -> horizon -> upper wall -> ceiling.
  vec3 col = mix( uGround, uHorizon, smoothstep( -0.40, -0.01, h ) );
  col = mix( col, uZenith, smoothstep( 0.02, 0.66, h ) );
  col = mix( col, uCeiling, uIndoor * smoothstep( 0.52, 0.95, h ) );

  col *= 1.0 + mgMottle( d * 2.0 ) * uMottle;

  // Defocused furniture, only around the horizon band.
  float cl = mgClutter( d ) * uClutter * ( 1.0 - smoothstep( 0.10, 0.52, abs( h - 0.06 ) ) );
  col = mix( col, uClutterColor * ( 0.7 + 0.6 * uIntensity ), cl * 0.75 );

  // --- window -------------------------------------------------------------
  vec3 wf = normalize( uWindowDir );
  vec3 wr = normalize( cross( wf, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 1e-4, 0.0, 0.0 ) );
  vec3 wu = normalize( cross( wr, wf ) );
  float z = dot( d, wf );

  if ( z > 0.05 && uWindowIntensity > 0.0 ) {
    vec2 q = vec2( dot( d, wr ), dot( d, wu ) ) / z;
    float sd = mgRoundBox( q, uWindowSize, uWindowRound );

    float pane = 1.0 - smoothstep( 0.0, max( uWindowSoft, 1e-4 ), sd );

    // Frame + glazing bars. Not black: a real frame still bounces light.
    float barW = 0.018;
    float bars = min(
      smoothstep( 0.0, barW, abs( q.x ) ),
      smoothstep( 0.0, barW * 1.15, abs( q.y ) )
    );
    bars = mix( 1.0, bars, uMullion );
    pane *= mix( 0.16, 1.0, bars );

    // Halo and the wash the window throws across the surrounding wall. This is
    // the "visible falloff" that tells the eye where the key light comes from.
    float glow = exp( -max( sd, 0.0 ) * uWindowFalloff );
    float wash = exp( -max( sd, 0.0 ) * ( uWindowFalloff * 0.34 ) );

    col += uWindowColor * uWindowIntensity * pane;
    col += uWindowColor * uWindowIntensity * glow * 0.16;
    col += uWindowColor * uWindowIntensity * wash * 0.045 * uIndoor;
  }

  // --- sun disc (outdoor presets) ----------------------------------------
  if ( uSunDisc > 0.0 ) {
    float sd2 = max( dot( d, normalize( uSunToward ) ), 0.0 );
    float disc = smoothstep( 0.99940, 0.99975, sd2 );
    float halo = pow( sd2, 900.0 ) * 0.9 + pow( sd2, 40.0 ) * 0.10 + pow( sd2, 6.0 ) * 0.025;
    col += uSunColor * uSunDisc * ( disc * 26.0 + halo );
  }

  // --- distance haze ------------------------------------------------------
  col = mix( col, uHazeColor, uHazeStrength * ( 1.0 - smoothstep( 0.0, 0.46, abs( h + 0.02 ) ) ) );

  return max( col * uIntensity, vec3( 0.0 ) );
}
`;

const ENV_VERT = /* glsl */ `
varying vec3 vEnvDir;
void main() {
  // The shell is centred on its own origin, so the local position *is* the
  // direction, for both the camera-locked backdrop and the origin-centred IBL
  // capture scene.
  vEnvDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const ENV_FRAG = /* glsl */ `
varying vec3 vEnvDir;
${ENV_SHADER_PARS}

#ifdef MG_BACKDROP
uniform float uDither;
float mgHash21( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
#endif

void main() {
  vec3 col = mgEnvColor( vEnvDir );

  #ifdef MG_BACKDROP
    // A touch of ordered noise keeps the very smooth wall gradient from banding
    // once the grade stretches it.
    col += ( mgHash21( gl_FragCoord.xy ) - 0.5 ) * uDither;
  #endif

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* -------------------------------------------------------------------------- */
/* Uniform plumbing                                                           */
/* -------------------------------------------------------------------------- */

function col(hexOrColor) {
  return hexOrColor instanceof THREE.Color ? hexOrColor.clone() : new THREE.Color(hexOrColor);
}

function v3(a, fallback) {
  const s = Array.isArray(a) ? a : fallback;
  return new THREE.Vector3(s[0], s[1], s[2]);
}

/**
 * Fill in defaults once and tag the result, so the per-frame blend path can skip
 * re-merging (and re-allocating) every call.
 */
export function mergeBackdrop(params) {
  if (params && params.__mgMerged) return params;
  const p = Object.assign({}, DEFAULT_BACKDROP, params || {});
  p.dust = Object.assign({}, DEFAULT_BACKDROP.dust, (params && params.dust) || {});
  p.shafts = Object.assign({}, DEFAULT_BACKDROP.shafts, (params && params.shafts) || {});
  Object.defineProperty(p, '__mgMerged', { value: true, enumerable: false });
  return p;
}

/** Build a fresh uniform set for the environment shader. */
export function makeEnvUniforms(params) {
  const p = mergeBackdrop(params);
  return {
    uZenith: { value: col(p.zenith) },
    uHorizon: { value: col(p.horizon) },
    uGround: { value: col(p.ground) },
    uCeiling: { value: col(p.ceiling) },
    uClutterColor: { value: col(p.clutterColor) },
    uClutter: { value: p.clutter },

    uWindowColor: { value: col(p.windowColor) },
    uWindowDir: { value: v3(p.windowDir, DEFAULT_BACKDROP.windowDir).normalize() },
    uWindowSize: { value: new THREE.Vector2(p.windowSize[0], p.windowSize[1]) },
    uWindowIntensity: { value: p.windowIntensity },
    uWindowRound: { value: p.windowRound },
    uWindowSoft: { value: p.windowSoft },
    uWindowFalloff: { value: p.windowFalloff },
    uMullion: { value: p.mullion },

    uSunColor: { value: col(p.sunColor) },
    uSunToward: { value: v3(p.sunDir, DEFAULT_BACKDROP.sunDir).normalize() },
    uSunDisc: { value: p.sunDisc },

    uHazeColor: { value: col(p.hazeColor) },
    uHazeStrength: { value: p.hazeStrength },
    uIndoor: { value: p.indoor },
    uMottle: { value: p.mottle },
    uIntensity: { value: p.intensity },

    uDither: { value: 0.0035 },
  };
}

const _tmpColor = new THREE.Color();
const _tmpVec = new THREE.Vector3();
const _tmpVec2 = new THREE.Vector2();

/**
 * Write params into an existing uniform set, optionally blended.
 * @param {object} u uniforms from makeEnvUniforms
 * @param {object} params partial backdrop description
 * @param {number} [t=1] 0 keeps the current value, 1 snaps to params
 */
export function setEnvUniforms(u, params, t = 1) {
  const p = mergeBackdrop(params);
  const lerpC = (name, value) => {
    _tmpColor.set(value);
    u[name].value.lerp(_tmpColor, t);
  };
  const lerpN = (name, value) => {
    u[name].value += (value - u[name].value) * t;
  };
  const lerpV = (name, value, fallback) => {
    const s = Array.isArray(value) ? value : fallback;
    _tmpVec.set(s[0], s[1], s[2]).normalize();
    u[name].value.lerp(_tmpVec, t).normalize();
  };

  lerpC('uZenith', p.zenith);
  lerpC('uHorizon', p.horizon);
  lerpC('uGround', p.ground);
  lerpC('uCeiling', p.ceiling);
  lerpC('uClutterColor', p.clutterColor);
  lerpN('uClutter', p.clutter);

  lerpC('uWindowColor', p.windowColor);
  lerpV('uWindowDir', p.windowDir, DEFAULT_BACKDROP.windowDir);
  u.uWindowSize.value.lerp(_tmpVec2.set(p.windowSize[0], p.windowSize[1]), t);
  lerpN('uWindowIntensity', p.windowIntensity);
  lerpN('uWindowRound', p.windowRound);
  lerpN('uWindowSoft', p.windowSoft);
  lerpN('uWindowFalloff', p.windowFalloff);
  lerpN('uMullion', p.mullion);

  lerpC('uSunColor', p.sunColor);
  lerpV('uSunToward', p.sunDir, DEFAULT_BACKDROP.sunDir);
  lerpN('uSunDisc', p.sunDisc);

  lerpC('uHazeColor', p.hazeColor);
  lerpN('uHazeStrength', p.hazeStrength);
  lerpN('uIndoor', p.indoor);
  lerpN('uMottle', p.mottle);
  lerpN('uIntensity', p.intensity);
  return u;
}

/**
 * A minimal scene containing only the environment shell, centred on the origin.
 * Lighting feeds this to PMREMGenerator.fromScene to build the IBL — no HDR files,
 * and the reflections match the visible backdrop exactly.
 *
 * @returns {{scene: THREE.Scene, uniforms: object, mesh: THREE.Mesh, dispose: Function}}
 */
export function makeEnvScene(params) {
  const scene = new THREE.Scene();
  const uniforms = makeEnvUniforms(params);
  const material = new THREE.ShaderMaterial({
    name: 'MG.EnvCapture',
    uniforms,
    vertexShader: ENV_VERT,
    fragmentShader: ENV_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    fog: false,
  });
  const geometry = new THREE.SphereGeometry(50, 48, 32);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  return {
    scene,
    uniforms,
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Dust motes                                                                 */
/* -------------------------------------------------------------------------- */

const DUST_VERT = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform vec3  uSunTravel;   // direction the key light travels
uniform vec3  uBox;         // half extents of the wrapping volume
uniform float uOpacity;

attribute vec3  aSeed;
attribute float aScale;

varying float vAlpha;
varying float vSpark;

void main() {
  vec3 p = position;
  float t = uTime;

  // Slow convection plus a lazy rise; every mote has its own phase so the field
  // never pulses as a whole.
  p.x += sin( t * ( 0.10 + aSeed.x * 0.15 ) + aSeed.y * 6.2831 ) * ( 2.0 + aSeed.z * 4.5 );
  p.y += t * ( 0.42 + aSeed.y * 0.85 ) + sin( t * 0.23 + aSeed.x * 6.2831 ) * 1.6;
  p.z += cos( t * ( 0.08 + aSeed.z * 0.13 ) + aSeed.x * 6.2831 ) * ( 2.0 + aSeed.y * 4.5 );

  // Wrap inside the box so density stays uniform forever.
  p = mod( p + uBox, 2.0 * uBox ) - uBox;

  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;

  float dist = max( -mv.z, 1.0 );
  gl_PointSize = clamp( uSize * aScale * ( 240.0 / dist ), 0.7, 24.0 );

  vec3 world = ( modelMatrix * vec4( p, 1.0 ) ).xyz;
  vec3 view = normalize( world - cameraPosition );
  // Motes only really light up when we look into the beam: forward scattering.
  float fs = pow( clamp( dot( view, uSunTravel ), 0.0, 1.0 ), 5.0 );
  vSpark = 0.14 + fs * 1.35;

  vAlpha = uOpacity
    * smoothstep( 5.0, 26.0, dist )
    * ( 1.0 - smoothstep( 230.0, 460.0, dist ) );
}
`;

const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
varying float vSpark;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot( d, d );
  if ( r2 > 0.25 ) discard;

  // Written as 1 - smoothstep rather than a descending smoothstep: GLSL leaves
  // smoothstep undefined when edge0 >= edge1.
  float core = 1.0 - smoothstep( 0.0, 0.25, r2 );
  // A faint rim keeps defocused motes reading as little discs rather than dots.
  float rim = smoothstep( 0.16, 0.25, r2 ) * ( 1.0 - smoothstep( 0.21, 0.25, r2 ) ) * 1.6;
  float a = core * core * vAlpha;

  // Premultiplied: the renderer is created with premultipliedAlpha, so additive
  // blending resolves to blendFunc(ONE, ONE) and ignores gl_FragColor.a.
  gl_FragColor = vec4( uColor * vSpark * ( 1.0 + rim ) * a, a );
}
`;

/* -------------------------------------------------------------------------- */
/* Light shafts                                                               */
/* -------------------------------------------------------------------------- */

const SHAFT_VERT = /* glsl */ `
varying vec3 vLocal;
void main() {
  vLocal = position * 2.0;   // BoxGeometry(1,1,1) -> -1..1
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const SHAFT_FRAG = /* glsl */ `
uniform vec3  uColor;
uniform float uStrength;
uniform float uTime;
varying vec3  vLocal;

void main() {
  vec3 l = vLocal;
  // Soft on all six faces so the slab never shows a silhouette edge, no matter
  // where the camera sits relative to it.
  float section = ( 1.0 - smoothstep( 0.12, 1.0, abs( l.x ) ) )
                * ( 1.0 - smoothstep( 0.12, 1.0, abs( l.y ) ) );
  float along = 1.0 - smoothstep( 0.45, 1.0, abs( l.z ) );
  float n = 0.72 + 0.28 * sin( l.z * 2.7 + uTime * 0.31 ) * sin( l.x * 4.9 - uTime * 0.19 );
  float a = section * along * n * uStrength;
  gl_FragColor = vec4( uColor * a, 1.0 );
}
`;

/* -------------------------------------------------------------------------- */
/* Sky system                                                                 */
/* -------------------------------------------------------------------------- */

const DUST_TIERS = { low: 0, medium: 420, high: 900, ultra: 1600 };

const _anchor = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwdAlt = new THREE.Vector3(0, 0, 1);
const _look = new THREE.Matrix4();
const _zero = new THREE.Vector3();

export class Sky {
  name = 'sky';

  constructor(ctx = {}) {
    this.ctx = ctx;
    this.enabled = true;
    this.time = 0;

    this.root = new THREE.Group();
    this.root.name = 'MG.Sky';
    this.root.matrixAutoUpdate = true;

    this.backdrop = null;
    this.dust = null;
    this.shafts = null;

    this.params = mergeBackdrop(null);
    this._target = null;
    this._blend = 1;
    this._blendRate = 0;

    this.dustBox = new THREE.Vector3(150, 46, 150);
    this.dustCenterY = 42;
    this._dustCount = 0;
  }

  async init() {
    const ctx = this.ctx;
    const tier = (ctx.settings && ctx.settings.quality) || 'ultra';

    this._buildBackdrop();
    this._buildDust(DUST_TIERS[tier] != null ? DUST_TIERS[tier] : DUST_TIERS.ultra);
    this._buildShafts();

    if (ctx.scene) ctx.scene.add(this.root);

    // If Lighting already resolved a preset before us, adopt it immediately.
    const p = ctx.lighting && ctx.lighting.preset && ctx.lighting.preset.backdrop;
    if (p) this.setPreset(ctx.lighting.preset.id, p, { transition: 0 });

    ctx.bus?.on?.('lighting:preset', (e) => {
      if (e && e.backdrop) this.setPreset(e.name, e.backdrop, { transition: e.transition || 0 });
    });

    return this;
  }

  /* ---- construction ----------------------------------------------------- */

  _buildBackdrop() {
    const uniforms = makeEnvUniforms(this.params);
    const material = new THREE.ShaderMaterial({
      name: 'MG.Backdrop',
      defines: { MG_BACKDROP: '' },
      uniforms,
      vertexShader: ENV_VERT,
      fragmentShader: ENV_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    // Unit shell: `position` doubles as the sample direction, and the radius is
    // rescaled each frame to sit comfortably inside whatever far plane is in use.
    const geometry = new THREE.SphereGeometry(1, 48, 32);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.setScalar(1400);
    mesh.name = 'MG.Backdrop';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = true;
    mesh.renderOrder = -1000;

    this.backdrop = { mesh, material, geometry, uniforms };
    this.root.add(mesh);
  }

  _buildDust(count) {
    if (this.dust) {
      this.root.remove(this.dust.points);
      this.dust.geometry.dispose();
      this.dust.material.dispose();
      this.dust = null;
    }
    this._dustCount = count | 0;
    if (this._dustCount <= 0) return;

    const rng = this.ctx.rng && typeof this.ctx.rng.next === 'function' ? this.ctx.rng : null;
    // Deterministic fallback: a tiny xorshift so the mote field is identical run
    // to run even when no seeded rng was threaded through.
    let s = 0x9e3779b9;
    const rand = rng
      ? () => rng.next()
      : () => {
          s ^= s << 13;
          s ^= s >>> 17;
          s ^= s << 5;
          return ((s >>> 0) % 100000) / 100000;
        };

    const n = this._dustCount;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n * 3);
    const scale = new Float32Array(n);
    const b = this.dustBox;

    for (let i = 0; i < n; i++) {
      pos[i * 3 + 0] = (rand() * 2 - 1) * b.x;
      pos[i * 3 + 1] = (rand() * 2 - 1) * b.y;
      pos[i * 3 + 2] = (rand() * 2 - 1) * b.z;
      seed[i * 3 + 0] = rand();
      seed[i * 3 + 1] = rand();
      seed[i * 3 + 2] = rand();
      // Heavily skewed: a few big out-of-focus motes among many specks.
      const r = rand();
      scale[i] = 0.45 + r * r * r * 2.6;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), b.length() * 1.5);

    const material = new THREE.ShaderMaterial({
      name: 'MG.Dust',
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: 2.1 },
        uSunTravel: { value: new THREE.Vector3(0.4, -0.6, 0.7).normalize() },
        uBox: { value: b.clone() },
        uOpacity: { value: 0.5 },
        uColor: { value: new THREE.Color(0xffe9c8) },
      },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    const points = new THREE.Points(geometry, material);
    points.name = 'MG.Dust';
    points.frustumCulled = false;
    points.renderOrder = 900;
    points.position.set(0, this.dustCenterY, 0);

    this.dust = { points, geometry, material };
    this.root.add(points);
  }

  _buildShafts() {
    if (this.shafts) return;
    const group = new THREE.Group();
    group.name = 'MG.Shafts';
    group.visible = false;

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.ShaderMaterial({
      name: 'MG.Shaft',
      uniforms: {
        uColor: { value: new THREE.Color(0xffe3bb) },
        uStrength: { value: 0.0 },
        uTime: { value: 0 },
      },
      vertexShader: SHAFT_VERT,
      fragmentShader: SHAFT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    const slabs = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(geometry, material);
      m.frustumCulled = false;
      m.renderOrder = 880;
      slabs.push(m);
      group.add(m);
    }

    this.shafts = { group, geometry, material, slabs };
    this.root.add(group);
  }

  /* ---- public API -------------------------------------------------------- */

  /**
   * @param {string} name preset id, informational
   * @param {object} backdrop backdrop parameter block (see DEFAULT_BACKDROP)
   * @param {{transition?: number}} [opts] seconds to blend over
   */
  setPreset(name, backdrop, opts = {}) {
    this.presetName = name || this.presetName;
    const next = mergeBackdrop(backdrop);
    const transition = opts.transition || 0;

    if (transition <= 0) {
      this.params = next;
      this._target = null;
      this._blend = 1;
      this._blendRate = 0;
      if (this.backdrop) setEnvUniforms(this.backdrop.uniforms, next, 1);
      this._applyDust(next, 1);
      this._applyShafts(next, 1);
    } else {
      this._target = next;
      this._blend = 0;
      this._blendRate = 1 / transition;
    }
    return this;
  }

  setQuality(tier) {
    const count = DUST_TIERS[tier] != null ? DUST_TIERS[tier] : DUST_TIERS.ultra;
    if (count !== this._dustCount) {
      this._buildDust(count);
      this._applyDust(this.params, 1);
    }
    if (this.shafts) this.shafts.group.visible = tier !== 'low' && this.shafts.material.uniforms.uStrength.value > 0.001;
  }

  setDustDensity(scale) {
    if (!this.dust) return;
    const base = (this.params.dust && this.params.dust.opacity) || 0.5;
    this.dust.material.uniforms.uOpacity.value = base * Math.max(0, scale);
  }

  /* ---- per-frame --------------------------------------------------------- */

  update(dt, ctx = this.ctx) {
    if (!this.enabled) return;
    const d = Math.min(dt || 0, 0.05);
    this.time += d;

    if (this._target && this._blend < 1) {
      this._blend = Math.min(1, this._blend + this._blendRate * d);
      // Frame-rate independent approach toward the target uniform set.
      const k = 1 - Math.exp(-this._blendRate * d * 4.5);
      if (this.backdrop) setEnvUniforms(this.backdrop.uniforms, this._target, k);
      this._applyDust(this._target, k);
      this._applyShafts(this._target, k);
      if (this._blend >= 1) {
        this.params = this._target;
        this._target = null;
      }
    }

    const camera = ctx.camera;
    if (camera && this.backdrop) {
      // Lock the shell to the camera so it can never be entered or exited.
      this.backdrop.mesh.position.copy(camera.position);
      const r = Math.max(60, (camera.far || 4000) * 0.35);
      if (this.backdrop.mesh.scale.x !== r) this.backdrop.mesh.scale.setScalar(r);
    }

    if (this.dust) {
      this.dust.material.uniforms.uTime.value = this.time;

      // Follow the action, but only in whole wrap-periods, which is invisible
      // because the field is periodic. Anything finer would slide the motes.
      const focus = this._focusPoint(ctx, _anchor);
      const px = this.dustBox.x * 2;
      const pz = this.dustBox.z * 2;
      this.dust.points.position.set(
        Math.round(focus.x / px) * px,
        this.dustCenterY,
        Math.round(focus.z / pz) * pz
      );

      const sun = ctx.lighting && ctx.lighting.sunTravel;
      if (sun) this.dust.material.uniforms.uSunTravel.value.copy(sun);
    }

    if (this.shafts && this.shafts.group.visible) {
      this.shafts.material.uniforms.uTime.value = this.time;
      // t = 0 leaves every blended value alone but re-runs the placement, so the
      // shafts keep following the sun direction and the current track centre.
      this._applyShafts(this._target || this.params, 0);
    }
  }

  lateUpdate(dt, ctx = this.ctx) {
    // The director moves the camera in lateUpdate; re-lock the shell so the
    // backdrop never lags a frame behind a fast camera cut.
    const camera = ctx.camera;
    if (camera && this.backdrop) this.backdrop.mesh.position.copy(camera.position);
  }

  onResize() {}

  dispose() {
    if (this.backdrop) {
      this.backdrop.geometry.dispose();
      this.backdrop.material.dispose();
    }
    if (this.dust) {
      this.dust.geometry.dispose();
      this.dust.material.dispose();
    }
    if (this.shafts) {
      this.shafts.geometry.dispose();
      this.shafts.material.dispose();
    }
    this.root.parent?.remove(this.root);
    this.backdrop = this.dust = this.shafts = null;
  }

  /* ---- internals --------------------------------------------------------- */

  _focusPoint(ctx, out) {
    const p = (ctx.player && ctx.player.position) || (ctx.vehicles && ctx.vehicles[0] && ctx.vehicles[0].position);
    if (p) return out.copy(p);
    const b = ctx.track && ctx.track.bounds;
    if (b && b.getCenter) return b.getCenter(out);
    if (ctx.camera) {
      ctx.camera.getWorldDirection(_fwd);
      return out.copy(ctx.camera.position).addScaledVector(_fwd, 120);
    }
    return out.set(0, 0, 0);
  }

  _applyDust(p, t) {
    if (!this.dust) return;
    const d = p.dust || DEFAULT_BACKDROP.dust;
    const u = this.dust.material.uniforms;
    u.uColor.value.lerp(_tmpColor.set(d.color), t);
    u.uOpacity.value += (d.opacity * (d.density != null ? d.density : 1) - u.uOpacity.value) * t;
    u.uSize.value += (2.1 * (d.size || 1) - u.uSize.value) * t;
  }

  _applyShafts(p, t) {
    if (!this.shafts) return;
    const s = p.shafts || DEFAULT_BACKDROP.shafts;
    const u = this.shafts.material.uniforms;
    u.uColor.value.lerp(_tmpColor.set(s.color || 0xffe3bb), t);
    u.uStrength.value += ((s.strength || 0) * 0.075 - u.uStrength.value) * t;

    const on = u.uStrength.value > 0.0015;
    this.shafts.group.visible = on;
    if (!on) return;

    // Orient the slabs along the key direction and hang them over the playfield.
    const travel = (this.ctx.lighting && this.ctx.lighting.sunTravel) || _fwd.set(0.4, -0.6, 0.7).normalize();
    const center = this.ctx.track && this.ctx.track.bounds && this.ctx.track.bounds.getCenter
      ? this.ctx.track.bounds.getCenter(_anchor)
      : _anchor.set(0, 0, 0);

    // Matrix4.lookAt puts +Z along (eye - target), so eye = travel makes the
    // slab's long axis point the way the light is going.
    _look.lookAt(travel, _zero, Math.abs(travel.y) > 0.995 ? _fwdAlt : _up);
    this.shafts.group.quaternion.setFromRotationMatrix(_look);
    this.shafts.group.position.set(center.x, center.y + 60, center.z);

    const w = s.width || 46;
    const len = s.length || 620;
    const count = Math.min(this.shafts.slabs.length, s.count || 3);
    for (let i = 0; i < this.shafts.slabs.length; i++) {
      const slab = this.shafts.slabs[i];
      slab.visible = i < count;
      if (!slab.visible) continue;
      const off = (i - (count - 1) * 0.5) * w * 1.7;
      slab.position.set(off, 0, 0);
      slab.scale.set(w, w * 1.6, len);
    }
  }
}

export default Sky;
