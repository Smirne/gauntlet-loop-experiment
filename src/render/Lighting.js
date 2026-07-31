// Lighting rig for MICRO GAUNTLET.
//
// Three things live here:
//
//  1. A fixed light rig — key sun (split into N cascade lights), cool hemispheric
//     sky fill, warm bounce, cool rim, a trace of ambient, and a lamp spot for the
//     night preset. The rig is built once and never changes shape: presets only
//     move and re-tint it. That matters because adding or removing a light changes
//     NUM_*_LIGHTS in every shader and forces a full material recompile — a
//     several-hundred-millisecond stall in the middle of a race.
//
//  2. Cascaded shadow maps, implemented here because three does not ship them.
//     N directional lights share one direction/colour/intensity; a patched
//     `lights_fragment_begin` gives each an occupancy window in view depth so that
//     exactly one contributes per fragment (the windows sum to 1, so energy is
//     conserved and the seams cross-fade). Each cascade's ortho box is fitted to
//     the minimal sphere around its frustum slice and snapped to whole shadow
//     texels, which is what stops the shadow edges crawling as the camera moves.
//
//  3. Contact shadows. A cast shadow alone does not plant a 9 cm die-cast car on a
//     table; a tight, oriented occlusion blob under the chassis does. One instanced
//     draw covers every car on the grid.
//
// Env lighting is procedural: the Sky module's direction->radiance function is
// rendered into a cube and run through PMREMGenerator. No HDR files, and the
// reflections in the clearcoat match the backdrop the player can see.

import * as THREE from 'three';
import { BASE_EXPOSURE } from './Renderer.js';
import { makeEnvScene, setEnvUniforms } from './Sky.js';

const DEG = Math.PI / 180;

/* ========================================================================== */
/* Presets                                                                    */
/* ========================================================================== */

/**
 * Angles are elevation (degrees above the XZ plane) and azimuth (degrees, 0 = +Z,
 * increasing toward +X). `intensity` values are tuned against ACESFilmic at
 * BASE_EXPOSURE with typical PBR albedos of 0.15-0.6.
 */
export const LIGHT_PRESETS = {
  morning: {
    id: 'morning',
    look: 'morning',
    exposure: 1.02,
    sun: { color: 0xffd3a1, intensity: 3.55, elevation: 21, azimuth: -52 },
    fill: { sky: 0x9dbcf0, ground: 0x6b5238, intensity: 0.72 },
    bounce: { color: 0xffbf8a, intensity: 0.55, elevation: -16, azimuth: 128 },
    rim: { color: 0xa9c8ff, intensity: 0.42, elevation: 30, azimuth: 142 },
    ambient: { color: 0x2f3a52, intensity: 0.15 },
    lamp: { intensity: 0 },
    fog: { color: 0xd7ddea, density: 0.00085 },
    env: { intensity: 1.0 },
    contact: { strength: 0.62, tint: 0x2a2620 },
    backdrop: {
      zenith: 0x54739f, horizon: 0xb8c3d1, ground: 0x38322b, ceiling: 0x9aa7b9,
      clutter: 0.55, clutterColor: 0x2b2b31,
      windowColor: 0xfff0d6, windowIntensity: 8.5, windowSize: [0.30, 0.24],
      windowRound: 0.05, windowSoft: 0.035, windowFalloff: 2.6, mullion: 1.0,
      sunColor: 0xffe6c0, sunDisc: 0.0,
      hazeColor: 0xc6cfdb, hazeStrength: 0.34, indoor: 1.0, mottle: 0.055, intensity: 1.0,
      dust: { density: 1.0, color: 0xffe9c8, size: 1.0, opacity: 0.55 },
      shafts: { strength: 0.85, width: 46, length: 640, count: 3, color: 0xffdfae },
    },
  },

  noon: {
    id: 'noon',
    look: 'noon',
    exposure: 0.97,
    sun: { color: 0xfff4e2, intensity: 4.35, elevation: 66, azimuth: -22 },
    fill: { sky: 0x88b4ff, ground: 0x7a6a4e, intensity: 0.86 },
    bounce: { color: 0xffd9b0, intensity: 0.33, elevation: -22, azimuth: 158 },
    rim: { color: 0xbcd7ff, intensity: 0.28, elevation: 24, azimuth: 150 },
    ambient: { color: 0x33405c, intensity: 0.13 },
    lamp: { intensity: 0 },
    fog: { color: 0xdfe6f0, density: 0.0007 },
    env: { intensity: 1.05 },
    contact: { strength: 0.70, tint: 0x231f1a },
    backdrop: {
      zenith: 0x4a7cc8, horizon: 0xcbd9ea, ground: 0x4a453c, ceiling: 0x7ea6e0,
      clutter: 0.30, clutterColor: 0x3a4048,
      windowColor: 0xffffff, windowIntensity: 2.2, windowSize: [0.26, 0.20],
      windowRound: 0.06, windowSoft: 0.06, windowFalloff: 2.0, mullion: 0.4,
      sunColor: 0xfff6e4, sunDisc: 1.0,
      hazeColor: 0xd9e3f0, hazeStrength: 0.30, indoor: 0.25, mottle: 0.03, intensity: 1.0,
      dust: { density: 0.6, color: 0xfff2dd, size: 0.85, opacity: 0.32 },
      shafts: { strength: 0.0, width: 46, length: 640, count: 3, color: 0xfff0d0 },
    },
  },

  goldenHour: {
    id: 'goldenHour',
    look: 'goldenHour',
    exposure: 1.06,
    sun: { color: 0xffa758, intensity: 3.35, elevation: 9, azimuth: -78 },
    fill: { sky: 0x7fa6e8, ground: 0x8a5f34, intensity: 0.54 },
    bounce: { color: 0xff9a55, intensity: 0.70, elevation: -13, azimuth: 102 },
    rim: { color: 0x9fc0ff, intensity: 0.52, elevation: 22, azimuth: 116 },
    ambient: { color: 0x30263a, intensity: 0.17 },
    lamp: { intensity: 0 },
    fog: { color: 0xf0c69a, density: 0.0016 },
    env: { intensity: 1.0 },
    contact: { strength: 0.56, tint: 0x2c2118 },
    backdrop: {
      zenith: 0x3f5a96, horizon: 0xf2c491, ground: 0x3c2f24, ceiling: 0x8f7a86,
      clutter: 0.60, clutterColor: 0x2a2028,
      windowColor: 0xffc98a, windowIntensity: 12.0, windowSize: [0.33, 0.26],
      windowRound: 0.05, windowSoft: 0.045, windowFalloff: 2.1, mullion: 1.0,
      sunColor: 0xffb46a, sunDisc: 0.55,
      hazeColor: 0xe8b98d, hazeStrength: 0.52, indoor: 0.75, mottle: 0.06, intensity: 1.0,
      dust: { density: 1.35, color: 0xffd7a2, size: 1.15, opacity: 0.72 },
      shafts: { strength: 1.15, width: 54, length: 720, count: 3, color: 0xffc389 },
    },
  },

  overcast: {
    id: 'overcast',
    look: 'overcast',
    exposure: 1.10,
    sun: { color: 0xdfe6f2, intensity: 1.15, elevation: 58, azimuth: -30 },
    fill: { sky: 0xc7d4e6, ground: 0x8d8779, intensity: 1.55 },
    bounce: { color: 0xcfd6dd, intensity: 0.33, elevation: -20, azimuth: 150 },
    rim: { color: 0xdfe8f5, intensity: 0.24, elevation: 26, azimuth: 148 },
    ambient: { color: 0x4a5364, intensity: 0.30 },
    lamp: { intensity: 0 },
    fog: { color: 0xd2d9e2, density: 0.0022 },
    env: { intensity: 1.15 },
    contact: { strength: 0.40, tint: 0x2f3238 },
    backdrop: {
      zenith: 0x93a3b8, horizon: 0xc8d0da, ground: 0x4c4a46, ceiling: 0xa9b4c2,
      clutter: 0.40, clutterColor: 0x424750,
      windowColor: 0xe8eef6, windowIntensity: 3.4, windowSize: [0.32, 0.25],
      windowRound: 0.06, windowSoft: 0.09, windowFalloff: 1.5, mullion: 0.9,
      sunColor: 0xdfe6f2, sunDisc: 0.0,
      hazeColor: 0xcfd7e1, hazeStrength: 0.46, indoor: 0.85, mottle: 0.04, intensity: 1.0,
      dust: { density: 0.5, color: 0xdfe6f2, size: 0.9, opacity: 0.22 },
      shafts: { strength: 0.0, width: 46, length: 640, count: 3, color: 0xdfe6f2 },
    },
  },

  dusk: {
    id: 'dusk',
    look: 'dusk',
    exposure: 1.18,
    sun: { color: 0xff8a63, intensity: 1.45, elevation: 5, azimuth: -96 },
    fill: { sky: 0x4a5fa8, ground: 0x3a2e3a, intensity: 0.68 },
    bounce: { color: 0xff7a52, intensity: 0.38, elevation: -12, azimuth: 96 },
    rim: { color: 0x7f9dff, intensity: 0.62, elevation: 26, azimuth: 98 },
    ambient: { color: 0x232a48, intensity: 0.28 },
    lamp: { intensity: 0 },
    fog: { color: 0x59547e, density: 0.0026 },
    env: { intensity: 1.1 },
    contact: { strength: 0.50, tint: 0x1a1a2a },
    backdrop: {
      zenith: 0x1e2a55, horizon: 0x7d6392, ground: 0x1c1a26, ceiling: 0x2b3260,
      clutter: 0.70, clutterColor: 0x14131f,
      windowColor: 0xff9d6e, windowIntensity: 9.0, windowSize: [0.30, 0.24],
      windowRound: 0.05, windowSoft: 0.05, windowFalloff: 2.3, mullion: 1.0,
      sunColor: 0xff8a5c, sunDisc: 0.35,
      hazeColor: 0x6a5f8c, hazeStrength: 0.55, indoor: 0.7, mottle: 0.06, intensity: 1.0,
      dust: { density: 0.9, color: 0xffb389, size: 1.05, opacity: 0.5 },
      shafts: { strength: 0.9, width: 50, length: 700, count: 2, color: 0xff9e70 },
    },
  },

  nightLamp: {
    id: 'nightLamp',
    look: 'nightLamp',
    exposure: 1.30,
    sun: { color: 0x6f86c8, intensity: 0.34, elevation: 40, azimuth: 122 },
    fill: { sky: 0x35426e, ground: 0x241d18, intensity: 0.30 },
    bounce: { color: 0xffb473, intensity: 0.20, elevation: -18, azimuth: -40 },
    rim: { color: 0x89a7ff, intensity: 0.34, elevation: 24, azimuth: -70 },
    ambient: { color: 0x141a2c, intensity: 0.20 },
    // `irradiance` is the target lux-equivalent at the target point; the actual
    // three intensity is derived as irradiance * distance^2 because punctual
    // lights are physically falling off since r155.
    lamp: {
      color: 0xffc27a, irradiance: 5.4, offset: [-118, 205, -92],
      angle: 0.66, penumbra: 0.58, shadow: true,
    },
    fog: { color: 0x1b2138, density: 0.0030 },
    env: { intensity: 0.85 },
    contact: { strength: 0.74, tint: 0x14131c },
    backdrop: {
      zenith: 0x0d1226, horizon: 0x2a2c47, ground: 0x0d0c12, ceiling: 0x151a33,
      clutter: 0.80, clutterColor: 0x080810,
      windowColor: 0x7d9dff, windowIntensity: 2.2, windowSize: [0.26, 0.30],
      windowRound: 0.04, windowSoft: 0.04, windowFalloff: 2.8, mullion: 1.0,
      sunColor: 0x8ea6e8, sunDisc: 0.0,
      hazeColor: 0x232a48, hazeStrength: 0.42, indoor: 1.0, mottle: 0.05, intensity: 1.0,
      dust: { density: 1.2, color: 0xffd6a0, size: 1.1, opacity: 0.6 },
      shafts: { strength: 0.7, width: 40, length: 520, count: 2, color: 0xffc98d },
    },
  },
};

export const LIGHT_PRESET_NAMES = Object.keys(LIGHT_PRESETS);

/* ========================================================================== */
/* Cascaded shadow maps: the shader patch                                     */
/* ========================================================================== */

const SHADOW_CALL =
  'getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, ' +
  'directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, ' +
  'directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )';

const SHADOW_LINE = 'directLight.color *= ( directLight.visible && receiveShadow ) ? ' + SHADOW_CALL + ' : 1.0;';

const RE_DIRECT_LINE =
  'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, ' +
  'geometryClearcoatNormal, material, reflectedLight );';

const DIR_BLOCK_START = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
const DIR_BLOCK_END = '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )';

/** View-space depth of the shading point, positive in front of the camera. */
const CSM_DEPTH = '( - geometryPosition.z )';

const f = (n) => {
  const s = Number(n).toFixed(4);
  return s.indexOf('.') < 0 ? s + '.0' : s;
};

/**
 * Module-level record of what we did to the global chunk. The patch is global and
 * one-shot for the session: split boundaries are baked into shader literals, so a
 * second Lighting instance must adopt this configuration rather than assume its
 * own.
 */
const CsmChunk = { installed: false, original: null, cascades: 0, splits: null };

/**
 * Rewrite `lights_fragment_begin` so the first `cascades` directional lights act
 * as one cascaded key light.
 *
 * Split boundaries are baked in as literals rather than pushed through a uniform:
 * three only re-uploads a built-in material's uniform block when the light *hash*
 * changes, so a per-frame custom uniform would go stale. Splits are a fixed
 * configuration in every engine that ships CSM anyway — what has to be per-frame
 * is the cascade *fit*, and that travels through the stock shadow matrices.
 *
 * @param {number[]} splits ascending view depths, length cascades + 1
 * @param {number} blendFrac fraction of each split distance used to cross-fade
 * @returns {?{cascades: number, splits: number[]}} null if the chunk did not look
 *   the way we expect; otherwise the configuration now baked into the shader,
 *   which may be an earlier install's rather than the one just requested.
 */
export function installCsmShaderPatch(splits, blendFrac = 0.06) {
  if (CsmChunk.installed) return { cascades: CsmChunk.cascades, splits: CsmChunk.splits };
  const cascades = splits.length - 1;
  if (cascades < 2) return null;

  const original = THREE.ShaderChunk.lights_fragment_begin;
  if (typeof original !== 'string') return null;

  const a = original.indexOf(DIR_BLOCK_START);
  const b = original.indexOf(DIR_BLOCK_END, a + 1);
  if (a < 0 || b < 0) return null;

  let block = original.slice(a, b);
  if (block.indexOf(SHADOW_LINE) < 0 || block.indexOf(RE_DIRECT_LINE) < 0) return null;

  // Cross-fade bands around each interior split.
  const lo = [];
  const hi = [];
  for (let i = 1; i < cascades; i++) {
    const w = Math.max(1.0, splits[i] * blendFrac);
    lo.push(splits[i] - w);
    hi.push(splits[i] + w);
  }

  // --- 1. last cascade fades its shadow out before the shadow far plane so
  //        distant geometry stays lit rather than snapping to unshadowed.
  const fadeStart = f(splits[cascades] * 0.80);
  const fadeEnd = f(splits[cascades]);
  const shadowPatch =
    `#if ( UNROLLED_LOOP_INDEX == ${cascades - 1} )\n` +
    `\t\tdirectLight.color *= ( directLight.visible && receiveShadow ) ? mix( 1.0, ${SHADOW_CALL}, ` +
    `1.0 - smoothstep( ${fadeStart}, ${fadeEnd}, ${CSM_DEPTH} ) ) : 1.0;\n` +
    `\t\t#else\n` +
    `\t\t${SHADOW_LINE}\n` +
    `\t\t#endif`;
  block = block.replace(SHADOW_LINE, shadowPatch);

  // --- 2. occupancy windows. They partition view depth, so summed over the
  //        cascade lights the key contributes exactly once everywhere.
  let occ = '';
  for (let i = 0; i < cascades; i++) {
    const terms = [];
    if (i > 0) terms.push(`smoothstep( ${f(lo[i - 1])}, ${f(hi[i - 1])}, ${CSM_DEPTH} )`);
    if (i < cascades - 1) terms.push(`( 1.0 - smoothstep( ${f(lo[i])}, ${f(hi[i])}, ${CSM_DEPTH} ) )`);
    const expr = terms.length ? terms.join(' * ') : '1.0';
    occ += `\t\t#${i === 0 ? 'if' : 'elif'} ( UNROLLED_LOOP_INDEX == ${i} )\n`;
    occ += `\t\tdirectLight.color *= ${expr};\n`;
  }
  occ += '\t\t#endif\n\t\t';
  block = block.replace(RE_DIRECT_LINE, occ + RE_DIRECT_LINE);

  CsmChunk.original = original;
  CsmChunk.cascades = cascades;
  CsmChunk.splits = splits.slice();
  CsmChunk.installed = true;
  THREE.ShaderChunk.lights_fragment_begin = original.slice(0, a) + block + original.slice(b);
  return { cascades, splits: CsmChunk.splits };
}

/** Restore the stock chunk. Only meaningful before any material has compiled. */
export function uninstallCsmShaderPatch() {
  if (!CsmChunk.installed) return;
  THREE.ShaderChunk.lights_fragment_begin = CsmChunk.original;
  CsmChunk.installed = false;
  CsmChunk.cascades = 0;
  CsmChunk.splits = null;
}

/* ========================================================================== */
/* Contact shadows                                                            */
/* ========================================================================== */

const CONTACT_VERT = /* glsl */ `
attribute vec4 aParams;
varying vec2 vBlobUv;
varying vec4 vBlobParams;
#include <common>
void main() {
  vBlobUv = uv;
  vBlobParams = aParams;
  #include <begin_vertex>
  #include <project_vertex>
}
`;

const CONTACT_FRAG = /* glsl */ `
uniform vec3 uTint;
varying vec2 vBlobUv;
varying vec4 vBlobParams;   // x strength, y core radius, z softness exponent

void main() {
  vec2 p = vBlobUv * 2.0 - 1.0;
  float r = length( p );
  float a = 1.0 - smoothstep( vBlobParams.y, 1.0, r );
  a = pow( max( a, 0.0 ), vBlobParams.z ) * vBlobParams.x;
  a = clamp( a, 0.0, 1.0 );
  gl_FragColor = vec4( mix( vec3( 1.0 ), uTint, a ), 1.0 );
}
`;

const MAX_CONTACT = 48;

/* ========================================================================== */
/* Scratch                                                                    */
/* ========================================================================== */

const _sunDir = new THREE.Vector3();
const _center = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _altUp = new THREE.Vector3(0, 0, 1);
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _mat = new THREE.Matrix4();
const _color = new THREE.Color();
const _boxCenter = new THREE.Vector3();
const _boxSize = new THREE.Vector3();
const _snapped = new THREE.Vector3();
const _camPos = new THREE.Vector3();

function dirFromAngles(elevationDeg, azimuthDeg, out) {
  // Clamp off vertical: three builds the shadow camera basis with lookAt and a
  // (0,1,0) up vector, which degenerates when the light is straight overhead.
  const e = Math.max(-84, Math.min(84, elevationDeg)) * DEG;
  const a = azimuthDeg * DEG;
  const c = Math.cos(e);
  return out.set(Math.sin(a) * c, Math.sin(e), Math.cos(a) * c).normalize();
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/* ========================================================================== */
/* Lighting                                                                   */
/* ========================================================================== */

export class Lighting {
  name = 'lighting';

  constructor(ctx = {}, opts = {}) {
    this.ctx = ctx;
    this.enabled = true;

    this.root = new THREE.Group();
    this.root.name = 'MG.Lighting';

    /** Direction from the scene *toward* the key light. */
    this.sunDir = new THREE.Vector3(0, 1, 0);
    /** Direction the key light *travels*. Sky reads this for scattering. */
    this.sunTravel = new THREE.Vector3(0, -1, 0);

    this.presetName = opts.preset || 'morning';
    this.preset = LIGHT_PRESETS[this.presetName] || LIGHT_PRESETS.morning;

    this.cascadeCount = Math.max(2, Math.min(4, opts.cascades || 3));
    this.shadowFar = opts.shadowFar || 400;
    this.shadowNear = opts.shadowNear || 2;
    this.casterExtrusion = opts.casterExtrusion || 160;
    this.fitPadding = opts.fitPadding || 1.06;
    this.splits = opts.splits || null;

    this.csmEnabled = false;
    this.cascades = [];
    this._frame = 0;
    this._intervals = [1, 2, 3, 4];

    this._blend = null; // { from, to, t, rate }
    this._envCache = new Map();
    this._pmrem = null;
    this._envScene = null;
    this._noHeightAt = false;
    this._sawLate = false;

    this.contact = null;
  }

  /* ---------------------------------------------------------------------- */

  async init() {
    const ctx = this.ctx;
    const scene = ctx.scene;
    const settings = ctx.settings || {};
    const tier = settings.quality || 'ultra';

    this.shadowMapSize = this._resolveShadowMapSize(settings);
    this._intervals = tier === 'low' ? [1, 3, 5, 6] : tier === 'medium' ? [1, 2, 4, 5] : [1, 2, 3, 4];

    // Splits: practical scheme biased toward the chase-camera working range
    // (~60-220 u from the lens) rather than the classic near-plane log split,
    // which would spend the whole first cascade on empty air in front of the car.
    if (!this.splits) {
      const n = this.cascadeCount;
      const near = this.shadowNear;
      const far = this.shadowFar;
      const lambda = 0.55;
      this.splits = [near];
      for (let i = 1; i < n; i++) {
        const p = i / n;
        const logS = near * Math.pow(far / near, p);
        const uniS = near + (far - near) * p;
        // Pull the first boundary out: nothing interesting lives within ~40 u.
        this.splits.push(lerp(uniS, logS, lambda) + far * 0.045 * (n - i));
      }
      this.splits.push(far);
    }

    const csm = installCsmShaderPatch(this.splits, 0.065);
    this.csmEnabled = !!csm;
    if (csm) {
      // May differ from what we asked for if another instance installed first.
      this.splits = csm.splits;
      this.cascadeCount = csm.cascades;
    } else {
      console.warn('[MICRO GAUNTLET] CSM shader patch did not apply; falling back to a single shadow map.');
    }

    this._buildRig();
    this._buildContactShadows();

    if (scene) {
      scene.add(this.root);
      // The cascade lights must be the first shadow-casting directional lights in
      // three's sorted light list, and that sort is stable, so being first in the
      // scene graph is what guarantees cascade index == light index.
      this._hoistRoot(scene);
      if (!scene.fog) scene.fog = new THREE.FogExp2(0xd7ddea, 0.001);
      this.fog = scene.fog;
    }

    this.setPreset(this.presetName, { transition: 0 });
    return this;
  }

  _resolveShadowMapSize(settings) {
    const caps = this.ctx.renderer?.userData?.mg?.caps;
    const requested = (settings.render && settings.render.shadowMapSize) || (settings.quality === 'low' ? 512 : settings.quality === 'medium' ? 1024 : 2048);
    // 3 x 2048 packed-depth maps is ~50 MB; 3 x 4096 would be 200 MB, which is
    // not a trade worth making when the fits are already sub-millimetre.
    return Math.min(2048, Math.max(256, requested), caps ? caps.maxTextureSize : 4096);
  }

  _hoistRoot(scene) {
    const idx = scene.children.indexOf(this.root);
    if (idx > 0) {
      scene.children.splice(idx, 1);
      scene.children.unshift(this.root);
    }
  }

  /* ---- rig -------------------------------------------------------------- */

  _buildRig() {
    const n = this.csmEnabled ? this.cascadeCount : 1;

    for (let i = 0; i < n; i++) {
      const light = new THREE.DirectionalLight(0xffffff, 1);
      light.name = 'MG.Sun.Cascade' + i;
      light.castShadow = true;
      light.shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize);
      light.shadow.camera.up.set(0, 1, 0);
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = 1000;
      light.shadow.bias = -0.0002;
      light.shadow.normalBias = 0.1;
      light.shadow.autoUpdate = false;
      light.shadow.needsUpdate = true;
      light.target.name = 'MG.Sun.Target' + i;
      this.root.add(light);
      this.root.add(light.target);
      this.cascades.push({ light, index: i, radius: 1, texel: 1 });
    }
    this.sun = this.cascades[0].light;

    this.fill = new THREE.HemisphereLight(0x9dbcf0, 0x6b5238, 0.7);
    this.fill.name = 'MG.Fill';
    this.root.add(this.fill);

    this.bounce = new THREE.DirectionalLight(0xffbf8a, 0.5);
    this.bounce.name = 'MG.Bounce';
    this.bounce.castShadow = false;
    this.root.add(this.bounce);
    this.root.add(this.bounce.target);

    this.rim = new THREE.DirectionalLight(0xa9c8ff, 0.4);
    this.rim.name = 'MG.Rim';
    this.rim.castShadow = false;
    this.root.add(this.rim);
    this.root.add(this.rim.target);

    this.ambient = new THREE.AmbientLight(0x2f3a52, 0.15);
    this.ambient.name = 'MG.Ambient';
    this.root.add(this.ambient);

    // Present in every preset so the shader permutation never changes; its
    // intensity (and shadow work) is simply zero except at night.
    this.lamp = new THREE.SpotLight(0xffc27a, 0, 0, 0.66, 0.58, 2);
    this.lamp.name = 'MG.Lamp';
    this.lamp.castShadow = true;
    this.lamp.shadow.mapSize.set(Math.min(1024, this.shadowMapSize), Math.min(1024, this.shadowMapSize));
    this.lamp.shadow.camera.near = 8;
    this.lamp.shadow.camera.far = 900;
    this.lamp.shadow.bias = -0.0006;
    this.lamp.shadow.normalBias = 0.25;
    this.lamp.shadow.autoUpdate = false;
    this.lamp.shadow.needsUpdate = false;
    this.lamp.position.set(-118, 205, -92);
    this.root.add(this.lamp);
    this.root.add(this.lamp.target);
  }

  _buildContactShadows() {
    const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const params = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CONTACT * 4), 4);
    params.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aParams', params);

    const material = new THREE.ShaderMaterial({
      name: 'MG.ContactShadow',
      uniforms: { uTint: { value: new THREE.Color(0x2a2620) } },
      vertexShader: CONTACT_VERT,
      fragmentShader: CONTACT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.MultiplyBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: false,
      toneMapped: false,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, MAX_CONTACT);
    mesh.name = 'MG.ContactShadows';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = -5; // first thing in the transparent queue
    mesh.count = 0;

    this.contact = { mesh, geometry, material, params, strength: 0.62, users: [] };
    this.root.add(mesh);
  }

  /* ---- presets ---------------------------------------------------------- */

  /**
   * @param {string} name one of LIGHT_PRESET_NAMES
   * @param {{transition?: number}} [opts] seconds to blend the rig over
   */
  setPreset(name, opts = {}) {
    const next = LIGHT_PRESETS[name];
    if (!next) return this;

    const transition = opts.transition != null ? opts.transition : 0.6;
    this.presetName = name;
    this.preset = next;

    if (transition > 0 && this._current) {
      this._blend = { to: next, t: 0, rate: 1 / transition };
    } else {
      this._blend = null;
      this._applyPreset(next, 1);
      // A prefiltered cube cannot be cross-faded, so it swaps outright: instantly
      // here, at the midpoint of a blend in _tickBlend.
      this._applyEnv(next);
    }

    this.ctx.sky?.setPreset?.(name, next.backdrop, { transition });
    this.ctx.postfx?.setLook?.(next.look || name);
    this.ctx.bus?.emit?.('lighting:preset', {
      name,
      look: next.look || name,
      backdrop: next.backdrop,
      transition,
    });
    return this;
  }

  /**
   * Move the rig toward preset `p` by an incremental factor `t` (1 = snap).
   * Everything blends from wherever it currently is, so repeated partial steps
   * converge without needing a snapshot of the starting state.
   */
  _applyPreset(p, t) {
    const snap = t >= 1;
    const lerpC = (target, hex) => {
      if (snap) target.set(hex);
      else target.lerp(_color.set(hex), t);
    };
    const num = (a, b) => (snap ? b : lerp(a, b, t));

    const dirSun = dirFromAngles(p.sun.elevation, p.sun.azimuth, _sunDir);
    if (snap) this.sunDir.copy(dirSun);
    else this.sunDir.lerp(dirSun, t).normalize();
    this.sunTravel.copy(this.sunDir).negate();

    lerpC(this.sun.color, p.sun.color);
    this.sun.intensity = num(this.sun.intensity, p.sun.intensity);

    // Every cascade is the same physical light; only its shadow map differs.
    for (let i = 1; i < this.cascades.length; i++) {
      const l = this.cascades[i].light;
      l.color.copy(this.sun.color);
      l.intensity = this.sun.intensity;
    }

    lerpC(this.fill.color, p.fill.sky);
    lerpC(this.fill.groundColor, p.fill.ground);
    this.fill.intensity = num(this.fill.intensity, p.fill.intensity);

    lerpC(this.bounce.color, p.bounce.color);
    this.bounce.intensity = num(this.bounce.intensity, p.bounce.intensity);
    dirFromAngles(p.bounce.elevation, p.bounce.azimuth, _fwd);
    this.bounce.position.copy(_fwd).multiplyScalar(600);

    lerpC(this.rim.color, p.rim.color);
    this.rim.intensity = num(this.rim.intensity, p.rim.intensity);
    dirFromAngles(p.rim.elevation, p.rim.azimuth, _fwd);
    this.rim.position.copy(_fwd).multiplyScalar(600);

    lerpC(this.ambient.color, p.ambient.color);
    this.ambient.intensity = num(this.ambient.intensity, p.ambient.intensity);

    this._applyLamp(p, t);

    if (this.fog) {
      lerpC(this.fog.color, p.fog.color);
      this.fog.density = num(this.fog.density, p.fog.density);
    }

    if (this.contact) {
      this.contact.strength = num(this.contact.strength, p.contact.strength);
      lerpC(this.contact.material.uniforms.uTint.value, p.contact.tint);
    }

    const renderer = this.ctx.renderer;
    if (renderer) {
      renderer.toneMappingExposure = num(renderer.toneMappingExposure, BASE_EXPOSURE * (p.exposure || 1));
    }

    const scene = this.ctx.scene;
    if (scene) scene.environmentIntensity = num(scene.environmentIntensity, (p.env && p.env.intensity) || 1);

    this._current = p;
  }

  _applyLamp(p, t) {
    const snap = t >= 1;
    const l = p.lamp || { intensity: 0 };
    const bounds = this._trackCenter(_boxCenter);
    if (l.offset) {
      this.lamp.position.set(bounds.x + l.offset[0], bounds.y + l.offset[1], bounds.z + l.offset[2]);
    }
    this.lamp.target.position.copy(bounds);

    if (l.irradiance) {
      const d = this.lamp.position.distanceTo(this.lamp.target.position);
      // Punctual lights fall off as 1/d^2 since r155, so a "how bright at the
      // table" number has to be converted into three's intensity.
      const want = l.irradiance * d * d;
      this.lamp.intensity = snap ? want : lerp(this.lamp.intensity, want, t);
      this.lamp.distance = d * 3.2;
      this.lamp.decay = 2;
      this.lamp.angle = l.angle || 0.66;
      this.lamp.penumbra = l.penumbra || 0.58;
      if (snap) this.lamp.color.set(l.color);
      else this.lamp.color.lerp(_color.set(l.color), t);
    } else {
      this.lamp.intensity = snap ? 0 : lerp(this.lamp.intensity, 0, t);
    }

    // The lamp stays in the scene and stays visible at all times: hiding it or
    // dropping castShadow would change NUM_SPOT_LIGHT(_SHADOWS) and recompile
    // every material in the game mid-race. Only its shadow *render* is skipped.
    this.lamp.visible = true;
    this.lamp.shadow.autoUpdate = false;
    this.lamp.shadow.needsUpdate = this.lamp.intensity > 1;
  }

  /**
   * Procedural IBL: render Sky's direction->radiance function into a cube and
   * prefilter it. No .hdr, and because it is literally the same shader as the
   * visible backdrop, what the clearcoat reflects is what is actually behind the
   * car. Results are cached per preset — regenerating costs ~10 ms.
   */
  _applyEnv(p) {
    const renderer = this.ctx.renderer;
    const scene = this.ctx.scene;
    if (!renderer || !scene) return;

    let entry = this._envCache.get(p.id);
    if (!entry) {
      try {
        if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(renderer);
        if (!this._envScene) this._envScene = makeEnvScene(p.backdrop);
        else setEnvUniforms(this._envScene.uniforms, p.backdrop, 1);

        // Tame the window in the IBL only. At its full backdrop value a 12x
        // highlight in mip 0 turns every rough surface in the scene into a
        // mirror of the window; the visible backdrop keeps the full punch.
        const wi = this._envScene.uniforms.uWindowIntensity.value;
        this._envScene.uniforms.uWindowIntensity.value = Math.min(wi, 6.0);
        const rt = this._pmrem.fromScene(this._envScene.scene, 0, 1, 400, { size: 256 });
        this._envScene.uniforms.uWindowIntensity.value = wi;

        entry = { rt, texture: rt.texture };
        this._envCache.set(p.id, entry);
      } catch (e) {
        console.warn('[MICRO GAUNTLET] env map generation failed:', e);
        return;
      }
    }

    scene.environment = entry.texture;
    scene.environmentIntensity = (p.env && p.env.intensity) || 1;
    // Insurance against a missing Sky module: never leave the clear colour black.
    if (!scene.background && !this.ctx.sky) scene.background = new THREE.Color(p.fog.color);
  }

  /* ---- per frame -------------------------------------------------------- */

  update(dt, ctx = this.ctx) {
    if (!this.enabled) return;
    const d = Math.min(dt || 0, 0.05);
    this._tickBlend(d);
    this._updateContactShadows(ctx);
    if (!this._sawLate) this._fitToCamera(ctx);
  }

  lateUpdate(dt, ctx = this.ctx) {
    // The camera director runs in lateUpdate, so this is the only place the
    // cascade fit sees the camera transform that will actually be rendered.
    this._sawLate = true;
    this._fitToCamera(ctx);
  }

  _tickBlend(dt) {
    const b = this._blend;
    if (!b) return;
    const prevT = b.t;
    b.t = Math.min(1, b.t + b.rate * dt);
    // Smoothstep the parameter so the transition eases in and out.
    const s = b.t * b.t * (3 - 2 * b.t);
    const sPrev = prevT * prevT * (3 - 2 * prevT);
    // Convert eased absolute progress into the incremental step that lands us on
    // the eased curve given where the rig already sits.
    const step = sPrev >= 1 ? 1 : (s - sPrev) / (1 - sPrev);

    if (b.t >= 1) {
      this._applyPreset(b.to, 1);
      this._applyEnv(b.to);
      this._blend = null;
      return;
    }
    this._applyPreset(b.to, step);
    if (prevT < 0.5 && b.t >= 0.5) this._applyEnv(b.to);
  }

  /* ---- cascades --------------------------------------------------------- */

  _fitToCamera(ctx) {
    // Cheap re-assertion: another system adding a shadow-casting directional
    // light ahead of us in the scene graph would shift the cascade indices the
    // shader patch depends on.
    if (ctx.scene && ctx.scene.children[0] !== this.root) this._hoistRoot(ctx.scene);

    const camera = ctx.camera;
    if (!camera || !camera.isPerspectiveCamera) {
      this._fitToBounds(ctx);
      return;
    }
    this._frame++;

    camera.updateMatrixWorld();
    camera.getWorldDirection(_fwd);
    _camPos.setFromMatrixPosition(camera.matrixWorld);

    const tanV = Math.tan((camera.fov * DEG) * 0.5);
    const tanH = tanV * camera.aspect;
    const a2 = tanV * tanV + tanH * tanH;

    const last = this.splits.length - 1;
    const first = this._frame === 1;
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      const interval = this._intervals[i] || 1;
      // Cascade 0 refits every frame; the wider ones every few, because a 2-frame
      // lag at 100 u out is invisible and each refit costs a full depth pass.
      // A cascade that is not refitted is also not re-rendered, so its stale map
      // and its stale shadow matrix stay consistent with each other.
      if (!first && this._frame % interval !== 0) continue;

      // Without the shader patch there is exactly one map, and it has to cover
      // the whole shadow range rather than just the first slice.
      const near = this.csmEnabled ? this.splits[i] : this.splits[0];
      const far = this.csmEnabled ? this.splits[i + 1] : this.splits[last];

      // Minimal sphere around the frustum slice, centred on the view axis. Using a
      // sphere (not the slice's AABB) is what makes the fit rotation-invariant, so
      // simply turning the camera cannot shimmer the shadow edges.
      let cDist = (near + far) * (a2 + 1) * 0.5;
      if (cDist > far) cDist = far;
      const rNear = Math.sqrt(near * near * a2 + (cDist - near) * (cDist - near));
      const rFar = Math.sqrt(far * far * a2 + (cDist - far) * (cDist - far));
      // 6% slack: registration order can put the camera director's lateUpdate
      // after ours, and a throttled cascade is up to four frames old, so the fit
      // has to cover where the camera is going, not only where it was.
      const radius = Math.max(rNear, rFar) * this.fitPadding;

      _center.copy(_camPos).addScaledVector(_fwd, cDist);
      this._placeCascade(c, _center, radius);
    }
  }

  /** Fallback when there is no perspective camera: one box over the playfield. */
  _fitToBounds(ctx) {
    const b = ctx.track && ctx.track.bounds;
    let radius = 300;
    if (b && b.getCenter) {
      b.getCenter(_center);
      b.getSize(_boxSize);
      radius = Math.max(60, _boxSize.length() * 0.5);
    } else {
      _center.set(0, 0, 0);
    }
    for (let i = 0; i < this.cascades.length; i++) {
      this._placeCascade(this.cascades[i], _center, radius * (i === 0 ? 1 : 1 + i * 0.6));
    }
  }

  _placeCascade(c, center, radius) {
    const light = c.light;
    const mapSize = light.shadow.mapSize.x;
    const texel = (radius * 2) / mapSize;

    // Mirror exactly what LightShadow.updateMatrices does via
    // shadowCamera.lookAt(target): z = normalize(eye - target), x = up X z,
    // y = z X x. If the two bases disagree the snap lands on the wrong grid and
    // does nothing.
    const up = Math.abs(this.sunDir.y) > 0.9995 ? _altUp : _up;
    light.shadow.camera.up.copy(up);
    _xAxis.crossVectors(up, this.sunDir).normalize();
    _yAxis.crossVectors(this.sunDir, _xAxis).normalize();

    // Snap the fit to whole texels along both light-space axes. Without this the
    // shadow edges swim by a fraction of a texel every frame and the whole image
    // crawls, which is the single most obvious "hobby project" tell in a
    // moving-camera shot.
    const cx = center.dot(_xAxis);
    const cy = center.dot(_yAxis);
    const sx = Math.round(cx / texel) * texel - cx;
    const sy = Math.round(cy / texel) * texel - cy;
    _snapped.copy(center).addScaledVector(_xAxis, sx).addScaledVector(_yAxis, sy);

    const dist = radius + this.casterExtrusion;
    light.position.copy(_snapped).addScaledVector(this.sunDir, dist);
    light.target.position.copy(_snapped);

    const cam = light.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 0.5;
    cam.far = dist + radius;
    cam.updateProjectionMatrix();

    // Both biases scale with texel size so near and far cascades acne-free at the
    // same settings. normalBias does the heavy lifting; the depth bias is only
    // there to catch surfaces facing nearly edge-on to the light.
    light.shadow.normalBias = texel * 1.45;
    light.shadow.bias = -(texel * 0.85) / (cam.far - cam.near);
    light.shadow.needsUpdate = true;

    c.radius = radius;
    c.texel = texel;
  }

  /* ---- contact shadows -------------------------------------------------- */

  /**
   * Register any object that should get a grounding blob (props, debris, the
   * player's shadow during a cutscene).
   * @param {THREE.Object3D|{position: THREE.Vector3, quaternion?: THREE.Quaternion}} target
   * @param {{length?: number, width?: number, strength?: number, fadeHeight?: number}} [opts]
   */
  addContactShadow(target, opts = {}) {
    if (!this.contact || !target) return null;
    const entry = {
      target,
      length: opts.length || 9,
      width: opts.width || 4,
      strength: opts.strength != null ? opts.strength : 1,
      fadeHeight: opts.fadeHeight || 7,
    };
    this.contact.users.push(entry);
    return entry;
  }

  removeContactShadow(entry) {
    if (!this.contact) return;
    const i = this.contact.users.indexOf(entry);
    if (i >= 0) this.contact.users.splice(i, 1);
  }

  _groundHeight(x, z) {
    const track = this.ctx.track;
    if (track && !this._noHeightAt && typeof track.heightAt === 'function') {
      try {
        const y = track.heightAt(x, z);
        if (Number.isFinite(y)) return y;
      } catch (e) {
        this._noHeightAt = true;
      }
    }
    return 0;
  }

  /**
   * Write one blob instance. Returns the next free slot (unchanged if the object
   * is too far off the surface to be worth drawing).
   */
  _pushContact(n, obj, length, width, mul, fadeHeight) {
    const cs = this.contact;
    if (n >= MAX_CONTACT) return n;
    const p = obj.position;
    if (!p) return n;

    const gy = this._groundHeight(p.x, p.z);
    const h = Math.max(0, p.y - gy);
    const lift = Math.min(1, h / fadeHeight);
    const fade = 1 - lift;
    if (fade <= 0.001) return n;

    // Airborne cars get a bigger, softer, fainter blob — exactly the cue a real
    // contact shadow gives as an object lifts off a surface.
    const spread = 1 + lift * 0.85;
    const strength = cs.strength * mul * fade * fade;

    if (obj.quaternion) {
      _euler.setFromQuaternion(obj.quaternion, 'YXZ');
      _quat.setFromAxisAngle(_up, _euler.y);
    } else {
      _quat.identity();
    }
    _pos.set(p.x, gy + 0.09, p.z);
    // Vehicle forward is local +Z, so the blob is long in Z and narrow in X.
    // Override per vehicle with `vehicle.footprint = { length, width }`.
    _scale.set(width * 1.55 * spread, 1, length * 1.22 * spread);
    _mat.compose(_pos, _quat, _scale);
    cs.mesh.setMatrixAt(n, _mat);

    const arr = cs.params.array;
    const o = n * 4;
    arr[o] = strength;
    // The dark core shrinks and the edge softens with height.
    arr[o + 1] = 0.42 - 0.34 * lift;
    arr[o + 2] = 1.45; // edge falloff exponent
    arr[o + 3] = 0;
    return n + 1;
  }

  _updateContactShadows(ctx) {
    const cs = this.contact;
    if (!cs) return;

    const mesh = cs.mesh;
    let n = 0;

    const vehicles = ctx.vehicles;
    if (vehicles && vehicles.length) {
      for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        if (!v || !v.position) continue;
        const fp = v.footprint || null;
        n = this._pushContact(n, v, fp ? fp.length : 9, fp ? fp.width : 4, 1, 7);
      }
    }

    for (let i = 0; i < cs.users.length; i++) {
      const u = cs.users[i];
      if (!u.target || !u.target.position) continue;
      n = this._pushContact(n, u.target, u.length, u.width, u.strength, u.fadeHeight);
    }

    mesh.count = n;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      cs.params.needsUpdate = true;
    }
    mesh.visible = n > 0;
  }

  /* ---- misc ------------------------------------------------------------- */

  _trackCenter(out) {
    const b = this.ctx.track && this.ctx.track.bounds;
    if (b && b.getCenter) return b.getCenter(out);
    return out.set(0, 0, 0);
  }

  setQuality(tier) {
    this._intervals = tier === 'low' ? [1, 3, 5, 6] : tier === 'medium' ? [1, 2, 4, 5] : [1, 2, 3, 4];
    const size = this._resolveShadowMapSize(Object.assign({}, this.ctx.settings, { quality: tier }));
    if (size === this.shadowMapSize) return;
    this.shadowMapSize = size;
    for (const c of this.cascades) {
      c.light.shadow.mapSize.set(size, size);
      // Force three to rebuild the render target at the new size.
      if (c.light.shadow.map) {
        c.light.shadow.map.dispose();
        c.light.shadow.map = null;
      }
      c.light.shadow.needsUpdate = true;
    }
  }

  /** Explicit fog override, for tracks that ship their own ambient block. */
  setFog(color, density) {
    if (!this.fog) return;
    if (color != null) this.fog.color.set(color);
    if (density != null) this.fog.density = density;
  }

  onResize() {}

  dispose() {
    for (const [, v] of this._envCache) {
      try {
        v.rt.dispose();
      } catch (e) {
        /* ignore */
      }
    }
    this._envCache.clear();
    this._envScene?.dispose();
    this._pmrem?.dispose();
    if (this.contact) {
      this.contact.geometry.dispose();
      this.contact.material.dispose();
    }
    for (const c of this.cascades) {
      if (c.light.shadow.map) c.light.shadow.map.dispose();
    }
    if (this.lamp && this.lamp.shadow.map) this.lamp.shadow.map.dispose();
    this.root.parent?.remove(this.root);
  }
}

export default Lighting;
