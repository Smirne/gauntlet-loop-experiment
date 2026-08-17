// vehicle/VehicleVisual.js — the car you actually look at.
//
// CarModels.js makes the geometry; this file turns it into a lit, painted,
// animated object and keeps it welded to the physics in Vehicle.js. Everything
// it draws is driven by real simulation state — there is no cosmetic
// approximation of suspension travel, wheel speed or brake heat anywhere in
// here, because the moment those drift apart from what the car is doing the
// whole thing reads as a toy animation instead of a machine.
//
// ------------------------------------------------------------------ hookups
//
// Vehicle.js constructs us with (ctx, vehicle, opts), awaits init(), then calls
// attach(vehicle.group). Because we take the attach() path, Vehicle owns the
// world transform and everything below is pure body-local maths — which is the
// same space CarModels authors in, so nothing ever needs converting.
//
// SUSPENSION  The hub's local Y is exact, not inferred:
//               hubLocalY = wheel.localY - (suspRest - wheel.compression)
//             falls straight out of how Vehicle._probeWheels casts the strut.
//             No matrix inverse, no world-space round trip, no lag.
//
// SPIN        Integrated from wheel.omega, which is the tyre model's own wheel
//             speed — so a locked wheel stops dead and a spinning one blurs,
//             and both agree with the smoke and the skid marks.
//
// ------------------------------------------------------------------- damage
//
// Scuffs and dirt are a shader term rather than a redrawn texture: rebuilding a
// 1024x512 canvas mid-race would stall the frame. The term is injected on top of
// Materials.carPaint's own patch (call the original onBeforeCompile first, then
// ours) and only ever references `vMapUv`, which three declares under the same
// USE_MAP guard the injected block is wrapped in. That is deliberate: a
// fragment block that names an identifier from the wrong shader stage silently
// fails to link and the car renders as nothing at all.

import * as THREE from 'three';
import { clamp, saturate, lerp, smoothstep } from '../core/Random.js';
import {
  buildChassis, chassisLivery, wheelTexture, liveryFor, bevelBox, plateTexture,
} from './CarModels.js';

const TAU = Math.PI * 2;

/* ==========================================================================
 * Scratch
 * ========================================================================== */

const _v = new THREE.Vector3();
const _col = new THREE.Color();
// Four hub records, reused every frame by the linkage solver.
const _hub = [
  { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 },
];

/** How dark each lighting preset is, which is what decides if lamps come on. */
const PRESET_DARKNESS = {
  morning: 0.0, noon: 0.0, overcast: 0.06, goldenHour: 0.24, dusk: 0.72, nightLamp: 1.0,
};

// Punctual lights are physically falling off since three r155, so a headlight
// budget is a real budget: every extra spotlight recompiles every material in
// the scene when the light count changes. Six across the whole field is plenty
// — the player's are the ones anybody looks at.
const SPOT_BUDGET = 6;
let _spotsUsed = 0;

/* ==========================================================================
 * Material bench
 * ========================================================================== */

/** Minimal stand-ins so a missing render/Materials.js costs polish, not cars. */
const FALLBACK = {
  carPaint: (o = {}) => new THREE.MeshPhysicalMaterial({
    color: o.color ?? 0xd6202a, metalness: 0.8, roughness: 0.3,
    clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.3,
  }),
  chrome: () => new THREE.MeshPhysicalMaterial({ color: 0xf2f3f5, metalness: 1, roughness: 0.08, envMapIntensity: 1.7 }),
  glass: (o = {}) => new THREE.MeshPhysicalMaterial({
    color: o.color ?? 0x2b3742, metalness: 0, roughness: 0.05, transparent: true,
    opacity: o.opacity ?? 0.42, clearcoat: 1, clearcoatRoughness: 0.02,
    envMapIntensity: 2, depthWrite: false,
  }),
  plasticToy: (o = {}) => new THREE.MeshPhysicalMaterial({
    color: o.color ?? 0x1b1d21, metalness: 0, roughness: 0.55,
    clearcoat: (o.gloss ?? 0.5) * 0.9, clearcoatRoughness: 0.12,
  }),
  lamp: (o = {}) => {
    const c = new THREE.Color(o.color ?? 0xfff2d0);
    return new THREE.MeshPhysicalMaterial({
      color: c, emissive: c, emissiveIntensity: o.intensity ?? 2.4,
      metalness: 0, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.03,
    });
  },
  surface: (kind, o = {}) => new THREE.MeshStandardMaterial({ color: 0x6a6d74, metalness: 0.85, roughness: 0.52 }),
};

function factory(ctx) {
  const M = ctx?.materials || ctx?.assets?.materials || null;
  const pick = (name) => (typeof M?.[name] === 'function' ? M[name].bind(M) : FALLBACK[name]);
  return {
    carPaint: pick('carPaint'),
    chrome: pick('chrome'),
    glass: pick('glass'),
    plasticToy: pick('plasticToy'),
    lamp: pick('lamp'),
    surface: pick('surface'),
    raw: M,
  };
}

/* --------------------------------------------------------------- wear GLSL */

// Self-contained: no reliance on any helper another module happens to inject.
const WEAR_DECL = /* glsl */`
uniform float uMgWear;
uniform float uMgDirt;
uniform vec3 uMgDust;
uniform vec3 uMgBare;
uniform vec3 uMgBands;
float mgvHash21( vec2 p ) {
  return fract( sin( dot( p, vec2( 91.37, 47.13 ) ) ) * 26571.531 );
}
float mgvNoise2( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = mgvHash21( i );
  float b = mgvHash21( i + vec2( 1.0, 0.0 ) );
  float c = mgvHash21( i + vec2( 0.0, 1.0 ) );
  float d = mgvHash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float mgvFbm( vec2 p ) {
  return mgvNoise2( p ) * 0.6 + mgvNoise2( p * 2.31 + 11.7 ) * 0.28 + mgvNoise2( p * 5.13 + 3.1 ) * 0.12;
}
`;

// uMgBands is (rightRoofV, leftRoofV, leftSillV) — the three boundaries that
// turn the ring unwrap back into "how high up the car am I", which is what
// dirt and scuffs actually key off.
const WEAR_BODY = /* glsl */`
#ifdef USE_MAP
{
  float mgU = vMapUv.x;
  float mgV = fract( vMapUv.y );
  float mgH;
  if ( mgV < uMgBands.x )        mgH = mgV / max( 1e-4, uMgBands.x );
  else if ( mgV < uMgBands.y )   mgH = 1.0;
  else if ( mgV < uMgBands.z )   mgH = 1.0 - ( mgV - uMgBands.y ) / max( 1e-4, uMgBands.z - uMgBands.y );
  else                           mgH = 0.0;

  // Grime climbs from the sills and pools in the shut lines.
  float mgBlot = mgvFbm( vec2( mgU * 9.0, mgV * 7.0 ) );
  float mgDirt = uMgDirt * ( 0.24 + 0.76 * pow( 1.0 - mgH, 1.7 ) ) * ( 0.45 + 0.75 * mgBlot );
  mgDirt = clamp( mgDirt, 0.0, 0.92 );
  diffuseColor.rgb = mix( diffuseColor.rgb, uMgDust, mgDirt * 0.78 );
  roughnessFactor = mix( roughnessFactor, 0.94, mgDirt * 0.85 );

  // Scuffs live on the corners a car actually hits, and run with the airflow.
  float mgEnd = max( smoothstep( 0.84, 1.0, mgU ), smoothstep( 0.16, 0.0, mgU ) );
  float mgFlank = 1.0 - abs( mgH - 0.46 ) * 1.5;
  float mgStreak = mgvFbm( vec2( mgU * 210.0, mgV * 26.0 ) );
  mgStreak = smoothstep( 0.56, 0.86, mgStreak );
  float mgScuff = uMgWear * clamp( 0.30 + 0.90 * mgEnd, 0.0, 1.4 ) * clamp( mgFlank, 0.0, 1.0 ) * mgStreak;
  mgScuff = clamp( mgScuff, 0.0, 1.0 );
  diffuseColor.rgb = mix( diffuseColor.rgb, uMgBare, mgScuff );
  roughnessFactor = mix( roughnessFactor, 0.40, mgScuff );
  metalnessFactor = mix( metalnessFactor, 0.88, mgScuff * 0.75 );
}
#endif
`;

/**
 * A car-paint material carrying its own livery, and its own wear state.
 *
 * Materials.carPaint caches by parameter signature, so every car would
 * otherwise share one material and one set of scuffs. We ask it for the
 * canonical paint, then build a sibling that reuses its compiled-in flake and
 * clearcoat patch — the injection closure and the program cache key are shared
 * deliberately, because three's own cache key already distinguishes the mapped
 * variant by its USE_MAP boolean.
 */
function makePaintMaterial(mats, livery, tex, opts = {}) {
  const base = mats.carPaint({
    color: 0xffffff,
    preset: livery.preset || 'metallic',
    flake: livery.flake ?? 0.55,
    flakeSize: opts.flakeSize ?? 0.014,
  });

  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: base.metalness ?? 0.34,
    roughness: base.roughness ?? 0.30,
    clearcoat: base.clearcoat ?? 1,
    clearcoatRoughness: base.clearcoatRoughness ?? 0.045,
    envMapIntensity: base.envMapIntensity ?? 1.35,
    ior: base.ior ?? 1.48,
    map: tex?.map || null,
    normalMap: tex?.normalMap || null,
    // The livery canvas punches its window openings out of the alpha channel,
    // so the shell has real holes and you look through the glazing into the
    // cabin instead of at a painted-on rectangle. Alpha *test* rather than
    // blending: it sorts correctly against everything, and three copies both
    // the map and the threshold onto the depth material, so the openings show
    // up in the shadow the car casts too.
    alphaTest: tex?.hasAperture ? 0.45 : 0,
  });
  mat.name = `carPaint:${livery.name}`;
  if (mat.normalScale) mat.normalScale.set(0.62, 0.62);
  if (base.envMap) mat.envMap = base.envMap;

  const wear = {
    uMgWear: { value: 0 },
    uMgDirt: { value: 0 },
    uMgDust: { value: new THREE.Color(0x6b5c46) },
    uMgBare: { value: new THREE.Color(0x9aa0a8) },
    uMgBands: { value: new THREE.Vector3(0.33, 0.5, 0.83) },
  };
  mat.userData.mgUniforms = base.userData?.mgUniforms || null;
  mat.userData.wear = wear;
  mat.userData.baseClearcoat = mat.clearcoat;
  mat.userData.baseRoughness = mat.roughness;

  const inner = base.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    if (typeof inner === 'function') {
      try { inner(shader); } catch (err) { console.warn('[VehicleVisual] paint patch failed', err); }
    }
    for (const k in wear) shader.uniforms[k] = wear[k];
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', `#include <common>\n${WEAR_DECL}`);
    fs = fs.replace('#include <metalnessmap_fragment>',
      `#include <metalnessmap_fragment>\n${WEAR_BODY}`);
    shader.fragmentShader = fs;
  };
  const innerKey = typeof base.customProgramCacheKey === 'function'
    ? base.customProgramCacheKey() : 'mg:paint';
  mat.customProgramCacheKey = () => `${innerKey}|wear`;
  mat.needsUpdate = true;
  return mat;
}

/* ==========================================================================
 * Shared assets
 * ========================================================================== */

let _shadowTex = null;

/** Soft elliptical blob, generated once for the whole game. */
function contactShadowTexture() {
  if (_shadowTex) return _shadowTex;
  if (typeof document === 'undefined') return null;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x / (S - 1)) * 2 - 1;
      const dy = (y / (S - 1)) * 2 - 1;
      const r = Math.hypot(dx, dy * 1.02);
      // Quadratic core with a long soft skirt: a linear falloff reads as a
      // decal, this reads as occlusion.
      const a = Math.pow(saturate(1 - r), 1.9) * (0.72 + 0.28 * Math.pow(saturate(1 - r), 4));
      const i = (y * S + x) * 4;
      img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0;
      img.data[i + 3] = Math.round(saturate(a) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  _shadowTex = new THREE.CanvasTexture(c);
  _shadowTex.colorSpace = THREE.NoColorSpace;
  _shadowTex.needsUpdate = true;
  return _shadowTex;
}

/* ==========================================================================
 * VehicleVisual
 * ========================================================================== */

export class VehicleVisual {
  /**
   * @param {object} ctx shared context
   * @param {object} vehicle the Vehicle that owns us
   * @param {object} opts { model, livery, isPlayer, parent, spec }
   */
  constructor(ctx, vehicle, opts = {}) {
    this.name = 'vehicleVisual';
    this.ctx = ctx || {};
    this.vehicle = vehicle || null;
    this.opts = opts;
    this.modelId = opts.model ?? vehicle?.modelId ?? 'muscle';
    this.liveryIndex = opts.livery ?? vehicle?.livery ?? 0;
    this.isPlayer = !!(opts.isPlayer ?? vehicle?.isPlayer);

    this.root = new THREE.Group();
    this.root.name = `visual:${vehicle?.id ?? this.modelId}`;
    this.body = new THREE.Group();
    this.body.name = 'body';
    this.root.add(this.body);

    this.chassis = null;
    this.livery = null;
    this.materials = {};
    this.meshes = [];
    this.wheels = [];
    this.arms = [];
    this.axles = [];
    this.spots = [];
    this.contact = null;   // fallback blob mesh, only when there is no Lighting
    this._csEntry = null;  // handle from Lighting.addContactShadow
    this._ownGeoms = [];   // geometry this car minted rather than shared

    /* --- animation state ------------------------------------------------- */
    this._spin = [0, 0, 0, 0];
    this._brakeHeat = [0, 0, 0, 0];
    this._pitch = 0;
    this._roll = 0;
    this._heave = 0;
    this._darkness = 0;
    this._lampMix = 0;
    this._brakeMix = 0;
    this._reverseMix = 0;
    this._wear = 0;
    this._dirt = 0;
    this._ready = false;
    this._disposed = false;
    this._ownContact = false;
    this._restHubY = 0;
    this._suspRest = 1.3;
    this._frame = 0;
  }

  /* ====================================================================== */

  async init(ctx, vehicle) {
    if (ctx) this.ctx = ctx;
    if (vehicle) this.vehicle = vehicle;
    const c = this.ctx;
    const v = this.vehicle;

    const quality = c?.settings?.quality || 'high';
    const texSize = quality === 'low' ? 512 : quality === 'medium' ? 768 : 1024;

    this.chassis = buildChassis(this.modelId, { quality });
    const skin = chassisLivery(this.chassis, this.liveryIndex, {
      size: texSize,
      anisotropy: c?.settings?.render?.anisotropy ?? 8,
    });
    this.livery = skin.livery || liveryFor(this.modelId, this.liveryIndex);

    const mats = factory(c);
    this._buildMaterials(mats, skin);
    this._buildBody();
    this._buildWheels(mats);
    this._buildLinkage(mats);
    this._buildLights();
    this._buildContactShadow();

    // Suspension geometry we need every frame, resolved once.
    const t = v?.tuning;
    this._suspRest = t?.suspRest ?? 1.3;
    this._restHubY = (t?.wheelRadius ?? 1.15) - (t?.cgHeight ?? 1.25);

    // Lighting reads this for the grounding blob under every car.
    if (v) {
      v.footprint = { length: this.chassis.footprint.length, width: this.chassis.footprint.width };
      v.visualBounds = this.chassis.footprint;
    }

    this._ready = true;
    return this;
  }

  /** Vehicle.js prefers this hook; taking it means Vehicle owns our transform. */
  attach(parent) {
    if (!parent || !parent.isObject3D) return this;
    if (this.root.parent !== parent) parent.add(this.root);
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
    this.root.scale.set(1, 1, 1);
    return this;
  }

  /* ---------------------------------------------------------- materials */

  _buildMaterials(mats, skin) {
    const lv = this.livery;
    const M = this.materials;
    const bands = this.chassis.uv.bands;

    M.paint = makePaintMaterial(mats, lv, skin, {});
    const wear = M.paint.userData.wear;
    wear.uMgBands.value.set(bands[2], bands[3], bands[5]);
    wear.uMgDust.value.set(0x6d5f49);
    wear.uMgBare.value.set(lv.preset === 'matte' ? 0x8d9298 : 0xa6acb4);

    M.accent = mats.carPaint({
      color: lv.accent ?? 0xf0f2f5,
      preset: lv.preset === 'matte' ? 'matte' : 'solid',
      flake: 0.18,
    });
    M.chrome = mats.chrome({});
    M.glass = mats.glass({
      color: lv.glassTint ?? 0x1e2831,
      // Face-on transmission drops so the cabin behind the pane is legible;
      // the grazing end is where the screen picks up the window. Both numbers
      // are deliberately short of a real Fresnel's 1.0: the glazing strip is a
      // band of the body surface, so it lies over painted roof as well as over
      // the openings, and a physically honest grazing alpha turned the whole
      // shoulder into frosted plastic. At 0.62 it reads as lacquer over the
      // paint and as glass over a hole, which is the read that matters.
      opacity: 0.30,
      // Both of these were tuned before the pane was drawing at all, against a
      // brighter environment than the one that shipped. Measured on the macro
      // frame the side glass clipped at 254,251,234 with no cabin visible
      // behind it — a white slab over an interior that is fully modelled. At
      // envMapIntensity 1.5 the sky reflection alone exceeded display white at
      // the shallow flank angle the macro camera uses, and edgeOpacity 0.62
      // then compounded it, because that angle is almost all "edge". 0.52 keeps
      // the lacquer-over-paint read the number was chosen for; 0.5 leaves a
      // real reflection without it being the only thing the pane returns.
      edgeOpacity: 0.52,
      envMapIntensity: 0.5,
    });
    M.trim = mats.plasticToy({ color: 0x1a1c20, gloss: 0.35 });
    M.grille = mats.plasticToy({ color: 0x0d0f12, gloss: 0.18 });
    // The rear number plate. Every other substance on the tail — paint, plated
    // trim, black plastic, a barely-emissive lens — either returns the key or
    // returns nothing, so with the sun off that face the whole panel goes to one
    // value. A pressed blank at 0.58 linear is brighter than any paint in the
    // roster *in shadow*, and it is the one element whose read does not depend
    // on catching anything.
    //
    // The blank now carries characters. Dark glyphs on a light ground is the
    // highest-contrast element anywhere on the car, and it is what actually
    // identifies a die-cast from behind — a white rectangle is as much of a
    // placeholder as the painted slab it replaced. Cloned rather than tinted in
    // place because plasticToy is cached by signature and every other black
    // plastic part on every car would inherit the map.
    M.plate = mats.plasticToy({ color: 0xc9ccd2, gloss: 0.45 });
    try {
      const pt = plateTexture(`MG ${String(lv.number ?? 1).padStart(2, '0')}`,
        { size: this.ctx?.settings?.quality === 'low' ? 256 : 512 });
      if (pt.map) {
        const own = M.plate.clone();
        own.name = 'plate';
        own.color.setHex(0xffffff);   // the blank's value now comes from the map
        own.map = pt.map;
        own.normalMap = pt.normalMap || null;
        if (own.normalScale) own.normalScale.set(0.85, 0.85);
        own.userData = { ...(own.userData || {}), mgOwned: true };
        own.needsUpdate = true;
        M.plate = own;
      }
    } catch (err) {
      console.warn('[VehicleVisual] plate texture failed', err);
    }
    // The cabin is now something you can see into, so it has to be a material
    // rather than a hole: near-black returns nothing through the glass and the
    // window reads as a painted rectangle again. Moulded dark grey with a
    // little sheen catches the sky and gives the aperture depth.
    M.interior = mats.plasticToy({ color: 0x33353b, gloss: 0.22 });
    // Looking in through the near window you can see the far door card, whose
    // outward face points away from you; without this the cabin has a hole in
    // it that you can see the track through.
    if (M.interior && M.interior.side !== THREE.DoubleSide) M.interior.side = THREE.DoubleSide;
    try {
      M.base = mats.surface('galvanisedSteel', { repeat: 3, normalScale: 0.7 });
    } catch (_) {
      M.base = mats.plasticToy({ color: 0x4a4d53, gloss: 0.3 });
    }
    if (!M.base) M.base = mats.plasticToy({ color: 0x4a4d53, gloss: 0.3 });

    // Lamps are per car so their emissive can be driven independently.
    const lamp = (color, intensity) => {
      const src = mats.lamp({ color, intensity });
      let m;
      try { m = src.clone(); } catch (_) { m = null; }
      if (!m) m = FALLBACK.lamp({ color, intensity });
      m.emissive = new THREE.Color(color);
      m.emissiveIntensity = intensity;
      m.userData = {};
      return m;
    };
    M.lampClear = lamp(0xfff0d4, 0.22);
    M.lampRed = lamp(0xff2418, 0.30);
    M.lampAmber = lamp(0xffb038, 0.20);
    M.lampClear.userData.peak = 5.2;
    M.lampRed.userData.peak = 6.0;
    M.lampAmber.userData.peak = 4.2;

    /* --- wheels --------------------------------------------------------- */
    const wf = this.chassis.wheels.front;
    const wr = this.chassis.wheels.rear;
    const tyreTex = wheelTexture(wf, { size: this.ctx?.settings?.quality === 'low' ? 512 : 1024 });
    // DEFECTS D3 was real: a 0x303236 tint over a 0.019 albedo gave 0.0006
    // linear, which is a hole rather than a substance. The correction then
    // overshot in the other direction, and the overshoot was almost all in
    // this material rather than in the texture.
    //
    // three multiplies `sheenColor` by `sheen` into one uniform (see
    // refreshMaterialUniforms), so the old pair was an *additive* Charlie lobe
    // with an albedo of linear(0x8f) * 0.6 = 0.165 — two and a half times the
    // diffuse albedo underneath it, spread broadly by sheenRoughness 0.8 over
    // the whole carcass. That single term is why the tyre measured luma 95-115
    // and out-valued both the sunlit paint and the sunlit table. envMapIntensity
    // 0.95 compounded it: on a Physical material that scales the diffuse
    // irradiance as well as the specular radiance, so the rubber was also
    // collecting a full share of sky.
    //
    // The lobe is kept, because D3's lesson is that a dark object with no
    // specular response reads as a void — a broad grazing sheen is exactly what
    // traces the sidewall bulge and separates the tread shoulder from the
    // underbody, where a narrow GGX one returns nothing. It is kept at
    // linear(0x45) * 0.34 = 0.021, an eighth of what it was: still visible as a
    // soft rolled highlight, no longer a light source.
    M.tyre = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: tyreTex.map || null,
      normalMap: tyreTex.normalMap || null,
      metalness: 0,
      roughness: 0.78,
      envMapIntensity: 0.45,
      sheen: 0.34,
      sheenRoughness: 0.85,
      sheenColor: new THREE.Color(0x454340),
    });
    M.tyre.name = 'tyre';
    if (M.tyre.normalScale) M.tyre.normalScale.set(1.1, 1.1);
    // The tyre is the only part of the car that actually touches the ground, and
    // three's default depth pass renders the *back* faces of a FrontSide
    // material (shadowSide table in WebGLShadowMap). For a 2.3 u wheel that puts
    // the occluder recorded in the shadow map a wheel-diameter behind the rubber
    // that is really blocking the light, so the cast shadow starts short of the
    // contact patch and the tyre peter-pans. Recording the near surface instead
    // puts the occluder where it is. Only the tyres get this: on a thin, dark,
    // rough surface the self-shadow acne that front-face depth risks is
    // invisible, where on the paint it would not be — and the paint is 20 u
    // thick, so it has nothing to gain here anyway.
    M.tyre.shadowSide = THREE.FrontSide;
    if (wr !== wf) {
      const t2 = wheelTexture(wr, { size: this.ctx?.settings?.quality === 'low' ? 512 : 1024 });
      M.tyreRear = M.tyre.clone();
      M.tyreRear.map = t2.map || null;
      M.tyreRear.normalMap = t2.normalMap || null;
      M.tyreRear.shadowSide = THREE.FrontSide;
      M.tyreRear.needsUpdate = true;
    } else {
      M.tyreRear = M.tyre;
    }

    const rimKind = lv.rim || 'chrome';
    if (rimKind === 'chrome') M.rim = mats.chrome({});
    else if (rimKind === 'gold') M.rim = mats.carPaint({ color: 0xc9a24a, preset: 'chromeish', flake: 0.3 });
    else if (rimKind === 'white') M.rim = mats.carPaint({ color: 0xeceef1, preset: 'solid', flake: 0.1 });
    else if (rimKind === 'accent') M.rim = mats.carPaint({ color: lv.accent ?? 0xd0202c, preset: 'metallic', flake: 0.4 });
    else M.rim = mats.carPaint({ color: 0x2a2d33, preset: 'metallic', flake: 0.35 });
    M.rimTrim = mats.chrome({});
    M.caliper = mats.plasticToy({ color: lv.accent ?? 0xd0202c, gloss: 0.85 });

    // One disc material per corner: the fronts glow long before the rears do,
    // and a locked rear on the handbrake has to be able to catch up on its own.
    M.discs = [];
    for (let i = 0; i < 4; i++) {
      const d = new THREE.MeshStandardMaterial({
        color: 0x8c9198, metalness: 0.92, roughness: 0.34,
        emissive: new THREE.Color(0x000000), emissiveIntensity: 1,
      });
      d.name = `brakeDisc${i}`;
      M.discs.push(d);
    }
  }

  /* ------------------------------------------------------------- assembly */

  _mesh(geometry, material, name, cast = true, receive = true) {
    const m = new THREE.Mesh(geometry, material);
    m.name = name;
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.matrixAutoUpdate = false;
    this.meshes.push(m);
    return m;
  }

  _buildBody() {
    const roleMat = {
      paint: 'paint', accent: 'accent', chrome: 'chrome', glass: 'glass',
      trim: 'trim', grille: 'grille', interior: 'interior', base: 'base',
      lampClear: 'lampClear', lampRed: 'lampRed', lampAmber: 'lampAmber',
      plate: 'plate',
    };
    for (const part of this.chassis.parts) {
      const key = roleMat[part.role] || 'trim';
      const mat = this.materials[key] || this.materials.trim;
      // Glazing and lamp lenses would only ever cast a shadow of themselves
      // onto the paint a millimetre behind them: pure cost, no image.
      const light = part.role === 'glass' || part.role.startsWith('lamp');
      const m = this._mesh(part.geometry, mat, `car:${part.role}`, !light, part.role !== 'glass');
      if (part.role === 'glass') m.renderOrder = 2;
      m.updateMatrix();
      this.body.add(m);
    }
  }

  _buildWheels(mats) {
    const c = this.chassis;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const left = (i & 1) === 0;
      const set = front ? c.wheels.front : c.wheels.rear;

      const pivot = new THREE.Group();
      pivot.name = `wheelPivot${i}`;
      const spin = new THREE.Group();
      spin.name = `wheelSpin${i}`;
      pivot.add(spin);

      spin.add(this._mesh(set.tyre, front ? this.materials.tyre : this.materials.tyreRear, `tyre${i}`));
      spin.add(this._mesh(set.rim, this.materials.rim, `rim${i}`));
      spin.add(this._mesh(set.rimTrim, this.materials.rimTrim, `rimTrim${i}`, false, true));
      const disc = this._mesh(set.disc, this.materials.discs[i], `disc${i}`, false, true);
      spin.add(disc);
      pivot.add(this._mesh(set.caliper, this.materials.caliper, `caliper${i}`, false, true));

      for (const child of spin.children) child.updateMatrix();
      for (const child of pivot.children) if (child.isMesh) child.updateMatrix();

      this.root.add(pivot);
      this.wheels.push({ pivot, spin, set, front, left, sideSign: left ? 1 : -1, hubLift: set.hubLift || 0 });
    }
  }

  /** Exposed suspension: wishbones, radius rods, shocks and live axles. */
  _buildLinkage(mats) {
    const c = this.chassis;
    if (!c.arms && !c.liveAxle) return;
    // One rounded unit cube, stretched per frame into every link on the car.
    const unit = bevelBox(1, 1, 1, 0.22, 2);

    if (c.arms) {
      const a = c.arms;
      const mat = this.materials[a.role] || this.materials.trim;
      for (let i = 0; i < 4; i++) {
        const left = (i & 1) === 0;
        const entries = [];
        for (const lvl of a.levels) {
          const m = this._mesh(unit, mat, `arm${i}`, true, true);
          this.root.add(m);
          entries.push({ mesh: m, lvl, radius: a.radius });
        }
        let shock = null;
        if (a.shock) {
          const m = this._mesh(unit, this.materials.accent, `shock${i}`, true, true);
          this.root.add(m);
          shock = { mesh: m, cfg: a.shock };
        }
        this.arms.push({ index: i, left, entries, shock });
      }
    }

    if (c.liveAxle) {
      const la = c.liveAxle;
      const mat = this.materials[la.role] || this.materials.trim;
      const diffGeo = new THREE.SphereGeometry(la.diff ?? 0.5, 14, 10);
      this._ownGeoms.push(diffGeo);
      for (const which of ['front', 'rear']) {
        const tube = this._mesh(unit, mat, `axle:${which}`, true, true);
        const diff = this._mesh(diffGeo, mat, `diff:${which}`, true, true);
        this.root.add(tube);
        this.root.add(diff);
        this.axles.push({ which, tube, diff, r: la.r ?? 0.3 });
      }
    }
    this._unitGeom = unit;
  }

  _buildLights() {
    const heads = this.chassis.lights.head || [];
    if (!heads.length) return;
    const want = this.isPlayer ? 2 : 1;
    for (let i = 0; i < want && i < heads.length; i++) {
      if (_spotsUsed >= SPOT_BUDGET) break;
      const h = this.isPlayer ? heads[i] : heads[0];
      const spot = new THREE.SpotLight(0xfff0d0, 0, 220, 0.42, 0.55, 1.6);
      spot.name = `headlight${i}`;
      spot.position.set(this.isPlayer ? h.x : 0, h.y + 0.1, h.z);
      spot.target.position.set(this.isPlayer ? h.x * 1.6 : 0, h.y - 3.2, h.z + 26);
      spot.castShadow = false;
      spot.visible = false;
      this.body.add(spot);
      this.body.add(spot.target);
      this.spots.push(spot);
      _spotsUsed++;
    }
  }

  /**
   * Grounding.
   *
   * render/Lighting.js owns the contact-shadow pool for the whole game, so the
   * car registers with it rather than drawing its own quad: one instanced draw
   * for every blob in the scene, and a blob that knows the car's real wheel
   * contact normals so it lies in the surface plane on a bank or a ramp.
   *
   * This used to *detect* that API and then return without building anything,
   * on the assumption that something else was calling it. Nothing was, so every
   * car in the game had no contact shadow at all — which the contract calls an
   * automatic fail. Detecting the API is now the trigger to use it.
   */
  _buildContactShadow() {
    const lighting = this.ctx?.lighting;
    const v = this.vehicle;
    if (lighting && typeof lighting.addContactShadow === 'function') {
      const fp = this.chassis.footprint;
      try {
        // The vehicle field claims the car, so Lighting suppresses its own
        // automatic blob and this one cannot double up on it. Without a Vehicle (the
        // car-select turntable) the visual root is the target and its own base
        // is the ground.
        this._csEntry = lighting.addContactShadow(v || this.root, {
          vehicle: v || null,
          // The occlusion under a car is wider than the car: it takes in both
          // tyre contact patches and the shadowed air under the sills.
          length: fp.length * 1.28,
          width: fp.width * 1.68,
          opacity: 1,
          maxHeight: 9,
          softness: 0.38,
          // Vehicle.position is the centre of mass; the contact patch is
          // cgHeight below it. Measuring from the origin fades a resting car's
          // blob to half strength.
          baseOffset: v ? (v.tuning?.cgHeight ?? 1.25) : 0,
          grounded: !v,
          lift: 0.05,
        }) || null;
      } catch (err) {
        console.warn('[VehicleVisual] contact shadow registration failed', err);
        this._csEntry = null;
      }
      if (this._csEntry) return;
    }
    const tex = contactShadowTexture();
    if (!tex || !this.ctx?.scene) return;
    const fp = this.chassis.footprint;
    const geo = new THREE.PlaneGeometry(fp.width * 1.75, fp.length * 1.28).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.7, depthWrite: false,
      blending: THREE.NormalBlending, toneMapped: false, color: 0x1a1712,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'contactShadow';
    mesh.renderOrder = -5;
    mesh.frustumCulled = false;
    this.ctx.scene.add(mesh);
    this.contact = { mesh, geo, mat };
    this._ownContact = true;
  }

  /* ====================================================================== *
   * Per-frame
   * ====================================================================== */

  update(dt, ctx, vehicle) {
    if (!this._ready || this._disposed) return;
    const v = vehicle || this.vehicle;
    if (!v) return;
    if (ctx) this.ctx = ctx;
    const d = clamp(dt || 0, 0, 0.05);
    this._frame++;

    this._updateWheels(d, v);
    this._updateBodyAttitude(d, v);
    this._updateLinkage(v);
    this._updateWear(d, v);
    this._updateLamps(d, v);
  }

  lateUpdate(dt, ctx, vehicle) {
    if (!this._ready || this._disposed) return;
    if (this._ownContact) this._updateContactShadow(vehicle || this.vehicle);
  }

  /* ------------------------------------------------------------- wheels */

  _updateWheels(dt, v) {
    const susp = v.tuning?.suspRest ?? this._suspRest;
    for (let i = 0; i < 4; i++) {
      const w = v.wheels?.[i];
      const vis = this.wheels[i];
      if (!w || !vis) continue;

      // Exact inverse of Vehicle._probeWheels: hitDist - radius == suspRest -
      // compression, so the hub sits at the mount minus the travel used.
      const travel = clamp(susp - (w.compression || 0), -0.05, susp * 1.25);
      const hubY = w.localY - travel + vis.hubLift;

      vis.pivot.position.set(w.localX, hubY, w.localZ);
      // The right-hand wheels are turned through half a revolution so their
      // dished face points outboard; that flips their spin axis with them.
      vis.pivot.rotation.y = (w.steerAngle || 0) + (vis.left ? 0 : Math.PI);

      this._spin[i] = (this._spin[i] + (w.omega || 0) * dt) % TAU;
      vis.spin.rotation.x = this._spin[i] * vis.sideSign;

      // Cache the hub for the linkage solver, which runs after every wheel.
      _hub[i].x = w.localX;
      _hub[i].y = hubY;
      _hub[i].z = w.localZ;

      /* --- brake heat -------------------------------------------------- */
      const surfaceSpeed = Math.abs(w.omega || 0) * (w.radius || 1.15);
      const cmd = vis.front
        ? (v.brake || 0) * (v.tuning?.brakeBias ?? 0.62)
        : Math.max((v.brake || 0) * (1 - (v.tuning?.brakeBias ?? 0.62)), (v.brakeLight || 0) - (v.brake || 0));
      const work = saturate(cmd * 1.5) * saturate(surfaceSpeed / 46);
      const heat = this._brakeHeat[i];
      const rate = work > heat ? 1.35 : 0.60;
      this._brakeHeat[i] = clamp(heat + (work - heat) * saturate(dt * rate * 2.2), 0, 1);

      const mat = this.materials.discs[i];
      const h = this._brakeHeat[i];
      if (h > 0.02) {
        // Black body-ish ramp: dull cherry through orange, never white.
        _col.setRGB(1, 0.16 + 0.34 * h, 0.02 + 0.06 * h);
        mat.emissive.copy(_col);
        mat.emissiveIntensity = Math.pow(h, 2.2) * 4.6;
        mat.roughness = lerp(0.34, 0.52, h);
      } else if (mat.emissiveIntensity !== 0) {
        mat.emissive.setRGB(0, 0, 0);
        mat.emissiveIntensity = 0;
        mat.roughness = 0.34;
      }
    }
  }

  /* ------------------------------------------------------------ attitude */

  /**
   * Visual dive, squat and roll layered over the rigid body's own motion.
   *
   * The suspension in Vehicle.js already pitches and rolls the chassis for
   * real; this adds a small, critically-damped exaggeration on top, of the
   * order of two degrees. Arcade racers all do it and it is the difference
   * between a car that transfers weight and a car that looks like it does.
   */
  _updateBodyAttitude(dt, v) {
    const k = saturate(dt * 9);
    const longG = clamp(v.longitudinalG || 0, -2.5, 2.5);
    const latG = clamp(v.lateralG || 0, -2.5, 2.5);

    // Positive rotation about +X drops the nose; braking is negative longG.
    const tPitch = clamp(-longG * 0.020, -0.052, 0.038);
    // Positive rotation about +Z lifts the car's left, which is what a car
    // cornering left (positive lateral G) does.
    const tRoll = clamp(latG * 0.024, -0.055, 0.055);
    const tHeave = -clamp(Math.abs(longG) * 0.035 + Math.abs(latG) * 0.020, 0, 0.11);

    this._pitch += (tPitch - this._pitch) * k;
    this._roll += (tRoll - this._roll) * k;
    this._heave += (tHeave - this._heave) * k;

    this.body.rotation.set(this._pitch, 0, this._roll);
    this.body.position.y = this._heave;
  }

  /* ------------------------------------------------------------- linkage */

  _updateLinkage(v) {
    if (!this.arms.length && !this.axles.length) return;

    for (const arm of this.arms) {
      const hub = _hub[arm.index];
      if (!hub) continue;
      const side = arm.left ? 1 : -1;
      for (const e of arm.entries) {
        const mx = side * Math.abs(hub.x) * e.lvl.x;
        const my = this._restHubY + e.lvl.y;
        const mz = hub.z + (e.lvl.z || 0);
        const dx = hub.x - mx;
        const dy = hub.y - my;
        const dz = hub.z - mz;
        const len = Math.hypot(dx, dy, dz) || 0.01;
        e.mesh.position.set((mx + hub.x) * 0.5, (my + hub.y) * 0.5, (mz + hub.z) * 0.5);
        // The link lies in a plane of constant Z apart from a small rake, so a
        // yaw then a roll is an exact orientation, no lookAt needed.
        e.mesh.rotation.set(0, Math.atan2(-dz, dx), Math.asin(clamp(dy / len, -1, 1)));
        e.mesh.scale.set(len, e.radius * 2, e.radius * 2);
        e.mesh.updateMatrix();
      }
      if (arm.shock) {
        const cfg = arm.shock.cfg;
        const mx = side * Math.abs(hub.x) * cfg.x;
        const my = this._restHubY + cfg.y;
        const dx = hub.x - mx;
        const dy = hub.y - my;
        const len = Math.hypot(dx, dy) || 0.01;
        const m = arm.shock.mesh;
        m.position.set((mx + hub.x) * 0.5, (my + hub.y) * 0.5, hub.z);
        m.rotation.set(0, 0, Math.atan2(dy, dx));
        m.scale.set(len, cfg.r * 2, cfg.r * 2);
        m.updateMatrix();
      }
    }

    for (const ax of this.axles) {
      const iL = ax.which === 'front' ? 0 : 2;
      const l = _hub[iL];
      const r = _hub[iL + 1];
      if (!l || !r) continue;
      const cx = (l.x + r.x) * 0.5;
      const cy = (l.y + r.y) * 0.5;
      const cz = (l.z + r.z) * 0.5;
      const dx = l.x - r.x;
      const dy = l.y - r.y;
      const len = Math.hypot(dx, dy) || 0.01;
      ax.tube.position.set(cx, cy, cz);
      ax.tube.rotation.set(0, 0, Math.atan2(dy, dx));
      ax.tube.scale.set(len, ax.r * 2, ax.r * 2);
      ax.tube.updateMatrix();
      ax.diff.position.set(cx, cy, cz + (ax.which === 'front' ? 0.32 : -0.32));
      ax.diff.updateMatrix();
    }
  }

  /* ---------------------------------------------------------------- wear */

  _updateWear(dt, v) {
    const paint = this.materials.paint;
    const wear = paint?.userData?.wear;
    if (!wear) return;
    const targetWear = saturate((v.scuff || 0) * 0.85 + (v.damage || 0) * 0.55);
    const targetDirt = saturate(v.dirt || 0);
    // Paint comes off instantly and washes back slowly, which is what makes a
    // long race legible: you can see who has been in the wars.
    const upW = targetWear > this._wear ? 6 : 0.7;
    const upD = targetDirt > this._dirt ? 3.5 : 1.2;
    this._wear += (targetWear - this._wear) * saturate(dt * upW);
    this._dirt += (targetDirt - this._dirt) * saturate(dt * upD);
    wear.uMgWear.value = this._wear;
    wear.uMgDirt.value = this._dirt;

    // Clearcoat is a material property, not a uniform: scuffed lacquer stops
    // returning that second specular lobe and the car visibly dulls.
    const base = paint.userData.baseClearcoat ?? 1;
    const cc = base * (1 - 0.62 * this._wear) * (1 - 0.28 * this._dirt);
    if (Math.abs(paint.clearcoat - cc) > 0.005) {
      paint.clearcoat = cc;
      paint.clearcoatRoughness = lerp(0.045, 0.30, saturate(this._wear + this._dirt * 0.6));
    }
  }

  /* -------------------------------------------------------------- lights */

  _updateLamps(dt, v) {
    const M = this.materials;
    const preset = this.ctx?.lighting?.presetName;
    const dark = PRESET_DARKNESS[preset] ?? this._darkness;
    this._darkness += (dark - this._darkness) * saturate(dt * 2.5);

    const on = this._darkness > 0.24 ? 1 : 0;
    this._lampMix += (on - this._lampMix) * saturate(dt * 6);
    const brakeTarget = saturate(v.brakeLight || 0);
    this._brakeMix += (brakeTarget - this._brakeMix) * saturate(dt * 18);
    const revTarget = saturate(v.reverseLight || 0);
    this._reverseMix += (revTarget - this._reverseMix) * saturate(dt * 12);

    if (M.lampClear) {
      M.lampClear.emissiveIntensity = lerp(0.18, M.lampClear.userData.peak, this._lampMix);
    }
    if (M.lampRed) {
      // Tail lights idle dim at night and slam bright under braking — the
      // single most legible signal in a pack, so it gets real range.
      const idle = lerp(0.10, 1.15, this._lampMix);
      M.lampRed.emissiveIntensity = idle + this._brakeMix * M.lampRed.userData.peak;
    }
    if (M.lampAmber) {
      M.lampAmber.emissiveIntensity = lerp(0.08, 0.55, this._lampMix) + this._reverseMix * M.lampAmber.userData.peak;
    }

    for (const s of this.spots) {
      const want = this._lampMix > 0.02;
      if (s.visible !== want) s.visible = want;
      if (!want) continue;
      // Punctual intensity is candela and falls off as distance^decay, so the
      // number that matters is the irradiance where the beam lands: 900 cd at
      // decay 1.6 puts roughly 7 on the road 20 u ahead, which sits alongside
      // Lighting's own lamp rather than blowing straight through the grade.
      s.intensity = this._lampMix * 900;
    }
  }

  /* ------------------------------------------------------------- shadow */

  _updateContactShadow(v) {
    const c = this.contact;
    if (!c || !v) return;
    const p = v.position;
    let gy = 0;
    const track = this.ctx?.track;
    if (track && typeof track.heightAt === 'function') {
      try {
        const y = track.heightAt(p.x, p.z);
        if (Number.isFinite(y)) gy = y;
      } catch (_) { /* flat fallback */ }
    }
    const h = Math.max(0, p.y - (v.tuning?.cgHeight ?? 1.25) - gy);
    const lift = saturate(h / 7);
    const fade = (1 - lift) * (1 - lift);
    if (fade <= 0.004) {
      c.mesh.visible = false;
      return;
    }
    c.mesh.visible = true;
    c.mat.opacity = 0.66 * fade;
    const spread = 1 + lift * 0.9;
    // Only the yaw belongs in a ground decal: the blob must stay flat on the
    // floor while the car rolls and pitches over it.
    _v.set(0, 0, 1).applyQuaternion(v.quaternion);
    const yaw = Math.atan2(_v.x, _v.z);
    c.mesh.position.set(p.x, gy + 0.09, p.z);
    c.mesh.rotation.set(0, yaw, 0);
    c.mesh.scale.set(spread, 1, spread);
  }

  /* ====================================================================== */

  /** Snapshot for the debug overlay and the car-select screen. */
  describe() {
    return {
      model: this.modelId,
      name: this.chassis?.def?.name,
      livery: this.livery?.name,
      stats: this.chassis?.stats || null,
      meshes: this.meshes.length,
      spots: this.spots.length,
      brakeHeat: this._brakeHeat.map((h) => +h.toFixed(2)),
      wear: +this._wear.toFixed(2),
      dirt: +this._dirt.toFixed(2),
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const s of this.spots) {
      s.parent?.remove(s);
      s.target?.parent?.remove(s.target);
      s.dispose?.();
    }
    _spotsUsed = Math.max(0, _spotsUsed - this.spots.length);
    this.spots.length = 0;

    if (this._csEntry) {
      // Hand the pool slot back, or a restarted race leaks a blob per car.
      try { this.ctx?.lighting?.removeContactShadow?.(this._csEntry); } catch (_) { /* already gone */ }
      this._csEntry = null;
    }
    if (this.contact) {
      this.contact.mesh.parent?.remove(this.contact.mesh);
      this.contact.geo.dispose();
      this.contact.mat.dispose();
      this.contact = null;
    }
    this._unitGeom?.dispose?.();
    for (const g of this._ownGeoms) g.dispose?.();
    this._ownGeoms.length = 0;

    // Only the materials this car minted for itself. Chassis geometry, livery
    // textures and everything that came out of the shared Materials cache
    // belong to CarModels and render/Materials, not to us.
    const owned = new Set([
      this.materials.paint, this.materials.tyre, this.materials.tyreRear,
      this.materials.lampClear, this.materials.lampRed, this.materials.lampAmber,
      // Only if it is the clone we minted to carry this car's plate texture —
      // without a texture M.plate is still the shared cached plastic, and
      // disposing that takes every other car's black trim with it. The texture
      // itself is cached in CarModels and is not ours to free either way.
      this.materials.plate?.userData?.mgOwned ? this.materials.plate : null,
      ...(this.materials.discs || []),
    ]);
    owned.delete(undefined);
    owned.delete(null);
    for (const m of owned) m.dispose?.();

    this.root.parent?.remove(this.root);
    this.meshes.length = 0;
    this.wheels.length = 0;
    this.arms.length = 0;
    this.axles.length = 0;
    this.materials = {};
  }
}

/** Convenience for anything that wants a car outside a Vehicle (car select). */
export function createVehicleVisual(ctx, vehicle, opts) {
  return new VehicleVisual(ctx, vehicle, opts);
}

export default VehicleVisual;
