// world/tracks/bedroom.js — CARPET CHAOS
//
// Half past nine, one bedside lamp, and a circuit taped out across a bedroom
// floor by somebody who was supposed to be asleep. The key is a single warm
// point source low and to the north; everything else in frame is lit by what
// bounces off the carpet, which is why the pile has to read.
//
// Longest lap of the five at 1903 u, and the one with the most surface changes:
// laminate, rug, carpet, cardboard, paper and a plastic play mat, with rolling
// resistance swinging from 0.009 on the boards to 0.052 on the rug. A car set
// up for the boards understeers on the pile and vice versa; the compromise is
// the whole game here.
//
// LAYOUT — 1903 u, counter-clockwise:
//
//   t 0.00-0.13  THE BOARDS      main straight east along bare laminate.
//   t 0.15       PAPERBACK       ramp off a book left face-down on the floor.
//   t 0.13-0.24  THE WARDROBE    R28 double-apex hairpin in the corner. The
//                                slowest, tightest, most walled corner here.
//   t 0.24-0.36  CRAYON RUN      infield straight west, through a spilled box
//                                of crayons that roll when hit.
//   t 0.31-0.36  THE SCRIBBLE    R26 chicane over cardboard.
//   t 0.36-0.45  TOYBOX          R40 right-hand 180 at the west end.
//   t 0.45-0.53  THE VENT        infield straight east — with a 12 u floor vent
//                                across it that has to be taken at speed.
//   t 0.53-0.60  BRICK CHICANE   R28 flick through a wall of building blocks.
//   t 0.60-0.68  THE STACK       R41 left 180 round a tower of books, with the
//                                second ramp on its apex.
//   t 0.68-0.83  THE RUG         north straight over deep pile: 0.052 rolling
//                                drag, and it eats a fifth of the top speed.
//   t 0.83-1.00  BEDSIDE         two R60-plus sweepers back to the boards,
//                                straight through the pool of lamplight.

export default {
  id: 'bedroom',
  name: 'CARPET CHAOS',
  theme: 'bedroom',
  lighting: 'nightLamp',
  seed: 61207,
  laps: 3,
  difficulty: 2,

  startT: 0.062,
  gridSize: 12,

  surface: 'laminate',
  offTrackSurface: 'carpet',
  groundSurface: 'carpet',
  shoulderWidth: 8,
  roadRaise: 0.5,
  groundRelief: 0.40,   // carpet is soft and uneven
  roadRelief: 0.12,
  groundPad: 340,

  path: [
    [-140, 0, -152], [-118, 0, -152], [-96, 0, -152], [-74, 0, -152], [-52, 0, -152], [-31, 0, -153],
    [-9, 0, -155], [13, 0, -156], [35, 0, -157], [57, 0, -158], [79, 0, -157], [101, 0, -156],
    [122, 0, -155], [144, 0, -154], [166, 0, -153], [187, 0, -148], [198, 0, -129], [198, 0, -107],
    [198, 0, -86], [186, 0, -67], [166, 0, -61], [144, 0, -58], [122, 0, -55], [101, 0, -52],
    [79, 0, -53], [58, 0, -58], [38, 0, -68], [18, 0, -76], [-3, 0, -71], [-22, 0, -60],
    [-41, 0, -50], [-62, 0, -46], [-84, 0, -49], [-105, 0, -51], [-126, 0, -44], [-139, 0, -27],
    [-142, 0, -5], [-140, 0, 17], [-127, 0, 34], [-107, 0, 40], [-85, 0, 43], [-63, 0, 44],
    [-41, 0, 43], [-20, 0, 41], [2, 0, 37], [23, 0, 32], [44, 0, 26], [66, 0, 27],
    [85, 0, 37], [105, 0, 46], [125, 0, 53], [147, 0, 49], [168, 0, 50], [186, 0, 63],
    [195, 0, 82], [193, 0, 104], [180, 0, 121], [161, 0, 129], [139, 0, 131], [117, 0, 131],
    [95, 0, 132], [73, 0, 133], [51, 0, 133], [29, 0, 131], [8, 0, 130], [-14, 0, 128],
    [-36, 0, 126], [-58, 0, 125], [-80, 0, 125], [-102, 0, 125], [-123, 0, 126], [-145, 0, 126],
    [-167, 0, 122], [-185, 0, 111], [-199, 0, 94], [-205, 0, 73], [-206, 0, 51], [-206, 0, 29],
    [-206, 0, 7], [-206, 0, -15], [-206, 0, -37], [-206, 0, -58], [-206, 0, -80], [-204, 0, -102],
    [-195, 0, -122], [-181, 0, -138], [-161, 0, -148],
  ],

  widthProfile: [
    { t: 0.00, width: 30 },
    { t: 0.11, width: 27 },
    { t: 0.16, width: 24 },   // into the Wardrobe
    { t: 0.20, width: 22 },   // hairpin apex — tightest road on the track
    { t: 0.25, width: 26 },
    { t: 0.31, width: 23 },   // Scribble chicane
    { t: 0.36, width: 24 },
    { t: 0.42, width: 25 },   // Toybox
    { t: 0.48, width: 28 },   // the Vent needs room to land
    { t: 0.55, width: 23 },   // Brick chicane
    { t: 0.59, width: 23 },
    { t: 0.63, width: 26 },   // the Stack
    { t: 0.72, width: 30 },   // the Rug, two lines wide
    { t: 0.80, width: 29 },
    { t: 0.86, width: 26 },
    { t: 0.95, width: 28 },
  ],

  surfaceSpans: [
    { from: 0.000, to: 0.120, surface: 'laminate' },
    { from: 0.120, to: 0.235, surface: 'rug' },          // the runner in the corner
    { from: 0.235, to: 0.330, surface: 'carpet' },
    { from: 0.330, to: 0.430, surface: 'cardboard' },    // a flattened box
    { from: 0.430, to: 0.520, surface: 'laminate' },
    { from: 0.520, to: 0.618, surface: 'plasticGloss' }, // the play mat
    { from: 0.618, to: 0.690, surface: 'paper' },        // a drawing, taped down
    { from: 0.690, to: 0.845, surface: 'rug' },          // the big rug
    { from: 0.845, to: 0.930, surface: 'carpet' },
    { from: 0.930, to: 1.000, surface: 'laminate' },
  ],

  hazards: [
    // Two books, face down, propped open. 8 u of rise over 26 is about 22 u of
    // carry at 90 u/s — over the crayons and onto the rug.
    { type: 'ramp', id: 'paperback', t: 0.148, length: 26, height: 8.0, width: 26 },
    { type: 'ramp', id: 'hardback', t: 0.655, length: 24, height: 7.0, width: 24, offset: -3 },

    // The floor vent. No ramp in front of it, so it is crossed on momentum
    // alone: 9 u at 80 u/s is 0.11 s of air and 1.7 u of drop, which reads as a
    // hard rumble rather than as a jump. Stopping in it still means a respawn.
    { type: 'gap', id: 'floorVent', t: 0.474, length: 9, depth: 12, width: 30 },

    // The edge of the rug, twice, plus the lip of the cardboard.
    { type: 'bump', id: 'rugEdgeA', t: 0.122, length: 10, height: 1.8, width: 32 },
    { type: 'bump', id: 'rugEdgeB', t: 0.232, length: 10, height: 1.8, width: 32 },
    { type: 'bump', id: 'cardLip', t: 0.334, length: 9, height: 1.3, width: 26 },
    { type: 'bump', id: 'rugEdgeC', t: 0.692, length: 11, height: 2.0, width: 32 },
    { type: 'bump', id: 'rugEdgeD', t: 0.842, length: 11, height: 2.0, width: 32 },

    // Crayon wax ground into the boards. Not much grip loss — 0.42 is the same
    // as the milk on the kitchen table — but it is exactly on the apex.
    { type: 'wax', id: 'crayonSmear', t: 0.286, length: 30, width: 13, offset: -6, surface: 'spilledMilk' },
    { type: 'wax', id: 'paintSmear', t: 0.566, length: 26, width: 12, offset: 6, surface: 'spilledMilk' },
  ],

  walls: [
    { from: 0.128, to: 0.245, side: 'right', height: 4.2 },
    { from: 0.375, to: 0.455, side: 'left', height: 3.6 },
    { from: 0.590, to: 0.665, side: 'right', height: 3.6 },
    { from: 0.815, to: 0.870, side: 'right', height: 4.4 },
    { from: 0.945, to: 1.000, side: 'right', height: 4.4 },
  ],

  decals: [
    { kind: 'crayonScrawl', t: 0.286, lateral: -6, radius: 20, aspect: 2.2, opacity: 0.9 },
    { kind: 'crayonScrawl', t: 0.310, lateral: 4, radius: 16, aspect: 1.8, opacity: 0.75 },
    { kind: 'crayonScrawl', position: [-60, 88], radius: 26, aspect: 1.6, rotation: 0.5, opacity: 0.85 },
    { kind: 'crayonScrawl', position: [40, -100], radius: 22, rotation: -0.8, opacity: 0.8 },
    { kind: 'crayonScrawl', position: [-250, 40], radius: 30, aspect: 1.4, opacity: 0.7 },
    { kind: 'paintSplash', t: 0.566, lateral: 6, radius: 18, aspect: 1.6, opacity: 0.85 },
    { kind: 'paintSplash', position: [126, 0], radius: 20, rotation: 0.9, opacity: 0.8 },
    { kind: 'inkBlot', position: [-108, -104], radius: 15, opacity: 0.85 },
    { kind: 'inkBlot', t: 0.640, lateral: -8, radius: 12, opacity: 0.7 },
    { kind: 'juice', position: [188, 150], radius: 22, aspect: 1.5, opacity: 0.7 },
    { kind: 'juice', t: 0.760, lateral: 10, radius: 16, opacity: 0.6 },
    { kind: 'crumbPatch', position: [-160, -96], radius: 26, opacity: 0.55 },
    { kind: 'crumbPatch', t: 0.885, lateral: -8, radius: 20, opacity: 0.5 },
    { kind: 'rubberPatch', t: 0.205, lateral: -5, radius: 15, aspect: 2.2, opacity: 0.55 },
    { kind: 'rubberPatch', t: 0.430, lateral: 6, radius: 17, aspect: 2.4, opacity: 0.5 },
    { kind: 'rubberPatch', t: 0.982, lateral: -6, radius: 18, aspect: 2.5, opacity: 0.5 },
  ],

  props: [
    /* ---- focal composition ------------------------------------------------ */

    // The tower of books the Stack is named after, on the inside of the loop,
    // with a second stack behind it so the silhouette has depth.
    { model: 'bookStack', t: 0.622, lateral: -34, yaw: 0.25, scale: 1.15 },
    { model: 'bookStack', position: [188, 0, 6], yaw: -0.5, scale: 1.05 },
    { model: 'bookStack', position: [-262, 0, -30], yaw: 0.8, scale: 1.2 },
    { model: 'bookStack', position: [40, 0, 196], yaw: 0.15 },

    // The books that make the ramps, lying beside their own kicker.
    { model: 'book', t: 0.146, lateral: -27, yaw: 0.05, scale: 1.1 },
    { model: 'book', t: 0.152, lateral: 27, yaw: -0.04, scale: 1.1, color: 0x8c3b2b },
    { model: 'book', t: 0.658, lateral: 27, yaw: 0.06, scale: 1.05, color: 0x3f6b45 },
    { model: 'book', position: [-40, 0, -104], yaw: 0.4 },
    { model: 'book', position: [96, 0, 92], yaw: -0.7, color: 0x6b4a8c },

    // A wall of building blocks along the Brick chicane — laid as a real wall,
    // two courses high, because a scattered pile would read as noise.
    { model: 'buildingBlock', t: 0.535, lateral: -26, yaw: 0.02 },
    { model: 'buildingBlock', t: 0.541, lateral: -26, yaw: 0.02 },
    { model: 'buildingBlock', t: 0.547, lateral: -26, yaw: 0.02 },
    { model: 'buildingBlock', t: 0.538, lateral: -26, y: 5.1, yaw: 0.3 },
    { model: 'buildingBlock', t: 0.544, lateral: -26, y: 5.1, yaw: -0.2 },
    { model: 'buildingBlock', t: 0.578, lateral: 26, yaw: -0.05 },
    { model: 'buildingBlock', t: 0.584, lateral: 26, yaw: -0.05 },
    { model: 'buildingBlock', t: 0.581, lateral: 26, y: 5.1, yaw: 0.4 },

    { model: 'gameController', position: [-70, 0, 90], yaw: 0.35, scale: 1.1 },
    { model: 'gameController', position: [156, 0, -170], yaw: -0.9 },
    { model: 'tapeRoll', position: [-140, 0, 92], yaw: 0.7 },
    { model: 'woodOffcut', position: [214, 0, 128], yaw: 0.5 },
    { model: 'jigsawPiece', position: [-24, 0, -100], yaw: 0.6 },
    { model: 'jigsawPiece', position: [-14, 0, -92], yaw: 2.2 },
    { model: 'jigsawPiece', position: [-34, 0, -92], yaw: -1.1 },

    /* ---- scattered dressing ---------------------------------------------- */

    // Crayons roll. They are on the road on purpose through the Crayon Run.
    { model: 'crayon', count: 14, band: 'road', from: 0.255, to: 0.330, spacing: 9, tilt: 0.08 },
    { model: 'crayon', count: 40, band: 'verge', offset: [5, 26], spacing: 4, tilt: 0.15 },
    { model: 'crayon', count: 26, band: 'field', clear: 18, spacing: 8, tilt: 0.15 },
    { model: 'legoBrick', count: 56, band: 'verge', offset: [5, 28], spacing: 3, tilt: 0.35 },
    { model: 'legoBrick2', count: 60, band: 'verge', offset: [5, 28], spacing: 3, tilt: 0.35 },
    { model: 'legoBrick', count: 34, band: 'field', clear: 18, spacing: 6, tilt: 0.35 },
    { model: 'legoBrick2', count: 34, band: 'field', clear: 18, spacing: 6, tilt: 0.35 },
    { model: 'marble', count: 26, band: 'verge', offset: [6, 24], spacing: 5 },
    { model: 'marble', count: 8, band: 'road', from: 0.700, to: 0.820, spacing: 16 },
    { model: 'toyDie', count: 18, band: 'verge', offset: [6, 26], spacing: 6, tilt: 0.4 },
    { model: 'dominoTile', count: 22, band: 'verge', offset: [7, 26], spacing: 7, tilt: 0.2 },
    { model: 'jigsawPiece', count: 26, band: 'verge', offset: [6, 30], spacing: 6, tilt: 0.2 },
    { model: 'jigsawPiece', count: 18, band: 'field', clear: 20, spacing: 9, tilt: 0.2 },
    { model: 'buildingBlock', count: 22, band: 'verge', offset: [10, 30], spacing: 9, tilt: 0.1 },
    { model: 'buildingBlock', count: 16, band: 'field', clear: 24, spacing: 14, tilt: 0.1 },
    { model: 'book', count: 12, band: 'field', clear: 34, spacing: 30, tilt: 0.04, scale: [0.9, 1.15] },
    { model: 'bookStack', count: 6, band: 'field', clear: 50, spacing: 46, scale: [0.85, 1.2] },
    { model: 'pencil', count: 9, band: 'field', clear: 26, spacing: 24, tilt: 0.04 },
    { model: 'eraser', count: 10, band: 'verge', offset: [8, 26], spacing: 9, tilt: 0.2 },
    { model: 'battery', count: 9, band: 'verge', offset: [8, 26], spacing: 10, tilt: 0.1 },
    { model: 'coin', count: 12, band: 'verge', offset: [8, 26], spacing: 8, tilt: 0.06 },
    { model: 'gameController', count: 4, band: 'field', clear: 34, spacing: 40 },
    { model: 'tapeRoll', count: 6, band: 'field', clear: 28, spacing: 26 },
  ],

  ambient: {
    fogColor: 0x1c2338,
    fogDensity: 0.0018,
    dustDensity: 1.9,
  },
};
