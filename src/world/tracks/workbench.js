// world/tracks/workbench.js — SPARKPLUG CIRCUIT
//
// A garage workbench after dark, lit by one clamp lamp on a bent arm hanging in
// from high on the right. Everything outside the cone of that lamp falls away
// into blue-black, which is the whole point: this is the track that proves the
// lighting rig can do a single hard key with a deep falloff.
//
// It is also the technical one. Narrowest widths on the game (20-28), the
// tightest hairpin (R26), two separate chicanes, and two oil slicks at grip
// 0.20 — a fifth of dry pine. Nothing here is taken flat.
//
// LAYOUT — 1831 u, clockwise (the only clockwise circuit of the five):
//
//   t 0.00-0.14  THE BENCH RUN   main straight west along the bench front.
//   t 0.14-0.20  VICE CORNER     R62 right, tightening under the vice.
//   t 0.20-0.28  THE STEEL       west straight over a galvanised offcut: grip
//                                drops to 0.86 and the car will not rotate.
//   t 0.28-0.34  SOLDER         R58 right, oil across the exit.
//   t 0.34-0.49  THE LONG BENCH  north straight, the fastest part of the lap.
//   t 0.49-0.58  SPARKPLUG       R26 double-apex hairpin. Slowest corner in the
//                                game; second gear and a lot of patience.
//   t 0.58-0.71  DRAWER CHICANE  four-apex chicane through the sawdust.
//   t 0.71-0.80  CLAMP LOOP      R40 left 180 at the far end.
//   t 0.80-0.86  THE OFFCUT      ramp off a stack of pine, then the tool slot:
//                                a 14 u gap straight through the bench.
//   t 0.86-0.94  TAPE CHICANE    second chicane, over gaffa tape (grip 1.04 —
//                                the grippiest surface on the lap, and the only
//                                place a late lunge sticks).
//   t 0.94-1.00  SAWHORSE        R40 right back onto the main straight.

export default {
  id: 'workbench',
  name: 'SPARKPLUG CIRCUIT',
  theme: 'workbench',
  lighting: 'dusk',
  seed: 88041,
  laps: 3,
  difficulty: 3,

  startT: 0.065,
  gridSize: 12,

  surface: 'pine',
  offTrackSurface: 'sawdust',
  groundSurface: 'pine',
  shoulderWidth: 8,
  roadRaise: 0.5,
  groundRelief: 0.18,
  roadRelief: 0.09,
  groundPad: 340,
  maxBanking: 0.10,   // a bench does not bank; keep the cue subliminal

  path: [
    [112, 0, -152], [90, 0, -152], [68, 0, -152], [46, 0, -153], [24, 0, -155], [2, 0, -157],
    [-20, 0, -158], [-42, 0, -158], [-64, 0, -156], [-86, 0, -154], [-108, 0, -151], [-130, 0, -150],
    [-152, 0, -150], [-173, 0, -144], [-191, 0, -131], [-203, 0, -112], [-208, 0, -91], [-208, 0, -69],
    [-208, 0, -47], [-208, 0, -25], [-208, 0, -3], [-208, 0, 19], [-208, 0, 41], [-208, 0, 63],
    [-207, 0, 85], [-199, 0, 106], [-184, 0, 122], [-164, 0, 131], [-142, 0, 133], [-120, 0, 134],
    [-98, 0, 135], [-76, 0, 135], [-54, 0, 135], [-32, 0, 133], [-10, 0, 131], [12, 0, 129],
    [34, 0, 127], [56, 0, 126], [78, 0, 127], [100, 0, 127], [122, 0, 128], [144, 0, 129],
    [166, 0, 129], [187, 0, 124], [198, 0, 106], [198, 0, 84], [196, 0, 62], [181, 0, 46],
    [160, 0, 44], [138, 0, 43], [116, 0, 41], [94, 0, 41], [73, 0, 49], [54, 0, 59],
    [32, 0, 56], [13, 0, 45], [-8, 0, 41], [-29, 0, 48], [-50, 0, 55], [-72, 0, 52],
    [-93, 0, 48], [-115, 0, 43], [-131, 0, 29], [-138, 0, 8], [-137, 0, -14], [-127, 0, -33],
    [-108, 0, -44], [-86, 0, -46], [-64, 0, -47], [-42, 0, -47], [-20, 0, -45], [2, 0, -42],
    [23, 0, -37], [45, 0, -37], [65, 0, -47], [85, 0, -56], [107, 0, -54], [128, 0, -53],
    [146, 0, -66], [152, 0, -87], [152, 0, -109], [148, 0, -130], [133, 0, -146],
  ],

  widthProfile: [
    { t: 0.00, width: 28 },
    { t: 0.12, width: 26 },
    { t: 0.17, width: 23 },   // Vice Corner
    { t: 0.23, width: 25 },
    { t: 0.31, width: 23 },   // Solder
    { t: 0.40, width: 28 },   // the long bench, the one wide place
    { t: 0.47, width: 24 },
    { t: 0.52, width: 22 },   // Sparkplug hairpin — the contract floor
    { t: 0.57, width: 22 },
    { t: 0.62, width: 24 },
    { t: 0.66, width: 22 },   // Drawer chicane
    { t: 0.70, width: 22 },
    { t: 0.75, width: 24 },   // Clamp Loop
    { t: 0.81, width: 26 },   // the offcut ramp needs landing room
    { t: 0.86, width: 24 },
    { t: 0.90, width: 22 },   // Tape chicane
    { t: 0.96, width: 25 },
  ],

  surfaceSpans: [
    { from: 0.000, to: 0.135, surface: 'pine' },
    { from: 0.135, to: 0.205, surface: 'plasticMatte' },      // a cutting mat
    { from: 0.205, to: 0.290, surface: 'galvanisedSteel' },   // sheet offcut, low grip
    { from: 0.290, to: 0.365, surface: 'pine' },
    { from: 0.365, to: 0.470, surface: 'brushedAluminium' },  // the rule laid along the bench
    { from: 0.470, to: 0.585, surface: 'pine' },
    { from: 0.585, to: 0.720, surface: 'sawdust' },           // under the saw
    { from: 0.720, to: 0.840, surface: 'pine' },
    { from: 0.840, to: 0.930, surface: 'gaffaTape' },         // the taped repair
    { from: 0.930, to: 1.000, surface: 'pine' },
  ],

  hazards: [
    // Oil. Grip 0.20 — a fifth of the pine either side of it. Both slicks are
    // deliberately off-centre so the fast line only clips them if the driver is
    // greedy, and both are on corner exits where that is tempting.
    { type: 'oil', id: 'solderOil', t: 0.334, length: 34, width: 15, offset: 6 },
    { type: 'oil', id: 'drainOil', t: 0.612, length: 30, width: 13, offset: -7 },
    { type: 'oil', id: 'canOil', t: 0.898, length: 26, width: 12, offset: 5 },

    // Bolts and washers rolled loose across the bench.
    { type: 'bump', id: 'boltA', t: 0.262, length: 8, height: 1.5, width: 18, offset: -4 },
    { type: 'bump', id: 'boltB', t: 0.276, length: 8, height: 1.3, width: 16, offset: 6 },
    { type: 'bump', id: 'ruleEdge', t: 0.368, length: 10, height: 1.1, width: 30 },
    { type: 'bump', id: 'ruleEdge2', t: 0.466, length: 10, height: 1.1, width: 30 },

    // The offcut ramp and the tool slot immediately after it. Cars arrive at
    // roughly 78 u/s off the Clamp Loop; 10.5 u of rise over 22 puts them 18 u
    // down the road, and the slot needs 11.5 of that. The margin is deliberately
    // generous — this is the technical circuit, not the cruel one.
    { type: 'ramp', id: 'offcutRamp', t: 0.8075, length: 22, height: 10.5, width: 26 },
    { type: 'gap', id: 'toolSlot', t: 0.8165, length: 10, depth: 22, width: 32 },

    // The tape is rucked where it was pressed down over the slot's far lip.
    { type: 'bump', id: 'tapeLip', t: 0.845, length: 10, height: 1.4, width: 26 },
  ],

  walls: [
    { from: 0.140, to: 0.205, side: 'left', height: 4.4 },
    { from: 0.280, to: 0.345, side: 'left', height: 4.4 },
    { from: 0.492, to: 0.590, side: 'left', height: 3.8 },
    { from: 0.725, to: 0.805, side: 'right', height: 3.8 },
    { from: 0.925, to: 1.000, side: 'left', height: 4.2 },
  ],

  decals: [
    { kind: 'oil', t: 0.334, lateral: 6, radius: 18, aspect: 1.9, opacity: 0.95 },
    { kind: 'oil', t: 0.352, lateral: 11, radius: 11, aspect: 1.5, opacity: 0.7 },
    { kind: 'oil', t: 0.612, lateral: -7, radius: 16, aspect: 1.7, opacity: 0.95 },
    { kind: 'oil', t: 0.898, lateral: 5, radius: 14, aspect: 1.6, opacity: 0.9 },
    { kind: 'oil', position: [-52, -96], radius: 20, aspect: 1.4, rotation: 0.4, opacity: 0.85 },
    { kind: 'oil', position: [172, 12], radius: 15, opacity: 0.8 },
    { kind: 'oil', position: [-246, 60], radius: 22, aspect: 1.8, rotation: -0.7, opacity: 0.8 },
    { kind: 'sawdustPile', t: 0.640, lateral: 0, radius: 30, aspect: 1.6, opacity: 0.85 },
    { kind: 'sawdustPile', t: 0.680, lateral: -8, radius: 22, opacity: 0.75 },
    { kind: 'sawdustPile', position: [10, 90], radius: 34, opacity: 0.7 },
    { kind: 'sawdustPile', position: [-176, -96], radius: 28, opacity: 0.6 },
    { kind: 'sootScorch', position: [96, -100], radius: 16, opacity: 0.7 },
    { kind: 'sootScorch', t: 0.526, lateral: 0, radius: 13, opacity: 0.55 },
    { kind: 'paintSplash', position: [-140, 96], radius: 18, aspect: 1.5, opacity: 0.8 },
    { kind: 'paintSplash', position: [214, -140], radius: 14, opacity: 0.75 },
    { kind: 'rubberPatch', t: 0.548, lateral: -5, radius: 15, aspect: 2.2, opacity: 0.6 },
    { kind: 'rubberPatch', t: 0.175, lateral: -5, radius: 18, aspect: 2.5, opacity: 0.5 },
    { kind: 'rubberPatch', t: 0.975, lateral: 5, radius: 17, aspect: 2.4, opacity: 0.5 },
  ],

  props: [
    /* ---- focal composition ------------------------------------------------ */

    // A paint tin and an oil can bracket the Sparkplug hairpin. They are the two
    // tallest silhouettes on the circuit and they sit where the lamp cone is
    // brightest, so the slowest corner is also the best-lit one.
    { model: 'paintTin', position: [238, 0, 118], yaw: 0.3, scale: 1.2 },
    { model: 'paintTin', position: [256, 0, 60], yaw: -0.7, scale: 1.0 },
    { model: 'oilCan', position: [232, 0, 26], yaw: 0.9, scale: 1.15 },
    { model: 'oilCan', position: [-52, 0, -96], yaw: 2.4, scale: 1.0 },
    { model: 'paintTin', position: [-262, 0, -74], yaw: 0.5, scale: 1.1 },
    { model: 'paintTin', position: [-38, 0, 200], yaw: -0.4, scale: 0.95 },

    // The stack of pine the ramp is cut from, right beside the ramp.
    { model: 'woodOffcut', t: 0.806, lateral: -28, yaw: 0.04, scale: 1.2 },
    { model: 'woodOffcut', t: 0.806, lateral: -28, y: 4.1, yaw: 0.16, scale: 1.15 },
    { model: 'woodOffcut', t: 0.812, lateral: 28, yaw: -0.06, scale: 1.2 },
    { model: 'woodOffcut', position: [176, 0, -178], yaw: 0.8, scale: 1.1 },
    { model: 'woodOffcut', position: [186, 4.0, -176], yaw: 0.55, scale: 1.05 },

    // Hand tools laid along the bench edge, aligned so they read as a tidy row.
    { model: 'screwdriver', t: 0.052, lateral: -30, yaw: 0.02 },
    { model: 'screwdriver', t: 0.068, lateral: -34, yaw: -0.02, color: 0x2c7bd0 },
    { model: 'wrench', t: 0.086, lateral: -32, yaw: 0.03 },
    { model: 'wrench', t: 0.104, lateral: -36, yaw: -0.05 },
    { model: 'screwdriver', t: 0.412, lateral: 30, yaw: 3.14 },
    { model: 'wrench', t: 0.432, lateral: 33, yaw: 3.10 },

    { model: 'tapeRoll', t: 0.868, lateral: -26, yaw: 0.4 },
    { model: 'tapeRoll', position: [-96, 0, 90], yaw: 0.9, scale: 1.1 },
    { model: 'springCoil', position: [24, 0, -100], yaw: 0.2 },
    { model: 'springCoil', position: [-160, 0, 88], yaw: 1.4 },
    { model: 'sandpaperSheet', position: [-30, 0, -98], yaw: 0.35 },
    { model: 'sandpaperSheet', position: [70, 0, 92], yaw: -0.6 },
    { model: 'jamJar', position: [-6, 0, -104], yaw: 0.6, scale: 1.1 },   // full of screws
    { model: 'jamJar', position: [124, 0, 96], yaw: -0.3 },

    /* ---- scattered dressing ---------------------------------------------- */

    { model: 'bolt', count: 60, band: 'verge', offset: [6, 26], spacing: 3, tilt: 0.4, scale: [0.8, 1.3] },
    { model: 'nut', count: 70, band: 'verge', offset: [5, 28], spacing: 3, tilt: 0.5, scale: [0.8, 1.4] },
    { model: 'bolt', count: 30, band: 'field', clear: 18, spacing: 7, tilt: 0.4 },
    { model: 'nut', count: 34, band: 'field', clear: 18, spacing: 6, tilt: 0.5 },
    { model: 'pebble', count: 40, band: 'verge', offset: [6, 26], spacing: 4, tilt: 0.4, scale: [0.5, 1.1] },
    { model: 'battery', count: 12, band: 'verge', offset: [8, 28], spacing: 10, tilt: 0.1 },
    { model: 'eraser', count: 10, band: 'verge', offset: [8, 26], spacing: 9, tilt: 0.2 },
    { model: 'bottleCap', count: 14, band: 'verge', offset: [7, 28], spacing: 8, tilt: 0.3 },
    { model: 'pencil', count: 8, band: 'field', clear: 24, spacing: 26, tilt: 0.05 },
    { model: 'springCoil', count: 9, band: 'field', clear: 26, spacing: 22, tilt: 0.2 },
    { model: 'sandpaperSheet', count: 8, band: 'field', clear: 26, spacing: 24, tilt: 0.05 },
    { model: 'tapeRoll', count: 7, band: 'field', clear: 30, spacing: 26 },
    { model: 'woodOffcut', count: 12, band: 'field', clear: 40, spacing: 34, tilt: 0.06, scale: [0.85, 1.25] },
    { model: 'screwdriver', count: 8, band: 'field', clear: 28, spacing: 24, tilt: 0.05 },
    { model: 'wrench', count: 7, band: 'field', clear: 28, spacing: 24, tilt: 0.05 },
    { model: 'oilCan', count: 4, band: 'field', clear: 44, spacing: 44 },
    { model: 'paintTin', count: 6, band: 'field', clear: 52, spacing: 48, scale: [0.85, 1.2] },
    { model: 'jamJar', count: 6, band: 'field', clear: 38, spacing: 28 },
  ],

  ambient: {
    fogColor: 0x2c3348,
    fogDensity: 0.0016,
    dustDensity: 2.2,
  },
};
