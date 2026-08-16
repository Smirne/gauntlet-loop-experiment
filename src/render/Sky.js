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
/* The room                                                                   */
/* -------------------------------------------------------------------------- */

// WHY THIS IS GEOMETRY AND NOT MORE PAINT (D12).
//
// The backdrop shell is locked to the camera, so every direction it paints is
// at the same apparent distance no matter where the camera stands. That is
// exactly right for the far side of a room seen over a tabletop, and exactly
// wrong for the two things D12 is actually about:
//
//  1. The establishing shot never sees the horizon. At ~350 u up, pitched 50
//     degrees down with a 38 degree lens, the TOP of frame is already 31
//     degrees BELOW horizontal; in the top corners it is 15 degrees below.
//     Every sightline in that frame is a downward one, so the only part of the
//     shell it can ever sample is the flat uGround band under h = -0.40. That
//     band is one colour with no depth in it, which is precisely the "dark
//     navy hole off the table edge" the reviewers kept reading as a bug. No
//     amount of painting fixes it, because the frame contains no horizon to
//     paint on.
//  2. A floor is at a *finite* distance that changes across the frame — a few
//     hundred units just past the table edge, a thousand at the far wall. A
//     camera-locked shell puts all of it at 1400 u. Geometry gets that for
//     free, plus real fog falloff, real defocus from the DOF pass, and real
//     occlusion by the table.
//
// So: a floor, four walls, and a handful of block silhouettes, all behind and
// below the playfield, all opaque, none of it castShadow or receiveShadow. The
// shell is still there and still owns the IBL; the walls hand back to it over
// their top edge so the geometry has no visible upper rim.
//
// SCALE. The playfield is ~460 x 340 u with 9 u cars, i.e. a "table" already
// about 3.3x the size of a real one relative to the toys on it. The room is
// built in that same exaggerated scale rather than in literal centimetres, so
// it stays self-consistent with the thing it surrounds: table height 75 cm ->
// 250 u, ceiling 2.5 m -> ~825 u, counter 90 cm -> 300 u. Building the room at
// literal cm around a 4.6 m tabletop would read as a table in a doll's house.
//
// MATERIAL, NOT TONE. The first pass built the room by multiplying the backdrop
// palette by a brightness — tone 0.46 for walls, 0.78 for the floor. That is why
// it read as an untextured card: the palette is a *lighting* description (what
// colour the far side of the room is glowing), so using it as paint gives a
// surface whose albedo changes with the time of day and whose hue is whatever
// the sky happens to be. It also puts the floor at luma 87-94 in morning, five
// points of saturation from neutral, next to a 0.54-saturation oak tabletop.
//
// Now the room has its own albedos — painted emulsion on the walls, a boarded
// oak floor — and the palette is read as the LEVEL and CAST of the light in the
// room: `lit = a + b * luminance(palette)`, tinted toward the palette's own hue.
// Morning lands within a couple of levels of where it was, which is deliberate
// (nobody complained about the level); goldenHour picks up its warmth; and
// nightLamp stops being 9/255, because a near-black palette now means a dimly
// lit room rather than a black-painted one.
const ROOM = Object.freeze({
  floorDrop: 250,      // tabletop -> floor, i.e. the table's height
  margin: 330,         // table edge -> wall: room to walk round it
  minHalf: 640,        // never closer than this, whatever the table does
  maxHalf: 1150,       // ... and never past the band Lighting's fog assumes
  wallRatio: 1.0,      // wall height as a fraction of the smaller half-extent
  wallMin: 560,
  wallMax: 1000,
  plank: [52, 420],    // floorboard width and stagger length

  // Emulsion in a pale grey-green. It was a warm off-white (0xcfc6b8), which is
  // a perfectly good kitchen wall and the wrong one for this frame: the critics
  // measured 85-88% of the image inside a single 40 degree amber band, and the
  // room is the only large surface that can carry a complementary anchor. This
  // colour is picked ISO-LUMINANT with the one it replaces — both land at 0.554
  // relative luminance once uRoomTint has bent them toward the preset's cast —
  // so the room's level is exactly where it was tuned and only its hue moved.
  // uRoomTint still pulls it halfway to the preset, so goldenHour warms it back
  // and it never fights the key.
  wallColor: 0xb4c8c8,
  floorColor: 0x93673d, // mid oak board
  tint: 0.50,          // how far each albedo bends toward the preset's own cast
  tone: 0.46,          // wall level against the backdrop palette
  floorTone: 1.0,
  propTone: 0.62,
  // Sheen strengths. See the sheen block in ROOM_FRAG for why these are larger
  // than they look: most of the lobe is a wide, weak ambient term, not a mirror.
  wallSheen: 0.10,
  floorGloss: 0.20,    // satin varnish: the window smears along the boards
  skirt: 105,          // skirting height. Below ~90 it dies at establishing distance.
  // Splashback band, floor-relative. Pinned to ROOM_PROPS: the counter runs are
  // 300 tall and the wall cupboards hang from 470, so the tiles fill exactly the
  // gap between them, which is also the strip of wall that survives being seen
  // over a 250 u tabletop.
  splash: [300, 470],
  // How much of `scene.fog` the room takes (D13). Lighting owns the fog and its
  // 0.0006 exp2 density is right for the playfield, but the room is the farthest
  // thing in any frame: at the 1200 u of the far wall the raw factor is 0.40, and
  // mixing 40% of a cool neutral (0x92979e) over every wall and board is most of
  // why the reviewers read the room as a colourless card. At 0.62 the far wall
  // still sits at a quarter fog, so aerial perspective survives and the material
  // comes back through it.
  fog: 0.62,

  amb: 0.58,           // shading floor, unlit faces
  key: 0.82,           // extra for a face turned to the window
  pool: 0.30,          // the window's own patch, as a fraction of surface albedo
  tableShade: 0.95,    // how much of the key the table blocks
  tableAO: 0.42,       // ambient the table steals from the floor directly under it
  bounce: 0.28,        // fraction of Lighting's warm bounce the room floor picks up
  bounceRange: 420,    // how far past the table edge that warmth reaches
  lampGain: 1.0,       // practical (nightLamp) spot, read live off Lighting
  lampSpill: 0.35,     // a shade leaks in every direction, not just down the cone
  propHeadroom: 0.95,  // tallest a room prop may stand, as a fraction of wall height
});

/** Themes that are not in a room. The shell keeps the sky for these. */
const OUTDOOR_THEMES = new Set(['garden', 'outdoor', 'yard', 'street']);

/**
 * Themes where the playfield IS the floor rather than a surface standing on it.
 * The room floor still has to exist — the track's own ground stops at its pad
 * and the walls are beyond that — but it drops by a hair instead of a table
 * height, enough to stay under the track's own ground relief without ever
 * reading as a step.
 */
const FLOOR_THEMES = new Map([['bedroom', 8]]);

/**
 * Themes that get the tiled splashback. Deliberately narrow: tiles between
 * worktop and wall-unit height read as a kitchen instantly, and read as a
 * mistake on a bedroom wall.
 */
const TILED_THEMES = new Set(['kitchen']);

/**
 * Blocks along the walls, in wall-anchored coordinates:
 *   wall  - which wall to stand against
 *   along - centre position as a fraction of that wall's half-length
 *   w/d/h - width along the wall, depth into the room, height
 *   base  - height of the underside above the floor (wall units hang)
 * Kept deliberately dumb and few: this is a silhouette, not a set.
 *
 * HEIGHTS ARE NOT ARBITRARY and must not be scaled to taste: the room is built
 * at the same stretched scale as the table (250 u = 75 cm, so 3.33 u per cm), so
 * a counter is 90 cm -> 300 u and a larder unit 192 cm -> 640 u. The complaint
 * that "only three of eight props clear the tabletop" is true, but the cure is not
 * to inflate a bin into a wardrobe — everything below 250 u is genuinely hidden
 * behind a 250 u table. The cure is more things that are legitimately tall, so
 * the silhouette above the tabletop has something in it: a fridge, an open
 * shelving stack and a door jamb are added here for exactly that.
 */
const ROOM_PROPS = Object.freeze([
  { wall: '-z', along: -0.30, w: 900, d: 200, h: 300, base: 0 },     // counter run
  { wall: '-x', along: -0.62, w: 520, d: 200, h: 300, base: 0 },     // its return
  { wall: '-z', along: 0.58, w: 300, d: 230, h: 640, base: 0 },      // tall larder unit
  { wall: '-z', along: -0.42, w: 560, d: 120, h: 260, base: 470 },   // wall cupboard
  { wall: '-x', along: -0.55, w: 380, d: 120, h: 260, base: 470 },   // wall cupboard
  { wall: '-x', along: 0.34, w: 300, d: 230, h: 610, base: 0 },      // fridge
  { wall: '+x', along: 0.18, w: 200, d: 190, h: 300, base: 0 },      // chair back
  { wall: '+x', along: -0.44, w: 260, d: 160, h: 700, base: 0 },     // open shelving
  { wall: '+z', along: -0.46, w: 170, d: 170, h: 260, base: 0 },     // bin
  { wall: '+z', along: 0.40, w: 160, d: 160, h: 250, base: 0 },      // stool
  { wall: '+z', along: 0.02, w: 120, d: 90, h: 760, base: 0 },       // door jamb
]);

const ROOM_VERT = /* glsl */ `
varying vec3 vRoomPos;
varying vec3 vRoomN;
varying vec3 vObjC;
#include <fog_pars_vertex>

void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vRoomPos = wp.xyz;
  // The mesh origin in world space. Constant across the object, so the fragment
  // stage can key a per-prop tint and box-local coordinates off it without
  // needing an attribute or a second material.
  vObjC = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  // Every room mesh is an axis-aligned plane or box under axis-aligned scale,
  // so the plain model rotation is enough here and no normal matrix is needed.
  vRoomN = normalize( mat3( modelMatrix ) * normal );
  vec4 mvPosition = viewMatrix * wp;
  #include <fog_vertex>
  gl_Position = projectionMatrix * mvPosition;
}
`;

const ROOM_FRAG = /* glsl */ `
${ENV_SHADER_PARS}

uniform vec3  uRoomCenter;   // x, floor level, z
uniform vec3  uRoomHalf;     // half X, wall height, half Z
uniform float uRoomTone;
uniform float uFloorTone;
uniform float uPropTone;
uniform float uRoomAmb;
uniform float uRoomKey;
uniform vec2  uPlank;

uniform vec3  uWinPos;
uniform vec3  uWinRight;
uniform vec3  uWinUp;
uniform vec3  uWinNormal;
uniform vec2  uWinHalf;
uniform float uWinPool;
uniform float uRoomWindow;

uniform vec3  uTableCenter;  // x, tabletop level, z
uniform vec2  uTableHalf;
uniform float uTableShade;
uniform float uTableAO;

uniform vec3  uWallColor;    // emulsion albedo
uniform vec3  uFloorColor;   // board albedo
uniform float uRoomTint;     // how far each albedo bends toward the preset cast
uniform float uWallSheen;
uniform float uFloorGloss;
uniform float uSkirt;
uniform vec3  uSplash;       // tile band: low edge, high edge, amount
uniform float uRoomFog;      // how much of scene.fog this room takes

uniform vec3  uBounceColor;  // warm light coming back off the tabletop
uniform float uBounceAmt;
uniform float uBounceRange;

uniform vec3  uLampPos;      // the practical, when a preset has one
uniform vec3  uLampAxis;
uniform vec3  uLampColor;
uniform vec2  uLampCos;      // cos(outer), cos(inner)
uniform float uLampPower;
uniform float uLampSpill;

varying vec3 vRoomPos;
varying vec3 vRoomN;
varying vec3 vObjC;

#include <fog_pars_fragment>

float mgBoardTone( float i ) {
  return fract( sin( i * 12.9898 + 4.1 ) * 43758.5453 ) - 0.5;
}

/**
 * Shadow of the tabletop, cast along an arbitrary direction L that points
 * TOWARD the light. The penumbra widens with how far the ray has to travel to
 * reach the slab, which is the difference between a table shadow and a decal of
 * one: 730 u below a tabletop the edge is 70 u soft, on the wall behind it more.
 */
float mgTableOcc( vec3 P, vec3 L ) {
  float occ = 0.0;
  if ( uTableHalf.x > 1.0 && L.y > 0.05 ) {
    float tt = ( uTableCenter.y - P.y ) / L.y;
    if ( tt > 0.0 ) {
      vec3 hp = P + L * tt;
      vec2 dd = abs( hp.xz - uTableCenter.xz ) - uTableHalf;
      float sd = length( max( dd, vec2( 0.0 ) ) ) + min( max( dd.x, dd.y ), 0.0 );
      float soft = clamp( tt * 0.10, 18.0, 260.0 );
      occ = 1.0 - smoothstep( -soft, soft, sd );
    }
  }
  return occ;
}

/** Signed distance from a point to the table footprint, in the XZ plane. */
float mgTableDist( vec3 P ) {
  vec2 dd = abs( P.xz - uTableCenter.xz ) - uTableHalf;
  return length( max( dd, vec2( 0.0 ) ) ) + min( max( dd.x, dd.y ), 0.0 );
}

/**
 * How lit this room is, from the luminance of the preset's own backdrop palette.
 * The palette is a description of light, not of paint, so it sets the level the
 * room's real albedos are seen at. Clamped low rather than to zero so a
 * near-black preset gives a dim room instead of a black hole.
 */
float mgRoomLit( float palLum, float a, float b ) {
  return clamp( a + b * palLum, 0.05, 1.15 );
}

void main() {
  vec3 N = normalize( vRoomN );
  vec3 P = vRoomPos;
  vec3 V = normalize( P - cameraPosition );

  float floorness = smoothstep( 0.55, 0.85, N.y );
  #ifdef MG_ROOM_PROP
    floorness = 0.0;
  #endif

  float h = P.y - uRoomCenter.y;                      // height above the floor
  float t = clamp( h / max( uRoomHalf.y, 1.0 ), 0.0, 1.0 );
  vec3 wdir = normalize( uWindowDir );                // toward the window

  // --- the light in the room, read off the same uniforms the shell paints
  // --- with, so the two can never disagree about what time of day it is.
  vec3 wallPal = mix( mix( uGround, uHorizon, 0.42 ),
                      mix( uHorizon, uCeiling, 0.55 ),
                      smoothstep( 0.0, 0.62, t ) );
  vec3 floorPal = mix( uGround, uHorizon, 0.22 );
  vec3 pal = mix( wallPal, floorPal, floorness );
  float palLum = max( dot( pal, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-5 );
  // Not named "cast": that is a reserved word in GLSL ES and the program will
  // not compile.
  vec3 palCast = mix( vec3( 1.0 ), pal / palLum, uRoomTint );

  // --- and the surfaces themselves, which are painted plaster and oak boards
  // --- whatever the light is doing.
  vec3 wallCol  = uWallColor * mgRoomLit( palLum, 0.06, 2.2 ) * uRoomTone;
  vec3 floorCol = uFloorColor * mgRoomLit( palLum, 0.10, 3.9 ) * uFloorTone;
  vec3 col = mix( wallCol, floorCol, floorness ) * palCast;

  #ifdef MG_ROOM_PROP
    col *= uPropTone;
    // Units are not all the same colour. One hash off the mesh origin spreads
    // them between warm timber and cool painted board.
    float pid = fract( sin( dot( vObjC.xz, vec2( 0.0173, 0.0311 ) ) ) * 43758.5453 );
    col *= mix( vec3( 1.08, 0.99, 0.86 ), vec3( 0.88, 0.92, 1.02 ), pid );
    // A worktop or a cupboard top is the one face that catches the room light.
    col *= 1.0 + 0.30 * smoothstep( 0.6, 0.95, N.y );
    {
      // Door and drawer seams. The sum of x and z varies along whichever
      // vertical face this is and stays constant across the other, so one
      // coordinate serves all four sides of the box.
      vec3 lp = P - vObjC;
      float sc = ( lp.x + lp.z ) / 150.0;
      float sv = lp.y / 150.0;
      float fs = fwidth( sc );
      float fv = fwidth( sv );
      float seam = smoothstep( 0.90, 1.0, abs( fract( sc ) - 0.5 ) * 2.0 )
                 * ( 1.0 - smoothstep( 0.08, 0.30, fs ) );
      float shelf = smoothstep( 0.93, 1.0, abs( fract( sv ) - 0.5 ) * 2.0 )
                  * ( 1.0 - smoothstep( 0.08, 0.30, fv ) )
                  * ( 1.0 - smoothstep( 0.6, 0.95, N.y ) );
      col *= 1.0 - 0.30 * max( seam, shelf );
    }
  #endif

  col *= 1.0 + mgMottle( P * 0.0045 ) * uMottle * 1.2;

  // --- floorboards. Faded out by screen-space derivative, so the pattern
  // --- dissolves before it can alias into a shimmer at distance.
  #ifndef MG_ROOM_PROP
  {
    // fwidth stays out of any branch: a derivative taken inside non-uniform
    // control flow is undefined, and this is cheap enough not to guard.
    vec2 g = ( P.xz - uRoomCenter.xz ) / max( uPlank, vec2( 1.0 ) );
    float fwx = fwidth( g.x );
    float fwy = fwidth( g.y );
    float sharp = 1.0 - smoothstep( 0.06, 0.30, fwx );
    float fine = 1.0 - smoothstep( 0.006, 0.030, fwx );
    // Boards are laid in a stagger, so the butt joints do not line up across
    // the floor. Staggering AFTER the derivatives keeps the board edge from
    // sampling a discontinuity and drawing a one-pixel line down the room.
    float gy = g.y + 0.37 * floor( g.x );
    float edge = abs( fract( g.x ) - 0.5 ) * 2.0;
    float groove = smoothstep( 0.86, 1.0, edge );
    float joint = smoothstep( 0.94, 1.0, abs( fract( gy ) - 0.5 ) * 2.0 )
                * ( 1.0 - smoothstep( 0.10, 0.40, fwy ) );
    float tone = mgBoardTone( floor( g.x ) + 7.0 * floor( gy ) );
    // Grain runs along the board, and only resolves close enough to see it.
    float grain = sin( g.x * 57.0 + tone * 13.0 + gy * 1.7 ) * 0.5 + 0.5;
    col *= 1.0 + ( tone * 0.16 - groove * 0.32 - joint * 0.26 ) * sharp * floorness;
    col *= 1.0 + ( grain * grain * 0.10 - 0.05 ) * fine * floorness;
  }
  #endif

  // Skirting. This is paint, so it belongs in the albedo and takes the room
  // light like any other part of the wall. The band was 36-46 u and vanished at
  // establishing distance; at ~105 u it survives, and the lip highlight plus the
  // shadow reveal above it are what turn a grey field into a room.
  #ifndef MG_ROOM_PROP
  {
    // Written as 1 - smoothstep, never as a descending one: GLSL leaves
    // smoothstep undefined when edge0 >= edge1.
    float sTop = max( uSkirt, 8.0 );
    float band = ( 1.0 - smoothstep( sTop * 0.88, sTop, h ) ) * smoothstep( 0.0, sTop * 0.10, h );
    float lip = smoothstep( sTop * 0.70, sTop * 0.90, h ) * ( 1.0 - smoothstep( sTop * 0.90, sTop, h ) );
    float reveal = smoothstep( sTop, sTop * 1.07, h ) * ( 1.0 - smoothstep( sTop * 1.07, sTop * 1.34, h ) );
    float toe = 1.0 - smoothstep( 0.0, sTop * 0.06, h );
    float k = ( 1.0 - floorness );
    col *= 1.0 + k * ( band * 0.20 + lip * 0.26 - reveal * 0.20 - toe * 0.34 );
    // Skirting is gloss white over an emulsion wall: desaturate it a little too.
    col = mix( col, vec3( dot( col, vec3( 0.2126, 0.7152, 0.0722 ) ) ) * 1.06, k * band * 0.28 );
  }
  #endif

  // Glazed tile is glossier than emulsion; the splashback below adds to this.
  float glossExtra = 0.0;

  // --- splashback. The two walls the counter runs stand against are tiled from
  // --- worktop height to the underside of the wall units, in a running bond of
  // --- 66 x 33 u metro tiles (20 x 10 cm at the room's 3.33 u per cm).
  // ---
  // --- This is the room's answer to "no material at any scale", and the band is
  // --- where it is because that is the strip of wall the frame can actually
  // --- see. Sightlines in the establishing shot descend at about 32 degrees, so
  // --- a ray grazing the front top edge of a 300 u counter meets the wall 200 u
  // --- behind it 125 u lower: everything on that wall below ~175 u is hidden by
  // --- the counter, and everything below ~44 u is hidden by the table rim. The
  // --- 300-470 band clears both, which the skirting never can.
  #ifndef MG_ROOM_PROP
  {
    // Derivatives stay out of every branch: taken in non-uniform control flow
    // they are undefined, and this is a handful of ALU either way.
    // One horizontal coordinate serves both tiled walls, because on each of them
    // exactly one of x and z is constant.
    float su = ( ( P.x - uRoomCenter.x ) + ( P.z - uRoomCenter.z ) ) / 66.0;
    float sv = h / 33.0;
    float crisp = 1.0 - smoothstep( 0.05, 0.26, fwidth( su ) );

    float lo = uSplash.x;
    float hi = max( uSplash.y, lo + 20.0 );
    // Inward normal is +Z on the -Z wall and +X on the -X wall, which are the
    // two ROOM_PROPS puts counter runs against. Everything else stays plain.
    float tiled = smoothstep( 0.70, 0.95, max( N.z, N.x ) );
    float band = smoothstep( lo, lo + 12.0, h ) * ( 1.0 - smoothstep( hi - 12.0, hi, h ) );
    float m = uSplash.z * tiled * band * ( 1.0 - floorness );

    // Running bond: every other course shifts half a tile. Staggering AFTER the
    // derivative keeps the course boundary from sampling a discontinuity and
    // drawing a one-pixel line across the wall.
    float row = floor( sv );
    float su2 = su + 0.5 * mod( row, 2.0 );
    float grout = max(
      smoothstep( 0.88, 1.0, abs( fract( su2 ) - 0.5 ) * 2.0 ),
      smoothstep( 0.84, 1.0, abs( fract( sv ) - 0.5 ) * 2.0 )
    );
    // Glazed ceramic is never one colour across a wall.
    float tid = mgBoardTone( floor( su2 ) * 3.0 + row * 11.0 );
    // Only the HIGH-frequency half takes the derivative fade. The band's own
    // value lift is low frequency and survives any distance, which is the same
    // reason the skirting works: a horizontal change of value across a wall
    // reads as a room long after the grout it came from has dissolved.
    col *= 1.0 + m * ( 0.20 + ( tid * 0.10 - grout * 0.42 ) * crisp );
    glossExtra += m * 0.22;
  }
  #endif

  vec3 albedo = col;

  // --- shading. One key, from the window, plus a flat ambient. A wall with the
  // --- window in it faces away from it and stays dark, which is correct and is
  // --- most of what makes the room read as lit rather than coloured in.
  float lam = max( dot( N, wdir ), 0.0 );

  // The table blocks the window. This is the one cast shadow in the room and it
  // is the reason the table reads as an object standing in it rather than a lit
  // card. It removes the key only: the room fill still reaches the floor.
  float tableOcc = uTableShade > 0.0 ? mgTableOcc( P, wdir ) : 0.0;
  float shade = uRoomAmb + uRoomKey * lam * ( 1.0 - tableOcc * uTableShade );

  // Corner occlusion, on both sides of the wall-floor join.
  float dWall = min( uRoomHalf.x - abs( P.x - uRoomCenter.x ),
                     uRoomHalf.z - abs( P.z - uRoomCenter.z ) );
  float cornerFloor = 1.0 - smoothstep( 0.0, 110.0, max( dWall, 0.0 ) );
  float cornerWall = 1.0 - smoothstep( 0.0, 80.0, max( h, 0.0 ) );
  shade *= 1.0 - 0.34 * mix( cornerWall, cornerFloor, floorness );

  // Ambient the table steals from the floor immediately beneath it. Separate
  // from the cast shadow above, which is displaced along the key direction and
  // lands somewhere else entirely.
  float sdTable = mgTableDist( P );
  if ( P.y < uTableCenter.y - 1.0 && uTableHalf.x > 1.0 ) {
    shade *= 1.0 - uTableAO * ( 1.0 - smoothstep( -60.0, 220.0, sdTable ) );
  }

  col = albedo * shade;

  // --- the light the window actually throws into the room: the window pane
  // --- projected along its own direction onto whatever this fragment is. Times
  // --- the albedo, so the boards keep reading through the patch instead of it
  // --- sitting on top of them as a flat additive rectangle.
  if ( uRoomWindow > 0.001 && lam > 0.0 && uWinHalf.x > 1.0 ) {
    float denom = min( dot( wdir, uWinNormal ), -1e-3 );
    float tw = dot( uWinPos - P, uWinNormal ) / denom;
    if ( tw > 0.0 ) {
      vec3 hitp = P + wdir * tw;
      vec2 q = vec2( dot( hitp - uWinPos, uWinRight ), dot( hitp - uWinPos, uWinUp ) );
      float sdp = mgRoundBox( q, uWinHalf * 0.92, uWinHalf.x * 0.20 );
      float soft = max( uWinHalf.x * 0.24, 8.0 );
      float pool = 1.0 - smoothstep( -soft, soft, sdp );
      pool *= 1.0 - tableOcc * uTableShade;
      col += albedo * uWindowColor * uWindowIntensity * uRoomWindow * uWinPool * pool * lam;
    }
  }

  // --- the practical. nightLamp's key is a spot over the table, not the
  // --- directional, and until now the room knew nothing about it, which is why
  // --- that preset came back at 9/255. Read live off Lighting, so a preset that
  // --- has no lamp costs one compare.
  if ( uLampPower > 0.0 ) {
    vec3 toL = uLampPos - P;
    float d2 = max( dot( toL, toL ), 1.0 );
    vec3 L = toL * inversesqrt( d2 );
    float ndl = max( dot( N, L ), 0.0 );
    if ( ndl > 0.0 ) {
      float cone = smoothstep( uLampCos.x, uLampCos.y, dot( -L, uLampAxis ) );
      float lampShade = 1.0 - mgTableOcc( P, L ) * uTableShade;
      col += albedo * uLampColor * ( uLampPower / d2 ) * ndl * ( cone + uLampSpill ) * lampShade;
    }
  }

  // --- warm bounce off the tabletop. It is oak in a raking key, so the floor
  // --- just past the table edge and the bottom of the nearest wall pick up its
  // --- colour; directly underneath gets none, because the slab is in the way.
  if ( uBounceAmt > 0.0 && uTableHalf.x > 1.0 ) {
    float bnc = exp( -max( sdTable, 0.0 ) / max( uBounceRange, 1.0 ) )
              * smoothstep( -120.0, 40.0, sdTable )
              * exp( -max( h, 0.0 ) / max( uBounceRange * 0.75, 1.0 ) );
    col += albedo * uBounceColor * uBounceAmt * bnc;
  }

  // --- the pane itself, drawn on the wall it is actually in. Not multiplied by
  // --- the albedo: this one is the source, not a surface catching it.
  #ifndef MG_ROOM_PROP
  if ( uRoomWindow > 0.001 && uWinHalf.x > 1.0 ) {
    vec3 rel = P - uWinPos;
    float onWall = max( dot( N, uWinNormal ), 0.0 ) * ( 1.0 - smoothstep( 1.0, 9.0, abs( dot( rel, uWinNormal ) ) ) );
    if ( onWall > 0.001 ) {
      vec2 q = vec2( dot( rel, uWinRight ), dot( rel, uWinUp ) );
      float sd = mgRoundBox( q, uWinHalf, uWinHalf.x * 0.06 );
      float soft = max( uWinHalf.x * 0.02, 1.5 );
      float pane = 1.0 - smoothstep( 0.0, soft, sd );
      float barW = max( uWinHalf.x * 0.035, 1.0 );
      float bars = min( smoothstep( 0.0, barW, abs( q.x ) ), smoothstep( 0.0, barW * 1.1, abs( q.y ) ) );
      bars = mix( 1.0, bars, uMullion );
      pane *= mix( 0.12, 1.0, bars );
      float wash = exp( -max( sd, 0.0 ) / max( uWinHalf.x * 0.75, 1.0 ) );
      col += uWindowColor * uWindowIntensity * uRoomWindow * onWall * ( pane + wash * 0.10 );
    }
  }
  #endif

  // --- grazing sheen. Emulsion paint and a varnished floor both have a real
  // --- Fresnel edge, and it is the single thing that separates a painted wall
  // --- from a flat card: at a shallow angle a wall picks up the room, and the
  // --- floor smears the window along the boards. The reflection is sampled from
  // --- the same environment function the shell paints with, clamped so the pane
  // --- cannot put a mirror-bright hole in a floorboard.
  // ---
  // --- The lobe is SPLIT, and that is the whole point. A Schlick pow-5 term on
  // --- its own is inert at the angles this game's cameras use: the establishing
  // --- shot meets the far wall about 25 degrees off its normal, where pow-5
  // --- evaluates to 8e-5 and 0.06 of it is nothing at all. So the wide, weak
  // --- part of the lobe — the part emulsion actually has, and the part that
  // --- makes a wall look painted rather than printed — is taken from pal, the
  // --- room's own light colour, which is already in hand and costs nothing. The
  // --- narrow mirror part still comes from the environment, but only where the
  // --- surface really is grazing, which keeps the expensive call rare.
  float gloss = mix( uWallSheen, uFloorGloss, floorness ) + glossExtra;
  float ndv = clamp( dot( N, -V ), 0.0, 1.0 );
  float fres = pow( 1.0 - ndv, 3.0 );
  col += pal * gloss * ( 0.22 + 0.60 * fres );
  // The gate is worth having: mgEnvColor is the most expensive thing in this
  // shader and the room can cover a third of the frame. A surface seen close to
  // head-on contributes under half a level and is skipped.
  if ( gloss * fres > 0.004 ) {
    vec3 env = min( mgEnvColor( reflect( V, N ) ), vec3( 2.5 ) );
    col += env * gloss * fres * 1.7;
  }

  // Same master the shell applies, applied at the same point in the chain, so
  // a preset that dims the backdrop dims the room with it.
  col = max( col * uIntensity, vec3( 0.0 ) );

  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    // Scaled by uRoomFog (D13). The room is the farthest geometry in every
    // frame, so it collects the most fog of anything on screen, and at the raw
    // density the far wall arrives 40% replaced by a flat cool neutral. The
    // scale keeps the aerial perspective and hands the material back.
    col = mix( col, fogColor, clamp( fogFactor * uRoomFog, 0.0, 1.0 ) );
  #endif

  // Hand back to the painted shell across the top of the wall. Done after fog
  // so the two agree exactly at the join and the geometry has no visible rim.
  //
  // Props are excluded. The handback exists to hide the upper rim of the wall
  // planes; a box standing in the room has no such rim, and dissolving the one
  // tall silhouette in the set into the backdrop was throwing away the only
  // prop that clears the tabletop by any margin.
  #ifndef MG_ROOM_PROP
  {
    float topT = ( 1.0 - floorness ) * smoothstep( 0.86, 1.0, t );
    if ( topT > 0.001 ) {
      col = mix( col, mgEnvColor( normalize( P - cameraPosition ) ), topT );
    }
  }
  #endif

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Uniforms for the room. Every entry the environment shader needs is the SAME
 * object the backdrop uses, not a copy, so a preset change written through
 * `setEnvUniforms` lands on the painted shell and the built room in one go and
 * they cannot drift apart.
 */
export function makeRoomUniforms(envUniforms) {
  const u = Object.assign({}, envUniforms);
  // three writes these itself every frame for any material with fog === true.
  u.fogColor = { value: new THREE.Color(0x92979e) };
  u.fogDensity = { value: 0.0006 };
  u.fogNear = { value: 1 };
  u.fogFar = { value: 2000 };

  u.uRoomCenter = { value: new THREE.Vector3(0, -ROOM.floorDrop, 0) };
  u.uRoomHalf = { value: new THREE.Vector3(ROOM.minHalf, ROOM.wallMin, ROOM.minHalf) };
  u.uRoomTone = { value: ROOM.tone };
  u.uFloorTone = { value: ROOM.floorTone };
  u.uPropTone = { value: ROOM.propTone };
  u.uRoomAmb = { value: ROOM.amb };
  u.uRoomKey = { value: ROOM.key };
  u.uPlank = { value: new THREE.Vector2(ROOM.plank[0], ROOM.plank[1]) };

  u.uWinPos = { value: new THREE.Vector3(0, 0, 0) };
  u.uWinRight = { value: new THREE.Vector3(1, 0, 0) };
  u.uWinUp = { value: new THREE.Vector3(0, 1, 0) };
  u.uWinNormal = { value: new THREE.Vector3(0, 0, 1) };
  u.uWinHalf = { value: new THREE.Vector2(0, 0) };
  u.uWinPool = { value: ROOM.pool };
  u.uRoomWindow = { value: 1 };

  u.uTableCenter = { value: new THREE.Vector3(0, 0, 0) };
  u.uTableHalf = { value: new THREE.Vector2(0, 0) };
  u.uTableShade = { value: ROOM.tableShade };
  u.uTableAO = { value: ROOM.tableAO };

  u.uWallColor = { value: new THREE.Color(ROOM.wallColor) };
  u.uFloorColor = { value: new THREE.Color(ROOM.floorColor) };
  u.uRoomTint = { value: ROOM.tint };
  u.uWallSheen = { value: ROOM.wallSheen };
  u.uFloorGloss = { value: ROOM.floorGloss };
  u.uSkirt = { value: ROOM.skirt };
  // z is the amount, and starts at zero: _fitRoom turns the tiles on only for
  // themes that should have them, so a room that never fits stays untiled.
  u.uSplash = { value: new THREE.Vector3(ROOM.splash[0], ROOM.splash[1], 0) };
  u.uRoomFog = { value: ROOM.fog };

  // Overwritten every frame from ctx.lighting.bounce when there is one; these
  // are the morning values so the room is never wrong before Lighting reports.
  u.uBounceColor = { value: new THREE.Color(0xffc79a) };
  u.uBounceAmt = { value: 0.46 * ROOM.bounce };
  u.uBounceRange = { value: ROOM.bounceRange };

  u.uLampPos = { value: new THREE.Vector3(0, 0, 0) };
  u.uLampAxis = { value: new THREE.Vector3(0, -1, 0) };
  u.uLampColor = { value: new THREE.Color(0xffc27a) };
  u.uLampCos = { value: new THREE.Vector2(0.5, 0.9) };
  u.uLampPower = { value: 0 };
  u.uLampSpill = { value: ROOM.lampSpill };
  return u;
}

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
const _lampPos = new THREE.Vector3();
const _lampAim = new THREE.Vector3();
const _lampDir = new THREE.Vector3(0, -1, 0);

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

    // The built room (D12). `floorDrop` null means "take it from the track, or
    // from ROOM.floorDrop"; set it to a number to pin the table height.
    this.room = null;
    this.roomEnabled = true;
    this.floorDrop = null;
    this._roomSig = null;

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
    // The track does not exist yet at this point; the room fits itself to it
    // from update() as soon as it does.
    this._buildRoom();

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

  /* ---- the room ---------------------------------------------------------- */

  /**
   * Floor, four walls, and the block silhouettes along them. One unit plane and
   * one unit box, scaled per mesh, so a refit is transform-only and never
   * touches a buffer. Nothing here casts or receives a shadow: the room sits
   * far outside the shadow cascade, where a sampled shadow map would clamp to a
   * hard edge, and the one shadow it needs — the table's — is analytic in the
   * fragment shader instead.
   */
  _buildRoom() {
    if (this.room) return;
    const env = this.backdrop ? this.backdrop.uniforms : makeEnvUniforms(this.params);
    const uniforms = makeRoomUniforms(env);

    const shared = {
      uniforms,
      vertexShader: ROOM_VERT,
      fragmentShader: ROOM_FRAG,
      side: THREE.FrontSide,
      depthWrite: true,
      depthTest: true,
      fog: true,
    };
    // Both materials point at the SAME uniforms object on purpose.
    const material = new THREE.ShaderMaterial(Object.assign({ name: 'MG.Room' }, shared));
    const propMaterial = new THREE.ShaderMaterial(
      Object.assign({ name: 'MG.RoomProp', defines: { MG_ROOM_PROP: '' } }, shared)
    );

    const plane = new THREE.PlaneGeometry(1, 1);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const group = new THREE.Group();
    group.name = 'MG.Room';

    const make = (geometry, mat, name) => {
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.name = name;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
      return mesh;
    };

    const floor = make(plane, material, 'MG.Room.floor');
    floor.rotation.x = -Math.PI / 2;

    // Order is fixed and referenced by _fitRoom: -Z, +Z, -X, +X. Each rotation
    // turns the plane's +Z normal to face into the room.
    const wallRot = [0, Math.PI, Math.PI * 0.5, -Math.PI * 0.5];
    const walls = [];
    for (let i = 0; i < 4; i++) {
      const w = make(plane, material, `MG.Room.wall${i}`);
      w.rotation.y = wallRot[i];
      walls.push(w);
    }

    const props = [];
    for (let i = 0; i < ROOM_PROPS.length; i++) {
      const p = make(box, propMaterial, `MG.Room.prop${i}`);
      p.userData.mgFits = false;
      p.visible = false;
      props.push(p);
    }

    group.visible = false;   // stays hidden until the first successful fit
    this.room = {
      group, material, propMaterial, plane, box, floor, walls, props, uniforms,
      dims: null,
      tmp: { dir: new THREE.Vector3(), right: new THREE.Vector3() },
    };
    this.root.add(group);
  }

  /**
   * Size the room around whatever track is loaded. Cheap enough to call every
   * frame: it early-outs on an unchanged signature, and the track does not
   * exist yet when Sky.init runs, so polling is how the room ever gets built.
   */
  _fitRoom(ctx = this.ctx) {
    const room = this.room;
    if (!room) return;

    const track = ctx && ctx.track;
    const def = (track && track.def) || null;
    const b = track && track.bounds;

    let cx = 0;
    let cz = 0;
    let tableHX = 260;
    let tableHZ = 260;
    let topY = 0;
    if (b && b.min && b.max && Number.isFinite(b.min.x) && b.max.x - b.min.x > 4) {
      cx = (b.min.x + b.max.x) * 0.5;
      cz = (b.min.z + b.max.z) * 0.5;
      // Same pad TrackBuilder.buildGround uses, so the walls track the real
      // extent of the table rather than a guess about it.
      const pad = def && Number.isFinite(def.groundPad) ? def.groundPad : 340;
      tableHX = (b.max.x - b.min.x) * 0.5 + pad;
      tableHZ = (b.max.z - b.min.z) * 0.5 + pad;
    }
    if (track && Number.isFinite(track.groundY)) topY = track.groundY;

    const theme = String((def && def.theme) || (track && track.id) || 'kitchen');
    const themeDrop = FLOOR_THEMES.has(theme) ? FLOOR_THEMES.get(theme) : ROOM.floorDrop;
    const drop = Number.isFinite(this.floorDrop)
      ? this.floorDrop
      : (def && Number.isFinite(def.tableHeight) ? def.tableHeight : themeDrop);

    const halfX = Math.min(ROOM.maxHalf, Math.max(ROOM.minHalf, tableHX + ROOM.margin));
    const halfZ = Math.min(ROOM.maxHalf, Math.max(ROOM.minHalf, tableHZ + ROOM.margin));
    const wallH = Math.min(
      ROOM.wallMax,
      Math.max(ROOM.wallMin, Math.min(halfX, halfZ) * ROOM.wallRatio)
    );
    const floorY = topY - drop;

    const visible = this.roomEnabled !== false && !OUTDOOR_THEMES.has(theme);

    const sig = `${theme}|${cx.toFixed(1)},${cz.toFixed(1)},${halfX.toFixed(1)},${halfZ.toFixed(1)},${floorY.toFixed(1)},${wallH.toFixed(1)},${visible}`;
    if (sig === this._roomSig) return;
    this._roomSig = sig;

    room.group.visible = visible;
    room.dims = { cx, cz, halfX, halfZ, floorY, wallH, topY, tableHX, tableHZ };

    // A hair of overlap at the corners so no seam can open between planes.
    const over = 1.02;
    room.floor.position.set(cx, floorY, cz);
    room.floor.scale.set(halfX * 2 * over, halfZ * 2 * over, 1);

    const wy = floorY + wallH * 0.5;
    room.walls[0].position.set(cx, wy, cz - halfZ);
    room.walls[0].scale.set(halfX * 2 * over, wallH, 1);
    room.walls[1].position.set(cx, wy, cz + halfZ);
    room.walls[1].scale.set(halfX * 2 * over, wallH, 1);
    room.walls[2].position.set(cx - halfX, wy, cz);
    room.walls[2].scale.set(halfZ * 2 * over, wallH, 1);
    room.walls[3].position.set(cx + halfX, wy, cz);
    room.walls[3].scale.set(halfZ * 2 * over, wallH, 1);

    const u = room.uniforms;
    u.uRoomCenter.value.set(cx, floorY, cz);
    u.uRoomHalf.value.set(halfX, wallH, halfZ);
    u.uTableCenter.value.set(cx, topY, cz);
    u.uTableHalf.value.set(tableHX, tableHZ);
    u.uSplash.value.set(ROOM.splash[0], ROOM.splash[1], TILED_THEMES.has(theme) ? 1 : 0);

    // Was 0.72, which clipped the one prop tall enough to matter. The handback
    // no longer touches props, so they can stand their real height; the cap is
    // only here to keep a unit from poking through the top of the wall plane.
    const hCap = wallH * ROOM.propHeadroom;
    for (let i = 0; i < room.props.length; i++) {
      const d = ROOM_PROPS[i];
      const mesh = room.props[i];
      const ph = Math.min(d.h, hCap - d.base);
      if (!(ph > 10)) {
        mesh.userData.mgFits = false;
        mesh.visible = false;
        continue;
      }
      let px = cx;
      let pz = cz;
      let sx = d.w;
      let sz = d.d;
      if (d.wall === '-z') {
        px = cx + d.along * halfX;
        pz = cz - halfZ + d.d * 0.5;
      } else if (d.wall === '+z') {
        px = cx + d.along * halfX;
        pz = cz + halfZ - d.d * 0.5;
      } else if (d.wall === '-x') {
        px = cx - halfX + d.d * 0.5;
        pz = cz + d.along * halfZ;
        sx = d.d;
        sz = d.w;
      } else {
        px = cx + halfX - d.d * 0.5;
        pz = cz + d.along * halfZ;
        sx = d.d;
        sz = d.w;
      }
      // Never let a block reach over the table: a room prop intersecting the
      // playfield would be a far worse defect than a missing silhouette.
      const clearX = Math.abs(px - cx) - sx * 0.5 - tableHX;
      const clearZ = Math.abs(pz - cz) - sz * 0.5 - tableHZ;
      const fits = Math.max(clearX, clearZ) > 20;
      mesh.userData.mgFits = fits;
      mesh.visible = fits;
      mesh.position.set(px, floorY + d.base + ph * 0.5, pz);
      mesh.scale.set(sx, ph, sz);
    }
  }

  /**
   * Put the pane on a real wall, in the direction the backdrop uniforms say the
   * window is. Which wall, and where along it, comes straight from uWindowDir —
   * that direction is built from each preset's own key azimuth in Lighting, and
   * the two must agree or the light in the room has no visible source. Two
   * things are then clamped so a pane always fits the wall it is in: its height
   * (a window at 20 degrees seen from 1200 u away wants to sit above the
   * ceiling), and, if it would overhang the end of the wall, how far along that
   * wall it sits.
   */
  _updateRoomWindow() {
    const room = this.room;
    if (!room || !room.group.visible || !room.dims) return;
    const u = room.uniforms;
    const dims = room.dims;

    const wd = room.tmp.dir.copy(u.uWindowDir.value);
    if (wd.lengthSq() < 1e-8) return;
    wd.normalize();

    const ax = Math.abs(wd.x);
    const az = Math.abs(wd.z);
    const tx = ax > 1e-4 ? dims.halfX / ax : Infinity;
    const tz = az > 1e-4 ? dims.halfZ / az : Infinity;
    const t = Math.min(tx, tz);
    if (!Number.isFinite(t) || t <= 1) {
      u.uWinHalf.value.set(0, 0);
      return;
    }

    // Proportions from the preset, clamped to something that fits a wall.
    const hw = Math.min(0.20, Math.max(0.12, u.uWindowSize.value.x)) * t;
    const hh = Math.min(0.17, Math.max(0.10, u.uWindowSize.value.y)) * t;

    let nx = 0;
    let nz = 0;
    if (tx <= tz) nx = wd.x > 0 ? -1 : 1;
    else nz = wd.z > 0 ? -1 : 1;

    const right = room.tmp.right.set(-nz, 0, nx);
    const px = dims.cx + wd.x * t;
    const pz = dims.cz + wd.z * t;

    const yLo = dims.floorY + dims.wallH * 0.30 + hh;
    const yHi = dims.floorY + dims.wallH * 0.88 - hh;
    let py = dims.topY + 24 + wd.y * t;
    py = Math.max(Math.min(yLo, yHi), Math.min(py, Math.max(yLo, yHi)));

    // Slide the pane along its wall if it would run off the end.
    const lat = (px - dims.cx) * right.x + (pz - dims.cz) * right.z;
    const latMax = Math.max(0, (nx !== 0 ? dims.halfZ : dims.halfX) - hw - 30);
    const shift = Math.max(-latMax, Math.min(lat, latMax)) - lat;

    u.uWinPos.value.set(px + right.x * shift, py, pz + right.z * shift);
    u.uWinNormal.value.set(nx, 0, nz);
    u.uWinRight.value.copy(right);
    u.uWinUp.value.set(0, 1, 0);
    u.uWinHalf.value.set(hw, hh);

    // Hide any wall unit that would be standing where the window is.
    for (let i = 0; i < room.props.length; i++) {
      const mesh = room.props[i];
      if (!mesh.userData.mgFits) continue;
      const dx = mesh.position.x - u.uWinPos.value.x;
      const dz = mesh.position.z - u.uWinPos.value.z;
      const nd = Math.abs(dx * nx + dz * nz);
      const side = Math.abs(dx * right.x + dz * right.z);
      const top = mesh.position.y + mesh.scale.y * 0.5;
      const bottom = mesh.position.y - mesh.scale.y * 0.5;
      const clash =
        nd < 300 &&
        side < hw + Math.max(mesh.scale.x, mesh.scale.z) * 0.5 &&
        top > py - hh &&
        bottom < py + hh;
      mesh.visible = !clash;
    }
  }

  /**
   * Read the two lights the room cannot infer from the backdrop palette and
   * write them into its uniforms.
   *
   *  - the practical spot. nightLamp's key is a desk lamp over the table, not
   *    the directional, and the backdrop palette for that preset is near black
   *    (0x0d0c12 / 0x2a2c47), so a room derived from the palette alone came out
   *    at 9/255. Lighting already owns the lamp; this just looks at it.
   *  - the warm bounce off the tabletop, whose colour and level are a preset
   *    decision (morning is 0xffc79a at 0.46) and would otherwise have to be
   *    duplicated here and kept in sync by hand.
   *
   * Entirely guarded: Lighting may still be a stub, and most presets have no
   * lamp at all, in which case the power goes to zero and the shader skips it.
   */
  _updateRoomLight(ctx = this.ctx) {
    const room = this.room;
    if (!room) return;
    const u = room.uniforms;
    const lighting = ctx && ctx.lighting;

    const lamp = lighting && lighting.lamp;
    const lit =
      lamp &&
      typeof lamp.getWorldPosition === 'function' &&
      lamp.visible !== false &&
      Number.isFinite(lamp.intensity) &&
      lamp.intensity > 0;
    if (lit) {
      // getWorldPosition updates the matrix chain itself, so this is correct
      // even before the renderer has walked the scene graph this frame.
      lamp.getWorldPosition(_lampPos);
      u.uLampPos.value.copy(_lampPos);

      if (lamp.target && typeof lamp.target.getWorldPosition === 'function') {
        lamp.target.getWorldPosition(_lampAim);
        _lampDir.copy(_lampAim).sub(_lampPos);
      } else {
        _lampDir.set(0, -1, 0);
      }
      if (_lampDir.lengthSq() < 1e-8) _lampDir.set(0, -1, 0);
      u.uLampAxis.value.copy(_lampDir.normalize());

      if (lamp.color) u.uLampColor.value.copy(lamp.color);

      const angle = Math.min(Math.max(Number.isFinite(lamp.angle) ? lamp.angle : 0.6, 0.05), 1.45);
      const penumbra = Math.min(Math.max(Number.isFinite(lamp.penumbra) ? lamp.penumbra : 0.5, 0), 1);
      const cosOuter = Math.cos(angle);
      const cosInner = Math.cos(angle * (1 - penumbra * 0.85));
      u.uLampCos.value.set(cosOuter, Math.max(cosInner, cosOuter + 1e-3));

      // three's punctual intensity is candela and its irradiance is
      // intensity / d^2; the room's shading term is a plain reflectance
      // multiplier, so divide by pi to land in the same space as uRoomAmb.
      u.uLampPower.value = (lamp.intensity / Math.PI) * ROOM.lampGain;
    } else {
      u.uLampPower.value = 0;
    }

    const bounce = lighting && lighting.bounce;
    if (bounce) {
      if (bounce.color) u.uBounceColor.value.copy(bounce.color);
      const i = Number.isFinite(bounce.intensity) ? bounce.intensity : 0;
      u.uBounceAmt.value = Math.max(0, i) * ROOM.bounce;
    }
  }

  _disposeRoom() {
    const room = this.room;
    if (!room) return;
    room.plane.dispose();
    room.box.dispose();
    room.material.dispose();
    room.propMaterial.dispose();
    room.group.parent?.remove(room.group);
    this.room = null;
    this._roomSig = null;
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

  /**
   * Tuning handles for the built room, so its levels can be moved from a
   * console or a tuning panel without touching a shader.
   *
   * @param {{enabled?: boolean, floorDrop?: number, tone?: number,
   *          floorTone?: number, propTone?: number, ambient?: number,
   *          key?: number, pool?: number, tableShade?: number,
   *          window?: number, tableAO?: number, tint?: number,
   *          wallSheen?: number, floorGloss?: number, skirt?: number,
   *          fog?: number, bounceRange?: number, lampSpill?: number,
   *          wallColor?: number, floorColor?: number}} opts
   */
  setRoom(opts = {}) {
    if (opts.enabled != null) this.roomEnabled = !!opts.enabled;
    if (Number.isFinite(opts.floorDrop)) this.floorDrop = opts.floorDrop;
    const u = this.room && this.room.uniforms;
    if (u) {
      if (Number.isFinite(opts.tone)) u.uRoomTone.value = opts.tone;
      if (Number.isFinite(opts.floorTone)) u.uFloorTone.value = opts.floorTone;
      if (Number.isFinite(opts.propTone)) u.uPropTone.value = opts.propTone;
      if (Number.isFinite(opts.ambient)) u.uRoomAmb.value = opts.ambient;
      if (Number.isFinite(opts.key)) u.uRoomKey.value = opts.key;
      if (Number.isFinite(opts.pool)) u.uWinPool.value = opts.pool;
      if (Number.isFinite(opts.tableShade)) u.uTableShade.value = opts.tableShade;
      if (Number.isFinite(opts.window)) u.uRoomWindow.value = opts.window;
      if (Number.isFinite(opts.tableAO)) u.uTableAO.value = opts.tableAO;
      if (Number.isFinite(opts.tint)) u.uRoomTint.value = opts.tint;
      if (Number.isFinite(opts.wallSheen)) u.uWallSheen.value = opts.wallSheen;
      if (Number.isFinite(opts.floorGloss)) u.uFloorGloss.value = opts.floorGloss;
      if (Number.isFinite(opts.skirt)) u.uSkirt.value = opts.skirt;
      if (Number.isFinite(opts.fog)) u.uRoomFog.value = opts.fog;
      if (Number.isFinite(opts.bounceRange)) u.uBounceRange.value = opts.bounceRange;
      if (Number.isFinite(opts.lampSpill)) u.uLampSpill.value = opts.lampSpill;
      if (Number.isFinite(opts.wallColor)) u.uWallColor.value.set(opts.wallColor);
      if (Number.isFinite(opts.floorColor)) u.uFloorColor.value.set(opts.floorColor);
    }
    this._roomSig = null;   // force a refit on the next update
    return this;
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

    this._fitRoom(ctx);
    this._updateRoomWindow();
    this._updateRoomLight(ctx);

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
    this._disposeRoom();
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
