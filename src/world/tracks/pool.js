// world/tracks/pool.js — FELT SPEEDWAY
//
// Nine feet of slate under an even, sourceless overcast. No hard key, no long
// shadows: this circuit exists to prove the renderer can carry a frame on
// material and ambient occlusion alone. Baize has a nap — a fine wool pile with
// real sheen and real anisotropy — and it is the only surface in the game that
// grips harder than a road tyre deserves (1.14). The result is the fastest lap
// of the five and the one with the highest minimum speed.
//
// Two 86 u sweepers taken absolutely flat, a jump over a cue that has been left
// lying across the table, and a scattering of loose balls sitting on the racing
// line that a 90 u/s car will send the length of the cloth.
//
// LAYOUT — 1829 u, clockwise:
//
//   t 0.00-0.13  BAULK LINE     main straight, east along the top cushion.
//   t 0.10       THE CUE        ramp over the cue. Flat out; it is a crest, not
//                               a brake point, and the car lands mid-corner.
//   t 0.13-0.23  TOP POCKET     R86 right sweeper, chalked to hell on entry.
//   t 0.23-0.29  LONG RAIL      east straight down the cushion.
//   t 0.29-0.36  BOTTOM POCKET  R86 right sweeper over the rubber cushion —
//                               grip 1.10, and the only part of the lap where
//                               a car can carry more than it should.
//   t 0.36-0.49  THE BREAK      south straight, where the loose balls end up.
//   t 0.49-0.58  BAULK HAIRPIN  R38 double-apex, slowest corner on the circuit
//                               and still quicker than most tracks' fast ones.
//   t 0.58-0.74  THE D          infield esses: three R40 direction changes with
//                               no straight between them.
//   t 0.74-0.80  RACK LOOP      R44 left 180 round the triangle.
//   t 0.80-0.94  SCORE SHEET    infield return over a paper scorecard: grip
//                               0.82, and it is exactly wide enough to go round.
//   t 0.94-1.00  SPIDER         R43 right 180 back onto the baulk line.

export default {
  id: 'pool',
  name: 'FELT SPEEDWAY',
  theme: 'pool',
  lighting: 'overcast',
  seed: 40615,
  laps: 4,          // shortest lap time of the five, so it gets an extra lap
  difficulty: 2,

  startT: 0.055,
  gridSize: 12,

  surface: 'poolFelt',
  offTrackSurface: 'poolFelt',
  groundSurface: 'poolFelt',
  shoulderWidth: 9,
  roadRaise: 0.42,      // slate is flat; the ribbon barely stands proud of it
  groundRelief: 0.10,
  roadRelief: 0.06,
  groundPad: 300,
  maxBanking: 0.09,

  path: [
    [-115, 0, 144], [-93, 0, 143], [-71, 0, 143], [-49, 0, 143], [-27, 0, 144], [-5, 0, 145],
    [17, 0, 146], [39, 0, 147], [61, 0, 147], [83, 0, 147], [105, 0, 146], [127, 0, 145],
    [148, 0, 140], [168, 0, 130], [184, 0, 116], [196, 0, 97], [203, 0, 76], [205, 0, 54],
    [205, 0, 32], [205, 0, 10], [205, 0, -12], [205, 0, -34], [205, 0, -56], [203, 0, -78],
    [196, 0, -98], [183, 0, -116], [167, 0, -131], [147, 0, -141], [126, 0, -145], [104, 0, -146],
    [82, 0, -147], [60, 0, -147], [38, 0, -147], [16, 0, -146], [-6, 0, -145], [-28, 0, -144],
    [-50, 0, -142], [-72, 0, -142], [-94, 0, -142], [-116, 0, -142], [-138, 0, -142], [-161, 0, -142],
    [-182, 0, -138], [-198, 0, -124], [-204, 0, -103], [-204, 0, -81], [-199, 0, -60], [-183, 0, -45],
    [-162, 0, -39], [-140, 0, -36], [-118, 0, -37], [-97, 0, -41], [-77, 0, -50], [-56, 0, -57],
    [-34, 0, -54], [-15, 0, -44], [5, 0, -34], [26, 0, -31], [47, 0, -39], [67, 0, -49],
    [88, 0, -52], [108, 0, -44], [125, 0, -29], [132, 0, -9], [132, 0, 13], [129, 0, 35],
    [115, 0, 52], [95, 0, 61], [73, 0, 63], [51, 0, 64], [29, 0, 64], [7, 0, 62],
    [-15, 0, 59], [-36, 0, 56], [-58, 0, 54], [-80, 0, 54], [-102, 0, 55], [-124, 0, 56],
    [-144, 0, 65], [-157, 0, 83], [-160, 0, 104], [-153, 0, 125], [-137, 0, 140],
  ],

  widthProfile: [
    { t: 0.00, width: 34 },   // the widest road in the game
    { t: 0.09, width: 32 },
    { t: 0.17, width: 30 },   // Top Pocket
    { t: 0.25, width: 33 },
    { t: 0.32, width: 30 },   // Bottom Pocket
    { t: 0.42, width: 34 },   // the Break — the overtaking straight
    { t: 0.50, width: 29 },
    { t: 0.545, width: 26 },  // Baulk hairpin
    { t: 0.60, width: 28 },
    { t: 0.66, width: 27 },   // the D
    { t: 0.72, width: 27 },
    { t: 0.77, width: 28 },   // Rack Loop
    { t: 0.85, width: 32 },
    { t: 0.91, width: 31 },
    { t: 0.96, width: 28 },   // Spider
  ],

  surfaceSpans: [
    { from: 0.000, to: 0.140, surface: 'poolFelt' },
    { from: 0.140, to: 0.235, surface: 'chalkLine' },     // chalk dust, worked in
    { from: 0.235, to: 0.300, surface: 'poolFelt' },
    { from: 0.300, to: 0.372, surface: 'rubber' },        // over the cushion
    { from: 0.372, to: 0.520, surface: 'poolFelt' },
    { from: 0.520, to: 0.600, surface: 'chalkLine' },
    { from: 0.600, to: 0.700, surface: 'poolFelt' },
    { from: 0.700, to: 0.782, surface: 'paper' },         // the scorecard
    { from: 0.782, to: 0.908, surface: 'poolFelt' },
    { from: 0.908, to: 1.000, surface: 'chalkLine' },
  ],

  hazards: [
    // The cue. Long, shallow, and taken flat: the car crests it at 105 u/s and
    // lands about a car length into Top Pocket, which is what makes it a corner
    // entry problem rather than a jump.
    { type: 'ramp', id: 'theCue', t: 0.104, length: 32, height: 7.5, width: 32 },

    // The triangle, propped on its edge at the Rack Loop apex.
    { type: 'ramp', id: 'theRack', t: 0.828, length: 24, height: 5.5, width: 18, offset: -6 },

    // Cushion rubber, standing proud where it has lifted from the rail.
    { type: 'bump', id: 'cushionA', t: 0.306, length: 12, height: 1.6, width: 34 },
    { type: 'bump', id: 'cushionB', t: 0.366, length: 12, height: 1.4, width: 34 },

    // Trodden-in chalk. Not a spill — a surface patch that eats the front end
    // if the car is still turning when it arrives.
    { type: 'chalk', id: 'chalkA', t: 0.168, length: 40, width: 16, offset: -8, surface: 'chalkLine' },
    { type: 'chalk', id: 'chalkB', t: 0.556, length: 34, width: 14, offset: 7, surface: 'chalkLine' },
    { type: 'chalk', id: 'chalkC', t: 0.952, length: 36, width: 15, offset: -7, surface: 'chalkLine' },
  ],

  walls: [
    { from: 0.126, to: 0.240, side: 'left', height: 4.8 },
    { from: 0.286, to: 0.372, side: 'left', height: 4.8 },
    { from: 0.488, to: 0.590, side: 'left', height: 4.2 },
    { from: 0.735, to: 0.808, side: 'right', height: 4.0 },
    { from: 0.930, to: 1.000, side: 'left', height: 4.4 },
  ],

  decals: [
    // The pockets: six of them, painted straight onto the slate outside the
    // ribbon so the shape of the table reads even when the cushions are out of
    // frame. They are decals, not holes — a car cannot fall into one.
    { kind: 'pocket', position: [-252, 196], radius: 22 },
    { kind: 'pocket', position: [252, 196], radius: 22 },
    { kind: 'pocket', position: [-252, -196], radius: 22 },
    { kind: 'pocket', position: [252, -196], radius: 22 },
    { kind: 'pocket', position: [0, 208], radius: 20 },
    { kind: 'pocket', position: [0, -208], radius: 20 },

    { kind: 'chalkScuff', t: 0.168, lateral: -8, radius: 26, aspect: 1.8, opacity: 0.85 },
    { kind: 'chalkScuff', t: 0.196, lateral: -2, radius: 20, aspect: 1.5, opacity: 0.7 },
    { kind: 'chalkScuff', t: 0.556, lateral: 7, radius: 22, aspect: 1.6, opacity: 0.8 },
    { kind: 'chalkScuff', t: 0.952, lateral: -7, radius: 22, aspect: 1.7, opacity: 0.75 },
    { kind: 'chalkScuff', position: [-160, 4], radius: 24, opacity: 0.6 },
    { kind: 'chalkScuff', position: [60, 8], radius: 20, opacity: 0.55 },
    { kind: 'chalkScuff', position: [230, 120], radius: 26, opacity: 0.5 },
    { kind: 'rubberPatch', t: 0.545, lateral: 0, radius: 20, aspect: 2.4, opacity: 0.6 },
    { kind: 'rubberPatch', t: 0.140, lateral: -6, radius: 22, aspect: 2.8, opacity: 0.5 },
    { kind: 'rubberPatch', t: 0.780, lateral: 5, radius: 19, aspect: 2.3, opacity: 0.5 },
    { kind: 'water', position: [-118, -96], radius: 18, aspect: 1.5, opacity: 0.35 },
    { kind: 'coffeeRing', position: [150, 96], radius: 10, opacity: 0.7 },
    { kind: 'coffeeRing', position: [-196, 118], radius: 9, opacity: 0.6 },
  ],

  props: [
    /* ---- the table itself ------------------------------------------------- */

    // Six cues laid end to end make the cushion rails. Each is 145 u long, so
    // three a side covers the whole table and the eye completes the rectangle.
    { model: 'cueStick', position: [-150, 0, 196], yaw: 1.5708 },
    { model: 'cueStick', position: [8, 0, 200], yaw: 1.5708 },
    { model: 'cueStick', position: [160, 0, 196], yaw: 1.5708 },
    { model: 'cueStick', position: [-150, 0, -198], yaw: 1.5708 },
    { model: 'cueStick', position: [8, 0, -202], yaw: 1.5708 },
    { model: 'cueStick', position: [160, 0, -198], yaw: 1.5708 },
    { model: 'cueStick', position: [-262, 0, -60], yaw: 0 },
    { model: 'cueStick', position: [-262, 0, 90], yaw: 0 },
    { model: 'cueStick', position: [268, 0, -60], yaw: 0 },
    { model: 'cueStick', position: [268, 0, 90], yaw: 0 },

    // The cue that makes the jump, lying across the ribbon under the ramp. Sunk
    // so only its top shoulder stands proud of the crest: the hazard does the
    // launching, and a 145 u collider across the racing line would be a wall.
    { model: 'cueStick', t: 0.104, lateral: 0, y: -2.6, yaw: 1.5708, collide: false, scale: 0.95 },

    // The rack, out in the open infield rather than on the loop's verge — it is
    // 40 u across the flats and will not fit inside a 44 u corridor otherwise.
    { model: 'triangleRack', position: [20, 0, 16], yaw: 0.3, scale: 1.15 },
    { model: 'triangleRack', position: [-232, 0, 168], yaw: -0.6 },

    /* ---- the balls -------------------------------------------------------- */

    // A broken rack: seven balls left where the last shot put them, four of them
    // genuinely on the racing line. They are knockable, restitution 0.86, and a
    // car at 90 u/s will send one the length of the table.
    { model: 'poolBall', t: 0.430, lateral: -4, color: 0xf2c419 },
    { model: 'poolBallStripe', t: 0.448, lateral: 7, color: 0x2e5fbc },
    { model: 'poolBall', t: 0.462, lateral: -9, color: 0xc0392b },
    { model: 'poolBallStripe', t: 0.618, lateral: 5, color: 0x8e44ad },
    { model: 'poolBall', t: 0.646, lateral: -6, color: 0xe07b1e },
    { model: 'poolBall', t: 0.882, lateral: 8, color: 0x1e8449 },
    { model: 'poolBallStripe', t: 0.900, lateral: -5, color: 0x7b3f1d },
    { model: 'poolBall', position: [-60, 0, 6], color: 0x1b1b1b },      // the eight
    { model: 'poolBall', position: [-44, 0, -2], color: 0xf6f4ec },     // the cue ball
    { model: 'poolBall', position: [64, 0, 4], color: 0xf2c419 },
    { model: 'poolBallStripe', position: [78, 0, -6], color: 0x2e5fbc },

    { model: 'chalkCube', position: [-30, 0, 10], yaw: 0.4 },
    { model: 'chalkCube', t: 0.166, lateral: 30, yaw: 0.9 },
    { model: 'chalkCube', t: 0.550, lateral: -30, yaw: -0.5 },
    { model: 'coaster', position: [150, 0, 96], yaw: 0.2 },
    { model: 'coaster', position: [-196, 0, 118], yaw: 0.8 },

    /* ---- scattered dressing ---------------------------------------------- */

    { model: 'poolBall', count: 10, band: 'field', clear: 24, spacing: 16 },
    { model: 'poolBallStripe', count: 9, band: 'field', clear: 24, spacing: 16 },
    { model: 'poolBall', count: 6, band: 'verge', offset: [7, 24], spacing: 12 },
    { model: 'poolBallStripe', count: 6, band: 'verge', offset: [7, 24], spacing: 12 },
    { model: 'chalkCube', count: 16, band: 'verge', offset: [6, 26], spacing: 8, tilt: 0.25 },
    { model: 'chalkCube', count: 10, band: 'field', clear: 20, spacing: 14, tilt: 0.25 },
    { model: 'toyDie', count: 12, band: 'verge', offset: [6, 24], spacing: 6, tilt: 0.4 },
    { model: 'coin', count: 14, band: 'verge', offset: [8, 26], spacing: 8, tilt: 0.06 },
    { model: 'coaster', count: 9, band: 'field', clear: 26, spacing: 22 },
    { model: 'triangleRack', count: 3, band: 'field', clear: 46, spacing: 60 },
    // No scattered cues: at 145 u long, a random yaw would put one end across
    // the racing line from any placement the field band can actually find.
  ],

  ambient: {
    fogColor: 0xa8b6ad,
    fogDensity: 0.00040,
    dustDensity: 0.55,
  },
};
