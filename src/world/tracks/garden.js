// world/tracks/garden.js — GREENHOUSE GP
//
// Late afternoon at the bottom of the garden, sun about fifteen degrees up and
// coming in almost horizontally from the west, so every paving slab throws a
// shadow the length of a car and the grass goes translucent at the edges.
//
// This is the fast circuit of the five: two 75-plus-radius sweepers taken flat,
// a genuine jump over the drain channel, and only one properly slow corner.
// Grip swings hard — dry paving is 1.02, the soil border is 0.58, the sandpit
// is 0.46 and the puddle is 0.44 — so the whole lap is about choosing where to
// put the car laterally, not just where to brake.
//
// LAYOUT — 1841 u, counter-clockwise:
//
//   t 0.00-0.16  THE SLAB RUN   main straight along the top path, west-bound.
//   t 0.16-0.22  GREENHOUSE     R74 fast left round the corner of the frame.
//   t 0.22-0.28  WEST WALL      long gravel straight down the boundary.
//   t 0.28-0.31  THE DRAIN      ramp over the channel, then a 12 u gap. Take it
//                               flat or don't take it at all.
//   t 0.31-0.36  ROOT CORNER    R80 sweeper, roots lifting the slabs.
//   t 0.36-0.50  THE BORDER     south straight, over wet soil, with the hose
//                               lying across it in two places.
//   t 0.50-0.58  THE COLDFRAME  R30 double-apex hairpin, slowest corner.
//   t 0.58-0.66  SPRINKLER      infield straight through standing water.
//   t 0.66-0.73  THE CHICANE    R26 flick-flack between the plant pots.
//   t 0.73-0.80  SANDPIT LOOP   R40 right-hand 180 through loose sand.
//   t 0.80-0.94  THE LAWN       infield return, half on grass — slower but a
//                               far better exit onto the last corner.
//   t 0.94-1.00  PAVER          R40 left 180 back onto the main straight.

export default {
  id: 'garden',
  name: 'GREENHOUSE GP',
  theme: 'garden',
  lighting: 'goldenHour',
  seed: 20771,
  laps: 3,
  difficulty: 2,

  startT: 0.070,
  gridSize: 12,

  surface: 'concrete',
  offTrackSurface: 'grass',
  groundSurface: 'grass',
  shoulderWidth: 10,
  roadRaise: 0.6,
  groundRelief: 0.55,   // a lawn is never flat
  roadRelief: 0.16,
  groundPad: 380,

  path: [
    [158, 0, 138], [136, 0, 138], [114, 0, 138], [93, 0, 139], [71, 0, 140], [49, 0, 142],
    [27, 0, 144], [5, 0, 144], [-17, 0, 143], [-39, 0, 141], [-60, 0, 139], [-82, 0, 136],
    [-104, 0, 135], [-126, 0, 134], [-148, 0, 132], [-168, 0, 124], [-185, 0, 110], [-197, 0, 92],
    [-203, 0, 71], [-204, 0, 49], [-204, 0, 27], [-204, 0, 5], [-204, 0, -17], [-204, 0, -39],
    [-204, 0, -61], [-201, 0, -82], [-192, 0, -102], [-177, 0, -119], [-159, 0, -131], [-139, 0, -138],
    [-117, 0, -140], [-95, 0, -141], [-73, 0, -141], [-51, 0, -141], [-29, 0, -139], [-7, 0, -138],
    [14, 0, -136], [36, 0, -134], [58, 0, -133], [80, 0, -133], [102, 0, -133], [124, 0, -134],
    [146, 0, -134], [168, 0, -135], [188, 0, -129], [199, 0, -111], [200, 0, -89], [198, 0, -67],
    [184, 0, -51], [162, 0, -47], [141, 0, -45], [119, 0, -44], [97, 0, -42], [75, 0, -39],
    [54, 0, -32], [35, 0, -22], [14, 0, -17], [-5, 0, -28], [-23, 0, -39], [-44, 0, -35],
    [-64, 0, -27], [-86, 0, -26], [-107, 0, -22], [-123, 0, -8], [-130, 0, 13], [-125, 0, 34],
    [-110, 0, 49], [-88, 0, 54], [-67, 0, 53], [-45, 0, 52], [-23, 0, 53], [-1, 0, 55],
    [21, 0, 58], [42, 0, 61], [64, 0, 62], [86, 0, 62], [108, 0, 61], [130, 0, 60],
    [152, 0, 59], [173, 0, 61], [190, 0, 75], [198, 0, 95], [194, 0, 116], [179, 0, 132],
  ],

  widthProfile: [
    { t: 0.00, width: 33 },
    { t: 0.12, width: 31 },
    { t: 0.19, width: 28 },   // Greenhouse
    { t: 0.25, width: 30 },
    { t: 0.29, width: 27 },   // the drain — narrow at the jump so it must be aimed
    { t: 0.33, width: 30 },
    { t: 0.42, width: 33 },   // the Border, widest part of the lap
    { t: 0.49, width: 28 },
    { t: 0.54, width: 24 },   // Coldframe hairpin
    { t: 0.60, width: 29 },
    { t: 0.68, width: 25 },   // chicane
    { t: 0.72, width: 25 },
    { t: 0.77, width: 27 },   // Sandpit Loop
    { t: 0.85, width: 32 },   // the Lawn, two lines wide
    { t: 0.91, width: 30 },
    { t: 0.96, width: 26 },
  ],

  surfaceSpans: [
    { from: 0.000, to: 0.130, surface: 'concrete' },      // paving slabs
    { from: 0.130, to: 0.265, surface: 'gravel' },        // the side path
    { from: 0.265, to: 0.375, surface: 'concrete' },
    { from: 0.375, to: 0.495, surface: 'soil' },          // straight through the border
    { from: 0.495, to: 0.585, surface: 'gravel' },
    { from: 0.585, to: 0.720, surface: 'concrete' },
    { from: 0.720, to: 0.800, surface: 'sand' },          // the sandpit
    { from: 0.800, to: 0.905, surface: 'grass' },         // across the lawn
    { from: 0.905, to: 1.000, surface: 'concrete' },
  ],

  hazards: [
    // The drain. Ramp lip and gap edge are 2 u apart, so the launch is the only
    // way across: 9 u of rise over 26 gives 25 u of carry at 100 u/s.
    { type: 'ramp', id: 'drainRamp', t: 0.2885, length: 26, height: 9.0, width: 27 },
    { type: 'gap', id: 'drain', t: 0.2996, length: 12, depth: 20, width: 34 },

    // Roots under the slabs on the exit of the fast sweeper.
    { type: 'bump', id: 'rootA', t: 0.345, length: 16, height: 2.1, width: 24, offset: -6 },
    { type: 'bump', id: 'rootB', t: 0.362, length: 14, height: 1.7, width: 22, offset: 7 },

    // The hose, lying across the border in two loops.
    { type: 'bump', id: 'hoseA', t: 0.425, length: 9, height: 2.6, width: 36 },
    { type: 'bump', id: 'hoseB', t: 0.452, length: 9, height: 2.4, width: 36 },

    // Standing water under the sprinkler and in the dip after the hairpin.
    { type: 'puddle', id: 'sprinklerPool', t: 0.612, length: 46, width: 30, height: 0.9 },
    { type: 'puddle', id: 'dipPool', t: 0.660, length: 30, width: 18, offset: -7, height: 0.7 },
    { type: 'puddle', id: 'lawnPool', t: 0.862, length: 34, width: 16, offset: 9, height: 0.6 },
  ],

  walls: [
    { from: 0.152, to: 0.230, side: 'right', height: 4.6 },
    { from: 0.288, to: 0.352, side: 'right', height: 4.6 },
    { from: 0.500, to: 0.596, side: 'right', height: 4.0 },
    { from: 0.725, to: 0.800, side: 'left', height: 3.8 },
    { from: 0.930, to: 1.000, side: 'right', height: 4.2 },
  ],

  decals: [
    { kind: 'water', t: 0.612, lateral: 0, radius: 26, aspect: 1.7, opacity: 0.7 },
    { kind: 'water', t: 0.640, lateral: 10, radius: 15, aspect: 1.4, opacity: 0.6 },
    { kind: 'water', t: 0.862, lateral: 9, radius: 17, aspect: 1.5, opacity: 0.6 },
    { kind: 'water', position: [-60, 96], radius: 24, aspect: 1.6, opacity: 0.55 },
    { kind: 'water', position: [120, -92], radius: 20, opacity: 0.5 },
    { kind: 'grassStain', t: 0.835, lateral: -8, radius: 24, aspect: 2.2, opacity: 0.75 },
    { kind: 'grassStain', t: 0.870, lateral: 6, radius: 20, aspect: 1.9, opacity: 0.65 },
    { kind: 'grassStain', t: 0.412, lateral: 10, radius: 22, aspect: 1.8, opacity: 0.6 },
    { kind: 'crumbPatch', t: 0.755, lateral: 0, radius: 30, aspect: 1.5, opacity: 0.7 },
    { kind: 'crumbPatch', t: 0.783, lateral: -9, radius: 20, opacity: 0.6 },
    { kind: 'crumbPatch', position: [-176, -20], radius: 34, opacity: 0.55 },
    { kind: 'rubberPatch', t: 0.552, lateral: -6, radius: 17, aspect: 2.3, opacity: 0.5 },
    { kind: 'rubberPatch', t: 0.965, lateral: 6, radius: 19, aspect: 2.5, opacity: 0.45 },
    { kind: 'oil', position: [268, 24], radius: 14, aspect: 1.4, opacity: 0.6 },
  ],

  props: [
    /* ---- focal composition ------------------------------------------------ */

    // The greenhouse corner is anchored by three terracotta pots, tallest on the
    // apex side so the corner has a readable silhouette from the chase camera.
    { model: 'plantPot', position: [-244, 0, 128], yaw: 0.3, scale: 1.25 },
    { model: 'plantPot', position: [-262, 0, 78], yaw: -0.4, scale: 1.0 },
    { model: 'plantPot', position: [-232, 0, 166], yaw: 0.9, scale: 0.85 },
    { model: 'plantPot', position: [252, 0, 158], yaw: -0.6, scale: 1.15 },
    { model: 'plantPot', position: [-40, 0, 214], yaw: 0.2, scale: 1.1 },
    { model: 'plantPot', position: [96, 0, -212], yaw: 1.1, scale: 0.95 },

    // The sprinkler sits in the middle of the standing water it made.
    { model: 'sprinklerHead', t: 0.612, lateral: 26, yaw: 0.4 },
    { model: 'hoseCoil', t: 0.640, lateral: 34, yaw: 0.2, scale: 1.1 },

    // ...and the hose runs from it, across the border straight, twice.
    { model: 'hoseCoil', position: [-30, 0, -176], yaw: 0.7, scale: 1.2 },
    { model: 'wateringCan', position: [-84, 0, -184], yaw: -0.5, scale: 1.15 },
    { model: 'wateringCan', position: [180, 0, 20], yaw: 0.8 },

    { model: 'trowel', position: [10, 0, 12], yaw: 0.6 },
    { model: 'trowel', position: [-150, 0, -184], yaw: -1.2 },
    { model: 'seedPacket', position: [40, 0, 8], yaw: 0.3, rotation: [0.15, 0.3, 0] },
    { model: 'seedPacket', position: [-118, 0, 90], yaw: -0.8 },

    // Brick pavers edging the sandpit loop — laid end to end on the infield
    // side, so they read as a deliberate border rather than as scattered
    // rubble. A paver is 19 u across the track and 9 along it, so the lateral
    // offsets have to clear the shoulder by more than half of 19.
    { model: 'brickPaver', t: 0.735, lateral: 31, yaw: 0 },
    { model: 'brickPaver', t: 0.748, lateral: 30, yaw: 0 },
    { model: 'brickPaver', t: 0.761, lateral: 29, yaw: 0 },
    { model: 'brickPaver', t: 0.774, lateral: 30, yaw: 0 },
    { model: 'brickPaver', t: 0.787, lateral: 31, yaw: 0 },
    { model: 'brickPaver', t: 0.290, lateral: 32, yaw: 0.1 },
    { model: 'brickPaver', t: 0.306, lateral: 33, yaw: -0.1 },

    /* ---- scattered dressing ---------------------------------------------- */

    // Grass is the single biggest reason this track reads as a garden rather
    // than as a green plane. It has no collider, so it can be dense.
    { model: 'grassTuft', count: 260, band: 'verge', offset: [4, 40], spacing: 3, tilt: 0.2, scale: [0.7, 1.6] },
    { model: 'grassTuft', count: 200, band: 'field', clear: 16, spacing: 8, tilt: 0.2, scale: [0.8, 1.8] },
    { model: 'leaf', count: 90, band: 'verge', offset: [5, 34], spacing: 3, tilt: 0.3, scale: [0.8, 1.5] },
    { model: 'leaf', count: 60, band: 'field', clear: 18, spacing: 7, tilt: 0.3, scale: [0.8, 1.6] },
    { model: 'pebble', count: 70, band: 'verge', offset: [6, 28], spacing: 4, tilt: 0.35, scale: [0.6, 1.5] },
    { model: 'pebble', count: 40, band: 'field', clear: 20, spacing: 9, tilt: 0.35, scale: [0.7, 1.7] },
    { model: 'brickPaver', count: 14, band: 'verge', offset: [12, 30], spacing: 16, align: true, tilt: 0.04 },
    { model: 'seedPacket', count: 8, band: 'field', clear: 26, spacing: 22, tilt: 0.25 },
    { model: 'plantPot', count: 9, band: 'field', clear: 54, spacing: 48, scale: [0.75, 1.3] },
    { model: 'wateringCan', count: 4, band: 'field', clear: 44, spacing: 40 },
    { model: 'hoseCoil', count: 4, band: 'field', clear: 46, spacing: 44 },
    { model: 'trowel', count: 5, band: 'field', clear: 30, spacing: 26, tilt: 0.06 },
    { model: 'sprinklerHead', count: 3, band: 'field', clear: 40, spacing: 60 },
  ],

  ambient: {
    fogColor: 0xe6c69a,
    fogDensity: 0.00085,
    dustDensity: 1.6,
  },
};
