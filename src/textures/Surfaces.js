// textures/Surfaces.js — the named surface library.
//
// ProcTex.js knows how to turn noise into pixels. This module knows what those
// pixels *mean*: how much grip a tyre finds on them, how much they slow a car
// that leaves the racing line, what flies up when a wheel spins, what the
// contact sounds like, and whether being there should count as off-track at
// all. One name — 'oak', 'poolFelt', 'gravel' — is the single key that the
// track builder, the tyre model, the particle system and the audio engine all
// look things up under, which is what keeps them agreeing with each other.
//
// It also owns the texture cache, and the loading strategy that goes with it.
// A 2048² bake of oak is roughly a second of pure JavaScript, so baking every
// surface up front would put a multi-second stall in the boot. Instead the
// first request for a surface bakes a fast draft (a genuine, complete, if
// slightly soft version of the material — never a placeholder colour) and
// hands it back immediately, then queues the full-resolution bake on idle
// time. Because the upgrade mutates the texture's Source in place, every
// material already holding a reference picks up the sharp version silently on
// the next frame.

import * as PT from './ProcTex.js';
import * as Cfg from '../core/Settings.js';

const Settings = Cfg.Settings ?? Cfg.default ?? {
  textures: { resolution: 1024, maxResolution: 2048, cacheBudgetMB: 256 },
  render: { anisotropy: 8 },
};

const clamp = PT.clamp;

/* ================================================================== defaults */

// Grip is a multiplier on the tyre model's peak friction, with a good plank
// table as the 1.0 reference — that is the surface most of the game is raced
// on, so tuning everything relative to it keeps the numbers legible.
//
// rollDrag is a rolling-resistance coefficient applied per second of contact.
// The spread matters more than the absolute values: 0.009 (laminate) to 0.12
// (gravel) is a factor of thirteen, which is what makes cutting a corner
// across the sandbox a real decision rather than a cosmetic one.

const BASE = {
  grip: 1,
  rollDrag: 0.012,
  offTrack: false,
  particle: 'dust',
  particleRate: 1,
  particleColor: 0xb9a68c,
  skidTint: 0x1a1a1a,
  category: 'hard',
  audio: {
    timbre: 'hard',
    rollGain: 0.5,
    rollFilter: 0.6,
    rollGrain: 0.15,
    skidGain: 0.9,
    skidFilter: 0.7,
    impact: 'tap',
  },
  material: {
    type: 'standard',
    metalness: 0,
    roughness: 1,
    envMapIntensity: 1,
    // Geometric specular antialiasing, consumed by render/Materials.js.
    // `saaVariance` is the assumed screen-space variance of the pixel filter;
    // `saaMax` caps how much GGX width one pixel of normal sweep may add, so a
    // silhouette or a crease can never dissolve the material into grey.
    saaVariance: 0.25,
    saaMax: 0.18,
    // How much of the base roughness map bleeds into the clearcoat lobe. A
    // real coat is not a separate perfect sheet: where the surface underneath
    // is scuffed, dusty or open-grained, the film over it scatters too. Zero
    // means a laboratory-clean coat.
    ccFromRough: 0,
  },
  // Large-scale variation injected by Materials to break up tiling. Soft
  // organic surfaces can take a lot of it; a manufactured tile cannot.
  macro: { colorAmount: 0.06, roughAmount: 0.10, scale: 0.0055 },
};

function def(id, o) {
  const d = {
    ...BASE,
    ...o,
    id,
    audio: { ...BASE.audio, ...(o.audio || {}) },
    material: { ...BASE.material, ...(o.material || {}) },
    macro: { ...BASE.macro, ...(o.macro || {}) },
  };
  const geo = PT.defaultsFor(id);
  d.tileWorld = o.tileWorld ?? geo.tileWorld;
  d.relief = o.relief ?? geo.relief;
  d.label = o.label ?? id;
  return d;
}

/* ============================================================ the library */

export const SURFACE_DEFS = {

  /* ---------------------------------------------------------------- timber */

  oak: def('oak', {
    label: 'Oak board',
    category: 'wood',
    grip: 1.0, rollDrag: 0.010,
    particleColor: 0xc39764,
    audio: { timbre: 'wood', rollGain: 0.55, rollFilter: 0.52, rollGrain: 0.18, skidGain: 0.85, skidFilter: 0.55, impact: 'knock' },
    material: { roughness: 1, envMapIntensity: 1 },
    macro: { colorAmount: 0.07, roughAmount: 0.12, scale: 0.0038 },
  }),

  pine: def('pine', {
    label: 'Pine board',
    category: 'wood',
    grip: 0.98, rollDrag: 0.011,
    particleColor: 0xd8b481,
    audio: { timbre: 'wood', rollGain: 0.58, rollFilter: 0.56, rollGrain: 0.20, skidGain: 0.82, skidFilter: 0.58, impact: 'knock' },
    macro: { colorAmount: 0.08, roughAmount: 0.12, scale: 0.0040 },
  }),

  // Polished varnish is genuinely slippery — a rubber tyre on a hard, smooth,
  // sealed film has far less to key into than on open grain.
  //
  // Visually this is the most dangerous material in the game: it is the surface
  // the race is actually run on, it covers most of the frame, and a car sits
  // 2 cm above a horizontal plane, so the chase camera sees it almost entirely
  // at grazing incidence.
  //
  // An earlier pass took this from clearcoat 1.0 / roughness 0.055 to 0.55/0.16
  // and recorded the mirror as fixed. It was not, and the reason is worth
  // keeping. A clearcoat is an *additive* second layer: three attenuates the
  // layer under it by (1 - clearcoat * Fcc) and adds clearcoat * its own
  // reflection on top. At grazing incidence Fresnel drives Fcc to 1 whatever
  // the coat's index, so at clearcoat 0.55 the wood was down to 45% of itself
  // with 55% of the sky laid over it — and 55% of a daylight sky over 45% of a
  // dark walnut is, arithmetically, blue. Measured across the ribbon, red minus
  // blue ran +16 (warm) at the camera's feet, 0 at mid distance and -7 (blue)
  // at the horizon: the wood lost as the angle got shallower. Halving the
  // coat's *roughness* cannot touch that; only its *weight* can.
  //
  // So the coat is now a residue rather than a layer, it inherits almost all of
  // the substrate's scatter, and the real work is done by the base roughness
  // map in ProcTex (0.29 floor, 0.33 mean, up from 0.14/0.16), because three's
  // split-sum DFG returns ~63% of the environment at grazing incidence for
  // roughness 0.16 and ~29% at 0.33. Roughness is the only grazing-angle clamp
  // reachable from this side of the file, and it is a strong one. After both
  // changes the same three samples read +74, +47 and +27 — warm all the way to
  // the horizon.
  varnishedWood: def('varnishedWood', {
    label: 'Varnished top',
    category: 'wood',
    grip: 0.92, rollDrag: 0.008,
    particleColor: 0x8a5c34,
    audio: { timbre: 'polished', rollGain: 0.42, rollFilter: 0.78, rollGrain: 0.06, skidGain: 1.05, skidFilter: 0.86, impact: 'knock' },
    material: {
      type: 'physical',
      clearcoat: 0.10, clearcoatRoughness: 0.34, ccFromRough: 0.92,
      ior: 1.5, envMapIntensity: 0.80,
      // Widest filter in the library. This is the surface that runs to the
      // horizon under a long lens, so it is the one where a single pixel spans
      // the most normal sweep and needs the most help holding its lobe together.
      saaVariance: 0.38, saaMax: 0.34,
    },
    macro: { colorAmount: 0.05, roughAmount: 0.16, scale: 0.0032 },
  }),

  laminate: def('laminate', {
    label: 'Laminate floor',
    category: 'wood',
    grip: 1.0, rollDrag: 0.009,
    particleColor: 0xcba372,
    audio: { timbre: 'laminate', rollGain: 0.60, rollFilter: 0.70, rollGrain: 0.10, skidGain: 0.95, skidFilter: 0.78, impact: 'knock' },
    material: {
      type: 'physical',
      clearcoat: 0.45, clearcoatRoughness: 0.24, ccFromRough: 0.45, ior: 1.5,
      saaMax: 0.22,
    },
    macro: { colorAmount: 0.04, roughAmount: 0.08, scale: 0.0026 },
  }),

  /* ------------------------------------------------------------ soft goods */

  // Baize is the grippiest thing in the game: a fine wool nap keys into rubber
  // beautifully, which is exactly why the pool table plays like a slot car set.
  poolFelt: def('poolFelt', {
    label: 'Pool baize',
    category: 'cloth',
    grip: 1.14, rollDrag: 0.030,
    particle: 'dust', particleColor: 0x2f8c52, particleRate: 0.5,
    skidTint: 0x123a20,
    audio: { timbre: 'felt', rollGain: 0.30, rollFilter: 0.22, rollGrain: 0.05, skidGain: 0.45, skidFilter: 0.20, impact: 'thud' },
    material: {
      type: 'physical',
      sheen: 0.55, sheenRoughness: 0.42, sheenColor: 0x6fbb85,
      anisotropy: 0.55, anisotropyRotation: Math.PI * 0.5,
      envMapIntensity: 0.55,
    },
    macro: { colorAmount: 0.05, roughAmount: 0.08, scale: 0.0045 },
  }),

  carpet: def('carpet', {
    label: 'Carpet',
    category: 'cloth',
    grip: 0.90, rollDrag: 0.078, offTrack: true,
    particle: 'dust', particleColor: 0xa8967c, particleRate: 0.7,
    audio: { timbre: 'carpet', rollGain: 0.26, rollFilter: 0.16, rollGrain: 0.22, skidGain: 0.30, skidFilter: 0.16, impact: 'thud' },
    material: { type: 'physical', sheen: 0.4, sheenRoughness: 0.6, sheenColor: 0xc9b89a, envMapIntensity: 0.45 },
    macro: { colorAmount: 0.09, roughAmount: 0.08, scale: 0.0060 },
  }),

  rug: def('rug', {
    label: 'Rug',
    category: 'cloth',
    grip: 0.95, rollDrag: 0.052,
    particle: 'dust', particleColor: 0xb08a6a, particleRate: 0.6,
    audio: { timbre: 'carpet', rollGain: 0.32, rollFilter: 0.24, rollGrain: 0.28, skidGain: 0.38, skidFilter: 0.22, impact: 'thud' },
    material: { type: 'physical', sheen: 0.35, sheenRoughness: 0.55, sheenColor: 0xd8c8a6, envMapIntensity: 0.5 },
    macro: { colorAmount: 0.06, roughAmount: 0.08, scale: 0.0042 },
  }),

  /* -------------------------------------------------------------- outdoors */

  sand: def('sand', {
    label: 'Sandbox',
    category: 'loose',
    grip: 0.62, rollDrag: 0.110, offTrack: true,
    particle: 'sand', particleColor: 0xdcc79c, particleRate: 2.2,
    skidTint: 0x8a7350,
    audio: { timbre: 'sand', rollGain: 0.48, rollFilter: 0.30, rollGrain: 0.55, skidGain: 0.55, skidFilter: 0.28, impact: 'soft' },
    material: { envMapIntensity: 0.8 },
    macro: { colorAmount: 0.10, roughAmount: 0.07, scale: 0.0070 },
  }),

  grass: def('grass', {
    label: 'Lawn',
    category: 'loose',
    grip: 0.72, rollDrag: 0.086, offTrack: true,
    particle: 'grassClipping', particleColor: 0x5f9435, particleRate: 1.8,
    skidTint: 0x35502a,
    audio: { timbre: 'grass', rollGain: 0.40, rollFilter: 0.26, rollGrain: 0.40, skidGain: 0.48, skidFilter: 0.24, impact: 'soft' },
    material: { type: 'physical', sheen: 0.3, sheenRoughness: 0.5, sheenColor: 0x9ec46a, envMapIntensity: 0.7 },
    macro: { colorAmount: 0.11, roughAmount: 0.08, scale: 0.0075 },
  }),

  soil: def('soil', {
    label: 'Bare earth',
    category: 'loose',
    grip: 0.68, rollDrag: 0.094, offTrack: true,
    particle: 'dust', particleColor: 0x6b543a, particleRate: 2.4,
    skidTint: 0x2e2317,
    audio: { timbre: 'soil', rollGain: 0.44, rollFilter: 0.24, rollGrain: 0.48, skidGain: 0.50, skidFilter: 0.22, impact: 'soft' },
    material: { envMapIntensity: 0.7 },
    macro: { colorAmount: 0.12, roughAmount: 0.07, scale: 0.0068 },
  }),

  gravel: def('gravel', {
    label: 'Gravel',
    category: 'loose',
    grip: 0.58, rollDrag: 0.122, offTrack: true,
    particle: 'debris', particleColor: 0x9a9184, particleRate: 2.6,
    skidTint: 0x4a453d,
    audio: { timbre: 'gravel', rollGain: 0.72, rollFilter: 0.62, rollGrain: 0.95, skidGain: 0.68, skidFilter: 0.55, impact: 'scatter' },
    material: { envMapIntensity: 0.85 },
    macro: { colorAmount: 0.09, roughAmount: 0.09, scale: 0.0072 },
  }),

  /* -------------------------------------------------------------- flooring */

  concrete: def('concrete', {
    label: 'Concrete',
    category: 'hard',
    grip: 1.02, rollDrag: 0.012,
    particleColor: 0xb4b1aa,
    audio: { timbre: 'concrete', rollGain: 0.62, rollFilter: 0.66, rollGrain: 0.22, skidGain: 1.0, skidFilter: 0.72, impact: 'crack' },
    macro: { colorAmount: 0.08, roughAmount: 0.13, scale: 0.0030 },
  }),

  ceramicTile: def('ceramicTile', {
    label: 'Ceramic tile',
    category: 'hard',
    grip: 0.94, rollDrag: 0.008,
    particleColor: 0xe8e3d6,
    audio: { timbre: 'tile', rollGain: 0.50, rollFilter: 0.88, rollGrain: 0.30, skidGain: 1.1, skidFilter: 0.92, impact: 'chink' },
    material: {
      type: 'physical',
      clearcoat: 0.7, clearcoatRoughness: 0.11, ccFromRough: 0.40,
      ior: 1.55, envMapIntensity: 1.1, saaMax: 0.26,
    },
    macro: { colorAmount: 0.03, roughAmount: 0.06, scale: 0.0022 },
  }),

  linoleum: def('linoleum', {
    label: 'Linoleum',
    category: 'hard',
    grip: 0.97, rollDrag: 0.009,
    particleColor: 0xb9a37e,
    audio: { timbre: 'lino', rollGain: 0.46, rollFilter: 0.58, rollGrain: 0.08, skidGain: 1.15, skidFilter: 0.66, impact: 'thud' },
    material: { type: 'physical', clearcoat: 0.35, clearcoatRoughness: 0.30, ccFromRough: 0.40 },
    macro: { colorAmount: 0.05, roughAmount: 0.10, scale: 0.0030 },
  }),

  /* ----------------------------------------------------------------- metal */

  brushedAluminium: def('brushedAluminium', {
    label: 'Brushed aluminium',
    category: 'metal',
    grip: 0.86, rollDrag: 0.008,
    particle: 'sparks', particleColor: 0xe6e8ea, particleRate: 1.4,
    audio: { timbre: 'metal', rollGain: 0.52, rollFilter: 0.90, rollGrain: 0.06, skidGain: 1.1, skidFilter: 0.95, impact: 'clang' },
    material: {
      type: 'physical',
      metalness: 1, roughness: 1,
      // 0.85 was the real cause of D4's "matte blue paint", not the albedo or
      // the roughness map — both of those measure fine (albedo 230/232/234,
      // roughness mean 0.30). three builds the stretched lobe as
      // alphaT = mix(roughness^2, 1, anisotropy^2), so 0.85 gave alphaT 0.75,
      // i.e. an effective roughness of 0.93 along the brush direction. That is
      // a fully matte lobe, and a matte lobe on a metal returns the average of
      // the environment — which, under a daylight probe, is flat blue. 0.42
      // keeps a 3:1 stretch, which still reads unmistakably as brushed while
      // leaving the cross-brush lobe tight enough to resolve the key light.
      anisotropy: 0.42, anisotropyRotation: Math.PI * 0.5,
      envMapIntensity: 1.25,
      // A metal has no diffuse term to hide behind, so all of its aliasing is
      // specular and it needs the widest antialiasing ceiling in the library.
      saaMax: 0.26,
    },
    macro: { colorAmount: 0.03, roughAmount: 0.10, scale: 0.0026 },
  }),

  galvanisedSteel: def('galvanisedSteel', {
    label: 'Galvanised steel',
    category: 'metal',
    grip: 0.84, rollDrag: 0.008,
    particle: 'sparks', particleColor: 0xb6bcc0, particleRate: 1.4,
    audio: { timbre: 'metal', rollGain: 0.56, rollFilter: 0.86, rollGrain: 0.14, skidGain: 1.05, skidFilter: 0.9, impact: 'clang' },
    material: { type: 'physical', metalness: 1, roughness: 1, envMapIntensity: 1.2, saaMax: 0.24 },
    macro: { colorAmount: 0.04, roughAmount: 0.12, scale: 0.0030 },
  }),

  chromePlate: def('chromePlate', {
    label: 'Chrome',
    category: 'metal',
    grip: 0.78, rollDrag: 0.007,
    particle: 'sparks', particleColor: 0xf2f3f4, particleRate: 1.6,
    audio: { timbre: 'metal', rollGain: 0.44, rollFilter: 0.96, rollGrain: 0.03, skidGain: 1.2, skidFilter: 0.98, impact: 'clang' },
    material: { type: 'physical', metalness: 1, roughness: 1, envMapIntensity: 1.6, saaMax: 0.28 },
    macro: { colorAmount: 0.015, roughAmount: 0.05, scale: 0.0018 },
  }),

  /* --------------------------------------------------------------- plastic */

  plasticMatte: def('plasticMatte', {
    label: 'Matte plastic',
    category: 'plastic',
    grip: 0.95, rollDrag: 0.010,
    particleColor: 0xd8d8d6,
    audio: { timbre: 'plastic', rollGain: 0.48, rollFilter: 0.68, rollGrain: 0.08, skidGain: 0.9, skidFilter: 0.7, impact: 'tick' },
    macro: { colorAmount: 0.025, roughAmount: 0.07, scale: 0.0020 },
  }),

  plasticGloss: def('plasticGloss', {
    label: 'Gloss plastic',
    category: 'plastic',
    grip: 0.88, rollDrag: 0.008,
    particleColor: 0xe2e2e0,
    audio: { timbre: 'plastic', rollGain: 0.44, rollFilter: 0.82, rollGrain: 0.05, skidGain: 1.0, skidFilter: 0.86, impact: 'tick' },
    material: {
      type: 'physical',
      clearcoat: 0.9, clearcoatRoughness: 0.085, ccFromRough: 0.30,
      ior: 1.5, envMapIntensity: 1.15, saaMax: 0.24,
    },
    macro: { colorAmount: 0.02, roughAmount: 0.06, scale: 0.0018 },
  }),

  // The best grip in the game, and the reason a rubber ramp or mat is a
  // shortcut worth aiming for.
  rubber: def('rubber', {
    label: 'Rubber',
    category: 'plastic',
    grip: 1.26, rollDrag: 0.032,
    particle: 'tyreSmoke', particleColor: 0x2a2a2a, particleRate: 1.2,
    audio: { timbre: 'rubber', rollGain: 0.34, rollFilter: 0.18, rollGrain: 0.05, skidGain: 1.25, skidFilter: 0.30, impact: 'thud' },
    material: { envMapIntensity: 0.6 },
    macro: { colorAmount: 0.03, roughAmount: 0.08, scale: 0.0024 },
  }),

  /* ----------------------------------------------------------------- paper */

  paper: def('paper', {
    label: 'Paper',
    category: 'paper',
    grip: 0.80, rollDrag: 0.020,
    particle: 'debris', particleColor: 0xf3efe4, particleRate: 0.8,
    audio: { timbre: 'paper', rollGain: 0.38, rollFilter: 0.74, rollGrain: 0.32, skidGain: 0.55, skidFilter: 0.78, impact: 'rustle' },
    material: { type: 'physical', sheen: 0.25, sheenRoughness: 0.75, sheenColor: 0xfffaf0, envMapIntensity: 0.55 },
    macro: { colorAmount: 0.035, roughAmount: 0.06, scale: 0.0034 },
  }),

  cardboard: def('cardboard', {
    label: 'Cardboard',
    category: 'paper',
    grip: 0.85, rollDrag: 0.024,
    particle: 'debris', particleColor: 0xb08a5c, particleRate: 1,
    audio: { timbre: 'paper', rollGain: 0.44, rollFilter: 0.52, rollGrain: 0.42, skidGain: 0.6, skidFilter: 0.5, impact: 'rustle' },
    material: { envMapIntensity: 0.55 },
    macro: { colorAmount: 0.055, roughAmount: 0.07, scale: 0.0038 },
  }),

  /* --------------------------------------------------------------- liquids */

  spilledMilk: def('spilledMilk', {
    label: 'Spilled milk',
    category: 'liquid',
    grip: 0.40, rollDrag: 0.030,
    particle: 'milkSplash', particleColor: 0xf6f5ef, particleRate: 3,
    skidTint: 0xd8d4c4,
    audio: { timbre: 'wet', rollGain: 0.35, rollFilter: 0.42, rollGrain: 0.04, skidGain: 0.5, skidFilter: 0.40, impact: 'splash' },
    material: {
      type: 'physical',
      roughness: 1, ior: 1.35, envMapIntensity: 1.3,
      decal: true, transparent: true, alphaTest: 0.02,
    },
    macro: { colorAmount: 0.02, roughAmount: 0.05, scale: 0.0030 },
  }),

  // The lowest grip in the game by a wide margin. Hitting oil should feel like
  // a mistake you cannot fully drive out of.
  oilSlick: def('oilSlick', {
    label: 'Oil slick',
    category: 'liquid',
    grip: 0.22, rollDrag: 0.006,
    particle: 'waterSplash', particleColor: 0x14100c, particleRate: 1.4,
    skidTint: 0x0a0908,
    audio: { timbre: 'wet', rollGain: 0.22, rollFilter: 0.36, rollGrain: 0.02, skidGain: 0.35, skidFilter: 0.32, impact: 'splash' },
    material: {
      type: 'physical',
      roughness: 1, ior: 1.47, envMapIntensity: 1.5,
      // Thin-film interference off a real thickness map: this is what makes
      // the rainbow read as physics rather than as a painted-on gradient.
      iridescence: 1, iridescenceIOR: 1.38, iridescenceThicknessRange: [180, 780],
      decal: true, transparent: true, alphaTest: 0.02,
    },
    macro: { colorAmount: 0.02, roughAmount: 0.06, scale: 0.0032 },
  }),

  waterPuddle: def('waterPuddle', {
    label: 'Puddle',
    category: 'liquid',
    grip: 0.46, rollDrag: 0.046,
    particle: 'waterSplash', particleColor: 0xa8c4cc, particleRate: 3.2,
    skidTint: 0x2e3a3a,
    audio: { timbre: 'wet', rollGain: 0.40, rollFilter: 0.48, rollGrain: 0.06, skidGain: 0.42, skidFilter: 0.44, impact: 'splash' },
    material: {
      type: 'physical',
      roughness: 1, ior: 1.33, envMapIntensity: 1.6,
      decal: true, transparent: true, alphaTest: 0.02,
    },
    macro: { colorAmount: 0.02, roughAmount: 0.05, scale: 0.0034 },
  }),

  /* ------------------------------------------------------------- markings */

  chalkLine: def('chalkLine', {
    label: 'Chalk line',
    category: 'marking',
    grip: 0.96, rollDrag: 0.011,
    particle: 'dust', particleColor: 0xf2f4f6, particleRate: 1.6,
    audio: { timbre: 'chalk', rollGain: 0.30, rollFilter: 0.44, rollGrain: 0.16, skidGain: 0.7, skidFilter: 0.5, impact: 'tap' },
    material: { decal: true, transparent: true, alphaTest: 0.04, envMapIntensity: 0.5 },
    macro: { colorAmount: 0.03, roughAmount: 0.05, scale: 0.0040 },
  }),

  gaffaTape: def('gaffaTape', {
    label: 'Gaffa tape',
    category: 'marking',
    grip: 1.08, rollDrag: 0.011,
    particleColor: 0x232426,
    audio: { timbre: 'tape', rollGain: 0.36, rollFilter: 0.34, rollGrain: 0.10, skidGain: 0.8, skidFilter: 0.36, impact: 'thud' },
    material: { decal: true, transparent: true, alphaTest: 0.15, envMapIntensity: 0.6 },
    macro: { colorAmount: 0.03, roughAmount: 0.08, scale: 0.0030 },
  }),

  /* --------------------------------------------------------------- litter */

  crumbs: def('crumbs', {
    label: 'Crumbs',
    category: 'litter',
    grip: 0.80, rollDrag: 0.030,
    particle: 'debris', particleColor: 0xa4703a, particleRate: 2.2,
    audio: { timbre: 'crumbs', rollGain: 0.52, rollFilter: 0.70, rollGrain: 0.75, skidGain: 0.6, skidFilter: 0.62, impact: 'scatter' },
    material: { decal: true, transparent: true, alphaTest: 0.10, envMapIntensity: 0.7 },
    macro: { colorAmount: 0.07, roughAmount: 0.07, scale: 0.0060 },
  }),

  sawdust: def('sawdust', {
    label: 'Sawdust',
    category: 'litter',
    grip: 0.70, rollDrag: 0.042, offTrack: true,
    particle: 'dust', particleColor: 0xdcc79b, particleRate: 2.8,
    audio: { timbre: 'sawdust', rollGain: 0.34, rollFilter: 0.30, rollGrain: 0.42, skidGain: 0.42, skidFilter: 0.28, impact: 'soft' },
    material: { decal: true, transparent: true, alphaTest: 0.08, envMapIntensity: 0.65 },
    macro: { colorAmount: 0.08, roughAmount: 0.07, scale: 0.0058 },
  }),
};

export const KINDS = Object.keys(SURFACE_DEFS);

const FALLBACK = 'concrete';

/** Metadata for a kind. Never returns null — an unknown name resolves to
 *  concrete so a typo in a track definition degrades instead of crashing. */
export function surfaceDef(kind) {
  return SURFACE_DEFS[kind] || SURFACE_DEFS[FALLBACK];
}

/* ============================================================ texture cache */

const _cache = new Map();       // kind -> entry
const _pending = [];            // kinds queued for the full-resolution pass
let _idleHandle = 0;
let _idleIsTimeout = false;
let _ctx = null;
let _anisotropy = 8;
let _bytes = 0;

// A draft is a complete, correct bake evaluated at a fraction of the linear
// resolution — about a sixteenth of the cost — and magnified to the set's final
// pixel dimensions. It is on screen for a few hundred milliseconds at most, and
// because the layer machinery band-limits anything finer than the grid it reads
// as a slightly soft version of the material rather than as a broken one.
//
// It is only the *generator* that runs small. The textures themselves are
// allocated at their final size from the first upload, because three hands a
// DataTexture to `texStorage2D`, whose allocation is immutable: re-uploading a
// larger image into it later is silently dropped by the driver and the surface
// would stay a blur for the rest of the session.
const DRAFT_SIZE = 256;

function budgetBytes() {
  const mb = Settings.textures?.cacheBudgetMB ?? 256;
  return mb * 1024 * 1024;
}

/** The size a kind's textures are *allocated* at, trimmed if the cache is
 *  already full. Chosen once, at the first request, and never revisited: the
 *  draft and the sharp bake that replaces it must agree on it. Never evicts —
 *  a set in use by a live material must not vanish underneath it. */
function targetSize(kind) {
  const cfg = Settings.textures ?? {};
  let s = cfg.resolution ?? 1024;
  const budget = budgetBytes();
  if (_bytes > budget * 0.85) s = Math.max(256, s >> 1);
  if (_bytes > budget * 1.4) s = Math.max(256, s >> 1);
  return s;
}

function scheduleIdle() {
  if (_idleHandle || _pending.length === 0) return;
  const run = () => {
    _idleHandle = 0;
    const kind = _pending.shift();
    if (kind) upgradeNow(kind);
    if (_pending.length) scheduleIdle();
  };
  if (typeof requestIdleCallback === 'function') {
    _idleIsTimeout = false;
    _idleHandle = requestIdleCallback(run, { timeout: 1200 });
  } else {
    _idleIsTimeout = true;
    _idleHandle = setTimeout(run, 24);
  }
}

function upgradeNow(kind) {
  const e = _cache.get(kind);
  if (!e || e.level >= 1) return;
  try {
    _bytes -= e.set.bytes;
    // Same pixel dimensions, sharper pixels — see DRAFT_SIZE.
    e.set.upgrade();
    e.level = 1;
    _bytes += e.set.bytes;
    _ctx?.bus?.emit?.('surface:upgraded', { kind, size: e.set.size });
  } catch (err) {
    console.warn('[Surfaces] full-resolution bake failed for', kind, err);
    e.level = 1; // do not retry forever
    _bytes += e.set.bytes;
  }
}

/**
 * The cached PBR set for a surface.
 *
 * Always returns immediately with usable textures. The first call bakes a
 * draft and queues the sharp version; later calls return the same object, so
 * every material in the game shares one upload per surface.
 */
export function textures(kind, opts = {}) {
  const k = SURFACE_DEFS[kind] ? kind : FALLBACK;
  const cached = _cache.get(k);
  if (cached) return cached.set;

  const immediate = opts.immediate === true;
  const size = targetSize(k);
  let set;
  try {
    set = PT.makeTextureSet(k, {
      ...opts,
      size,
      seed: opts.seed ?? 0,
      draft: !immediate,
      draftSize: DRAFT_SIZE,
    });
  } catch (err) {
    // A generator throwing must not take the frame down; fall back to a kind
    // that is known to bake, so the mesh still gets real material data.
    console.error('[Surfaces] bake failed for', k, err);
    if (k !== FALLBACK) return textures(FALLBACK, opts);
    throw err;
  }

  const entry = { kind: k, set, level: set.level ?? (immediate ? 1 : 0) };
  _cache.set(k, entry);
  _bytes += set.bytes;
  if (!immediate) {
    _pending.push(k);
    scheduleIdle();
  }
  return set;
}

/**
 * Bake a list of surfaces to full resolution, yielding to the event loop
 * between each so a loading screen can animate and the tab stays responsive.
 * @param {string[]} kinds
 * @param {{onProgress?: (done:number, total:number, kind:string) => void}} [o]
 */
export async function warm(kinds, o = {}) {
  const list = (Array.isArray(kinds) ? kinds : KINDS).filter((k) => SURFACE_DEFS[k]);
  for (let i = 0; i < list.length; i++) {
    const k = list[i];
    const e = _cache.get(k);
    if (!e) {
      textures(k, { immediate: true });
    } else if (e.level < 1) {
      const at = _pending.indexOf(k);
      if (at >= 0) _pending.splice(at, 1);
      upgradeNow(k);
    }
    o.onProgress?.(i + 1, list.length, k);
    // A macrotask, not a microtask: the browser needs a chance to paint.
    await new Promise((res) => setTimeout(res, 0));
  }
  return list.length;
}

/* ================================================================ the system */

export const Surfaces = {
  name: 'surfaces',

  KINDS,
  DEFS: SURFACE_DEFS,

  /** Cheap on purpose: nothing is baked here, or the boot would stall for
   *  several seconds on surfaces the chosen track may never use. */
  async init(ctx) {
    _ctx = ctx || null;
    _anisotropy = clamp(Settings.render?.anisotropy ?? 8, 1, 16);
    PT.setAnisotropy(_anisotropy);
    // Review hook: MG.surfaces.verifyTiling() proves the wrap from the console
    // without needing a screenshot, and MG.surfaces.stats() shows what the
    // texture budget is actually being spent on.
    if (typeof window !== 'undefined') {
      window.MG = window.MG || {};
      window.MG.surfaces = Surfaces;
      window.MG.procTex = PT;
    }
    return this;
  },

  /* -------------------------------------------------------------- lookups */

  has(kind) { return !!SURFACE_DEFS[kind]; },
  def: surfaceDef,
  get: surfaceDef,
  list() { return KINDS.slice(); },
  listByCategory(cat) { return KINDS.filter((k) => SURFACE_DEFS[k].category === cat); },

  /** Peak-friction multiplier, 1.0 = a good plank table. */
  grip(kind) { return surfaceDef(kind).grip; },
  /** Rolling resistance coefficient. */
  drag(kind) { return surfaceDef(kind).rollDrag; },
  rollDrag(kind) { return surfaceDef(kind).rollDrag; },
  /** Particles/Trails kind to emit from a spinning or sliding wheel. */
  particle(kind) { return surfaceDef(kind).particle; },
  particleColor(kind) { return surfaceDef(kind).particleColor; },
  particleRate(kind) { return surfaceDef(kind).particleRate; },
  /** Tyre audio timbre plus the numeric parameters behind it. */
  audio(kind) { return surfaceDef(kind).audio; },
  timbre(kind) { return surfaceDef(kind).audio.timbre; },
  /** True when leaving the ribbon onto this should count as off-track. */
  isOffTrack(kind) { return !!surfaceDef(kind).offTrack; },
  skidTint(kind) { return surfaceDef(kind).skidTint; },
  /** Centimetres of world covered by one texture repeat. */
  tileWorld(kind) { return surfaceDef(kind).tileWorld; },
  relief(kind) { return surfaceDef(kind).relief; },
  color(kind) { return surfaceDef(kind).particleColor; },

  /* ------------------------------------------------------------- textures */

  textures,
  textureSet: textures,
  warm,

  /** Tell the foundry about a repeat-adjusted clone of one of its textures, so
   *  the idle re-bake reaches it as well as the original. See ProcTex. */
  linkDerived(base, derived) { return PT.linkDerived?.(base, derived) ?? derived; },

  /** Force one surface to full resolution right now (blocking). */
  ensure(kind) { return textures(kind, { immediate: true }); },

  setAnisotropy(v) {
    _anisotropy = clamp(v | 0, 1, 16);
    PT.setAnisotropy(_anisotropy);
  },

  applySettings(s) {
    if (s?.render?.anisotropy) this.setAnisotropy(s.render.anisotropy);
  },

  stats() {
    return {
      cached: _cache.size,
      pending: _pending.length,
      megabytes: +(_bytes / 1048576).toFixed(1),
      budgetMB: Settings.textures?.cacheBudgetMB ?? 256,
      // `generatedAt` is where the generator actually ran; `size` is the upload.
      // They differ only while a draft is still waiting for its idle re-bake.
      sets: [..._cache.values()].map((e) => ({
        kind: e.kind, size: e.set.size, generatedAt: e.set.genSize, level: e.level,
      })),
    };
  },

  /** Numeric wrap proof for one surface, or every surface. See ProcTex. */
  verifyTiling(kind, opts) {
    return kind ? PT.verifyTiling(kind, opts) : PT.verifyAllTiling(opts);
  },

  dispose() {
    if (_idleHandle) {
      if (_idleIsTimeout) clearTimeout(_idleHandle);
      else if (typeof cancelIdleCallback === 'function') cancelIdleCallback(_idleHandle);
      _idleHandle = 0;
    }
    _pending.length = 0;
    for (const e of _cache.values()) e.set.dispose();
    _cache.clear();
    _bytes = 0;
  },
};

export default Surfaces;
